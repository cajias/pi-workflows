import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseArgs,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../workflows/errors.js";
import {
  parseWorkflowSubmissionInput,
  WorkflowSubmissionToolParameters,
} from "../workflows/tool-input.js";
import {
  describeHeadlessModelProblem,
  findHeadlessModelProblem,
  type ModelSettingSources,
} from "./headless-step-model.js";
import { encodeRpcModelError, RPC_SUBMISSION_PREFIX } from "./rpc-protocol.js";

/** The part of the session context that the model check reads. */
export type RpcBridgeSessionContext = Pick<
  ExtensionContext,
  "cwd" | "model" | "scopedModels" | "modelRegistry" | "isProjectTrusted"
>;

/** The part of the Pi extension API that the bridge uses. */
export type RpcBridgeApi = Pick<ExtensionAPI, "registerTool" | "getSettings"> & {
  on(
    event: "session_start",
    handler: (event: unknown, ctx: RpcBridgeSessionContext) => void,
  ): () => void;
};

/** The process facts that the bridge reads, and how it stops Pi. */
export type RpcBridgeRuntime = {
  /** Pi's own command-line arguments, without the node and script paths. */
  argv: readonly string[];
  agentDir: string;
  /** Report a model error on stderr and stop Pi before it reads any prompt. */
  stop(error: string): void;
};

/**
 * Loaded into headless `pi --mode rpc` children spawned by the standalone
 * server. The child has no workflow engine, so this bridge only registers the
 * `workflow` tool and reports every submission to the server over stderr; the
 * server validates against the engine and re-prompts on rejection.
 */
export default function piWorkflowsRpcBridge(pi: ExtensionAPI) {
  registerRpcBridge(pi, {
    argv: process.argv.slice(2),
    agentDir: getAgentDir(),
    stop: (error) => {
      try {
        // Synchronous, so the line reaches the pipe before the process exits.
        fs.writeSync(2, encodeRpcModelError(error));
      } catch {
        // stderr is gone; the runner reports the exit instead.
      }
      process.exit(1);
    },
  });
}

export function registerRpcBridge(pi: RpcBridgeApi, runtime: RpcBridgeRuntime): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Publish an update or submit the output for the pending workflow step.",
      "Only call this tool when a workflow step contract in the conversation asks you to.",
      "Pass the exact requestId from the contract.",
    ].join(" "),
    parameters: WorkflowSubmissionToolParameters,
    async execute(toolCallId, rawParams) {
      const params = parseWorkflowSubmissionInput(rawParams);
      process.stderr.write(
        `${RPC_SUBMISSION_PREFIX}${JSON.stringify({ ...params, idempotencyKey: toolCallId })}\n`,
      );
      return {
        content: [
          {
            type: "text",
            text:
              params.action === "update"
                ? "Workflow update recorded; continue the current step."
                : "Submission recorded. Continue only when the workflow sends the next step.",
          },
        ],
        details: {},
      };
    },
  });

  // Pi emits session_start after it chose the model and before it reads any RPC command.
  // Pi reports a handler error and carries on, so a failed check also stops pi rather than
  // letting the step run on a model that nobody checked.
  pi.on("session_start", (_event, ctx) => {
    let error: string | undefined;
    try {
      error = headlessModelError(pi, ctx, runtime);
    } catch (cause) {
      error = `Headless pi could not check the model that it chose for workflow steps: ${errorMessage(cause)}`;
    }
    if (error !== undefined) runtime.stop(error);
  });
}

function headlessModelError(
  pi: RpcBridgeApi,
  ctx: RpcBridgeSessionContext,
  runtime: RpcBridgeRuntime,
): string | undefined {
  const settings = pi.getSettings();
  const args = parseArgs([...runtime.argv]);
  const registry = ctx.modelRegistry;
  const problem = findHeadlessModelProblem({
    explicitModel: Boolean(args.model),
    // The same patterns that Pi resolved into `ctx.scopedModels` (Pi 1.1.0 `main.js` 658).
    scope: {
      patterns: args.models ?? settings.enabledModels ?? [],
      fromCommandLine: args.models !== undefined,
      models: ctx.scopedModels.map((scoped) => scoped.model),
    },
    defaultProvider: settings.defaultProvider,
    defaultModel: settings.defaultModel,
    selected: ctx.model,
    find: (provider, id) => registry.find(provider, id),
    hasProvider: (provider) => registry.getAll().some((model) => model.provider === provider),
    hasConfiguredAuth: (model) => registry.hasConfiguredAuth(model),
  });
  return problem === undefined
    ? undefined
    : describeHeadlessModelProblem(problem, modelSettingSources(ctx, runtime.agentDir));
}

/** The settings file that sets each model setting, read the way the session read them. */
function modelSettingSources(ctx: RpcBridgeSessionContext, agentDir: string): ModelSettingSources {
  const cwd = path.resolve(ctx.cwd);
  const settings = SettingsManager.create(cwd, agentDir, {
    projectTrusted: ctx.isProjectTrusted(),
  });
  const project = settings.getProjectSettings();
  const global = settings.getGlobalSettings();
  const projectPath = path.join(cwd, CONFIG_DIR_NAME, "settings.json");
  const globalPath = path.join(path.resolve(agentDir), "settings.json");
  const sourceOf = (key: keyof ModelSettingSources): string | undefined => {
    if (project[key] !== undefined) return projectPath;
    return global[key] === undefined ? undefined : globalPath;
  };
  return {
    defaultProvider: sourceOf("defaultProvider"),
    defaultModel: sourceOf("defaultModel"),
    enabledModels: sourceOf("enabledModels"),
  };
}
