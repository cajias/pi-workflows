import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agentGroupErrorFields, runPiAgentGroup } from "../src/builtins/pi-agent-group.js";
import type { PiAgentLifecycleEvent, PiAgentRequest } from "../src/builtins/pi-agent-launch.js";
import { agentGroupCauseText } from "../src/server/agent-group-diagnostics.js";
import { describeAgentGroupFailure } from "../src/server/agent-group-protocol.js";
import { startMockOpenAiServer, type MockModelScript } from "./e2e/mock-openai.js";
import { makeTempDir } from "./helpers.js";

// Each test bounds a session by a hang limit, not by speed, as pi-agent-group.test.ts does.
const SESSION_HANG_MS = 30_000;
// Each group runs every request in its own slot, so it can run for one session timeout. The
// group adds a ten-minute margin, so a credential must stay valid for 10.5 minutes.
const REQUIRED_MINUTES = 11;
const NEAR_EXPIRY_MS = 5 * 60_000;
const LONG_LIVED_MS = 3 * 60 * 60_000;
// Unique credential values. None of them may appear in any result, event, or error text.
const MARKERS = {
  oldAccess: "pw-oauth-marker-old-access-41d7",
  oldRefresh: "pw-oauth-marker-old-refresh-41d7",
  newAccess: "pw-oauth-marker-new-access-41d7",
  newRefresh: "pw-oauth-marker-new-refresh-41d7",
};

function request(id: string, cwd: string): PiAgentRequest {
  return {
    id,
    role: `Role ${id}`,
    prompt: `Prompt ${id}`,
    cwd,
    tools: ["read"],
    timeoutMs: SESSION_HANG_MS,
  };
}

function fixtureExtension(name: string): string {
  return path.resolve(`test/fixtures/pi-agent-extensions/${name}.ts`);
}

function storedOAuth(expiresInMs: number) {
  return {
    type: "oauth",
    access: MARKERS.oldAccess,
    refresh: MARKERS.oldRefresh,
    expires: Date.now() + expiresInMs,
  };
}

type Scenario = {
  agentDir: string;
  cwd: string;
  authPath: string;
  refreshLog: string;
  mock: Awaited<ReturnType<typeof startMockOpenAiServer>>;
  events: PiAgentLifecycleEvent[];
};

/**
 * A group whose dispatch provider is the legacy fixture extension with a stored OAuth
 * credential. Its refresh is the fixture's mock, which logs each call. Requests go to a local
 * mock model server, which records the bearer token of each request.
 */
async function legacyOAuthScenario(
  name: string,
  options: {
    expiresInMs: number;
    refresh?: "rotate" | "short" | "fail";
    script?: MockModelScript;
  },
): Promise<Scenario> {
  const mock = await startMockOpenAiServer(
    options.script ?? (() => ({ kind: "text", text: '{"answer":"oauth"}' })),
  );
  const agentDir = await makeTempDir(`pi-agent-oauth-${name}`);
  const cwd = await makeTempDir(`pi-agent-oauth-${name}-project`);
  await fs.writeFile(path.join(cwd, "README.md"), "fixture project\n", "utf8");
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "fixture-legacy",
      defaultModel: "fixture-legacy-model",
      defaultThinkingLevel: "high",
      extensions: [fixtureExtension("legacy-provider")],
    }),
    "utf8",
  );
  const authPath = path.join(agentDir, "auth.json");
  await fs.writeFile(
    authPath,
    JSON.stringify({ "fixture-legacy": storedOAuth(options.expiresInMs) }),
    "utf8",
  );
  const refreshLog = path.join(agentDir, "refresh.log");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("HOME", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("PI_AGENT_FIXTURE_API_KEY", undefined);
  vi.stubEnv("PI_AGENT_FIXTURE_BASE_URL", mock.baseUrl);
  vi.stubEnv("PI_AGENT_FIXTURE_OAUTH", "1");
  vi.stubEnv("PI_AGENT_FIXTURE_OAUTH_REFRESH", options.refresh);
  vi.stubEnv("PI_AGENT_FIXTURE_OAUTH_REFRESH_FILE", refreshLog);
  vi.stubEnv("PI_AGENT_FIXTURE_OAUTH_NEW_ACCESS", MARKERS.newAccess);
  vi.stubEnv("PI_AGENT_FIXTURE_OAUTH_NEW_REFRESH", MARKERS.newRefresh);
  return { agentDir, cwd, authPath, refreshLog, mock, events: [] };
}

