import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  PiAgentGroupError,
  PiAgentLifecycleEvent,
  PiAgentLifecycleState,
  PiAgentRequest,
} from "../builtins/pi-agent-launch.js";
import { errorMessage } from "../workflows/errors.js";

const TERMINAL_STATES = new Set<PiAgentLifecycleState>(["completed", "failed", "cancelled"]);
const QUEUED_PHASE = "cancelled: the session did not start";
const STDERR_LOG_FILE = "pi-stderr.log";
const CAUSE_FILE = "cause.txt";
const DIAGNOSTIC_FILES = new Set([STDERR_LOG_FILE, CAUSE_FILE]);
/**
 * A diagnostics directory name: `pi-workflows-<runId>-agent-group-` from the workflow runner, or
 * the default `pi-workflows-agent-group-`, then the six letters or digits that mkdtemp adds.
 * The run ID part follows the run ID syntax that the Pi extension accepts.
 */
const DIAGNOSTICS_DIRECTORY =
  /^pi-workflows-(?:[A-Za-z0-9][A-Za-z0-9._-]{0,199}-)?agent-group-[A-Za-z0-9]{6}$/u;

/**
 * How long a kept diagnostics directory stays before a later agent group deletes it: seven
 * days after its last change. A kept cause file or stderr log exists so an operator or the
 * post-workflow model turn can read why a group failed, and a week leaves time to do that
 * after a weekend or a paused run. It is also far beyond the longest running group: Sanity
 * Check's agent group actions time out after 20 minutes, and pi's output keeps the stderr
 * log's modification time current while a group runs.
 */
export const DIAGNOSTICS_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type DiagnosticsPruneOptions = {
  now?: number;
  retentionMs?: number;
  /** Reports a directory that could not be checked or removed. Pruning itself never fails. */
  onError?: (target: string, error: unknown) => void;
};

/**
 * Delete expired diagnostics directories in `parent` and return the removed paths.
 *
 * A directory is removed only when it is exactly what {@link AgentGroupDiagnostics} creates: a
 * matching name, a real directory (not a symlink) owned by this user with mode `0700`, holding
 * nothing but a `pi-stderr.log` and a `cause.txt`, each optional and each a regular file owned
 * by this user with mode `0600`, and with none of them modified within `retentionMs`. Removal
 * unlinks those files and then removes the empty directory, so it never recurses and never
 * follows a symlink. Everything else stays. A directory that disappears meanwhile, because
 * another runner pruned it, is skipped silently; any other failure goes to `onError` and
 * leaves that directory in place.
 */
export async function pruneAgentGroupDiagnostics(
  parent: string = os.tmpdir(),
  options: DiagnosticsPruneOptions = {},
): Promise<string[]> {
  // Without a user ID, ownership cannot be checked, so nothing is pruned.
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const cutoff = (options.now ?? Date.now()) - (options.retentionMs ?? DIAGNOSTICS_RETENTION_MS);
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
  for (const name of names.filter((entry) => DIAGNOSTICS_DIRECTORY.test(entry)).sort()) {
    const directory = path.join(parent, name);
    try {
      if (await removeExpiredDiagnostics(directory, uid, cutoff)) removed.push(directory);
    } catch (error) {
      report(directory, error);
    }
  }
  return removed;
}

async function removeExpiredDiagnostics(
  directory: string,
  uid: number,
  cutoff: number,
): Promise<boolean> {
  const info = await fsp.lstat(directory);
  if (!info.isDirectory() || !expiredPrivateEntry(info, uid, 0o700, cutoff)) return false;
  const entries = await fsp.readdir(directory);
  if (entries.some((entry) => !DIAGNOSTIC_FILES.has(entry))) return false;
  const files = entries.toSorted().map((entry) => path.join(directory, entry));
  for (const file of files) {
    const fileInfo = await fsp.lstat(file);
    if (!fileInfo.isFile() || !expiredPrivateEntry(fileInfo, uid, 0o600, cutoff)) return false;
  }
  for (const file of files) await fsp.unlink(file);
  // Fails, and keeps the directory, if anything appeared in it meanwhile.
  await fsp.rmdir(directory);
  return true;
}

