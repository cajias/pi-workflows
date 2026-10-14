import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowClient } from "../src/client/client.js";
import { serverLockPath } from "../src/server/lock.js";
import { WorkflowServer } from "../src/server/server.js";
import type { JsonValue } from "../src/state/json.js";
import {
  oauthRefreshMarkerDirectory,
  writeOAuthRefreshMarker,
} from "../src/state/oauth-refresh-markers.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { makeTempDir, waitUntil } from "./helpers.js";

const WORKFLOWS = JSON.stringify(path.resolve("src/workflows/index.ts"));
const COMPUTE_NODE = "work: compute({ run: () => ({ done: true }) })";
const AGENT_NODE = 'work: agent({ prompt: () => "Return a result." })';

async function writeWorkflow(cwd: string, node: string): Promise<string> {
  const workflowPath = path.join(cwd, "headless.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { agent, compute, defineWorkflow } from ${WORKFLOWS};
export default defineWorkflow({
  name: "headless-pi-server",
  startAt: "work",
  nodes: { ${node} },
  edges: [],
});\n`,
  );
  return workflowPath;
}

/** Start one headless run, which launches a workflow runner, and wait until it finishes. */
async function runOnce(
  databasePath: string,
  cwd: string,
  runId: string,
  node = COMPUTE_NODE,
): Promise<void> {
  const workflowPath = await writeWorkflow(cwd, node);
  const client = new WorkflowClient({ databasePath });
  try {
    const resolved = await client.resolveWorkflow({ cwd, workflowRef: workflowPath });
    const response = await client.request({
      operation: "run.start",
      runId,
      payload: {
        projectPath: cwd,
        workflowName: resolved.workflowName,
        workflowSourceRef: resolved.workflowSourceRef,
        workflowSource: resolved.workflowSource,
        definitionDigest: resolved.definitionDigest,
        definitionSnapshot: resolved.definitionSnapshot,
        input: {},
        launchOptions: {},
        originSessionId: "headless-pi-retry-session",
        executionMode: "headless",
      },
    });
    expect(response.outcome, response.error).toBe("accepted");
  } finally {
    await client.close();
  }
  await waitUntil(() => {
    const queue = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
    try {
      return queue.getWorkflowRun(runId)?.status === "done";
    } finally {
      queue.close();
    }
  }, 30_000);
}

async function statusOf(databasePath: string): Promise<Record<string, JsonValue>> {
  const client = new WorkflowClient({ databasePath });
  try {
    const response = await client.request({ operation: "server.status" });
    return response.receipt as Record<string, JsonValue>;
  } finally {
    await client.close();
  }
}

async function withServer(
  options: ConstructorParameters<typeof WorkflowServer>[0],
  check: (databasePath: string, logs: string[]) => Promise<void>,
): Promise<void> {
  const databasePath = path.join(await makeTempDir("server-headless-pi"), "state.sqlite");
  const logs: string[] = [];
  const server = new WorkflowServer({
    databasePath,
    claimPollMs: 1_000_000,
    onLog: (message) => logs.push(message),
    ...options,
  });
  await server.start();
  try {
    await check(databasePath, logs);
  } finally {
    await server.stop();
  }
}

describe("workflow server headless pi pin", () => {
  it("reports and logs the pi that the starting Pi session pinned", async () => {
    const pin = { kind: "node", node: "/opt/node/bin/node", cli: "/opt/pi/dist/cli.js" } as const;
    await withServer({ headlessPi: pin }, async (databasePath, logs) => {
      expect((await statusOf(databasePath)).headlessPi).toEqual({ source: "session", ...pin });
      expect(logs).toContain(
        "headless pi from the starting Pi session: /opt/pi/dist/cli.js run by /opt/node/bin/node",
      );
    });
  });

  it("resolves pi from its PATH once at start when no session pinned it", async () => {
    const root = await makeTempDir("server-headless-pi-path");
    const cli = path.join(root, "package", "cli.js");
    await fs.mkdir(path.dirname(cli));
    await fs.writeFile(cli, "#!/usr/bin/env node\n", { mode: 0o755 });
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await fs.symlink(cli, path.join(bin, "pi"));
    await fs.symlink(process.execPath, path.join(bin, "node"));
    await withServer({ env: { PATH: bin } }, async (databasePath, logs) => {
      const pinned = { kind: "node", node: process.execPath, cli: await fs.realpath(cli) };
      expect((await statusOf(databasePath)).headlessPi).toEqual({ source: "path", ...pinned });
      // A later change on disk does not move the pin.
      await fs.rm(path.join(bin, "pi"));
      expect((await statusOf(databasePath)).headlessPi).toEqual({ source: "path", ...pinned });
      expect(logs).toContain(`headless pi from PATH: ${pinned.cli} run by ${process.execPath}`);
    });
  });

  it("starts without a resolvable pi and reports why in its status", async () => {
    const empty = await makeTempDir("server-headless-pi-empty");
    await withServer({ env: { PATH: empty } }, async (databasePath) => {
      expect((await statusOf(databasePath)).headlessPi).toEqual({
        source: "path",
        kind: "unresolved",
        error: expect.stringContaining(`no executable pi is on the server's PATH (${empty})`),
      });
    });
  });

  it("resolves an unresolved pin once more when the next runner starts", async () => {
    const root = await makeTempDir("server-headless-pi-retry");
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await withServer({ env: { PATH: bin }, claimPollMs: 10 }, async (databasePath, logs) => {
      expect((await statusOf(databasePath)).headlessPi).toMatchObject({ kind: "unresolved" });
      // pi appears after the server started, as after a slow first probe.
      const pi = path.join(bin, "pi");
      await fs.writeFile(pi, "#!/bin/sh\n", { mode: 0o755 });
      await runOnce(databasePath, root, "headless-pi-retry-first");
      expect((await statusOf(databasePath)).headlessPi).toEqual({
        source: "path",
        kind: "executable",
        executable: pi,
      });
      expect(logs).toContain(`headless pi from PATH after a retry: ${pi}`);
    });
  });

  it("retries an unresolved pin only once", async () => {
    const root = await makeTempDir("server-headless-pi-retry-once");
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await withServer({ env: { PATH: bin }, claimPollMs: 10 }, async (databasePath, logs) => {
      await runOnce(databasePath, root, "headless-pi-retry-missing");
      expect((await statusOf(databasePath)).headlessPi).toMatchObject({ kind: "unresolved" });
      await fs.writeFile(path.join(bin, "pi"), "#!/bin/sh\n", { mode: 0o755 });
      await runOnce(databasePath, root, "headless-pi-retry-later");
      // The retry already happened; the pin changes again only after a restart.
      expect((await statusOf(databasePath)).headlessPi).toMatchObject({ kind: "unresolved" });
      expect(logs.filter((line) => line.includes("after a retry"))).toHaveLength(1);
    });
  });

  it("reports agent group OAuth refresh processes from their markers", async () => {
    const configDir = await makeTempDir("server-oauth-refresh");
    await withServer({ env: { PI_WORKFLOWS_CONFIG_DIR: configDir } }, async (databasePath) => {
      expect((await statusOf(databasePath)).oauthRefreshes).toEqual([]);
      const startedAt = new Date().toISOString();
      writeOAuthRefreshMarker(oauthRefreshMarkerDirectory({ PI_WORKFLOWS_CONFIG_DIR: configDir }), {
        pid: process.pid,
        provider: "fixture",
        startedAt,
      });
      expect((await statusOf(databasePath)).oauthRefreshes).toEqual([
        { pid: process.pid, provider: "fixture", startedAt, running: true },
      ]);
    });
  });

  it("reports no headless extensions unless the opt-in lists some", async () => {
    await withServer({}, async (databasePath, logs) => {
      expect((await statusOf(databasePath)).headlessExtensions).toEqual({ entries: [] });
      expect(logs.some((line) => line.startsWith("headless extensions"))).toBe(false);
    });
  });

  it("reports why listed headless extensions are invalid and still starts", async () => {
    const env = { PI_WORKFLOWS_HEADLESS_EXTENSIONS: "relative/provider.ts" };
    await withServer({ env }, async (databasePath, logs) => {
      const error =
        'PI_WORKFLOWS_HEADLESS_EXTENSIONS is invalid: "relative/provider.ts" is not an absolute path. Fix it, then restart the workflow server with `pi-workflows server stop`';
      expect((await statusOf(databasePath)).headlessExtensions).toEqual({ error });
      expect(logs).toContain(`headless extensions unavailable: ${error}`);
    });
  });

  it("hands listed headless extensions through the runner to each headless child", async () => {
    const root = await makeTempDir("server-headless-extensions");
    const real = path.join(root, "extensions", "provider.ts");
    await fs.mkdir(path.dirname(real));
    await fs.writeFile(real, "export default function provider() {}\n");
    const realpath = await fs.realpath(real);
    // The configured path is a symlink; status shows both, and children load the real file.
    const extension = path.join(root, "provider.ts");
    await fs.symlink(real, extension);
    const argvFile = path.join(root, "argv.json");
    // A pi that records its arguments and submits the step it is given.
    const fakePi = path.join(root, "fake-pi.cjs");
    await fs.writeFile(
      fakePi,
      `const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const contract = JSON.parse(line).message.split("\\n").find((text) => text.startsWith('{"action": "submit"'));
  if (contract === undefined) return;
  const action = JSON.parse(contract.replace("<your result>", "null"));
  process.stderr.write("PI_WORKFLOWS_STEP_SUBMISSION " + JSON.stringify({ ...action, output: { done: true } }) + "\\n");
});
setInterval(() => {}, 1000);
`,
    );
    const options = {
      headlessPi: { kind: "node", node: process.execPath, cli: fakePi } as const,
      env: { PI_WORKFLOWS_HEADLESS_EXTENSIONS: extension },
      claimPollMs: 10,
    };
    await withServer(options, async (databasePath, logs) => {
      expect((await statusOf(databasePath)).headlessExtensions).toEqual({
        entries: [{ path: extension, realpath }],
      });
      expect(logs).toContain(
        `headless extensions from PI_WORKFLOWS_HEADLESS_EXTENSIONS: ${extension} (${realpath})`,
      );
      await runOnce(databasePath, root, "headless-extensions-run", AGENT_NODE);
      const argv = JSON.parse(await fs.readFile(argvFile, "utf8")) as string[];
      expect(argv.slice(0, 5)).toEqual(["--mode", "rpc", "--no-session", "--no-extensions", "-e"]);
      expect(path.basename(argv[5] ?? "")).toMatch(/^rpc-bridge\.(?:ts|js)$/);
      expect(argv.slice(6)).toEqual(["-e", realpath]);
    });
  });

  it("receives the session's pin through the server process that a client starts", async () => {
    const databasePath = path.join(await makeTempDir("server-headless-pi-entry"), "state.sqlite");
    const pin = { kind: "executable", executable: "/opt/pi/bin/pi" } as const;
    const client = new WorkflowClient({ databasePath, headlessPi: pin });
    try {
      const status = await client.ensureRunning();
      expect((status.receipt as Record<string, JsonValue>).headlessPi).toEqual({
        source: "session",
        ...pin,
      });
      await client.request({ operation: "server.stop" });
    } finally {
      await client.close();
    }
    await waitUntil(() => !existsSync(serverLockPath(databasePath)), 10_000);
  });
});
