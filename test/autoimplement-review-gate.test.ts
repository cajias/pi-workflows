import { describe, expect, it } from "vitest";
import {
  gateHead,
  gateHeadPushed,
  headPassesGate,
  latestWorkEvent,
  p2VerifiedHeads,
  recordedHeads,
  reviewCandidate,
  reviewGatePassed,
  reviewOf,
  reviewedHeadAwaitsPush,
  revisionPassesGate,
} from "../src/builtins/autoimplement-review-gate.js";
import type { WorkflowNodeOutcome, WorkflowStepRecord } from "../src/workflows/types.js";

const ID = "5f495c970c490173";

let sequence = 0;

function step(nodeId: string, output: unknown, outcome: WorkflowNodeOutcome = "ok") {
  sequence += 1;
  return {
    attemptId: `attempt-${sequence}`,
    nodeId,
    nodeType: "agent",
    outcome,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    prompt: null,
    output,
  } satisfies WorkflowStepRecord;
}

function head(headRevision: string, dependencyFingerprint?: string) {
  return {
    id: ID,
    repository: "/repository",
    branch: "feat/demo",
    baseBranch: "main",
    headRevision,
    ...(dependencyFingerprint === undefined ? {} : { dependencyFingerprint }),
  };
}

/** A head record of `nodeId`, such as `commitLocal h1` or `verifyP2Local h2 passed`. */
function recorded(
  nodeId: string,
  headRevision: string,
  extra: Record<string, unknown> = {},
  outcome: WorkflowNodeOutcome = "ok",
) {
  return step(nodeId, { ...extra, repositories: [head(headRevision)] }, outcome);
}

function review(
  headRevision: string,
  findings: { p0?: string[]; p1?: string[]; p2?: string[] } = {},
  options: { invocationSucceeded?: boolean; dependencyFingerprint?: string } = {},
) {
  const list = (items: string[] = []) => items.map((summary) => ({ summary }));
  return step("assessReview", {
    repositories: [
      {
        ...head(headRevision, options.dependencyFingerprint),
        invocationSucceeded: options.invocationSucceeded ?? true,
        p0: list(findings.p0),
        p1: list(findings.p1),
        p2: list(findings.p2),
        lower: [],
      },
    ],
  });
}

const edit = (nodeId: string, outcome: WorkflowNodeOutcome = "ok") =>
  step(nodeId, outcome === "ok" ? { done: true } : null, outcome);

type Scenario = {
  name: string;
  steps: WorkflowStepRecord[];
  event: string;
  gate: boolean;
  pushed: boolean;
};

/** The scenario table of the plan's "State predicates" section. */
const SCENARIOS: Scenario[] = [
  {
    name: "early: publish h1, review clean",
    steps: [edit("implement"), recorded("publish", "h1"), review("h1")],
    event: "publish h1",
    gate: true,
    pushed: true,
  },
  {
    name: "early: publish h1, review p2, addressP2, verifyP2 h2 passed",
    steps: [
      edit("implement"),
      recorded("publish", "h1"),
      review("h1", { p2: ["simplify"] }),
      edit("addressP2"),
      recorded("verifyP2", "h2", { passed: true, pushed: true }),
    ],
    event: "verifyP2 h2",
    gate: true,
    pushed: true,
  },
  {
    name: "end: fix, commitLocal h1, review clean",
    steps: [edit("fix"), recorded("commitLocal", "h1"), review("h1")],
    event: "commitLocal h1",
    gate: true,
    pushed: false,
  },
  {
    name: "end: fix, commitLocal h1, review clean, then publish h1",
    steps: [edit("fix"), recorded("commitLocal", "h1"), review("h1"), recorded("publish", "h1")],
    event: "publish h1",
    gate: true,
    pushed: true,
  },
  {
    name: "end: commitLocal h1, review p2, addressP2, verifyP2Local h2 passed",
    steps: [
      edit("implement"),
      recorded("commitLocal", "h1"),
      review("h1", { p2: ["simplify"] }),
      edit("addressP2"),
      recorded("verifyP2Local", "h2", { passed: true, pushed: false }),
    ],
    event: "verifyP2Local h2",
    gate: true,
    pushed: false,
  },
  {
    name: "end: after publish, a CI fix",
    steps: [recorded("commitLocal", "h1"), review("h1"), recorded("publish", "h1"), edit("fix")],
    event: "fix",
    gate: false,
    pushed: false,
  },
  {
    name: "end: commitLocal h1, review critical",
    steps: [recorded("commitLocal", "h1"), review("h1", { p1: ["race"] })],
    event: "commitLocal h1",
    gate: false,
    pushed: false,
  },
];

