import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { assertSocketPathSupported, clientSocketPath } from "../src/client/protocol.js";
import { resourceManagerSearchDirs } from "../src/resource-managers/loader.js";
import { workflowsConfigDir } from "../src/state/config-dir.js";
import { workflowStatePath } from "../src/state/database.js";
import { workflowSearchDirs } from "../src/workflows/loader.js";
import { TEST_TEMP_ROOT_ENV } from "./global-setup.js";

const execFileAsync = promisify(execFile);

/**
 * Variables that a parent Pi, Herdr, or shell session sets and the suite must not inherit.
 *
 * `PI_WORKFLOWS_E2E_PI_ENTRY` is not here on purpose. A developer sets it explicitly to choose which
 * Pi CLI the E2E suite runs. It is not a user directory and does not point tests at the real home,
 * so the suite keeps it.
 */
const PARENT_SESSION_ENVIRONMENT = [
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_WORKFLOWS_HEADLESS_EXTENSIONS",
  "HERDR_ENV",
  "GITLAB_HOST",
];

function testTempRoot(): string {
  const root = process.env[TEST_TEMP_ROOT_ENV];
  if (root === undefined) throw new Error(`${TEST_TEMP_ROOT_ENV} is not set`);
  return root;
}

/** Whether `target` is `root` or a path below it, after both are resolved. */
function isInside(root: string, target: string | undefined): boolean {
  if (target === undefined || target === "") return false;
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function expectInsideTestRoot(paths: Record<string, string | undefined>): void {
  const root = testTempRoot();
  const outside = Object.entries(paths).filter(([, value]) => !isInside(root, value));
  expect(outside, `paths outside the test temp root ${root}`).toEqual([]);
}

describe("test process isolation", () => {
  it("keeps the test temp root inside the system temporary directory", () => {
    expect(isInside(os.tmpdir(), testTempRoot())).toBe(true);
  });

  it("isolates HOME and the Pi agent directory under the test temp root", () => {
    expectInsideTestRoot({
      HOME: process.env.HOME,
      "os.homedir()": os.homedir(),
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      "Pi getAgentDir()": getAgentDir(),
      PI_WORKFLOWS_CONFIG_DIR: process.env.PI_WORKFLOWS_CONFIG_DIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      npm_config_cache: process.env.npm_config_cache,
      npm_config_userconfig: process.env.npm_config_userconfig,
    });
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(process.env.npm_config_update_notifier).toBe("false");
  });

  it("resolves every default Pi and pi-workflows user path under the test temp root", () => {
    const cwd = testTempRoot();
    expectInsideTestRoot({
      "workflow state database": workflowStatePath(),
      "workflow server socket": clientSocketPath(workflowStatePath()),
      "pi-workflows configuration": workflowsConfigDir(),
      "global workflows": workflowSearchDirs({ cwd }).find(({ source }) => source === "global")
        ?.dir,
      "global resource managers": resourceManagerSearchDirs({ cwd }).find(
        ({ source }) => source === "global",
      )?.dir,
    });
  });

  it("keeps the default workflow server socket path within the operating system limit", () => {
    expect(() => assertSocketPathSupported(clientSocketPath(workflowStatePath()))).not.toThrow();
  });

  it("does not inherit variables from a parent Pi or Herdr session", () => {
    const inherited = PARENT_SESSION_ENVIRONMENT.filter((name) => process.env[name] !== undefined);
    expect(inherited).toEqual([]);
  });

  it("passes the isolated environment to child processes", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "-e",
      `const os = require("node:os");
       process.stdout.write(JSON.stringify({
         home: os.homedir(),
         agentDir: process.env.PI_CODING_AGENT_DIR,
         tempRoot: process.env.${TEST_TEMP_ROOT_ENV},
       }));`,
    ]);
    const child = JSON.parse(stdout) as { home: string; agentDir?: string; tempRoot?: string };
    expect(child.tempRoot).toBe(testTempRoot());
    expectInsideTestRoot({ "child HOME": child.home, "child agent dir": child.agentDir });
  });

  it("gives Git child processes no system or user configuration", async () => {
    const { stdout } = await execFileAsync("git", ["config", "--list", "--show-origin"], {
      cwd: testTempRoot(),
    });
    expect(stdout).toBe("");
  });

  it("gives npm child processes a temporary cache and user configuration", async () => {
    const { stdout } = await execFileAsync(
      "npm",
      ["config", "get", "cache", "userconfig", "update-notifier"],
      { cwd: testTempRoot() },
    );
    const values = Object.fromEntries(
      stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=", 2) as [string, string]),
    );
    expectInsideTestRoot({ cache: values.cache, userconfig: values.userconfig });
    expect(values["update-notifier"]).toBe("false");
  }, 30_000);
});
