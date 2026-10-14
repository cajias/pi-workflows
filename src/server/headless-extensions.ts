import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nearestPackageManifest } from "../client/headless-pi-command.js";

/** Opt-in extension paths that every headless Pi child loads beside its bridge. */
export const HEADLESS_EXTENSIONS_ENV = "PI_WORKFLOWS_HEADLESS_EXTENSIONS";

/** One listed extension: the path as configured, and the real file that children load. */
export type HeadlessExtension = { path: string; realpath: string };

/** The validated extensions, or why the list is invalid. An invalid list fails closed. */
export type HeadlessExtensions = { entries: HeadlessExtension[] } | { error: string };

const RESTART_HINT = "then restart the workflow server with `pi-workflows server stop`";
/** The pi-workflows package that holds this module, from `src/server` or `dist/server`. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Read the opt-in list once, at server start. Entries are separated by `path.delimiter`, and
 * empty entries are skipped. Each entry must be the absolute path of an extension file that
 * is not part of pi-workflows, because the pi-workflows extension would compete with the
 * bridge. A directory is refused: Pi would resolve it like a package and could load other
 * files, including pi-workflows, plus skills, prompts, and themes. A single bad entry makes
 * the whole list invalid: children then fail instead of running without an extension that
 * the operator asked for.
 */
export function readHeadlessExtensions(env: NodeJS.ProcessEnv): HeadlessExtensions {
  const entries: HeadlessExtension[] = [];
  for (const entry of (env[HEADLESS_EXTENSIONS_ENV] ?? "").split(path.delimiter)) {
    if (entry.length === 0) continue;
    const inspected = inspectExtension(entry);
    if ("problem" in inspected) {
      return {
        error: `${HEADLESS_EXTENSIONS_ENV} is invalid: ${inspected.problem}. Fix it, ${RESTART_HINT}`,
      };
    }
    entries.push({ path: path.normalize(entry), realpath: inspected.realpath });
  }
  return { entries };
}

/**
 * The real files that a child loads, checked again in full before each start. The file must
 * still pass every rule and resolve to the real file pinned at server start, so a removed
 * file or a symlink pointed elsewhere fails closed instead of loading something unchecked.
 */
export function availableHeadlessExtensions(extensions: HeadlessExtensions): string[] {
  if ("error" in extensions) throw new Error(extensions.error);
  return extensions.entries.map((entry) => {
    const inspected = inspectExtension(entry.path);
    const problem =
      "problem" in inspected
        ? inspected.problem
        : inspected.realpath === entry.realpath
          ? undefined
          : `${entry.path} now resolves to ${inspected.realpath} instead of ${entry.realpath}`;
    if (problem !== undefined) {
      throw new Error(
        `The headless extension ${entry.path} from ${HEADLESS_EXTENSIONS_ENV} changed after the workflow server started: ${problem}. Restore it, ${RESTART_HINT}.`,
      );
    }
    return entry.realpath;
  });
}

function inspectExtension(entry: string): { realpath: string } | { problem: string } {
  const problem = extensionProblem(entry);
  return problem === undefined ? { realpath: fs.realpathSync(entry) } : { problem };
}

function extensionProblem(entry: string): string | undefined {
  if (!path.isAbsolute(entry)) return `${JSON.stringify(entry)} is not an absolute path`;
  let real: string;
  try {
    real = fs.realpathSync(entry);
  } catch {
    return `${entry} does not exist`;
  }
  const stat = fs.statSync(real);
  if (stat.isDirectory()) {
    return `${entry} is a directory. Pi would load every extension, skill, prompt, and theme that it resolves there, so list the extension's entry file instead, such as <package>/dist/index.js or <package>/index.ts`;
  }
  if (!stat.isFile()) return `${entry} is not a regular file`;
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
  const name = nearestPackageManifest(path.dirname(real))?.manifest.name;
  return name !== undefined && name === nearestPackageManifest(root)?.manifest.name;
}

function realOrSelf(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}
