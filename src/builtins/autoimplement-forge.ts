import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Code forge selection for Autoimplement.
 *
 * Everything here is pure except `defaultForgeIo`, `readForgeFacts`, and `resolveForge`. Detection
 * never throws for unknown or malformed facts: it falls back to GitHub, which is the upstream
 * behavior, and records why.
 */

const execFileAsync = promisify(execFile);

export type Forge = "github" | "gitlab";
export type ForgeRequest = "auto" | Forge;
export const FORGE_RESOLUTION_SCHEMA = "pi-workflows.autoimplement-forge-resolution.v1";

export type ForgeResolution = {
  schema: typeof FORGE_RESOLUTION_SCHEMA;
  requested: ForgeRequest;
  forge: Forge;
  /** Matched forge host: a glab hosts key, `GITLAB_HOST`, or the remote host. Null when explicit or without a remote host. */
  host: string | null;
  /** The remote URL without credentials. Null when explicit or absent. */
  remoteUrl: string | null;
  reason: string;
};

/** A remote's network host, lowercased and without IPv6 brackets. */
export type RemoteHost = { host: string; port: number | null };
/** One entry under `hosts:` in a glab `config.yml`. Tokens are never kept. */
export type GlabHostEntry = { key: string; apiHost?: string; sshHost?: string };
export type ForgeFacts = {
  /** Already redacted. */
  remoteUrl: string | null;
  ghHosts: readonly string[];
  glabHosts: readonly GlabHostEntry[];
  /** `GITLAB_HOST` as a bare host or a URL. */
  gitlabHostEnv: string | null;
};

export type ForgeIo = {
  /** Runs `git` without a shell and returns its trimmed standard output. */
  runGit(cwd: string, args: string[]): Promise<string>;
  /** Returns null when the file does not exist. */
  readText(file: string): Promise<string | null>;
  env: NodeJS.ProcessEnv;
  homeDir: string;
};

const FORGE_REQUESTS: readonly ForgeRequest[] = ["auto", "github", "gitlab"];
const UPSTREAM_DEFAULT = "using GitHub (upstream default)";
const URL_REMOTE = /^([a-z][a-z0-9+.-]*):\/\//i;
const NETWORK_SCHEMES = new Set(["ssh", "git+ssh", "ssh+git", "https", "http", "git"]);
const SCP_REMOTE = /^(?:[^@/]+@)?(\[[^\]/]+\]|[^:/[\]]+):(?!\/\/)/;

export function parseForgeRequest(value: unknown, label: string): ForgeRequest | undefined {
  if (value === undefined) return undefined;
  if (!FORGE_REQUESTS.includes(value as ForgeRequest)) {
    throw new Error(`${label} must be auto, github, or gitlab`);
  }
  return value as ForgeRequest;
}

/**
 * The network host of a Git remote.
 *
 * Accepts scp-like `[user@]host:path` and `ssh://`, `git+ssh://`, `https://`, `http://`, and
 * `git://` URLs. Local paths, `file://` URLs, and other schemes have no network host.
 */
export function parseRemoteHost(remoteUrl: string): RemoteHost | null {
  const value = remoteUrl.trim();
  const scheme = URL_REMOTE.exec(value)?.[1];
  if (scheme !== undefined) return urlRemoteHost(value, scheme.toLowerCase());
  const host = SCP_REMOTE.exec(value)?.[1];
  return host === undefined ? null : { host: bareHost(host), port: null };
}

function urlRemoteHost(value: string, scheme: string): RemoteHost | null {
  if (!NETWORK_SCHEMES.has(scheme)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hostname.length === 0) return null;
  return { host: bareHost(url.hostname), port: url.port === "" ? null : Number(url.port) };
}

function bareHost(host: string): string {
  return host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

/** Removes `user[:password]@` from URL-style remotes. Scp-like remotes cannot carry a password. */
export function redactRemoteUrl(remoteUrl: string): string {
  return remoteUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");
}

/** The hostname of a hosts key, `api_host`, or `GITLAB_HOST` value, ignoring any scheme and port. */
function hostnameOf(value: string): string {
  const trimmed = value.trim();
  if (URL_REMOTE.test(trimmed)) return parseRemoteHost(trimmed)?.host ?? "";
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(trimmed);
  if (bracketed?.[1] !== undefined) return bracketed[1].toLowerCase();
  return trimmed.replace(/:\d+$/, "").toLowerCase();
}

type YamlLine = { indent: number; key: string; value: string };

/** One `key: value` line of block YAML, or undefined for blank, comment, and other lines. */
function yamlLine(line: string): YamlLine | undefined {
  const indent = line.length - line.trimStart().length;
  const body = line.trim();
  if (body.length === 0 || body.startsWith("#")) return undefined;
  const match = /^(?:"([^"]*)"|'([^']*)'|([^\s#"'].*?))\s*:(?:\s+(.*))?$/.exec(body);
  const key = match?.[1] ?? match?.[2] ?? match?.[3];
  if (key === undefined) return undefined;
  return { indent, key, value: yamlScalar(match?.[4] ?? "") };
}

