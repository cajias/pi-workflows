import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertNoServingServer,
  probeServerServing,
  readServerLock,
  replaceServerLock,
  serverLockPath,
  stopRecordedServer,
} from "../src/server/lock.js";
import { processStartIdentity } from "../src/server/processes.js";
import { makeTempDir, waitUntil } from "./helpers.js";

const IDLE = "setInterval(() => {}, 1000);";

function childCode(ignoreSigterm: boolean): string {
  const handler = ignoreSigterm ? 'process.on("SIGTERM", () => {});' : "";
  return `${handler}process.stdout.write("ready\\n");${IDLE}`;
}

/** Start an idle process and wait until it reports that its handlers are installed. */
async function startIdleProcess(ignoreSigterm = false): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", childCode(ignoreSigterm)], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  await new Promise((resolve, reject) => {
    child.stdout?.once("data", resolve);
    child.once("error", reject);
  });
  return child;
}

async function lockDirectory(prefix: string): Promise<{ directory: string; lockPath: string }> {
  const directory = await makeTempDir(prefix);
  return { directory, lockPath: path.join(directory, "server.lock.json") };
}

function recordFor(
  child: ChildProcess,
  serverId = "server-test",
): {
  pid: number;
  startIdentity: string;
  serverId: string;
} {
  const pid = child.pid as number;
  const startIdentity = processStartIdentity(pid);
  if (startIdentity === undefined)
    throw new Error(`The test process has no start identity: ${pid}`);
  return { pid, startIdentity, serverId };
}

/** The test process itself: always alive, so its lock record always matches. */
function selfRecord(serverId: string): {
  pid: number;
  startIdentity: string;
  serverId: string;
} {
  const startIdentity = processStartIdentity(process.pid);
  if (startIdentity === undefined)
    throw new Error(`The test process has no start identity: ${process.pid}`);
  return { pid: process.pid, startIdentity, serverId };
}

function killIfAlive(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The test process has already exited.
    }
  }
}

describe("workflow server lock file", () => {
  it("reads no record from a missing, unparsable, or unusable lock file", async () => {
    const { lockPath } = await lockDirectory("pw-lock-empty");
    expect(readServerLock(lockPath)).toBeUndefined();

    fs.writeFileSync(lockPath, "not json\n");
    expect(readServerLock(lockPath)).toBeUndefined();

    fs.writeFileSync(
      lockPath,
      JSON.stringify({ schema: "pi-workflows.server-lock.v1", pid: "1", startIdentity: "x" }),
    );
    expect(readServerLock(lockPath)).toBeUndefined();
  });

  it("names the lock file beside the state database", async () => {
    const directory = await makeTempDir("pw-lock-path");
    expect(serverLockPath(path.join(directory, "state.sqlite"))).toBe(
      path.join(directory, "server", "server.lock.json"),
    );
  });

  it("replaces a lock record atomically with an owner-only file", async () => {
    const { directory, lockPath } = await lockDirectory("pw-lock-replace");
    const first = selfRecord("server-first");
    const second = selfRecord("server-second");
    replaceServerLock(lockPath, first);
    expect(readServerLock(lockPath)).toEqual(first);
    replaceServerLock(lockPath, second);
    expect(readServerLock(lockPath)).toEqual(second);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual({
      schema: "pi-workflows.server-lock.v1",
      ...second,
    });
    expect(fs.statSync(lockPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(["server.lock.json"]);
  });

  it("removes its temporary file when the replacement cannot land", async () => {
    const { directory, lockPath } = await lockDirectory("pw-lock-replace-fail");
    // A directory at the lock path makes the rename fail.
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "keep"), "");
    expect(() => replaceServerLock(lockPath, selfRecord("server-blocked"))).toThrow();
    expect(fs.readdirSync(directory)).toEqual(["server.lock.json"]);
  });

  it("stops the recorded process", async () => {
    const { lockPath } = await lockDirectory("pw-lock-stop");
    const child = await startIdleProcess();
    try {
      const record = recordFor(child);
      replaceServerLock(lockPath, record);
      expect(readServerLock(lockPath)).toEqual(record);
      expect(await stopRecordedServer(lockPath)).toEqual({
        pid: record.pid,
        serverId: record.serverId,
        forced: false,
        exited: true,
      });
      await waitUntil(() => processStartIdentity(record.pid) === undefined);
    } finally {
      killIfAlive(child);
    }
  });

  it("leaves a process alone when its start identity does not match", async () => {
    const { lockPath } = await lockDirectory("pw-lock-identity");
    const child = await startIdleProcess();
    try {
      replaceServerLock(lockPath, {
        pid: child.pid as number,
        startIdentity: "platform-start:0",
        serverId: "server-other",
      });
      expect(await stopRecordedServer(lockPath)).toBeUndefined();
      expect(processStartIdentity(child.pid as number)).toBeDefined();
    } finally {
      killIfAlive(child);
    }
  });

  it("stops nothing when the recorded process has exited", async () => {
    const { lockPath } = await lockDirectory("pw-lock-gone");
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => exited.once("exit", resolve));
    replaceServerLock(lockPath, {
      pid: exited.pid as number,
      startIdentity: "platform-start:0",
      serverId: "server-gone",
    });
    expect(await stopRecordedServer(lockPath)).toBeUndefined();
  });

  it("forces a stop when the recorded process ignores the request", async () => {
    const { lockPath } = await lockDirectory("pw-lock-force");
    const child = await startIdleProcess(true);
    try {
      const record = recordFor(child, "server-stubborn");
      replaceServerLock(lockPath, record);
      expect(await stopRecordedServer(lockPath, { graceMs: 200 })).toEqual({
        pid: record.pid,
        serverId: "server-stubborn",
        forced: true,
        exited: true,
      });
      await waitUntil(() => processStartIdentity(record.pid) === undefined);
    } finally {
      killIfAlive(child);
    }
  });
});

