/**
 * Prefix of the stderr lines that the rpc-bridge extension writes for `workflow` tool calls.
 * It lives apart from the bridge so the workflow runner reads it without loading the bridge,
 * which imports packages that only Pi supplies.
 */
export const RPC_SUBMISSION_PREFIX = "PI_WORKFLOWS_STEP_SUBMISSION ";
