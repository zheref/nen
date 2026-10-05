// src/pr/template.test.ts -- zheref/nen#239: the body-check bootstrap's
// template discovery, heading derivation and derived-body check.

import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkDerivedBody,
  deriveRequirements,
  discoverTemplate,
  isContained,
  readLines,
  stripComments,
  workingTreeReader,
} from "./template.js";

/** A throwaway repository root holding exactly `files` (repo-relative path -> contents). */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nen-pr-template-"));
  for (const [relative, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), contents, "utf8");
  }
  return root;
}

const discover = (root: string): ReturnType<typeof discoverTemplate> => discoverTemplate(workingTreeReader(root));
const names = (template: string): string[] => deriveRequirements(template).map((requirement) => requirement.name);
const statuses = (body: string, template: string): string[] =>
  checkDerivedBody(body, deriveRequirements(template)).results.map((result) => `${result.status} ${result.name}`);

describe("discoverTemplate -- each of GitHub's locations", () => {
  it.each([
    [".github/PULL_REQUEST_TEMPLATE.md"],
    [".github/pull_request_template.md"],
    [".github/pull_request_template.txt"],
    ["PULL_REQUEST_TEMPLATE.md"],
    ["pull_request_template.TXT"],
    ["docs/PULL_REQUEST_TEMPLATE.md"],
    ["docs/pull_request_template.txt"],
    [".github/PULL_REQUEST_TEMPLATE/feature.md"],
    [".github/PULL_REQUEST_TEMPLATE/feature.txt"],
    ["PULL_REQUEST_TEMPLATE/feature.md"],
    ["docs/pull_request_template/feature.TXT"],
  ])("finds a lone template at %s", (relative) => {
    expect(discover(repo({ [relative]: "## Summary\n" }))).toEqual({ kind: "found", path: relative });
  });

  // N9: a default file with no extension, or another extension, is not one.
  it.each([["pull_request_template"], [".github/pull_request_template"], ["docs/pull_request_template.rst"]])(
    "does not accept %s",
    (relative) => {
      expect(discover(repo({ [relative]: "## Summary\n" })).kind).toBe("none");
    },
  );

  it("a .md and a .txt default in the same place are two candidates -- ambiguous (N9)", () => {
    const root = repo({ ".github/pull_request_template.md": "## A\n", ".github/pull_request_template.txt": "## B\n" });
    expect(discover(root)).toEqual({
      kind: "ambiguous",
      candidates: [".github/pull_request_template.md", ".github/pull_request_template.txt"],
    });
  });

  it("a default file wins over directory alternatives beside it -- it is what GitHub pre-fills", () => {
    const root = repo({
      ".github/pull_request_template.md": "## Summary\n",
      ".github/PULL_REQUEST_TEMPLATE/a.md": "## A\n",
      ".github/PULL_REQUEST_TEMPLATE/b.md": "## B\n",
    });
    expect(discover(root)).toEqual({ kind: "found", path: ".github/pull_request_template.md" });
  });

  it("ignores other extensions and nested directories inside PULL_REQUEST_TEMPLATE/", () => {
    const root = repo({
      ".github/PULL_REQUEST_TEMPLATE/only.md": "## Only\n",
      ".github/PULL_REQUEST_TEMPLATE/notes.rst": "## Not a template\n",
      ".github/PULL_REQUEST_TEMPLATE/bare": "## Not one either\n",
      ".github/PULL_REQUEST_TEMPLATE/nested/deeper.md": "## Too deep\n",
    });
    expect(discover(root)).toEqual({ kind: "found", path: ".github/PULL_REQUEST_TEMPLATE/only.md" });
  });

  it("a directory NAMED like the default file is not a template", () => {
    expect(discover(repo({ ".github/pull_request_template.md/x.md": "## X\n" })).kind).toBe("none");
  });
});

describe("discoverTemplate -- ambiguity and absence are refusals, never a guess", () => {
  it("two default files in different locations is ambiguous, listing both", () => {
    const root = repo({ ".github/pull_request_template.md": "## A\n", "docs/pull_request_template.md": "## B\n" });
    expect(discover(root)).toEqual({
      kind: "ambiguous",
      candidates: [".github/pull_request_template.md", "docs/pull_request_template.md"],
    });
  });

  it("several directory templates and no default is ambiguous", () => {
    const root = repo({ ".github/PULL_REQUEST_TEMPLATE/b.md": "## B\n", ".github/PULL_REQUEST_TEMPLATE/a.txt": "## A\n" });
    expect(discover(root)).toEqual({
      kind: "ambiguous",
      candidates: [".github/PULL_REQUEST_TEMPLATE/a.txt", ".github/PULL_REQUEST_TEMPLATE/b.md"],
    });
  });

  it("no template anywhere is 'none', naming every place searched", () => {
    const discovery = discover(repo({ "README.md": "# hi\n" }));
    expect(discovery.kind).toBe("none");
    if (discovery.kind !== "none") return;
    expect(discovery.searched).toContain(".github/pull_request_template.{md,txt}");
    expect(discovery.searched).toContain("pull_request_template.{md,txt}");
    expect(discovery.searched).toContain("docs/pull_request_template.{md,txt}");
    expect(discovery.searched).toContain(".github/PULL_REQUEST_TEMPLATE/*.{md,txt}");
  });

  it("a root that does not exist is 'none', not a throw", () => {
    expect(discover(join(tmpdir(), "nen-definitely-absent-root-239")).kind).toBe("none");
  });
});

