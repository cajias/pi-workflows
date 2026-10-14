import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import echoWorkflow from "../examples/workflows/echo.workflow.js";
import { WorkflowClient } from "../src/client/client.js";
import { WorkflowServer } from "../src/server/server.js";
import { StateDatabase } from "../src/state/database.js";
import { canonicalJson } from "../src/state/json.js";
import { WorkflowMessageStore } from "../src/state/workflow-messages.js";
import { verifyInactiveBackup } from "../src/viewer/backup.js";
import { main } from "../src/viewer/cli.js";
import { UNDELIVERED_TERMINAL_MESSAGE_MIN_AGE_MS } from "../src/workflows/diagnostics.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { createDefinitionSnapshot } from "../src/workflows/store.js";
import { terminalWorkflowMessageContent } from "../src/workflows/workflow-message-content.js";
import { makeTempDir } from "./helpers.js";

const HOUR_MS = 60 * 60 * 1_000;

/**
 * Seed two failed interactive runs with pending terminal messages: one for a session
 * that never reported, one for a session that received an earlier message.
 */
function seed(databasePath: string, projectPath: string, createdAt: number): void {
  const queue = new WorkflowRunQueueStore(databasePath, { projectPath });
  const messages = new WorkflowMessageStore(queue.state);
  const snapshot = createDefinitionSnapshot(echoWorkflow);
  const terminal = (runId: string, sessionId: string) => {
    queue.reserveWorkflowRun({
      runId,
      workflowName: "echo",
      workflowSourceRef: "builtin:echo",
      workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      definitionDigest: createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
      definitionSnapshot: snapshot,
      input: {},
      launchOptions: {},
      originSessionId: sessionId,
    });
    queue.failWorkflowRun({ runId, errorCode: "fixture", errorMessage: "fixture" });
    const workflowMessageId = `terminal-${runId}`;
    messages.create({
      workflowMessageId,
      runId,
      targetSessionId: sessionId,
      kind: "terminal",
      sourceId: `terminal:${runId}`,
      idempotencyKey: workflowMessageId,
      now: createdAt,
      content: terminalWorkflowMessageContent({
        workflowMessageId,
        runId,
        content: "Workflow fixture: failed.",
        details: { status: "failed" },
      }),
    });
  };
  try {
    terminal("returning-earlier", "returning-session");
    messages.adoptBranch(
      "returning-session",
      [{ workflowMessageId: "terminal-returning-earlier", piSessionEntryId: "entry-earlier" }],
      new Set(["terminal-returning-earlier"]),
    );
    terminal("returning-later", "returning-session");
    terminal("orphan", "made-up-session");
  } finally {
    queue.close();
  }
}

function messageStatuses(databasePath: string): unknown[] {
  const state = new StateDatabase({ filePath: databasePath, mode: "read-only" });
  try {
    return state.connection
      .prepare(
        "SELECT workflow_message_id AS id, status, updated_at AS updatedAt FROM workflow_messages ORDER BY id",
      )
      .all();
  } finally {
    state.close();
  }
}

describe("undelivered terminal message notices", () => {
  it("reports them in state status and state verify without failing or changing them", async () => {
    const directory = await makeTempDir("state-notices");
    const databasePath = path.join(directory, "state.sqlite");
    const createdAt = Date.now() - 2 * HOUR_MS;
    seed(databasePath, directory, createdAt);
    const before = messageStatuses(databasePath);
    const server = new WorkflowServer({ databasePath, claimPollMs: 10 });
    await server.start();
    const client = new WorkflowClient({ databasePath, clientId: "state-notices" });
    try {
      const expected = {
        schema: "pi-workflows.state-notices.v1",
        undeliveredTerminalMessages: {
          minimumAgeMs: UNDELIVERED_TERMINAL_MESSAGE_MIN_AGE_MS,
          messages: [
            {
              workflowMessageId: "terminal-orphan",
              runId: "orphan",
              targetSessionId: "made-up-session",
              createdAt: new Date(createdAt).toISOString(),
              ageMs: expect.any(Number),
            },
          ],
        },
      };
      const status = await client.request({ operation: "state.status" });
      expect(status).toMatchObject({ outcome: "accepted", receipt: { notices: expected } });
      const age = (status.receipt as { notices: typeof expected }).notices
        .undeliveredTerminalMessages.messages[0]?.ageMs;
      expect(age).toBeGreaterThanOrEqual(2 * HOUR_MS);
      // A notice is not a violation, so verification still accepts the state.
      await expect(client.request({ operation: "state.verify" })).resolves.toMatchObject({
        outcome: "accepted",
        receipt: { valid: true, violations: [], notices: expected },
      });
    } finally {
      await client.close();
      await server.stop();
    }
    expect(messageStatuses(databasePath)).toEqual(before);
  }, 60_000);

  it("prints them after a valid inactive backup and leaves the backup unchanged", async () => {
    const directory = await makeTempDir("state-notices-backup");
    const databasePath = path.join(directory, "state.sqlite");
    const backupPath = path.join(directory, "backup.sqlite");
    seed(databasePath, directory, Date.now() - 2 * HOUR_MS);
    const state = new StateDatabase({ filePath: databasePath });
    await state.backup(backupPath);
    state.close();
    const before = messageStatuses(backupPath);
    const notices = verifyInactiveBackup(backupPath, databasePath);
    expect(notices.undeliveredTerminalMessages.messages.map((message) => message.runId)).toEqual([
      "orphan",
    ]);
    expect(messageStatuses(backupPath)).toEqual(before);
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await expect(main(["state", "verify", backupPath])).resolves.toBe(0);
    } finally {
      write.mockRestore();
    }
    expect(written.join("").split("\n")).toEqual([
      `Inactive SQLite backup is valid: ${backupPath}`,
      expect.stringMatching(
        /^notice undeliveredTerminalMessage terminal-orphan: run orphan, target session made-up-session never reported; pending since \S+Z \(2\.\d h\)$/u,
      ),
      "",
    ]);
    expect(messageStatuses(backupPath)).toEqual(before);
  });
});
