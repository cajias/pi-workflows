import type { WorkflowStepRecord } from "../workflows/types.js";
import type { CandidateRepository } from "./autoimplement-command-batches.js";

/**
 * Review-gate facts for Autoimplement publication timing.
 *
 * Every predicate is a pure function of the recorded steps. Under `prTiming: end`, the workflow
 * pushes a head only after the gate passes for exactly that head. Under `early`, the newest head
 * record is always a pushed one, so these predicates never change an upstream route.
 */

type Steps = readonly WorkflowStepRecord[];

/** The identity a review is tied to. */
export type HeadIdentity = { id: string; headRevision: string; dependencyFingerprint?: string };

export type ReviewVerdict = "clean" | "p2" | "critical";

/** Steps that can change files. Any outcome counts, because a failed or timed-out edit may be partial. */
const LOCAL_EDIT_NODES: ReadonlySet<string> = new Set(["implement", "fix", "addressP2"]);
/** Steps that record a head. Only `ok` outcomes count. */
const HEAD_RECORD_NODES: ReadonlySet<string> = new Set([
  "commitLocal",
  "publish",
  "verifyP2",
  "verifyP2Local",
]);
/** Head records whose head is on the remote. */
const PUSHED_RECORD_NODES: ReadonlySet<string> = new Set(["publish", "verifyP2"]);
/** Head records that review runs against. */
const CANDIDATE_NODES: ReadonlySet<string> = new Set(["commitLocal", "publish"]);
const P2_VERIFICATION_NODES: ReadonlySet<string> = new Set(["verifyP2", "verifyP2Local"]);

type ReviewEntry = HeadIdentity & {
  invocationSucceeded: boolean;
  p0: readonly unknown[];
  p1: readonly unknown[];
  p2: readonly unknown[];
};

function isHeadRecord(step: WorkflowStepRecord): boolean {
  return step.outcome === "ok" && HEAD_RECORD_NODES.has(step.nodeId);
}

function sameHead(left: HeadIdentity, right: HeadIdentity): boolean {
  return (
    left.id === right.id &&
    left.headRevision === right.headRevision &&
    left.dependencyFingerprint === right.dependencyFingerprint
  );
}

/** The repositories an accepted head record or review candidate reports. */
export function recordedHeads(step: WorkflowStepRecord): CandidateRepository[] {
  return (step.output as { repositories: CandidateRepository[] }).repositories;
}

function isPassedP2Verification(step: WorkflowStepRecord): boolean {
  return (
    step.outcome === "ok" &&
    P2_VERIFICATION_NODES.has(step.nodeId) &&
    (step.output as { passed?: unknown }).passed === true
  );
}

/** The newest edit step (any outcome) or accepted head record. */
export function latestWorkEvent(steps: Steps): WorkflowStepRecord | undefined {
  return steps.findLast((step) => LOCAL_EDIT_NODES.has(step.nodeId) || isHeadRecord(step));
}

/** The newest accepted `commitLocal` or `publish` step: the record that review runs against. */
export function reviewCandidate(steps: Steps): WorkflowStepRecord | undefined {
  return steps.findLast((step) => step.outcome === "ok" && CANDIDATE_NODES.has(step.nodeId));
}

function reviewEntry(steps: Steps, head: HeadIdentity): ReviewEntry | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.nodeId !== "assessReview" || step.outcome !== "ok") continue;
    const entries = (step.output as { repositories?: ReviewEntry[] }).repositories ?? [];
    const entry = entries.find(
      (candidate) => candidate.invocationSucceeded && sameHead(candidate, head),
    );
    if (entry !== undefined) return entry;
  }
  return undefined;
}

/** The newest successful review of exactly this head, or undefined when none exists. */
export function reviewOf(steps: Steps, head: HeadIdentity): ReviewVerdict | undefined {
  const entry = reviewEntry(steps, head);
  if (entry === undefined) return undefined;
  if (entry.p0.length + entry.p1.length > 0) return "critical";
  return entry.p2.length > 0 ? "p2" : "clean";
}

/**
 * Heads of passed P2 verifications whose parent candidate, the newest `commitLocal` or `publish`
 * before them, had a P2-only review for every repository.
 */
export function p2VerifiedHeads(steps: Steps): HeadIdentity[] {
  const heads: HeadIdentity[] = [];
  steps.forEach((step, index) => {
    if (!isPassedP2Verification(step)) return;
    const earlier = steps.slice(0, index);
    const parent = reviewCandidate(earlier);
    if (parent === undefined) return;
    if (recordedHeads(parent).every((head) => reviewOf(earlier, head) === "p2")) {
      heads.push(...recordedHeads(step));
    }
  });
  return heads;
}

/** A head passes when it was reviewed clean, or when it is a P2-verified head after a P2-only review. */
export function headPassesGate(steps: Steps, head: HeadIdentity): boolean {
  return (
    reviewOf(steps, head) === "clean" ||
    p2VerifiedHeads(steps).some((verified) => sameHead(verified, head))
  );
}

/**
 * True when a commit of repository `id` passed the review gate: a recorded head with that revision
 * passes, with whatever dependency fingerprint it was recorded and reviewed with.
 */
export function revisionPassesGate(steps: Steps, id: string, headRevision: string): boolean {
  return steps.some(
    (step) =>
      isHeadRecord(step) &&
      recordedHeads(step).some(
        (head) =>
          head.id === id && head.headRevision === headRevision && headPassesGate(steps, head),
      ),
  );
}

/**
 * True when the newest local work has passed the review gate: the newest work event is a head
 * record, it is not a failed P2 verification, and every head it records passes the gate.
 */
export function reviewGatePassed(steps: Steps): boolean {
  const event = latestWorkEvent(steps);
  if (event === undefined || !HEAD_RECORD_NODES.has(event.nodeId)) return false;
  if (P2_VERIFICATION_NODES.has(event.nodeId) && !isPassedP2Verification(event)) return false;
  return recordedHeads(event).every((head) => headPassesGate(steps, head));
}

/** True when the newest work event is a pushed head record. */
export function gateHeadPushed(steps: Steps): boolean {
  const event = latestWorkEvent(steps);
  return event !== undefined && PUSHED_RECORD_NODES.has(event.nodeId);
}

/** True when a head passed the review gate but is not pushed yet: the next publication pushes it. */
export function reviewedHeadAwaitsPush(steps: Steps): boolean {
  return reviewGatePassed(steps) && !gateHeadPushed(steps);
}

/** The repositories of the gate head record: the newest work event, when it records a head. */
export function gateHead(steps: Steps): CandidateRepository[] | undefined {
  const event = latestWorkEvent(steps);
  return event === undefined || !HEAD_RECORD_NODES.has(event.nodeId)
    ? undefined
    : recordedHeads(event);
}
