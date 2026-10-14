import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listOAuthRefreshMarkers,
  oauthRefreshMarkerDirectory,
  pruneOAuthRefreshMarkers,
  removeOAuthRefreshMarker,
  writeOAuthRefreshMarker,
} from "../src/state/oauth-refresh-markers.js";
import { makeTempDir } from "./helpers.js";

const STARTED_AT = "2030-01-01T00:00:00.000Z";
const STARTED = Date.parse(STARTED_AT);

describe("OAuth refresh process markers", () => {
  it("lives in the pi-workflows configuration directory", () => {
    expect(oauthRefreshMarkerDirectory({ PI_WORKFLOWS_CONFIG_DIR: "/config" })).toBe(
      path.join("/config", "oauth-refresh"),
    );
  });

  it("writes a private marker without credential data and removes it", async () => {
    const directory = path.join(await makeTempDir("oauth-refresh-markers"), "oauth-refresh");
    // A file left by an earlier process with the same ID is replaced.
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "41.json"), "old", "utf8");
    const file = writeOAuthRefreshMarker(directory, {
      pid: 41,
      provider: "fixture",
      startedAt: STARTED_AT,
    });
    expect(file).toBe(path.join(directory, "41.json"));
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      schema: "pi-workflows.oauth-refresh-marker.v1",
      pid: 41,
      provider: "fixture",
      startedAt: STARTED_AT,
    });
    removeOAuthRefreshMarker(file);
    removeOAuthRefreshMarker(file);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it("refuses a marker directory that is a symbolic link", async () => {
    const root = await makeTempDir("oauth-refresh-markers");
    await fs.mkdir(path.join(root, "real"));
    await fs.symlink(path.join(root, "real"), path.join(root, "oauth-refresh"));
    expect(() =>
      writeOAuthRefreshMarker(path.join(root, "oauth-refresh"), {
        pid: 42,
        provider: "fixture",
        startedAt: STARTED_AT,
      }),
    ).toThrow("is not a private directory of this user");
    expect(await fs.readdir(path.join(root, "real"))).toEqual([]);
  });

  it("lists markers with whether their process still runs, and prunes the rest", async () => {
    const directory = path.join(await makeTempDir("oauth-refresh-markers"), "oauth-refresh");
    expect(listOAuthRefreshMarkers(directory)).toEqual([]);
    pruneOAuthRefreshMarkers(directory);
    for (const pid of [11, 12, 13]) {
      writeOAuthRefreshMarker(directory, { pid, provider: `p${pid}`, startedAt: STARTED_AT });
    }
    await fs.writeFile(path.join(directory, "14.json"), "not a marker", "utf8");
    await fs.writeFile(
      path.join(directory, "15.json"),
      JSON.stringify({ schema: "pi-workflows.oauth-refresh-marker.v1", pid: "x" }),
      "utf8",
    );
    await fs.writeFile(path.join(directory, "notes.txt"), "kept", "utf8");
    const elsewhere = path.join(path.dirname(directory), "elsewhere.json");
    await fs.writeFile(elsewhere, "kept", "utf8");
    await fs.symlink(elsewhere, path.join(directory, "16.json"));
    const options = { now: STARTED + 1_000, isRunning: (pid: number) => pid !== 12 };
    expect(
      listOAuthRefreshMarkers(directory, options).toSorted((left, right) => left.pid - right.pid),
    ).toEqual([
      { pid: 11, provider: "p11", startedAt: STARTED_AT, running: true },
      { pid: 12, provider: "p12", startedAt: STARTED_AT, running: false },
      { pid: 13, provider: "p13", startedAt: STARTED_AT, running: true },
    ]);
    // No refresh process lives eight minutes, so a running ID that old belongs to another one.
    expect(
      listOAuthRefreshMarkers(directory, { now: STARTED + 8 * 60_000, isRunning: () => true }).map(
        (marker) => marker.running,
      ),
    ).toEqual([false, false, false]);

    pruneOAuthRefreshMarkers(directory, options);
    expect((await fs.readdir(directory)).toSorted()).toEqual([
      "11.json",
      "13.json",
      "16.json",
      "notes.txt",
    ]);
    expect(await fs.readFile(elsewhere, "utf8")).toBe("kept");
    // A real check: this test's own process runs, and a long-gone ID does not.
    writeOAuthRefreshMarker(directory, {
      pid: process.pid,
      provider: "self",
      startedAt: new Date().toISOString(),
    });
    expect(listOAuthRefreshMarkers(directory).find((marker) => marker.pid === process.pid)).toEqual(
      expect.objectContaining({ running: true }),
    );
  });
});
