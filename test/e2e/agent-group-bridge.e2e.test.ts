import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTempDir, waitUntil } from "../helpers.js";

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
  faux.setResponses([
    process.env.PI_WORKFLOWS_E2E_REVIEW_MODE === "hang"
      ? async (_context, options) => {
          await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve));
          return fauxAssistantMessage("aborted");
        }
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
  updates: Array<{ key: string; status: string; label?: string }>;
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
    FAKE_PI_BIN: path.join(root, "bin", "pi"),
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
  for (const name of ["home", "project", "bin", "config", "agent", "fixtures"]) {
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
  // The real Pi CLI, started with this Node binary.
  await fs.writeFile(
    path.join(root, "bin", "pi"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(PI_ENTRY)} "$@"\n`,
    { encoding: "utf8", mode: 0o755 },
  );
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
    expect(output.updates).toContainEqual({
      key: "agents/review/review",
      status: "completed",
      label: "Combined review · fixture-review/fixture-model",
    });
    expect(output.updates.at(-1)).toMatchObject({ key: "agents/review", status: "completed" });
    expect(output.pids).toHaveLength(1);
    await waitUntil(() => output.pids.every(processGone), 10_000);
  }, 120_000);

  it("cancels a running review session and stops headless pi", async () => {
    const output = await runReview({
      PI_WORKFLOWS_E2E_REVIEW_MODE: "hang",
      PI_WORKFLOWS_TEST_CANCEL_WHEN_RUNNING: "1",
    });

    expect(output.error).toBe("Pi agent group cancelled: test cancellation");
    // The bridge aborted the live child session and reported its final state.
    expect(output.updates).toContainEqual(
      expect.objectContaining({ key: "agents/review/review", status: "cancelled" }),
    );
    expect(output.updates.at(-1)).toMatchObject({ key: "agents/review", status: "cancelled" });
    expect(output.pids).toHaveLength(1);
    await waitUntil(() => output.pids.every(processGone), 10_000);
  }, 120_000);
});
