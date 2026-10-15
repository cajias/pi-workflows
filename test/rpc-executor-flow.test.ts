import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ServerProcessRegistry } from "../src/server/processes.js";
import { RpcStepExecutor } from "../src/server/rpc-executor.js";
import { encodeRpcModelError, encodeRpcSessionStarted } from "../src/server/rpc-protocol.js";
import type { AgentStepRequest } from "../src/workflows/types.js";
import { makeTempDir } from "./helpers.js";

function requestFor(
  nodeId: string,
  attemptId: string,
  accept?: AgentStepRequest["accept"],
): AgentStepRequest {
  return {
    contract: {
      requestId: `request-${nodeId}-${attemptId}`,
      runId: "r",
      workflowName: "w",
      nodeId,
      attemptId,
      completion: "submit",
    },
    prompt: "do the step",
    accept: accept ?? (async () => ({ ok: true as const, value: null })),
  };
}

/** A fake pi that speaks the bridge protocol from a small script. */
async function makeFakePi(
  script: string,
): Promise<{ dir: string; fakePi: string; stdinLog: string }> {
  const dir = await makeTempDir("pi-rpc-flow");
  const fakePi = path.join(dir, "fake-pi.sh");
  const stdinLog = path.join(dir, "stdin.log");
  await fs.writeFile(
    fakePi,
    `#!/bin/sh\nSTDIN_LOG=${JSON.stringify(stdinLog)}\nexec 3<&0\ncat <&3 > "$STDIN_LOG" &\nCATPID=$!\n${script}\nwait $CATPID\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  return { dir, fakePi, stdinLog };
}

function submissionLine(step: string, attempt: string, output: unknown): string {
  return `PI_WORKFLOWS_STEP_SUBMISSION ${JSON.stringify({ action: "submit", requestId: `request-${step}-${attempt}`, output })}\\n`;
}

function updateLine(step: string, attempt: string): string {
  return `PI_WORKFLOWS_STEP_SUBMISSION ${JSON.stringify({
    action: "update",
    requestId: `request-${step}-${attempt}`,
    idempotencyKey: "tool-1",
    update: { type: "progress", key: "job", data: {} },
  })}\\n`;
}

/** A model error line as the bridge frames it, escaped for a shell `printf`. */
function modelErrorLine(error: string): string {
  return encodeRpcModelError(error).replaceAll("\n", "\\n");
}

describe("RpcStepExecutor submissions", () => {
  it("resolves a submission reported over stderr", async () => {
    const { fakePi } = await makeFakePi(
      `sleep 0.2\nprintf '${submissionLine("work", "a1", { done: true })}' >&2\nsleep 2\n`,
    );
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new ServerProcessRegistry("/tmp"),
      pi: { kind: "executable", executable: fakePi },
    });
    const submission = await executor.runAgentStep(
      requestFor("work", "a1"),
      new AbortController().signal,
    );
    expect(submission.output).toBeNull();
    await executor.close();
  });

  it("reports a rejected update to the headless agent and keeps the step open", async () => {
    const { fakePi, stdinLog } = await makeFakePi(
      `sleep 0.2\nprintf '${updateLine("work", "a1")}' >&2\nfor _ in 1 2 3 4 5 6 7 8 9 10; do\n  grep -q 'Workflow update rejected' "$STDIN_LOG" && break\n  sleep 0.1\ndone\ngrep -q 'Workflow update rejected' "$STDIN_LOG" || exit 4\nprintf '${submissionLine("work", "a1", { done: true })}' >&2\nsleep 2\n`,
    );
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new ServerProcessRegistry("/tmp"),
      pi: { kind: "executable", executable: fakePi },
    });
    const request = requestFor("work", "a1") as AgentStepRequest;
    request.publishUpdate = async () => {
      throw new Error("progress.schema must equal pi-workflows.progress.v1");
    };

    await expect(
      executor.runAgentStep(request, new AbortController().signal),
    ).resolves.toMatchObject({ output: null });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await fs.readFile(stdinLog, "utf8")).toContain(
      "Workflow update rejected: progress.schema must equal pi-workflows.progress.v1",
    );
    await executor.close();
  });

  it("re-prompts with the validation error and accepts a corrected submission", async () => {
    const { fakePi, stdinLog } = await makeFakePi(
      `sleep 0.2\nprintf '${submissionLine("work", "a1", { bad: 1 })}' >&2\nsleep 0.2\nprintf '${submissionLine("work", "a1", { good: 2 })}' >&2\nsleep 2\n`,
    );
    let calls = 0;
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new ServerProcessRegistry("/tmp"),
      pi: { kind: "executable", executable: fakePi },
    });
    const submission = await executor.runAgentStep(
      requestFor("work", "a1", async (output) => {
        calls += 1;
        return calls === 1
          ? { ok: false as const, error: "missing field" }
          : { ok: true as const, value: output };
      }),
      new AbortController().signal,
    );
    expect(submission.output).toEqual({ good: 2 });
    // The rejection surfaced to the model and a corrected submission was
    // validated: exactly two accept calls, no more.
    expect(calls).toBe(2);
    await executor.close();
    void stdinLog;
  });

  it("returns a submission that arrived before the prompt was sent", async () => {
    const { fakePi } = await makeFakePi(
      `printf '${submissionLine("work", "a1", { early: true })}' >&2
sleep 2
`,
    );
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new ServerProcessRegistry("/tmp"),
      pi: { kind: "executable", executable: fakePi },
    });
    // The marker is already waiting when the step starts; the executor
    // resolves without waiting for more.
    const submission = await executor.runAgentStep(
      requestFor("work", "a1"),
      new AbortController().signal,
    );
    expect(submission.output).toBeNull();
    await executor.close();
  });

  it("ignores malformed markers and submissions for other attempts", async () => {
    const { fakePi } = await makeFakePi(
      `sleep 0.2\nprintf 'PI_WORKFLOWS_STEP_SUBMISSION {broken\\n' >&2\nprintf '${submissionLine("work", "other", 1)}' >&2\nsleep 0.2\nprintf '${submissionLine("work", "a1", "mine")}' >&2\nsleep 2\n`,
    );
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new ServerProcessRegistry("/tmp"),
      pi: { kind: "executable", executable: fakePi },
    });
    const submission = await executor.runAgentStep(
      requestFor("work", "a1"),
      new AbortController().signal,
    );
    expect(submission.output).toBeNull();
    await executor.close();
  });

  it("rejects the step when the abort signal fires", async () => {
    const { fakePi } = await makeFakePi("sleep 30\n");
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new ServerProcessRegistry("/tmp"),
      pi: { kind: "executable", executable: fakePi },
    });
    const abort = new AbortController();
    const step = executor.runAgentStep(requestFor("work", "a1"), abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 150));
    abort.abort(new Error("stop the step"));
    await expect(step).rejects.toThrow(/stop the step|aborted/);
    await executor.close();
  });

  it("rejects the step when the child exits mid-step", async () => {
    const { fakePi } = await makeFakePi("exit 3\n");
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new ServerProcessRegistry("/tmp"),
      pi: { kind: "executable", executable: fakePi },
    });
    await expect(
      executor.runAgentStep(requestFor("work", "a1"), new AbortController().signal),
    ).rejects.toThrow(/exited/);
    // A second step on the dead child fails immediately with its exit info.
    await expect(
      executor.runAgentStep(requestFor("work", "a2"), new AbortController().signal),
    ).rejects.toThrow(/exited \(code 3/);
    await executor.close();
  });

  it("fails every step with the bridge's model error when the bridge stops pi", async () => {
    // A descendant writes the error line after pi exits, so the executor must wait for
    // stderr to deliver it instead of reporting the bare exit.
    const { fakePi, stdinLog } = await makeFakePi(
      `(sleep 0.3; printf '${modelErrorLine("default model is missing")}' >&2) &\nexit 1\n`,
    );
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new ServerProcessRegistry("/tmp"),
      pi: { kind: "executable", executable: fakePi },
    });
    await expect(
      executor.runAgentStep(requestFor("work", "a1"), new AbortController().signal),
    ).rejects.toThrow(/^default model is missing$/);
    await expect(
      executor.runAgentStep(requestFor("work", "a2"), new AbortController().signal),
    ).rejects.toThrow(/^default model is missing$/);
    await executor.close();
    expect(await fs.readFile(stdinLog, "utf8")).not.toContain("request-work-a2");
  });

  it("fails the step on a model error before the child exits", async () => {
    const { fakePi } = await makeFakePi(
      `printf 'noise without newline' >&2\nprintf '${modelErrorLine("no model")}' >&2\nsleep 30\n`,
    );
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new ServerProcessRegistry("/tmp"),
      pi: { kind: "executable", executable: fakePi },
    });
    await expect(
      executor.runAgentStep(requestFor("work", "a1"), new AbortController().signal),
    ).rejects.toThrow(/^no model$/);
    // The next step fails at once without prompting the stopped child again.
    await expect(
      executor.runAgentStep(requestFor("work", "a2"), new AbortController().signal),
    ).rejects.toThrow(/^no model$/);
    await executor.close();
  });

  it("reports Pi's own reason when Pi exits before its session starts", async () => {
    // Pi 1.1.0 prints this, in red, and exits 1 when no model is available at all.
    const { fakePi } = await makeFakePi(
      `printf '\\033[31mNo models available. Use /login to log into a provider via OAuth or API key. See:\\n  /docs/providers.md\\n  /docs/models.md\\033[39m\\n' >&2\nexit 1\n`,
    );
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new ServerProcessRegistry("/tmp"),
      pi: { kind: "executable", executable: fakePi },
    });
    const reason = [
      "No models available. Use /login to log into a provider via OAuth or API key. See:",
      "  /docs/providers.md",
      "  /docs/models.md",
    ].join("\n");
    await expect(
      executor.runAgentStep(requestFor("work", "a1"), new AbortController().signal),
    ).rejects.toThrow(
      `Headless pi session exited mid-step (code 1) before its session started. Pi reported:\n${reason}`,
    );
    // A later step on the dead child reports the same reason.
    await expect(
      executor.runAgentStep(requestFor("work", "a2"), new AbortController().signal),
    ).rejects.toThrow(
      `Headless pi session exited (code 1, signal null) before its session started. Pi reported:\n${reason}`,
    );
    await executor.close();
  });

  it("reports only the exit for stderr that Pi writes after its session started", async () => {
    const started = encodeRpcSessionStarted().replaceAll("\n", "\\n");
    const { fakePi } = await makeFakePi(
      `printf 'startup note\\n' >&2\nprintf '${started}' >&2\nprintf 'later noise\\n' >&2\nexit 1\n`,
    );
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new ServerProcessRegistry("/tmp"),
      pi: { kind: "executable", executable: fakePi },
    });
    await expect(
      executor.runAgentStep(requestFor("work", "a1"), new AbortController().signal),
    ).rejects.toThrow(/^Headless pi session exited mid-step \(code 1\)$/);
    await expect(
      executor.runAgentStep(requestFor("work", "a2"), new AbortController().signal),
    ).rejects.toThrow(/^Headless pi session exited \(code 1, signal null\)$/);
    await executor.close();
  });

  it("ends the startup window at Pi's first stdout event when the marker is missing", async () => {
    // Pi writes RPC events on stdout only after its session started, so stderr before and
    // after the first event is not startup output, even when the bridge's marker is lost.
    const { fakePi } = await makeFakePi(
      `printf 'startup note\\n' >&2\nsleep 0.2\nprintf '{"type":"response"}\\n'\nsleep 0.2\nprintf 'later noise\\n' >&2\nexit 1\n`,
    );
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new ServerProcessRegistry("/tmp"),
      pi: { kind: "executable", executable: fakePi },
    });
    await expect(
      executor.runAgentStep(requestFor("work", "a1"), new AbortController().signal),
    ).rejects.toThrow(/^Headless pi session exited mid-step \(code 1\)$/);
    await expect(
      executor.runAgentStep(requestFor("work", "a2"), new AbortController().signal),
    ).rejects.toThrow(/^Headless pi session exited \(code 1, signal null\)$/);
    await executor.close();
  });

  it("reports the exit when a model error line is malformed", async () => {
    const { fakePi } = await makeFakePi(
      `printf 'PI_WORKFLOWS_STEP_MODEL_ERROR {broken\\n' >&2\nprintf 'PI_WORKFLOWS_STEP_MODEL_ERROR {"error":1}\\n' >&2\nexit 1\n`,
    );
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new ServerProcessRegistry("/tmp"),
      pi: { kind: "executable", executable: fakePi },
    });
    await expect(
      executor.runAgentStep(requestFor("work", "a1"), new AbortController().signal),
    ).rejects.toThrow(/exited mid-step \(code 1\)/);
    await executor.close();
  });
});

describe("ServerProcessRegistry edge cases", () => {
  it("tolerates corrupt registry files", async () => {
    const dir = await makeTempDir("pi-server-registry-corrupt");
    const file = path.join(dir, "server.children.json");
    await fs.writeFile(file, "not json\n", "utf8");
    const registry = new ServerProcessRegistry(dir);
    expect(registry.reapOrphans()).toEqual([]);
    await fs.writeFile(file, '{"not": "an array"}', "utf8");
    expect(registry.reapOrphans()).toEqual([]);
    await fs.writeFile(file, '["not-a-pid", -1]', "utf8");
    expect(registry.reapOrphans()).toEqual([]);
    const identity = registry.register(process.pid);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      schema: "pi-workflows.process-registry.v1",
      processes: [identity],
    });
    registry.unregister(process.pid);
  });

  it("kills one exact registered process group", async () => {
    const dir = await makeTempDir("pi-server-registry-one");
    const registry = new ServerProcessRegistry(dir);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    expect(child.pid).toBeTypeOf("number");
    registry.register(child.pid as number);
    const exited = once(child, "exit");
    expect(registry.kill(child.pid as number)).toBe(true);
    await exited;
    expect(registry.kill(child.pid as number)).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("killAll clears the registry and tolerates dead pids", async () => {
    const dir = await makeTempDir("pi-server-registry-kill");
    const registry = new ServerProcessRegistry(dir);
    expect(() => registry.register(424_250)).toThrow(/attest/);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    expect(child.pid).toBeTypeOf("number");
    registry.register(child.pid as number);
    const exited = once(child, "exit");
    registry.killAll();
    await exited;
    expect(registry.size).toBe(0);
    expect(JSON.parse(await fs.readFile(path.join(dir, "server.children.json"), "utf8"))).toEqual({
      schema: "pi-workflows.process-registry.v1",
      processes: [],
    });
  });
});
