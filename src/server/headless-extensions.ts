import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nearestPackageManifest } from "../client/headless-pi-command.js";

/** Opt-in extension paths that every headless Pi child loads beside its bridge. */
export const HEADLESS_EXTENSIONS_ENV = "PI_WORKFLOWS_HEADLESS_EXTENSIONS";

/** The validated extension paths, or why the list is invalid. An invalid list fails closed. */
export type HeadlessExtensions = { paths: string[] } | { error: string };

const RESTART_HINT = "then restart the workflow server with `pi-workflows server stop`";
/** The pi-workflows package that holds this module, from `src/server` or `dist/server`. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Read the opt-in list once, at server start. Entries are separated by `path.delimiter`, and
 * empty entries are skipped. Each entry must be an absolute path that exists and is not part
 * of pi-workflows, because the pi-workflows extension would compete with the bridge. A single
 * bad entry makes the whole list invalid: children then fail instead of running without an
 * extension that the operator asked for.
 */
export function readHeadlessExtensions(env: NodeJS.ProcessEnv): HeadlessExtensions {
  const paths: string[] = [];
  for (const entry of (env[HEADLESS_EXTENSIONS_ENV] ?? "").split(path.delimiter)) {
    if (entry.length === 0) continue;
    const problem = extensionProblem(entry);
    if (problem !== undefined) {
      return {
        error: `${HEADLESS_EXTENSIONS_ENV} is invalid: ${problem}. Fix it, ${RESTART_HINT}`,
      };
    }
    paths.push(path.normalize(entry));
  }
  return { paths };
}

/** The listed paths, checked again before each start, because a listed file can be removed. */
export function availableHeadlessExtensions(extensions: HeadlessExtensions): string[] {
  if ("error" in extensions) throw new Error(extensions.error);
  const missing = extensions.paths.find((entry) => !fs.existsSync(entry));
  if (missing !== undefined) {
    throw new Error(
      `The headless extension ${missing} from ${HEADLESS_EXTENSIONS_ENV} no longer exists. Restore it, ${RESTART_HINT}.`,
    );
  }
  return extensions.paths;
}

function extensionProblem(entry: string): string | undefined {
  if (!path.isAbsolute(entry)) return `${JSON.stringify(entry)} is not an absolute path`;
  let real: string;
  try {
    real = fs.realpathSync(entry);
  } catch {
    return `${entry} does not exist`;
  }
  if (isPiWorkflows(real)) {
    return `${entry} is part of pi-workflows, whose extension must not load beside the headless bridge`;
  }
  return undefined;
}

/** Inside this package's root, or inside any package with this package's name. */
function isPiWorkflows(real: string): boolean {
  const root = realOrSelf(PACKAGE_ROOT);
  const relative = path.relative(root, real);
  const outside =
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (!outside) return true;
  const start = fs.statSync(real).isDirectory() ? real : path.dirname(real);
  const name = nearestPackageManifest(start)?.manifest.name;
  return name !== undefined && name === nearestPackageManifest(root)?.manifest.name;
}

function realOrSelf(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}
