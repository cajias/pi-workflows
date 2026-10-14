import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  setPiAgentGroupLauncher,
  type PiAgentGroupLaunchOptions,
  type PiAgentRequest,
  type PiAgentResult,
} from "../src/builtins/pi-agent-launch.js";
import sanityCheckWorkflow, {
  buildDetailedSanityCheckPrompt,
  buildReviewRequests,
  buildSanityCheckSummaryInput,
  buildVerificationRequest,
  collectContributionEvidence,
  formatSanityCheckReport,
  parseAgentJsonOutput,
  parseReviewOutput,
  parseSanityCheckInput,
  parseSanityCheckResult,
  type ContributionEvidence,
  type SanityCheckArea,
  type SanityCheckMode,
  type SanityCheckReview,
  type SanityCheckVerdict,
} from "../src/builtins/sanity-check.workflow.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { readWorkflowRun } from "../src/workflows/store.js";
import type { WorkflowUpdateRecord } from "../src/workflows/types.js";
import { makeStateDatabasePath, ScriptedExecutor, waitUntil } from "./helpers.js";

const execFileAsync = promisify(execFile);
const areas: SanityCheckArea[] = ["necessity", "duplication", "contracts", "scope_tests"];

function evidence(): ContributionEvidence {
  return {
    repository: "/tmp/repository",
    baseRef: "origin/main",
    headRevision: "abc123",
    pullRequest: { available: true, data: { title: "Change" } },
    committed: {
      stat: { text: "1 file changed", truncated: false },
      files: { text: "M\tsrc/a.ts", truncated: false },
      diff: { text: "+change", truncated: false },
    },
    workingTree: {
      status: { text: "", truncated: false },
      stat: { text: "", truncated: false },
      files: { text: "", truncated: false },
      diff: { text: "", truncated: false },
      untracked: { text: "", truncated: false },
    },
  };
}

function areaResult(area: SanityCheckArea) {
  return {
    area,
    assessment: "pass" as const,
    summary: `${area} is supported`,
    evidence: [{ path: "src/a.ts", symbol: "feature", detail: "direct evidence" }],
  };
}

function review(reviewAreas = areas): SanityCheckReview {
  return {
    areas: reviewAreas.map(areaResult),
    acceptanceCase: "The implementation directly satisfies the requirement.",
    questions: [],
    unknowns: [],
  };
}

function finalResult(verdict: SanityCheckVerdict) {
  return {
    verdict,
    summary: "The change is supported.",
    findings: areas.map(areaResult),
    requiredChanges: [],
    questionsForContributor: [],
    unknowns: [],
  };
}

type HostCall = { requests: PiAgentRequest[]; options: PiAgentGroupLaunchOptions };

/** Answer every request like the real launcher: lifecycle facts first, then final text. */
function installFakeHost(answer: (request: PiAgentRequest) => string | Error): HostCall[] {
  const calls: HostCall[] = [];
  setPiAgentGroupLauncher(async (requests, options) => {
    calls.push({ requests, options });
    const results: PiAgentResult[] = [];
    for (const request of requests) {
      const base = { id: request.id, role: request.role, elapsedMs: 1, model: "fixture/model" };
      await options.onLifecycle?.({ ...base, state: "running", phase: "thinking" });
      const text = answer(request);
      if (text instanceof Error) {
        await options.onLifecycle?.({ ...base, state: "failed", phase: "failed" });
        throw text;
      }
      await options.onLifecycle?.({ ...base, state: "completed", phase: "completed" });
      results.push({
        id: request.id,
        text,
        model: "fixture/model",
        thinkingLevel: "high",
        durationMs: 1,
      });
    }
    return results;
  });
  return calls;
}

/** The review and verification actions of Sanity Check, after fixed evidence. */
function agentProbe(mode: SanityCheckMode) {
  return defineWorkflow({
    name: "sanity-check-agents",
    startAt: "prepare",
    nodes: {
      prepare: compute({ run: () => ({ mode }) }),
      collectEvidence: compute({ run: () => evidence() }),
      review: sanityCheckWorkflow.nodes.review,
      verify: sanityCheckWorkflow.nodes.verify,
    },
    edges: [
      { from: "prepare", to: "collectEvidence" },
      { from: "collectEvidence", to: "review" },
      { from: "review", to: "verify" },
    ],
  });
}

