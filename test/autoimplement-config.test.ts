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
import autoimplementWorkflow from "../src/builtins/autoimplement.workflow.js";
import monitorWorkflow from "../src/builtins/monitor.workflow.js";
import { decisionConfigDir } from "../src/channels/config.js";
import { workflowsConfigDir } from "../src/state/index.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { digest } from "../src/workflows/human-decision.js";
import type { WorkflowStepRecord } from "../src/workflows/types.js";
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

async function parse(value: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parseInput = autoimplementWorkflow.input;
  if (parseInput === undefined) throw new Error("autoimplement input parser is missing");
  return (await parseInput({ task: "demo", repository: "/repo", ...value })) as Record<
    string,
    unknown
  >;
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

describe("autoimplement input defaults", () => {
  it("uses the built-in defaults without a file", async () => {
    expect(await parse({})).toMatchObject({ forge: "auto", prTiming: "early", merge: false });
  });

  it("fills missing fields from the file and lets each input field win", async () => {
    await writeDefaults({
      schema: AUTOIMPLEMENT_DEFAULTS_SCHEMA,
      forge: "gitlab",
      prTiming: "end",
    });
    expect(await parse({})).toMatchObject({ forge: "gitlab", prTiming: "end" });
    expect(await parse({ forge: "github" })).toMatchObject({ forge: "github", prTiming: "end" });
    expect(await parse({ prTiming: "early" })).toMatchObject({
      forge: "gitlab",
      prTiming: "early",
    });
    await writeDefaults({ schema: AUTOIMPLEMENT_DEFAULTS_SCHEMA, prTiming: "end" });
    expect(await parse({})).toMatchObject({ forge: "auto", prTiming: "end" });
  });

  it("rejects invalid input values before it reads the file", async () => {
    await writeDefaults("{ not json");
    await expect(parse({ forge: "bitbucket" })).rejects.toThrow(
      "autoimplement forge must be auto, github, or gitlab",
    );
    await expect(parse({ prTiming: "later" })).rejects.toThrow(
      "autoimplement prTiming must be early or end",
    );
    await expect(parse({})).rejects.toThrow(`autoimplement defaults file ${defaultsFile()}`);
  });

  it("reports the upstream input errors before forge, timing, and defaults file errors", async () => {
    await writeDefaults("{ not json");
    await expect(parse({ task: " ", forge: "bitbucket" })).rejects.toThrow(
      "autoimplement task must be a non-empty string",
    );
    await expect(parse({ repository: "relative", prTiming: "later" })).rejects.toThrow(
      "repository must be absolute",
    );
    await expect(parse({ baseBranch: "" })).rejects.toThrow(
      "baseBranch must be a non-empty string",
    );
    await expect(parse({ forge: "bitbucket", prTiming: "later" })).rejects.toThrow(
      "autoimplement forge must be auto, github, or gitlab",
    );
  });

  it("throws synchronously for an invalid defaults file", async () => {
    await writeDefaults({ schema: AUTOIMPLEMENT_DEFAULTS_SCHEMA, prTiming: "late" });
    const parseInput = autoimplementWorkflow.input;
    if (parseInput === undefined) throw new Error("autoimplement input parser is missing");
    expect(() => parseInput({ task: "demo", repository: "/repo" })).toThrow(
      "prTiming must be early or end",
    );
  });

  it("does not read the file for a fully explicit input", async () => {
    // Reading this file would throw, so a successful parse proves the file was not read.
    await writeDefaults("{ not json");
    expect(await parse({ forge: "gitlab", prTiming: "end" })).toMatchObject({
      forge: "gitlab",
      prTiming: "end",
    });
    const reads: string[] = [];
    expect(
      loadAutoimplementDefaults({ PI_WORKFLOWS_CONFIG_DIR: "/configured" }, (file) => {
        reads.push(file);
        return JSON.stringify({ schema: AUTOIMPLEMENT_DEFAULTS_SCHEMA, forge: "github" });
      }),
    ).toEqual({ forge: "github" });
    expect(reads).toEqual([path.join("/configured", "autoimplement.json")]);
  });

  it("parses a parsed input to the same value after the file changes", async () => {
    await writeDefaults({
      schema: AUTOIMPLEMENT_DEFAULTS_SCHEMA,
      forge: "gitlab",
      prTiming: "end",
    });
    const first = await parse({ merge: true });
    await writeDefaults({
      schema: AUTOIMPLEMENT_DEFAULTS_SCHEMA,
      forge: "github",
      prTiming: "early",
    });
    expect(await parse(first)).toEqual(first);
    await fs.rm(defaultsFile());
    expect(await parse(first)).toEqual(first);
  });
});

function step(index: number, nodeId: string, output: unknown): WorkflowStepRecord {
  return {
    attemptId: `attempt-${index}`,
    nodeId,
    nodeType: "compute",
    outcome: "ok",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    prompt: null,
    output,
  };
}

describe("monitor repairs", () => {
  it("normalize the included Autoimplement input with the defaults file", async () => {
    await writeDefaults({ schema: AUTOIMPLEMENT_DEFAULTS_SCHEMA, prTiming: "end" });
    const repository = await makeTempDir("monitor-defaults-repo");
    const plan = { summary: "Repair test-a", steps: ["fix", "verify"] };
    const observation = {
      route: "act",
      goalState: "incomplete",
      workState: "failed",
      observation: "test-a fails",
      report: "A fixable failure was found.",
      targetStateId: "test-a:one",
      authorizedActions: ["repair test-a"],
      reason: "Repair is authorized.",
      action: {
        kind: "repair",
        incomplete: "test-a must pass",
        evidence: {},
        nextAction: "Fix test-a",
        authority: {
          status: "authorized",
          basis: "The task authorizes repair.",
          allowedMutations: ["source and tests"],
          forbiddenMutations: [],
          costLimit: "No paid resources",
          providerRuntime: "Keep the runtime",
          requiredChecks: [],
          stopConditions: [],
          allowedRecoveryActions: [],
          repository,
          merge: false,
          repairApproval: { mode: "skip" },
        },
        cost: { paidAction: false, status: "not-applicable", evidence: "local" },
        defect: { sharedCodeOrDataDefect: true, paidRunners: "stopped", evidence: "none" },
        verification: "Run test-a.",
        failureId: "test-a",
        targetStateId: "test-a:one",
      },
    };
    const planChange = {
      exit: "ready",
      output: { plan, planDigest: digest(plan), documents: ["docs/plan.md"] },
    };
    const compiled = compileWorkflowDefinition(monitorWorkflow);
    const entry = compiled.nodes.implementation;
    if (entry?.nodeType !== "compute") throw new Error("implementation entry must be compute");
    const result = (await entry.run({
      input: {},
      outputs: {},
      results: {},
      state: {
        schema: "pi-workflows.run-state.v1",
        traceSeq: 1,
        runId: "monitor-defaults",
        workflowName: "monitor",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        status: "running",
        input: {},
        outputs: { observe: observation, planChange },
        results: {},
        steps: [
          step(1, "observe", observation),
          step(2, "planChange/__piw_exit_ready", planChange),
        ],
      },
      signal: new AbortController().signal,
    })) as { input: Record<string, unknown> };
    expect(result.input).toMatchObject({
      task: "Fix test-a",
      repository,
      forge: "auto",
      prTiming: "end",
    });
  });
});
