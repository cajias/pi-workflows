import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runPiAgentGroup } from "../builtins/pi-agent-group.js";
import {
  AGENT_GROUP_COMMAND,
  agentGroupIdOf,
  decodeAgentGroupCommand,
  describeAgentGroupFailure,
  encodeAgentGroupEvent,
  type AgentGroupCommand,
  type AgentGroupEvent,
} from "./agent-group-protocol.js";

type RunCommand = Extract<AgentGroupCommand, { type: "run" }>;

/** The part of the Pi extension API that the bridge uses. */
export type AgentGroupBridgeApi = {
  registerCommand(
    name: string,
    options: { description: string; handler: (argument: string) => Promise<void> },
  ): void;
  on(event: "session_shutdown", handler: () => Promise<void>): unknown;
};

/**
 * Loaded into a headless `pi --mode rpc` child that the workflow runner starts for one Pi
 * agent group. Pi loads this module with its own module mapping, so the group creates child
 * sessions through the Pi SDK exactly as it would inside a Pi session. The runner sends the
 * group as the argument of an extension command, which pi handles without a model turn, and
 * the bridge reports lifecycle facts and the final result over stderr.
 */
export default function piWorkflowsAgentGroupBridge(pi: ExtensionAPI): void {
  registerAgentGroupBridge(pi);
}

export function registerAgentGroupBridge(pi: AgentGroupBridgeApi): void {
  const groups = new Map<string, AbortController>();
  const running = new Set<Promise<void>>();

  pi.registerCommand(AGENT_GROUP_COMMAND, {
    description: "Run one Pi Workflows agent group for the workflow runner",
    handler: async (argument) => {
      let command: AgentGroupCommand;
      try {
        command = decodeAgentGroupCommand(argument);
      } catch (error) {
        emit({
          type: "failed",
          groupId: agentGroupIdOf(argument) ?? "",
          error: describeAgentGroupFailure(error),
        });
        return;
      }
      if (command.type === "cancel") {
        groups.get(command.groupId)?.abort(new Error(command.reason));
        return;
      }
      const work = runGroup(command, groups);
      running.add(work);
      try {
        await work;
      } finally {
        running.delete(work);
      }
    },
  });

  // Pi shuts down when the runner closes stdin or stops the process. Settle active
  // sessions before Pi disposes its runtime.
  pi.on("session_shutdown", async () => {
    for (const controller of groups.values()) {
      controller.abort(new Error("Headless pi is shutting down"));
    }
    await Promise.all(running);
  });

  emit({ type: "ready" });
}

async function runGroup(command: RunCommand, groups: Map<string, AbortController>): Promise<void> {
  const controller = new AbortController();
  groups.set(command.groupId, controller);
  try {
    const results = await runPiAgentGroup(command.requests, {
      ...command.options,
      signal: controller.signal,
      onLifecycle: (event) => emit({ type: "lifecycle", groupId: command.groupId, event }),
    });
    emit({ type: "completed", groupId: command.groupId, results });
  } catch (error) {
    emit({ type: "failed", groupId: command.groupId, error: describeAgentGroupFailure(error) });
  } finally {
    groups.delete(command.groupId);
  }
}

function emit(event: AgentGroupEvent): void {
  process.stderr.write(encodeAgentGroupEvent(event));
}
