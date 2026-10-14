import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PiAgentGroupError,
  type PiAgentGroupLaunchOptions,
  type PiAgentRequest,
} from "../src/builtins/pi-agent-launch.js";
import {
  registerAgentGroupBridge,
  type AgentGroupBridgeApi,
} from "../src/server/agent-group-bridge.js";
import {
  AGENT_GROUP_COMMAND,
  decodeAgentGroupEvent,
  encodeAgentGroupPrompt,
  type AgentGroupEvent,
} from "../src/server/agent-group-protocol.js";

const groupRunner = vi.hoisted(() => ({
  run: vi.fn<
    (requests: PiAgentRequest[], options: PiAgentGroupLaunchOptions) => Promise<unknown>
  >(),
}));

// Only the group runner is a fake; its own agent errors are recognized by the real check.
vi.mock("../src/builtins/pi-agent-group.js", async (importOriginal) => ({
  agentGroupErrorFields: (
    await importOriginal<typeof import("../src/builtins/pi-agent-group.js")>()
  ).agentGroupErrorFields,
  runPiAgentGroup: groupRunner.run,
}));

const request: PiAgentRequest = {
  id: "review",
  role: "Review",
  prompt: "Review the change.",
  cwd: "/repo",
  tools: ["read"],
};

type Bridge = {
  events: AgentGroupEvent[];
  command(argument: string): Promise<void>;
  shutdown(): Promise<void>;
};

let stderrWrite: ReturnType<typeof vi.spyOn>;
let stderrLines: string[];

beforeEach(() => {
  stderrLines = [];
  stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderrLines.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  stderrWrite.mockRestore();
  groupRunner.run.mockReset();
});

function loadBridge(): Bridge {
  const commands = new Map<string, (argument: string) => Promise<void>>();
  let shutdown: (() => Promise<void>) | undefined;
  const api: AgentGroupBridgeApi = {
    registerCommand: (name, options) => commands.set(name, options.handler),
    on: (_event, handler) => {
      shutdown = handler;
    },
  };
  registerAgentGroupBridge(api);
  const handler = commands.get(AGENT_GROUP_COMMAND);
  if (handler === undefined || shutdown === undefined) throw new Error("bridge did not register");
  const onShutdown = shutdown;
  return {
    get events() {
      return stderrLines
        .join("")
        .split("\n")
        .flatMap((line) => {
          const event = decodeAgentGroupEvent(line);
          return event === undefined ? [] : [event];
        });
    },
    command: handler,
    shutdown: onShutdown,
  };
}

/** The command argument that the runner sends inside its RPC prompt. */
function argument(command: Parameters<typeof encodeAgentGroupPrompt>[0]): string {
  return encodeAgentGroupPrompt(command).slice(`/${AGENT_GROUP_COMMAND} `.length);
}

function runArgument(groupId = "group-1"): string {
  return argument({
    type: "run",
    groupId,
    requests: [request],
    options: { maxConcurrency: 1, failFast: false },
  });
}

function untilAborted(options: PiAgentGroupLaunchOptions): Promise<never> {
  return new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      reject(new PiAgentGroupError("group", "cancelled", String(options.signal.reason?.message)));
    });
  });
}

