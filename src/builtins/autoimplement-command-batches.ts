import { createHash } from "node:crypto";
import path from "node:path";
import { MAX_COMMAND_BATCH_ITEMS, type CommandBatchItem } from "../workflows/command-batch.js";
import { isFullCommitId, parseGitLabMergeRequestUrl } from "./autoimplement-forge.js";

export const REVIEW_TIMEOUT_MS = 10 * 60_000;
export const CI_WATCH_TIMEOUT_MS = 5 * 60_000;
export const AUTOIMPLEMENT_BATCH_MAX_OUTPUT_CHARS = 1_000_000;
export const AUTOIMPLEMENT_MAX_CONCURRENCY = 8;

export type AutoimplementConcurrency = {
  reviewer: number;
  ciWatch: number;
  verification: number;
};

/** One repository head that review can run against: a pushed publication or a local commit. */
export type CandidateRepository = {
  id: string;
  repository: string;
  branch: string;
  baseBranch: string;
  headRevision: string;
  dependencyFingerprint?: string;
};

export type PublishedRepository = CandidateRepository & { pr: string };

export type PublishedRepositories = {
  repositories: PublishedRepository[];
};

/** Heads committed locally and never pushed, as `commitLocal` and `verifyP2Local` report them. */
export type LocalCommitRepositories = {
  repositories: CandidateRepository[];
};

/**
 * The merge request's `head_pipeline` as a GitLab CI target reports it. `parentIds` holds the
 * `parent_ids` of the pipeline commit for a merged results or merge train pipeline.
 */
export type GitLabHeadPipeline = { sha: string; status: string; ref: string; parentIds?: string[] };

export type CiTargetInspection = {
  id: string;
  repository: string;
  headRevision: string;
  pr: string;
  route: "green" | "failed" | "pending" | "unavailable";
  reason: string;
  relatedFailures: string[];
  unrelatedFailures: string[];
  trackingCommand?: CommandBatchItem;
  /** GitLab only: the merge request's head pipeline, or null when it has none. */
  headPipeline?: GitLabHeadPipeline | null;
};

export type CiInspectionBatch = {
  route: "green" | "failed" | "pending" | "unavailable";
  reason: string;
  relatedFailures: string[];
  unrelatedFailures: string[];
  targets: CiTargetInspection[];
};

/** How a pending CI watch is bound to its target. GitLab watches also bind the published branch. */
export type CiForgeBinding = { forge: "github" } | { forge: "gitlab"; branch: string };
export const GITHUB_CI_BINDING: CiForgeBinding = { forge: "github" };

export function parseAutoimplementConcurrency(value: unknown): AutoimplementConcurrency {
  if (value === undefined) return { reviewer: 4, ciWatch: 4, verification: 2 };
  const input = requireRecord(value, "autoimplement concurrency");
  for (const key of Object.keys(input)) {
    if (key !== "reviewer" && key !== "ciWatch" && key !== "verification") {
      throw new Error(`autoimplement concurrency.${key} is not supported`);
    }
  }
  return {
    reviewer: concurrencyValue(input.reviewer ?? 4, "reviewer"),
    ciWatch: concurrencyValue(input.ciWatch ?? 4, "ciWatch"),
    verification: concurrencyValue(input.verification ?? 2, "verification"),
  };
}

/** The labels and the per-kind fields of one repository-record list. */
type RepositoryRecordKind<TExtra> = {
  /** Names the whole result, such as `publication result`. */
  result: string;
  /** Names one entry, such as `publication repositories`. */
  entries: string;
  /** Names a duplicated entry, such as `publication repository`. */
  entry: string;
  /** The boolean field every entry must set to true. */
  flag: "pushed" | "committed";
  /** Reads the fields that only this kind of record has. */
  extra: (raw: Record<string, unknown>, label: string) => TExtra;
};

