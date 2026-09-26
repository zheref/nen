// src/release/unitcheck.test.ts -- the pure pieces of `nen release unit-check`.

import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import {
  fetchChangedFiles,
  outsideReleaseUnit,
  resolvePrRef,
  resolveUnitCheckTarget,
  UnitCheckRefError,
} from "./unitcheck.js";

describe("resolvePrRef -- <n> or <owner/name>#<n>, never a guess", () => {
  it("reads a bare number with no slug", () => {
    expect(resolvePrRef("42")).toEqual({ slug: null, number: 42 });
  });

  it("reads owner/name#n", () => {
    expect(resolvePrRef("acme/widgets#7")).toEqual({ slug: "acme/widgets", number: 7 });
  });

  it("refuses a token with no digits", () => {
    expect(() => resolvePrRef("acme/widgets")).toThrow(UnitCheckRefError);
  });

  it("refuses zero -- not a positive pull-request number", () => {
    expect(() => resolvePrRef("0")).toThrow(UnitCheckRefError);
  });
});

describe("resolveUnitCheckTarget", () => {
  it("uses the explicit slug without touching git at all", () => {
    const seams = new ScriptedSeams([]);
    const target = resolveUnitCheckTarget(seams, "/repo", { slug: "acme/widgets", number: 1 });
    expect(target.slug).toBe("acme/widgets");
  });

  it("falls back to the checkout's own origin when the ref carries no slug", () => {
    const seams = new ScriptedSeams([
      { match: "git remote get-url origin", result: { code: 0, stdout: "git@github.com:acme/widgets.git\n" } },
    ]);
    const target = resolveUnitCheckTarget(seams, "/repo", { slug: null, number: 1 });
    expect(target.slug).toBe("acme/widgets");
  });

  it("refuses a malformed explicit slug", () => {
    const seams = new ScriptedSeams([]);
    expect(() => resolveUnitCheckTarget(seams, "/repo", { slug: "not-a-slug", number: 1 })).toThrow(UnitCheckRefError);
  });
});

describe("fetchChangedFiles", () => {
  it("reads the file paths off gh api --paginate .../files (F2)", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh api --paginate repos/acme/widgets/pulls/9/files",
        result: { code: 0, stdout: JSON.stringify([{ filename: "src/a.ts" }, { filename: "docs/b.md" }]) },
      },
      {
        match: "gh api repos/acme/widgets/pulls/9",
        result: { code: 0, stdout: JSON.stringify({ changed_files: 2 }) },
      },
    ]);
    const files = fetchChangedFiles(seams, { owner: "acme", repo: "widgets", slug: "acme/widgets" }, 9);
    expect(files).toEqual([
      { path: "src/a.ts", previousPath: null },
      { path: "docs/b.md", previousPath: null },
    ]);
  });

  it("reads previous_filename for a rename (F2)", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh api --paginate repos/acme/widgets/pulls/9/files",
        result: { code: 0, stdout: JSON.stringify([{ filename: "src/new.ts", previous_filename: "src/old.ts" }]) },
      },
      {
        match: "gh api repos/acme/widgets/pulls/9",
        result: { code: 0, stdout: JSON.stringify({ changed_files: 1 }) },
      },
    ]);
    const files = fetchChangedFiles(seams, { owner: "acme", repo: "widgets", slug: "acme/widgets" }, 9);
    expect(files).toEqual([{ path: "src/new.ts", previousPath: "src/old.ts" }]);
  });

  // F2: a PR reporting more changed files than the files endpoint actually
  // returned is a truncated read (GitHub paginates and caps this endpoint) --
  // refused rather than answered off an incomplete list.
  it("refuses when the PR's changed_files count disagrees with the files endpoint (F2)", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh api --paginate repos/acme/widgets/pulls/9/files",
        result: { code: 0, stdout: JSON.stringify([{ filename: "src/a.ts" }]) },
      },
      {
        match: "gh api repos/acme/widgets/pulls/9",
        result: { code: 0, stdout: JSON.stringify({ changed_files: 150 }) },
      },
    ]);
    expect(() => fetchChangedFiles(seams, { owner: "acme", repo: "widgets", slug: "acme/widgets" }, 9)).toThrow(/truncated/);
  });

  it("refuses at GitHub's 3000-file cap (F2)", () => {
    const many = Array.from({ length: 3000 }, (_unused, index): { filename: string } => ({ filename: `src/f${index}.ts` }));
    const seams = new ScriptedSeams([
      {
        match: "gh api --paginate repos/acme/widgets/pulls/9/files",
        result: { code: 0, stdout: JSON.stringify(many) },
      },
      {
        match: "gh api repos/acme/widgets/pulls/9",
        result: { code: 0, stdout: JSON.stringify({ changed_files: 3000 }) },
      },
    ]);
    expect(() => fetchChangedFiles(seams, { owner: "acme", repo: "widgets", slug: "acme/widgets" }, 9)).toThrow(/3000-file cap/);
  });
});

function file(path: string, previousPath: string | null = null): { readonly path: string; readonly previousPath: string | null } {
  return { path, previousPath };
}

describe("outsideReleaseUnit -- the pure classification", () => {
  it("is empty when every changed path is claimed by a prefix or glob", () => {
    const outside = outsideReleaseUnit([file("src/unit/a.ts"), file("src/unit/sub/b.ts")], ["src/unit"]);
    expect(outside).toEqual([]);
  });

  it("names every path outside the unit, never stopping at the first", () => {
    const outside = outsideReleaseUnit(
      [file("src/unit/a.ts"), file("src/other/b.ts"), file("docs/readme.md")],
      ["src/unit/**"],
    );
    expect(outside).toEqual(["src/other/b.ts", "docs/readme.md"]);
  });

  it("reads a glob pattern the same way ../review/scopes.ts's grammar does", () => {
    const outside = outsideReleaseUnit([file("src/unit/deep/nested/file.ts")], ["src/unit/**"]);
    expect(outside).toEqual([]);
  });

  // F2: a rename FROM outside the unit is outside, even though its new name
  // now sits inside -- the unit's boundary is not something a rename alone
  // can smuggle a file across.
  it("treats a rename-in from outside the unit as outside (F2)", () => {
    const outside = outsideReleaseUnit([file("src/unit/renamed.ts", "src/outside/renamed.ts")], ["src/unit/**"]);
    expect(outside).toEqual(["src/unit/renamed.ts"]);
  });

  it("does not flag a rename that stays inside the unit on both ends (F2)", () => {
    const outside = outsideReleaseUnit([file("src/unit/renamed.ts", "src/unit/old-name.ts")], ["src/unit/**"]);
    expect(outside).toEqual([]);
  });
});
