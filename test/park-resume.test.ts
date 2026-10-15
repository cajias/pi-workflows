import { describe, expect, it } from "vitest";
import { agent, compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { WorkflowRunState } from "../src/workflows/types.js";
import { ScriptedExecutor, makeStateDatabasePath, waitUntil } from "./helpers.js";

const workflow = defineWorkflow({
  name: "handoff",
  startAt: "first",
  nodes: {
    first: compute({ run: () => ({ first: true }) }),
    second: agent({ prompt: () => "finish" }),
  },
  edges: [{ from: "first", to: "second" }],
});

describe("durable run handoff in SQLite", () => {
  it("parks active work and continues it from the same database", async () => {
    const databasePath = await makeStateDatabasePath("park-run");
    const firstExecutor = new ScriptedExecutor().respond("second", { hang: true });
    const firstEngine = new WorkflowEngine({ databasePath, executor: firstExecutor });
    const running = firstEngine.run(workflow, {});
    await waitUntil(() => firstExecutor.requests.length === 1);
    firstEngine.park();
    const parked = await running;
    expect(parked.state.status).toBe("running");

    const recoveryStore = new WorkflowRunStore(databasePath);
    const firstRecovery = await recoveryStore.prepareRunResume(parked.runId);
    const secondRecovery = await recoveryStore.prepareRunResume(parked.runId);
    expect(secondRecovery.currentAttemptId).toBe(firstRecovery.currentAttemptId);
    expect(secondRecovery.currentNode).toBe("second");
    recoveryStore.close();

    const secondEngine = new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("second", { output: { done: true } }),
    });
    const completed = await secondEngine.resumeRun(workflow, parked.runId);
    expect(completed.state.status).toBe("completed");
    expect(completed.state.finalOutput).toEqual({ done: true });
  });

  it("marks an abandoned active run as interrupted through one transaction", async () => {
    const databasePath = await makeStateDatabasePath("interrupted-run");
    const store = new WorkflowRunStore(databasePath);
    const executor = new ScriptedExecutor().respond("second", { hang: true });
    const engine = new WorkflowEngine({ store, executor });
    const running = engine.run(workflow, {});
    await waitUntil(() => executor.requests.length === 1);
    engine.park();
    const parked = await running;
    const interrupted = await store.markRunInterrupted(parked.runId, "owner disappeared");
    expect(interrupted?.state).toMatchObject({ status: "failed", error: "owner disappeared" });
    expect(interrupted?.state.currentAttemptId).toBeUndefined();
    expect(interrupted?.state.currentNode).toBeUndefined();
    expect(store.readRun(parked.runId)?.state.currentAttemptId).toBeUndefined();
    expect(interrupted?.traceEvents?.at(-1)?.type).toBe("run_interrupted");
    store.close();
  });

  describe("unrecorded attempts", () => {
    const seen: Array<WorkflowRunState["unrecordedAttempts"]> = [];
    const observed = defineWorkflow({
      name: "unrecorded",
      startAt: "first",
      nodes: {
        first: compute({ run: () => ({ first: true }) }),
        second: agent({ prompt: () => "finish" }),
        third: compute({
          run: (context) => {
            seen.push(structuredClone(context.state.unrecordedAttempts));
            return { third: true };
          },
        }),
      },
      edges: [
        { from: "first", to: "second" },
        { from: "second", to: "third" },
      ],
    });

    it("lists an attempt that a resume retired without a step record", async () => {
      seen.length = 0;
      const databasePath = await makeStateDatabasePath("unrecorded-attempt");
      const firstExecutor = new ScriptedExecutor().respond("second", { hang: true });
      const firstEngine = new WorkflowEngine({ databasePath, executor: firstExecutor });
      const running = firstEngine.run(observed, {});
      await waitUntil(() => firstExecutor.requests.length === 1);
      firstEngine.park();
      const parked = await running;
      const store = new WorkflowRunStore(databasePath);
      const lost = store.readRun(parked.runId)?.state;
      // The parked attempt is still the active attempt, so nothing is unrecorded yet.
      expect(lost?.unrecordedAttempts).toBeUndefined();
      const prepared = await store.prepareRunResume(parked.runId);
      expect(prepared.unrecordedAttempts).toBeUndefined();
      store.close();

      const secondEngine = new WorkflowEngine({
        databasePath,
        executor: new ScriptedExecutor().respond("second", { output: { done: true } }),
      });
      const completed = await secondEngine.resumeRun(observed, parked.runId);
      expect(completed.state.status).toBe("completed");
      const reopened = new WorkflowRunStore(databasePath);
      const stored = reopened.readRun(parked.runId)?.state;
      reopened.close();
      const retired = stored?.unrecordedAttempts?.[0];
      expect(stored?.unrecordedAttempts).toHaveLength(1);
      expect(retired).toMatchObject({
        attemptId: prepared.currentAttemptId,
        nodeId: "second",
        startedAt: prepared.currentNodeStartedAt,
      });
      const replacement = stored?.steps.find((step) => step.nodeId === "second");
      expect(replacement?.attemptId).not.toBe(retired?.attemptId);
      expect(Date.parse(retired?.finishedAt ?? "")).toBeLessThanOrEqual(
        Date.parse(replacement?.startedAt ?? ""),
      );
      // The engine's in-memory state, which node callbacks read, matches the stored derivation.
      expect(seen).toEqual([stored?.unrecordedAttempts]);
      expect(completed.state.unrecordedAttempts).toEqual(stored?.unrecordedAttempts);
    });

    it("omits the field when every attempt has a step record", async () => {
      seen.length = 0;
      const databasePath = await makeStateDatabasePath("no-unrecorded-attempt");
      const engine = new WorkflowEngine({
        databasePath,
        executor: new ScriptedExecutor().respond("second", { output: { done: true } }),
      });
      const completed = await engine.run(observed, {});
      expect(completed.state.status).toBe("completed");
      expect(completed.state).not.toHaveProperty("unrecordedAttempts");
      expect(seen).toEqual([undefined]);
      const store = new WorkflowRunStore(databasePath);
      expect(store.readRun(completed.runId)?.state).not.toHaveProperty("unrecordedAttempts");
      store.close();
    });
  });
});