function parseRepositoryRecords<TExtra extends object>(
  value: unknown,
  kind: RepositoryRecordKind<TExtra>,
): Array<CandidateRepository & TExtra> {
  const result = requireRecord(value, kind.result);
  if (!Array.isArray(result.repositories) || result.repositories.length === 0) {
    throw new Error(`${kind.result} repositories must be a non-empty array`);
  }
  if (result.repositories.length > MAX_COMMAND_BATCH_ITEMS) {
    throw new Error(
      `${kind.result} repositories must contain at most ${MAX_COMMAND_BATCH_ITEMS} entries`,
    );
  }
  const ids = new Set<string>();
  return result.repositories.map((entry, index) => {
    const label = `${kind.entries}[${index}]`;
    const raw = requireRecord(entry, label);
    const repository = requireAbsolutePath(raw.repository, `${label}.repository`);
    const id = repositoryId(repository);
    if (ids.has(id)) throw new Error(`${kind.entry} is duplicated: ${repository}`);
    ids.add(id);
    const dependencyFingerprint = optionalString(
      raw.dependencyFingerprint,
      `${label}.dependencyFingerprint`,
    );
    if (raw[kind.flag] !== true) {
      throw new Error(`${label}.${kind.flag} must be true`);
    }
    return {
      id,
      repository,
      branch: requireString(raw.branch, `${label}.branch`),
      baseBranch: requireString(raw.baseBranch, `${label}.baseBranch`),
      headRevision: requireString(raw.headRevision, `${label}.headRevision`),
      ...kind.extra(raw, label),
      ...(dependencyFingerprint !== undefined ? { dependencyFingerprint } : {}),
    };
  });
}

export function parsePublishedRepositories(value: unknown): PublishedRepositories {
  return {
    repositories: parseRepositoryRecords(value, {
      result: "publication result",
      entries: "publication repositories",
      entry: "publication repository",
      flag: "pushed",
      extra: (raw, label) => ({ pr: requireString(raw.pr, `${label}.pr`) }),
    }),
  };
}

/**
 * Reads local commit records. They follow the publication rules, but every entry sets
 * `committed: true` and names neither a pull request nor a push, because nothing is published yet.
 */
export function parseLocalCommitRepositories(value: unknown): LocalCommitRepositories {
  return {
    repositories: parseRepositoryRecords(value, {
      result: "local commit result",
      entries: "local commit repositories",
      entry: "local commit repository",
      flag: "committed",
      extra: (raw, label) => {
        if (raw.pr !== undefined) throw new Error(`${label}.pr must be absent before publication`);
        if (raw.pushed !== undefined && raw.pushed !== false) {
          throw new Error(`${label}.pushed must be false before publication`);
        }
        return {};
      },
    }),
  };
}

export function reviewerCommand(repository: CandidateRepository): CommandBatchItem {
  return {
    id: repository.id,
    command: "pi-reviewer",
    args: ["--base", repository.baseBranch],
    cwd: repository.repository,
    timeoutMs: REVIEW_TIMEOUT_MS,
    maxOutputChars: AUTOIMPLEMENT_BATCH_MAX_OUTPUT_CHARS,
  };
}

export function parseCiInspectionBatch(
  value: unknown,
  bindingFor: (id: string) => CiForgeBinding = () => GITHUB_CI_BINDING,
): CiInspectionBatch {
  const result = requireRecord(value, "CI inspection");
  if (!Array.isArray(result.targets) || result.targets.length === 0) {
    throw new Error("CI inspection targets must be a non-empty array");
  }
  if (result.targets.length > MAX_COMMAND_BATCH_ITEMS) {
    throw new Error(
      `CI inspection targets must contain at most ${MAX_COMMAND_BATCH_ITEMS} entries`,
    );
  }
  const ids = new Set<string>();
  const targets = result.targets.map((entry, index) => {
    const raw = requireRecord(entry, `CI targets[${index}]`);
    const repository = requireAbsolutePath(raw.repository, `CI targets[${index}].repository`);
    const id = repositoryId(repository);
    if (ids.has(id)) throw new Error(`CI target is duplicated: ${repository}`);
    ids.add(id);
    if (
      raw.route !== "green" &&
      raw.route !== "failed" &&
      raw.route !== "pending" &&
      raw.route !== "unavailable"
    ) {
      throw new Error(`CI targets[${index}].route is invalid`);
    }
    const pr = requireString(raw.pr, `CI targets[${index}].pr`);
    const target: CiTargetInspection = {
      id,
      repository,
      headRevision: requireString(raw.headRevision, `CI targets[${index}].headRevision`),
      pr,
      route: raw.route,
      reason: requireString(raw.reason, `CI targets[${index}].reason`),
      relatedFailures: stringArray(
        raw.relatedFailures ?? [],
        `CI targets[${index}].relatedFailures`,
      ),
      unrelatedFailures: stringArray(
        raw.unrelatedFailures ?? [],
        `CI targets[${index}].unrelatedFailures`,
      ),
    };
    if (raw.route === "pending") {
      target.trackingCommand = parseCiCommand(
        raw.trackingCommand,
        id,
        repository,
        pr,
        bindingFor(id),
      );
    }
    return target;
  });
  const route = targets.some((target) => target.route === "failed")
    ? "failed"
    : targets.some((target) => target.route === "pending")
      ? "pending"
      : targets.some((target) => target.route === "unavailable")
        ? "unavailable"
        : "green";
  return {
    route,
    reason: targets.map((target) => `${target.id}: ${target.reason}`).join("; "),
    relatedFailures: targets.flatMap((target) => target.relatedFailures),
    unrelatedFailures: targets.flatMap((target) => target.unrelatedFailures),
    targets,
  };
}

