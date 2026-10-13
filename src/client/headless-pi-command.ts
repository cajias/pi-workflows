import fs from "node:fs";
import path from "node:path";

/**
 * The pi that a workflow server starts for headless agent steps and agent groups. A pi that
 * is a Node script runs as the pinned Node with the pinned CLI script. A self-contained pi
 * executable runs directly.
 */
export type HeadlessPiCommand =
  | { kind: "node"; node: string; cli: string }
  | { kind: "executable"; executable: string };

/** The facts about a running process that identify the pi CLI it runs. */
export type PiProcessFacts = {
  execPath: string;
  argv: readonly string[];
  /** True when the process is a Node single executable application. */
  sea: boolean;
};

const NODE_FLAG = "--headless-pi-node";
const CLI_FLAG = "--headless-pi-cli";
const EXECUTABLE_FLAG = "--headless-pi-executable";
/** A Bun compiled executable reports its entry script on Bun's virtual filesystem. */
const BUN_VIRTUAL_SCRIPT = /\$bunfs|~BUN|%7EBUN/;

/**
 * Identify the pi CLI that runs this process, the way Pi's subagent example starts pi again:
 * the running executable with its entry script, or a compiled pi executable alone. The entry
 * script counts only when it is a `bin` of a package with a `piConfig`, which every pi CLI
 * package has. An SDK host or a test runner therefore yields undefined.
 */
export function currentPiCommand(
  facts: PiProcessFacts = runningProcessFacts(),
): HeadlessPiCommand | undefined {
  const script = facts.argv[1];
  if (facts.sea || (script !== undefined && BUN_VIRTUAL_SCRIPT.test(script))) {
    return { kind: "executable", executable: facts.execPath };
  }
  const cli = script === undefined ? undefined : realFile(script);
  if (cli === undefined || !isPiCliScript(cli)) return undefined;
  return { kind: "node", node: facts.execPath, cli };
}

/** Server entry arguments that hand a pin to the server that a client starts. */
export function headlessPiCommandArgs(command: HeadlessPiCommand | undefined): string[] {
  if (command === undefined) return [];
  return command.kind === "node"
    ? [NODE_FLAG, command.node, CLI_FLAG, command.cli]
    : [EXECUTABLE_FLAG, command.executable];
}

/** Read the pin that {@link headlessPiCommandArgs} wrote, or undefined when none was given. */
export function parseHeadlessPiCommandArgs(argv: readonly string[]): HeadlessPiCommand | undefined {
  const node = flagPath(argv, NODE_FLAG);
  const cli = flagPath(argv, CLI_FLAG);
  const executable = flagPath(argv, EXECUTABLE_FLAG);
  if (executable !== undefined && node === undefined && cli === undefined) {
    return { kind: "executable", executable };
  }
  if (executable === undefined && node !== undefined && cli !== undefined) {
    return { kind: "node", node, cli };
  }
  if (executable === undefined && node === undefined && cli === undefined) return undefined;
  throw new Error(
    `Give either ${NODE_FLAG} with ${CLI_FLAG}, or ${EXECUTABLE_FLAG} alone, to pin headless pi`,
  );
}

function flagPath(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || !path.isAbsolute(value)) {
    throw new Error(`${flag} requires an absolute path`);
  }
  return value;
}

function runningProcessFacts(): PiProcessFacts {
  // Node added getBuiltinModule in 22.3, and other runtimes may lack it or node:sea.
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: string) => { isSea?: () => boolean } | undefined)
    | undefined;
  const sea = getBuiltinModule?.("node:sea");
  return { execPath: process.execPath, argv: process.argv, sea: sea?.isSea?.() === true };
}

/** True when `cli` is a `bin` entry of the nearest package, and that package configures pi. */
function isPiCliScript(cli: string): boolean {
  for (let directory = path.dirname(cli); ; directory = path.dirname(directory)) {
    const manifest = readManifest(path.join(directory, "package.json"));
    if (manifest !== undefined) {
      return (
        isRecord(manifest.piConfig) &&
        binScripts(manifest.bin).some((bin) => realFile(path.resolve(directory, bin)) === cli)
      );
    }
    if (path.dirname(directory) === directory) return false;
  }
}

/** The parsed manifest, `{}` when it is unreadable as an object, or undefined when absent. */
function readManifest(file: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function binScripts(bin: unknown): string[] {
  if (typeof bin === "string") return [bin];
  if (!isRecord(bin)) return [];
  return Object.values(bin).filter((value): value is string => typeof value === "string");
}

function realFile(file: string): string | undefined {
  try {
    const real = fs.realpathSync(file);
    return fs.statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
