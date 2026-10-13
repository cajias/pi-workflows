import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  currentPiCommand,
  headlessPiCommandArgs,
  parseHeadlessPiCommandArgs,
  type PiProcessFacts,
} from "../src/client/headless-pi-command.js";
import { makeTempDir } from "./helpers.js";

const NODE = "/opt/node/bin/node";

/** An installed pi package: `package.json` with `piConfig` and a `bin` that names the CLI. */
async function piPackage(
  manifest: Record<string, unknown> = { bin: { pi: "dist/cli.js" }, piConfig: {} },
): Promise<{ root: string; cli: string; binLink: string }> {
  const root = await makeTempDir("headless-pi-package");
  const cli = path.join(root, "dist", "cli.js");
  await fs.mkdir(path.dirname(cli), { recursive: true });
  await fs.writeFile(cli, "#!/usr/bin/env node\n", { mode: 0o755 });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  // npm links `node_modules/.bin/pi` to the CLI; Node reports that link as argv[1].
  const binLink = path.join(root, ".bin", "pi");
  await fs.mkdir(path.dirname(binLink));
  await fs.symlink(path.relative(path.dirname(binLink), cli), binLink);
  return { root, cli: await fs.realpath(cli), binLink };
}

function facts(script: string | undefined, extra: Partial<PiProcessFacts> = {}): PiProcessFacts {
  return {
    execPath: NODE,
    argv: script === undefined ? [NODE] : [NODE, script, "--mode", "rpc"],
    sea: false,
    ...extra,
  };
}

describe("currentPiCommand", () => {
  it("pins the running Node and the real CLI script behind a symlinked bin", async () => {
    const pkg = await piPackage();
    expect(currentPiCommand(facts(pkg.binLink))).toEqual({
      kind: "node",
      node: NODE,
      cli: pkg.cli,
    });
  });

  it("accepts a package whose bin is a single string", async () => {
    const pkg = await piPackage({ name: "pi", bin: "./dist/cli.js", piConfig: { name: "pi" } });
    expect(currentPiCommand(facts(pkg.cli))).toMatchObject({ kind: "node", cli: pkg.cli });
  });

  it("pins a compiled pi executable alone", () => {
    expect(currentPiCommand(facts("/$bunfs/root/pi", { execPath: "/opt/pi/pi" }))).toEqual({
      kind: "executable",
      executable: "/opt/pi/pi",
    });
    expect(currentPiCommand(facts("B:\\~BUN\\root\\pi", { execPath: "C:\\pi\\pi.exe" }))).toEqual({
      kind: "executable",
      executable: "C:\\pi\\pi.exe",
    });
    expect(currentPiCommand(facts("/opt/pi/pi", { execPath: "/opt/pi/pi", sea: true }))).toEqual({
      kind: "executable",
      executable: "/opt/pi/pi",
    });
  });

  it("does not pin a script that is not a pi CLI", async () => {
    // A package bin without piConfig, such as a test runner or an SDK host's own CLI.
    const runner = await piPackage({ bin: { runner: "dist/cli.js" } });
    expect(currentPiCommand(facts(runner.binLink))).toBeUndefined();
    // A pi package file that is not one of its bins.
    const other = await piPackage({ bin: { pi: "dist/other.js" }, piConfig: {} });
    expect(currentPiCommand(facts(other.cli))).toBeUndefined();
    // A pi package bin that names no file.
    const noBin = await piPackage({ bin: 7, piConfig: {} });
    expect(currentPiCommand(facts(noBin.cli))).toBeUndefined();
    // An unreadable manifest.
    const broken = await piPackage();
    await fs.writeFile(path.join(broken.root, "package.json"), "{");
    expect(currentPiCommand(facts(broken.cli))).toBeUndefined();
    const array = await piPackage();
    await fs.writeFile(path.join(array.root, "package.json"), "[]");
    expect(currentPiCommand(facts(array.cli))).toBeUndefined();
  });

  it("does not pin a missing script, a directory, or a process without one", async () => {
    const dir = await makeTempDir("headless-pi-missing");
    expect(currentPiCommand(facts(path.join(dir, "missing.js")))).toBeUndefined();
    expect(currentPiCommand(facts(dir))).toBeUndefined();
    expect(currentPiCommand(facts(undefined))).toBeUndefined();
    // A script outside any package.
    const loose = path.join(dir, "cli.js");
    await fs.writeFile(loose, "");
    expect(currentPiCommand(facts(loose))).toBeUndefined();
  });

  it("does not treat this test runner as pi", () => {
    expect(currentPiCommand()).toBeUndefined();
  });
});

describe("headless pi server entry arguments", () => {
  it("round-trips both pin kinds and passes nothing without a pin", () => {
    const node = { kind: "node", node: NODE, cli: "/opt/pi/dist/cli.js" } as const;
    const executable = { kind: "executable", executable: "/opt/pi/pi" } as const;
    expect(headlessPiCommandArgs(node)).toEqual([
      "--headless-pi-node",
      NODE,
      "--headless-pi-cli",
      "/opt/pi/dist/cli.js",
    ]);
    expect(
      parseHeadlessPiCommandArgs(["node", "server-entry.js", ...headlessPiCommandArgs(node)]),
    ).toEqual(node);
    expect(parseHeadlessPiCommandArgs(headlessPiCommandArgs(executable))).toEqual(executable);
    expect(headlessPiCommandArgs(undefined)).toEqual([]);
    expect(parseHeadlessPiCommandArgs(["node", "server-entry.js", "--database", "/db"])).toBe(
      undefined,
    );
  });

  it("rejects relative, missing, partial, and mixed pins", () => {
    expect(() => parseHeadlessPiCommandArgs(["--headless-pi-executable", "pi"])).toThrow(
      "--headless-pi-executable requires an absolute path",
    );
    expect(() => parseHeadlessPiCommandArgs(["--headless-pi-node"])).toThrow(
      "--headless-pi-node requires an absolute path",
    );
    const partial = "Give either --headless-pi-node with --headless-pi-cli";
    expect(() => parseHeadlessPiCommandArgs(["--headless-pi-node", NODE])).toThrow(partial);
    expect(() => parseHeadlessPiCommandArgs(["--headless-pi-cli", "/opt/pi/cli.js"])).toThrow(
      partial,
    );
    expect(() =>
      parseHeadlessPiCommandArgs([
        "--headless-pi-executable",
        "/opt/pi/pi",
        "--headless-pi-node",
        NODE,
      ]),
    ).toThrow(partial);
  });
});
