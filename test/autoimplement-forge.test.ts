import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORGE_RESOLUTION_SCHEMA,
  defaultForgeIo,
  detectForge,
  ghHostsFile,
  glabConfigFiles,
  parseForgeRequest,
  parseForgeResolution,
  parseGhHostsYaml,
  parseGitLabMergeRequestUrl,
  parseGlabHostsYaml,
  parseRemoteHost,
  readForgeFacts,
  redactRemoteUrl,
  resolveForge,
  type ForgeFacts,
  type ForgeIo,
} from "../src/builtins/autoimplement-forge.js";
import { makeTempDir } from "./helpers.js";
import { git } from "./helpers/autoimplement-fixtures.js";

/** Mirrors the shape of a real glab config with a self-managed host behind a separate SSH host. */
const GLAB_CONFIG = `# glab config
git_protocol: ssh
check_update: false
hosts:
    code.aws.dev:
        api_protocol: https
        api_host: code.aws.dev
        ssh_host: ssh.code.aws.dev
        token: glpat-SECRET-ONE
        git_protocol: ssh
    gitlab.com:
        token: "glpat-SECRET-TWO"
    "quoted.example:8443":
        api_host: 'api.quoted.example' # comment
        ssh_host:
        user: someone
editor: vim
`;

function facts(overrides: Partial<ForgeFacts> = {}): ForgeFacts {
  return {
    remoteUrl: "git@unknown.example:g/p.git",
    ghHosts: [],
    glabHosts: [],
    gitlabHostEnv: null,
    ...overrides,
  };
}

type IoCall = { kind: "git" | "read"; value: string };

function fakeIo(
  options: {
    remotes?: Record<string, string>;
    files?: Record<string, string>;
    env?: NodeJS.ProcessEnv;
    gitError?: Error;
  } = {},
): { io: ForgeIo; calls: IoCall[] } {
  const calls: IoCall[] = [];
  const remotes = options.remotes ?? {};
  const io: ForgeIo = {
    env: options.env ?? {},
    homeDir: "/home/user",
    runGit: async (_cwd, args) => {
      calls.push({ kind: "git", value: args.join(" ") });
      if (options.gitError !== undefined) throw options.gitError;
      if (args[0] === "remote" && args.length === 1) return Object.keys(remotes).join("\n");
      const url = remotes[args[2] ?? ""];
      if (url === undefined) throw new Error(`error: No such remote '${args[2]}'`);
      return url;
    },
    readText: async (file) => {
      calls.push({ kind: "read", value: file });
      return options.files?.[file] ?? null;
    },
  };
  return { io, calls };
}

describe("autoimplement forge requests", () => {
  it("accepts auto, github, gitlab, or nothing", () => {
    expect(parseForgeRequest(undefined, "forge")).toBeUndefined();
    for (const value of ["auto", "github", "gitlab"]) {
      expect(parseForgeRequest(value, "forge")).toBe(value);
    }
    expect(() => parseForgeRequest("bitbucket", "autoimplement forge")).toThrow(
      "autoimplement forge must be auto, github, or gitlab",
    );
    expect(() => parseForgeRequest(1, "forge")).toThrow("must be auto, github, or gitlab");
  });
});

