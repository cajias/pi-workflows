import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clientSocketPath } from "../src/client/protocol.js";
import { probeServerServing, readServerLock, serverLockPath } from "../src/server/lock.js";
import { processStartIdentity } from "../src/server/processes.js";
import { WorkflowServer } from "../src/server/server.js";
import { ServerStateStore } from "../src/server/state.js";
import { makeTempDir, waitUntil } from "./helpers.js";

const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const SERVER_ENTRY = fileURLToPath(new URL("../src/server/server-entry.ts", import.meta.url));
const CLAIM_GATE = fileURLToPath(new URL("./fixtures/server-claim-gate.mjs", import.meta.url));
/** The spawned server's default claim poll interval, `CLAIM_POLL_MS` in src/server/server.ts. */
const SERVER_CLAIM_POLL_MS = 2_000;
/** The live repro saw five replacement servers start during one `server stop`. */
const STARTERS = 5;
const STARTUP_TIMEOUT_MS = 30_000;
const EXIT_GRACE_MS = 10_000;

type Starter = {
  child: ChildProcess;
  pid: number;
  serverId: string;
  exited: Promise<number | null>;
  stderr: () => string;
};

/** One temporary state directory shared by every starter of a respawn storm. */
type Storm = {
  databasePath: string;
  gate: string;
  lockPath: string;
  socketPath: string;
  starters: Starter[];
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The process group already exited.
  }
}

async function createStorm(prefix: string): Promise<Storm> {
  const root = await makeTempDir(prefix);
  const databasePath = path.join(root, "state.sqlite");
  const gate = path.join(root, "claim-gate");
  fs.mkdirSync(gate);
  return {
    databasePath,
    gate,
    lockPath: serverLockPath(databasePath),
    socketPath: clientSocketPath(databasePath),
    starters: [],
  };
}

/** Spawn one real workflow server that pauses at its epoch claim until the test releases it. */
async function startGatedStarter(storm: Storm): Promise<Starter> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      TSX_LOADER,
      "--import",
      CLAIM_GATE,
      SERVER_ENTRY,
      "--database",
      storm.databasePath,
    ],
    {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PI_WORKFLOWS_TEST_CLAIM_GATE: storm.gate },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("the starter did not spawn");
  const reached = path.join(storm.gate, `${pid}.reached`);
  try {
    await waitUntil(() => fs.existsSync(reached) || hasExited(child), STARTUP_TIMEOUT_MS);
    if (!fs.existsSync(reached)) {
      throw new Error(`starter ${pid} exited before it reached its claim: ${stderr}`);
    }
  } catch (error) {
    // A starter that never reached its gate is not tracked, so stop it here.
    killGroup(pid, "SIGKILL");
    await exited;
    throw error;
  }
  return { child, pid, serverId: fs.readFileSync(reached, "utf8"), exited, stderr: () => stderr };
}

/** Each starter reaches its claim before the next one starts, as in a respawn storm. */
async function startStarters(storm: Storm): Promise<Starter[]> {
  for (let index = 0; index < STARTERS; index += 1) {
    storm.starters.push(await startGatedStarter(storm));
  }
  return storm.starters;
}

function releaseClaim(storm: Storm, starter: Starter): void {
  fs.writeFileSync(path.join(storm.gate, `${starter.pid}.release`), "");
}

/** Name each starter by role, so a failure shows which process the lock names. */
function describeStarters(storm: Storm, winner: Starter, expectation: string): string {
  const roles = storm.starters.map((starter, index) => {
    const role = starter === winner ? "winner" : "fenced";
    const state = hasExited(starter.child) ? "exited" : "running";
    return `starter ${index + 1} (${role}): pid ${starter.pid}, ${starter.serverId}, ${state}`;
  });
  return `${expectation} (${roles.join("; ")})`;
}

async function expectFenced(storm: Storm, starter: Starter): Promise<void> {
  releaseClaim(storm, starter);
  expect(await starter.exited).toBe(1);
  expect(starter.stderr()).toMatch(/live Pi Workflows server already owns epoch/);
}

async function releaseWinner(storm: Storm, winner: Starter): Promise<void> {
  releaseClaim(storm, winner);
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (!(await probeServerServing(storm.socketPath, 500))) {
    if (hasExited(winner.child)) {
      throw new Error(`the claim winner exited instead of serving: ${winner.stderr()}`);
    }
    if (Date.now() > deadline) throw new Error("the claim winner did not start serving");
    await delay(20);
  }
}

