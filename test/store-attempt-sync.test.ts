import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StateDatabase } from "../src/state/database.js";
import { agent, assistantMessage, compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { SESSION_BINDING_SCHEMA, WorkflowRunStore } from "../src/workflows/store.js";
import type { AgentStepRequest, AgentStepSubmission } from "../src/workflows/types.js";
import { makeStateDatabasePath, ScriptedExecutor } from "./helpers.js";

const uuids = vi.hoisted(() => ({ next: 0 }));

// Two runs of one scenario are compared row by row, so their identifiers must match.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () => {
      uuids.next += 1;
      return `00000000-0000-4000-8000-${uuids.next.toString(16).padStart(12, "0")}`;
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advance the frozen clock so each scripted step writes a distinct, repeatable time. */
function tick(): void {
  vi.setSystemTime(Date.now() + 1_000);
}

const scenario = defineWorkflow({
  name: "attempt-sync-scenario",
  startAt: "first",
  maxSteps: 20,
  nodes: {
    first: compute({ run: () => ({ first: true }) }),
    work: agent({ prompt: () => "do the work", expectedOutput: assistantMessage() }),
    late: agent({ prompt: () => "record a late entry" }),
    hold: agent({ prompt: () => "hold until resumed" }),
    last: compute({ run: () => ({ done: true }) }),
  },
  edges: [
    { from: "first", to: "work" },
    { from: "work", switch: { on: "$result.outcome", cases: { ok: "late", failed: "work" } } },
    { from: "late", to: "hold" },
    { from: "hold", to: "last" },
  ],
});

type ScenarioResult = {
  runId: string;
  rows: Record<string, unknown[]>;
  /** Rows that name the retired attempt, read when the resumed attempt starts. */
  retiredAtResume: Record<string, unknown[]>;
  retiredAtEnd: Record<string, unknown[]>;
  /** The interval opened for a recorded attempt, read two transitions later. */
  intervalAtHold: unknown[];
  /** Errors from the injected failed transaction. */
  injectedFailures: string[];
};

const binding = (runId: string, piSessionId: string) => ({
  schema: SESSION_BINDING_SCHEMA,
  runId,
  piSessionId,
  cwd: "/tmp/attempt-sync",
  boundAt: new Date().toISOString(),
});

const stepPrompt = (id: string, content: string, attemptId: string) => ({
  id,
  type: "custom_message",
  customType: "pi-workflows-step",
  content,
  details: { contract: { attemptId } },
});

const workText = "work is complete";

/**
 * One run that covers each way a recorded attempt's rows can still change:
 * - a failed `work` attempt and its retry, with Pi prompt entries;
 * - a newer step prompt entry for a recorded attempt, stored before a transition whose
 *   first commit fails after the sync and is then retried;
 * - a response entry a recorded attempt names, stored only after it was recorded;
 * - an entry in another segment that reuses an entry id a recorded attempt links;
 * - an open active interval for a recorded attempt;
 * - a step prompt entry that a second store instance appends;
 * - a parked attempt that resume retires.
 * `fullSync` drops the store's sync cursor before every transition, which makes each
 * save rewrite every recorded step the way the store did before F40.
 */
async function runScenario(fullSync: boolean): Promise<ScenarioResult> {
  uuids.next = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  let failNextSnapshot = false;
  const store = new WorkflowRunStore(await makeStateDatabasePath("attempt-sync"), {
    snapshotLifecycle: () => {
      if (!failNextSnapshot) return;
      failNextSnapshot = false;
      throw new Error("injected failure after the attempt sync");
    },
  });
  try {
    return await runScenarioOn(store, fullSync, () => {
      failNextSnapshot = true;
    });
  } finally {
    store.close();
  }
}

async function runScenarioOn(
  store: WorkflowRunStore,
  fullSync: boolean,
  failNextCommit: () => void,
): Promise<ScenarioResult> {
  const injectedFailures: string[] = [];
  const workAttempts: string[] = [];
  const commit = store.commitTransition.bind(store);
  store.commitTransition = async (runId, transition) => {
    const once = async () => {
      if (fullSync) store.synchronizeRevision(runId);
      return await commit(runId, transition);
    };
    if (
      transition.kind !== "startAttempt" ||
      transition.event.nodeId !== "late" ||
      injectedFailures.length > 0
    ) {
      return await once();
    }
    // A newer prompt entry for a recorded attempt arrives before a transition that adds no
    // step. That transition fails after its sync, so its retry must still relink the attempt.
    tick();
    await store.appendSessionEntry(
      runId,
      stepPrompt("first-prompt-late", "late prompt", attemptOf(store, "first")),
    );
    failNextCommit();
    try {
      await once();
      injectedFailures.push("the injected failure did not fire");
    } catch (error) {
      injectedFailures.push(String(error));
    }
    return await once();
  };
  let bound = false;
  const work = async (request: AgentStepRequest): Promise<AgentStepSubmission> => {
    tick();
    const runId = request.contract.runId;
    if (!bound) {
      bound = true;
      await store.writeSessionBinding(runId, binding(runId, "attempt-sync-session"));
    }
    workAttempts.push(request.contract.attemptId);
    const promptId = `work-prompt-${workAttempts.length}`;
    await store.appendSessionEntry(
      runId,
      stepPrompt(promptId, request.prompt, request.contract.attemptId),
    );
    if (workAttempts.length === 1) throw new Error("the first work attempt fails");
    // The named response entry is stored only after this attempt is recorded.
    return {
      output: workText,
      assistantMessage: {
        sha256: createHash("sha256").update(workText).digest("hex"),
        entryId: "work-response",
      },
      conversation: { firstEntryId: promptId, lastEntryId: "work-response" },
    };
  };
  const late = async (request: AgentStepRequest): Promise<AgentStepSubmission> => {
    tick();
    const runId = request.contract.runId;
    // The response entry the retried work attempt names is stored only now.
    await store.appendSessionEntry(runId, {
      id: "work-response",
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: workText }],
      },
    });
    // An entry in another segment reuses the id the failed attempt links as its prompt.
    await store.writeSessionBinding(
      runId,
      binding(runId, "attempt-sync-late-session"),
      request.contract.attemptId,
    );
    await store.appendSessionEntry(
      runId,
      { id: "work-prompt-1", type: "custom_message", customType: "note", content: "reused id" },
      request.contract.attemptId,
    );
    // A server interval left open for a recorded attempt.
    store.state.connection
      .prepare(
        `INSERT INTO attempt_active_intervals(attempt_id, interval_number, started_at, observed_at)
         VALUES (?, 1, ?, ?)`,
      )
      .run(attemptOf(store, "first"), Date.now() - 500, Date.now());
    const accepted = await request.accept({ late: true });
    if (!accepted.ok) throw new Error(accepted.error);
    return { output: accepted.value };
  };
  let intervalAtHold: unknown[] = [];
  let holdStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    holdStarted = resolve;
  });
  const hold = async (signal: AbortSignal) => {
    tick();
    intervalAtHold = store.state.connection
      .prepare("SELECT * FROM attempt_active_intervals WHERE attempt_id = ?")
      .all(attemptOf(store, "first"));
    holdStarted();
    return await new Promise<AgentStepSubmission>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const firstEngine = new WorkflowEngine({
    store,
    executor: {
      enforcesToolAllowlist: true,
      assistantMessageMode: "visible",
      runAgentStep: async (request, signal) => {
        if (request.contract.nodeId === "work") return await work(request);
        if (request.contract.nodeId === "late") return await late(request);
        return await hold(signal);
      },
    },
  });
  const running = firstEngine.run(scenario, {});
  await started;
  firstEngine.park();
  const parked = await running;
  expect(parked.state.status).toBe("running");
  tick();
  let retiredAtResume: Record<string, unknown[]> = {};
  const resumed = await new WorkflowEngine({
    store,
    executor: new ScriptedExecutor().respond("hold", async (request) => {
      retiredAtResume = retiredRows(store.state, parked.runId);
      tick();
      // A second store on the same database adds a step prompt entry for a recorded attempt.
      const other = new WorkflowRunStore(store.databasePath);
      try {
        await other.appendSessionEntry(
          request.contract.runId,
          stepPrompt("late-prompt-other-store", "late prompt", attemptOf(store, "late")),
        );
      } finally {
        other.close();
      }
      return { output: { held: true } };
    }),
  }).resumeRun(scenario, parked.runId);
  expect(resumed.state.status).toBe("completed");
  return {
    runId: parked.runId,
    rows: dumpRows(store.state, parked.runId),
    retiredAtResume,
    retiredAtEnd: retiredRows(store.state, parked.runId),
    intervalAtHold,
    injectedFailures,
  };
}

