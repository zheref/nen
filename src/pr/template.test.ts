// src/pr/template.test.ts -- zheref/nen#239: the body-check bootstrap's
// template discovery and heading derivation.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deriveRequirements, discoverTemplate } from "./template.js";
import { checkBody } from "./bodycheck.js";

/** A throwaway repository root holding exactly `files` (repo-relative path -> contents). */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nen-pr-template-"));
  for (const [relative, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), contents, "utf8");
  }
  return root;
}

describe("discoverTemplate -- each of GitHub's locations", () => {
  it.each([
    [".github/PULL_REQUEST_TEMPLATE.md"],
    [".github/pull_request_template.md"],
    ["PULL_REQUEST_TEMPLATE.md"],
    ["pull_request_template.md"],
    ["docs/PULL_REQUEST_TEMPLATE.md"],
    ["docs/pull_request_template.md"],
    [".github/PULL_REQUEST_TEMPLATE/feature.md"],
    ["PULL_REQUEST_TEMPLATE/feature.md"],
    ["docs/pull_request_template/feature.md"],
  ])("finds a lone template at %s", (relative) => {
    expect(discoverTemplate(repo({ [relative]: "## Summary\n" }))).toEqual({ kind: "found", path: relative });
  });

  it("a default file wins over directory alternatives beside it -- it is what GitHub pre-fills", () => {
    const root = repo({
      ".github/pull_request_template.md": "## Summary\n",
      ".github/PULL_REQUEST_TEMPLATE/a.md": "## A\n",
      ".github/PULL_REQUEST_TEMPLATE/b.md": "## B\n",
    });
    expect(discoverTemplate(root)).toEqual({ kind: "found", path: ".github/pull_request_template.md" });
  });

  it("ignores non-markdown files and nested directories inside PULL_REQUEST_TEMPLATE/", () => {
    const root = repo({
      ".github/PULL_REQUEST_TEMPLATE/only.md": "## Only\n",
      ".github/PULL_REQUEST_TEMPLATE/notes.txt": "## Not a template\n",
      ".github/PULL_REQUEST_TEMPLATE/nested/deeper.md": "## Too deep\n",
    });
    expect(discoverTemplate(root)).toEqual({ kind: "found", path: ".github/PULL_REQUEST_TEMPLATE/only.md" });
  });

  it("a directory NAMED like the default file is not a template", () => {
    const root = repo({ ".github/pull_request_template.md/x.md": "## X\n" });
    expect(discoverTemplate(root).kind).toBe("none");
  });
});

describe("discoverTemplate -- ambiguity and absence are refusals, never a guess", () => {
  it("two default files in different locations is ambiguous, listing both", () => {
    const root = repo({ ".github/pull_request_template.md": "## A\n", "docs/pull_request_template.md": "## B\n" });
    expect(discoverTemplate(root)).toEqual({
      kind: "ambiguous",
      candidates: [".github/pull_request_template.md", "docs/pull_request_template.md"],
    });
  });

  it("several directory templates and no default is ambiguous", () => {
    const root = repo({ ".github/PULL_REQUEST_TEMPLATE/b.md": "## B\n", ".github/PULL_REQUEST_TEMPLATE/a.md": "## A\n" });
    expect(discoverTemplate(root)).toEqual({
      kind: "ambiguous",
      candidates: [".github/PULL_REQUEST_TEMPLATE/a.md", ".github/PULL_REQUEST_TEMPLATE/b.md"],
    });
  });

  it("no template anywhere is 'none', naming every place searched", () => {
    const discovery = discoverTemplate(repo({ "README.md": "# hi\n" }));
    expect(discovery.kind).toBe("none");
    if (discovery.kind !== "none") return;
    expect(discovery.searched).toContain(".github/pull_request_template.md");
    expect(discovery.searched).toContain("pull_request_template.md");
    expect(discovery.searched).toContain("docs/pull_request_template.md");
    expect(discovery.searched).toContain(".github/PULL_REQUEST_TEMPLATE/*.md");
  });

  it("a root that does not exist is 'none', not a throw", () => {
    expect(discoverTemplate(join(tmpdir(), "nen-definitely-absent-root-239")).kind).toBe("none");
  });
});

describe("deriveRequirements", () => {
  it("turns each ATX heading into one requirement at the same level", () => {
    const requirements = deriveRequirements("## Summary\n\nWhat.\n\n### How to verify ###\n\n# Title\n");
    expect(requirements.map((requirement) => requirement.name)).toEqual(["## Summary", "### How to verify", "# Title"]);
  });

  it("skips headings inside fenced code, HTML comments and front matter, and de-duplicates", () => {
    const template = [
      "---",
      "name: x",
      "---",
      "## Summary",
      "```md",
      "## Not a section",
      "```",
      "~~~",
      "## Nor this",
      "~~~",
      "<!--",
      "## Commented out",
      "-->",
      "<!-- inline --> ## Not a heading either",
      "## Summary",
      "## Test plan <!-- keep it short -->",
    ].join("\n");
    expect(deriveRequirements(template).map((requirement) => requirement.name)).toEqual(["## Summary", "## Test plan"]);
  });

  it("returns nothing for a template with no headings (the caller refuses it)", () => {
    expect(deriveRequirements("Describe your change.\n\n- [ ] tests\n")).toEqual([]);
  });

  it("escapes regex metacharacters, and the patterns match a filled-in body, case-insensitively", () => {
    const requirements = deriveRequirements("## What (and why?)\n## How to verify\n## C++ [notes]\n");
    const body = "## what (AND why?)\nbecause\n\n##   How to verify\nrun it\n\n## C++ [notes] ##\n";
    expect(checkBody(body, requirements).ok).toBe(true);
  });

  it("a heading at the wrong level, or only mentioned in prose, does not satisfy it", () => {
    const requirements = deriveRequirements("## How to verify\n");
    expect(checkBody("### How to verify\n", requirements).ok).toBe(false);
    expect(checkBody("See ## How to verify below\n", requirements).ok).toBe(false);
    expect(checkBody("## How to verify further\n", requirements).ok).toBe(false);
  });
});
