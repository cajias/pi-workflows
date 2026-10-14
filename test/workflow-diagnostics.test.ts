import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import echoWorkflow from "../examples/workflows/echo.workflow.js";
import type { StateDatabase } from "../src/state/database.js";
import { canonicalJson } from "../src/state/json.js";
import { WorkflowMessageStore } from "../src/state/workflow-messages.js";
import { checkpoint, defineWorkflow } from "../src/workflows/definition.js";
import {
  UNDELIVERED_TERMINAL_MESSAGE_MIN_AGE_MS,
  workflowStateNoticeSummary,
  workflowStateNotices,
  workflowStateViolations,
} from "../src/workflows/diagnostics.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { WorkflowRunStore, createDefinitionSnapshot } from "../src/workflows/store.js";
import { terminalWorkflowMessageContent } from "../src/workflows/workflow-message-content.js";
import { makeStateDatabasePath, ScriptedExecutor } from "./helpers.js";

it("reports exact request contradictions without repairing them", async () => {
  const store = new WorkflowRunStore(await makeStateDatabasePath("workflow-diagnostics"));
  try {
    const engine = new WorkflowEngine({ store, executor: new ScriptedExecutor() });
    const workflow = defineWorkflow({
      name: "diagnostic",
      startAt: "gate",
      nodes: { gate: checkpoint({ summary: "Answer this checkpoint" }) },
      edges: [],
    });
    const waiting = await engine.run(workflow, {});
    expect(workflowStateViolations(store.state)).toEqual([]);
    store.state.connection
      .prepare(
        "INSERT INTO attempt_active_intervals(attempt_id, interval_number, started_at, observed_at) VALUES (?, 1, 100, 100)",
      )
      .run(waiting.state.currentAttemptId);
    expect(workflowStateViolations(store.state)).toEqual([
      { code: "activeClock", runId: waiting.runId, detail: expect.any(String) },
    ]);
    store.state.connection
      .prepare("UPDATE attempt_active_intervals SET ended_at = observed_at")
      .run();
    store.state.connection
      .prepare("UPDATE runs SET status = 'completed', finished_at = 1 WHERE run_id = ?")
      .run(waiting.runId);
    expect(workflowStateViolations(store.state)).toEqual([
      { code: "pendingRequest", runId: waiting.runId, detail: expect.any(String) },
    ]);
    expect(store.readRun(waiting.runId)?.state.status).toBe("completed");
    store.state.connection
      .prepare("UPDATE runs SET status = 'waiting', finished_at = NULL WHERE run_id = ?")
      .run(waiting.runId);
    store.state.connection
      .prepare(
        "UPDATE interactive_requests SET status = 'settled', accepted_submission_id = 'missing', settled_at = 1 WHERE run_id = ?",
      )
      .run(waiting.runId);
    expect(workflowStateViolations(store.state)).toEqual([
      { code: "acceptedRequest", runId: waiting.runId, detail: expect.any(String) },
    ]);
    store.state.connection
      .prepare(
        "UPDATE interactive_requests SET status = 'cancelled', accepted_submission_id = NULL, settled_at = NULL WHERE run_id = ?",
      )
      .run(waiting.runId);
    expect(workflowStateViolations(store.state)).toEqual([
      { code: "waitingRequest", runId: waiting.runId, detail: expect.any(String) },
    ]);
  } finally {
    store.close();
  }
});

