import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CANCEL_SETTLE_MS } from "../../src/server/agent-group-launcher.js";
import { makeTempDir, waitUntil } from "../helpers.js";
import { startMockOpenAiServer } from "./mock-openai.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// PI_WORKFLOWS_E2E_PI_ENTRY runs this scenario on another Pi cli.js, such as a newer release.
const PI_ENTRY =
  process.env.PI_WORKFLOWS_E2E_PI_ENTRY ?? path.join(REPO_ROOT, "node_modules", ".bin", "pi");
const TSX_LOADER = createRequire(path.join(REPO_ROOT, "src", "client", "client.ts")).resolve("tsx");
const BLOCK_HOOK = path.join(REPO_ROOT, "test", "fixtures", "block-pi-packages.mjs");
const REVIEW_RUNNER = path.join(REPO_ROOT, "test", "fixtures", "run-sanity-review.mjs");

const REVIEW = {
  areas: ["necessity", "duplication", "contracts", "scope_tests"].map((area) => ({
    area,
    assessment: "unclear",
    summary: `${area} needs product intent`,
    evidence: [],
  })),
  acceptanceCase: "The change is small and isolated.",
  questions: [],
  unknowns: ["Product intent is not recorded."],
};

// A provider extension with a deterministic local model. Pi loads it inside the headless
// child, so its host package import resolves only through Pi's module mapping.
const REVIEW_PROVIDER = `import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

export default function reviewProvider(pi) {
  const faux = fauxProvider({
    provider: "fixture-review",
    api: "fixture-review-api",
    models: [{ id: "fixture-model", name: "Fixture model", reasoning: true }],
  });
  const answer = ${JSON.stringify(JSON.stringify(REVIEW))};
  const mode = process.env.PI_WORKFLOWS_E2E_REVIEW_MODE;
  faux.setResponses([
    mode === "hang"
      ? async (_context, options) => {
          await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve));
          return fauxAssistantMessage("aborted");
        }
      : mode === "provider-error"
        ? fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: process.env.PI_WORKFLOWS_E2E_PROVIDER_ERROR,
          })
        : fauxAssistantMessage(answer),
  ]);
  pi.registerProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Fixture review key",
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

type ReviewOutput = {
  reviews?: unknown[];
  error?: string;
  updates: Array<{ key: string; status: string; phase?: string; label?: string; at: number }>;
  abortedAt?: number;
  pids: number[];
};

let root: string;
let packageSource: string;

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Every directory from `start` to the filesystem root, which Node searches for packages. */
function ancestors(start: string): string[] {
  const directories = [start];
  for (let at = start; path.dirname(at) !== at; at = path.dirname(at)) {
    directories.push(path.dirname(at));
  }
  return directories;
}

async function runReview(env: Record<string, string> = {}): Promise<ReviewOutput> {
  const agentDir = path.join(root, "agent");
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(root, "home"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_WORKFLOWS_CONFIG_DIR: path.join(root, "config"),
    PI_OFFLINE: "1",
    NO_COLOR: "1",
    PI_WORKFLOWS_TEST_FORM_ROOT: packageSource,
    PI_WORKFLOWS_TEST_FORM_EXTENSION: ".ts",
    // The real Pi CLI, pinned with this Node binary.
    PI_WORKFLOWS_TEST_PI_CLI: PI_ENTRY,
    PI_WORKFLOWS_TEST_DIAGNOSTICS_DIR: path.join(root, "logs"),
    ...env,
  };
  delete childEnv.NODE_PATH;
  delete childEnv.NODE_OPTIONS;
  // The workflow runner is plain Node: no Pi module mapping, and every host package blocked.
  const child = spawn(
    process.execPath,
    ["--import", TSX_LOADER, "--import", BLOCK_HOOK, REVIEW_RUNNER],
    { cwd: path.join(root, "project"), env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const [code] = (await once(child, "exit")) as [number | null];
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout) as ReviewOutput;
}

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function runtimeDependencies(): Promise<string[]> {
  const manifest = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(manifest.dependencies ?? {}).toSorted();
}

/** Installed package names in one node_modules directory, including scoped packages. */
async function installedPackages(directory: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await fs.readdir(directory)) {
    if (!entry.startsWith("@")) names.push(entry);
    else {
      for (const scoped of await fs.readdir(path.join(directory, entry))) {
        names.push(`${entry}/${scoped}`);
      }
    }
  }
  return names.toSorted();
}

// Unique OAuth credential values for the legacy fixture provider. None may appear in the
// review output, its error, or any diagnostics file.
const OAUTH_MARKERS = {
  oldAccess: "pw-e2e-oauth-old-access-93a1",
  oldRefresh: "pw-e2e-oauth-old-refresh-93a1",
  newAccess: "pw-e2e-oauth-new-access-93a1",
  newRefresh: "pw-e2e-oauth-new-refresh-93a1",
};

/**
 * An agent directory whose default provider is the legacy fixture extension, with a stored
 * OAuth credential that expires in five minutes. The fixture's refresh mock logs each call.
 */
async function oauthScenario(
  name: string,
  baseUrl: string,
  refresh: "rotate" | "fail",
): Promise<{
  env: Record<string, string>;
  authPath: string;
  refreshLog: string;
  diagnosticsDir: string;
}> {
  const agentDir = path.join(root, `${name}-agent`);
  const diagnosticsDir = path.join(root, `${name}-logs`);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(diagnosticsDir, { recursive: true });
  await writeJson(path.join(agentDir, "settings.json"), {
    defaultProvider: "fixture-legacy",
    defaultModel: "fixture-legacy-model",
    defaultThinkingLevel: "high",
    extensions: [
      path.join(REPO_ROOT, "test", "fixtures", "pi-agent-extensions", "legacy-provider.ts"),
    ],
  });
  const authPath = path.join(agentDir, "auth.json");
  await writeJson(authPath, {
    "fixture-legacy": {
      type: "oauth",
      access: OAUTH_MARKERS.oldAccess,
      refresh: OAUTH_MARKERS.oldRefresh,
      expires: Date.now() + 5 * 60_000,
    },
  });
  const refreshLog = path.join(root, `${name}-refresh.log`);
  return {
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PI_WORKFLOWS_TEST_DIAGNOSTICS_DIR: diagnosticsDir,
      PI_AGENT_FIXTURE_BASE_URL: baseUrl,
      PI_AGENT_FIXTURE_OAUTH: "1",
      PI_AGENT_FIXTURE_OAUTH_REFRESH: refresh,
      PI_AGENT_FIXTURE_OAUTH_REFRESH_FILE: refreshLog,
      PI_AGENT_FIXTURE_OAUTH_NEW_ACCESS: OAUTH_MARKERS.newAccess,
      PI_AGENT_FIXTURE_OAUTH_NEW_REFRESH: OAUTH_MARKERS.newRefresh,
    },
    authPath,
    refreshLog,
    diagnosticsDir,
  };
}

async function refreshCount(file: string): Promise<number> {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  return text.trim() === "" ? 0 : text.trim().split("\n").length;
}

/** Fails when the text or any file under the directory holds an OAuth marker. */
async function expectNoOAuthText(text: string, directory: string): Promise<void> {
  const texts = [text];
  for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      texts.push(await fs.readFile(path.join(entry.parentPath, entry.name), "utf8"));
    }
  }
  for (const marker of Object.values(OAUTH_MARKERS)) {
    for (const value of texts) expect(value).not.toContain(marker);
  }
}

beforeAll(async () => {
  root = await makeTempDir("agent-group-bridge-e2e");
  // A copy of the package like a `pi install` tree: regular dependencies are installed,
  // and the packages that Pi supplies are absent from it and every ancestor directory.
  const packageRoot = path.join(root, "package");
  packageSource = path.join(packageRoot, "src");
  await fs.cp(path.join(REPO_ROOT, "src"), packageSource, { recursive: true });
  await fs.copyFile(path.join(REPO_ROOT, "package.json"), path.join(packageRoot, "package.json"));
  for (const name of await runtimeDependencies()) {
    const target = path.join(packageRoot, "node_modules", name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(path.join(REPO_ROOT, "node_modules", name), target, "dir");
  }
  for (const name of ["home", "project", "config", "agent", "fixtures", "logs"]) {
    await fs.mkdir(path.join(root, name), { recursive: true });
  }
  const provider = path.join(root, "fixtures", "review-provider.ts");
  await fs.writeFile(provider, REVIEW_PROVIDER, "utf8");
  const agentDir = path.join(root, "agent");
  await writeJson(path.join(agentDir, "settings.json"), {
    defaultProvider: "fixture-review",
    defaultModel: "fixture-model",
    defaultThinkingLevel: "high",
    extensions: [provider],
  });
  await writeJson(path.join(agentDir, "models-store.json"), {
    "fixture-review": {
      models: [
        {
          id: "fixture-model",
          name: "Fixture model",
          api: "fixture-review-api",
          provider: "fixture-review",
          baseUrl: "http://localhost:0",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4_096,
        },
      ],
      checkedAt: 1,
    },
  });
  await fs.writeFile(path.join(agentDir, "auth.json"), "{}\n", "utf8");
}, 60_000);

describe("Sanity Check agent groups under the real Pi runtime", () => {
  it("installs no host package where the agent group bridge loads", async () => {
    const bridge = path.join(packageSource, "server", "agent-group-bridge.ts");
    const packageRoot = path.dirname(packageSource);
    await fs.access(bridge);
    expect(await installedPackages(path.join(packageRoot, "node_modules"))).toEqual(
      await runtimeDependencies(),
    );
    for (const directory of ancestors(path.dirname(bridge))) {
      if (directory === packageRoot) continue;
      await expect(fs.access(path.join(directory, "node_modules"))).rejects.toThrow();
    }
    expect(() =>
      createRequire(path.join(packageSource, "builtins", "pi-agent-group.ts")).resolve(
        "@earendil-works/pi-ai",
      ),
    ).toThrow(/Cannot find module/);
  });

  it("runs the review action through the bridge inside headless pi", async () => {
    const output = await runReview();

    expect(output.error).toBeUndefined();
    expect(output.reviews).toEqual([REVIEW]);
    expect(output.updates).toContainEqual(
      expect.objectContaining({
        key: "agents/review/review",
        status: "completed",
        phase: "completed",
        label: "Combined review · fixture-review/fixture-model",
      }),
    );
    expect(output.updates.at(-1)).toMatchObject({ key: "agents/review", status: "completed" });
    expect(output.pids).toHaveLength(1);
    await waitUntil(() => output.pids.every(processGone), 10_000);
  }, 120_000);

  it("runs the review action offline with a provider built into Pi", async () => {
    // `models.json` points Pi's built-in Cerebras provider at a local mock, and there is no
    // cached model catalog, so the model comes from Pi's bundled catalog.
    const mock = await startMockOpenAiServer(() => ({
      kind: "text",
      text: JSON.stringify(REVIEW),
    }));
    const agentDir = path.join(root, "builtin-agent");
    await fs.mkdir(agentDir, { recursive: true });
    await writeJson(path.join(agentDir, "settings.json"), {
      defaultProvider: "cerebras",
      defaultModel: "gpt-oss-120b",
      defaultThinkingLevel: "high",
    });
    await writeJson(path.join(agentDir, "models.json"), {
      providers: { cerebras: { baseUrl: mock.baseUrl } },
    });
    await writeJson(path.join(agentDir, "auth.json"), {
      cerebras: { type: "api_key", key: "builtin-provider-key" },
    });
    try {
      const output = await runReview({ PI_CODING_AGENT_DIR: agentDir });

      expect(output.error).toBeUndefined();
      expect(output.reviews).toEqual([REVIEW]);
      expect(output.updates).toContainEqual(
        expect.objectContaining({
          key: "agents/review/review",
          status: "completed",
          label: "Combined review · cerebras/gpt-oss-120b",
        }),
      );
      expect(mock.authorizations).toEqual(["Bearer builtin-provider-key"]);
      // Headless Pi may create an empty models store, but offline it caches no catalog.
      const store = await fs
        .readFile(path.join(agentDir, "models-store.json"), "utf8")
        .catch(() => "{}");
      expect(JSON.parse(store)).not.toHaveProperty("cerebras");
      expect(output.pids).toHaveLength(1);
      await waitUntil(() => output.pids.every(processGone), 10_000);
    } finally {
      await mock.close();
    }
  }, 120_000);

  it("refreshes a near-expiry OAuth credential once in the headless pi host", async () => {
    const mock = await startMockOpenAiServer(() => ({
      kind: "text",
      text: JSON.stringify(REVIEW),
    }));
    const scenario = await oauthScenario("oauth-refresh", mock.baseUrl, "rotate");
    try {
      const output = await runReview(scenario.env);

      expect(output.error).toBeUndefined();
      expect(output.reviews).toEqual([REVIEW]);
      // One refresh in the bridge host, saved by Pi, and the child used the new credential.
      expect(await refreshCount(scenario.refreshLog)).toBe(1);
      expect(mock.authorizations).toEqual([`Bearer ${OAUTH_MARKERS.newAccess}`]);
      const stored = JSON.parse(await fs.readFile(scenario.authPath, "utf8")) as Record<
        string,
        unknown
      >;
      expect(stored["fixture-legacy"]).toMatchObject({
        type: "oauth",
        access: OAUTH_MARKERS.newAccess,
        refresh: OAUTH_MARKERS.newRefresh,
      });
      await expectNoOAuthText(JSON.stringify(output), scenario.diagnosticsDir);
      await waitUntil(() => output.pids.every(processGone), 10_000);
    } finally {
      await mock.close();
    }
  }, 120_000);

  it("fails before any session starts when the headless pi host cannot refresh", async () => {
    const mock = await startMockOpenAiServer(() => ({ kind: "text", text: "must not run" }));
    const scenario = await oauthScenario("oauth-failure", mock.baseUrl, "fail");
    try {
      const output = await runReview(scenario.env);

      expect(output.error).toMatch(
        /^Pi agent group could not refresh OAuth credentials: fixture-legacy; sign in to the provider again in Pi, or configure an API key for it\. complete cause: /,
      );
      expect(await refreshCount(scenario.refreshLog)).toBe(1);
      expect(mock.requests).toHaveLength(0);
      // The kept cause file names the failure; the refresh error, which quoted the refresh
      // token, is saved nowhere.
      await expectNoOAuthText(JSON.stringify(output), scenario.diagnosticsDir);
      await waitUntil(() => output.pids.every(processGone), 10_000);
    } finally {
      await mock.close();
    }
  }, 120_000);

  it("cancels a running review session and stops headless pi", async () => {
    const output = await runReview({
      PI_WORKFLOWS_E2E_REVIEW_MODE: "hang",
      PI_WORKFLOWS_TEST_CANCEL_WHEN_RUNNING: "1",
    });

    expect(output.error).toBe("Pi agent group cancelled: test cancellation");
    // The bridge aborted the live child session and confirmed its final state within the
    // settle grace, so the launcher reported nothing on its behalf.
    const settled = output.updates.filter((update) => update.key === "agents/review/review").at(-1);
    expect(settled).toMatchObject({ status: "cancelled", phase: "cancelled" });
    const settleMs = (settled?.at ?? Number.POSITIVE_INFINITY) - (output.abortedAt ?? 0);
    process.stdout.write(`real-Pi cancellation settled in ${settleMs} ms\n`);
    expect(settleMs).toBeLessThan(CANCEL_SETTLE_MS);
    expect(output.updates.at(-1)).toMatchObject({ key: "agents/review", status: "cancelled" });
    expect(output.pids).toHaveLength(1);
    await waitUntil(() => output.pids.every(processGone), 10_000);
    // Neither group failed to run, so no stderr log remains.
    expect(await fs.readdir(path.join(root, "logs"))).toEqual([]);
  }, 120_000);

  it("saves a real provider error only in the cause file that the action error names", async () => {
    const privateText = `invalid request PRIVATE_E2E_PROVIDER_MARKER ${"x".repeat(6_000)} END`;
    const output = await runReview({
      PI_WORKFLOWS_E2E_REVIEW_MODE: "provider-error",
      PI_WORKFLOWS_E2E_PROVIDER_ERROR: privateText,
    });

    const facts = "Pi agent review stopped with error: the provider reported an error";
    const cause = /complete cause: (\S+cause\.txt)$/u.exec(output.error ?? "")?.[1];
    expect(output.error).toBe(`${facts}. complete cause: ${cause}`);
    expect(cause?.startsWith(path.join(root, "logs") + path.sep)).toBe(true);
    expect(await fs.readFile(cause ?? "", "utf8")).toBe(`${facts}\n\n${privateText}\n`);
    expect(JSON.stringify(output.updates)).not.toContain("PRIVATE_E2E_PROVIDER_MARKER");
    expect(
      output.updates.filter((update) => update.key === "agents/review/review").at(-1),
    ).toMatchObject({ status: "failed" });
    // The bridge reported the error, so only the cause file stays.
    expect(await fs.readdir(path.dirname(cause ?? ""))).toEqual(["cause.txt"]);
    await waitUntil(() => output.pids.every(processGone), 10_000);
    await fs.rm(path.dirname(cause ?? ""), { recursive: true, force: true });
  }, 120_000);
});
