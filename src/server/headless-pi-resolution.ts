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
 * Resolve `pi` on `PATH` the way a shell would start it, then pin the result. A Node script
 * pins its real file, symlinks resolved, and the Node that its `#!` line selects, asked for
 * its own `process.execPath` so a version manager shim for Node resolves once, here.
 *
 * Any other file keeps the path found on `PATH`. A shim such as mise or Volta is one binary
 * that picks the tool from the name it was started by, so its real file is not pi; the
 * child starts the found path with `pi` as its name, as a shell would.
 */
export async function resolvePiFromPath(
  env: NodeJS.ProcessEnv,
  probeTimeoutMs = NODE_PROBE_TIMEOUT_MS,
): Promise<HeadlessPiLaunch> {
  const found = findOnPath("pi", env);
  if (found === undefined) {
    return unresolved(`no executable pi is on the server's PATH (${env.PATH ?? ""})`);
  }
  const cli = fs.realpathSync(found);
  const interpreter = nodeInterpreter(readShebang(cli));
  if (interpreter === undefined) return { kind: "executable", executable: found };
  try {
    return { kind: "node", node: await nodeExecPath(interpreter, env, probeTimeoutMs), cli };
  } catch (error) {
    return unresolved(
      `${cli} starts with ${interpreter}, which ${probeFailure(error, probeTimeoutMs)}`,
    );
  }
}

/** Why the Node probe failed. Node sets `killed` when it stopped the probe at its timeout. */
function probeFailure(error: unknown, timeoutMs: number): string {
  const killed = typeof error === "object" && error !== null && "killed" in error && error.killed;
  return killed === true
    ? `timed out: it did not report its executable within ${timeoutMs} ms`
    : `failed: ${errorMessage(error)}`;
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

async function nodeExecPath(
  interpreter: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await execFileAsync(
    interpreter,
    ["-e", "process.stdout.write(`\\n${process.execPath}`)"],
    { env, encoding: "utf8", timeout: timeoutMs },
  );
  // A preload in NODE_OPTIONS may print first; the path is the last line.
  const reported = stdout.split("\n").at(-1) ?? "";
  if (!path.isAbsolute(reported)) throw new Error(`it reported ${JSON.stringify(reported)}`);
  return reported;
}
