import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GITHUB_CI_BINDING,
  parseAutoimplementConcurrency,
  parseCiCommand,
  parseCiInspectionBatch,
  parsePublishedRepositories,
  validateVerificationCommandSafety,
  repositoryId,
  reviewerCommand,
} from "../src/builtins/autoimplement-command-batches.js";
import { makeTempDir } from "./helpers.js";

describe("autoimplement command batch contracts", () => {
  it("normalizes bounded concurrency", () => {
    expect(parseAutoimplementConcurrency(undefined)).toEqual({
      reviewer: 4,
      ciWatch: 4,
      verification: 2,
    });
    expect(parseAutoimplementConcurrency({ reviewer: 1 })).toEqual({
      reviewer: 1,
      ciWatch: 4,
      verification: 2,
    });
    expect(() => parseAutoimplementConcurrency({ reviewer: 9 })).toThrow(/1 through 8/);
    expect(() => parseAutoimplementConcurrency({ unknown: 1 })).toThrow(/not supported/);
  });

  it("derives stable repository ids and reviewer commands from publication", async () => {
    const repository = await makeTempDir("published-repository");
    const parsed = parsePublishedRepositories({
      repositories: [
        {
          repository,
          branch: "feat/demo",
          baseBranch: "main",
          headRevision: "abc123",
          pr: "https://example.test/pr/1",
          pushed: true,
        },
      ],
    });
    expect(parsed.repositories[0]).toMatchObject({
      id: repositoryId(repository),
      repository: path.resolve(repository),
      headRevision: "abc123",
    });
    expect(
      parsePublishedRepositories({
        repositories: [
          {
            repository,
            branch: "feat/demo",
            baseBranch: "main",
            headRevision: "abc123",
            pr: "https://example.test/pr/1",
            pushed: true,
            dependencyFingerprint: "sha256:dependency",
          },
        ],
      }).repositories[0],
    ).toMatchObject({ dependencyFingerprint: "sha256:dependency" });
    expect(reviewerCommand(parsed.repositories[0]!)).toEqual({
      id: repositoryId(repository),
      command: "pi-reviewer",
      args: ["--base", "main"],
      cwd: path.resolve(repository),
      timeoutMs: 600_000,
      maxOutputChars: 1_000_000,
    });
  });

  it("rejects duplicate or incomplete publication records", async () => {
    const repository = await makeTempDir("duplicate-publication");
    const record = {
      repository,
      branch: "feat/demo",
      baseBranch: "main",
      headRevision: "abc123",
      pr: "https://example.test/pr/1",
      pushed: true,
    };
    expect(() => parsePublishedRepositories({ repositories: [record, record] })).toThrow(
      /duplicated/,
    );
    expect(() =>
      parsePublishedRepositories({ repositories: [{ ...record, pushed: false }] }),
    ).toThrow(/pushed must be true/);
    expect(() => parsePublishedRepositories({ repositories: [] })).toThrow(/non-empty/);
    expect(() =>
      parsePublishedRepositories({
        repositories: Array.from({ length: 65 }, (_, index) => ({
          ...record,
          repository: path.join(repository, String(index)),
        })),
      }),
    ).toThrow(/at most 64/);
    expect(() =>
      parsePublishedRepositories({ repositories: [{ ...record, repository: "relative" }] }),
    ).toThrow(/absolute/);
    expect(() =>
      parsePublishedRepositories({
        repositories: [{ ...record, dependencyFingerprint: 1 }],
      }),
    ).toThrow(/non-empty string/);
  });

  it("rejects unsafe verification executables and publication actions", () => {
    for (const executable of [
      "git",
      "bash",
      "dash",
      "cmd.exe",
      "C:\\Windows\\System32\\PowerShell.exe",
    ]) {
      expect(() => validateVerificationCommandSafety(executable, [], "check")).toThrow(
        /not allowed/,
      );
    }
    expect(() => validateVerificationCommandSafety("npm", ["publish"], "check")).toThrow(
      /mutation or publication/,
    );
    expect(() => validateVerificationCommandSafety("npm", ["test"], "check")).not.toThrow();
  });

  it("normalizes per-PR CI state and validates pending watch commands", async () => {
    const repository = await makeTempDir("ci-target");
    const id = repositoryId(repository);
    const pr = "https://example.test/pr/1";
    const parsed = parseCiInspectionBatch({
      targets: [
        {
          repository,
          headRevision: "abc123",
          pr,
          route: "pending",
          reason: "running",
          relatedFailures: [],
          unrelatedFailures: [],
          trackingCommand: {
            id,
            command: "gh",
            args: ["pr", "checks", "--watch"],
            cwd: repository,
            timeoutMs: 300_000,
            maxOutputChars: 100_000,
          },
        },
      ],
    });
    expect(parsed).toMatchObject({
      route: "pending",
      targets: [
        {
          id,
          route: "pending",
          trackingCommand: { args: ["pr", "checks", pr, "--watch"] },
        },
      ],
    });
    for (const route of ["green", "failed", "unavailable"] as const) {
      expect(
        parseCiInspectionBatch({
          targets: [
            {
              repository,
              headRevision: "abc123",
              pr: "https://example.test/pr/1",
              route,
              reason: route,
            },
          ],
        }).route,
      ).toBe(route);
    }
    expect(() => parseCiInspectionBatch({ targets: [] })).toThrow(/non-empty/);
    expect(() =>
      parseCiInspectionBatch({
        targets: Array.from({ length: 65 }, (_, index) => ({
          repository: path.join(repository, String(index)),
          headRevision: "abc123",
          pr: `https://example.test/pr/${index}`,
          route: "green",
          reason: "green",
        })),
      }),
    ).toThrow(/at most 64/);
    expect(() =>
      parseCiInspectionBatch({
        targets: [
          {
            repository,
            headRevision: "abc123",
            pr: "https://example.test/pr/1",
            route: "green",
            reason: "green",
          },
          {
            repository,
            headRevision: "abc123",
            pr: "https://example.test/pr/1",
            route: "green",
            reason: "green",
          },
        ],
      }),
    ).toThrow(/duplicated/);
    expect(() =>
      parseCiInspectionBatch({
        targets: [
          {
            repository,
            headRevision: "abc123",
            pr: "https://example.test/pr/1",
            route: "unknown",
            reason: "unknown",
          },
        ],
      }),
    ).toThrow(/route is invalid/);
    const command = {
      id,
      command: "gh",
      args: ["pr", "checks", "--watch"],
      cwd: repository,
      timeoutMs: 300_000,
      maxOutputChars: 100_000,
    };
    expect(
      parseCiCommand({ ...command, args: ["run", "watch", "123"] }, id, repository, pr),
    ).toMatchObject({
      args: ["pr", "checks", pr, "--watch"],
    });
    expect(
      parseCiCommand({ ...command, args: ["pr", "checks", pr, "--watch"] }, id, repository, pr),
    ).toMatchObject({
      args: ["pr", "checks", pr, "--watch"],
    });
    for (const invalid of [
      { ...command, id: "wrong" },
      { ...command, command: "git" },
      { ...command, args: "bad" },
      { ...command, cwd: path.join(repository, "other") },
      { ...command, timeoutMs: 0 },
      { ...command, maxOutputChars: 0 },
      { ...command, args: ["pr", "merge"] },
      { ...command, args: ["pr", "checks", "https://example.test/pr/2", "--watch"] },
      { ...command, args: ["pr", "checks", pr, "--watch", "--repo", "other/repo"] },
      { ...command, args: ["run", "watch", "123", "--repo", "other/repo"] },
    ]) {
      expect(() => parseCiCommand(invalid, id, repository, pr)).toThrow();
    }
  });
});