async function runAgentProbe(mode: SanityCheckMode) {
  return await new WorkflowEngine({
    executor: new ScriptedExecutor(),
    databasePath: await makeStateDatabasePath("sanity-check-agents"),
  }).run(agentProbe(mode), {});
}

/**
 * Start every session, then wait for the abort and report final states the
 * way the headless launcher does after the action attempt has already ended.
 */
function installAbortedHost(): { started: () => boolean; lateEvents: () => number } {
  let started = false;
  let lateEvents = 0;
  setPiAgentGroupLauncher(async (requests, options) => {
    for (const request of requests) {
      await options.onLifecycle?.({
        id: request.id,
        role: request.role,
        elapsedMs: 1,
        model: "fixture/model",
        state: "running",
        phase: "thinking",
      });
    }
    started = true;
    await new Promise((resolve) => options.signal.addEventListener("abort", resolve));
    for (const request of requests) {
      lateEvents += 1;
      await options.onLifecycle?.({
        id: request.id,
        role: request.role,
        elapsedMs: 2,
        state: "cancelled",
        phase: "cancelled: headless pi did not report that the session settled",
      });
    }
    throw new Error("Pi agent group was cancelled");
  });
  return { started: () => started, lateEvents: () => lateEvents };
}

function reviewProbe(timeoutMs?: number) {
  return defineWorkflow({
    name: "sanity-check-review",
    startAt: "prepare",
    nodes: {
      prepare: compute({ run: () => ({ mode: "parallel" }) }),
      collectEvidence: compute({ run: () => evidence() }),
      review: {
        ...sanityCheckWorkflow.nodes.review!,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
    },
    edges: [
      { from: "prepare", to: "collectEvidence" },
      { from: "collectEvidence", to: "review" },
    ],
  });
}

function progressStates(updates: WorkflowUpdateRecord[] | undefined) {
  return Object.fromEntries(
    (updates ?? []).map((update) => [update.key, [update.data.status, update.data.phase]]),
  );
}

afterEach(() => setPiAgentGroupLauncher(undefined));

describe("sanity-check workflow", () => {
  it("runs serial review and verification sessions through the Pi agent group launcher", async () => {
    const calls = installFakeHost((request) =>
      JSON.stringify(request.id === "verification" ? finalResult("keep") : review()),
    );
    const result = await runAgentProbe("serial");

    expect(result.state.status).toBe("completed");
    expect(result.state.outputs.review).toEqual([review()]);
    expect(result.state.outputs.verify).toEqual(finalResult("keep"));
    expect(calls.map((call) => call.options.maxConcurrency)).toEqual([1, 1]);
    expect(calls.map((call) => call.requests.map((request) => request.id))).toEqual([
      ["review"],
      ["verification"],
    ]);
    for (const request of calls.flatMap((call) => call.requests)) {
      expect(request).toMatchObject({
        cwd: "/tmp/repository",
        tools: ["read", "grep", "find", "ls"],
        timeoutMs: 20 * 60_000,
      });
    }
    const progress = new Map(
      (result.state.updates ?? []).map((update) => [update.key, update.data.status]),
    );
    expect(progress.get("agents/review")).toBe("completed");
    expect(progress.get("agents/review/review")).toBe("completed");
    expect(progress.get("agents/verification")).toBe("completed");
    expect(progress.get("agents/verification/verification")).toBe("completed");
  });

  it("runs four focused reviews concurrently in parallel mode", async () => {
    const calls = installFakeHost((request) =>
      JSON.stringify(
        request.id === "verification"
          ? finalResult("simplify")
          : review([request.id as SanityCheckArea]),
      ),
    );
    const result = await runAgentProbe("parallel");

    expect(result.state.status).toBe("completed");
    expect(result.state.outputs.review).toEqual(areas.map((area) => review([area])));
    expect(calls[0]?.options.maxConcurrency).toBe(4);
    expect(calls[0]?.requests.map((request) => request.id)).toEqual(areas);
  });

  it("fits long agent labels to the progress schema and keeps the complete label", async () => {
    const runWithModel = async (model: string) => {
      setPiAgentGroupLauncher(async (requests, options) => {
        for (const request of requests) {
          for (const state of ["running", "completed"] as const) {
            await options.onLifecycle?.({
              id: request.id,
              role: request.role,
              elapsedMs: 1,
              model,
              state,
              phase: state,
            });
          }
        }
        return requests.map((request) => ({
          id: request.id,
          text: JSON.stringify(request.id === "verification" ? finalResult("keep") : review()),
          model,
          thinkingLevel: "high" as const,
          durationMs: 1,
        }));
      });
      const result = await runAgentProbe("serial");
      expect(result.state.status).toBe("completed");
      return result.state.updates ?? [];
    };
    const track = (updates: WorkflowUpdateRecord[], type: string, key: string) =>
      updates.find((update) => update.type === type && update.key === key)?.data;

    // A model ID that pushes the label past 200 characters.
    const longModel = `provider/${"m".repeat(250)}`;
    const long = await runWithModel(longModel);
    const complete = `Combined review · ${longModel}`;
    const label = track(long, "progress", "agents/review/review")?.label as string;
    expect(label).toBe(`${complete.slice(0, 199)}…`);
    expect(label).toHaveLength(200);
    expect(track(long, "sanity-check.agent-label", "agents/review/review")).toEqual({
      schema: "pi-workflows.sanity-check-agent-label.v1",
      label: complete,
    });
    // One complete-label record per track, even though the track updated several times.
    expect(
      long.filter((update) => update.type === "sanity-check.agent-label").map((u) => u.key),
    ).toEqual(["agents/review/review", "agents/verification/verification"]);

    // The cut never ends on half of a surrogate pair.
    const emojiModel = `p/${"x".repeat(178)}${"😀".repeat(20)}`;
    const emoji = await runWithModel(emojiModel);
    expect(track(emoji, "progress", "agents/review/review")?.label).toBe(
      `${`Combined review · ${emojiModel}`.slice(0, 198)}…`,
    );

    // A label within the limit stays whole and needs no complete-label record.
    const short = await runWithModel("fixture/model");
    expect(track(short, "progress", "agents/review/review")?.label).toBe(
      "Combined review · fixture/model",
    );
    expect(short.some((update) => update.type === "sanity-check.agent-label")).toBe(false);
  });

  it("retries a complete-label update that the runtime rejected", async () => {
    const model = `provider/${"m".repeat(250)}`;
    const complete = `Review · ${model}`;
    const published: Array<{ type: string; key: string; label: unknown }> = [];
    let rejectedOnce = false;
    setPiAgentGroupLauncher(async (requests, options) => {
      for (const state of ["running", "running", "completed"] as const) {
        await options.onLifecycle?.({
          id: "review",
          role: "Review",
          elapsedMs: 1,
          model,
          state,
          phase: state,
        });
      }
      return requests.map((request) => ({
        id: request.id,
        text: JSON.stringify(review()),
        model,
        thinkingLevel: "high" as const,
        durationMs: 1,
      }));
    });
    const context = {
      input: {},
      outputs: { prepare: { mode: "serial" }, collectEvidence: evidence() },
      results: {},
      state: {},
      signal: new AbortController().signal,
      effect: {
        type: "pi-workflows.sanity-check.review",
        idempotencyKey: "review",
        recovery: "manual",
      },
      publishUpdate: async (update: {
        type: string;
        key: string;
        data: Record<string, unknown>;
      }) => {
        // The first complete-label update is rejected, as by the update rate limit.
        if (update.type === "sanity-check.agent-label" && !rejectedOnce) {
          rejectedOnce = true;
          throw new Error("update rate limit exceeded");
        }
        published.push({ type: update.type, key: update.key, label: update.data.label });
        return { updateId: "u", seq: published.length, at: "", type: update.type, key: update.key };
      },
    } as unknown as Parameters<NonNullable<typeof sanityCheckWorkflow.nodes.review.run>>[0];

    await sanityCheckWorkflow.nodes.review.run!(context);

    expect(rejectedOnce).toBe(true);
    // The next lifecycle event for the key publishes the complete label again, once.
    expect(published.filter((update) => update.type === "sanity-check.agent-label")).toEqual([
      { type: "sanity-check.agent-label", key: "agents/review/review", label: complete },
    ]);
  });

  it("fails the review action with the launcher error and marks its progress failed", async () => {
    installFakeHost(() => new Error("Pi agent review failed: provider unavailable"));
    const result = await runAgentProbe("serial");

    expect(result.state.status).toBe("failed");
    expect(JSON.stringify(result.state.results.review)).toContain(
      "Pi agent review failed: provider unavailable",
    );
    const progress = new Map(
      (result.state.updates ?? []).map((update) => [update.key, update.data.status]),
    );
    expect(progress.get("agents/review")).toBe("failed");
    expect(progress.get("agents/review/review")).toBe("failed");
  });

  it("settles every agent track as timed out when the review action times out", async () => {
    const host = installAbortedHost();
    const databasePath = await makeStateDatabasePath("sanity-check-timeout");
    const result = await new WorkflowEngine({
      executor: new ScriptedExecutor(),
      databasePath,
    }).run(reviewProbe(500), {});

    expect(result.state.status).toBe("timed_out");
    const timedOut = ["failed", "timed out"];
    const expected = Object.fromEntries(
      ["agents/review", ...areas.map((area) => `agents/review/${area}`)].map((key) => [
        key,
        timedOut,
      ]),
    );
    expect(progressStates(result.state.updates)).toEqual(expected);
    expect(progressStates(readWorkflowRun(result.runId, { databasePath })?.state.updates)).toEqual(
      expected,
    );
    // The launcher's own final events arrive after the attempt ended and change nothing.
    await waitUntil(() => host.lateEvents() === areas.length);
    expect(progressStates(readWorkflowRun(result.runId, { databasePath })?.state.updates)).toEqual(
      expected,
    );
  });

  it("settles every agent track as cancelled when the run is cancelled", async () => {
    const host = installAbortedHost();
    const databasePath = await makeStateDatabasePath("sanity-check-cancel");
    const engine = new WorkflowEngine({ executor: new ScriptedExecutor(), databasePath });
    const running = engine.run(reviewProbe(), {});
    await waitUntil(host.started);
    engine.cancel();
    const result = await running;

    expect(result.state.status).toBe("cancelled");
    const expected = Object.fromEntries(
      ["agents/review", ...areas.map((area) => `agents/review/${area}`)].map((key) => [
        key,
        ["cancelled", "cancelled"],
      ]),
    );
    expect(progressStates(readWorkflowRun(result.runId, { databasePath })?.state.updates)).toEqual(
      expected,
    );
  });

  it("bounds malformed agent output errors without retaining model text", () => {
    const privateOutput = `PRIVATE_REPOSITORY_TEXT_${"x".repeat(100_000)}`;
    let error: unknown;
    try {
      parseAgentJsonOutput(privateOutput, "necessity");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Sanity Check agent necessity returned invalid JSON");
    expect((error as Error).message).not.toContain("PRIVATE_REPOSITORY_TEXT");
  });

  it("defaults to serial mode and validates input", () => {
    expect(parseSanityCheckInput(undefined)).toEqual({ mode: "serial" });
    expect(parseSanityCheckInput(null)).toEqual({ mode: "serial" });
    expect(parseSanityCheckInput({})).toEqual({ mode: "serial" });
    expect(parseSanityCheckInput({ baseRef: "origin/main" })).toEqual({
      mode: "serial",
      baseRef: "origin/main",
    });
    expect(parseSanityCheckInput({ mode: "parallel", baseRef: "main" })).toEqual({
      mode: "parallel",
      baseRef: "main",
    });
    expect(() => parseSanityCheckInput({ mode: "fast" })).toThrow(/serial or parallel/);
    expect(() => parseSanityCheckInput({ baseRef: "--output=x" })).toThrow(/plain Git reference/);
    expect(() => parseSanityCheckInput({ baseRef: 42 })).toThrow(/non-empty string/);
    expect(() => parseSanityCheckInput({ extra: true })).toThrow(/not supported/);
  });

  it("uses one complete review in serial mode and four focused reviews in parallel mode", () => {
    const serial = buildReviewRequests("serial", evidence());
    expect(serial).toHaveLength(1);
    for (const area of areas) expect(serial[0]?.prompt).toContain(area);
    expect(serial[0]?.prompt).toContain("best evidence-based case for accepting");
    expect(serial[0]?.prompt).toContain("exact file and symbol");

    const parallel = buildReviewRequests("parallel", evidence());
    expect(parallel.map((request) => request.id)).toEqual(areas);
    for (const request of parallel) {
      expect(request.prompt).toContain(`Review areas: ${request.id}.`);
      expect(request.prompt).toContain("best evidence-based case for accepting");
    }
  });

  it("bounds serialized evidence and review results below the session prompt limit", () => {
    const largeEvidence: ContributionEvidence = {
      ...evidence(),
      pullRequest: { available: true, data: { body: "x".repeat(200_000) } },
    };
    const reviewRequest = buildReviewRequests("serial", largeEvidence)[0];
    expect(reviewRequest?.prompt.length).toBeLessThan(96_000);
    expect(reviewRequest?.prompt).toContain("[input truncated]");

    const largeReview = { ...review(), acceptanceCase: "x".repeat(200_000) };
    const verification = buildVerificationRequest(largeEvidence, [largeReview]);
    expect(verification.prompt.length).toBeLessThan(96_000);
    expect(verification.prompt).toContain("[input truncated]");
  });

  it("builds one verification session that removes unsupported claims", () => {
    const request = buildVerificationRequest(evidence(), [review()]);
    expect(request.id).toBe("verification");
    expect(request.prompt).toContain("Delete any claim that lacks support");
    expect(request.prompt).toContain("exact file and symbol");
    expect(request.prompt).toContain("When reviews disagree");
    for (const verdict of ["keep", "simplify", "refactor", "drop", "needs_evidence"]) {
      expect(request.prompt).toContain(verdict);
    }
  });

  it("validates review coverage, acceptance cases, evidence, and every final verdict", () => {
    expect(parseReviewOutput(review(), areas)).toEqual(review());
    expect(() => parseReviewOutput({ ...review(), acceptanceCase: "" }, areas)).toThrow(
      /acceptanceCase/,
    );
    expect(() =>
      parseReviewOutput({ ...review(), areas: [areaResult("necessity")] }, areas),
    ).toThrow(/each requested area/);
    expect(() =>
      parseReviewOutput(
        {
          ...review(["necessity"]),
          areas: [{ ...areaResult("necessity"), evidence: [] }],
        },
        ["necessity"],
      ),
    ).toThrow(/requires evidence/);
    expect(
      parseReviewOutput(
        {
          ...review(["necessity"]),
          areas: [
            {
              ...areaResult("necessity"),
              assessment: "unclear",
              evidence: [],
              alternative: "Ask for the missing requirement.",
            },
          ],
        },
        ["necessity"],
      ).areas[0],
    ).toMatchObject({ assessment: "unclear", alternative: "Ask for the missing requirement." });

    for (const verdict of ["keep", "simplify", "refactor", "drop", "needs_evidence"] as const) {
      expect(parseSanityCheckResult(finalResult(verdict)).verdict).toBe(verdict);
    }
    expect(() => parseSanityCheckResult({ ...finalResult("keep"), verdict: "approve" })).toThrow(
      /verdict/,
    );
    expect(() => parseReviewOutput(null, areas)).toThrow(/must be an object/);
    expect(() =>
      parseReviewOutput(
        { ...review(["necessity"]), areas: [{ ...areaResult("necessity"), area: "bad" }] },
        ["necessity"],
      ),
    ).toThrow(/area is invalid/);
    expect(() =>
      parseReviewOutput(
        {
          ...review(["necessity"]),
          areas: [{ ...areaResult("necessity"), assessment: "maybe" }],
        },
        ["necessity"],
      ),
    ).toThrow(/assessment must be/);
    expect(() => parseReviewOutput({ ...review(), questions: "none" }, areas)).toThrow(
      /must be an array/,
    );
    expect(() =>
      parseReviewOutput({ ...review(), unknowns: Array.from({ length: 41 }, () => "x") }, areas),
    ).toThrow(/at most 40/);
  });

  it("shows the full report before a composed plain summary", () => {
    const result = parseSanityCheckResult(finalResult("keep"));
    const report = formatSanityCheckReport(result);
    expect(report).toContain("Sanity Check: keep");
    expect(report).toContain("src/a.ts :: feature");
    const detailed = formatSanityCheckReport({
      ...result,
      findings: [
        { ...result.findings[0]!, alternative: "Use the existing helper." },
        ...result.findings.slice(1),
      ],
      requiredChanges: ["Add the missing test."],
      questionsForContributor: ["Which user needs this?"],
      unknowns: ["Product intent is not recorded."],
    });
    expect(detailed).toContain("Alternative: Use the existing helper.");
    expect(detailed).toContain("Required changes:");
    expect(detailed).toContain("Questions for the contributor:");
    expect(detailed).toContain("Unknowns:");
    const longSummary = "x".repeat(20_000);
    const complete = formatSanityCheckReport({ ...result, summary: longSummary });
    expect(complete).toContain(longSummary);
    expect(complete).not.toContain("[report truncated]");

    const prompt = buildDetailedSanityCheckPrompt(result);
    expect(prompt).toContain("return no other text");
    expect(prompt).toContain(report);
    const summary = buildSanityCheckSummaryInput(result, report);
    expect(summary).toMatchObject({
      source: { verdict: "keep", detailedReport: report },
      mustInclude: ["Verdict: keep"],
      maxChars: 2_000,
      maxSentences: 5,
      format: "mixed",
    });
    expect(() => buildSanityCheckSummaryInput(result, "A changed report")).toThrow(
      /did not match the verified report/,
    );

    expect(sanityCheckWorkflow).not.toHaveProperty("presentationPrompt");
    expect(sanityCheckWorkflow.maxSteps).toBe(8);
    expect(sanityCheckWorkflow.nodes.detailedReport).toMatchObject({
      nodeType: "agent",
      expectedOutput: { kind: "assistant-message" },
    });
    expect(sanityCheckWorkflow.nodes.detailedReport.expectedOutput).not.toHaveProperty("maxChars");
    expect(Object.keys(sanityCheckWorkflow.includes ?? {})).toEqual(["plainSummary"]);
    expect(sanityCheckWorkflow.nodes.finish).toMatchObject({ nodeType: "compute" });
    expect(sanityCheckWorkflow.edges).toEqual([
      { from: "prepare", to: "collectEvidence" },
      { from: "collectEvidence", to: "review" },
      { from: "review", to: "verify" },
      { from: "verify", to: "detailedReport" },
      { from: "detailedReport", to: "plainSummary" },
      { from: "plainSummary.completed", to: "finish" },
    ]);
  });

  it("collects committed and working-tree evidence with fixed Git commands", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sanity-evidence-"));
    try {
      await execFileAsync("git", ["init", "-q"], { cwd: dir });
      await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: dir });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
      await fs.writeFile(path.join(dir, "sample.txt"), "base\n", "utf8");
      await execFileAsync("git", ["add", "sample.txt"], { cwd: dir });
      await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
      await fs.writeFile(
        path.join(dir, "sample.txt"),
        `base\n${"working\n".repeat(2_000)}`,
        "utf8",
      );

      const result = await collectContributionEvidence(
        { mode: "serial", baseRef: stdout.trim() },
        dir,
        new AbortController().signal,
      );
      expect(result.repository).toBe(dir);
      expect(result.baseRef).toBe(stdout.trim());
      expect(result.committed.diff.text).toBe("");
      expect(result.workingTree.diff.text).toContain("+working");
      expect(result.workingTree.diff.truncated).toBe(true);
      expect(result.workingTree.status.text).toContain("sample.txt");
      expect(result.pullRequest.available).toBe(false);

      const defaultBase = await collectContributionEvidence(
        { mode: "serial" },
        dir,
        new AbortController().signal,
      );
      expect(defaultBase.baseRef).toBe(stdout.trim());
      expect(defaultBase.workingTree.diff.truncated).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
