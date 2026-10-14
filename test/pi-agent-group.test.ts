import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createEphemeralCredentialStore,
  createEphemeralModelStore,
  runPiAgentGroup,
  type PiAgentSessionFactory,
} from "../src/builtins/pi-agent-group.js";
import {
  PiAgentGroupError,
  type PiAgentLifecycleEvent,
  type PiAgentRequest,
} from "../src/builtins/pi-agent-launch.js";
import { startMockOpenAiServer } from "./e2e/mock-openai.js";
import { makeTempDir } from "./helpers.js";

/**
 * Per-agent timeout for requests that do not test timeout behavior. A real SDK session loads
 * extensions and a model runtime, and its first model request loads the provider's API client,
 * which can take more than a second on a loaded machine. This bound only stops a session that
 * never settles: a hang still fails with a timeout error, after the runner has aborted and
 * disposed the session. Tests of timeout behavior set their own short `timeoutMs` on sessions
 * that never settle by themselves.
 */
const SESSION_HANG_MS = 30_000;
/** Vitest timeout for this file, long enough that the per-agent bound fires first. */
const TEST_TIMEOUT_MS = 3 * SESSION_HANG_MS;

function request(id: string): PiAgentRequest {
  return {
    id,
    role: `Role ${id}`,
    prompt: `Prompt ${id}`,
    cwd: process.cwd(),
    tools: ["read", "grep", "find", "ls"],
    timeoutMs: SESSION_HANG_MS,
  };
}

function message(text: string, stopReason = "stop", errorMessage?: string) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    },
  };
}

function fixtureExtension(name: string): string {
  return path.resolve(`test/fixtures/pi-agent-extensions/${name}.ts`);
}

async function writeNativeFixtureConfig(agentDir: string, extensions?: string[]): Promise<void> {
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "fixture-native",
      defaultModel: "fixture-model",
      defaultThinkingLevel: "high",
      extensions: extensions ?? [fixtureExtension("native-provider")],
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(agentDir, "models-store.json"),
    JSON.stringify({
      "fixture-native": {
        models: [
          {
            id: "fixture-model",
            name: "Fixture model",
            api: "fixture-api",
            provider: "fixture-native",
            baseUrl: "http://localhost:0",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 4_096,
          },
        ],
        checkedAt: 1,
      },
    }),
    "utf8",
  );
  await fs.writeFile(path.join(agentDir, "auth.json"), "{}\n", "utf8");
}

// A provider built into Pi with an OpenAI-compatible API. Tests point it at a local mock
// server through `models.json`, the way a user configures a proxy, so no request leaves the
// machine.
const BUILTIN_PROVIDER = "cerebras";
const BUILTIN_MODEL = "gpt-oss-120b";
const BUILTIN_PROVIDER_KEY = "builtin-provider-key";
const BUILTIN_PROVIDER_KEY_ENV = "CEREBRAS_API_KEY";

async function writeBuiltinProviderConfig(
  agentDir: string,
  baseUrl: string,
  options: { extensions?: string[]; auth?: boolean } = {},
): Promise<void> {
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: BUILTIN_PROVIDER,
      defaultModel: BUILTIN_MODEL,
      defaultThinkingLevel: "high",
      extensions: options.extensions ?? [],
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(agentDir, "models.json"),
    JSON.stringify({ providers: { [BUILTIN_PROVIDER]: { baseUrl } } }),
    "utf8",
  );
  await fs.writeFile(
    path.join(agentDir, "auth.json"),
    JSON.stringify(
      options.auth === false
        ? {}
        : { [BUILTIN_PROVIDER]: { type: "api_key", key: BUILTIN_PROVIDER_KEY } },
    ),
    "utf8",
  );
}

async function readAgentConfig(agentDir: string): Promise<string[]> {
  return await Promise.all(
    ["settings.json", "models.json", "auth.json"].map(
      async (name) => await fs.readFile(path.join(agentDir, name), "utf8"),
    ),
  );
}

function successfulFactory(
  delays: Record<string, number> = {},
  results: Record<string, string> = {},
  hooks: { active?: (value: number) => void; disposed?: (id: string) => void } = {},
): PiAgentSessionFactory {
  let active = 0;
  return async (agent) => {
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    return {
      model: { provider: "mock", id: "model" },
      thinkingLevel: "high",
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt(_prompt, options) {
        options?.preflightResult?.("started");
        active += 1;
        hooks.active?.(active);
        for (const listener of listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta" },
          });
          listener({ type: "tool_execution_start", toolName: "read", args: { secret: true } });
        }
        await new Promise((resolve) => setTimeout(resolve, delays[agent.id] ?? 0));
        for (const listener of listeners)
          listener(message(results[agent.id] ?? `result ${agent.id}`));
        active -= 1;
        hooks.active?.(active);
      },
      async abort() {},
      dispose() {
        hooks.disposed?.(agent.id);
      },
    };
  };
}