describe("autoimplement GitLab CI watch binding", () => {
  const pr = "https://gitlab.example.test/group/sub/project/-/merge_requests/7";
  const projectUrl = "https://gitlab.example.test/group/sub/project";
  const binding = { forge: "gitlab" as const, branch: "feat/demo" };
  const canonical = ["ci", "status", "--live", "--branch", "feat/demo", "--repo", projectUrl];

  async function target() {
    const repository = await makeTempDir("gitlab-ci-target");
    const id = repositoryId(repository);
    const command = (args: string[], overrides: Record<string, unknown> = {}) => ({
      id,
      command: "glab",
      args,
      cwd: repository,
      timeoutMs: 300_000,
      maxOutputChars: 1_000_000,
      ...overrides,
    });
    return { repository, id, command };
  }

  it.each([
    [["ci", "status", "--live"]],
    [["ci", "status", "--wait", "--branch", "feat/demo"]],
    [["ci", "status", "-l", "-b", "feat/demo", "-R", projectUrl]],
    [["ci", "status", "--repo=group/sub/project", "--live", "--branch=feat/demo"]],
    [["ci", "status", "--live", "-R", "gitlab.example.test/group/sub/project"]],
  ])("accepts and normalizes %j", async (args) => {
    const { repository, id, command } = await target();
    expect(parseCiCommand(command(args), id, repository, pr, binding)).toEqual({
      id,
      command: "glab",
      args: canonical,
      cwd: repository,
      timeoutMs: 300_000,
      maxOutputChars: 1_000_000,
    });
  });

  it.each([
    [["ci", "status"], "must watch with --live, -l, or --wait"],
    [["ci", "status", "--live", "--live"], "repeats the watch flag"],
    [["ci", "status", "--live", "--wait"], "repeats the watch flag"],
    [["ci", "status", "--live", "--branch", "main"], "published source branch"],
    [["ci", "status", "--live", "-b", "feat/demo", "--branch", "feat/demo"], "repeats the branch"],
    [["ci", "status", "--live", "--branch"], "branch option needs a value"],
    [["ci", "status", "--live", "--branch="], "branch option needs a value"],
    [["ci", "status", "--live", "--repo", "other/project"], "merge request project"],
    [
      ["ci", "status", "--live", "-R", "https://evil.example/group/sub/project"],
      "merge request project",
    ],
    [["ci", "status", "--live", "-F", "json"], "option is not allowed: -F"],
    [["ci", "status", "--live", "--compact"], "option is not allowed: --compact"],
    [["ci", "status", "--live", "constructor", "x"], "option is not allowed: constructor"],
    [["ci", "status", "--live", "__proto__"], "option is not allowed: __proto__"],
    [["ci", "status", "--live", "--branch=feat/demo", "extra"], "option is not allowed: extra"],
    [["ci", "get", "-b", "feat/demo"], "must start with ci status"],
    [["ci", "view"], "must start with ci status"],
    [["ci", "trace", "12"], "must start with ci status"],
    [["api", "projects/:id/pipelines"], "must start with ci status"],
    [["mr", "merge", "7"], "must start with ci status"],
  ])("rejects %j", async (args, message) => {
    const { repository, id, command } = await target();
    expect(() => parseCiCommand(command(args), id, repository, pr, binding)).toThrow(message);
  });

  it.each(["gh", "sh", "bash", "/usr/bin/env"])("rejects the %s executable", async (executable) => {
    const { repository, id, command } = await target();
    expect(() =>
      parseCiCommand(
        command(["ci", "status", "--live"], { command: executable }),
        id,
        repository,
        pr,
        binding,
      ),
    ).toThrow("CI tracking command.command must be glab");
  });

  it("rejects a target that is not a merge request URL and other target bindings", async () => {
    const { repository, id, command } = await target();
    const live = ["ci", "status", "--live"];
    expect(() =>
      parseCiCommand(
        command(live),
        id,
        repository,
        "https://gitlab.example.test/group/project/merge_requests/7",
        binding,
      ),
    ).toThrow("CI target pr must be a GitLab merge request URL");
    for (const invalid of [
      command(live, { id: "wrong" }),
      command(live, { cwd: `${repository}/other` }),
      command(live, { timeoutMs: 300_001 }),
      command(live, { maxOutputChars: 1_000_001 }),
      command(live, { args: "ci status --live" }),
    ]) {
      expect(() => parseCiCommand(invalid, id, repository, pr, binding)).toThrow();
    }
  });

  it("keeps glab out of GitHub watches and gh out of GitLab watches", async () => {
    const { repository, id, command } = await target();
    expect(() =>
      parseCiCommand(command(["ci", "status", "--live"]), id, repository, pr, GITHUB_CI_BINDING),
    ).toThrow("CI tracking command.command must be gh");
    expect(() =>
      parseCiCommand(
        command(["pr", "checks", "--watch"], { command: "gh" }),
        id,
        repository,
        pr,
        binding,
      ),
    ).toThrow("CI tracking command.command must be glab");
  });

  it("binds pending GitLab inspection targets through the target id", async () => {
    const { repository, id, command } = await target();
    const inspection = (targetPr: string) => ({
      targets: [
        {
          repository,
          headRevision: "abc123",
          pr: targetPr,
          route: "pending",
          reason: "running",
          trackingCommand: command(["ci", "status", "--wait"]),
        },
      ],
    });
    const seen: string[] = [];
    const parsed = parseCiInspectionBatch(inspection(pr), (targetId) => {
      seen.push(targetId);
      return binding;
    });
    expect(seen).toEqual([id]);
    expect(parsed.targets[0]?.trackingCommand?.args).toEqual(canonical);
    expect(() =>
      parseCiInspectionBatch(inspection("https://example.test/pr/1"), () => binding),
    ).toThrow("CI target pr must be a GitLab merge request URL");
  });
});
