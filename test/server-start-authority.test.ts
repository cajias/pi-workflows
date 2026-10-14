import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowClient } from "../src/client/client.js";
import { WorkflowServer } from "../src/server/server.js";
import { ServerStateStore } from "../src/server/state.js";
import type { JsonObject } from "../src/state/json.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { type SessionAuthority, makeTempDir, ownSessionCoordinator, waitUntil } from "./helpers.js";

const SESSION = "start-authority-session";

async function writeComputeWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "compute.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { compute, defineWorkflow } from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
export default defineWorkflow({
  name: "start-authority",
  startAt: "work",
  nodes: { work: compute({ run: ({ input }) => input }) },
  edges: [],
});\n`,
  );
  return workflowPath;
}

async function setup(prefix: string) {
  const cwd = await makeTempDir(`${prefix}-project`);
  const databasePath = path.join(await makeTempDir(`${prefix}-state`), "state.sqlite");
  const workflowPath = await writeComputeWorkflow(cwd);
  const server = new WorkflowServer({ databasePath, claimPollMs: 10 });
  await server.start();
  const client = new WorkflowClient({ databasePath, clientId: "start-authority" });
  const resolved = await client.resolveWorkflow({ cwd, workflowRef: workflowPath });
  const queue = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
  const start = async (
    sender: WorkflowClient,
    runId: string,
    payload: JsonObject = {},
    idempotencyKey: string = runId,
  ) =>
    await sender.request({
      operation: "run.start",
      runId,
      idempotencyKey,
      payload: {
        projectPath: cwd,
        workflowName: resolved.workflowName,
        workflowSourceRef: resolved.workflowSourceRef,
        workflowSource: resolved.workflowSource,
        definitionDigest: resolved.definitionDigest,
        definitionSnapshot: resolved.definitionSnapshot,
        input: { runId },
        launchOptions: {},
        originSessionId: SESSION,
        executionMode: "interactive",
        ...payload,
      },
    });
  const close = async () => {
    queue.close();
    await client.close();
    await server.stop();
  };
  return { databasePath, client, queue, start, close };
}

function storedRows(databasePath: string): { runs: number; messages: number; commands: number } {
  const state = new ServerStateStore(databasePath, { readOnly: true });
  try {
    const count = (sql: string) => (state.state.connection.prepare(sql).get() as { n: number }).n;
    return {
      runs: count("SELECT count(*) AS n FROM runs"),
      messages: count("SELECT count(*) AS n FROM workflow_messages"),
      commands: count("SELECT count(*) AS n FROM server_commands WHERE operation = 'run.start'"),
    };
  } finally {
    state.close();
  }
}

describe("interactive run start authority", () => {
  it("refuses a made-up origin session and creates no run", async () => {
    const test = await setup("start-made-up");
    try {
      await expect(test.start(test.client, "no-authority")).resolves.toMatchObject({
        outcome: "rejected",
        error:
          'An interactive run.start requires the live Pi session coordinator of its origin session. Use executionMode "headless" for a run without a Pi session',
      });
      // A session that never connected has no coordinator, whatever epoch is named.
      await expect(
        test.start(test.client, "invented-epoch", {
          targetSessionId: SESSION,
          coordinatorEpoch: "session-epoch-invented",
        }),
      ).resolves.toMatchObject({
        outcome: "rejected",
        error: "Workflow session coordinator was replaced",
      });
      expect(test.queue.listWorkflowRuns()).toEqual([]);
      expect(storedRows(test.databasePath)).toEqual({ runs: 0, messages: 0, commands: 0 });
    } finally {
      await test.close();
    }
  });

  it("accepts the live origin session and leaves headless starts unchanged", async () => {
    const test = await setup("start-live");
    try {
      const authority = await ownSessionCoordinator(test.client, SESSION);
      await expect(test.start(test.client, "live", authority)).resolves.toMatchObject({
        outcome: "accepted",
        receipt: { runId: "live" },
      });
      // A headless start needs no Pi session, so it carries no session authority.
      await expect(
        test.start(test.client, "headless", { executionMode: "headless" }),
      ).resolves.toMatchObject({ outcome: "accepted", receipt: { runId: "headless" } });
      await waitUntil(
        () =>
          test.queue.getWorkflowRun("live")?.status === "done" &&
          test.queue.getWorkflowRun("headless")?.status === "done",
        30_000,
      );
      expect(test.queue.getWorkflowRun("live")).toMatchObject({
        originSessionId: SESSION,
        executionMode: "interactive",
      });
      expect(test.queue.getWorkflowRun("headless")).toMatchObject({
        originSessionId: null,
        executionMode: "headless",
      });
      // Only the interactive run hands a terminal result to its live session.
      const state = new ServerStateStore(test.databasePath, { readOnly: true });
      try {
        expect(
          state.workflowMessages
            .listSession(SESSION)
            .filter((message) => message.kind === "terminal")
            .map((message) => message.runId),
        ).toEqual(["live"]);
      } finally {
        state.close();
      }
    } finally {
      await test.close();
    }
  }, 60_000);

  it("refuses another session's authority and an unreported branch", async () => {
    const test = await setup("start-mismatch");
    const foreign = new WorkflowClient({
      databasePath: test.databasePath,
      clientId: "start-authority",
    });
    try {
      const other = await ownSessionCoordinator(test.client, "other-session");
      await expect(test.start(test.client, "mismatched", other)).resolves.toMatchObject({
        outcome: "rejected",
        error: "An interactive run.start must name its own Pi session as originSessionId",
      });
      const authority = await ownSessionCoordinator(test.client, SESSION);
      // Authority belongs to its own connection, so a copied epoch cannot start a run.
      await expect(test.start(foreign, "copied", authority)).resolves.toMatchObject({
        outcome: "rejected",
        error: "Workflow session coordinator was replaced",
      });
      const watched = await foreign.request({
        operation: "view.session.watch",
        payload: { subscriptionId: "unreported", sessionId: SESSION, coordinator: true },
      });
      const unreported: SessionAuthority = {
        targetSessionId: SESSION,
        coordinatorEpoch: (watched.receipt as { coordinatorEpoch: string }).coordinatorEpoch,
      };
      await expect(test.start(foreign, "unreported", unreported)).resolves.toMatchObject({
        outcome: "rejected",
        error: "Workflow session branch must be reported before session control",
      });
      expect(test.queue.listWorkflowRuns()).toEqual([]);
      expect(storedRows(test.databasePath)).toEqual({ runs: 0, messages: 0, commands: 0 });
    } finally {
      await foreign.close();
      await test.close();
    }
  });

  it("adopts a retried start from the reconnected session and refuses it without one", async () => {
    const test = await setup("start-retry");
    try {
      const first = await ownSessionCoordinator(test.client, SESSION);
      await expect(test.start(test.client, "retried", first, "retry-key")).resolves.toMatchObject({
        outcome: "accepted",
      });
      await test.client.close();
      const reconnected = new WorkflowClient({
        databasePath: test.databasePath,
        clientId: "start-authority",
      });
      try {
        // A receipt is no authority: the retry is refused until the session reconnects.
        await expect(test.start(reconnected, "retried", first, "retry-key")).resolves.toMatchObject(
          {
            outcome: "rejected",
            error: "Workflow session coordinator was replaced",
          },
        );
        const second = await ownSessionCoordinator(reconnected, SESSION);
        // The new epoch is authority evidence, not part of the durable request.
        await expect(
          test.start(reconnected, "retried", second, "retry-key"),
        ).resolves.toMatchObject({ outcome: "adopted", receipt: { runId: "retried" } });
        expect(test.queue.listWorkflowRuns().map((run) => run.runId)).toEqual(["retried"]);
      } finally {
        await reconnected.close();
      }
    } finally {
      await test.close();
    }
  });
});