export function parseCiCommand(
  value: unknown,
  id: string,
  repository: string,
  pr: string,
  binding: CiForgeBinding = GITHUB_CI_BINDING,
): CommandBatchItem {
  const raw = requireRecord(value, "CI tracking command");
  if (raw.id !== id) throw new Error("CI tracking command id must match the target repository");
  return binding.forge === "gitlab"
    ? parseGitLabCiCommand(raw, id, repository, pr, binding.branch)
    : parseGitHubCiCommand(raw, id, repository, pr);
}

/** Accepts `gh pr checks [<pr>] --watch` or `gh run watch <id>` and binds it to the target PR. */
function parseGitHubCiCommand(
  raw: Record<string, unknown>,
  id: string,
  repository: string,
  pr: string,
): CommandBatchItem {
  const command = parseCommandItem(raw, "CI tracking command", {
    id,
    command: "gh",
    cwd: repository,
    maxTimeoutMs: CI_WATCH_TIMEOUT_MS,
  });
  const args = command.args;
  const prWatch =
    (args.length === 3 && args[0] === "pr" && args[1] === "checks" && args[2] === "--watch") ||
    (args.length === 4 &&
      args[0] === "pr" &&
      args[1] === "checks" &&
      args[2] === pr &&
      args[3] === "--watch");
  const runWatch =
    args.length === 3 &&
    args[0] === "run" &&
    args[1] === "watch" &&
    /^[1-9]\d*$/.test(args[2] ?? "");
  if (!prWatch && !runWatch) {
    throw new Error("CI tracking command args are not allowed for the target PR");
  }
  return { ...command, args: ["pr", "checks", pr, "--watch"] };
}

const GLAB_WATCH_FLAGS = new Set(["--live", "-l", "--wait"]);
const GLAB_VALUE_OPTIONS: ReadonlyMap<string, "branch" | "repo"> = new Map([
  ["--branch", "branch"],
  ["-b", "branch"],
  ["--repo", "repo"],
  ["-R", "repo"],
]);

type GlabCiStatusOptions = { watch?: string; branch?: string; repo?: string };
type GlabOption = { name: "branch" | "repo"; value: string | undefined };

/** A `--branch`/`-b` or `--repo`/`-R` option with a separate or `=` value, or undefined. */
function glabValueOption(token: string, tokens: Iterator<string>): GlabOption | undefined {
  const separate = GLAB_VALUE_OPTIONS.get(token);
  if (separate !== undefined) return { name: separate, value: tokens.next().value };
  const inline = /^--(branch|repo)=(.*)$/.exec(token);
  if (inline === null) return undefined;
  return { name: inline[1] as GlabOption["name"], value: inline[2] };
}

function readGlabToken(
  token: string,
  tokens: Iterator<string>,
  options: GlabCiStatusOptions,
): void {
  if (GLAB_WATCH_FLAGS.has(token)) {
    if (options.watch !== undefined) throw new Error("CI tracking command repeats the watch flag");
    options.watch = token;
    return;
  }
  const option = glabValueOption(token, tokens);
  if (option === undefined) throw new Error(`CI tracking command option is not allowed: ${token}`);
  if (options[option.name] !== undefined) {
    throw new Error(`CI tracking command repeats the ${option.name} option`);
  }
  if (option.value === undefined || option.value.length === 0) {
    throw new Error(`CI tracking command ${option.name} option needs a value`);
  }
  options[option.name] = option.value;
}

/** The options after `ci status`. Each option appears at most once and nothing else is allowed. */
function parseGlabCiStatusOptions(args: readonly string[]): GlabCiStatusOptions {
  if (args[0] !== "ci" || args[1] !== "status") {
    throw new Error("CI tracking command args must start with ci status");
  }
  const options: GlabCiStatusOptions = {};
  const tokens = args.slice(2)[Symbol.iterator]();
  for (let next = tokens.next(); next.done !== true; next = tokens.next()) {
    readGlabToken(next.value, tokens, options);
  }
  return options;
}

