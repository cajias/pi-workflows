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

/**
 * The complete stderr stream of one headless pi child, in a private temporary file:
 * `<tmp>/<prefix>XXXXXX/pi-stderr.log`, with a `0700` directory and a `0600` file.
 *
 * Pi's stderr can carry text from provider extensions, so it never enters workflow state:
 * Sanity Check keeps only bounded results and safe operational facts. A group that pi fails
 * to run keeps the file and names it in its error; the operator deletes it. Every other group
 * removes it. A runner that is killed with SIGKILL during a group leaves its directory behind.
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