describe("autoimplement remote parsing", () => {
  it.each([
    ["git@github.com:o/r.git", "github.com", null],
    ["ssh://git@github.com/o/r.git", "github.com", null],
    ["git+ssh://git@host.example/o/r", "host.example", null],
    ["https://github.com/o/r.git", "github.com", null],
    ["http://h.example/x/y", "h.example", null],
    ["git://h.example:9418/x/y", "h.example", 9418],
    ["ssh://git@gitlab.example.com:2222/g/p.git", "gitlab.example.com", 2222],
    ["https://[::1]:8443/g/p", "::1", 8443],
    ["git@[::1]:g/p.git", "::1", null],
    ["git@GitLab.Example.COM:g/p.git", "gitlab.example.com", null],
    ["ssh://git@GitLab.Example.COM/g/p.git", "gitlab.example.com", null],
    ["  host.example:g/p.git  ", "host.example", null],
  ])("parses %s", (remote, host, port) => {
    expect(parseRemoteHost(remote)).toEqual({ host, port });
  });

  it.each([
    "/abs/repo.git",
    "./rel",
    "../rel",
    "file:///x",
    "",
    "ftp://host.example/x",
    "ssh://",
    "https://exa mple.com/x",
    "user@host-without-path",
  ])("finds no network host in %j", (remote) => {
    expect(parseRemoteHost(remote)).toBeNull();
  });

  it("removes URL credentials and keeps scp-like remotes unchanged", () => {
    expect(redactRemoteUrl("https://oauth2:TOKEN@gitlab.example.com/g/p.git")).toBe(
      "https://gitlab.example.com/g/p.git",
    );
    expect(redactRemoteUrl("ssh://user:pw@host.example:2222/g/p.git")).toBe(
      "ssh://host.example:2222/g/p.git",
    );
    expect(redactRemoteUrl("https://a@b:c@host.example/g/p")).toBe("https://host.example/g/p");
    expect(redactRemoteUrl("https://host.example/g/p@v1")).toBe("https://host.example/g/p@v1");
    expect(redactRemoteUrl("git@host.example:g/p.git")).toBe("git@host.example:g/p.git");
  });
});

describe("autoimplement forge host files", () => {
  it("lists top-level gh hosts and keeps no values", () => {
    const text = [
      "# gh hosts",
      "github.com:",
      "    user: someone",
      "    oauth_token: gho_SECRET",
      "",
      "ghe.example.com:",
      "    nested:",
      "        deeper: value",
      '"quoted.example":',
      "- not-a-key",
    ].join("\n");
    const hosts = parseGhHostsYaml(text);
    expect(hosts).toEqual(["github.com", "ghe.example.com", "quoted.example"]);
    expect(JSON.stringify(hosts)).not.toContain("SECRET");
  });

  it("reads glab host keys, api_host, and ssh_host but never tokens", () => {
    const entries = parseGlabHostsYaml(GLAB_CONFIG);
    expect(entries).toEqual([
      { key: "code.aws.dev", apiHost: "code.aws.dev", sshHost: "ssh.code.aws.dev" },
      { key: "gitlab.com" },
      { key: "quoted.example:8443", apiHost: "api.quoted.example" },
    ]);
    expect(JSON.stringify(entries)).not.toContain("SECRET");
  });

  it("ignores glab files without a hosts block", () => {
    expect(parseGlabHostsYaml("hosts: {}\n  nested.example:\n")).toEqual([]);
    expect(parseGlabHostsYaml("other:\n    host.example:\n        api_host: x\n")).toEqual([]);
    expect(parseGlabHostsYaml("hosts:\n        api_host: orphan\n")).toEqual([{ key: "api_host" }]);
    expect(parseGlabHostsYaml("hosts:\n    a.example:\n  odd: value\n    b.example:\n")).toEqual([
      { key: "a.example" },
      { key: "b.example" },
    ]);
  });
});