describe("undelivered terminal workflow messages", () => {
  const created = Date.UTC(2026, 0, 10, 12, 0, 0);
  const now = created + 30 * 60 * 60 * 1_000;

  async function fixture() {
    const queue = new WorkflowRunQueueStore(await makeStateDatabasePath("terminal-notices"), {
      projectPath: "/tmp/terminal-notices-project",
    });
    const messages = new WorkflowMessageStore(queue.state);
    const snapshot = createDefinitionSnapshot(echoWorkflow);
    /** One failed interactive run with a pending terminal message for `sessionId`. */
    const terminal = (runId: string, sessionId: string, at: number = created) => {
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
      return messages.create({
        workflowMessageId,
        runId,
        targetSessionId: sessionId,
        kind: "terminal",
        sourceId: workflowMessageId,
        idempotencyKey: workflowMessageId,
        now: at,
        content: terminalWorkflowMessageContent({
          workflowMessageId,
          runId,
          content: "Workflow fixture: failed.",
          details: { status: "failed" },
        }),
      });
    };
    const deliver = (runId: string, sessionId: string) =>
      messages.adoptBranch(
        sessionId,
        [{ workflowMessageId: `terminal-${runId}`, piSessionEntryId: `entry-${runId}` }],
        new Set([`terminal-${runId}`]),
      );
    return { queue, messages, terminal, deliver };
  }

  /** Every row of every table, so a report that writes anything fails the comparison. */
  function tableRows(state: StateDatabase): string {
    const tables = state.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    return JSON.stringify(
      tables.map(({ name }) => [
        name,
        state.connection.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
      ]),
      (_key, value: unknown) =>
        value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value,
    );
  }

  it("lists every old pending terminal message of a session that never reported", async () => {
    const f = await fixture();
    try {
      f.terminal("made-up-one", "made-up-session-one");
      f.terminal("made-up-two", "made-up-session-two", created + 1_000);
      const before = tableRows(f.queue.state);
      expect(workflowStateNotices(f.queue.state, now)).toEqual({
        schema: "pi-workflows.state-notices.v1",
        undeliveredTerminalMessages: {
          minimumAgeMs: UNDELIVERED_TERMINAL_MESSAGE_MIN_AGE_MS,
          entries: [
            {
              workflowMessageId: "terminal-made-up-one",
              runId: "made-up-one",
              targetSessionId: "made-up-session-one",
              createdAt: "2026-01-10T12:00:00.000Z",
              ageMs: 30 * 60 * 60 * 1_000,
            },
            {
              workflowMessageId: "terminal-made-up-two",
              runId: "made-up-two",
              targetSessionId: "made-up-session-two",
              createdAt: "2026-01-10T12:00:01.000Z",
              ageMs: 30 * 60 * 60 * 1_000 - 1_000,
            },
          ],
        },
      });
      // The status form counts the same messages and names none of them.
      const summary = workflowStateNoticeSummary(f.queue.state, now);
      expect(summary).toEqual({
        schema: "pi-workflows.state-notices.v1",
        undeliveredTerminalMessages: {
          minimumAgeMs: UNDELIVERED_TERMINAL_MESSAGE_MIN_AGE_MS,
          count: 2,
          oldestAgeMs: 30 * 60 * 60 * 1_000,
        },
      });
      expect(JSON.stringify(summary)).not.toMatch(/made-up|terminal-/u);
      // The report is read-only: no message is cancelled, expired, or deleted.
      expect(tableRows(f.queue.state)).toBe(before);
      expect(f.messages.get("terminal-made-up-one")?.status).toBe("pending");
      // Validity is unchanged: a notice is not an invariant violation.
      expect(workflowStateViolations(f.queue.state)).toEqual([]);
    } finally {
      f.queue.close();
    }
  });

  it("leaves out delivered, cancelled, recent, and reported-session messages", async () => {
    const f = await fixture();
    try {
      f.terminal("delivered", "delivered-session");
      f.deliver("delivered", "delivered-session");
      f.terminal("cancelled", "cancelled-session");
      f.queue.state.connection
        .prepare("UPDATE workflow_messages SET status = 'cancelled' WHERE run_id = 'cancelled'")
        .run();
      f.terminal("recent", "recent-session", now - UNDELIVERED_TERMINAL_MESSAGE_MIN_AGE_MS + 1);
      // A session that received an earlier message did connect, so a pending result
      // of its later run waits for that session to come back.
      f.terminal("earlier", "returning-session");
      f.deliver("earlier", "returning-session");
      f.terminal("later", "returning-session");
      const before = tableRows(f.queue.state);
      expect(workflowStateNotices(f.queue.state, now).undeliveredTerminalMessages.entries).toEqual(
        [],
      );
      expect(workflowStateNoticeSummary(f.queue.state, now).undeliveredTerminalMessages).toEqual({
        minimumAgeMs: UNDELIVERED_TERMINAL_MESSAGE_MIN_AGE_MS,
        count: 0,
        oldestAgeMs: null,
      });
      expect(tableRows(f.queue.state)).toBe(before);
      // The threshold is inclusive once the full minimum age has passed.
      expect(
        workflowStateNotices(f.queue.state, now + 1).undeliveredTerminalMessages.entries.map(
          (message) => message.runId,
        ),
      ).toEqual(["recent"]);
    } finally {
      f.queue.close();
    }
  });

  it("treats a workflow turn as evidence that the session reported", async () => {
    const f = await fixture();
    try {
      f.terminal("turned", "turn-session");
      f.deliver("turned", "turn-session");
      f.messages.startTurn({
        workflowMessageId: "terminal-turned",
        workflowTurnId: "turn-turned",
        runId: "turned",
        targetSessionId: "turn-session",
      });
      // The sent message alone already proves a report. Make the turn the only proof.
      f.queue.state.connection
        .prepare(
          "UPDATE workflow_messages SET status = 'pending', pi_session_entry_id = NULL WHERE run_id = 'turned'",
        )
        .run();
      expect(workflowStateNotices(f.queue.state, now).undeliveredTerminalMessages.entries).toEqual(
        [],
      );
      expect(workflowStateNoticeSummary(f.queue.state, now).undeliveredTerminalMessages.count).toBe(
        0,
      );
    } finally {
      f.queue.close();
    }
  });
});
