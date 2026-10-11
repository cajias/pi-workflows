import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const skillRoot = path.join(root, "skills");

function skill(name: string): string {
  return readFileSync(path.join(skillRoot, name, "SKILL.md"), "utf8");
}

describe("bundled workflow skills", () => {
  it("ships one matching skill for each operator-facing built-in", () => {
    const names = readdirSync(skillRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(names).toEqual([
      "autodoc",
      "autoimplement",
      "autoplan",
      "monitor",
      "pi-workflows",
      "sanity-check",
    ]);
    for (const name of names) {
      expect(skill(name)).toContain(`name: ${name}`);
    }
  });

  it.each(["autodoc", "autoimplement", "autoplan", "sanity-check"])(
    "routes %s through its built-in workflow",
    (name) => {
      expect(skill(name)).toContain(`built-in \`${name}\` workflow`);
    },
  );

  it("routes monitor through its built-in workflow", () => {
    expect(skill("monitor")).toContain("built-in Pi `monitor` workflow");
  });

  it("forbids the GitLab CLI in autoimplement verification checks", () => {
    expect(skill("autoimplement")).toContain("GitLab CLI");
  });

  it("guides autoimplement outside Pi through glab merge requests on GitLab", () => {
    const markdown = skill("autoimplement");
    expect(markdown).toContain("On GitLab, use `glab` and merge requests (MRs)");
    expect(markdown).toContain("never open a second MR for the same branch pair");
    expect(markdown).toContain("`glab mr merge <iid> --sha <head> --auto-merge=false --yes`");
  });

  it("guides autoimplement to publish once after review with prTiming end", () => {
    const markdown = skill("autoimplement");
    expect(markdown).toContain(
      "With `end`, the workflow commits locally, runs pi-reviewer on the local commits, and pushes once to open or update the single pull request or merge request only after review passes.",
    );
    expect(markdown).toContain("Direct `defaultBranch` work ignores this field.");
    expect(markdown).toContain(
      "With `prTiming: end`, keep commits local until pi-reviewer passes for the current local head, then push once",
    );
    expect(markdown).not.toContain("does not change publication order");
  });

  it("keeps initial planning out of autoimplement and autodoc", () => {
    expect(skill("autoimplement")).toContain("Do not devise an initial plan");
    expect(skill("autodoc")).toContain("It does not choose, devise, improve, or revise");
  });
});