async function refreshCount(scenario: Scenario): Promise<number> {
  try {
    return (await fs.readFile(scenario.refreshLog, "utf8")).trim().split("\n").length;
  } catch {
    return 0;
  }
}

async function storedCredential(scenario: Scenario, provider = "fixture-legacy") {
  return (JSON.parse(await fs.readFile(scenario.authPath, "utf8")) as Record<string, unknown>)[
    provider
  ];
}

async function groupError(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("the agent group did not fail");
}

/** Every text that leaves the group for an error: message, bridge event, and cause file. */
function errorTexts(error: Error): string {
  const fields = agentGroupErrorFields(error);
  expect(fields).toBeDefined();
  return JSON.stringify([
    error.message,
    fields,
    describeAgentGroupFailure(error, fields),
    agentGroupCauseText(error as Parameters<typeof agentGroupCauseText>[0]),
  ]);
}

function expectNoCredentialText(text: string): void {
  for (const marker of Object.values(MARKERS)) expect(text).not.toContain(marker);
}

async function close(scenario: Scenario | undefined): Promise<void> {
  vi.unstubAllEnvs();
  await scenario?.mock.close();
}

describe("Pi agent group OAuth credentials", { timeout: 3 * SESSION_HANG_MS }, () => {
  it("uses a stored OAuth credential without refreshing it when it outlives the group", async () => {
    let scenario: Scenario | undefined;
    try {
      scenario = await legacyOAuthScenario("long-lived", { expiresInMs: LONG_LIVED_MS });
      const before = await fs.readFile(scenario.authPath, "utf8");
      const results = await runPiAgentGroup([request("long-lived", scenario.cwd)], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
      });
      expect(results).toEqual([
        expect.objectContaining({
          model: "fixture-legacy/fixture-legacy-model",
          text: '{"answer":"oauth"}',
        }),
      ]);
      expect(await refreshCount(scenario)).toBe(0);
      expect(scenario.mock.authorizations).toEqual([`Bearer ${MARKERS.oldAccess}`]);
      expect(await fs.readFile(scenario.authPath, "utf8")).toBe(before);
      expectNoCredentialText(JSON.stringify(results));
    } finally {
      await close(scenario);
    }
  });

  it("refreshes a near-expiry OAuth credential once through Pi before parallel children start", async () => {
    let scenario: Scenario | undefined;
    try {
      scenario = await legacyOAuthScenario("near-expiry", {
        expiresInMs: NEAR_EXPIRY_MS,
        refresh: "rotate",
      });
      const { cwd, events } = scenario;
      const results = await runPiAgentGroup(
        ["a", "b", "c", "d"].map((id) => request(`parallel-${id}`, cwd)),
        {
          maxConcurrency: 4,
          signal: new AbortController().signal,
          onLifecycle: (event) => {
            events.push(event);
          },
        },
      );
      expect(results).toHaveLength(4);
      // One refresh for the group, not one per child.
      expect(await refreshCount(scenario)).toBe(1);
      // Every child used the refreshed credential, which Pi itself saved to auth.json.
      expect(scenario.mock.authorizations).toEqual(
        Array.from({ length: 4 }, () => `Bearer ${MARKERS.newAccess}`),
      );
      expect(await storedCredential(scenario)).toMatchObject({
        type: "oauth",
        access: MARKERS.newAccess,
        refresh: MARKERS.newRefresh,
      });
      expectNoCredentialText(JSON.stringify([results, events]));
    } finally {
      await close(scenario);
    }
  });

  it("fails before any session starts when Pi cannot refresh the OAuth credential", async () => {
    let scenario: Scenario | undefined;
    try {
      scenario = await legacyOAuthScenario("refresh-fails", {
        expiresInMs: NEAR_EXPIRY_MS,
        refresh: "fail",
      });
      const before = await fs.readFile(scenario.authPath, "utf8");
      const { cwd, events } = scenario;
      const error = await groupError(
        runPiAgentGroup([request("refresh-fails", cwd)], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          onLifecycle: (event) => {
            events.push(event);
          },
        }),
      );
      expect(error.message).toBe(
        "Pi agent group could not refresh OAuth credentials: fixture-legacy; sign in to the provider again in Pi, or configure an API key for it",
      );
      // The refresh error quoted the refresh token; its text is kept nowhere.
      expect(agentGroupErrorFields(error)?.detail).toBeUndefined();
      expectNoCredentialText(errorTexts(error));
      expect(await refreshCount(scenario)).toBe(1);
      expect(events).toEqual([]);
      expect(scenario.mock.requests).toHaveLength(0);
      expect(await fs.readFile(scenario.authPath, "utf8")).toBe(before);
    } finally {
      await close(scenario);
    }
  });

  it("fails before any session starts when the refreshed credential still expires too soon", async () => {
    let scenario: Scenario | undefined;
    try {
      scenario = await legacyOAuthScenario("too-short", {
        expiresInMs: NEAR_EXPIRY_MS,
        refresh: "short",
      });
      const { cwd, events } = scenario;
      const error = await groupError(
        runPiAgentGroup([request("too-short", cwd)], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          onLifecycle: (event) => {
            events.push(event);
          },
        }),
      );
      expect(error.message).toBe(
        `Pi agent group has OAuth credentials that expire too soon: fixture-legacy; the refreshed credentials expire before the agent group can finish, which can take ${REQUIRED_MINUTES} minutes`,
      );
      expect(agentGroupErrorFields(error)?.detail).toBeUndefined();
      expectNoCredentialText(errorTexts(error));
      expect(await refreshCount(scenario)).toBe(1);
      expect(events).toEqual([]);
      expect(scenario.mock.requests).toHaveLength(0);
    } finally {
      await close(scenario);
    }
  });

  it("fails a child that would need to refresh before its first request, without refreshing", async () => {
    let scenario: Scenario | undefined;
    try {
      // The credential expires in four minutes, inside Pi's five-minute refresh threshold. The
      // group's clock runs three hours behind, so the group sees no need to refresh.
      scenario = await legacyOAuthScenario("late-start", {
        expiresInMs: 4 * 60_000,
        refresh: "rotate",
      });
      const before = await fs.readFile(scenario.authPath, "utf8");
      const error = await groupError(
        runPiAgentGroup([request("late-start", scenario.cwd)], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          now: () => Date.now() - LONG_LIVED_MS,
        }),
      );
      expect(error.message).toBe(
        "Pi agent late-start would need to refresh OAuth credentials mid-group: fixture-legacy; an agent group refreshes OAuth credentials only once, before it starts",
      );
      expectNoCredentialText(errorTexts(error));
      expect(await refreshCount(scenario)).toBe(0);
      expect(scenario.mock.requests).toHaveLength(0);
      expect(await fs.readFile(scenario.authPath, "utf8")).toBe(before);
    } finally {
      await close(scenario);
    }
  });

  it("fails a child that would need to refresh between requests, without refreshing", async () => {
    let scenario: Scenario | undefined;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // The first model request calls the read tool. While the tool runs, the clock moves
      // past the credential's expiry, so the next request would need a refresh.
      scenario = await legacyOAuthScenario("mid-prompt", {
        expiresInMs: LONG_LIVED_MS,
        refresh: "rotate",
        script: ({ lastRole }) =>
          lastRole === "toolResult" || lastRole === "tool"
            ? { kind: "text", text: '{"answer":"late"}' }
            : { kind: "tool", toolName: "read", args: { path: "README.md" } },
      });
      const before = await fs.readFile(scenario.authPath, "utf8");
      let clock = 0;
      const error = await groupError(
        runPiAgentGroup([request("mid-prompt", scenario.cwd)], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          now: () => (clock += 300),
          onLifecycle: (event) => {
            if (event.phase === "tool: read") vi.setSystemTime(Date.now() + 2 * LONG_LIVED_MS);
          },
        }),
      );
      expect(error.message).toBe(
        "Pi agent mid-prompt would need to refresh OAuth credentials mid-group: fixture-legacy; an agent group refreshes OAuth credentials only once, before it starts",
      );
      expectNoCredentialText(errorTexts(error));
      expect(await refreshCount(scenario)).toBe(0);
      expect(scenario.mock.authorizations).toEqual([`Bearer ${MARKERS.oldAccess}`]);
      expect(await fs.readFile(scenario.authPath, "utf8")).toBe(before);
    } finally {
      vi.useRealTimers();
      await close(scenario);
    }
  });

  it("uses a long-lived OAuth credential of a provider built into Pi without refreshing it", async () => {
    let scenario: Scenario | undefined;
    try {
      scenario = await legacyOAuthScenario("builtin-long-lived", { expiresInMs: LONG_LIVED_MS });
      await writeOpenRouterConfig(scenario, LONG_LIVED_MS, { modelsJson: true });
      const before = await fs.readFile(scenario.authPath, "utf8");
      const results = await runPiAgentGroup([request("builtin-long-lived", scenario.cwd)], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
      });
      expect(results).toEqual([
        expect.objectContaining({ model: `openrouter/${OPENROUTER_MODEL}` }),
      ]);
      expect(scenario.mock.authorizations).toEqual([`Bearer ${MARKERS.oldAccess}`]);
      expect(await fs.readFile(scenario.authPath, "utf8")).toBe(before);
    } finally {
      await close(scenario);
    }
  });

  it("refreshes through Pi a near-expiry OAuth credential of a provider built into Pi", async () => {
    let scenario: Scenario | undefined;
    try {
      scenario = await legacyOAuthScenario("builtin-near-expiry", { expiresInMs: LONG_LIVED_MS });
      await writeOpenRouterConfig(scenario, NEAR_EXPIRY_MS, { modelsJson: true });
      const before = await fs.readFile(scenario.authPath, "utf8");
      const error = await groupError(
        runPiAgentGroup([request("builtin-near-expiry", scenario.cwd)], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
        }),
      );
      // Pi's own OpenRouter refresh returns the stored credential unchanged, so the
      // credential still expires too early.
      expect(error.message).toBe(
        "Pi agent group could not refresh OAuth credentials: openrouter; sign in to the provider again in Pi, or configure an API key for it",
      );
      expectNoCredentialText(errorTexts(error));
      // Pi's credential store ran the refresh and saved its result in its own format.
      const after = await fs.readFile(scenario.authPath, "utf8");
      expect(after).not.toBe(before);
      expect(JSON.parse(after)).toEqual(JSON.parse(before));
      expect(scenario.mock.requests).toHaveLength(0);
    } finally {
      await close(scenario);
    }
  });

  it("refreshes through Pi a near-expiry OAuth credential of a Pi provider that an extension re-registers", async () => {
    let scenario: Scenario | undefined;
    try {
      scenario = await legacyOAuthScenario("wrapped-near-expiry", { expiresInMs: LONG_LIVED_MS });
      await writeOpenRouterConfig(scenario, NEAR_EXPIRY_MS, {
        extensions: [fixtureExtension("openrouter-base-url")],
      });
      const before = await fs.readFile(scenario.authPath, "utf8");
      const { cwd, events } = scenario;
      const error = await groupError(
        runPiAgentGroup([request("wrapped-near-expiry", cwd)], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          onLifecycle: (event) => {
            events.push(event);
          },
        }),
      );
      // Pi's own OpenRouter refresh returns the stored credential unchanged, so the
      // credential still expires too early.
      expect(error.message).toBe(
        "Pi agent group could not refresh OAuth credentials: openrouter; sign in to the provider again in Pi, or configure an API key for it",
      );
      expectNoCredentialText(errorTexts(error));
      // Pi's credential store ran the refresh and saved its result in its own format.
      const after = await fs.readFile(scenario.authPath, "utf8");
      expect(after).not.toBe(before);
      expect(JSON.parse(after)).toEqual(JSON.parse(before));
      expect(events).toEqual([]);
      expect(scenario.mock.requests).toHaveLength(0);
    } finally {
      await close(scenario);
    }
  });
});

// A provider built into Pi whose OAuth credential is a long-lived key. Its refresh returns the
// stored credential without a network request, and it speaks the mock's chat API.
const OPENROUTER_MODEL = "openai/gpt-oss-120b";

async function writeOpenRouterConfig(
  scenario: Scenario,
  expiresInMs: number,
  options: { modelsJson?: boolean; extensions?: string[] },
): Promise<void> {
  await fs.writeFile(
    path.join(scenario.agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "openrouter",
      defaultModel: OPENROUTER_MODEL,
      defaultThinkingLevel: "high",
      extensions: options.extensions ?? [],
    }),
    "utf8",
  );
  if (options.modelsJson === true) {
    await fs.writeFile(
      path.join(scenario.agentDir, "models.json"),
      JSON.stringify({ providers: { openrouter: { baseUrl: scenario.mock.baseUrl } } }),
      "utf8",
    );
  }
  await fs.writeFile(
    scenario.authPath,
    JSON.stringify({ openrouter: storedOAuth(expiresInMs) }),
    "utf8",
  );
  vi.stubEnv("OPENROUTER_API_KEY", undefined);
}
