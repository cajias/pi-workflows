import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowClient } from "../src/client/client.js";
import type { ClientEvent } from "../src/client/protocol.js";
import { WorkflowServer } from "../src/server/server.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { WorkflowTraceEvent, WorkflowUpdateRecord } from "../src/workflows/types.js";
import { makeTempDir, waitUntil } from "./helpers.js";

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
  const started = await client.request({
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
});