/** The attempt id of a node that ran once. */
function attemptOf(store: WorkflowRunStore, nodeId: string): string {
  const row = store.state.connection
    .prepare("SELECT attempt_id AS attemptId FROM node_attempts WHERE node_id = ?")
    .get(nodeId) as { attemptId: string } | undefined;
  if (row === undefined) throw new Error(`attempt for ${nodeId} is missing`);
  return row.attemptId;
}

/**
 * Every row that names the run's retired (cancelled, unrecorded) attempts. Derived
 * unrecorded-attempt projections read exactly these rows, so later syncs must leave them.
 */
function retiredRows(state: StateDatabase, runId: string): Record<string, unknown[]> {
  const retired = `SELECT attempt_id FROM node_attempts WHERE run_id = ? AND status = 'cancelled'
    AND attempt_id NOT IN (SELECT attempt_id FROM run_steps WHERE run_id = ?)`;
  const all = (sql: string) => state.connection.prepare(sql).all(runId, runId);
  return {
    nodeAttempts: all(`SELECT * FROM node_attempts WHERE attempt_id IN (${retired})`),
    runSteps: all(`SELECT * FROM run_steps WHERE attempt_id IN (${retired})`),
    attemptEntries: all(`SELECT * FROM attempt_entries WHERE attempt_id IN (${retired})`),
    activeIntervals: all(`SELECT * FROM attempt_active_intervals WHERE attempt_id IN (${retired})`),
  };
}