describe("autoimplement forge detection", () => {
  const glabHosts = parseGlabHostsYaml(GLAB_CONFIG);

  it("uses an explicit forge against a contrary remote", () => {
    for (const forge of ["github", "gitlab"] as const) {
      expect(detectForge(forge, facts({ remoteUrl: "git@gitlab.com:g/p.git" }))).toEqual({
        schema: FORGE_RESOLUTION_SCHEMA,
        requested: forge,
        forge,
        host: null,
        remoteUrl: null,
        reason: "explicit input",
      });
    }
  });

  it("falls back to GitHub without a remote or a network host", () => {
    expect(detectForge("auto", facts({ remoteUrl: null }))).toMatchObject({
      forge: "github",
      host: null,
      remoteUrl: null,
      reason: "no Git remote; using GitHub (upstream default)",
    });
    expect(detectForge("auto", facts({ remoteUrl: "/srv/git/p.git" }))).toMatchObject({
      forge: "github",
      host: null,
      remoteUrl: "/srv/git/p.git",
      reason: expect.stringContaining("no network host"),
    });
  });

  it("recognizes github.com and gitlab.com remotes", () => {
    expect(detectForge("auto", facts({ remoteUrl: "git@github.com:o/r.git" }))).toMatchObject({
      forge: "github",
      host: "github.com",
      reason: "remote host github.com",
    });
    expect(
      detectForge("auto", facts({ remoteUrl: "https://gitlab.com/g/p.git", glabHosts })),
    ).toMatchObject({ forge: "gitlab", host: "gitlab.com", reason: "remote host gitlab.com" });
  });

  it("matches a self-managed GitLab through ssh_host, the key, or api_host", () => {
    expect(
      detectForge("auto", facts({ remoteUrl: "git@ssh.code.aws.dev:g/p.git", glabHosts })),
    ).toMatchObject({
      requested: "auto",
      forge: "gitlab",
      host: "code.aws.dev",
      remoteUrl: "git@ssh.code.aws.dev:g/p.git",
      reason: "glab ssh_host ssh.code.aws.dev of code.aws.dev",
    });
    expect(
      detectForge("auto", facts({ remoteUrl: "git@code.aws.dev:g/p.git", glabHosts })),
    ).toMatchObject({ forge: "gitlab", host: "code.aws.dev", reason: "glab host code.aws.dev" });
    expect(
      detectForge("auto", facts({ remoteUrl: "https://api.quoted.example/g/p.git", glabHosts })),
    ).toMatchObject({
      forge: "gitlab",
      host: "quoted.example:8443",
      reason: "glab api_host api.quoted.example of quoted.example:8443",
    });
  });

  it("ignores ports when it compares a host:port key with a remote", () => {
    expect(
      detectForge("auto", facts({ remoteUrl: "ssh://git@quoted.example:2222/g/p.git", glabHosts })),
    ).toMatchObject({ forge: "gitlab", host: "quoted.example:8443" });
    expect(
      detectForge(
        "auto",
        facts({ remoteUrl: "https://v6.example/g/p", glabHosts: [{ key: "[v6.example]:8443" }] }),
      ),
    ).toMatchObject({ forge: "gitlab", host: "[v6.example]:8443" });
  });

  it("uses gh hosts for GitHub Enterprise and reports ambiguity", () => {
    expect(
      detectForge(
        "auto",
        facts({ remoteUrl: "git@ghe.example.com:o/r.git", ghHosts: ["GHE.example.com"] }),
      ),
    ).toMatchObject({
      forge: "github",
      host: "ghe.example.com",
      reason: "gh host ghe.example.com",
    });
    const both = detectForge(
      "auto",
      facts({ remoteUrl: "git@code.aws.dev:g/p.git", ghHosts: ["code.aws.dev"], glabHosts }),
    );
    expect(both).toMatchObject({ forge: "github", host: "code.aws.dev" });
    expect(both.reason).toContain("configured for both gh and glab");
    expect(both.reason).toContain("Set forge explicitly");
  });

  it("matches GITLAB_HOST given as a URL or a bare host", () => {
    expect(
      detectForge(
        "auto",
        facts({
          remoteUrl: "git@gitlab.example.test:g/p.git",
          gitlabHostEnv: "https://GitLab.Example.Test",
        }),
      ),
    ).toMatchObject({
      forge: "gitlab",
      host: "gitlab.example.test",
      reason: "GITLAB_HOST gitlab.example.test",
    });
    expect(
      detectForge(
        "auto",
        facts({
          remoteUrl: "git@gitlab.example.test:g/p.git",
          gitlabHostEnv: "gitlab.example.test:8080",
        }),
      ),
    ).toMatchObject({ forge: "gitlab", host: "gitlab.example.test" });
    expect(
      detectForge(
        "auto",
        facts({ remoteUrl: "git@gitlab.example.test:g/p.git", gitlabHostEnv: "other.example" }),
      ),
    ).toMatchObject({ forge: "github" });
    expect(
      detectForge(
        "auto",
        facts({
          remoteUrl: "git@gitlab.example.test:g/p.git",
          gitlabHostEnv: "ftp://gitlab.example.test",
        }),
      ),
    ).toMatchObject({ forge: "github" });
  });

  it("falls back to GitHub for an unknown host", () => {
    expect(detectForge("auto", facts({ glabHosts }))).toMatchObject({
      forge: "github",
      host: "unknown.example",
      remoteUrl: "git@unknown.example:g/p.git",
      reason: "unknown host unknown.example; using GitHub (upstream default)",
    });
  });
});

