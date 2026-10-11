import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { repositoryId } from "../../src/builtins/autoimplement-command-batches.js";
import { digest } from "../../src/workflows/human-decision.js";
import type {
  AgentStepRequest,
  AgentStepSubmission,
  WorkflowNodeContext,
  WorkflowStepRecord,
} from "../../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor } from "../helpers.js";

/**
 * Shared fixtures for the Autoimplement forge, settings, and publication-timing suites.
 *
 * The suites run against a temporary Git repository on `feat/demo` with fake `pi-reviewer`, `gh`,
 * and `glab` executables first on `PATH`. Agent nodes are answered by a `ScriptedExecutor`, so no
 * model and no real forge is called.
 */

const execFileAsync = promisify(execFile);

export type AutoimplementFixture = {
  repository: string;
  commandDir: string;
  baseRevision: string;
  /** Each fake `glab` call appends its arguments to this file as one line. */
  glabLog: string;
  /** Restores the `PATH` that was active before the fixture started. */
  restore(): void;
};

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

export async function installCommand(
  commandDir: string,
  name: string,
  body: string,
): Promise<void> {
  await fs.writeFile(path.join(commandDir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

export async function setUpAutoimplementFixture(): Promise<AutoimplementFixture> {
  const originalPath = process.env.PATH ?? "";
  const commandDir = await makeTempDir("pi-workflows-autoimplement-commands");
  const repository = await makeTempDir("pi-workflows-autoimplement-fixture-repo");
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.name", "Test"]);
  await git(repository, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(repository, "README.md"), "fixture\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "fixture"]);
  const baseRevision = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["switch", "-c", "feat/demo"]);
  const glabLog = path.join(commandDir, "glab.log");
  await installCommand(commandDir, "pi-reviewer", "printf '%s\\n' \"review complete\"");
  await installCommand(commandDir, "gh", "printf '%s\\n' \"checks complete\"");
  await installCommand(
    commandDir,
    "glab",
    `printf '%s\\n' "$*" >> ${JSON.stringify(glabLog)}\nprintf '%s\\n' "pipeline complete"`,
  );
  process.env.PATH = `${commandDir}:${originalPath}`;
  return {
    repository,
    commandDir,
    baseRevision,
    glabLog,
    restore: () => {
      process.env.PATH = originalPath;
    },
  };
}

/** Complete Autoimplement settings with the upstream defaults. */
export function autoimplementSettingsValue(overrides: Record<string, unknown> = {}) {
  return {
    merge: false,
    addedInstructions: [] as string[],
    forge: "auto",
    prTiming: "early",
    ...overrides,
  };
}

export function preparedWorkspaceFor(fixture: AutoimplementFixture, target = fixture.repository) {
  return {
    schema: "pi-workflows.prepared-workspace.v1" as const,
    mode: "branch" as const,
    repository: target,
    baseBranch: "main",
    baseRevision: fixture.baseRevision,
    workBranch: "feat/demo",
    directDefaultBranchAuthorized: false,
    preExistingChangedPaths: [],
    evidence: ["test fixture"],
    scope: `Only ${target}`,
  };
}

export function documentedPlan(plan: unknown) {
  return {
    plan,
    documentation: { status: "current" as const, planDigest: digest(plan), documents: [] },
    approval: { mode: "skip" as const },
  };
}

export function published(
  repository: string,
  headRevision = "abc123",
  pr = "https://example.test/pr/1",
  branch = "feat/demo",
) {
  return {
    repositories: [{ repository, branch, baseBranch: "main", headRevision, pr, pushed: true }],
  };
}

export function reviewOf(
  repository: string,
  findings: { p1?: string[]; p2?: string[] } = {},
): Record<string, unknown> {
  const p1 = (findings.p1 ?? []).map((summary) => ({ kind: "implementation", summary }));
  const p2 = (findings.p2 ?? []).map((summary) => ({ kind: "implementation", summary }));
  const reason = p1.length + p2.length === 0 ? "No P0, P1, or P2 findings." : "Findings recorded.";
  return {
    repositories: [
      {
        id: repositoryId(repository),
        invocationSucceeded: true,
        p0: [],
        p1,
        p2,
        lower: [],
        reason,
      },
    ],
    reason,
  };
}

export function ciInspection(
  repository: string,
  route: "green" | "failed" | "pending" | "unavailable",
  headRevision = "abc123",
  pr = "https://example.test/pr/1",
  trackingCommand?: { command: string; args: string[] },
) {
  return {
    targets: [
      {
        repository,
        headRevision,
        pr,
        route,
        reason: route,
        relatedFailures: [],
        unrelatedFailures: [],
        ...(route === "pending"
          ? {
              trackingCommand: {
                id: repositoryId(repository),
                command: trackingCommand?.command ?? "gh",
                args: trackingCommand?.args ?? ["pr", "checks", "--watch"],
                cwd: repository,
                timeoutMs: 300_000,
                maxOutputChars: 1_000_000,
              },
            }
          : {}),
      },
    ],
  };
}

export function controlDecision(route: string, reason = `Choose ${route}.`): AgentStepSubmission {
  const complete = route === "complete";
  const blocked = route === "blocked";
  return {
    output: {
      route,
      goalMet: complete,
      blockingNow: blocked,
      outsideAuthority: blocked,
      canProceed: !complete && !blocked,
      reason,
      nextAction: complete || blocked ? "" : `Run the ${route} branch.`,
      alternativesChecked: blocked ? ["No safe continuing route remains"] : [],
      evidence: [`Current evidence supports ${route}.`],
    },
  };
}

/** Parses the observation line of a decide prompt. */
export function observationOf(request: AgentStepRequest): {
  availableRoutes: string[];
  latestAttempt?: { nodeId?: string; outcome?: string } | null;
} {
  const match = /Observation: (.+)\nRecent attempts:/.exec(request.prompt);
  if (match?.[1] === undefined)
    throw new Error("Autoimplement controller prompt lacks observation");
  return JSON.parse(match[1]) as { availableRoutes: string[] };
}

export function chooseFirstControlRoute(request: AgentStepRequest): AgentStepSubmission {
  const route = observationOf(request).availableRoutes[0];
  if (route === undefined) throw new Error("Autoimplement controller has no available route");
  return controlDecision(route, `Choose ${route} from the current evidence.`);
}

export function summaryExecutor(): ScriptedExecutor {
  return new ScriptedExecutor()
    .respond("completedSummary", () => ({
      output: "The approved work is complete. Validation passed.",
      assistantMessage: { sha256: "a".repeat(64) },
    }))
    .respond("blockedSummary", () => ({
      output: "Work stopped at the recorded blocker.",
      assistantMessage: { sha256: "b".repeat(64) },
    }));
}

export function verificationPlan(repository: string, id = "verify") {
  return {
    checks: [
      {
        id,
        command: process.execPath,
        args: ["-e", "process.stdout.write('passed')"],
        cwd: repository,
        timeoutMs: 60_000,
        maxOutputChars: 100_000,
        readOnly: true,
        baseEligible: true,
        changedFileScope: false,
        findingFormat: "text",
      },
    ],
    untested: [],
  };
}

/** Answers every node from implementation through local verification with a passing result. */
export function implementationExecutor(
  repository: string,
  decide: (request: AgentStepRequest) => AgentStepSubmission = chooseFirstControlRoute,
): ScriptedExecutor {
  return summaryExecutor()
    .respond("decide", decide)
    .respond("implement", {
      output: {
        status: "implemented",
        summary: "implemented",
        files: ["src/change.ts"],
        issueKind: null,
        evidence: "complete",
      },
    })
    .respond("classifyImplementation", {
      output: { route: "verify", summary: "ready", evidence: "implementation complete" },
    })
    .respond("localVerification/planChecks", { output: verificationPlan(repository) })
    .respond("verify", {
      output: {
        passed: true,
        commands: [{ command: "node verification", outcome: "passed" }],
        failures: [],
        untested: [],
      },
    })
    .respond("classifyVerification", {
      output: { route: "publish", summary: "checks passed", evidence: "npm test" },
    });
}

/** Answers every node from implementation through publication with a passing result. */
export function commonExecutor(
  repository: string,
  publication: unknown = published(repository),
  decide: (request: AgentStepRequest) => AgentStepSubmission = chooseFirstControlRoute,
): ScriptedExecutor {
  return implementationExecutor(repository, decide).respond("publish", { output: publication });
}

/** Submits an output through the step validator, as a model's workflow submit call would. */
export async function acceptedOutput(
  request: AgentStepRequest,
  output: unknown,
): Promise<AgentStepSubmission> {
  const result = await request.accept(output);
  if (!result.ok) throw new Error(`Scripted output rejected: ${result.error}`);
  return { output: result.value };
}

export function completedDelivery(pr = "https://example.test/pr/1", merged = false) {
  return {
    output: {
      status: "completed",
      merged,
      pr,
      reportComment: `${pr}#report`,
      reason: merged ? "merged" : "ready",
    },
  };
}

export type AutoimplementScenario = {
  executor: ScriptedExecutor;
  input: Record<string, unknown>;
};

function scenarioInput(repository: string, merge: boolean): Record<string, unknown> {
  return {
    task: "implement demo",
    ...documentedPlan({ steps: ["change code"] }),
    repository,
    merge,
  };
}

const NO_ACTIONABLE_COMMENTS = {
  output: { route: "ci", summary: "no actionable comments", evidence: [] },
};

/** One P2-only review, addressed and verified without a second reviewer run, then merged. */
export function p2PathScenario(
  repository: string,
  pr = "https://example.test/pr/1",
): AutoimplementScenario {
  const executor = commonExecutor(repository, published(repository, "abc123", pr))
    .respond("assessReview", { output: reviewOf(repository, { p2: ["simplify one branch"] }) })
    .respond("addressP2", { output: { addressed: ["simplified branch"], skipped: [] } })
    .respond("verifyP2", {
      output: {
        passed: true,
        commands: [{ command: "npm test", outcome: "passed" }],
        pushed: true,
        repositories: published(repository, "def456", pr).repositories,
      },
    })
    .respond("inspectComments", NO_ACTIONABLE_COMMENTS)
    .respond("inspectCi", { output: ciInspection(repository, "green", "def456", pr) })
    .respond("finalizeDelivery", completedDelivery(pr, true));
  return { executor, input: scenarioInput(repository, true) };
}

/** One P1 finding, fixed, verified, published again, and reviewed clean, then merged. */
export function p1PathScenario(
  repository: string,
  pr = "https://example.test/pr/1",
): AutoimplementScenario {
  const passed = (outcome: string) => ({
    output: {
      passed: true,
      commands: [{ command: "npm test", outcome }],
      failures: [],
      untested: [],
    },
  });
  const executor = commonExecutor(repository, published(repository, "one", pr))
    .respond("verify", passed("passed again"))
    .respond("classifyVerification", {
      output: { route: "publish", summary: "passed", evidence: "second" },
    })
    .respond("publish", { output: published(repository, "two", pr) })
    .respond(
      "assessReview",
      { output: reviewOf(repository, { p1: ["fix race"] }) },
      { output: reviewOf(repository) },
    )
    .respond("fix", { output: { fixed: "fixed race", files: ["src/change.ts"] } })
    .respond("inspectComments", NO_ACTIONABLE_COMMENTS)
    .respond("inspectCi", { output: ciInspection(repository, "green", "two", pr) })
    .respond("finalizeDelivery", completedDelivery(pr, true));
  return { executor, input: scenarioInput(repository, true) };
}

/** A clean review, then one pending CI target that runs its bound watch before delivery. */
export function pendingCiScenario(
  repository: string,
  pr = "https://example.test/pr/1",
  trackingCommand?: { command: string; args: string[] },
): AutoimplementScenario {
  const executor = commonExecutor(repository, published(repository, "abc123", pr))
    .respond("assessReview", { output: reviewOf(repository) })
    .respond("inspectComments", NO_ACTIONABLE_COMMENTS)
    .respond("inspectCi", {
      output: ciInspection(repository, "pending", "abc123", pr, trackingCommand),
    })
    .respond("assessTrackedCi", {
      output: {
        route: "green",
        reason: "checks passed",
        targets: [{ id: repositoryId(repository), route: "green", reason: "checks passed" }],
        relatedFailures: [],
        unrelatedFailures: [],
      },
    })
    .respond("finalizeDelivery", completedDelivery(pr, false));
  return { executor, input: scenarioInput(repository, false) };
}

/**
 * Fixed values for the synthetic prompt context.
 *
 * The GitHub golden literals in `test/builtin-autoimplement-forge.test.ts` were recorded from these
 * exact values against upstream HEAD. Changing any value here changes every golden prompt.
 */
export const GOLDEN_REPOSITORY = "/golden/repository";
export const GOLDEN_PR = "https://github.com/golden/repository/pull/7";
export const GOLDEN_HEAD = "abc123";

const GOLDEN_WORKSPACE = {
  schema: "pi-workflows.prepared-workspace.v1",
  mode: "branch",
  repository: GOLDEN_REPOSITORY,
  baseBranch: "main",
  baseRevision: "base000",
  workBranch: "feat/golden",
  directDefaultBranchAuthorized: false,
  preExistingChangedPaths: [],
  evidence: ["golden fixture"],
  scope: `Only ${GOLDEN_REPOSITORY}`,
};

function goldenStep(index: number, nodeId: string, output: unknown): WorkflowStepRecord {
  const second = String(index).padStart(2, "0");
  return {
    attemptId: `golden-attempt-${index}`,
    nodeId,
    nodeType: "compute",
    outcome: "ok",
    startedAt: `2026-01-01T00:00:${second}.000Z`,
    finishedAt: `2026-01-01T00:00:${second}.500Z`,
    prompt: null,
    output,
  };
}

export type SyntheticContextOptions = {
  merge?: boolean;
  pr?: string;
  /** Extra or replacement outputs, such as a recorded `resolveForge` result. */
  outputs?: Record<string, unknown>;
  settings?: Record<string, unknown>;
};

/**
 * A complete, deterministic Autoimplement node context in which every agent prompt can render.
 *
 * The context holds one published repository, a P2 review, a pending CI inspection with its watch
 * batch, and prepared completed and blocked results.
 */
export function syntheticAutoimplementContext(
  options: SyntheticContextOptions = {},
): WorkflowNodeContext {
  const pr = options.pr ?? GOLDEN_PR;
  const id = repositoryId(GOLDEN_REPOSITORY);
  const plan = { summary: "Ship the golden change", steps: ["change code", "verify"] };
  const publication = {
    repositories: [
      {
        id,
        repository: GOLDEN_REPOSITORY,
        branch: "feat/golden",
        baseBranch: "main",
        headRevision: GOLDEN_HEAD,
        pr,
      },
    ],
  };
  const implementation = {
    status: "implemented",
    summary: "Implemented the golden change.",
    files: ["src/golden.ts"],
    repositories: [GOLDEN_REPOSITORY],
    issueKind: null,
    evidence: "complete",
  };
  const review = {
    route: "p2",
    invocationSucceeded: true,
    p0: [],
    p1: [],
    p2: [{ severity: "P2", kind: "implementation", summary: "Simplify one branch." }],
    lower: [],
    reason: "One P2 finding.",
    repositories: [
      {
        id,
        repository: GOLDEN_REPOSITORY,
        baseBranch: "main",
        headRevision: GOLDEN_HEAD,
        invocationSucceeded: true,
        p0: [],
        p1: [],
        p2: [{ severity: "P2", kind: "implementation", summary: "Simplify one branch." }],
        lower: [],
        reason: "One P2 finding.",
      },
    ],
  };
  const reviewerBatch = {
    schema: "pi-workflows.command-batch-result.v1",
    completed: 1,
    total: 1,
    items: [
      {
        id,
        command: "pi-reviewer",
        args: ["--base", "main"],
        cwd: GOLDEN_REPOSITORY,
        stdout: "review complete",
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 10,
        outcome: "succeeded",
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    ],
  };
  const selection = {
    route: "run",
    repositories: publication.repositories,
    commands: [
      {
        id,
        command: "pi-reviewer",
        args: ["--base", "main"],
        cwd: GOLDEN_REPOSITORY,
        timeoutMs: 600_000,
        maxOutputChars: 1_000_000,
      },
    ],
  };
  const trackingCommand = {
    id,
    command: "gh",
    args: ["pr", "checks", pr, "--watch"],
    cwd: GOLDEN_REPOSITORY,
    timeoutMs: 300_000,
    maxOutputChars: 1_000_000,
  };
  const inspection = {
    route: "pending",
    reason: `${id}: checks are running`,
    relatedFailures: [],
    unrelatedFailures: [],
    targets: [
      {
        id,
        repository: GOLDEN_REPOSITORY,
        headRevision: GOLDEN_HEAD,
        pr,
        route: "pending",
        reason: "checks are running",
        relatedFailures: [],
        unrelatedFailures: [],
        trackingCommand,
      },
    ],
  };
  const watch = {
    route: "repair",
    batch: {
      schema: "pi-workflows.command-batch-result.v1",
      completed: 1,
      total: 1,
      items: [
        {
          id,
          command: "gh",
          args: trackingCommand.args,
          cwd: GOLDEN_REPOSITORY,
          stdout: "checks pending",
          stderr: "",
          exitCode: null,
          signal: null,
          durationMs: 300_000,
          outcome: "timedOut",
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      ],
    },
  };
  const observation = {
    decisionNumber: 7,
    decisionLimit: 40,
    consecutiveNoProgressAttempts: 0,
    progressFingerprint: `sha256:${"d".repeat(64)}`,
    lastRoute: "ci",
    latestAttempt: { nodeId: "trackCi", outcome: "ok", output: watch },
    availableRoutes: ["ci", "repair", "blocked"],
  };
  const completed = {
    status: "completed",
    task: "Ship the golden change",
    plan,
    implementation,
    verification: { passed: true },
    reviewRounds: [review],
    ci: { route: "green", reason: "checks passed" },
    delivery: { status: "completed", merged: false, pr, reportComment: `${pr}#report` },
  };
  const blocked = {
    status: "blocked",
    task: "Ship the golden change",
    reason: "CI is unavailable.",
    evidence: { route: "unavailable" },
  };
  const steps = [
    goldenStep(1, "prepare", { task: "Ship the golden change", repository: GOLDEN_REPOSITORY }),
    goldenStep(2, "implement", implementation),
    goldenStep(3, "publish", publication),
    goldenStep(4, "selectReviewCommands", selection),
    goldenStep(5, "runReview", { route: "assess", batch: reviewerBatch }),
    goldenStep(6, "assessReview", review),
    goldenStep(7, "reviewResult", { sourceNode: "assessReview", outcome: "ok", result: review }),
    goldenStep(8, "inspectCi", inspection),
    goldenStep(9, "trackCi", watch),
  ];
  return {
    input: {
      task: "Ship the golden change",
      plan,
      scope: `Only ${GOLDEN_REPOSITORY}. May edit, test, commit, push, and open a pull request.`,
      constraints: ["Keep the public API."],
      repository: GOLDEN_REPOSITORY,
      baseBranch: "main",
      merge: options.merge === true,
      documents: ["docs/golden.md"],
      preparedWorkspace: GOLDEN_WORKSPACE,
    },
    outputs: {
      prepare: steps[0]?.output,
      implement: implementation,
      publish: publication,
      selectReviewCommands: selection,
      runReview: { route: "repair", batch: reviewerBatch },
      assessReview: review,
      inspectCi: inspection,
      trackCi: watch,
      observe: observation,
      prepareCompleted: completed,
      prepareBlocked: blocked,
      ...options.outputs,
    },
    results: {},
    state: {
      schema: "pi-workflows.run-state.v1",
      traceSeq: 1,
      runId: "golden-run",
      workflowName: "autoimplement",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      status: "running",
      input: {},
      outputs: {},
      results: {},
      steps,
    },
    settings: autoimplementSettingsValue({ merge: options.merge === true, ...options.settings }),
    signal: new AbortController().signal,
  };
}
