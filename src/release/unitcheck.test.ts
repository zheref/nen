// src/release/unitcheck.test.ts -- the pure pieces of `nen release unit-check`.

import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import {
  assembleUnitCheck,
  checkKeyScopedPath,
  fetchChangedFiles,
  fetchJsonAtRef,
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
        match: "gh api --paginate --slurp repos/acme/widgets/pulls/9/files",
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

  it("flattens two pages of --slurp output into one changed-file list (item 5)", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh api --paginate --slurp repos/acme/widgets/pulls/9/files",
        // `--slurp` wraps each page's own JSON array inside one outer array
        // -- this is what TWO pages of the underlying endpoint look like
        // once `gh` has slurped them, as opposed to the un-slurped
        // concatenation of two bare arrays back-to-back.
        result: {
          code: 0,
          stdout: JSON.stringify([
            [{ filename: "src/a.ts" }, { filename: "src/b.ts" }],
            [{ filename: "docs/c.md" }],
          ]),
        },
      },
      {
        match: "gh api repos/acme/widgets/pulls/9",
        result: { code: 0, stdout: JSON.stringify({ changed_files: 3 }) },
      },
    ]);
    const files = fetchChangedFiles(seams, { owner: "acme", repo: "widgets", slug: "acme/widgets" }, 9);
    expect(files).toEqual([
      { path: "src/a.ts", previousPath: null },
      { path: "src/b.ts", previousPath: null },
      { path: "docs/c.md", previousPath: null },
    ]);
  });

  it("reads previous_filename for a rename (F2)", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh api --paginate --slurp repos/acme/widgets/pulls/9/files",
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
        match: "gh api --paginate --slurp repos/acme/widgets/pulls/9/files",
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
        match: "gh api --paginate --slurp repos/acme/widgets/pulls/9/files",
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

  it("claims a content-scoped (object) entry's path by exact equality, not as a pattern", () => {
    const outside = outsideReleaseUnit(
      [file("nen/contract.json")],
      [{ path: "nen/contract.json", keys: ["version"] }],
    );
    expect(outside).toEqual([]);
  });

  it("a content-scoped entry's path does not claim a different file, even a sibling", () => {
    const outside = outsideReleaseUnit(
      [file("nen/other.json")],
      [{ path: "nen/contract.json", keys: ["version"] }],
    );
    expect(outside).toEqual(["nen/other.json"]);
  });
});

const TARGET = { owner: "acme", repo: "widgets", slug: "acme/widgets" };

describe("fetchJsonAtRef -- reads and parses a repo file's content at one ref, fail-closed", () => {
  function contentsCall(json: unknown): { readonly match: string; readonly result: { readonly code: number; readonly stdout: string } } {
    return {
      match: "gh api repos/acme/widgets/contents/nen/contract.json?ref=abc123",
      result: { code: 0, stdout: JSON.stringify({ content: Buffer.from(JSON.stringify(json)).toString("base64") }) },
    };
  }

  it("decodes base64 content and parses it as JSON", () => {
    const seams = new ScriptedSeams([contentsCall({ version: "1.0.0" })]);
    expect(fetchJsonAtRef(seams, TARGET, "nen/contract.json", "abc123")).toEqual({ version: "1.0.0" });
  });

  it("is null when gh itself refuses (missing file, bad ref, ...)", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/acme/widgets/contents/nen/contract.json?ref=abc123", result: { code: 1, stdout: "", stderr: "404" } },
    ]);
    expect(fetchJsonAtRef(seams, TARGET, "nen/contract.json", "abc123")).toBeNull();
  });

  it("is null when the decoded content is not valid JSON", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh api repos/acme/widgets/contents/nen/contract.json?ref=abc123",
        result: { code: 0, stdout: JSON.stringify({ content: Buffer.from("not json").toString("base64") }) },
      },
    ]);
    expect(fetchJsonAtRef(seams, TARGET, "nen/contract.json", "abc123")).toBeNull();
  });
});

describe("checkKeyScopedPath -- a content-scoped entry's own verdict", () => {
  it("passes when the only leaves that differ are declared keys (dotted or JSON-pointer)", () => {
    const outcome = checkKeyScopedPath(
      { path: "nen/contract.json", keys: ["version", "/nested/allowed"] },
      "base",
      "head",
      (path, ref): unknown =>
        ref === "base"
          ? { version: "1.0.0", nested: { allowed: "x" } }
          : { version: "1.0.1", nested: { allowed: "y" } },
    );
    expect(outcome).toEqual({ path: "nen/contract.json", ok: true, offendingKeys: [] });
  });

  it("fails and names the offending key when an undeclared leaf changes too (version + description)", () => {
    const outcome = checkKeyScopedPath(
      { path: "nen/contract.json", keys: ["version"] },
      "base",
      "head",
      (path, ref): unknown =>
        ref === "base"
          ? { version: "1.0.0", description: "old" }
          : { version: "1.0.1", description: "new" },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.offendingKeys).toEqual(["description"]);
  });

  it("fails closed when either side is unreadable/unparseable JSON", () => {
    const outcome = checkKeyScopedPath({ path: "nen/contract.json", keys: ["version"] }, "base", "head", (): unknown => null);
    expect(outcome.ok).toBe(false);
    expect(outcome.offendingKeys.length).toBeGreaterThan(0);
  });
});

describe("assembleUnitCheck -- wired with a keyScoped context", () => {
  it("reports ok:true when a plain unit is clean and a content-scoped entry only changed its declared key", () => {
    const report = assembleUnitCheck(
      TARGET,
      42,
      [{ path: "nen/contract.json", keys: ["version"] }],
      [file("nen/contract.json")],
      { baseRef: "base", headRef: "head", readJson: (path, ref): unknown => (ref === "base" ? { version: "1.0.0" } : { version: "1.0.1" }) },
    );
    expect(report.ok).toBe(true);
    expect(report.keyScopedViolations).toEqual([]);
  });

  it("reports ok:false and names the offending key when the content-scoped entry changes outside its keys", () => {
    const report = assembleUnitCheck(
      TARGET,
      42,
      [{ path: "nen/contract.json", keys: ["version"] }],
      [file("nen/contract.json")],
      {
        baseRef: "base",
        headRef: "head",
        readJson: (path, ref): unknown => (ref === "base" ? { version: "1.0.0", description: "old" } : { version: "1.0.1", description: "new" }),
      },
    );
    expect(report.ok).toBe(false);
    expect(report.keyScopedViolations).toEqual([{ path: "nen/contract.json", ok: false, offendingKeys: ["description"] }]);
  });

  it("skips the content read entirely for a keyed entry that was never changed", () => {
    let reads = 0;
    const report = assembleUnitCheck(
      TARGET,
      42,
      [{ path: "nen/contract.json", keys: ["version"] }, "src/unit/**"],
      [file("src/unit/a.ts")],
      { baseRef: "base", headRef: "head", readJson: (): unknown => { reads += 1; return {}; } },
    );
    expect(reads).toBe(0);
    expect(report.ok).toBe(true);
  });
});