describe("stripComments", () => {
  it("removes every pair across the whole line and reports a comment left open (N8)", () => {
    expect(stripComments("<!-- a --> text <!--", false)).toEqual({ text: " text ", open: true });
    expect(stripComments("a <!-- b --> c <!-- d --> e", false)).toEqual({ text: "a  c  e", open: false });
    expect(stripComments("still inside --> after", true)).toEqual({ text: " after", open: false });
    expect(stripComments("still inside", true)).toEqual({ text: "", open: true });
  });
});

describe("deriveRequirements", () => {
  it("turns each ATX heading into one requirement at the same level", () => {
    expect(names("## Summary\n\nWhat.\n\n### How to verify ###\n\n# Title\n")).toEqual(["## Summary", "### How to verify", "# Title"]);
  });

  it("skips headings inside fenced code and HTML comments, and de-duplicates", () => {
    const template = [
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
      "<!-- inline --> ## An HTML block line, never a heading",
      "## Summary",
      "## Test plan <!-- keep it short -->",
    ].join("\n");
    expect(names(template)).toEqual(["## Summary", "## Test plan"]);
  });

  // N1: the heading before an opening comment is kept; the comment it opens
  // still swallows the lines up to its close.
  it("keeps a heading on a line that opens a multi-line comment", () => {
    expect(names("## Summary <!--\n describe\n## Inside\n-->\n## After\n")).toEqual(["## Summary", "## After"]);
  });

  // N8: a comment that closes and a second that opens on the same line.
  it("a second comment opened after a closed one on the same line still hides what follows", () => {
    expect(names("## Top\n<!-- a --> text <!--\n## Hidden\n-->\n")).toEqual(["## Top"]);
  });

  // N2.
  it("a UTF-8 BOM does not hide the first heading", () => {
    expect(names("﻿## Summary\n## Test plan\n")).toEqual(["## Summary", "## Test plan"]);
  });

  // N11: no front-matter rule -- a leading '---' is a thematic break.
  it("a leading '---' is a horizontal rule, not front matter", () => {
    expect(names("---\n## A\n---\n## B\n")).toEqual(["## A", "## B"]);
  });

  // N12: tabs inside the heading text are whitespace runs too.
  it("a tab inside a template heading matches a space in the body", () => {
    expect(statuses("## How to verify\nrun it\n", "## How\tto verify\n")).toEqual(["ok ## How to verify"]);
  });

  it("returns nothing for a template with no headings (the caller refuses it)", () => {
    expect(deriveRequirements("Describe your change.\n\n- [ ] tests\n")).toEqual([]);
  });

  it("escapes regex metacharacters and matches case-insensitively", () => {
    expect(statuses("## what (AND why?)\nbecause\n\n## C++ [notes] ##\nx\n", "## What (and why?)\n## C++ [notes]\n")).toEqual([
      "ok ## What (and why?)",
      "ok ## C++ [notes]",
    ]);
  });

  it("a heading at the wrong level, only in prose, or with more text, does not match", () => {
    const template = "## How to verify\n";
    expect(statuses("### How to verify\nx\n", template)).toEqual(["missing ## How to verify"]);
    expect(statuses("See ## How to verify below\n", template)).toEqual(["missing ## How to verify"]);
    expect(statuses("## How to verify further\nx\n", template)).toEqual(["missing ## How to verify"]);
  });
});