describe("autoimplement forge IO", () => {
  it("chooses the gh hosts file in gh's own order", () => {
    const homeDir = "/home/user";
    expect(ghHostsFile({ env: { GH_CONFIG_DIR: "/gh", XDG_CONFIG_HOME: "/xdg" }, homeDir })).toBe(
      path.join("/gh", "hosts.yml"),
    );
    expect(ghHostsFile({ env: { GH_CONFIG_DIR: "", XDG_CONFIG_HOME: "/xdg" }, homeDir })).toBe(
      path.join("/xdg", "gh", "hosts.yml"),
    );
    expect(ghHostsFile({ env: {}, homeDir })).toBe(
      path.join(homeDir, ".config", "gh", "hosts.yml"),
    );
  });

  it("lists glab config candidates in order", () => {
    const homeDir = "/home/user";
    expect(
      glabConfigFiles({ env: { GLAB_CONFIG_DIR: "/glab", XDG_CONFIG_HOME: "/xdg" }, homeDir }),
    ).toEqual([
      path.join("/glab", "config.yml"),
      path.join(homeDir, ".config", "glab-cli", "config.yml"),
      path.join("/xdg", "glab-cli", "config.yml"),
    ]);
    expect(glabConfigFiles({ env: {}, homeDir })).toEqual([
      path.join(homeDir, ".config", "glab-cli", "config.yml"),
    ]);
  });

  it("reads origin and the configured host files", async () => {
    const { io, calls } = fakeIo({
      remotes: { origin: "https://oauth2:TOKEN@ssh.code.aws.dev/g/p.git" },
      env: { GH_CONFIG_DIR: "/gh", GLAB_CONFIG_DIR: "/glab", GITLAB_HOST: "gitlab.example.test" },
      files: {
        [path.join("/gh", "hosts.yml")]: "ghe.example.com:\n    user: me\n",
        [path.join("/glab", "config.yml")]: GLAB_CONFIG,
        [path.join("/home/user", ".config", "glab-cli", "config.yml")]:
          "hosts:\n    ignored.example:\n",
      },
    });
    const read = await readForgeFacts("/repo", io);
    expect(read).toEqual({
      remoteUrl: "https://ssh.code.aws.dev/g/p.git",
      ghHosts: ["ghe.example.com"],
      glabHosts: parseGlabHostsYaml(GLAB_CONFIG),
      gitlabHostEnv: "gitlab.example.test",
    });
    expect(calls).toEqual([
      { kind: "git", value: "remote get-url origin" },
      { kind: "read", value: path.join("/gh", "hosts.yml") },
      { kind: "read", value: path.join("/glab", "config.yml") },
    ]);
    expect(await resolveForge("auto", "/repo", io)).toMatchObject({
      forge: "gitlab",
      host: "code.aws.dev",
      remoteUrl: "https://ssh.code.aws.dev/g/p.git",
    });
  });

  it("uses the first remote when origin is missing and falls through glab candidates", async () => {
    const { io, calls } = fakeIo({
      remotes: { upstream: "git@code.aws.dev:g/p.git", other: "git@github.com:o/r.git" },
      env: { GLAB_CONFIG_DIR: "/glab", XDG_CONFIG_HOME: "/xdg" },
      files: { [path.join("/xdg", "glab-cli", "config.yml")]: GLAB_CONFIG },
    });
    const read = await readForgeFacts("/repo", io);
    expect(read).toMatchObject({
      remoteUrl: "git@code.aws.dev:g/p.git",
      ghHosts: [],
      gitlabHostEnv: null,
    });
    expect(read.glabHosts).toHaveLength(3);
    expect(calls.map((call) => call.value)).toEqual([
      "remote get-url origin",
      "remote",
      "remote get-url upstream",
      path.join("/xdg", "gh", "hosts.yml"),
      path.join("/glab", "config.yml"),
      path.join("/home/user", ".config", "glab-cli", "config.yml"),
      path.join("/xdg", "glab-cli", "config.yml"),
    ]);
  });

  it("reads no hosts when the host files are missing", async () => {
    const { io, calls } = fakeIo({ remotes: { origin: "git@code.aws.dev:g/p.git" } });
    expect(await readForgeFacts("/repo", io)).toEqual({
      remoteUrl: "git@code.aws.dev:g/p.git",
      ghHosts: [],
      glabHosts: [],
      gitlabHostEnv: null,
    });
    expect(calls.filter((call) => call.kind === "read")).toHaveLength(2);
  });

  it("reads no host files without a remote", async () => {
    const { io, calls } = fakeIo({ remotes: {} });
    expect(await readForgeFacts("/repo", io)).toEqual({
      remoteUrl: null,
      ghHosts: [],
      glabHosts: [],
      gitlabHostEnv: null,
    });
    expect(calls.every((call) => call.kind === "git")).toBe(true);
    const empty = fakeIo({ remotes: { origin: "" } });
    expect((await readForgeFacts("/repo", empty.io)).remoteUrl).toBeNull();
  });

  it("does no IO for an explicit request", async () => {
    const { io, calls } = fakeIo({ remotes: { origin: "git@gitlab.com:g/p.git" } });
    expect(await resolveForge("github", "/repo", io)).toMatchObject({
      requested: "github",
      forge: "github",
      reason: "explicit input",
    });
    expect(await resolveForge("gitlab", "/repo")).toMatchObject({ forge: "gitlab" });
    expect(calls).toEqual([]);
  });

  it("turns IO failures into a GitHub resolution", async () => {
    const { io } = fakeIo({ gitError: new Error("fatal: not a git repository") });
    expect(await resolveForge("auto", "/repo", io)).toEqual({
      schema: FORGE_RESOLUTION_SCHEMA,
      requested: "auto",
      forge: "github",
      host: null,
      remoteUrl: null,
      reason:
        "could not read the Git remote or forge host files (fatal: not a git repository); using GitHub (upstream default)",
    });
    const thrower: ForgeIo = {
      ...fakeIo({ remotes: { origin: "git@code.aws.dev:g/p.git" } }).io,
      readText: async () => {
        throw "unreadable";
      },
    };
    expect((await resolveForge("auto", "/repo", thrower)).reason).toContain("(unreadable)");
  });

  it("records gitlab for a real repository with a self-managed remote and glab config", async () => {
    const repository = await makeTempDir("forge-real-repo");
    const glabDir = await makeTempDir("forge-glab-config");
    const homeDir = await makeTempDir("forge-home");
    await git(repository, ["init", "-b", "main"]);
    await git(repository, ["remote", "add", "origin", "git@ssh.code.aws.dev:team/project.git"]);
    await fs.writeFile(path.join(glabDir, "config.yml"), GLAB_CONFIG);
    const io: ForgeIo = { ...defaultForgeIo(), env: { GLAB_CONFIG_DIR: glabDir }, homeDir };
    expect(await resolveForge("auto", repository, io)).toEqual({
      schema: FORGE_RESOLUTION_SCHEMA,
      requested: "auto",
      forge: "gitlab",
      host: "code.aws.dev",
      remoteUrl: "git@ssh.code.aws.dev:team/project.git",
      reason: "glab ssh_host ssh.code.aws.dev of code.aws.dev",
    });
    const plain = await makeTempDir("forge-real-plain");
    await git(plain, ["init", "-b", "main"]);
    expect(await resolveForge("auto", plain, io)).toMatchObject({
      forge: "github",
      reason: "no Git remote; using GitHub (upstream default)",
    });
    // Without injected IO the process environment is used; a repository without a remote reads no host file.
    expect(await resolveForge("auto", plain)).toMatchObject({ forge: "github", host: null });
  });

  it("reads missing files as absent and rethrows other read errors", async () => {
    const directory = await makeTempDir("forge-read");
    const file = path.join(directory, "file.txt");
    await fs.writeFile(file, "text");
    const io = defaultForgeIo();
    expect(await io.readText(file)).toBe("text");
    expect(await io.readText(path.join(directory, "missing.yml"))).toBeNull();
    expect(await io.readText(path.join(file, "below-a-file.yml"))).toBeNull();
    await expect(io.readText(directory)).rejects.toThrow(/EISDIR/);
  });
});

