import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorkflowClient } from "../src/client/client.js";
import { WorkflowServer } from "../src/server/server.js";
import { ServerStateStore } from "../src/server/state.js";
import { renderRunDetailLines } from "../src/viewer/render.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { readWorkflowRun } from "../src/workflows/store.js";
import { makeTempDir, waitUntil } from "./helpers.js";

const execFileAsync = promisify(execFile);
const FAKE_PI = path.resolve("test/fixtures/fake-agent-group-pi.mjs");
const SESSION = "agent-error-privacy-session";

/**
 * A Git repository with one committed change, and a fake `gh` that has no pull request, so
 * Sanity Check collects its evidence without a network.
 */
async function writeRepository(cwd: string, bin: string): Promise<void> {
  const git = async (...args: string[]) => await execFileAsync("git", args, { cwd });
  await git("init", "-q");
  await git("config", "user.name", "Test User");
  await git("config", "user.email", "test@example.com");
  await fs.writeFile(path.join(cwd, "sample.txt"), "base\n");
  await git("add", "sample.txt");
  await git("commit", "-q", "-m", "base");
  await fs.writeFile(path.join(cwd, "sample.txt"), "base\nchange\n");
  await git("commit", "-q", "-am", "change");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "gh"), "#!/bin/sh\necho 'no pull request' >&2\nexit 1\n", {
    mode: 0o755,
  });
}

/** Start the built-in Sanity Check from an origin session, so it ends with a model turn. */
async function startSanityCheck(client: WorkflowClient, cwd: string, runId: string): Promise<void> {
  const resolved = await client.resolveWorkflow({ cwd, workflowRef: "sanity-check" });
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
      input: { mode: "serial" },
      launchOptions: {},
      originSessionId: SESSION,
      executionMode: "interactive",
    },
  });
  expect(response.outcome).toBe("accepted");
}

function queueStatus(databasePath: string, runId: string): string | undefined {
  const store = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
  try {
    return store.getWorkflowRun(runId)?.status;
  } finally {
    store.close();
  }
}

function terminalContent(databasePath: string, runId: string): string | undefined {
  const state = new ServerStateStore(databasePath, { readOnly: true });
  try {
    const message = state.workflowMessages
      .listSession(SESSION)
      .find((candidate) => candidate.kind === "terminal" && candidate.runId === runId);
    return message?.content.content;
  } finally {
    state.close();
  }
}

/** Every byte under `root`, so text cannot hide in any table, blob, journal, or log. */
async function filesUnder(root: string): Promise<Array<{ file: string; text: string }>> {
  const files: Array<{ file: string; text: string }> = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files.push({ file, text: (await fs.readFile(file)).toString("latin1") });
  }
  return files;
}

describe("agent group error privacy", () => {
  it.each([
    [
      "a provider error",
      "provider-error",
      "Pi agent review stopped with error: the provider reported an error",
    ],
    [
      "a Pi rejection",
      "rejected-private",
      "Pi agent group could not run: pi rejected the agent group command",
    ],
    [
      "a group-level error",
      "plain-error",
      "Pi agent group failed: the agent group raised an error",
    ],
  ])(
    "keeps %s out of state, traces, piw, and the post-workflow turn",
    async (_name, scenario, facts) => {
      const marker = `PRIVATE_MARKER_${scenario}_${process.pid}`;
      const privateText = `${marker} ${"secret provider text ".repeat(300)}END_OF_PRIVATE_TEXT`;
      const cwd = await makeTempDir("agent-error-privacy-project");
      const stateDir = await makeTempDir("agent-error-privacy-state");
      // The workflow runner and headless pi create their diagnostics here.
      const tmp = await makeTempDir("agent-error-privacy-tmp");
      const home = await makeTempDir("agent-error-privacy-home");
      const databasePath = path.join(stateDir, "state.sqlite");
      const bin = path.join(home, "bin");
      await writeRepository(cwd, bin);
      const server = new WorkflowServer({
        databasePath,
        claimPollMs: 10,
        headlessPi: { kind: "node", node: process.execPath, cli: FAKE_PI },
        env: {
          TMPDIR: tmp,
          HOME: home,
          PI_CODING_AGENT_DIR: path.join(home, "agent"),
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          FAKE_AGENT_GROUP_SCENARIO: scenario,
          FAKE_AGENT_GROUP_PRIVATE_TEXT: privateText,
        },
      });
      const client = new WorkflowClient({ databasePath });
      const runId = `agent-error-${scenario}`;
      await server.start();
      let terminal: string | undefined;
      try {
        await startSanityCheck(client, cwd, runId);
        await waitUntil(() => queueStatus(databasePath, runId) === "failed", 30_000);
        await waitUntil(() => {
          terminal = terminalContent(databasePath, runId);
          return terminal !== undefined;
        }, 30_000);
      } finally {
        await server.stop();
      }

      const bundle = readWorkflowRun(runId, { databasePath, includeTrace: true });
      if (bundle === null) throw new Error("run missing");
      expect(bundle.state.status).toBe("failed");
      const error = bundle.state.error ?? "";
      const cause = /complete cause: (\S+cause\.txt)(?:;|$)/u.exec(error)?.[1];
      if (cause === undefined) throw new Error(`no cause file in: ${error}`);
      expect(error.startsWith(`${facts}. complete cause: ${cause}`)).toBe(true);
      expect(cause.startsWith(`${tmp}${path.sep}pi-workflows-${runId}-agent-group-`)).toBe(true);
      // The complete cause, every character, is only in the private cause file.
      expect(await fs.readFile(cause, "utf8")).toBe(`${facts}\n\n${privateText}\n`);
      expect((await fs.stat(cause)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(cause))).mode & 0o777).toBe(0o700);

      // State and traces: the stored run, every trace event, and every byte of the database.
      expect(JSON.stringify(bundle.state)).not.toContain(marker);
      expect(bundle.traceEvents?.some((event) => JSON.stringify(event).includes(facts))).toBe(true);
      expect(JSON.stringify(bundle.traceEvents)).not.toContain(marker);
      const stored = await filesUnder(stateDir);
      expect(stored.some((entry) => entry.text.includes(facts))).toBe(true);
      expect(
        stored.filter((entry) => entry.text.includes(marker)).map((entry) => entry.file),
      ).toEqual([]);
      // The project directory holds the workflow and nothing that the run wrote privately.
      for (const entry of await filesUnder(cwd)) expect(entry.text).not.toContain(marker);

      // piw renders the stored error and progress, never the private text.
      const rendered = renderRunDetailLines(bundle, { width: 400, height: 400 }).join("\n");
      expect(rendered).toContain(cause);
      expect(rendered).not.toContain(marker);

      // The post-workflow model turn gets the safe facts and where the complete cause is.
      expect(terminal).toContain(cause);
      expect(terminal).not.toContain(marker);
    },
    60_000,
  );
});
