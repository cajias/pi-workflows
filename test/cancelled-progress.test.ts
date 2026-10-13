import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ServerStateStore } from "../src/server/state.js";
import { ServerViewStore } from "../src/server/view.js";
import { StateDatabase } from "../src/state/database.js";
import { canonicalJson } from "../src/state/json.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { action, defineWorkflow, idempotentEffect } from "../src/workflows/definition.js";
import { workflowStateViolations } from "../src/workflows/diagnostics.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import {
  createDefinitionSnapshot,
  settleCancelledRunProgress,
  WorkflowRunStore,
} from "../src/workflows/store.js";
import type { WorkflowUpdateRecord } from "../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor, waitUntil } from "./helpers.js";
import { claimTestRun } from "./queue-helpers.js";

function progress(status: string, extra: Record<string, unknown> = {}) {
  return { schema: "pi-workflows.progress.v1", status, ...extra };
}

function byKey(updates: readonly WorkflowUpdateRecord[] | undefined) {
  return new Map((updates ?? []).map((update) => [`${update.type}:${update.key}`, update]));
}

/**
 * One claimed run whose action publishes open, terminal, and non-progress
 * updates and then ignores its abort signal, like a runner that the workflow
 * server stops after it commits a cancellation.
 */
async function startRun(name: string) {
  const projectPath = await makeTempDir(`${name}-project`);
  const databasePath = path.join(await makeTempDir(`${name}-state`), "state.sqlite");
  const state = new StateDatabase({ filePath: databasePath });
  const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
  const serverState = new ServerStateStore(databasePath, { state });
  const runId = `run-${name}`;
  const claimToken = `claim-${name}`;
  const sessionId = `session-${name}`;
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
  const runs = new WorkflowRunStore(databasePath, {
    state,
    authorityProvider: () => queue.workflowRunAuthority(runId, claimToken),
  });
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

    // The stopped runner has lost its claim, so it cannot overwrite the settlement.
    run.engine.cancel();
    await expect(run.running).rejects.toThrow(/claim lost/);
    expect(run.runs.runRevision(run.runId)).toBe(after);
    expectSettled(run.runs.readRunState(run.runId)?.updates, attemptId);
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
