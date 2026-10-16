import { randomUUID } from "node:crypto";
import {
  PiAgentGroupError,
  type PiAgentGroupLaunchOptions,
  type PiAgentLifecycleEvent,
  type PiAgentRequest,
  type PiAgentResult,
} from "../builtins/pi-agent-launch.js";
import { errorMessage, isClaimLostError, isRunParkedError } from "../workflows/errors.js";
import {
  AgentGroupDiagnostics,
  agentGroupCauseText,
  AgentLifecycleLedger,
  pruneAgentGroupDiagnostics,
} from "./agent-group-diagnostics.js";
import {
  decodeAgentGroupEvent,
  encodeAgentGroupPrompt,
  type AgentGroupEvent,
  type AgentGroupFailure,
  type AgentGroupRunOptions,
} from "./agent-group-protocol.js";
import {
  availableHeadlessLaunch,
  describeHeadlessPiExit,
  HeadlessPiProcess,
  packagedExtensionPath,
  type HeadlessPiExit,
  type HeadlessPiOptions,
} from "./headless-pi.js";

const BRIDGE_PATH = packagedExtensionPath(import.meta.url, "agent-group-bridge") ?? null;
/**
 * How long a cancelled group may take to settle before the launcher stops pi. Settling aborts
 * each child's provider request and disposes its runtime, which runs every admitted provider
 * extension's `session_shutdown`. Children settle concurrently, so the bound does not grow
 * with group size. The real-Pi end-to-end test settles in well under one second; ten seconds
 * leaves room for an extension that closes network clients or saves refreshed credentials.
 * The engine stops waiting for an aborted action at once, so this wait never delays a run.
 */
export const CANCEL_SETTLE_MS = 10_000;
/**
 * After pi reports that the bridge command returned, how long stderr may stay silent before
 * the missing result is an error. The bridge writes its final event before the command
 * returns, but stdout and stderr are separate pipes. Each stderr chunk restarts the wait, so
 * a large result still in transit is never misreported. Five seconds exceeds the one-second
 * process stop grace that the workflow runner uses.
 */
export const RESULT_IDLE_MS = 5_000;
const LAUNCH_HINT =
  "The workflow runner starts agent groups with the same pinned pi, arguments, and environment as headless workflow steps; `pi-workflows server status` reports that pi as `headlessPi`";

export type HeadlessPiAgentGroupSettings = {
  /** The bridge extension; `null` reports a broken installation. */
  bridgePath?: string | null;
  /** Parent of each group's private diagnostics directory; defaults to the OS temp directory. */
  diagnosticsDirectory?: string;
  /** Name prefix of each diagnostics directory, for example one that names the run. */
  diagnosticsPrefix?: string;
  cancelSettleMs?: number;
  resultIdleMs?: number;
};

type ResolvedSettings = {
  diagnosticsDirectory: string | undefined;
  diagnosticsPrefix: string | undefined;
  cancelSettleMs: number;
  resultIdleMs: number;
};

type Outcome = { results: PiAgentResult[] } | { error: PiAgentGroupError };

/**
 * Runs Pi agent groups for the workflow runner. The runner is plain Node and cannot load the
 * packages that Pi supplies, so each group runs in its own headless pi child that loads the
 * agent group bridge. The child starts exactly like a headless agent step.
 */
export class HeadlessPiAgentGroupLauncher {
  private readonly active = new Set<HeadlessPiProcess>();
  private readonly bridgePath: string | null;
  private readonly settings: ResolvedSettings;
  private closed = false;
  private pruned: Promise<void> | undefined;

  constructor(
    private readonly options: HeadlessPiOptions,
    settings: HeadlessPiAgentGroupSettings = {},
  ) {
    this.bridgePath = settings.bridgePath === undefined ? BRIDGE_PATH : settings.bridgePath;
    this.settings = {
      diagnosticsDirectory: settings.diagnosticsDirectory,
      diagnosticsPrefix: settings.diagnosticsPrefix,
      cancelSettleMs: settings.cancelSettleMs ?? CANCEL_SETTLE_MS,
      resultIdleMs: settings.resultIdleMs ?? RESULT_IDLE_MS,
    };
  }

