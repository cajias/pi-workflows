import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repositoryId } from "../src/builtins/autoimplement-command-batches.js";
import { FORGE_RESOLUTION_SCHEMA } from "../src/builtins/autoimplement-forge.js";
import autoimplementWorkflow from "../src/builtins/autoimplement.workflow.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type {
  AgentStepRequest,
  AgentStepSubmission,
  WorkflowNodeContext,
  WorkflowNodeOutcome,
  WorkflowStepRecord,
} from "../src/workflows/types.js";
import { makeStateDatabasePath, makeTempDir } from "./helpers.js";
import {
  acceptedOutput,
  autoimplementSettingsValue,
  chooseFirstControlRoute,
  ciInspection,
  completedDelivery,
  controlDecision,
  documentedPlan,
  git,
  headPipelineFields,
  implementationExecutor,
  observationOf,
  preparedWorkspaceFor,
  published,
  reviewOf,
  setUpAutoimplementFixture,
  summaryExecutor,
  syntheticAutoimplementContext,
  type AutoimplementFixture,
} from "./helpers/autoimplement-fixtures.js";

/**
 * Publication timing for Autoimplement.
 *
 * `prTiming: end` keeps every implement, verify, review, and fix round local and pushes once, after
 * the review gate passes for exactly the pushed head. These tests cover the route rules with
 * synthetic step histories and run the graph on both forges with fake `pi-reviewer`, `gh`, and
 * `glab` executables. The `early` GitHub and GitLab paths are pinned byte for byte in
 * `test/builtin-autoimplement-forge.test.ts`; the matrix below runs all four forge and timing cells
 * side by side.
 */

type Forge = "github" | "gitlab";
type Timing = "early" | "end";

let fixture: AutoimplementFixture;

beforeEach(async () => {
  fixture = await setUpAutoimplementFixture();
});

afterEach(() => {
  fixture.restore();
});

// ---------------------------------------------------------------------------------------------
// Synthetic step histories
// ---------------------------------------------------------------------------------------------

const REPOSITORY = "/golden/repository";
const ID = repositoryId(REPOSITORY);

let sequence = 0;

function step(
  nodeId: string,
  output: unknown,
  outcome: WorkflowNodeOutcome = "ok",
): WorkflowStepRecord {
  sequence += 1;
  return {
    attemptId: `timing-attempt-${sequence}`,
    nodeId,
    nodeType: "compute",
    outcome,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    prompt: null,
    output,
  };
}

function candidate(headRevision: string, extra: Record<string, unknown> = {}) {
  return {
    id: ID,
    repository: REPOSITORY,
    branch: "feat/golden",
    baseBranch: "main",
    headRevision,
    ...extra,
  };
}

const commitLocal = (head: string) => step("commitLocal", { repositories: [candidate(head)] });
const publish = (head: string) =>
  step("publish", { repositories: [candidate(head, { pr: "https://example.test/pr/1" })] });
const verifyP2Local = (head: string, passed = true) =>
  step("verifyP2Local", { passed, pushed: false, repositories: [candidate(head)] });
const verifyP2 = (head: string) =>
  step("verifyP2", {
    passed: true,
    pushed: true,
    repositories: [candidate(head, { pr: "https://example.test/pr/1" })],
  });
const routed = (route: string) => step("routeVerifiedWorkspace", { route });
const edit = (nodeId: string) => step(nodeId, { done: true });

function assessed(head: string, findings: { p1?: string[]; p2?: string[] } = {}) {
  const list = (items: string[] = []) =>
    items.map((summary) => ({ severity: "P1", kind: "implementation", summary }));
  const route = (findings.p1 ?? []).length > 0 ? "critical" : findings.p2 ? "p2" : "clean";
  return {
    route,
    invocationSucceeded: true,
    repositories: [
      {
        ...candidate(head),
        invocationSucceeded: true,
        p0: [],
        p1: list(findings.p1),
        p2: list(findings.p2),
        lower: [],
        reason: route,
      },
    ],
  };
}

/** One review of a head: the assessment step and the branch result the controller observes. */
function reviewed(head: string, findings: { p1?: string[]; p2?: string[] } = {}) {
  const assessment = assessed(head, findings);
  return [
    step("assessReview", assessment),
    step("reviewResult", { sourceNode: "assessReview", outcome: "ok", result: assessment }),
  ];
}

const reused = () =>
  step("reviewResult", {
    sourceNode: "selectReviewCommands",
    outcome: "ok",
    result: { route: "reuse", repositories: [], commands: [] },
  });

function result(sourceNode: string, value: unknown, nodeId: string) {
  return step(nodeId, { sourceNode, outcome: "ok", result: value });
}

const BRANCH_WORKSPACE = syntheticAutoimplementContext().input as { preparedWorkspace: unknown };

function timingContext(
  steps: WorkflowStepRecord[],
  prTiming: Timing,
  overrides: { input?: Record<string, unknown>; outputs?: Record<string, unknown> } = {},
): WorkflowNodeContext {
  const context = syntheticAutoimplementContext({
    settings: { prTiming },
    ...(overrides.outputs === undefined ? {} : { outputs: overrides.outputs }),
  });
  return {
    ...context,
    input: { ...(context.input as Record<string, unknown>), ...overrides.input },
    state: { ...context.state, steps },
  };
}

async function availableRoutes(steps: WorkflowStepRecord[], prTiming: Timing): Promise<string[]> {
  const node = autoimplementWorkflow.nodes.observe;
  if (node?.nodeType !== "compute") throw new Error("observe must be a compute node");
  const context = { ...timingContext(steps, prTiming), outputs: {} };
  const observation = (await node.run(context)) as { availableRoutes: string[] };
  return observation.availableRoutes;
}

async function computeRoute(
  nodeId: "routeVerifiedWorkspace" | "routeAddressedP2",
  context: WorkflowNodeContext,
): Promise<unknown> {
  const node = autoimplementWorkflow.nodes[nodeId];
  if (node?.nodeType !== "compute") throw new Error(`${nodeId} must be a compute node`);
  return await node.run(context);
}

const UPSTREAM_PUBLICATION_ROUTES = ["review", "publication", "redesign", "blocked"];
const COMMENTS_ROUTES = ["comments", "review", "blocked"];
const AWAITING_PUSH_ROUTES = ["publication", "review", "blocked"];

type RouteRow = {
  name: string;
  prTiming: Timing;
  steps: () => WorkflowStepRecord[];
  routes: string[];
};

/** Every row of the plan's `resultRoutes` table, for both timings. */
const ROUTE_ROWS: RouteRow[] = [
  {
    name: "early publicationResult after publish keeps the upstream routes",
    prTiming: "early",
    steps: () => [
      edit("implement"),
      routed("pullRequest"),
      publish("h1"),
      result("publish", {}, "publicationResult"),
    ],
    routes: UPSTREAM_PUBLICATION_ROUTES,
  },
  {
    name: "early publicationResult after a fix that left the reviewed head unchanged stays upstream",
    prTiming: "early",
    steps: () => [
      publish("h1"),
      ...reviewed("h1"),
      edit("fix"),
      routed("pullRequest"),
      publish("h1"),
      result("publish", {}, "publicationResult"),
    ],
    routes: UPSTREAM_PUBLICATION_ROUTES,
  },
  {
    name: "end publicationResult after commitLocal offers review first",
    prTiming: "end",
    steps: () => [
      edit("implement"),
      routed("commitLocal"),
      commitLocal("h1"),
      result("commitLocal", {}, "publicationResult"),
    ],
    routes: UPSTREAM_PUBLICATION_ROUTES,
  },
  {
    name: "end publicationResult after the reviewed publish offers comments",
    prTiming: "end",
    steps: () => [
      commitLocal("h1"),
      ...reviewed("h1"),
      routed("publishReviewed"),
      publish("h1"),
      result("publish", {}, "publicationResult"),
    ],
    routes: COMMENTS_ROUTES,
  },
  {
    name: "default-branch publicationResult completes",
    prTiming: "end",
    steps: () => [
      routed("defaultBranch"),
      step("finalizeDefaultBranch", { status: "completed" }),
      result("finalizeDefaultBranch", { status: "completed" }, "publicationResult"),
    ],
    routes: ["complete"],
  },
  {
    name: "early clean review offers comments",
    prTiming: "early",
    steps: () => [publish("h1"), ...reviewed("h1")],
    routes: COMMENTS_ROUTES,
  },
  {
    name: "end clean review of a local commit offers its single push",
    prTiming: "end",
    steps: () => [commitLocal("h1"), ...reviewed("h1")],
    routes: AWAITING_PUSH_ROUTES,
  },
  {
    name: "end critical review of a local commit offers repair",
    prTiming: "end",
    steps: () => [commitLocal("h1"), ...reviewed("h1", { p1: ["race"] })],
    routes: ["repair", "redesign", "blocked"],
  },
  {
    name: "early reused review offers comments",
    prTiming: "early",
    steps: () => [publish("h1"), ...reviewed("h1"), reused()],
    routes: COMMENTS_ROUTES,
  },
  {
    name: "end reused clean review of a local commit offers its single push",
    prTiming: "end",
    steps: () => [commitLocal("h1"), ...reviewed("h1"), edit("fix"), commitLocal("h1"), reused()],
    routes: AWAITING_PUSH_ROUTES,
  },
  {
    name: "end reused critical review of a local commit offers repair",
    prTiming: "end",
    steps: () => [
      commitLocal("h1"),
      ...reviewed("h1", { p1: ["race"] }),
      edit("fix"),
      commitLocal("h1"),
      reused(),
    ],
    routes: ["repair", "redesign", "blocked"],
  },
  {
    name: "early passed P2 verification offers comments",
    prTiming: "early",
    steps: () => [
      publish("h1"),
      ...reviewed("h1", { p2: ["tidy"] }),
      edit("addressP2"),
      verifyP2("h2"),
      result("verifyP2", { passed: true }, "p2Result"),
    ],
    routes: COMMENTS_ROUTES,
  },
  {
    name: "end passed local P2 verification offers its single push",
    prTiming: "end",
    steps: () => [
      commitLocal("h1"),
      ...reviewed("h1", { p2: ["tidy"] }),
      edit("addressP2"),
      verifyP2Local("h2"),
      result("verifyP2Local", { passed: true }, "p2Result"),
    ],
    routes: AWAITING_PUSH_ROUTES,
  },
  {
    name: "end failed local P2 verification offers repair",
    prTiming: "end",
    steps: () => [
      commitLocal("h1"),
      ...reviewed("h1", { p2: ["tidy"] }),
      edit("addressP2"),
      verifyP2Local("h2", false),
      result("verifyP2Local", { passed: false }, "p2Result"),
    ],
    routes: ["repair", "redesign", "blocked"],
  },
  {
    name: "end failed commitLocal offers publication again, like publish",
    prTiming: "end",
    steps: () => [edit("implement"), routed("commitLocal"), step("commitLocal", null, "failed")],
    routes: ["publication", "repair", "redesign", "blocked"],
  },
  {
    name: "end failed verifyP2Local offers addressP2 again, like verifyP2",
    prTiming: "end",
    steps: () => [
      commitLocal("h1"),
      ...reviewed("h1", { p2: ["tidy"] }),
      edit("addressP2"),
      step("verifyP2Local", null, "timed_out"),
    ],
    routes: ["addressP2", "repair", "redesign", "blocked"],
  },
];

