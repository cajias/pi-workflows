import type { CommandBatchItem } from "../workflows/command-batch.js";
import {
  AUTOIMPLEMENT_BATCH_MAX_OUTPUT_CHARS,
  CI_WATCH_TIMEOUT_MS,
  gitlabCiWatchArgs,
  type PublishedRepositories,
  type PublishedRepository,
} from "./autoimplement-command-batches.js";
import { parseGitLabMergeRequestUrl, type Forge } from "./autoimplement-forge.js";

/**
 * Forge wording for Autoimplement prompts.
 *
 * The GitHub sentences are the upstream prompt lines, copied verbatim, so the default GitHub path
 * stays byte-identical. GitLab sentences are complete sentences of their own: substituting single
 * words into a GitHub sentence would change articles and phrasing. A line that both forges use is
 * one shared constant. Only prompt bodies vary by forge, because `statusDetail` and
 * `expectedOutput` are static parts of the definition.
 */

/** Nouns for lines that interpolate the forge's request name. */
export type ForgeTerms = {
  request: "pull request" | "merge request";
  requests: "pull requests" | "merge requests";
  short: "PR" | "MR";
  shortPlural: "PRs" | "MRs";
  cli: "gh" | "glab";
};

/** Complete prompt sentences, keyed by the node that uses them. */
export type ForgeText = {
  /** `implement`: what to inspect before the first edit. */
  implementInspect: string;
  /** `finalizeDefaultBranch`: never request a merge of the default branch into itself. */
  defaultBranchNoSelfRequest: string;
  /** `publish`: the lines before the requested base branch. */
  publish: { early: readonly string[] };
  /** `verifyP2`: every rule line. */
  verifyP2: readonly string[];
  /** `inspectComments`: the lines before the published repositories. */
  inspectComments: readonly string[];
  /** `inspectCi`: the lines before the published repositories. */
  inspectCi: (published: PublishedRepositories) => readonly string[];
  /** `repairCiCommand`: the lines before the failed batch. */
  repairCi: readonly string[];
  /** `assessTrackedCi`: the lines before the inspection and tracking results. */
  assessTrackedCi: readonly string[];
  /** `finalizeDelivery`: the lines before the published repositories. */
  finalizeDelivery: (merge: boolean) => readonly string[];
  /** `completedSummary` and `blockedSummary`: what the summary includes. */
  summaryResults: string;
  /** `prepareCompleted`: the CI reason for direct default-branch work. */
  defaultBranchCiReason: string;
  /** `decide`: lines after the merge setting. */
  decide: readonly string[];
};

const GITHUB_TERMS: ForgeTerms = {
  request: "pull request",
  requests: "pull requests",
  short: "PR",
  shortPlural: "PRs",
  cli: "gh",
};

const GITLAB_TERMS: ForgeTerms = {
  request: "merge request",
  requests: "merge requests",
  short: "MR",
  shortPlural: "MRs",
  cli: "glab",
};

export function forgeTerms(forge: Forge): ForgeTerms {
  return forge === "gitlab" ? GITLAB_TERMS : GITHUB_TERMS;
}

const PUBLISH_BEFORE_REVIEW = "Commit and push the verified implementation before review.";
const PUBLISH_DEPENDENCY_FINGERPRINT =
  "Include dependencyFingerprint only when a declared dependency result is relevant to review reuse.";
const P2_VERIFY = "Run focused verification for the P2 changes and push the verified result.";
const P2_HEADS =
  "Inspect the local and remote heads first. Do not push again when the verified head is already remote.";
const P2_NO_REVIEW =
  "Do not run pi-reviewer again because the previous round had no P0 or P1 findings.";
const REPORT_COMMANDS = "Report exact commands and outcomes.";
const CI_ROUTES = "Choose green, failed, pending, or unavailable for each target.";
const CI_FAILURES =
  "Separate failures caused by this change from unrelated failures. Do not invent an ETA.";
const CI_REPAIR_FAILED =
  "One or more supported CI watch commands failed or returned truncated output.";
const CI_REPAIR_RETRY =
  "Choose retry only when the same validated commands can now provide useful status. Choose blocked otherwise.";