function dumpRows(state: StateDatabase, runId: string): Record<string, unknown[]> {
  const all = (sql: string, ...params: unknown[]) => state.connection.prepare(sql).all(...params);
  return {
    nodeAttempts: all("SELECT * FROM node_attempts WHERE run_id = ? ORDER BY attempt_id", runId),
    runSteps: all("SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_index", runId),
    attemptEntries: all(
      `SELECT ae.* FROM attempt_entries ae JOIN node_attempts a ON a.attempt_id = ae.attempt_id
       WHERE a.run_id = ? ORDER BY ae.attempt_id, ae.role`,
      runId,
    ),
    sessionEntries: all("SELECT * FROM session_entries WHERE run_id = ? ORDER BY run_seq", runId),
    activeIntervals: all(
      `SELECT i.* FROM attempt_active_intervals i JOIN node_attempts a ON a.attempt_id = i.attempt_id
       WHERE a.run_id = ? ORDER BY i.attempt_id, i.interval_number`,
      runId,
    ),
    blobs: all("SELECT * FROM blobs ORDER BY blob_hash"),
  };
}

type Execution = { reader: boolean; source: string };

/**
 * Count each SQLite statement execution. better-sqlite3 statements share one prototype,
 * so spying on it sees every statement the store prepares, cached or not.
 */
