import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEADLESS_EXTENSIONS_ENV,
  availableHeadlessExtensions,
  readHeadlessExtensions,
  type HeadlessExtensions,
} from "../src/server/headless-extensions.js";
import { HeadlessPiProcess, type HeadlessPiExit } from "../src/server/headless-pi.js";
import { makeTempDir, waitUntil } from "./helpers.js";

const RESTART = "then restart the workflow server with `pi-workflows server stop`";
const DIRECTORY =
  "is a directory. Pi would load every extension, skill, prompt, and theme that it resolves there, so list the extension's entry file instead, such as <package>/dist/index.js or <package>/index.ts";

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
    expect(readHeadlessExtensions({})).toEqual({ entries: [] });
    expect(readHeadlessExtensions(listed(""))).toEqual({ entries: [] });
  });

  it("accepts absolute extension files and pins the real file behind each", async () => {
    const file = await extensionPackage("@fixture/provider");
    const other = await extensionPackage("@fixture/other");
    const unnormalized = `${path.dirname(other.extension)}${path.sep}.${path.sep}provider.ts`;
    const link = path.join(await makeTempDir("headless-extension-alias"), "provider.ts");
    await fs.symlink(file.extension, link);
    expect(readHeadlessExtensions(listed(file.extension, "", unnormalized, link))).toEqual({
      entries: [
        { path: file.extension, realpath: await fs.realpath(file.extension) },
        { path: other.extension, realpath: await fs.realpath(other.extension) },
        { path: link, realpath: await fs.realpath(file.extension) },
      ],
    });
  });

  it("refuses a directory, which Pi would resolve like a package", async () => {
    const directory = (entry: string) =>
      `${HEADLESS_EXTENSIONS_ENV} is invalid: ${entry} ${DIRECTORY}. Fix it, ${RESTART}`;
    // A plain provider package directory.
    const plain = await extensionPackage("@fixture/provider");
    expect(readHeadlessExtensions(listed(plain.root))).toEqual({ error: directory(plain.root) });
    // A directory of extensions that holds a pi-workflows checkout, as ~/.pi/agent/extensions can.
    const extensions = await makeTempDir("headless-extension-dir");
    await fs.symlink(path.resolve("."), path.join(extensions, "pi-workflows"));
    expect(readHeadlessExtensions(listed(extensions))).toEqual({ error: directory(extensions) });
    // A wrapper package whose manifest points into pi-workflows.
    const wrapper = await extensionPackage("@fixture/wrapper");
    await fs.writeFile(
      path.join(wrapper.root, "package.json"),
      JSON.stringify({
        name: "@fixture/wrapper",
        pi: { extensions: [path.resolve("src", "extension", "index.ts")] },
      }),
    );
    expect(readHeadlessExtensions(listed(wrapper.root))).toEqual({
      error: directory(wrapper.root),
    });
    // This package's own root.
    expect(readHeadlessExtensions(listed(path.resolve(".")))).toEqual({
      error: directory(path.resolve(".")),
    });
  });

  it("refuses an entry that is not a regular file", async () => {
    expect(readHeadlessExtensions(listed("/dev/null"))).toMatchObject({
      error: expect.stringContaining("/dev/null is not a regular file"),
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
    // This package's extension, and a symlink to it.
    const own = path.resolve("src", "extension", "index.ts");
    const link = path.join(await makeTempDir("headless-extension-link"), "extension.ts");
    await fs.symlink(own, link);
    for (const entry of [own, link]) {
      expect(readHeadlessExtensions(listed(entry))).toMatchObject({
        error: expect.stringContaining(`${entry} ${refusal}`),
      });
    }
    // Another installed copy, found by its package name, and a symlink into it.
    const copy = await extensionPackage("@osolmaz/pi-workflows");
    const copyLink = path.join(await makeTempDir("headless-extension-copy-link"), "provider.ts");
    await fs.symlink(copy.extension, copyLink);
    for (const entry of [copy.extension, copyLink]) {
      expect(readHeadlessExtensions(listed(entry))).toMatchObject({
        error: expect.stringContaining(`${entry} ${refusal}`),
      });
    }
  });
});

