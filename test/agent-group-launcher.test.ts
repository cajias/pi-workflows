import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PiAgentGroupError,
  type PiAgentLifecycleEvent,
  type PiAgentRequest,
} from "../src/builtins/pi-agent-launch.js";
import { HeadlessPiAgentGroupLauncher } from "../src/server/agent-group-launcher.js";
import type { HeadlessPiOptions } from "../src/server/headless-pi.js";
import { makeTempDir, waitUntil } from "./helpers.js";

const FAKE_PI = path.resolve("test/fixtures/fake-agent-group-pi.mjs");

function request(id: string): PiAgentRequest {
  return { id, role: `Role ${id}`, prompt: `Prompt ${id}`, cwd: "/repo", tools: ["read"] };
}

type Harness = {
  dir: string;
  argvFile: string;
  commandsFile: string;
  registered: number[];
  unregistered: number[];
  options: HeadlessPiOptions;
};

/** A launcher whose `pi` is the fake bridge child, started through the same launch options. */
async function harness(scenario: string, extra: Partial<HeadlessPiOptions> = {}): Promise<Harness> {
  const dir = await makeTempDir("agent-group-launcher");
  const piBin = path.join(dir, "pi");
  await fs.writeFile(
    piBin,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_PI)} "$@"\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  const registered: number[] = [];
  const unregistered: number[] = [];
  const argvFile = path.join(dir, "argv.json");
  const commandsFile = path.join(dir, "commands.jsonl");
  return {
    dir,
    argvFile,
    commandsFile,
    registered,
    unregistered,
    options: {
      cwd: dir,
      piBin,
      processGroup: "own",
      abortGraceMs: 300,
      env: {
        FAKE_AGENT_GROUP_SCENARIO: scenario,
        FAKE_PI_ARGV_FILE: argvFile,
        FAKE_PI_COMMANDS_FILE: commandsFile,
        FAKE_PI_MARKER: "launch-env",
      },
      piArgs: ["--model", "fixture/model"],
      registry: {
        register: (pid) => registered.push(pid),
        unregister: (pid) => unregistered.push(pid),
      },
      ...extra,
    },
  };
}

