import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ServerStateStore } from "../src/server/state.js";
import { ServerViewStore } from "../src/server/view.js";
import { StateDatabase } from "../src/state/database.js";
import { canonicalJson } from "../src/state/json.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { action, agent, defineWorkflow, idempotentEffect } from "../src/workflows/definition.js";
import { workflowStateViolations } from "../src/workflows/diagnostics.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import {
  createDefinitionSnapshot,
  settleCancelledRunProgress,
  WorkflowRunStore,
} from "../src/workflows/store.js";
import type { WorkflowDefinition, WorkflowUpdateRecord } from "../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor, waitUntil } from "./helpers.js";
import { claimTestRun } from "./queue-helpers.js";

function progress(status: string, extra: Record<string, unknown> = {}) {
  return { schema: "pi-workflows.progress.v1", status, ...extra };
}

function byKey(updates: readonly WorkflowUpdateRecord[] | undefined) {
  return new Map((updates ?? []).map((update) => [`${update.type}:${update.key}`, update]));
}

/** A claimed queue run in a private database, without the production scheduler. */
function claimedRun(
  name: string,
  projectPath: string,
  databasePath: string,
  workflow: WorkflowDefinition,
) {
  const state = new StateDatabase({ filePath: databasePath });
  const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
  const runId = `run-${name}`;
  const claimToken = `claim-${name}`;
  const sessionId = `session-${name}`;
  const snapshot = createDefinitionSnapshot(workflow);
  claimTestRun(queue, {
    runId,
    workflowName: workflow.name,
    workflowSourceRef: `builtin:${name}`,
    workflowSource: { root: { kind: "builtin", id: name, revision: "test" }, mounted: [] },
    definitionDigest: createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
    definitionSnapshot: snapshot,
    input: {},
    runnerId: name,
    claimToken,
    leaseMs: 60_000,
    originSessionId: sessionId,
  });
  /** A run store whose writes carry one runner's claim, as a supervised runner's do. */
  const storeFor = (token: string) =>
    new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority(runId, token),
    });
  return { state, queue, runId, claimToken, sessionId, storeFor };
}

/**
 * One claimed run whose action publishes open, terminal, and non-progress
 * updates and then ignores its abort signal, like a runner that the workflow
 * server stops after it commits a cancellation.
 */
async function startRun(name: string) {
  const projectPath = await makeTempDir(`${name}-project`);
  const databasePath = path.join(await makeTempDir(`${name}-state`), "state.sqlite");
  let started = false;
  const workflow = compileWorkflowDefinition(
    defineWorkflow({
      name,
      startAt: "review",
      nodes: {
        review: action({
          effect: idempotentEffect(`test.${name}`),
          run: async ({ publishUpdate }) => {
            await publishUpdate({
              type: "progress",
              key: "agents/review",
              data: progress("running", { phase: "review", completed: 1, total: 3, unit: "s" }),
            });
            await publishUpdate({
              type: "progress",
              key: "agents/review/a",
              data: progress("running", { label: "Reviewer A", phase: "tool: read" }),
            });
            await publishUpdate({
              type: "progress",
              key: "agents/review/b",
              data: progress("pending", { phase: "pending" }),
            });
            await publishUpdate({
              type: "progress",
              key: "agents/review/c",
              data: progress("completed", { phase: "completed" }),
            });
            await publishUpdate({ type: "note", key: "agents/review/a", data: { open: true } });
            started = true;
            return await new Promise<never>(() => undefined);
          },
        }),
      },
      edges: [],
    }),
  );
  const claimed = claimedRun(name, projectPath, databasePath, workflow);
  const { state, queue, runId, claimToken, sessionId } = claimed;
  const serverState = new ServerStateStore(databasePath, { state });
  const runs = claimed.storeFor(claimToken);
  const engine = new WorkflowEngine({ store: runs, executor: new ScriptedExecutor() });
  const running = engine.run(workflow, {}, { runId });
  await waitUntil(() => started);
  const views = new ServerViewStore(
    state,
    queue,
    serverState,
    runs,
    () => false,
    () => false,
  );
  return { state, queue, runs, views, engine, running, runId, claimToken, sessionId };
}

