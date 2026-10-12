import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clientSocketPath } from "../src/client/protocol.js";
import { probeServerServing, readServerLock, serverLockPath } from "../src/server/lock.js";
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Spawn one real workflow server that pauses at its epoch claim until the test releases it. */
async function startGatedStarter(databasePath: string, gate: string): Promise<Starter> {
  const child = spawn(
    process.execPath,
    ["--import", TSX_LOADER, "--import", CLAIM_GATE, SERVER_ENTRY, "--database", databasePath],
    {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PI_WORKFLOWS_TEST_CLAIM_GATE: gate },
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
  const reached = path.join(gate, `${pid}.reached`);
  await waitUntil(() => fs.existsSync(reached) || hasExited(child), STARTUP_TIMEOUT_MS);
  if (!fs.existsSync(reached)) {
    throw new Error(`starter ${pid} exited before it reached its claim: ${stderr}`);
  }
  return { child, pid, serverId: fs.readFileSync(reached, "utf8"), exited, stderr: () => stderr };
}

function releaseClaim(gate: string, starter: Starter): void {
  fs.writeFileSync(path.join(gate, `${starter.pid}.release`), "");
}

/** Name each starter by role, so a failure shows which process the lock names. */
function describeStarters(starters: Starter[]): string {
  const roles = starters.map((starter, index) => {
    const role = index === 0 ? "winner" : `fenced loser ${index}`;
    const state = hasExited(starter.child) ? "exited" : "running";
    return `${role}: pid ${starter.pid}, ${starter.serverId}, ${state}`;
  });
  return `the lock must name the claim winner (${roles.join("; ")})`;
}

async function waitUntilServing(socketPath: string, starter: Starter): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (!(await probeServerServing(socketPath, 500))) {
    if (hasExited(starter.child)) {
      throw new Error(`the claim winner exited instead of serving: ${starter.stderr()}`);
    }
    if (Date.now() > deadline) throw new Error("the claim winner did not start serving");
    await delay(20);
  }
}

/** Release every gate, then stop every starter that is still running. */
async function stopStarters(gate: string, starters: Starter[]): Promise<void> {
  for (const starter of starters) {
    if (hasExited(starter.child)) continue;
    releaseClaim(gate, starter);
    try {
      process.kill(-starter.pid, "SIGTERM");
    } catch {
      // The starter exited after the check.
    }
  }
  await Promise.all(
    starters.map(async (starter) => {
      if (hasExited(starter.child)) return;
      await Promise.race([starter.exited, delay(EXIT_GRACE_MS)]);
      if (hasExited(starter.child)) return;
      try {
        process.kill(-starter.pid, "SIGKILL");
      } catch {
        // The starter exited during the grace period.
      }
      await starter.exited;
    }),
  );
  fs.rmSync(gate, { recursive: true, force: true });
}

describe("workflow server lock during a respawn storm", () => {
  it("keeps the claim winner's lock when fenced starters overlap its startup", async () => {
    const root = await makeTempDir("server-lock-race");
    const databasePath = path.join(root, "state.sqlite");
    const gate = path.join(root, "claim-gate");
    fs.mkdirSync(gate);
    const lockPath = serverLockPath(databasePath);
    const socketPath = clientSocketPath(databasePath);

    // The old server stops: its listener, claim, and lock are gone, and every
    // connected session spawns a replacement at once.
    const old = new WorkflowServer({ databasePath, runnerId: "server-old" });
    await old.start();
    await old.stop();
    expect(readServerLock(lockPath)).toBeUndefined();

    const starters: Starter[] = [];
    try {
      // Each replacement reaches its claim before the next one starts, so every
      // later starter sees the earlier ones alive and not yet serving.
      for (let index = 0; index < STARTERS; index += 1) {
        starters.push(await startGatedStarter(databasePath, gate));
      }
      const [winner, ...losers] = starters as [Starter, ...Starter[]];

      releaseClaim(gate, winner);
      await waitUntilServing(socketPath, winner);
      for (const loser of losers) {
        releaseClaim(gate, loser);
        expect(await loser.exited).toBe(1);
        expect(loser.stderr()).toMatch(/live Pi Workflows server already owns epoch/);
      }

      const state = new ServerStateStore(databasePath, { readOnly: true });
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
      expect(readServerLock(lockPath), describeStarters(starters)).toMatchObject({
        serverId: winner.serverId,
        pid: winner.pid,
      });
      // The winner's next claim poll leaves its lock in place.
      await delay(SERVER_CLAIM_POLL_MS + 500);
      expect(readServerLock(lockPath), describeStarters(starters)).toMatchObject({
        serverId: winner.serverId,
        pid: winner.pid,
      });
      expect(await probeServerServing(socketPath, 1_000)).toBe(true);
    } finally {
      await stopStarters(gate, starters);
    }
  }, 120_000);
});
