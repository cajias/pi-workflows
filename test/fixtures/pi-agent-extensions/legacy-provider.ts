import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type FixtureOAuthCredentials = { access: string; refresh: string; expires: number };

/**
 * A legacy `oauth` configuration whose refresh is the test's mock. Each refresh appends one line
 * to PI_AGENT_FIXTURE_OAUTH_REFRESH_FILE when it starts, then waits until the file
 * PI_AGENT_FIXTURE_OAUTH_REFRESH_GATE exists, when that is set. PI_AGENT_FIXTURE_OAUTH_REFRESH
 * selects its outcome: `rotate` returns the PI_AGENT_FIXTURE_OAUTH_NEW_* tokens for two hours,
 * `short` returns them for one minute, `fail` throws an error that quotes the refresh token, and
 * `hang` never returns and ignores its abort signal. Any other value means a refresh is a test
 * failure. The gate wait gives up after 60 seconds.
 *
 * PI_AGENT_FIXTURE_OAUTH_AFTER_REFRESH changes `auth.json` after Pi saved the refreshed
 * credential, as another Pi process could: `remove` deletes the entry, and `api-key` replaces
 * it with an API key.
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
      const gate = process.env.PI_AGENT_FIXTURE_OAUTH_REFRESH_GATE;
      // A test that fails before it opens the gate still lets this refresh end.
      const gateDeadline = Date.now() + 60_000;
      while (gate && !fs.existsSync(gate)) {
        if (Date.now() > gateDeadline) throw new Error("fixture OAuth refresh gate never opened");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const mode = process.env.PI_AGENT_FIXTURE_OAUTH_REFRESH;
      // A refresh that ignores its abort signal and never returns.
      if (mode === "hang") await new Promise<never>(() => undefined);
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
      const change = process.env.PI_AGENT_FIXTURE_OAUTH_AFTER_REFRESH;
      if (change && credentials.access === process.env.PI_AGENT_FIXTURE_OAUTH_NEW_ACCESS) {
        const authPath = path.join(process.env.PI_CODING_AGENT_DIR ?? "", "auth.json");
        const stored = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>;
        if (change === "remove") delete stored["fixture-legacy"];
        else stored["fixture-legacy"] = { type: "api_key", key: "fixture-replacement-key" };
        fs.writeFileSync(authPath, JSON.stringify(stored), "utf8");
      }
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
