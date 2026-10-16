import { describe, expect, it } from "vitest";
import {
  action,
  agent,
  compute,
  defineWorkflow,
  idempotentEffect,
} from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { ClaimLostError } from "../src/workflows/errors.js";
import { abortedAttemptProgress } from "../src/workflows/progress.js";
import { WorkflowRunStore, readWorkflowRun } from "../src/workflows/store.js";
import type {
  AgentStepExecutor,
  WorkflowActionContext,
  WorkflowRunState,
  WorkflowTraceEvent,
  WorkflowUpdateInput,
  WorkflowUpdateRecord,
} from "../src/workflows/types.js";
import { holdTimers, makeStateDatabasePath, ScriptedExecutor, waitUntil } from "./helpers.js";

type Publish = WorkflowActionContext["publishUpdate"];

/** A node limit that only a held test timer reaches; no other timer in these tests uses it. */
const HELD_TIMEOUT_MS = 3_600_017;

function progress(status: string, extra: Record<string, unknown> = {}) {
  return { schema: "pi-workflows.progress.v1", status, ...extra };
}

function track(key: string, status: string, extra: Record<string, unknown> = {}) {
  return { type: "progress", key, data: progress(status, extra) };
}

/** Never settles, so the engine must stop waiting for the node by itself. */
function hang(): Promise<never> {
  return new Promise<never>(() => undefined);
}

function byKey(updates: WorkflowUpdateRecord[] | undefined): Map<string, WorkflowUpdateRecord> {
  return new Map((updates ?? []).map((update) => [update.key, update]));
}

function durableUpdates(databasePath: string, runId: string) {
  const loaded = readWorkflowRun(runId, { databasePath, includeTrace: true });
  return {
    updates: byKey(loaded?.state.updates),
    trace: loaded?.traceEvents ?? [],
  };
}

/** The stored `node_attempts` facts that a retired attempt's `unrecordedAttempts` entry derives from. */
type AttemptRow = {
  status: string;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
};

function attemptRow(databasePath: string, attemptId: string | undefined) {
  const store = new WorkflowRunStore(databasePath, { readOnly: true });
  try {
    return store.state.connection
      .prepare(
        `SELECT status, started_at AS startedAt, finished_at AS finishedAt, updated_at AS updatedAt
         FROM node_attempts WHERE attempt_id = ?`,
      )
      .get(attemptId) as AttemptRow | undefined;
  } finally {
    store.close();
  }
}

/** Park a run in the middle of its first `work` attempt and resume it in a second engine. */
async function parkThenResume(
  workflow: ReturnType<typeof defineWorkflow>,
  started: () => boolean,
  databasePath: string,
  whileResuming: () => Promise<void> = async () => undefined,
) {
  const first = new WorkflowEngine({ databasePath, executor: new ScriptedExecutor() });
  const running = first.run(workflow, {});
  await waitUntil(started);
  first.park();
  const parked = await running;
  // The workflow server returns an interrupted idempotent effect to pending before resume.
  const recovery = new WorkflowRunStore(databasePath);
  expect(await recovery.recoverApplyingEffects(parked.runId)).toBe("safe");
  const retiredAttemptId = recovery.readRunState(parked.runId)?.currentAttemptId;
  recovery.close();
  const second = new WorkflowEngine({ databasePath, executor: new ScriptedExecutor() });
  const resuming = second.resumeRun(workflow, parked.runId);
  await whileResuming();
  return { parked, retiredAttemptId, resumed: await resuming };
}

async function makeEngine(options: { executor?: ScriptedExecutor; store?: WorkflowRunStore } = {}) {
  const databasePath = options.store?.databasePath ?? (await makeStateDatabasePath("aborted"));
  const events: WorkflowTraceEvent[] = [];
  const engine = new WorkflowEngine({
    executor: options.executor ?? new ScriptedExecutor(),
    ...(options.store === undefined ? { databasePath } : { store: options.store }),
    onEvent: (event) => events.push(event),
  });
  return { engine, databasePath, events };
}

/** One action that publishes the given tracks and then ignores its abort signal. */
function hungAction(
  name: string,
  tracks: WorkflowUpdateInput[],
  options: { timeoutMs?: number; capture?: (publish: Publish, signal: AbortSignal) => void } = {},
) {
  return defineWorkflow({
    name,
    startAt: "work",
    nodes: {
      work: action({
        effect: idempotentEffect(`test.${name}`),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        run: async ({ publishUpdate, signal }) => {
          for (const update of tracks) await publishUpdate(update);
          options.capture?.(publishUpdate, signal);
          return await hang();
        },
      }),
    },
    edges: [],
  });
}