describe("autoimplement forge resolution records", () => {
  const valid = {
    schema: FORGE_RESOLUTION_SCHEMA,
    requested: "auto",
    forge: "gitlab",
    host: "code.aws.dev",
    remoteUrl: "git@ssh.code.aws.dev:g/p.git",
    reason: "glab ssh_host ssh.code.aws.dev of code.aws.dev",
  };

  it("reads a recorded resolution", () => {
    expect(parseForgeResolution(valid)).toEqual(valid);
    expect(parseForgeResolution({ ...valid, host: null, remoteUrl: null })).toMatchObject({
      host: null,
      remoteUrl: null,
    });
  });

  it.each([
    [null, "must be an object"],
    [[], "must be an object"],
    [{ ...valid, extra: true }, "unknown keys: extra"],
    [{ ...valid, schema: "other" }, "schema must be"],
    [{ ...valid, requested: "bitbucket" }, "must be auto, github, or gitlab"],
    [{ ...valid, requested: undefined }, "requested is required"],
    [{ ...valid, forge: "auto" }, "forge must be github or gitlab"],
    [{ ...valid, reason: "" }, "reason must be a non-empty string"],
    [{ ...valid, host: 1 }, "host must be a string or null"],
    [{ ...valid, remoteUrl: undefined }, "remoteUrl must be a string or null"],
  ])("rejects %j", (value, message) => {
    expect(() => parseForgeResolution(value)).toThrow(message);
  });
});

