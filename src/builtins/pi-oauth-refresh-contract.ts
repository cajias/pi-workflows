/**
 * The contract between an agent group and its OAuth refresh process (`pi-oauth-refresh.ts`):
 * the request, the exit statuses, how a refresh error maps to one, how the entry starts, and how
 * both sides load Pi's modules by path from the Pi installation that runs the group.
 *
 * Only Node built-ins and Pi Workflows' own state module are imported statically, so a plain
 * Node process can load this module.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CredentialStore } from "@earendil-works/pi-ai";
import {
  OAUTH_REFRESH_CEILING_MS,
  OAUTH_REFRESH_MIN_CEILING_MS,
} from "../state/oauth-refresh-markers.js";

/** The environment variable that carries the request, as base64url JSON. */
export const OAUTH_REFRESH_REQUEST_ENV = "PI_WORKFLOWS_OAUTH_REFRESH_REQUEST";
/**
 * Read only by the refresh process: a shorter ceiling, in milliseconds, for tests. It reaches
 * the process only together with {@link OAUTH_REFRESH_TEST_SWITCH_ENV}; production uses
 * `OAUTH_REFRESH_CEILING_MS`.
 */
export const OAUTH_REFRESH_TEST_CEILING_ENV = "PI_WORKFLOWS_TEST_OAUTH_REFRESH_CEILING_MS";
/**
 * The explicit test switch, `1`, that lets a test ceiling reach the refresh process and go below
 * `OAUTH_REFRESH_MIN_CEILING_MS`. A test ceiling exported on its own, for example left in a shell
 * that later starts the workflow server, never shortens a production refresh.
 */
export const OAUTH_REFRESH_TEST_SWITCH_ENV = "PI_WORKFLOWS_TEST_SHORT_OAUTH_REFRESH_CEILING";
const REQUEST_SCHEMA = "pi-workflows.oauth-refresh-request.v1";

/** The exit status of a refresh process. */
export const OAUTH_REFRESH_EXIT = {
  /** Pi's authentication returned. The stored credential decides the outcome. */
  done: 0,
  /** Pi reported an OAuth failure: the refresh failed, or its token still expires too soon. */
  refreshFailed: 3,
  /** Pi could not lock, read, or write `auth.json`. */
  storeFailed: 4,
  /** Anything else, such as an extension that fails to load. */
  failed: 5,
  /** The refresh did not start within the start deadline. */
  notStarted: 6,
  /** The Pi installation lacks a module or an API that the refresh needs. */
  unsupported: 7,
  /** The refresh ran into the ceiling and the process exited with it still in flight. */
  ceiling: 8,
  /** The process could not write its marker, so it did not refresh. */
  markerFailed: 9,
} as const;

export type OAuthRefreshExit = (typeof OAUTH_REFRESH_EXIT)[keyof typeof OAUTH_REFRESH_EXIT];

export type OAuthRefreshRequest = {
  /** The root of the Pi package that runs the group, from Pi's `getPackageDir()`. */
  piPackageDir: string;
  agentDir: string;
  cwd: string;
  provider: string;
  /** The extensions that the group admits, because one of them can supply the OAuth refresh. */
  extensionPaths: string[];
  /** Pi refreshes the credential when it expires within this time. */
  minValidityMs: number;
};

export function encodeOAuthRefreshRequest(request: OAuthRefreshRequest): string {
  return Buffer.from(JSON.stringify({ schema: REQUEST_SCHEMA, ...request }), "utf8").toString(
    "base64url",
  );
}

export function decodeOAuthRefreshRequest(encoded: string): OAuthRefreshRequest {
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { schema?: unknown }).schema !== REQUEST_SCHEMA
  ) {
    throw new Error("invalid OAuth refresh request");
  }
  const { schema: _schema, ...request } = value as OAuthRefreshRequest & { schema: string };
  return request;
}

/**
 * The environment of a refresh process: the group's own, the given variables, and a test
 * ceiling only when the explicit test switch is also set.
 */
export function oauthRefreshProcessEnv(
  env: NodeJS.ProcessEnv,
  variables: Record<string, string>,
): NodeJS.ProcessEnv {
  const processEnv: NodeJS.ProcessEnv = { ...env, ...variables };
  if (env[OAUTH_REFRESH_TEST_SWITCH_ENV] !== "1") delete processEnv[OAUTH_REFRESH_TEST_CEILING_ENV];
  return processEnv;
}

/**
 * The ceiling of a refresh process. A test ceiling below `OAUTH_REFRESH_MIN_CEILING_MS`, Pi's own
 * bound, applies only with the explicit test switch.
 */
export function oauthRefreshCeilingMs(env: NodeJS.ProcessEnv): number {
  const override = Number(env[OAUTH_REFRESH_TEST_CEILING_ENV]);
  if (!Number.isSafeInteger(override) || override <= 0) return OAUTH_REFRESH_CEILING_MS;
  return env[OAUTH_REFRESH_TEST_SWITCH_ENV] === "1"
    ? override
    : Math.max(override, OAUTH_REFRESH_MIN_CEILING_MS);
}