describe("autoimplement publication timing routes", () => {
  it.each(ROUTE_ROWS)("$name", async ({ steps, prTiming, routes }) => {
    expect(await availableRoutes(steps(), prTiming)).toEqual(routes);
  });

  it("chooses one of four publication routes and lets default-branch work ignore the timing", async () => {
    const route = (steps: WorkflowStepRecord[], prTiming: Timing, input = {}) =>
      computeRoute("routeVerifiedWorkspace", timingContext(steps, prTiming, { input }));
    const verified = [edit("implement")];
    const reviewedLocal = [commitLocal("h1"), ...reviewed("h1")];
    expect(await route(verified, "early")).toEqual({ route: "pullRequest" });
    expect(await route(verified, "end")).toEqual({ route: "commitLocal" });
    // A local commit that is not reviewed, or reviewed with findings, is committed again first.
    expect(await route([commitLocal("h1")], "end")).toEqual({ route: "commitLocal" });
    expect(await route([commitLocal("h1"), ...reviewed("h1", { p1: ["race"] })], "end")).toEqual({
      route: "commitLocal",
    });
    expect(await route([commitLocal("h1"), ...reviewed("h1", { p2: ["tidy"] })], "end")).toEqual({
      route: "commitLocal",
    });
    expect(await route(reviewedLocal, "end")).toEqual({ route: "publishReviewed" });
    expect(await route([...reviewedLocal, edit("fix")], "end")).toEqual({ route: "commitLocal" });
    expect(await route([publish("h1"), ...reviewed("h1")], "end")).toEqual({
      route: "commitLocal",
    });
    const defaultBranch = {
      preparedWorkspace: {
        ...(BRANCH_WORKSPACE.preparedWorkspace as Record<string, unknown>),
        mode: "defaultBranch",
        workBranch: "main",
      },
    };
    expect(await route(verified, "end", defaultBranch)).toEqual({ route: "defaultBranch" });
    expect(await route(reviewedLocal, "end", defaultBranch)).toEqual({ route: "defaultBranch" });
    expect(autoimplementWorkflow.nodes.routeVerifiedWorkspace).toMatchObject({
      nodeType: "compute",
      settingsRoute: true,
    });
  });

  it("follows the human end-to-early rule without losing a reviewed local head", async () => {
    const route = (steps: WorkflowStepRecord[]) =>
      computeRoute("routeVerifiedWorkspace", timingContext(steps, "early"));
    // Switched before review: the next publication pushes before review, as early does.
    expect(await route([commitLocal("h1")])).toEqual({ route: "pullRequest" });
    // Switched after a clean review: the reviewed local head still gets its single push.
    expect(await route([commitLocal("h1"), ...reviewed("h1")])).toEqual({
      route: "publishReviewed",
    });
    // P2 work follows where the reviewed candidate lives, not the timing.
    expect(
      await computeRoute(
        "routeAddressedP2",
        timingContext([commitLocal("h1"), ...reviewed("h1", { p2: ["tidy"] })], "early"),
      ),
    ).toEqual({ route: "local" });
  });

  it("verifies P2 work locally only when the reviewed candidate is a local commit", async () => {
    const route = (steps: WorkflowStepRecord[]) =>
      computeRoute("routeAddressedP2", timingContext(steps, "end"));
    expect(await route([commitLocal("h1"), edit("addressP2")])).toEqual({ route: "local" });
    expect(await route([commitLocal("h1"), publish("h1"), edit("addressP2")])).toEqual({
      route: "push",
    });
    expect(await route([edit("addressP2")])).toEqual({ route: "push" });
  });
});

// ---------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------

const GITLAB_MR = "https://gitlab.example.test/group/sub/project/-/merge_requests/7";
const GITLAB_RESOLUTION = {
  schema: FORGE_RESOLUTION_SCHEMA,
  requested: "auto",
  forge: "gitlab",
  host: "gitlab.example.test",
  remoteUrl: "git@gitlab.example.test:group/sub/project.git",
  reason: "glab host gitlab.example.test",
};

/** The golden context with `prTiming: end`, optionally on GitLab, and extra recorded steps. */
function endPromptContext(forge: Forge, extraSteps: WorkflowStepRecord[] = []) {
  const context = syntheticAutoimplementContext({
    settings: { prTiming: "end" },
    ...(forge === "gitlab" ? { pr: GITLAB_MR, outputs: { resolveForge: GITLAB_RESOLUTION } } : {}),
  });
  return {
    ...context,
    input: {
      ...(context.input as Record<string, unknown>),
      ...(forge === "gitlab"
        ? {
            scope:
              "Only /golden/repository. May edit, test, commit, push, and open a merge request.",
          }
        : {}),
    },
    state: { ...context.state, steps: [...context.state.steps, ...extraSteps] },
  };
}

async function renderPrompt(nodeId: string, context: WorkflowNodeContext): Promise<string> {
  const node = autoimplementWorkflow.nodes[nodeId];
  if (node?.nodeType !== "agent") throw new Error(`${nodeId} must be an agent node`);
  return await node.prompt(context);
}

const END_PROMPT_STEPS = [
  commitLocal("local123"),
  ...reviewed("local123"),
  routed("publishReviewed"),
];

/** Agent prompts that `end` adds or changes. */
const END_PROMPT_NODES = [
  "decide",
  "implement",
  "fix",
  "addressP2",
  "commitLocal",
  "verifyP2Local",
  "publish",
] as const;

function expectNoPullRequestWording(prompt: string): void {
  expect(prompt).not.toContain("pull request");
  expect(prompt).not.toContain("pr-description");
  expect(prompt).not.toMatch(/\bPRs?\b/u);
  expect(prompt).not.toContain("gh pr");
}

