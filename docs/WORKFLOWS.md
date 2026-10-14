# Workflow authoring reference

This document is the authoring reference for pi-workflows definitions. It
covers the file format, every node type, edge routing, the step contract the
model sees, and how runs behave at runtime. For durable state, see
[SQLITE_STATE.md](SQLITE_STATE.md).

## Starting and resuming runs

A successful start call confirms that a run was created. Wait for the delivered
step contract before submitting an agent result. Report worktree creation or
implementation progress only after the corresponding recorded steps succeed.
The status view distinguishes unconfirmed step delivery, active agent work,
required results, and a durable pause. Waiting uses a different glyph from pause.
A Pi session holds at most one active interactive run. A start call for a
session whose reservation is taken fails with the identity of the active run;
wait for that run, inspect it, or cancel it first. A headless run does not take
the session reservation, so it can run beside an interactive run.

An interactive run starts only from its live origin Pi session. The run sends
its steps and its terminal result to that session, so the workflow server
accepts an interactive `run.start` only with the session's current coordinator
authority: the `targetSessionId` and `coordinatorEpoch` of the connection that
owns the session and has reported its branch. `targetSessionId` must equal
`originSessionId`. The server checks that authority before it looks up an
earlier receipt, so a retried start also needs the live session. A start from
another client, from another session, or for a session that never connected is
rejected and creates no run. Without this check, such a start would create a
terminal message that no session can receive; the message would stay pending
and keep its run from retention. The extension sends its session's authority
with every start. When the session is still connecting or reporting its branch,
the start waits up to 15 seconds for it and then fails with `Workflow session
coordinator is not ready`. A headless start (`executionMode: "headless"`) needs
no Pi session and carries no session authority. Verification scripts and tests
use headless runs or an isolated server, never the live server with a made-up
session; see [Verification scripts](DEVELOPMENT.md#verification-scripts).

Resume uses the run's original source and graph, including ordinary workflows
without included workflows. Source and graph checks run before any durable
mutation. `WorkflowEngine.resumeRun` has no `force` option. Restore the original
source to resume its accepted work, or explicitly start a new run for changed
code. A new run does not inherit outputs, approvals, or effect receipts.
File and built-in source identities verify code; callers of the direct engine
API must supply source identity to detect callback-body changes that leave the
structural graph unchanged.

## Workflow files

A workflow is a TypeScript module whose default export is `defineWorkflow(...)`.
Files are discovered by suffix (`.workflow.ts`, `.workflow.js`, `.workflow.mts`,
`.workflow.mjs`) from these sources, in precedence order:

1. `.pi/workflows/` in the project (highest precedence on name collisions)
2. `~/.pi/agent/workflows/` globally
3. Workflows built into Pi Workflows

Pi Workflows includes built-in `plain-summary`, `autoplan`, `autodoc`,
`autoimplement`, `plan-approval`, `sanity-check`, and `monitor` workflows. `autoplan` is the current name for the
planning workflow that was first released as `autodevise`; the old command and
export are not retained. A project or global file named `monitor.workflow.ts`
replaces the built-in monitor. Each built-in has a stable reference such as
`builtin:monitor` and an explicit revision. A resolver child snapshots the
selected built-in before start, and each run runner verifies that identity
before execution. A revision mismatch refuses resume. Project and global
workflow files also use their absolute path and SHA-256 hash as source
identity.

Package-internal workflows can be registered as non-discoverable built-ins.
They do not appear in the workflow list or ordinary name lookup, but composed
built-ins record them with a stable built-in ID and revision. This keeps source
identity independent of the package installation path. It does not weaken file
identity checks for project and global workflows.

The workflow's command name is the file stem, so `.pi/workflows/triage.workflow.ts`
runs as `/workflow triage`. A direct path also works: `/workflow ./somewhere/x.workflow.ts`.
Files are loaded with [jiti](https://github.com/unjs/jiti), so plain TypeScript
works without a build step, and `import ... from "@osolmaz/pi-workflows"` resolves to
the engine that loaded the file.

```typescript
import { agent, compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "example",
  title: ({ input }) => `example: ${(input as { task?: string }).task}`,
  startAt: "ask",
  maxSteps: 50,
  nodes: {
    ask: agent({
      prompt: ({ input }) => `Answer: ${(input as { task?: string }).task}`,
      expectedOutput: `{ "answer": "text" }`,
    }),
    finish: compute({ run: ({ outputs }) => outputs.ask }),
  },
  edges: [{ from: "ask", to: "finish" }],
});
```

Top-level fields:

| Field        | Type                      | Notes                                                                                                                                                  |
| ------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`       | `string`                  | Required. Used in run ids and the step contract. `answer`, `cancel`, `list`, `pause`, `resume`, and `status` are reserved for `/workflow` subcommands. |
| `source`     | `string`                  | Optional `import.meta.url` for exact provenance when another TypeScript workflow imports this definition directly.                                     |
| `contractId` | `string`                  | Optional stable input-and-exit contract identity. Dynamic overrides must match it.                                                                     |
| `input`      | `function`                | Optional runtime input normalizer and validator. Its return type is the workflow input type.                                                           |
| `title`      | `string` or function      | Optional run title, resolved once at start from `{ input, workflowName }`. Async resolution is bounded (30s) and cancellable.                          |
| `startAt`    | `string`                  | Required. Id of the first node.                                                                                                                        |
| `nodes`      | `Record<string, node>`    | Required, non-empty. Node ids must match `[A-Za-z_][A-Za-z0-9_-]*`.                                                                                    |
| `includes`   | `Record<string, include>` | Optional imported or dynamically resolved child workflows.                                                                                             |
| `exits`      | `Record<string, exit>`    | Optional named successful terminal nodes used when another workflow includes this workflow.                                                            |
| `edges`      | `WorkflowEdge[]`          | Required. See routing below.                                                                                                                           |
| `maxSteps`   | `number`                  | Optional loop bound, default 100. The run fails when exceeded.                                                                                         |

`defineWorkflow` validates the shape eagerly (node ids, edge shapes, function
fields) and validates the graph (unknown targets, duplicate outgoing edges,
unreachable nodes) when a run starts.

A node ID matches `^[A-Za-z_][A-Za-z0-9_-]*$` and is at most 4 KiB. The size
limit keeps every node identity inside one bounded client frame, because the run
view carries the identity in full and never cuts it. A longer ID fails the
definition with a message that names the limit.

## Node context

Every node callback receives the same context object:

```typescript
type WorkflowNodeContext = {
  input: unknown; // the run input
  outputs: Record<string, unknown>; // accepted output per finished node id
  results: Record<string, WorkflowNodeResult>; // full result records, including failures
  state: WorkflowRunState; // the live run state (read-only by convention)
  settings?: unknown; // fixed typed settings for this attempt, when declared
  settingsScopeId?: string;
  settingsChangeNumber?: number;
  signal: AbortSignal; // aborted on node timeout or run cancellation
};
```

`outputs` only contains nodes that finished with outcome `ok`. When a node runs
more than once (a loop), the latest result wins. A failed retry removes the
node's earlier output from `outputs`.

Long-running compute, action, and checkpoint callbacks should observe
`context.signal` (pass it to `fetch`/`spawn`, or check `signal.aborted` between
steps). When the node times out or the run is cancelled, the engine stops
waiting immediately, but only cooperative callbacks stop doing work.

A workflow can declare typed JSON settings with `workflowSettings()`. Each node
attempt receives one fixed copy. Authorized changes use RFC 6902 JSON Patch and
affect only later attempts. Use `settingsRoute()` for a pure route choice that
must retry when a newer settings change wins before route settlement. See
[Change workflow settings during a run](2026-08-25-workflow-settings.md).

Function actions receive `WorkflowActionContext`, which adds
`publishUpdate(update)`. Other callbacks keep the read-only node context.

## Durable runs, parking, and resume

Every run enters one global SQLite queue. One package-owned server claims runs,
renews live claims, commits state, and supervises one child process for each
active run generation. The extension is a local server client. It does not run
the workflow engine or workflow definitions.

The server starts on demand when a Pi or CLI client needs it. These commands
control the same user-level server for all projects:

```bash
pi-workflows server start
pi-workflows server status
pi-workflows server stop
pi-workflows server run [-- <extra pi args>]
```

`server run` stays attached. The other commands start, inspect, or stop the
on-demand process. No command installs an operating-system service.

`server run -- <args>` adds Pi arguments to every headless Pi child. To use a
provider that only a user extension registers, name that extension by its
absolute path: `pi-workflows server run -- -e /abs/path/provider-ext.ts
--provider <provider> --model <model>`. The whole extension then loads into
every headless agent step and agent group host process, for every run and
project. It must not be the pi-workflows extension, and `server run` rejects a
relative extension path. A server started any other way gets no extra Pi
arguments; list the extension in [headless extensions](#headless-extensions)
instead. See
[Extra Pi arguments](WORKFLOW_SERVER.md#extra-pi-arguments) for every caveat.

The extension, CLI, and `piw` use the same version-1 client protocol over a Unix socket or Windows named pipe. The server sends byte-bounded run-list and run-view pages. Clients collect a complete run list for one revision and reject stale run pages whose cursor or revision no longer matches. A run view's `revision` is the presentation cursor; `runRevision` is the execution resource revision used by restart and other exact execution commands. The server reads only the selected history ranges and reuses an unchanged subscribed view after a lightweight revision check. It waits for a slow socket to drain and removes every subscription when its client unsubscribes. Large values stay available through verified content chunks. Server-generated aggregate values are saved and linked to the run before the server advertises them.

A runner verifies the root and all mounted source identities before it loads
workflow modules. It then checks the resolved mounted-source map and executes
from committed state through a server-backed store. Resume reads return only
`WorkflowRunState`. Session messages, tool results, activity
events, viewer history, settings, follow-ups, and other inspection data stay in
server-owned SQLite. If one required result exceeds the runner protocol frame,
the server returns a digest-bound reference and the runner reads and verifies it
in bounded parts. A source mismatch parks the
run with `workflowSourceChanged`; normal scheduling does not retry it. Restore
the recorded source and explicitly resume, or cancel the run. A headless Pi
child uses its own registered process group. The runner stops that group on
normal completion, and the server reaps it if the runner exits first. If the
runner stops for another recoverable reason, pure work can run again. A
protected write checks and renews the exact live token and generation in one
transaction. An expired or replaced owner cannot revive itself.

Interactive agent and assistant-message steps do not run headlessly for a Pi
session. The runner commits a durable interaction request and parks. The origin
session presents the request through documented Pi APIs and submits the exact
request, node, attempt, and revision. The server records submitted output as
provisional. A new supervised runner loads the workflow and runs its `validate`
function before the server accepts the submission. A validation error leaves the
same request pending and returns the error to the model. Closing Pi leaves that
request pending; reopening the same session adopts the existing session entry
or presents it once. Step prompts, protected decisions, notifications, terminal
results, and follow-ups use the server-owned `workflow_messages` table and one
extension sender. Initial and resumed prompts are the same step-message
kind with different display reasons. A terminal workflow message becomes
eligible only after the terminal outcome is committed. A resource manager child
without an origin session can use a supervised headless `pi --mode rpc` child
for structured agent steps.

Every headless Pi child runs the pi and Node that the server pinned when it
started; it never looks `pi` up on `PATH`. A server that a Pi session starts
pins that session's own pi. A server that the CLI or `piw` starts resolves `pi`
on its own `PATH` once. The pin stays until the server restarts, and
`pi-workflows server status` reports it as `headlessPi`. See
[Headless Pi command](WORKFLOW_SERVER.md#headless-pi-command).

A headless agent step fails before any model request when its Pi child cannot use the default
model from Pi settings. See [Headless step model](#headless-step-model).

Pause stops the runner and parks at the last durable boundary. Resume takes a
new generation. Cancellation can stop a live runner or atomically claim and
cancel an expired running row. Resume refuses changed workflow source.

### Unrecorded attempts

`state.steps` lists only attempts that finished with a step record. A resume
that starts a new attempt retires the interrupted one without a step record,
so its work would otherwise leave no trace in the run state. The run state
therefore lists such attempts in `unrecordedAttempts`, in start order:

```typescript
type WorkflowUnrecordedAttempt = {
  attemptId: string;
  nodeId: string;
  startedAt: string; // when the attempt started
  finishedAt?: string; // when it was retired, when recorded
};
```

The list holds every started attempt of the run that is not active and has no
step record. It is derived from the stored attempt rows and is never stored
separately. The field is absent when there is no such attempt, so a run without
a restart has the same state as before. After a resume, the engine reads the
list from the store, so node callbacks see it in `context.state`. A retired
attempt's window ends when the resume retired it, so it also covers the time the
runner was down. Use the list to account for side effects that a lost attempt
may have made. It is not proof that the attempt made any.

## Node types

### agent

Sends a prompt to the model. `expectedOutput` selects one of two output forms.

While the workflow-owned Pi turn or supervised runner is active, the visible run status is
`running`. The durable agent request can still be waiting for its result. With no active work,
a pending request displays `waiting`. Pause, ambiguity, and terminal outcomes retain precedence.
The exact pending request determines response controls in both running and waiting displays:
agent steps retain `submit` and `update`, checkpoints retain `answer`, and protected decisions
retain only their human response path. Ordinary chat is not workflow activity.

`allowedTools` optionally restricts a step to exact tool names, for example `allowedTools: ["read", "grep", "find", "ls"]`. Omit it for the normal tool set; use `[]` to permit only matching workflow `submit` and `update` calls. Do not include `workflow` in the list. Restrictions remain in composed child graphs, definition snapshots, and the durable step contract. Changing them requires a new run under the fixed-definition rule.

The origin Pi extension blocks other calls through public `tool_call` before execution, including while delivery acknowledgment is pending. It applies the restriction only to the workflow-owned running turn, not later ordinary chat. This is an exact tool allowlist, not a filesystem sandbox: authors must trust the implementations of the tools they allow. No shell is implicitly read-only.

An executor must declare `enforcesToolAllowlist: true` only when it enforces that contract before every tool call. The current headless RPC executor does not support restricted steps. The engine rejects such a step before calling that executor rather than silently dropping its restriction; use an origin Pi session. Scripted executors that run no model tools can declare support.

The existing string form waits for a `workflow submit` call:

```typescript
agent({
  prompt: ({ outputs }) => `Review this: ${JSON.stringify(outputs.implement)}`,
  expectedOutput: `{ "verdict": "clean" | "issues_found" }`,
  validate: (output) => output, // optional; throw to reject the submission
  timeoutMs: ({ input }) =>
    (input as { timeoutMinutes?: number }).timeoutMinutes
      ? (input as { timeoutMinutes: number }).timeoutMinutes * 60_000
      : 30 * 60_000, // optional number or context callback; default 15 minutes
  statusDetail: "reviewing", // optional; shown in widget and viewer
});
```

The assistant-message form waits for one normal visible response and uses its
exact text as the node output:

```typescript
agent({
  prompt: ({ outputs }) => `Explain this plainly: ${JSON.stringify(outputs.review)}`,
  expectedOutput: assistantMessage(),
});
```

`assistantMessage()` has no default character limit. Authors can opt in with
`assistantMessage({ maxChars: 2_000 })`. It cannot be combined with `validate`
because an invalid response is already visible and must not be retried.

For submitted output, the engine appends the existing workflow-tool contract.
The server checks the durable transport identifiers, stores a `validating`
submission, and starts a supervised runner. In that runner, the output passes
through tolerant JSON normalization and then `validate`. The tool reports
success only after this check accepts the output. If the tool turn is aborted,
the client stops waiting but does not cancel the durable server command. A retry
uses a new transport request ID with the same durable submission identity and
adopts the stored result. Rejected submissions return
the validation error and can retry in the same step. When a late submission loses
to the active-time limit, the error says that the request expired only when the
saved timeout event names that exact request. Other revision conflicts keep the
generic conflict error. If the model settles
without submitting, the server sends up to two reminders for the exact pending
request. It waits for the owned turn to settle and does not remind during validation,
pause, or another active turn. If both reminders end without an accepted result,
the run fails with `missingSubmission`. Accepted results remain saved. The timeout
remains active during each reported model turn, and cancellation remains active throughout.
For assistant-message output, the engine appends a normal-response contract,
waits for `agent_settled`, rejects empty, failed, aborted, or tool-only results,
and never suppresses the visible text. Timeout and cancellation abort either
form's active Pi turn.

`timeoutMs` can be a finite positive number, `null`, or a function of the normal
node context that returns either value. Omit it to use the 15-minute engine
default. The limit counts active node execution. For an origin-session agent
node, it counts reported model-turn time from an active connected Pi session.
It excludes message delivery, waiting, paused time, disconnects, and server downtime. Set it to `null` to disable only this deadline; cancellation,
parking, claim loss, shutdown, and the node's abort signal still work. A timeout
function can use prepared outputs to select a policy for this run. It has 30
seconds to return. Computed timeout functions are runtime code, so definition
snapshots omit them. Snapshots keep fixed numbers and fixed `null` values.

### Terminal recovery and fresh restarts

Terminal messages return responsibility to the regular Pi model after execution
ends. The model checks whether the user's task is complete, explains the outcome,
and can correct mistakes within existing permission. Cancellation is different:
its terminal message is passive and stops automatic continuation.

The collapsed terminal card shows the workflow, status, and error. Expand it to
read the full result and recovery instructions. An explicit `assistantMessage()`
node can still provide a workflow-specific explanation. The terminal turn should
refer to that explanation rather than repeat it. `presentationPrompt` is not supported.
Autoimplement prepares its structured result, runs an explicit summary node,
and then returns the prepared result. A failed summary cannot erase accepted work.

The extension submits visible assistant text and records the end of a workflow
turn at `agent_settled`. `agent_end` records only low-level activity. Automatic Pi
retries keep the same unsettled turn and cannot submit an unfinished response.
Branch evidence must identify the exact workflow message before reconnect can
adopt its turn.

A fresh restart targets `runId` plus `expectedRevision`. It starts from the original
input in a new run and does not copy old steps, changed settings, decisions, or
effects. The workflow server rejects a stale revision or unsettled external effects before
reserving work. An identical retry adopts the same child run.

An owned terminal turn can start or restart work within existing user permission.
Each terminal handoff can create only one recovery run. Repeated commands must
adopt that run, even after it finishes. Both commands count toward a shared limit
of two automatic launches per recovery chain. Each terminal turn has a 15-minute active-time limit. Disconnects and server
downtime do not consume that time. Saved launch counts and active elapsed time survive
reconnects. An interrupted recovery turn stops with a visible blocker rather than
silently replaying work. A later explicit user request can authorize new work.

Queued follow-ups wait for the source's terminal turn to finish successfully. Another
workflow started during recovery must also release the session before a follow-up
can run. Cancellation or interrupted recovery keeps those follow-ups from running
automatically. These rules implement the [workflow recovery plan](2026-09-08-workflow-recovery-plan.md).

### compute

Runs a TypeScript function inline. Use it for pure data shaping.

```typescript
compute({ run: ({ outputs }) => ({ merged: { ...outputs } }) });
```

### notify

Queues a durable plain-text message for the Pi session that started the run.
The runner does not write the message into its own conversation. A standalone
server can execute this node, and the message still waits for the origin session.

```typescript
notify({
  kind: "progress", // or "final"
  message: ({ outputs }) => String(outputs.check),
});
```

The runtime gives each logical execution of a notification node a stable index.
A retry after a crash reuses that index, so it cannot queue the same message
twice. Re-entering the node later in a loop gets the next index. A workflow
with a `notify` node must be an interactive queued run with an origin session.
ResourceManager child workflows are detached and must report through their
managed resource instead.

### action

Performs managed work. Every function action and shell action must declare how
the server recovers if the runner exits after the external operation but before
it saves a receipt.

Use `idempotentEffect(type)` only when the operation has a stable external
idempotency key or a read-back check that makes another attempt safe:

```typescript
import { action, idempotentEffect } from "@osolmaz/pi-workflows";

action({
  effect: idempotentEffect("preview.deploy"),
  run: async ({ input }) => await deployPreview(input),
});
```

Use `manualEffect(type)` when the external system cannot prove whether an
uncertain request applied. An uncertain runner exit marks that effect
`ambiguous`, parks the run, and requires explicit operator recovery. The server
does not retry it automatically.

The shell form (`shell` is a synonym that requires `exec`) runs a command owned
by the workflow definition, with a timeout and captured output:

```typescript
shell({
  effect: idempotentEffect("repository.status"),
  exec: () => ({
    command: "git",
    args: ["status", "--porcelain"],
    cwd: "/path/to/repo",
    timeoutMs: 10_000,
    allowNonZeroExit: false,
  }),
  parse: (result) => ({ dirty: result.stdout.trim().length > 0 }),
});
```

Without `parse`, the node output is the full `ShellActionResult` (`stdout`,
`stderr`, `exitCode`, `signal`, `durationMs`). A non-zero exit fails the node
unless `allowNonZeroExit` is set. Captured stdout and stderr are each capped
(default 1,000,000 characters, configurable with `maxOutputChars`) so verbose
commands cannot exhaust memory. Both action forms record a receipt (command,
exit code, duration) in the step record for auditability, including when the
command fails.

A function action can publish a durable update without completing the node:

```typescript
action({
  effect: idempotentEffect("dataset.process"),
  run: async ({ publishUpdate }) => {
    await publishUpdate({
      type: "progress",
      key: "overall",
      data: {
        schema: "pi-workflows.progress.v1",
        status: "running",
        completed: 40,
        total: 100,
        unit: "rows",
      },
    });
  },
});
```

If the attempt times out or is cancelled before the action marks a track
finished, the runtime settles that track. See
[Progress of timed-out and cancelled attempts](#progress-of-timed-out-and-cancelled-attempts).

A shell action can parse complete lines from stdout or stderr and return one
or more updates through `updates.parseLine`. Parsing applies backpressure and
keeps normal output capture. Lines and update data are each limited to 64 KiB.
See [WORKFLOW_UPDATES.md](WORKFLOW_UPDATES.md) for the envelope, progress
schema, limits, estimation, and error rules.

The server reserves the effect before it lets the action run. The engine creates
the internal key from the run ID, effect type, full compiled node path, and node
visit number. Workflow code does not supply that key. Two included workflows
can use the same local node name without sharing an effect. A repeated key with
the same request adopts the durable record; the same key with another request
is a conflict. A normal caught error settles the attempt as rejected. After an
uncertain process exit, an idempotent effect returns to pending for retry, while
a manual effect becomes ambiguous. This is not an exactly-once claim.

### checkpoint

Creates a durable input request and parks the run. The run is waiting, not
terminal. Its input, settings, history, and active attempt stay unchanged.
The optional callback creates the request content once. It does not complete
the node.

An answer completes that exact request in the same run. The answer becomes the
checkpoint output, and execution follows its outgoing edge. A checkpoint at the
end of the graph completes the run with its answer. Each answered checkpoint
counts once toward `maxSteps`. Invalid responses do not create another run or
change another request.

```typescript
checkpoint({
  summary: "human decides how to proceed",
  run: ({ outputs }) => outputs.reconcile, // optional request content; defaults to { summary }
});
```

A typed human decision is an authoring layer over checkpoint:

```typescript
const choices = defineHumanChoices({
  continue: choice({ label: "Continue" }),
  stop: choice({ label: "Stop" }),
  replan: choice({
    label: "Replan",
    input: textInput({ name: "instructions", prompt: "What should change?" }),
  }),
});

humanDecision({
  audience: "operator",
  choices,
  onTimeout: {
    afterMs: 10 * 60_000,
    response: { choice: "continue" },
  },
  request: ({ outputs }) => ({
    title: "Approve plan",
    subject: outputs.plan,
    presentation: {
      schema: "pi-workflows.decision-presentation.v1",
      summary: "Review the implementation plan.",
      blocks: [{ kind: "paragraph", text: "The plan is ready for approval." }],
    },
  }),
});
```

The waiting run stores the request and asks every channel configured for the audience. The structured `subject` remains machine data. Channels receive the normalized `presentation`, title, choices, input prompts, and deadline policy. The first valid verified human answer wins. When `onTimeout` is present and no human answer wins before the saved deadline, the server accepts the declared response with `timeout` provenance and resumes the same run. This policy can continue without a configured channel. The original input remains unchanged, and the resolved response becomes the checkpoint output. `humanDecisionEdge()` provides exhaustive routing for the choices.

The model-facing workflow tool cannot answer a protected human decision. The origin Pi session displays the request without starting a model turn. A person uses `/workflow answer <requestId> <response>` to send the answer through the server-owned path. Ordinary checkpoints can also use the model-facing `answer` action.

See [Human decisions](HUMAN_DECISIONS.md) for channels, recovery, persistence, and plan approval.

### decision

`decision` is sugar over `agent` for constrained choices. It builds the prompt
suffix listing the choices, sets `expectedOutput`, and validates that the
submitted object carries one of the allowed values in the decision field
(default `route`).

```typescript
const choices = ["y", "n"] as const;

decision({
  choices,
  question: ({ outputs }) => `Same as proposed? ${JSON.stringify(outputs.propose)}`,
});
```

Pair it with `decisionEdge`, which builds the matching `switch` edge and makes
a missing case a compile-time error:

```typescript
decisionEdge({ from: "compare", choices, cases: { y: "implement", n: "reconcile" } });
```

## Edges and routing

Each node has at most one outgoing edge. A plain edge is unconditional:

```typescript
{ from: "a", to: "b" }
```

A `switch` edge routes on a JSON path evaluated against the node's result:

```typescript
{ from: "review", switch: { on: "$.route", cases: { clean: "done", issues_found: "fix" } } }
```

Path roots:

- `$.field` and `$output.field` read from the node's accepted output.
- `$result.field` reads from the result record. `$result.outcome` is the main
  use, with values `ok`, `failed`, `timed_out`, or `cancelled`, which lets a
  workflow route failures to a recovery node instead of failing the run.

A missing case for the resolved value fails the run with a routing error. A
node with no outgoing edge (or no matching failure route) ends the run:
`completed` on success, `failed`/`timed_out`/`cancelled` otherwise.

Use `controlLoop()` when one decision point must send work to several branches
that return after one bounded action. The helper returns normal switch and
return edges. It adds no node type or runtime state. The workflow still owns
observation, decision checks, progress checks, terminal checks, and failure
handling. See [Control loops](CONTROL_LOOPS.md).

## Included workflows

Use `includeWorkflow()` to mount a standalone workflow under a parent name:

```typescript
import repair from "./repair.workflow.js";

includes: {
  repair: includeWorkflow(repair, {
    input: ({ outputs }) => ({ issue: outputs.check }),
  }),
},
```

The child declares named exits:

```typescript
exits: {
  completed: { from: "finalize", validate: parseCompleted },
  blocked: { from: "blocked", validate: parseBlocked },
},
```

Enter through the mount and leave through `<mount>.<exit>`:

```typescript
{ from: "check", to: "repair" }
{ from: "repair.completed", to: "check" }
{ from: "repair.blocked", to: "finish" }
```

Direct imports check child input and exit names in TypeScript. Use `includedResult(child, outputs.mount)` to recover the child's discriminated exit output without a cast. Dynamic discovered names, built-in references, and file paths are also supported. Every reference resolves before the run starts.

Child callbacks receive local input, outputs, results, and steps from their current invocation. Persisted node identities include the mount path. Re-entry starts with empty child-local state. Root and child step limits both apply. Internal entry and exit transitions do not consume those limits.

The run records every mounted source and a digest of the resolved graph. Resume refuses a changed child source. Source cycles are rejected before the run starts. See [Workflow composition](WORKFLOW_COMPOSITION.md) for typing, persistence, nesting, and viewer rules.

## Model workflow control

The model sees one `workflow` tool. Its `action` field supports:

- `list` for discovered workflow names and sources;
- `start` with a workflow name or path and structured input;
- `status` for the active run or a supplied run ID;
- `pause` and `resume` for the active session run;
- `cancel` for the active run or a supplied run ID;
- `answer` with an exact checkpoint `requestId` and input;
- `update` with an exact agent `requestId` and a non-completing update;
- `submit` with an exact agent `requestId` and its output.

A direct user request to continue or resume the active workflow maps to
`resume` immediately. The model does not call `status` instead of `resume` or
use it as a prerequisite. An already active run adopts the resume request. A
pending interaction on a paused run remains the same durable request and resumes
without a runner. Other paused or parked work gets a new claim generation and runner.
With no resumable run, the server rejects the request.

The origin Pi session shows its active run in the workflow widget. The extension
renders each bounded server session snapshot immediately. It does not wait for
complete step, trace, session, settings, follow-up, or update history, and it
does not hydrate large run content for this compact view. Detailed clients load
that data through the shared protocol only when they need it. The snapshot
carries a bounded window of node rows. Scrolling past an edge of that window
moves the live session subscription with `view.session.window`, so the widget
shows the adjacent window instead of the complete topology. A window request
that fails stays retryable, and the widget keeps the loaded window until the
next one arrives. A window that follows a node row too large for one frame holds
no rows, so an upward step from it returns to the last window that held rows.
The compact run also leaves out a current or waiting node identity that cannot
fit one frame. New workflows cannot hold such an identity, because the definition
refuses a node ID above 4 KiB, and state written before that limit needs a reset.
The extension remembers the window the user scrolled to, so a
subscription it has to arm again after a connection loss returns that window
instead of the default one. `Shift+Up` and
`Shift+Down` scroll the widget by default; see
[Widget scroll shortcuts](#widget-scroll-shortcuts) to remap or remove them. A
sent step message is open only while its
interaction is pending and its run is not paused. Because public `agent_start`
has no message payload, any model turn that starts in that state is workflow
work. If Escape ends that turn with Pi's public `aborted` stop reason, one
turn-end report atomically sets the run pause and cancels the interaction's
pending step messages. A turn that starts while the run is paused does not bind
to the workflow. The paused run does not accept updates, submissions, or
decision answers until `resume`.

`status` reports the durable queue projection. A server command succeeds only
after its transaction commits. The protocol stores request fingerprints and
receipts, so an exact duplicate adopts the committed result and conflicting
reuse is rejected.

The normal extension offers these actions through the origin Pi session. The
headless RPC bridge offers only `update` and `submit`, so a resource manager child
cannot recursively control unrelated runs. ResourceManager code can use its narrow
`ctx.workflows` methods for child runs, settings, and follow-up records. Those
methods also commit through the global server.

### Widget scroll shortcuts

The widget registers `Shift+Up` and `Shift+Down` by default. An optional
`shortcuts.json` file in the extension config directory changes those keys
without patching the package. The default directory is `~/.config/pi-workflows`,
where `/workflow-channel` also keeps its `channels.json`; the
`PI_WORKFLOWS_CONFIG_DIR` environment variable moves both files.

```json
{
  "schema": "pi-workflows.shortcuts.v1",
  "scrollUp": "ctrl+alt+up",
  "scrollDown": "ctrl+alt+down"
}
```

Each field takes one Pi key id: modifiers from `ctrl`, `shift`, `alt`, and
`super`, joined with `+` before a key name such as `up`, `pageUp`, `j`, or `f5`.
Modifier order and letter case do not matter. Rules:

- Without the file, both directions keep the default keys.
- An omitted field keeps its default. `null` leaves that direction
  unregistered, so both `null` values turn keyboard scrolling off.
- `ctrl+shift+r` stays reserved for `/piw`.
- When both fields resolve to the same key, only the scroll-up direction stays
  registered.
- A file that is unreadable, is not valid JSON, or lacks the `pi-workflows.shortcuts.v1`
  schema registers neither direction and warns once per session with the file
  path.
- A value that is not a documented `modifier+key` id, or a key reserved for
  `/piw`, leaves that one direction unregistered and warns once with the value.
  The other direction keeps its resolved key.

The widget shows the keys in effect in its controls line. A pair that shares its
modifiers and uses `up` and `down` renders as one label, which for the keys above
is `ctrl+alt+↑/↓ scroll`, and the default pair renders as `shift+↑/↓ scroll`.
Other pairs are listed in full, for example `ctrl+up · alt+down`. The segment is
omitted when both directions are off. The extension reads the file when it
loads, so run `/reload` after a change. A key press that reaches the last loaded
node asks the server for the next node window, which opens at its first row. A
key press that reaches the first loaded node asks for the previous window, which
opens at its last row. The view keeps the loaded window and its position until
the asked window arrives, so a failed request stays retryable.

The reason this file exists is another package that also uses `shift+up` or
`shift+down`, such as `pi-background-tasks`. Remap or remove those two keys here
and that package keeps them, so Pi reports no conflict that names pi-workflows.
Turning both directions off leaves hidden rows out of keyboard reach: the
controls line keeps showing how many rows are hidden, and `/piw` opens the whole
run in the viewer. A remapped combination can also fail to reach Pi, for example
a `super` key in a terminal that does not report the modifier, so prefer keys
that the terminal sends reliably.

### Built-in plain summary

The built-in `plain-summary` workflow turns supplied structured data into one
normal assistant message. Its input has `source`, `purpose`, optional
`mustInclude`, optional `maxChars`, optional `maxSentences`, and `format` set to
`paragraphs`, `bullets`, or `mixed`. The workflow applies no character or
sentence limit by default. A caller can request either limit with a positive
integer. `assistantMessage()` itself also has no default limit.

The summarizer uses only the supplied source, treats instructions inside that
source as data, keeps required points, and returns the same text as its
`completed` result. The source enters the normal model prompt and Pi session,
so callers must pass only data that is suitable for that conversation. It has no notify node or final presentation prompt, so
including it in another workflow produces one readable assistant response
before the parent continues.

### Built-in planning and implementation

The built-in `autoplan` workflow first asks the model to capture everything the
user has instructed for the intended purpose in the available conversation
context. Relevant earlier and queued user messages must keep their wording and
order. The model returns one `originalUserInstructions` string and must not
summarize, rewrite, explain, label, omit, or add instructions. Validation checks
only that the string is not empty and preserves the accepted text without
normalization. Every later Autoplan agent prompt includes this string as the
authoritative user instructions. Structured run input such as scope,
constraints, a previous plan, and new evidence remains supplemental. Ready and
blocked final outputs include the same string for audit and downstream use.

Autoplan then records two through four practical candidates, describes the ideal
separately, chooses one option, records a rejection reason for every other
explicit option, and writes a detailed plan. It includes `plain-summary` to show
the chosen plan, its main steps, and the rejected options in one assistant
message without a character or sentence limit. The detailed records remain in
the run bundle. See
[Capture the user's complete intent in Autoplan](plans/2026-08-25-autoplan-user-intent-capture-plan.md)
for the selected design and implementation plan.

The standalone `autodoc` workflow finds an already selected plan, records it in
canonical documentation, and never devises or implements. It prepares a safe
workspace only when documentation must change. Program actions run candidate
checks, compare eligible failures with the base revision in a temporary
detached worktree, and keep matching baseline failures visible without blocking
the current change. The built-in `autoimplement` workflow finds a clear existing
plan from explicit input, conversation context, or referenced canonical
documents. One central `decide` controller chooses the next safe branch from
current evidence. An explicit plan bypasses autodoc only when a
current-document receipt carries its matching plan digest; otherwise autodoc
inspects and adopts or updates the canonical documents. Later invalidating
evidence returns to `autoplan` followed by `autodoc`.

The built-in `plan-approval` workflow offers `continue`, `stop`, and exact-text `replan` exits. Its shared policy uses `auto`, `required`, or `skip` mode. Omitted policy defaults to `auto`: ask audience `operator`, then continue with the exact plan after 10 minutes without an answer. Required mode waits for a human. Skip mode creates no decision. Stop and replan always require a human answer.

The internal plan-change workflow composes Autoplan, Autodoc, plan approval, and bounded replanning. Autoimplement and Monitor use it whenever they create or change a plan. Existing supplied or discovered plans bypass the gate. A plan selected by Monitor enters Autoimplement without another decision for the same digest.

Autoimplement runs independent commands through bounded command batches. A batch is an ordinary function action that calls the public `runCommandBatch` helper. Each command has a stable ID, executable, arguments, absolute working directory, timeout, and output limit. Results stay separate and return in input order. One command uses the same path with concurrency one.

Autoimplement prepares the workspace before its first edit-capable node. `workspaceMode` accepts `auto`, `branch`, `worktree`, or `defaultBranch`. Auto mode adopts a current task branch, creates a model-named branch from a clean default branch, or creates a model-named standard sibling worktree when the default checkout has existing work. Program actions validate and apply names. Direct default-branch work requires explicit authority and does not imply commit, push, merge, or release authority. Every later stage uses the prepared absolute path.

Autoimplement gives `implement` and the shared verifier's `semanticRepair` the same named eight-hour deadline. The engine default stays unchanged. Each branch performs one bounded unit of work and returns to observation after expected success, failure, or timeout. The controller can choose plan discovery, workspace preparation, documentation, implementation, repair, verification, publication, review, P2 work, comment handling, CI, delivery, redesign, completion, or blocked. Cancellation remains immediate and terminal. Unexpected parser, graph, and invariant errors still fail the run.

Local verification uses one shared change-verification planner. A caller can supply exact `verificationChecks` and explicit `verificationUntested` work when the prepared workspace is already known. Otherwise the planner uses a 30-minute active-time limit. Its prompt and validator use the same command-safety lists, including the rules that all Git, GitHub CLI (`gh`), and GitLab CLI (`glab`) commands are forbidden, even read-only ones. The `glab` rule applies on every forge. One rejection returns all independent check errors in stable order, and no command starts before acceptance. Failed or timed-out planning returns a normal blocked child result to the Autoimplement controller. Candidate-only and remote-only checks remain explicit without invented evidence.

Direct program actions run candidate checks and read-only base-eligible checks with the same command, arguments, timeout, and output limit. Results separate related, unrelated, fixed-baseline, unknown, and untested findings. Matching base failures do not block the candidate. Related failures enter a two-attempt mechanical or semantic repair loop. Unknown or incomplete evidence needs bounded judgment, and truncated, timed-out, cancelled, or spawn-failed output cannot pass.

A failed or timed-out semantic repair enters `reconcileRepair`, not terminal failure. The recovery agent can use only `read`, `grep`, `find`, `ls`, `list_sessions`, and its exact workflow submit/update calls. Shells, edits, process input, process termination, and unrelated workflow controls are blocked. It inspects saved edits, receipts, and command sessions without changing repository contents. If a command still needs termination, it reports that exact blocker instead of receiving broader tools. It can verify completed work, request a bounded retry, or report a blocker. Verification or retry requires evidence that the previous commands have stopped. Failed and timed-out attempts count against the existing two-attempt repair bound. Intentional cancellation stays terminal. If reconciliation fails, times out, or cannot establish command state, it returns a blocker rather than starting more work.

The extension aborts only the cancelled workflow-owned Pi turn through public `ctx.abort()`. The server retains that turn until Pi confirms settlement or an idle branch observation proves it lost. The next prompt cannot run before that boundary. Aborting Pi does not prove that third-party detached commands stopped: reconciliation must inspect those commands through their existing owner tools. There is no hidden model retry or new process-control protocol.

Autoimplement uses batches for pi-reviewer and pending CI watches. It keeps model turns, fixes, pushes, comment changes, merges, and releases in their existing order. Reviewer commands are tied to the repository, base branch, reviewed head, and relevant dependency fingerprint. The reviewed head is the pushed head under `prTiming: early` and the local commit under `prTiming: end`, as [Autoimplement publication timing](#autoimplement-publication-timing) describes. A later review round includes only repositories whose head or dependency fingerprint changed. P0 or P1 work still requires another review. P2-only work can be addressed and verified without another reviewer run only because of that P2 work.

Autoimplement inspects every pull request or merge request before it waits for CI. On GitHub, it accepts only supported pending `gh pr checks --watch` or `gh run watch` descriptors and binds each one to the validated pull request as `gh pr checks <PR URL> --watch`. On GitLab, it accepts only `glab ci status` watches and binds each one to the published source branch and the merge request's project, as [Autoimplement forge selection](#autoimplement-forge-selection) describes. Repository and pull-request overrides are rejected. One watch lasts at most five minutes. A failed or timed-out watch affects only its own pull request or merge request. When checks remain pending, the model runs more useful local tests before checking CI again. Autoimplement does not invent an ETA.

A failed batch item's `error` states only its exit status or signal, such as `Command failed: exit 3; its output is in the item's stdout and stderr`. It does not repeat the command's output, which the item keeps in `stdout` and `stderr`, complete up to the item's `maxOutputChars` and marked by the truncation flags. A timeout, cancellation, or spawn failure keeps its complete error text. The action abort signal stops active command process groups and prevents queued commands from starting. Accepted outputs use immutable events and content-addressed blobs. An interrupted unaccepted batch runs again because batch commands are read-only or isolated local checks. Progress updates contain metadata only and never control routing. Truncated reviewer or CI output cannot count as clean. See [Run independent commands in bounded batches](plans/2026-08-20-bounded-command-batches-plan.md) for the complete contract and implementation plan.

A branch blocker does not end Autoimplement by itself. The controller can repair, retry, redesign, move to another safe branch, or return blocked. A blocked decision requires current evidence and at least one checked alternative. The loop permits at most 40 accepted decisions and removes a route after three consecutive returns with the same stable facts. Changed evidence resets that route count. If the controller itself fails or times out three times without an accepted decision, Autoimplement returns a normal blocked result. These limits prevent blind retries while allowing real progress.

#### Autoimplement forge selection

The `forge` input chooses the code forge: `auto`, `github`, or `gitlab`. An explicit `github` or `gitlab` does no detection. With `auto`, the read-only `resolveForge` step runs between `prepare` and the first observation. It reads the remote of `origin`, or of the first remote when `origin` is missing, in the prepared worktree, the prepared repository, or the requested repository, in that order. It then decides as follows:

1. A remote without a network host, such as a local path or a `file://` URL, or no remote at all, selects GitHub.
2. `github.com` selects GitHub, and `gitlab.com` selects GitLab. `altssh.gitlab.com`, the GitLab.com SSH host on port 443, selects GitLab with the host `gitlab.com`.
3. A host in both the `gh` hosts file and the `glab` configuration selects GitHub and records the ambiguity. Set `forge` explicitly in that case.
4. A host that matches a `glab` hosts key, its `api_host`, or its `ssh_host`, or the `GITLAB_HOST` hostname, selects GitLab. This covers a self-managed GitLab whose SSH remote uses a separate SSH hostname.
5. A host in the `gh` hosts file selects GitHub.
6. Any other host selects GitHub, which is the upstream behavior.

Hostnames compare without case, and ports are ignored. The `gh` hosts file is `$GH_CONFIG_DIR/hosts.yml`, else `$XDG_CONFIG_HOME/gh/hosts.yml`, else `~/.config/gh/hosts.yml`. The `glab` configuration is `$GLAB_CONFIG_DIR/config.yml` when `GLAB_CONFIG_DIR` is set, and detection then reads no other `glab` file. Otherwise it is the first file that exists among `~/.config/glab-cli/config.yml` and `$XDG_CONFIG_HOME/glab-cli/config.yml`. Only host keys, `api_host`, and `ssh_host` are read; tokens are never kept. SSH aliases in `~/.ssh/config`, `GL_HOST`, `GITLAB_URI`, and per-repository `glab` configuration are not read. If detection cannot read a file or run Git, it selects GitHub and records the error.

The step records a `pi-workflows.autoimplement-forge-resolution.v1` value with `requested`, the resolved `forge`, the matched `host`, the `remoteUrl` without any URL credentials, and a `reason`. An explicit forge records the reason `explicit input`, or `Autoimplement defaults file` when the forge came from the [defaults file](#autoimplement-defaults-file). The step is an idempotent action, so a runner crash before it commits reruns the detection. A resume replays the recorded result, and a restart detects again. The step is not a control attempt, and the decide ledger leaves it out.

On a GitLab run, a pending CI target accepts only `glab ci status` with one watch flag (`--live`, `-l`, or `--wait`) and optional `--branch` and `--repo` values. The branch must be the published source branch, and the repository must be the merge request's project. The target `pr` must be a merge request URL of the form `https://<host>/<project path>/-/merge_requests/<iid>`. The workflow runs the watch as `glab ci status --live --branch <branch> --repo https://<host>/<project path>`, with the same five-minute limit. A GitHub run rejects `glab` watches, and a GitLab run rejects `gh` watches.

On a GitLab run, the prompts use merge request wording and name `glab`, and validation errors that name the request say MR or merge request. GitHub runs keep the upstream prompts and validation errors byte for byte. The GitLab prompts cover the whole flow:

- **Publication** looks up an open merge request for the source and target branch with `glab api --hostname <host> "projects/<project>/merge_requests?state=opened&source_branch=<branch>&target_branch=<base>"` and reuses it. Otherwise it creates one with `glab mr create`. Both `glab mr create` and `glab mr update` pass `--repo https://<host>/<project path>`, so `glab` never chooses a project from several remotes or writes its choice to `.git/config`. It never creates a second merge request for the same branch pair. The model writes the description itself instead of using the `pr-description` skill. The model reports the merge request `web_url` exactly as `glab mr create` or the API returned it, and the head revision as the full commit SHA (40 hex characters, or 64 in a SHA-256 repository). The prompt includes the recorded forge resolution, whose `host` is the `--hostname` value before any merge request exists. When that `host` is null, which happens for an explicit `forge`, the prompt tells the model to use the `glab` host of the work repository's Git remote instead.
- **Comments** are merge request discussions. The prompt lists them, replies to them, and resolves them through the `glab api` discussions endpoints, and it ignores system notes.
- **CI inspection** reads the merge request's `head_pipeline`, its jobs, and failed job logs through `glab api`. The prompt lists the exact watch command the workflow will run for every target.
- **CI assessment** after a watch reads the merge request through `glab api` again before it returns any route. The merge request's head pipeline decides the route, as described below.
- **Delivery** merges only when merge is allowed, with `glab mr merge <iid> --repo <project URL> --sha <head> --auto-merge=false --yes`. It reports a merge only after a fresh read shows the merge request as merged, because `glab` also exits 0 when it only sets auto-merge. It posts the final report as a merge request note.

Every prompt that acts on a published merge request includes GitLab API coordinates that the program derives from the merge request URL: the `--hostname` value, the URL-encoded project for `projects/<project>/...` paths, the iid, and the project URL. The REST calls work with old and new `glab` builds.

On GitLab, the merge request's `head_pipeline` decides CI, not the watch. The watch follows the newest pipeline of the source branch, which can belong to an older commit or differ from the merge request's own pipeline. Every `inspectCi` and `assessTrackedCi` target therefore reports the head pipeline as `headPipeline` with its full `sha`, its `status`, and its `ref`, or `null` when the merge request has none. The `assessTrackedCi` prompt also carries the GitLab API coordinates, so it can read the merge request.

The head pipeline ran for the published head in one of two ways:

- Its `sha` equals the published `headRevision`. This covers branch pipelines and detached merge request pipelines on `refs/merge-requests/<iid>/head`.
- Its `ref` is `refs/merge-requests/<iid>/merge` or `refs/merge-requests/<iid>/train` of the published merge request, and the published head is a parent of its commit. Merged results and merge train pipelines run on a temporary merge commit, so the model reads that commit with `glab api ... projects/<project>/repository/commits/<sha>` and reports its `parent_ids` as `parentIds`. The iid must be the one in the published merge request URL. For these two refs, `parentIds` is required and must list full commit SHAs.

A target is green only when its head pipeline ran for the published head and has status `success`. A target is failed only when its head pipeline ran for the published head and has status `failed`. Validation rejects any other green or failed target, so the model must correct its result before CI can lead to delivery or repair. This also covers a failed result with only unrelated failures, which offers delivery: it is accepted only when the failed pipeline is the published head's. The prompts map the other cases:

- A head pipeline for another commit, or one that is still `created`, `waiting_for_resource`, `preparing`, `waiting_for_callback`, `pending`, `running`, `scheduled`, `canceling`, or `manual`, is `pending`, because the pipeline of the published head has not finished. A `manual` pipeline waits for a person to start a job, and GitLab does not count it as finished. A pending target waits with the bound watch, or the run tests more locally, and then CI is inspected again. The existing decision and no-progress limits bound that wait.
- A merge request without a head pipeline is `unavailable`. So is a head pipeline of the published head that is `canceled` or `skipped`, because no CI result exists for that head. Neither is a failure of the change, and neither may count as green. The controller can inspect CI again, for example after a person retries the pipeline, and a project without CI ends blocked, as on GitHub.

The static expected-output examples omit `headPipeline`, so the GitLab prompts ask for it. GitHub targets carry no `headPipeline`.

The JSON key `pr` holds the merge request URL on GitLab. GitLab publication validation requires every `pr` to be a merge request URL of the form `https://<host>/<project path>/-/merge_requests/<iid>`. A URL with a port is rejected, because every GitLab prompt reaches the REST API through `glab api --hostname <host>`, and `glab` rejects a hostname with a port. A GitLab instance whose web address needs a port is therefore not supported, even when detection matched it through a `host:port` hosts key. When the forge resolution has a `host`, the URL hostname must equal it, compared without case and without a port. Every `branch` must be the prepared task branch, because the program-run watch names it. Every `headRevision` must be a full commit SHA, because the head pipeline and `glab mr merge --sha` compare full SHAs. A GitLab P2 push must report a full head revision too. Later steps already require the published URL, so they need no separate check. GitHub publication URLs, branches, and head revisions are not checked under `prTiming: early`.

The `statusDetail` and `expectedOutput` strings are static parts of the workflow definition, so they cannot change per run. The ones that named a forge now read correctly on both forges. For example, the comment step's status is "checking PR/MR comments", and the `inspectCi` example shows both the `gh` and the `glab` tracking command forms. The GitLab prompt tells the model to use only the `glab` form.

The `prTiming` input accepts `early` or `end` and chooses when a run publishes. See [Autoimplement publication timing](#autoimplement-publication-timing).

The run settings include the requested `forge` and `prTiming`. Neither model steps nor people can change `forge` during a run. Only a `human` settings actor can change `prTiming`, and only from `end` to `early`. A change from `early` to `end` is rejected for every actor. Settings changes made from a Pi session are recorded as `session` changes today, so this rule cannot yet be used through the server.

#### Autoimplement defaults file

Persistent defaults live in `${PI_WORKFLOWS_CONFIG_DIR:-~/.config/pi-workflows}/autoimplement.json`:

```json
{
  "schema": "pi-workflows.autoimplement-defaults.v1",
  "forge": "gitlab",
  "prTiming": "early"
}
```

`schema` is required. `forge` and `prTiming` are optional, and no other key is allowed. A workflow input value wins over the file, and the file wins over the built-in defaults `auto` and `early`. A missing file means the built-in defaults apply. An unreadable file, invalid JSON, an unknown key, a wrong schema, or an invalid value fails the start with an error that names the file.

Input parsing reads the file only when the input omits `forge` or `prTiming`, then stores both values in the normalized input. When the forge came from the file, the normalized input also records `forgeSource: "defaults"`, so the forge resolution names the file as its reason. Callers do not set `forgeSource`. Parsing a normalized input again therefore never reads the file. A resume uses the stored input and does not read the file. A restart parses the original raw input again, so a changed file takes effect when that input omitted a field. An included Autoimplement, such as a Monitor repair, parses its input in the runner and inherits the same defaults. The file is read in the workflow server runner's environment, not in the Pi session's environment.

#### Autoimplement publication timing

The `prTiming` input chooses when Autoimplement publishes. `early`, the default, commits, pushes, and opens or updates the pull request or merge request before review, exactly as upstream does. `end` keeps every implementation, verification, review, and fix round local. It pushes only after the review gate passes for the exact head it pushes, so no pull request or merge request exists until the review gate passes. The gate passes after a clean review, or after verified P2 work that follows a P2-only review, as described below.

The `publication` route runs `routeVerifiedWorkspace`, a settings route that chooses one of four branches:

- `defaultBranch` for direct default-branch work. That work has no pull request or merge request, so it ignores `prTiming`.
- `publishReviewed` when the newest local work passed the review gate and is not pushed yet.
- `commitLocal` under `end` otherwise.
- `pullRequest`, the upstream `publish`, under `early`.

`commitLocal` commits the verified work on the prepared task branch. It never pushes, never opens or updates a pull request or merge request, and never rewrites a pushed commit. The program checks the reported commit against the work tree: the head must be the checked-out `HEAD` of the prepared task branch, and only paths that were already changed before the run may stay uncommitted. Review then runs `pi-reviewer --base <base>` against that local head.

Nothing may be pushed before the review gate passes. `commitLocal` and `verifyP2Local` therefore also look for a push from this clone. They find the remote-tracking ref of the task branch's push destination, as for a reviewed push, described below, and read that ref's reflog. Git logs `update by push` there when this clone pushes the branch, and logs the fetch or pull command when it fetches. The step fails when an `update by push` entry was written after the run started and no rule below excuses it. Each entry names the commit it pushed, and a push is excused when:

- that commit passed the review gate, as described below. Pushing it exposes no unreviewed work, whichever step pushed it. This covers a reviewed `publish` that pushed the reviewed head and then failed or timed out, and one whose attempt a runner restart discarded: a resume records no step for the interrupted attempt, so its time window is lost;
- an accepted `publish` or `verifyP2` recorded that commit as its head; or
- it was written during a `verifyP2` attempt, including one that failed after it pushed. P2 work is pushed without another review, so its attempt window is what identifies it. Reflog times have one-second resolution, so a push in the same second as such an attempt counts as part of it. A `verifyP2` attempt that a runner restart interrupted has no step record. Its window comes from the run state's [unrecorded attempts](#unrecorded-attempts), from its start until the resume retired it. A push from this clone while the runner was down is therefore excused too.

A `publish` attempt's window excuses nothing by itself, because a reviewed publication must push only the reviewed head. An unreviewed commit that a failing `publish` attempt pushed therefore still fails the next local commit.

Fetch and pull entries never fail the step. Commits that someone else adds on the forge, such as an applied review suggestion or a branch update, therefore do not block the run. The agent can pull them, commit on top of them, pass review, and push the result as a fast-forward.

When Git keeps no reflog for the ref, for example with `core.logAllRefUpdates` turned off, the ref value decides instead. A ref that records a commit that passed the review gate is accepted, so a reviewed `publish` that pushed the reviewed head and then failed or was lost does not fail the next local commit. Otherwise, after a publication of this run, the ref must record the newest published head: the head of the newest accepted `publish` or `verifyP2`. A failed `publish` records no published head. Before any publication, it must record a commit whose committer time is earlier than the run start. That fallback cannot tell a push by this run from a commit that someone else added, so its error names a commit this run did not publish, pushed by this run or by someone else.

The run start is the start of the run's first recorded step. Step records are persisted, so a resume keeps that time.

A failing check tells the model not to push before the review gate passes. Pushed commits cannot be withdrawn without a force push, so the controller should then choose `blocked`. Moving `prTiming` to `early` is not available as a way out yet: only a `human` settings actor may make that change, and no server path can record a `human` settings change today. The Pi session path checks a change as a `resource_manager` actor and records it as a `session` actor, and the ResourceManager path uses a `resource_manager` actor. An absent ref or an unknown push destination counts as no push. The check reads local refs only, so it detects a push only after the fact. With a reflog it detects every push through the push destination that updates this ref, including one that sends only commits made before the run. It does not detect a push that bypasses that ref, such as a push to a URL, to another remote, or to another branch name, and that is then fetched into the ref: the reflog then shows only a fetch, which looks like a commit that someone else added. It also cannot see a push made from another clone.

The review gate passes when the newest work event records a head and every head it records passes. A head passes when its newest successful review found no P0, P1, or P2 findings, or when a passed P2 verification produced it after a P2-only review of its parent. An `implement`, `fix`, or `addressP2` step counts as new work with any outcome, because a failed or timed-out edit may be partial. While a reviewed head is not pushed, a clean review, a reused clean review, or a passed P2 verification offers `publication`, `review`, or `blocked` instead of comments. A reused review of a head that is not pushed and did not pass offers `repair`, `redesign`, or `blocked`.

That publication runs `publish` with the reviewed-head prompt. The model pushes exactly that head without force and creates no commits. It reuses the one pull request or merge request for the branch and base, or opens it when none exists, and never creates a second one. Validation requires the published head, branch, base branch, and dependency fingerprint to equal the reviewed head, and the branch to be the prepared task branch. It also reads local Git state without any network call. The reviewed head must be the checked-out `HEAD` of that branch, with only paths that were already changed before the run left uncommitted. The prompt asks for `git push -u <remote> <task branch>`, so the branch gets an upstream. The workflow then finds the push destination's remote-tracking ref, which must record the reviewed head:

1. `<branch>@{push}`, when Git resolves it to `refs/remotes/<remote>/<branch>`.
2. Otherwise `refs/remotes/<remote>/<branch>` of the first remote set among `branch.<branch>.pushRemote`, `remote.pushDefault`, and `branch.<branch>.remote`, else of `origin`, which Git pushes to by default, else of the only remote. A configured value that names no remote, such as a URL, leaves the destination unknown, and so do several remotes when none is `origin`. This ref counts only when the first positive fetch refspec of that remote that matches `refs/heads/<branch>` maps it to this ref, with no negative refspec excluding the branch, because Git updates only that first match's target on a push. A later refspec that would map the branch here does not count. A stale ref that a push never updates is ignored.

When that ref is absent although the refspec maps the branch to it, the claimed push did not happen, because Git creates the ref on a successful push, so the publish is rejected. When no remote is known, or the refspec does not map the branch, the ref check is skipped. A later reviewed push must report the same pull request or merge request URL as the earlier publication of the run. Its prompt names that URL and tells the model to check it before pushing. If it is closed or merged, the model does not push, because a push to a deleted branch would recreate it, and does not open another request; it reports that the request is no longer open so the controller can choose `blocked`. Otherwise it pushes to it. If the model reports another URL anyway, the error tells it not to open another one and to let the controller choose `blocked`, because one run publishes to one request. A publish that breaks any of these rules fails the step and returns to the controller, which offers `publication` again. After the push, comment handling, CI, and delivery run on that single pull request or merge request.

P2 work follows where the reviewed candidate lives. After `addressP2`, the compute step `routeAddressedP2` sends work on a pushed candidate to `verifyP2`, which verifies and pushes as upstream does. It sends work on a local commit to `verifyP2Local`, which verifies and commits locally and is checked against the work tree like `commitLocal`. A passed local P2 verification is pushed without another review. This is the same P2 exception that upstream makes.

A later fix, for example after a review comment or a failed CI run, repeats the cycle: repair, verification, `commitLocal`, review, and one push to the same pull request or merge request after the fixed head is reviewed clean. Under `end`, the `implement`, `fix`, and `addressP2` prompts say not to push, and the decide prompt states the timing.

Under `early`, every route list, prompt, and step stays upstream. `commitLocal` and `verifyP2Local` never run, and `routeAddressedP2` always chooses `push`. Besides `resolveForge`, the only additions on that path are the `routeAddressedP2` step and the settings-route flag on `routeVerifiedWorkspace`. The decide ledger leaves `resolveForge` and `routeAddressedP2` out before it takes its window of recent steps, so every decide prompt lists the upstream steps.

A `human` settings actor can move `prTiming` from `end` to `early` during a run. After a clean review of a local commit, that reviewed head still gets its single push. Before that review, the next publication pushes before review, as `early` does. P2 work still follows where the reviewed candidate lives. Settings changes from a Pi session are recorded as `session` changes today, so this change cannot yet be made through the server.

### Built-in sanity check

The built-in `sanity-check` workflow reviews a pull request or local contribution before implementation, approval, or merge. It checks whether the change is needed, duplicates existing code, should use a simpler design, adds unnecessary data models or public plugin and SDK APIs, or has scope and test problems.

```json
{
  "mode": "serial",
  "baseRef": "origin/main"
}
```

Serial mode is the default. It runs one review session for all four review areas, then one verification session. Parallel mode runs four focused review sessions at the same time, then one verification session. Serial mode uses two model sessions. Parallel mode uses five. When `baseRef` is omitted, the workflow tries the remote default branch, the current branch upstream, and the first parent, then uses `HEAD` for a working-tree-only review.

The workflow collects pull request intent and repository diff evidence before model review. It bounds evidence and review results before prompt construction and marks truncated input. Every review must cite evidence and give the strongest case for accepting the current design. The verification session removes unsupported claims, requires exact file and symbol references, resolves supported conflicts, and returns `keep`, `simplify`, `refactor`, `drop`, or `needs_evidence`.

Sanity Check creates child sessions directly through the documented Pi SDK. A private built-in runner uses `createAgentSession` with `SessionManager.inMemory`, one independent context per child, and only the verified built-in `read`, `grep`, `find`, and `ls` tools. Child sessions load no skills, prompt templates, themes, or context files. They create no Pi session file.

Revision 7 runs that SDK work in a headless Pi process. The `review` and `verify` actions execute in the plain Node workflow runner, which cannot load the packages that Pi supplies to extensions (see [Host-provided Pi packages](#host-provided-pi-packages)). For each agent group, the runner starts `pi --mode rpc --no-session --no-extensions -e <agent-group-bridge>` with the same [pinned pi](WORKFLOW_SERVER.md#headless-pi-command), server-supplied Pi arguments, environment, process group, and server process registration as a headless agent step. Pi loads the bridge extension with its own module mapping. The runner sends the group as the argument of one bridge command in an RPC `prompt`, which Pi handles without a model turn. The bridge reports lifecycle facts and the final result or error on stderr lines tagged with a random group ID; the runner ignores other output. The runner fails the group if Pi rejects the command or routes it anywhere except the bridge.

Cancellation and action timeouts send a cancel command. The bridge aborts each session, disposes its runtime, which runs provider extension shutdown, and reports each session's final state. The runner waits up to 10 seconds for that settlement. Sessions settle concurrently, and the real-Pi end-to-end test settles in under one second, so the bound leaves room for an extension that closes network clients or saves refreshed credentials. A started session that the bridge has not confirmed by then is reported `cancelled` with the phase `cancelled: headless pi did not report that the session settled`, and queued work that never started is reported `cancelled` with the phase `cancelled: the session did not start`. The runner then stops the Pi process group with `SIGTERM` and, after the one-second stop grace, `SIGKILL`. Pi's own shutdown also settles open sessions while it runs. The 10-second wait applies only while the runner keeps running. When the run itself ends or the runner stops, the runner stops each Pi process group at once with the same one-second grace, and settlement relies on the bridge's `session_shutdown` handler during Pi's shutdown. Once the runner settles a group, it ignores later bridge events, so each request has exactly one terminal state and a reported state never changes. Late events are ignored; when the group's stderr log is kept (failures where pi could not run the group), they remain in it. When a timeout or cancellation has already ended the action attempt, the engine accepts no more progress updates for it, so these late events never reach durable state. The runtime settles the open tracks instead, as [Progress of timed-out and cancelled attempts](#progress-of-timed-out-and-cancelled-attempts) describes: after a timeout, every review or verification track that has not finished shows `failed` with the phase `timed out`, and after a cancellation it shows `cancelled`. Tracks that already finished keep their final state.

If the [pinned pi](WORKFLOW_SERVER.md#headless-pi-command) is unavailable, the action fails before any session starts, with the reason and the restart that pins pi again. If `pi` cannot start, exits before its bridge loads, or exits before the group finishes, the action fails with that cause. Started sessions without a final state are first reported `failed`, and queued ones `cancelled`, so no track stays running. The same applies when Pi rejects the bridge command or the bridge returns without a result. After Pi reports that the bridge command returned, the runner allows five seconds of stderr silence for the final event, and each stderr chunk restarts that wait so a large result in transit still arrives. Such a failure keeps a private log file that holds Pi's complete stderr and, when Pi rejects or misroutes the bridge command, Pi's complete RPC response, beside the group's cause file. The error message quotes no text that Pi supplied and names both files in full, as [Agent group errors](#agent-group-errors) describes. Pi's stderr can contain provider extension output, so Pi Workflows neither copies it into workflow state nor quotes it in the error. The runner deletes the log when the group succeeds, is cancelled, or fails with an error that the bridge reported. A kept log stays at `$TMPDIR/pi-workflows-<runId>-agent-group-XXXXXX/pi-stderr.log` (`0700` directory, `0600` file) for seven days. A runner that is stopped with `SIGKILL` during a group can also leave its directory behind. The action's manual effect never repeats automatically, and the post-workflow model turn can inspect the failure and read both files.

Kept and left-behind diagnostics directories, with their stderr logs and cause files, are pruned after seven days. Before a workflow runner starts its first agent group, it deletes each such directory in the same temporary directory when neither the directory nor any file in it has changed for seven days. It deletes only a directory with that name pattern that is not a symbolic link, belongs to the current user, has mode `0700`, and holds nothing except a `pi-stderr.log` and a `cause.txt`, each optional and each a regular file that belongs to the current user and has mode `0600`. It removes those files and then the empty directory, so it never deletes recursively or through a symbolic link, and it leaves every other entry in place. A running group's output keeps its log current, and Sanity Check's agent group actions time out after 20 minutes, so pruning does not remove the log of a group in progress. A pruning failure is written to the runner's stderr and never fails the group. Seven days leaves time to read a failure after a weekend or a paused run. The retention period is fixed; there is no setting.

The child runner resolves enabled user extension paths, excludes Pi Workflows and project extensions by default, and preflights the remaining paths without creating a session. It admits only the extension that registers the exact configured provider, plus any behavior extension on an explicit private allowlist. When no extension registers that provider, the provider must be one that Pi defines itself: a provider built into Pi or one configured in `models.json`. Children then load no provider extension and use Pi's own provider, as normal Pi does. A provider that neither an extension nor Pi defines fails the group with `has unknown provider` before any session starts. The runner rejects competing provider owners, workflow tools or commands, and extensions that replace a built-in read-only tool. The admitted paths are frozen for the group, and each child loads only those explicit paths without a second discovery pass. The preflight loads every enabled user extension, so a user extension that fails to load fails the group with `could not load provider extensions`. This also happens when the dispatch provider is one of Pi's own and no extension would be admitted.

Each child owns a separate `ModelRuntime`, provider instance, extension runtime, resource loader, and in-memory session. The runner loads the dispatch provider's validated cached catalog entry and its ordinary stored credential into per-child in-memory stores. Children receive no other provider's stored credential, and a child's store never changes: it rejects every write, so a child cannot refresh, replace, or remove a credential. A provider extension that keeps credentials in its own store uses that store in place; Pi Workflows does not copy, print, migrate, or persist those credentials. Each child's model runtime skips its create-time refresh and refreshes once, offline, after Pi registers the admitted extension. Like normal Pi startup, that pass checks every provider's availability, but other providers can find only ambient authentication such as environment variables, and the pass never refreshes an OAuth token.

The server's [extra Pi arguments](WORKFLOW_SERVER.md#extra-pi-arguments) reach the group's host process, but its `--provider` and `--model` do not select the group's model, and a provider extension that they load is not admitted to child sessions.

Each child resolves the exact model the way Pi does, without network access. The sources are Pi's bundled catalog, the provider's cached entry in `<agentDir>/models-store.json`, `models.json`, and the admitted provider extension. Only a physical chat model qualifies, so a virtual model cannot route the session to another model. The cached entry is optional, because Pi writes it only after an online catalog refresh. A group therefore runs before any refresh and with `PI_OFFLINE=1` when its model is built into Pi, declared by `models.json` or the provider extension, or already cached. As in normal Pi, `models.json` overrides, such as a provider `baseUrl`, headers, or `modelOverrides`, apply to the provider's models, including the models of an extension-owned provider, so they can change where Sanity Check requests go. A model that no source lists fails the agent with `has no model` before prompting. Built-in providers authenticate as in normal Pi, from the ordinary credential snapshot, a `models.json` key, or the provider's environment variable. A provider without usable authentication fails the agent with `has no provider authentication` before prompting.

A stored OAuth credential of the dispatch provider is refreshed at most once per agent group, before any child session starts, and never inside a child, as [OAuth credentials in agent groups](#oauth-credentials-in-agent-groups) describes.

A complete explicit provider, model, and thinking override wins. Otherwise, the runner uses the configured process defaults. It passes the exact resolved model and thinking level to the child session, then verifies the actual provider, model, thinking level, authentication, extension state, active tools, and tool sources before prompting. A missing or different dispatch is terminal. The runner never silently falls back to OpenRouter, Kimi, a local model, or another provider or model. It does not promise to inherit a model selected temporarily in the origin Pi TUI.

Children do not receive the `workflow` tool, workflow commands, parent run identifiers, update channels, or workflow callbacks. Prompts that invoke extension slash commands are rejected. The parent Sanity Check action remains the only workflow owner. These controls block normal child model and extension bindings from inspecting or changing workflow state. Extensions still run as trusted code in the headless Pi process that runs the group, so this is not an OS sandbox against direct filesystem or network access.

Only bounded final assistant text and safe operational facts leave a live child session. Pi Workflows does not persist child prompts, reasoning, intermediate messages, tool arguments, tool results, message history, credentials, or extension-private state. No credential, including one that Pi refreshed for the group, enters workflow state, traces, errors, logs, or cause files; Pi itself saves a refreshed credential in `auth.json`. Timeout and cancellation abort active work and settle each session, within the bounded wait described above, before its runtime is disposed, its extensions shut down, and its provider resources released. An agent error never quotes text from a provider, the Pi SDK, or Pi: its message holds only the error code and safe operational facts, and the complete cause stays in a private file, as [Agent group errors](#agent-group-errors) describes.

The workflow publishes aggregate and per-agent `pi-workflows.progress.v1` tracks under `agents/review/*` and `agents/verification/*`. Progress contains role, the verified actual model when known, state, elapsed facts, and safe phases such as `thinking` or `tool: read`. A track's label is its role followed by `·` and the model. The `pi-workflows.progress.v1` schema accepts a label of at most 200 characters, as [Workflow updates](WORKFLOW_UPDATES.md#progress-update-type) specifies and `validateProgressData` enforces. A longer label, which only a long provider or model ID produces, therefore ends with `…` within 200 characters, and a `sanity-check.agent-label` update under the same key keeps the complete label. The Pi widget shows the aggregate plus failed and active children within its ten-line limit. `piw` shows every durable child track and its samples. Both views use the progress records, so no child workflow run is needed.

Serial mode still uses two child sessions, and parallel mode still uses five. Review prompts, review areas, strict result validation, verdicts, and progress stay unchanged. After verification, an assistant-message agent shows the full bounded report verbatim. A mismatch stops before summary generation. The graph then includes `plain-summary`, which shows a short plain-language explanation with the verdict and the most important next action. The detailed response always settles before the summary starts. A final compute node returns the original strict result, so presentation cannot change the verdict. Sanity Check creates no extra terminal model turn.

Each child session is an SDK session inside the headless Pi process that runs its group, not a separate `pi` CLI run. Only the transport between the workflow runner and that process uses an RPC command and JSON events on stderr. Child sessions use no temporary prompt file, standard-output cap, subprocess fallback, shared child runtime, or blanket child-extension ban. See [the Sanity Check plan](plans/2026-08-21-sanity-check-plan.md) for the selected implementation and test boundaries.

#### OAuth credentials in agent groups

A stored OAuth credential of the dispatch provider is refreshed at most once per agent group, before any child session starts, and never inside a child. This covers providers built into Pi or configured in `models.json`, a Pi provider that an admitted extension re-registers, and a provider that only an extension defines, including a legacy provider extension's `oauth` login. All of them keep the credential in `auth.json`, and Pi refreshes it through the provider's OAuth refresh, which an extension can supply. An API key from `auth.json`, `models.json`, or the provider's environment variable needs no refresh and is used as before.

The group first computes how long a child can still make a model request. Each request runs in one of `maxConcurrency` slots and stops at its own `timeoutMs`, so the group's run bound is `ceil(requests / slots) × the longest timeoutMs`. Sanity Check runs one request per slot with a 20-minute timeout, the same as its action timeout, so its bound is 20 minutes. The group adds a 10-minute margin. Five minutes of it cover Pi's own refresh threshold, because Pi refreshes a token in a model request when it expires within five minutes. The other five cover session abort and disposal after a timeout, slot scheduling, and timer delays. A Sanity Check credential must therefore stay valid for 30 more minutes.

When the stored credential expires within that time, the group refreshes it once, in a refresh process of its own. The headless Pi process that runs the group starts that process with the same Node and Pi installation, detached into its own session and process group, and registers it with no supervisor. The refresh process creates Pi's file-backed credential store for `<agentDir>/auth.json`, a model runtime that uses it, and the same admitted extensions as the children, and calls Pi's own authentication with that minimum validity and no abort signal. Pi takes the file lock, checks again under the lock, skips the refresh when another Pi process already refreshed, and writes the result itself, exactly as in a Pi session. Pi Workflows never writes credentials. The refresh process reports only an exit status, so no credential and no error text leaves it.

No stop that Pi Workflows issues reaches the refresh process: not the agent group launcher, the workflow runner, or the workflow server. Stopping a group stops its headless Pi process: a cancellation or an action timeout sends the bridge a cancel and, after the 10-second settle wait, `SIGTERM` and then `SIGKILL` after the one-second grace; the end of a run and a stopping workflow runner use the same grace; the workflow server stops a runner with `SIGTERM` and `SIGKILL` after two seconds and then kills every headless Pi process that the runner registered; and a stopping server, like a starting server that finds the processes an older server registered, kills every registered process. Each of these signals a process or process group that the refresh process is not part of, so it keeps running and Pi saves the rotated credential. A stop from outside Pi Workflows can still interrupt it, as it would interrupt normal Pi: a cgroup or container stop, such as systemd stopping the user session or `docker stop`, an explicit `SIGKILL`, the out-of-memory killer, or a reboot. A cancelled group starts no refresh, but a cancellation that arrives after the refresh process has started does not prevent the refresh; the group waits for it to finish before it reports the cancellation or action timeout, for at most two minutes.

The refresh process ignores `SIGTERM`, `SIGINT`, and `SIGHUP` while a refresh is in flight, and exits on its own. It exits within 60 seconds when the refresh has not started, for example because an extension is stuck loading. Once the refresh has started, Pi normally returns within its lock wait of up to 30 seconds plus its 15-second refresh timeout, which a provider's refresh receives as its abort signal. A provider refresh that ignores that signal could otherwise run forever while Pi holds the `auth.json` lock, so the refresh process also exits 5 minutes after the refresh started, even with the refresh still in flight. That ceiling is well past Pi's own bounds and the group's two-minute wait. Tests can shorten it only with an explicit test switch; without the switch, the group never passes a test ceiling to the refresh process, and the refresh process never uses a ceiling below 45 seconds, Pi's lock wait plus its refresh timeout. Exiting releases Pi's lock. A refresh that the ceiling ends can lose a token that the provider rotated after that long, and the group then reports `could not refresh OAuth credentials`.

While it runs, the refresh process keeps a marker, `<pid>.json` (mode `0600`) in `${PI_WORKFLOWS_CONFIG_DIR:-~/.config/pi-workflows}/oauth-refresh/` (mode `0700`), with its process ID, the provider ID, and its start time, and no credential data. It writes the marker under a pending `<pid>.json.tmp` name and renames it into place, so no other process sees it half-written, and it removes the marker when it exits. The marker directory must be a private, writable directory of the user, not a symbolic link: without a marker the refresh process does not refresh, and the group fails as `cannot record the OAuth refresh process`. Reading and pruning the markers skip any other directory and touch only `<pid>.json` files and pending markers older than ten seconds. `pi-workflows server status` lists the markers as `oauthRefreshes`, each with `running: false` once its process is gone or older than any refresh process lives. A marker stays behind only when the process was killed, and the next refresh removes stale markers before it starts. The refresh process needs the Node build of Pi, whose package holds the SDK and the credential store, and a package build of Pi Workflows runs its compiled entry. A source checkout runs the TypeScript source through tsx, a dependency of the package, so it needs no Node type stripping.

The group then reads the stored credential again through Pi's file-backed credential store, under its lock, and every child receives that one credential. It never switches a group to another kind of authentication on its own: when the entry is gone or is no longer an OAuth credential after the refresh, the group fails as `could not refresh OAuth credentials`, even when an environment variable or `models.json` would provide an API key.

The group fails before any session starts, with no lifecycle event and no model request, when:

- the refresh fails, leaves the stored credential unchanged, or leaves no OAuth credential: `Pi agent group could not refresh OAuth credentials: <provider>; sign in to the provider again in Pi, or configure an API key for it`;
- the refreshed credential still expires within the required time: `Pi agent group has OAuth credentials that expire too soon: <provider>; the refreshed credentials expire before the agent group can finish, which can take <minutes> minutes`;
- Pi cannot lock, read, or write `auth.json`, which Pi reports with its `auth` error code: `Pi agent group could not lock or update Pi credentials: <provider>; another Pi process may be holding auth.json, or Pi could not write it; retry the agent group`;
- the Pi installation lacks the SDK or credential store module, or their API differs, as with a compiled Pi binary: `Pi agent group cannot refresh OAuth credentials: <provider>; this Pi installation does not provide the modules that agent groups use to refresh OAuth credentials; use Pi's Node package, or configure an API key for the provider`;
- the refresh process cannot write its marker: `Pi agent group cannot record the OAuth refresh process: <provider>; make <config dir>/oauth-refresh a private directory of this user`;
- neither the compiled refresh entry nor tsx for its source is available: `Pi agent group cannot refresh OAuth credentials: <provider>; this Pi or Node installation cannot run the OAuth refresh process; configure an API key for the provider`.

A refresh error can quote the provider's token response, so Pi Workflows keeps its text nowhere: not in the message, the private cause file, workflow state, or traces. The messages name only the provider and the required minutes.

A child never refreshes through Pi. Its credential store rejects every write before Pi's refresh runs, so Pi cannot send the refresh token from a child. A child that would still need a refresh, for example because the clock moved past the window, fails with `Pi agent <id> would need to refresh OAuth credentials mid-group: <provider>; an agent group refreshes OAuth credentials only once, before it starts`. The children of one group therefore never refresh in parallel through Pi, and none of them races the parent Pi's locked credential file. The guarantee covers Pi's refresh path. An admitted provider extension receives the stored credential, including its refresh token, for example in a legacy `oauth` login's `getApiKey`, and it can use it on its own; such an extension is trusted code, exactly as in normal Pi.

#### Agent group errors

A failed agent group fails its Sanity Check `review` or `verify` action with one `PiAgentGroupError`. Its message reaches run state, the trace, `piw`, the Pi widget, and the post-workflow model turn, so it holds only text that Pi Workflows writes itself:

```text
Pi agent <agent id> <code>: <facts>. complete cause: <directory>/cause.txt
```

- `<agent id>` is the request ID, such as `review`, `security`, or `verification`, or `group` for the group as a whole.
- `<code>` names what failed, for example `stopped with error`, `timed out`, `cancelled`, `failed`, `cleanup failed`, `has an invalid request`, `has no default model`, `has no model`, `has no provider authentication`, or `could not run`.
- `<facts>` are safe operational facts: fixed text such as `the provider reported an error`, `the session raised an error`, `the session abort failed`, or `pi rejected the agent group command`, Pi Workflows' own validation text such as `Duplicate Pi agent id: review`, and IDs, durations, counts, exit statuses, extension sources, and provider and model IDs.

Text that a provider, the Pi SDK, Pi, or the operating system wrote is private detail and never enters the message. That covers a provider's `errorMessage`, a thrown SDK error, the error of a failed session abort or disposal, Pi's RPC rejection, and a spawn error. Pi Workflows reports its own validation of the requests as `has an invalid request` with that validation text as the facts, so it stays visible. Its own loader failures stay visible too, for example `Pi agent group failed: Could not load Pi credentials for isolated agents`, `Could not load Pi model catalog for isolated agents`, or `Could not resolve Pi child extension path`. The underlying filesystem or parser error is private detail. A parse error of `auth.json` is kept nowhere, because it can quote a credential. Any other error, such as a settings, package manager, or extension failure while the group is prepared, becomes `Pi agent group failed: the agent group raised an error`, and all of its text is private detail. The group runner normalizes every error at its boundary, and the bridge keeps facts only for an instance of the group runner's own error class. It never recognizes an agent error by its name or fields, so a foreign error that copies them stays private too. Pi Workflows shortens neither the message nor the detail.

The workflow runner writes the complete cause to `cause.txt` in the group's private diagnostics directory, `$TMPDIR/pi-workflows-<runId>-agent-group-XXXXXX/`, beside `pi-stderr.log`. The directory has mode `0700` and the file mode `0600`. The file holds `Pi agent <agent id> <code>: <facts>` and, when the error has private detail, a blank line and the complete detail. Every failure of a group that the runner started in headless pi keeps its cause file. A failure that the bridge reported keeps only `cause.txt`. A failure where pi could not run the group also keeps `pi-stderr.log`, which its message names after the cause file, followed by the launch hint:

```text
Pi agent group could not run: pi rejected the agent group command. complete cause: <directory>/cause.txt; complete pi stderr: <directory>/pi-stderr.log. The workflow runner starts agent groups with the same pinned pi, …
```

If the runner cannot write the cause file, the message says `complete cause was not saved: <reason>` in place of the path and still quotes no private detail. A cancelled group keeps no file, because its reason comes from the workflow runner. Errors that the runner raises before it starts pi, such as an unavailable pinned pi or a missing bridge, contain only Pi Workflows' text, so their message is their complete cause. When starting pi itself fails, for example because the server refuses to supervise the child, the group fails with `could not run: headless pi could not be started`, and the underlying text is private detail. A lost run claim keeps its own error, because the engine stops on it. If stopping pi or removing diagnostics fails after a group ends, the runner writes that to its stderr, and the group keeps its result or error. Kept directories are pruned after seven days, as described above. The post-workflow model turn receives the message, so it can read the named files to explain the failure.

### Built-in monitor

The built-in `monitor` workflow turns a plain request to finish and monitor an
authorized goal into one looping workflow run. It accepts only `task`,
`stopWhen`, `everyMinutes`, and `maxChecks`:

```json
{
  "task": "Finish pull request 123 within the recorded repository and delivery authority.",
  "stopWhen": "The pull request is merged or safe continuation is blocked.",
  "everyMinutes": 30
}
```

The first `observe` step runs immediately and is read-only. It inspects the real
target with normal tools and chooses `wait`, `act`, or `stop`. `wait` means that
useful target work is moving or an external event must finish. `act` states one
safe action that existing authority permits. `stop` means that the goal is
complete or cannot continue safely.

An `advance` or `recover` action runs directly in a separate normal-tools step.
A `repair` action composes the shared plan-change workflow and Autoimplement.
Monitor observes again immediately after every action. It stops instead of
repeating a completed repair when the same stable failure and target state
return. The timer is reachable only from `wait`.

`everyMinutes` defaults to 30. Every accepted observation provides one concise
report that separates Monitor state, goal state, and target work state. The
runtime queues that report as a workflow notification with `triggerTurn:
false`, so it does not cause an assistant reply. An observation can also provide
independent progress tracks. The regular Pi model observes the target and
submits those facts. Pi Workflows validates counts and calculates rates,
confidence, and ETA deterministically. The target does not need a Pi Workflows
dependency or reporting protocol.

Intervals must be whole minutes from 1 through 1,440. When `stopWhen` is
omitted, the monitor stops only after an explicit user request. `maxChecks`
defaults to the disclosed observation safety limit of 1,000 and cannot exceed
it. Callers omit `maxChecks` unless the user requests a fixed count. Unknown
fields fail before a run is created. See [MONITOR.md](MONITOR.md) for the
observation, action, and progress schemas.

The interval uses the existing shell action to launch the current Node
executable with a timer. This works on every platform supported by Pi. The node
and command timeouts are higher than the maximum interval. Cancelling the
workflow aborts the timer process immediately. If the owning Pi process or
standalone server stops during the wait, normal parking rules abort the shell node
and resume later by running that wait again from the beginning.

A monitor uses the session's single active workflow slot. It does not provide
cron syntax, calendar scheduling, OS notifications, or a background service.

## Runner capacity

Workflow runs and resource-manager reconciles share one workflow server scheduler. Start, restart, resume, result validation, and timeout recovery all wait for the same runner capacity. The default is four execution runners; set `PI_WORKFLOWS_MAX_RUNNERS` before starting the workflow server to change it. Waiting and paused requests keep their durable identity without occupying a runner. A submitted candidate stays durable until a runner can validate it. Cancellation does not wait for capacity.

One unfinished interactive run reserves its origin Pi session, including while waiting or paused. Independent headless work does not reserve that session.

## The step contract

Every `agent` prompt ends with a step contract block naming the workflow, the
step id, attempt id, durable request id, and expected output shape:

```
---
Workflow step contract (workflow: autoimplement, step: review, attempt: 6f9d…)

This step is your work now. Nothing else will start it, so do not sleep or poll for another step.
Complete this step by calling the `workflow` tool exactly once with:
{"action": "submit", "requestId": "request-EXACT_ID_FROM_CONTRACT", "output": <your result>}
Expected output: { "route": "clean" | "issues_found", "reason": "short justification" }
The step is complete only after the workflow tool accepts the output.
If the tool reports a validation error, correct the output and call it again.
```

The `workflow` tool uses `{ action: "submit", requestId, output }` for step
results. The request binds one run and one attempt. Loops and retries get new
request IDs; they cannot accept an earlier request's output. A missing, stale,
wrong-kind, or other-session request is rejected, as is output that fails
`validate`. The server never selects the oldest pending request.
Acceptance resolves the step and the engine advances. In an interactive Pi
session, each agent prompt arrives as a `pi-workflows-step` custom message
with `triggerTurn: true`. The coordinator sends a step only while Pi is idle, so
a pending step starts a new model turn and the model ends its current turn
instead of sleeping or polling for it. The model receives the complete prompt,
while the conversation shows a compact workflow and node card. Expanding tool
output with Ctrl+O shows the exact contract and full prompt. Step messages with
reason `resumed` use the same card and keep the active attempt ID.

Headless RPC execution receives the same complete prompt without TUI metadata.
Workflow notifications use a custom message with `triggerTurn: false`, so a
notification does not start an assistant response. Step prompts, decisions, notifications, terminal results, and follow-ups use the same saved workflow-message contract and extension coordinator. Initial and resumed prompts use the same step kind. See
[Workflow messages in Pi](WORKFLOW_STEP_MESSAGES.md) and the approved
[workflow-message restoration plan](2026-09-02-unify-workflow-messages-plan.md).

## Agent prompt budget

One agent prompt is one model request. The request must fit the model context window together with
the session context and the reserved answer, so an agent prompt has a ceiling.
`PROMPT_CEILING_CHARS` in `src/workflows/prompt-evidence.ts` is that ceiling, and it is the same
number that the Pi agent group uses to validate a prompt. It bounds the prompt a builder writes. The
engine then appends the live-control block, whose settings summary is itself capped at 8,192
characters, and the step contract, so one complete request can be that much larger than the ceiling.
That headroom is far below the context window the ceiling protects. The context window is the named
external interface that justifies a limit, and the complete result stays available in run state.

Step results can be large. One verification result can carry command logs of up to
`MAX_COMMAND_BATCH_OUTPUT_CHARS` per check, and a result that several steps recorded can reach
several prompt lines. `projectEvidence` builds a bounded copy of a value before it reaches a prompt:

- an object whose `schema` has a registered evidence view is replaced by that view's result;
- a string longer than `EVIDENCE_TEXT_CHARS` becomes a reference with a head and tail excerpt, its
  character count, and a digest;
- an array over `EVIDENCE_MAX_ITEMS` keeps its first items and adds one reference naming the rest;
- an object over `EVIDENCE_MAX_FIELDS` keeps its first fields and adds one reference naming the rest;
- a subtree deeper than `EVIDENCE_MAX_DEPTH` becomes one reference;
- anything the rules cannot represent, including a cycle, becomes one reference.

An evidence view is a pure function of one typed result, exported next to the type that defines it.
It keeps the fields a routing decision reads and names a bulk payload by size instead of carrying it.
The change-verification view in `src/builtins/change-verification.workflow.ts` is the first one, and
it keys off the versioned `schema` identifier that the durable result already carries. A result type
with no registered view is still bounded by the generic rules, so a new producer cannot widen a
prompt by being added.

`EVIDENCE_MAX_ITEMS` follows `MAX_COMMAND_BATCH_ITEMS`, because a command batch is the largest list a
registered view carries whole. A smaller item cap would drop checks that a view named, and the size
budget, not the item cap, is what bounds one prompt.

Two rules keep the walk finite. A view runs once per schema on a path, so a view cannot recurse
through its own replacement, and a view result opens a fresh depth budget. Without that second rule,
what a model saw of one result type would depend on how deeply the prompt happened to nest it: the
observation nests a result two levels deeper than a ledger entry does.

The change-verification view keeps the route, the reason, the prepared workspace, the findings, and
the fingerprints, and it names each verification command by its id, outcome, exit code, duration, and
log size. The view drops the log text only, because the durable result keeps it and
`outputReferences` names it.

Projection shapes a prompt only. `state.steps[].output` keeps every complete result and
`state.steps[].prompt` keeps every complete prompt, so a recorded run stays readable and resumable.
The autoimplement decide prompt projects its observation and its recent-attempt list, and then
measures the assembled prompt. When the projected evidence still does not fit, the oldest ledger
entries collapse to references, and then the largest observation field collapses to one. The order is
fixed, so the prompt keeps the newest results and the small decisive fields, such as the available
routes, for as long as it can. `boundLedger` and `boundEvidence` do that work. An overflow that
remains is a named error that reports the size of the fixed lines, the observation, and the
recent-attempt list, so the next reader knows which part did not fit.

## Visible responses

Workflow nodes normally produce structured values for routing and persistence.
When a person must receive normal prose, use an agent node with
`expectedOutput: assistantMessage()`. The runner parks and records the exact
step request. The origin Pi session starts the model turn, and the visible
assistant text becomes the node output after the turn settles.

The request keeps its node and attempt ID across Pi reload. The extension first
looks for an existing session entry with the durable request ID. It inserts a
new visible message only when no adopted entry exists. A repeated submission
returns its stored receipt.

A headless resource manager child cannot produce a visible assistant message without
an approved origin-session binding. Use structured agent output for detached
work. A terminal run creates its own terminal workflow message through the shared coordinator only after the outcome is durable.

## Runtime behavior

Runs execute one node at a time. Runners propose narrow transitions; the workflow server
validates and commits them before execution moves on. A start must follow the
accepted graph route. A completed run must return its accepted final node output.
Runners cannot skip a checkpoint, rewrite an active attempt's start, or replace
the full saved run state. Defaults worth knowing:

- Node timeout is 15 minutes unless the node sets `timeoutMs` to a positive
  number or context callback. A timed-out node has outcome `timed_out` and can
  be routed with `$result.outcome`. A timed-out agent node also aborts its Pi
  turn, and late output for that attempt is rejected. Interactive runs save the
  resolved budget before they park. The workflow server records active intervals with a
  monotonic clock. Message delivery, waiting, pauses, disconnects, wall-clock
  changes, and server downtime do not consume the limit. Recovery keeps the last
  saved elapsed-time sample without rewriting the attempt's start timestamp.
  Human decision deadlines remain absolute wall-clock deadlines.
- `maxSteps` (workflow-level, default 100) bounds loops built from cycles in
  the graph.
- `/workflow pause` atomically parks the run with `paused: true`, stores the
  receipt, and fences the runner before process-group shutdown. `/workflow
resume` takes a new generation and reruns only work after the last durable
  boundary.
- The server tells each runner to `start`, `resume`, or `restart`.
  An answered checkpoint resumes its exact attempt in the same run. An explicit
  restart creates a new child run at the workflow start. The model-facing result
  returns the child as `runId`, the terminal source as `parentRunId`, and the
  saved `restartNumber`, and tells the model to continue with the child.
- Resuming an active run adopts the existing work. Duplicate start, control,
  update, and submission messages return their stored receipts.
- A start is committed as `queued` with its final run ID before the command
  reports success. Cancellation can use that run ID before its scheduled runner
  starts. Active cancellation commits its terminal state and command receipt
  together before runner shutdown. It cancels effects that have not started,
  marks applying effects ambiguous for explicit recovery, and settles the
  cancelled attempt's open progress tracks. `workflow status` and
  `workflow cancel` can use the run ID immediately.
- One interactive workflow request is presented per Pi session. Other requests
  remain durable and ordered.
- Each protected write renews only its exact live token and generation in the
  same transaction. Claim loss does not write a failed run event.
- An uncommitted pure or idempotent node can run again after a runner crash. An
  uncertain manual effect parks as ambiguous and never retries automatically.
  If a ready runner exits before the saved run revision advances, the server parks
  the run with `runnerNoProgress`. The scheduler does not claim it again until
  an operator explicitly resumes or cancels it.
- Server status reports safe counts and timestamps. It does not report session
  IDs, project paths, prompts, payloads, tokens, process IDs, or credentials.

## Progress of timed-out and cancelled attempts

A progress track belongs to the attempt that published its current record.
Publishers mark finished tracks with a terminal status. An attempt that times
out or is cancelled cannot do that any more: once its abort signal fires, the
engine rejects every update from that attempt, so an action that ignores the
signal and keeps reporting never changes durable state. The runtime settles
those tracks instead.

When an attempt ends with the outcome `timed_out` or `cancelled`, every
`progress` track whose current record belongs to that attempt and whose status
is not `completed`, `failed`, or `cancelled` receives one more record for the
same attempt:

| Attempt outcome | `status`    | `phase`     |
| --------------- | ----------- | ----------- |
| `timed_out`     | `failed`    | `timed out` |
| `cancelled`     | `cancelled` | `cancelled` |

The progress profile has no timed-out status. `failed` keeps a timed-out track
with the failed tracks that the Pi widget lists first, and the phase says why
the track ended. The record keeps `label`, `completed`, `total`, `unit`, and
`sourceUpdatedAt`, and drops `sourceEstimatedFinishAt`, because the finish
estimate no longer applies.

- Terminal tracks, other update types, and tracks whose current record belongs
  to another attempt keep their records. A retry runs under a new attempt ID,
  so settling one attempt never changes a retry's tracks, and a retry that
  publishes a key again replaces the settled record with its own.
- Settlement records are ordinary updates. Each one is a `workflow_updates`
  row and an `update_published` event for the ended attempt, so the run view,
  the Pi widget, and `piw` show them like any other update. They do not count
  toward the publication rate limit.
- The engine waits until every publication that the attempt started before the
  abort has settled, then writes the settlement records before the attempt's
  `node_failed` event. A publication that was in flight at the abort can still
  finish its track, and the engine never overwrites that terminal state.
- A rejected settlement record never changes the attempt outcome or its route.
  A lost claim still stops the runner.
- A workflow server cancellation commits outside the engine and then stops the
  runner, which has lost its claim. The queue's cancellation transaction
  therefore writes the `cancelled` settlement records itself, for every
  attempt it cancels: the active attempt of a running run, and the open
  attempt of a paused, parked, or expired run. The records, the cancelled
  attempts, and the cancelled run commit together, or none of them do. Each
  record advances the run revision once, as
  [SQLite state](SQLITE_STATE.md#write-contract) describes.
- A parked attempt is abandoned for resume, not ended, so its tracks stay open.
  This includes a runner that the workflow server stops for a pause, a
  handoff, or a server shutdown. If the run is cancelled while it is parked,
  the cancellation settles them.

Known limitations:

- When a parked run resumes and the node runs again under a new attempt, the
  discarded attempt's open tracks are not settled. A track is replaced only
  when the new attempt publishes the same key again. A key that the new
  attempt never publishes keeps its last open state, also after the run later
  completes or is cancelled.
- A run that the workflow server fails without the engine keeps the open
  tracks of its last attempt. The server does this with
  `WorkflowRunQueueStore.failWorkflowRun` when the missing-submission
  reminders run out or a runner cannot load its workflow source. Those tracks
  keep the last state that their attempt published, while the run and node
  status show the failure. `WorkflowRunStore.markRunInterrupted`, which fails
  an abandoned run as interrupted, behaves the same way, but nothing in
  production calls it at present.

## Wake recovery

The server survives laptop suspend and resume instead of restarting on every
wake:

- The authenticated owner re-arms its own expired lease. Lease renewal matches
  the recorded epoch, server id, token hash, pid, and process start identity,
  so a lease that expired while the machine slept re-arms on the first
  post-wake heartbeat and the server keeps serving. The server stops only when
  its claim was genuinely superseded, meaning another server took the epoch.
- Takeover requires the recorded holder to be provably not serving. Before its
  epoch claim, a starting server probes the socket with a bounded hello check,
  whatever the server lock file says: missing, naming a dead process, or naming
  a live one. A server that answers makes the new server exit with its
  `already running` message, even when the lock file is gone. A holder that is
  mid-shutdown or frozen and does not answer lets the start continue to the
  epoch claim. The epoch claim row stays the fencing authority: a probe misfire
  costs one wasted start, never two serving servers. When the superseded
  holder's process later exits, the operating system unlinks the socket path
  its own listener bound, which is the path the replacement now serves; the
  replacement re-creates the socket file within one poll tick while its claim
  still names it, and clients retry through the brief window.
- Only the epoch owner writes `server/server.lock.json`, except in the
  poll-repair race listed below. The probe only reads,
  so a starter owns nothing on disk until it wins the claim. A starter whose
  claim is fenced exits without writing or removing the lock file or the
  socket, and without reaping the owner's child processes. This holds when
  many sessions respawn servers at once, as during `pi-workflows server stop`.
  The claim winner reaps exact stale child processes and then writes its own
  lock record atomically: a private temporary file in the same directory is
  renamed over the lock. While the claim row still names the owner and its
  epoch, every poll rewrites a lock file that is missing or names another
  record. A superseded server never rewrites it, except in the poll-repair
  race listed below.
- A server removes the lock file only while it still owns the epoch and the
  lock names it. Stop, and a startup that fails after the claim, remove it
  before they release the claim. A superseded server leaves the lock to its
  successor, which may have claimed the epoch without having written its
  record yet. Four narrow windows remain, in which the owner's lock file is
  missing or names the superseded server. In each of them the owner's poll
  rewrites the lock within one claim poll, 2 seconds by default:
  - The lock's server ID check and the removal are separate steps, so a
    successor that claims an expired lease after the ownership check and
    writes its lock between those two steps can still lose its record.
  - When the ownership read fails, for example because the state database
    cannot be read, the removal falls back to the lock's server ID check
    alone. A superseded server then removes a lock that still names it, so a
    successor that claimed the epoch earlier and writes its lock between that
    check and the removal loses its record.
  - The poll's own lock repair also checks ownership and rewrites the lock in
    separate steps. When it finds the lock missing or foreign and a successor
    claims an expired lease and writes its lock between those steps, the
    superseded server overwrites the successor's record with its own. It
    later leaves that record in place, because it no longer owns the epoch.
  - During the first restart onto this behavior, the stopping server still
    runs the earlier code, which releases its claim before it removes its
    lock.
- Clients re-spawn failed replacements. When a spawned server exits without
  becoming ready, the client starts the next one within the same start window,
  capped at three attempts, so one lost race costs milliseconds instead of the
  whole window.

`expires_at` in the server claim answers whether the lease is currently valid
for takeover arbitration. It does not answer whether the owner process is
alive; ownership is proven by identity and token.

## Run history retention

Pi Workflows keeps a terminal root run and all its explicit restart descendants for 30 days from `finished_at`. The server can remove the tree after that point only when every descendant is terminal and no protected work or outside reference remains.

Protected work includes waiting or parked runs, live queue rows, pending workflow messages, open workflow turns, pending interactions or decisions, recording session segments, queued follow-ups, active leases, unsettled effects, controller ownership, active runner content, resumable checkpoints, and undelivered terminal results.

The server checks for cleanup after startup recovery and after workflow runners exit. It also schedules a daily check after each completed sweep. Cleanup runs only while normal server work is idle. One process completes at most one sweep in 24 hours. If work appears, cleanup stops between complete root trees. The next idle lifecycle trigger or a five-minute idle retry continues it.

Automatic cleanup does not create a backup. The explicit `pi-workflows state prune` apply command still requires a new absolute verified backup. Both paths use the same eligibility, deletion, and blob-reference rules.

An undelivered terminal result is protected work, so its run stays until its session receives it. A terminal message addressed to a session that never connects therefore keeps its run forever. `pi-workflows state status` and `pi-workflows state verify` list each such message as a notice once it has been pending for an hour and its session has left no evidence of reporting to the server. A notice changes nothing and does not fail verification. [SQLite state](SQLITE_STATE.md#undelivered-terminal-messages) describes the rule, the output, and the manual removal procedure for a maintenance window.

Deleting a run tree removes its unreferenced blobs. SQLite can reuse those pages immediately. Automatic `VACUUM` runs only while the server remains idle, at least 64 MiB is reclaimable, and at least 20 percent of pages are free. A failed or skipped compaction does not restore deleted history or make free pages unusable.

Retained runs keep complete resume and viewer behavior through the existing bounded reads. An expired deleted run no longer appears in lists and a direct view returns not found. Pi session history is not changed.

This is a history policy, not a hard disk limit. Recent or protected runs can be large. See [SQLite state](SQLITE_STATE.md) and [the automatic state-retention plan](plans/2026-09-04-automatic-state-retention-plan.md) for the full safety and test contract.

## Workflows started by resource managers

A resource manager can start a workflow as a finite child job with `ctx.workflows.ensure()`. The request key is stable across reconciliation passes, and the input fingerprint prevents one key from being reused for different work.

```typescript
const run = await ctx.workflows.ensure({
  requestKey: `repair:${resource.metadata.generation}`,
  workflow: "repair-pull-request",
  input: { repository: resource.spec.repository, number: resource.spec.number },
});

if (run.state !== "succeeded") {
  return ctx.requeueAfter(5_000, {
    workflowRun: {
      requestId: run.requestId,
      ...(run.runId ? { runId: run.runId } : {}),
      state: run.state,
      attempt: run.attempt,
    },
  });
}
```

Child workflow completion queues the parent resource again. The global server runs the child through the same queue and supervised runner model as any other run. A server or runner crash resumes the existing durable run when its committed effect state makes that safe. Consequential external mutations belong in the workflow or resource manager effect API; an uncertain result stops for explicit recovery.

See [RESOURCE_MANAGERS.md](RESOURCE_MANAGERS.md) for resource manager definitions and the full recovery contract.

## Headless extensions

Headless Pi children start with `--no-extensions` and load only their bridge, so
a provider that only a user extension registers is unknown there. Set
`PI_WORKFLOWS_HEADLESS_EXTENSIONS` in the environment of whatever starts the
workflow server to list the absolute paths of extension files, separated by the
platform path delimiter. A server that a Pi session starts inherits that session's
environment:

```bash
PI_WORKFLOWS_HEADLESS_EXTENSIONS=/abs/path/provider-ext.ts pi
```

Every headless agent step and Sanity Check agent group host then loads each
listed extension after its bridge. Select the extension's provider with
`defaultProvider` and `defaultModel` in the user's settings, or with
`pi-workflows server run -- --provider <provider> --model <model>`.

- The opt-in is off by default, so headless children keep their default
  authority.
- The server reads the list once at start and keeps it until it restarts. After
  changing the variable, restart the server with `pi-workflows server stop`.
  `pi-workflows server status` reports it as `headlessExtensions`, with each
  configured path and the real file behind it.
- Each entry must be the absolute path of an extension file, such as
  `<package>/dist/index.js` or `<package>/index.ts`, that is not part of
  pi-workflows. A directory is refused: Pi would resolve it like a package and
  could load other extension files, pi-workflows among them, plus the package's
  skills, prompts, and themes. One bad entry makes the whole list invalid. The
  server still starts and reports the reason, and every headless child fails
  with it instead of running without the extension.
- The server pins the real file behind each entry at start, and children load
  that file. Before each launch, the runner checks every entry again and fails
  that launch when the file is gone, no longer passes the checks, or now
  resolves to another file. The file's contents are not pinned, so an edit to
  the same file takes effect at the next launch.
- The whole extension loads, with its tools, hooks, and commands, into every
  headless child for every run and project that the server handles.

See [Headless extensions](WORKFLOW_SERVER.md#headless-extensions) for the
complete rules.

## Headless step model

A headless agent step runs in `pi --mode rpc --no-session --no-extensions -e <rpc-bridge>`, followed by `-e` for each of the [headless extensions](#headless-extensions) and the server's [extra Pi arguments](WORKFLOW_SERVER.md#extra-pi-arguments). Headless runs use it, including the runs that resource managers start. Pi chooses the child's model once, when the child starts:

1. `--model`, with or without `--provider`, from the extra Pi arguments. Pi exits with an error when it cannot resolve them, so the step fails with the child's exit.
2. Otherwise, when `--models` or the `enabledModels` setting sets a model scope, the settings default if the scope holds it, else the first scoped model.
3. Otherwise, the settings default: `defaultProvider` and `defaultModel` from the user's `<agent dir>/settings.json`, overridden by the run project's `.pi/settings.json` when Pi trusts that project. Headless pi has no trust prompt, so it trusts a project only from a remembered decision or the `defaultProjectTrust` setting.
4. Otherwise, Pi's first available model with configured authentication.

Workflow definitions, step contracts, and the RPC executor never choose a model. The executor sends no `set_model`.

Pi moves from step 3 to step 4 without a diagnostic when it cannot use the default. Headless pi loads no extension except the bridge, the [headless extensions](#headless-extensions), and those in the extra Pi arguments, so a default whose provider only a user extension registers would otherwise run the step on another model. The bridge therefore checks the session's model when Pi emits `session_start`, after Pi chose the model and before it reads any RPC command. It stops pi when all of these hold:

- the command line names no `--model`;
- the effective settings set both `defaultProvider` and `defaultModel`;
- the session did not start on that model; and
- the child cannot use the default: it has no such provider, the provider has no such model, or the provider has no configured authentication. A usable default that a model scope leaves out is Pi's normal step 2 choice and is not an error.

The bridge then writes one error line to stderr and exits before any model request. It also stops pi when the check itself fails, because Pi would otherwise carry on after the extension error. The step fails with an error that names the default, the settings file that sets each field, the reason, the model that Pi would have used, and the fixes: load the provider's extension through `PI_WORKFLOWS_HEADLESS_EXTENSIONS` or with `-e`, name a model with `--provider` and `--model`, or change the default. It also says that the server reads `PI_WORKFLOWS_HEADLESS_EXTENSIONS` and its extra Pi arguments only when it starts, so a change needs `pi-workflows server stop`, and that `pi-workflows server status` shows the loaded `headlessExtensions`. Every later headless step in that run fails with the same error without starting pi again. The run then fails like any other failed step, and the post-workflow model turn and recovery behave as usual.

With no settings default, or with only one of the two fields, Pi ignores the default, as it does in an interactive session, and the step runs on Pi's first available model. Headless pi may lack the extension providers of an interactive session, so this choice can differ from the interactive one. Name a model with `--provider` and `--model` in the extra Pi arguments when the choice matters. If no model is available at all, Pi itself exits at start and the step fails with that exit.

The [Sanity Check](#built-in-sanity-check) agent group host loads the agent group bridge instead and makes no model request itself. Its child sessions check their own exact model.

## Host-provided Pi packages

Pi supplies `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` only to code that Pi loads itself. `pi install` installs this package with npm's legacy peer handling, so those packages are absent from an installed package tree. They resolve only through Pi's extension module mapping.

The workflow server, workflow runner, resource-manager runner, decision-channel adapter, source resolver, and `piw` CLI are plain Node processes without that mapping. Every module that one of them can load must not value-import a host-provided package. This includes the public `@osolmaz/pi-workflows`, `/builtins`, `/resource-managers`, and `/client` entry points that workflow files load in those processes. Use a declaration-level `import type` for types. An inline `import { type Name }` still loads the module.

Code that needs a host package at run time must run in a process that Pi starts. The Pi extension, the headless step bridge, and the Sanity Check agent group bridge are loaded by Pi with `-e`. A plain Node process that needs Pi SDK work starts headless Pi with such a bridge, as [Sanity Check](#built-in-sanity-check) does. Constants that both sides share live in modules without host imports, such as `src/server/rpc-protocol.ts`.

`test/plain-node-entries.test.ts` guards this rule. It walks the compiled import graph from every plain Node entry and public entry point, and fails when one reaches a package outside `dependencies`. It also imports each entry, resolves every discoverable built-in through the resolver process, and runs Sanity Check's review action. These checks run from source and from a temporary release build, with a Node resolve hook that makes every host package unresolvable. The end-to-end suite loads the Sanity Check bridge into the real Pi runtime from a package copy where host packages are not installed.

## Using the engine outside Pi

The engine remains Pi-agnostic. `WorkflowEngine` takes any `AgentStepExecutor`,
so tests and custom library integrations can script agent steps. The package's
production extension does not use this as a selectable embedded runtime; it
always sends runs to the global server.

```typescript
import { WorkflowEngine, type AgentStepExecutor } from "@osolmaz/pi-workflows";

const executor: AgentStepExecutor = {
  async runAgentStep(request) {
    const accepted = await request.accept({ answer: "42" });
    if (!accepted.ok) throw new Error(accepted.error);
    return { output: accepted.value };
  },
};

const engine = new WorkflowEngine({
  executor,
  databasePath: "/tmp/workflow-state.sqlite",
});
const { state } = await engine.run(workflow, { task: "..." });
```

## Test the installed package

The installed-package end-to-end test packs this repository and installs the
archive in a temporary consumer project the way `pi install` installs an npm
package: production dependencies only, with `--legacy-peer-deps`. Pi installs an
npm package with `npm install <spec> --prefix <root> --legacy-peer-deps`. The test
also passes `--omit=dev`, the flag that Pi adds for a git package's dependencies,
as a safety margin. That changes nothing, because the generated consumer
`package.json` declares no dependencies. Without peer installation, the packages
that Pi supplies to extensions are absent, as they are for a user, and
the test fails if Node could resolve any of them from the installed package. Pi
provides them at run time only to code that it loads itself, so a plain Node
workflow process that imports one fails in this test. The test then starts the
repository-pinned base Pi with only that Pi Workflows installation. It checks
command isolation, server startup, widget and status changes, pause, resume,
completion, and `piw <runId> --once` output.

Run the deterministic phase without a model call:

```bash
npm run test:e2e:live -- --runtime-only
```

A real-model phase is manual. Supply the exact Pi provider and model as separate
values. The runner does not select a default or accept model fallback:

```bash
npm run test:e2e:live -- \
  --provider openai \
  --model gpt-5.6-luna
```

For providers that reserve credit against the requested output allowance, pass
`--max-output-tokens N` with the generated profile. OpenRouter can reject a
small smoke test when the model's catalog default requests hundreds of thousands
of output tokens. This option changes only the exact built-in model's `maxTokens`
through Pi's documented `modelOverrides`. It does not change the provider, model
ID, API, endpoint, or credentials. The test verifies and reports the allowance,
keeps the complete response, and fails immediately on a provider error.

```bash
npm run test:e2e:live -- \
  --provider openrouter \
  --model deepseek/deepseek-v4-flash \
  --max-output-tokens 4096
```

For subscription authentication, use a dedicated Pi profile that has no other
extensions or resources. The output-budget option cannot modify this existing
profile:

```bash
npm run test:e2e:live -- \
  --profile ~/.config/pi-workflows-e2e/openai-codex \
  --provider openai-codex \
  --model gpt-5.6-luna
```

The real-model phase also saves partial work in a temporary directory, lets the agent step expire, and verifies that the owned Pi command stopped before a recovery step runs. The harness checks the process and durable workflow outcomes independently of the model's recovery claim.

The profile and normal provider environment remain operator-owned. The runner
does not read, copy, print, or save credentials. It uses one guarded temporary
root and removes that root after success or failure. Use `--keep` only when you
need the isolated files for diagnosis.
