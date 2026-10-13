import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { HeadlessPiCommand } from "../client/headless-pi-command.js";
import { errorMessage } from "../workflows/errors.js";
import { isExecutableFile, type HeadlessPiLaunch } from "./headless-pi.js";

const execFileAsync = promisify(execFile);
/** Linux reads at most 256 bytes of a `#!` line and macOS 512, so this covers either kernel. */
const SHEBANG_BYTES = 512;
/** A Node that cannot print its own path in this time cannot start headless pi either. */
const NODE_PROBE_TIMEOUT_MS = 5_000;
const UNRESOLVED_HINT =
  "Start the workflow server from a Pi session, or put pi on the server's PATH, then restart the server with `pi-workflows server stop`";

/** The pi that headless children run for the whole server lifetime, and who chose it. */
export type HeadlessPiPin = {
  /** `session`: the Pi session that started the server; `path`: the server's own `PATH`. */
  source: "session" | "path";
  pi: HeadlessPiLaunch;
};

/** Pin headless pi once at server start. The starting Pi session's own pi wins over `PATH`. */
export async function pinHeadlessPi(
  sessionPi: HeadlessPiCommand | undefined,
  env: NodeJS.ProcessEnv,
): Promise<HeadlessPiPin> {
  if (sessionPi !== undefined) return { source: "session", pi: sessionPi };
  return { source: "path", pi: await resolvePiFromPath(env) };
}

/**
 * Resolve `pi` on `PATH` the way a shell would start it, then pin the result. The command
 * resolves to its real file. A Node script also pins the Node that its `#!` line selects,
 * asked for its own `process.execPath` so a version manager shim resolves once, here.
 */
export async function resolvePiFromPath(env: NodeJS.ProcessEnv): Promise<HeadlessPiLaunch> {
  const found = findOnPath("pi", env);
  if (found === undefined) {
    return unresolved(`no executable pi is on the server's PATH (${env.PATH ?? ""})`);
  }
  const cli = fs.realpathSync(found);
  const interpreter = nodeInterpreter(readShebang(cli));
  if (interpreter === undefined) return { kind: "executable", executable: cli };
  try {
    return { kind: "node", node: await nodeExecPath(interpreter, env), cli };
  } catch (error) {
    return unresolved(`${cli} starts with ${interpreter}, which failed: ${errorMessage(error)}`);
  }
}

function unresolved(reason: string): HeadlessPiLaunch {
  return {
    kind: "unresolved",
    error: `The workflow server could not pin headless pi: ${reason}. ${UNRESOLVED_HINT}.`,
  };
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  return (env.PATH ?? "")
    .split(path.delimiter)
    .filter((directory) => directory.length > 0)
    .map((directory) => path.resolve(directory, name))
    .find((candidate) => isExecutableFile(candidate));
}

/** The `#!` line without its marker, or undefined for a file that has none or cannot be read. */
function readShebang(file: string): string | undefined {
  const head = Buffer.alloc(SHEBANG_BYTES);
  let length: number;
  try {
    const descriptor = fs.openSync(file, "r");
    try {
      length = fs.readSync(descriptor, head, 0, SHEBANG_BYTES, 0);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return undefined;
  }
  const text = head.subarray(0, length).toString("utf8");
  return text.startsWith("#!") ? text.slice(2).split("\n")[0] : undefined;
}

/** The Node that a `#!` line starts: `node` from `PATH` for `env node`, or an absolute Node. */
function nodeInterpreter(shebang: string | undefined): string | undefined {
  const [program, ...args] = shebang?.trim().split(/\s+/) ?? [];
  if (program === undefined) return undefined;
  if (path.basename(program) === "env" && args.length === 1 && args[0] === "node") return "node";
  if (path.basename(program) === "node" && args.length === 0) return program;
  return undefined;
}

async function nodeExecPath(interpreter: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync(
    interpreter,
    ["-e", "process.stdout.write(`\\n${process.execPath}`)"],
    { env, encoding: "utf8", timeout: NODE_PROBE_TIMEOUT_MS },
  );
  // A preload in NODE_OPTIONS may print first; the path is the last line.
  const reported = stdout.split("\n").at(-1) ?? "";
  if (!path.isAbsolute(reported)) throw new Error(`it reported ${JSON.stringify(reported)}`);
  return reported;
}
