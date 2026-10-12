import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const DEFAULT_ABORT_GRACE_MS = 3_000;

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
  /** Absolute path to the pi binary; defaults to the installed `pi`. */
  piBin?: string;
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

export function abortGraceMs(options: HeadlessPiOptions): number {
  return options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
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
    const child = spawn(
      this.options.piBin ?? "pi",
      [
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
      ],
      {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: this.options.processGroup !== "inherit",
      },
    );
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
