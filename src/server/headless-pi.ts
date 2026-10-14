import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { HeadlessPiCommand } from "../client/headless-pi-command.js";

const DEFAULT_ABORT_GRACE_MS = 3_000;
const RESTART_HINT = "Restart the workflow server with `pi-workflows server stop` to pin pi again";
/** The flags that load an extension in Pi 1.1.0. Each takes the next argument as its source. */
const EXTENSION_FLAGS = new Set(["-e", "--extension"]);
/** Sources that Pi does not read as filesystem paths (`isLocalPath` in Pi's `utils/paths`). */
const NON_PATH_SOURCE = /^(?:npm|git|github|http|https|ssh|builtin):/;

/** The pi that the workflow server pinned at start, or why it could not pin one. */
export type HeadlessPiLaunch = HeadlessPiCommand | { kind: "unresolved"; error: string };

export interface SupervisedProcessRegistry {
  register(pid: number): unknown | Promise<unknown>;
  unregister(pid: number): unknown | Promise<unknown>;
}

/** How the workflow runner starts headless pi. Agent steps and agent groups share it. */
export type HeadlessPiOptions = {
  cwd: string;
  registry?: SupervisedProcessRegistry;
  /** Start a separate process group, or inherit the caller's process group. */
  processGroup?: "own" | "inherit";
  /** Grace period before a process group receives SIGKILL. */
  abortGraceMs?: number;
  /** The pinned pi. Nothing is looked up on `PATH` when a child starts. */
  pi: HeadlessPiLaunch;
  /** Extra environment for the child; the server's environment is inherited. */
  env?: Record<string, string>;
  /** Extra pi arguments, for example a model override. */
  piArgs?: string[];
};

/** A child exit, or `error` when the binary could not start. */
export type HeadlessPiExit = { code: number | null; signal: string | null; error?: string };

export type HeadlessPiHandlers = {
  onStderrLine?: (line: string) => void;
  /** Every raw stderr chunk, before line splitting. */
  onStderrChunk?: (chunk: Buffer) => void;
  onStdoutLine?: (line: string) => void;
  onExit?: (exit: HeadlessPiExit) => void;
};

export function describeHeadlessPiExit(exit: HeadlessPiExit): string {
  return exit.error ?? `code ${exit.code}, signal ${exit.signal}`;
}

/**
 * Locate an extension shipped beside a server module. Production resolves the compiled .js;
 * tests and source checkouts load the .ts source, which pi compiles when it loads extensions.
 */
export function packagedExtensionPath(moduleUrl: string, name: string): string | undefined {
  return [`./${name}.js`, `./${name}.ts`]
    .map((candidate) => fileURLToPath(new URL(candidate, moduleUrl)))
    .find((candidate) => fs.existsSync(candidate));
}

/**
 * Reject a relative extension path in the Pi arguments that a server adds to every headless
 * child. Each child starts in its run's project directory, so Pi would resolve a relative
 * path there and could load code from every project. Every `-e` and `--extension` in the
 * list is checked, wherever it is.
 *
 * A `--` is rejected as well. Pi gives it to an option before it that takes a value, such as
 * `--model --`, and then keeps reading options, so `--` cannot mark where checking may stop.
 * In RPC mode, headless pi ignores the messages that a real `--` would start.
 */
export function assertAbsoluteExtensionPaths(piArgs: readonly string[]): void {
  for (let index = 0; index < piArgs.length; index += 1) {
    const flag = piArgs[index] as string;
    if (flag === "--") {
      throw new Error(
        "Extra Pi arguments cannot contain `--`. Pi can read it as the value of the option before it and then load extensions named after it, and headless pi takes no messages. Remove it.",
      );
    }
    if (!EXTENSION_FLAGS.has(flag)) continue;
    index += 1;
    const source = piArgs[index];
    if (source === undefined) {
      throw new Error(`Extra Pi argument ${flag} requires an absolute extension path`);
    }
    if (isRelativeExtensionPath(source)) {
      throw new Error(
        `Extra Pi argument \`${flag} ${source}\` names a relative extension path. Headless pi starts in each run's project directory, so Pi would resolve it there and could load project code. Pass an absolute path.`,
      );
    }
  }
}

function isRelativeExtensionPath(source: string): boolean {
  if (NON_PATH_SOURCE.test(source.trim())) return false;
  // Pi expands `~` to the home directory and reads a `file://` URL as an absolute path.
  if (source === "~" || source.startsWith("~/") || source.startsWith("file://")) return false;
  return !path.isAbsolute(source);
}

export function abortGraceMs(options: HeadlessPiOptions): number {
  return options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
}

export function describeHeadlessPi(pi: HeadlessPiLaunch): string {
  if (pi.kind === "node") return `${pi.cli} run by ${pi.node}`;
  if (pi.kind === "executable") return pi.executable;
  return `unresolved: ${pi.error}`;
}

/** The program and arguments that start the pinned pi with pi's own `args`. */
export function headlessPiSpawnArgs(
  pi: HeadlessPiCommand,
  args: readonly string[],
): { command: string; args: string[] } {
  return pi.kind === "node"
    ? { command: pi.node, args: [pi.cli, ...args] }
    : { command: pi.executable, args: [...args] };
}

/**
 * The pinned pi, checked before each start. A pin outlives `pi update` or a Node upgrade that
 * removes its files, so a missing file is reported with the restart that pins pi again.
 */
