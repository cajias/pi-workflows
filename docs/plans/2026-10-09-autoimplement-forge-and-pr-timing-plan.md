---
title: Select the code forge and publication timing in Autoimplement
author: Raul Cajias <cajias@amazon.de>
date: 2026-10-09
status: proposed
---

# Select the code forge and publication timing in Autoimplement

## Summary

The built-in `autoimplement` workflow gains two inputs.

- `forge` (`auto`, `github`, or `gitlab`) chooses the code forge. The default is `auto`. It reads the
  host of the work repository's Git remote, including self-managed GitLab hosts such as
  `code.aws.dev` that are configured for `glab`. GitLab support covers the whole flow through
  `glab`: create or update one merge request (MR), inspect and watch its pipeline with an
  allowlisted MR-bound `glab ci status` command, read, reply to, and resolve MR discussions, merge
  when `merge: true`, and use MR wording in every prompt.
- `prTiming` (`early` or `end`) chooses when work is published. The default is `early`, which is
  exactly today's behavior: push and open the pull request before review. With `end`, commits stay
  local through every implement, verify, pi-reviewer, and fix round. Only after the review gate
  passes does one push create the single PR or MR. CI and comment handling then run on that PR or MR,
  and later fixes push to it only after another review gate passes.

A user can set persistent defaults for both inputs in
`${PI_WORKFLOWS_CONFIG_DIR:-~/.config/pi-workflows}/autoimplement.json`. The precedence is workflow
input, then the config file, then the built-in default (`auto`, `early`).

The upstream default (`forge` resolving to `github` and `prTiming: early`) keeps every GitHub prompt
string, route list, and parser contract byte-identical. The changes visible on that path are:

- one new read-only `resolveForge` step;
- the two new fields in the normalized input and in the settings;
- the stricter verification command rule that also forbids `glab`;
- the regenerated layout fixture and catalog revisions.

The implementation is split into three sequential work packages (A, B, C). Each one has its own
files and acceptance tests.

Abbreviations: `AI` is `src/builtins/autoimplement.workflow.ts`, `CB` is
`src/builtins/autoimplement-command-batches.ts`. Line numbers refer to HEAD `2cb8ab3` (v0.17.7).

## Goals

- Detect GitHub, GitLab.com, and self-managed GitLab from the work repository's remote, and allow an
  explicit override.
- Run the complete Autoimplement flow on GitLab through `glab`, with the same safety model as GitHub:
  program-bound tracking commands, no shell wrappers, and no Git or forge CLI in verification checks.
- Offer `prTiming: end`, so that nothing is pushed and no PR or MR exists until the review gate passes,
  and then exactly one push opens or updates one PR or MR.
- Keep the upstream GitHub `early` behavior byte-identical.

Non-goals:

- Other forges, such as Bitbucket or Gitea.
- Multi-repository publication. `parsePublishedForContext` (`AI:1160-1174`) admits only the prepared
  workspace, and this plan keeps that.
- Engine changes that would make `statusDetail` or `expectedOutput` dynamic.
- Fixing the settings actor plumbing on the server (O1).
- Changing `sanity-check`, the resource-manager example, or `openai.yaml`.
- Compatibility with older alpha state. Unfinished `autoimplement` and `monitor` runs are refused on
  resume because their revisions change, and the error message tells the user to cancel and start
  again (`src/workflows/errors.ts:74-86`).

## Decisions

