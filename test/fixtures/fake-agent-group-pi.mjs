// A fake `pi --mode rpc` child that speaks the agent group bridge protocol. The scenario in
// FAKE_AGENT_GROUP_SCENARIO selects its behavior; tests run it through a shell wrapper.
import fs from "node:fs";
import readline from "node:readline";

const PREFIX = "PI_WORKFLOWS_AGENT_GROUP ";
const SCHEMA = "pi-workflows.agent-group-event.v1";
const COMMAND = "/pi-workflows-agent-group ";
const scenario = process.env.FAKE_AGENT_GROUP_SCENARIO ?? "success";

if (process.env.FAKE_PI_ARGV_FILE) {
  fs.writeFileSync(
    process.env.FAKE_PI_ARGV_FILE,
    JSON.stringify({ argv: process.argv.slice(2), env: process.env.FAKE_PI_MARKER ?? null }),
  );
}
if (scenario === "ignore-cancel") process.on("SIGTERM", () => undefined);

function emit(event) {
  process.stderr.write(`${PREFIX}${JSON.stringify({ schema: SCHEMA, ...event })}\n`);
}

function respond(id, response) {
  process.stdout.write(
    `${JSON.stringify({ id, type: "response", command: "prompt", ...response })}\n`,
  );
}

function lifecycle(groupId, request, state) {
  emit({
    type: "lifecycle",
    groupId,
    event: { id: request.id, role: request.role, state, phase: state, elapsedMs: 1 },
  });
}

const runScenarios = {
  success(command, id) {
    for (const request of command.requests) lifecycle(command.groupId, request, "running");
    for (const request of command.requests) lifecycle(command.groupId, request, "completed");
    emit({ type: "completed", groupId: command.groupId, results: results(command) });
    respond(id, { success: true, data: { disposition: "handled" } });
  },
  forged(command, id) {
    emit({ type: "completed", groupId: "forged-group", results: [] });
    emit({ type: "failed", groupId: "forged-group", error: { message: "forged" } });
    process.stderr.write(`${PREFIX}not json\n`);
    runScenarios.success(command, id);
  },
  "agent-error"(command, id) {
    emit({
      type: "failed",
      groupId: command.groupId,
      error: { message: "ignored", agentId: "review", code: "timed out", detail: "after 5ms" },
    });
    respond(id, { success: true, data: { disposition: "handled" } });
  },
  "plain-error"(command, id) {
    emit({
      type: "failed",
      groupId: command.groupId,
      error: { message: "Invalid Pi agent id: !" },
    });
    respond(id, { success: true, data: { disposition: "handled" } });
  },
  unrouted(_command, id) {
    respond(id, { success: true, data: { disposition: "started" } });
  },
  rejected(_command, id) {
    respond(id, { success: false, error: "Unknown command" });
  },
  "handled-without-result"(_command, id) {
    respond(id, { success: true, data: { disposition: "handled" } });
  },
  "exit-mid-run"() {
    process.stderr.write("provider crashed\n");
    process.exit(5);
  },
  hang(command) {
    for (const request of command.requests) lifecycle(command.groupId, request, "running");
  },
  "ignore-cancel"(command) {
    runScenarios.hang(command);
  },
};

function results(command) {
  return command.requests.map((request) => ({
    id: request.id,
    text: process.env.FAKE_AGENT_GROUP_TEXT ?? `result ${request.id}`,
    model: "fixture/model",
    thinkingLevel: "high",
    durationMs: 1,
  }));
}

function cancel(command) {
  if (scenario !== "hang") return;
  lifecycle(command.groupId, { id: "review", role: "Review" }, "cancelled");
  emit({
    type: "failed",
    groupId: command.groupId,
    error: { message: "ignored", agentId: "group", code: "cancelled", detail: command.reason },
  });
}

function onLine(line) {
  const message = JSON.parse(line);
  if (message.type !== "prompt" || !message.message.startsWith(COMMAND)) return;
  const command = JSON.parse(
    Buffer.from(message.message.slice(COMMAND.length), "base64url").toString("utf8"),
  );
  if (process.env.FAKE_PI_COMMANDS_FILE) {
    fs.appendFileSync(process.env.FAKE_PI_COMMANDS_FILE, `${JSON.stringify(command)}\n`);
  }
  if (command.type === "cancel") cancel(command);
  else runScenarios[scenario]?.(command, message.id);
}

if (scenario === "exit-before-ready") {
  process.stderr.write("boom diagnostics\n");
  process.exit(3);
}
readline.createInterface({ input: process.stdin }).on("line", onLine);
if (scenario !== "silent") emit({ type: "ready" });
setInterval(() => undefined, 1_000);
