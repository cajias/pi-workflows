import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowClient } from "../src/client/client.js";
import { WorkflowServer } from "../src/server/server.js";
import { ServerStateStore } from "../src/server/state.js";
import type { JsonObject } from "../src/state/json.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import {
  makeTempDir,
  ownSessionCoordinator,
  requestInteractiveStart,
  waitUntil,
} from "./helpers.js";

const SESSION = "session-command-retry";
const CLIENT_ID = "session-command-retry";

async function setup(prefix: string) {
  const cwd = await makeTempDir(`${prefix}-project`);
  const databasePath = path.join(await makeTempDir(`${prefix}-state`), "state.sqlite");
  const gate = path.join(cwd, "finish");
  const workflowPath = path.join(cwd, "retry.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import fs from "node:fs";
import { allowSettingsPath, compute, defineWorkflow, workflowSettings } from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
export default defineWorkflow({
  name: "session-command-retry",
  startAt: "wait",
  settings: workflowSettings({
    initial: { items: [] },
    parse: (value) => value,
    paths: [allowSettingsPath("/items", { read: ["session"], add: ["session", "resource_manager"] })],
  }),
  nodes: {
    wait: compute({ run: async ({ signal }) => {
      while (!fs.existsSync(${JSON.stringify(gate)})) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { done: true };
    } }),
  },
  edges: [],
});\n`,
  );
  const server = new WorkflowServer({ databasePath, claimPollMs: 10 });
  await server.start();
  const client = new WorkflowClient({ databasePath, clientId: CLIENT_ID });
  const runs = new WorkflowRunStore(databasePath, { readOnly: true });
  const resolved = await client.resolveWorkflow({ cwd, workflowRef: workflowPath });
  const started = await requestInteractiveStart(client, {
    operation: "run.start",
    runId: "retried",
    payload: {
      projectPath: cwd,
      ...resolved,
      input: {},
      launchOptions: {},
      originSessionId: SESSION,
      executionMode: "interactive",
    },
  });
  expect(started).toMatchObject({ outcome: "accepted" });
  await waitUntil(() => runs.readRun("retried")?.state.status === "running", 30_000);
  const close = async () => {
    await fs.writeFile(gate, "finish");
    runs.close();
    await client.close();
    await server.stop();
  };
  return { databasePath, client, runs, close };
}

function commandCount(databasePath: string, operation: string): number {
  const state = new ServerStateStore(databasePath, { readOnly: true });
  try {
    return (
      state.state.connection
        .prepare("SELECT count(*) AS n FROM server_commands WHERE operation = ?")
        .get(operation) as { n: number }
    ).n;
  } finally {
    state.close();
  }
}

const COMMANDS = [
  {
    operation: "followUp.queue" as const,
    payload: { prompt: "Queue this follow-up exactly once." },
    applied: (runs: WorkflowRunStore) =>
      runs.readFollowUpQueue("retried")?.followUps.map((item) => item.state) ?? [],
    once: ["queued"],
  },
  {
    operation: "run.changeSettings" as const,
    payload: { patch: [{ op: "add", path: "/items/-", value: "once" }] },
    applied: (runs: WorkflowRunStore) => {
      const scope = runs.findSettingsScope("retried", "", 1);
      return [scope?.changeNumber, scope?.settings];
    },
    once: [1, { items: ["once"] }],
  },
];

describe("session command retry after a lost connection", () => {
  it.each(COMMANDS)(
    "$operation adopts a committed retry from the reconnected session and applies it once",
    async ({ operation, payload, applied, once }) => {
      const test = await setup(`retry-${operation.replace(".", "-")}`);
      try {
        const first = await ownSessionCoordinator(test.client, SESSION);
        const send = async (sender: WorkflowClient, authority: JsonObject, requestId: string) =>
          await sender.request({
            operation,
            requestId,
            runId: "retried",
            idempotencyKey: "retry-key",
            payload: { ...authority, ...payload },
          });
        // The first send commits, and its response is lost with the connection.
        await expect(send(test.client, first, "first")).resolves.toMatchObject({
          outcome: "accepted",
        });
        await test.client.close();
        const reconnected = new WorkflowClient({
          databasePath: test.databasePath,
          clientId: CLIENT_ID,
        });
        try {
          // A receipt is no authority: the stale epoch is refused before receipt lookup.
          await expect(send(reconnected, first, "stale")).resolves.toMatchObject({
            outcome: "rejected",
            error: "Workflow session coordinator was replaced",
          });
          const second = await ownSessionCoordinator(reconnected, SESSION);
          // The new epoch is authority evidence, not part of the durable request.
          await expect(send(reconnected, second, "fresh")).resolves.toMatchObject({
            outcome: "adopted",
          });
          expect(applied(test.runs)).toEqual(once);
          expect(commandCount(test.databasePath, operation)).toBe(1);
        } finally {
          await reconnected.close();
        }
      } finally {
        await test.close();
      }
    },
    60_000,
  );
});
