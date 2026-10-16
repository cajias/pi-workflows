import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkflowClient } from "../../src/client/client.js";
import { HeadlessPiProcess, type HeadlessPiExit } from "../../src/server/headless-pi.js";
import { serverLockPath } from "../../src/server/lock.js";
import { workflowStatePath } from "../../src/state/database.js";
import { WorkflowRunQueueStore } from "../../src/workflows/queue.js";
import { WorkflowRunStore } from "../../src/workflows/store.js";
import { makeTempDir, waitUntil } from "../helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// PI_WORKFLOWS_E2E_PI_ENTRY runs this scenario on another Pi cli.js, such as a newer release.
const PI_ENTRY =
  process.env.PI_WORKFLOWS_E2E_PI_ENTRY ?? path.join(REPO_ROOT, "node_modules", ".bin", "pi");
const TSX_LOADER = createRequire(path.join(REPO_ROOT, "src", "client", "client.ts")).resolve("tsx");
const CLI = path.join(REPO_ROOT, "src", "viewer", "cli.ts");
const RPC_BRIDGE = path.join(REPO_ROOT, "src", "server", "rpc-bridge.ts");
const EXTENSION = path.join(REPO_ROOT, "src", "extension", "index.ts");
const PROVIDER = "fixture-headless";
const MODEL = "fixture-model";

// A provider that only this extension registers. Its model answers a headless workflow step
// by submitting the provider and model that Pi resolved for it, without any network.
const PROVIDER_EXTENSION = `import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

function stepRequestId(context) {
  for (const message of [...context.messages].reverse()) {
    if (message.role !== "user") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text ?? "").join("\\n");
    const contract = text.split("\\n").find((line) => line.startsWith('{"action": "submit"'));
    if (contract !== undefined) return JSON.parse(contract.replace("<your result>", "null")).requestId;
  }
  throw new Error("The prompt holds no workflow step contract");
}

export default function headlessProvider(pi) {
  const faux = fauxProvider({
    provider: ${JSON.stringify(PROVIDER)},
    api: "fixture-headless-api",
    models: [{ id: ${JSON.stringify(MODEL)}, name: "Fixture model" }],
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

let root: string;
let home: string;
let project: string;
let providerExtension: string;
let piCli: string;
let bin: string;

/** The environment of Pi, the server, and every headless child: a private home and agent dir. */
function piEnvironment(homeDir = home): Record<string, string> {
  return {
    HOME: homeDir,
    PI_CODING_AGENT_DIR: path.join(homeDir, ".pi", "agent"),
    PI_OFFLINE: "1",
    NO_COLOR: "1",
  };
}

/** Start the one-step headless workflow on a running server and return the step output. */
async function runProviderStep(
  databasePath: string,
  runId: string,
  diagnostics: () => string,
): Promise<unknown> {
  const client = new WorkflowClient({ databasePath });
  try {
    const workflowPath = path.join(project, "headless-provider.workflow.ts");
    const resolved = await client.resolveWorkflow({ cwd: project, workflowRef: workflowPath });
    const started = await client.request({
      operation: "run.start",
      runId,
      payload: {
        projectPath: project,
        workflowName: resolved.workflowName,
        workflowSourceRef: resolved.workflowSourceRef,
        workflowSource: resolved.workflowSource,
        definitionDigest: resolved.definitionDigest,
        definitionSnapshot: resolved.definitionSnapshot,
        input: {},
        launchOptions: {},
        originSessionId: "headless-provider-session",
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
  expect(status, diagnostics()).toBe("done");
  const store = new WorkflowRunStore(databasePath, { readOnly: true });
  try {
    return store.readRun(runId)?.state.steps.find((step) => step.nodeId === "ask")?.output;
  } finally {
    store.close();
  }
}

beforeAll(async () => {
  root = await makeTempDir("pw-prov");
  home = path.join(root, "home");
  project = path.join(root, "project");
  bin = path.join(root, "bin");
  for (const directory of [home, project, bin]) await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
  providerExtension = path.join(root, "extensions", "headless-provider.ts");
  await fs.mkdir(path.dirname(providerExtension));
  await fs.writeFile(providerExtension, PROVIDER_EXTENSION, "utf8");
  piCli = await fs.realpath(PI_ENTRY);
  // `server run` pins the pi on its PATH, so this PATH names the Pi under test and this Node.
  await fs.symlink(piCli, path.join(bin, "pi"));
  await fs.symlink(process.execPath, path.join(bin, "node"));
  await fs.writeFile(
    path.join(project, "headless-provider.workflow.ts"),
    `import { agent, defineWorkflow } from ${JSON.stringify(
      path.join(REPO_ROOT, "src", "workflows", "index.ts"),
    )};
