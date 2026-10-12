import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { builtinWorkflowCatalog } from "../src/builtins/catalog.js";
import { makeTempDir } from "./helpers.js";

// Pi supplies these packages only to modules that it loads itself, and `pi install`
// installs this package with npm's legacy peer handling, so they are absent from an
// installed package tree. Plain Node processes must never reach a value import of them.
const HOST_PACKAGE =
  /^(?:@earendil-works\/pi-(?:ai|agent-core|coding-agent|tui)|@mariozechner\/pi-[\w.-]+|typebox|@sinclair\/typebox)$/u;
const BLOCKED_MARKER = "PI_WORKFLOWS_TEST_BLOCKED_PI_PACKAGE";
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TSX_LOADER = createRequire(path.join(REPO_ROOT, "src", "client", "client.ts")).resolve("tsx");
const BLOCK_HOOK = path.join(REPO_ROOT, "test", "fixtures", "block-pi-packages.mjs");
const SPAWN_TIMEOUT_MS = 60_000;

/** Modules that Node loads without Pi's module mapping, as process entries or public imports. */
const PLAIN_NODE_MODULES = [
  "server/resolver-entry",
  "server/workflow-runner-entry",
  "server/resource-runner-entry",
  "channels/adapter-entry",
  "server/server",
  "viewer/cli",
  "builtins/catalog",
  "builtins/index",
  "workflows/index",
  "resource-managers/index",
  "client/index",
] as const;

/** The server entry starts a server on import, so only its static graph is checked. */
const STATIC_ONLY_PLAIN_NODE_MODULES = ["server/server-entry"] as const;

/** Modules that Pi loads as extensions, so host packages resolve through Pi's mapping. */
const PI_LOADED_MODULES = [
  "extension/index",
  "server/rpc-bridge",
  "server/agent-group-bridge",
] as const;

// Runs inside each spawned child. It first proves that a host package cannot load, then
// imports the module under test.
const IMPORT_PROBE = [
  `const marker = ${JSON.stringify(BLOCKED_MARKER)};`,
  'const probe = await import("@earendil-works/pi-ai").then(() => "loaded", (error) => String(error?.message ?? error));',
  "if (!probe.includes(marker)) {",
  "  process.stderr.write(`host package was not blocked: ${probe}\\n`);",
  "  process.exit(97);",
  "}",
  "await import(process.env.PI_WORKFLOWS_TEST_ENTRY_URL);",
  'process.stdout.write("IMPORT_OK\\n");',
].join("\n");

const REVIEW_PROBE = path.join(REPO_ROOT, "test", "fixtures", "run-sanity-review.mjs");
const FAKE_PI = path.join(REPO_ROOT, "test", "fixtures", "fake-agent-group-pi.mjs");

type Form = {
  name: "src" | "dist";
  root: string;
  extension: ".ts" | ".js";
  /** Node flags that load this form; the source form needs the TypeScript loader. */
  loaderArgs: string[];
};

type NodeResult = { code: number | null; stdout: string; stderr: string };

let sandbox: string;
let builtPackage: string;

function sourceForm(): Form {
  return {
    name: "src",
    root: path.join(REPO_ROOT, "src"),
    extension: ".ts",
    loaderArgs: ["--import", TSX_LOADER],
  };
}

function builtForm(): Form {
  return {
    name: "dist",
    root: path.join(builtPackage, "dist"),
    extension: ".js",
    loaderArgs: [],
  };
}

function blockedArgs(form: Form): string[] {
  return [...form.loaderArgs, "--import", BLOCK_HOOK];
}

function modulePath(form: Form, name: string): string {
  return path.join(form.root, `${name}${form.extension}`);
}

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const home = path.join(sandbox, "home");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
    PI_WORKFLOWS_CONFIG_DIR: path.join(sandbox, "config"),
  };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  return env;
}