const CI_ASSESS_NO_WAIT = "Assess every CI watch result without starting another wait.";
const CI_ASSESS_PENDING =
  "A timed-out watch normally remains pending. Separate related from unrelated failures. Do not invent an ETA.";
const DELIVERY_BLOCKED =
  "Return blocked instead of claiming completion when a required merge or report action fails.";

const GITHUB_INSPECT_CI = [
  "Inspect every published pull request once without waiting for completion.",
  "Return one target per repository and current PR head.",
  CI_ROUTES,
  "When pending, provide an exact supported gh pr checks --watch or gh run watch command with the repository id, absolute repository cwd, timeoutMs at most 300000, and maxOutputChars at most 1000000. The workflow binds it to the target PR before execution.",
  CI_FAILURES,
] as const;

const GITHUB_DELIVERY_RULES = [
  "Before each mutation, inspect the current PR head, merge state, and existing final report. Do not merge an already merged expected head or post a duplicate report.",
  "Use each repository's required merge method.",
  "Post a final report with the implementation summary and exact validation commands on every PR only when that report is missing.",
  "Keep the existing top-level merged, pr, reportComment, and reason fields. For several PRs, use the first PR for the top-level compatibility fields and include every result under repositories.",
  DELIVERY_BLOCKED,
] as const;

const GITHUB_TEXT: ForgeText = {
  implementInspect:
    "Before changing files, inspect the current worktree, diff, commits, branch, remote state, and matching pull request. Continue existing work and do not repeat completed effects.",
  defaultBranchNoSelfRequest: "Never open a pull request from the default branch to itself.",
  publish: {
    early: [
      PUBLISH_BEFORE_REVIEW,
      "Inspect the branch, local and remote heads, and matching pull requests first. Do not push an already-pushed head or create a second pull request for the same branch and base.",
      "Use the existing implementation-plan PR when one exists. Otherwise open a PR and use the pr-description skill for its body.",
      "Inspect the complete public diff before every push or PR mutation.",
      "Report every repository that received a pushed pull request with its absolute repository path, branch, base branch, pushed head revision, and PR URL.",
      PUBLISH_DEPENDENCY_FINGERPRINT,
    ],
  },
  verifyP2: [
    P2_VERIFY,
    P2_HEADS,
    P2_NO_REVIEW,
    "Re-observe every published PR after the push and return its current repository, branch, base branch, head revision, PR URL, pushed status, and unchanged dependency fingerprint.",
    REPORT_COMMANDS,
  ],
  inspectComments: [
    "Inspect current inline review comments and PR issue comments for every published pull request.",
    "Handle pull requests one at a time. Reply to and resolve every comment. Ignore stale or irrelevant comments only after explaining why.",
    "Choose redesign for a valid design issue, fix for a local code issue, ci when no actionable comment remains on any PR, or blocked for an external blocker.",
  ],
  inspectCi: () => GITHUB_INSPECT_CI,
  repairCi: [
    CI_REPAIR_FAILED,
    "Diagnose and fix only local gh prerequisites or authentication that are already authorized.",
    "Do not change the PR identity or substitute another command form.",
    CI_REPAIR_RETRY,
  ],
  assessTrackedCi: [
    CI_ASSESS_NO_WAIT,
    "Return one target result for every watched PR and an aggregate route of green, failed, pending, or unavailable.",
    CI_ASSESS_PENDING,
  ],
  finalizeDelivery: (merge) => [
    merge
      ? "Handle verified PRs one at a time and merge each unless repository policy or explicit user instructions prohibit it."
      : "Leave every verified PR ready without merging because current workflow settings disable merge.",
    ...GITHUB_DELIVERY_RULES,
  ],
  summaryResults:
    "Include the work completed, exact validation commands, review findings, CI, PR or merge results, and remaining limitations.",
  defaultBranchCiReason: "Direct default-branch work has no pull request.",
  decide: [],
};

/** Tells the model where the placeholders of the GitLab REST calls come from. */
const GITLAB_COORDINATES_RULE =
  "Take <hostname>, <apiProject>, <iid>, and <projectUrl> for each merge request from the GitLab API coordinates line.";

