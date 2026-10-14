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
/** A marker's file name. Nothing else in the directory is ever read or removed. */
const MARKER_NAME = /^\d+\.json$/u;
/** A marker that is still being written, before it is renamed into place. */
const PENDING_MARKER_NAME = /^\d+\.json\.tmp$/u;
/** A pending marker this old was left by a process that died while writing it. */
const PENDING_MARKER_MAX_AGE_MS = 10_000;

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
/**
 * The shortest ceiling that a production refresh process accepts: Pi's lock wait of up to 30
 * seconds plus its 15-second refresh timeout. A shorter one could end a refresh that Pi would
 * still finish, after the provider rotated the refresh token and before Pi saved it.
 */
export const OAUTH_REFRESH_MIN_CEILING_MS = 45_000;
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
 * Returns its path. A file left for the same PID belongs to an earlier, finished process. The
 * marker is written under a pending name and renamed into place, so a concurrent prune never
 * sees it half-written.
 */
export function writeOAuthRefreshMarker(directory: string, marker: OAuthRefreshMarker): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!isPrivateDirectory(directory)) {
    throw new Error(`${directory} is not a private directory of this user`);
  }
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, `${marker.pid}.json`);
  const pending = `${file}.tmp`;
  fs.rmSync(pending, { force: true });
  fs.writeFileSync(pending, JSON.stringify({ schema: MARKER_SCHEMA, ...marker }), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(pending, file);
  return file;
}

/** A real directory, not a symbolic link, that belongs to this user. */
function isPrivateDirectory(directory: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    return false;
  }
  return stat.isDirectory() && (process.getuid === undefined || stat.uid === process.getuid());
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

/**
 * Remove the markers whose process no longer runs, unreadable markers, and pending markers that
 * a process left while writing them. A directory that is not this user's own real directory is
 * left alone, and only marker file names are ever removed.
 */
export function pruneOAuthRefreshMarkers(directory: string, options: LivenessOptions = {}): void {
  for (const { file, marker } of markerFiles(directory)) {
    if (marker === undefined || !isLive(marker, options)) fs.rmSync(file, { force: true });
  }
  const now = options.now ?? Date.now();
  for (const name of directoryEntries(directory)) {
    if (!PENDING_MARKER_NAME.test(name)) continue;
    const file = path.join(directory, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && now - stat.mtimeMs > PENDING_MARKER_MAX_AGE_MS) fs.rmSync(file);
    } catch {
      // Renamed or removed meanwhile.
    }
  }
}

type LivenessOptions = { now?: number; isRunning?: (pid: number) => boolean };

function isLive(marker: OAuthRefreshMarker, options: LivenessOptions): boolean {
  const age = (options.now ?? Date.now()) - Date.parse(marker.startedAt);
  return (options.isRunning ?? processRunning)(marker.pid) && age <= MARKER_MAX_AGE_MS;
}

/** The entries of a private marker directory; none for any other path. */
function directoryEntries(directory: string): string[] {
  if (!isPrivateDirectory(directory)) return [];
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

/** Regular marker files, never followed through a symbolic link. */
function markerFiles(directory: string): Array<{ file: string; marker?: OAuthRefreshMarker }> {
  return directoryEntries(directory)
    .filter((name) => MARKER_NAME.test(name))
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
