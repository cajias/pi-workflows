import os from "node:os";
import path from "node:path";

/**
 * The pi-workflows configuration directory: `PI_WORKFLOWS_CONFIG_DIR`, or `~/.config/pi-workflows`.
 *
 * Decision channels and built-in workflow defaults share this one directory.
 */
export function workflowsConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_WORKFLOWS_CONFIG_DIR ?? path.join(os.homedir(), ".config", "pi-workflows");
}
