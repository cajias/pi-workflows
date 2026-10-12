import { describe, expect, it } from "vitest";
import { repositoryId } from "../src/builtins/autoimplement-command-batches.js";
import {
  endTimingText,
  forgeTerms,
  forgeText,
  gitlabApiCoordinates,
} from "../src/builtins/autoimplement-forge-text.js";

const FIRST = "/work/first";
const SECOND = "/work/second";

function publishedRecord(repository: string, pr: string, branch = "feat/demo") {
  return {
    id: repositoryId(repository),
    repository,
    branch,
    baseBranch: "main",
    headRevision: "abc123",
    pr,
  };
}

describe("forgeTerms", () => {
  it("names the pull request on GitHub", () => {
    expect(forgeTerms("github")).toEqual({ request: "pull request", short: "PR" });
  });

  it("names the merge request on GitLab", () => {
    expect(forgeTerms("gitlab")).toEqual({ request: "merge request", short: "MR" });
  });
});

function gitlabLines(): string[] {
  const text = forgeText("gitlab");
  const end = endTimingText("gitlab");
  return [
    text.implementInspect,
    text.defaultBranchNoSelfRequest,
    ...text.publish.early,
    ...text.publish.reviewed("abc123"),
    ...text.verifyP2,
    ...text.inspectComments,
    ...text.inspectCi({ repositories: [] }),
    ...text.repairCi,
    ...text.assessTrackedCi,
    ...text.finalizeDelivery(true),
    ...text.finalizeDelivery(false),
    text.summaryResults,
    text.defaultBranchCiReason,
    ...text.decide,
    end.noPush,
    end.decide,
    ...end.commitLocal,
    ...end.verifyP2Local,
  ];
}

describe("forgeText", () => {
  it("never uses pull request wording, the pr-description skill, or gh on GitLab", () => {
    for (const line of gitlabLines()) {
      expect(line).not.toMatch(/pull request|pr-description|\bPRs?\b|\bgh\b/u);
    }
  });

  it("shares the forge-independent lines instead of copying them", () => {
    const github = forgeText("github");
    const gitlab = forgeText("gitlab");
    expect(gitlab.publish.early[0]).toBe(github.publish.early[0]);
    expect(gitlab.publish.early.at(-1)).toBe(github.publish.early.at(-1));
    expect(gitlab.verifyP2.slice(0, 3)).toEqual(github.verifyP2.slice(0, 3));
    expect(gitlab.repairCi[0]).toBe(github.repairCi[0]);
    expect(gitlab.assessTrackedCi[0]).toBe(github.assessTrackedCi[0]);
    expect(github.decide).toEqual([]);
  });

  it("adds the merge lines only when merge is allowed on GitLab", () => {
    const allowed = forgeText("gitlab").finalizeDelivery(true).join("\n");
    const disabled = forgeText("gitlab").finalizeDelivery(false).join("\n");
    expect(allowed).toContain(
      "glab mr merge <iid> --repo <projectUrl> --sha <headRevision> --auto-merge=false --yes",
    );
    expect(allowed).toContain("shows state merged");
    expect(allowed).toMatch(/^Handle verified MRs one at a time/u);
    expect(disabled).not.toContain("glab mr merge");
    expect(disabled).toMatch(/^Leave every verified MR ready/u);
  });

  it("ignores the publication on GitHub and lists one canonical watch per GitLab target", () => {
    const published = {
      repositories: [
        publishedRecord(FIRST, "https://gitlab.example.test/group/first/-/merge_requests/3"),
        publishedRecord(
          SECOND,
          "https://gitlab.example.test:8443/group/sub/second/-/merge_requests/12",
          "feat/other",
        ),
      ],
    };
    expect(forgeText("github").inspectCi(published)).toEqual(
      forgeText("github").inspectCi({ repositories: [] }),
    );
    const commands = [
      {
        id: repositoryId(FIRST),
        command: "glab",
        args: [
          "ci",
          "status",
          "--live",
          "--branch",
          "feat/demo",
          "--repo",
          "https://gitlab.example.test/group/first",
        ],
        cwd: FIRST,
        timeoutMs: 300_000,
        maxOutputChars: 1_000_000,
      },
      {
        id: repositoryId(SECOND),
        command: "glab",
        args: [
          "ci",
          "status",
          "--live",
          "--branch",
          "feat/other",
          "--repo",
          "https://gitlab.example.test:8443/group/sub/second",
        ],
        cwd: SECOND,
        timeoutMs: 300_000,
        maxOutputChars: 1_000_000,
      },
    ];
    expect(forgeText("gitlab").inspectCi(published).at(-1)).toBe(
      `Canonical glab tracking commands: ${JSON.stringify(commands)}`,
    );
  });
});