describe("autoimplement end-timing prompts", () => {
  it("keeps the steps outside the upstream graph out of the decide ledger window", async () => {
    const golden = syntheticAutoimplementContext();
    const [prepare, ...rest] = golden.state.steps;
    const later = [
      edit("addressP2"),
      verifyP2("h2"),
      result("verifyP2", { passed: true }, "p2Result"),
      step("commentsResult", { sourceNode: "inspectComments", outcome: "ok", result: {} }),
    ];
    const upstream = [prepare!, ...rest, ...later];
    const added = [
      prepare!,
      step("resolveForge", { forge: "github" }),
      ...rest,
      later[0]!,
      step("routeAddressedP2", { route: "push" }),
      ...later.slice(1),
    ];
    expect(upstream.length).toBeGreaterThan(12);
    const render = async (steps: WorkflowStepRecord[]) =>
      await renderPrompt("decide", { ...golden, state: { ...golden.state, steps } });
    const prompt = await render(added);
    expect(prompt).toBe(await render(upstream));
    expect(prompt).not.toContain("routeAddressedP2");
    expect(prompt).not.toContain("resolveForge");
  });
  it("adds the timing line to decide only under end, after the merge and forge lines", async () => {
    const github = (await renderPrompt("decide", endPromptContext("github"))).split("\n");
    const merge = github.indexOf("Merge allowed now: false");
    expect(github[merge + 1]).toBe(
      "Publication timing: end. Publication first commits locally; after the review gate passes, publication pushes once to the single pull request.",
    );
    const gitlab = (await renderPrompt("decide", endPromptContext("gitlab"))).split("\n");
    const gitlabMerge = gitlab.indexOf("Merge allowed now: false");
    expect(gitlab.slice(gitlabMerge + 1, gitlabMerge + 3)).toEqual([
      "Forge: gitlab. Publication uses one GitLab merge request through glab.",
      "Publication timing: end. Publication first commits locally; after the review gate passes, publication pushes once to the single merge request.",
    ]);
    const early = await renderPrompt("decide", syntheticAutoimplementContext());
    expect(early).not.toContain("Publication timing");
  });

  it("drops the end lines when the known workspace is direct default-branch work", async () => {
    const workspace = (mode: string) => ({
      exit: "ready",
      output: { ...(BRANCH_WORKSPACE.preparedWorkspace as Record<string, unknown>), mode },
    });
    const withWorkspace = (outputs: Record<string, unknown>) => {
      const context = timingContext([], "end", { outputs });
      const { preparedWorkspace: _prepared, ...input } = context.input as Record<string, unknown>;
      return { ...context, input };
    };
    const decide = async (outputs: Record<string, unknown>) =>
      await renderPrompt("decide", withWorkspace(outputs));
    expect(await decide({ workspace: workspace("defaultBranch") })).not.toContain(
      "Publication timing",
    );
    expect(await decide({ workspace: workspace("branch") })).toContain("Publication timing: end.");
    expect(await decide({ workspace: { exit: "blocked", output: {} } })).toContain(
      "Publication timing: end.",
    );
    expect(await decide({})).toContain("Publication timing: end.");
  });

  it.each(["implement", "fix", "addressP2"])(
    "ends the %s prompt with the no-push line only under end",
    async (nodeId) => {
      const github = (await renderPrompt(nodeId, endPromptContext("github"))).split("\n");
      expect(github.at(-1)).toBe(
        "Do not push and do not open or update a pull request. This run pushes only after the review gate passes.",
      );
      const gitlab = (await renderPrompt(nodeId, endPromptContext("gitlab"))).split("\n");
      expect(gitlab.at(-1)).toBe(
        "Do not push and do not open or update a merge request. This run pushes only after the review gate passes.",
      );
      const early = await renderPrompt(nodeId, syntheticAutoimplementContext());
      expect(early).not.toContain("This run pushes only after the review gate passes.");
    },
  );

  it("commits locally without pushing or opening a pull request", async () => {
    const prompt = await renderPrompt("commitLocal", endPromptContext("github"));
    const lines = prompt.split("\n");
    expect(lines[0]).toBe(
      "Commit the verified work locally on the prepared task branch, so review runs on these commits before anything is published.",
    );
    expect(lines).toContain(
      "Never push, never open or update a pull request, and never amend or rewrite a commit that was already pushed.",
    );
    expect(prompt).toContain("do not create an empty commit");
    expect(lines.at(-1)).toMatch(
      /^Prepared workspace: \{"schema":"pi-workflows.prepared-workspace/u,
    );
  });

  it("verifies P2 work locally against the reviewed local commit", async () => {
    const context = endPromptContext("github", [commitLocal("local123")]);
    const lines = (await renderPrompt("verifyP2Local", context)).split("\n");
    expect(lines[0]).toBe(
      "Run focused verification for the P2 changes, then commit the verified result locally on the task branch.",
    );
    expect(lines).toContain(`Reviewed local commits: ${JSON.stringify([candidate("local123")])}`);
    expect(lines).toContain(
      "Do not run pi-reviewer again because the previous round had no P0 or P1 findings.",
    );
  });

  it("pushes exactly the reviewed head when publication follows a clean review", async () => {
    const lines = (
      await renderPrompt("publish", endPromptContext("github", END_PROMPT_STEPS))
    ).split("\n");
    expect(lines[0]).toBe(
      "Push exactly the reviewed local head local123 to the task branch without force. This head passed the review gate, so create no new commits and do not amend or rewrite any commit.",
    );
    expect(lines[1]).toBe(
      "If the local HEAD is not local123, do not push. Report the difference instead.",
    );
    expect(lines).not.toContain("Commit and push the verified implementation before review.");
    expect(lines.at(-1)).toBe("Do not merge yet.");
    const gitlab = (
      await renderPrompt("publish", endPromptContext("gitlab", END_PROMPT_STEPS))
    ).split("\n");
    expect(gitlab[0]).toBe(lines[0]);
    expect(gitlab).toContain(`Forge resolution: ${JSON.stringify(GITLAB_RESOLUTION)}`);
    expect(gitlab.join("\n")).toContain(
      "glab mr create --repo https://<hostname>/<project path> --source-branch <branch>",
    );
  });

  it.each(END_PROMPT_NODES)(
    "renders the GitLab end %s prompt without pull request wording",
    async (nodeId) => {
      const prompt = await renderPrompt(nodeId, endPromptContext("gitlab", END_PROMPT_STEPS));
      expectNoPullRequestWording(prompt);
      expect(prompt).toContain("merge request");
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------------------------

function validatorOf(nodeId: string) {
  const node = autoimplementWorkflow.nodes[nodeId];
  if (node?.nodeType !== "agent" || node.validate === undefined) {
    throw new Error(`${nodeId} must be a validated agent node`);
  }
  const validate = node.validate;
  return async (value: unknown, context: WorkflowNodeContext) => await validate(value, context);
}

/** A context whose prepared workspace is the fixture repository. */
function fixtureContext(
  steps: WorkflowStepRecord[] = [],
  workspace: Record<string, unknown> = {},
): WorkflowNodeContext {
  return {
    ...timingContext(steps, "end"),
    input: {
      task: "demo",
      repository: fixture.repository,
      preparedWorkspace: { ...preparedWorkspaceFor(fixture), ...workspace },
    },
  };
}

function localRecord(headRevision: string, extra: Record<string, unknown> = {}) {
  return {
    repository: fixture.repository,
    branch: "feat/demo",
    baseBranch: "main",
    headRevision,
    committed: true,
    ...extra,
  };
}

function fixtureCandidate(headRevision: string, extra: Record<string, unknown> = {}) {
  return {
    id: repositoryId(fixture.repository),
    repository: fixture.repository,
    branch: "feat/demo",
    baseBranch: "main",
    headRevision,
    ...extra,
  };
}

describe("autoimplement commitLocal validator", () => {
  const validate = validatorOf("commitLocal");
  const submit = async (record: Record<string, unknown>, workspace = {}) =>
    await validate({ repositories: [record] }, fixtureContext([], workspace));

  it("accepts the checked-out HEAD of the prepared task branch", async () => {
    await expect(submit(localRecord(fixture.baseRevision))).resolves.toEqual({
      repositories: [fixtureCandidate(fixture.baseRevision)],
    });
  });

  it("rejects another head, branch, base, or repository", async () => {
    await expect(submit(localRecord("0".repeat(40)))).rejects.toThrow(
      `local commit repositories[0].headRevision must be the checked-out HEAD ${fixture.baseRevision}`,
    );
    await expect(
      submit(localRecord(fixture.baseRevision, { branch: "feat/other" })),
    ).rejects.toThrow(
      "local commit repositories[0].branch must be the prepared task branch: feat/demo",
    );
    await expect(
      submit(localRecord(fixture.baseRevision, { baseBranch: "develop" })),
    ).rejects.toThrow(
      "local commit repositories[0].baseBranch must be the prepared base branch: main",
    );
    const other = path.join(fixture.repository, "nested");
    await expect(submit(localRecord(fixture.baseRevision, { repository: other }))).rejects.toThrow(
      `local commit repositories[0].repository must be the prepared workspace: ${fixture.repository}`,
    );
    await git(fixture.repository, ["switch", "-c", "feat/other"]);
    await expect(submit(localRecord(fixture.baseRevision))).rejects.toThrow(
      "local commit repositories[0].branch must be the checked-out branch feat/other",
    );
  });

  it("rejects task changes left uncommitted outside the pre-existing paths", async () => {
    await fs.writeFile(path.join(fixture.repository, "task.txt"), "task\n");
    await fs.writeFile(path.join(fixture.repository, "README.md"), "changed\n");
    await expect(submit(localRecord(fixture.baseRevision))).rejects.toThrow(
      "local commit repositories[0] leaves task changes uncommitted: README.md, task.txt",
    );
    await expect(
      submit(localRecord(fixture.baseRevision), { preExistingChangedPaths: ["README.md"] }),
    ).rejects.toThrow("leaves task changes uncommitted: task.txt");
    await expect(
      submit(localRecord(fixture.baseRevision), {
        preExistingChangedPaths: ["README.md", "task.txt"],
      }),
    ).resolves.toMatchObject({ repositories: [{ headRevision: fixture.baseRevision }] });
  });
});

describe("autoimplement verifyP2Local validator", () => {
  const validate = validatorOf("verifyP2Local");
  const verification = (extra: Record<string, unknown> = {}) => ({
    passed: true,
    commands: [{ command: "npm test", outcome: "passed" }],
    pushed: false,
    repositories: [localRecord(fixture.baseRevision)],
    ...extra,
  });
  const reviewedCommit = (extra: Record<string, unknown> = {}) =>
    step("commitLocal", { repositories: [fixtureCandidate("parent", extra)] });

  it("accepts a committed local P2 head of the reviewed candidate", async () => {
    await expect(
      validate(verification(), fixtureContext([reviewedCommit()])),
    ).resolves.toMatchObject({
      passed: true,
      pushed: false,
      repositories: [fixtureCandidate(fixture.baseRevision)],
    });
    await expect(
      validate(verification({ passed: false }), fixtureContext([reviewedCommit()])),
    ).resolves.toMatchObject({ passed: false });
  });

  it("rejects a push, an unclear verdict, another candidate, or a missing repository", async () => {
    const context = fixtureContext([reviewedCommit()]);
    await expect(validate(verification({ pushed: true }), context)).rejects.toThrow(
      "local P2 verification pushed must be false",
    );
    await expect(validate(verification({ passed: "yes" }), context)).rejects.toThrow(
      "local P2 verification passed must be a boolean",
    );
    await expect(
      validate(verification(), fixtureContext([reviewedCommit({ dependencyFingerprint: "sha" })])),
    ).rejects.toThrow(
      `local P2 verification repository does not match the reviewed local commit: ${repositoryId(fixture.repository)}`,
    );
    const second = { ...fixtureCandidate("parent"), id: "second-id", repository: "/second" };
    await expect(
      validate(
        verification(),
        fixtureContext([
          step("commitLocal", { repositories: [fixtureCandidate("parent"), second] }),
        ]),
      ),
    ).rejects.toThrow("local P2 verification is missing repository ids: second-id");
    await expect(validate(verification(), fixtureContext())).rejects.toThrow(
      "No reviewed commitLocal or publish record found",
    );
    await expect(
      validate(
        verification({ repositories: [localRecord("0".repeat(40))] }),
        fixtureContext([reviewedCommit()]),
      ),
    ).rejects.toThrow(
      "local P2 verification repositories[0].headRevision must be the checked-out HEAD",
    );
  });
});

describe("autoimplement reviewed publication validator", () => {
  const validate = validatorOf("publish");
  const pushed = (extra: Record<string, unknown> = {}) => ({
    repositories: [
      {
        repository: fixture.repository,
        branch: "feat/demo",
        baseBranch: "main",
        headRevision: fixture.baseRevision,
        pr: "https://example.test/pr/1",
        pushed: true,
        ...extra,
      },
    ],
  });
  /** A clean review of a local commit, then the publication route that pushes it. */
  const gate = (extra: Record<string, unknown> = {}, head = fixture.baseRevision) => {
    const reviewedHead = fixtureCandidate(head, extra);
    const assessment = {
      route: "clean",
      repositories: [
        { ...reviewedHead, invocationSucceeded: true, p0: [], p1: [], p2: [], lower: [] },
      ],
    };
    return [
      step("commitLocal", { repositories: [reviewedHead] }),
      step("assessReview", assessment),
      routed("publishReviewed"),
    ];
  };
  const earlierPublish = (pr: string, outcome: WorkflowNodeOutcome = "ok") =>
    step("publish", { repositories: [fixtureCandidate("0".repeat(40), { pr })] }, outcome);

  it("accepts only the reviewed head under publishReviewed", async () => {
    await expect(validate(pushed(), fixtureContext(gate()))).resolves.toMatchObject({
      repositories: [{ headRevision: fixture.baseRevision }],
    });
    await expect(
      validate(
        pushed({ dependencyFingerprint: "sha" }),
        fixtureContext(gate({ dependencyFingerprint: "sha" })),
      ),
    ).resolves.toMatchObject({ repositories: [{ dependencyFingerprint: "sha" }] });
    for (const extra of [
      { headRevision: "other" },
      { baseBranch: "develop" },
      { dependencyFingerprint: "sha" },
    ]) {
      await expect(validate(pushed(extra), fixtureContext(gate()))).rejects.toThrow(
        "publication must push exactly the reviewed head",
      );
    }
    await expect(
      validate(pushed({ branch: "feat/other" }), fixtureContext(gate())),
    ).rejects.toThrow(
      "publication repositories[0].branch must be the prepared task branch: feat/demo",
    );
    const elsewhere = [
      step("commitLocal", {
        repositories: [
          { ...fixtureCandidate(fixture.baseRevision), id: "other-id", repository: "/other" },
        ],
      }),
      routed("publishReviewed"),
    ];
    await expect(validate(pushed(), fixtureContext(elsewhere))).rejects.toThrow(
      'publication must push exactly the reviewed head: {"reviewed":null,',
    );
  });

  it("requires the reviewed head to be the clean checked-out HEAD of the task branch", async () => {
    await fs.writeFile(path.join(fixture.repository, "after-review.txt"), "unreviewed\n");
    await expect(validate(pushed(), fixtureContext(gate()))).rejects.toThrow(
      "publication repositories[0] leaves task changes uncommitted: after-review.txt",
    );
    await git(fixture.repository, ["add", "after-review.txt"]);
    await git(fixture.repository, ["commit", "-m", "unreviewed commit"]);
    const unreviewed = await git(fixture.repository, ["rev-parse", "HEAD"]);
    await expect(validate(pushed(), fixtureContext(gate()))).rejects.toThrow(
      `publication repositories[0].headRevision must be the checked-out HEAD ${unreviewed}`,
    );
    await git(fixture.repository, ["switch", "-c", "feat/other", fixture.baseRevision]);
    await expect(validate(pushed(), fixtureContext(gate()))).rejects.toThrow(
      "publication repositories[0].branch must be the checked-out branch feat/other",
    );
  });

  it("requires the tracking ref of the push destination to record the reviewed head", async () => {
    const remote = await makeTempDir("autoimplement-reviewed-push-remote");
    await git(remote, ["init", "--bare", "-b", "main"]);
    await git(fixture.repository, ["remote", "add", "origin", remote]);
    await git(fixture.repository, ["push", "-q", "-u", "origin", "feat/demo"]);
    await fs.writeFile(path.join(fixture.repository, "reviewed.txt"), "reviewed\n");
    await git(fixture.repository, ["add", "reviewed.txt"]);
    await git(fixture.repository, ["commit", "-m", "reviewed"]);
    const head = await git(fixture.repository, ["rev-parse", "HEAD"]);
    const context = fixtureContext(gate({}, head));
    await expect(validate(pushed({ headRevision: head }), context)).rejects.toThrow(
      `publication repositories[0].headRevision must be the pushed head, but refs/remotes/origin/feat/demo is ${fixture.baseRevision}`,
    );
    await git(fixture.repository, ["push", "-q", "origin", "feat/demo"]);
    await expect(validate(pushed({ headRevision: head }), context)).resolves.toMatchObject({
      repositories: [{ headRevision: head }],
    });
    // A push destination with another branch name is not a reliable tracking ref, so it is skipped.
    await git(fixture.repository, [
      "push",
      "-q",
      "origin",
      `${fixture.baseRevision}:refs/heads/main`,
    ]);
    await git(fixture.repository, ["fetch", "-q", "origin"]);
    await git(fixture.repository, ["branch", "--set-upstream-to", "origin/main"]);
    await git(fixture.repository, ["config", "push.default", "upstream"]);
    await git(fixture.repository, [
      "update-ref",
      "refs/remotes/origin/feat/demo",
      fixture.baseRevision,
    ]);
    await expect(validate(pushed({ headRevision: head }), context)).resolves.toMatchObject({
      repositories: [{ headRevision: head }],
    });
  });

  it("requires a later reviewed push to reuse the request this run already published", async () => {
    const first = "https://example.test/pr/1";
    const context = fixtureContext([earlierPublish(first), ...gate()]);
    await expect(validate(pushed({ pr: "https://example.test/pr/2" }), context)).rejects.toThrow(
      `publication repositories[0].pr must be the pull request this run already published: ${first}`,
    );
    await expect(validate(pushed(), context)).resolves.toMatchObject({
      repositories: [{ pr: first }],
    });
    const failedEarlier = fixtureContext([earlierPublish(first, "failed"), ...gate()]);
    await expect(
      validate(pushed({ pr: "https://example.test/pr/2" }), failedEarlier),
    ).resolves.toMatchObject({ repositories: [{ pr: "https://example.test/pr/2" }] });
    const mergeRequest = "https://gitlab.example.test/group/project/-/merge_requests/7";
    const gitlab = fixtureContext([earlierPublish(mergeRequest), ...gate()]);
    const onGitLab = {
      ...gitlab,
      outputs: {
        ...gitlab.outputs,
        resolveForge: { ...GITLAB_RESOLUTION, requested: "gitlab", host: null, remoteUrl: null },
      },
    };
    await expect(
      validate(
        pushed({ pr: "https://gitlab.example.test/group/project/-/merge_requests/8" }),
        onGitLab,
      ),
    ).rejects.toThrow(
      `publication repositories[0].pr must be the merge request this run already published: ${mergeRequest}`,
    );
  });

  it("leaves other publication routes unbound and requires a gate head for publishReviewed", async () => {
    await expect(
      validate(pushed({ headRevision: "any" }), fixtureContext([routed("pullRequest")])),
    ).resolves.toMatchObject({ repositories: [{ headRevision: "any" }] });
    await expect(
      validate(pushed(), fixtureContext([...gate(), edit("fix"), routed("publishReviewed")])),
    ).rejects.toThrow("reviewed publication has no reviewed local head");
  });
});

// ---------------------------------------------------------------------------------------------
// Graph runs
// ---------------------------------------------------------------------------------------------

/** Complete graph runs take several seconds each, and a multi-round run takes about twice that. */
const GRAPH_RUN_TIMEOUT_MS = 30_000;

const GITHUB_RUN_PR = "https://example.test/pr/1";
const GITLAB_RUN_MR = "https://gitlab.example.test/group/project/-/merge_requests/7";
const CANONICAL_GLAB_WATCH = [
  "ci",
  "status",
  "--live",
  "--branch",
  "feat/demo",
  "--repo",
  "https://gitlab.example.test/group/project",
];

const NO_ACTIONABLE_COMMENTS = {
  output: { route: "ci", summary: "no actionable comments", evidence: [] },
};
const FIX_COMMENT = {
  output: { route: "fix", summary: "a reviewer asked for a fix", evidence: ["comment 1"] },
};

/** Local commits the scripted model makes in the fixture repository. */
class LocalWork {
  readonly heads: string[] = [];
  constructor(
    readonly repository: string,
    readonly baseRevision: string,
  ) {}

  get head(): string {
    return this.heads.at(-1) ?? this.baseRevision;
  }

  async commit(name: string): Promise<string> {
    await fs.writeFile(path.join(this.repository, `${name}.txt`), `${name}\n`);
    await git(this.repository, ["add", "."]);
    await git(this.repository, ["commit", "-m", name]);
    this.heads.push(await git(this.repository, ["rev-parse", "HEAD"]));
    return this.head;
  }
}

type RunOptions = {
  forge: Forge;
  prTiming: Timing;
  /** One review per round; each entry lists findings, empty for a clean review. */
  reviews?: Array<{ p1?: string[]; p2?: string[] }>;
  /** Comment results in order; the last one repeats. */
  comments?: Array<{ output: unknown }>;
  ci?: "green" | "pending";
  /** Replaces the scripted publish answer. */
  publish?: (request: AgentStepRequest, work: LocalWork) => Promise<AgentStepSubmission>;
  /** Called during each assessReview answer before it submits. */
  onReview?: (request: AgentStepRequest) => Promise<void>;
  /** Replaces the scripted inspectCi answer. */
  inspectCi?: (request: AgentStepRequest, work: LocalWork) => Promise<AgentStepSubmission>;
  /** Replaces the scripted assessTrackedCi answer. */
  assessTrackedCi?: (request: AgentStepRequest, work: LocalWork) => Promise<AgentStepSubmission>;
  /** Replaces the scripted controller. */
  decide?: (request: AgentStepRequest) => Promise<AgentStepSubmission> | AgentStepSubmission;
};

/** A tracked CI assessment of the one fixture repository. */
function trackedAssessment(
  route: "green" | "failed" | "pending" | "unavailable",
  extra: Record<string, unknown> = {},
) {
  return {
    route,
    reason: `checks ${route}`,
    targets: [{ id: repositoryId(fixture.repository), route, reason: `checks ${route}`, ...extra }],
    relatedFailures: [],
    unrelatedFailures: [],
  };
}

function prFor(forge: Forge): string {
  return forge === "gitlab" ? GITLAB_RUN_MR : GITHUB_RUN_PR;
}

function trackingCommandFor(forge: Forge) {
  return forge === "gitlab"
    ? { command: "glab", args: ["ci", "status", "--live"] }
    : { command: "gh", args: ["pr", "checks", "--watch"] };
}

function timingScenario(options: RunOptions) {
  const repository = fixture.repository;
  const work = new LocalWork(repository, fixture.baseRevision);
  const pr = prFor(options.forge);
  const reviews = [...(options.reviews ?? [{}])];
  const localCommit = (head: string) => ({ repositories: [localRecord(head)] });
  let commits = 0;
  const executor = implementationExecutor(repository, options.decide)
    .respond("commitLocal", async (request) => {
      commits += 1;
      return await acceptedOutput(request, localCommit(await work.commit(`local-${commits}`)));
    })
    .respond(
      "publish",
      options.publish === undefined
        ? async (request) => await acceptedOutput(request, published(repository, work.head, pr))
        : async (request) =>
            await (options.publish as NonNullable<RunOptions["publish"]>)(request, work),
    )
    .respond("assessReview", async (request) => {
      await options.onReview?.(request);
      const findings = reviews.length > 1 ? reviews.shift() : reviews[0];
      return await acceptedOutput(request, reviewOf(repository, findings));
    })
    .respond("fix", { output: { fixed: "fixed it", files: ["src/change.ts"] } })
    .respond("addressP2", { output: { addressed: ["simplified branch"], skipped: [] } })
    .respond("verifyP2Local", async (request) =>
      acceptedOutput(request, {
        passed: true,
        commands: [{ command: "npm test", outcome: "passed" }],
        pushed: false,
        repositories: localCommit(await work.commit("p2")).repositories,
      }),
    )
    .respond("verifyP2", async (request) =>
      acceptedOutput(request, {
        passed: true,
        commands: [{ command: "npm test", outcome: "passed" }],
        pushed: true,
        repositories: published(repository, work.head, pr).repositories,
      }),
    )
    .respond("inspectComments", ...(options.comments ?? [NO_ACTIONABLE_COMMENTS]))
    .respond(
      "inspectCi",
      options.inspectCi === undefined
        ? async (request) =>
            acceptedOutput(
              request,
              ciInspection(
                repository,
                options.ci ?? "green",
                work.head,
                pr,
                trackingCommandFor(options.forge),
                options.forge,
              ),
            )
        : async (request) =>
            await (options.inspectCi as NonNullable<RunOptions["inspectCi"]>)(request, work),
    )
    .respond(
      "assessTrackedCi",
      options.assessTrackedCi === undefined
        ? async (request) =>
            acceptedOutput(
              request,
              trackedAssessment("green", headPipelineFields(options.forge, "green", work.head)),
            )
        : async (request) =>
            await (options.assessTrackedCi as NonNullable<RunOptions["assessTrackedCi"]>)(
              request,
              work,
            ),
    )
    .respond("opportunisticTest", {
      output: { performed: [], furtherUsefulTests: false, summary: "no further useful test" },
    })
    .respond("finalizeDelivery", completedDelivery(pr, false));
  const input = {
    task: "implement demo",
    ...documentedPlan({ steps: ["change code"] }),
    repository,
    merge: false,
    forge: options.forge,
    prTiming: options.prTiming,
  };
  return { executor, input, work, pr };
}

async function runTiming(name: string, options: RunOptions) {
  const scenario = timingScenario(options);
  const databasePath = await makeStateDatabasePath(`autoimplement-timing-${name}`);
  const engine = new WorkflowEngine({ executor: scenario.executor, databasePath });
  const { state } = await engine.run(autoimplementWorkflow, scenario.input);
  return { ...scenario, state, databasePath };
}

type RunState = Awaited<ReturnType<typeof runTiming>>["state"];

const nodeIdsOf = (state: RunState) => state.steps.map((entry) => entry.nodeId);

function okSteps(state: RunState, nodeId: string) {
  return state.steps.filter((entry) => entry.nodeId === nodeId && entry.outcome === "ok");
}

function headsOf(entry: { output: unknown }): string[] {
  return (entry.output as { repositories: Array<{ headRevision: string }> }).repositories.map(
    (repository) => repository.headRevision,
  );
}

function firstCleanReviewResult(state: RunState): number {
  return state.steps.findIndex(
    (entry) =>
      entry.nodeId === "reviewResult" &&
      (entry.output as { result?: { route?: string } }).result?.route === "clean",
  );
}

/** The routes the controller observed right after `index`. */
function routesAfter(state: RunState, index: number): string[] {
  const observation = state.steps.slice(index + 1).find((entry) => entry.nodeId === "observe");
  if (observation === undefined) throw new Error(`no observation after step ${index}`);
  return (observation.output as { availableRoutes: string[] }).availableRoutes;
}

/** Proves that nothing is pushed under `end` before a clean review of the pushed head. */
function expectPushesOnlyAfterCleanReview(state: RunState): void {
  const ids = nodeIdsOf(state);
  const clean = firstCleanReviewResult(state);
  expect(clean).toBeGreaterThan(0);
  const beforeClean = ids.slice(0, clean);
  expect(beforeClean).not.toContain("publish");
  expect(beforeClean).not.toContain("verifyP2");
  expect(ids.indexOf("commitLocal")).toBeLessThan(ids.indexOf("runReview"));
}

/** The node sequence of a complete GitHub `end` run with green CI. */
const END_HAPPY_PATH = [
  "prepare",
  "resolveForge",
  "observe",
  "decide",
  "dispatch",
  "workspace",
  "workspace/inspect",
  "workspace/ready",
  "workspace/__piw_exit_ready",
  "observe",
  "decide",
  "dispatch",
  "implement",
  "classifyImplementation",
  "observe",
  "decide",
  "dispatch",
  "localVerification",
  "localVerification/selectChecks",
  "localVerification/planChecks",
  "localVerification/runCandidate",
  "localVerification/runBase",
  "localVerification/classify",
  "localVerification/ready",
  "localVerification/__piw_exit_ready",
  "observe",
  "decide",
  "dispatch",
  "routeVerifiedWorkspace",
  "commitLocal",
  "publicationResult",
  "observe",
  "decide",
  "dispatch",
  "selectReviewCommands",
  "runReview",
  "routeRunReviewResult",
  "assessReview",
  "reviewResult",
  "observe",
  "decide",
  "dispatch",
  "routeVerifiedWorkspace",
  "publish",
  "publicationResult",
  "observe",
  "decide",
  "dispatch",
  "inspectComments",
  "commentsResult",
  "observe",
  "decide",
  "dispatch",
  "inspectCi",
  "routeInspectCiResult",
  "ciResult",
  "observe",
  "decide",
  "dispatch",
  "finalizeDelivery",
  "deliveryResult",
  "observe",
  "decide",
  "dispatch",
  "prepareCompleted",
  "completedSummary",
  "finalize",
];

/** The same run with a pending CI target that runs its bound watch. */
const END_PENDING_CI_PATH = [
  ...END_HAPPY_PATH.slice(0, END_HAPPY_PATH.indexOf("ciResult")),
  "trackCi",
  "routeTrackCiResult",
  "assessTrackedCi",
  ...END_HAPPY_PATH.slice(END_HAPPY_PATH.indexOf("ciResult")),
];

function topLevelPrompts(executor: { requests: AgentStepRequest[] }): string[] {
  return executor.requests
    .filter((request) => !request.contract.nodeId.includes("/"))
    .map((request) => request.prompt);
}

const MATRIX: ReadonlyArray<{ forge: Forge; prTiming: Timing }> = [
  { forge: "github", prTiming: "early" },
  { forge: "github", prTiming: "end" },
  { forge: "gitlab", prTiming: "early" },
  { forge: "gitlab", prTiming: "end" },
];

describe("autoimplement {github, gitlab} × {early, end} publication matrix", () => {
  it.each(MATRIX)(
    "$forge × $prTiming: publishes once at the timing's point and watches CI with the forge CLI",
    async ({ forge, prTiming }) => {
      const run = await runTiming(`matrix-${forge}-${prTiming}`, {
        forge,
        prTiming,
        ci: "pending",
      });
      const { state } = run;
      expect(state.status, state.error).toBe("completed");
      const ids = nodeIdsOf(state);
      expect(okSteps(state, "publish")).toHaveLength(1);
      if (prTiming === "early") {
        expect(ids).not.toContain("commitLocal");
        expect(ids.indexOf("publish")).toBeLessThan(ids.indexOf("runReview"));
      } else {
        expect(ids).toEqual(END_PENDING_CI_PATH);
        expectPushesOnlyAfterCleanReview(state);
        expect(headsOf(okSteps(state, "publish")[0]!)).toEqual(
          headsOf(okSteps(state, "commitLocal")[0]!),
        );
      }
      const watch = state.steps.find((entry) => entry.nodeId === "trackCi")?.output;
      if (forge === "gitlab") {
        expect(watch).toMatchObject({
          batch: { items: [{ command: "glab", args: CANONICAL_GLAB_WATCH }] },
        });
        expect(await fs.readFile(fixture.glabLog, "utf8")).toBe(
          `${CANONICAL_GLAB_WATCH.join(" ")}\n`,
        );
        // The engine appends each step contract, whose static O2 expected-output example still
        // shows both forms, so whole step prompts are checked for the two required terms.
        for (const prompt of topLevelPrompts(run.executor)) {
          expect(prompt).not.toContain("pull request");
          expect(prompt).not.toContain("pr-description");
        }
      } else {
        expect(watch).toMatchObject({
          batch: { items: [{ command: "gh", args: ["pr", "checks", run.pr, "--watch"] }] },
        });
      }
      expect(state.finalOutput).toMatchObject({
        status: "completed",
        delivery: { status: "completed", pr: run.pr },
      });
    },
    GRAPH_RUN_TIMEOUT_MS,
  );
});

describe.each(["github", "gitlab"] as const)("autoimplement %s × end", (forge) => {
  it(
    "commits locally, reviews, and pushes the reviewed head once",
    async () => {
      const { state, executor, work } = await runTiming(`${forge}-end-happy`, {
        forge,
        prTiming: "end",
      });
      expect(state.status, state.error).toBe("completed");
      expect(nodeIdsOf(state)).toEqual(END_HAPPY_PATH);
      expectPushesOnlyAfterCleanReview(state);
      const [only] = okSteps(state, "publish");
      expect(okSteps(state, "publish")).toHaveLength(1);
      expect(headsOf(only!)).toEqual([work.heads[0]]);
      const publishIndex = state.steps.indexOf(only!);
      expect(routesAfter(state, publishIndex)).toEqual(COMMENTS_ROUTES);
      const reviewIndex = firstCleanReviewResult(state);
      expect(routesAfter(state, reviewIndex)).toEqual(AWAITING_PUSH_ROUTES);
      expect(
        state.steps
          .filter((entry) => entry.nodeId === "routeVerifiedWorkspace")
          .map((entry) => entry.output),
      ).toEqual([{ route: "commitLocal" }, { route: "publishReviewed" }]);
      const publishPrompt = executor.requests.find(
        (request) => request.contract.nodeId === "publish",
      );
      expect(publishPrompt?.prompt).toContain(
        `Push exactly the reviewed local head ${work.heads[0]}`,
      );
      const implement = executor.requests.find(
        (request) => request.contract.nodeId === "implement",
      );
      expect(implement?.prompt).toContain("This run pushes only after the review gate passes.");
    },
    GRAPH_RUN_TIMEOUT_MS,
  );

  it(
    "reviews twice and commits twice before the single push after a P1 finding",
    async () => {
      const { state, work } = await runTiming(`${forge}-end-p1`, {
        forge,
        prTiming: "end",
        reviews: [{ p1: ["fix race"] }, {}],
      });
      expect(state.status, state.error).toBe("completed");
      expectPushesOnlyAfterCleanReview(state);
      const ids = nodeIdsOf(state);
      const publishIndex = ids.indexOf("publish");
      expect(ids.slice(0, publishIndex).filter((id) => id === "assessReview")).toHaveLength(2);
      expect(okSteps(state, "commitLocal").map(headsOf)).toEqual([
        [work.heads[0]],
        [work.heads[1]],
      ]);
      expect(okSteps(state, "publish").map(headsOf)).toEqual([[work.heads[1]]]);
      expect(state.finalOutput).toMatchObject({
        reviewRounds: [{ route: "critical" }, { route: "clean" }],
      });
    },
    GRAPH_RUN_TIMEOUT_MS,
  );

  it(
    "verifies P2 work locally and pushes the P2-verified head without another review",
    async () => {
      const { state, work } = await runTiming(`${forge}-end-p2`, {
        forge,
        prTiming: "end",
        reviews: [{ p2: ["simplify one branch"] }],
      });
      expect(state.status, state.error).toBe("completed");
      const ids = nodeIdsOf(state);
      expect(ids).toContain("verifyP2Local");
      expect(ids).not.toContain("verifyP2");
      expect(ids.filter((id) => id === "assessReview")).toHaveLength(1);
      expect(state.steps.find((entry) => entry.nodeId === "routeAddressedP2")?.output).toEqual({
        route: "local",
      });
      expect(ids.indexOf("verifyP2Local")).toBeLessThan(ids.indexOf("publish"));
      expect(okSteps(state, "publish").map(headsOf)).toEqual([[work.heads[1]]]);
      expect(okSteps(state, "verifyP2Local").map(headsOf)).toEqual([[work.heads[1]]]);
    },
    GRAPH_RUN_TIMEOUT_MS,
  );

  it(
    "pushes a fix after the request exists only after a clean review of the fixed head",
    async () => {
      const { state, work, pr } = await runTiming(`${forge}-end-fix`, {
        forge,
        prTiming: "end",
        comments: [FIX_COMMENT, NO_ACTIONABLE_COMMENTS],
      });
      expect(state.status, state.error).toBe("completed");
      const publishes = okSteps(state, "publish");
      expect(publishes.map(headsOf)).toEqual([[work.heads[0]], [work.heads[1]]]);
      expect(
        publishes.map(
          (entry) => (entry.output as { repositories: Array<{ pr: string }> }).repositories[0]?.pr,
        ),
      ).toEqual([pr, pr]);
      // Each push follows a clean review of exactly that head, recorded after the previous push.
      let previous = -1;
      for (const entry of publishes) {
        const index = state.steps.indexOf(entry);
        const between = state.steps.slice(previous + 1, index);
        const reviewedHeads = between
          .filter((candidateStep) => candidateStep.nodeId === "assessReview")
          .flatMap((candidateStep) =>
            (
              candidateStep.output as {
                route: string;
                repositories: Array<{ headRevision: string }>;
              }
            ).route === "clean"
              ? (candidateStep.output as { repositories: Array<{ headRevision: string }> })
                  .repositories
              : [],
          )
          .map((repository) => repository.headRevision);
        expect(reviewedHeads).toEqual(headsOf(entry));
        expect(between.map((candidateStep) => candidateStep.nodeId)).toContain("commitLocal");
        previous = index;
      }
    },
    GRAPH_RUN_TIMEOUT_MS,
  );

  it(
    "returns a publish of another head to the controller and offers publication again",
    async () => {
      let attempts = 0;
      const { state, work } = await runTiming(`${forge}-end-mismatch`, {
        forge,
        prTiming: "end",
        publish: async (request, local) => {
          attempts += 1;
          const head = attempts === 1 ? fixture.baseRevision : local.head;
          return await acceptedOutput(request, published(fixture.repository, head, prFor(forge)));
        },
      });
      expect(state.status, state.error).toBe("completed");
      const attemptsOfPublish = state.steps.filter((entry) => entry.nodeId === "publish");
      expect(attemptsOfPublish.map((entry) => entry.outcome)).toEqual(["failed", "ok"]);
      expect(attemptsOfPublish[0]?.error).toContain(
        "publication must push exactly the reviewed head",
      );
      const failedIndex = state.steps.indexOf(attemptsOfPublish[0]!);
      expect(state.steps[failedIndex + 1]?.nodeId).toBe("observe");
      expect(routesAfter(state, failedIndex)[0]).toBe("publication");
      expect(headsOf(attemptsOfPublish[1]!)).toEqual([work.heads[0]]);
    },
    GRAPH_RUN_TIMEOUT_MS,
  );
});

/** A GitLab branch pipeline of the fixture task branch. */
function branchPipeline(sha: string | undefined, status: string) {
  return { sha, status, ref: "feat/demo" };
}

/** Submits an invalid output the way a model would, and returns the validation error it gets. */
async function refusedOutput(request: AgentStepRequest, output: unknown): Promise<string> {
  const result = await request.accept(output);
  if (result.ok) throw new Error(`expected ${request.contract.nodeId} to refuse the output`);
  return result.error;
}

describe("autoimplement end publication before review", () => {
  it(
    "commits again instead of pushing and refuses comments until the clean review",
    async () => {
      const refused: string[] = [];
      let publicationResults = 0;
      const decide = async (request: AgentStepRequest): Promise<AgentStepSubmission> => {
        if (observationOf(request).latestAttempt?.nodeId === "publicationResult") {
          publicationResults += 1;
          // Right after the first local commit, ask to publish before any review.
          if (publicationResults === 1) {
            return await acceptedOutput(request, controlDecision("publication").output);
          }
          // After the second local commit, try to skip review and handle comments.
          if (publicationResults === 2) {
            const result = await request.accept(controlDecision("comments").output);
            if (result.ok) throw new Error("comments must not be available before review");
            refused.push(result.error);
          }
        }
        return chooseFirstControlRoute(request);
      };
      const { state, work } = await runTiming("github-end-early-publication", {
        forge: "github",
        prTiming: "end",
        decide,
      });
      expect(state.status, state.error).toBe("completed");
      expect(refused).toEqual([
        "autoimplement control route comments is not available; choose one of review, publication, redesign, blocked",
      ]);
      const ids = nodeIdsOf(state);
      const firstReview = ids.indexOf("runReview");
      expect(ids.slice(0, firstReview).filter((id) => id === "commitLocal")).toHaveLength(2);
      expect(
        state.steps
          .slice(0, firstReview)
          .filter((entry) => entry.nodeId === "routeVerifiedWorkspace")
          .map((entry) => entry.output),
      ).toEqual([{ route: "commitLocal" }, { route: "commitLocal" }]);
      expectPushesOnlyAfterCleanReview(state);
      expect(ids.indexOf("inspectComments")).toBeGreaterThan(ids.indexOf("publish"));
      expect(okSteps(state, "publish").map(headsOf)).toEqual([[work.head]]);
    },
    GRAPH_RUN_TIMEOUT_MS,
  );
});

describe("autoimplement GitLab CI with only unrelated failures", () => {
  it(
    "offers delivery only after a failed head pipeline of the published head",
    async () => {
      const refusals: string[] = [];
      const { state, work } = await runTiming("gitlab-unrelated-failures", {
        forge: "gitlab",
        prTiming: "early",
        inspectCi: async (request, local) => {
          const failed = (headPipeline: unknown) => {
            const inspection = ciInspection(
              fixture.repository,
              "failed",
              local.head,
              prFor("gitlab"),
            );
            return {
              targets: inspection.targets.map((entry) => ({
                ...entry,
                unrelatedFailures: ["external job timed out"],
                headPipeline,
              })),
            };
          };
          for (const stale of [null, branchPipeline("9".repeat(40), "failed")]) {
            refusals.push(await refusedOutput(request, failed(stale)));
          }
          return await acceptedOutput(request, failed(branchPipeline(local.head, "failed")));
        },
      });
      expect(state.status, state.error).toBe("completed");
      expect(refusals).toHaveLength(2);
      for (const error of refusals) {
        expect(error).toContain(
          `CI targets[0] can be failed only when the merge request head_pipeline ran for the published head ${work.head}`,
        );
      }
      const ciResult = state.steps.findIndex((entry) => entry.nodeId === "ciResult");
      expect(state.steps[ciResult]?.output).toMatchObject({
        sourceNode: "inspectCi",
        result: {
          route: "failed",
          unrelatedFailures: ["external job timed out"],
          targets: [{ headPipeline: branchPipeline(work.head, "failed") }],
        },
      });
      expect(routesAfter(state, ciResult)).toEqual(["delivery", "ci", "blocked"]);
      expect(okSteps(state, "finalizeDelivery")).toHaveLength(1);
    },
    GRAPH_RUN_TIMEOUT_MS,
  );
});

describe("autoimplement GitLab CI after a second publication", () => {
  it(
    "never reports green for an old, running, failed, or missing head pipeline of the new head",
    async () => {
      const refusals: Record<string, string[]> = { inspectCi: [], assessTrackedCi: [] };
      const green = (headPipeline: unknown) => ({ headPipeline });
      const watch = trackingCommandFor("gitlab");
      const pr = prFor("gitlab");
      let inspections = 0;
      let publications = 0;
      const { state, work } = await runTiming("gitlab-second-publication-ci", {
        forge: "gitlab",
        prTiming: "early",
        reviews: [{ p1: ["fix race"] }, {}],
        publish: async (request, local) => {
          publications += 1;
          await local.commit(`published-${publications}`);
          return await acceptedOutput(request, published(fixture.repository, local.head, pr));
        },
        inspectCi: async (request, local) => {
          inspections += 1;
          const [first, second] = local.heads;
          const target = (route: "green" | "pending", headPipeline: unknown) => {
            const inspection = ciInspection(fixture.repository, route, second!, pr, watch);
            return {
              targets: inspection.targets.map((entry) => ({ ...entry, ...green(headPipeline) })),
            };
          };
          if (inspections > 1) {
            return await acceptedOutput(
              request,
              target("green", branchPipeline(second, "success")),
            );
          }
          for (const headPipeline of [
            branchPipeline(first, "success"),
            branchPipeline(second, "running"),
            null,
          ]) {
            refusals.inspectCi!.push(await refusedOutput(request, target("green", headPipeline)));
          }
          return await acceptedOutput(request, target("pending", branchPipeline(first, "success")));
        },
        assessTrackedCi: async (request, local) => {
          const [first, second] = local.heads;
          for (const headPipeline of [
            branchPipeline(second, "failed"),
            branchPipeline(first, "success"),
            null,
          ]) {
            refusals.assessTrackedCi!.push(
              await refusedOutput(request, trackedAssessment("green", green(headPipeline))),
            );
          }
          return await acceptedOutput(
            request,
            trackedAssessment("pending", green(branchPipeline(second, "running"))),
          );
        },
      });
      expect(state.status, state.error).toBe("completed");
      const [first, second] = work.heads;
      expect(okSteps(state, "publish").map(headsOf)).toEqual([[first], [second]]);
      const expected = "can be green only when the";
      expect(refusals.inspectCi).toHaveLength(3);
      expect(refusals.assessTrackedCi).toHaveLength(3);
      for (const error of [...refusals.inspectCi!, ...refusals.assessTrackedCi!]) {
        expect(error).toContain(expected);
      }
      expect(refusals.inspectCi![0]).toContain(`ran for the published head ${second}`);
      expect(refusals.inspectCi![1]).toContain("status is success; reported running");
      expect(refusals.assessTrackedCi![0]).toContain("status is success; reported failed");
      // A pending assessment runs more local tests, and the controller then inspects CI again.
      const ids = nodeIdsOf(state);
      expect(ids.slice(ids.indexOf("assessTrackedCi") + 1, ids.lastIndexOf("inspectCi"))).toEqual([
        "opportunisticTest",
        "observe",
        "decide",
        "dispatch",
      ]);
      const ciResults = okSteps(state, "ciResult").map(
        (entry) => entry.output as { sourceNode: string; result: { route: string } },
      );
      expect(ciResults.map((entry) => [entry.sourceNode, entry.result.route])).toEqual([
        ["inspectCi", "green"],
      ]);
      expect(okSteps(state, "assessTrackedCi")[0]?.output).toMatchObject({
        route: "pending",
        targets: [{ headPipeline: branchPipeline(second, "running") }],
      });
      expect(okSteps(state, "inspectCi").map((entry) => entry.output)).toMatchObject([
        { route: "pending", targets: [{ headPipeline: branchPipeline(first, "success") }] },
        { route: "green", targets: [{ headPipeline: branchPipeline(second, "success") }] },
      ]);
      expect(okSteps(state, "opportunisticTest")).toHaveLength(1);
      expect(ids.indexOf("finalizeDelivery")).toBeGreaterThan(ids.lastIndexOf("inspectCi"));
      expect(await fs.readFile(fixture.glabLog, "utf8")).toBe(
        `${CANONICAL_GLAB_WATCH.join(" ")}\n`,
      );
    },
    GRAPH_RUN_TIMEOUT_MS,
  );
});

describe("autoimplement mid-run publication timing change", () => {
  it(
    "lets a human move end to early after a clean review and still pushes once",
    async () => {
      const settingsDefinition = autoimplementWorkflow.settings;
      if (settingsDefinition === undefined) throw new Error("autoimplement settings are missing");
      let externalStore: WorkflowRunStore | undefined;
      let scopeId: string | undefined;
      const changes: unknown[] = [];
      const databasePath = await makeStateDatabasePath("autoimplement-timing-github-end-to-early");
      const scenario = timingScenario({
        forge: "github",
        prTiming: "end",
        onReview: async (request) => {
          externalStore ??= new WorkflowRunStore(databasePath);
          scopeId = externalStore.findSettingsScope(request.contract.runId, "", 1)?.scopeId;
          if (scopeId === undefined) throw new Error("autoimplement settings scope is missing");
          changes.push(
            await externalStore.changeSettings(settingsDefinition, {
              runId: request.contract.runId,
              scopeId,
              requestId: "end-to-early",
              actor: { type: "human" },
              source: "interactive-command",
              patch: [{ op: "replace", path: "/prTiming", value: "early" }],
            }),
          );
        },
      });
      const engine = new WorkflowEngine({ executor: scenario.executor, databasePath });
      const { state } = await engine.run(autoimplementWorkflow, scenario.input);
      const scope = scopeId === undefined ? undefined : externalStore?.getSettingsScope(scopeId);
      externalStore?.close();

      expect(state.status, state.error).toBe("completed");
      expect(changes).toHaveLength(1);
      expect(scope).toMatchObject({ changeNumber: 1, settings: { prTiming: "early" } });
      expectPushesOnlyAfterCleanReview(state);
      expect(okSteps(state, "publish").map(headsOf)).toEqual([[scenario.work.heads[0]]]);
      expect(
        state.steps
          .filter((entry) => entry.nodeId === "routeVerifiedWorkspace")
          .map((entry) => entry.output),
      ).toEqual([{ route: "commitLocal" }, { route: "publishReviewed" }]);
      const decides = scenario.executor.requests.filter(
        (request) => request.contract.nodeId === "decide",
      );
      const reviewIndex = scenario.executor.requests.findIndex(
        (request) => request.contract.nodeId === "assessReview",
      );
      const laterDecides = scenario.executor.requests
        .slice(reviewIndex)
        .filter((request) => request.contract.nodeId === "decide");
      expect(decides[0]?.prompt).toContain("Publication timing: end.");
      expect(laterDecides.length).toBeGreaterThan(0);
      for (const request of laterDecides)
        expect(request.prompt).not.toContain("Publication timing");
    },
    GRAPH_RUN_TIMEOUT_MS,
  );
});

describe("autoimplement default-branch work with prTiming end", () => {
  it(
    "finalizes on the default branch and never commits through commitLocal",
    async () => {
      await git(fixture.repository, ["switch", "main"]);
      const prepared = {
        ...preparedWorkspaceFor(fixture),
        mode: "defaultBranch" as const,
        workBranch: "main",
        directDefaultBranchAuthorized: true,
      };
      const executor = summaryExecutor()
        .respond("decide", chooseFirstControlRoute)
        .respond("implement", {
          output: {
            status: "implemented",
            summary: "done",
            files: [],
            repositories: [fixture.repository],
            issueKind: null,
            evidence: "done",
          },
        })
        .respond("classifyImplementation", {
          output: { route: "verify", summary: "ready", evidence: "done" },
        })
        .respond("finalizeDefaultBranch", {
          output: {
            status: "completed",
            committed: false,
            pushed: false,
            merged: false,
            pr: "none",
            reportComment: "Verified local change retained.",
            reason: "No commit or push authority.",
          },
        });
      const engine = new WorkflowEngine({
        executor,
        databasePath: await makeStateDatabasePath("autoimplement-timing-default-branch"),
      });
      const { state } = await engine.run(autoimplementWorkflow, {
        task: "Verify direct default-branch work",
        ...documentedPlan({ steps: ["verify"] }),
        repository: fixture.repository,
        preparedWorkspace: prepared,
        directDefaultBranchAuthorized: true,
        verificationChecks: [
          {
            id: "verify",
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            cwd: fixture.repository,
            timeoutMs: 10_000,
            maxOutputChars: 100_000,
            readOnly: true,
            baseEligible: false,
            changedFileScope: false,
            findingFormat: "text",
          },
        ],
        merge: false,
        prTiming: "end",
      });
      expect(state.status, state.error).toBe("completed");
      const ids = nodeIdsOf(state);
      expect(ids).toContain("finalizeDefaultBranch");
      expect(ids).not.toContain("commitLocal");
      expect(ids).not.toContain("publish");
      expect(
        state.steps.find((entry) => entry.nodeId === "routeVerifiedWorkspace")?.output,
      ).toEqual({
        route: "defaultBranch",
      });
      for (const prompt of topLevelPrompts(executor)) {
        expect(prompt).not.toContain("Publication timing");
        expect(prompt).not.toContain("This run pushes only after the review gate passes.");
      }
      expect(state.finalOutput).toMatchObject({ delivery: { pr: "none" }, reviewRounds: [] });
    },
    GRAPH_RUN_TIMEOUT_MS,
  );
});

describe("autoimplement publication timing graph shape", () => {
  it("returns the new agent steps to the controller on failure and never on cancellation", () => {
    const compiled = compileWorkflowDefinition(autoimplementWorkflow);
    const edge = (from: string) =>
      compiled.edges.find((candidateEdge) => candidateEdge.from === from);
    expect(edge("commitLocal")).toEqual({
      from: "commitLocal",
      switch: {
        on: "$result.outcome",
        cases: { ok: "publicationResult", timed_out: "observe", failed: "observe" },
      },
    });
    expect(edge("verifyP2Local")).toEqual({
      from: "verifyP2Local",
      switch: {
        on: "$result.outcome",
        cases: { ok: "p2Result", timed_out: "observe", failed: "observe" },
      },
    });
    expect(edge("addressP2")).toEqual({
      from: "addressP2",
      switch: {
        on: "$result.outcome",
        cases: { ok: "routeAddressedP2", timed_out: "observe", failed: "observe" },
      },
    });
    expect(edge("routeAddressedP2")).toEqual({
      from: "routeAddressedP2",
      switch: { on: "$.route", cases: { push: "verifyP2", local: "verifyP2Local" } },
    });
    expect(edge("routeVerifiedWorkspace")).toEqual({
      from: "routeVerifiedWorkspace",
      switch: {
        on: "$.route",
        cases: {
          pullRequest: "publish",
          publishReviewed: "publish",
          commitLocal: "commitLocal",
          defaultBranch: "finalizeDefaultBranch",
        },
      },
    });
    expect(autoimplementWorkflow.nodes.commitLocal).toMatchObject({
      nodeType: "agent",
      timeoutMs: 30 * 60_000,
      statusDetail: "committing locally",
    });
    expect(autoimplementWorkflow.nodes.verifyP2Local).toMatchObject({
      nodeType: "agent",
      timeoutMs: 30 * 60_000,
      statusDetail: "verifying P2 changes locally",
    });
  });

  it("reports the local P2 verification when no shared verification result exists", () => {
    const node = autoimplementWorkflow.nodes.prepareCompleted;
    if (node?.nodeType !== "compute") throw new Error("prepareCompleted must be a compute node");
    const context = syntheticAutoimplementContext({
      settings: autoimplementSettingsValue({ prTiming: "end" }),
      outputs: { finalizeDelivery: { status: "completed", pr: GITHUB_RUN_PR } },
    });
    const local = { passed: true, pushed: false, repositories: [candidate("h2")] };
    const completed = node.run({
      ...context,
      state: { ...context.state, steps: [...context.state.steps, step("verifyP2Local", local)] },
    }) as { verification: unknown };
    expect(completed.verification).toEqual(local);
  });
});
