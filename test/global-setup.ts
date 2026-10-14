import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopTempWorkflowServers } from "./temp-workflow-servers.js";

export const TEST_TEMP_ROOT_ENV = "PI_WORKFLOWS_TEST_TEMP_ROOT";

/**
 * The temporary home under the test root. The name is one character because the default workflow
 * server socket sits under this home, and a Unix socket path is limited to 107 bytes on Linux.
 */
const TEST_HOME_DIRECTORY = "h";

/** The empty global Git configuration under the test root. */
const TEST_GIT_CONFIG_FILE = "gitconfig";

/**
 * The user environment the suite isolates. Every test process and every child that inherits its
 * environment sees these values, so no default path resolves to the developer's directories.
 *
 * - `HOME` is a temporary home. pi-workflows resolves its state database, global workflows, and
 *   global resource managers from `os.homedir()`. Pi falls back to `~/.pi/agent` from it.
 * - `PI_CODING_AGENT_DIR` is the Pi agent directory inside that home, so Pi settings, auth,
 *   models, and packages never come from the developer's agent directory.
 * - The XDG base directories sit inside that home. The gh and glab hosts lookup reads
 *   `XDG_CONFIG_HOME`, and Pi's llama.cpp extension reads `XDG_CACHE_HOME`.
 * - `PI_WORKFLOWS_CONFIG_DIR` is a temporary configuration directory.
 * - Git reads no system configuration and an empty global configuration, so the developer's
 *   identity, hooks, and signing settings never apply. Tests that commit set their own identity in
 *   each repository.
 * - npm uses a temporary cache, logs, and user configuration. `npm run` exports the developer's
 *   `npm_config_cache` and `npm_config_userconfig` to the suite, so `HOME` alone would not move
 *   them. The update notifier is off because it queries the registry from a fresh cache.
 * - The forge configuration directories point at missing temporary paths. Detection reads only
 *   `GH_CONFIG_DIR` or `GLAB_CONFIG_DIR` when it is set, so it never falls back to the developer's
 *   gh or glab hosts.
 * - Variables that a parent Pi, Herdr, or shell session sets are unset, so they cannot change what
 *   the suite runs.
 */
function isolatedTestEnvironment(root: string): Record<string, string | undefined> {
  const home = path.join(root, TEST_HOME_DIRECTORY);
  return {
    HOME: home,
    PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    PI_WORKFLOWS_CONFIG_DIR: path.join(root, "config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, TEST_GIT_CONFIG_FILE),
    npm_config_cache: path.join(home, ".npm"),
    npm_config_userconfig: path.join(home, ".npmrc"),
    npm_config_update_notifier: "false",
    GH_CONFIG_DIR: path.join(root, "missing-gh-config"),
    GLAB_CONFIG_DIR: path.join(root, "missing-glab-config"),
    GITLAB_HOST: undefined,
    PI_CODING_AGENT_SESSION_DIR: undefined,
    PI_WORKFLOWS_E2E_PI_ENTRY: undefined,
    PI_WORKFLOWS_HEADLESS_EXTENSIONS: undefined,
    HERDR_ENV: undefined,
  };
}

let ownedRoot: string | undefined;
let previousEnvironment: Record<string, string | undefined> = {};

/**
 * Creates the run's temporary root and isolates the environment under it. A root inherited from a
 * parent run is reused, and the same isolation is applied under it.
 */
export function setup(): void {
  const inheritedRoot = process.env[TEST_TEMP_ROOT_ENV];
  const root = inheritedRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "pw-tests-"));
  if (inheritedRoot === undefined) ownedRoot = root;
  const environment = { ...isolatedTestEnvironment(root), [TEST_TEMP_ROOT_ENV]: root };
  fs.mkdirSync(path.join(root, TEST_HOME_DIRECTORY), { recursive: true });
  fs.writeFileSync(path.join(root, TEST_GIT_CONFIG_FILE), "", { flag: "a" });
  previousEnvironment = {};
  for (const [name, value] of Object.entries(environment)) {
    previousEnvironment[name] = process.env[name];
    setEnvironmentValue(name, value);
  }
}

export async function teardown(): Promise<void> {
  if (ownedRoot !== undefined) {
    const stopped = await stopTempWorkflowServers(ownedRoot);
    if (stopped > 0) {
      process.stderr.write(
        `test harness stopped ${stopped} workflow server(s) left behind by this run\n`,
      );
    }
    fs.rmSync(ownedRoot, { force: true, recursive: true });
    ownedRoot = undefined;
  }
  for (const [name, value] of Object.entries(previousEnvironment)) {
    setEnvironmentValue(name, value);
  }
  previousEnvironment = {};
}

function setEnvironmentValue(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