function groupGone(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(-pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function commands(file: string): Promise<Array<Record<string, unknown>>> {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("headless pi agent group launcher", () => {
  it("launches pi like a headless step and returns results after lifecycle facts", async () => {
    const setup = await harness("success");
    const launcher = new HeadlessPiAgentGroupLauncher(setup.options);
    const seen: string[] = [];
    const results = await launcher.run([request("a"), request("b")], {
      maxConcurrency: 2,
      failFast: false,
      maxFinalChars: 1_000,
      signal: new AbortController().signal,
      onLifecycle: async (event) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(`${event.id}:${event.state}`);
      },
    });
    seen.push("resolved");

    expect(results.map((result) => result.text)).toEqual(["result a", "result b"]);
    expect(seen).toEqual(["a:running", "b:running", "a:completed", "b:completed", "resolved"]);
    const launched = JSON.parse(await fs.readFile(setup.argvFile, "utf8")) as {
      argv: string[];
      env: string;
    };
    expect(launched.argv.slice(0, 5)).toEqual([
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "-e",
    ]);
    expect(path.basename(launched.argv[5] ?? "")).toMatch(/^agent-group-bridge\.(?:ts|js)$/);
    expect(launched.argv.slice(6)).toEqual(["--model", "fixture/model"]);
    expect(launched.env).toBe("launch-env");
    const [run] = await commands(setup.commandsFile);
    expect(run).toMatchObject({
      schema: "pi-workflows.agent-group-command.v1",
      type: "run",
      requests: [request("a"), request("b")],
      options: { maxConcurrency: 2, failFast: false, maxFinalChars: 1_000 },
    });
    expect(setup.registered).toHaveLength(1);
    expect(setup.unregistered).toEqual(setup.registered);
    await waitUntil(() => groupGone(setup.registered[0]), 5_000);
  });

  it("ignores events for other groups and malformed marker lines", async () => {
    const setup = await harness("forged");
    const results = await new HeadlessPiAgentGroupLauncher(setup.options).run([request("a")], {
      maxConcurrency: 1,
      signal: new AbortController().signal,
    });
    expect(results.map((result) => result.id)).toEqual(["a"]);
  });

  it("rebuilds agent errors and reports other failures by message", async () => {
    const agent = await harness("agent-error");
    const agentFailure = await new HeadlessPiAgentGroupLauncher(agent.options)
      .run([request("review")], { maxConcurrency: 1, signal: new AbortController().signal })
      .catch((error: unknown) => error);
    expect(agentFailure).toBeInstanceOf(PiAgentGroupError);
    expect(agentFailure).toMatchObject({
      agentId: "review",
      code: "timed out",
      message: "Pi agent review timed out: after 5ms",
    });

    const plain = await harness("plain-error");
    await expect(
      new HeadlessPiAgentGroupLauncher(plain.options).run([request("a")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/^Invalid Pi agent id: !$/);
  });

  it("cancels through the bridge and forwards its final lifecycle facts", async () => {
    const setup = await harness("hang");
    const abort = new AbortController();
    const seen: PiAgentLifecycleEvent[] = [];
    const error = await new HeadlessPiAgentGroupLauncher(setup.options)
      .run([request("review")], {
        maxConcurrency: 1,
        signal: abort.signal,
        onLifecycle: (event) => {
          seen.push(event);
          if (event.state === "running") abort.abort(new Error("stop now"));
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PiAgentGroupError);
    expect((error as Error).message).toBe("Pi agent group cancelled: stop now");
    expect(seen.map((event) => event.state)).toEqual(["running", "cancelled"]);
    expect((await commands(setup.commandsFile)).map((command) => command.type)).toEqual([
      "run",
      "cancel",
    ]);
    await waitUntil(() => groupGone(setup.registered[0]), 5_000);
  });

  it("stops a bridge that ignores cancellation after the grace period", async () => {
    const setup = await harness("ignore-cancel");
    const abort = new AbortController();
    const started = Date.now();
    await expect(
      new HeadlessPiAgentGroupLauncher(setup.options).run([request("review")], {
        maxConcurrency: 1,
        signal: abort.signal,
        onLifecycle: () => abort.abort(new Error("give up")),
      }),
    ).rejects.toThrow("Pi agent group cancelled: give up");
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    await waitUntil(() => groupGone(setup.registered[0]), 5_000);
    expect(setup.unregistered).toEqual(setup.registered);
  });

  it("does not start pi for a cancelled group or after the launcher closes", async () => {
    const setup = await harness("success");
    const launcher = new HeadlessPiAgentGroupLauncher(setup.options);
    const abort = new AbortController();
    abort.abort(new Error("already stopped"));
    await expect(
      launcher.run([request("a")], { maxConcurrency: 1, signal: abort.signal }),
    ).rejects.toThrow("Pi agent group cancelled: already stopped");
    await launcher.close();
    await expect(
      launcher.run([request("a")], { maxConcurrency: 1, signal: new AbortController().signal }),
    ).rejects.toThrow("Pi agent group could not run: the workflow runner is stopping");
    await expect(fs.access(setup.argvFile)).rejects.toThrow();
    expect(setup.registered).toEqual([]);

    await expect(
      new HeadlessPiAgentGroupLauncher(setup.options, null).run([request("a")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/agent group bridge is missing from this installation/);
  });

  it("stops running groups when the launcher closes", async () => {
    const setup = await harness("hang");
    const launcher = new HeadlessPiAgentGroupLauncher(setup.options);
    let running = false;
    const pending = launcher
      .run([request("review")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        onLifecycle: () => {
          running = true;
        },
      })
      .catch((error: unknown) => error);
    await waitUntil(() => running, 10_000);
    await launcher.close();
    const error = await pending;
    expect((error as Error).message).toMatch(
      /Pi agent group could not run: headless pi exited before the agent group finished/,
    );
    await waitUntil(() => groupGone(setup.registered[0]), 5_000);
  });

  it.each([
    [
      "exit-before-ready",
      /headless pi exited before the agent group bridge loaded \(code 3, signal null\).*pi stderr: boom diagnostics/s,
    ],
    [
      "exit-mid-run",
      /headless pi exited before the agent group finished \(code 5, signal null\).*pi stderr: provider crashed/s,
    ],
    ["unrouted", /pi did not route the agent group command to its bridge \(disposition started\)/],
    ["rejected", /pi rejected the agent group command: Unknown command/],
    ["handled-without-result", /the agent group bridge returned without a result/],
  ])("fails clearly when %s", async (scenario, expected) => {
    const setup = await harness(scenario);
    const error = await new HeadlessPiAgentGroupLauncher(setup.options)
      .run([request("a")], { maxConcurrency: 1, signal: new AbortController().signal })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PiAgentGroupError);
    expect((error as Error).message).toMatch(/^Pi agent group could not run: /);
    expect((error as Error).message).toMatch(expected);
    expect((error as Error).message).toContain("same `pi` command");
    await waitUntil(() => groupGone(setup.registered[0]), 5_000);
  });

  it("fails clearly when pi cannot start", async () => {
    const setup = await harness("success");
    const missing = path.join(setup.dir, "missing-pi");
    await expect(
      new HeadlessPiAgentGroupLauncher({ ...setup.options, piBin: missing }).run([request("a")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      new RegExp(`bridge loaded \\(spawn ${missing.replaceAll("/", "\\/")} ENOENT\\)`, "u"),
    );
  });

  it("kills the child when the server refuses to supervise it", async () => {
    const setup = await harness("hang");
    let pid: number | undefined;
    await expect(
      new HeadlessPiAgentGroupLauncher({
        ...setup.options,
        registry: {
          register: (value) => {
            pid = value;
            throw new Error("Runner process is not a direct child of the active runner");
          },
          unregister: () => undefined,
        },
      }).run([request("a")], { maxConcurrency: 1, signal: new AbortController().signal }),
    ).rejects.toThrow("Runner process is not a direct child of the active runner");
    await waitUntil(() => groupGone(pid), 5_000);
  });
});