describe("abortedAttemptProgress", () => {
  const record = (
    key: string,
    attemptId: string,
    data: Record<string, unknown>,
    type = "progress",
  ): WorkflowUpdateRecord => ({
    updateId: `upd_${key}`,
    seq: 1,
    at: "2026-10-10T00:00:00.000Z",
    runId: "run",
    nodeId: "work",
    attemptId,
    type,
    key,
    data,
  });

  it("settles only the attempt's open progress tracks and keeps their facts", () => {
    const updates = [
      record(
        "open",
        "a1",
        progress("running", {
          label: "Runner",
          phase: "thinking",
          completed: 2,
          total: 5,
          unit: "rows",
          sourceUpdatedAt: "2026-10-10T00:00:00.000Z",
          sourceEstimatedFinishAt: "2026-10-10T01:00:00.000Z",
        }),
      ),
      record("waiting", "a1", progress("waiting")),
      record("done", "a1", progress("completed")),
      record("failed", "a1", progress("failed")),
      record("cancelled", "a1", progress("cancelled")),
      record("other-attempt", "a2", progress("running")),
      record("batch", "a1", { outcome: "running" }, "command-batch.item"),
      record("malformed", "a1", { schema: "pi-workflows.progress.v1", status: "bogus" }),
    ];

    expect(abortedAttemptProgress(updates, "a1", "timed_out")).toEqual([
      {
        type: "progress",
        key: "open",
        data: {
          schema: "pi-workflows.progress.v1",
          status: "failed",
          label: "Runner",
          phase: "timed out",
          completed: 2,
          total: 5,
          unit: "rows",
          sourceUpdatedAt: "2026-10-10T00:00:00.000Z",
        },
      },
      {
        type: "progress",
        key: "waiting",
        data: { schema: "pi-workflows.progress.v1", status: "failed", phase: "timed out" },
      },
    ]);
    expect(abortedAttemptProgress(updates, "a2", "cancelled")).toEqual([
      {
        type: "progress",
        key: "other-attempt",
        data: { schema: "pi-workflows.progress.v1", status: "cancelled", phase: "cancelled" },
      },
    ]);
    expect(abortedAttemptProgress(undefined, "a1", "cancelled")).toEqual([]);
  });
});

/**
 * Run an action whose first attempt publishes `first` and hangs, park it, and
 * return the parked run and that attempt's id. Later attempts publish nothing
 * and hang, so the resumed run stays active until the test cancels it.
 */
async function parkedAction(name: string, first: WorkflowUpdateInput[]) {
  const databasePath = await makeStateDatabasePath(name);
  let published = 0;
  let attempts = 0;
  const workflow = defineWorkflow({
    name,
    startAt: "work",
    nodes: {
      work: action({
        effect: idempotentEffect(`test.${name}`),
        run: async ({ publishUpdate }) => {
          attempts += 1;
          if (attempts === 1) for (const update of first) await publishUpdate(update);
          published = attempts;
          return await hang();
        },
      }),
    },
    edges: [],
  });
  const engine = new WorkflowEngine({ databasePath, executor: new ScriptedExecutor() });
  const running = engine.run(workflow, {});
  await waitUntil(() => published === 1);
  engine.park();
  const parked = await running;
  const store = new WorkflowRunStore(databasePath);
  const parkedAttempt = store.readRunState(parked.runId)?.currentAttemptId;
  if (parkedAttempt === undefined) throw new Error("parked attempt missing");
  expect(await store.recoverApplyingEffects(parked.runId)).toBe("safe");
  return {
    databasePath,
    workflow,
    store,
    runId: parked.runId,
    parkedAttempt,
    resumedStarted: () => published === 2,
  };
}

