/**
 * Host-independent contract for isolated Pi agent groups.
 *
 * Built-in workflow actions run in the plain Node workflow runner. That process cannot load
 * the packages that Pi supplies only to code it loads itself, so this module never imports
 * them. The runner installs a launcher that runs each group inside a headless Pi process, where
 * `pi-agent-group.ts` creates the child sessions through the Pi SDK.
 */

export type PiAgentTool = "read" | "grep" | "find" | "ls";
export type PiAgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type PiAgentRequest = {
  id: string;
  role: string;
  prompt: string;
  cwd: string;
  tools: PiAgentTool[];
  timeoutMs?: number;
  model?: { provider: string; id: string };
  thinkingLevel?: PiAgentThinkingLevel;
};

export type PiAgentResult = {
  id: string;
  text: string;
  model: string;
  thinkingLevel: PiAgentThinkingLevel;
  durationMs: number;
};

export type PiAgentLifecycleState = "running" | "completed" | "failed" | "cancelled";

export type PiAgentLifecycleEvent = {
  id: string;
  role: string;
  state: PiAgentLifecycleState;
  phase: string;
  elapsedMs: number;
  model?: string;
  thinkingLevel?: PiAgentThinkingLevel;
};

/** Options that a launcher carries to the process that runs the group. */
export type PiAgentGroupLaunchOptions = {
  maxConcurrency: number;
  signal: AbortSignal;
  failFast?: boolean;
  maxFinalChars?: number;
  onLifecycle?: (event: PiAgentLifecycleEvent) => void | Promise<void>;
  behaviorExtensionPaths?: string[];
};

export type PiAgentGroupLauncher = (
  requests: PiAgentRequest[],
  options: PiAgentGroupLaunchOptions,
) => Promise<PiAgentResult[]>;

const MAX_ERROR_CHARS = 2_000;

export class PiAgentGroupError extends Error {
  constructor(
    readonly agentId: string,
    readonly code: string,
    /** Unbounded cause text; the message bounds it. Launchers send it to rebuild the same error. */
    readonly detail: string,
  ) {
    super(`Pi agent ${agentId} ${code}: ${boundedErrorText(detail)}`);
    this.name = "PiAgentGroupError";
  }
}

export function boundedErrorText(value: string): string {
  const text = value.trim() || "unknown failure";
  return text.length <= MAX_ERROR_CHARS ? text : `${text.slice(0, MAX_ERROR_CHARS)}…`;
}

let installedLauncher: PiAgentGroupLauncher | undefined;

/** Install the process-wide launcher, or remove it with `undefined`. The workflow runner owns it. */
export function setPiAgentGroupLauncher(launcher: PiAgentGroupLauncher | undefined): void {
  installedLauncher = launcher;
}

/** Run one isolated agent group through the installed launcher. */
export async function launchPiAgentGroup(
  requests: PiAgentRequest[],
  options: PiAgentGroupLaunchOptions,
): Promise<PiAgentResult[]> {
  if (installedLauncher === undefined) {
    throw new PiAgentGroupError(
      "group",
      "could not run",
      "this process cannot start Pi agent sessions; run the workflow through the pi-workflows server",
    );
  }
  return await installedLauncher(requests, options);
}
