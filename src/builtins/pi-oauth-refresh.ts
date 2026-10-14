/**
 * Refreshes one stored OAuth credential through Pi's own locked credential store, in a process
 * of its own.
 *
 * The headless pi process that runs an agent group starts this process detached, in its own
 * session and process group, and registers it with no supervisor. The workflow server, the
 * runner, and the agent group launcher stop their processes through process groups and
 * registered process IDs, so no stop of theirs reaches this process, and none can end a refresh
 * after the provider has rotated the refresh token and before Pi has saved it.
 *
 * The process is plain Node: it imports Pi by path from the installation that runs the group.
 * Pi's `AuthStorage` takes the `auth.json` lock, refreshes, and writes the result; this process
 * never writes credentials. It reports only an exit status (see `pi-oauth-refresh-contract.ts`),
 * so no credential and no error text leaves it. While it runs it keeps a marker with its process
 * ID, the provider ID, and its start time (see `state/oauth-refresh-markers.ts`).
 *
 * Its lifetime is bounded twice: it exits when the refresh has not started within
 * `OAUTH_REFRESH_START_DEADLINE_MS`, and once the refresh has started, it exits at
 * `OAUTH_REFRESH_CEILING_MS` even when the refresh is still in flight.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OAUTH_REFRESH_START_DEADLINE_MS,
  oauthRefreshMarkerDirectory,
  removeOAuthRefreshMarker,
  writeOAuthRefreshMarker,
} from "../state/oauth-refresh-markers.js";
import {
  createPiCredentialStore,
  decodeOAuthRefreshRequest,
  isolatedResourceLoaderOptions,
  loadPiSdk,
  OAUTH_REFRESH_EXIT,
  OAUTH_REFRESH_REQUEST_ENV,
  oauthRefreshCeilingMs,
  oauthRefreshExitFor,
  type OAuthRefreshRequest,
} from "./pi-oauth-refresh-contract.js";

async function refresh(request: OAuthRefreshRequest, started: () => void): Promise<void> {
  const sdk = await loadPiSdk(request.piPackageDir);
  const store = await createPiCredentialStore(
    request.piPackageDir,
    path.join(request.agentDir, "auth.json"),
  );
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

async function main(): Promise<number> {
  let request: OAuthRefreshRequest;
  let marker: string;
  try {
    request = decodeOAuthRefreshRequest(process.env[OAUTH_REFRESH_REQUEST_ENV] ?? "");
  } catch {
    return OAUTH_REFRESH_EXIT.failed;
  }
  try {
    // Without a marker the process would be impossible to find, so it does not refresh.
    marker = writeOAuthRefreshMarker(oauthRefreshMarkerDirectory(), {
      pid: process.pid,
      provider: request.provider,
      startedAt: new Date().toISOString(),
    });
  } catch {
    return OAUTH_REFRESH_EXIT.markerFailed;
  }
  process.on("exit", () => removeOAuthRefreshMarker(marker));
  let refreshing = false;
  // Nothing in Pi Workflows signals this process. A signal from elsewhere still waits for a
  // refresh in flight, up to the ceiling.
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
    await refresh(request, () => {
      if (refreshing) return;
      refreshing = true;
      clearTimeout(deadline);
      setTimeout(
        () => process.exit(OAUTH_REFRESH_EXIT.ceiling),
        oauthRefreshCeilingMs(process.env),
      );
    });
    return OAUTH_REFRESH_EXIT.done;
  } catch (error) {
    return oauthRefreshExitFor(error);
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Exit at once: an admitted extension may hold handles, and no session ever started.
  void main().then((code) => process.exit(code));
}
