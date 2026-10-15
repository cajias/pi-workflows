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
};

/**
 * One run with a failed attempt and its retry, Pi prompt and response entries, a late
 * prompt entry for an earlier attempt, and a parked attempt that resume retires.
 * `fullSync` drops the store's sync cursor before every transition, which makes each
 * save rewrite every recorded step the way the store did before F40.
 */
async function runScenario(fullSync: boolean): Promise<ScenarioResult> {
  uuids.next = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  const store = new WorkflowRunStore(await makeStateDatabasePath("attempt-sync"));
  if (fullSync) {
    const commit = store.commitTransition.bind(store);
    store.commitTransition = async (runId, transition) => {
      store.synchronizeRevision(runId);
      return await commit(runId, transition);
    };
  }
  let bound = false;
  let workCalls = 0;
  const workAttempts: string[] = [];
  const bind = async (request: AgentStepRequest) => {
    if (bound) return;
    bound = true;
    await store.writeSessionBinding(request.contract.runId, {
      schema: SESSION_BINDING_SCHEMA,
      runId: request.contract.runId,
      piSessionId: "attempt-sync-session",
      cwd: "/tmp/attempt-sync",
      boundAt: new Date().toISOString(),
    });
  };
  const promptEntry = async (request: AgentStepRequest, id: string, attemptId: string) => {
    await store.appendSessionEntry(request.contract.runId, {
      id,
      type: "custom_message",
      customType: "pi-workflows-step",
      content: request.prompt,
      details: { contract: { attemptId } },
    });
  };
  const work = async (request: AgentStepRequest): Promise<AgentStepSubmission> => {
    tick();
    await bind(request);
    workCalls += 1;
    workAttempts.push(request.contract.attemptId);
    await promptEntry(request, `work-prompt-${workCalls}`, request.contract.attemptId);
    if (workCalls === 1) throw new Error("the first work attempt fails");
    const text = "work is complete";
    await store.appendSessionEntry(request.contract.runId, {
      id: "work-response",
      type: "message",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
    });
    return {
      output: text,
      assistantMessage: {
        sha256: createHash("sha256").update(text).digest("hex"),
        entryId: "work-response",
      },
      conversation: { firstEntryId: `work-prompt-${workCalls}`, lastEntryId: "work-response" },
    };
  };
  const late = async (request: AgentStepRequest): Promise<AgentStepSubmission> => {
    tick();
    const earlier = workAttempts.at(-1);
    if (earlier === undefined) throw new Error("work attempt is missing");
    // A newer prompt entry for an attempt that already finished moves its prompt link.
    await promptEntry(request, "work-prompt-late", earlier);
    const accepted = await request.accept({ late: true });
    if (!accepted.ok) throw new Error(accepted.error);
    return { output: accepted.value };
  };
  let holdStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    holdStarted = resolve;
  });
  const hold = async (signal: AbortSignal) => {
    tick();
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
    executor: new ScriptedExecutor().respond("hold", () => {
      retiredAtResume = retiredRows(store.state, parked.runId);
      tick();
      return { output: { held: true } };
    }),
  }).resumeRun(scenario, parked.runId);
  expect(resumed.state.status).toBe("completed");
  const rows = dumpRows(store.state, parked.runId);
  const retiredAtEnd = retiredRows(store.state, parked.runId);
  store.close();
  return { runId: parked.runId, rows, retiredAtResume, retiredAtEnd };
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
    const promptLinks = (incremental.rows.attemptEntries as Array<Record<string, unknown>>).filter(
      (entry) => entry.role === "prompt",
    );
    expect(promptLinks.map((entry) => entry.entry_id)).toEqual([
      "work-prompt-1",
      "work-prompt-late",
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
    store.close();
  });
});

function totalChanges(state: StateDatabase): number {
  const row = state.connection.prepare("SELECT total_changes() AS count").get() as {
    count: number;
  };
  return row.count;
}
