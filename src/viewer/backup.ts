import fs from "node:fs";
import path from "node:path";
import { StateDatabase, workflowStatePath } from "../state/database.js";
import {
  type WorkflowStateNotices,
  workflowStateNoticeLines,
  workflowStateNotices,
  workflowStateViolations,
} from "../workflows/diagnostics.js";

/**
 * Verify only an explicit inactive backup and return its notices. Active state is
 * verified through WorkflowClient.
 */
export function verifyInactiveBackup(
  databasePath: string,
  activeDatabasePath: string = workflowStatePath(),
): WorkflowStateNotices {
  const resolved = path.resolve(databasePath);
  const active = path.resolve(activeDatabasePath);
  if (sameFile(resolved, active)) {
    throw new Error("Active workflow state must be verified through the workflow server");
  }
  const state = new StateDatabase({ filePath: resolved, mode: "read-only" });
  try {
    state.integrityCheck();
    const violations = workflowStateViolations(state);
    const notices = workflowStateNotices(state);
    if (violations.length > 0) {
      throw new Error(
        [
          ...violations.map((item) => `${item.code} ${item.runId}: ${item.detail}`),
          ...workflowStateNoticeLines(notices),
        ].join("\n"),
      );
    }
    return notices;
  } finally {
    state.close();
  }
}

function sameFile(left: string, right: string): boolean {
  if (left === right) return true;
  if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
  const leftStat = fs.statSync(left);
  const rightStat = fs.statSync(right);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}
