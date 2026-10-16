import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkflowClient } from "../../src/client/client.js";
import { HeadlessPiProcess, type HeadlessPiExit } from "../../src/server/headless-pi.js";
import { RpcStepExecutor } from "../../src/server/rpc-executor.js";
import { workflowStatePath } from "../../src/state/database.js";
import { WorkflowRunQueueStore } from "../../src/workflows/queue.js";
import { WorkflowRunStore } from "../../src/workflows/store.js";
import type { AgentStepRequest } from "../../src/workflows/types.js";
import { makeTempDir, waitUntil } from "../helpers.js";
import { startMockOpenAiServer } from "./mock-openai.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// PI_WORKFLOWS_E2E_PI_ENTRY runs this scenario on another Pi cli.js, such as a newer release.
const PI_ENTRY =
  process.env.PI_WORKFLOWS_E2E_PI_ENTRY ?? path.join(REPO_ROOT, "node_modules", ".bin", "pi");
const TSX_LOADER = createRequire(path.join(REPO_ROOT, "src", "client", "client.ts")).resolve("tsx");
const CLI = path.join(REPO_ROOT, "src", "viewer", "cli.ts");
const AGENT_GROUP_BRIDGE = path.join(REPO_ROOT, "src", "server", "agent-group-bridge.ts");
/** A provider and model that only a user extension registers. */
const EXTENSION_PROVIDER = "fixture-extension";
const EXTENSION_MODEL = "fixture-extension-model";
/** A provider that `models.json` defines. Pi falls back to it when no other model resolves. */
const FALLBACK_PROVIDER = "fixture-fallback";
const FALLBACK_MODEL = "fixture-fallback-model";
/** A second `models.json` model, for a model scope. */
const SCOPED_MODEL = "fixture-scoped-model";
/** Environment names that could hand a real provider credential to Pi. */
const CREDENTIAL_ENV = /(?:API_KEY|_TOKEN|_SECRET|^AWS_|^AZURE_|^GOOGLE_|VERTEX|BEDROCK)/iu;

// A provider that only this extension registers. Its model answers a workflow step by
// submitting the provider and model that Pi chose for it, without any network.
const PROVIDER_EXTENSION = `import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

function stepRequestId(context) {
  const text = context.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text ?? "").join("\\n"),
    )
    .join("\\n");
  const found = [...text.matchAll(/"requestId":\\s*"([^"]+)"/gu)].at(-1);
  if (found === undefined) throw new Error("The prompt holds no workflow step contract");
  return found[1];
}

export default function extensionProvider(pi) {
  const faux = fauxProvider({
    provider: ${JSON.stringify(EXTENSION_PROVIDER)},
    api: "fixture-extension-api",
    models: [{ id: ${JSON.stringify(EXTENSION_MODEL)}, name: "Fixture extension model" }],
  });
  faux.setResponses([
    (context, _options, _state, model) =>
      fauxAssistantMessage(
        fauxToolCall("workflow", {
          action: "submit",
          requestId: stepRequestId(context),
          output: { provider: model.provider, model: model.id },
        }),
        { stopReason: "toolUse" },
      ),
    fauxAssistantMessage("Submitted."),
  ]);
  pi.registerProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Fixture key",
        async login() {
          return { type: "api_key", key: "fixture-login-key" };
        },
        async resolve() {
          return { auth: { apiKey: "fixture-key" }, source: "fixture provider" };
        },
      },
    },
  });
}
`;

type Home = { home: string; agentDir: string; project: string };

let root: string;
let piCli: string;
let providerExtension: string;
let mock: Awaited<ReturnType<typeof startMockOpenAiServer>>;
const scrubbedEnv = new Map<string, string>();

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part ? String(part.text) : "",
    )
    .join("\n");
}

/** The model names that reached the fallback provider's mock endpoint. */
function fallbackRequests(): string[] {
  return mock.requests.map((request) => String((request as { model?: unknown }).model));
}

