# Development guide

This document covers the standards for working on pi-workflows itself. For
authoring workflows, see [WORKFLOWS.md](WORKFLOWS.md).

The viewer follows the [incremental and virtualized viewer plan](plans/2026-08-28-piw-incremental-viewer-plan.md). Durable writers create revisioned target patches. Rust reads small run-list rows, bounded replay pages, and one shared watched-run projection. Rust and TypeScript share graph fixtures and the same retained scene contract.

## Layout and boundaries

```
src/workflows/   finite graph engine: definitions, execution, SQLite stores, loader
src/builtins/    default workflows shipped at lowest discovery precedence
src/resource-managers/ durable resources, queue, reconciliation, effects, child runs
src/server/      global server, local protocols, resolvers, and runner supervision
src/extension/   thin Pi client: commands, workflow tool, and origin-session bridge
src/viewer/      standalone read-only views over runs and managed resources
tui/             Rust piw viewer, bounded SQLite projection, and replay server
```

The dependency direction is enforced by `slophammer.yml`. `src/workflows`
imports nothing outside itself and never imports Pi. Durable updates,
progress validation, estimation, and text formatting stay in this layer so the
engine, extension, servers, and viewers share one contract. `src/builtins` contains
package-owned definitions and imports only the public workflow engine.
`src/resource-managers` may import the public workflow engine for child-run
scheduling. `src/server` may import resource manager stores and workflow stores,
but the server event loop never loads workflow or resource manager definitions.
Resolver and runner child entry points load those definitions. The extension uses static
built-in metadata and never imports the workflow engine. The extension and
viewer never import each other. The viewer reads SQLite state in read-only mode,
so it works from any process.

Within `src/render`, `graph.ts` computes a pure layered layout (ported from
the acpx replay viewer: labelled switch expansion, DFS back-edge detection,
longest-path layering, barycenter ordering, virtual pass-through cells for
long edges), `canvas.ts` is a character grid that merges box-drawing
characters by connectivity, and `graph-render.ts` turns a SQLite run state plus a
replay position into the drawn graph in one of two node styles: `box`
(bordered nodes) or `line` (single-line nodes). `render.ts` in `src/viewer`
composes the full detail view (header, graph, step timeline, step inspector)
and stays pure so tests can assert on rendered lines.

The TypeScript and Rust viewers both show progress tracks, sample counts,
confidence, update time, and ETA from SQLite data. The Rust viewer also keeps
graph layout and plain rendering in parity with `src/render`, then applies
ratatui-only presentation through semantic canvas
roles and `tui/src/theme`. Catppuccin is the default. Theme colors must be
chosen in the theme layer rather than directly in UI components. Graph node
surfaces are intentional styled spaces, so changing the sparse canvas must
preserve those spaces as well as box connectivity. Text or geometry changes
still belong in both renderers and require regenerated fixtures.

The renderer is built so that overlaps cannot corrupt the drawing: every
back edge owns exclusive lane rows and an exclusive gutter column, multiple
edges leaving one node fan out over separate exit columns, and labels are
drawn last through `textOverRun`/`textIfEmpty`, which refuse to overwrite
anything but a plain horizontal run or empty cells. `test/helpers/graph-verify.ts`
enforces this structurally: it re-parses the rendered characters, checks
every node box is unbroken, and traces every declared edge through the
actual box-drawing characters from source box to target arrow.
`test/graph-verify.test.ts` runs that verifier over 60 seeded random
workflow shapes at every replay position; if a rendering change breaks a
line, misplaces an arrow, or lets a label damage an edge, those tests fail
with the offending drawing in the assertion message.

Inside the engine, the model-facing seam is the `AgentStepExecutor` interface.
The production workflow runner uses an interaction executor for origin-session
work and `RpcStepExecutor` for headless resource manager work. The runner
receives a `ServerBackedWorkflowStore`; it cannot open a writable production
store.