function yamlScalar(value: string): string {
  const text = value.replace(/\s+#.*$/, "").trim();
  const quoted = /^(["'])(.*)\1$/.exec(text);
  return quoted?.[2] ?? text;
}

/** Top-level host keys of a gh `hosts.yml`. No value is kept. */
export function parseGhHostsYaml(text: string): string[] {
  const hosts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = yamlLine(line);
    if (parsed?.indent === 0) hosts.push(parsed.key);
  }
  return hosts;
}

/** Entries under `hosts:` in a glab `config.yml`, keeping only the key, `api_host`, and `ssh_host`. */
export function parseGlabHostsYaml(text: string): GlabHostEntry[] {
  const entries: GlabHostEntry[] = [];
  let inHosts = false;
  let hostIndent: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    const parsed = yamlLine(line);
    if (parsed === undefined) continue;
    if (parsed.indent === 0) {
      inHosts = parsed.key === "hosts" && parsed.value.length === 0;
      hostIndent = undefined;
      continue;
    }
    if (!inHosts) continue;
    hostIndent ??= parsed.indent;
    if (parsed.indent === hostIndent) entries.push({ key: parsed.key });
    else if (parsed.indent > hostIndent) addGlabHostValue(entries.at(-1), parsed);
  }
  return entries;
}

function addGlabHostValue(entry: GlabHostEntry | undefined, line: YamlLine): void {
  if (entry === undefined || line.value.length === 0) return;
  if (line.key === "api_host") entry.apiHost = line.value;
  if (line.key === "ssh_host") entry.sshHost = line.value;
}

function resolution(
  requested: ForgeRequest,
  forge: Forge,
  host: string | null,
  remoteUrl: string | null,
  reason: string,
): ForgeResolution {
  return { schema: FORGE_RESOLUTION_SCHEMA, requested, forge, host, remoteUrl, reason };
}

type GitLabMatch = { host: string; reason: string };

function glabEntryMatch(entry: GlabHostEntry, host: string): GitLabMatch | undefined {
  if (hostnameOf(entry.key) === host) return { host: entry.key, reason: `glab host ${entry.key}` };
  if (entry.apiHost !== undefined && hostnameOf(entry.apiHost) === host) {
    return { host: entry.key, reason: `glab api_host ${entry.apiHost} of ${entry.key}` };
  }
  if (entry.sshHost !== undefined && hostnameOf(entry.sshHost) === host) {
    return { host: entry.key, reason: `glab ssh_host ${entry.sshHost} of ${entry.key}` };
  }
  return undefined;
}

function gitlabMatch(facts: ForgeFacts, host: string): GitLabMatch | undefined {
  for (const entry of facts.glabHosts) {
    const match = glabEntryMatch(entry, host);
    if (match !== undefined) return match;
  }
  if (facts.gitlabHostEnv === null) return undefined;
  const envHost = hostnameOf(facts.gitlabHostEnv);
  return envHost === host ? { host: envHost, reason: `GITLAB_HOST ${envHost}` } : undefined;
}

/**
 * Chooses the forge from collected facts. Hostnames compare case-insensitively and ports are
 * ignored, because a hosts-file port names a web port and says nothing about the remote's SSH port.
 */
export function detectForge(requested: ForgeRequest, facts: ForgeFacts): ForgeResolution {
  if (requested !== "auto") return resolution(requested, requested, null, null, "explicit input");
  if (facts.remoteUrl === null) {
    return resolution(requested, "github", null, null, `no Git remote; ${UPSTREAM_DEFAULT}`);
  }
  const remote = parseRemoteHost(facts.remoteUrl);
  if (remote === null) {
    const reason = `remote has no network host (local path or file URL); ${UPSTREAM_DEFAULT}`;
    return resolution(requested, "github", null, facts.remoteUrl, reason);
  }
  return detectRemoteForge(facts, remote.host, facts.remoteUrl);
}

function detectRemoteForge(facts: ForgeFacts, host: string, remoteUrl: string): ForgeResolution {
  if (host === "github.com")
    return resolution("auto", "github", host, remoteUrl, `remote host ${host}`);
  if (host === "gitlab.com")
    return resolution("auto", "gitlab", host, remoteUrl, `remote host ${host}`);
  const gh = facts.ghHosts.some((entry) => hostnameOf(entry) === host);
  const gitlab = gitlabMatch(facts, host);
  if (gh && gitlab !== undefined) {
    const reason = `remote host ${host} is configured for both gh and glab (${gitlab.reason}); using GitHub. Set forge explicitly to use GitLab.`;
    return resolution("auto", "github", host, remoteUrl, reason);
  }
  if (gitlab !== undefined)
    return resolution("auto", "gitlab", gitlab.host, remoteUrl, gitlab.reason);
  if (gh) return resolution("auto", "github", host, remoteUrl, `gh host ${host}`);
  const reason = `unknown host ${host}; ${UPSTREAM_DEFAULT}`;
  return resolution("auto", "github", host, remoteUrl, reason);
}

export function defaultForgeIo(): ForgeIo {
  return {
    runGit: async (cwd, args) => {
      const result = await execFileAsync("git", args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 2_000_000,
        timeout: 30_000,
      });
      return result.stdout.trim();
    },
    readText: async (file) => {
      try {
        return await fs.readFile(file, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
      }
    },
    env: process.env,
    homeDir: os.homedir(),
  };
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

/** The gh hosts file, chosen in gh's own order: `GH_CONFIG_DIR`, then `XDG_CONFIG_HOME`, then home. */
export function ghHostsFile(io: Pick<ForgeIo, "env" | "homeDir">): string {
  const configDir = envValue(io.env, "GH_CONFIG_DIR");
  if (configDir !== undefined) return path.join(configDir, "hosts.yml");
  const xdg = envValue(io.env, "XDG_CONFIG_HOME");
  if (xdg !== undefined) return path.join(xdg, "gh", "hosts.yml");
  return path.join(io.homeDir, ".config", "gh", "hosts.yml");
}

/** Candidate glab config files in order. The first one that exists is used. */
export function glabConfigFiles(io: Pick<ForgeIo, "env" | "homeDir">): string[] {
  const configDir = envValue(io.env, "GLAB_CONFIG_DIR");
  const xdg = envValue(io.env, "XDG_CONFIG_HOME");
  return [
    ...(configDir === undefined ? [] : [path.join(configDir, "config.yml")]),
    path.join(io.homeDir, ".config", "glab-cli", "config.yml"),
    ...(xdg === undefined ? [] : [path.join(xdg, "glab-cli", "config.yml")]),
  ];
}

async function firstExistingText(io: ForgeIo, files: readonly string[]): Promise<string | null> {
  for (const file of files) {
    const text = await io.readText(file);
    if (text !== null) return text;
  }
  return null;
}

async function readRemoteUrl(cwd: string, io: ForgeIo): Promise<string | null> {
  let remoteUrl: string;
  try {
    remoteUrl = await io.runGit(cwd, ["remote", "get-url", "origin"]);
  } catch {
    const first = (await io.runGit(cwd, ["remote"]))
      .split(/\r?\n/)
      .map((name) => name.trim())
      .find((name) => name.length > 0);
    if (first === undefined) return null;
    remoteUrl = await io.runGit(cwd, ["remote", "get-url", first]);
  }
  return remoteUrl.length === 0 ? null : redactRemoteUrl(remoteUrl);
}

const NO_FACTS: ForgeFacts = { remoteUrl: null, ghHosts: [], glabHosts: [], gitlabHostEnv: null };

/**
 * Reads the remote of `origin`, else of the first remote, then the gh and glab host files.
 * Host files are read only when a remote exists, because without one detection is fixed.
 */
export async function readForgeFacts(cwd: string, io: ForgeIo): Promise<ForgeFacts> {
  const remoteUrl = await readRemoteUrl(cwd, io);
  if (remoteUrl === null) return NO_FACTS;
  const ghText = await io.readText(ghHostsFile(io));
  const glabText = await firstExistingText(io, glabConfigFiles(io));
  return {
    remoteUrl,
    ghHosts: ghText === null ? [] : parseGhHostsYaml(ghText),
    glabHosts: glabText === null ? [] : parseGlabHostsYaml(glabText),
    gitlabHostEnv: envValue(io.env, "GITLAB_HOST") ?? null,
  };
}

/**
 * Resolves the requested forge for a working directory. An explicit request does no IO. Any IO
 * failure becomes a GitHub resolution that records the error.
 */
export async function resolveForge(
  requested: ForgeRequest,
  cwd: string,
  io?: ForgeIo,
): Promise<ForgeResolution> {
  if (requested !== "auto") return detectForge(requested, NO_FACTS);
  try {
    return detectForge(requested, await readForgeFacts(cwd, io ?? defaultForgeIo()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = `could not read the Git remote or forge host files (${message}); ${UPSTREAM_DEFAULT}`;
    return resolution(requested, "github", null, null, reason);
  }
}

const RESOLUTION_FIELDS: Record<keyof ForgeResolution, true> = {
  schema: true,
  requested: true,
  forge: true,
  host: true,
  remoteUrl: true,
  reason: true,
};

function nullableString(value: unknown, label: string): string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${label} must be a string or null`);
  }
  return value;
}

/** Strict reader for the recorded `resolveForge` step output. */
export function parseForgeResolution(value: unknown): ForgeResolution {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("forge resolution must be an object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !Object.hasOwn(RESOLUTION_FIELDS, key));
  if (unknown.length > 0)
    throw new Error(`forge resolution has unknown keys: ${unknown.join(", ")}`);
  if (record.schema !== FORGE_RESOLUTION_SCHEMA) {
    throw new Error(`forge resolution schema must be ${FORGE_RESOLUTION_SCHEMA}`);
  }
  const requested = parseForgeRequest(record.requested, "forge resolution requested");
  if (requested === undefined) throw new Error("forge resolution requested is required");
  if (record.forge !== "github" && record.forge !== "gitlab") {
    throw new Error("forge resolution forge must be github or gitlab");
  }
  if (typeof record.reason !== "string" || record.reason.length === 0) {
    throw new Error("forge resolution reason must be a non-empty string");
  }
  return resolution(
    requested,
    record.forge,
    nullableString(record.host, "forge resolution host"),
    nullableString(record.remoteUrl, "forge resolution remoteUrl"),
    record.reason,
  );
}

export type GitLabMergeRequest = {
  /** The exact input. */
  url: string;
  /** May include `:port`. */
  host: string;
  /** For example `group/sub/project`. */
  projectPath: string;
  iid: number;
  /** `https://<host>/<projectPath>`. */
  projectUrl: string;
  /** `encodeURIComponent(projectPath)`, for `projects/<apiProject>/...` REST paths. */
  apiProject: string;
};

const MERGE_REQUEST_URL =
  /^https:\/\/([A-Za-z0-9.-]+(?::[0-9]+)?)\/([^?#]+)\/-\/merge_requests\/([1-9][0-9]*)$/;
const PROJECT_SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

function validProjectPath(projectPath: string): boolean {
  const segments = projectPath.split("/");
  return (
    segments.length >= 2 &&
    segments.every((segment) => PROJECT_SEGMENT.test(segment) && !/^\.+$/.test(segment))
  );
}

/**
 * Parses exactly `https://<host>/<project path>/-/merge_requests/<iid>`. The project path has at
 * least two segments of `[A-Za-z0-9_.-]` that do not start with `-` and are not only dots. The iid is
 * positive without a leading zero. A query, fragment, or trailing segment is rejected.
 */
export function parseGitLabMergeRequestUrl(value: unknown, label: string): GitLabMergeRequest {
  const match = typeof value === "string" ? MERGE_REQUEST_URL.exec(value) : null;
  const host = match?.[1];
  const projectPath = match?.[2];
  const iid = Number(match?.[3]);
  if (
    host === undefined ||
    projectPath === undefined ||
    !validProjectPath(projectPath) ||
    !Number.isSafeInteger(iid)
  ) {
    throw new Error(
      `${label} must be a GitLab merge request URL https://<host>/<project path>/-/merge_requests/<iid>`,
    );
  }
  return {
    url: value as string,
    host,
    projectPath,
    iid,
    projectUrl: `https://${host}/${projectPath}`,
    apiProject: encodeURIComponent(projectPath),
  };
}
