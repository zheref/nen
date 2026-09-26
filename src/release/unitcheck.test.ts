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
  it("reads the file paths off gh's own --json files", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh pr view 9 --repo acme/widgets --json files",
        result: { code: 0, stdout: JSON.stringify({ files: [{ path: "src/a.ts" }, { path: "docs/b.md" }] }) },
      },
    ]);
    const files = fetchChangedFiles(seams, { owner: "acme", repo: "widgets", slug: "acme/widgets" }, 9);
    expect(files).toEqual(["src/a.ts", "docs/b.md"]);
  });
});

describe("outsideReleaseUnit -- the pure classification", () => {
  it("is empty when every changed path is claimed by a prefix or glob", () => {
    const outside = outsideReleaseUnit(["src/unit/a.ts", "src/unit/sub/b.ts"], ["src/unit"]);
    expect(outside).toEqual([]);
  });

  it("names every path outside the unit, never stopping at the first", () => {
    const outside = outsideReleaseUnit(
      ["src/unit/a.ts", "src/other/b.ts", "docs/readme.md"],
      ["src/unit/**"],
    );
    expect(outside).toEqual(["src/other/b.ts", "docs/readme.md"]);
  });

  it("reads a glob pattern the same way ../review/scopes.ts's grammar does", () => {
    const outside = outsideReleaseUnit(["src/unit/deep/nested/file.ts"], ["src/unit/**"]);
    expect(outside).toEqual([]);
  });
});
