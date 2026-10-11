import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopTempWorkflowServers } from "./temp-workflow-servers.js";

export const TEST_TEMP_ROOT_ENV = "PI_WORKFLOWS_TEST_TEMP_ROOT";

/**
 * Forge configuration the suite isolates. The two config directories point at missing temporary
 * paths, so forge detection never reads the developer's gh or glab hosts.
 */
const FORGE_ENVIRONMENT = ["GH_CONFIG_DIR", "GLAB_CONFIG_DIR", "GITLAB_HOST"] as const;

let ownedRoot: string | undefined;
let previousRoot: string | undefined;
let previousConfigDir: string | undefined;
let previousForgeEnvironment: Partial<Record<(typeof FORGE_ENVIRONMENT)[number], string>> = {};

export function setup(): void {
  previousRoot = process.env[TEST_TEMP_ROOT_ENV];
  if (previousRoot !== undefined) return;

  ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pw-tests-"));
  process.env[TEST_TEMP_ROOT_ENV] = ownedRoot;
  previousConfigDir = process.env.PI_WORKFLOWS_CONFIG_DIR;
  process.env.PI_WORKFLOWS_CONFIG_DIR = path.join(ownedRoot, "config");
  previousForgeEnvironment = {};
  for (const name of FORGE_ENVIRONMENT) {
    const value = process.env[name];
    if (value !== undefined) previousForgeEnvironment[name] = value;
  }
  process.env.GH_CONFIG_DIR = path.join(ownedRoot, "missing-gh-config");
  process.env.GLAB_CONFIG_DIR = path.join(ownedRoot, "missing-glab-config");
  delete process.env.GITLAB_HOST;
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
  if (previousRoot === undefined) delete process.env[TEST_TEMP_ROOT_ENV];
  else process.env[TEST_TEMP_ROOT_ENV] = previousRoot;
  if (previousConfigDir === undefined) delete process.env.PI_WORKFLOWS_CONFIG_DIR;
  else process.env.PI_WORKFLOWS_CONFIG_DIR = previousConfigDir;
  for (const name of FORGE_ENVIRONMENT) {
    const value = previousForgeEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  previousRoot = undefined;
  previousConfigDir = undefined;
  previousForgeEnvironment = {};
}