  readonly run = async (
    requests: PiAgentRequest[],
    options: PiAgentGroupLaunchOptions,
  ): Promise<PiAgentResult[]> => {
    // Before its first group, the launcher deletes expired diagnostics that earlier runs kept
    // or left.
    this.pruned ??= this.pruneDiagnostics();
    await this.pruned;
    if (options.signal.aborted) throw cancellationError(options.signal.reason);
    if (this.closed) {
      throw new PiAgentGroupError("group", "could not run", "the workflow runner is stopping");
    }
    if (this.bridgePath === null) {
      throw new PiAgentGroupError(
        "group",
        "could not run",
        "the pi-workflows agent group bridge is missing from this installation",
      );
    }
    try {
      availableHeadlessLaunch(this.options);
    } catch (error) {
      // The reason is Pi Workflows' own text with paths, so it follows the facts in full.
      throw new PiAgentGroupError("group", "could not run", "headless pi is unavailable", {
        notice: errorMessage(error),
      });
    }
    const call = new AgentGroupCall(
      this.bridgePath,
      this.options,
      this.settings,
      requests,
      options,
    );
    this.active.add(call.child);
    try {
      return await call.run();
    } finally {
      await this.cleanUp(call);
    }
  };

  /**
   * Stop the group's pi child and finish its diagnostics. Cleanup is housekeeping like pruning:
   * a failure is reported on the runner's stderr and never replaces the group's outcome.
   */
  private async cleanUp(call: AgentGroupCall): Promise<void> {
    try {
      await call.child.close();
    } catch (error) {
      reportHousekeeping("Could not stop an agent group's headless pi", error);
    }
    this.active.delete(call.child);
    try {
      await call.finishDiagnostics();
    } catch (error) {
      reportHousekeeping("Could not finish agent group diagnostics", error);
    }
  }

  /** Pruning is housekeeping: a failure is reported on the runner's stderr, never to the group. */
  private async pruneDiagnostics(): Promise<void> {
    await pruneAgentGroupDiagnostics(this.settings.diagnosticsDirectory, {
      onError: (target, error) => {
        reportHousekeeping(`Could not prune agent group diagnostics at ${target}`, error);
      },
    });
  }

  /** Stop every running group's pi child. Later groups fail instead of starting. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.active].map(async (child) => await child.close()));
  }
}

class AgentGroupCall {
  readonly child: HeadlessPiProcess;
  private readonly groupId = randomUUID();
  private readonly outcome = deferred<PiAgentResult[]>();
  private readonly diagnostics: AgentGroupDiagnostics;
  private readonly ledger: AgentLifecycleLedger;
  private lifecycleWork: Promise<void> = Promise.resolve();
  private ready = false;
  private cancelling = false;
  private settled = false;
  /** The group failed to run, so its stderr log is kept and named in the error. */
  private keepStderrLog = false;
  private cancelTimer: NodeJS.Timeout | undefined;
  private resultTimer: NodeJS.Timeout | undefined;

  constructor(
    bridgePath: string,
    launch: HeadlessPiOptions,
    private readonly settings: ResolvedSettings,
    private readonly requests: PiAgentRequest[],
    private readonly options: PiAgentGroupLaunchOptions,
  ) {
    this.diagnostics = new AgentGroupDiagnostics(
      settings.diagnosticsDirectory,
      settings.diagnosticsPrefix,
    );
    this.ledger = new AgentLifecycleLedger(requests);
    this.child = new HeadlessPiProcess(bridgePath, launch, {
      onStderrChunk: (chunk) => this.onStderrChunk(chunk),
      onStderrLine: (line) => this.onStderrLine(line),
      onStdoutLine: (line) => this.onStdoutLine(line),
      onExit: (exit) => this.onExit(exit),
    });
  }

