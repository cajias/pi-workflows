import fs from "node:fs";
import path from "node:path";
import { workflowsConfigDir } from "./config-dir.js";

/**
 * Markers of running OAuth refresh processes.
 *
 * An agent group refreshes an OAuth credential in a process of its own that no workflow
 * server, runner, or launcher supervises, so that no stop of theirs can cut a refresh short.
 * Each such process writes a marker while it runs, so the operator and `pi-workflows server
 * status` can find it. A marker holds the process ID, the provider ID, and the start time, and
 * never credential data.
 */
const MARKER_SCHEMA = "pi-workflows.oauth-refresh-marker.v1";
const MARKER_SUFFIX = ".json";

/**
 * How long a refresh process may load Pi and the admitted extensions before its refresh starts.
 * It exits when the refresh has not started by then, which is safe: no refresh is in flight.
 */
export const OAUTH_REFRESH_START_DEADLINE_MS = 60_000;
/**
 * How long a refresh process may run once its refresh has started. Pi waits at most 30 seconds
 * for the `auth.json` lock and gives the provider's refresh a 15-second abort signal, and the
 * agent group waits two minutes for the process. A refresh still running five minutes after it
 * started is stuck, for example in a provider refresh that ignores its abort signal, so the
 * process then exits even though the refresh is in flight. Exiting releases Pi's lock.
 */
export const OAUTH_REFRESH_CEILING_MS = 5 * 60_000;
/** No refresh process lives longer than this, so an older marker is stale even if its PID runs. */
const MARKER_MAX_AGE_MS = OAUTH_REFRESH_START_DEADLINE_MS + OAUTH_REFRESH_CEILING_MS + 60_000;

export type OAuthRefreshMarker = {
  pid: number;
  provider: string;
  /** ISO 8601. */
  startedAt: string;
};

export type OAuthRefreshMarkerStatus = OAuthRefreshMarker & {
  /** The process still runs and the marker is younger than any refresh process lives. */
  running: boolean;
};

/** `${PI_WORKFLOWS_CONFIG_DIR:-~/.config/pi-workflows}/oauth-refresh`, private to the user. */
export function oauthRefreshMarkerDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(workflowsConfigDir(env), "oauth-refresh");
}

/**
 * Write the marker of the calling process: `<pid>.json`, mode `0600`, in a `0700` directory.
 * Returns its path. A file left for the same PID belongs to an earlier, finished process.
 */
export function writeOAuthRefreshMarker(directory: string, marker: OAuthRefreshMarker): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The directory must be the user's own, not a symbolic link, and private.
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid !== undefined && stat.uid !== process.getuid())) {
    throw new Error(`${directory} is not a private directory of this user`);
  }
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, `${marker.pid}${MARKER_SUFFIX}`);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, JSON.stringify({ schema: MARKER_SCHEMA, ...marker }), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return file;
}

export function removeOAuthRefreshMarker(file: string): void {
  fs.rmSync(file, { force: true });
}

/** Every marker in the directory, with whether its process still runs. */
export function listOAuthRefreshMarkers(
  directory: string,
  options: LivenessOptions = {},
): OAuthRefreshMarkerStatus[] {
  return markerFiles(directory).flatMap(({ marker }) =>
    marker === undefined ? [] : [{ ...marker, running: isLive(marker, options) }],
  );
}

/** Remove the markers whose process no longer runs, and unreadable markers. */
export function pruneOAuthRefreshMarkers(directory: string, options: LivenessOptions = {}): void {
  for (const { file, marker } of markerFiles(directory)) {
    if (marker === undefined || !isLive(marker, options)) fs.rmSync(file, { force: true });
  }
}

type LivenessOptions = { now?: number; isRunning?: (pid: number) => boolean };

function isLive(marker: OAuthRefreshMarker, options: LivenessOptions): boolean {
  const age = (options.now ?? Date.now()) - Date.parse(marker.startedAt);
  return (options.isRunning ?? processRunning)(marker.pid) && age <= MARKER_MAX_AGE_MS;
}

/** Regular marker files, never followed through a symbolic link. */
function markerFiles(directory: string): Array<{ file: string; marker?: OAuthRefreshMarker }> {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(MARKER_SUFFIX))
    .flatMap((name) => {
      const file = path.join(directory, name);
      try {
        if (!fs.lstatSync(file).isFile()) return [];
        const marker = parseMarker(fs.readFileSync(file, "utf8"));
        return [marker === undefined ? { file } : { file, marker }];
      } catch {
        return [];
      }
    });
}

function parseMarker(text: string): OAuthRefreshMarker | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.schema !== MARKER_SCHEMA ||
    !Number.isSafeInteger(record.pid) ||
    typeof record.provider !== "string" ||
    typeof record.startedAt !== "string" ||
    Number.isNaN(Date.parse(record.startedAt))
  ) {
    return undefined;
  }
  return { pid: record.pid as number, provider: record.provider, startedAt: record.startedAt };
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}
