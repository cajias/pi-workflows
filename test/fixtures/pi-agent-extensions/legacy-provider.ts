import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type FixtureOAuthCredentials = { access: string; refresh: string; expires: number };

/**
 * A legacy `oauth` configuration whose refresh is the test's mock. Each refresh appends one line
 * to PI_AGENT_FIXTURE_OAUTH_REFRESH_FILE. PI_AGENT_FIXTURE_OAUTH_REFRESH selects its outcome:
 * `rotate` returns the PI_AGENT_FIXTURE_OAUTH_NEW_* tokens for two hours, `short` returns them
 * for one minute, and `fail` throws an error that quotes the refresh token. Any other value
 * means a refresh is a test failure.
 */
function fixtureOAuth() {
  return {
    name: "Fixture legacy OAuth",
    async login(): Promise<FixtureOAuthCredentials> {
      throw new Error("fixture OAuth login is not interactive");
    },
    async refreshToken(credentials: FixtureOAuthCredentials): Promise<FixtureOAuthCredentials> {
      const counter = process.env.PI_AGENT_FIXTURE_OAUTH_REFRESH_FILE;
      if (counter) fs.appendFileSync(counter, "refresh\n", "utf8");
      const mode = process.env.PI_AGENT_FIXTURE_OAUTH_REFRESH;
      if (mode === "fail") throw new Error(`refresh rejected for ${credentials.refresh}`);
      if (mode !== "rotate" && mode !== "short") {
        throw new Error("fixture OAuth must not refresh");
      }
      return {
        access: process.env.PI_AGENT_FIXTURE_OAUTH_NEW_ACCESS ?? "fixture-new-access",
        refresh: process.env.PI_AGENT_FIXTURE_OAUTH_NEW_REFRESH ?? "fixture-new-refresh",
        expires: Date.now() + (mode === "rotate" ? 2 * 60 : 1) * 60_000,
      };
    },
    getApiKey(credentials: FixtureOAuthCredentials): string {
      return credentials.access;
    },
  };
}

export default function legacyProvider(pi: ExtensionAPI): void {
  pi.registerProvider("fixture-legacy", {
    baseUrl: process.env.PI_AGENT_FIXTURE_BASE_URL ?? "http://127.0.0.1:1/v1",
    apiKey: "$PI_AGENT_FIXTURE_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "fixture-legacy-model",
        name: "Fixture legacy model",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
    ],
    ...(process.env.PI_AGENT_FIXTURE_OAUTH === "1" ? { oauth: fixtureOAuth() } : {}),
  });
}