function countExecutions(state: StateDatabase): { executions: Execution[]; restore(): void } {
  const executions: Execution[] = [];
  const prototype = Object.getPrototypeOf(state.connection.prepare("SELECT 1")) as Record<
    "run" | "get" | "all",
    (this: Execution, ...params: unknown[]) => unknown
  >;
  const spies = (["run", "get", "all"] as const).map((method) => {
    const original = prototype[method];
    return vi.spyOn(prototype, method).mockImplementation(function (
      this: Execution,
      ...params: unknown[]
    ) {
      executions.push({ reader: this.reader, source: this.source });
      return original.apply(this, params);
    });
  });
  return {
    executions,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

describe("incremental node attempt sync", () => {
  it("writes the same attempt, step, entry, interval, and blob rows as a full re-sync", async () => {
    const incremental = await runScenario(false);
    const full = await runScenario(true);

    expect(incremental.runId).toBe(full.runId);
    expect(incremental.rows).toEqual(full.rows);

    // The scenario covers what the cursor must keep exact.
    const attempts = incremental.rows.nodeAttempts as Array<Record<string, unknown>>;
    const steps = incremental.rows.runSteps as Array<Record<string, unknown>>;
    const work = attempts.filter((attempt) => attempt.node_id === "work");
    expect(work.map((attempt) => attempt.status)).toEqual(["failed", "completed"]);
    expect(work[0]?.error_hash).not.toBeNull();
    const links = incremental.rows.attemptEntries as Array<Record<string, unknown>>;
    const link = (node: string, index: number, role: string) =>
      links.find(
        (entry) =>
          entry.attempt_id ===
            attempts.filter((attempt) => attempt.node_id === node)[index]?.attempt_id &&
          entry.role === role,
      );
    const reused = (incremental.rows.sessionEntries as Array<Record<string, unknown>>).filter(
      (entry) => entry.entry_id === "work-prompt-1",
    );
    expect(reused).toHaveLength(2);
    const lateSegment = reused.at(-1)?.segment_id;
    expect(lateSegment).not.toBe(reused[0]?.segment_id);
    // Newer step prompt entry for a recorded attempt, relinked by a retried transition.
    expect(link("first", 0, "prompt")?.entry_id).toBe("first-prompt-late");
    expect(link("work", 1, "prompt")?.entry_id).toBe("work-prompt-2");
    expect(incremental.injectedFailures).toEqual([
      "Error: injected failure after the attempt sync",
    ]);
    expect(full.injectedFailures).toEqual(incremental.injectedFailures);
    // Reused linked id in another segment: the prompt link follows the newer entry.
    expect(link("work", 0, "prompt")).toMatchObject({
      entry_id: "work-prompt-1",
      segment_id: lateSegment,
    });
    // Named response stored after the attempt was recorded.
    expect(link("work", 1, "response")?.entry_id).toBe("work-response");
    expect(work[1]?.output_hash).toBeNull();
    // Step prompt entry from a second store instance.
    expect(link("late", 0, "prompt")?.entry_id).toBe("late-prompt-other-store");
    // The open interval is closed by the next transition, as a full re-sync did.
    expect(incremental.intervalAtHold).toEqual(full.intervalAtHold);
    expect(incremental.intervalAtHold).toEqual([
      expect.objectContaining({ ended_at: expect.any(Number) }),
    ]);
    const holds = attempts.filter((attempt) => attempt.node_id === "hold");
    expect(holds.map((attempt) => attempt.status)).toEqual(["cancelled", "completed"]);
    const retired = holds[0];
    expect(retired?.started_at).toEqual(expect.any(Number));
    expect(retired?.finished_at).toEqual(expect.any(Number));
    expect(steps.map((step) => step.attempt_id)).not.toContain(retired?.attempt_id);
    // Later transitions create and update nothing for the retired attempt.
    expect(incremental.retiredAtResume.nodeAttempts).toEqual([retired]);
    expect(incremental.retiredAtResume.runSteps).toEqual([]);
    expect(incremental.retiredAtResume.attemptEntries).toEqual([]);
    expect(incremental.retiredAtResume).toEqual(full.retiredAtResume);
    expect(incremental.retiredAtEnd).toEqual(incremental.retiredAtResume);
    // A full re-sync refreshes updated_at on every recorded attempt; the cursor keeps that.
    const finalUpdate = Math.max(...attempts.map((attempt) => Number(attempt.updated_at)));
    const first = attempts.find((attempt) => attempt.node_id === "first");
    expect(first?.updated_at).toBe(finalUpdate);
  });

  it("does work per transition that stays constant as the run grows", async () => {
    const nodeCount = 40;
    const nodes = Object.fromEntries(
      Array.from(
        { length: nodeCount },
        (_, index) => [`node-${index}`, compute({ run: () => index })] as const,
      ),
    );
    const chain = defineWorkflow({
      name: "attempt-sync-chain",
      startAt: "node-0",
      maxSteps: nodeCount + 2,
      nodes,
      edges: Array.from({ length: nodeCount - 1 }, (_, index) => ({
        from: `node-${index}`,
        to: `node-${index + 1}`,
      })),
    });
    const store = new WorkflowRunStore(await makeStateDatabasePath("attempt-sync-chain"));
    const counter = countExecutions(store.state);
    const finishes: Array<{ steps: number; writes: number; promptScans: number; rows: number }> =
      [];
    const commit = store.commitTransition.bind(store);
    store.commitTransition = async (runId, transition) => {
      const before = counter.executions.length;
      const changesBefore = totalChanges(store.state);
      const event = await commit(runId, transition);
      if (transition.kind === "finishAttempt") {
        const executed = counter.executions.slice(before);
        finishes.push({
          steps: finishes.length + 1,
          writes: executed.filter((execution) => !execution.reader).length,
          promptScans: executed.filter((execution) =>
            execution.source.includes("'pi-workflows-step'"),
          ).length,
          rows: totalChanges(store.state) - changesBefore,
        });
      }
      return event;
    };
    try {
      const result = await new WorkflowEngine({ store, executor: new ScriptedExecutor() }).run(
        chain,
        {},
      );
      expect(result.state.status).toBe("completed");
    } finally {
      counter.restore();
      store.close();
    }

    expect(finishes).toHaveLength(nodeCount);
    const early = finishes[4];
    const late = finishes.at(-1);
    if (early === undefined || late === undefined) throw new Error("finish counts missing");
    // A full re-sync ran one prompt scan and several writes for every recorded step.
    expect(late.writes).toBe(early.writes);
    expect(late.promptScans).toBe(early.promptScans);
    expect(late.promptScans).toBe(1);
    // One bulk statement refreshes updated_at on each recorded step; nothing else grows.
    expect(late.rows - early.rows).toBe(late.steps - early.steps);
  });
});

function totalChanges(state: StateDatabase): number {
  const row = state.connection.prepare("SELECT total_changes() AS count").get() as {
    count: number;
  };
  return row.count;
}
