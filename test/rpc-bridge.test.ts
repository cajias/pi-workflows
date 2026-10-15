import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerRpcBridge,
  type RpcBridgeApi,
  type RpcBridgeSessionContext,
} from "../src/server/rpc-bridge.js";
import { RPC_SUBMISSION_PREFIX } from "../src/server/rpc-protocol.js";
import { makeTempDir } from "./helpers.js";

type Model = { provider: string; id: string };
type Settings = { defaultProvider?: string; defaultModel?: string; enabledModels?: string[] };

const FALLBACK: Model = { provider: "fallback", id: "fallback-model" };
const CUSTOM: Model = { provider: "custom", id: "custom-model" };
const PI_ARGS = ["--mode", "rpc", "--no-session", "--no-extensions", "-e", "/bridge.ts"];

type Tool = {
  name: string;
  execute(toolCallId: string, params: unknown): Promise<{ content: Array<{ text: string }> }>;
};

let agentDir: string;
let project: string;
let stderrLines: string[];
let stderrWrite: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  const root = await makeTempDir("rpc-bridge");
  agentDir = path.join(root, "agent");
  project = path.join(root, "project");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(path.join(project, ".pi"), { recursive: true });
  stderrLines = [];
  stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderrLines.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  stderrWrite.mockRestore();
});