/** A Pi installation without a module or an API that the refresh needs. */
export class UnsupportedPiInstallationError extends Error {
  constructor(what: string) {
    super(`unsupported Pi installation: ${what}`);
    this.name = "UnsupportedPiInstallationError";
  }
}

/**
 * The exit status for an error of the refresh. Pi's `ModelsError` (pi-ai `utils/models-error.js`)
 * carries a `code`: `oauth` for a failed refresh or one whose token expires too soon, and `auth`
 * for a credential store that could not be locked, read, or written (pi-ai `auth/resolve.js`).
 * The error itself can quote the provider's token response, so only this status leaves the
 * process.
 */
export function oauthRefreshExitFor(error: unknown): OAuthRefreshExit {
  if (error instanceof UnsupportedPiInstallationError) return OAUTH_REFRESH_EXIT.unsupported;
  if (!(error instanceof Error) || error.name !== "ModelsError") return OAUTH_REFRESH_EXIT.failed;
  const code = (error as { code?: unknown }).code;
  if (code === "oauth") return OAUTH_REFRESH_EXIT.refreshFailed;
  if (code === "auth") return OAUTH_REFRESH_EXIT.storeFailed;
  return OAUTH_REFRESH_EXIT.failed;
}

/**
 * The Node arguments that start the refresh process from the directory of its entry. A package
 * build runs the compiled entry. A source checkout runs the TypeScript source through tsx, a
 * dependency of this package, so the process needs no Node type stripping. `undefined` when
 * neither can run.
 */
export function oauthRefreshEntryArgs(
  directory: string,
  resolveTsx: () => string | undefined = () => resolveTsxLoader(import.meta.url),
): string[] | undefined {
  const compiled = path.join(directory, "pi-oauth-refresh.js");
  if (existsSync(compiled)) return [compiled];
  const source = path.join(directory, "pi-oauth-refresh.ts");
  if (!existsSync(source)) return undefined;
  const tsx = resolveTsx();
  return tsx === undefined ? undefined : ["--import", pathToFileURL(tsx).href, source];
}

function resolveTsxLoader(from: string): string | undefined {
  try {
    return createRequire(from).resolve("tsx");
  } catch {
    return undefined;
  }
}

/** Load only the given extension paths, and no other resources or context. */
export function isolatedResourceLoaderOptions(extensionPaths: readonly string[]) {
  return {
    additionalExtensionPaths: [...extensionPaths],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  };
}

/** The Pi modules that the refresh uses: the public SDK and Pi's file-backed credential store. */
export function piModulePaths(piPackageDir: string): { sdk: string; authStorage: string } {
  return {
    sdk: path.join(piPackageDir, "dist", "index.js"),
    authStorage: path.join(piPackageDir, "dist", "core", "auth-storage.js"),
  };
}

type PiSdk = typeof import("@earendil-works/pi-coding-agent");

/** Pi's public SDK, with the functions that the refresh calls. */
export async function loadPiSdk(piPackageDir: string): Promise<PiSdk> {
  const sdk = (await importPiModule(piModulePaths(piPackageDir).sdk, "the Pi SDK")) as Partial<
    Record<keyof PiSdk, unknown>
  >;
  const settings = sdk.SettingsManager as { inMemory?: unknown } | undefined;
  const runtime = sdk.ModelRuntime as { create?: unknown } | undefined;
  if (
    typeof runtime?.create !== "function" ||
    typeof sdk.createAgentSessionServices !== "function" ||
    typeof settings?.inMemory !== "function"
  ) {
    throw new UnsupportedPiInstallationError("the Pi SDK lacks the model runtime API");
  }
  return sdk as PiSdk;
}

/**
 * Pi's file-backed credential store for `auth.json` (`dist/core/auth-storage.js`), which Pi's
 * SDK uses itself. Pi's public SDK does not export it, so it is loaded by path.
 */
export async function createPiCredentialStore(
  piPackageDir: string,
  authPath: string,
): Promise<CredentialStore> {
  const module = (await importPiModule(
    piModulePaths(piPackageDir).authStorage,
    "Pi's credential store",
  )) as { AuthStorage?: { create?: unknown } };
  const create = module.AuthStorage?.create;
  if (typeof create !== "function") {
    throw new UnsupportedPiInstallationError("Pi's credential store has no AuthStorage.create");
  }
  const store = create.call(module.AuthStorage, authPath) as Partial<CredentialStore> | undefined;
  for (const method of ["read", "list", "modify", "delete"] as const) {
    if (typeof store?.[method] !== "function") {
      throw new UnsupportedPiInstallationError(`Pi's credential store has no ${method}`);
    }
  }
  return store as CredentialStore;
}

async function importPiModule(file: string, what: string): Promise<unknown> {
  try {
    return await import(pathToFileURL(file).href);
  } catch {
    throw new UnsupportedPiInstallationError(`${what} could not be loaded`);
  }
}
