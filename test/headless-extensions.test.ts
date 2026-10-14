import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEADLESS_EXTENSIONS_ENV,
  availableHeadlessExtensions,
  readHeadlessExtensions,
} from "../src/server/headless-extensions.js";
import { HeadlessPiProcess, type HeadlessPiExit } from "../src/server/headless-pi.js";
import { makeTempDir, waitUntil } from "./helpers.js";

const RESTART = "then restart the workflow server with `pi-workflows server stop`";

function listed(...entries: string[]): NodeJS.ProcessEnv {
  return { [HEADLESS_EXTENSIONS_ENV]: entries.join(path.delimiter) };
}

/** A package with one extension file, under `name` when given. */
async function extensionPackage(name?: string): Promise<{ root: string; extension: string }> {
  const root = await makeTempDir("headless-extension");
  const extension = path.join(root, "src", "provider.ts");
  await fs.mkdir(path.dirname(extension), { recursive: true });
  await fs.writeFile(extension, "export default function provider() {}\n");
  if (name !== undefined) {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name }));
  }
  return { root, extension };
}

describe("readHeadlessExtensions", () => {
  it("lists nothing unless the opt-in is set", () => {
    expect(readHeadlessExtensions({})).toEqual({ paths: [] });
    expect(readHeadlessExtensions(listed(""))).toEqual({ paths: [] });
  });

  it("accepts absolute extension files and package directories", async () => {
    const file = await extensionPackage("@fixture/provider");
    const directory = await extensionPackage("@fixture/other");
    const env = listed(file.extension, "", `${directory.root}${path.sep}.${path.sep}`);
    expect(readHeadlessExtensions(env)).toEqual({
      paths: [file.extension, `${directory.root}${path.sep}`],
    });
  });

  it("fails closed on a relative or missing entry", async () => {
    const file = await extensionPackage();
    expect(readHeadlessExtensions(listed(file.extension, "provider.ts"))).toEqual({
      error: `${HEADLESS_EXTENSIONS_ENV} is invalid: "provider.ts" is not an absolute path. Fix it, ${RESTART}`,
    });
    expect(readHeadlessExtensions(listed("~/provider.ts"))).toMatchObject({
      error: expect.stringContaining('"~/provider.ts" is not an absolute path'),
    });
    const missing = path.join(file.root, "gone.ts");
    expect(readHeadlessExtensions(listed(missing))).toEqual({
      error: `${HEADLESS_EXTENSIONS_ENV} is invalid: ${missing} does not exist. Fix it, ${RESTART}`,
    });
  });

  it("refuses pi-workflows itself", async () => {
    const refusal =
      "is part of pi-workflows, whose extension must not load beside the headless bridge";
    // This package's extension, its root, and a symlink into it.
    const own = path.resolve("src", "extension", "index.ts");
    const link = path.join(await makeTempDir("headless-extension-link"), "extension.ts");
    await fs.symlink(own, link);
    for (const entry of [own, path.resolve("."), link]) {
      expect(readHeadlessExtensions(listed(entry))).toMatchObject({
        error: expect.stringContaining(`${entry} ${refusal}`),
      });
    }
    // Another installed copy, found by its package name.
    const copy = await extensionPackage("@osolmaz/pi-workflows");
    for (const entry of [copy.extension, copy.root]) {
      expect(readHeadlessExtensions(listed(entry))).toMatchObject({
        error: expect.stringContaining(`${entry} ${refusal}`),
      });
    }
  });
});

describe("availableHeadlessExtensions", () => {
  it("returns the listed paths while they exist and fails closed otherwise", async () => {
    const file = await extensionPackage();
    expect(availableHeadlessExtensions({ paths: [file.extension] })).toEqual([file.extension]);
    expect(() => availableHeadlessExtensions({ error: "the list is invalid" })).toThrow(
      "the list is invalid",
    );
    await fs.rm(file.extension);
    expect(() => availableHeadlessExtensions({ paths: [file.extension] })).toThrow(
      `The headless extension ${file.extension} from ${HEADLESS_EXTENSIONS_ENV} no longer exists. Restore it, ${RESTART}.`,
    );
  });
});

describe("headless pi with listed extensions", () => {
  async function launch(extensions: { paths: string[] } | { error: string }) {
    const root = await makeTempDir("headless-extension-launch");
    const argsFile = path.join(root, "args.txt");
    const fakePi = path.join(root, "pi");
    await fs.writeFile(fakePi, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`, {
      mode: 0o755,
    });
    let exit: HeadlessPiExit | undefined;
    const child = new HeadlessPiProcess(
      "/bridge.ts",
      {
        cwd: root,
        pi: { kind: "executable", executable: fakePi },
        extensions,
        piArgs: ["--model", "fixture"],
        abortGraceMs: 300,
      },
      {
        onExit: (settled) => {
          exit = settled;
        },
      },
    );
    return { argsFile, child, exited: () => exit };
  }

  it("loads each listed extension after the bridge and before the server's Pi arguments", async () => {
    const one = await extensionPackage();
    const two = await extensionPackage();
    const run = await launch({ paths: [one.extension, two.root] });
    await run.child.start();
    try {
      await waitUntil(() => run.exited() !== undefined, 10_000);
    } finally {
      await run.child.close();
    }
    expect((await fs.readFile(run.argsFile, "utf8")).trimEnd().split("\n")).toEqual([
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "-e",
      "/bridge.ts",
      "-e",
      one.extension,
      "-e",
      two.root,
      "--model",
      "fixture",
    ]);
  });

  it("starts no child when the list is invalid", async () => {
    const run = await launch({ error: `${HEADLESS_EXTENSIONS_ENV} is invalid: no.` });
    await expect(run.child.start()).rejects.toThrow(`${HEADLESS_EXTENSIONS_ENV} is invalid: no.`);
    expect(run.child.pid).toBeUndefined();
    await expect(fs.access(run.argsFile)).rejects.toThrow();
  });
});