describe("progress of aborted attempts", () => {
  it("settles open tracks of a timed-out action and keeps terminal and other updates", async () => {
    const { engine, databasePath, events } = await makeEngine();
    const workflow = hungAction(
      "timed-out-tracks",
      [
        track("agents/review", "running", { phase: "review", completed: 0, total: 2, unit: "s" }),
        track("agents/review/a", "running", {
          label: "Reviewer A",
          phase: "tool: read",
          sourceEstimatedFinishAt: "2999-01-01T00:00:00.000Z",
        }),
        track("agents/review/b", "pending", { phase: "pending" }),
        track("agents/review/c", "completed", { phase: "completed" }),
        { type: "note", key: "agents/review/a", data: { status: "running" } },
      ],
      { timeoutMs: 50 },
    );

    const { runId, state } = await engine.run(workflow, {});

    expect(state.status).toBe("timed_out");
    expect(state.results.work?.outcome).toBe("timed_out");
    const attemptId = state.results.work?.attemptId;
    const durable = durableUpdates(databasePath, runId);
    const projected = byKey((state.updates ?? []).filter((update) => update.type === "progress"));
    for (const updates of [projected, durable.updates]) {
      expect(updates.get("agents/review")?.data).toEqual(
        progress("failed", { phase: "timed out", completed: 0, total: 2, unit: "s" }),
      );
      expect(updates.get("agents/review/a")?.data).toEqual(
        progress("failed", { label: "Reviewer A", phase: "timed out" }),
      );
      expect(updates.get("agents/review/b")?.data).toEqual(
        progress("failed", { phase: "timed out" }),
      );
      expect(updates.get("agents/review/c")?.data).toEqual(
        progress("completed", { phase: "completed" }),
      );
    }
    const note = (state.updates ?? []).find((update) => update.type === "note");
    expect(note?.data).toEqual({ status: "running" });

    // Settlement uses ordinary update records for the same attempt, before the attempt result.
    const published = durable.trace.filter((event) => event.type === "update_published");
    expect(published).toHaveLength(8);
    const settlement = published.slice(5);
    expect(settlement.every((event) => event.attemptId === attemptId)).toBe(true);
    expect(settlement.map((event) => event.payload.key)).toEqual([
      "agents/review",
      "agents/review/a",
      "agents/review/b",
    ]);
    const failedAt = durable.trace.findIndex((event) => event.type === "node_failed");
    expect(durable.trace.indexOf(settlement.at(-1)!)).toBeLessThan(failedAt);
    expect(events.filter((event) => event.type === "update_published")).toHaveLength(8);
  });

  it("settles open tracks as cancelled when the run is cancelled", async () => {
    const { engine, databasePath } = await makeEngine();
    let started = false;
    const workflow = hungAction(
      "cancelled-tracks",
      [track("overall", "running", { completed: 3, total: 10, unit: "rows" })],
      { capture: () => (started = true) },
    );

    const running = engine.run(workflow, {});
    await waitUntil(() => started);
    engine.cancel();
    const { runId, state } = await running;

    expect(state.status).toBe("cancelled");
    const expected = progress("cancelled", {
      phase: "cancelled",
      completed: 3,
      total: 10,
      unit: "rows",
    });
    expect(byKey(state.updates).get("overall")?.data).toEqual(expected);
    expect(durableUpdates(databasePath, runId).updates.get("overall")?.data).toEqual(expected);
  });

  it("settles an agent step's tracks after its timeout", async () => {
    const executor = new ScriptedExecutor().respond("ask", async (request) => {
      await request.publishUpdate?.(track("job", "running"), "tool-call-1");
      return await hang();
    });
    const { engine, databasePath } = await makeEngine({ executor });
    const workflow = defineWorkflow({
      name: "agent-timeout-tracks",
      startAt: "ask",
      nodes: { ask: agent({ prompt: () => "?", timeoutMs: 50 }) },
      edges: [],
    });

    const { runId, state } = await engine.run(workflow, {});

    expect(state.status).toBe("timed_out");
    expect(durableUpdates(databasePath, runId).updates.get("job")?.data).toEqual(
      progress("failed", { phase: "timed out" }),
    );
  });

  it("rejects publications after the abort and keeps the engine's final state", async () => {
    const { engine, databasePath } = await makeEngine();
    let publish: Publish | undefined;
    const rejected: Promise<unknown>[] = [];
    const workflow = hungAction("late-publication", [track("overall", "running")], {
      timeoutMs: 50,
      capture: (publishUpdate, signal) => {
        publish = publishUpdate;
        signal.addEventListener("abort", () => {
          rejected.push(
            publishUpdate(track("overall", "completed")).then(
              () => "accepted",
              (error: unknown) => error,
            ),
          );
        });
      },
    });

    const { runId, state } = await engine.run(workflow, {});
    const late = publish?.(track("overall", "running", { phase: "late" }));

    expect(state.status).toBe("timed_out");
    expect(rejected).toHaveLength(1);
    expect(String(await rejected[0])).toMatch(/is not active/);
    await expect(late).rejects.toThrow(/is not active/);
    const final = progress("failed", { phase: "timed out" });
    expect(byKey(state.updates).get("overall")?.data).toEqual(final);
    const durable = durableUpdates(databasePath, runId);
    expect(durable.updates.get("overall")?.data).toEqual(final);
    expect(durable.trace.filter((event) => event.type === "update_published")).toHaveLength(2);
  });

  it("waits for publications in flight at the abort before it settles", async () => {
    let releaseResponse: () => void = () => undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    class DelayedResponseStore extends WorkflowRunStore {
      override async publishUpdate(
        ...args: Parameters<WorkflowRunStore["publishUpdate"]>
      ): ReturnType<WorkflowRunStore["publishUpdate"]> {
        const result = await super.publishUpdate(...args);
        // A server-backed runner can receive the receipt of an accepted
        // update after its attempt has already timed out.
        if (args[3].data.status === "completed") await responseGate;
        return result;
      }
    }
    const store = new DelayedResponseStore(await makeStateDatabasePath("in-flight-update"));
    const { engine } = await makeEngine({ store });
    let started = false;
    const workflow = defineWorkflow({
      name: "in-flight-update",
      startAt: "work",
      nodes: {
        work: action({
          effect: idempotentEffect("test.in-flight-update"),
          timeoutMs: 50,
          run: async ({ publishUpdate }) => {
            await publishUpdate(track("a", "running"));
            await publishUpdate(track("b", "running"));
            void publishUpdate(track("a", "completed")).catch(() => undefined);
            started = true;
            return await hang();
          },
        }),
      },
      edges: [],
    });

    const running = engine.run(workflow, {});
    await waitUntil(() => started);
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseResponse();
    const { runId, state } = await running;

    expect(state.status).toBe("timed_out");
    const durable = byKey(store.readRun(runId)?.state.updates);
    expect(durable.get("a")?.data).toEqual(progress("completed"));
    expect(durable.get("b")?.data).toEqual(progress("failed", { phase: "timed out" }));
    expect(byKey(state.updates).get("a")?.data).toEqual(progress("completed"));
    store.close();
  });

  it("settles each attempt's own tracks and leaves a retry's tracks alone", async () => {
    const { engine, databasePath } = await makeEngine();
    let attempts = 0;
    const workflow = defineWorkflow({
      name: "retried-tracks",
      startAt: "work",
      nodes: {
        work: action({
          effect: idempotentEffect("test.retried-tracks"),
          timeoutMs: 50,
          run: async ({ publishUpdate }) => {
            attempts += 1;
            if (attempts === 1) {
              await publishUpdate(track("shared", "running"));
              await publishUpdate(track("first-only", "running"));
              return await hang();
            }
            await publishUpdate(track("shared", "running", { phase: "second" }));
            return "done";
          },
        }),
        finish: compute({ run: () => "finished" }),
      },
      edges: [
        {
          from: "work",
          switch: { on: "$result.outcome", cases: { ok: "finish", timed_out: "work" } },
        },
      ],
    });

    const { runId, state } = await engine.run(workflow, {});

    expect(state.status).toBe("completed");
    const [first, second] = state.steps.filter((step) => step.nodeId === "work");
    expect(first?.outcome).toBe("timed_out");
    expect(second?.outcome).toBe("ok");
    const durable = durableUpdates(databasePath, runId).updates;
    expect(durable.get("first-only")).toMatchObject({
      attemptId: first?.attemptId,
      data: progress("failed", { phase: "timed out" }),
    });
    expect(durable.get("shared")).toMatchObject({
      attemptId: second?.attemptId,
      data: progress("running", { phase: "second" }),
    });
  });

  it("settles a replaced attempt's own tracks as interrupted and lets the resumed attempt replace shared ones", async () => {
    const databasePath = await makeStateDatabasePath("parked-tracks");
    let started = false;
    const workflow = defineWorkflow({
      name: "parked-tracks",
      startAt: "work",
      nodes: {
        work: action({
          effect: idempotentEffect("test.parked-tracks"),
          run: async ({ publishUpdate }) => {
            if (!started) {
              await publishUpdate(track("overall", "running"));
              await publishUpdate(track("retired-only", "running"));
              started = true;
              return await hang();
            }
            await publishUpdate(track("overall", "completed"));
            return "done";
          },
        }),
      },
      edges: [],
    });
    const { parked, retiredAttemptId, resumed } = await parkThenResume(
      workflow,
      () => started,
      databasePath,
    );

    expect(parked.state.status).toBe("running");
    expect(resumed.state.status).toBe("completed");
    const updates = durableUpdates(databasePath, parked.runId).updates;
    const overall = updates.get("overall");
    expect(overall?.data).toEqual(progress("completed"));
    expect(overall?.attemptId).toBe(resumed.state.results.work?.attemptId);
    // The resume retired the parked attempt without a step and settled the track that only it
    // published as interrupted. The attempt stays retired and unrecorded.
    expect(updates.get("retired-only")).toMatchObject({
      attemptId: retiredAttemptId,
      data: progress("cancelled", { phase: "interrupted" }),
    });
    const stored = readWorkflowRun(parked.runId, { databasePath })?.state;
    expect(stored?.unrecordedAttempts).toEqual([
      expect.objectContaining({ attemptId: retiredAttemptId, nodeId: "work" }),
    ]);
    expect(attemptRow(databasePath, retiredAttemptId)).toMatchObject({ status: "cancelled" });
  });

  it("settles only a timed-out replacement's tracks and never reactivates the retired attempt", async () => {
    const databasePath = await makeStateDatabasePath("retired-and-timed-out");
    let started = false;
    let duringReplacement:
      | {
          unrecorded: unknown;
          retiredRow: AttemptRow | undefined;
          replacementAttemptId: string | undefined;
        }
      | undefined;
    const workflow = defineWorkflow({
      name: "retired-and-timed-out",
      startAt: "work",
      nodes: {
        work: action({
          effect: idempotentEffect("test.retired-and-timed-out"),
          // Only the replacement, which runs after a resume retired the parked attempt, has a
          // limit. The test holds that timer and fires it once the replacement has published
          // and recorded what it saw, so the limit cannot run out first.
          timeoutMs: ({ state }) =>
            state.unrecordedAttempts === undefined ? null : HELD_TIMEOUT_MS,
          run: async ({ publishUpdate, state }) => {
            if (!started) {
              await publishUpdate(track("shared", "running", { phase: "first" }));
              await publishUpdate(track("retired-only", "running"));
              started = true;
              return await hang();
            }
            await publishUpdate(track("shared", "running", { phase: "replacement" }));
            await publishUpdate(track("replacement-only", "pending"));
            const retired = state.unrecordedAttempts?.[0]?.attemptId;
            duringReplacement = {
              unrecorded: structuredClone(state.unrecordedAttempts),
              retiredRow: attemptRow(databasePath, retired),
              replacementAttemptId: state.currentAttemptId,
            };
            return await hang();
          },
        }),
      },
      edges: [],
    });

    const timers = holdTimers(HELD_TIMEOUT_MS);
    let result: Awaited<ReturnType<typeof parkThenResume>>;
    try {
      result = await parkThenResume(
        workflow,
        () => started,
        databasePath,
        async () => {
          await waitUntil(() => duringReplacement !== undefined, 30_000);
          expect(timers.held()).toBe(1);
          timers.fire();
        },
      );
    } finally {
      timers.restore();
    }
    const { parked, retiredAttemptId, resumed } = result;

    expect(resumed.state.status).toBe("timed_out");
    const replacementAttemptId = duringReplacement?.replacementAttemptId;
    expect(replacementAttemptId).toBeDefined();
    expect(replacementAttemptId).not.toBe(retiredAttemptId);
    // The retired attempt is listed once, with the window and row it had before the settlement.
    const stored = readWorkflowRun(parked.runId, { databasePath, includeTrace: true });
    const unrecorded = stored?.state.unrecordedAttempts;
    expect(unrecorded).toHaveLength(1);
    expect(unrecorded?.[0]).toMatchObject({ attemptId: retiredAttemptId, nodeId: "work" });
    expect(unrecorded).toEqual(duringReplacement?.unrecorded);
    expect(resumed.state.unrecordedAttempts).toEqual(unrecorded);
    expect(attemptRow(databasePath, retiredAttemptId)).toEqual(duringReplacement?.retiredRow);
    expect(duringReplacement?.retiredRow).toMatchObject({ status: "cancelled" });
    expect(Date.parse(unrecorded?.[0]?.startedAt ?? "")).toBe(
      duringReplacement?.retiredRow?.startedAt,
    );
    expect(Date.parse(unrecorded?.[0]?.finishedAt ?? "")).toBe(
      duringReplacement?.retiredRow?.finishedAt,
    );
    // The replacement is recorded as a timed-out step, not as an unrecorded attempt.
    expect(
      stored?.state.steps.filter((entry) => entry.nodeId === "work").map((entry) => entry.outcome),
    ).toEqual(["timed_out"]);
    expect(stored?.state.steps.at(-1)?.attemptId).toBe(replacementAttemptId);
    expect(attemptRow(databasePath, replacementAttemptId)).toMatchObject({ status: "timed_out" });
    // The timeout settles only the replacement's open tracks. The retired attempt's own track
    // keeps the interrupted record that the resume wrote for it.
    const updates = byKey(stored?.state.updates);
    expect(updates.get("retired-only")).toMatchObject({
      attemptId: retiredAttemptId,
      data: progress("cancelled", { phase: "interrupted" }),
    });
    expect(updates.get("shared")).toMatchObject({
      attemptId: replacementAttemptId,
      data: progress("failed", { phase: "timed out" }),
    });
    expect(updates.get("replacement-only")).toMatchObject({
      attemptId: replacementAttemptId,
      data: progress("failed", { phase: "timed out" }),
    });
    const settlement = (stored?.traceEvents ?? []).filter(
      (event) =>
        event.type === "update_published" &&
        event.payload.data !== undefined &&
        (event.payload.data as { phase?: unknown }).phase === "timed out",
    );
    expect(settlement.map((event) => event.attemptId)).toEqual([
      replacementAttemptId,
      replacementAttemptId,
    ]);
    // The resume wrote one interrupted record for each track that the retired attempt left open.
    const interrupted = (stored?.traceEvents ?? []).filter(
      (event) =>
        event.type === "update_published" &&
        (event.payload.data as { phase?: unknown } | undefined)?.phase === "interrupted",
    );
    expect(interrupted.map((event) => [event.attemptId, event.payload.key])).toEqual([
      [retiredAttemptId, "shared"],
      [retiredAttemptId, "retired-only"],
    ]);
  });

  it("settles the tracks of an attempt that a resume discards", async () => {
    const databasePath = await makeStateDatabasePath("discarded-tracks");
    let attempts = 0;
    let published = 0;
    const workflow = defineWorkflow({
      name: "discarded-tracks",
      startAt: "work",
      nodes: {
        work: action({
          effect: idempotentEffect("test.discarded-tracks"),
          run: async ({ publishUpdate }) => {
            attempts += 1;
            if (attempts === 1) {
              await publishUpdate(
                track("overall", "running", { completed: 1, total: 2, unit: "agents" }),
              );
              await publishUpdate(track("agents/a", "running", { label: "A" }));
              await publishUpdate(track("agents/done", "completed"));
            } else {
              await publishUpdate(track("overall", "running", { phase: "second" }));
              await publishUpdate(track("agents/b", "running"));
            }
            published = attempts;
            return await hang();
          },
        }),
      },
      edges: [],
    });
    const first = new WorkflowEngine({ databasePath, executor: new ScriptedExecutor() });
    const running = first.run(workflow, {});
    await waitUntil(() => published === 1);
    first.park();
    const parked = await running;
    const discarded = durableUpdates(databasePath, parked.runId).updates.get("agents/a")?.attemptId;
    if (discarded === undefined) throw new Error("first attempt track missing");

    const recovery = new WorkflowRunStore(databasePath);
    expect(await recovery.recoverApplyingEffects(parked.runId)).toBe("safe");
    recovery.close();
    let engineState: WorkflowRunState | undefined;
    const second = new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor(),
      onEvent: (_event, state) => {
        engineState = state;
      },
    });
    const resumed = second.resumeRun(workflow, parked.runId);
    await waitUntil(() => published === 2);

    // The resume settles each open track of the discarded attempt once, right after run_resumed.
    const afterResume = durableUpdates(databasePath, parked.runId);
    const resumedAt = afterResume.trace.findIndex((event) => event.type === "run_resumed");
    const settlement = afterResume.trace.slice(resumedAt + 1, resumedAt + 3);
    expect(settlement.map((event) => [event.type, event.attemptId, event.payload.key])).toEqual([
      ["update_published", discarded, "overall"],
      ["update_published", discarded, "agents/a"],
    ]);
    expect(settlement.map((event) => event.seq)).toEqual([
      afterResume.trace[resumedAt]!.seq + 1,
      afterResume.trace[resumedAt]!.seq + 2,
    ]);
    const settledA = afterResume.updates.get("agents/a");
    expect(settledA).toMatchObject({
      attemptId: discarded,
      data: progress("cancelled", { label: "A", phase: "interrupted" }),
    });
    expect(afterResume.updates.get("agents/done")?.data).toEqual(progress("completed"));

    // The retired attempt keeps its window and has no step record.
    const store = new WorkflowRunStore(databasePath);
    const connection = store.state.connection;
    expect(
      connection
        .prepare(
          `SELECT status, started_at IS NOT NULL AS started, finished_at IS NOT NULL AS finished
           FROM node_attempts WHERE attempt_id = ?`,
        )
        .get(discarded),
    ).toEqual({ status: "cancelled", started: 1, finished: 1 });
    expect(
      connection.prepare("SELECT 1 FROM run_steps WHERE attempt_id = ?").get(discarded),
    ).toBeUndefined();

    // The engine still holds the discarded attempt's open record, which does not
    // change how it settles its own attempt.
    expect(engineState?.updates?.find((update) => update.key === "agents/a")).toMatchObject({
      attemptId: discarded,
      data: progress("running", { label: "A" }),
    });
    second.cancel();
    const cancelled = await resumed;
    expect(cancelled.state.status).toBe("cancelled");
    const final = durableUpdates(databasePath, parked.runId);
    const current = cancelled.state.currentAttemptId ?? cancelled.state.results.work?.attemptId;
    expect(current).not.toBe(discarded);
    expect(final.updates.get("agents/a")).toEqual(settledA);
    expect(final.updates.get("agents/b")).toMatchObject({
      attemptId: current,
      data: progress("cancelled", { phase: "cancelled" }),
    });
    expect(final.updates.get("overall")).toMatchObject({
      attemptId: current,
      data: progress("cancelled", { phase: "cancelled" }),
    });
    const later = final.trace.slice(resumedAt + 3);
    expect(
      later.filter((event) => event.type === "update_published" && event.attemptId === discarded),
    ).toEqual([]);
    store.close();
  });

  it("writes no settlement when a resume replaces an attempt without open tracks", async () => {
    const run = await parkedAction("replaced-without-tracks", [track("done", "completed")]);
    const engine = new WorkflowEngine({ store: run.store, executor: new ScriptedExecutor() });
    const resumed = engine.resumeRun(run.workflow, run.runId);
    await waitUntil(run.resumedStarted);

    const { trace, updates } = durableUpdates(run.databasePath, run.runId);
    const resumedAt = trace.findIndex((event) => event.type === "run_resumed");
    // The resume commits only run_resumed (+1); the next revision is the new attempt.
    expect(trace[resumedAt + 1]).toMatchObject({
      type: "node_started",
      seq: trace[resumedAt]!.seq + 1,
    });
    expect(trace.slice(resumedAt).filter((event) => event.type === "update_published")).toEqual([]);
    expect(updates.get("done")).toMatchObject({
      attemptId: run.parkedAttempt,
      data: progress("completed"),
    });
    expect(
      run.store.state.connection
        .prepare("SELECT status FROM node_attempts WHERE attempt_id = ?")
        .get(run.parkedAttempt),
    ).toEqual({ status: "cancelled" });
    engine.cancel();
    await resumed;
    run.store.close();
  });

  it("rolls back a resume and its cached revision when a settlement record fails", async () => {
    const run = await parkedAction("rolled-back-resume", [track("open", "running")]);
    const before = run.store.runRevision(run.runId);
    run.store.state.connection.exec(
      `CREATE TEMP TRIGGER reject_settlement BEFORE INSERT ON workflow_updates
       BEGIN SELECT RAISE(ABORT, 'settlement rejected'); END`,
    );
    const engine = new WorkflowEngine({ store: run.store, executor: new ScriptedExecutor() });

    await expect(engine.resumeRun(run.workflow, run.runId)).rejects.toThrow(/settlement rejected/);

    // Only the resume preparation committed; the retirement and run_resumed rolled back.
    const prepared = before + 1;
    expect(run.store.runRevision(run.runId)).toBe(prepared);
    const { trace, updates } = durableUpdates(run.databasePath, run.runId);
    expect(trace.at(-1)).toMatchObject({ type: "run_resume_prepared", seq: prepared });
    expect(updates.get("open")?.data).toEqual(progress("running"));
    expect(
      run.store.state.connection
        .prepare("SELECT status FROM node_attempts WHERE attempt_id = ?")
        .get(run.parkedAttempt),
    ).toEqual({ status: "interrupted" });
    run.store.state.connection.exec("DROP TRIGGER reject_settlement");

    // The cached revision did not advance past the rollback, so the next write
    // through the same store is accepted.
    const accepted = await run.store.publishUpdate(
      run.runId,
      "work",
      run.parkedAttempt,
      track("open", "running", { phase: "after rollback" }),
    );
    expect(accepted.event.seq).toBe(prepared + 1);
    run.store.close();
  });

  it("keeps the tracks of an attempt that a resume keeps", async () => {
    const databasePath = await makeStateDatabasePath("kept-tracks");
    const workflow = defineWorkflow({
      name: "kept-tracks",
      startAt: "ask",
      nodes: { ask: agent({ prompt: () => "answer" }) },
      edges: [],
    });
    let firstStarted = false;
    const first: AgentStepExecutor = {
      enforcesToolAllowlist: true,
      assistantMessageMode: "visible",
      runAgentStep: async (request, signal) => {
        await request.publishUpdate?.(track("agents/ask", "running", { label: "Ask" }));
        firstStarted = true;
        return await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    const parkedEngine = new WorkflowEngine({ databasePath, executor: first });
    const running = parkedEngine.run(workflow, {});
    await waitUntil(() => firstStarted);
    parkedEngine.park();
    const parked = await running;
    const recovery = new WorkflowRunStore(databasePath);
    const kept = recovery.readRunState(parked.runId)?.currentAttemptId;
    recovery.close();
    if (kept === undefined) throw new Error("parked attempt missing");

    let seenByResumedAttempt: WorkflowUpdateRecord | undefined;
    let resumedAttemptId: string | undefined;
    const second: AgentStepExecutor = {
      enforcesToolAllowlist: true,
      assistantMessageMode: "visible",
      runAgentStep: async (request) => {
        resumedAttemptId = request.contract.attemptId;
        seenByResumedAttempt = durableUpdates(databasePath, parked.runId).updates.get("agents/ask");
        const accepted = await request.accept({ done: true });
        if (!accepted.ok) throw new Error(accepted.error);
        return { output: accepted.value };
      },
    };
    const resumed = await new WorkflowEngine({ databasePath, executor: second }).resumeRun(
      workflow,
      parked.runId,
      { resumeInteractionAttemptId: kept },
    );

    expect(resumed.state.status).toBe("completed");
    expect(resumedAttemptId).toBe(kept);
    expect(seenByResumedAttempt).toMatchObject({
      attemptId: kept,
      data: progress("running", { label: "Ask" }),
    });
    const { trace } = durableUpdates(databasePath, parked.runId);
    const resumedEvent = trace.find((event) => event.type === "run_resumed");
    expect(resumedEvent?.payload.resumedAttemptId).toBe(kept);
    expect(
      trace.filter(
        (event) => event.type === "update_published" && event.seq > (resumedEvent?.seq ?? 0),
      ),
    ).toEqual([]);
  });

  it("writes no settlement when a run is cancelled at a pause boundary", async () => {
    const { engine, databasePath, events } = await makeEngine();
    let finishWork: () => void = () => undefined;
    const workGate = new Promise<void>((resolve) => {
      finishWork = resolve;
    });
    let started = false;
    const workflow = defineWorkflow({
      name: "paused-tracks",
      startAt: "work",
      nodes: {
        work: action({
          effect: idempotentEffect("test.paused-tracks"),
          run: async ({ publishUpdate }) => {
            await publishUpdate(track("overall", "running"));
            started = true;
            await workGate;
            await publishUpdate(track("overall", "completed"));
            return "done";
          },
        }),
        next: compute({ run: () => "next" }),
      },
      edges: [{ from: "work", to: "next" }],
    });

    const running = engine.run(workflow, {});
    await waitUntil(() => started);
    engine.pause();
    finishWork();
    await waitUntil(() => events.some((event) => event.type === "run_paused"));
    engine.cancel();
    const { runId, state } = await running;

    expect(state.status).toBe("cancelled");
    expect(state.results.work?.outcome).toBe("ok");
    const durable = durableUpdates(databasePath, runId);
    expect(durable.updates.get("overall")?.data).toEqual(progress("completed"));
    expect(durable.trace.filter((event) => event.type === "update_published")).toHaveLength(2);
  });

  it("keeps the attempt outcome when a settlement update is rejected", async () => {
    class RejectingStore extends WorkflowRunStore {
      override async publishUpdate(
        ...args: Parameters<WorkflowRunStore["publishUpdate"]>
      ): ReturnType<WorkflowRunStore["publishUpdate"]> {
        if (args[4] === undefined && args[3].key === "a") throw new Error("storage refused");
        return await super.publishUpdate(...args);
      }
    }
    const store = new RejectingStore(await makeStateDatabasePath("rejected-settlement"));
    const { engine } = await makeEngine({ store });
    const workflow = hungAction(
      "rejected-settlement",
      [track("a", "running"), track("b", "running")],
      {
        timeoutMs: 50,
      },
    );

    const { runId, state } = await engine.run(workflow, {});

    expect(state.status).toBe("timed_out");
    const durable = byKey(store.readRun(runId)?.state.updates);
    expect(durable.get("a")?.data).toEqual(progress("running"));
    expect(durable.get("b")?.data).toEqual(progress("failed", { phase: "timed out" }));
    store.close();
  });

  it("propagates a lost claim during settlement", async () => {
    class FencedStore extends WorkflowRunStore {
      override async publishUpdate(
        ...args: Parameters<WorkflowRunStore["publishUpdate"]>
      ): ReturnType<WorkflowRunStore["publishUpdate"]> {
        if (args[4] === undefined) throw new ClaimLostError(args[0], "ownerChanged");
        return await super.publishUpdate(...args);
      }
    }
    const store = new FencedStore(await makeStateDatabasePath("fenced-settlement"));
    const { engine } = await makeEngine({ store });
    const workflow = hungAction("fenced-settlement", [track("a", "running")], { timeoutMs: 50 });

    await expect(engine.run(workflow, {})).rejects.toBeInstanceOf(ClaimLostError);
    store.close();
  });
});
