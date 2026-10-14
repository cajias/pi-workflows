/**
 * Refreshes one stored OAuth credential through Pi's own locked credential store, in a process
 * of its own.
 *
 * The headless pi process that runs an agent group starts this process detached, in its own
 * session and process group, and registers it nowhere. Stopping a group stops that headless pi
 * process with `SIGTERM` and then `SIGKILL`, and the workflow runner and the workflow server stop
 * their children the same way. None of those signals reach this process, so none of them can end
 * a refresh after the provider has rotated the refresh token and before Pi has saved it.
 *
 * The process is plain Node: it imports Pi by path from the installation that runs the group.
 * Pi's `AuthStorage` takes the `auth.json` lock, refreshes, and writes the result; this process
 * never writes credentials. It reports only an exit status, so no credential and no error text
 * leaves it. Its lifetime is bounded: it exits when the refresh does not start within
 * {@link OAUTH_REFRESH_START_DEADLINE_MS}, and once it starts, Pi bounds the lock wait and the
 * refresh.
 *
 * Only Node built-ins are imported statically, so Node can run the source file directly and the
 * agent group runner can import the contract below.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CredentialStore } from "@earendil-works/pi-ai";

/** The environment variable that carries the request, as base64url JSON. */
export const OAUTH_REFRESH_REQUEST_ENV = "PI_WORKFLOWS_OAUTH_REFRESH_REQUEST";
const REQUEST_SCHEMA = "pi-workflows.oauth-refresh-request.v1";
/**
 * How long the process may take to load Pi and the admitted extensions before the refresh
 * starts. Without a refresh in flight it is safe to stop, so a stuck extension cannot leave it
 * running forever.
 */
export const OAUTH_REFRESH_START_DEADLINE_MS = 60_000;

/** The exit status of a refresh process. */
export const OAUTH_REFRESH_EXIT = {
  /** Pi's authentication returned. The stored credential decides the outcome. */
  done: 0,
  /** Pi reported an OAuth failure: the refresh failed, or its token still expires too soon. */
  refreshFailed: 3,
  /** Pi could not lock, read, or write `auth.json`. */
  storeFailed: 4,
  /** Anything else, such as loading Pi or an extension. */
  failed: 5,
  /** The refresh did not start within the start deadline. */
  notStarted: 6,
} as const;

export type OAuthRefreshRequest = {
  schema: typeof REQUEST_SCHEMA;
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

export function encodeOAuthRefreshRequest(request: Omit<OAuthRefreshRequest, "schema">): string {
  return Buffer.from(JSON.stringify({ schema: REQUEST_SCHEMA, ...request }), "utf8").toString(
    "base64url",
  );
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
/** Pi's `AuthStorage` (`dist/core/auth-storage.js`), which Pi's SDK uses for `auth.json`. */
export type PiAuthStorageModule = {
  AuthStorage: { create(authPath: string): CredentialStore };
};

/** Import Pi's file-backed credential store from the installation that runs the group. */
export async function importPiAuthStorage(piPackageDir: string): Promise<PiAuthStorageModule> {
  return (await import(
    pathToFileURL(piModulePaths(piPackageDir).authStorage).href
  )) as PiAuthStorageModule;
}

async function refresh(request: OAuthRefreshRequest, started: () => void): Promise<void> {
  const sdk = (await import(pathToFileURL(piModulePaths(request.piPackageDir).sdk).href)) as PiSdk;
  const { AuthStorage } = await importPiAuthStorage(request.piPackageDir);
  const store = AuthStorage.create(path.join(request.agentDir, "auth.json"));
  const modelRuntime = await sdk.ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
    credentials: {
      read: async (providerId, options) => await store.read(providerId, options),
      list: async (options) => await store.list(options),
      // Pi refreshes an OAuth credential only through this write, under the file lock.
      modify: async (providerId, update, options) => {
        started();
        return await store.modify(providerId, update, options);
      },
      delete: async (providerId, options) => await store.delete(providerId, options),
    },
    modelsStore: {
      read: async () => undefined,
      write: async () => undefined,
      delete: async () => undefined,
    },
  });
  if (request.extensionPaths.length > 0) {
    await sdk.createAgentSessionServices({
      cwd: request.cwd,
      agentDir: request.agentDir,
      settingsManager: sdk.SettingsManager.inMemory(
        { extensions: [], skills: [], prompts: [], themes: [] },
        { projectTrusted: false },
      ),
      modelRuntime,
      resourceLoaderOptions: isolatedResourceLoaderOptions(request.extensionPaths),
    });
  }
  // No abort signal: once Pi has sent the refresh token, the refresh and its save must finish.
  await modelRuntime.getAuth(request.provider, { minOAuthValidityMs: request.minValidityMs });
}

/** Pi's `ModelsError` (pi-ai `utils/models-error.js`) carries a `code`, such as `oauth`. */
function modelsErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== "ModelsError") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function readRequest(): OAuthRefreshRequest {
  const encoded = process.env[OAUTH_REFRESH_REQUEST_ENV] ?? "";
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { schema?: unknown }).schema !== REQUEST_SCHEMA
  ) {
    throw new Error("invalid OAuth refresh request");
  }
  return value as OAuthRefreshRequest;
}

async function main(): Promise<number> {
  let refreshing = false;
  // Nothing in Pi Workflows signals this process. A signal from elsewhere still waits for a
  // refresh in flight.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (!refreshing) process.exit(OAUTH_REFRESH_EXIT.failed);
    });
  }
  const deadline = setTimeout(
    () => process.exit(OAUTH_REFRESH_EXIT.notStarted),
    OAUTH_REFRESH_START_DEADLINE_MS,
  );
  try {
    await refresh(readRequest(), () => {
      refreshing = true;
      clearTimeout(deadline);
    });
    return OAUTH_REFRESH_EXIT.done;
  } catch (error) {
    // The error can quote the provider's token response, so only its kind leaves the process.
    const code = modelsErrorCode(error);
    if (code === "oauth") return OAUTH_REFRESH_EXIT.refreshFailed;
    if (code === "auth") return OAUTH_REFRESH_EXIT.storeFailed;
    return OAUTH_REFRESH_EXIT.failed;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Exit at once: an admitted extension may hold handles, and no session ever started.
  void main().then((code) => process.exit(code));
}
