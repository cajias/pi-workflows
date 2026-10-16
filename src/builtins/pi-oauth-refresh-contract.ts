/**
 * The contract between an agent group and its OAuth refresh process (`pi-oauth-refresh.ts`):
 * the request, the exit statuses, how a refresh error maps to one, how the entry starts, and how
 * the refresh process loads Pi's public SDK from the Pi installation that runs the group.
 *
 * Only Node built-ins and Pi Workflows' own state module are imported statically, so a plain
 * Node process can load this module.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

/** Exit statuses from a refresh process that reached Pi's authentication, or named its failure. */
const REPORTED_EXITS: ReadonlySet<number> = new Set([
  OAUTH_REFRESH_EXIT.done,
  OAUTH_REFRESH_EXIT.refreshFailed,
  OAUTH_REFRESH_EXIT.storeFailed,
  OAUTH_REFRESH_EXIT.unsupported,
  OAUTH_REFRESH_EXIT.markerFailed,
]);

/**
 * Whether the refresh process itself failed rather than Pi's refresh: it could not start (the
 * group passes `undefined` for a spawn error), could not load Pi or the admitted extensions
 * (`failed`, or any status that Pi Workflows does not define, such as a crash), did not start
 * the refresh in time (`notStarted`), ran into the ceiling (`ceiling`), or did not exit while
 * the group waited (`undefined`). Signing in again does not help with any of these.
 */
export function oauthRefreshProcessFailed(exit: number | undefined): boolean {
  return exit === undefined || !REPORTED_EXITS.has(exit);
}

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

/**
 * The public entry of the Pi package: its manifest's `exports["."]`, as the `import` condition,
 * else the `default` condition, else a plain string. Pi Workflows imports only this entry, the
 * module that `import "@earendil-works/pi-coding-agent"` resolves to, and no file inside the
 * package. `undefined` when the manifest has no such entry or the entry file is missing.
 */
export function piSdkEntry(piPackageDir: string): string | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path.join(piPackageDir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  const exports = isRecord(manifest) ? manifest.exports : undefined;
  const root = isRecord(exports) && "." in exports ? exports["."] : undefined;
  const target =
    typeof root === "string"
      ? root
      : isRecord(root)
        ? [root.import, root.default].find((value) => typeof value === "string")
        : undefined;
  if (typeof target !== "string" || !target.startsWith("./")) return undefined;
  const entry = path.resolve(piPackageDir, target);
  const relative = path.relative(piPackageDir, entry);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(entry)) {
    return undefined;
  }
  return entry;
}

type PiSdk = typeof import("@earendil-works/pi-coding-agent");

/** Pi's public SDK, with the functions that the refresh calls. */
export async function loadPiSdk(piPackageDir: string): Promise<PiSdk> {
  const entry = piSdkEntry(piPackageDir);
  if (entry === undefined) {
    throw new UnsupportedPiInstallationError("the Pi package has no public entry");
  }
  let sdk: Partial<Record<keyof PiSdk, unknown>>;
  try {
    sdk = (await import(pathToFileURL(entry).href)) as Partial<Record<keyof PiSdk, unknown>>;
  } catch {
    throw new UnsupportedPiInstallationError("the Pi SDK could not be loaded");
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
