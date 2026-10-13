import os from "node:os";
import { describe, expect, it } from "vitest";
import { assertAbsoluteExtensionPaths } from "../src/server/headless-pi.js";

const RELATIVE = "names a relative extension path";

describe("assertAbsoluteExtensionPaths", () => {
  it("accepts absolute paths and sources that Pi does not read as paths", () => {
    for (const source of [
      "/opt/ext/provider.ts",
      `${os.homedir()}/ext/provider.ts`,
      "~/ext/provider.ts",
      "~",
      "file:///opt/ext/provider.ts",
      "npm:@scope/provider@1.2.3",
      "git:github.com/owner/provider",
      "github:owner/provider",
      "https://github.com/owner/provider",
      "http://example.invalid/provider",
      "ssh://git@example.invalid/provider",
      "builtin:mcp",
    ]) {
      for (const flag of ["-e", "--extension"]) {
        expect(() => assertAbsoluteExtensionPaths([flag, source])).not.toThrow();
      }
    }
    expect(() => assertAbsoluteExtensionPaths([])).not.toThrow();
    expect(() =>
      assertAbsoluteExtensionPaths(["--provider", "fixture", "--model", "./not-an-extension"]),
    ).not.toThrow();
  });

  it("rejects relative paths in both flag forms and names the flag and value", () => {
    for (const source of ["provider.ts", "./provider.ts", "../ext/provider.ts", "", "~other/x"]) {
      expect(() => assertAbsoluteExtensionPaths(["-e", source])).toThrow(
        `Extra Pi argument \`-e ${source}\` ${RELATIVE}`,
      );
      expect(() => assertAbsoluteExtensionPaths(["--extension", source])).toThrow(
        `Extra Pi argument \`--extension ${source}\` ${RELATIVE}`,
      );
    }
    // Pi takes the next argument as the source, even one that looks like an option.
    expect(() => assertAbsoluteExtensionPaths(["-e", "--provider", "fixture"])).toThrow(
      `Extra Pi argument \`-e --provider\` ${RELATIVE}`,
    );
  });

  it("checks every extension and requires a source after the flag", () => {
    expect(() =>
      assertAbsoluteExtensionPaths(["-e", "/opt/a.ts", "--model", "m", "-e", "relative.ts"]),
    ).toThrow(`\`-e relative.ts\` ${RELATIVE}`);
    expect(() => assertAbsoluteExtensionPaths(["--provider", "fixture", "-e"])).toThrow(
      "Extra Pi argument -e requires an absolute extension path",
    );
    expect(() => assertAbsoluteExtensionPaths(["--extension"])).toThrow(
      "Extra Pi argument --extension requires an absolute extension path",
    );
  });

  it("stops at `--`, after which Pi reads only messages", () => {
    expect(() => assertAbsoluteExtensionPaths(["--", "-e", "relative.ts"])).not.toThrow();
    expect(() =>
      assertAbsoluteExtensionPaths(["-e", "/opt/a.ts", "--", "--extension", "./b.ts"]),
    ).not.toThrow();
  });

  it("leaves `=` forms to Pi, which reports them as unknown options", () => {
    expect(() => assertAbsoluteExtensionPaths(["--extension=./provider.ts"])).not.toThrow();
    expect(() => assertAbsoluteExtensionPaths(["-e=./provider.ts"])).not.toThrow();
  });
});
