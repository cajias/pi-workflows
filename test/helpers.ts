import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkflowClient } from "../src/client/client.js";
import type { ClientResponse } from "../src/client/protocol.js";
import { canonicalJson, type JsonObject } from "../src/state/json.js";
import { resourceIdFor } from "../src/state/mutation.js";
import { initializeViewerRun } from "../src/state/viewer.js";
import type { HumanDecisionStore } from "../src/workflows/human-decision.js";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
  HumanDecisionPrompt,
  HumanDecisionRequest,
} from "../src/workflows/types.js";
import { TEST_TEMP_ROOT_ENV } from "./global-setup.js";

export async function makeTempDir(prefix: string): Promise<string> {
  const root = process.env[TEST_TEMP_ROOT_ENV];
  if (root === undefined) {
    throw new Error(`Test temporary root is not configured: ${TEST_TEMP_ROOT_ENV}`);
  }
  if (path.basename(prefix) !== prefix) {
    throw new Error(`Test temporary directory prefix must be one path segment: ${prefix}`);
  }
  await fs.mkdir(root, { recursive: true });
  return await fs.mkdtemp(path.join(root, `${prefix}-`));
}

export async function makeStateDatabasePath(prefix: string): Promise<string> {
  return path.join(await makeTempDir(prefix), "state.sqlite");
}