describe("checkDerivedBody", () => {
  const template = "## Summary <!-- one line -->\n<!-- what changed -->\n\n## How to verify\nDescribe the steps.\n";

  // N4 + N3: the untouched template matches every heading (the prefilled
  // inline comment kept) and fails only on content.
  it("a verbatim-template body matches every heading, then fails each as EMPTY", () => {
    expect(statuses(template, template)).toEqual(["empty ## Summary", "empty ## How to verify"]);
    expect(checkDerivedBody(template, deriveRequirements(template)).ok).toBe(false);
  });

  // N4: the pattern itself admits the trailing comment, so a pattern copied
  // into a shipped file still matches a raw body line that kept it.
  it("the derived pattern admits trailing comment spans on the raw heading line", () => {
    const [requirement] = deriveRequirements("## Summary\n");
    expect(new RegExp(requirement?.pattern ?? "", "im").test("## Summary <!-- one line --> <!-- two -->")).toBe(true);
  });

  it("a filled body passes, even keeping the prefilled inline comment on the heading", () => {
    const body = "## Summary <!-- one line -->\nA real change.\n\n## How to verify\nRun the suite.\n";
    expect(statuses(body, template)).toEqual(["ok ## Summary", "ok ## How to verify"]);
  });

  // N3: what does NOT count as content.
  it("blank lines, comments and the template's own placeholder lines are not content", () => {
    const body = "## Summary\n\n<!-- todo -->\n\n## How to verify\nDescribe the steps.\n";
    expect(statuses(body, template)).toEqual(["empty ## Summary", "empty ## How to verify"]);
  });

  it("content under a deeper sub-heading counts; the next same-level heading ends the section", () => {
    const deep = "## Changes\n### Details\n## Notes\n";
    expect(statuses("## Changes\n### Details\nfilled\n## Notes\nx\n", deep)).toEqual(["ok ## Changes", "ok ### Details", "ok ## Notes"]);
    expect(statuses("## Changes\n## Notes\nx\n### Details\ny\n", deep)).toEqual(["empty ## Changes", "ok ### Details", "ok ## Notes"]);
  });

  it("a fenced block is content under its heading", () => {
    expect(statuses("## How to verify\n```sh\nbun run test\n```\n", "## How to verify\n")).toEqual(["ok ## How to verify"]);
  });

  // N10: a heading hidden in a comment or a fence in the BODY does not count.
  it("a heading inside a body comment or fenced block is masked", () => {
    const one = "## How to verify\n";
    expect(statuses("<!--\n## How to verify\nsteps\n-->\n", one)).toEqual(["missing ## How to verify"]);
    expect(statuses("```\n## How to verify\nsteps\n```\n", one)).toEqual(["missing ## How to verify"]);
  });

  it("a BOM on the body does not hide its first heading (N2)", () => {
    expect(statuses("﻿## How to verify\nsteps\n", "## How to verify\n")).toEqual(["ok ## How to verify"]);
  });
});

describe("readLines", () => {
  // R9: a bare `##` is a heading with no title -- a section boundary.
  it("classifies a bare ATX heading as an untitled heading, and '#hashtag' as content", () => {
    expect(readLines("##\n#hashtag\n")).toEqual([
      { kind: "heading", level: 2, text: "##", title: "", atx: true },
      { kind: "content", text: "#hashtag" },
      { kind: "blank" },
    ]);
  });

  // R3.
  it("reads thematic breaks and HTML-tag-only lines as blank, and a Setext underline as a heading boundary", () => {
    expect(readLines("***\n- - -\n___\n<details>\n</details> <br/>\nTitle\n===\n")).toEqual([
      { kind: "blank" },
      { kind: "blank" },
      { kind: "blank" },
      { kind: "blank" },
      { kind: "blank" },
      { kind: "heading", level: 1, text: "Title", title: "Title", atx: false },
      { kind: "blank" },
      { kind: "blank" },
    ]);
  });
});

describe("the section rules (round 2)", () => {
  // R9: a bare `##` ends the section above it.
  it("a bare '##' is a section boundary, so content after it does not fill the heading above", () => {
    expect(statuses("## A\n##\nafter the boundary\n## B\ny\n", "## A\n## B\n")).toEqual(["empty ## A", "ok ## B"]);
  });

  // R3: what a body puts under a heading that is not content.
  it("a thematic break, an HTML-tag-only line, or a Setext title is not content", () => {
    const template = "## Summary\n## Next\n";
    expect(statuses("## Summary\n---\n## Next\nx\n", template)).toEqual(["empty ## Summary", "ok ## Next"]);
    expect(statuses("## Summary\n<details></details>\n## Next\nx\n", template)).toEqual(["empty ## Summary", "ok ## Next"]);
    expect(statuses("## Summary\nA title\n---\n## Next\nx\n", template)).toEqual(["empty ## Summary", "ok ## Next"]);
    // A tag with words inside it is content.
    expect(statuses("## Summary\n<summary>Why</summary>\n## Next\nx\n", template)).toEqual(["ok ## Summary", "ok ## Next"]);
  });

  it("a Setext heading in the template is not a requirement", () => {
    expect(names("Title\n=====\n## Summary\n")).toEqual(["## Summary"]);
  });

  // R4.
  it("a placeholder line differing only in letter case or whitespace is still the template's own -- EMPTY", () => {
    expect(statuses("## A\ndescribe the   CHANGE.\n", "## A\nDescribe\tthe change.\n")).toEqual(["empty ## A"]);
  });

  // R5.
  it("text after a '-->' closing a comment from an earlier line is never a heading", () => {
    expect(names("## A\n<!--\nnote --> ## Hidden\n")).toEqual(["## A"]);
    expect(statuses("<!--\nx --> ## A\nsteps\n", "## A\n")).toEqual(["missing ## A"]);
  });
});