export default defineWorkflow({
  name: "headless-provider-e2e",
  startAt: "ask",
  nodes: { ask: agent({ prompt: () => "Report the provider and model that run this step." }) },
  edges: [],
});\n`,
    "utf8",
  );
}, 60_000);

describe("server Pi arguments that load a provider extension into headless pi", () => {
  let server: ChildProcess | undefined;

  afterAll(async () => {
    if (server !== undefined && server.exitCode === null && server.signalCode === null) {
      server.kill("SIGTERM");
      await once(server, "exit");
    }
  });

  it("runs a headless step on the extension's provider and model", async () => {
    server = spawn(
      process.execPath,
      [
        "--import",
        TSX_LOADER,
        CLI,
        "server",
        "run",
        "--",
        "-e",
        providerExtension,
        "--provider",
        PROVIDER,
        "--model",
        MODEL,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          ...piEnvironment(),
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    server.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    server.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    await waitUntil(() => output.includes("[server] headless pi from "), 30_000).catch(() => {
      throw new Error(`The workflow server did not start:\n${output}`);
    });
    expect(output).toContain(`[server] headless pi from PATH: ${piCli} run by ${process.execPath}`);

    expect(
      await runProviderStep(workflowStatePath(home), "headless-provider-run", () => output),
    ).toEqual({ provider: PROVIDER, model: MODEL });
  });

  it("cannot resolve the extension's provider without the extension", async () => {
    // The same headless child as above without `-e`: `--no-extensions` loads no provider.
    const stderr: string[] = [];
    let exit: HeadlessPiExit | undefined;
    const child = new HeadlessPiProcess(
      RPC_BRIDGE,
      {
        cwd: project,
        pi: { kind: "node", node: process.execPath, cli: piCli },
        env: piEnvironment(),
        piArgs: ["--provider", PROVIDER, "--model", MODEL],
        abortGraceMs: 1_000,
      },
      {
        onStderrLine: (line) => stderr.push(line),
        onExit: (settled) => {
          exit = settled;
        },
      },
    );
    await child.start();
    try {
      await waitUntil(() => exit !== undefined, 30_000);
    } finally {
      await child.close();
    }
    expect(exit?.code).toBe(1);
    expect(stderr.join("\n")).toContain(`Unknown provider "${PROVIDER}"`);
  });
});

describe("opt-in headless extensions of a server that a Pi session starts", () => {
  let sessionHome: string;
  let pi: ChildProcess | undefined;
  let piOutput = "";

  beforeAll(async () => {
    sessionHome = path.join(root, "session-home");
    const agentDir = path.join(sessionHome, ".pi", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    // Headless children get no Pi arguments from this server, so the settings select the
    // provider, which only the listed extension registers.
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL }),
    );
  });

  afterAll(async () => {
    if (pi !== undefined && pi.exitCode === null && pi.signalCode === null) {
      pi.kill("SIGTERM");
      await once(pi, "exit");
    }
    const databasePath = workflowStatePath(sessionHome);
    const client = new WorkflowClient({ databasePath });
    try {
      await client.request({ operation: "server.stop" });
    } catch {
      // The workflow server is already stopped.
    } finally {
      await client.close();
    }
    await waitUntil(() => !existsSync(serverLockPath(databasePath)), 15_000);
  });

  it("runs a headless step on a provider from the listed extension", async () => {
    // The Pi session loads the provider itself only to start on its default model. The
    // server that its extension starts inherits this environment, opt-in included.
    pi = spawn(
      process.execPath,
      [
        PI_ENTRY,
        "--mode",
        "rpc",
        "--session-id",
        randomUUID(),
        "--session-dir",
        path.join(sessionHome, "sessions"),
        "--no-skills",
        "--no-themes",
        "--no-prompt-templates",
        "--no-context-files",
        "--offline",
        "-e",
        EXTENSION,
        "-e",
        providerExtension,
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          ...piEnvironment(sessionHome),
          PI_WORKFLOWS_HEADLESS_EXTENSIONS: providerExtension,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    pi.stdout?.on("data", (chunk: Buffer) => (piOutput += chunk.toString("utf8")));
    pi.stderr?.on("data", (chunk: Buffer) => (piOutput += chunk.toString("utf8")));

    const databasePath = workflowStatePath(sessionHome);
    let status: Record<string, unknown> | undefined;
    for (const deadline = Date.now() + 30_000; status === undefined && Date.now() < deadline;) {
      const client = new WorkflowClient({ databasePath });
      try {
        status = (await client.request({ operation: "server.status" })).receipt as Record<
          string,
          unknown
        >;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      } finally {
        await client.close();
      }
    }
    expect(status, piOutput).toBeDefined();
    expect(status?.headlessExtensions).toEqual({
      entries: [{ path: providerExtension, realpath: await fs.realpath(providerExtension) }],
    });
    expect(status?.headlessPi).toEqual({
      source: "session",
      kind: "node",
      node: process.execPath,
      cli: piCli,
    });
    expect(await runProviderStep(databasePath, "headless-extensions-run", () => piOutput)).toEqual({
      provider: PROVIDER,
      model: MODEL,
    });
  });
});