export async function seedHumanDecisionRequest(
  store: HumanDecisionStore,
  request: HumanDecisionRequest,
): Promise<void> {
  const state = store.state;
  if (
    state.connection.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(request.runId) === undefined
  ) {
    state.transaction(() => {
      const now = Date.parse(request.createdAt);
      const runResourceId = resourceIdFor("run", request.runId);
      const snapshot = {
        schema: "pi-workflows.definition-snapshot.v1",
        name: request.workflowName,
        startAt: request.nodeId,
        nodes: { [request.nodeId]: { nodeType: "checkpoint" } },
        edges: [],
      };
      const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest();
      const definitionHash = state.putJson(snapshot, now);
      const inputHash = state.putJson({}, now);
      const launchHash = state.putJson({}, now);
      const finalOutputHash = state.putJson(request, now);
      state.connection
        .prepare(
          `INSERT INTO workflow_definitions(
             definition_digest, workflow_name, definition_hash, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(definitionDigest, request.workflowName, definitionHash, now);
      state.connection
        .prepare(
          `INSERT INTO resources(
             resource_id, resource_type, aggregate_key, revision, created_at, updated_at
           ) VALUES (?, 'run', ?, 1, ?, ?)`,
        )
        .run(runResourceId, request.runId, now, now);
      state.connection
        .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
        .run(runResourceId);
      state.connection
        .prepare(
          `INSERT INTO runs(
             run_id, resource_id, root_run_id, definition_digest, workflow_ref,
             launch_options_hash, status, paused, input_hash, final_output_hash,
             created_at, updated_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'waiting', 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.runId,
          runResourceId,
          request.runId,
          definitionDigest,
          request.workflowName,
          launchHash,
          inputHash,
          finalOutputHash,
          now,
          now,
          now,
        );
      initializeViewerRun(state, request.runId, now);
      state.connection
        .prepare(
          `INSERT INTO run_sources(run_id, mount_path, source_type, source_ref, source_revision)
           VALUES (?, '', 'file', ?, 'test')`,
        )
        .run(request.runId, `inline:${request.workflowName}`);
      state.connection
        .prepare(
          `INSERT INTO node_attempts(
             attempt_id, run_id, node_id, attempt_number, node_type, status,
             started_at, created_at, updated_at, finished_at
           ) VALUES (?, ?, ?, 1, 'checkpoint', 'completed', ?, ?, ?, ?)`,
        )
        .run(request.attemptId, request.runId, request.nodeId, now, now, now, now);
      state.connection
        .prepare("INSERT INTO run_steps(run_id, step_index, attempt_id) VALUES (?, 0, ?)")
        .run(request.runId, request.attemptId);
    });
  }
  await store.createRequest(request);
}

export function decisionPrompt(
  subject: unknown = {},
  expiresAt?: string,
  title = "Approve",
): HumanDecisionPrompt {
  return {
    title,
    subject,
    presentation: {
      schema: "pi-workflows.decision-presentation.v1",
      summary: "Review this decision.",
      blocks: [],
    },
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

export type SessionAuthority = { targetSessionId: string; coordinatorEpoch: string };

/**
 * Return the one current workflow message id the server asks Pi to confirm, or
 * null when the session holds no workflow message yet.
 */
export async function currentWorkflowMessageId(
  client: WorkflowClient,
  sessionId: string,
): Promise<string | null> {
  const seen: { messageId: string | null; received: boolean } = {
    messageId: null,
    received: false,
  };
  const unsubscribe = await client.watchSession(sessionId, (event) => {
    if (event.event !== "session_snapshot") return;
    const payload = event.payload as {
      workflowMessage?: { workflowMessageId?: unknown } | null;
    };
    const value = payload.workflowMessage?.workflowMessageId;
    seen.messageId = typeof value === "string" ? value : null;
    seen.received = true;
  });
  try {
    await waitUntil(() => seen.received, 5_000);
  } finally {
    await unsubscribe();
  }
  return seen.messageId;
}

/** Report the branch Pi holds for the one current workflow message. */
export async function reportBranch(
  client: WorkflowClient,
  authority: SessionAuthority,
  options: {
    workflowMessageId?: string | null;
    piSessionEntryId?: string | null;
    isIdle?: boolean;
    hasPendingMessages?: boolean;
  } = {},
): Promise<ClientResponse> {
  const workflowMessageId =
    options.workflowMessageId === undefined
      ? await currentWorkflowMessageId(client, authority.targetSessionId)
      : options.workflowMessageId;
  return await client.request({
    operation: "workflowMessage.reportBranch",
    payload: {
      ...authority,
      workflowMessageId,
      piSessionEntryId: options.piSessionEntryId ?? null,
      isIdle: options.isIdle ?? true,
      hasPendingMessages: options.hasPendingMessages ?? false,
    },
  });
}

/** Become the live coordinator of one origin session and report its empty branch. */
export async function ownSessionCoordinator(
  client: WorkflowClient,
  targetSessionId: string,
  subscriptionId = `owner-${targetSessionId}`,
): Promise<SessionAuthority> {
  const watched = await client.request({
    operation: "view.session.watch",
    payload: { subscriptionId, sessionId: targetSessionId, coordinator: true },
  });
  const coordinatorEpoch = (watched.receipt as { coordinatorEpoch?: unknown } | undefined)
    ?.coordinatorEpoch;
  if (typeof coordinatorEpoch !== "string") {
    throw new Error(`Session coordinator was refused: ${watched.error ?? watched.outcome}`);
  }
  const authority = { targetSessionId, coordinatorEpoch };
  const reported = await reportBranch(client, authority);
  if (reported.outcome !== "accepted") {
    throw new Error(`Session branch report was refused: ${reported.error ?? reported.outcome}`);
  }
  return authority;
}

type StartRequest = Omit<Parameters<WorkflowClient["request"]>[0], "payload"> & {
  payload: JsonObject;
};

/**
 * Send an interactive `run.start` the way a live Pi session does: from the
 * coordinator connection of its origin session. With `authority`, `client` already
 * holds that coordinator. Without it, a short-lived connection with the same client
 * identity owns the session for this start only, so the session is disconnected
 * again afterwards, as it was before the server required that authority.
 */
export async function requestInteractiveStart(
  client: WorkflowClient,
  request: StartRequest,
  authority?: SessionAuthority,
): Promise<ClientResponse> {
  if (authority !== undefined) {
    return await client.request({ ...request, payload: { ...request.payload, ...authority } });
  }
  const originSessionId = request.payload.originSessionId;
  if (typeof originSessionId !== "string") throw new Error("run.start needs originSessionId");
  const starter = new WorkflowClient({
    databasePath: client.databasePath,
    clientId: client.clientId,
  });
  try {
    const owned = await ownSessionCoordinator(starter, originSessionId, "interactive-start");
    return await starter.request({ ...request, payload: { ...request.payload, ...owned } });
  } finally {
    await starter.close();
  }
}

/** Poll until `predicate` is true, failing after `timeoutMs`. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export type ScriptedResponse =
  | { output: unknown }
  | { error: string }
  | { hang: true }
  | ((request: AgentStepRequest) => Promise<AgentStepSubmission> | AgentStepSubmission);

/**
 * Deterministic executor for engine tests. Responses are keyed by node id;
 * repeated visits to the same node consume queued responses in order.
 */
export class ScriptedExecutor implements AgentStepExecutor {
  // Scripted tests execute no model tools.
  readonly enforcesToolAllowlist = true;
  readonly assistantMessageMode = "visible" as const;
  readonly requests: AgentStepRequest[] = [];
  private readonly responses = new Map<string, ScriptedResponse[]>();

  respond(nodeId: string, ...responses: ScriptedResponse[]): this {
    const queue = this.responses.get(nodeId) ?? [];
    queue.push(...responses);
    this.responses.set(nodeId, queue);
    return this;
  }

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    this.requests.push(request);
    const queue = this.responses.get(request.contract.nodeId) ?? [];
    const response = queue.length > 1 ? queue.shift() : queue[0];
    if (!response) {
      throw new Error(`No scripted response for node ${request.contract.nodeId}`);
    }
    if (typeof response === "function") {
      return await response(request);
    }
    if ("hang" in response) {
      return await new Promise<AgentStepSubmission>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if ("error" in response) {
      throw new Error(response.error);
    }
    const accepted = await request.accept(response.output);
    if (!accepted.ok) {
      throw new Error(`Scripted output rejected: ${accepted.error}`);
    }
    return { output: accepted.value };
  }
}
