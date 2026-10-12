import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PiAgentGroupError,
  type PiAgentLifecycleEvent,
  type PiAgentRequest,
} from "../src/builtins/pi-agent-launch.js";
import {
  CANCEL_SETTLE_MS,
  HeadlessPiAgentGroupLauncher,
  RESULT_IDLE_MS,
  type HeadlessPiAgentGroupSettings,
} from "../src/server/agent-group-launcher.js";
import type { HeadlessPiOptions } from "../src/server/headless-pi.js";
import { makeTempDir, waitUntil } from "./helpers.js";

const FAKE_PI = path.resolve("test/fixtures/fake-agent-group-pi.mjs");
const SETTLE_MS = 400;
const UNSETTLED_CANCEL = "cancelled: headless pi did not report that the session settled";
const UNFINISHED_RUN = "failed: headless pi stopped before the session finished";

function request(id: string): PiAgentRequest {
  return { id, role: `Role ${id}`, prompt: `Prompt ${id}`, cwd: "/repo", tools: ["read"] };
}

type Harness = {
  dir: string;
  logs: string;
  argvFile: string;
  commandsFile: string;
  registered: number[];
  unregistered: number[];
  options: HeadlessPiOptions;
  settings: HeadlessPiAgentGroupSettings;
  launcher(): HeadlessPiAgentGroupLauncher;
};

