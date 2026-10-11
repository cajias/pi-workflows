import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOIMPLEMENT_DEFAULTS_SCHEMA,
  autoimplementDefaultsPath,
  loadAutoimplementDefaults,
  parseAutoimplementDefaults,
  parsePrTiming,
} from "../src/builtins/autoimplement-config.js";
import { decisionConfigDir } from "../src/channels/config.js";
import { workflowsConfigDir } from "../src/state/index.js";
import { makeTempDir } from "./helpers.js";

let configDir = "";

beforeEach(async () => {
  configDir = await makeTempDir("autoimplement-defaults");
  vi.stubEnv("PI_WORKFLOWS_CONFIG_DIR", configDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function defaultsFile(): string {
  return path.join(configDir, "autoimplement.json");
}

async function writeDefaults(value: unknown): Promise<void> {
  await fs.writeFile(defaultsFile(), typeof value === "string" ? value : JSON.stringify(value));
}

describe("autoimplement defaults file", () => {
  it("uses the shared configuration directory", () => {
    expect(autoimplementDefaultsPath({ PI_WORKFLOWS_CONFIG_DIR: "/configured" })).toBe(
      path.join("/configured", "autoimplement.json"),
    );
    expect(workflowsConfigDir({ PI_WORKFLOWS_CONFIG_DIR: "/configured" })).toBe("/configured");
    expect(workflowsConfigDir({})).toBe(path.join(os.homedir(), ".config", "pi-workflows"));
    expect(autoimplementDefaultsPath({})).toBe(
      path.join(os.homedir(), ".config", "pi-workflows", "autoimplement.json"),
    );
    expect(decisionConfigDir({ PI_WORKFLOWS_CONFIG_DIR: "/configured" })).toBe("/configured");
    expect(decisionConfigDir({})).toBe(workflowsConfigDir({}));
    expect(autoimplementDefaultsPath()).toBe(defaultsFile());
    expect(workflowsConfigDir()).toBe(configDir);
  });

  it("accepts early, end, or nothing for publication timing", () => {
    expect(parsePrTiming(undefined, "prTiming")).toBeUndefined();
    expect(parsePrTiming("early", "prTiming")).toBe("early");
    expect(parsePrTiming("end", "prTiming")).toBe("end");
    expect(() => parsePrTiming("late", "autoimplement prTiming")).toThrow(
      "autoimplement prTiming must be early or end",
    );
  });

  it("returns no defaults when the file is missing", () => {
    expect(loadAutoimplementDefaults()).toEqual({});
  });

  it("applies a valid file", async () => {
    await writeDefaults({
      schema: AUTOIMPLEMENT_DEFAULTS_SCHEMA,
      forge: "gitlab",
      prTiming: "end",
    });
    expect(loadAutoimplementDefaults()).toEqual({ forge: "gitlab", prTiming: "end" });
    await writeDefaults({ schema: AUTOIMPLEMENT_DEFAULTS_SCHEMA });
    expect(loadAutoimplementDefaults()).toEqual({});
  });

  it.each([
    [{ schema: AUTOIMPLEMENT_DEFAULTS_SCHEMA, merge: true }, "unknown keys merge"],
    [{ forge: "gitlab" }, `schema must be ${AUTOIMPLEMENT_DEFAULTS_SCHEMA}`],
    [{ schema: "pi-workflows.autoimplement-defaults.v0" }, "schema must be"],
    [
      { schema: AUTOIMPLEMENT_DEFAULTS_SCHEMA, forge: "gitea" },
      "forge must be auto, github, or gitlab",
    ],
    [{ schema: AUTOIMPLEMENT_DEFAULTS_SCHEMA, prTiming: "late" }, "prTiming must be early or end"],
    [[], "must be a JSON object"],
    [null, "must be a JSON object"],
    ["{ not json", "invalid JSON"],
  ])("rejects %j and names the file", async (value, message) => {
    await writeDefaults(value);
    let error: unknown;
    try {
      loadAutoimplementDefaults();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`autoimplement defaults file ${defaultsFile()}: `);
    expect((error as Error).message).toContain(message);
  });

  it("rejects a directory and other read errors with the file path", async () => {
    await fs.mkdir(defaultsFile());
    expect(() => loadAutoimplementDefaults()).toThrow(
      new RegExp(`autoimplement defaults file .*autoimplement\\.json: EISDIR`),
    );
    expect(() =>
      loadAutoimplementDefaults({ PI_WORKFLOWS_CONFIG_DIR: "/configured" }, () => {
        throw "unreadable";
      }),
    ).toThrow("autoimplement defaults file /configured/autoimplement.json: unreadable");
  });

  it("parses a value without reading a file", () => {
    expect(
      parseAutoimplementDefaults(
        { schema: AUTOIMPLEMENT_DEFAULTS_SCHEMA, forge: "auto", prTiming: "early" },
        "/x.json",
      ),
    ).toEqual({ forge: "auto", prTiming: "early" });
    expect(() => parseAutoimplementDefaults("text", "/x.json")).toThrow(
      "autoimplement defaults file /x.json: must be a JSON object",
    );
  });
});