function describeEvent(event: WorkflowStepRecord | undefined): string {
  if (event === undefined) return "none";
  const heads = (event.output as { repositories?: Array<{ headRevision: string }> } | null)
    ?.repositories;
  return heads === undefined
    ? event.nodeId
    : `${event.nodeId} ${heads.map((entry) => entry.headRevision).join(",")}`;
}

describe("autoimplement review gate scenarios", () => {
  it.each(SCENARIOS)("$name", ({ steps, event, gate, pushed }) => {
    expect(describeEvent(latestWorkEvent(steps))).toBe(event);
    expect(reviewGatePassed(steps)).toBe(gate);
    expect(gateHeadPushed(steps)).toBe(pushed);
    expect(reviewedHeadAwaitsPush(steps)).toBe(gate && !pushed);
  });
});

describe("autoimplement review gate predicates", () => {
  it("counts failed and timed-out edits as local work", () => {
    for (const nodeId of ["implement", "fix", "addressP2"]) {
      for (const outcome of ["failed", "timed_out"] as const) {
        const steps = [recorded("commitLocal", "h1"), review("h1"), edit(nodeId, outcome)];
        expect(latestWorkEvent(steps)?.nodeId).toBe(nodeId);
        expect(reviewGatePassed(steps)).toBe(false);
        expect(gateHead(steps)).toBeUndefined();
      }
    }
  });

  it("ignores failed head records", () => {
    const steps = [
      recorded("commitLocal", "h1"),
      review("h1"),
      recorded("commitLocal", "h2", {}, "failed"),
      recorded("publish", "h2", {}, "timed_out"),
    ];
    expect(describeEvent(latestWorkEvent(steps))).toBe("commitLocal h1");
    expect(describeEvent(reviewCandidate(steps))).toBe("commitLocal h1");
    expect(reviewedHeadAwaitsPush(steps)).toBe(true);
    expect(gateHead(steps)).toEqual([head("h1")]);
  });

  it("passes the gate with an earlier clean review of the same identity", () => {
    const steps = [
      recorded("commitLocal", "h1"),
      review("h1"),
      edit("fix"),
      recorded("commitLocal", "h1"),
    ];
    expect(reviewGatePassed(steps)).toBe(true);
    expect(gateHeadPushed(steps)).toBe(false);
  });

  it("ties a review to the dependency fingerprint and to a successful invocation", () => {
    const fingerprinted = [
      recorded("commitLocal", "h1"),
      review("h1", {}, { dependencyFingerprint: "sha256:other" }),
    ];
    expect(reviewOf(fingerprinted, head("h1"))).toBeUndefined();
    expect(reviewGatePassed(fingerprinted)).toBe(false);
    const failedInvocation = [
      recorded("commitLocal", "h1"),
      review("h1", {}, { invocationSucceeded: false }),
    ];
    expect(reviewOf(failedInvocation, head("h1"))).toBeUndefined();
    expect(reviewGatePassed(failedInvocation)).toBe(false);
  });

  it("reads the newest successful review of a head", () => {
    const steps = [
      recorded("commitLocal", "h1"),
      review("h1", { p0: ["broken"] }),
      review("h2"),
      step("assessReview", { reason: "no repositories" }),
      step("assessReview", null, "failed"),
    ];
    expect(reviewOf(steps, head("h1"))).toBe("critical");
    expect(reviewOf(steps, head("h2"))).toBe("clean");
    expect(reviewOf([...steps, review("h1", { p2: ["tidy"] })], head("h1"))).toBe("p2");
    expect(reviewOf(steps, head("h3"))).toBeUndefined();
  });

  it("fails the gate after a failed or unpassed P2 verification", () => {
    const base = [recorded("commitLocal", "h1"), review("h1", { p2: ["tidy"] }), edit("addressP2")];
    const unpassed = [...base, recorded("verifyP2Local", "h2", { passed: false, pushed: false })];
    expect(describeEvent(latestWorkEvent(unpassed))).toBe("verifyP2Local h2");
    expect(reviewGatePassed(unpassed)).toBe(false);
    expect(p2VerifiedHeads(unpassed)).toEqual([]);
    const failed = [...base, recorded("verifyP2Local", "h2", { passed: true }, "failed")];
    expect(latestWorkEvent(failed)?.nodeId).toBe("addressP2");
    expect(reviewGatePassed(failed)).toBe(false);
  });

  it("accepts a P2-verified head only after a P2-only review of its parent candidate", () => {
    const verified = recorded("verifyP2Local", "h2", { passed: true, pushed: false });
    const afterP2 = [recorded("commitLocal", "h1"), review("h1", { p2: ["tidy"] }), verified];
    expect(p2VerifiedHeads(afterP2)).toEqual([head("h2")]);
    expect(headPassesGate(afterP2, head("h2"))).toBe(true);
    const afterCritical = [
      recorded("commitLocal", "h1"),
      review("h1", { p1: ["race"], p2: ["tidy"] }),
      verified,
    ];
    expect(p2VerifiedHeads(afterCritical)).toEqual([]);
    expect(reviewGatePassed(afterCritical)).toBe(false);
    const unreviewed = [recorded("commitLocal", "h1"), verified];
    expect(p2VerifiedHeads(unreviewed)).toEqual([]);
    expect(p2VerifiedHeads([verified])).toEqual([]);
    const unchanged = [
      recorded("commitLocal", "h1"),
      review("h1", { p2: ["tidy"] }),
      recorded("verifyP2Local", "h1", { passed: true, pushed: false }),
    ];
    expect(reviewGatePassed(unchanged)).toBe(true);
  });

  it("finds whether a commit passed the gate under any recorded identity", () => {
    const reviewedClean = [recorded("commitLocal", "h1"), review("h1")];
    expect(revisionPassesGate(reviewedClean, ID, "h1")).toBe(true);
    expect(revisionPassesGate(reviewedClean, "other-id", "h1")).toBe(false);
    expect(revisionPassesGate(reviewedClean, ID, "h2")).toBe(false);
    // A later edit does not undo a clean review of that exact commit.
    expect(revisionPassesGate([...reviewedClean, edit("fix")], ID, "h1")).toBe(true);
    expect(
      revisionPassesGate([recorded("commitLocal", "h1"), review("h1", { p1: ["race"] })], ID, "h1"),
    ).toBe(false);
    expect(revisionPassesGate([recorded("commitLocal", "h1")], ID, "h1")).toBe(false);
    // A review without a recorded head, or a failed record, gives no identity to check.
    expect(revisionPassesGate([review("h1")], ID, "h1")).toBe(false);
    expect(
      revisionPassesGate([recorded("commitLocal", "h1", {}, "failed"), review("h1")], ID, "h1"),
    ).toBe(false);
    const p2 = [
      recorded("commitLocal", "h1"),
      review("h1", { p2: ["tidy"] }),
      edit("addressP2"),
      recorded("verifyP2Local", "h2", { passed: true }),
    ];
    expect(revisionPassesGate(p2, ID, "h2")).toBe(true);
    expect(revisionPassesGate(p2, ID, "h1")).toBe(false);
  });

  it("reports only publish and verifyP2 as pushed heads", () => {
    const pushed = (nodeId: string) => gateHeadPushed([recorded(nodeId, "h1", { passed: true })]);
    expect(pushed("publish")).toBe(true);
    expect(pushed("verifyP2")).toBe(true);
    expect(pushed("commitLocal")).toBe(false);
    expect(pushed("verifyP2Local")).toBe(false);
    expect(gateHeadPushed([])).toBe(false);
    expect(reviewGatePassed([])).toBe(false);
    expect(gateHead([])).toBeUndefined();
  });

  it("reviews only commitLocal and publish records", () => {
    const steps = [
      recorded("publish", "h1"),
      recorded("commitLocal", "h2"),
      recorded("verifyP2Local", "h3", { passed: true }),
      recorded("verifyP2", "h4", { passed: true }),
    ];
    const candidate = reviewCandidate(steps);
    expect(candidate?.nodeId).toBe("commitLocal");
    expect(candidate === undefined ? [] : recordedHeads(candidate)).toEqual([head("h2")]);
    expect(reviewCandidate([edit("implement")])).toBeUndefined();
  });
});
