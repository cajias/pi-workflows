import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowClient } from "../src/client/client.js";
import type { ClientEvent } from "../src/client/protocol.js";
import { WorkflowServer } from "../src/server/server.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { WorkflowTraceEvent, WorkflowUpdateRecord } from "../src/workflows/types.js";
import { makeTempDir, requestInteractiveStart, waitUntil } from "./helpers.js";

const SESSION_ID = "cancel-progress-session";
const OPEN_TRACKS = ["agents/review", "agents/review/a", "agents/review/b"];

/**
 * An action that publishes open and finished tracks, then never settles: the
 * runner stops it, or its timeout ends the attempt.
 */
async function writeTrackWorkflow(cwd: string, timeoutMs?: number): Promise<string> {
  const workflowPath = path.join(cwd, "tracks.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { action, defineWorkflow, idempotentEffect } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
const progress = (status, extra = {}) => ({ schema: "pi-workflows.progress.v1", status, ...extra });
export default defineWorkflow({
  name: "server-cancel-progress",
  startAt: "review",
  nodes: {
    review: action({
      effect: idempotentEffect("test.server-cancel-progress"),${
        timeoutMs === undefined ? "" : `\n      timeoutMs: ${timeoutMs},`
      }
      run: async ({ publishUpdate }) => {
        await publishUpdate({ type: "progress", key: "agents/review", data: progress("running", { phase: "review" }) });
        await publishUpdate({ type: "progress", key: "agents/review/a", data: progress("running", { phase: "thinking" }) });
        await publishUpdate({ type: "progress", key: "agents/review/b", data: progress("pending", { phase: "pending" }) });
        await publishUpdate({ type: "progress", key: "agents/review/c", data: progress("completed", { phase: "completed" }) });
        return await new Promise(() => undefined);
      },
    }),
  },
  edges: [],
});\n`,
  );
  return workflowPath;
}

function readRun(databasePath: string, runId: string) {
  const store = new WorkflowRunStore(databasePath, { readOnly: true });
  try {
    return {
      revision: store.runRevision(runId),
      loaded: store.readRun(runId, { includeTrace: true }),
    };
  } finally {
    store.close();
  }
}

function queueStatus(databasePath: string, runId: string): string | undefined {
  const queue = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
  try {
    return queue.getWorkflowRun(runId)?.status;
  } finally {
    queue.close();
  }
}

function liveRunners(databasePath: string, runId: string): number {
  const queue = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
  try {
    const row = queue.state.connection
      .prepare(
        `SELECT count(*) AS count FROM run_runners
         WHERE run_id = ? AND status IN ('starting', 'ready', 'running')`,
      )
      .get(runId) as { count: number };
    return row.count;
  } finally {
    queue.close();
  }
}

function statuses(updates: readonly { key: string; type?: string; data: unknown }[] | undefined) {
  return Object.fromEntries(
    (updates ?? [])
      .filter((update) => update.type === undefined || update.type === "progress")
      .map((update) => [update.key, (update.data as { status?: unknown }).status]),
  );
}

async function startTrackRun(
  client: WorkflowClient,
  cwd: string,
  workflowPath: string,
  runId: string,
): Promise<void> {
  const resolved = await client.resolveWorkflow({ cwd, workflowRef: workflowPath });
  const started = await requestInteractiveStart(client, {
    operation: "run.start",
    runId,
    payload: {
      projectPath: cwd,
      workflowName: resolved.workflowName,
      workflowSourceRef: resolved.workflowSourceRef,
      workflowSource: resolved.workflowSource,
      definitionDigest: resolved.definitionDigest,
      definitionSnapshot: resolved.definitionSnapshot,
      input: {},
      launchOptions: {},
      originSessionId: SESSION_ID,
      executionMode: "interactive",
    },
  });
  expect(started.outcome).toBe("accepted");
}

const RESUMED_TRACKS = ["agents/review", "agents/review/a"];
const FIRST_ATTEMPT_MARKER = "first-attempt.marker";

/**
 * An action whose first attempt publishes two open tracks and a finished one,
 * then waits until a pause stops it. A later attempt finds the marker file,
 * publishes one more track, and completes.
 */
async function writeResumableTrackWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "resumable-tracks.workflow.ts");
  const markerPath = path.join(cwd, FIRST_ATTEMPT_MARKER);
  await fs.writeFile(
    workflowPath,
    `import fs from "node:fs";
import { action, defineWorkflow, idempotentEffect } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
const progress = (status, extra = {}) => ({ schema: "pi-workflows.progress.v1", status, ...extra });
const marker = ${JSON.stringify(markerPath)};
export default defineWorkflow({
  name: "server-resume-progress",
  startAt: "review",
  nodes: {
    review: action({
      effect: idempotentEffect("test.server-resume-progress"),
      run: async ({ publishUpdate, state }) => {
        if (fs.existsSync(marker)) {
          // Report the runner engine's own projection that this attempt started from.
          const seen = Object.fromEntries((state.updates ?? []).map((update) => [update.key, [update.data.status, update.data.phase]]));
          await publishUpdate({ type: "progress", key: "agents/resumed", data: progress("completed", { phase: "completed" }) });
          return { resumed: true, seen };
        }
        await publishUpdate({ type: "progress", key: "agents/review", data: progress("running", { phase: "review" }) });
        await publishUpdate({ type: "progress", key: "agents/review/a", data: progress("running", { phase: "thinking" }) });
        await publishUpdate({ type: "progress", key: "agents/review/c", data: progress("completed", { phase: "completed" }) });
        fs.writeFileSync(marker, "first");
        return await new Promise(() => undefined);
      },
    }),
  },
  edges: [],
});\n`,
  );
  return workflowPath;
}

/** Start the resumable run, wait for its open tracks, and pause it until its runner exits. */
async function startAndPauseResumableRun(
  client: WorkflowClient,
  databasePath: string,
  cwd: string,
  workflowPath: string,
  runId: string,
): Promise<{ revision: number; attemptId: string }> {
  await startTrackRun(client, cwd, workflowPath, runId);
  // The first attempt writes its marker after its third update, so pause only once
  // the marker exists. Otherwise a stop in between would let the resumed attempt
  // repeat the first attempt's work instead of completing.
  const markerPath = path.join(cwd, FIRST_ATTEMPT_MARKER);
  await waitUntil(
    () =>
      (readRun(databasePath, runId).loaded?.state.updates?.length ?? 0) === 3 &&
      existsSync(markerPath),
    30_000,
  );
  expect(await client.request({ operation: "run.pause", runId })).toMatchObject({
    outcome: "accepted",
    receipt: { paused: true },
  });
  await waitUntil(() => liveRunners(databasePath, runId) === 0, 30_000);
  const paused = readRun(databasePath, runId);
  const attemptId = paused.loaded?.state.currentAttemptId;
  if (attemptId === undefined) throw new Error("paused attempt missing");
  expect(queueStatus(databasePath, runId)).toBe("parked");
  expect(statuses(paused.loaded?.state.updates)).toEqual({
    "agents/review": "running",
    "agents/review/a": "running",
    "agents/review/c": "completed",
  });
  return { revision: paused.revision, attemptId };
}

describe("workflow server progress settlement", () => {
  it("settles open progress tracks with the cancellation of an active run", async () => {
    const cwd = await makeTempDir("server-cancel-progress-project");
    const databasePath = path.join(
      await makeTempDir("server-cancel-progress-state"),
      "state.sqlite",
    );
    const workflowPath = await writeTrackWorkflow(cwd);
    const server = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath, clientId: "cancel-progress-client" });
    const runId = "server-cancel-progress-run";
    await server.start();
    try {
      await startTrackRun(client, cwd, workflowPath, runId);
      await waitUntil(
        () => (readRun(databasePath, runId).loaded?.state.updates?.length ?? 0) === 4,
        30_000,
      );
      const before = readRun(databasePath, runId);
      const attemptId = before.loaded?.state.currentAttemptId;
      expect(attemptId).toBeDefined();

      const cancelled = await client.request({ operation: "run.cancel", runId });
      expect(cancelled).toMatchObject({ outcome: "accepted", receipt: { status: "cancelled" } });

      const after = readRun(databasePath, runId);
      expect(after.loaded?.state.status).toBe("cancelled");
      expect(after.revision).toBe(before.revision + OPEN_TRACKS.length + 1);
      const expected = {
        "agents/review": "cancelled",
        "agents/review/a": "cancelled",
        "agents/review/b": "cancelled",
        "agents/review/c": "completed",
      };
      const updates = after.loaded?.state.updates ?? [];
      expect(statuses(updates)).toEqual(expected);
      const trace: WorkflowTraceEvent[] = after.loaded?.traceEvents ?? [];
      const tail = trace.slice(-(OPEN_TRACKS.length + 1));
      expect(tail.map((event) => event.type)).toEqual([
        "update_published",
        "update_published",
        "update_published",
        "run.queue_cancelled",
      ]);
      expect(tail.map((event) => event.seq)).toEqual(
        Array.from({ length: OPEN_TRACKS.length + 1 }, (_, index) => before.revision + index + 1),
      );
      for (const event of tail.slice(0, OPEN_TRACKS.length)) {
        expect(event.attemptId).toBe(attemptId);
        const record = updates.find(
          (update: WorkflowUpdateRecord) => update.key === event.payload.key,
        );
        expect(record).toMatchObject({ seq: event.seq, attemptId, data: event.payload.data });
      }

      const view = await client.getRun(runId);
      expect(view?.runRevision).toBe(after.revision);
      expect(statuses(view?.updates as WorkflowUpdateRecord[] | undefined)).toEqual(expected);

      const snapshots: Array<{ runRevision?: number; progressUpdates?: unknown[] }> = [];
      const unsubscribe = await client.watchSession(SESSION_ID, (event: ClientEvent) => {
        if (event.event !== "session_snapshot") return;
        const run = (event.payload as { run?: (typeof snapshots)[number] | null }).run;
        if (run !== undefined && run !== null) snapshots.push(run);
      });
      try {
        await waitUntil(() => snapshots.at(-1)?.runRevision === after.revision, 15_000);
        expect(
          statuses(snapshots.at(-1)?.progressUpdates as { key: string; data: unknown }[]),
        ).toEqual(expected);
      } finally {
        await unsubscribe();
      }

      const verified = await client.request({ operation: "state.verify" });
      expect(verified).toMatchObject({ outcome: "accepted", receipt: { valid: true } });
      // The stopped runner cannot change the settled tracks afterwards.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(readRun(databasePath, runId).revision).toBe(after.revision);
    } finally {
      await client.close();
      await server.stop();
    }
  }, 60_000);
  it("settles open progress tracks in the runner when an action times out", async () => {
    const cwd = await makeTempDir("server-timeout-progress-project");
    const databasePath = path.join(
      await makeTempDir("server-timeout-progress-state"),
      "state.sqlite",
    );
    // The timer starts when the runner dispatches the action. The action needs
    // only a few update round trips before it waits, so a long limit keeps a
    // loaded machine from timing out first.
    const workflowPath = await writeTrackWorkflow(cwd, 8_000);
    const server = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath, clientId: "timeout-progress-client" });
    const runId = "server-timeout-progress-run";
    await server.start();
    try {
      await startTrackRun(client, cwd, workflowPath, runId);
      // Read once the server has also settled the queue row, its last write for the run.
      await waitUntil(() => queueStatus(databasePath, runId) === "failed", 45_000);

      const after = readRun(databasePath, runId);
      const state = after.loaded?.state;
      expect(state?.results.review?.outcome).toBe("timed_out");
      const attemptId = state?.results.review?.attemptId;
      expect(attemptId).toBeDefined();
      const timedOut = { status: "failed", phase: "timed out" };
      const updates = state?.updates ?? [];
      expect(
        Object.fromEntries(
          updates.map((update) => [
            update.key,
            { status: update.data.status, phase: update.data.phase },
          ]),
        ),
      ).toEqual({
        "agents/review": timedOut,
        "agents/review/a": timedOut,
        "agents/review/b": timedOut,
        "agents/review/c": { status: "completed", phase: "completed" },
      });
      expect(updates.every((update) => update.attemptId === attemptId)).toBe(true);

      // Every revision has one event, in order, and the run revision is the last one.
      const trace: WorkflowTraceEvent[] = after.loaded?.traceEvents ?? [];
      expect(trace.map((event) => event.seq)).toEqual(
        Array.from({ length: trace.length }, (_, index) => index + 1),
      );
      expect(after.revision).toBe(trace.at(-1)?.seq);
      const attemptEvents = trace.filter((event) => event.attemptId === attemptId);
      expect(attemptEvents.map((event) => event.type)).toEqual([
        "node_started",
        ...Array<string>(4 + OPEN_TRACKS.length).fill("update_published"),
        "node_failed",
      ]);
      const settlement = attemptEvents.slice(5, 5 + OPEN_TRACKS.length);
      expect(settlement.map((event) => event.payload.key)).toEqual(OPEN_TRACKS);
      for (const event of settlement) {
        const record = updates.find((update) => update.key === event.payload.key);
        expect(record).toMatchObject({ seq: event.seq, attemptId, data: event.payload.data });
      }
      expect(attemptEvents.at(-1)?.payload.outcome).toBe("timed_out");
      const failedAt = trace.indexOf(attemptEvents.at(-1)!);
      expect(trace.slice(failedAt + 1).map((event) => event.type)).toContain("run_timed_out");

      const view = await client.getRun(runId);
      expect(view?.runRevision).toBe(after.revision);
      expect(statuses(view?.updates as WorkflowUpdateRecord[] | undefined)).toEqual({
        "agents/review": "failed",
        "agents/review/a": "failed",
        "agents/review/b": "failed",
        "agents/review/c": "completed",
      });
      const verified = await client.request({ operation: "state.verify" });
      expect(verified).toMatchObject({ outcome: "accepted", receipt: { valid: true } });
    } finally {
      await client.close();
      await server.stop();
    }
  }, 90_000);

  it("adopts the server revision after a resume settles the replaced attempt's tracks", async () => {
    const cwd = await makeTempDir("server-resume-progress-project");
    const databasePath = path.join(
      await makeTempDir("server-resume-progress-state"),
      "state.sqlite",
    );
    const workflowPath = await writeResumableTrackWorkflow(cwd);
    const server = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath, clientId: "resume-progress-client" });
    const runId = "server-resume-progress-run";
    await server.start();
    try {
      const paused = await startAndPauseResumableRun(
        client,
        databasePath,
        cwd,
        workflowPath,
        runId,
      );

      expect(await client.request({ operation: "run.resume", runId })).toMatchObject({
        outcome: "accepted",
      });
      await waitUntil(() => queueStatus(databasePath, runId) === "done", 45_000);

      const after = readRun(databasePath, runId);
      const state = after.loaded?.state;
      expect(state?.status).toBe("completed");
      const resumedAttemptId = state?.results.review?.attemptId;
      expect(resumedAttemptId).toBeDefined();
      expect(resumedAttemptId).not.toBe(paused.attemptId);
      const trace: WorkflowTraceEvent[] = after.loaded?.traceEvents ?? [];
      // Every revision has exactly one event. A rejected write takes no revision, so
      // this alone cannot show that none was rejected: node_started at R + N + 1 and
      // the completed run below prove the runner's next write was accepted.
      expect(trace.map((event) => event.seq)).toEqual(
        Array.from({ length: trace.length }, (_, index) => index + 1),
      );
      expect(after.revision).toBe(trace.at(-1)?.seq);

      // The runner's run_resumed proposal returns revision R + N: run_resumed at R,
      // then one settlement record for each of the replaced attempt's open tracks.
      const resumedAt = trace.findIndex((event) => event.type === "run_resumed");
      expect(resumedAt).toBeGreaterThan(-1);
      const resumed = trace[resumedAt]!;
      const settlement = trace.slice(resumedAt + 1, resumedAt + 1 + RESUMED_TRACKS.length);
      expect(settlement.map((event) => [event.seq, event.type, event.attemptId])).toEqual(
        RESUMED_TRACKS.map((_, index) => [
          resumed.seq + index + 1,
          "update_published",
          paused.attemptId,
        ]),
      );
      expect(settlement.map((event) => event.payload.key)).toEqual(RESUMED_TRACKS);
      // The runner's next write carries the adopted revision R + N and commits at R + N + 1.
      const next = trace[resumedAt + 1 + RESUMED_TRACKS.length];
      expect(next).toMatchObject({
        seq: resumed.seq + RESUMED_TRACKS.length + 1,
        type: "node_started",
        attemptId: resumedAttemptId,
      });
      expect(
        trace
          .slice(resumedAt + 1 + RESUMED_TRACKS.length)
          .filter((event) => event.attemptId === resumedAttemptId)
          .map((event) => event.type),
      ).toEqual(["node_started", "update_published", "node_finished"]);

      const interrupted = { status: "cancelled", phase: "interrupted" };
      const updates = state?.updates ?? [];
      expect(
        Object.fromEntries(
          updates.map((update) => [
            update.key,
            { status: update.data.status, phase: update.data.phase, attemptId: update.attemptId },
          ]),
        ),
      ).toEqual({
        "agents/review": { ...interrupted, attemptId: paused.attemptId },
        "agents/review/a": { ...interrupted, attemptId: paused.attemptId },
        "agents/review/c": {
          status: "completed",
          phase: "completed",
          attemptId: paused.attemptId,
        },
        "agents/resumed": {
          status: "completed",
          phase: "completed",
          attemptId: resumedAttemptId,
        },
      });
      for (const event of settlement) {
        const record = updates.find((update) => update.key === event.payload.key);
        expect(record).toMatchObject({ seq: event.seq, data: event.payload.data });
      }
      // The runner engine's in-memory projection took the settled records too, so the
      // resumed attempt started from the same tracks that durable reads show.
      expect(state?.outputs.review).toEqual({
        resumed: true,
        seen: {
          "agents/review": ["cancelled", "interrupted"],
          "agents/review/a": ["cancelled", "interrupted"],
          "agents/review/c": ["completed", "completed"],
        },
      });
      const view = await client.getRun(runId);
      expect(view?.runRevision).toBe(after.revision);
      const verified = await client.request({ operation: "state.verify" });
      expect(verified).toMatchObject({ outcome: "accepted", receipt: { valid: true } });
    } finally {
      await client.close();
      await server.stop();
    }
  }, 90_000);

  it("settles open tracks as failed when the server fails a run whose source cannot load", async () => {
    const cwd = await makeTempDir("server-load-fail-progress-project");
    const databasePath = path.join(
      await makeTempDir("server-load-fail-progress-state"),
      "state.sqlite",
    );
    const workflowPath = await writeResumableTrackWorkflow(cwd);
    const server = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath, clientId: "load-fail-progress-client" });
    const runId = "server-load-fail-progress-run";
    await server.start();
    try {
      const paused = await startAndPauseResumableRun(
        client,
        databasePath,
        cwd,
        workflowPath,
        runId,
      );
      // The saved source no longer matches, so the resumed runner reports a load failure.
      await fs.appendFile(workflowPath, "\n// changed while paused\n");

      expect(await client.request({ operation: "run.resume", runId })).toMatchObject({
        outcome: "accepted",
      });
      await waitUntil(() => queueStatus(databasePath, runId) === "failed", 45_000);

      const queue = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
      try {
        expect(queue.getWorkflowRun(runId)?.errorCode).toBe("workflowLoadFailed");
        expect(
          queue.state.connection
            .prepare("SELECT status FROM node_attempts WHERE attempt_id = ?")
            .get(paused.attemptId),
        ).toEqual({ status: "failed" });
      } finally {
        queue.close();
      }
      const after = readRun(databasePath, runId);
      expect(after.loaded?.state.status).toBe("failed");
      const failed = { status: "failed", phase: "failed" };
      const updates = after.loaded?.state.updates ?? [];
      expect(
        Object.fromEntries(
          updates.map((update) => [
            update.key,
            { status: update.data.status, phase: update.data.phase },
          ]),
        ),
      ).toEqual({
        "agents/review": failed,
        "agents/review/a": failed,
        "agents/review/c": { status: "completed", phase: "completed" },
      });
      expect(updates.every((update) => update.attemptId === paused.attemptId)).toBe(true);
      // The failure transaction settles each open track, then records run.queue_failed.
      const trace: WorkflowTraceEvent[] = after.loaded?.traceEvents ?? [];
      const tail = trace.slice(-(RESUMED_TRACKS.length + 1));
      expect(tail.map((event) => [event.seq, event.type])).toEqual([
        [after.revision - 2, "update_published"],
        [after.revision - 1, "update_published"],
        [after.revision, "run.queue_failed"],
      ]);
      expect(tail.slice(0, -1).map((event) => event.payload.key)).toEqual(RESUMED_TRACKS);
      expect(tail.slice(0, -1).every((event) => event.attemptId === paused.attemptId)).toBe(true);
      const view = await client.getRun(runId);
      expect(view?.runRevision).toBe(after.revision);
      expect(statuses(view?.updates as WorkflowUpdateRecord[] | undefined)).toEqual({
        "agents/review": "failed",
        "agents/review/a": "failed",
        "agents/review/c": "completed",
      });
      const verified = await client.request({ operation: "state.verify" });
      expect(verified).toMatchObject({ outcome: "accepted", receipt: { valid: true } });
    } finally {
      await client.close();
      await server.stop();
    }
  }, 90_000);
});
