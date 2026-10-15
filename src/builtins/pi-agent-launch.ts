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

export type PiAgentGroupErrorOptions = {
  /**
   * The complete cause when it holds text that Pi Workflows did not write, such as a provider
   * error, a thrown SDK error, or Pi's own output. The message never contains it.
   */
  detail?: string;
  /** Text from Pi Workflows that follows the facts, such as where the complete cause is saved. */
  notice?: string;
};

/**
 * A failed agent or agent group. Its message holds only the error code, the agent ID, and
 * safe operational facts that Pi Workflows writes itself: fixed text, provider and model IDs,
 * counts, and paths. The message reaches workflow state, traces, `piw`, and the post-workflow
 * model turn, and Sanity Check lets only safe operational facts leave a child session. Text
 * that a provider, an SDK, or Pi produced stays in `detail`; the workflow runner saves it
 * to a private cause file and names that file in `notice`.
 */
export class PiAgentGroupError extends Error {
  readonly detail: string | undefined;
  readonly notice: string | undefined;

  constructor(
    readonly agentId: string,
    readonly code: string,
    /** Safe operational facts from Pi Workflows. Never provider, SDK, or Pi output. */
    readonly facts: string,
    options: PiAgentGroupErrorOptions = {},
  ) {
    super(
      `Pi agent ${agentId} ${code}: ${facts}${options.notice === undefined ? "" : `. ${options.notice}`}`,
    );
    this.name = "PiAgentGroupError";
    this.detail = options.detail;
    this.notice = options.notice;
  }
}

// The workflow loader evaluates user workflow files with a fresh copy of the built-in modules,
// so a module-level variable would hide the runner's launcher from built-in nodes that a user
// workflow reuses. One registered-symbol slot on `globalThis` is shared by every copy.
const LAUNCHER_SLOT = Symbol.for("pi-workflows.pi-agent-group-launcher");
type LauncherSlot = { [LAUNCHER_SLOT]?: PiAgentGroupLauncher };
const launcherSlot: typeof globalThis & LauncherSlot = globalThis;

/** Install the process-wide launcher, or remove it with `undefined`. The workflow runner owns it. */
export function setPiAgentGroupLauncher(launcher: PiAgentGroupLauncher | undefined): void {
  if (launcher === undefined) delete launcherSlot[LAUNCHER_SLOT];
  else launcherSlot[LAUNCHER_SLOT] = launcher;
}

/** Run one isolated agent group through the installed launcher. */
export async function launchPiAgentGroup(
  requests: PiAgentRequest[],
  options: PiAgentGroupLaunchOptions,
): Promise<PiAgentResult[]> {
  const installedLauncher = launcherSlot[LAUNCHER_SLOT];
  if (installedLauncher === undefined) {
    throw new PiAgentGroupError(
      "group",
      "could not run",
      "this process cannot start Pi agent sessions; run the workflow through the pi-workflows server",
    );
  }
  return await installedLauncher(requests, options);
}
