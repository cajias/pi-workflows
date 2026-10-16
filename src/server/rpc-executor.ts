import { errorMessage } from "../workflows/errors.js";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
} from "../workflows/types.js";
import {
  describeHeadlessPiExit,
  HeadlessPiProcess,
  packagedExtensionPath,
  type HeadlessPiOptions,
} from "./headless-pi.js";
import { decodeRpcModelError, RPC_SUBMISSION_PREFIX } from "./rpc-protocol.js";

const BRIDGE_PATH = packagedExtensionPath(import.meta.url, "rpc-bridge");
/**
 * How long an exited child's stderr may take to deliver its last lines, such as the bridge's
 * model error. The bound covers a descendant that keeps the pipe open after the child exits.
 */
const STDERR_DRAIN_MS = 1_000;

type StepSubmission = {
  action: "submit";
  requestId: string;
  output: unknown;
};

type StepUpdate = {
  action: "update";
  requestId: string;
  update: { type: string; key: string; data: Record<string, unknown> };
  idempotencyKey?: string;
};

type StepAction = StepSubmission | StepUpdate;

export type RpcStepExecutorOptions = HeadlessPiOptions & {
  /** Park assistant-message nodes for a visible origin session. */
  assistantMessageMode?: "park";
};

/**
 * Runs agent steps in a headless `pi --mode rpc` child. One child serves one
 * workflow run. The rpc-bridge extension inside the child registers the
 * `workflow` tool and reports submissions over stderr; this executor
 * validates them through `request.accept` and re-prompts on rejection, so
 * the model sees the same tool contract as an in-session run.
 */
export class RpcStepExecutor implements AgentStepExecutor {
  readonly assistantMessageMode: "park" | "unsupported";
  private readonly options: RpcStepExecutorOptions;
  private child: HeadlessPiProcess | null = null;
  private actions: StepAction[] = [];
  private submissionWaiters: Array<() => void> = [];
  private closePromise: Promise<void> | null = null;
  /** Why the bridge stopped the child before any model request, when it did. */
  private modelError: string | null = null;
  private stderrDrain: Promise<void> | null = null;

  constructor(options: RpcStepExecutorOptions) {
    this.options = options;
    this.assistantMessageMode = options.assistantMessageMode ?? "unsupported";
  }

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    await this.ensureStarted();
    let prompt = request.prompt;
    for (;;) {
      throwIfAborted(signal);
      const submission = await this.promptForSubmission(prompt, request, signal);
      const accepted = await request.accept(submission.output);
      if (accepted.ok) {
        return { output: accepted.value };
      }
      prompt = [
        `The workflow rejected your submission for step ${JSON.stringify(request.contract.nodeId)}:`,
        accepted.error,
        "",
        "Call the `workflow` tool again with a corrected output.",
      ].join("\n");
    }
  }

  /** Stop the child process tree, then unregister its exact group leader. */
  async close(): Promise<void> {
    this.closePromise ??= this.closeChild();
    await this.closePromise;
  }

  private async closeChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    await child?.close();
  }

  private async ensureStarted(): Promise<void> {
    if (this.closePromise !== null) throw new Error("Headless pi session is closed");
    if (this.modelError !== null) throw new Error(this.modelError);
    if (this.child !== null) {
      const exited = this.child.currentExit();
      if (exited !== null) {
        throw await this.exitError(
          this.child,
          `Headless pi session exited (${describeHeadlessPiExit(exited)})`,
        );
      }
      return;
    }
    if (BRIDGE_PATH === undefined) {
      throw new Error("The pi-workflows rpc-bridge extension is missing from this installation");
    }
    const child = new HeadlessPiProcess(BRIDGE_PATH, this.options, {
      onStderrLine: (line) => this.acceptStderrLine(line),
      onExit: () => this.wakeSubmissionWaiters(),
    });
    this.child = child;
    try {
      await child.start();
    } catch (error) {
      this.child = null;
      throw error;
    }
  }

  /** The bridge's model error, or the exit itself, once stderr has delivered its last line. */
  private async exitError(child: HeadlessPiProcess, exitMessage: string): Promise<Error> {
    this.stderrDrain ??= child.stderrDrained(STDERR_DRAIN_MS);
    await this.stderrDrain;
    return new Error(this.modelError ?? exitMessage);
  }

  private acceptStderrLine(line: string): void {
    const modelError = decodeRpcModelError(line);
    if (modelError !== undefined) {
      this.modelError ??= modelError;
      this.wakeSubmissionWaiters();
      return;
    }
    this.acceptSubmissionLine(line);
  }

  private acceptSubmissionLine(line: string): void {
    if (!line.startsWith(RPC_SUBMISSION_PREFIX)) return;
    try {
      const parsed = JSON.parse(line.slice(RPC_SUBMISSION_PREFIX.length)) as StepAction;
      if (
        (parsed.action === "submit" || parsed.action === "update") &&
        typeof parsed.requestId === "string"
      ) {
        this.actions.push(parsed);
      }
    } catch {
      // A malformed marker line is ignored; the step times out instead.
    }
    this.wakeSubmissionWaiters();
  }

  private async promptForSubmission(
    prompt: string,
    request: AgentStepRequest,
    signal: AbortSignal,
  ): Promise<StepSubmission> {
    const child = this.child;
    if (child === null || child.currentExit() !== null) {
      throw new Error("Headless pi session is not running");
    }
    child.write({ type: "prompt", message: prompt });
    for (;;) {
      throwIfAborted(signal);
      if (this.modelError !== null) throw new Error(this.modelError);
      const exited = child.currentExit();
      if (exited !== null) {
        throw await this.exitError(
          child,
          `Headless pi session exited mid-step (code ${exited.code})`,
        );
      }
      const found = this.takeMatchingAction(request);
      if (found?.action === "submit") return found;
      if (found?.action === "update") {
        if (request.publishUpdate === undefined) {
          throw new Error("This workflow server does not support step updates");
        }
        try {
          await request.publishUpdate(found.update, found.idempotencyKey);
        } catch (error) {
          child.write({
            type: "prompt",
            message: `Workflow update rejected: ${errorMessage(error)}. Correct the update and continue the same step.`,
          });
        }
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          this.sendAbortQuietly();
          reject(signal.reason ?? new Error("Workflow step aborted"));
        };
        this.submissionWaiters.push(waiter);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  private takeMatchingAction(request: AgentStepRequest): StepAction | undefined {
    const index = this.actions.findIndex(
      (candidate) => candidate.requestId === request.contract.requestId,
    );
    return index === -1 ? undefined : (this.actions.splice(index, 1)[0] as StepAction);
  }

  private sendAbortQuietly(): void {
    this.child?.write({ type: "abort" });
  }

  private wakeSubmissionWaiters(): void {
    const waiters = this.submissionWaiters;
    this.submissionWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw (signal.reason as unknown) ?? new Error("Workflow step aborted");
  }
}