/**
 * Accepts only `glab ci status` with one watch flag and optional branch and repository options
 * bound to the published branch and the merge request's project. Normalizes to the live watch with
 * both values explicit, so glab never resolves a remote or prompts.
 */
function parseGitLabCiCommand(
  raw: Record<string, unknown>,
  id: string,
  repository: string,
  pr: string,
  branch: string,
): CommandBatchItem {
  const command = parseCommandItem(raw, "CI tracking command", {
    id,
    command: "glab",
    cwd: repository,
    maxTimeoutMs: CI_WATCH_TIMEOUT_MS,
  });
  const mergeRequest = parseGitLabMergeRequestUrl(pr, "CI target pr");
  const options = parseGlabCiStatusOptions(command.args);
  if (options.watch === undefined) {
    throw new Error("CI tracking command must watch with --live, -l, or --wait");
  }
  if (options.branch !== undefined && options.branch !== branch) {
    throw new Error("CI tracking command branch must be the published source branch");
  }
  const projects = [
    mergeRequest.projectUrl,
    `${mergeRequest.host}/${mergeRequest.projectPath}`,
    mergeRequest.projectPath,
  ];
  if (options.repo !== undefined && !projects.includes(options.repo)) {
    throw new Error("CI tracking command repository must be the merge request project");
  }
  return { ...command, args: gitlabCiWatchArgs(branch, mergeRequest.projectUrl) };
}

/**
 * Reads the `head_pipeline` that a GitLab CI target reports, null when the merge request has none.
 *
 * The source-branch watch follows the newest pipeline of the branch, which can belong to another
 * commit or differ from the merge request's own pipeline. So a green or failed target must name a
 * head pipeline that ran for the published head, with status `success` or `failed`. It ran for that
 * head when its sha is the head, or when it is a merged results or merge train pipeline of this
 * merge request whose commit has the head as a parent.
 */
export function parseGitLabHeadPipeline(
  value: unknown,
  route: string,
  headRevision: string,
  iid: number,
  label: string,
): GitLabHeadPipeline | null {
  if (value === undefined) {
    throw new Error(
      `${label}.headPipeline must report the merge request head_pipeline sha, status, and ref, or null when it has none`,
    );
  }
  const pipeline = value === null ? null : headPipelineRecord(value, iid, `${label}.headPipeline`);
  if (route !== "green" && route !== "failed") return pipeline;
  if (pipeline === null || !ranForHead(pipeline, headRevision, iid)) {
    throw new Error(
      `${label} can be ${route} only when the merge request head_pipeline ran for the published head ${headRevision}: its sha is that head, or its ref is ${mergedResultsRefs(iid).join(" or ")} and that head is a parent; reported ${JSON.stringify(pipeline)}`,
    );
  }
  const status = route === "green" ? "success" : "failed";
  if (pipeline.status !== status) {
    throw new Error(
      `${label} can be ${route} only when the head_pipeline status is ${status}; reported ${pipeline.status}`,
    );
  }
  return pipeline;
}

/** The refs of the merged results and merge train pipelines of one merge request. */
function mergedResultsRefs(iid: number): string[] {
  return [`refs/merge-requests/${iid}/merge`, `refs/merge-requests/${iid}/train`];
}

function ranForHead(pipeline: GitLabHeadPipeline, headRevision: string, iid: number): boolean {
  return (
    pipeline.sha === headRevision ||
    (mergedResultsRefs(iid).includes(pipeline.ref) &&
      (pipeline.parentIds?.includes(headRevision) ?? false))
  );
}

function headPipelineRecord(value: unknown, iid: number, label: string): GitLabHeadPipeline {
  const record = requireRecord(value, label);
  const ref = requireString(record.ref, `${label}.ref`);
  const parentIds =
    record.parentIds === undefined && !mergedResultsRefs(iid).includes(ref)
      ? undefined
      : commitIds(record.parentIds, `${label}.parentIds`, ref);
  return {
    sha: commitId(record.sha, `${label}.sha`),
    status: requireString(record.status, `${label}.status`),
    ref,
    ...(parentIds === undefined ? {} : { parentIds }),
  };
}

function commitId(value: unknown, label: string): string {
  const sha = requireString(value, label);
  if (!isFullCommitId(sha)) throw new Error(`${label} must be a full commit SHA: ${sha}`);
  return sha;
}