/**
 * A private home and agent dir. Its `models.json` defines the fallback provider, its user
 * extension directory holds the provider extension that headless pi does not load, and its
 * settings name `settings` as the Pi defaults.
 */
async function makeHome(
  name: string,
  settings: Record<string, unknown>,
  fallbackModels: string[] = [FALLBACK_MODEL],
): Promise<Home> {
  const home = path.join(root, name, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const project = path.join(root, name, "project");
  await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.copyFile(providerExtension, path.join(agentDir, "extensions", "fixture-provider.ts"));
  await fs.writeFile(
    path.join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          [FALLBACK_PROVIDER]: {
            name: "Fixture fallback",
            baseUrl: mock.baseUrl,
            api: "openai-completions",
            apiKey: "fixture-fallback-key",
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
            models: fallbackModels.map((id) => ({ id })),
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(path.join(agentDir, "auth.json"), "{}\n");
  await fs.writeFile(path.join(agentDir, "settings.json"), `${JSON.stringify(settings)}\n`);
  return { home, agentDir, project };
}

function piEnvironment(home: Home): Record<string, string> {
  return {
    HOME: home.home,
    PI_CODING_AGENT_DIR: home.agentDir,
    PI_OFFLINE: "1",
    NO_COLOR: "1",
  };
}

function stepRequest(id: string): AgentStepRequest {
  const requestId = `request-${id}`;
  return {
    contract: {
      requestId,
      runId: `run-${id}`,
      workflowName: "headless-model-e2e",
      nodeId: "ask",
      attemptId: "a1",
      completion: "submit",
    },
    prompt: [
      "Report the provider and model that run this step.",
      `{"action": "submit", "requestId": ${JSON.stringify(requestId)}, "output": <your result>}`,
    ].join("\n"),
    accept: async (output) => ({ ok: true as const, value: output }),
  };
}

/** Run one headless agent step through the real Pi runtime. */
async function runStep(home: Home, id: string, piArgs: string[] = []): Promise<unknown> {
  const executor = new RpcStepExecutor({
    cwd: home.project,
    pi: { kind: "node", node: process.execPath, cli: piCli },
    env: piEnvironment(home),
    piArgs,
    abortGraceMs: 1_000,
  });
  const timeout = AbortSignal.timeout(60_000);
  try {
    return (await executor.runAgentStep(stepRequest(id), timeout)).output;
  } finally {
    await executor.close();
  }
}

beforeAll(async () => {
  // A credential from the developer's environment would let Pi fall back to a real provider.
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && CREDENTIAL_ENV.test(name)) {
      scrubbedEnv.set(name, value);
      delete process.env[name];
    }
  }
  root = await makeTempDir("pw-model");
  piCli = await fs.realpath(PI_ENTRY);
  providerExtension = path.join(root, "fixture-provider.ts");
  await fs.writeFile(providerExtension, PROVIDER_EXTENSION, "utf8");
  mock = await startMockOpenAiServer(({ messages, lastRole }) => {
    if (lastRole === "tool") return { kind: "text", text: "Submitted." };
    const text = messages.map((message) => textOf(message.content)).join("\n");
    const requestId = [...text.matchAll(/"requestId":\s*"([^"]+)"/gu)].at(-1)?.[1];
    return {
      kind: "tool",
      toolName: "workflow",
      args: {
        action: "submit",
        requestId,
        output: { provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL },
      },
    };
  });
}, 60_000);

afterAll(async () => {
  await mock?.close();
  for (const [name, value] of scrubbedEnv) process.env[name] = value;
});

describe("headless agent steps and the configured Pi model", () => {
  it("fails a step whose settings default only an unloaded extension provides", async () => {
    const home = await makeHome("ext-default", {
      defaultProvider: EXTENSION_PROVIDER,
      defaultModel: EXTENSION_MODEL,
    });
    const before = mock.requests.length;
    const outcome = await runStep(home, "ext-default").then(
      (output) => ({ output }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    );
    // Before the fix, Pi silently ran this step on the fallback provider.
    expect(
      { outcome, fallbackRequests: fallbackRequests().slice(before) },
      "headless pi must not run the step on another model",
    ).toEqual({
      outcome: { error: expect.stringContaining(`"${EXTENSION_PROVIDER}/${EXTENSION_MODEL}"`) },
      fallbackRequests: [],
    });
    const error = (outcome as { error: string }).error;
    expect(error).toContain(path.join(home.agentDir, "settings.json"));
    expect(error).toContain(`provider "${EXTENSION_PROVIDER}" is not available in headless pi`);
    expect(error).toContain(`"${FALLBACK_PROVIDER}/${FALLBACK_MODEL}"`);
  });

  it("names the project settings file when the project sets the default", async () => {
    const home = await makeHome("project-default", { defaultProjectTrust: "always" });
    await fs.mkdir(path.join(home.project, ".pi"), { recursive: true });
    await fs.writeFile(
      path.join(home.project, ".pi", "settings.json"),
      `${JSON.stringify({ defaultProvider: FALLBACK_PROVIDER, defaultModel: "missing-model" })}\n`,
    );
    const before = mock.requests.length;
    await expect(runStep(home, "project-default")).rejects.toThrow(
      `provider "${FALLBACK_PROVIDER}" has no model "missing-model"`,
    );
    await expect(runStep(home, "project-default-path")).rejects.toThrow(
      path.join(home.project, ".pi", "settings.json"),
    );
    expect(fallbackRequests().slice(before)).toEqual([]);
  });

  it("runs a step on a settings default that resolves", async () => {
    const home = await makeHome("resolvable-default", {
      defaultProvider: FALLBACK_PROVIDER,
      defaultModel: FALLBACK_MODEL,
    });
    const before = mock.requests.length;
    await expect(runStep(home, "resolvable-default")).resolves.toEqual({
      provider: FALLBACK_PROVIDER,
      model: FALLBACK_MODEL,
    });
    expect(fallbackRequests().slice(before)).toContain(FALLBACK_MODEL);
  });

  it("runs a step on explicit --provider and --model despite an unresolvable default", async () => {
    const home = await makeHome("explicit-model", {
      defaultProvider: EXTENSION_PROVIDER,
      defaultModel: EXTENSION_MODEL,
    });
    const before = mock.requests.length;
    await expect(
      runStep(home, "explicit-model", ["--provider", FALLBACK_PROVIDER, "--model", FALLBACK_MODEL]),
    ).resolves.toEqual({ provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL });
    expect(fallbackRequests().slice(before)).toContain(FALLBACK_MODEL);
  });

  it("runs a step on an extension default when the server loads that extension", async () => {
    const home = await makeHome("loaded-extension", {
      defaultProvider: EXTENSION_PROVIDER,
      defaultModel: EXTENSION_MODEL,
    });
    const before = mock.requests.length;
    await expect(runStep(home, "loaded-extension", ["-e", providerExtension])).resolves.toEqual({
      provider: EXTENSION_PROVIDER,
      model: EXTENSION_MODEL,
    });
    expect(fallbackRequests().slice(before)).toEqual([]);
  });

  it("keeps Pi's first scoped model when a usable default is outside the scope", async () => {
    const home = await makeHome(
      "scoped-models",
      {
        defaultProvider: FALLBACK_PROVIDER,
        defaultModel: FALLBACK_MODEL,
        enabledModels: [`${FALLBACK_PROVIDER}/${SCOPED_MODEL}`],
      },
      [FALLBACK_MODEL, SCOPED_MODEL],
    );
    const before = mock.requests.length;
    await expect(runStep(home, "scoped-models")).resolves.toBeDefined();
    expect(fallbackRequests().slice(before)).toContain(SCOPED_MODEL);
    expect(fallbackRequests().slice(before)).not.toContain(FALLBACK_MODEL);
  });

  it("runs a step on the first usable scoped model when the default is unusable", async () => {
    // Pi's first available model is FALLBACK_MODEL, so a request for SCOPED_MODEL shows that
    // Pi chose inside the scope. The unmatched extension pattern only warns.
    const viaSettings = await makeHome(
      "scope-settings",
      {
        defaultProvider: EXTENSION_PROVIDER,
        defaultModel: EXTENSION_MODEL,
        enabledModels: [`${EXTENSION_PROVIDER}/*`, `${FALLBACK_PROVIDER}/${SCOPED_MODEL}`],
      },
      [FALLBACK_MODEL, SCOPED_MODEL],
    );
    const viaCommandLine = await makeHome(
      "scope-command-line",
      { defaultProvider: EXTENSION_PROVIDER, defaultModel: EXTENSION_MODEL },
      [FALLBACK_MODEL, SCOPED_MODEL],
    );
    for (const [home, id, piArgs] of [
      [viaSettings, "scope-settings", []],
      [viaCommandLine, "scope-command-line", ["--models", `${FALLBACK_PROVIDER}/${SCOPED_MODEL}`]],
    ] as const) {
      const before = mock.requests.length;
      await expect(runStep(home, id, [...piArgs])).resolves.toBeDefined();
      expect(fallbackRequests().slice(before)).toContain(SCOPED_MODEL);
      expect(fallbackRequests().slice(before)).not.toContain(FALLBACK_MODEL);
    }
  });

  it("fails a step whose model scope holds no usable model", async () => {
    // Pi would otherwise run on the usable default, which is outside the scope.
    const usableDefault = await makeHome("empty-scope-settings", {
      defaultProvider: FALLBACK_PROVIDER,
      defaultModel: FALLBACK_MODEL,
      enabledModels: [`${EXTENSION_PROVIDER}/*`],
    });
    const before = mock.requests.length;
    const error = await runStep(usableDefault, "empty-scope-settings").then(
      () => "the step ran",
      (failure: unknown) => (failure instanceof Error ? failure.message : String(failure)),
    );
    expect(error).toContain(
      `inside the model scope "${EXTENSION_PROVIDER}/*" from the \`enabledModels\` Pi setting in ${path.join(usableDefault.agentDir, "settings.json")}: no model that headless pi can use matches it.`,
    );
    expect(error).toContain(`Pi would have used "${FALLBACK_PROVIDER}/${FALLBACK_MODEL}" instead`);
    // A --models scope wins over enabledModels and fails the same way.
    const commandLine = await makeHome("empty-scope-command-line", {
      defaultProvider: EXTENSION_PROVIDER,
      defaultModel: EXTENSION_MODEL,
      enabledModels: [`${FALLBACK_PROVIDER}/*`],
    });
    await expect(
      runStep(commandLine, "empty-scope-command-line", ["--models", `${EXTENSION_PROVIDER}/*`]),
    ).rejects.toThrow(
      `inside the model scope "${EXTENSION_PROVIDER}/*" from \`--models\` in the server's extra Pi arguments: no model that headless pi can use matches it.`,
    );
    expect(fallbackRequests().slice(before)).toEqual([]);
  });

  it("keeps Pi's first available model when no default is configured", async () => {
    const home = await makeHome("no-default", {});
    const before = mock.requests.length;
    await expect(runStep(home, "no-default")).resolves.toEqual({
      provider: FALLBACK_PROVIDER,
      model: FALLBACK_MODEL,
    });
    expect(fallbackRequests().slice(before)).toContain(FALLBACK_MODEL);
  });

  it("still starts the agent group host, whose sessions check their own model", async () => {
    const home = await makeHome("agent-group-host", {
      defaultProvider: EXTENSION_PROVIDER,
      defaultModel: EXTENSION_MODEL,
    });
    const stderr: string[] = [];
    let exit: HeadlessPiExit | undefined;
    const host = new HeadlessPiProcess(
      AGENT_GROUP_BRIDGE,
      {
        cwd: home.project,
        pi: { kind: "node", node: process.execPath, cli: piCli },
        env: piEnvironment(home),
        abortGraceMs: 1_000,
      },
      {
        onStderrLine: (line) => stderr.push(line),
        onExit: (settled) => {
          exit = settled;
        },
      },
    );
    await host.start();
    try {
      await waitUntil(
        () => exit !== undefined || stderr.some((line) => line.includes('"type":"ready"')),
        30_000,
      );
      expect(exit, stderr.join("\n")).toBeUndefined();
    } finally {
      await host.close();
    }
  });
});

describe("a workflow server whose headless pi cannot use the default model", () => {
  let server: ChildProcess | undefined;

  afterAll(async () => {
    if (server !== undefined && server.exitCode === null && server.signalCode === null) {
      server.kill("SIGTERM");
      await once(server, "exit");
    }
  });

  it("fails the step and the run with the model error", async () => {
    const home = await makeHome("server", {
      defaultProvider: EXTENSION_PROVIDER,
      defaultModel: EXTENSION_MODEL,
    });
    const bin = path.join(root, "server", "bin");
    await fs.mkdir(bin, { recursive: true });
    // `server run` pins the pi on its PATH, so this PATH names the Pi under test and this Node.
    await fs.symlink(piCli, path.join(bin, "pi"));
    await fs.symlink(process.execPath, path.join(bin, "node"));
    const workflowPath = path.join(home.project, "headless-model.workflow.ts");
    await fs.writeFile(
      workflowPath,
      `import { agent, defineWorkflow } from ${JSON.stringify(
        path.join(REPO_ROOT, "src", "workflows", "index.ts"),
      )};
export default defineWorkflow({
  name: "headless-model-e2e",
  startAt: "ask",
  nodes: { ask: agent({ prompt: () => "Report the provider and model that run this step." }) },
  edges: [],
});\n`,
      "utf8",
    );
    server = spawn(process.execPath, ["--import", TSX_LOADER, CLI, "server", "run"], {
      cwd: root,
      env: {
        ...process.env,
        ...piEnvironment(home),
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    server.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    server.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    await waitUntil(() => output.includes("[server] headless pi from "), 30_000).catch(() => {
      throw new Error(`The workflow server did not start:\n${output}`);
    });

    const databasePath = workflowStatePath(home.home);
    const client = new WorkflowClient({ databasePath });
    const runId = "headless-model-run";
    const before = mock.requests.length;
    try {
      const resolved = await client.resolveWorkflow({
        cwd: home.project,
        workflowRef: workflowPath,
      });
      const started = await client.request({
        operation: "run.start",
        runId,
        payload: {
          projectPath: home.project,
          workflowName: resolved.workflowName,
          workflowSourceRef: resolved.workflowSourceRef,
          workflowSource: resolved.workflowSource,
          definitionDigest: resolved.definitionDigest,
          definitionSnapshot: resolved.definitionSnapshot,
          input: {},
          launchOptions: {},
          originSessionId: "headless-model-session",
          executionMode: "headless",
        },
      });
      expect(started.outcome, started.error).toBe("accepted");
    } finally {
      await client.close();
    }
    let status: string | undefined;
    for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
      const queue = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
      try {
        status = queue.getWorkflowRun(runId)?.status;
      } finally {
        queue.close();
      }
      if (status === "done" || status === "failed" || status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const store = new WorkflowRunStore(databasePath, { readOnly: true });
    try {
      const run = store.readRun(runId);
      const ask = run?.state.steps.find((step) => step.nodeId === "ask");
      // Before the fix, the run finished `done` with the fallback provider's answer.
      expect(
        {
          status,
          askOutcome: ask?.outcome,
          askOutput: ask?.output,
          fallbackRequests: fallbackRequests().slice(before),
        },
        output,
      ).toEqual({
        status: "failed",
        askOutcome: "failed",
        askOutput: null,
        fallbackRequests: [],
      });
      expect(ask?.error).toContain(`"${EXTENSION_PROVIDER}/${EXTENSION_MODEL}"`);
      expect(run?.state.error).toContain(`"${EXTENSION_PROVIDER}/${EXTENSION_MODEL}"`);
    } finally {
      store.close();
    }
  });
});