These are the owner's decisions. A **Refined** note marks a point where this plan had to adjust the
decision to fit the code, with evidence. Contradictions that still need an owner answer are also
listed under [Open issues](#open-issues).

1. **Persistent defaults.** The file is
   `${PI_WORKFLOWS_CONFIG_DIR:-~/.config/pi-workflows}/autoimplement.json`. It accepts the keys
   `forge` and `prTiming` and rejects unknown keys. An invalid file or value is a clear start error.
   A missing file means the built-in defaults apply. Precedence is workflow input, then config file,
   then built-in (`auto` / `early`). `parseInput` fills missing values from the file, so the stored
   normalized input is explicit and parsing it again gives the same result.
   - **Refined (dependency boundary):** `src/builtins` may import only `src/state` and
     `src/workflows` (`slophammer.yml:39-43`), so it cannot import `decisionConfigDir` from
     `src/channels/config.ts:39-41`. The config-dir resolution moves into a new
     `src/state/config-dir.ts` (`workflowsConfigDir(env)`). `decisionConfigDir` delegates to it, so
     its signature and its test (`test/decision-channel-config.test.ts:33`) stay the same.
   - **Refined (schema id):** AGENTS.md requires versioned `schema` identifiers for persisted
     structured values. `channels.json` follows that rule (`src/channels/config.ts:170-174`). The
     file therefore also requires `"schema": "pi-workflows.autoimplement-defaults.v1"`. Its other
     keys stay `forge` and `prTiming`, and both are optional.
   - **Refined (synchronous):** `parseInput` must keep throwing synchronously, because the existing
     tests use `expect(() => parseInput(...)).toThrow(...)`
     (`test/builtin-autoimplement.test.ts:410-470`). The loader therefore uses `fs.readFileSync`. It
     reads the file only when `forge` or `prTiming` is missing from the input. A fully explicit input
     never reads the file, which is also what makes a second parse idempotent.
2. **Settings.** `forge` (the requested value) and `prTiming` are added to `AutoimplementSettings`,
   `parseAutoimplementSettings`, and `workflowSettings.initial`. `forge` cannot change during the
   run. `prTiming` can change mid-run only from `end` to `early`; a change from `early` to `end` is
   rejected. Model steps cannot change `prTiming`, the same as merge.
   - `/forge` gets `read` permission only, and `validateChange` also rejects any change to it.
   - `/prTiming` gets `read: ["session", "human"]` and `replace: ["human"]`. `validateChange`
     rejects `early` to `end` for every actor.
   - **Refined (actor plumbing):** a change that comes from a Pi session never reaches settings as a
     `human` actor today. See [Open issues](#open-issues), O1. As a result `prTiming` cannot actually
     be changed through the server until that defect is fixed. Unit tests prove the rules directly
     against `applyWorkflowSettingsPatch` and through `WorkflowRunStore.changeSettings` with a
     `human` actor.
3. **Forge resolution.** A new node `resolveForge` runs before `implement`. An explicit forge does
   no IO. `auto` reads `git remote get-url origin`, falling back to the first remote. Detection is a
   pure `detectForge(...)` in the new module `src/builtins/autoimplement-forge.ts`, wrapped by a thin
   IO layer, and both are unit-tested. The output is
   `{ schema, requested, forge, host, remoteUrl, reason }`. An unknown host resolves to `github`
   (upstream behavior) and records the reason.
   - **Refined (node type):** `resolveForge` is an `action` with
     `idempotentEffect("pi-workflows.autoimplement.resolve-forge")`, not a `compute` node.
     `docs/WORKFLOWS.md:317-322` limits `compute` to pure data shaping, and `:349-361` reserves
     `idempotentEffect` for work that is safe to repeat. The detection is read-only, so a rerun after
     a runner crash is safe and the run does not park as ambiguous. Workspace inspection uses
     `manualEffect` (`workspace-preparation.workflow.ts:627-630`); that would be needlessly strict
     here.
   - **Refined (placement):** the node sits on the edge `prepare -> resolveForge -> observe`, which
     replaces `{ from: "prepare", to: "observe" }` at `AI:2172`. It does not sit after workspace
     preparation, for two reasons. First, the `workspace` include is skipped entirely when the input
     supplies `preparedWorkspace` (`initialControlRoutes`, `AI:801-811`), so "after the workspace" is
     not one point in the graph. Second, the workspace route's returns belong to the controller loop
     (`AI:203-226`). The node runs Git in `preparedWorkspace.worktreePath`, else
     `preparedWorkspace.repository`, else `request.repository`. Linked worktrees share the remote
     configuration of the common Git directory, so all three paths give the same remote. This runs
     before plan discovery, documentation, and `implement`.
   - **Refined (lookups):** `gh` hosts come from `$GH_CONFIG_DIR/hosts.yml`, then
     `$XDG_CONFIG_HOME/gh/hosts.yml`, then `~/.config/gh/hosts.yml`, which matches `gh`'s own order.
     `glab` hosts come from the first file found among `$GLAB_CONFIG_DIR/config.yml`,
     `~/.config/glab-cli/config.yml`, and `$XDG_CONFIG_HOME/glab-cli/config.yml`. Host matching
     compares hostnames only and ignores ports. A key such as `host:8443` names a web port, which
     says nothing about the SSH port of the remote.
   - **Refined (security):** `remoteUrl` is stored with any `user:password@` part removed from
     URL-style remotes, because HTTPS remotes can embed tokens. An scp-style remote keeps its user
     name, since that form cannot carry a password.
4. **Forge terms.** A `forgeTerms(forge)` helper supplies all forge-specific wording. GitHub strings
   stay byte-identical to upstream; GitLab says "merge request" or "MR", names `glab`, and speaks of
   MR discussions. The JSON key stays `pr` for both forges, and its value is the PR or MR URL. On
   GitLab the `pr` value must parse as `https://<host>/<project path>/-/merge_requests/<iid>`, checked
   by the program. On GitHub the URL is not checked. GitLab replaces the external `pr-description`
   skill reference with an equivalent instruction; GitHub keeps it.
   - **Refined (static strings):** `statusDetail` and `expectedOutput` are static strings on the node
     definition (`src/workflows/types.ts:104,143`). They are included in the definition snapshot and
     digest (`src/workflows/store.ts:5130-5146`) and copied verbatim into step contracts
     (`src/workflows/engine.ts:855-856,1337`). They cannot vary per run, so the forge wording applies
     to prompt bodies only. See O2.
   - **Refined (sentence tables):** substituting single words breaks GitHub byte identity, because
     articles change ("a PR" becomes "an MR"). The helper is therefore `forgeText(forge)`, which
     returns complete per-forge sentences. A small `forgeTerms(forge)` remains for interpolated nouns.
   - **Refined (package):** `parseGitLabMergeRequestUrl` lands in work package A, because the CI
     binding derives `--repo` from the MR URL. Work package B wires it into publish validation.
   - **Refined (host binding):** the MR URL host is not required to match the remote host. On this
     machine the remote is `git@ssh.code.aws.dev:...`, while the `glab` hosts key and web host is
     `code.aws.dev`, linked by its `ssh_host: ssh.code.aws.dev` value.
5. **CI binding.** `parseCiCommand` becomes aware of the forge.
   - On GitLab it accepts only `glab ci status` with `--live` or `--wait`, optionally `-b`/`--branch`
     set to the published source branch, and optionally `-R`/`--repo` set to the project derived from
     the MR URL.
   - It rejects everything else: another branch or repository, `api`, `mr merge`, extra arguments,
     other executables, and shell wrappers.
   - It normalizes the command to
     `["ci","status","--live","--branch",<branch>,"--repo","https://<host>/<project path>"]`, binds
     `cwd` to the target repository, and keeps the same 5-minute timeout cap.
   - The published branch reaches the binding through the CI target id: `currentPublishedRepositories`
     gives `PublishedRepository.branch`, which is passed into `parseCiInspectionBatch`.
   - `glab` is added to `FORBIDDEN_VERIFICATION_EXECUTABLES`, and the rule text now covers the GitLab
     CLI. This is a **deliberate safety tightening** for all forges, and it changes the
     change-verification planner prompt on GitHub runs too.
   - **Refined (pinned text):** the existing sentence "All Git and GitHub CLI commands are
     forbidden, including read-only commands." is pinned by `test/change-verification.test.ts:245-247`
     and stays unchanged. A separate sentence is added: "All GitLab CLI (glab) commands are
     forbidden, including read-only commands."
   - **Refined (env):** `CommandBatchItem` has no `env` field. See the investigation results and
     follow-up F1.
6. **`prTiming=end` routing.** The controller route map stays unchanged.
   - `routeVerifiedWorkspace` sends new local work to a new agent node `commitLocal` under `end`.
     That node commits locally and never pushes or opens a PR or MR, then returns through
     `publicationResult`, and the controller offers `review`.
   - `selectReviewCommands` reads the latest `publish` or `commitLocal` record.
   - A unified rule in `resultRoutes` offers `publication` instead of `comments` after a clean review
     (or a passed P2 verification) whose head has not been pushed. `routeVerifiedWorkspace` then
     routes to `publish`, which pushes once and creates or updates the single PR or MR.
   - `publicationResult` after that publish offers `comments`, `review`, `blocked`.
   - Under `end`, `verifyP2` commits locally and never pushes. `currentPublishedRepositories` uses
     the latest pushed record.
   - `defaultBranch` workspace mode ignores `prTiming`. A mid-run change from `end` to `early` works
     through the unified rule.
   - **Refined (reads):** `selectReviewCommands` reads the latest of `publish` and `commitLocal` in
     both timings. Under pure `early`, `commitLocal` never runs, so the result is identical to
     upstream. Without this, a switch from `end` to `early` after `commitLocal` would fail with "No
     output found for publish" (`AI:507-516`).
   - **Refined (`verifyP2Local`):** the local P2 verification is a separate agent node
     `verifyP2Local`, chosen by a new compute switch `routeAddressedP2` after `addressP2`. The
     static `verifyP2.expectedOutput` shows `"pushed": true` and a `pr` (`AI:1980`), which directly
     contradicts a local contract. `currentPublishedRepositories` stays
     `latestOutput(["verifyP2", "publish"])`, which already means "latest pushed record", because
     `verifyP2Local` is never listed there.
   - **Refined (route values):** `routeVerifiedWorkspace` returns one of four routes: `pullRequest`
     (upstream), `defaultBranch` (upstream), `commitLocal`, or `publishReviewed`. The
     `publicationResult` rule is keyed on `publishReviewed`, so `early` cannot reach it. A
     predicate-only rule would differ from upstream in one case under `early`: a fix that leaves the
     head unchanged after a clean review.
   - **Refined (invariant):** "every push follows a clean review of that exact head" has one
     exception, which upstream already makes. A P2-only review followed by a passing P2
     verification may push the P2-verified head without reviewing it again. The exact invariant is
     stated under [State predicates](#state-predicates).
   - **Refined (`settingsRoute`):** `routeVerifiedWorkspace` becomes a `settingsRoute()` because it
     now reads `settings.prTiming`. `src/workflows/settings.ts:185-193` and
     `engine.ts:560-675` define how such a route reruns before it settles.
7. **Tests.** The plan must cover:
   - forge detection, including the self-managed `glab` case;
   - config defaults, precedence, and an invalid file;
   - the settings change rules;
   - the CI allowlist for both forges;
   - graph-routing tests for `{github, gitlab}` x `{early, end}` with fake `gh`, `glab`, and
     `pi-reviewer` executables on `PATH`;
   - the regenerated layout fixture;
   - a decision on the catalog revision. **Decision:** bump `autoimplement` from `"14"` to `"15"` and
     `monitor` from `"13"` to `"14"`. See the investigation results.
8. **Docs.** Update `skills/autoimplement/SKILL.md` and its pinned tests, `README.md`,
   `docs/WORKFLOWS.md`, and the monitor caller.
   - **Refined (monitor):** the monitor caller (`monitor.workflow.ts:805-836`) needs no code change.
     `AutoimplementInput.forge` and `prTiming` are optional, and the child's `parseInput` runs in the
     include-entry node (`src/workflows/composition.ts:185-197`). It fills both fields from the
     config file in the runner, so monitor repairs inherit the user's defaults. A test proves this.
9. **Follow-ups (out of scope):** the `gh` usage in `sanity-check.workflow.ts`,
   `examples/resource-managers/pull-request.resource-manager.ts`, and the stale `codex review` text in
   `skills/autoimplement/agents/openai.yaml`.

## Investigation results

**Is input parsed again on resume or recovery?**

- **Resume:** no. `WorkflowEngine.resumeRun` (`src/workflows/engine.ts:328-420`) reads the stored
  run state, including the normalized input, and never calls `workflow.input`.
- **Fresh start and terminal restart:** yes.
  - `startRun` stores the raw supplied input in the queue record (`src/server/server.ts:2560-2591`).
  - `restartRun` copies `source.input`, which is that raw input (`server.ts:1864-1960`, line 1944).
  - The runner passes `start` and `restart` commands to `engine.run` (`workflow-runner-entry.ts:325-327`).
  - `engine.run` normalizes the input with `workflow.input` before any run row exists (`engine.ts:268`).
  - So a restart reads the config file again when the raw input omitted `forge` or `prTiming`. A
    config change between the original run and its restart takes effect. Document this.
- **Included runs:** for a monitor-included Autoimplement, the child input is normalized inside the
  include-entry compute node (`composition.ts:185-197`). Its recorded output is replayed after a
  commit. A crash before the commit reruns it.
- **Idempotence:** parsing a normalized input again never reads the config file, because both
  fields are present. Test `parseInput(parseInput(x))` deep-equals `parseInput(x)`, including when
  the config file changes between the two calls.

**How does `validateChange` identify the actor?**

- It receives `actor: MutationActor` (`{ type: ActorType; id?: string }`, `src/state/mutation.ts:18-33`).
  `applyWorkflowSettingsPatch` passes it in (`src/workflows/settings.ts:216-245`) after checking path
  permissions for `actor.type` (`settings.ts:264-330`).
- By design, `session` is a model workflow-tool call and `human` is a direct interactive command
  (`docs/plans/2026-08-25-live-workflow-settings-plan.md:196-205`).
- In the code today, every Pi-session change is recorded as `session`: both the
  `/workflow change-settings` slash command and the model tool action (`server.ts:2014-2075`,
  actor at line 2075).
- The extension's `human` / `model` authority flag (`src/extension/index.ts:388,588,902`) is not
  forwarded for `change-settings` (`index.ts:1034-1053`).
- The resolver also pre-validates every proposal with actor `resource_manager`
  (`src/server/resolver-entry.ts:106-135`).
- A probe that applied a `/merge` patch to the autoimplement settings definition showed the result:
  - `resource_manager` was rejected: "replace is not allowed at /merge".
  - `session` was rejected: "cannot grant merge authority".
  - `human` was accepted.
- So, before this change, settings changes to `autoimplement` made from a Pi session are rejected at
  the resolver. That defect already exists and is O1.
- Model steps never get permission to change `prTiming` (`replace: ["human"]`), which matches the
  preferred rule.

**Does `CommandBatchItem` support `env`?**

- No. The type is `{ id, command, args, cwd, timeoutMs, maxOutputChars }`
  (`src/workflows/command-batch.ts:15-22`).
- `validateItem` rejects any other key (`command-batch.ts:137-142`).
- `runItem` does not pass `env` (`command-batch.ts:168-180`), although `runShellAction` supports
  `spec.env` (`src/workflows/shell.ts:79`).
- Batch commands therefore inherit the runner's `process.env`, and `GLAB_NO_PROMPT`, `NO_COLOR`, and
  `GLAB_CHECK_UPDATE` cannot be set per command.
- These mitigate the gap:
  - Commands run without a TTY, because stdio is piped.
  - The canonical command always passes `--repo <project URL>`. This avoids the remote-resolution
    prompt and the `.git/config` write that `glab` can make when several remotes exist
    (glab research, R7).
- Adding an allowlisted `env` is follow-up F1, an engine change with its own WORKFLOWS.md section.

**What does the catalog revision control?**

- `BuiltinWorkflowCatalog` records `{ kind: "builtin", id, revision }` as the run's source identity
  (`src/workflows/catalog.ts:93-98`).
- On resume, `resolve` throws `BuiltinWorkflowRevisionChangedError` when the installed revision
  differs (`catalog.ts:100-120`). Its message tells the user to cancel and start again
  (`errors.ts:74-86`).
- Independently, `workflowIdentityMismatch` refuses a resume when the composed child sources or the
  definition digest differ (`engine.ts:1774-1784`).
- The digest covers nodes, edges, effect types, `settingsRoute`, `statusDetail`, and
  `expectedOutput` (`store.ts:5082-5175`), but not prompt function bodies.
- **Decision: bump `autoimplement` to `"15"` and `monitor` to `"14"`.**
  - Edit `src/builtins/catalog.ts:17,38`, `src/builtins/metadata.ts:5,8`,
    `test/catalog.test.ts:21-22`, and `test/loader.test.ts:145`.
  - Both graphs change: the new nodes, plus `settingsRoute` on `routeVerifiedWorkspace`.
  - Monitor includes Autoimplement. Commit `f29e67f` set the precedent of bumping both when the
    Autoimplement graph changes.
- Do not bump `change-verification`. Its graph is unchanged, and the stricter planner rule is safe on
  resume. Bumping it would also change the composed sources of `autodoc`, `plan-change`,
  `autoimplement`, and `monitor`.

**Where exactly does `resolveForge` go?**

- Replace `{ from: "prepare", to: "observe" }` (`AI:2172`) with `prepare -> resolveForge` and
  `resolveForge -> observe`.
- It is not a control-attempt node, so the first observation still reports `prepare` and
  `initialControlRoutes`.
- It is excluded from the decide ledger, so GitHub decide prompts stay identical.

**How is pi-reviewer faked in tests?**

- `test/builtin-autoimplement.test.ts:325-342` (`beforeEach`) creates three things:
  - a temporary Git repository on `feat/demo` with no remote;
  - a temporary `commandDir`;
  - `#!/bin/sh` executables written by `installCommand` (`:36-39`): `pi-reviewer` prints "review
    complete", and `gh` prints "checks complete".
- `process.env.PATH` is set to `${commandDir}:${originalPath}` and restored in `afterEach`.
- `runReview` and `trackCi` spawn these through `runCommandBatch`.
- Failure cases rewrite the script, as in reviewer repair (`:1825-1832`).
- Agent nodes are answered by `ScriptedExecutor`, so no real model is called.
- The new tests add a `glab` script that appends its `$*` to a log file in `commandDir`.

## Design

### Inputs, config file, and settings

The input type gains two optional fields:

```ts
// AI:69-90
export type AutoimplementInput = {
  // ...existing fields unchanged...
  forge?: ForgeRequest; // "auto" | "github" | "gitlab"; always present after parseInput
  prTiming?: PrTiming; // "early" | "end"; always present after parseInput
};
```

`parseInput` (`AI:271-372`) works in this order:

1. Run every existing check, unchanged and in the same order.
2. `const forge = parseForgeRequest(input.forge, "autoimplement forge")`. It accepts `undefined`,
   `auto`, `github`, or `gitlab`, and otherwise throws
   `autoimplement forge must be auto, github, or gitlab`.
3. `const prTiming = parsePrTiming(input.prTiming, "autoimplement prTiming")`. It accepts
   `undefined`, `early`, or `end`.
4. If either value is `undefined`, read `loadAutoimplementDefaults()`. This is synchronous and is
   the only IO in `parseInput`.
5. Add `forge: forge ?? defaults.forge ?? "auto"` and
   `prTiming: prTiming ?? defaults.prTiming ?? "early"` to the returned object.

The config module is the new file `src/builtins/autoimplement-config.ts`:

```ts
export type PrTiming = "early" | "end";
export const AUTOIMPLEMENT_DEFAULTS_SCHEMA = "pi-workflows.autoimplement-defaults.v1";
export const AUTOIMPLEMENT_DEFAULTS_FILE = "autoimplement.json";
export type AutoimplementDefaults = { forge?: ForgeRequest; prTiming?: PrTiming };

export function parsePrTiming(value: unknown, label: string): PrTiming | undefined;
export function autoimplementDefaultsPath(env?: NodeJS.ProcessEnv): string;
/** Strict: requires schema; allows only schema, forge, prTiming; names the file in every error. */
export function parseAutoimplementDefaults(value: unknown, file: string): AutoimplementDefaults;
/** Missing file (ENOENT) returns {}. Any other read error, invalid JSON, or invalid value throws. */
export function loadAutoimplementDefaults(
  env?: NodeJS.ProcessEnv,
  readText?: (file: string) => string, // defaults to fs.readFileSync(file, "utf8")
): AutoimplementDefaults;
```

Example error: `autoimplement defaults file /home/u/.config/pi-workflows/autoimplement.json: prTiming
must be early or end`. The file holds no secrets, so it has no private-permission check. That differs
from `channels.json`.

The config directory comes from the new file `src/state/config-dir.ts`:

```ts
/** `${PI_WORKFLOWS_CONFIG_DIR}` or `~/.config/pi-workflows`. Shared by channels and built-ins. */
export function workflowsConfigDir(env: NodeJS.ProcessEnv = process.env): string;
```

`src/channels/config.ts:39-41` becomes `return workflowsConfigDir(env)`. `src/state/index.ts` exports
the helper.

The settings type grows to:

```ts
// AI:64-67
export type AutoimplementSettings = {
  merge: boolean;
  addedInstructions: string[];
  forge: ForgeRequest;
  prTiming: PrTiming;
};
```

The settings declaration (`AI:1600-1621`) changes in four places:

- `parseAutoimplementSettings` (`AI:374-389`) requires both new fields and validates their enum
  values. It stays a pure validator: it returns exactly the keys it receives and adds nothing.
- `initial` becomes:

  ```ts
  initial: (input) => ({
    merge: input.merge === true,
    addedInstructions: [],
    forge: input.forge ?? "auto",
    prTiming: input.prTiming ?? "early",
  });
  ```

  The `??` fallbacks serve only callers that pass raw input, such as
  `resolveInitialWorkflowSettings` in tests. The engine always passes normalized input.

- `paths` adds two rules:
  - `allowSettingsPath("/forge", { read: ["session", "human"] })`
  - `allowSettingsPath("/prTiming", { read: ["session", "human"], replace: ["human"] })`
- `validateChange` keeps the merge rule and adds two:
  - If `before.forge !== after.forge`, throw `The requested forge cannot change during a run`.
  - If `before.prTiming === "early"` and `after.prTiming === "end"`, throw
    `Publication timing cannot move from early to end during a run`.

The `description` becomes "Future merge behavior, publication timing, the requested forge, and
instructions added during this run."

Two accessors read the timing:

- `autoimplementSettings(context).prTiming` holds the requested timing.
- The new `publicationTiming(context): PrTiming` returns `early` when the prepared workspace is
  known and its mode is `defaultBranch`. Otherwise it returns `settings.prTiming`. Use it in every
  prompt line that applies only to `end`, and in `routeVerifiedWorkspace`.

### Forge module API

The new file is `src/builtins/autoimplement-forge.ts`. It is pure apart from `readForgeFacts` and
`resolveForge`.

```ts
export type Forge = "github" | "gitlab";
export type ForgeRequest = "auto" | Forge;
export const FORGE_RESOLUTION_SCHEMA = "pi-workflows.autoimplement-forge-resolution.v1";

export type ForgeResolution = {
  schema: typeof FORGE_RESOLUTION_SCHEMA;
  requested: ForgeRequest;
  forge: Forge;
  host: string | null; // matched forge host (glab hosts key, gh host, or remote host); null when explicit or no remote
  remoteUrl: string | null; // redacted remote URL; null when explicit or absent
  reason: string; // e.g. "explicit input", "remote host github.com", "glab ssh_host ssh.code.aws.dev of code.aws.dev"
};

export type RemoteHost = { host: string; port: number | null }; // host lowercased, IPv6 brackets removed
export type GlabHostEntry = { key: string; apiHost?: string; sshHost?: string };
export type ForgeFacts = {
  remoteUrl: string | null; // already redacted
  ghHosts: readonly string[];
  glabHosts: readonly GlabHostEntry[];
  gitlabHostEnv: string | null; // GITLAB_HOST, bare host or URL
};

export function parseForgeRequest(value: unknown, label: string): ForgeRequest | undefined;
/** scp-like `[user@]host:path`, `ssh://`, `git+ssh://`, `https://`, `http://`, `git://`; null for local paths and `file://`. */
export function parseRemoteHost(remoteUrl: string): RemoteHost | null;
/** Removes `user[:password]@` from URL-style remotes; scp-like remotes are returned unchanged. */
export function redactRemoteUrl(remoteUrl: string): string;
/** Top-level host keys of a gh `hosts.yml`. Indentation scanner, no YAML dependency, no values kept. */
export function parseGhHostsYaml(text: string): string[];
/** Entries under `hosts:` in a glab `config.yml`; keeps only key, api_host, ssh_host (never tokens). */
export function parseGlabHostsYaml(text: string): GlabHostEntry[];
/** Pure decision; see the precedence table. Never throws for unknown or malformed facts. */
export function detectForge(requested: ForgeRequest, facts: ForgeFacts): ForgeResolution;

export type ForgeIo = {
  runGit(cwd: string, args: string[]): Promise<string>; // execFile("git", ...) with 30 s timeout, like workspace-preparation `git()`
  readText(file: string): Promise<string | null>; // null on ENOENT
  env: NodeJS.ProcessEnv;
  homeDir: string;
};
export function defaultForgeIo(): ForgeIo;
/** `git remote get-url origin`, else `git remote` first entry + `get-url`; reads gh and glab host files. */
export async function readForgeFacts(cwd: string, io: ForgeIo): Promise<ForgeFacts>;
/** Explicit request returns immediately without IO. IO errors become a github resolution with a reason. */
export async function resolveForge(
  requested: ForgeRequest,
  cwd: string,
  io?: ForgeIo,
): Promise<ForgeResolution>;
/** Strict reader for the recorded `resolveForge` step output. */
export function parseForgeResolution(value: unknown): ForgeResolution;

export type GitLabMergeRequest = {
  url: string; // exact input
  host: string; // may include :port
  projectPath: string; // "group/sub/project"
  iid: number;
  projectUrl: string; // "https://<host>/<projectPath>"
  apiProject: string; // encodeURIComponent(projectPath)
};
/** Exactly `https://<host>/<projectPath>/-/merge_requests/<iid>`; >= 2 path segments of [A-Za-z0-9_.-]+ not starting with "-"; iid positive without leading zero; no query, fragment, or trailing segment. */
export function parseGitLabMergeRequestUrl(value: unknown, label: string): GitLabMergeRequest;
```

`detectForge` applies these rules in order. Hostnames compare case-insensitively, and ports are
ignored.

| #   | Condition                                                                                          | Result                                                                 | `host`                                 |
| --- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------- |
| 1   | `requested` is `github` or `gitlab`                                                                | that forge, reason `explicit input`                                    | `null`                                 |
| 2   | no remote, or no host can be parsed (local path, `file://`)                                        | `github`, reason names the cause                                       | `null`                                 |
| 3   | host is `github.com`                                                                               | `github`                                                               | `github.com`                           |
| 4   | host is `gitlab.com`                                                                               | `gitlab`                                                               | `gitlab.com`                           |
| 5   | host is listed in gh hosts and also matches a glab entry                                           | `github`, reason says it is ambiguous and suggests an explicit `forge` | remote host                            |
| 6   | host matches a glab entry's `key`, `api_host`, or `ssh_host`, or equals the `GITLAB_HOST` hostname | `gitlab`                                                               | entry `key`, or the `GITLAB_HOST` host |
| 7   | host is listed in gh hosts                                                                         | `github`                                                               | remote host                            |
| 8   | anything else                                                                                      | `github`, reason `unknown host <h>; using GitHub (upstream default)`   | remote host                            |

The module does not resolve aliases in `~/.ssh/config`, and does not read `GL_HOST`, `GITLAB_URI`,
or the per-repository `.git/glab-cli/config.yml`. These are follow-up F3. Until then, the workaround
is to set `forge` explicitly or in the config file.

### `resolveForge` node

```ts
resolveForge: action({
  effect: idempotentEffect("pi-workflows.autoimplement.resolve-forge"),
  statusDetail: "resolving the code forge",
  run: async ({ input }) => {
    const request = input as AutoimplementInput;
    const cwd = request.preparedWorkspace?.worktreePath ?? request.preparedWorkspace?.repository ?? request.repository;
    return await resolveForge(request.forge ?? "auto", cwd);
  },
}),
```

The node connects to the rest of the workflow as follows:

- **Edges:** `{ from: "prepare", to: "resolveForge" }` and `{ from: "resolveForge", to: "observe" }`.
  The wrapper turns every IO failure into a resolution, so the only way the node can fail is a
  programming error. Such an error fails the run, matching "unexpected invariant errors still fail
  the run" (`docs/WORKFLOWS.md:748`).
- **Accessor:** `forgeFor(context): Forge` returns
  `parseForgeResolution(context.outputs.resolveForge).forge`. When that output is absent, it returns
  `"github"`. In the real graph the output is always present, because `resolveForge` runs before
  `observe`. Only synthetic test contexts lack it, and returning upstream behavior there keeps the
  existing decide-prompt tests unchanged. A graph test pins the edge. A second accessor,
  `forgeResolution(context)`, returns the full record for prompts.
- **Ledger:** add `resolveForge` to the nodes the decide ledger skips. Introduce
  `CONTROL_LEDGER_SKIPPED_NODES = new Set(["observe", "dispatch", "resolveForge"])`, keep the doc
  comment accurate, and leave `CONTROL_ATTEMPT_NODES` unchanged for it.
- **Replay:** after the step commits, resume replays the recorded output. If the runner crashes
  before the commit, the idempotent effect returns to pending and the detection runs again, which is
  safe. A restart detects again, because it is a new run.

### Forge wording and GitLab prompts

The new file `src/builtins/autoimplement-forge-text.ts` holds the wording.

```ts
export type ForgeTerms = {
  request: "pull request" | "merge request";
  requests: "pull requests" | "merge requests";
  short: "PR" | "MR";
  shortPlural: "PRs" | "MRs";
  cli: "gh" | "glab";
};
export function forgeTerms(forge: Forge): ForgeTerms;

/** Complete per-node sentences. The github entries are copied verbatim from AI at 2cb8ab3. */
export type ForgeText = {
  implementInspect: string; // AI:1794
  defaultBranchNoSelfRequest: string; // AI:1839
  publish: { early: readonly string[]; reviewed: readonly string[] }; // AI:1882-1886; reviewed lines added by C
  verifyP2: readonly string[]; // AI:1974-1978
  inspectComments: readonly string[]; // AI:1991-1993
  inspectCi: (targets: readonly CiPromptTarget[]) => readonly string[]; // AI:2008-2012
  repairCi: readonly string[]; // AI:2058-2061
  assessTrackedCi: string; // AI:2074
  finalizeDelivery: (merge: boolean) => readonly string[]; // AI:2105-2112
  summaryResults: string; // AI:1588
  defaultBranchCiReason: string; // AI:2156
  decideLine?: string; // gitlab only: "Forge: gitlab. Publication uses one GitLab merge request through glab."
};
export function forgeText(forge: Forge): ForgeText;
/** GitLab REST coordinates for every published repository: --hostname <host> and projects/<apiProject>/merge_requests/<iid>. */
export function gitlabApiCoordinates(published: PublishedRepositories): string;
```

The sentences follow these rules:

- **Shared lines.** A line that is the same for both forges stays in one shared array. This keeps
  `slophammer dry` (copied blocks of 100 tokens or more, `slophammer.yml:7-14`) at zero findings.
- **No word substitution.** Prompts never build a GitHub line by substituting into a template.
- **GitLab commands.** GitLab sentences name exact `glab api` REST calls with an explicit
  `--hostname`. The local `glab` is an old build without `mr note list`, `note create --reply`, or
  `ci get --merge-request`, while newer `glab` has them. The REST calls work on both. Each GitLab
  prompt that touches an MR includes the program-derived `gitlabApiCoordinates(...)` line.

GitLab content by prompt:

| Prompt                  | GitLab wording and commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `implement`             | Inspect "... remote state, and matching merge request".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `finalizeDefaultBranch` | "Never open a merge request from the default branch to itself."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `publish` (early)       | Commit and push before review, as upstream. Inspect matching merge requests with `glab api --hostname <host> "projects/<apiProject>/merge_requests?state=opened&source_branch=<branch>&target_branch=<base>"` or `glab mr list --source-branch <branch> --target-branch <base> -F json`. Never create a second MR for the same source and target branch. Create with `glab mr create --source-branch <branch> --target-branch <base> --title <title> --description <text> --yes`. Update with `glab mr update <iid> --description <text> --yes`. **Replaces the `pr-description` skill:** "Write the merge request description yourself: what changed and why, how it was verified with exact commands, risks, and follow-ups." Report `pr` as the MR web URL `https://<host>/<project>/-/merge_requests/<iid>`. |
| `verifyP2` (pushed)     | Same as upstream, with "merge request" and "MR URL".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `inspectComments`       | List with `glab api --hostname <host> --paginate projects/<apiProject>/merge_requests/<iid>/discussions`. Ignore `system: true` notes. Reply with `glab api --hostname <host> --method POST projects/<apiProject>/merge_requests/<iid>/discussions/<discussionId>/notes -f body=<reply>`. Resolve every resolvable discussion with `glab api --hostname <host> --method PUT projects/<apiProject>/merge_requests/<iid>/discussions/<discussionId> -F resolved=true`. Handle merge requests one at a time.                                                                                                                                                                                                                                                                                                        |
| `inspectCi`             | One-shot status: `glab api --hostname <host> projects/<apiProject>/merge_requests/<iid>` (`head_pipeline.id/status/sha`), then `.../pipelines/<id>/jobs` and `.../jobs/<jobId>/trace` for failures. When pending, give a `trackingCommand` that is exactly the canonical command per target (listed in the prompt): `{ "id", "command": "glab", "args": ["ci","status","--live","--branch",<branch>,"--repo",<projectUrl>], "cwd", "timeoutMs" <= 300000, "maxOutputChars" <= 1000000 }`. A final line says: "The expected-output example shows the GitHub form; on this GitLab run use the glab form above." (O2)                                                                                                                                                                                               |
| `repairCiCommand`       | "local glab prerequisites or authentication"; "Do not change the MR identity."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `assessTrackedCi`       | "every watched MR".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `finalizeDelivery`      | "Leave every verified MR ready" or "Handle verified MRs one at a time". Read `merge_method` and `squash_option` from `glab api --hostname <host> projects/<apiProject>`. Merge with `glab api --hostname <host> --method PUT projects/<apiProject>/merge_requests/<iid>/merge -f sha=<head> [-F squash=true] [-F should_remove_source_branch=true]`, or `glab mr merge <iid> --sha <head> --auto-merge=false --yes`. Never report `merged: true` until `state` is `merged` on a fresh read, because armed auto-merge does not count. Post the report once with `.../merge_requests/<iid>/notes -f body=<report>`, and report it as `...#note_<id>`.                                                                                                                                                              |
| `resultSummary`         | "CI, MR or merge results".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `prepareCompleted`      | `ci.reason` is "Direct default-branch work has no merge request."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `decide`                | Appends `decideLine` after "Merge allowed now" on GitLab only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The `statusDetail` and `expectedOutput` strings stay the upstream text on both forges (O2).

### GitLab MR URL validation

`parsePublishedForContext` (`AI:1160-1174`) gains one check. When `forgeFor(context) === "gitlab"`,
every `pr` is passed through `parseGitLabMergeRequestUrl` and the original string is kept. The other
places that read `pr` already require it to equal the published value, so they need no extra check:

- `parseP2Verification` (`AI:1298-1334`);
- `parseCiInspectionForPublished` (`AI:1336-1363`);
- `parseDeliveryResult` (`AI:1209-1296`).

The GitHub path adds no URL check.

### CI allowlist and binding

The signatures in `CB` change so that the existing positional callers and tests keep working:

```ts
export type CiForgeBinding = { forge: "github" } | { forge: "gitlab"; branch: string };
export const GITHUB_CI_BINDING: CiForgeBinding = { forge: "github" };

// CB:182-213
export function parseCiCommand(
  value: unknown,
  id: string,
  repository: string,
  pr: string,
  binding: CiForgeBinding = GITHUB_CI_BINDING,
): CommandBatchItem;

// CB:119-180
export function parseCiInspectionBatch(
  value: unknown,
  bindingFor: (id: string) => CiForgeBinding = () => GITHUB_CI_BINDING,
): CiInspectionBatch;
```

How the binding works:

- `parseCiInspectionForPublished` (`AI:1336-1363`) builds `bindingFor` from
  `currentPublishedRepositories(context)`, keyed by repository id, and from `forgeFor(context)`.
- On GitLab, the binding is `{ forge: "gitlab", branch: published.branch }`, so the published source
  branch reaches the binding through the target id.
- An id with no published record throws
  `CI target does not match the published repository and head: <id>`.
- `parseCiInspectionBatch` passes `bindingFor(id)` to `parseCiCommand` for pending targets (`CB:161-163`).

**Rules shared by both forges.** These are unchanged:

- `id` must equal the target id.
- `cwd` must resolve to the target repository.
- `timeoutMs` must be from 1 through `CI_WATCH_TIMEOUT_MS` (300000).
- `maxOutputChars` must be from 1 through 1000000.
- `args` must be an array of strings.
- The executable is fixed per forge and never runs through a shell.

**GitHub.** This path is unchanged and `command` must be `gh`.

| Input `args`                                                            | Result                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------- |
| `["pr","checks","--watch"]`                                             | accepted, normalized to `["pr","checks",<pr>,"--watch"]` |
| `["pr","checks",<pr>,"--watch"]`                                        | accepted, normalized to the same value                   |
| `["run","watch","123"]`                                                 | accepted, normalized to the same value                   |
| `["pr","merge"]`, another PR URL, `--repo other/repo`, `command: "git"` | rejected, as in the existing tests                       |
| `command: "glab"` on a GitHub run                                       | rejected: `CI tracking command.command must be gh`       |

**GitLab.** `command` must be `glab`, and `pr` must parse with `parseGitLabMergeRequestUrl`. Let
`mr = parseGitLabMergeRequestUrl(pr)`. Then `args` must be `ci`, `status`, followed by an unordered
set of the options below. Each option may appear at most once, and no other token is allowed.

- **Watch flag:** exactly one of `--live`, `-l`, or `--wait`. Old `glab` has only `--live`; new
  `glab` has both.
- **Branch:** optional, as `--branch <b>`, `-b <b>`, or `--branch=<b>`. The value `b` must equal
  `binding.branch`.
- **Repository:** optional, as `--repo <r>`, `-R <r>`, or `--repo=<r>`. The value `r` must be one of
  `mr.projectUrl`, `<mr.host>/<mr.projectPath>`, or `mr.projectPath`.

The command is normalized to
`["ci","status","--live","--branch",binding.branch,"--repo",mr.projectUrl]`.

The examples below use branch `feat/demo` and
`pr = https://gitlab.example.test/group/sub/project/-/merge_requests/7`.

| Input `args`                                                                                 | Result                                               |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `["ci","status","--live"]`                                                                   | accepted                                             |
| `["ci","status","--wait","--branch","feat/demo"]`                                            | accepted                                             |
| `["ci","status","-l","-b","feat/demo","-R","https://gitlab.example.test/group/sub/project"]` | accepted                                             |
| `["ci","status","--repo=group/sub/project","--live","--branch=feat/demo"]`                   | accepted                                             |
| `["ci","status","--live","-R","gitlab.example.test/group/sub/project"]`                      | accepted                                             |
| `["ci","status"]`                                                                            | rejected: no watch flag                              |
| `["ci","status","--live","--live"]`, `["ci","status","--live","--wait"]`                     | rejected: repeated or second watch flag              |
| `["ci","status","--live","--branch","main"]`                                                 | rejected: another branch                             |
| `["ci","status","--live","--branch"]`, `["ci","status","--live","--branch="]`                | rejected: missing value                              |
| `["ci","status","--live","--repo","other/project"]`                                          | rejected: another project                            |
| `["ci","status","--live","-R","https://evil.example/group/sub/project"]`                     | rejected: another host                               |
| `["ci","status","--live","-F","json"]`, `["ci","status","--live","--compact"]`               | rejected: extra option                               |
| `["ci","get","-b","feat/demo"]`, `["ci","view"]`, `["ci","trace","12"]`                      | rejected: not `ci status`                            |
| `["api","projects/:id/pipelines"]`, `["mr","merge","7"]`                                     | rejected                                             |
| `command: "gh"`, `"sh"`, `"bash"`, `"/usr/bin/env"`                                          | rejected: `CI tracking command.command must be glab` |
| `pr` set to `https://gitlab.example.test/group/project/merge_requests/7` (no `/-/`)          | rejected: the project cannot be derived              |
| wrong `id`, another `cwd`, `timeoutMs: 300001`, `maxOutputChars: 1000001`                    | rejected                                             |

`trackCi` (`AI:2021-2050`) and its repair rule do not change. The watch returns `glab`'s text output
and exit code. A failed pipeline exits 1, so the item outcome is `failed` with an exit code, which
routes to assessment. A truncated output or spawn failure routes to `repairCiCommand`.

### Verification safety tightening

This is a deliberate change for every forge.

- Add `"glab"` to `FORBIDDEN_VERIFICATION_EXECUTABLES` (`CB:252-271`), in alphabetical order after
  `"git"`.
- `formatVerificationCommandSafetyRules` (`CB:284-291`) keeps its four lines and inserts a fifth after
  the Git/GitHub line:
  "All GitLab CLI (glab) commands are forbidden, including read-only commands."
- The change-verification planner prompt (`change-verification.workflow.ts:1207`) and its validator
  pick up both changes automatically.
- `skills/autoimplement/SKILL.md:25` adds "GitLab CLI" to its forbidden list.

### `prTiming=end` routing

The controller route map (`AI:203-226`, pinned by `test/builtin-autoimplement.test.ts:1418-1446`) is
unchanged.

**New and changed nodes**

- `routeVerifiedWorkspace` (`AI:1823-1828`) becomes `settingsRoute({ run })`:

  ```ts
  run: (context) => {
    if (preparedWorkspace(context).mode === "defaultBranch") return { route: "defaultBranch" };
    const steps = context.state.steps;
    if (reviewGatePassed(steps) && !gateHeadPushed(steps)) return { route: "publishReviewed" };
    if (publicationTiming(context) === "end") return { route: "commitLocal" };
    return { route: "pullRequest" };
  };
  ```

  Its edge (`AI:2201-2207`) gets these cases: `pullRequest: "publish"`, `publishReviewed: "publish"`,
  `commitLocal: "commitLocal"`, and `defaultBranch: "finalizeDefaultBranch"`.

- `commitLocal` is a new agent node with `timeoutMs` of 30 minutes and statusDetail "committing
  locally".
  - **Prompt.** It commits the verified work on the prepared task branch, as one or more new
    commits. It never pushes, never opens or updates a PR or MR, and never amends or rewrites a commit
    that was already pushed. It inspects branch, status, and commits first. When everything is
    already committed it reports the current HEAD and does not create an empty commit. All
    task-related changes must be committed. It names the forge request through `forgeTerms`.
  - **Expected output:**

    ```json
    {
      "repositories": [
        {
          "repository": "/absolute/repository",
          "branch": "task branch",
          "baseBranch": "base",
          "headRevision": "local commit",
          "committed": true,
          "dependencyFingerprint": "optional digest"
        }
      ]
    }
    ```

    The node stores it as one line, like the other `expectedOutput` strings.

  - **Validator.** `parseLocalCommitForContext` is async. It checks:
    - that `CB.parseLocalCommitRepositories` accepts the output, with the same rules as
      `parsePublishedRepositories` but `committed: true` instead of `pushed`/`pr`;
    - that the output names exactly the prepared work path;
    - that `branch` equals `preparedWorkspace.workBranch` and `baseBranch` equals
      `preparedWorkspace.baseBranch`;
    - **proposed addition:** a read-only Git check that `git rev-parse HEAD` equals `headRevision`,
      that `git symbolic-ref --short HEAD` equals `branch`, and that
      `git status --porcelain=v1 --untracked-files=all` lists no path outside
      `preExistingChangedPaths`. This makes the reviewed head program-verified, closing the gap the
      scout found: today `headRevision` is only reported by the model.
  - **Edges:** `ok -> publicationResult`, `timed_out -> observe`, `failed -> observe`.
- `publicationResult` (`AI:1829-1831`) reads
  `branchResultFrom(context, ["finalizeDefaultBranch", "publish", "commitLocal"])`.
- `publish` (`AI:1876-1895`) changes in two ways.
  - **Prompt.** When the latest `routeVerifiedWorkspace` route is `publishReviewed`, the prompt uses
    `forgeText(forge).publish.reviewed`, which says:
    - push exactly the reviewed local head `<sha>` without force, and create no new commits;
    - reuse the existing PR or MR for this branch and base, or open one if none exists, and never
      create a second one;
    - if the local HEAD differs from `<sha>`, do not push, and report the difference.

    Otherwise the prompt is unchanged.

  - **Validator.** `parsePublishedForContext` adds a check under `publishReviewed`: `headRevision`,
    `branch`, `baseBranch`, and `dependencyFingerprint` must equal the gate head record (see below).
- `selectReviewCommands` (`AI:1431-1449`) reads
  `latestOutput<ReviewCandidates>(context, ["publish", "commitLocal"])`.
  - `ReviewCommandSelection.repositories` becomes `CandidateRepository[]`.
  - `reviewerCommand` (`CB:108-117`) accepts a `CandidateRepository`. Its output is unchanged.
- `routeAddressedP2` is a new compute node. It returns `{ route: "push" }` when
  `reviewCandidate(steps)` came from `publish`, and `{ route: "local" }` otherwise. The `addressP2`
  edge (`AI:2263-2269`) changes to `ok -> routeAddressedP2`; `timed_out` and `failed` still go to
  `observe`. The new edge from `routeAddressedP2` switches on `$.route`: `push -> verifyP2`,
  `local -> verifyP2Local`.
- `verifyP2Local` is a new agent node with statusDetail "verifying P2 changes locally".
  - **Prompt.** Run focused verification for the P2 changes, then commit the verified result
    locally on the task branch. Never push and never open or update a PR or MR, because publication
    follows. Do not run pi-reviewer again. Return the repository, branch, base branch, local head,
    `committed: true`, and the unchanged dependency fingerprint. Report exact commands.
  - **Expected output:** the same shape as `commitLocal`, plus `"passed": true | false`,
    `"commands": [{ "command": "command", "outcome": "result" }]`, and `"pushed": false`.
    Each repository entry has `"committed": true` and no `pr`.
  - **Validator.** `parseLocalP2Verification` requires `passed` to be a boolean and `pushed === false`.
    It also requires `repository`, `branch`, `baseBranch`, and `dependencyFingerprint` to equal the
    current `reviewCandidate`, and runs the same HEAD check as `commitLocal`.
  - **Edges:** `ok -> p2Result`, `timed_out -> observe`, `failed -> observe`.
- `verifyP2` (`AI:1969-1982`) keeps its upstream prompt, `expectedOutput`, and `parseP2Verification`.
  It runs only when the reviewed candidate was pushed, which is always true under `early`.
- `p2Result` (`AI:1983-1985`) reads `branchResultFrom(context, ["verifyP2", "verifyP2Local"])`.
- `currentPublishedRepositories` (`AI:1176-1178`) keeps its code,
  `latestOutput(["verifyP2", "publish"])`. That list is exactly the set of pushed records. Add a
  comment that `verifyP2Local` is deliberately excluded.
- `CONTROL_ATTEMPT_NODES` (`AI:662-695`) gains `commitLocal` and `verifyP2Local`.
- `prepareCompleted` (`AI:2134-2160`) uses the verification fallback
  `latestOutput(context, ["verifyP2", "verifyP2Local"])`.

**Prompt lines that apply only under `end`.** These lines are added only when
`publicationTiming(context) === "end"`, so `early` text is unchanged.

- `implement`, `fix`, and `addressP2` add one line: "Do not push and do not open or update a pull
  request. This run publishes once, after review passes." The GitLab version says "merge request".
- `decide` adds one line after "Merge allowed now": "Publication timing: end. Publication first
  commits locally; after review passes, publication pushes once to the single pull request." The
  GitLab version says "merge request".

**`resultRoutes` changes (`AI:813-946`)**

In this table, "unpushed gate" means `reviewGatePassed(steps) && !gateHeadPushed(steps)`.

| Latest attempt                     | Upstream routes (kept when the condition is false)                          | New routes when the condition holds                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publicationResult` (`:877-881`)   | `completed` gives `complete`; else `review, publication, redesign, blocked` | the latest `routeVerifiedWorkspace` route is `publishReviewed`, the source is `publish`, and `reviewGatePassed && gateHeadPushed`: `comments, review, blocked` |
| `reviewResult`: clean (`:894`)     | `comments, review, blocked`                                                 | unpushed gate: `publication, review, blocked`                                                                                                                  |
| `reviewResult`: reuse (`:886-888`) | `comments, review, blocked`                                                 | head not pushed and gate passed: `publication, review, blocked`; head not pushed and gate not passed: `repair, redesign, blocked`                              |
| `p2Result` (`:900-904`)            | passed: `comments, review, blocked`                                         | passed with an unpushed gate: `publication, review, blocked`                                                                                                   |
| `commitLocal` (new)                | none                                                                        | `publication, repair, redesign, blocked`, the same as `publish`                                                                                                |
| `verifyP2Local` (new)              | none                                                                        | `addressP2, repair, redesign, blocked`, the same as `verifyP2`                                                                                                 |

The reuse row needs no condition when the head is pushed, because a pushed head always uses the
upstream routes. All other rows are unchanged.

### State predicates

The predicates are pure functions of `context.state.steps`. They go in the new module
`src/builtins/autoimplement-review-gate.ts` and depend only on `WorkflowStepRecord` and the record
types. Keep each function small, because the slophammer complexity target is 8.

```ts
/** Steps that can change files. Any outcome counts, because a failed or timed-out edit may be partial. */
const LOCAL_EDIT_NODES = new Set(["implement", "fix", "addressP2"]);
/** Steps that record a head. Only `ok` outcomes count. */
const HEAD_RECORD_NODES = new Set(["commitLocal", "publish", "verifyP2", "verifyP2Local"]);
const PUSHED_RECORD_NODES = new Set(["publish", "verifyP2"]);

type HeadIdentity = { id: string; headRevision: string; dependencyFingerprint?: string };

/** Newest LOCAL_EDIT step (any outcome) or HEAD_RECORD step (ok), scanning from the end. */
export function latestWorkEvent(
  steps: readonly WorkflowStepRecord[],
): WorkflowStepRecord | undefined;

/** Newest ok `commitLocal` or `publish` step: the record that `selectReviewCommands` reviews. */
export function reviewCandidate(
  steps: readonly WorkflowStepRecord[],
): WorkflowStepRecord | undefined;

/**
 * Newest ok `assessReview` repository entry with equal id, headRevision, and dependencyFingerprint,
 * and invocationSucceeded. Returns "critical" when p0 or p1 is non-empty, "p2" when p2 is non-empty,
 * otherwise "clean".
 */
export function reviewOf(
  steps: readonly WorkflowStepRecord[],
  head: HeadIdentity,
): "clean" | "p2" | "critical" | undefined;

/**
 * Heads reported by an ok verifyP2 or verifyP2Local step with passed === true, where the newest
 * commitLocal or publish step before it has reviewOf(...) === "p2" for every repository.
 */
export function p2VerifiedHeads(steps: readonly WorkflowStepRecord[]): HeadIdentity[];

/** A head passes when it was reviewed clean, or when it is a P2-verified head that followed a P2-only review. */
export function headPassesGate(steps: readonly WorkflowStepRecord[], head: HeadIdentity): boolean;

/**
 * True when the newest local work has passed the review gate. Concretely, latestWorkEvent(steps) is
 * a HEAD_RECORD step, it is not a verifyP2 or verifyP2Local step with passed !== true, and every
 * repository it records satisfies headPassesGate.
 */
export function reviewGatePassed(steps: readonly WorkflowStepRecord[]): boolean;

/** True when latestWorkEvent(steps) is a PUSHED_RECORD step. This is the "gate head pushed" fact. */
export function gateHeadPushed(steps: readonly WorkflowStepRecord[]): boolean;
```

**Invariant under `end`.** Let the gate head record be `latestWorkEvent(steps)` at the time
`routeVerifiedWorkspace` returns `publishReviewed`. Every `publish` or `verifyP2` step that pushes
under `end` comes after a gate pass for exactly the head it pushes. The pushed head is either:

- reviewed clean, by pi-reviewer with no P0, P1, or P2 findings; or
- the result of a passed P2 verification that followed a P2-only review of its parent candidate.

No PR or MR exists, and nothing is pushed, before the first gate pass. Later fixes always go through
this cycle:

```text
repair -> fix -> verification -> publication(commitLocal) -> review -> clean -> publication(publishReviewed) -> publish
```

The publish pushes to the same PR or MR, because the prompt says to reuse the existing one for the
branch and base.

The following scenarios check the predicates, with `latestWorkEvent` written as "e":

| Scenario                                                                 | e                  | Gate             | Pushed | Effect                                |
| ------------------------------------------------------------------------ | ------------------ | ---------------- | ------ | ------------------------------------- |
| early: `publish h1`, review clean                                        | `publish h1`       | yes              | yes    | upstream `comments`                   |
| early: `publish h1`, review p2, `addressP2`, `verifyP2 h2` passed        | `verifyP2 h2`      | yes, P2-verified | yes    | upstream `comments`                   |
| end: `fix`, `commitLocal h1`, review clean                               | `commitLocal h1`   | yes              | no     | `publication`, then `publishReviewed` |
| end: then `publish h1`                                                   | `publish h1`       | yes              | yes    | `publicationResult` gives `comments`  |
| end: `commitLocal h1`, review p2, `addressP2`, `verifyP2Local h2` passed | `verifyP2Local h2` | yes, P2-verified | no     | `publication`, then `publish h2`      |
| end: after `publish`, CI fix `fix`                                       | `fix`              | no               | no     | `commitLocal`, then review            |
| end: `commitLocal h1`, review critical                                   | `commitLocal h1`   | no               | no     | `repair`                              |

### Mermaid flowchart for `prTiming=end`

```mermaid
flowchart TD
  P[prepare] --> RF["resolveForge (action, idempotent)"] --> OBS["observe: availableRoutes"]
  OBS --> DEC["decide (agent)"] --> DIS{"dispatch on route"}
  DIS -->|implementation or repair| EDIT["implement or fix (no push)"] --> OBS
  DIS -->|verification| LV["localVerification"] -->|ready or blocked| OBS
  DIS -->|publication| RVW{"routeVerifiedWorkspace (settingsRoute)"}
  RVW -->|defaultBranch, timing ignored| FDB[finalizeDefaultBranch] --> PUBR
  RVW -->|commitLocal: end and gate not passed| CL["commitLocal: commit only, never push"]
  RVW -->|publishReviewed: gate passed, head not pushed| PUB["publish: push reviewed head, create or update the single PR or MR"]
  RVW -->|pullRequest: early| PUB
  CL -->|ok| PUBR[publicationResult]
  PUB -->|ok| PUBR
  PUBR -->|"after commitLocal: review first"| OBS
  DIS -->|review| SRC{"selectReviewCommands: latest publish or commitLocal"}
  SRC -->|run| RR["runReview: pi-reviewer --base"] --> AR[assessReview] --> REVR[reviewResult]
  SRC -->|reuse| REVR
  REVR -->|"clean and head not pushed: publication offered"| OBS
  DIS -->|addressP2| AP2[addressP2] --> RAP{routeAddressedP2}
  RAP -->|push: candidate was published| VP2["verifyP2: verify and push"] --> P2R[p2Result]
  RAP -->|local: candidate was commitLocal| VP2L["verifyP2Local: verify and commit"] --> P2R
  P2R -->|"passed and head not pushed: publication offered"| OBS
  DIS -->|comments| IC["inspectComments (PR or MR)"] --> OBS
  DIS -->|ci| ICI["inspectCi, trackCi (gh or glab bound)"] --> OBS
  DIS -->|delivery| FD["finalizeDelivery: merge if allowed"] --> OBS
  DIS -->|complete| PC[prepareCompleted]
```

A typical `end` run with one fix after the MR exists goes through these routes:

```text
verification -> publication(commitLocal) -> review(clean) -> publication(publishReviewed: push 1, open MR)
  -> comments -> ci(failed, related) -> repair -> verification -> publication(commitLocal)
  -> review(clean) -> publication(publishReviewed: push 2, same MR) -> comments -> ci(green) -> delivery -> complete
```

**What stays the same under `early`**

- `routeVerifiedWorkspace` always returns `pullRequest` or `defaultBranch`, because the gate head
  record is always `publish` or `verifyP2`, and both are pushed.
- `commitLocal` and `verifyP2Local` never run, and `routeAddressedP2` always returns `push`.
- `selectReviewCommands` reads the same `publish` record.
- Every `resultRoutes` list equals upstream.
- Prompts, `expectedOutput`, and `statusDetail` are byte-identical on GitHub.
- The added graph elements on the `early` path are the `resolveForge` action, the `routeAddressedP2` compute
  step, and the `settingsRoute` flag. They appear in step history and in the layout fixture.

**Mid-run change from `end` to `early`.** This works only for a `human` actor (O1). After a
`commitLocal` and a clean review, the unified rule still offers `publication`, and
`routeVerifiedWorkspace` returns `publishReviewed`. Before the review, `routeVerifiedWorkspace`
returns `pullRequest`, so the next publication pushes before review, as in `early`. P2 work follows
the pushed state of the reviewed candidate, not the timing.

**Output shapes.** `AutoimplementCompleted` and `AutoimplementBlocked` are unchanged. On GitLab,
`delivery.pr` and the CI target `pr` hold the MR URL. The result does not include the forge;
readers find it in the `resolveForge` step of the run bundle.

## Touched paths

The WP column names the work package that owns each change.

### `src/builtins/autoimplement.workflow.ts`

| Symbol                                                                                         | Lines                                                 | Change                                                                                                                                                 | WP      |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| imports                                                                                        | 1-62                                                  | Import from the forge, config, forge-text, and review-gate modules; `idempotentEffect`; `settingsRoute`                                                | A, B, C |
| `AutoimplementSettings`                                                                        | 64-67                                                 | Add `forge: ForgeRequest`, `prTiming: PrTiming`                                                                                                        | A       |
| `AutoimplementInput`                                                                           | 69-90                                                 | Add optional `forge`, `prTiming`                                                                                                                       | A       |
| `parseInput`                                                                                   | 271-372                                               | Validate both fields; fill them from `loadAutoimplementDefaults()` only when missing; return them explicitly                                           | A       |
| `parseAutoimplementSettings`                                                                   | 374-389                                               | Require and validate `forge` and `prTiming`                                                                                                            | A       |
| `publicationTiming` (new, near `autoimplementSettings`)                                        | 391-393                                               | `early` for `defaultBranch` workspaces, else `settings.prTiming`                                                                                       | C       |
| `forgeFor`, `forgeResolution` (new)                                                            | near 532-545                                          | Read the recorded `resolveForge` output; `github` when absent                                                                                          | A       |
| `ReviewCommandSelection`                                                                       | 440-444                                               | `repositories: CandidateRepository[]`                                                                                                                  | C       |
| `PROMPT_ECHO_STEP_NODES`, `controlEvidenceLedger`                                              | 560-579                                               | Skip `resolveForge` in the ledger (`CONTROL_LEDGER_SKIPPED_NODES`)                                                                                     | A       |
| `decidePrompt`                                                                                 | 613-644                                               | GitLab-only `decideLine` (B); `end`-only timing line (C)                                                                                               | B, C    |
| `CONTROL_ATTEMPT_NODES`                                                                        | 662-695                                               | Add `commitLocal`, `verifyP2Local`                                                                                                                     | C       |
| `resultRoutes`                                                                                 | 813-946                                               | `publicationResult` (877-881), `reviewResult` reuse and clean (886-888, 894), `p2Result` (900-904), new `commitLocal` and `verifyP2Local` failure rows | C       |
| `parsePublishedForContext`                                                                     | 1160-1174                                             | GitLab MR URL check (B); `publishReviewed` head binding (C)                                                                                            | B, C    |
| `currentPublishedRepositories`                                                                 | 1176-1178                                             | No code change; add a comment that it lists only pushed records                                                                                        | C       |
| `parseP2Verification`                                                                          | 1298-1334                                             | Unchanged; add `parseLocalP2Verification` next to it                                                                                                   | C       |
| `parseCiInspectionForPublished`                                                                | 1336-1363                                             | Pass a forge binding with the published branch per id                                                                                                  | A       |
| `selectReviewCommands`                                                                         | 1431-1449                                             | Read the latest `publish` or `commitLocal` record                                                                                                      | C       |
| `resultSummary`                                                                                | 1581-1593                                             | Use `forgeText(...).summaryResults`                                                                                                                    | B       |
| `workflowSettings({...})`                                                                      | 1600-1621                                             | `initial`, `paths`, `validateChange`, `description`                                                                                                    | A       |
| node `resolveForge` (new)                                                                      | after 1727-1732                                       | Action with an idempotent effect                                                                                                                       | A       |
| node `implement`                                                                               | 1782-1803                                             | Forge inspect line (B); `end` no-push line (C)                                                                                                         | B, C    |
| node `routeVerifiedWorkspace`                                                                  | 1823-1828                                             | `settingsRoute` with four routes                                                                                                                       | C       |
| node `publicationResult`                                                                       | 1829-1831                                             | Add `commitLocal` source                                                                                                                               | C       |
| node `finalizeDefaultBranch`                                                                   | 1832-1857                                             | Forge wording for the self-request line                                                                                                                | B       |
| node `fix`                                                                                     | 1858-1872                                             | `end` no-push line                                                                                                                                     | C       |
| node `publish`                                                                                 | 1876-1895                                             | Forge prompt lines (B); `publishReviewed` variant (C)                                                                                                  | B, C    |
| node `commitLocal` (new)                                                                       | after 1876-1895                                       | Agent and async validator                                                                                                                              | C       |
| node `addressP2`                                                                               | 1956-1968                                             | `end` no-push line                                                                                                                                     | C       |
| node `routeAddressedP2` (new)                                                                  | after 1956-1968                                       | Compute `push` or `local`                                                                                                                              | C       |
| node `verifyP2`                                                                                | 1969-1982                                             | Forge wording; prompt becomes `(context) => ...`                                                                                                       | B       |
| node `verifyP2Local` (new)                                                                     | after 1969-1982                                       | Agent and validator                                                                                                                                    | C       |
| node `p2Result`                                                                                | 1983-1985                                             | Sources `verifyP2`, `verifyP2Local`                                                                                                                    | C       |
| nodes `inspectComments`, `inspectCi`, `repairCiCommand`, `assessTrackedCi`, `finalizeDelivery` | 1986-1999, 2003-2017, 2054-2066, 2067-2082, 2100-2118 | Forge prompt bodies; GitLab API coordinates; canonical glab tracking command                                                                           | B       |
| node `prepareCompleted`                                                                        | 2134-2160                                             | Forge `ci.reason` (B); `verifyP2Local` verification fallback (C)                                                                                       | B, C    |
| edge `prepare -> observe`                                                                      | 2172                                                  | Replace with `prepare -> resolveForge -> observe`                                                                                                      | A       |
| edge `routeVerifiedWorkspace`                                                                  | 2201-2207                                             | Cases `pullRequest`, `publishReviewed`, `commitLocal`, `defaultBranch`                                                                                 | C       |
| edge `addressP2`                                                                               | 2263-2269                                             | `ok -> routeAddressedP2`                                                                                                                               | C       |
| edges for `commitLocal`, `routeAddressedP2`, `verifyP2Local` (new)                             | after 2276                                            | `$result.outcome` switches with `timed_out`/`failed -> observe`; `$.route` switch                                                                      | C       |

### Other source, fixture, and documentation paths

| Path                                                            | Symbol                                                                       | Lines                                                    | Change                                                                                                                           | WP                            |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `src/builtins/autoimplement-forge.ts`                           | new module                                                                   | new                                                      | Forge types, remote parsing, YAML host scanners, `detectForge`, IO wrapper, `parseForgeResolution`, `parseGitLabMergeRequestUrl` | A                             |
| `src/builtins/autoimplement-config.ts`                          | new module                                                                   | new                                                      | `PrTiming`, defaults schema, path, parser, synchronous loader                                                                    | A                             |
| `src/state/config-dir.ts`                                       | `workflowsConfigDir`                                                         | new                                                      | Shared config-directory resolution                                                                                               | A                             |
| `src/state/index.ts`                                            | exports                                                                      | 1-30                                                     | Export `workflowsConfigDir`                                                                                                      | A                             |
| `src/channels/config.ts`                                        | `decisionConfigDir`                                                          | 39-41                                                    | Delegate to `workflowsConfigDir`                                                                                                 | A                             |
| `src/builtins/autoimplement-command-batches.ts`                 | `parseCiInspectionBatch`                                                     | 119-180                                                  | Optional `bindingFor` parameter                                                                                                  | A                             |
| same                                                            | `parseCiCommand`                                                             | 182-213                                                  | Optional `binding`; GitLab grammar and normalization                                                                             | A                             |
| same                                                            | `FORBIDDEN_VERIFICATION_EXECUTABLES`, `formatVerificationCommandSafetyRules` | 252-291                                                  | Add `glab`; add the GitLab CLI sentence                                                                                          | A                             |
| same                                                            | `PublishedRepository`                                                        | 16-24                                                    | Extract `CandidateRepository` (without `pr`); `PublishedRepository = CandidateRepository & { pr }`                               | C                             |
| same                                                            | `parseLocalCommitRepositories` (new)                                         | after 65-106                                             | Shares the per-entry parser with `parsePublishedRepositories`; avoid copied blocks                                               | C                             |
| same                                                            | `reviewerCommand`                                                            | 108-117                                                  | Parameter type `CandidateRepository`                                                                                             | C                             |
| `src/builtins/autoimplement-forge-text.ts`                      | new module                                                                   | new                                                      | `forgeTerms`, `forgeText`, `gitlabApiCoordinates`                                                                                | B (C adds `publish.reviewed`) |
| `src/builtins/autoimplement-review-gate.ts`                     | new module                                                                   | new                                                      | State predicates                                                                                                                 | C                             |
| `src/builtins/index.ts`                                         | exports                                                                      | 13-20                                                    | Export types `ForgeRequest`, `PrTiming` (as `AutoimplementForgeRequest` and `AutoimplementPrTiming`)                             | A                             |
| `src/builtins/catalog.ts`                                       | registrations                                                                | 17, 38                                                   | `autoimplement` to `"15"`, `monitor` to `"14"`                                                                                   | A                             |
| `src/builtins/metadata.ts`                                      | `BUILTIN_WORKFLOW_METADATA`                                                  | 5, 8                                                     | Same revisions                                                                                                                   | A                             |
| `src/builtins/monitor.workflow.ts`                              | `implementation` include                                                     | 805-836                                                  | No change; verified by a test                                                                                                    | A (test only)                 |
| `fixtures/layout/example-autoimplement.json`                    | golden layout                                                                | whole file                                               | Regenerate with `npm run fixtures`                                                                                               | A, C                          |
| `test/global-setup.ts`                                          | `setup`, `teardown`                                                          | 12-37                                                    | Point `GH_CONFIG_DIR` and `GLAB_CONFIG_DIR` at nonexistent temp subdirectories; save, unset, and restore `GITLAB_HOST`           | A                             |
| `test/helpers/autoimplement-fixtures.ts`                        | new helper                                                                   | new                                                      | Shared temp repository, fake `pi-reviewer`/`gh`/`glab`, settings, and scripted executors for the new test files                  | A                             |
| `test/builtin-autoimplement.test.ts`                            | settings literals                                                            | 390, 399, 1105, 1199, 1271, 1289, 1321, 1400, 1472, 1513 | Add `forge: "auto", prTiming: "early"` to these settings fixtures. This is a fixture-only edit and no assertion changes.         | A                             |
| `test/catalog.test.ts`                                          | revisions                                                                    | 21-22                                                    | `"15"`, `"14"`                                                                                                                   | A                             |
| `test/loader.test.ts`                                           | monitor revision                                                             | 145                                                      | `"14"`                                                                                                                           | A                             |
| `docs/WORKFLOWS.md`                                             | Autoimplement paragraphs                                                     | 744-764                                                  | New forge and timing sections; update the review (758) and CI (760) paragraphs                                                   | A, B, C                       |
| `skills/autoimplement/SKILL.md`                                 | input rules, outside-Pi steps                                                | 15-32, 98-146                                            | `forge` and `prTiming` field rules; GitLab CLI in the forbidden list; GitLab and `end` notes                                     | A, B, C                       |
| `README.md`                                                     | built-in list                                                                | 399-404                                                  | Mention GitLab and `prTiming`                                                                                                    | B, C                          |
| `test/package-resources.test.ts`, `test/bundled-skills.test.ts` | pinned skill text                                                            | 167-179; 15-50                                           | Existing pins unchanged; add pins for the new field rules                                                                        | A, C                          |

## Test plan

All automated tests use temporary directories, fake executables on `PATH`, and `ScriptedExecutor`.
They make no network calls and call no real models. Branch coverage is currently 85.57%, so every
new branch below needs its own case.

### `test/autoimplement-forge.test.ts` (new, A)

These tests cover the pure functions with no IO.

- `parseRemoteHost` cases:
  - `git@github.com:o/r.git`, `ssh://git@github.com/o/r.git`, `git+ssh://git@host/o/r`,
    `https://github.com/o/r.git`, `http://h/x/y`, `git://h:9418/x/y`;
  - `ssh://git@gitlab.example.com:2222/g/p.git` gives port 2222;
  - `https://[::1]:8443/g/p` handles IPv6;
  - an uppercase host is lowercased;
  - `/abs/repo.git`, `./rel`, `file:///x`, and an empty string give `null`.
- `redactRemoteUrl` strips `https://oauth2:TOKEN@host/...` and `ssh://user:pw@host/...`, and leaves
  `git@host:g/p.git` unchanged.
- `parseGhHostsYaml` finds `github.com` and `ghe.example.com`, and ignores comments, nested keys, and
  blank lines.
- `parseGlabHostsYaml` reads a fixture that mirrors the local file. The file has `code.aws.dev` with
  `api_host` and `ssh_host`, a bare `gitlab.com:` entry, and keys such as `git_protocol` and `token`.
  The test checks that the output never contains a token value, and handles quoted keys and
  `host:8443` keys.
- `detectForge`, one test per row of the precedence table:
  - github.com and gitlab.com remotes;
  - `git@ssh.code.aws.dev:g/p.git` matched through `ssh_host` gives `gitlab` with host `code.aws.dev`;
  - `git@code.aws.dev:g/p.git` matched through the key;
  - an `api_host` match;
  - a `host:port` key compared with a remote on another port;
  - a GHES host from gh hosts;
  - a host in both files gives `github` with an ambiguity reason;
  - `GITLAB_HOST` given as a URL and as a bare host;
  - an unknown host, no remote, and a local remote;
  - explicit `github` and `gitlab` against a contrary remote.
- `readForgeFacts` and `resolveForge` with an injected `ForgeIo`:
  - `origin` present;
  - `origin` missing with another remote present, which uses the first remote;
  - no remotes;
  - `git` throws;
  - `GH_CONFIG_DIR`, then `XDG_CONFIG_HOME`, then home for gh;
  - `GLAB_CONFIG_DIR`, then home, then XDG for glab, with the first file found winning;
  - an explicit request performs zero IO calls;
  - an IO error becomes a `github` resolution with a reason.
- One `resolveForge` test runs real `git` against a temporary repository with
  `git remote add origin git@gitlab.example.test:g/p.git`, with env pointing to a temporary
  `GLAB_CONFIG_DIR`.
- `parseForgeResolution` rejects a wrong schema, a bad enum, and missing fields.
- `parseGitLabMergeRequestUrl`:
  - accepts subgroups and a host with a port;
  - rejects `http:`, a missing `/-/`, `iid` 0, a leading zero, a query, a fragment, `/diffs`, a
    single-segment project, and a segment that starts with `-`;
  - derives `projectUrl` and `apiProject` (`group%2Fsub%2Fproject`).

### `test/autoimplement-config.test.ts` (new, A)

- A missing file gives `{}`, and `parseInput` then returns `auto` and `early`.
- A valid file with `{ schema, forge: "gitlab", prTiming: "end" }` is applied.
- Input values override the file, separately for each field.
- These are rejected, and each message names the file path:
  - an unknown key;
  - a missing or wrong `schema`;
  - an invalid `forge` or `prTiming`;
  - invalid JSON;
  - a top-level array;
  - `EISDIR` (the path is a directory).
- A fully explicit input does not read the file; a `readText` spy confirms it.
- `PI_WORKFLOWS_CONFIG_DIR` is respected. Without it, the default is `<home>/.config/pi-workflows`,
  checked through `workflowsConfigDir` with an injected env.
- `decisionConfigDir` still returns the configured or default directory, and the existing test stays
  unchanged.
- Idempotence: `parseInput(parseInput(x))` deep-equals `parseInput(x)`, including after the file is
  rewritten between the two calls.
- Monitor: running the `implementation` include entry, with a config file that sets `prTiming: end`,
  normalizes the child input to `prTiming: "end"`.

### `test/autoimplement-command-batches.test.ts` (A; existing cases unchanged)

- Add every GitLab accept and reject row from the [CI allowlist](#ci-allowlist-and-binding) table.
- Add `glab` on a GitHub binding and `gh` on a GitLab binding.
- `parseCiInspectionBatch` with a GitLab `bindingFor` normalizes a pending target. A GitLab target
  whose `pr` is not an MR URL is rejected.
- `validateVerificationCommandSafety("glab", [], "check")` throws. So does
  `/usr/local/bin/glab`.
- `formatVerificationCommandSafetyRules()` contains both the old Git/GitHub sentence and the new
  GitLab sentence.
- C adds: `parseLocalCommitRepositories` accept and reject cases (`committed` missing or false, a
  relative path, a duplicate, a `pr` present), and `reviewerCommand` with a `CandidateRepository`.

### `test/builtin-autoimplement-settings.test.ts` (new, A)

- `resolveInitialWorkflowSettings` with normalized input carries `forge` and `prTiming` over.
- `/forge` replace is rejected for `session`, `human`, and `resource_manager`.
- `/prTiming` from `end` to `early` is accepted for `human` and rejected for `session` (path rule).
- `/prTiming` from `early` to `end` is rejected for `human` (`validateChange`).
- A patch that sets an invalid `prTiming` is rejected by the parser.
- A settings value missing either field is rejected.
- The merge rules are unchanged and still pass.

### `test/builtin-autoimplement-forge.test.ts` (new, B; A adds the graph-shape cases)

Graph shape (A):

- `prepare -> resolveForge -> observe`.
- `resolveForge` is an action with an `idempotent` effect.
- It is not in the decide ledger: a run's first decide prompt has no `resolveForge` entry.
- `forgeFor` returns `github` when the output is absent.

The GitHub golden test (B) is written **before** the refactor, against HEAD `2cb8ab3`, and must pass
unchanged afterwards.

- A fixed synthetic context renders the prompts of `implement`, `finalizeDefaultBranch`, `publish`,
  `verifyP2`, `inspectComments`, `inspectCi`, `repairCiCommand`, `assessTrackedCi`, `finalizeDelivery`
  (with merge true and false), `resultSummary`, and `decide`.
- The test compares each prompt to a literal string.
- It also compares every node's `expectedOutput` and `statusDetail` to literals.

GitLab prompts (B):

- They contain "merge request" and `glab api --hostname`, and contain neither "pr-description" nor
  "pull request".
- `inspectCi` lists the canonical glab command per target.
- `inspectComments` names the discussions, reply, and resolve endpoints with `apiProject`.
- `finalizeDelivery` includes the rule that a merge is only real once the state reads `merged`.

GitLab validators (B):

- `publish` rejects a GitHub-style URL on GitLab and accepts an MR URL.
- GitHub still accepts `https://example.test/pr/1`.

Graph runs for `github` x `early`. These capture the upstream node sequence first.

- Run the P2 path and the P1 path from the existing tests.
- Assert that the `nodeId` sequence, without `resolveForge` and `routeAddressedP2`, equals the
  recorded upstream sequence.

Graph runs for `gitlab` x `early` (explicit `forge: "gitlab"`, plus one `auto` run with a remote and
a temporary `GLAB_CONFIG_DIR`):

- `publish` runs before the first `runReview`.
- `inspectCi` is pending with `glab ci status --live`, and `trackCi` runs the fake `glab`.
- The log shows `ci status --live --branch feat/demo --repo https://gitlab.example.test/group/project`.
- `finalizeDelivery` completes with the MR URL.

### `test/autoimplement-review-gate.test.ts` (new, C)

Synthetic step arrays exercise every predicate.

- Every row of the scenario table in [State predicates](#state-predicates).
- Failed and timed-out `fix` or `addressP2` steps count as edits.
- A failed `commitLocal` is ignored.
- Reuse of an earlier clean review of the same identity passes the gate.
- A dependency fingerprint mismatch fails the gate.
- A critical review fails the gate.
- A `verifyP2Local` step with `passed: false` fails the gate.
- A `p2VerifiedHeads` entry needs a P2-only parent review.
- `gateHeadPushed` is true for `publish` and `verifyP2`, and false for `commitLocal` and
  `verifyP2Local`.

### `test/builtin-autoimplement-pr-timing.test.ts` (new, C)

Route availability, using the observe node with synthetic contexts (the same pattern as
`test/builtin-autoimplement.test.ts:1460-1520`):

- every row of the `resultRoutes` table, for both timings;
- `publicationResult` without `publishReviewed` keeps the upstream routes;
- `routeVerifiedWorkspace` gives all four routes, and `defaultBranch` wins over `end`;
- `routeAddressedP2` gives `push` and `local`.

The graph runs below cover `github` and `gitlab`, each with `end`. Each run lets
`chooseFirstControlRoute` pick the controller route and uses fake `pi-reviewer`, `gh`, and `glab`.

- **Happy path.**
  - Step order: `commitLocal` comes before the first `runReview`.
  - No `publish` or `verifyP2` step appears before the first `reviewResult` whose result route is
    `clean`.
  - Exactly one `publish` step completes, and its `headRevision` equals the `commitLocal` head.
  - Afterwards `publicationResult` offers `comments` first.
- **P1 path.** Two `assessReview` rounds and two `commitLocal` steps happen before the single
  `publish`.
- **P2 path.**
  - `verifyP2Local` runs and `verifyP2` does not.
  - There is one `publish`, with the `verifyP2Local` head, and no second review.
- **Fix after the MR exists.** This uses the `comments` route `fix`.
  - There are exactly two `publish` steps, with the same `pr`.
  - Each one comes after a clean review of the same head that was recorded after the previous
    publish.
- **Mismatched head.** A `publish` under `publishReviewed` that reports another head fails
  validation. The outcome is `failed`, the run returns to `observe`, and the next observation offers
  `publication`.
- **Mid-run change from `end` to `early`.** A `human` actor changes the setting through
  `WorkflowRunStore.changeSettings` during the scripted `assessReview` response, following the pattern
  of `test/workflow-settings-store.test.ts:296-330`. The run completes with one `publish`, and the
  setting change is recorded.
- **`defaultBranch` with `prTiming: end`.** `finalizeDefaultBranch` runs, and `commitLocal` never
  does.
- **`commitLocal` validator.** It rejects a wrong HEAD and a wrong branch. It also rejects a dirty
  path outside `preExistingChangedPaths`. It accepts the real HEAD of the fixture.
- **Edges.** `commitLocal`, `verifyP2Local`, and the `addressP2` changes have `timed_out` and
  `failed` edges to `observe` and no `cancelled` edge. This matches
  `test/builtin-autoimplement.test.ts:2314-2357`.

### Existing suites

- They stay unchanged except for the fixture edits listed under [Touched paths](#touched-paths).
- `test/layout-fixtures.test.ts` passes after `npm run fixtures`.
- `test/package-resources.test.ts` and `test/bundled-skills.test.ts` gain pins for:
  - the `` `forge` `` rule;
  - the `` `prTiming` `` rule;
  - "GitLab CLI" in the forbidden list.

## Work packages

The packages run in order: A, then B, then C. Each package leaves `npm run check`, `npm run test:e2e`,
`npx slophammer-ts@latest dry .`, and
`npx slophammer-ts@latest check . --only ts.dependency-boundaries-required` green. Each one updates
the docs for what it ships. A package hands off its branch head and the run of these commands to the
next. B and C both edit `autoimplement.workflow.ts`, so they must not run in parallel. The new test
files are what keep file overlap low.

### A: forge module, input, config, settings, `resolveForge`, CI allowlist

Files:

- new `src/builtins/autoimplement-forge.ts`;
- new `src/builtins/autoimplement-config.ts`;
- new `src/state/config-dir.ts`, `src/state/index.ts`, and `src/channels/config.ts`;
- `src/builtins/autoimplement-command-batches.ts` (CI binding, forbidden list);
- `src/builtins/autoimplement.workflow.ts`: types, `parseInput`, settings, `forgeFor`, the
  `resolveForge` node and edges, the ledger skip, and the binding in `parseCiInspectionForPublished`;
- `src/builtins/index.ts`, `catalog.ts`, and `metadata.ts`;
- `test/global-setup.ts` and the new `test/helpers/autoimplement-fixtures.ts`;
- the new test files `test/autoimplement-forge.test.ts`, `test/autoimplement-config.test.ts`, and
  `test/builtin-autoimplement-settings.test.ts`;
- additions to `test/autoimplement-command-batches.test.ts`;
- the fixture-only edits in `test/builtin-autoimplement.test.ts`, `test/catalog.test.ts`, and
  `test/loader.test.ts`;
- `fixtures/layout/example-autoimplement.json`;
- `docs/WORKFLOWS.md` (forge selection and config sections, the verification rule);
- `skills/autoimplement/SKILL.md` (the `forge` and `prTiming` field rules and the forbidden list) and
  its pinned tests.

Before editing anything, record the golden upstream node sequences and GitHub prompt literals that B
needs. Do this in the new `test/builtin-autoimplement-forge.test.ts`, against unmodified HEAD.

Acceptance:

- All forge, config, settings, and CI allowlist tests listed above pass.
- `prepare -> resolveForge -> observe` is pinned by a test.
- Existing tests pass with only the listed fixture edits.
- In a temporary repository with an `ssh.code.aws.dev`-style remote and a `glab` config fixture,
  `resolveForge` records `gitlab`.
- `prTiming` is accepted and stored, but has no routing effect until C. The docs say so until C
  lands.

### B: forge-aware prompts, parsers, and GitLab MR URLs

Files:

- new `src/builtins/autoimplement-forge-text.ts`;
- `src/builtins/autoimplement.workflow.ts`: the prompt bodies of `implement`,
  `finalizeDefaultBranch`, `publish` (early), `verifyP2`, `inspectComments`, `inspectCi`,
  `repairCiCommand`, `assessTrackedCi`, and `finalizeDelivery`, plus `resultSummary`, the GitLab line
  in `decidePrompt`, the `ci.reason` in `prepareCompleted`, and the MR URL check in
  `parsePublishedForContext`;
- `test/builtin-autoimplement-forge.test.ts`: the GitLab prompt, validator, and graph-run cases;
- `docs/WORKFLOWS.md` (GitLab paragraph, updated CI paragraph), `README.md`, and
  `skills/autoimplement/SKILL.md` (GitLab notes in the outside-Pi steps).

Acceptance:

- The GitHub golden prompts recorded in A are byte-identical.
- GitLab prompts contain no "pull request" and no "pr-description".
- The `github` x `early` and `gitlab` x `early` graph runs pass.
- The fake `glab` log shows the canonical bound command.
- The layout fixture is unchanged, since B changes no static strings or structure.

### C: `prTiming=end` routing

Files:

- new `src/builtins/autoimplement-review-gate.ts`;
- `src/builtins/autoimplement-command-batches.ts`: `CandidateRepository`,
  `parseLocalCommitRepositories`, and the `reviewerCommand` type;
- `src/builtins/autoimplement.workflow.ts`:
  - `publicationTiming`;
  - `routeVerifiedWorkspace` as a `settingsRoute`;
  - the new nodes `commitLocal`, `routeAddressedP2`, and `verifyP2Local`, with their edges;
  - the `publicationResult`, `p2Result`, and `selectReviewCommands` sources;
  - the `resultRoutes` rows and `CONTROL_ATTEMPT_NODES`;
  - the `publish` `publishReviewed` variant and validator;
  - the lines that apply only under `end`;
  - the `prepareCompleted` fallback;
- `src/builtins/autoimplement-forge-text.ts`: the `publish.reviewed` lines;
- the new test files `test/autoimplement-review-gate.test.ts` and
  `test/builtin-autoimplement-pr-timing.test.ts`;
- the `CandidateRepository` and local-commit additions to
  `test/autoimplement-command-batches.test.ts`;
- `fixtures/layout/example-autoimplement.json` (regenerated);
- `docs/WORKFLOWS.md` (the publication timing section, the review paragraph), `README.md`, and
  `skills/autoimplement/SKILL.md` (the `prTiming` behavior) and its pinned tests.

Acceptance:

- Every test in the C sections above passes.
- The `github` x `early` sequence check recorded in A still passes, which proves `early` is
  unchanged.
- Under `end`, no push node runs before a clean `reviewResult`, and the happy path has exactly one
  `publish`.
- The `defaultBranch` workspace mode ignores `prTiming`.
- The live E2E in [Validation](#validation) passes.

## Documentation

- **`docs/WORKFLOWS.md`.** Add new subsections under "Built-in planning and implementation", after
  line 760. The AGENTS.md rule that every new engine feature needs a WORKFLOWS.md section requires
  them.
  - **"Autoimplement forge selection"** (A, B) covers:
    - the `forge` values, the detection order, and what is stored in `resolveForge`;
    - the GitLab flow through `glab api` and the MR URL shape;
    - the static-text caveat (O2).
  - **"Autoimplement defaults file"** (A) covers:
    - the path, schema, keys, and precedence;
    - that a restart reads the file again, while a resume does not;
    - that the file is read in the server runner's environment.
  - **"Autoimplement publication timing"** (C) covers:
    - `early` versus `end`, `commitLocal`, the review gate, and the P2 exception;
    - the single PR or MR;
    - that `defaultBranch` ignores the timing;
    - that a mid-run change from `end` to `early` needs a `human` actor.
  - Update line 758: reviewer commands are tied to the reviewed head, which is pushed under `early`
    and committed locally under `end`.
  - Update line 760: add the GitLab `glab ci status --live` binding.
  - Add the GitLab CLI to the verification rule at line 750.
- **`skills/autoimplement/SKILL.md`.**
  - **Field rules.** Add rules for both new fields.
    - `forge`: omit it unless the user names a forge. The safe default is the config file or `auto`.
    - `prTiming`: omit it unless the user asks to publish only after review. Then use `end`. The safe
      default is the config file or `early`.
    - Leave both out of the JSON example, so that copying the example never overrides the config
      file.
  - **Scope wording.** It already names pull-request actions. Add "merge request" next to them for
    GitLab.
  - **Line 25.** Add "GitLab CLI" to the forbidden list.
  - **Outside-Pi steps.** In steps 3 to 6:
    - Add a GitLab note: use `glab` and merge requests.
    - Add an `end` note: keep commits local until pi-reviewer passes, then push once.
  - **Unchanged.** Keep the active-workflow guard and every pinned sentence.
- **`README.md:399-404`.** Add one sentence: "Works with GitHub (`gh`) and GitLab (`glab`), and
  `prTiming: end` publishes once after review passes."
- **Monitor (`docs/MONITOR.md`).** No change. Monitor repairs inherit the defaults file.

## Validation

Run these before each package hands off. This is AGENTS.md's required sequence:

```bash
npm run check      # oxfmt, oxlint --deny-warnings, tsc, build, vitest with coverage >= 85% on every metric
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npm run fixtures   # A and C; commit the regenerated fixture
```

The gates have these constraints:

- There are no type suppressions: no `@ts-ignore`, `@ts-expect-error`, or `as any` used to silence
  errors.
- The gitlab and github sentence tables must share their common lines, so that `slophammer dry`
  stays at 0.

Live validation is manual and separate from the automated tests. It must use an exact low-cost
model.

1. Run `npm run test:e2e:live -- --provider openai --model gpt-5.6-luna`, or
   `--provider openrouter --model deepseek/deepseek-v4-flash`. This is the required real-model run.
2. With explicit owner authorization, and only on a **disposable** GitLab project and branch on
   `code.aws.dev`, run one Autoimplement through Pi using the same model:
   - set `merge: false`, `prTiming: end`, and `forge: auto`;
   - check that `resolveForge` records `gitlab` through `ssh_host`;
   - check that no push happens before the clean review;
   - check that exactly one MR exists and that the bound `glab ci status --live` watch ran.

   Also run one GitHub `early` smoke on a disposable repository. These runs push to real remotes, so
   they need explicit authority, and they are not part of `npm run check`.

**Live E2E waived for the F11-F14 branch.** The human waived step 1 for
`fix/autoimplement-end-timing-f11-f14`, because no run could reach a model on this host:

- run 1 (`--provider openai --model gpt-5.6-luna`) completed the model-free workflow, then failed
  with `Provider is not configured: openai` (`/tmp/livee2e-f11f14.log`);
- run 2 (`--provider openrouter --model deepseek/deepseek-v4-flash`) failed before any model call,
  on the paused-status check: "Timed out waiting for the paused Pi workflow widget and status"
  (`/tmp/livee2e-f11f14-or.log`, F42);
- run 3 (the same openrouter model) completed the model-free workflow, then failed with
  `Provider is not configured: openrouter` (`/tmp/livee2e-f11f14-or2.log`).

The livee2e and livee2e2 agent results record the details. No real-model live E2E has verified
this branch.

## Risks and open issues

### Owner decisions (2026-10-11)

The owner resolved the open issues as follows. These decisions override any conflicting text
elsewhere in this plan.

- **`glab api` is approved.** Use `glab api` REST calls, with glab's own auth, to list, reply to,
  and resolve MR discussions and to look up MRs. Use plain `glab` subcommands (`mr create`,
  `mr merge`, `mr list`, `mr view`, `ci status`) where they exist on the old local build.
- **O1: accept and track F2.** Implement the `end` to `early` rule for a `human` actor, and unit-test
  it. Do not change the server, resolver, or extension settings plumbing in this work.
- **O2: use forge-neutral static text.** Rewrite the static `statusDetail` and `expectedOutput`
  strings that name a forge so they read correctly on both forges. For example, use "checking PR/MR
  comments", and give an `inspectCi` example that allows `gh` or `glab`. This is a cosmetic change
  to GitHub's static text only. GitHub prompt bodies stay byte-identical. Routing and behavior stay
  unchanged. Package B makes this change and regenerates the layout fixture, which updates B's
  acceptance criterion "layout fixture unchanged". F6 is no longer needed for wording.
- **O3: forbid `glab` everywhere.** This is the accepted safety tightening.
- **Live validation.** Drop step 2 of [Validation](#validation): a disposable GitLab or GitHub
  run that pushes or opens an MR or PR. The goal forbids live MR or PR creation. The real-model
  `test:e2e:live` run in step 1 stays required, because AGENTS.md requires one real-model live E2E
  with a low-cost model. An earlier version of this note called it optional, which was wrong. It
  ran once on fork main 7d3f478:
  `npm run test:e2e:live -- --provider amazon-bedrock --model us.openai.gpt-5.6-luna` exited 0
  with `result: passed` and `modelCostUsd` 0.0041 (log `/tmp/fpt-live-e2e.log`). The other live
  check is read-only: `glab mr list` against a code.aws.dev repository.

### Open issues

- **O1: settings actor plumbing (decision 2).**
  - **Evidence.**
    - Every Pi-session settings change is recorded as `session` (`src/server/server.ts:2075`).
    - The resolver validates every proposal as `resource_manager`
      (`src/server/resolver-entry.ts:121-127`).
    - Autoimplement's path rules allow only `session` and `human` (`AI:1603-1614`).
    - The extension's `human` flag (`src/extension/index.ts:388`) is never forwarded for
      `change-settings` (`:1034-1053`).
  - **Consequence.**
    - Today a Pi session cannot change any Autoimplement setting.
    - After this plan, `prTiming` from `end` to `early` is accepted only for a `human` actor, and no
      server path produces one yet.
    - The behavior is implemented and unit-tested, but cannot be reached through the server.
    - Merge grants have the same limitation today.
  - **Owner decision needed.** Either accept this and track follow-up F2, which forwards authority
    and validates with the real actor, or widen `/prTiming` replace to `session`. Widening
    contradicts the stated preference.
- **O2: static `statusDetail` and `expectedOutput` (decision 4).**
  - **Evidence.** These fields are static on the node definition (`src/workflows/types.ts:104,143`)
    and are part of the definition digest (`src/workflows/store.ts:5130-5146`).
  - **Consequence.** Several strings still show GitHub wording on GitLab:
    - the status line text "checking PR comments" and "finalizing PRs";
    - the `inspectCi` `expectedOutput`, which shows `"command": "gh"`.
    - The GitLab prompt body states the exact `glab` command to use instead.
  - **Alternatives.** Making these fields dynamic is an engine change: snapshot, viewer, and widget.
    Duplicating nodes per forge cannot work for `inspectCi`, because `dispatch` must keep targeting
    `inspectCi`.
  - **Owner decision needed.** Accept the prompt override, or schedule engine support (F6).
- **O3: early prompt identity.** Adding `glab` to the verification rules changes the
  change-verification planner prompt on GitHub runs too. The decisions require this as a deliberate
  tightening. It is the one exception to "GitHub prompt strings byte-identical".
- **O4: resume refusal.** Bumping the `autoimplement` and `monitor` revisions refuses to resume
  unfinished runs from 0.17.7, with the cancel-and-restart guidance. This follows the alpha policy.

### Risks

- **The watch may follow the wrong pipeline.** `glab ci status --live --branch` watches the newest
  pipeline of the branch. Merged-results and detached MR pipelines can differ from it (glab research,
  item 4).
  - The watch only decides when to look again. `assessTrackedCi` and the next `inspectCi` read the
    MR's `head_pipeline` through REST.
  - Newer `glab` offers `ci get --merge-request`, but the local build lacks it (F4).
- **Watch output can run long.** On old `glab`, the `--live` output without a TTY may print repeated
  frames and ANSI codes (R2).
  - The 1,000,000-character cap could truncate the output, which routes to `repairCiCommand`. If it
    keeps happening, the no-progress limit blocks the run.
  - Measure this in the live E2E.
  - `NO_COLOR` cannot be set until F1 lands.
- **The watch exit code is not the verdict.** `glab ci status` exits 0 for canceled, skipped, and
  manual pipelines (R1). Routing never relies on that exit code; the assessment agent decides.
- **Detection can fall back to GitHub.** Detection runs in the server runner's environment, which
  supplies `HOME`, `GH_CONFIG_DIR`, `GLAB_CONFIG_DIR`, and `GITLAB_HOST`.
  - A server that started with another environment may detect differently.
  - SSH aliases from `~/.ssh/config` are not resolved.
  - In both cases detection falls back to `github`, and the run records the reason. The workaround
    is an explicit `forge`, or one in the config file.
- **GitHub is not inferred from a missing `gh`.** If a self-managed GitHub host is missing from gh
  hosts and absent from glab hosts, the result is still `github`, which is correct.
- **What pi-reviewer sees is unverified.** Whether `pi-reviewer --base` reads uncommitted changes is
  unknown, because it is an external tool. `commitLocal` requires every task change to be committed,
  and the proposed validator checks this. That makes the committed head and the working tree agree,
  so both readings review the same content.
- **Local commits must not be rewritten.** Under `end`, local commits before the first push are fine
  to rewrite. After the first push, prompts forbid amending pushed commits and forbid force pushes.
  The validator checks the head only, not ancestry. F5 adds a `merge-base --is-ancestor` check.
- **Projects without CI.** GitLab projects with no pipelines can lead to `unavailable`, and then to
  `blocked`. GitHub repositories without checks behave the same way today. This is unchanged.
- **Coverage and complexity.** The new branches are numerous. The test plan lists one case per
  branch. Split `resultRoutes` additions into small helpers, so the existing function does not grow
  past review.

## Follow-ups

These are out of scope for this plan.

- F1: Add an optional, allowlisted `env` field to `CommandBatchItem`:
  - validate it in `validateItem`;
  - pass it from `runItem` to `runShellAction`;
  - document it in WORKFLOWS.md.
  - Then use `GLAB_NO_PROMPT=1`, `NO_COLOR=1`, and `GLAB_CHECK_UPDATE=false` for `glab` watches.
- F2: Fix the settings actor plumbing:
  - forward the extension's `human` or `model` authority on `run.changeSettings`;
  - validate in the resolver with the real actor instead of `resource_manager`.
- F3: Extend forge detection to `GL_HOST`, `GITLAB_URI`, `~/.ssh/config` `HostName` aliases, and
  the per-repository `.git/glab-cli/config.yml`.
- F4: When `glab ci get --merge-request` is available, allow a watch bound to the MR (the head
  pipeline).
- F5: Program-verify that a push under `end` is a fast-forward of the previously pushed head.
- F6: Engine support for per-run `statusDetail` and `expectedOutput`, or a forge-neutral rewrite of
  those strings once GitHub byte identity is no longer required.
- F7: Make `sanity-check.workflow.ts` aware of the forge (`gh pr view` at `:202-214`, `origin/HEAD`
  at `:133`).
- F8: Make `examples/resource-managers/pull-request.resource-manager.ts` aware of the forge
  (`github-merge` at `:99`, the GitHub API accept header at `:201`).
- F9: Fix the stale `codex review` and "PR" text in `skills/autoimplement/agents/openai.yaml:3-4`.
  The workflow uses `pi-reviewer`. _(done)_
  - `default_prompt` now names `pi-reviewer --base <branch>`, and both fields name the pull
    request or merge request, as `skills/autoimplement/SKILL.md` does.
- F10: Detect a push before the review gate that bypasses the push destination's remote-tracking
  ref (review N3).
  - The gap: `assertNotPushedBeforeGate` (`src/builtins/autoimplement.workflow.ts`) reads only the
    `update by push` entries of `refs/remotes/<remote>/<branch>`. A push to a URL, to another
    remote, or to another branch name, followed by a fetch, leaves only a fetch entry. That looks
    like a commit someone else added, so the check accepts it.
  - Optional detection: also treat a fetched commit as a stray push when the local
    `refs/heads/<branch>` reflog shows that this clone created it during the run (a `commit`
    entry), and no publication of the run recorded it.
- F11: Use only the first fetch refspec that matches the branch (review N4).
  - Git maps `refs/heads/<branch>` through the first matching positive fetch refspec.
    `fetchRefspecTracks` (`src/builtins/workspace-preparation.workflow.ts`) accepts any match.
  - With `+refs/heads/feat/*:refs/remotes/origin/feat-alias/*` before
    `+refs/heads/*:refs/remotes/origin/*`, a push updates only `origin/feat-alias/<name>`, while
    the code trusts a stale `origin/feat/<name>`, so every reviewed publish fails.
  - Take the first positive refspec that matches and compare only its target. _(done)_
  - `fetchRefspecTracks` now skips negative refspecs and refspecs without a target, and compares only the first match's target.
- F12: Restore two no-reflog test cases (review N6) in "falls back to the ref value when Git keeps
  no reflog for it" (`test/builtin-autoimplement-pr-timing.test.ts`):
  - an accepted `verifyP2` as the newest published head;
  - a failed `publish` that does not count as a published head. _(done)_
  - Both cases are back in that test, which now also pushes a P2 commit without a reflog.
- F13: Keep a `verifyP2` push excused across a runner restart (review R1).
  - The gap: a P2 commit is unreviewed, so only its `verifyP2` attempt window excuses its push in
    `publicationPush` (`src/builtins/autoimplement.workflow.ts`). A resume marks the interrupted
    attempt `interrupted` in `node_attempts` and writes no `run_steps` record, so the window is
    lost. This was already true before the N2 fix.
  - Scenario: a `verifyP2` attempt pushes P2 commit P, then the runner restarts. The replacement
    `verifyP2` fails, the controller picks `repair`, and every later `commitLocal` is rejected.
  - Fix idea: also consult the windows of interrupted `node_attempts`, or record each attempt's
    start. _(done)_
  - The run state now derives `unrecordedAttempts` from `node_attempts`, and `publicationPush` excuses
    a push inside an unrecorded `verifyP2` attempt's window.
- F14: Use the reviewed-head excuse in the no-reflog fallback (review R2). Group it with F12.
  - The gap: when Git keeps no reflog for the ref, `assertNotPushedBeforeGate` compares the ref
    value with the last published head only and does not call `revisionPassesGate`.
  - Scenario: `core.logAllRefUpdates=false`. A reviewed publish pushes H and then fails or is
    lost. The `commitLocal` after the repair is rejected with "moved to H, a commit this run did
    not publish".
  - Fix: also accept when `revisionPassesGate(steps, id, tracking.headRevision)` holds. _(done)_
  - The no-reflog fallback now accepts a gate-passing ref value first; a new test covers a failed reviewed publish.
- F15: Skip the push check in `verifyP2Local` under `early` timing (review R3). Track it with F2.
  - The gap: `verifyP2Local` calls `assertNotPushedBeforeGate` even when `publicationTiming` is
    `early`.
  - Scenario: after a human end→early switch, a failed early publish pushes X. Then
    `verifyP2Local` rejects X and advises `blocked`, which is misleading under `early`.
  - Unreachable until F2 lets a person change `prTiming`.
  - Fix: skip the check when `publicationTiming(context) === "early"`.
- F16: Small consistency fixes from the review (R4, R5 nits):
  - the accepted-record rule in `publicationPush` does not compare `head.id`, unlike
    `revisionPassesGate`. This is harmless because the validators pin the run to the prepared
    workspace;
  - on a regression, the "end repair after a runner restart during the reviewed push" graph tests
    (`test/builtin-autoimplement-pr-timing.test.ts`) fail by the 30 s `GRAPH_RUN_TIMEOUT_MS`
    timeout rather than by an assertion.
- F17: Name both forges in the `prTiming` field rule of `skills/autoimplement/SKILL.md:30` (grep
  audit). It says `early` "opens the pull request before review" without the GitLab wording. Fix:
  "opens the pull request or merge request". _(done)_
- F18: Correct `docs/WORKFLOWS.md:858`. It says that after a failed push check "a person can move
  `prTiming` to `early`". That is not possible until F2 lands. _(done)_
  - The sentence now says the controller should choose `blocked`, and that moving `prTiming` to
    `early` is not available yet because no server path can record a `human` settings change. F2
    still has to land before a person can make that change.
- F19: Re-check built-in revisions when merging upstream.
  - The fork's built-in revision numbers (autoimplement 15, monitor 14, change-verification 3,
    autodoc 4, plan-change 2) equal upstream's next numbers.
  - If upstream reuses them for different content, mixed fork and upstream installs would silently
    accept each other's runs.
  - Re-check revisions when merging upstream.
- F20: Settle durable per-agent tracks after an action times out or is cancelled. _(done)_
  - The gap: the `agents/<group>/<id>` tracks stay `running`. This predates the resolver host-peer
    fix: `WorkflowEngine.publishUpdate` rejects updates once the attempt signal aborts
    (`src/workflows/engine.ts:168-177`), and the engine stops waiting for an aborted action
    (`src/workflows/engine.ts:1046`).
  - Fix: the engine finalizes progress for aborted attempts.
  - Done in `d522def` and `0eaabfe`: the engine and the queue's cancellation transaction give each
    open track of the ended attempt a final `failed` (`timed out`) or `cancelled` record.
  - Review fixes in `4941bd5` and `d61a63f`: the docs state the actual revision steps and the
    remaining limitations, and a real server test covers settlement after an action times out.
- F21: Revisit the 2,000-character agent error cap as a product decision. _(done)_
  - `MAX_ERROR_CHARS` (`src/builtins/pi-agent-launch.ts:59`, moved from
    `src/builtins/pi-agent-group.ts:30` at 2cb8ab3) comes from the Sanity Check privacy contract,
    not from a named external interface.
  - `PiAgentGroupError.detail` keeps the complete cause.
  - Done with option C in `56d24c5`, `1551281`, `d08e022`, `9de9ddc`, and `8ad0cfd`: agent errors
    carry only codes and Pi Workflows' own facts, plus the full path of a private `0600` cause
    file, and nothing is truncated. Command-batch errors state only the exit status, and the item
    keeps its complete stdout and stderr.
  - Second-round review fixes in `b530394`, `c4123be`, and `82bc63e`: pi cleanup and start
    failures keep the group's outcome, only the group runner's own agent errors keep visible
    facts, and a rejected complete-label update is retried.
- F22: Let Sanity Check agent groups use built-in providers and run offline. _(done)_
  - The gap: a group accepts only a provider that a user extension registers, and it needs that
    provider's `<agentDir>/models-store.json` entry, which Pi writes only after an online catalog
    refresh. Groups therefore fail with `PI_OFFLINE=1` (set in the user's `~/.zprofile`) and with
    providers built into Pi rather than registered by a user extension.
  - This predates the fix: `src/builtins/pi-agent-group.ts` at 2cb8ab3, lines 477 (user-scope
    candidates), 521-532 (extension-registered owner check), and 298 and 400-404
    (`models-store.json` snapshot).
  - Done in `a7ef6fc`: groups also accept providers that Pi defines itself, resolve the model
    without a cached catalog, and run with `PI_OFFLINE=1`.
  - Review fixes in `be1f636` and `1f1da97`: children receive only the dispatch credential, and a
    test rejects a virtual dispatch model.
  - Superseded: `df024ad` added an interim gate that refused OAuth credentials for Pi-defined
    providers, and the second-round review fix `fee7e2a` applied it to Pi providers that
    extensions re-register.
  - OAuth done with the human's option A in `8c2cc74` and `35c451f`: before the group starts, Pi's
    own `AuthStorage` refreshes the dispatch provider's OAuth credential at most once, under its
    file lock, when the credential would not outlive the run bound plus a 10-minute margin. The
    group fails closed when the refresh fails or the token is still too short. Children never
    refresh, and legacy extension OAuth is covered.
  - OAuth refresh hardening in `c08a0e9`, `bbdc56d`, `5003478`, `aa0c6cd`, and `f04621f`: the
    refresh runs in its own process, which no pi-workflows stop reaches, and that process exits at
    the latest 5 minutes after the refresh starts. Private marker files list each refresh in
    `server status` as `oauthRefreshes`. The group fails closed on a missing or changed entry, a
    lock or store failure, an unsupported Pi installation, and a marker failure.
- F23: Prune kept agent group stderr logs. _(done)_
  - `$TMPDIR/pi-workflows-<runId>-agent-group-*/pi-stderr.log` (`0700` directory, `0600` file)
    stays until the operator deletes it (`src/server/agent-group-diagnostics.ts:24`).
  - Done in `047b697`: before its first agent group, each runner deletes only log directories in
    the exact logger layout that are unchanged for a fixed seven days.
- F24: Install the live E2E candidate the way Pi does. _(done)_
  - `scripts/live-e2e.mjs:541-545` runs plain `npm install`, which installs the peer packages, so
    it cannot catch a plain Node entry that value-imports a host-only Pi package. Add
    `--legacy-peer-deps` to match `pi install`.
  - Done in `57349aa`: the candidate installs with `--omit=dev --legacy-peer-deps`, and the run
    fails if a host-provided Pi package can be resolved from it.
- F25: Pin the `pi` and Node that headless Pi uses. _(done)_
  - Agent steps and agent groups spawn `pi` from the server's inherited `PATH`
    (`src/server/headless-pi.ts:85-86`), and npm-installed `pi` starts through
    `#!/usr/bin/env node`. A server started with a mise shim on `PATH` would run that Node.
  - Done in `138b41f` and `1f357e2`: the server pins pi and Node once at start, and
    `server status` reports the pin as `headlessPi`.
  - Review fixes in `43197be` and `44f3df9`: a `PATH` shim keeps its own name as `argv0`, and a
    probe timeout is named, with one retry of an unresolved pin.
- F26: Make the timing-sensitive agent group test robust under load. _(done)_
  - `test/pi-agent-group.test.ts:1170` ("discovers a legacy provider owner and uses its configured
    authentication") runs a real SDK session with the helper's `timeoutMs: 1_000`
    (`test/pi-agent-group.test.ts:25`). It failed with "Pi agent legacy timed out: after 1000ms" on
    the first full `npm run check` while concurrent gates ran: load average about 16-20
    (`/tmp/resolver-peers-fix4-check.attempt1.log`) and about 24
    (`/tmp/resolver-peers-int3-check.attempt1-flake.log`).
  - It passed alone (3/3 and 36/36) and on full reruns. It predates the resolver host-peer fix,
    which changed only its imports.
  - Done in `e16cb98`: real SDK sessions in that file use a 30-second hang limit under a 90-second
    test timeout, so only a real hang fails by timeout.
- F27: Let headless Pi load a provider that only an extension registers. _(done)_
  - Done in `b666986` and `e05d4b2`: server piArgs can load an extension-only provider through
    absolute `-e` paths, documented and validated.
  - Review fixes in `0bdafbe`, `bf33a4a`, and `96fcba7`: piArgs reject `--`, and the opt-in
    `PI_WORKFLOWS_HEADLESS_EXTENSIONS` loads the listed extensions for every server start path,
    including the auto-spawned server.
  - Second-round review fixes in `266bc1e`, `a0b69ad`, `75e551d`, `b445ef7`, and `beacb4c`:
    entries must be extension files, the server pins each realpath and rechecks it before each
    launch, the docs say that file contents are not pinned, and an entry that vanishes during its
    check fails closed with a clear error.
- F28: Keep the checkout clean after pi-style installs. _(done)_
  - Done in `7ec4245`: lockfile regenerated so pi-style installs leave the checkout clean.
- F32: Fail headless steps whose configured default model cannot be resolved instead of silently
  falling back. _(done)_
  - Done in `5579bfd` and `ca7bfe1`: headless pi stops before any model request, and the step
    fails with an error that names the default and how to fix it.
  - Second-round review fix in `e0c78d0`: the error names the server restart that picks up a
    changed `PI_WORKFLOWS_HEADLESS_EXTENSIONS` or changed extra Pi arguments.
  - Round-4 fix in `1ff25d5`: a `--models` or `enabledModels` scope counts as an explicit choice.
    The step runs on the first usable model in the scope, fails clearly when nothing in the scope
    is usable, and never falls back to a model outside the scope. A step with no settings default
    but a scope that matches nothing usable now fails; before, it ran on Pi's first available
    model.
- F33: Require the origin session for interactive run.start and report undelivered terminal
  messages. _(done)_
  - Done in `a08ee63`, `2bce3fe`, `dbf2509`, `0101bdb`, `87f81ae`, `12b749b`, and `086f3a9`:
    - an interactive `run.start` requires a live session command for its origin session, and a
      start whose connection is lost retries with fresh authority and the same idempotency key;
    - `state status` reports the count and oldest age of undelivered terminal messages, and
      `state verify` lists them; both only report;
    - verification scripts must use an isolated workflow server.
- F34: Remove the two stale terminal workflow messages from the live state DB in a maintenance
  window.
  - Deferred by the human. It needs explicit approval before any run against the live state, and
    it follows the procedure in `docs/SQLITE_STATE.md` ("Removing undeliverable terminal
    messages").
- F35: Refresh session authority on retry for `followUp.queue` and `run.changeSettings`.
  - Found during F33: both commands build their session authority once, so a retry after a lost
    connection carries the stale coordinator epoch and is rejected as replaced. A user retry can
    then queue a second follow-up or apply a settings patch twice.
- F36: Isolate HOME, the Pi agent dir, and user config for every test process. _(done)_
  - Done in `9bb3a13`, `945d7c2`, and `4a77241`: the global test setup points HOME,
    `PI_CODING_AGENT_DIR`, the XDG directories, git's global config, and npm's cache and user
    config at a temporary root, unsets inherited Pi session, headless-extension, herdr, and GitLab
    host variables, and keeps `PI_WORKFLOWS_E2E_PI_ENTRY` as an explicit opt-in. A guard test
    fails when any isolated path points outside the temporary root.
  - Residual: test servers still read the header of the real `pi` on `PATH` (read-only); the
    herdr-package e2e `npm pack` builds into the repo's `dist/`; the default macOS TMPDIR may
    exceed the socket path limit; and npm's own cache from the gates' `npm ci` and `npx` is
    tooling, not test state.
- F37: Settle progress tracks left open when the server fails a run without the engine
  (`failWorkflowRun`) or discards an attempt on resume.
- F38: Report Pi's own reason when no model exists at all; headless steps now show only
  `exited mid-step (code 1)`.
- F39: Let user workflows that reuse built-in Sanity Check nodes reach the runner's agent group
  launcher.
- F40: Make load-sensitive tests robust: server-view ("bounds the node window"), monitor-repair,
  builtin-autoimplement-forge.
- F42: Accept the step suffix in the live E2E paused-status check.
  - The gap: `hasWorkflowUiState` (`scripts/live-e2e.mjs:386-403`) accepts only the exact status
    text `live-runtime-e2e [paused]`. Pi printed `live-runtime-e2e [paused] hold`, so the paused
    wait can time out with "Timed out waiting for the paused Pi workflow widget and status"
    (`scripts/live-e2e.mjs:740`).
  - Evidence: run 2 of the F11-F14 live E2E (`/tmp/livee2e-f11f14-or.log`) saw
    `live-runtime-e2e [paused] hold` 10 times and timed out after 30 s. Other runs passed this
    check, so it may also be a race in when the status carries the step name.
  - Fix: accept the step suffix, or find out why the status sometimes carries it.
- F43: Do not excuse pushes forever for an unrecorded attempt without an end time (review2 P2 1).
  - The gap: when an unrecorded `verifyP2` attempt has no `finishedAt`, the `publicationPush`
    window runs to `Number.POSITIVE_INFINITY` (`src/builtins/autoimplement.workflow.ts:1684-1686`),
    so it would excuse every later push, including unreviewed `fix` work.
  - Unreachable today: every path that moves an attempt to a non-active status sets `finished_at`.
  - Fix: skip entries without `finishedAt`, or make `finishedAt` required in
    `WorkflowUnrecordedAttempt` and filter the query with `finished_at IS NOT NULL`.
- F44: Correct the `unrecordedAttempts` wording (review2 P2 2).
  - The gap: `docs/WORKFLOWS.md` ("Unrecorded attempts"), the `WorkflowUnrecordedAttempt` comment
    in `src/workflows/types.ts:603-606`, and `docs/SQLITE_STATE.md:167` say "a run without a
    restart has the same state as before". Runs that are cancelled or fail while an attempt is in
    flight also get `unrecordedAttempts` (`src/workflows/queue.ts:1995`, `:2046`). This is harmless,
    because the run is terminal.
  - Fix: reword the docs and the comment, for example "the field is absent when every started
    attempt has a step record".
- F45: Add the missing `unrecordedAttempts` resume tests (review2 P2 3).
  - `test/park-resume.test.ts:61-141` covers one restart and no restart. Add cases for:
    - two successive restarts, which give two entries in start order;
    - a resume that keeps the interrupted attempt, where the field must not grow;
    - the server-backed `WorkflowRunnerStore` path (`src/server/workflow-runner-store.ts:64-70`).
- F46: Check the negative-refspec exclusion against real Git (review1 P2 1).
  - The gap: when a `^` refspec excludes the branch, `fetchRefspecTracks` returns false, so
    `pushTrackingHead` is undefined and `assertNotPushedBeforeGate` skips the check
    (`src/builtins/workspace-preparation.workflow.ts:288-294`). This fails open if Git still
    updates the tracking ref on push.
  - The test at `test/workspace-preparation.test.ts:538` asserts only the code's result. No
    real-Git test checks whether Git skips the tracking-ref update in that case.
  - Fix: push with a negative refspec configured against a temp bare remote and assert whether
    `refs/remotes/origin/<branch>` moved. If it moved, drop the exclusion for the push case.
- F47: Keep the push check when the first matching refspec maps to an alias (review1 P2 2).
  - The gap: with `+refs/heads/feat/*:refs/remotes/origin/feat-alias/*` first, `pushTrackingHead`
    is undefined and the push-before-gate check is skipped silently
    (`src/builtins/workspace-preparation.workflow.ts:300-301`, `:229`). This is no worse than
    before F11.
  - Consider returning the mapped target ref, for example `refs/remotes/origin/feat-alias/<name>`,
    as the tracking ref, so the reflog and value checks keep working. This is a scope decision.