  async run(): Promise<PiAgentResult[]> {
    const onAbort = () => this.cancel();
    this.options.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await this.diagnostics.open();
      try {
        await this.child.start();
      } catch (error) {
        // A lost claim or a parked run is the engine's own stop signal and keeps its type.
        if (isClaimLostError(error) || isRunParkedError(error)) {
          this.settled = true;
          throw error;
        }
        // Any other start failure can quote the operating system or the server, so its text
        // is private detail. The killed child cannot settle the group again.
        this.failToRun("headless pi could not be started", errorMessage(error));
      }
      if (this.options.signal.aborted) this.cancel();
      return await this.outcome.promise;
    } finally {
      this.options.signal.removeEventListener("abort", onAbort);
      this.clearTimers();
    }
  }

  /** Call after the child exits, so a kept stderr log holds the complete stream. */
  async finishDiagnostics(): Promise<void> {
    await this.diagnostics.finish(this.keepStderrLog);
  }

  private onStderrChunk(chunk: Buffer): void {
    this.diagnostics.write(chunk);
    if (this.resultTimer !== undefined) this.startResultTimer();
  }

  private onStderrLine(line: string): void {
    const event = decodeAgentGroupEvent(line);
    if (event?.type === "ready") this.sendRun();
    else if (event !== undefined && event.groupId === this.groupId) this.acceptGroupEvent(event);
  }

  private acceptGroupEvent(event: Exclude<AgentGroupEvent, { type: "ready" }>): void {
    // A settled group's outcome and terminal facts are final. Late events are ignored; when the
    // group's stderr log is kept (failures where pi could not run the group), they remain in it.
    if (this.settled) return;
    if (event.type === "lifecycle") this.forward(event.event);
    else if (event.type === "completed") this.finish({ results: event.results });
    else this.finish({ error: failureError(event.error) });
  }

  /** Pi answers the RPC prompt only after the bridge command returns, or when no command ran. */
  private onStdoutLine(line: string): void {
    const response = promptResponse(line, this.groupId);
    if (response === undefined || this.settled) return;
    if (response.error !== undefined) {
      this.recordRpcResponse(line);
      this.failToRun("pi rejected the agent group command", response.error);
    } else if (response.disposition !== "handled") {
      this.recordRpcResponse(line);
      this.failToRun(
        "pi did not route the agent group command to its bridge",
        `disposition ${String(response.disposition)}`,
      );
    } else {
      this.startResultTimer();
    }
  }

  private onExit(exit: HeadlessPiExit): void {
    if (this.settled) return;
    const stage = this.ready
      ? "headless pi exited before the agent group finished"
      : "headless pi exited before the agent group bridge loaded";
    // A spawn error is the operating system's text about pi; the exit status is a fact.
    if (exit.error === undefined) this.failToRun(`${stage} (${describeHeadlessPiExit(exit)})`);
    else this.failToRun(`${stage} (pi could not be started)`, exit.error);
  }

  private sendRun(): void {
    // A group cancelled before the bridge loaded has already settled.
    if (this.ready || this.settled) return;
    this.ready = true;
    this.child.write({
      id: this.groupId,
      type: "prompt",
      message: encodeAgentGroupPrompt({
        type: "run",
        groupId: this.groupId,
        requests: this.requests,
        options: runOptions(this.options),
      }),
    });
  }

  /** Ask the bridge to abort and settle its sessions, then stop waiting after the settle grace. */
  private cancel(): void {
    if (this.settled || this.cancelling) return;
    this.cancelling = true;
    const cancelled = () => this.finishUnconfirmed(cancellationError(this.options.signal.reason));
    if (!this.ready) {
      cancelled();
      return;
    }
    this.child.write({
      type: "prompt",
      message: encodeAgentGroupPrompt({
        type: "cancel",
        groupId: this.groupId,
        reason: cancellationReason(this.options.signal.reason),
      }),
    });
    this.cancelTimer = setTimeout(cancelled, this.settings.cancelSettleMs);
  }

  /** Keep Pi's complete answer in the log, because the error message never quotes Pi. */
  private recordRpcResponse(line: string): void {
    this.diagnostics.write(Buffer.from(`\n[pi-workflows] pi RPC response on stdout: ${line}\n`));
  }

  /**
   * Pi could not run the group. `facts` is Pi Workflows' own text; `detail` is text that Pi
   * or the operating system supplied, which only the cause file holds. The stderr log is kept
   * too, and the message names both files and the launch hint.
   */
  private failToRun(facts: string, detail?: string): void {
    // A cancelled group reports cancellation, so nothing would name the log.
    this.keepStderrLog = !this.options.signal.aborted;
    this.finishUnconfirmed(
      new PiAgentGroupError(
        "group",
        "could not run",
        facts,
        detail === undefined ? {} : { detail },
      ),
    );
  }

  /**
   * Settle a group whose bridge did not report its outcome. Every request without a terminal
   * fact gets one first, so its progress track ends.
   */
  private finishUnconfirmed(error: PiAgentGroupError): void {
    if (this.settled) return;
    const cancelled = this.cancelling || this.options.signal.aborted;
    const unsettled = cancelled
      ? this.ledger.unsettled("cancelled", "headless pi did not report that the session settled")
      : this.ledger.unsettled("failed", "headless pi stopped before the session finished");
    for (const event of unsettled) this.forward(event);
    this.finish({ error });
  }

  /** Forward one fact. A request's first terminal fact is its last, real or reported here. */
  private forward(event: PiAgentLifecycleEvent): void {
    if (this.ledger.isTerminal(event.id)) return;
    this.ledger.record(event);
    const onLifecycle = this.options.onLifecycle;
    if (onLifecycle === undefined) return;
    this.lifecycleWork = this.lifecycleWork
      .then(async () => await onLifecycle(event))
      .catch(() => undefined);
  }

  /**
   * Settle once, after forwarded lifecycle facts. A cancelled group always reports
   * cancellation; any other failure first saves its complete cause.
   */
  private finish(outcome: Outcome): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    const cancelled = this.options.signal.aborted;
    const final: Outcome = cancelled
      ? { error: cancellationError(this.options.signal.reason) }
      : outcome;
    void this.lifecycleWork.then(async () => {
      if ("results" in final) this.outcome.resolve(final.results);
      else this.outcome.reject(cancelled ? final.error : await this.withSavedCause(final.error));
    });
  }

  /**
   * The same error, naming the file that holds its complete cause. When pi could not run the
   * group, the message also names the kept stderr log and the launch hint. The message never
   * quotes the private detail, even when the cause file cannot be written.
   */
  private async withSavedCause(error: PiAgentGroupError): Promise<PiAgentGroupError> {
    const notices = [await this.diagnostics.saveCause(agentGroupCauseText(error))];
    if (this.keepStderrLog) notices.push(this.diagnostics.describeStderr());
    const located = notices.join("; ");
    return new PiAgentGroupError(error.agentId, error.code, error.facts, {
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      notice: this.keepStderrLog ? `${located}. ${LAUNCH_HINT}` : located,
    });
  }

  private startResultTimer(): void {
    clearTimeout(this.resultTimer);
    this.resultTimer = setTimeout(
      () => this.failToRun("the agent group bridge returned without a result"),
      this.settings.resultIdleMs,
    );
  }

  private clearTimers(): void {
    clearTimeout(this.cancelTimer);
    clearTimeout(this.resultTimer);
    this.cancelTimer = undefined;
    this.resultTimer = undefined;
  }
}