/** The `parent_ids` of a pipeline commit: required for a merged results or merge train ref. */
function commitIds(value: unknown, label: string, ref: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `${label} must list the full commit SHAs in parent_ids of the ${ref} pipeline commit`,
    );
  }
  return value.map((entry, index) => commitId(entry, `${label}[${index}]`));
}

/** The one GitLab watch form the workflow runs: a live status with the branch and project explicit. */
export function gitlabCiWatchArgs(branch: string, projectUrl: string): string[] {
  return ["ci", "status", "--live", "--branch", branch, "--repo", projectUrl];
}

export function repositoryId(repository: string): string {
  const canonical = path.resolve(repository);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function parseCommandItem(
  value: unknown,
  label: string,
  options: {
    id?: string;
    command?: string;
    cwd?: string;
    maxTimeoutMs: number;
  },
): CommandBatchItem {
  const raw = requireRecord(value, label);
  const id = options.id ?? requireString(raw.id, `${label}.id`);
  const command = options.command ?? requireString(raw.command, `${label}.command`);
  if (options.command !== undefined && raw.command !== options.command) {
    throw new Error(`${label}.command must be ${options.command}`);
  }
  if (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`${label}.args must be an array of strings`);
  }
  const cwd = options.cwd ?? requireAbsolutePath(raw.cwd, `${label}.cwd`);
  if (options.cwd !== undefined && path.resolve(String(raw.cwd)) !== options.cwd) {
    throw new Error(`${label}.cwd must match the target repository`);
  }
  const timeoutMs = positiveInteger(raw.timeoutMs, `${label}.timeoutMs`, options.maxTimeoutMs);
  const maxOutputChars = positiveInteger(
    raw.maxOutputChars ?? AUTOIMPLEMENT_BATCH_MAX_OUTPUT_CHARS,
    `${label}.maxOutputChars`,
    AUTOIMPLEMENT_BATCH_MAX_OUTPUT_CHARS,
  );
  return { id, command, args: [...raw.args] as string[], cwd, timeoutMs, maxOutputChars };
}

export const FORBIDDEN_VERIFICATION_EXECUTABLES = [
  "ash",
  "bash",
  "cmd",
  "cmd.exe",
  "csh",
  "dash",
  "fish",
  "gh",
  "git",
  "glab",
  "ksh",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "rm",
  "sh",
  "tcsh",
  "zsh",
] as const;

export const FORBIDDEN_VERIFICATION_ACTION_WORDS = [
  "publish",
  "release",
  "deploy",
  "push",
  "merge",
] as const;

const FORBIDDEN_VERIFICATION_EXECUTABLE_SET = new Set<string>(FORBIDDEN_VERIFICATION_EXECUTABLES);
const FORBIDDEN_VERIFICATION_ACTION_WORD_SET = new Set<string>(FORBIDDEN_VERIFICATION_ACTION_WORDS);

export function formatVerificationCommandSafetyRules(): string[] {
  return [
    `Executable basenames must not be any of: ${FORBIDDEN_VERIFICATION_EXECUTABLES.join(", ")}.`,
    "All Git and GitHub CLI commands are forbidden, including read-only commands.",
    "All GitLab CLI (glab) commands are forbidden, including read-only commands.",
    "Shell executables and shell wrappers are forbidden.",
    `Arguments must not contain these standalone action words: ${FORBIDDEN_VERIFICATION_ACTION_WORDS.join(", ")}.`,
  ];
}

export function validateVerificationCommandSafety(
  command: string,
  args: readonly string[],
  label: string,
): void {
  const executable = path.win32.basename(path.basename(command)).toLowerCase();
  if (FORBIDDEN_VERIFICATION_EXECUTABLE_SET.has(executable)) {
    throw new Error(`${label}.command is not allowed`);
  }
  const words =
    args
      .join(" ")
      .toLowerCase()
      .match(/[a-z]+/g) ?? [];
  if (words.some((word) => FORBIDDEN_VERIFICATION_ACTION_WORD_SET.has(word))) {
    throw new Error(`${label} contains a mutation or publication action`);
  }
}

function concurrencyValue(value: unknown, field: string): number {
  return positiveInteger(
    value,
    `autoimplement concurrency.${field}`,
    AUTOIMPLEMENT_MAX_CONCURRENCY,
  );
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}`);
  }
  return value as number;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value] as string[];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function requireAbsolutePath(value: unknown, label: string): string {
  const resolved = requireString(value, label);
  if (!path.isAbsolute(resolved)) throw new Error(`${label} must be absolute`);
  return path.resolve(resolved);
}