function expiredPrivateEntry(info: fs.Stats, uid: number, mode: number, cutoff: number): boolean {
  return info.uid === uid && (info.mode & 0o777) === mode && info.mtimeMs <= cutoff;
}

/**
 * The complete cause of a failed agent group, as its cause file holds it: the error code and
 * facts, then the complete private detail.
 */
export function agentGroupCauseText(error: PiAgentGroupError): string {
  const summary = `Pi agent ${error.agentId} ${error.code}: ${error.facts}\n`;
  return error.detail === undefined ? summary : `${summary}\n${error.detail}\n`;
}

/**
 * Private diagnostics for one headless pi child, in a temporary directory
 * `<tmp>/<prefix>XXXXXX/` with mode `0700`:
 *
 * - `pi-stderr.log` (`0600`) receives the child's complete stderr stream.
 * - `cause.txt` (`0600`) holds the complete cause of a failed group, written by
 *   {@link saveCause}.
 *
 * Pi's stderr and an error's private detail can carry provider, SDK, or Pi text, so neither
 * enters workflow state: Sanity Check keeps only bounded results and safe operational facts,
 * and the error names these files instead. {@link finish} keeps the cause file of a failed
 * group, keeps the stderr log only when pi failed to run the group, and removes the directory
 * when it keeps neither. A runner that is killed with SIGKILL during a group leaves its
 * directory behind. {@link pruneAgentGroupDiagnostics} deletes kept and left-behind
 * directories after {@link DIAGNOSTICS_RETENTION_MS}.
 */
export class AgentGroupDiagnostics {
  private directory: string | undefined;
  private stream: fs.WriteStream | undefined;
  /** Why the directory could not be created. */
  private directoryFailure: string | undefined;
  private stderrFailure: string | undefined;
  private causeSaved = false;

  constructor(
    private readonly parent: string = os.tmpdir(),
    private readonly prefix: string = "pi-workflows-agent-group-",
  ) {}

  get stderrPath(): string | undefined {
    return this.directory === undefined ? undefined : path.join(this.directory, STDERR_LOG_FILE);
  }

  get causePath(): string | undefined {
    return this.directory === undefined ? undefined : path.join(this.directory, CAUSE_FILE);
  }

  async open(): Promise<void> {
    try {
      // mkdtemp creates the directory with mode 0700.
      this.directory = await fsp.mkdtemp(path.join(this.parent, this.prefix));
    } catch (error) {
      this.directoryFailure = errorMessage(error);
      return;
    }
    const stream = fs.createWriteStream(path.join(this.directory, STDERR_LOG_FILE), {
      flags: "wx",
      mode: 0o600,
    });
    stream.on("error", (error) => {
      this.stderrFailure ??= error.message;
    });
    this.stream = stream;
  }

  write(chunk: Buffer): void {
    this.stream?.write(chunk);
  }

  /** Where the complete stderr stream is, for an error message. */
  describeStderr(): string {
    const target = this.stderrPath;
    const failure = this.directoryFailure ?? this.stderrFailure;
    if (failure !== undefined || target === undefined) {
      return `pi stderr was not saved: ${failure ?? "no log file"}`;
    }
    return `complete pi stderr: ${target}`;
  }

  /**
   * Write `text` to the cause file and say where it is, for an error message. A failure is
   * reported in the returned text and never quotes `text`.
   */
  async saveCause(text: string): Promise<string> {
    const target = this.causePath;
    if (target === undefined) {
      return `complete cause was not saved: ${this.directoryFailure ?? "no diagnostics directory"}`;
    }
    try {
      await fsp.writeFile(target, text, { flag: "wx", mode: 0o600 });
    } catch (error) {
      return `complete cause was not saved: ${errorMessage(error)}`;
    }
    this.causeSaved = true;
    return `complete cause: ${target}`;
  }

  /** Call after the child exits, so a kept stderr log holds the complete stream. */
  async finish(keepStderr: boolean): Promise<void> {
    const stream = this.stream;
    this.stream = undefined;
    if (stream !== undefined && !stream.destroyed) {
      await new Promise<void>((resolve) => stream.end(resolve));
    }
    if (this.directory === undefined || keepStderr) return;
    if (this.causeSaved) await fsp.rm(path.join(this.directory, STDERR_LOG_FILE), { force: true });
    else await fsp.rm(this.directory, { recursive: true, force: true });
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
