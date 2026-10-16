import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentGroupError } from "../src/builtins/pi-agent-launch.js";
import {
  AgentGroupDiagnostics,
  agentGroupCauseText,
  DIAGNOSTICS_RETENTION_MS,
  pruneAgentGroupDiagnostics,
} from "../src/server/agent-group-diagnostics.js";
import { makeTempDir } from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = Date.now();
const EXPIRED = new Date(NOW - DIAGNOSTICS_RETENTION_MS - DAY_MS);
const FRESH = new Date(NOW - DIAGNOSTICS_RETENTION_MS + DAY_MS);

type LogDirectory = { directory: string; log: string; cause: string };

/**
 * A diagnostics directory with the exact layout that AgentGroupDiagnostics creates, last
 * modified at `mtime`: a stderr log unless `contents` is null, and a cause file when `cause`
 * is given.
 */
async function logDirectory(
  parent: string,
  name: string,
  mtime: Date,
  contents: string | null = "pi stderr\n",
  cause: string | null = null,
): Promise<LogDirectory> {
  const directory = path.join(parent, name);
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const log = path.join(directory, "pi-stderr.log");
  const causeFile = path.join(directory, "cause.txt");
  for (const [file, text] of [
    [log, contents],
    [causeFile, cause],
  ] as const) {
    if (text === null) continue;
    await fs.writeFile(file, text, { mode: 0o600 });
    await fs.chmod(file, 0o600);
    await fs.utimes(file, mtime, mtime);
  }
  await fs.utimes(directory, mtime, mtime);
  return { directory, log, cause: causeFile };
}

async function exists(target: string): Promise<boolean> {
  return await fs.lstat(target).then(
    () => true,
    () => false,
  );
}