const GITLAB_INSPECT_CI = [
  "Inspect every published merge request once without waiting for completion.",
  "Return one target per repository and current MR head.",
  CI_ROUTES,
  "Read each merge request with glab api --hostname <hostname> projects/<apiProject>/merge_requests/<iid> and use its head_pipeline id, status, and sha. For a failed pipeline, list its jobs with glab api --hostname <hostname> projects/<apiProject>/pipelines/<pipelineId>/jobs and read a failed job log with glab api --hostname <hostname> projects/<apiProject>/jobs/<jobId>/trace.",
  "When pending, set trackingCommand to exactly the canonical glab tracking command listed for that target. The workflow accepts only glab ci status with --live or --wait, the published source branch, and the merge request project, with timeoutMs at most 300000 and maxOutputChars at most 1000000.",
  "The expected-output example shows both command forms. On this GitLab run use only the glab form.",
  CI_FAILURES,
  GITLAB_COORDINATES_RULE,
] as const;

const GITLAB_MERGE_RULES = [
  "Use each project's required merge method. Read merge_method and squash_option with glab api --hostname <hostname> projects/<apiProject>, and add --squash when squash_option is always or default_on.",
  "Merge with glab mr merge <iid> --repo <projectUrl> --sha <headRevision> --auto-merge=false --yes, where <headRevision> is the published head revision of that merge request.",
  "Report merged true only after a fresh read of the merge request shows state merged. glab also exits 0 when it only arms auto-merge or leaves the merge request open, and neither counts as merged.",
] as const;

const GITLAB_DELIVERY_RULES = [
  "Post a final report with the implementation summary and exact validation commands on every MR only when that report is missing, with glab api --hostname <hostname> --method POST projects/<apiProject>/merge_requests/<iid>/notes -f body=<report>. Report reportComment as the MR URL followed by #note_<note id>.",
  "Keep the existing top-level merged, pr, reportComment, and reason fields, and set pr to the MR URL. For several MRs, use the first MR for the top-level compatibility fields and include every result under repositories.",
  DELIVERY_BLOCKED,
  GITLAB_COORDINATES_RULE,
] as const;