describe("GitLab merge request URLs", () => {
  it("derives the project and REST coordinates", () => {
    expect(
      parseGitLabMergeRequestUrl(
        "https://gitlab.example.test/group/sub/project/-/merge_requests/7",
        "pr",
      ),
    ).toEqual({
      url: "https://gitlab.example.test/group/sub/project/-/merge_requests/7",
      host: "gitlab.example.test",
      projectPath: "group/sub/project",
      iid: 7,
      projectUrl: "https://gitlab.example.test/group/sub/project",
      apiProject: "group%2Fsub%2Fproject",
    });
    expect(
      parseGitLabMergeRequestUrl("https://code.example:8443/g/p.v2_x/-/merge_requests/12", "pr"),
    ).toMatchObject({ host: "code.example:8443", projectPath: "g/p.v2_x", iid: 12 });
  });

  it.each([
    "http://gitlab.example.test/group/project/-/merge_requests/7",
    "https://gitlab.example.test/group/project/merge_requests/7",
    "https://gitlab.example.test/group/project/-/merge_requests/0",
    "https://gitlab.example.test/group/project/-/merge_requests/07",
    "https://gitlab.example.test/group/project/-/merge_requests/7?tab=diffs",
    "https://gitlab.example.test/group/project/-/merge_requests/7#note_1",
    "https://gitlab.example.test/group/project/-/merge_requests/7/diffs",
    "https://gitlab.example.test/group/project/-/merge_requests/7/",
    "https://gitlab.example.test/project/-/merge_requests/7",
    "https://gitlab.example.test/group/-project/-/merge_requests/7",
    "https://gitlab.example.test/group/../-/merge_requests/7",
    "https://user@gitlab.example.test/group/project/-/merge_requests/7",
    "https://gitlab.example.test/group/project/-/merge_requests/99999999999999999999",
    "https://github.com/o/r/pull/7",
    7,
  ])("rejects %j", (value) => {
    expect(() => parseGitLabMergeRequestUrl(value, "CI target pr")).toThrow(
      "CI target pr must be a GitLab merge request URL",
    );
  });
});
