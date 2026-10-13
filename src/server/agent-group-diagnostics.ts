import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  PiAgentLifecycleEvent,
  PiAgentLifecycleState,
  PiAgentRequest,
} from "../builtins/pi-agent-launch.js";
import { errorMessage } from "../workflows/errors.js";

const TERMINAL_STATES = new Set<PiAgentLifecycleState>(["completed", "failed", "cancelled"]);
const QUEUED_PHASE = "cancelled: the session did not start";
const STDERR_LOG_FILE = "pi-stderr.log";
/**
 * A stderr log directory name: `pi-workflows-<runId>-agent-group-` from the workflow runner, or
 * the default `pi-workflows-agent-group-`, then the six letters or digits that mkdtemp adds.
 * The run ID part follows the run ID syntax that the Pi extension accepts.
 */
const STDERR_LOG_DIRECTORY =
  /^pi-workflows-(?:[A-Za-z0-9][A-Za-z0-9._-]{0,199}-)?agent-group-[A-Za-z0-9]{6}$/u;

/**
 * How long a kept stderr log stays before a later agent group deletes it: seven days after
 * pi last wrote to it. A kept log exists so an operator or the post-workflow model turn can
 * read why pi could not run a group, and a week leaves time to do that after a weekend or a
 * paused run. It is also far beyond the longest running group: Sanity Check's agent group
 * actions time out after 20 minutes, and pi's output keeps the file's modification time
 * current while a group runs.
 */
export const STDERR_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type StderrLogPruneOptions = {
  now?: number;
  retentionMs?: number;
  /** Reports a directory that could not be checked or removed. Pruning itself never fails. */
  onError?: (target: string, error: unknown) => void;
};

/**
 * Delete expired stderr log directories in `parent` and return the removed paths.
 *
 * A directory is removed only when it is exactly what {@link PiStderrLog} creates: a matching
 * name, a real directory (not a symlink) owned by this user with mode `0700`, holding nothing
 * or only a regular `pi-stderr.log` file owned by this user with mode `0600`, and with neither
 * modified within `retentionMs`. Removal unlinks that one file and then removes the empty
 * directory, so it never recurses and never follows a symlink. Everything else stays. A
 * directory that disappears meanwhile, because another runner pruned it, is skipped silently;
 * any other failure goes to `onError` and leaves that directory in place.
 */
export async function pruneStderrLogs(
  parent: string = os.tmpdir(),
  options: StderrLogPruneOptions = {},
): Promise<string[]> {
  // Without a user ID, ownership cannot be checked, so nothing is pruned.
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const cutoff = (options.now ?? Date.now()) - (options.retentionMs ?? STDERR_LOG_RETENTION_MS);
  const report = (target: string, error: unknown) => {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    try {
      options.onError?.(target, error);
    } catch {
      // Reporting is best effort, like pruning itself.
    }
  };
  let names: string[];
  try {
    names = await fsp.readdir(parent);
  } catch (error) {
    report(parent, error);
    return [];
  }
  const removed: string[] = [];
  for (const name of names.filter((entry) => STDERR_LOG_DIRECTORY.test(entry)).sort()) {
    const directory = path.join(parent, name);
    try {
      if (await removeExpiredStderrLog(directory, uid, cutoff)) removed.push(directory);
    } catch (error) {
      report(directory, error);
    }
  }
  return removed;
}

async function removeExpiredStderrLog(
  directory: string,
  uid: number,
  cutoff: number,
): Promise<boolean> {
  const info = await fsp.lstat(directory);
  if (!info.isDirectory() || !expiredPrivateEntry(info, uid, 0o700, cutoff)) return false;
  const entries = await fsp.readdir(directory);
  if (entries.some((entry) => entry !== STDERR_LOG_FILE)) return false;
  if (entries.length > 0) {
    const log = path.join(directory, STDERR_LOG_FILE);
    const logInfo = await fsp.lstat(log);
    if (!logInfo.isFile() || !expiredPrivateEntry(logInfo, uid, 0o600, cutoff)) return false;
    await fsp.unlink(log);
  }
  // Fails, and keeps the directory, if anything appeared in it meanwhile.
  await fsp.rmdir(directory);
  return true;
}

