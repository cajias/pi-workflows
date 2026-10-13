import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowClient } from "../src/client/client.js";
import { serverLockPath } from "../src/server/lock.js";
import { WorkflowServer } from "../src/server/server.js";
import type { JsonValue } from "../src/state/json.js";
import { makeTempDir, waitUntil } from "./helpers.js";

async function statusOf(databasePath: string): Promise<Record<string, JsonValue>> {
  const client = new WorkflowClient({ databasePath });
  try {
    const response = await client.request({ operation: "server.status" });
    return response.receipt as Record<string, JsonValue>;
  } finally {
    await client.close();
  }
}

async function withServer(
  options: ConstructorParameters<typeof WorkflowServer>[0],
  check: (databasePath: string, logs: string[]) => Promise<void>,
): Promise<void> {
  const databasePath = path.join(await makeTempDir("server-headless-pi"), "state.sqlite");
  const logs: string[] = [];
  const server = new WorkflowServer({
    databasePath,
    claimPollMs: 1_000_000,
    onLog: (message) => logs.push(message),
    ...options,
  });
  await server.start();
  try {
    await check(databasePath, logs);
  } finally {
    await server.stop();
  }
}

describe("workflow server headless pi pin", () => {
  it("reports and logs the pi that the starting Pi session pinned", async () => {
    const pin = { kind: "node", node: "/opt/node/bin/node", cli: "/opt/pi/dist/cli.js" } as const;
    await withServer({ headlessPi: pin }, async (databasePath, logs) => {
      expect((await statusOf(databasePath)).headlessPi).toEqual({ source: "session", ...pin });
      expect(logs).toContain(
        "headless pi from the starting Pi session: /opt/pi/dist/cli.js run by /opt/node/bin/node",
      );
    });
  });

  it("resolves pi from its PATH once at start when no session pinned it", async () => {
    const root = await makeTempDir("server-headless-pi-path");
    const cli = path.join(root, "package", "cli.js");
    await fs.mkdir(path.dirname(cli));
    await fs.writeFile(cli, "#!/usr/bin/env node\n", { mode: 0o755 });
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await fs.symlink(cli, path.join(bin, "pi"));
    await fs.symlink(process.execPath, path.join(bin, "node"));
    await withServer({ env: { PATH: bin } }, async (databasePath, logs) => {
      const pinned = { kind: "node", node: process.execPath, cli: await fs.realpath(cli) };
      expect((await statusOf(databasePath)).headlessPi).toEqual({ source: "path", ...pinned });
      // A later change on disk does not move the pin.
      await fs.rm(path.join(bin, "pi"));
      expect((await statusOf(databasePath)).headlessPi).toEqual({ source: "path", ...pinned });
      expect(logs).toContain(`headless pi from PATH: ${pinned.cli} run by ${process.execPath}`);
    });
  });

  it("starts without a resolvable pi and reports why in its status", async () => {
    const empty = await makeTempDir("server-headless-pi-empty");
    await withServer({ env: { PATH: empty } }, async (databasePath) => {
      expect((await statusOf(databasePath)).headlessPi).toEqual({
        source: "path",
        kind: "unresolved",
        error: expect.stringContaining(`no executable pi is on the server's PATH (${empty})`),
      });
    });
  });

  it("receives the session's pin through the server process that a client starts", async () => {
    const databasePath = path.join(await makeTempDir("server-headless-pi-entry"), "state.sqlite");
    const pin = { kind: "executable", executable: "/opt/pi/bin/pi" } as const;
    const client = new WorkflowClient({ databasePath, headlessPi: pin });
    try {
      const status = await client.ensureRunning();
      expect((status.receipt as Record<string, JsonValue>).headlessPi).toEqual({
        source: "session",
        ...pin,
      });
      await client.request({ operation: "server.stop" });
    } finally {
      await client.close();
    }
    await waitUntil(() => !existsSync(serverLockPath(databasePath)), 10_000);
  });
});