/** The stored `node_attempts` facts behind an `unrecordedAttempts` entry. */
function attemptRow(state: StateDatabase, attemptId: string | undefined) {
  return state.connection
    .prepare(
      `SELECT status, started_at AS startedAt, finished_at AS finishedAt, updated_at AS updatedAt
       FROM node_attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
}

const open = ["agents/review", "agents/review/a", "agents/review/b"];

function expectSettled(updates: readonly WorkflowUpdateRecord[] | undefined, attemptId: string) {
  const current = byKey(updates);
  expect(current.get("progress:agents/review")).toMatchObject({
    attemptId,
    data: progress("cancelled", { phase: "cancelled", completed: 1, total: 3, unit: "s" }),
  });
  expect(current.get("progress:agents/review/a")?.data).toEqual(
    progress("cancelled", { label: "Reviewer A", phase: "cancelled" }),
  );
  expect(current.get("progress:agents/review/b")?.data).toEqual(
    progress("cancelled", { phase: "cancelled" }),
  );
  expect(current.get("progress:agents/review/c")?.data).toEqual(
    progress("completed", { phase: "completed" }),
  );
  expect(current.get("note:agents/review/a")?.data).toEqual({ open: true });
}

describe("progress of a cancelled run", () => {
  it("settles open tracks in the cancellation transaction of an active run", async () => {
    const run = await startRun("active-cancel");
    const before = run.runs.runRevision(run.runId);
    const attemptId = run.runs.readRunState(run.runId)?.currentAttemptId;
    if (attemptId === undefined) throw new Error("active attempt missing");

    expect(run.queue.cancelWorkflowRun({ runId: run.runId, claimToken: run.claimToken })).toBe(
      true,
    );

    // One revision for each settled track and one for the cancellation itself.
    const after = run.runs.runRevision(run.runId);
    expect(after).toBe(before + open.length + 1);
    const loaded = run.runs.readRun(run.runId, { includeTrace: true });
    expect(loaded?.state.status).toBe("cancelled");
    expectSettled(loaded?.state.updates, attemptId);
    const tail = loaded?.traceEvents?.slice(-(open.length + 1)) ?? [];
    expect(tail.map((event) => [event.seq, event.type])).toEqual([
      [before + 1, "update_published"],
      [before + 2, "update_published"],
      [before + 3, "update_published"],
      [before + 4, "run.queue_cancelled"],
    ]);
    expect(tail.slice(0, open.length).map((event) => event.payload.key)).toEqual(open);
    expect(tail.slice(0, open.length).every((event) => event.attemptId === attemptId)).toBe(true);
    for (const event of tail.slice(0, open.length)) {
      const record = byKey(loaded?.state.updates).get(`progress:${String(event.payload.key)}`);
      expect(record).toMatchObject({ seq: event.seq, updateId: event.payload.updateId });
      expect(record?.data).toEqual(event.payload.data);
    }
    expect(
      run.state.connection
        .prepare("SELECT status FROM node_attempts WHERE attempt_id = ?")
        .get(attemptId),
    ).toEqual({ status: "cancelled" });

    const view = run.views.run(run.runId);
    expect(view?.runRevision).toBe(after);
    expectSettled(view?.updates as WorkflowUpdateRecord[] | undefined, attemptId);
    run.state.integrityCheck();
    expect(workflowStateViolations(run.state)).toEqual([]);

    // The cancelled attempt has no step record, so the run lists it as unrecorded.
    const runFinishedAt = run.state.connection
      .prepare("SELECT finished_at AS finishedAt FROM runs WHERE run_id = ?")
      .get(run.runId);
    const cancelledRow = attemptRow(run.state, attemptId);
    const unrecorded = run.runs.readRunState(run.runId)?.unrecordedAttempts;
    expect(unrecorded).toEqual([expect.objectContaining({ attemptId, nodeId: "review" })]);

    // The stopped runner has lost its claim, so it cannot overwrite the settlement or bring
    // its attempt back.
    run.engine.cancel();
    await expect(run.running).rejects.toThrow(/claim lost/);
    expect(run.runs.runRevision(run.runId)).toBe(after);
    const final = run.runs.readRunState(run.runId);
    expect(final?.status).toBe("cancelled");
    expectSettled(final?.updates, attemptId);
    expect(final?.unrecordedAttempts).toEqual(unrecorded);
    expect(attemptRow(run.state, attemptId)).toEqual(cancelledRow);
    expect(
      run.state.connection
        .prepare("SELECT finished_at AS finishedAt FROM runs WHERE run_id = ?")
        .get(run.runId),
    ).toEqual(runFinishedAt);
    run.state.close();
  }, 60_000);

  it("settles open tracks when a paused run without a live claim is cancelled", async () => {
    const run = await startRun("paused-cancel");
    const attemptId = run.runs.readRunState(run.runId)?.currentAttemptId;
    if (attemptId === undefined) throw new Error("active attempt missing");
    // Like the workflow server's pause, mark the run paused, release its claim,
    // and stop the runner in the middle of the node.
    run.state.transaction(() => {
      run.state.connection
        .prepare("UPDATE runs SET paused = 1, status_detail = 'paused' WHERE run_id = ?")
        .run(run.runId);
      expect(run.queue.parkWorkflowRun({ runId: run.runId, claimToken: run.claimToken })).toBe(
        true,
      );
    });
    run.engine.park();
    await run.running;
    const before = run.runs.runRevision(run.runId);

    expect(run.queue.cancelWorkflowRun({ runId: run.runId })).toBe(true);

    expect(run.runs.runRevision(run.runId)).toBe(before + open.length + 1);
    const loaded = run.runs.readRun(run.runId, { includeTrace: true });
    expect(loaded?.state.status).toBe("cancelled");
    expectSettled(loaded?.state.updates, attemptId);
    expect(loaded?.traceEvents?.at(-1)?.type).toBe("run.queue_cancelled");
    expect(workflowStateViolations(run.state)).toEqual([]);
    run.state.close();
  }, 60_000);

  it("settles progress only inside the cancellation transaction", async () => {
    const run = await startRun("outside-transaction");
    expect(() => settleCancelledRunProgress(run.state, run.runId, Date.now())).toThrow(
      /inside the cancellation transaction/,
    );
    run.engine.cancel();
    await run.running;
    run.state.close();
  }, 60_000);

  it("rolls back the settlement with the cancellation", async () => {
    const run = await startRun("rolled-back-cancel");
    const before = run.runs.runRevision(run.runId);
    const updates = run.state.connection.prepare("SELECT count(*) AS count FROM workflow_updates");
    const count = updates.get();
    run.state.connection.exec(
      `CREATE TEMP TRIGGER reject_cancel BEFORE UPDATE OF status ON node_attempts
       WHEN NEW.status = 'cancelled' BEGIN SELECT RAISE(ABORT, 'cancel rejected'); END`,
    );

    expect(() =>
      run.queue.cancelWorkflowRun({ runId: run.runId, claimToken: run.claimToken }),
    ).toThrow(/cancel rejected/);

    expect(run.runs.runRevision(run.runId)).toBe(before);
    expect(updates.get()).toEqual(count);
    expect(
      byKey(run.runs.readRunState(run.runId)?.updates).get("progress:agents/review")?.data,
    ).toMatchObject({ status: "running" });
    run.state.connection.exec("DROP TRIGGER reject_cancel");
    run.engine.cancel();
    await run.running;
    run.state.close();
  }, 60_000);
});

/**
 * A claimed `verifyP2` agent run that publishes progress, parks in its first
 * attempt, and resumes in a second runner whose replacement attempt publishes
 * its own tracks and then waits. The resume retires the parked attempt
 * without a step record.
 */
async function resumedVerifyP2(name: string) {
  const projectPath = await makeTempDir(`${name}-project`);
  const databasePath = path.join(await makeTempDir(`${name}-state`), "state.sqlite");
  const workflow = compileWorkflowDefinition(
    defineWorkflow({
      name,
      startAt: "verifyP2",
      nodes: { verifyP2: agent({ prompt: () => "Verify and push the P2 changes." }) },
      edges: [],
    }),
  );
  const run = claimedRun(name, projectPath, databasePath, workflow);
  let firstStarted = false;
  const first = new WorkflowEngine({
    store: run.storeFor(run.claimToken),
    executor: new ScriptedExecutor().respond("verifyP2", async (request) => {
      await request.publishUpdate?.(
        { type: "progress", key: "agents/verifyP2", data: progress("running", { phase: "first" }) },
        "first-overall",
      );
      await request.publishUpdate?.(
        { type: "progress", key: "agents/verifyP2/lost", data: progress("running") },
        "first-lost",
      );
      firstStarted = true;
      return await new Promise<never>(() => undefined);
    }),
  });
  const parking = first.run(workflow, {}, { runId: run.runId });
  await waitUntil(() => firstStarted);
  const retiredAttemptId = run.storeFor(run.claimToken).readRunState(run.runId)?.currentAttemptId;
  first.park();
  expect((await parking).state.status).toBe("running");
  expect(run.queue.parkWorkflowRun({ runId: run.runId, claimToken: run.claimToken })).toBe(true);

  // A later runner claims the parked run and resumes it under a new attempt.
  const resumeToken = `${run.claimToken}-resume`;
  expect(
    run.queue.claimWorkflowRun({
      runId: run.runId,
      runnerId: `${name}-resume`,
      claimToken: resumeToken,
      leaseMs: 60_000,
    }),
  ).toBeDefined();
  const runs = run.storeFor(resumeToken);
  let replacementStarted = false;
  const second = new WorkflowEngine({
    store: runs,
    executor: new ScriptedExecutor().respond("verifyP2", async (request) => {
      await request.publishUpdate?.(
        {
          type: "progress",
          key: "agents/verifyP2",
          data: progress("running", { phase: "replacement" }),
        },
        "replacement-overall",
      );
      await request.publishUpdate?.(
        { type: "progress", key: "agents/verifyP2/replacement", data: progress("pending") },
        "replacement-own",
      );
      replacementStarted = true;
      return await new Promise<never>(() => undefined);
    }),
  });
  const resuming = second.resumeRun(workflow, run.runId);
  await waitUntil(() => replacementStarted);
  const resumed = runs.readRunState(run.runId);
  const replacementAttemptId = resumed?.currentAttemptId;
  expect(replacementAttemptId).toBeDefined();
  expect(replacementAttemptId).not.toBe(retiredAttemptId);
  return {
    ...run,
    runs,
    second,
    resuming,
    resumeToken,
    retiredAttemptId,
    replacementAttemptId,
    retiredUnrecorded: resumed?.unrecordedAttempts,
    retiredRow: attemptRow(run.state, retiredAttemptId),
  };
}

describe("progress settlement and retired attempts", () => {
  it("lists a retired and a cancelled verifyP2 attempt and settles only the active one's tracks", async () => {
    const run = await resumedVerifyP2("verify-p2-cancel");
    expect(run.retiredUnrecorded).toEqual([
      expect.objectContaining({ attemptId: run.retiredAttemptId, nodeId: "verifyP2" }),
    ]);
    expect(run.retiredRow).toMatchObject({ status: "cancelled" });

    expect(run.queue.cancelWorkflowRun({ runId: run.runId, claimToken: run.resumeToken })).toBe(
      true,
    );
    run.second.cancel();
    await expect(run.resuming).rejects.toThrow(/claim lost/);

    const state = run.runs.readRunState(run.runId);
    expect(state?.status).toBe("cancelled");
    // Both attempts ended without a step record and appear in start order. The retired
    // attempt keeps the window and row that the resume gave it.
    const unrecorded = state?.unrecordedAttempts ?? [];
    expect(unrecorded.map((attempt) => [attempt.attemptId, attempt.nodeId])).toEqual([
      [run.retiredAttemptId, "verifyP2"],
      [run.replacementAttemptId, "verifyP2"],
    ]);
    expect(unrecorded[0]).toEqual(run.retiredUnrecorded?.[0]);
    expect(Date.parse(unrecorded[0]?.finishedAt ?? "")).toBeLessThanOrEqual(
      Date.parse(unrecorded[1]?.startedAt ?? ""),
    );
    expect(attemptRow(run.state, run.retiredAttemptId)).toEqual(run.retiredRow);
    expect(attemptRow(run.state, run.replacementAttemptId)).toMatchObject({ status: "cancelled" });
    // The cancellation settled the active attempt's tracks. The track that only the retired
    // attempt published was never settled.
    const updates = byKey(state?.updates);
    expect(updates.get("progress:agents/verifyP2/lost")).toMatchObject({
      attemptId: run.retiredAttemptId,
      data: progress("running"),
    });
    expect(updates.get("progress:agents/verifyP2")).toMatchObject({
      attemptId: run.replacementAttemptId,
      data: progress("cancelled", { phase: "cancelled" }),
    });
    expect(updates.get("progress:agents/verifyP2/replacement")).toMatchObject({
      attemptId: run.replacementAttemptId,
      data: progress("cancelled", { phase: "cancelled" }),
    });
    expect(workflowStateViolations(run.state)).toEqual([]);
    run.state.close();
  }, 60_000);

  it("rejects an update for a retired attempt and leaves its row unchanged", async () => {
    const run = await resumedVerifyP2("verify-p2-guard");
    const before = run.runs.runRevision(run.runId);
    const update = {
      type: "progress",
      key: "agents/verifyP2/lost",
      data: progress("completed"),
    };

    // A late write from the retired attempt is rejected while the replacement is active.
    await expect(
      run.runs.publishUpdate(run.runId, "verifyP2", run.retiredAttemptId ?? "", update),
    ).rejects.toThrow(/does not match the active attempt/);
    expect(attemptRow(run.state, run.retiredAttemptId)).toEqual(run.retiredRow);
    expect(run.runs.runRevision(run.runId)).toBe(before);

    // It is still rejected once the run is terminal.
    expect(run.queue.cancelWorkflowRun({ runId: run.runId, claimToken: run.resumeToken })).toBe(
      true,
    );
    run.second.cancel();
    await expect(run.resuming).rejects.toThrow(/claim lost/);
    const cancelled = run.runs.runRevision(run.runId);
    await expect(
      run.runs.publishUpdate(run.runId, "verifyP2", run.retiredAttemptId ?? "", update),
    ).rejects.toThrow(/does not match the active attempt/);
    expect(attemptRow(run.state, run.retiredAttemptId)).toEqual(run.retiredRow);
    expect(run.runs.runRevision(run.runId)).toBe(cancelled);
    expect(
      byKey(run.runs.readRunState(run.runId)?.updates).get("progress:agents/verifyP2/lost"),
    ).toMatchObject({ attemptId: run.retiredAttemptId, data: progress("running") });
    run.state.close();
  }, 60_000);
});