function expiredPrivateEntry(info: fs.Stats, uid: number, mode: number, cutoff: number): boolean {
  return info.uid === uid && (info.mode & 0o777) === mode && info.mtimeMs <= cutoff;
}

/**
 * The complete stderr stream of one headless pi child, in a private temporary file:
 * `<tmp>/<prefix>XXXXXX/pi-stderr.log`, with a `0700` directory and a `0600` file.
 *
 * Pi's stderr can carry text from provider extensions, so it never enters workflow state:
 * Sanity Check keeps only bounded results and safe operational facts. A group that pi fails
 * to run keeps the file and names it in its error. Every other group removes it. A runner that
 * is killed with SIGKILL during a group leaves its directory behind. {@link pruneStderrLogs}
 * deletes kept and left-behind directories after {@link STDERR_LOG_RETENTION_MS}.
 */
export class PiStderrLog {
  private directory: string | undefined;
  private stream: fs.WriteStream | undefined;
  private failure: string | undefined;

  constructor(
    private readonly parent: string = os.tmpdir(),
    private readonly prefix: string = "pi-workflows-agent-group-",
  ) {}

  get path(): string | undefined {
    return this.directory === undefined ? undefined : path.join(this.directory, "pi-stderr.log");
  }

  async open(): Promise<void> {
    try {
      // mkdtemp creates the directory with mode 0700.
      this.directory = await fsp.mkdtemp(path.join(this.parent, this.prefix));
      const stream = fs.createWriteStream(path.join(this.directory, "pi-stderr.log"), {
        flags: "wx",
        mode: 0o600,
      });
      stream.on("error", (error) => {
        this.failure ??= error.message;
      });
      this.stream = stream;
    } catch (error) {
      this.failure = errorMessage(error);
    }
  }

  write(chunk: Buffer): void {
    this.stream?.write(chunk);
  }

  /** Where the complete stream is, for an error message. */
  describe(): string {
    const target = this.path;
    if (this.failure !== undefined || target === undefined) {
      return `pi stderr was not saved: ${this.failure ?? "no log file"}`;
    }
    return `complete pi stderr: ${target}`;
  }

  async keep(): Promise<void> {
    await this.endStream();
  }

  async discard(): Promise<void> {
    await this.endStream();
    if (this.directory !== undefined) {
      await fsp.rm(this.directory, { recursive: true, force: true });
    }
  }

  private async endStream(): Promise<void> {
    const stream = this.stream;
    this.stream = undefined;
    if (stream === undefined || stream.destroyed) return;
    await new Promise<void>((resolve) => stream.end(resolve));
  }
}

type AgentRecord = { event: PiAgentLifecycleEvent; seenAt: number };

/**
 * The last lifecycle fact for each request in one group. When the bridge cannot report how
 * a group ended, it supplies a terminal fact for every request that still lacks one, so no
 * progress track stays pending or running.
 */
export class AgentLifecycleLedger {
  private readonly latest = new Map<string, AgentRecord>();

  constructor(
    private readonly requests: PiAgentRequest[],
    private readonly now: () => number = Date.now,
  ) {}

  record(event: PiAgentLifecycleEvent): void {
    this.latest.set(event.id, { event, seenAt: this.now() });
  }

  isTerminal(id: string): boolean {
    const state = this.latest.get(id)?.event.state;
    return state !== undefined && TERMINAL_STATES.has(state);
  }

  /**
   * Terminal facts for unsettled requests. Started requests take `state` with `phase`;
   * requests that never started are cancelled, as when a group stops before queued work runs.
   */
  unsettled(state: "cancelled" | "failed", phase: string): PiAgentLifecycleEvent[] {
    const events: PiAgentLifecycleEvent[] = [];
    for (const request of this.requests) {
      const record = this.latest.get(request.id);
      if (record === undefined) {
        events.push({
          id: request.id,
          role: request.role,
          state: "cancelled",
          phase: QUEUED_PHASE,
          elapsedMs: 0,
        });
      } else if (!TERMINAL_STATES.has(record.event.state)) {
        events.push({
          ...record.event,
          state,
          phase: `${state}: ${phase}`,
          elapsedMs: record.event.elapsedMs + this.now() - record.seenAt,
        });
      }
    }
    return events;
  }
}
