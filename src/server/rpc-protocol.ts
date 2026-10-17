/**
 * Prefix of the stderr lines that the rpc-bridge extension writes for `workflow` tool calls.
 * It lives apart from the bridge so the workflow runner reads it without loading the bridge,
 * which imports packages that only Pi supplies.
 */
export const RPC_SUBMISSION_PREFIX = "PI_WORKFLOWS_STEP_SUBMISSION ";

/**
 * Prefix of the one stderr line that the rpc-bridge writes, before Pi reads any prompt, when
 * the child cannot use the configured default model. The bridge then exits.
 */
export const RPC_MODEL_ERROR_PREFIX = "PI_WORKFLOWS_STEP_MODEL_ERROR ";

/**
 * Frame a model error on its own stderr line. The leading newline ends any partial line that
 * other code in the Pi process wrote first.
 */
export function encodeRpcModelError(error: string): string {
  return `\n${RPC_MODEL_ERROR_PREFIX}${JSON.stringify({ error })}\n`;
}

/**
 * The stderr line that the rpc-bridge writes once Pi started its session and the model check
 * passed. Stderr that Pi writes before it, such as Pi's own "No models available" exit, is the
 * reason a child exited during startup.
 */
export const RPC_SESSION_STARTED_LINE = "PI_WORKFLOWS_STEP_SESSION_STARTED";

/** Frame the session-started line on its own stderr line, like a model error. */
export function encodeRpcSessionStarted(): string {
  return `\n${RPC_SESSION_STARTED_LINE}\n`;
}

/** The error of a model error line, or undefined for any other line. */
export function decodeRpcModelError(line: string): string | undefined {
  if (!line.startsWith(RPC_MODEL_ERROR_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(line.slice(RPC_MODEL_ERROR_PREFIX.length)) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}