describe("Pi agent groups", { timeout: TEST_TIMEOUT_MS }, () => {
  it("validates requests and options before creating sessions", async () => {
    const signal = new AbortController().signal;
    await expect(runPiAgentGroup([], { maxConcurrency: 1, signal })).resolves.toEqual([]);
    await expect(
      runPiAgentGroup([{ ...request("bad id") }], { maxConcurrency: 1, signal }),
    ).rejects.toThrow(/Invalid Pi agent id/);
    await expect(
      runPiAgentGroup([request("same"), request("same")], { maxConcurrency: 1, signal }),
    ).rejects.toThrow(/Duplicate Pi agent id/);
    await expect(
      runPiAgentGroup([{ ...request("bad-tool"), tools: ["bash" as "read"] }], {
        maxConcurrency: 1,
        signal,
      }),
    ).rejects.toThrow(/unsupported tool/);
    await expect(
      runPiAgentGroup([{ ...request("large"), prompt: "x".repeat(96_001) }], {
        maxConcurrency: 1,
        signal,
      }),
    ).rejects.toThrow(/at most 96000/);
    await expect(runPiAgentGroup([request("one")], { maxConcurrency: 0, signal })).rejects.toThrow(
      /maxConcurrency/,
    );
    await expect(
      runPiAgentGroup([{ ...request("control"), role: "bad\u007frole" }], {
        maxConcurrency: 1,
        signal,
      }),
    ).rejects.toThrow(/control characters/);
    const reasonlessAbort = { aborted: true, reason: undefined } as AbortSignal;
    await expect(
      runPiAgentGroup([request("reasonless")], {
        maxConcurrency: 1,
        signal: reasonlessAbort,
      }),
    ).rejects.toThrow(/operation cancelled/);
  });

  it("returns final results in request order and emits safe lifecycle facts", async () => {
    const events: PiAgentLifecycleEvent[] = [];
    const disposed: string[] = [];
    let clock = 0;
    const results = await runPiAgentGroup([request("slow"), request("fast")], {
      maxConcurrency: 2,
      signal: new AbortController().signal,
      sessionFactory: successfulFactory(
        { slow: 20, fast: 1 },
        { slow: '{"answer":"slow"}', fast: '{"answer":"fast"}' },
        { disposed: (id) => disposed.push(id) },
      ),
      onLifecycle: (event) => {
        events.push(event);
      },
      now: () => (clock += 300),
    });

    expect(results.map((result) => result.id)).toEqual(["slow", "fast"]);
    expect(results.map((result) => result.text)).toEqual([
      '{"answer":"slow"}',
      '{"answer":"fast"}',
    ]);
    expect(results.every((result) => result.model === "mock/model")).toBe(true);
    expect(disposed.sort()).toEqual(["fast", "slow"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "slow", state: "running", phase: "thinking" }),
        expect.objectContaining({ id: "slow", state: "completed", phase: "completed" }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain("Prompt slow");
  });

  it("enforces maximum concurrency", async () => {
    let maximum = 0;
    await runPiAgentGroup([request("a"), request("b"), request("c")], {
      maxConcurrency: 2,
      signal: new AbortController().signal,
      sessionFactory: successfulFactory(
        { a: 10, b: 10, c: 10 },
        {},
        { active: (value) => (maximum = Math.max(maximum, value)) },
      ),
    });
    expect(maximum).toBe(2);
  });

  it("fails on a provider error, keeps its text private, and disposes the session", async () => {
    const providerText = `PRIVATE_PROVIDER_ERROR ${"p".repeat(6_000)} END`;
    let disposed = false;
    const factory: PiAgentSessionFactory = async () => {
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      return {
        model: { provider: "mock", id: "model" },
        thinkingLevel: "off",
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt(_prompt, options) {
          options?.preflightResult?.("started");
          for (const listener of listeners) listener(message("", "error", providerText));
        },
        async abort() {},
        dispose() {
          disposed = true;
        },
      };
    };
    const error = await runPiAgentGroup([request("provider")], {
      maxConcurrency: 1,
      signal: new AbortController().signal,
      sessionFactory: factory,
    }).catch((caught: unknown) => caught);
    // The provider's text can quote the prompt or credentials, so only the detail holds it.
    expect(error).toBeInstanceOf(PiAgentGroupError);
    expect(error).toMatchObject({
      message: "Pi agent provider stopped with error: the provider reported an error",
      detail: providerText,
    });
    expect(disposed).toBe(true);
  });

  it("bounds final output", async () => {
    await expect(
      runPiAgentGroup([request("large")], {
        maxConcurrency: 1,
        maxFinalChars: 10,
        signal: new AbortController().signal,
        sessionFactory: successfulFactory({}, { large: "x".repeat(11) }),
      }),
    ).rejects.toThrow(/final output is too large/);
  });

  it("times out, aborts, and disposes a running session", async () => {
    let release: (() => void) | undefined;
    let aborted = false;
    let disposed = false;
    const factory: PiAgentSessionFactory = async () => ({
      model: { provider: "mock", id: "model" },
      thinkingLevel: "off",
      subscribe: () => () => {},
      async prompt(_prompt, options) {
        options?.preflightResult?.("started");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      async abort() {
        aborted = true;
        release?.();
      },
      dispose() {
        disposed = true;
      },
    });
    await expect(
      runPiAgentGroup([{ ...request("slow"), timeoutMs: 20 }], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: factory,
      }),
    ).rejects.toThrow(/timed out/);
    expect(aborted).toBe(true);
    expect(disposed).toBe(true);
  });

  it("preserves parent cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop now"));
    await expect(
      runPiAgentGroup([request("cancel")], {
        maxConcurrency: 1,
        signal: controller.signal,
        sessionFactory: successfulFactory(),
      }),
    ).rejects.toMatchObject({ code: "cancelled" } satisfies Partial<PiAgentGroupError>);
  });

  it("cancels queued work after the first material failure", async () => {
    const created: string[] = [];
    const events: PiAgentLifecycleEvent[] = [];
    const factory: PiAgentSessionFactory = async (agent) => {
      created.push(agent.id);
      return {
        model: { provider: "mock", id: "model" },
        thinkingLevel: "off",
        subscribe: () => () => {},
        async prompt() {
          throw new Error("first failed");
        },
        async abort() {},
        dispose() {},
      };
    };
    await expect(
      runPiAgentGroup([request("first"), request("queued")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: factory,
        onLifecycle: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toMatchObject({ agentId: "first", detail: "first failed" });
    expect(created).toEqual(["first"]);
    expect(events).toContainEqual(
      expect.objectContaining({ id: "queued", state: "cancelled", phase: "cancelled" }),
    );
    await expect(
      runPiAgentGroup([request("first-no-progress"), request("queued-no-progress")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: factory,
      }),
    ).rejects.toMatchObject({ agentId: "first-no-progress", detail: "first failed" });
  });

  it("rejects duplicate tools and invalid limits", async () => {
    const signal = new AbortController().signal;
    await expect(
      runPiAgentGroup([{ ...request("tools"), tools: ["read", "read"] }], {
        maxConcurrency: 1,
        signal,
      }),
    ).rejects.toThrow(/duplicate tool/);
    await expect(
      runPiAgentGroup([{ ...request("timeout"), timeoutMs: 0 }], {
        maxConcurrency: 1,
        signal,
      }),
    ).rejects.toThrow(/timeoutMs/);
    await expect(
      runPiAgentGroup([request("output")], {
        maxConcurrency: 1,
        maxFinalChars: 0,
        signal,
      }),
    ).rejects.toThrow(/maxFinalChars/);
  });

  it("rejects unsafe request fields and oversized groups", async () => {
    const signal = new AbortController().signal;
    await expect(
      runPiAgentGroup(
        Array.from({ length: 9 }, (_, index) => request(`agent-${index}`)),
        {
          maxConcurrency: 1,
          signal,
        },
      ),
    ).rejects.toThrow(/at most 8/);
    await expect(
      runPiAgentGroup([{ ...request("role"), role: "" }], { maxConcurrency: 1, signal }),
    ).rejects.toThrow(/role/);
    await expect(
      runPiAgentGroup([{ ...request("role-control"), role: "bad\nrole" }], {
        maxConcurrency: 1,
        signal,
      }),
    ).rejects.toThrow(/control characters/);
    await expect(
      runPiAgentGroup([{ ...request("cwd"), cwd: "" }], { maxConcurrency: 1, signal }),
    ).rejects.toThrow(/cwd/);
    await expect(
      runPiAgentGroup([{ ...request("no-tools"), tools: [] }], { maxConcurrency: 1, signal }),
    ).rejects.toThrow(/at least one tool/);
    await expect(
      runPiAgentGroup(
        [
          {
            ...request("provider"),
            model: { provider: "", id: "model" },
            thinkingLevel: "high",
          },
        ],
        {
          maxConcurrency: 1,
          signal,
        },
      ),
    ).rejects.toThrow(/model provider/);
    await expect(
      runPiAgentGroup(
        [
          {
            ...request("model-id"),
            model: { provider: "mock", id: "" },
            thinkingLevel: "high",
          },
        ],
        {
          maxConcurrency: 1,
          signal,
        },
      ),
    ).rejects.toThrow(/model id/);
  });

  it("reports prompt rejection and missing final output", async () => {
    // Pi reports no disposition for a rejected prompt, and an extension can
    // handle a prompt or Pi can queue it without running the model.
    for (const disposition of [undefined, "handled", "queued"] as const) {
      const rejected: PiAgentSessionFactory = async () => ({
        model: { provider: "mock", id: "model" },
        thinkingLevel: "off",
        subscribe: () => () => {},
        async prompt(_prompt, options) {
          if (disposition !== undefined) options?.preflightResult?.(disposition);
        },
        async abort() {},
        dispose() {},
      });
      await expect(
        runPiAgentGroup([request("rejected")], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          sessionFactory: rejected,
        }),
      ).rejects.toThrow(
        disposition === undefined
          ? /rejected prompt: prompt preflight failed/
          : new RegExp(`rejected prompt: Pi ${disposition} the prompt`),
      );
    }

    const missing: PiAgentSessionFactory = async () => ({
      model: { provider: "mock", id: "model" },
      thinkingLevel: "off",
      subscribe: () => () => {},
      async prompt(_prompt, options) {
        options?.preflightResult?.("started");
      },
      async abort() {},
      dispose() {},
    });
    await expect(
      runPiAgentGroup([request("missing")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: missing,
      }),
    ).rejects.toThrow(/no final output/);
  });

  it("accepts string content and ignores lifecycle callback failures", async () => {
    const factory: PiAgentSessionFactory = async () => {
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      return {
        model: { provider: "mock", id: "model" },
        thinkingLevel: "medium",
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt(_prompt, options) {
          options?.preflightResult?.("started");
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: { role: "assistant", content: '{"ok":true}', stopReason: "stop" },
            });
          }
        },
        async abort() {},
        dispose() {},
      };
    };
    const [result] = await runPiAgentGroup([request("string")], {
      maxConcurrency: 1,
      signal: new AbortController().signal,
      sessionFactory: factory,
      onLifecycle: () => {
        throw new Error("display failed");
      },
    });
    expect(result?.text).toBe('{"ok":true}');
    expect(result?.thinkingLevel).toBe("medium");
  });

  it("uses the latest assistant text and ignores unknown tool phases", async () => {
    const events: PiAgentLifecycleEvent[] = [];
    let clock = 0;
    const factory: PiAgentSessionFactory = async () => {
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      return {
        model: { provider: "mock", id: "model" },
        thinkingLevel: "off",
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt(_prompt, options) {
          options?.preflightResult?.("started");
          for (const listener of listeners) {
            listener({ type: "tool_execution_start", toolName: "bash" });
            listener(message("old failure", "error", "old"));
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  { type: "thinking", text: "private" },
                  { type: "text", text: "final" },
                ],
                stopReason: "stop",
              },
            });
          }
        },
        async abort() {},
        dispose() {},
      };
    };
    const [result] = await runPiAgentGroup([request("latest")], {
      maxConcurrency: 1,
      signal: new AbortController().signal,
      sessionFactory: factory,
      now: () => (clock += 300),
      onLifecycle: (event) => {
        events.push(event);
      },
    });
    expect(result?.text).toBe("final");
    expect(events.map((event) => event.phase)).not.toContain("tool: bash");
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("handles ignored messages, empty output, and provider aborts", async () => {
    const makeFactory =
      (events: Record<string, unknown>[]): PiAgentSessionFactory =>
      async () => {
        const listeners = new Set<(event: Record<string, unknown>) => void>();
        return {
          model: { provider: "mock", id: "model" },
          thinkingLevel: "off",
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async prompt(_prompt, options) {
            options?.preflightResult?.("started");
            for (const event of events) for (const listener of listeners) listener(event);
          },
          async abort() {},
          dispose() {},
        };
      };
    await expect(
      runPiAgentGroup([request("empty")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: makeFactory([
          { type: "message_update", assistantMessageEvent: { type: "text_delta" } },
          { type: "message_end", message: { role: "user", content: "ignored" } },
          message("   "),
        ]),
      }),
    ).rejects.toThrow(/assistant text is empty/);
    await expect(
      runPiAgentGroup([request("aborted")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: makeFactory([message("", "aborted")]),
      }),
    ).rejects.toThrow(/provider stopped/);
    await expect(
      runPiAgentGroup([request("non-text")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: makeFactory([
          {
            type: "message_end",
            message: { role: "assistant", content: 42, stopReason: "stop" },
          },
        ]),
      }),
    ).rejects.toThrow(/assistant text is empty/);
  });

  it("reports a failed abort as a fact and keeps the abort's text private", async () => {
    let release: (() => void) | undefined;
    const factory: PiAgentSessionFactory = async () => ({
      model: { provider: "mock", id: "model" },
      thinkingLevel: "off",
      subscribe: () => () => {},
      async prompt() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      async abort() {
        release?.();
        throw new Error("PRIVATE_ABORT_FAILURE");
      },
      dispose() {},
    });
    await expect(
      runPiAgentGroup([{ ...request("abort-diagnostic"), timeoutMs: 5 }], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: factory,
      }),
    ).rejects.toMatchObject({
      message: "Pi agent abort-diagnostic timed out: after 5ms; the session abort failed",
      detail: "PRIVATE_ABORT_FAILURE",
    });
  });

  it("keeps the complete text of unexpected errors out of the message", async () => {
    const blank: PiAgentSessionFactory = async () => {
      throw "";
    };
    await expect(
      runPiAgentGroup([request("blank")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: blank,
      }),
    ).rejects.toMatchObject({
      message: "Pi agent blank failed: the session raised an error",
      detail: "",
    });

    // A thrown SDK error keeps every character, but only in the private detail.
    const sdkText = `PRIVATE_SDK_ERROR ${"x".repeat(5_000)} END`;
    const verbose: PiAgentSessionFactory = async () => {
      throw new Error(sdkText);
    };
    await expect(
      runPiAgentGroup([request("verbose")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: verbose,
      }),
    ).rejects.toMatchObject({
      message: "Pi agent verbose failed: the session raised an error",
      detail: sdkText,
    });
  });

  it("reports missing models and cleanup failures", async () => {
    const noModel: PiAgentSessionFactory = async () => ({
      model: undefined,
      thinkingLevel: "off",
      subscribe: () => () => {},
      async prompt() {},
      async abort() {},
      dispose() {},
    });
    await expect(
      runPiAgentGroup([request("model")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: noModel,
      }),
    ).rejects.toMatchObject({ code: "failed", detail: "No usable Pi model is configured" });

    const cleanup: PiAgentSessionFactory = async () => {
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      return {
        model: { provider: "mock", id: "model" },
        thinkingLevel: "off",
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt(_prompt, options) {
          options?.preflightResult?.("started");
          for (const listener of listeners) listener(message("ok"));
        },
        async abort() {},
        dispose() {
          throw new Error("PRIVATE_DISPOSE_FAILURE");
        },
      };
    };
    await expect(
      runPiAgentGroup([request("cleanup")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: cleanup,
      }),
    ).rejects.toMatchObject({
      message: "Pi agent cleanup cleanup failed: the session could not be disposed",
      detail: "PRIVATE_DISPOSE_FAILURE",
    });

    const primary: PiAgentSessionFactory = async () => ({
      model: { provider: "mock", id: "model" },
      thinkingLevel: "off",
      subscribe: () => () => {},
      async prompt() {
        throw new Error("prompt failed first");
      },
      async abort() {},
      dispose() {
        throw new Error("cleanup failed second");
      },
    });
    await expect(
      runPiAgentGroup([request("primary")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: primary,
      }),
    ).rejects.toMatchObject({ code: "failed", detail: "prompt failed first" });
  });

  it("cancels a session while its prompt is running", async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    let aborted = false;
    const factory: PiAgentSessionFactory = async () => ({
      model: { provider: "mock", id: "model" },
      thinkingLevel: "off",
      subscribe: () => () => {},
      async prompt() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      async abort() {
        aborted = true;
        release?.();
      },
      dispose() {},
    });
    const running = runPiAgentGroup([request("cancel-running")], {
      maxConcurrency: 1,
      signal: controller.signal,
      sessionFactory: factory,
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(new Error("cancel running"));
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(aborted).toBe(true);
  });

  it("normalizes timeout and cancellation failures during session creation", async () => {
    const timedOutFactory: PiAgentSessionFactory = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw "late creation failure";
    };
    await expect(
      runPiAgentGroup([{ ...request("late-timeout"), timeoutMs: 1 }], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: timedOutFactory,
      }),
    ).rejects.toMatchObject({ code: "timed out" });

    const controller = new AbortController();
    const cancelledFactory: PiAgentSessionFactory = async () => {
      controller.abort(new Error("cancel during creation"));
      throw "creation stopped";
    };
    await expect(
      runPiAgentGroup([request("creation-cancel")], {
        maxConcurrency: 1,
        signal: controller.signal,
        sessionFactory: cancelledFactory,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("cancels before creating a session when the run clock aborts", async () => {
    const controller = new AbortController();
    let created = false;
    await expect(
      runPiAgentGroup([request("clock-cancel")], {
        maxConcurrency: 1,
        signal: controller.signal,
        sessionFactory: async () => {
          created = true;
          return await successfulFactory()!(request("clock-cancel"), {
            signal: controller.signal,
          });
        },
        now: () => {
          controller.abort(new Error("clock cancelled"));
          return 0;
        },
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(created).toBe(false);
  });

  it("does not prompt when a session times out during creation", async () => {
    let prompted = false;
    let aborted = false;
    const factory: PiAgentSessionFactory = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        model: { provider: "mock", id: "model" },
        thinkingLevel: "off",
        subscribe: () => () => {},
        async prompt() {
          prompted = true;
        },
        async abort() {
          aborted = true;
        },
        dispose() {},
      };
    };
    await expect(
      runPiAgentGroup([{ ...request("creation"), timeoutMs: 5 }], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: factory,
      }),
    ).rejects.toThrow(/timed out/);
    expect(prompted).toBe(false);
    expect(aborted).toBe(true);
  });

  it("bounds repeated lifecycle phase updates", async () => {
    let updates = 0;
    let clock = 0;
    const factory: PiAgentSessionFactory = async () => {
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      return {
        model: { provider: "mock", id: "model" },
        thinkingLevel: "high",
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt(_prompt, options) {
          options?.preflightResult?.("started");
          for (let index = 0; index < 100; index += 1) {
            for (const listener of listeners) {
              listener({
                type: "tool_execution_start",
                toolName: index % 2 === 0 ? "read" : "grep",
              });
            }
          }
          for (const listener of listeners) listener(message("ok"));
        },
        async abort() {},
        dispose() {},
      };
    };
    const phaseRequest = request("phases");
    delete phaseRequest.timeoutMs;
    await runPiAgentGroup([phaseRequest], {
      maxConcurrency: 1,
      signal: new AbortController().signal,
      sessionFactory: factory,
      now: () => (clock += 300),
      onLifecycle: () => {
        updates += 1;
      },
    });
    expect(updates).toBeLessThanOrEqual(68);
  });

  it("keeps credential and model refresh state in memory", async () => {
    const agentDir = await makeTempDir("pi-agent-group-credentials");
    await fs.writeFile(
      path.join(agentDir, "auth.json"),
      JSON.stringify({
        api: { type: "api_key", key: "test-key" },
        command: { type: "api_key" },
        oauth: { type: "oauth", refresh: "test-refresh", access: "test-access", expires: 1 },
      }),
      "utf8",
    );
    const catalogText = JSON.stringify({
      cached: { models: [], checkedAt: 1, etag: '"catalog"' },
    });
    await fs.writeFile(path.join(agentDir, "models-store.json"), catalogText, "utf8");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const controller = new AbortController();
      const credentials = await createEphemeralCredentialStore(controller.signal);
      expect(await credentials.list()).toEqual([
        { providerId: "api", type: "api_key" },
        { providerId: "command", type: "api_key" },
        { providerId: "oauth", type: "oauth" },
      ]);
      const firstRead = await credentials.read("api");
      expect(firstRead).toEqual({ type: "api_key", key: "test-key" });
      if (firstRead?.type === "api_key") firstRead.key = "changed-only-in-copy";
      expect(await credentials.read("api")).toEqual({ type: "api_key", key: "test-key" });

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const failed = credentials.modify("api", async () => {
        await gate;
        throw new Error("refresh failed");
      });
      const recovered = credentials.modify("api", async (current) => ({
        ...(current ?? { type: "api_key" as const }),
        key: "refreshed-in-memory",
      }));
      release();
      await expect(failed).rejects.toThrow("refresh failed");
      await expect(recovered).resolves.toEqual({
        type: "api_key",
        key: "refreshed-in-memory",
      });
      await expect(credentials.modify("api", async () => undefined)).resolves.toEqual({
        type: "api_key",
        key: "refreshed-in-memory",
      });
      await credentials.delete("api");
      expect(await credentials.read("api")).toBeUndefined();

      const models = await createEphemeralModelStore(controller.signal);
      const cached = await models.read("cached");
      expect(cached).toEqual({ models: [], checkedAt: 1, etag: '"catalog"' });
      if (cached !== undefined) cached.checkedAt = 2;
      expect(await models.read("cached")).toEqual({
        models: [],
        checkedAt: 1,
        etag: '"catalog"',
      });
      await models.write("mock", { models: [], checkedAt: 1 });
      expect(await models.read("mock")).toEqual({ models: [], checkedAt: 1 });
      await models.delete("mock");
      expect(await models.read("mock")).toBeUndefined();
      expect(await fs.readFile(path.join(agentDir, "models-store.json"), "utf8")).toBe(catalogText);

      controller.abort(new Error("stop"));
      await expect(credentials.read("oauth")).rejects.toThrow("stop");
      await expect(credentials.list()).rejects.toThrow("stop");
      await expect(credentials.modify("oauth", async (value) => value)).rejects.toThrow("stop");
      await expect(credentials.delete("oauth")).rejects.toThrow("stop");
      await expect(models.read("cached")).rejects.toThrow("stop");
      await expect(models.write("mock", { models: [] })).rejects.toThrow("stop");
      await expect(models.delete("cached")).rejects.toThrow("stop");
      expect(JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8"))).toEqual({
        api: { type: "api_key", key: "test-key" },
        command: { type: "api_key" },
        oauth: { type: "oauth", refresh: "test-refresh", access: "test-access", expires: 1 },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects malformed credential files without exposing their contents", async () => {
    const agentDir = await makeTempDir("pi-agent-group-invalid-credentials");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const invalidValues: unknown[] = [
      null,
      [],
      "PRIVATE_CREDENTIAL_TEXT",
      { bad: null },
      { bad: [] },
      { bad: { type: "api_key", key: 1 } },
      { bad: { type: "oauth" } },
      { bad: { type: "oauth", refresh: "r" } },
      { bad: { type: "oauth", refresh: "r", access: "a" } },
      { bad: { type: "oauth", refresh: "r", access: "a", expires: "later" } },
    ];
    try {
      for (const invalid of invalidValues) {
        await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify(invalid), "utf8");
        await expect(createEphemeralCredentialStore(new AbortController().signal)).rejects.toThrow(
          "Could not load Pi credentials for isolated agents",
        );
      }
      await fs.writeFile(path.join(agentDir, "auth.json"), "PRIVATE_NOT_JSON", "utf8");
      let message = "";
      try {
        await createEphemeralCredentialStore(new AbortController().signal);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("Could not load Pi credentials for isolated agents");
      expect(message).not.toContain("PRIVATE_NOT_JSON");
      await fs.rm(path.join(agentDir, "auth.json"));
      await expect(
        createEphemeralCredentialStore(new AbortController().signal),
      ).resolves.toBeDefined();
      const cancelled = new AbortController();
      cancelled.abort(new Error("cancelled before load"));
      await expect(createEphemeralCredentialStore(cancelled.signal)).rejects.toThrow(
        "cancelled before load",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects malformed model catalogs without exposing their contents", async () => {
    const agentDir = await makeTempDir("pi-agent-group-invalid-models");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const invalidValues: unknown[] = [
      null,
      [],
      "PRIVATE_MODEL_CATALOG_TEXT",
      { bad: null },
      { bad: { models: null } },
      { bad: { models: [], checkedAt: "later" } },
      { bad: { models: [], lastModified: "later" } },
      { bad: { models: [], etag: 1 } },
    ];
    try {
      for (const invalid of invalidValues) {
        await fs.writeFile(
          path.join(agentDir, "models-store.json"),
          JSON.stringify(invalid),
          "utf8",
        );
        await expect(createEphemeralModelStore(new AbortController().signal)).rejects.toThrow(
          "Could not load Pi model catalog for isolated agents",
        );
      }
      await fs.writeFile(path.join(agentDir, "models-store.json"), "PRIVATE_NOT_JSON", "utf8");
      let message = "";
      try {
        await createEphemeralModelStore(new AbortController().signal);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("Could not load Pi model catalog for isolated agents");
      expect(message).not.toContain("PRIVATE_NOT_JSON");
      await fs.rm(path.join(agentDir, "models-store.json"));
      await expect(createEphemeralModelStore(new AbortController().signal)).resolves.toBeDefined();
      const cancelled = new AbortController();
      cancelled.abort(new Error("cancelled before model load"));
      await expect(createEphemeralModelStore(cancelled.signal)).rejects.toThrow(
        "cancelled before model load",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("runs provider extensions through isolated per-agent SDK runtimes", async () => {
    const agentDir = await makeTempDir("pi-agent-group-agent");
    const cwd = await makeTempDir("pi-agent-group-project");
    const lifecycleFile = path.join(agentDir, "lifecycle.log");
    const providerExtension = path.resolve("test/fixtures/pi-agent-extensions/native-provider.ts");
    await fs.writeFile(path.join(cwd, "AGENTS.md"), "PRIVATE_CONTEXT_MARKER", "utf8");
    await writeNativeFixtureConfig(agentDir, [providerExtension]);
    const settingsBefore = await fs.readFile(path.join(agentDir, "settings.json"), "utf8");
    const modelsStoreBefore = await fs.readFile(path.join(agentDir, "models-store.json"), "utf8");
    const authBefore = await fs.readFile(path.join(agentDir, "auth.json"), "utf8");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv("PI_AGENT_FIXTURE_API_KEY", "provider-owned-key");
    vi.stubEnv("PI_AGENT_FIXTURE_LIFECYCLE_FILE", lifecycleFile);
    try {
      const results = await runPiAgentGroup(
        [
          { ...request("sdk-a"), cwd, tools: ["read"] },
          { ...request("sdk-b"), cwd, tools: ["read"] },
        ],
        { maxConcurrency: 2, signal: new AbortController().signal },
      );
      expect(results).toEqual([
        expect.objectContaining({
          id: "sdk-a",
          text: '{"answer":"ok"}',
          model: "fixture-native/fixture-model",
          thinkingLevel: "high",
        }),
        expect.objectContaining({
          id: "sdk-b",
          text: '{"answer":"ok"}',
          model: "fixture-native/fixture-model",
          thinkingLevel: "high",
        }),
      ]);
      expect((await fs.readFile(lifecycleFile, "utf8")).trim().split("\n").toSorted()).toEqual([
        "session_shutdown",
        "session_shutdown",
        "session_shutdown",
        "session_start",
        "session_start",
      ]);
      await expect(fs.stat(path.join(agentDir, "sessions"))).rejects.toThrow();
      expect(await fs.readFile(path.join(agentDir, "settings.json"), "utf8")).toBe(settingsBefore);
      expect(await fs.readFile(path.join(agentDir, "models-store.json"), "utf8")).toBe(
        modelsStoreBefore,
      );
      expect(await fs.readFile(path.join(agentDir, "auth.json"), "utf8")).toBe(authBefore);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("admits explicit behavior extensions without activating their tools", async () => {
    const agentDir = await makeTempDir("pi-agent-group-behavior");
    const cwd = await makeTempDir("pi-agent-group-behavior-project");
    await writeNativeFixtureConfig(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    try {
      await expect(
        runPiAgentGroup([{ ...request("behavior"), cwd, tools: ["read"] }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          behaviorExtensionPaths: [fixtureExtension("behavior")],
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          model: "fixture-native/fixture-model",
          text: '{"answer":"ok"}',
        }),
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails before prompting when provider-owned authentication is unavailable", async () => {
    const agentDir = await makeTempDir("pi-agent-group-missing-auth");
    const cwd = await makeTempDir("pi-agent-group-missing-auth-project");
    await writeNativeFixtureConfig(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv("PI_AGENT_FIXTURE_DISABLE_AUTH", "1");
    try {
      await expect(
        runPiAgentGroup([{ ...request("missing-auth"), cwd, tools: ["read"] }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/has no provider authentication/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails with an unknown provider or model", async () => {
    const agentDir = await makeTempDir("pi-agent-group-exact-dispatch");
    const cwd = await makeTempDir("pi-agent-group-exact-project");
    await writeNativeFixtureConfig(agentDir, []);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    try {
      await expect(
        runPiAgentGroup([{ ...request("missing-provider"), cwd }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("Pi agent group has unknown provider: fixture-native");
      // An extension that registers another provider does not make this one known.
      await writeNativeFixtureConfig(agentDir, [fixtureExtension("legacy-provider")]);
      await expect(
        runPiAgentGroup([{ ...request("other-provider"), cwd }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("Pi agent group has unknown provider: fixture-native");
      await writeNativeFixtureConfig(agentDir);
      await expect(
        runPiAgentGroup(
          [
            {
              ...request("missing-model"),
              cwd,
              model: { provider: "fixture-native", id: "missing" },
              thinkingLevel: "high",
            },
          ],
          { maxConcurrency: 1, signal: new AbortController().signal },
        ),
      ).rejects.toThrow("Pi agent missing-model has no model: fixture-native/missing");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("runs a provider built into Pi without a cached model catalog, online and offline", async () => {
    const mock = await startMockOpenAiServer(() => ({
      kind: "text",
      text: '{"answer":"builtin"}',
    }));
    const agentDir = await makeTempDir("pi-agent-group-builtin");
    const cwd = await makeTempDir("pi-agent-group-builtin-project");
    const lifecycleFile = path.join(agentDir, "lifecycle.log");
    // A user extension that registers another provider is preflighted but not admitted.
    await writeBuiltinProviderConfig(agentDir, mock.baseUrl, {
      extensions: [fixtureExtension("native-provider")],
    });
    const configBefore = await readAgentConfig(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv(BUILTIN_PROVIDER_KEY_ENV, undefined);
    vi.stubEnv("PI_AGENT_FIXTURE_LIFECYCLE_FILE", lifecycleFile);
    try {
      for (const offline of [undefined, "1"]) {
        vi.stubEnv("PI_OFFLINE", offline);
        await expect(
          runPiAgentGroup([{ ...request("builtin"), cwd, tools: ["read"] }], {
            maxConcurrency: 1,
            signal: new AbortController().signal,
          }),
        ).resolves.toEqual([
          expect.objectContaining({
            model: `${BUILTIN_PROVIDER}/${BUILTIN_MODEL}`,
            thinkingLevel: "high",
            text: '{"answer":"builtin"}',
          }),
        ]);
      }
      // Each child used the stored credential through Pi's own provider resolution.
      expect(mock.authorizations).toEqual([
        `Bearer ${BUILTIN_PROVIDER_KEY}`,
        `Bearer ${BUILTIN_PROVIDER_KEY}`,
      ]);
      // Each group's preflight settled the extension, and no child session loaded it.
      expect((await fs.readFile(lifecycleFile, "utf8")).trim().split("\n")).toEqual([
        "session_shutdown",
        "session_shutdown",
      ]);
      await expect(fs.stat(path.join(agentDir, "models-store.json"))).rejects.toThrow();
      await expect(fs.stat(path.join(agentDir, "sessions"))).rejects.toThrow();
      expect(await readAgentConfig(agentDir)).toEqual(configBefore);
    } finally {
      vi.unstubAllEnvs();
      await mock.close();
    }
  });

  it("runs a built-in provider model that only the cached catalog knows while offline", async () => {
    const mock = await startMockOpenAiServer(() => ({
      kind: "text",
      text: '{"answer":"cached"}',
    }));
    const agentDir = await makeTempDir("pi-agent-group-builtin-cached");
    const cwd = await makeTempDir("pi-agent-group-builtin-cached-project");
    await writeBuiltinProviderConfig(agentDir, mock.baseUrl);
    const catalogText = JSON.stringify({
      [BUILTIN_PROVIDER]: {
        models: [
          {
            id: "fixture-cached-model",
            name: "Fixture cached model",
            api: "openai-completions",
            provider: BUILTIN_PROVIDER,
            baseUrl: "https://catalog.invalid/v1",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 4_096,
          },
        ],
        checkedAt: 1,
        // Pi applies a cached catalog only when it is newer than its bundled catalog.
        lastModified: Date.UTC(2100, 0, 1),
      },
    });
    await fs.writeFile(path.join(agentDir, "models-store.json"), catalogText, "utf8");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv(BUILTIN_PROVIDER_KEY_ENV, undefined);
    vi.stubEnv("PI_OFFLINE", "1");
    try {
      await expect(
        runPiAgentGroup(
          [
            {
              ...request("cached"),
              cwd,
              tools: ["read"],
              model: { provider: BUILTIN_PROVIDER, id: "fixture-cached-model" },
              thinkingLevel: "high",
            },
          ],
          { maxConcurrency: 1, signal: new AbortController().signal },
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          model: `${BUILTIN_PROVIDER}/fixture-cached-model`,
          text: '{"answer":"cached"}',
        }),
      ]);
      expect(mock.authorizations).toEqual([`Bearer ${BUILTIN_PROVIDER_KEY}`]);
      expect(await fs.readFile(path.join(agentDir, "models-store.json"), "utf8")).toBe(catalogText);
    } finally {
      vi.unstubAllEnvs();
      await mock.close();
    }
  });

  it("fails before prompting without built-in provider authentication or model", async () => {
    const mock = await startMockOpenAiServer(() => ({ kind: "text", text: "must not run" }));
    const agentDir = await makeTempDir("pi-agent-group-builtin-missing");
    const cwd = await makeTempDir("pi-agent-group-builtin-missing-project");
    await writeBuiltinProviderConfig(agentDir, mock.baseUrl, { auth: false });
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv(BUILTIN_PROVIDER_KEY_ENV, undefined);
    vi.stubEnv("PI_OFFLINE", "1");
    try {
      await expect(
        runPiAgentGroup([{ ...request("builtin-auth"), cwd, tools: ["read"] }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(
        `Pi agent builtin-auth has no provider authentication: ${BUILTIN_PROVIDER}`,
      );
      await writeBuiltinProviderConfig(agentDir, mock.baseUrl);
      await expect(
        runPiAgentGroup(
          [
            {
              ...request("builtin-model"),
              cwd,
              tools: ["read"],
              model: { provider: BUILTIN_PROVIDER, id: "missing-model" },
              thinkingLevel: "high",
            },
          ],
          { maxConcurrency: 1, signal: new AbortController().signal },
        ),
      ).rejects.toThrow(`Pi agent builtin-model has no model: ${BUILTIN_PROVIDER}/missing-model`);
      expect(mock.requests).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      await mock.close();
    }
  });

  it("gives each child only the dispatch provider's stored credential", async () => {
    const mock = await startMockOpenAiServer(() => ({ kind: "text", text: '{"answer":"probe"}' }));
    const agentDir = await makeTempDir("pi-agent-group-credential-scope");
    const cwd = await makeTempDir("pi-agent-group-credential-scope-project");
    const probeFile = path.join(agentDir, "credential-probe.log");
    await writeBuiltinProviderConfig(agentDir, mock.baseUrl);
    // Stored API keys for two other built-in providers, which Pi resolves from auth.json.
    await fs.writeFile(
      path.join(agentDir, "auth.json"),
      JSON.stringify({
        [BUILTIN_PROVIDER]: { type: "api_key", key: BUILTIN_PROVIDER_KEY },
        openai: { type: "api_key", key: "other-openai-key" },
        groq: { type: "api_key", key: "other-groq-key" },
      }),
      "utf8",
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv(BUILTIN_PROVIDER_KEY_ENV, undefined);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.stubEnv("GROQ_API_KEY", undefined);
    vi.stubEnv("PI_OFFLINE", "1");
    vi.stubEnv("PI_AGENT_CREDENTIAL_PROBE_FILE", probeFile);
    vi.stubEnv("PI_AGENT_CREDENTIAL_PROBE_PROVIDERS", `${BUILTIN_PROVIDER},openai,groq`);
    try {
      await expect(
        runPiAgentGroup([{ ...request("credential-scope"), cwd, tools: ["read"] }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          behaviorExtensionPaths: [fixtureExtension("credential-probe")],
        }),
      ).resolves.toEqual([expect.objectContaining({ text: '{"answer":"probe"}' })]);
      expect((await fs.readFile(probeFile, "utf8")).trim().split("\n")).toEqual([
        `${BUILTIN_PROVIDER}=present`,
        "openai=absent",
        "groq=absent",
      ]);
      expect(mock.authorizations).toEqual([`Bearer ${BUILTIN_PROVIDER_KEY}`]);
    } finally {
      vi.unstubAllEnvs();
      await mock.close();
    }
  });

  it("rejects a virtual model as the dispatch model before any request", async () => {
    const mock = await startMockOpenAiServer(() => ({ kind: "text", text: "must not run" }));
    const agentDir = await makeTempDir("pi-agent-group-virtual-model");
    const cwd = await makeTempDir("pi-agent-group-virtual-model-project");
    await writeBuiltinProviderConfig(agentDir, mock.baseUrl);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv(BUILTIN_PROVIDER_KEY_ENV, undefined);
    vi.stubEnv("PI_OFFLINE", "1");
    try {
      // The admitted extension lists `fixture-virtual` under the dispatch provider. Its router
      // would send requests to a physical model, so the dispatch is not exact.
      await expect(
        runPiAgentGroup(
          [
            {
              ...request("virtual"),
              cwd,
              tools: ["read"],
              model: { provider: BUILTIN_PROVIDER, id: "fixture-virtual" },
              thinkingLevel: "high",
            },
          ],
          {
            maxConcurrency: 1,
            signal: new AbortController().signal,
            behaviorExtensionPaths: [fixtureExtension("virtual-model")],
          },
        ),
      ).rejects.toThrow(`Pi agent virtual has no model: ${BUILTIN_PROVIDER}/fixture-virtual`);
      expect(mock.requests).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      await mock.close();
    }
  });

  it("runs an extension provider without a cached model catalog while offline", async () => {
    const agentDir = await makeTempDir("pi-agent-group-extension-offline");
    const cwd = await makeTempDir("pi-agent-group-extension-offline-project");
    await writeNativeFixtureConfig(agentDir);
    await fs.rm(path.join(agentDir, "models-store.json"));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
    try {
      await expect(
        runPiAgentGroup([{ ...request("extension-offline"), cwd, tools: ["read"] }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          model: "fixture-native/fixture-model",
          text: '{"answer":"ok"}',
        }),
      ]);
      await expect(fs.stat(path.join(agentDir, "models-store.json"))).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("discovers a legacy provider owner and uses its configured authentication", async () => {
    const mock = await startMockOpenAiServer(() => ({
      kind: "text",
      text: '{"answer":"legacy"}',
    }));
    const agentDir = await makeTempDir("pi-agent-group-legacy");
    const cwd = await makeTempDir("pi-agent-group-legacy-project");
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "fixture-legacy",
        defaultModel: "fixture-legacy-model",
        defaultThinkingLevel: "high",
        extensions: [fixtureExtension("legacy-provider")],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(agentDir, "models-store.json"),
      JSON.stringify({
        "fixture-legacy": {
          models: [
            {
              id: "fixture-legacy-model",
              name: "Fixture legacy model",
              api: "openai-completions",
              provider: "fixture-legacy",
              baseUrl: mock.baseUrl,
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
          checkedAt: 1,
        },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(agentDir, "auth.json"), "{}\n", "utf8");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv("PI_AGENT_FIXTURE_BASE_URL", mock.baseUrl);
    vi.stubEnv("PI_AGENT_FIXTURE_API_KEY", "legacy-provider-key");
    try {
      await expect(
        runPiAgentGroup([{ ...request("legacy"), cwd, tools: ["read"] }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          model: "fixture-legacy/fixture-legacy-model",
          text: '{"answer":"legacy"}',
        }),
      ]);
      expect(mock.requests).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      await mock.close();
    }
  });

  it("rejects a failed child provider registration instead of using a built-in fallback", async () => {
    const mock = await startMockOpenAiServer(() => ({ kind: "text", text: "must not run" }));
    const agentDir = await makeTempDir("pi-agent-group-invalid-registration");
    const cwd = await makeTempDir("pi-agent-group-invalid-registration-project");
    const shutdownFile = path.join(agentDir, "invalid-provider-shutdown.log");
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "openai",
        defaultModel: "fixture-openai-model",
        defaultThinkingLevel: "high",
        extensions: [fixtureExtension("invalid-openai-provider")],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(agentDir, "models-store.json"),
      JSON.stringify({
        openai: {
          models: [
            {
              id: "fixture-openai-model",
              name: "Fixture OpenAI model",
              api: "openai-responses",
              provider: "openai",
              baseUrl: mock.baseUrl,
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
          checkedAt: 1,
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(agentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "fixture-key" } }),
      "utf8",
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv("PI_AGENT_INVALID_PROVIDER_SHUTDOWN_FILE", shutdownFile);
    try {
      await expect(
        runPiAgentGroup([{ ...request("invalid-registration"), cwd, tools: ["read"] }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/could not register provider extension: registration failed/);
      expect(mock.requests).toHaveLength(0);
      expect((await fs.readFile(shutdownFile, "utf8")).trim().split("\n")).toEqual([
        "session_shutdown",
        "session_shutdown",
      ]);
    } finally {
      vi.unstubAllEnvs();
      await mock.close();
    }
  });

  it("surfaces child extension shutdown failures without private details", async () => {
    const agentDir = await makeTempDir("pi-agent-group-child-shutdown-failure");
    const cwd = await makeTempDir("pi-agent-group-child-shutdown-failure-project");
    await writeNativeFixtureConfig(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    try {
      let message = "";
      try {
        await runPiAgentGroup([{ ...request("child-shutdown-failure"), cwd, tools: ["read"] }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          behaviorExtensionPaths: [fixtureExtension("child-shutdown-failure")],
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("could not settle child extensions");
      expect(message).not.toContain("PRIVATE_CHILD_CLEANUP_FAILURE");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects workflow capabilities and built-in tool overrides", async () => {
    const agentDir = await makeTempDir("pi-agent-group-unsafe-extension");
    const cwd = await makeTempDir("pi-agent-group-unsafe-project");
    await writeNativeFixtureConfig(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    try {
      await expect(
        runPiAgentGroup([{ ...request("workflow-capability"), cwd }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          behaviorExtensionPaths: [fixtureExtension("workflow-capability")],
        }),
      ).rejects.toThrow(/exposes workflow control/);
      await expect(
        runPiAgentGroup([{ ...request("read-override"), cwd }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          behaviorExtensionPaths: [fixtureExtension("read-override")],
        }),
      ).rejects.toThrow(/replaces a built-in tool/);
      let cleanupMessage = "";
      try {
        await runPiAgentGroup([{ ...request("shutdown-failure"), cwd }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          behaviorExtensionPaths: [fixtureExtension("shutdown-failure")],
        });
      } catch (error) {
        cleanupMessage = error instanceof Error ? error.message : String(error);
      }
      expect(cleanupMessage).toContain("could not settle extension preflight");
      expect(cleanupMessage).not.toContain("PRIVATE_PRECHECK_CLEANUP_FAILURE");
      await expect(
        runPiAgentGroup([{ ...request("primary-before-cleanup"), cwd }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          behaviorExtensionPaths: [
            fixtureExtension("workflow-capability"),
            fixtureExtension("shutdown-failure"),
          ],
        }),
      ).rejects.toThrow(/exposes workflow control/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects incomplete, mixed, and slash-command dispatch requests", async () => {
    const signal = new AbortController().signal;
    await expect(
      runPiAgentGroup(
        [
          {
            ...request("partial"),
            model: { provider: "fixture-native", id: "fixture-model" },
          },
        ],
        { maxConcurrency: 1, signal, sessionFactory: successfulFactory() },
      ),
    ).rejects.toThrow(/model and thinkingLevel together/);
    await expect(
      runPiAgentGroup([{ ...request("slash"), prompt: "  /workflow status" }], {
        maxConcurrency: 1,
        signal,
        sessionFactory: successfulFactory(),
      }),
    ).rejects.toThrow(/must not invoke an extension command/);
    // The real SDK path reads settings before it compares dispatches, so it gets a temporary
    // agent directory instead of the user's.
    const agentDir = await makeTempDir("pi-agent-group-mixed-dispatch");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    try {
      await expect(
        runPiAgentGroup(
          [
            {
              ...request("first-dispatch"),
              model: { provider: "fixture-native", id: "fixture-model" },
              thinkingLevel: "high",
            },
            {
              ...request("second-dispatch"),
              model: { provider: "fixture-native", id: "other-model" },
              thinkingLevel: "high",
            },
          ],
          { maxConcurrency: 2, signal },
        ),
      ).rejects.toThrow(/one exact model dispatch/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("excludes Pi Workflows wrapper packages before their factories run", async () => {
    const agentDir = await makeTempDir("pi-agent-group-wrapper");
    const cwd = await makeTempDir("pi-agent-group-wrapper-project");
    const wrapper = path.join(agentDir, "wrapper");
    const marker = path.join(agentDir, "wrapper-loaded");
    await fs.mkdir(wrapper);
    await fs.writeFile(
      path.join(wrapper, "package.json"),
      JSON.stringify({
        name: "fixture-workflows-wrapper",
        type: "module",
        dependencies: { "@osolmaz/pi-workflows": "0.12.0" },
        pi: { extensions: ["./index.ts"] },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(wrapper, "index.ts"),
      `import fs from "node:fs"; export default function () { fs.writeFileSync(${JSON.stringify(marker)}, "loaded"); }`,
      "utf8",
    );
    await writeNativeFixtureConfig(agentDir, [
      fixtureExtension("native-provider"),
      path.join(wrapper, "index.ts"),
    ]);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    try {
      await expect(
        runPiAgentGroup([{ ...request("wrapper"), cwd, tools: ["read"] }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
        }),
      ).resolves.toHaveLength(1);
      await expect(fs.stat(marker)).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("continues remaining work when fail-fast is disabled", async () => {
    const created: string[] = [];
    const factory: PiAgentSessionFactory = async (agent) => {
      created.push(agent.id);
      if (agent.id === "bad") throw new Error("bad agent");
      return await successfulFactory()!(agent, {
        signal: new AbortController().signal,
      });
    };
    await expect(
      runPiAgentGroup([request("bad"), request("good")], {
        maxConcurrency: 1,
        failFast: false,
        signal: new AbortController().signal,
        sessionFactory: factory,
      }),
    ).rejects.toMatchObject({ agentId: "bad", detail: "bad agent" });
    expect(created).toEqual(["bad", "good"]);
  });
});