describe("isContained (R8)", () => {
  // Chosen by the platform ARGUMENT, never the host's path module: this case
  // must evaluate the same on a Windows runner (where `path.sep` is '\\').
  it("is exact on POSIX", () => {
    expect(isContained("/repo", "/repo/.github/t.md", "linux")).toBe(true);
    expect(isContained("/repo", "/Repo/.github/t.md", "linux")).toBe(false);
    expect(isContained("/repo", "/repository/t.md", "linux")).toBe(false);
  });

  it("folds case and separators on win32", () => {
    expect(isContained("C:\\Users\\Me\\Repo", "c:\\users\\me\\repo\\.github\\t.md", "win32")).toBe(true);
    expect(isContained("C:\\Users\\Me\\Repo", "C:/Users/Me/Repo/.github/t.md", "win32")).toBe(true);
    expect(isContained("C:\\Users\\Me\\Repo", "C:\\Users\\Me\\Repository\\t.md", "win32")).toBe(false);
    expect(isContained("C:\\Users\\Me\\Repo", "D:\\Users\\Me\\Repo\\t.md", "win32")).toBe(false);
  });
});

describe("workingTreeReader -- reads refuse as usage errors (exit 2), never 1", () => {
  // N6.
  it.skipIf(process.platform === "win32")("refuses a template symlinked to a file outside the root", () => {
    const outside = repo({ "elsewhere.md": "## Secret\n" });
    const root = repo({});
    mkdirSync(join(root, ".github"));
    symlinkSync(join(outside, "elsewhere.md"), join(root, ".github", "pull_request_template.md"));
    const reader = workingTreeReader(root);
    expect(discoverTemplate(reader)).toEqual({ kind: "found", path: ".github/pull_request_template.md" });
    expect(() => reader.read(".github/pull_request_template.md")).toThrow(
      expect.objectContaining({ name: "VerbUsageError", message: expect.stringMatching(/outside the repository root/) }),
    );
  });

  // R8: a directory junction needs no symlink privilege on Windows; elsewhere
  // node makes it a directory symlink. Skipped only if it cannot be created.
  it("refuses a template reached through a directory junction pointing outside the root", (context) => {
    const outside = repo({ "pull_request_template.md": "## Secret\n" });
    const root = repo({});
    try {
      symlinkSync(outside, join(root, ".github"), "junction");
    } catch {
      context.skip();
    }
    const reader = workingTreeReader(root);
    expect(discoverTemplate(reader)).toEqual({ kind: "found", path: ".github/pull_request_template.md" });
    expect(() => reader.read(".github/pull_request_template.md")).toThrow(
      expect.objectContaining({ name: "VerbUsageError", message: expect.stringMatching(/outside the repository root/) }),
    );
  });

  // Both sides are canonicalised the same way (realpathSync.native), so a
  // root named through an alias -- a link to the checkout here, an 8.3 short
  // name on a Windows runner (zheref/nen#294) -- still contains its own files.
  it("reads a template when the root itself is named through an alias", (context) => {
    const real = repo({ ".github/pull_request_template.md": "## Summary\n" });
    const alias = join(mkdtempSync(join(tmpdir(), "nen-pr-alias-")), "checkout");
    try {
      symlinkSync(real, alias, "junction");
    } catch {
      context.skip();
    }
    expect(workingTreeReader(alias).read(".github/pull_request_template.md")).toBe("## Summary\n");
  });

  it.skipIf(process.platform === "win32")("reads a template symlinked to a file INSIDE the root", () => {
    const root = repo({ "templates-src/pr.md": "## Inside\n" });
    mkdirSync(join(root, ".github"));
    symlinkSync(join(root, "templates-src", "pr.md"), join(root, ".github", "pull_request_template.md"));
    expect(workingTreeReader(root).read(".github/pull_request_template.md")).toBe("## Inside\n");
  });

  // N5.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable template is a usage error naming the file", () => {
    const root = repo({ ".github/pull_request_template.md": "## Summary\n" });
    const file = join(root, ".github", "pull_request_template.md");
    chmodSync(file, 0o000);
    try {
      expect(() => workingTreeReader(root).read(".github/pull_request_template.md")).toThrow(
        expect.objectContaining({ name: "VerbUsageError", message: expect.stringMatching(/pull_request_template\.md.*EACCES/) }),
      );
    } finally {
      chmodSync(file, 0o644);
    }
  });
});
