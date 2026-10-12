import { randomUUID } from "node:crypto";
import {
  PiAgentGroupError,
  type PiAgentGroupLaunchOptions,
  type PiAgentLifecycleEvent,
  type PiAgentRequest,
  type PiAgentResult,
} from "../builtins/pi-agent-launch.js";
import { errorMessage } from "../workflows/errors.js";
import {
  decodeAgentGroupEvent,
  encodeAgentGroupPrompt,
  type AgentGroupEvent,
  type AgentGroupFailure,
  type AgentGroupRunOptions,
} from "./agent-group-protocol.js";
import {
  abortGraceMs,
  describeHeadlessPiExit,
  HeadlessPiProcess,
  packagedExtensionPath,
  type HeadlessPiExit,
  type HeadlessPiOptions,
} from "./headless-pi.js";

const BRIDGE_PATH = packagedExtensionPath(import.meta.url, "agent-group-bridge") ?? null;
// Pi startup failures are diagnosed from the last stderr lines. The complete stream is not
// retained, so a long run cannot grow memory without bound.
const DIAGNOSTIC_LINES = 20;
const LAUNCH_HINT =
  "The workflow runner starts agent groups with the same `pi` command, arguments, and environment as headless workflow steps; check that this command runs on the workflow server";

type Outcome = { results: PiAgentResult[] } | { error: Error };

/**
 * Runs Pi agent groups for the workflow runner. The runner is plain Node and cannot load the
 * packages that Pi supplies, so each group runs in its own headless pi child that loads the
 * agent group bridge. The child starts exactly like a headless agent step.
 */
export class HeadlessPiAgentGroupLauncher {
  private readonly active = new Set<HeadlessPiProcess>();
  private closed = false;

  constructor(
    private readonly options: HeadlessPiOptions,
    private readonly bridgePath: string | null = BRIDGE_PATH,
  ) {}

  readonly run = async (
    requests: PiAgentRequest[],
    options: PiAgentGroupLaunchOptions,
  ): Promise<PiAgentResult[]> => {
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
    const call = new AgentGroupCall(this.bridgePath, this.options, requests, options);
    this.active.add(call.child);
    try {
      return await call.run();
    } finally {
      await call.child.close();
      this.active.delete(call.child);
    }
  };

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
  private readonly diagnostics: string[] = [];
  private lifecycleWork: Promise<void> = Promise.resolve();
  private ready = false;
  private cancelling = false;
  private settled = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    bridgePath: string,
    private readonly launch: HeadlessPiOptions,
    private readonly requests: PiAgentRequest[],
    private readonly options: PiAgentGroupLaunchOptions,
  ) {
    this.child = new HeadlessPiProcess(bridgePath, launch, {
      onStderrLine: (line) => this.onStderrLine(line),
      onStdoutLine: (line) => this.onStdoutLine(line),
      onExit: (exit) => this.onExit(exit),
    });
  }

  async run(): Promise<PiAgentResult[]> {
    const onAbort = () => this.cancel();
    this.options.signal.addEventListener("abort", onAbort, { once: true });
    try {
      try {
        await this.child.start();
      } catch (error) {
        // The start failure is the outcome; the killed child must not settle again.
        this.settled = true;
        throw error;
      }
      if (this.options.signal.aborted) this.cancel();
      return await this.outcome.promise;
    } finally {
      this.options.signal.removeEventListener("abort", onAbort);
      clearTimeout(this.timer);
    }
  }

  private onStderrLine(line: string): void {
    const event = decodeAgentGroupEvent(line);
    if (event === undefined) {
      this.remember(line);
    } else if (event.type === "ready") {
      this.sendRun();
    } else if (event.groupId === this.groupId) {
      this.acceptGroupEvent(event);
    }
  }

  private acceptGroupEvent(event: Exclude<AgentGroupEvent, { type: "ready" }>): void {
    if (event.type === "lifecycle") this.forward(event.event);
    else if (event.type === "completed") this.finish({ results: event.results });
    else this.finish({ error: failureError(event.error) });
  }

  /** Pi answers the RPC prompt only after the bridge command returns, or when no command ran. */
  private onStdoutLine(line: string): void {
    const response = promptResponse(line, this.groupId);
    if (response === undefined || this.settled) return;
    if (response.error !== undefined) {
      this.finish({ error: runFailure(`pi rejected the agent group command: ${response.error}`) });
    } else if (response.disposition !== "handled") {
      this.finish({
        error: runFailure(
          `pi did not route the agent group command to its bridge (disposition ${String(response.disposition)})`,
        ),
      });
    } else {
      // The bridge writes its final event before its command returns, but stderr and
      // stdout are separate pipes. Allow the event to arrive before declaring it missing.
      this.restartTimer(() =>
        this.finish({ error: runFailure("the agent group bridge returned without a result") }),
      );
    }
  }

  private onExit(exit: HeadlessPiExit): void {
    if (this.settled) return;
    const stage = this.ready
      ? "headless pi exited before the agent group finished"
      : "headless pi exited before the agent group bridge loaded";
    this.finish({ error: runFailure(`${stage} (${describeHeadlessPiExit(exit)})`) });
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

  /** Ask the bridge to abort and settle its sessions, then give up after the grace period. */
  private cancel(): void {
    if (this.settled || this.cancelling) return;
    this.cancelling = true;
    if (!this.ready) {
      this.finish({ error: cancellationError(this.options.signal.reason) });
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
    this.restartTimer(() => this.finish({ error: cancellationError(this.options.signal.reason) }));
  }

  private forward(event: PiAgentLifecycleEvent): void {
    const onLifecycle = this.options.onLifecycle;
    if (onLifecycle === undefined) return;
    this.lifecycleWork = this.lifecycleWork
      .then(async () => await onLifecycle(event))
      .catch(() => undefined);
  }

  /** Settle once, after forwarded lifecycle facts. A cancelled group always reports cancellation. */
  private finish(outcome: Outcome): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    const final: Outcome = this.options.signal.aborted
      ? { error: cancellationError(this.options.signal.reason) }
      : outcome;
    void this.lifecycleWork.then(() => {
      if ("results" in final) this.outcome.resolve(final.results);
      else this.outcome.reject(withDiagnostics(final.error, this.diagnostics));
    });
  }

  private restartTimer(onTimeout: () => void): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(onTimeout, abortGraceMs(this.launch));
  }

  private remember(line: string): void {
    const text = line.trim();
    if (text.length === 0) return;
    this.diagnostics.push(text);
    if (this.diagnostics.length > DIAGNOSTIC_LINES) this.diagnostics.shift();
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

function failureError(failure: AgentGroupFailure): Error {
  if (failure.agentId !== undefined && failure.code !== undefined && failure.detail !== undefined) {
    return new PiAgentGroupError(failure.agentId, failure.code, failure.detail);
  }
  return new Error(failure.message);
}

function runFailure(detail: string): PiAgentGroupError {
  return new PiAgentGroupError("group", "could not run", `${detail}. ${LAUNCH_HINT}`);
}

function withDiagnostics(error: Error, diagnostics: string[]): Error {
  if (
    !(error instanceof PiAgentGroupError) ||
    error.code !== "could not run" ||
    diagnostics.length === 0
  ) {
    return error;
  }
  return new PiAgentGroupError(
    error.agentId,
    error.code,
    `${error.detail}. pi stderr: ${diagnostics.join(" | ")}`,
  );
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