export function availableHeadlessPi(pi: HeadlessPiLaunch): HeadlessPiCommand {
  if (pi.kind === "unresolved") throw new Error(pi.error);
  const programs = pi.kind === "node" ? [pi.node] : [pi.executable];
  const missing =
    programs.find((program) => !isExecutableFile(program)) ??
    (pi.kind === "node" && !isFile(pi.cli) ? pi.cli : undefined);
  if (missing !== undefined) {
    throw new Error(
      `The workflow server pinned headless pi as ${describeHeadlessPi(pi)}, but ${missing} is missing or not executable. ${RESTART_HINT}.`,
    );
  }
  return pi;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function isExecutableFile(file: string): boolean {
  if (!isFile(file)) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * One headless `pi --mode rpc` child that loads exactly one pi-workflows extension. Pi loads
 * the extension with its own module mapping, so the extension can import the packages that
 * Pi supplies. JSON commands go to stdin; the extension reports over stderr lines.
 */
export class HeadlessPiProcess {
  private child: ChildProcess | null = null;
  private exitState: HeadlessPiExit | null = null;
  private registeredPid: number | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly extensionPath: string,
    private readonly options: HeadlessPiOptions,
    private readonly handlers: HeadlessPiHandlers = {},
  ) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** The exit, or null while the child runs. A method so callers re-read it after awaits. */
  currentExit(): HeadlessPiExit | null {
    return this.exitState;
  }

  async start(): Promise<void> {
    const launch = headlessPiSpawnArgs(availableHeadlessPi(this.options.pi), [
      "--mode",
      "rpc",
      "--no-session",
      // Isolation is required: an installed pi-workflows extension would
      // otherwise load beside the bridge, register a competing workflow
      // tool, and start its own resume and resource runners.
      "--no-extensions",
      "-e",
      this.extensionPath,
      ...(this.options.piArgs ?? []),
    ]);
    const child = spawn(launch.command, launch.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: this.options.processGroup !== "inherit",
    });
    this.child = child;
    child.on("exit", (code, signal) => this.settle({ code, signal }));
    // A failed spawn (missing binary, EACCES) emits error instead of exit;
    // without a listener it would crash the server as an uncaught exception.
    child.on("error", (error) => this.settle({ code: null, signal: null, error: error.message }));
    child.stdin?.on("error", () => {
      // Writes racing child exit surface asynchronously as EPIPE; the caller
      // fails through the exit path instead of an uncaught stream error.
    });
    const stderr = new LineSplitter(this.handlers.onStderrLine);
    child.stderr?.on("data", (chunk: Buffer) => {
      this.handlers.onStderrChunk?.(chunk);
      stderr.push(chunk);
    });
    child.stderr?.on("end", () => stderr.end());
    // stdout carries the RPC event stream. It is drained even without a reader
    // so the pipe never blocks the child.
    const stdout = new LineSplitter(this.handlers.onStdoutLine);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stdout?.on("end", () => stdout.end());
    await this.register(child);
  }

  /** Write one JSON command line. Writes after exit are dropped; the exit path reports it. */
  write(command: Record<string, unknown>): void {
    if (this.child === null || this.exitState !== null) return;
    try {
      this.child.stdin?.write(`${JSON.stringify(command)}\n`);
    } catch {
      // The pipe may already be closed.
    }
  }

  /** Stop the child process tree, then unregister its exact group leader. */
  async close(): Promise<void> {
    this.closePromise ??= this.closeChild();
    await this.closePromise;
  }

  private settle(exit: HeadlessPiExit): void {
    this.exitState = exit;
    this.handlers.onExit?.(exit);
  }

  private async register(child: ChildProcess): Promise<void> {
    if (child.pid === undefined || this.options.registry === undefined) return;
    try {
      await this.options.registry.register(child.pid);
      this.registeredPid = child.pid;
    } catch (error) {
      killGroup(child.pid, "SIGKILL");
      this.child = null;
      throw error;
    }
  }

  private async closeChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null) return;
    try {
      try {
        child.stdin?.end();
      } catch {
        // The pipe may already be closed.
      }
      await this.stopChild(child);
    } finally {
      await this.unregister();
    }
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    const pid = child.pid;
    const graceMs = abortGraceMs(this.options);
    if (pid !== undefined && this.options.processGroup !== "inherit") {
      killGroup(pid, "SIGTERM");
      if (!(await waitForGroupExit(pid, graceMs))) killGroup(pid, "SIGKILL");
      return;
    }
    if (this.exitState !== null) return;
    child.kill("SIGTERM");
    if (!(await waitForExit(child, graceMs))) child.kill("SIGKILL");
  }

  private async unregister(): Promise<void> {
    const pid = this.registeredPid;
    if (pid === null) return;
    this.registeredPid = null;
    await this.options.registry?.unregister(pid);
  }
}

/**
 * Split a byte stream into UTF-8 lines. Only each new chunk is scanned for newlines, so one
 * long line costs time linear in its length, and characters split across chunks stay intact.
 */
class LineSplitter {
  private readonly decoder = new StringDecoder("utf8");
  private pending: string[] = [];

  constructor(private readonly onLine: ((line: string) => void) | undefined) {}

  push(chunk: Buffer): void {
    if (this.onLine === undefined) return;
    this.split(this.decoder.write(chunk));
  }

  /** Report a final line that has no newline. */
  end(): void {
    if (this.onLine === undefined) return;
    this.split(this.decoder.end());
    const rest = this.pending.join("");
    this.pending = [];
    if (rest.length > 0) this.onLine(rest);
  }

  private split(text: string): void {
    let start = 0;
    for (let newline = text.indexOf("\n"); newline >= 0; newline = text.indexOf("\n", start)) {
      this.pending.push(text.slice(start, newline));
      const line = this.pending.join("");
      this.pending = [];
      this.onLine?.(line);
      start = newline + 1;
    }
    if (start < text.length) this.pending.push(text.slice(start));
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Group signals are unsupported here; the leader still needs it.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (process.platform === "win32") return true;
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