describe("availableHeadlessExtensions", () => {
  const changed = (entry: string, problem: string) =>
    `The headless extension ${entry} from ${HEADLESS_EXTENSIONS_ENV} changed after the workflow server started: ${problem}. Restore it, ${RESTART}.`;

  it("returns the pinned real files while every check still passes", async () => {
    const file = await extensionPackage();
    const link = path.join(await makeTempDir("headless-extension-pinned"), "provider.ts");
    await fs.symlink(file.extension, link);
    const real = await fs.realpath(file.extension);
    expect(availableHeadlessExtensions(readHeadlessExtensions(listed(link)))).toEqual([real]);
    expect(() => availableHeadlessExtensions({ error: "the list is invalid" })).toThrow(
      "the list is invalid",
    );
  });

  it("fails closed when a pinned file is removed or replaced", async () => {
    const file = await extensionPackage();
    const pinned = readHeadlessExtensions(listed(file.extension));
    await fs.rm(file.extension);
    expect(() => availableHeadlessExtensions(pinned)).toThrow(
      changed(file.extension, `${file.extension} does not exist`),
    );
    await fs.mkdir(file.extension);
    expect(() => availableHeadlessExtensions(pinned)).toThrow(
      changed(file.extension, `${file.extension} ${DIRECTORY}`),
    );
  });

  it("fails closed when a symlink points elsewhere after start", async () => {
    const first = await extensionPackage();
    const second = await extensionPackage();
    const link = path.join(await makeTempDir("headless-extension-retarget"), "provider.ts");
    await fs.symlink(first.extension, link);
    const pinned = readHeadlessExtensions(listed(link));
    await fs.rm(link);
    await fs.symlink(second.extension, link);
    expect(() => availableHeadlessExtensions(pinned)).toThrow(
      changed(
        link,
        `${link} now resolves to ${await fs.realpath(second.extension)} instead of ${await fs.realpath(first.extension)}`,
      ),
    );
    // Pointed into pi-workflows, the rule that refused it at start refuses it again.
    await fs.rm(link);
    await fs.symlink(path.resolve("src", "extension", "index.ts"), link);
    expect(() => availableHeadlessExtensions(pinned)).toThrow(
      changed(
        link,
        `${link} is part of pi-workflows, whose extension must not load beside the headless bridge`,
      ),
    );
  });
});

describe("headless pi with listed extensions", () => {
  async function launch(extensions: HeadlessExtensions) {
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
    // Children load the pinned real file, not the configured symlink.
    const alias = path.join(await makeTempDir("headless-extension-launch-alias"), "two.ts");
    await fs.symlink(two.extension, alias);
    const run = await launch(readHeadlessExtensions(listed(one.extension, alias)));
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
      await fs.realpath(one.extension),
      "-e",
      await fs.realpath(two.extension),
      "--model",
      "fixture",
    ]);
  });

  it("starts no child when a listed symlink points elsewhere after start", async () => {
    const first = await extensionPackage();
    const second = await extensionPackage();
    const link = path.join(await makeTempDir("headless-extension-launch-retarget"), "p.ts");
    await fs.symlink(first.extension, link);
    const run = await launch(readHeadlessExtensions(listed(link)));
    await fs.rm(link);
    await fs.symlink(second.extension, link);
    await expect(run.child.start()).rejects.toThrow(
      `The headless extension ${link} from ${HEADLESS_EXTENSIONS_ENV} changed after the workflow server started`,
    );
    expect(run.child.pid).toBeUndefined();
    await expect(fs.access(run.argsFile)).rejects.toThrow();
  });

  it("starts no child when the list is invalid", async () => {
    const run = await launch({ error: `${HEADLESS_EXTENSIONS_ENV} is invalid: no.` });
    await expect(run.child.start()).rejects.toThrow(`${HEADLESS_EXTENSIONS_ENV} is invalid: no.`);
    expect(run.child.pid).toBeUndefined();
    await expect(fs.access(run.argsFile)).rejects.toThrow();
  });
});
