// Runs Sanity Check's review action in a plain Node process, the way the workflow runner
// does, with the headless pi agent group launcher. The test selects the source or built form,
// the pi CLI script that this Node pins, and an optional cancellation point through the
// environment.
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PI_WORKFLOWS_TEST_FORM_ROOT;
const extension = process.env.PI_WORKFLOWS_TEST_FORM_EXTENSION;
const cancelWhenRunning = process.env.PI_WORKFLOWS_TEST_CANCEL_WHEN_RUNNING === "1";
const load = async (name) =>
  await import(pathToFileURL(path.join(root, `${name}${extension}`)).href);

const { setPiAgentGroupLauncher } = await load("builtins/pi-agent-launch");
const { HeadlessPiAgentGroupLauncher } = await load("server/agent-group-launcher");
const { default: sanityCheck } = await load("builtins/sanity-check.workflow");

const pids = [];
const launcher = new HeadlessPiAgentGroupLauncher(
  {
    cwd: process.cwd(),
    pi: { kind: "node", node: process.execPath, cli: process.env.PI_WORKFLOWS_TEST_PI_CLI },
    abortGraceMs: 1_000,
    registry: { register: (pid) => pids.push(pid), unregister: () => undefined },
  },
  { diagnosticsDirectory: process.env.PI_WORKFLOWS_TEST_DIAGNOSTICS_DIR },
);
setPiAgentGroupLauncher(launcher.run);

const text = { text: "", truncated: false };
const evidence = {
  repository: process.cwd(),
  baseRef: "HEAD",
  headRevision: "abc",
  pullRequest: { available: false },
  committed: { stat: text, files: text, diff: text },
  workingTree: { status: text, stat: text, files: text, diff: text, untracked: text },
};
const controller = new AbortController();
const updates = [];
const output = { updates, pids };
try {
  output.reviews = await sanityCheck.nodes.review.run({
    input: {},
    outputs: { prepare: { mode: "serial" }, collectEvidence: evidence },
    results: {},
    state: {},
    signal: controller.signal,
    effect: {
      type: "pi-workflows.sanity-check.review",
      idempotencyKey: "review",
      recovery: "manual",
    },
    publishUpdate: async (update) => {
      updates.push({
        key: update.key,
        status: update.data.status,
        phase: update.data.phase,
        label: update.data.label,
        at: Date.now(),
      });
      // The label names the model once the child session exists.
      if (
        cancelWhenRunning &&
        update.data.status === "running" &&
        update.data.label?.includes(" · ")
      ) {
        output.abortedAt ??= Date.now();
        controller.abort(new Error("test cancellation"));
      }
      return { updateId: "u", seq: updates.length, at: "", type: update.type, key: update.key };
    },
  });
} catch (error) {
  output.error = error instanceof Error ? error.message : String(error);
}
process.stdout.write(`${JSON.stringify(output)}\n`);