async function runNode(
  args: string[],
  extraEnv: Record<string, string> = {},
  input = "",
): Promise<NodeResult> {
  const child = spawn(process.execPath, args, {
    cwd: path.join(sandbox, "project"),
    env: { ...isolatedEnvironment(), ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: SPAWN_TIMEOUT_MS,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.stdin.end(input);
  const [code] = (await once(child, "exit")) as [number | null];
  return { code, stdout, stderr };
}

async function importWithHostPackagesBlocked(form: Form, target: string): Promise<NodeResult> {
  return await runNode([...blockedArgs(form), "--input-type=module", "-e", IMPORT_PROBE], {
    PI_WORKFLOWS_TEST_ENTRY_URL: pathToFileURL(target).href,
  });
}

async function resolveWithHostPackagesBlocked(form: Form, workflowRef: string) {
  const request = {
    schema: "pi-workflows.resolve-request.v1",
    cwd: path.join(sandbox, "project"),
    workflowRef,
  };
  return await runNode(
    [...blockedArgs(form), modulePath(form, "server/resolver-entry")],
    {},
    JSON.stringify(request),
  );
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

const STATIC_SPECIFIER = /^\s*(?:import|export)\s+(?:[^;"'`]*?\s+from\s*)?(["'])([^"'\n]+)\1/gmu;
const LITERAL_DYNAMIC_SPECIFIER = /(?<![\w$.])import\s*\(\s*(["'])([^"'\n]+)\1\s*\)/gu;
const ANY_DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(/gu;

/** Runtime specifiers of one emitted module. Type-only imports are already erased by tsc. */
function runtimeSpecifiers(file: string, source: string): string[] {
  const statics = [...source.matchAll(STATIC_SPECIFIER)].map((match) => match[2] ?? "");
  const dynamics = [...source.matchAll(LITERAL_DYNAMIC_SPECIFIER)].map((match) => match[2] ?? "");
  const dynamicCount = [...source.matchAll(ANY_DYNAMIC_IMPORT)].length;
  if (dynamicCount !== dynamics.length) {
    throw new Error(`${file} has a dynamic import that the graph check cannot follow`);
  }
  return [...statics, ...dynamics];
}

type PackageUse = { packageName: string; chain: string[] };

/** Walk the emitted module graph from one entry and report every bare package it reaches. */
async function reachablePackages(entry: string): Promise<PackageUse[]> {
  const parents = new Map<string, string | undefined>([[entry, undefined]]);
  const queue = [entry];
  const uses: PackageUse[] = [];
  const chainTo = (file: string): string[] => {
    const chain: string[] = [];
    for (let at: string | undefined = file; at !== undefined; at = parents.get(at)) {
      chain.unshift(path.relative(builtPackage, at));
    }
    return chain;
  };
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const source = await fs.readFile(file, "utf8");
    for (const specifier of runtimeSpecifiers(file, source)) {
      if (!specifier.startsWith(".")) {
        if (!isBuiltin(specifier)) {
          uses.push({ packageName: packageName(specifier), chain: chainTo(file) });
        }
        continue;
      }
      const target = path.resolve(path.dirname(file), specifier);
      await fs.access(target);
      if (parents.has(target)) continue;
      parents.set(target, file);
      queue.push(target);
    }
  }
  return uses;
}

function describeUses(uses: PackageUse[]): string[] {
  return [...new Set(uses.map((use) => `${use.packageName} via ${use.chain.join(" -> ")}`))];
}

async function runtimeDependencies(): Promise<Set<string>> {
  const manifest = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return new Set(Object.keys(manifest.dependencies ?? {}));
}

beforeAll(async () => {
  sandbox = await makeTempDir("plain-node-entries");
  await fs.mkdir(path.join(sandbox, "project"), { recursive: true });
  await fs.mkdir(path.join(sandbox, "home", ".pi", "agent"), { recursive: true });
  builtPackage = path.join(sandbox, "package");
  await fs.mkdir(builtPackage, { recursive: true });
  // Build with the release tsconfig into the sandbox. The package manifest makes the
  // emitted files ESM, and the linked node_modules supplies regular dependencies.
  const build = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      path.join(REPO_ROOT, "tsconfig.build.json"),
      "--outDir",
      path.join(builtPackage, "dist"),
    ],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 },
  );
  if (build.status !== 0) {
    throw new Error(`tsc build failed:\n${build.stdout}\n${build.stderr}`);
  }
  await fs.copyFile(path.join(REPO_ROOT, "package.json"), path.join(builtPackage, "package.json"));
  await fs.symlink(path.join(REPO_ROOT, "node_modules"), path.join(builtPackage, "node_modules"));
}, 180_000);

describe("host package guard", () => {
  it("blocks host packages that the development tree can otherwise load", async () => {
    for (const form of [sourceForm(), builtForm()]) {
      const target = pathToFileURL(modulePath(form, "builtins/pi-agent-group")).href;
      // Development installs contain every host package, so the module loads without the hook.
      const unblocked = await runNode([
        ...form.loaderArgs,
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(target)}); process.stdout.write("LOADED\\n");`,
      ]);
      expect(unblocked.code, `${form.name}: ${unblocked.stderr}`).toBe(0);
      expect(unblocked.stdout).toContain("LOADED");
      const blocked = await importWithHostPackagesBlocked(
        form,
        modulePath(form, "builtins/pi-agent-group"),
      );
      expect(blocked.code, `${form.name}: ${blocked.stderr}`).not.toBe(0);
      expect(blocked.stderr).toContain(`${BLOCKED_MARKER} @earendil-works/pi-ai`);
    }
  }, 120_000);
});

describe("plain-node module graphs", () => {
  it.each([...PLAIN_NODE_MODULES, ...STATIC_ONLY_PLAIN_NODE_MODULES])(
    "%s reaches only regular dependencies",
    async (name) => {
      const dependencies = await runtimeDependencies();
      const uses = await reachablePackages(modulePath(builtForm(), name));
      expect(describeUses(uses.filter((use) => !dependencies.has(use.packageName)))).toEqual([]);
    },
  );

  it.each(PI_LOADED_MODULES)(
    "%s reaches only regular dependencies and packages that Pi supplies",
    async (name) => {
      const dependencies = await runtimeDependencies();
      const uses = await reachablePackages(modulePath(builtForm(), name));
      const unexpected = uses.filter(
        (use) => !dependencies.has(use.packageName) && !HOST_PACKAGE.test(use.packageName),
      );
      expect(describeUses(unexpected)).toEqual([]);
    },
  );
});

describe.concurrent.each(["src", "dist"] as const)(
  "plain-node entries without host packages (%s)",
  (formName) => {
    const form = () => (formName === "src" ? sourceForm() : builtForm());

    it.each(PLAIN_NODE_MODULES)(
      "imports %s",
      async (name) => {
        const result = await importWithHostPackagesBlocked(form(), modulePath(form(), name));
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain("IMPORT_OK");
      },
      SPAWN_TIMEOUT_MS,
    );

    it.each(builtinWorkflowCatalog.listDiscoverable().map((entry) => entry.id))(
      "resolves built-in %s through the resolver process",
      async (id) => {
        const result = await resolveWithHostPackagesBlocked(form(), id);
        expect(result.code, result.stderr).toBe(0);
        const resolved = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(resolved).toMatchObject({
          schema: "pi-workflows.resolved-launch.v1",
          workflowName: builtinWorkflowCatalog.get(id)?.definition.name,
          workflowSourceRef: `builtin:${id}`,
        });
      },
      SPAWN_TIMEOUT_MS,
    );
  },
);

describe.each(["src", "dist"] as const)(
  "workflow runner actions without host packages (%s)",
  (formName) => {
    it(
      "runs Sanity Check's review through the headless pi agent group launcher",
      async () => {
        const form = formName === "src" ? sourceForm() : builtForm();
        const piBin = path.join(sandbox, `fake-pi-${formName}`);
        const argvFile = path.join(sandbox, `fake-pi-${formName}.json`);
        await fs.writeFile(
          piBin,
          `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_PI)} "$@"\n`,
          { encoding: "utf8", mode: 0o755 },
        );
        const review = {
          areas: ["necessity", "duplication", "contracts", "scope_tests"].map((area) => ({
            area,
            assessment: "unclear",
            summary: `${area} needs product intent`,
            evidence: [],
          })),
          acceptanceCase: "The change is small.",
          questions: [],
          unknowns: [],
        };
        const result = await runNode([...blockedArgs(form), REVIEW_PROBE], {
          PI_WORKFLOWS_TEST_FORM_ROOT: form.root,
          PI_WORKFLOWS_TEST_FORM_EXTENSION: form.extension,
          FAKE_PI_BIN: piBin,
          FAKE_PI_ARGV_FILE: argvFile,
          FAKE_AGENT_GROUP_SCENARIO: "success",
          FAKE_AGENT_GROUP_TEXT: JSON.stringify(review),
        });
        expect(result.code, result.stderr).toBe(0);
        const output = JSON.parse(result.stdout) as {
          reviews: unknown[];
          updates: Array<{ key: string; status: string }>;
        };
        expect(output.reviews).toEqual([review]);
        expect(output.updates).toContainEqual(
          expect.objectContaining({ key: "agents/review/review", status: "completed" }),
        );
        const launched = JSON.parse(await fs.readFile(argvFile, "utf8")) as { argv: string[] };
        expect(launched.argv[5]).toBe(modulePath(form, "server/agent-group-bridge"));
      },
      SPAWN_TIMEOUT_MS,
    );
  },
);
