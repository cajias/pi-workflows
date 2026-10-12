import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { killProcessGroup, matchesProcessIdentity, type ProcessIdentity } from "./processes.js";

export const SERVER_LOCK_SCHEMA = "pi-workflows.server-lock.v1" as const;

/** Grace between the graceful stop request and the forced stop. */
export const SERVER_STOP_GRACE_MS = 5_000;
const STOP_POLL_MS = 50;

/** One lock record names the server process and fences a reused process ID. */
export type ServerLockRecord = ProcessIdentity & { serverId: string };

export type RecordedServerStop = {
  pid: number;
  serverId: string;
  /** True when the process ignored the graceful request and a forced stop followed. */
  forced: boolean;
  /** True when the recorded process no longer holds its start identity. */
  exited: boolean;
};

export function serverDirectoryPath(databasePath: string): string {
  return path.join(path.dirname(path.resolve(databasePath)), "server");
}

export function serverLockPath(databasePath: string): string {
  return path.join(serverDirectoryPath(databasePath), "server.lock.json");
}

function isServerLockRecord(value: unknown): value is ServerLockRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    schema?: unknown;
    pid?: unknown;
    startIdentity?: unknown;
    serverId?: unknown;
  };
  return (
    record.schema === SERVER_LOCK_SCHEMA &&
    typeof record.pid === "number" &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.startIdentity === "string" &&
    record.startIdentity.length > 0 &&
    typeof record.serverId === "string"
  );
}

/** Read the recorded server, or return undefined for a missing or unusable lock file. */
export function readServerLock(lockPath: string): ServerLockRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!isServerLockRecord(parsed)) return undefined;
  const { pid, startIdentity, serverId } = parsed;
  return { pid, startIdentity, serverId };
}

/** True when both records name the same server process and server ID. */
export function sameServerLock(
  left: ServerLockRecord | undefined,
  right: ServerLockRecord,
): boolean {
  return (
    left !== undefined &&
    left.pid === right.pid &&
    left.startIdentity === right.startIdentity &&
    left.serverId === right.serverId
  );
}

/**
 * Replace the lock file in one atomic step: the record goes to a private
 * temporary file in the same directory, which is then renamed over the lock.
 * A reader therefore sees the previous record or the new one, never a partial
 * file or a gap. Only the server that owns the current epoch calls this.
 */
export function replaceServerLock(lockPath: string, record: ServerLockRecord): void {
  const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  const { pid, startIdentity, serverId } = record;
  try {
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({ schema: SERVER_LOCK_SCHEMA, pid, startIdentity, serverId })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    fs.renameSync(temporary, lockPath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** One bounded socket probe: does a server accept connections here and answer? */
export type ServerLockProbe = (socketPath: string, timeoutMs: number) => Promise<boolean>;

/**
 * Ask the socket whether a server is really serving. Serving means the connect
 * succeeds and the server's hello arrives within the timeout; a connect error or
 * a silent window means the holder is alive but not serving, as during shutdown
 * or while frozen. The probe socket is always destroyed.
 */
export async function probeServerServing(socketPath: string, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect(socketPath);
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    const finish = (serving: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(serving);
    };
    socket.once("data", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

/**
 * Refuse to start while a server answers on the socket. The probe runs whatever
 * the lock file says: a missing record, a dead process, or a live one. A lock
 * can be missing while a server serves, and a live holder can be alive but
 * silent, as during shutdown or while frozen. This check only reads. It never
 * writes or removes the lock, because a starter does not own the lock until it
 * wins the epoch claim. Fencing against a second live server stays with the
 * epoch claim: a probe misfire costs one wasted start, and the loser exits when
 * its claim fails.
 */
export async function assertNoServingServer(
  lockPath: string,
  options: { socketPath: string; probeTimeoutMs?: number; probe?: ServerLockProbe },
): Promise<void> {
  const probe = options.probe ?? probeServerServing;
  if (!(await probe(options.socketPath, options.probeTimeoutMs ?? 500))) return;
  const holder = readServerLock(lockPath);
  throw new Error(
    holder !== undefined && matchesProcessIdentity(holder)
      ? `A workflow server is already running with PID ${holder.pid}`
      : `A workflow server is already running on ${options.socketPath}`,
  );
}

/**
 * Stop the server named by the lock file when the recorded process still has its start
 * identity. A client whose package version differs from the running server cannot send a
 * stop request, so the lock file is the only path to that stale process. A record whose
 * process is gone, or whose process ID now belongs to another process, stops nothing.
 */
export async function stopRecordedServer(
  lockPath: string,
  options: { graceMs?: number } = {},
): Promise<RecordedServerStop | undefined> {
  const record = readServerLock(lockPath);
  if (record === undefined) return undefined;
  if (!matchesProcessIdentity(record)) return undefined;
  const graceMs = options.graceMs ?? SERVER_STOP_GRACE_MS;
  killProcessGroup(record.pid, "SIGTERM");
  const graceful = await waitForExit(record, graceMs);
  if (graceful) return { pid: record.pid, serverId: record.serverId, forced: false, exited: true };
  killProcessGroup(record.pid, "SIGKILL");
  const forced = await waitForExit(record, graceMs);
  return { pid: record.pid, serverId: record.serverId, forced: true, exited: forced };
}

async function waitForExit(record: ServerLockRecord, graceMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(graceMs, STOP_POLL_MS);
  while (Date.now() < deadline) {
    if (!matchesProcessIdentity(record)) return true;
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
  return !matchesProcessIdentity(record);
}
