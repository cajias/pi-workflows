import type {
  PiAgentLifecycleEvent,
  PiAgentRequest,
  PiAgentResult,
} from "../builtins/pi-agent-launch.js";

/**
 * Wire format between the workflow runner and the agent group bridge inside headless pi.
 *
 * The runner sends commands as the argument of one extension command in a pi RPC `prompt`,
 * so pi hands them to the bridge without a model turn. The bridge answers with stderr lines.
 * Every event after `ready` carries the run's random `groupId`; the runner ignores other lines,
 * so text that a model or tool writes to stderr cannot settle the group.
 */
export const AGENT_GROUP_COMMAND = "pi-workflows-agent-group";
export const AGENT_GROUP_EVENT_PREFIX = "PI_WORKFLOWS_AGENT_GROUP ";
const COMMAND_SCHEMA = "pi-workflows.agent-group-command.v1";
const EVENT_SCHEMA = "pi-workflows.agent-group-event.v1";

export type AgentGroupRunOptions = {
  maxConcurrency: number;
  failFast?: boolean;
  maxFinalChars?: number;
  behaviorExtensionPaths?: string[];
};

export type AgentGroupCommand =
  | {
      type: "run";
      groupId: string;
      requests: PiAgentRequest[];
      options: AgentGroupRunOptions;
    }
  | { type: "cancel"; groupId: string; reason: string };

/**
 * A failed group. Agent errors keep their fields so the runner rebuilds the same error. The
 * `message` of any other error, and an agent error's `detail`, can quote provider, SDK, or Pi
 * text, so the runner keeps them out of its error message.
 */
export type AgentGroupFailure = {
  message: string;
  agentId?: string;
  code?: string;
  facts?: string;
  detail?: string;
};

export type AgentGroupEvent =
  | { type: "ready" }
  | { type: "lifecycle"; groupId: string; event: PiAgentLifecycleEvent }
  | { type: "completed"; groupId: string; results: PiAgentResult[] }
  | { type: "failed"; groupId: string; error: AgentGroupFailure };

/** The RPC prompt text that invokes the bridge command. */
export function encodeAgentGroupPrompt(command: AgentGroupCommand): string {
  const payload = Buffer.from(JSON.stringify({ schema: COMMAND_SCHEMA, ...command }), "utf8");
  return `/${AGENT_GROUP_COMMAND} ${payload.toString("base64url")}`;
}

/** Decode the bridge command argument. Malformed input throws. */
export function decodeAgentGroupCommand(argument: string): AgentGroupCommand {
  const value = decodePayload(argument);
  if (value.schema !== COMMAND_SCHEMA || typeof value.groupId !== "string") {
    throw new Error("Agent group command is invalid");
  }
  if (value.type === "cancel" && typeof value.reason === "string") {
    return { type: "cancel", groupId: value.groupId, reason: value.reason };
  }
  if (value.type === "run" && Array.isArray(value.requests) && isRunOptions(value.options)) {
    return {
      type: "run",
      groupId: value.groupId,
      requests: value.requests as PiAgentRequest[],
      options: value.options,
    };
  }
  throw new Error("Agent group command is invalid");
}

/** The group named by a command argument, when the argument carries one. */
export function agentGroupIdOf(argument: string): string | undefined {
  try {
    const groupId = decodePayload(argument).groupId;
    return typeof groupId === "string" ? groupId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One stderr record. The leading newline ends any partial line that other code in the Pi
 * process wrote first, so that text cannot hide the event prefix.
 */
export function encodeAgentGroupEvent(event: AgentGroupEvent): string {
  return `\n${AGENT_GROUP_EVENT_PREFIX}${JSON.stringify({ schema: EVENT_SCHEMA, ...event })}\n`;
}

/** Decode one stderr line. Lines that are not valid bridge events return undefined. */
export function decodeAgentGroupEvent(line: string): AgentGroupEvent | undefined {
  if (!line.startsWith(AGENT_GROUP_EVENT_PREFIX)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(AGENT_GROUP_EVENT_PREFIX.length));
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.schema !== EVENT_SCHEMA) return undefined;
  if (value.type === "ready") return { type: "ready" };
  if (typeof value.groupId !== "string") return undefined;
  return groupEvent(value.groupId, value);
}

/**
 * Describe a failure for the runner. `fields` are the facts of an agent error that the group
 * runner raised itself, from `agentGroupErrorFields`; without them the runner treats the whole
 * failure as private text.
 */
export function describeAgentGroupFailure(
  error: unknown,
  fields?: { agentId: string; code: string; facts: string; detail?: string },
): AgentGroupFailure {
  const message = error instanceof Error ? error.message : String(error);
  return fields === undefined ? { message } : { message, ...fields };
}

function groupEvent(groupId: string, value: Record<string, unknown>): AgentGroupEvent | undefined {
  if (value.type === "lifecycle" && isLifecycleEvent(value.event)) {
    return { type: "lifecycle", groupId, event: value.event };
  }
  if (value.type === "completed" && Array.isArray(value.results) && value.results.every(isResult)) {
    return { type: "completed", groupId, results: value.results };
  }
  if (value.type === "failed" && isFailure(value.error)) {
    return { type: "failed", groupId, error: value.error };
  }
  return undefined;
}

function decodePayload(argument: string): Record<string, unknown> {
  const value = JSON.parse(Buffer.from(argument.trim(), "base64url").toString("utf8")) as unknown;
  if (!isRecord(value)) throw new Error("Agent group command is invalid");
  return value;
}

function isRunOptions(value: unknown): value is AgentGroupRunOptions {
  return isRecord(value) && typeof value.maxConcurrency === "number";
}

function isLifecycleEvent(value: unknown): value is PiAgentLifecycleEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.role === "string" &&
    ["running", "completed", "failed", "cancelled"].includes(String(value.state)) &&
    typeof value.phase === "string" &&
    typeof value.elapsedMs === "number"
  );
}

function isResult(value: unknown): value is PiAgentResult {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    typeof value.model === "string" &&
    typeof value.thinkingLevel === "string" &&
    typeof value.durationMs === "number"
  );
}

function isFailure(value: unknown): value is AgentGroupFailure {
  return isRecord(value) && typeof value.message === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