/** The winner owns the claim and its lock, and the lock survives the winner's next claim poll. */
async function expectWinnerKeepsLock(storm: Storm, winner: Starter): Promise<void> {
  const state = new ServerStateStore(storm.databasePath, { readOnly: true });
  try {
    expect(state.serverStatus()).toMatchObject({
      serverId: winner.serverId,
      pid: winner.pid,
      live: true,
    });
  } finally {
    state.close();
  }
  expect(hasExited(winner.child)).toBe(false);
  const message = describeStarters(storm, winner, "the lock must name the claim winner");
  expect(readServerLock(storm.lockPath), message).toMatchObject({
    serverId: winner.serverId,
    pid: winner.pid,
  });
  await delay(SERVER_CLAIM_POLL_MS + 500);
  expect(readServerLock(storm.lockPath), message).toMatchObject({
    serverId: winner.serverId,
    pid: winner.pid,
  });
  expect(await probeServerServing(storm.socketPath, 1_000)).toBe(true);
}

/** Release every gate, then stop every starter that is still running. */
async function stopStarters(storm: Storm): Promise<void> {
  for (const starter of storm.starters) {
    if (hasExited(starter.child)) continue;
    releaseClaim(storm, starter);
    killGroup(starter.pid, "SIGTERM");
  }
  await Promise.all(
    storm.starters.map(async (starter) => {
      if (hasExited(starter.child)) return;
      await Promise.race([starter.exited, delay(EXIT_GRACE_MS)]);
      if (hasExited(starter.child)) return;
      killGroup(starter.pid, "SIGKILL");
      await starter.exited;
    }),
  );
  fs.rmSync(storm.gate, { recursive: true, force: true });
}

/** An idle process that stands in for the stopping server's still-running process. */
async function startStoppingServerProcess(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["-e", 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise((resolve, reject) => {
    child.stdout?.once("data", resolve);
    child.once("error", reject);
  });
  return child;
}

describe("workflow server lock during a respawn storm", () => {
  it("keeps the claim winner's lock when fenced starters overlap its startup", async () => {
    const storm = await createStorm("server-lock-race");
    // The old server stops: its listener, claim, and lock are gone, and every
    // connected session spawns a replacement at once.
    const old = new WorkflowServer({ databasePath: storm.databasePath, runnerId: "server-old" });
    await old.start();
    await old.stop();
    expect(readServerLock(storm.lockPath)).toBeUndefined();
    try {
      const [winner, ...losers] = (await startStarters(storm)) as [Starter, ...Starter[]];
      await releaseWinner(storm, winner);
      for (const loser of losers) await expectFenced(storm, loser);
      await expectWinnerKeepsLock(storm, winner);
    } finally {
      await stopStarters(storm);
    }
  }, 120_000);

  it("leaves the stopping server's lock alone while its claim fences early starters", async () => {
    const storm = await createStorm("server-lock-race-mid-stop");
    // The stopping server closed its listener but still holds its claim and
    // its lock, so every starter's probe finds nothing serving.
    const stopping = await startStoppingServerProcess();
    const stoppingPid = stopping.pid as number;
    const startIdentity = processStartIdentity(stoppingPid) as string;
    const store = new ServerStateStore(storm.databasePath);
    try {
      const oldClaim = store.acquireServer({
        serverId: "server-old",
        pid: stoppingPid,
        processStartIdentity: startIdentity,
        leaseMs: 60_000,
      });
      fs.mkdirSync(path.dirname(storm.lockPath), { recursive: true, mode: 0o700 });
      const oldLock = `${JSON.stringify({
        schema: "pi-workflows.server-lock.v1",
        pid: stoppingPid,
        startIdentity,
        serverId: "server-old",
      })}\n`;
      fs.writeFileSync(storm.lockPath, oldLock, { mode: 0o600 });

      const [first, second, winner, fourth, fifth] = (await startStarters(storm)) as [
        Starter,
        Starter,
        Starter,
        Starter,
        Starter,
      ];
      // The stopping server's live claim fences the earliest starters, and
      // they leave its lock exactly as it was.
      for (const early of [first, second]) {
        await expectFenced(storm, early);
        expect(
          fs.readFileSync(storm.lockPath, "utf8"),
          describeStarters(
            storm,
            winner,
            "starters fenced by the old claim must not touch its lock",
          ),
        ).toBe(oldLock);
      }
      // The stopping server finishes: it removes its own lock, then releases its claim.
      if (readServerLock(storm.lockPath)?.serverId === "server-old") fs.rmSync(storm.lockPath);
      expect(store.releaseServer(oldClaim)).toBe(true);

      await releaseWinner(storm, winner);
      for (const late of [fourth, fifth]) await expectFenced(storm, late);
      await expectWinnerKeepsLock(storm, winner);
    } finally {
      await stopStarters(storm);
      store.close();
      killGroup(stoppingPid, "SIGKILL");
    }
  }, 120_000);
});