async function writeSettings(file: string, settings: Settings): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(settings)}\n`, "utf8");
}

/**
 * Load the bridge with `settings` as the session's effective settings, then start a session
 * on `selected` with a catalog of `models`, all authenticated.
 */
function startSession(options: {
  settings: Settings | Error;
  selected?: Model;
  models?: Model[];
  /** The scope that Pi resolved from `--models` or `enabledModels`. */
  scoped?: Model[];
  argv?: string[];
  projectTrusted?: boolean;
}): { stops: string[]; starts: number; tools: Tool[] } {
  const stops: string[] = [];
  let starts = 0;
  const tools: Tool[] = [];
  let sessionStart: ((event: unknown, ctx: RpcBridgeSessionContext) => void) | undefined;
  const api = {
    registerTool: (tool: unknown) => tools.push(tool as Tool),
    getSettings: () => {
      if (options.settings instanceof Error) throw options.settings;
      return options.settings;
    },
    on: (_event: "session_start", handler: typeof sessionStart) => {
      sessionStart = handler;
      return () => {};
    },
  } as unknown as RpcBridgeApi;
  registerRpcBridge(api, {
    argv: options.argv ?? PI_ARGS,
    agentDir,
    stop: (error) => stops.push(error),
    started: () => {
      starts += 1;
    },
  });
  const models = options.models ?? [FALLBACK];
  const registry = {
    find: (provider: string, id: string) =>
      models.find((model) => model.provider === provider && model.id === id),
    getAll: () => models,
    hasConfiguredAuth: () => true,
  };
  sessionStart?.({ type: "session_start", reason: "startup" }, {
    cwd: project,
    model: options.selected ?? FALLBACK,
    scopedModels: (options.scoped ?? []).map((model) => ({ model })),
    modelRegistry: registry,
    isProjectTrusted: () => options.projectTrusted ?? false,
  } as unknown as RpcBridgeSessionContext);
  return { stops, starts, tools };
}

describe("rpc-bridge workflow tool", () => {
  it("reports each submission over stderr", async () => {
    const { tools } = startSession({ settings: {} });
    expect(tools.map((tool) => tool.name)).toEqual(["workflow"]);
    const result = await tools[0]?.execute("call-1", {
      action: "submit",
      requestId: "request-1",
      output: { done: true },
    });
    expect(result?.content[0]?.text).toContain("Submission recorded");
    expect(stderrLines).toEqual([
      `${RPC_SUBMISSION_PREFIX}${JSON.stringify({ action: "submit", requestId: "request-1", output: { done: true }, idempotencyKey: "call-1" })}\n`,
    ]);
  });
});

describe("rpc-bridge default model check", () => {
  it("stops Pi when the user settings default is not available", async () => {
    const settings = { defaultProvider: "custom", defaultModel: "custom-model" };
    await writeSettings(path.join(agentDir, "settings.json"), settings);
    const { stops } = startSession({ settings });
    expect(stops).toHaveLength(1);
    expect(stops[0]).toContain(
      `"custom/custom-model" from Pi settings (set in ${path.join(agentDir, "settings.json")}): provider "custom" is not available in headless pi`,
    );
    expect(stops[0]).toContain('Pi would have used "fallback/fallback-model" instead');
  });

  it("names the project settings file that a trusted project uses", async () => {
    await writeSettings(path.join(agentDir, "settings.json"), { defaultProvider: "custom" });
    await writeSettings(path.join(project, ".pi", "settings.json"), {
      defaultModel: "custom-model",
    });
    const settings = { defaultProvider: "custom", defaultModel: "custom-model" };
    const trusted = startSession({ settings, projectTrusted: true });
    expect(trusted.stops[0]).toContain(
      `(defaultProvider in ${path.join(agentDir, "settings.json")}, defaultModel in ${path.join(project, ".pi", "settings.json")})`,
    );
    // An untrusted project's settings do not apply, so they are never named.
    const untrusted = startSession({ settings, projectTrusted: false });
    expect(untrusted.stops[0]).toContain(
      `(defaultProvider in ${path.join(agentDir, "settings.json")}):`,
    );
  });

  it("lets Pi run on a default that resolved", () => {
    const settings = { defaultProvider: "custom", defaultModel: "custom-model" };
    expect(startSession({ settings, selected: CUSTOM, models: [FALLBACK, CUSTOM] }).stops).toEqual(
      [],
    );
  });

  it("lets Pi run on a model that its command line names", () => {
    const settings = { defaultProvider: "custom", defaultModel: "custom-model" };
    for (const argv of [
      [...PI_ARGS, "--provider", "fallback", "--model", "fallback-model"],
      [...PI_ARGS, "--model", "fallback/fallback-model"],
    ]) {
      expect(startSession({ settings, argv }).stops).toEqual([]);
    }
  });

  it("reports that the session started only when the model check passes", () => {
    expect(startSession({ settings: {} }).starts).toBe(1);
    const settings = { defaultProvider: "custom", defaultModel: "custom-model" };
    expect(startSession({ settings }).starts).toBe(0);
  });

  it("lets Pi choose its first available model when no default is set", () => {
    expect(startSession({ settings: {} }).stops).toEqual([]);
  });

  it("stops Pi when the check itself fails, since Pi would carry on after it", () => {
    expect(startSession({ settings: new Error("settings are not bound") }).stops).toEqual([
      "Headless pi could not check the model that it chose for workflow steps: settings are not bound",
    ]);
  });

  it("lets Pi start on a model in the scope when the default is not available", () => {
    const settings = {
      defaultProvider: "custom",
      defaultModel: "custom-model",
      enabledModels: ["fallback/*"],
    };
    expect(startSession({ settings, scoped: [FALLBACK] }).stops).toEqual([]);
    expect(
      startSession({
        settings: { defaultProvider: "custom", defaultModel: "custom-model" },
        scoped: [FALLBACK],
        argv: [...PI_ARGS, "--models", "fallback/*"],
      }).stops,
    ).toEqual([]);
  });

  it("stops Pi when no model in the enabledModels scope is usable", async () => {
    const settings = { enabledModels: ["custom/*"] };
    await writeSettings(path.join(project, ".pi", "settings.json"), settings);
    const { stops } = startSession({ settings, projectTrusted: true });
    expect(stops).toHaveLength(1);
    expect(stops[0]).toContain(
      `inside the model scope "custom/*" from the \`enabledModels\` Pi setting in ${path.join(project, ".pi", "settings.json")}: no model that headless pi can use matches it.`,
    );
    expect(stops[0]).toContain('Pi would have used "fallback/fallback-model" instead');
  });

  it("stops Pi when no model in the --models scope is usable, ahead of enabledModels", () => {
    const { stops } = startSession({
      settings: { enabledModels: ["fallback/*"] },
      argv: [...PI_ARGS, "--models", "custom/*,other"],
    });
    expect(stops[0]).toContain(
      'inside the model scope "custom/*", "other" from `--models` in the server\'s extra Pi arguments:',
    );
  });
});
