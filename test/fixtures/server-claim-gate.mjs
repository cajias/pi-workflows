// Preloaded with `node --import` after tsx by test/server-lock-race.test.ts. A spawned workflow
// server pauses at its epoch claim until the test releases it, so concurrent starters reach the
// claim in an order the test chooses. The claim is synchronous, so the pause blocks the whole
// process, the way a starter descheduled just before its claim would stall. Each process announces
// itself with `<pid>.reached`, which holds its server ID, and waits for `<pid>.release`.
import fs from "node:fs";
import path from "node:path";
import { ServerStateStore } from "../../src/server/state.ts";

const gate = process.env.PI_WORKFLOWS_TEST_CLAIM_GATE;
const POLL_MS = 10;

if (gate !== undefined && gate.length > 0) {
  const acquireServer = ServerStateStore.prototype.acquireServer;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  ServerStateStore.prototype.acquireServer = function gatedAcquireServer(options) {
    const reached = path.join(gate, `${process.pid}.reached`);
    fs.writeFileSync(`${reached}.tmp`, options.serverId);
    fs.renameSync(`${reached}.tmp`, reached);
    const release = path.join(gate, `${process.pid}.release`);
    while (!fs.existsSync(release)) Atomics.wait(pause, 0, 0, POLL_MS);
    return acquireServer.call(this, options);
  };
}
