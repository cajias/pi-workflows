import { describe, expect, it } from "vitest";
import { repositoryId } from "../src/builtins/autoimplement-command-batches.js";
import {
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
  it("names the pull request nouns and gh on GitHub", () => {
    expect(forgeTerms("github")).toEqual({
      request: "pull request",
      requests: "pull requests",
      short: "PR",
      shortPlural: "PRs",
      cli: "gh",
    });
  });

  it("names the merge request nouns and glab on GitLab", () => {
    expect(forgeTerms("gitlab")).toEqual({
      request: "merge request",
      requests: "merge requests",
      short: "MR",
      shortPlural: "MRs",
      cli: "glab",
    });
  });
});

function gitlabLines(): string[] {
  const text = forgeText("gitlab");
  return [
    text.implementInspect,
    text.defaultBranchNoSelfRequest,
    ...text.publish.early,
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