async function exitedPid(): Promise<number> {
  const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => exited.once("exit", resolve));
  return exited.pid as number;
}

describe("pre-claim serving check", () => {
  const socketPath = path.join("/tmp", "unused.sock");

  it("probes and passes with a missing or dead lock record without writing", async () => {
    const { lockPath } = await lockDirectory("pw-lock-check-quiet");
    const probe = vi.fn(async () => false);
    await assertNoServingServer(lockPath, { socketPath, probe });
    expect(probe).toHaveBeenCalledOnce();
    expect(fs.existsSync(lockPath)).toBe(false);

    const dead = { pid: await exitedPid(), startIdentity: "platform-start:0", serverId: "gone" };
    replaceServerLock(lockPath, dead);
    await assertNoServingServer(lockPath, { socketPath, probe });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(readServerLock(lockPath)).toEqual(dead);
  });

  it("refuses to start while a server answers and the lock file is missing", async () => {
    const { lockPath } = await lockDirectory("pw-lock-check-missing");
    await expect(
      assertNoServingServer(lockPath, { socketPath, probe: async () => true }),
    ).rejects.toThrow(`A workflow server is already running on ${socketPath}`);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("names a live recorded holder and leaves its record in place", async () => {
    const { lockPath } = await lockDirectory("pw-lock-check-live");
    const child = await startIdleProcess();
    try {
      const holder = recordFor(child, "server-serving");
      replaceServerLock(lockPath, holder);
      await expect(
        assertNoServingServer(lockPath, { socketPath, probe: async () => true }),
      ).rejects.toThrow(`A workflow server is already running with PID ${holder.pid}`);
      expect(readServerLock(lockPath)).toEqual(holder);

      // A live holder that is alive but silent keeps its record too.
      await assertNoServingServer(lockPath, { socketPath, probe: async () => false });
      expect(readServerLock(lockPath)).toEqual(holder);
    } finally {
      killIfAlive(child);
    }
  });

  it("does not name a recorded process that has exited", async () => {
    const { lockPath } = await lockDirectory("pw-lock-check-dead");
    const dead = { pid: await exitedPid(), startIdentity: "platform-start:0", serverId: "gone" };
    replaceServerLock(lockPath, dead);
    await expect(
      assertNoServingServer(lockPath, { socketPath, probe: async () => true }),
    ).rejects.toThrow(`A workflow server is already running on ${socketPath}`);
  });

  it("refuses against a real hello-writing server with no lock file", async () => {
    const directory = await makeTempDir("pw-lock-check-real");
    const lockPath = path.join(directory, "server.lock.json");
    const realSocket = path.join(directory, "s.sock");
    const server = net.createServer((socket) => {
      socket.end('{"type":"hello"}\n');
    });
    server.listen(realSocket);
    await once(server, "listening");
    try {
      await expect(
        assertNoServingServer(lockPath, { socketPath: realSocket, probeTimeoutMs: 1_000 }),
      ).rejects.toThrow(/already running/);
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      server.close();
    }
  });

  it("passes a real silent socket and leaves the silent holder's record", async () => {
    const directory = await makeTempDir("pw-lock-check-deaf");
    const lockPath = path.join(directory, "server.lock.json");
    const deafSocket = path.join(directory, "s.sock");
    const holder = selfRecord("server-deaf");
    replaceServerLock(lockPath, holder);
    const server = net.createServer(() => undefined);
    server.listen(deafSocket);
    await once(server, "listening");
    try {
      await assertNoServingServer(lockPath, { socketPath: deafSocket, probeTimeoutMs: 300 });
      expect(readServerLock(lockPath)).toEqual(holder);
    } finally {
      server.close();
    }
  });
});

describe("server serving probe", () => {
  it("reports a hello-writing server as serving", async () => {
    const socketPath = path.join(await makeTempDir("pw-probe-hello"), "s.sock");
    const server = net.createServer((socket) => {
      socket.end('{"type":"hello"}\n');
    });
    server.listen(socketPath);
    await once(server, "listening");
    try {
      expect(await probeServerServing(socketPath, 1_000)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("reports a silent bound socket as not serving", async () => {
    const socketPath = path.join(await makeTempDir("pw-probe-silent"), "s.sock");
    const server = net.createServer(() => undefined);
    server.listen(socketPath);
    await once(server, "listening");
    try {
      expect(await probeServerServing(socketPath, 300)).toBe(false);
    } finally {
      server.close();
    }
  });

  it("reports a missing socket path as not serving without connecting", async () => {
    const socketPath = path.join(await makeTempDir("pw-probe-missing"), "gone.sock");
    expect(await probeServerServing(socketPath, 300)).toBe(false);
  });
});