The server, runners, resolver, channel adapter, and `piw` are plain Node
processes. Pi supplies its own packages only to code that it loads, so modules
those processes reach must not value-import `@earendil-works/pi-*` or `typebox`.
Pi SDK work runs in a headless Pi child with a bridge extension. See
[Host-provided Pi packages](WORKFLOWS.md#host-provided-pi-packages) and
`test/plain-node-entries.test.ts`.

The Pi extension uses documented session lifecycle, message, tool, and session
manager APIs. It writes no Pi session file. It saves server mutations through the
local protocol and uses the public session branch only to adopt the exact
visible entry for a durable interaction request. Tests can still use scripted
executors through the Pi-agnostic engine API.

`src/viewer/session-reducer.ts` and `tui/src/session.rs` implement the same
sequence-ordered fold. Shared fixtures in `fixtures/session-events/` pin their
output. Seeking uses viewer-only checkpoints every 256 events and an in-memory
timestamp index. Neither cache is persisted.

## Toolchain

Node 22+, ESM, TypeScript strict (including `exactOptionalPropertyTypes`).
Formatting is oxfmt, linting is oxlint with warnings denied, tests are vitest
with istanbul coverage. The single gate is:

```bash
npm run check   # format:check + lint + typecheck + build + test:coverage
```

Coverage thresholds are 85% lines/functions/branches/statements, configured
in `vitest.config.ts`. The istanbul provider is deliberate. Workflow files are
loaded through jiti at runtime, and the v8 provider mismapped those modules;
istanbul instruments through the vitest transform pipeline only.

The suite creates one temporary root per run and deletes it at the end. Some
tests start a workflow server in a temporary home, and a server that outlives
its test holds about 80 MB for the life of the machine. The harness therefore
reads `server/server.lock.json` under the run root, stops every recorded
process whose start identity still matches, and then removes the root. A
killed run can still leave a server behind, so check `ps` after an interrupted
run.

Slophammer runs in CI (coverage, complexity max 8, DRY max 0 findings,
dependency boundaries). Run it locally with:

```bash
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

## Viewer performance checks

Create a synthetic growing database and run the release benchmark:

```bash
mkdir -m 700 /tmp/piw-viewer-benchmark
npx tsx scripts/generate-viewer-benchmark.ts \
  /tmp/piw-viewer-benchmark/state.sqlite 44 405 211 1105 1200
cargo run --release --manifest-path tui/Cargo.toml \
  --example refresh_benchmark -- \
  /tmp/piw-viewer-benchmark/state.sqlite 1000
```

The generator prints only row counts and database size. The benchmark prints run count, query and load counts, payload rows, raw tick times, and peak RSS. It does not print run IDs or payload text.

The deterministic gate is zero payload reads after the first bounded selected window during unchanged idle checks. The measured gates are p99 main-thread checks below 16 ms and peak RSS below 185 MB on a database close to the registered 97 MB fixture. Run the benchmark several times and report the median, range, p99, maximum, and peak memory. Do not select extra complexity from one best run.

## End-to-end tests

```bash
npm run test:e2e
```

The E2E suite (`test/e2e/`) is non-destructive and fully local. It starts a
mock OpenAI-compatible server (`test/e2e/mock-openai.ts`) whose scripted
"model" answers each step contract with a `workflow` tool call, then spawns
the real pi CLI from `devDependencies` in RPC mode with:

- `PI_CODING_AGENT_DIR` pointed at a temp agent dir containing a `models.json`
  for the mock provider,
- `HOME` pointed at a temporary home containing the canonical workflow database,
- the extension loaded from source with `-e src/extension/index.ts`.

It drives `/workflow` over the RPC protocol and checks the global server,
durable interaction request, origin-session presentation, accepted submission,
runner recovery, final SQLite state, and viewer output. It also restarts the
real Pi process while one request is pending and proves that the same request is
not inserted twice. Nothing outside the temp directories is touched, and no
real model is called.

## Verification scripts

Tests and ad-hoc verification scripts that drive a workflow server through
`WorkflowClient` must stay off the live server. `new WorkflowClient()` without a
`databasePath` connects to the live server of
`~/.pi/agent/workflows/state.sqlite`, which real Pi sessions use. Use one of
these instead:

- Start the run with `executionMode: "headless"`. A headless run needs no Pi
  session and creates no terminal workflow message.
- Use an isolated server. Pass a scratch database,
  `new WorkflowClient({ databasePath: "/var/tmp/<scratch>/state.sqlite" })`, and
  call `ensureAvailable()`. The client starts a server for that database with its
  own socket under `<scratch>/server/`. Keep the scratch path short, because the
  socket path must fit the operating system limit, 107 bytes on Linux. Send
  `server.stop` and delete the scratch directory when the script is done.

Never start an interactive run on the live socket with a made-up
`originSessionId`. The run's terminal result is addressed to that session, so it
would stay pending forever and keep the run from retention. The workflow server
rejects such a start: an interactive `run.start` needs the live coordinator
authority of its origin session, as described in
[Starting and resuming runs](WORKFLOWS.md#starting-and-resuming-runs). A script
that needs interactive behavior uses an isolated server and owns the session
there. It subscribes with `view.session.watch` and `coordinator: true`, reports
the branch with `workflowMessage.reportBranch`, and sends `targetSessionId` and
`coordinatorEpoch` with the start from that same connection.
`requestInteractiveStart` in `test/helpers.ts` does this for the unit tests.

## Publishing

The npm package is `@osolmaz/pi-workflows`. The crates.io package is
`pi-workflows`, and it installs the `piw` executable. Keep both package versions
in sync so one GitHub Release can publish both artifacts.

Trusted publishing uses separate GitHub environments and workflows. Neither
workflow stores a long-lived registry token:

- npm: repository `osolmaz/pi-workflows`, workflow
  `.github/workflows/publish.yml`, environment `npm`;
- crates.io: repository owner `osolmaz`, repository `pi-workflows`, workflow
  `publish-crate.yml`, environment `crates-io`.

For later versions:

1. Update `version` in `package.json`, `package-lock.json`, `tui/Cargo.toml`,
   `tui/Cargo.lock`, and `herdr-plugin.toml`, then merge that change into the
   default branch.
2. Publish a GitHub Release whose tag is `v<version>`, such as `v0.2.0`.
3. Wait for the **Publish npm package** and **Publish crates.io package**
   workflows to finish.
4. Verify the version on both npm and crates.io.

Both workflows reject mismatched tags, commits outside the default branch, and
versions already present in their registry. They run their package checks
before publishing.

## Conventions

- Conventional Commits for commit messages and PR titles.
- Persisted JSON uses camelCase keys and current `schema` identifiers; see
  [SQLITE_STATE.md](SQLITE_STATE.md). During alpha, a breaking shape changes the current contract in place and uses the clear reset failure. Do not add a compatibility path or `v2` only to preserve old alpha state.
- Every exported API of the engine (`src/workflows/index.ts`) is covered by
  unit tests; new node types or edge semantics need tests in `test/` and a
  section in [WORKFLOWS.md](WORKFLOWS.md).
