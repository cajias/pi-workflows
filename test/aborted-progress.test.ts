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
  WorkflowActionContext,
  WorkflowTraceEvent,
  WorkflowUpdateInput,
  WorkflowUpdateRecord,
} from "../src/workflows/types.js";
import { makeStateDatabasePath, ScriptedExecutor, waitUntil } from "./helpers.js";

type Publish = WorkflowActionContext["publishUpdate"];

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
  return { parked, retiredAttemptId, resumed: await second.resumeRun(workflow, parked.runId) };
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

  it("leaves tracks open when the engine parks and lets the resumed attempt replace them", async () => {
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
    // The resume retired the parked attempt without a step. Nothing settled it, so the track
    // that only it published stays open, and its attempt stays retired.
    expect(updates.get("retired-only")).toMatchObject({
      attemptId: retiredAttemptId,
      data: progress("running"),
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
          // limit. It is long enough for the replacement to publish and record what it saw first.
          timeoutMs: ({ state }) => (state.unrecordedAttempts === undefined ? null : 1_000),
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

    const { parked, retiredAttemptId, resumed } = await parkThenResume(
      workflow,
      () => started,
      databasePath,
    );

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
    // Only the replacement's open tracks settle; the retired attempt's own track stays open.
    const updates = byKey(stored?.state.updates);
    expect(updates.get("retired-only")).toMatchObject({
      attemptId: retiredAttemptId,
      data: progress("running"),
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
