import { afterEach, describe, expect, it } from "vitest";
import {
  PiAgentGroupError,
  launchPiAgentGroup,
  setPiAgentGroupLauncher,
  type PiAgentGroupLaunchOptions,
  type PiAgentRequest,
} from "../src/builtins/pi-agent-launch.js";

const request: PiAgentRequest = {
  id: "review",
  role: "Review",
  prompt: "Review the change.",
  cwd: "/repo",
  tools: ["read"],
};

afterEach(() => setPiAgentGroupLauncher(undefined));

describe("Pi agent group launcher", () => {
  it("fails clearly when the process has no Pi agent launcher", async () => {
    await expect(
      launchPiAgentGroup([request], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      "Pi agent group could not run: this process cannot start Pi agent sessions; run the workflow through the pi-workflows server",
    );
  });

  it("delegates requests and options to the installed launcher", async () => {
    const calls: Array<{ requests: PiAgentRequest[]; options: PiAgentGroupLaunchOptions }> = [];
    setPiAgentGroupLauncher(async (requests, options) => {
      calls.push({ requests, options });
      return [{ id: "review", text: "{}", model: "p/m", thinkingLevel: "high", durationMs: 1 }];
    });
    const options = { maxConcurrency: 1, signal: new AbortController().signal };
    await expect(launchPiAgentGroup([request], options)).resolves.toEqual([
      { id: "review", text: "{}", model: "p/m", thinkingLevel: "high", durationMs: 1 },
    ]);
    expect(calls).toEqual([{ requests: [request], options }]);

    setPiAgentGroupLauncher(undefined);
    await expect(launchPiAgentGroup([request], options)).rejects.toThrow(
      /could not run: this process cannot start/,
    );
  });

  it("keeps private detail out of the message and never shortens it", () => {
    const detail = `PRIVATE_PROVIDER_TEXT ${"x".repeat(10_000)}`;
    const error = new PiAgentGroupError("review", "failed", "the session raised an error", {
      detail,
    });
    expect(error.detail).toBe(detail);
    expect(error.facts).toBe("the session raised an error");
    expect(error.message).toBe("Pi agent review failed: the session raised an error");
    expect(error.message).not.toContain("PRIVATE_PROVIDER_TEXT");

    const facts = `after 5ms; ${"y".repeat(3_000)}`;
    const located = new PiAgentGroupError("review", "timed out", facts, {
      detail,
      notice: "complete cause: /tmp/cause.txt",
    });
    expect(located.message).toBe(
      `Pi agent review timed out: ${facts}. complete cause: /tmp/cause.txt`,
    );
    expect(located.notice).toBe("complete cause: /tmp/cause.txt");
    expect(new PiAgentGroupError("review", "failed", "fixed").detail).toBeUndefined();
  });
});
