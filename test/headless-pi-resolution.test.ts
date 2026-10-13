import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pinHeadlessPi, resolvePiFromPath } from "../src/server/headless-pi-resolution.js";
import {
  availableHeadlessPi,
  describeHeadlessPi,
  headlessPiSpawnArgs,
} from "../src/server/headless-pi.js";
import { makeTempDir } from "./helpers.js";

/** A `bin` directory for `PATH`, with a symlinked `pi` and, optionally, a `node`. */
async function pathWithPi(
  script: string,
  options: { node?: boolean } = {},
): Promise<{ bin: string; cli: string; env: NodeJS.ProcessEnv }> {
  const root = await makeTempDir("headless-pi-path");
  const cli = path.join(root, "package", "dist", "cli.js");
  await fs.mkdir(path.dirname(cli), { recursive: true });
  await fs.writeFile(cli, script, { mode: 0o755 });
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  await fs.symlink(path.relative(bin, cli), path.join(bin, "pi"));
  if (options.node !== false) await fs.symlink(process.execPath, path.join(bin, "node"));
  return { bin, cli: await fs.realpath(cli), env: { PATH: ["", bin, ""].join(path.delimiter) } };
}

describe("resolvePiFromPath", () => {
  it("pins the real CLI script and the real Node that `env node` selects", async () => {
    const setup = await pathWithPi("#!/usr/bin/env node\n");
    // The `node` on PATH is a symlink, as version manager shims often are; Node reports
    // the binary it really runs.
    expect(await resolvePiFromPath(setup.env)).toEqual({
      kind: "node",
      node: process.execPath,
      cli: setup.cli,
    });
  });

  it("pins the Node that an absolute shebang names", async () => {
    const setup = await pathWithPi(`#!${process.execPath}\n`, { node: false });
    expect(await resolvePiFromPath(setup.env)).toEqual({
      kind: "node",
      node: process.execPath,
      cli: setup.cli,
    });
  });

  it("pins a pi that is not a Node script as an executable", async () => {
    for (const script of [
      "#!/bin/sh\nexec true\n",
      "#!/usr/bin/env -S node --flag\n",
      "\u007fELF",
    ]) {
      const setup = await pathWithPi(script, { node: false });
      expect(await resolvePiFromPath(setup.env)).toEqual({
        kind: "executable",
        executable: setup.cli,
      });
    }
  });

  it("skips PATH entries without an executable pi", async () => {
    const setup = await pathWithPi("#!/bin/sh\n", { node: false });
    const other = await makeTempDir("headless-pi-other");
    await fs.writeFile(path.join(other, "pi"), "#!/bin/sh\n", { mode: 0o644 });
    await fs.mkdir(path.join(other, "nested", "pi"), { recursive: true });
    const env = {
      PATH: [other, path.join(other, "nested"), setup.bin].join(path.delimiter),
    };
    expect(await resolvePiFromPath(env)).toEqual({ kind: "executable", executable: setup.cli });
  });

  it("reports a missing pi with the PATH it searched", async () => {
    const empty = await makeTempDir("headless-pi-empty");
    const resolved = await resolvePiFromPath({ PATH: empty });
    expect(resolved).toEqual({
      kind: "unresolved",
      error: `The workflow server could not pin headless pi: no executable pi is on the server's PATH (${empty}). Start the workflow server from a Pi session, or put pi on the server's PATH, then restart the server with \`pi-workflows server stop\`.`,
    });
    expect(await resolvePiFromPath({})).toMatchObject({
      kind: "unresolved",
      error: expect.stringContaining("on the server's PATH ()"),
    });
  });

  it("reports a Node script whose Node cannot run", async () => {
    const setup = await pathWithPi("#!/usr/bin/env node\n", { node: false });
    expect(await resolvePiFromPath({ PATH: setup.bin })).toMatchObject({
      kind: "unresolved",
      error: expect.stringContaining(
        `${setup.cli} starts with node, which failed: spawn node ENOENT`,
      ),
    });
    const silent = path.join(setup.bin, "node");
    await fs.writeFile(silent, "#!/bin/sh\nprintf 'relative/node'\n", { mode: 0o755 });
    expect(await resolvePiFromPath({ PATH: setup.bin })).toMatchObject({
      kind: "unresolved",
      error: expect.stringContaining('which failed: it reported "relative/node"'),
    });
  });
});

describe("pinHeadlessPi", () => {
  it("prefers the starting session's pi and otherwise resolves PATH", async () => {
    const session = { kind: "executable", executable: "/opt/pi/pi" } as const;
    expect(await pinHeadlessPi(session, { PATH: "" })).toEqual({ source: "session", pi: session });
    const setup = await pathWithPi("#!/bin/sh\n", { node: false });
    expect(await pinHeadlessPi(undefined, setup.env)).toEqual({
      source: "path",
      pi: { kind: "executable", executable: setup.cli },
    });
  });
});

describe("headless pi launch", () => {
  it("starts a Node script pi with its pinned Node and passes pi's arguments after it", () => {
    const args = ["--mode", "rpc", "--no-session", "--no-extensions", "-e", "/bridge.js"];
    expect(headlessPiSpawnArgs({ kind: "node", node: "/n/node", cli: "/p/cli.js" }, args)).toEqual({
      command: "/n/node",
      args: ["/p/cli.js", ...args],
    });
    expect(headlessPiSpawnArgs({ kind: "executable", executable: "/p/pi" }, args)).toEqual({
      command: "/p/pi",
      args,
    });
  });

  it("describes every pin kind", () => {
    expect(describeHeadlessPi({ kind: "node", node: "/n/node", cli: "/p/cli.js" })).toBe(
      "/p/cli.js run by /n/node",
    );
    expect(describeHeadlessPi({ kind: "executable", executable: "/p/pi" })).toBe("/p/pi");
    expect(describeHeadlessPi({ kind: "unresolved", error: "no pi" })).toBe("unresolved: no pi");
  });

  it("checks that the pinned files still exist before each start", async () => {
    const dir = await makeTempDir("headless-pi-available");
    const cli = path.join(dir, "cli.js");
    const plain = path.join(dir, "plain");
    await fs.writeFile(cli, "");
    await fs.writeFile(plain, "", { mode: 0o644 });
    const node = { kind: "node", node: process.execPath, cli } as const;
    expect(availableHeadlessPi(node)).toBe(node);
    const restart = "Restart the workflow server with `pi-workflows server stop` to pin pi again.";
    const missingCli = path.join(dir, "gone.js");
    expect(() => availableHeadlessPi({ ...node, cli: missingCli })).toThrow(
      `The workflow server pinned headless pi as ${missingCli} run by ${process.execPath}, but ${missingCli} is missing or not executable. ${restart}`,
    );
    expect(() => availableHeadlessPi({ ...node, node: plain })).toThrow(
      `but ${plain} is missing or not executable`,
    );
    expect(() => availableHeadlessPi({ kind: "executable", executable: dir })).toThrow(
      `but ${dir} is missing or not executable`,
    );
    expect(() => availableHeadlessPi({ kind: "unresolved", error: "no pi on PATH" })).toThrow(
      "no pi on PATH",
    );
  });
});