/** A launcher whose `pi` is the fake bridge child, started through the same launch options. */
async function harness(
  scenario: string,
  extra: Partial<HeadlessPiOptions> = {},
  env: Record<string, string> = {},
): Promise<Harness> {
  const dir = await makeTempDir("agent-group-launcher");
  const logs = path.join(dir, "logs");
  await fs.mkdir(logs);
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
  const options: HeadlessPiOptions = {
    cwd: dir,
    piBin,
    processGroup: "own",
    abortGraceMs: 300,
    env: {
      FAKE_AGENT_GROUP_SCENARIO: scenario,
      FAKE_PI_ARGV_FILE: argvFile,
      FAKE_PI_COMMANDS_FILE: commandsFile,
      FAKE_PI_MARKER: "launch-env",
      ...env,
    },
    piArgs: ["--model", "fixture/model"],
    registry: {
      register: (pid) => registered.push(pid),
      unregister: (pid) => unregistered.push(pid),
    },
    ...extra,
  };
  const settings: HeadlessPiAgentGroupSettings = {
    diagnosticsDirectory: logs,
    cancelSettleMs: SETTLE_MS,
    resultIdleMs: 500,
  };
  return {
    dir,
    logs,
    argvFile,
    commandsFile,
    registered,
    unregistered,
    options,
    settings,
    launcher: () => new HeadlessPiAgentGroupLauncher(options, settings),
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

/** The stderr log that an error names, which the launcher keeps after a failed run. */
async function namedStderrLog(error: unknown): Promise<string> {
  const match = /complete pi stderr: (\S+pi-stderr\.log)/u.exec((error as Error).message);
  if (match?.[1] === undefined) throw new Error(`no stderr log in: ${(error as Error).message}`);
  return await fs.readFile(match[1], "utf8");
}

function states(events: PiAgentLifecycleEvent[]): string[] {
  return events.map((event) => `${event.id}:${event.state}:${event.phase}`);
}

describe("headless pi agent group launcher", () => {
  it("documents bounded waits longer than the runner's process stop grace", () => {
    expect(CANCEL_SETTLE_MS).toBe(10_000);
    expect(RESULT_IDLE_MS).toBe(5_000);
  });

  it("launches pi like a headless step and returns results after lifecycle facts", async () => {
    const setup = await harness("success");
    const seen: string[] = [];
    const results = await setup.launcher().run([request("a"), request("b")], {
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
    expect(groupGone(setup.registered[0])).toBe(true);
    // A successful group keeps no stderr log.
    expect(await fs.readdir(setup.logs)).toEqual([]);
  });

  it("ignores events for other groups and malformed marker lines", async () => {
    const setup = await harness("forged");
    const results = await setup.launcher().run([request("a")], {
      maxConcurrency: 1,
      signal: new AbortController().signal,
    });
    expect(results.map((result) => result.id)).toEqual(["a"]);
  });

  it("reads events after partial lines that other code wrote to stderr", async () => {
    const setup = await harness("noisy");
    const seen: string[] = [];
    const results = await setup.launcher().run([request("a")], {
      maxConcurrency: 1,
      signal: new AbortController().signal,
      onLifecycle: (event) => {
        seen.push(`${event.id}:${event.state}`);
      },
    });
    expect(results.map((result) => result.text)).toEqual(["result a"]);
    expect(seen).toEqual(["a:running", "a:running", "a:completed"]);
  });

  it("receives a large result split across many chunks after pi answers the prompt", async () => {
    const unit = "résumé ✓ 漢字 ";
    const setup = await harness(
      "large",
      {},
      {
        FAKE_AGENT_GROUP_TEXT: unit,
        FAKE_AGENT_GROUP_TEXT_REPEAT: "40000",
        // The whole transfer takes longer than the 500 ms result wait; each gap is shorter.
        FAKE_AGENT_GROUP_CHUNK_DELAY_MS: "5",
      },
    );
    const started = Date.now();
    const results = await setup.launcher().run([request("a")], {
      maxConcurrency: 1,
      signal: new AbortController().signal,
    });
    expect(Date.now() - started).toBeGreaterThan(500);
    expect(results).toHaveLength(1);
    expect(results[0]?.text).toBe(unit.repeat(40_000));
  }, 30_000);

  it("rebuilds agent errors and reports other failures by message", async () => {
    const agent = await harness("agent-error");
    const agentFailure = await agent
      .launcher()
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
      plain.launcher().run([request("a")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/^Invalid Pi agent id: !$/);
    // Errors that the bridge reports keep no stderr log.
    expect(await fs.readdir(plain.logs)).toEqual([]);
  });

  it("cancels through the bridge and forwards the settled lifecycle facts", async () => {
    const setup = await harness("hang");
    const abort = new AbortController();
    const seen: PiAgentLifecycleEvent[] = [];
    const started = Date.now();
    const error = await setup
      .launcher()
      .run([request("a"), request("b")], {
        maxConcurrency: 2,
        signal: abort.signal,
        onLifecycle: (event) => {
          seen.push(event);
          if (event.id === "b" && event.state === "running") abort.abort(new Error("stop now"));
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PiAgentGroupError);
    expect((error as Error).message).toBe("Pi agent group cancelled: stop now");
    expect(Date.now() - started).toBeLessThan(SETTLE_MS);
    expect(states(seen)).toEqual([
      "a:running:running",
      "b:running:running",
      "a:cancelled:cancelled",
      "b:cancelled:cancelled",
    ]);
    expect((await commands(setup.commandsFile)).map((command) => command.type)).toEqual([
      "run",
      "cancel",
    ]);
    await waitUntil(() => groupGone(setup.registered[0]), 5_000);
    expect(await fs.readdir(setup.logs)).toEqual([]);
  });

  it("ends every unsettled track before it stops a bridge that ignores cancellation", async () => {
    const setup = await harness("ignore-cancel");
    const abort = new AbortController();
    const seen: PiAgentLifecycleEvent[] = [];
    const started = Date.now();
    const error = await setup
      .launcher()
      .run([request("a"), request("b")], {
        maxConcurrency: 1,
        signal: abort.signal,
        onLifecycle: (event) => {
          seen.push(event);
          if (event.state === "running") abort.abort(new Error("give up"));
        },
      })
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toBe("Pi agent group cancelled: give up");
    expect(Date.now() - started).toBeGreaterThanOrEqual(SETTLE_MS);
    // The started session and the queued one both end, before the group settles.
    expect(states(seen)).toEqual([
      "a:running:running",
      `a:cancelled:${UNSETTLED_CANCEL}`,
      `b:cancelled:${UNSETTLED_CANCEL}`,
    ]);
    expect(seen[1]?.elapsedMs).toBeGreaterThanOrEqual(seen[0]?.elapsedMs ?? 0);
    expect(seen[2]).toMatchObject({ role: "Role b", elapsedMs: 0 });
    // The fake ignores SIGTERM, so the process group needs SIGKILL.
    await waitUntil(() => groupGone(setup.registered[0]), 5_000);
    expect(setup.unregistered).toEqual(setup.registered);
  });

  it("keeps the bridge's settled facts and ends only the sessions it did not confirm", async () => {
    const setup = await harness("partial-settle");
    const abort = new AbortController();
    const seen: PiAgentLifecycleEvent[] = [];
    await expect(
      setup.launcher().run([request("a"), request("b")], {
        maxConcurrency: 2,
        signal: abort.signal,
        onLifecycle: (event) => {
          seen.push(event);
          if (event.id === "b" && event.state === "running") abort.abort(new Error("stop"));
        },
      }),
    ).rejects.toThrow("Pi agent group cancelled: stop");
    expect(states(seen)).toEqual([
      "a:running:running",
      "b:running:running",
      "a:cancelled:cancelled",
      `b:cancelled:${UNSETTLED_CANCEL}`,
    ]);
  });

  it("ends started and queued tracks and keeps pi stderr when pi exits mid-group", async () => {
    const setup = await harness("exit-mid-run");
    const seen: PiAgentLifecycleEvent[] = [];
    const error = await setup
      .launcher()
      .run([request("a"), request("b")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        onLifecycle: (event) => {
          seen.push(event);
        },
      })
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toMatch(
      /^Pi agent group could not run: headless pi exited before the agent group finished \(code 5, signal null\)\. complete pi stderr: /u,
    );
    expect(states(seen)).toEqual([
      "a:running:running",
      `a:failed:${UNFINISHED_RUN}`,
      "b:cancelled:cancelled: headless pi stopped before the session finished",
    ]);
    expect(await namedStderrLog(error)).toContain("provider crashed\n");
  });

  it("does not start pi for a cancelled group or after the launcher closes", async () => {
    const setup = await harness("success");
    const launcher = setup.launcher();
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
      new HeadlessPiAgentGroupLauncher(setup.options, { bridgePath: null }).run([request("a")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/agent group bridge is missing from this installation/);
  });

  it("stops running groups when the launcher closes", async () => {
    const setup = await harness("hang");
    const launcher = setup.launcher();
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
      /headless pi exited before the agent group bridge loaded \(code 3, signal null\)/,
      "boom diagnostics\n",
    ],
    ["unrouted", /pi did not route the agent group command to its bridge \(disposition started\)/],
    ["rejected", /pi rejected the agent group command: Unknown command/],
    ["handled-without-result", /the agent group bridge returned without a result/],
  ])("fails clearly when %s", async (scenario, expected, stderr?: string) => {
    const setup = await harness(scenario);
    const error = await setup
      .launcher()
      .run([request("a")], { maxConcurrency: 1, signal: new AbortController().signal })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PiAgentGroupError);
    expect((error as Error).message).toMatch(/^Pi agent group could not run: /);
    expect((error as Error).message).toMatch(expected);
    expect((error as Error).message).toContain("same `pi` command");
    // The complete stderr stream stays in the named private log, not in the error.
    const log = await namedStderrLog(error);
    if (stderr !== undefined) {
      expect(log).toContain(stderr);
      expect((error as Error).message).not.toContain(stderr.trim());
    }
    const [directory] = await fs.readdir(setup.logs);
    expect((await fs.stat(path.join(setup.logs, directory ?? ""))).mode & 0o777).toBe(0o700);
    expect(
      (await fs.stat(path.join(setup.logs, directory ?? "", "pi-stderr.log"))).mode & 0o777,
    ).toBe(0o600);
    await waitUntil(() => groupGone(setup.registered[0]), 5_000);
  });

  it("fails clearly when pi cannot start", async () => {
    const setup = await harness("success");
    const missing = path.join(setup.dir, "missing-pi");
    await expect(
      new HeadlessPiAgentGroupLauncher({ ...setup.options, piBin: missing }, setup.settings).run(
        [request("a")],
        {
          maxConcurrency: 1,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow(
      new RegExp(`bridge loaded \\(spawn ${missing.replaceAll("/", "\\/")} ENOENT\\)`, "u"),
    );
  });

  it("names a log it could not create instead of failing the group", async () => {
    const setup = await harness("exit-before-ready");
    await expect(
      new HeadlessPiAgentGroupLauncher(setup.options, {
        ...setup.settings,
        diagnosticsDirectory: path.join(setup.dir, "missing-directory"),
      }).run([request("a")], { maxConcurrency: 1, signal: new AbortController().signal }),
    ).rejects.toThrow(/bridge loaded \(code 3, signal null\)\. pi stderr was not saved: ENOENT/u);
  });

  it("kills the child when the server refuses to supervise it", async () => {
    const setup = await harness("hang");
    let pid: number | undefined;
    await expect(
      new HeadlessPiAgentGroupLauncher(
        {
          ...setup.options,
          registry: {
            register: (value) => {
              pid = value;
              throw new Error("Runner process is not a direct child of the active runner");
            },
            unregister: () => undefined,
          },
        },
        setup.settings,
      ).run([request("a")], { maxConcurrency: 1, signal: new AbortController().signal }),
    ).rejects.toThrow("Runner process is not a direct child of the active runner");
    await waitUntil(() => groupGone(pid), 5_000);
    expect(await fs.readdir(setup.logs)).toEqual([]);
  });
});