describe("reviewed publication text", () => {
  it("pushes exactly the reviewed head and reuses the one pull request on GitHub", () => {
    const lines = forgeText("github").publish.reviewed("abc123");
    expect(lines.slice(0, 2)).toEqual([
      "Push exactly the reviewed local head abc123 to the task branch without force. This head passed the review gate, so create no new commits and do not amend or rewrite any commit.",
      "If the local HEAD is not abc123, do not push. Report the difference instead.",
    ]);
    expect(lines).toContain(
      "Inspect the branch, local and remote heads, and matching pull requests first. Reuse the existing pull request for this branch and base, or open one when none exists. Never create a second pull request for the same branch and base.",
    );
    expect(lines).toContain(
      "When you open a pull request, use the pr-description skill for its body.",
    );
    expect(lines.slice(-3)).toEqual(forgeText("github").publish.early.slice(-3));
    expect(lines.join("\n")).not.toContain("before review");
  });

  it("pushes exactly the reviewed head and reuses the one merge request on GitLab", () => {
    const github = forgeText("github").publish.reviewed("abc123");
    const lines = forgeText("gitlab").publish.reviewed("abc123");
    expect(lines.slice(0, 2)).toEqual(github.slice(0, 2));
    expect(lines[2]).toBe(
      "Inspect the branch, local and remote heads, and matching merge requests first. Never create a second merge request for the same source and target branch.",
    );
    expect(lines.slice(3)).toEqual(forgeText("gitlab").publish.early.slice(2));
    expect(lines.join("\n")).toContain(
      "glab mr create --repo https://<hostname>/<project path> --source-branch <branch>",
    );
  });
});

describe("endTimingText", () => {
  it("names the pull request on GitHub", () => {
    const text = endTimingText("github");
    expect(text.noPush).toBe(
      "Do not push and do not open or update a pull request. This run pushes only after the review gate passes.",
    );
    expect(text.decide).toBe(
      "Publication timing: end. Publication first commits locally; after the review gate passes, publication pushes once to the single pull request.",
    );
    expect(text.commitLocal[1]).toBe(
      "Never push, never open or update a pull request, and never amend or rewrite a commit that was already pushed.",
    );
    expect(text.verifyP2Local[2]).toBe(
      "Do not run pi-reviewer again because the previous round had no P0 or P1 findings.",
    );
    expect(text.verifyP2Local.at(-1)).toBe("Report exact commands and outcomes.");
  });

  it("names the merge request on GitLab and shares every other line", () => {
    const github = endTimingText("github");
    const gitlab = endTimingText("gitlab");
    expect(gitlab.noPush).toBe(github.noPush.replace("pull request", "merge request"));
    expect(gitlab.decide).toBe(github.decide.replace("pull request", "merge request"));
    expect(gitlab.commitLocal).toEqual(
      github.commitLocal.map((line) => line.replace("pull request", "merge request")),
    );
    expect(gitlab.verifyP2Local).toEqual(
      github.verifyP2Local.map((line) => line.replace("pull request", "merge request")),
    );
  });
});

describe("gitlabApiCoordinates", () => {
  it("derives the hostname, encoded project, and iid of every merge request", () => {
    const first = "https://gitlab.example.test/group/first/-/merge_requests/3";
    const second = "https://gitlab.example.test:8443/group/sub/second/-/merge_requests/12";
    const coordinates = [
      {
        id: repositoryId(FIRST),
        repository: FIRST,
        pr: first,
        hostname: "gitlab.example.test",
        apiProject: "group%2Ffirst",
        iid: 3,
        projectUrl: "https://gitlab.example.test/group/first",
      },
      {
        id: repositoryId(SECOND),
        repository: SECOND,
        pr: second,
        hostname: "gitlab.example.test:8443",
        apiProject: "group%2Fsub%2Fsecond",
        iid: 12,
        projectUrl: "https://gitlab.example.test:8443/group/sub/second",
      },
    ];
    expect(
      gitlabApiCoordinates({
        repositories: [publishedRecord(FIRST, first), publishedRecord(SECOND, second)],
      }),
    ).toBe(`GitLab API coordinates: ${JSON.stringify(coordinates)}`);
  });

  it("rejects a publication whose pr is not a merge request URL", () => {
    const record = publishedRecord(FIRST, "https://github.com/group/first/pull/3");
    expect(() => gitlabApiCoordinates({ repositories: [record] })).toThrow(
      `published repository ${record.id} pr must be a GitLab merge request URL`,
    );
  });
});