function runOptions(options: PiAgentGroupLaunchOptions): AgentGroupRunOptions {
  return {
    maxConcurrency: options.maxConcurrency,
    ...(options.failFast === undefined ? {} : { failFast: options.failFast }),
    ...(options.maxFinalChars === undefined ? {} : { maxFinalChars: options.maxFinalChars }),
    ...(options.behaviorExtensionPaths === undefined
      ? {}
      : { behaviorExtensionPaths: options.behaviorExtensionPaths }),
  };
}

function promptResponse(
  line: string,
  id: string,
): { error?: string; disposition?: unknown } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.type !== "response" || value.id !== id) return undefined;
  if (value.success !== true) return { error: String(value.error ?? "unknown error") };
  return { disposition: isRecord(value.data) ? value.data.disposition : undefined };
}

function failureError(failure: AgentGroupFailure): PiAgentGroupError {
  if (failure.agentId !== undefined && failure.code !== undefined && failure.facts !== undefined) {
    return new PiAgentGroupError(
      failure.agentId,
      failure.code,
      failure.facts,
      failure.detail === undefined ? {} : { detail: failure.detail },
    );
  }
  // Any other error, such as a Pi SDK, settings, or package manager failure while the group is
  // prepared, can quote text that Pi Workflows did not write, so all of it is private detail.
  return new PiAgentGroupError("group", "failed", "the agent group raised an error", {
    detail: failure.message,
  });
}

function reportHousekeeping(what: string, error: unknown): void {
  process.stderr.write(`${what}: ${errorMessage(error)}\n`);
}

function cancellationError(reason: unknown): PiAgentGroupError {
  return new PiAgentGroupError("group", "cancelled", cancellationReason(reason));
}

function cancellationReason(reason: unknown): string {
  return reason === undefined ? "operation cancelled" : errorMessage(reason);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // A failed start returns before anyone awaits the outcome.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