const GITLAB_TEXT: ForgeText = {
  implementInspect:
    "Before changing files, inspect the current worktree, diff, commits, branch, remote state, and matching merge request. Continue existing work and do not repeat completed effects.",
  defaultBranchNoSelfRequest: "Never open a merge request from the default branch to itself.",
  publish: {
    early: [
      PUBLISH_BEFORE_REVIEW,
      "Inspect the branch, local and remote heads, and matching merge requests first. Do not push an already-pushed head or create a second merge request for the same source and target branch.",
      'Look up an open merge request for this source and target branch with glab api --hostname <hostname> "projects/<apiProject>/merge_requests?state=opened&source_branch=<branch>&target_branch=<base>". <hostname> is the host in the forge resolution, or the glab host of the work repository\'s Git remote when that is null. <apiProject> is the URL-encoded project path, such as group%2Fsub%2Fproject.',
      "Reuse that merge request when one exists, and update a stale description with glab mr update <iid> --description <description> --yes. Otherwise run glab in the prepared workspace to create one with glab mr create --source-branch <branch> --target-branch <base> --title <title> --description <description> --yes.",
      "Write the merge request description yourself: what changed and why, how it was verified with exact commands, risks, and follow-ups.",
      "Inspect the complete public diff before every push or MR mutation.",
      "Report every repository that received a pushed merge request with its absolute repository path, branch, base branch, pushed head revision, and the MR web URL https://<hostname>/<project path>/-/merge_requests/<iid> as pr.",
      PUBLISH_DEPENDENCY_FINGERPRINT,
    ],
  },
  verifyP2: [
    P2_VERIFY,
    P2_HEADS,
    P2_NO_REVIEW,
    "Re-observe every published merge request after the push with glab api --hostname <hostname> projects/<apiProject>/merge_requests/<iid>, and return its current repository, branch, base branch, head revision, MR URL as pr, pushed status, and unchanged dependency fingerprint.",
    REPORT_COMMANDS,
    GITLAB_COORDINATES_RULE,
  ],
  inspectComments: [
    "Inspect the current discussions, including inline diff discussions and general comments, of every published merge request.",
    "List them with glab api --hostname <hostname> --paginate projects/<apiProject>/merge_requests/<iid>/discussions, and ignore notes with system true.",
    "Handle merge requests one at a time. Reply to and resolve every discussion. Ignore stale or irrelevant comments only after explaining why.",
    "Reply with glab api --hostname <hostname> --method POST projects/<apiProject>/merge_requests/<iid>/discussions/<discussionId>/notes -f body=<reply>.",
    "Resolve every resolvable discussion with glab api --hostname <hostname> --method PUT projects/<apiProject>/merge_requests/<iid>/discussions/<discussionId> -F resolved=true.",
    "Choose redesign for a valid design issue, fix for a local code issue, ci when no actionable comment remains on any MR, or blocked for an external blocker.",
    GITLAB_COORDINATES_RULE,
  ],
  inspectCi: (published) => [
    ...GITLAB_INSPECT_CI,
    `Canonical glab tracking commands: ${JSON.stringify(published.repositories.map(gitlabTrackingCommand))}`,
  ],
  repairCi: [
    CI_REPAIR_FAILED,
    "Diagnose and fix only local glab prerequisites or authentication that are already authorized.",
    "Do not change the MR identity or substitute another command form.",
    CI_REPAIR_RETRY,
  ],
  assessTrackedCi: [
    CI_ASSESS_NO_WAIT,
    "Return one target result for every watched MR and an aggregate route of green, failed, pending, or unavailable.",
    CI_ASSESS_PENDING,
    "glab ci status exits 0 for canceled, skipped, and manual pipelines, so judge each pipeline by the status in its watch output, not by the exit code.",
  ],
  finalizeDelivery: (merge) => [
    merge
      ? "Handle verified MRs one at a time and merge each unless repository policy or explicit user instructions prohibit it."
      : "Leave every verified MR ready without merging because current workflow settings disable merge.",
    "Before each mutation, inspect the current MR head, merge state, and existing final report with glab api --hostname <hostname> projects/<apiProject>/merge_requests/<iid> and its notes. Do not merge an already merged expected head or post a duplicate report.",
    ...(merge ? GITLAB_MERGE_RULES : []),
    ...GITLAB_DELIVERY_RULES,
  ],
  summaryResults:
    "Include the work completed, exact validation commands, review findings, CI, MR or merge results, and remaining limitations.",
  defaultBranchCiReason: "Direct default-branch work has no merge request.",
  decide: ["Forge: gitlab. Publication uses one GitLab merge request through glab."],
};

export function forgeText(forge: Forge): ForgeText {
  return forge === "gitlab" ? GITLAB_TEXT : GITHUB_TEXT;
}

function mergeRequestOf(repository: PublishedRepository) {
  return parseGitLabMergeRequestUrl(repository.pr, `published repository ${repository.id} pr`);
}

/** The watch the CI binding normalizes every accepted GitLab tracking command to. */
function gitlabTrackingCommand(repository: PublishedRepository): CommandBatchItem {
  return {
    id: repository.id,
    command: "glab",
    args: gitlabCiWatchArgs(repository.branch, mergeRequestOf(repository).projectUrl),
    cwd: repository.repository,
    timeoutMs: CI_WATCH_TIMEOUT_MS,
    maxOutputChars: AUTOIMPLEMENT_BATCH_MAX_OUTPUT_CHARS,
  };
}

/**
 * GitLab REST coordinates for every published repository, derived from its merge request URL:
 * the `--hostname` value, the encoded project for `projects/<apiProject>/...`, and the iid.
 */
export function gitlabApiCoordinates(published: PublishedRepositories): string {
  const coordinates = published.repositories.map((repository) => {
    const mergeRequest = mergeRequestOf(repository);
    return {
      id: repository.id,
      repository: repository.repository,
      pr: repository.pr,
      hostname: mergeRequest.host,
      apiProject: mergeRequest.apiProject,
      iid: mergeRequest.iid,
      projectUrl: mergeRequest.projectUrl,
    };
  });
  return `GitLab API coordinates: ${JSON.stringify(coordinates)}`;
}
