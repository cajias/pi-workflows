import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PiAgentGroupError,
  launchPiAgentGroup,
  setPiAgentGroupLauncher,
  type PiAgentGroupLaunchOptions,
  type PiAgentRequest,
} from "../src/builtins/pi-agent-launch.js";
import { loadWorkflowFile } from "../src/workflows/loader.js";
import { makeTempDir } from "./helpers.js";

const request: PiAgentRequest = {
  id: "review",
  role: "Review",
  prompt: "Review the change.",
  cwd: "/repo",
  tools: ["read"],
};

afterEach(() => setPiAgentGroupLauncher(undefined));

describe("Pi agent group launcher", () => {
  it("fails clearly when the process has no Pi agent launcher", async () => {
    await expect(
      launchPiAgentGroup([request], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      "Pi agent group could not run: this process cannot start Pi agent sessions; run the workflow through the pi-workflows server",
    );
  });

  it("delegates requests and options to the installed launcher", async () => {
    const calls: Array<{ requests: PiAgentRequest[]; options: PiAgentGroupLaunchOptions }> = [];
    setPiAgentGroupLauncher(async (requests, options) => {
      calls.push({ requests, options });
      return [{ id: "review", text: "{}", model: "p/m", thinkingLevel: "high", durationMs: 1 }];
    });
    const options = { maxConcurrency: 1, signal: new AbortController().signal };
    await expect(launchPiAgentGroup([request], options)).resolves.toEqual([
      { id: "review", text: "{}", model: "p/m", thinkingLevel: "high", durationMs: 1 },
    ]);
    expect(calls).toEqual([{ requests: [request], options }]);

    setPiAgentGroupLauncher(undefined);
    await expect(launchPiAgentGroup([request], options)).rejects.toThrow(
      /could not run: this process cannot start/,
    );
  });

  it("keeps private detail out of the message and never shortens it", () => {
    const detail = `PRIVATE_PROVIDER_TEXT ${"x".repeat(10_000)}`;
    const error = new PiAgentGroupError("review", "failed", "the session raised an error", {
      detail,
    });
    expect(error.detail).toBe(detail);
    expect(error.facts).toBe("the session raised an error");
    expect(error.message).toBe("Pi agent review failed: the session raised an error");
    expect(error.message).not.toContain("PRIVATE_PROVIDER_TEXT");

    const facts = `after 5ms; ${"y".repeat(3_000)}`;
    const located = new PiAgentGroupError("review", "timed out", facts, {
      detail,
      notice: "complete cause: /tmp/cause.txt",
    });
    expect(located.message).toBe(
      `Pi agent review timed out: ${facts}. complete cause: /tmp/cause.txt`,
    );
    expect(located.notice).toBe("complete cause: /tmp/cause.txt");
    expect(new PiAgentGroupError("review", "failed", "fixed").detail).toBeUndefined();
  });
});

describe("Pi agent group launcher in user workflows", () => {
  it("reaches the installed launcher from built-in Sanity Check nodes in a user workflow file", async () => {
    const dir = await makeTempDir("pi-workflows-f39");
    const file = path.join(dir, "reuse-sanity.workflow.ts");
    await fs.writeFile(
      file,
      [
        `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";`,
        `import { sanityCheckWorkflow } from "@osolmaz/pi-workflows/builtins";`,
        `export default defineWorkflow({`,
        `  name: "reuse-sanity",`,
        `  startAt: "prepare",`,
        `  nodes: {`,
        `    prepare: compute({ run: () => ({ mode: "serial" }) }),`,
        `    review: sanityCheckWorkflow.nodes.review,`,
        `  },`,
        `  edges: [{ from: "prepare", to: "review" }],`,
        `});`,
        ``,
      ].join("\n"),
      "utf8",
    );
    const workflow = await loadWorkflowFile(file);
    const calls: PiAgentRequest[][] = [];
    setPiAgentGroupLauncher(async (requests) => {
      calls.push(requests);
      throw new PiAgentGroupError("group", "failed", "fixture launcher");
    });
    const text = { text: "", truncated: false };
    const review = workflow.nodes.review;
    if (review?.nodeType !== "action" || !("run" in review)) {
      throw new Error("review must be a function action node");
    }
    const context = {
      input: {},
      outputs: {
        prepare: { mode: "serial" },
        collectEvidence: {
          repository: dir,
          baseRef: "HEAD",
          headRevision: "abc",
          pullRequest: { available: false },
          committed: { stat: text, files: text, diff: text },
          workingTree: { status: text, stat: text, files: text, diff: text, untracked: text },
        },
      },
      results: {},
      state: {},
      signal: new AbortController().signal,
      effect: { type: "pi-workflows.sanity-check.review", idempotencyKey: "r", recovery: "manual" },
      publishUpdate: async () => ({ updateId: "u", seq: 1, at: "", type: "t", key: "k" }),
    } as unknown as Parameters<NonNullable<typeof review.run>>[0];

    await expect(review.run(context)).rejects.toThrow("Pi agent group failed: fixture launcher");
    expect(calls).toHaveLength(1);
  });
});
