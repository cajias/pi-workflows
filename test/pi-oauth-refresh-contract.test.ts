import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createPiCredentialStore,
  decodeOAuthRefreshRequest,
  encodeOAuthRefreshRequest,
  loadPiSdk,
  OAUTH_REFRESH_EXIT,
  OAUTH_REFRESH_TEST_CEILING_ENV,
  OAUTH_REFRESH_TEST_SWITCH_ENV,
  oauthRefreshCeilingMs,
  oauthRefreshEntryArgs,
  oauthRefreshExitFor,
  oauthRefreshProcessEnv,
  piModulePaths,
  UnsupportedPiInstallationError,
} from "../src/builtins/pi-oauth-refresh-contract.js";
import {
  OAUTH_REFRESH_CEILING_MS,
  OAUTH_REFRESH_MIN_CEILING_MS,
} from "../src/state/oauth-refresh-markers.js";
import { makeTempDir } from "./helpers.js";

/** An error shaped like pi-ai's `ModelsError`, which carries a `code`. */
function modelsError(code: unknown): Error {
  const error = new Error("refresh text that may quote a token") as Error & { code: unknown };
  error.name = "ModelsError";
  error.code = code;
  return error;
}

async function stubPi(modules: { sdk?: string; authStorage?: string }): Promise<string> {
  const root = await makeTempDir("pi-oauth-refresh-stub");
  const paths = piModulePaths(root);
  await fs.mkdir(path.dirname(paths.authStorage), { recursive: true });
  if (modules.sdk !== undefined) await fs.writeFile(paths.sdk, modules.sdk, "utf8");
  if (modules.authStorage !== undefined) {
    await fs.writeFile(paths.authStorage, modules.authStorage, "utf8");
  }
  return root;
}