async function prune(parent: string, errors: Array<[string, unknown]> = []): Promise<string[]> {
  return await pruneAgentGroupDiagnostics(parent, {
    now: NOW,
    onError: (target, error) => errors.push([target, error]),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent group diagnostics pruning", () => {
  it("keeps logs for seven days", () => {
    expect(DIAGNOSTICS_RETENTION_MS).toBe(7 * DAY_MS);
  });

  it("removes expired log directories, with or without a run ID, and empty ones", async () => {
    const parent = await makeTempDir("stderr-log-prune");
    const run = await logDirectory(
      parent,
      "pi-workflows-20261009T120000000Z-sanity-check-0a1b2c3d-agent-group-Ab3dE9",
      EXPIRED,
    );
    const plain = await logDirectory(parent, "pi-workflows-agent-group-xY12zQ", EXPIRED);
    // A runner killed between mkdtemp and opening the file leaves an empty directory.
    const empty = await logDirectory(parent, "pi-workflows-r1-agent-group-000000", EXPIRED, null);
    const errors: Array<[string, unknown]> = [];

    expect(await prune(parent, errors)).toEqual(
      [run.directory, plain.directory, empty.directory].sort(),
    );
    expect(await fs.readdir(parent)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("removes expired directories that hold a cause file, alone or beside the log", async () => {
    const parent = await makeTempDir("stderr-log-prune");
    const causeOnly = await logDirectory(
      parent,
      "pi-workflows-r1-agent-group-cause1",
      EXPIRED,
      null,
      "Pi agent review failed: the session raised an error\n",
    );
    const both = await logDirectory(
      parent,
      "pi-workflows-r1-agent-group-both01",
      EXPIRED,
      "pi stderr\n",
      "Pi agent group could not run: pi rejected the agent group command\n",
    );
    const errors: Array<[string, unknown]> = [];

    expect(await prune(parent, errors)).toEqual([both.directory, causeOnly.directory].sort());
    expect(await fs.readdir(parent)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("keeps a directory while its cause file is recent, private, and regular", async () => {
    const parent = await makeTempDir("stderr-log-prune");
    // A recent cause file keeps the directory even when the log and the directory expired.
    const fresh = await logDirectory(
      parent,
      "pi-workflows-r1-agent-group-fresh2",
      EXPIRED,
      "pi stderr\n",
      "cause\n",
    );
    await fs.utimes(fresh.cause, FRESH, FRESH);
    const readable = await logDirectory(
      parent,
      "pi-workflows-r1-agent-group-mode03",
      EXPIRED,
      null,
      "cause\n",
    );
    await fs.chmod(readable.cause, 0o644);
    const elsewhere = await makeTempDir("stderr-log-target");
    const outsideCause = path.join(elsewhere, "cause.txt");
    await fs.writeFile(outsideCause, "outside\n", { mode: 0o600 });
    await fs.utimes(outsideCause, EXPIRED, EXPIRED);
    const linked = await logDirectory(parent, "pi-workflows-r1-agent-group-link02", EXPIRED, null);
    await fs.symlink(outsideCause, linked.cause);
    await fs.utimes(linked.directory, EXPIRED, EXPIRED);
    const nested = await logDirectory(parent, "pi-workflows-r1-agent-group-nest02", EXPIRED, null);
    await fs.mkdir(nested.cause, { mode: 0o700 });
    await fs.utimes(nested.cause, EXPIRED, EXPIRED);
    await fs.utimes(nested.directory, EXPIRED, EXPIRED);
    const errors: Array<[string, unknown]> = [];

    expect(await prune(parent, errors)).toEqual([]);
    expect(await fs.readFile(fresh.cause, "utf8")).toBe("cause\n");
    expect(await fs.readFile(fresh.log, "utf8")).toBe("pi stderr\n");
    expect(await fs.readFile(readable.cause, "utf8")).toBe("cause\n");
    expect((await fs.lstat(linked.cause)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(outsideCause, "utf8")).toBe("outside\n");
    expect((await fs.lstat(nested.cause)).isDirectory()).toBe(true);
    expect(errors).toEqual([]);
  });

  it("keeps directories that pi used within the retention period", async () => {
    const parent = await makeTempDir("stderr-log-prune");
    const fresh = await logDirectory(parent, "pi-workflows-r1-agent-group-fresh1", FRESH);
    // A running group's output keeps the file current while the directory itself ages.
    const writing = await logDirectory(parent, "pi-workflows-r2-agent-group-write1", EXPIRED);
    await fs.utimes(writing.log, FRESH, FRESH);
    const touched = await logDirectory(parent, "pi-workflows-r3-agent-group-touch1", EXPIRED);
    await fs.utimes(touched.directory, FRESH, FRESH);
    // A clock that moved backwards cannot make a directory look expired.
    const future = new Date(NOW + DAY_MS);
    const ahead = await logDirectory(parent, "pi-workflows-r4-agent-group-ahead1", future);

    expect(await prune(parent)).toEqual([]);
    for (const kept of [fresh, writing, touched, ahead]) {
      expect(await fs.readFile(kept.log, "utf8")).toBe("pi stderr\n");
    }
    expect(
      await pruneAgentGroupDiagnostics(parent, {
        now: NOW + 30 * DAY_MS,
        retentionMs: DIAGNOSTICS_RETENTION_MS,
      }),
    ).toHaveLength(4);
  });

  it("keeps entries whose names are not stderr log directories", async () => {
    const parent = await makeTempDir("stderr-log-prune");
    const names = [
      "pi-workflows-agent-group-short",
      "pi-workflows-agent-group-toolong1",
      "pi-workflows-r1-agent-group-Ab3dE9.bak",
      "pi-workflows-r1-agent-group-Ab-dE9",
      "pi-workflows--agent-group-Ab3dE9",
      "pi-workflows-.r1-agent-group-Ab3dE9",
      "other-r1-agent-group-Ab3dE9",
      "pi-workflows-live-e2e-Ab3dE9",
      "pw-tests-Ab3dE9",
    ];
    for (const name of names) await logDirectory(parent, name, EXPIRED);
    // A regular file with a matching name is not a directory.
    const file = path.join(parent, "pi-workflows-r1-agent-group-file01");
    await fs.writeFile(file, "not a directory", { mode: 0o600 });
    await fs.utimes(file, EXPIRED, EXPIRED);
    const errors: Array<[string, unknown]> = [];

    expect(await prune(parent, errors)).toEqual([]);
    expect((await fs.readdir(parent)).sort()).toEqual(
      [...names, "pi-workflows-r1-agent-group-file01"].sort(),
    );
    expect(errors).toEqual([]);
  });

  it("does not follow symlinks", async () => {
    const parent = await makeTempDir("stderr-log-prune");
    const elsewhere = await makeTempDir("stderr-log-target");
    // A symlinked directory with a matching name, pointing at a directory that would qualify.
    const target = await logDirectory(elsewhere, "pi-workflows-r1-agent-group-target", EXPIRED);
    const linkedDirectory = path.join(parent, "pi-workflows-r1-agent-group-linked");
    await fs.symlink(target.directory, linkedDirectory);
    // A symlink in place of the log file, pointing at a file that would qualify.
    const outsideLog = path.join(elsewhere, "pi-stderr.log");
    await fs.writeFile(outsideLog, "outside\n", { mode: 0o600 });
    await fs.utimes(outsideLog, EXPIRED, EXPIRED);
    const linkedLog = await logDirectory(
      parent,
      "pi-workflows-r1-agent-group-symlog",
      EXPIRED,
      null,
    );
    await fs.symlink(outsideLog, linkedLog.log);
    await fs.utimes(linkedLog.directory, EXPIRED, EXPIRED);

    expect(await prune(parent)).toEqual([]);
    expect((await fs.lstat(linkedDirectory)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target.log, "utf8")).toBe("pi stderr\n");
    expect((await fs.lstat(linkedLog.log)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(outsideLog, "utf8")).toBe("outside\n");
  });

  it("keeps directories with another mode or owner", async () => {
    const parent = await makeTempDir("stderr-log-prune");
    const openDirectory = await logDirectory(parent, "pi-workflows-r1-agent-group-mode01", EXPIRED);
    await fs.chmod(openDirectory.directory, 0o755);
    const readableLog = await logDirectory(parent, "pi-workflows-r1-agent-group-mode02", EXPIRED);
    await fs.chmod(readableLog.log, 0o644);

    expect(await prune(parent)).toEqual([]);
    expect(await exists(openDirectory.log)).toBe(true);
    expect(await exists(readableLog.log)).toBe(true);

    // Every entry belongs to this user, so another user ID stands in for another owner.
    const owned = await logDirectory(parent, "pi-workflows-r1-agent-group-owner1", EXPIRED);
    const uid = process.getuid?.() ?? 0;
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(await prune(parent)).toEqual([]);
    expect(await exists(owned.log)).toBe(true);
  });

  it("keeps directories with unexpected contents", async () => {
    const parent = await makeTempDir("stderr-log-prune");
    const extra = await logDirectory(parent, "pi-workflows-r1-agent-group-extra1", EXPIRED);
    await fs.writeFile(path.join(extra.directory, "notes.txt"), "keep me", { mode: 0o600 });
    await fs.utimes(extra.directory, EXPIRED, EXPIRED);
    const nested = await logDirectory(parent, "pi-workflows-r1-agent-group-nest01", EXPIRED, null);
    await fs.mkdir(nested.log, { mode: 0o700 });
    await fs.writeFile(path.join(nested.log, "inner"), "keep me");
    await fs.utimes(nested.log, EXPIRED, EXPIRED);
    await fs.utimes(nested.directory, EXPIRED, EXPIRED);
    const errors: Array<[string, unknown]> = [];

    expect(await prune(parent, errors)).toEqual([]);
    expect(await fs.readFile(path.join(extra.directory, "notes.txt"), "utf8")).toBe("keep me");
    expect(await fs.readFile(extra.log, "utf8")).toBe("pi stderr\n");
    expect(await fs.readFile(path.join(nested.log, "inner"), "utf8")).toBe("keep me");
    expect(errors).toEqual([]);
  });

  it("reports failures without throwing and continues with other directories", async () => {
    const parent = await makeTempDir("stderr-log-prune");
    const failing = await logDirectory(parent, "pi-workflows-r1-agent-group-fail01", EXPIRED);
    const removable = await logDirectory(parent, "pi-workflows-r1-agent-group-okay01", EXPIRED);
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
      if (target === failing.log) throw Object.assign(new Error("denied"), { code: "EPERM" });
      await unlink(target);
    });
    const errors: Array<[string, unknown]> = [];

    expect(await prune(parent, errors)).toEqual([removable.directory]);
    expect(await exists(failing.log)).toBe(true);
    expect(errors).toEqual([[failing.directory, expect.objectContaining({ code: "EPERM" })]]);

    // An unreadable parent is reported, and a throwing reporter is ignored.
    const notDirectory = path.join(parent, "file");
    await fs.writeFile(notDirectory, "");
    const reports: string[] = [];
    await expect(
      pruneAgentGroupDiagnostics(notDirectory, {
        now: NOW,
        onError: (target) => {
          reports.push(target);
          throw new Error("reporter failed");
        },
      }),
    ).resolves.toEqual([]);
    expect(reports).toEqual([notDirectory]);
  });

  it("skips directories that disappear meanwhile, as when runners prune concurrently", async () => {
    const parent = await makeTempDir("stderr-log-prune");
    const directories = await Promise.all(
      ["a", "b", "c", "d"].map(
        async (letter) =>
          await logDirectory(parent, `pi-workflows-r1-agent-group-${letter.repeat(6)}`, EXPIRED),
      ),
    );
    const errors: Array<[string, unknown]> = [];

    const [first, second] = await Promise.all([prune(parent, errors), prune(parent, errors)]);
    expect([...first, ...second].sort()).toEqual(directories.map((entry) => entry.directory));
    expect(await fs.readdir(parent)).toEqual([]);
    expect(errors).toEqual([]);
    // A missing parent is not a failure either.
    expect(await prune(path.join(parent, "missing"), errors)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("prunes the directories that AgentGroupDiagnostics creates and keeps", async () => {
    const parent = await makeTempDir("stderr-log-prune");
    // Pi could not run this group, so both files stay.
    const couldNotRun = new AgentGroupDiagnostics(parent, "pi-workflows-r1-agent-group-");
    await couldNotRun.open();
    couldNotRun.write(Buffer.from("could not run\n"));
    await couldNotRun.saveCause("Pi agent group could not run: pi rejected the command\n");
    await couldNotRun.finish(true);
    // The bridge reported this failure, so only the cause file stays.
    const reported = new AgentGroupDiagnostics(parent, "pi-workflows-r2-agent-group-");
    await reported.open();
    reported.write(Buffer.from("provider output\n"));
    await reported.saveCause("Pi agent review failed: the session raised an error\n");
    await reported.finish(false);
    const kept = [couldNotRun, reported].map((diagnostics) => {
      if (diagnostics.causePath === undefined) throw new Error("the directory did not open");
      return diagnostics.causePath;
    });
    const directories = kept.map((cause) => path.dirname(cause));
    expect(await fs.readdir(directories[0]!)).toEqual(["cause.txt", "pi-stderr.log"]);
    expect(await fs.readdir(directories[1]!)).toEqual(["cause.txt"]);

    expect(await prune(parent)).toEqual([]);
    for (const directory of directories) {
      for (const name of await fs.readdir(directory)) {
        await fs.utimes(path.join(directory, name), EXPIRED, EXPIRED);
      }
      await fs.utimes(directory, EXPIRED, EXPIRED);
    }
    expect(await prune(parent)).toEqual(directories.toSorted());
    expect(await fs.readdir(parent)).toEqual([]);
  });
});

describe("agent group diagnostics", () => {
  it("writes the complete cause to a private file beside the stderr log", async () => {
    const parent = await makeTempDir("agent-group-diagnostics");
    const diagnostics = new AgentGroupDiagnostics(parent, "pi-workflows-r1-agent-group-");
    await diagnostics.open();
    const detail = `PRIVATE_CAUSE ${"é漢".repeat(4_000)} END`;
    const error = new PiAgentGroupError("review", "failed", "the session raised an error", {
      detail,
    });

    const notice = await diagnostics.saveCause(agentGroupCauseText(error));
    const causePath = diagnostics.causePath!;
    expect(notice).toBe(`complete cause: ${causePath}`);
    expect(path.dirname(causePath)).toBe(path.dirname(diagnostics.stderrPath!));
    expect(await fs.readFile(causePath, "utf8")).toBe(
      `Pi agent review failed: the session raised an error\n\n${detail}\n`,
    );
    expect((await fs.stat(path.dirname(causePath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(causePath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(diagnostics.stderrPath!)).mode & 0o777).toBe(0o600);
    // A second cause never replaces the first.
    expect(await diagnostics.saveCause("other")).toMatch(/^complete cause was not saved: EEXIST/u);
    await diagnostics.finish(false);
    expect(await fs.readdir(path.dirname(causePath))).toEqual(["cause.txt"]);
  });

  it("states facts alone when an error has no private detail", () => {
    expect(agentGroupCauseText(new PiAgentGroupError("group", "has unknown provider", "x"))).toBe(
      "Pi agent group has unknown provider: x\n",
    );
  });

  it("removes a directory that keeps nothing and reports one it could not create", async () => {
    const parent = await makeTempDir("agent-group-diagnostics");
    const unused = new AgentGroupDiagnostics(parent);
    await unused.open();
    unused.write(Buffer.from("output\n"));
    await unused.finish(false);
    expect(await fs.readdir(parent)).toEqual([]);

    const missing = new AgentGroupDiagnostics(path.join(parent, "missing"));
    await missing.open();
    expect(missing.causePath).toBeUndefined();
    expect(await missing.saveCause("PRIVATE_CAUSE")).toMatch(
      /^complete cause was not saved: ENOENT/u,
    );
    expect(await missing.saveCause("PRIVATE_CAUSE")).not.toContain("PRIVATE_CAUSE");
    expect(missing.describeStderr()).toMatch(/^pi stderr was not saved: ENOENT/u);
    await missing.finish(false);
  });
});