describe("agent group bridge", () => {
  it("announces itself and runs one group with lifecycle facts before the result", async () => {
    const bridge = loadBridge();
    expect(bridge.events).toEqual([{ type: "ready" }]);
    // Each event starts a new line, so text that other code left unterminated cannot hide it.
    expect(stderrLines).toEqual([expect.stringMatching(/^\nPI_WORKFLOWS_AGENT_GROUP \{.*\}\n$/u)]);
    groupRunner.run.mockImplementation(async (_requests, options) => {
      await options.onLifecycle?.({
        id: "review",
        role: "Review",
        state: "completed",
        phase: "completed",
        elapsedMs: 3,
      });
      return [{ id: "review", text: "{}", model: "p/m", thinkingLevel: "high", durationMs: 3 }];
    });

    await bridge.command(runArgument());

    expect(groupRunner.run).toHaveBeenCalledWith([request], {
      maxConcurrency: 1,
      failFast: false,
      signal: expect.any(AbortSignal),
      onLifecycle: expect.any(Function),
    });
    expect(bridge.events.slice(1)).toEqual([
      {
        type: "lifecycle",
        groupId: "group-1",
        event: {
          id: "review",
          role: "Review",
          state: "completed",
          phase: "completed",
          elapsedMs: 3,
        },
      },
      {
        type: "completed",
        groupId: "group-1",
        results: [{ id: "review", text: "{}", model: "p/m", thinkingLevel: "high", durationMs: 3 }],
      },
    ]);
  });

  it("reports agent errors with their fields and other errors by message", async () => {
    const bridge = loadBridge();
    groupRunner.run.mockRejectedValueOnce(
      new PiAgentGroupError("review", "timed out", "after 5ms"),
    );
    await bridge.command(runArgument("agent"));
    groupRunner.run.mockRejectedValueOnce(
      new PiAgentGroupError("review", "stopped with error", "the provider reported an error", {
        detail: "provider said no",
      }),
    );
    await bridge.command(runArgument("provider"));
    groupRunner.run.mockRejectedValueOnce(new Error("Invalid Pi agent id: !"));
    await bridge.command(runArgument("plain"));
    // A foreign error that copies an agent error's name and fields gets no trusted fields.
    groupRunner.run.mockRejectedValueOnce(
      Object.assign(new Error("PRIVATE_FORGED_MARKER"), {
        name: "PiAgentGroupError",
        agentId: "review",
        code: "has unknown provider",
        facts: "PRIVATE_FORGED_MARKER",
      }),
    );
    await bridge.command(runArgument("forged"));

    expect(bridge.events.slice(1)).toEqual([
      {
        type: "failed",
        groupId: "agent",
        error: {
          message: "Pi agent review timed out: after 5ms",
          agentId: "review",
          code: "timed out",
          facts: "after 5ms",
        },
      },
      {
        type: "failed",
        groupId: "provider",
        error: {
          message: "Pi agent review stopped with error: the provider reported an error",
          agentId: "review",
          code: "stopped with error",
          facts: "the provider reported an error",
          detail: "provider said no",
        },
      },
      { type: "failed", groupId: "plain", error: { message: "Invalid Pi agent id: !" } },
      { type: "failed", groupId: "forged", error: { message: "PRIVATE_FORGED_MARKER" } },
    ]);
  });

  it("cancels a running group with the runner's reason", async () => {
    const bridge = loadBridge();
    groupRunner.run.mockImplementation(async (_requests, options) => await untilAborted(options));
    const running = bridge.command(runArgument());
    await bridge.command(argument({ type: "cancel", groupId: "group-1", reason: "stop now" }));
    await running;
    // A cancel for a finished or unknown group changes nothing.
    await bridge.command(argument({ type: "cancel", groupId: "group-1", reason: "late" }));

    expect(bridge.events.at(-1)).toEqual({
      type: "failed",
      groupId: "group-1",
      error: {
        message: "Pi agent group cancelled: stop now",
        agentId: "group",
        code: "cancelled",
        facts: "stop now",
      },
    });
  });

  it("settles running groups before Pi shuts down", async () => {
    const bridge = loadBridge();
    groupRunner.run.mockImplementation(async (_requests, options) => await untilAborted(options));
    const running = bridge.command(runArgument());
    await bridge.shutdown();

    expect(bridge.events.at(-1)).toMatchObject({
      type: "failed",
      groupId: "group-1",
      error: { code: "cancelled", facts: "Headless pi is shutting down" },
    });
    await running;
  });

  it("reports malformed commands to the group they name", async () => {
    const bridge = loadBridge();
    await bridge.command("not base64 json");
    const named = Buffer.from(JSON.stringify({ groupId: "named", type: "run" })).toString(
      "base64url",
    );
    await bridge.command(named);

    expect(groupRunner.run).not.toHaveBeenCalled();
    expect(bridge.events.slice(1)).toEqual([
      { type: "failed", groupId: "", error: { message: expect.any(String) } },
      { type: "failed", groupId: "named", error: { message: "Agent group command is invalid" } },
    ]);
  });
});