describe("OAuth refresh process contract", () => {
  it("maps a refresh error to an exit status by its kind only", () => {
    expect(oauthRefreshExitFor(modelsError("oauth"))).toBe(OAUTH_REFRESH_EXIT.refreshFailed);
    expect(oauthRefreshExitFor(modelsError("auth"))).toBe(OAUTH_REFRESH_EXIT.storeFailed);
    expect(oauthRefreshExitFor(modelsError("provider"))).toBe(OAUTH_REFRESH_EXIT.failed);
    expect(oauthRefreshExitFor(modelsError(undefined))).toBe(OAUTH_REFRESH_EXIT.failed);
    expect(oauthRefreshExitFor(new Error("plain"))).toBe(OAUTH_REFRESH_EXIT.failed);
    expect(oauthRefreshExitFor("thrown text")).toBe(OAUTH_REFRESH_EXIT.failed);
    expect(oauthRefreshExitFor(new UnsupportedPiInstallationError("missing"))).toBe(
      OAUTH_REFRESH_EXIT.unsupported,
    );
    // Every status is distinct, so the group can tell the outcomes apart.
    const statuses = Object.values(OAUTH_REFRESH_EXIT);
    expect(new Set(statuses).size).toBe(statuses.length);
  });

  it("passes a test ceiling only with the explicit test switch, and floors it otherwise", () => {
    const variables = { PI_CODING_AGENT_DIR: "/agent" };
    const stray = { HOME: "/home", [OAUTH_REFRESH_TEST_CEILING_ENV]: "1000" };
    const production = oauthRefreshProcessEnv(stray, variables);
    expect(production).toEqual({ HOME: "/home", PI_CODING_AGENT_DIR: "/agent" });
    expect(OAUTH_REFRESH_TEST_CEILING_ENV in production).toBe(false);
    // The group's own environment is not changed.
    expect(stray[OAUTH_REFRESH_TEST_CEILING_ENV]).toBe("1000");
    const test = { ...stray, [OAUTH_REFRESH_TEST_SWITCH_ENV]: "1" };
    expect(oauthRefreshProcessEnv(test, variables)).toEqual({ ...test, ...variables });
    expect(
      oauthRefreshProcessEnv({ ...stray, [OAUTH_REFRESH_TEST_SWITCH_ENV]: "yes" }, variables),
    ).not.toHaveProperty(OAUTH_REFRESH_TEST_CEILING_ENV);

    expect(oauthRefreshCeilingMs({})).toBe(OAUTH_REFRESH_CEILING_MS);
    expect(oauthRefreshCeilingMs({ [OAUTH_REFRESH_TEST_CEILING_ENV]: "soon" })).toBe(
      OAUTH_REFRESH_CEILING_MS,
    );
    expect(oauthRefreshCeilingMs({ [OAUTH_REFRESH_TEST_CEILING_ENV]: "0" })).toBe(
      OAUTH_REFRESH_CEILING_MS,
    );
    // Without the switch, no ceiling goes below Pi's own 45-second bound.
    expect(oauthRefreshCeilingMs({ [OAUTH_REFRESH_TEST_CEILING_ENV]: "1000" })).toBe(
      OAUTH_REFRESH_MIN_CEILING_MS,
    );
    expect(OAUTH_REFRESH_MIN_CEILING_MS).toBe(45_000);
    expect(oauthRefreshCeilingMs({ [OAUTH_REFRESH_TEST_CEILING_ENV]: "120000" })).toBe(120_000);
    expect(oauthRefreshCeilingMs({ ...test })).toBe(1_000);
  });

  it("round-trips a request and rejects anything else", () => {
    const request = {
      piPackageDir: "/pi",
      agentDir: "/agent",
      cwd: "/project",
      provider: "fixture",
      extensionPaths: ["/ext.ts"],
      minValidityMs: 1_000,
    };
    expect(decodeOAuthRefreshRequest(encodeOAuthRefreshRequest(request))).toEqual(request);
    const other = Buffer.from(JSON.stringify({ schema: "other" }), "utf8").toString("base64url");
    expect(() => decodeOAuthRefreshRequest(other)).toThrow("invalid OAuth refresh request");
    expect(() => decodeOAuthRefreshRequest(Buffer.from("null").toString("base64url"))).toThrow(
      "invalid OAuth refresh request",
    );
  });

  it("starts the compiled entry, or the source through tsx, or reports that neither can run", async () => {
    const directory = await makeTempDir("pi-oauth-refresh-entry");
    expect(oauthRefreshEntryArgs(directory, () => "/tsx/loader.mjs")).toBeUndefined();
    const source = path.join(directory, "pi-oauth-refresh.ts");
    await fs.writeFile(source, "", "utf8");
    expect(oauthRefreshEntryArgs(directory, () => "/tsx/loader.mjs")).toEqual([
      "--import",
      pathToFileURL("/tsx/loader.mjs").href,
      source,
    ]);
    expect(oauthRefreshEntryArgs(directory, () => undefined)).toBeUndefined();
    // The package's own tsx resolves by default.
    expect(oauthRefreshEntryArgs(directory)?.[0]).toBe("--import");
    const compiled = path.join(directory, "pi-oauth-refresh.js");
    await fs.writeFile(compiled, "", "utf8");
    expect(oauthRefreshEntryArgs(directory, () => undefined)).toEqual([compiled]);
  });

  it("reports a Pi installation without the modules or APIs that the refresh uses", async () => {
    const missing = await stubPi({});
    await expect(loadPiSdk(missing)).rejects.toThrow(
      "unsupported Pi installation: the Pi SDK could not be loaded",
    );
    await expect(createPiCredentialStore(missing, "/auth.json")).rejects.toThrow(
      "unsupported Pi installation: Pi's credential store could not be loaded",
    );

    const misshapen = await stubPi({
      sdk: "export const ModelRuntime = {};\n",
      authStorage: "export const AuthStorage = {};\n",
    });
    await expect(loadPiSdk(misshapen)).rejects.toThrow(UnsupportedPiInstallationError);
    await expect(createPiCredentialStore(misshapen, "/auth.json")).rejects.toThrow(
      "unsupported Pi installation: Pi's credential store has no AuthStorage.create",
    );

    const partialStore = await stubPi({
      authStorage:
        "export const AuthStorage = { create: () => ({ read() {}, list() {}, modify() {} }) };\n",
    });
    await expect(createPiCredentialStore(partialStore, "/auth.json")).rejects.toThrow(
      "unsupported Pi installation: Pi's credential store has no delete",
    );

    const complete = await stubPi({
      sdk: "export const ModelRuntime = { create() {} };\nexport function createAgentSessionServices() {}\nexport const SettingsManager = { inMemory() {} };\n",
      authStorage:
        "export const AuthStorage = { create: (authPath) => ({ authPath, read() {}, list() {}, modify() {}, delete() {} }) };\n",
    });
    await expect(loadPiSdk(complete)).resolves.toBeDefined();
    await expect(createPiCredentialStore(complete, "/agent/auth.json")).resolves.toMatchObject({
      authPath: "/agent/auth.json",
    });
  });
});
