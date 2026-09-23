// src/shu/coverage/roots.test.ts -- the root a report's row names are resolved
// against (zheref/nen#236), on strings and an injected `exists`. No filesystem.

import { describe, expect, it } from "vitest";
import { counts, target, type CoverageTarget } from "./shape.js";
import { isAbsoluteName, joinUnder, rebaseRows, resolveRoot, rootCandidates } from "./roots.js";
import { filterTouchedGroups } from "./touched.js";

function row(name: string, covered = 1, total = 1): CoverageTarget {
  return target(name, counts(covered, total), null);
}

describe("rootCandidates", () => {
  it("a member's coverage/ directory proposes the member, then the lane cwd, then the repo root", () => {
    expect(rootCandidates("packages/core/coverage/lcov.info", "")).toEqual([
      { root: "packages/core", basis: "artifact" },
      { root: "", basis: "lane-cwd" },
    ]);
  });

  it("no trailing `coverage` segment proposes no artifact root at all", () => {
    expect(rootCandidates("build/reports/lcov.info", "apps/web")).toEqual([
      { root: "apps/web", basis: "lane-cwd" },
      { root: "", basis: "repo-root" },
    ]);
  });

  it("the single-package shape collapses to ONE candidate, keeping the earliest basis", () => {
    expect(rootCandidates("coverage/lcov.info", ".")).toEqual([{ root: "", basis: "artifact" }]);
  });

  it("backslashes and a trailing slash on the lane cwd are one spelling", () => {
    expect(rootCandidates("apps\\web\\coverage\\lcov.info", "apps/web/")).toEqual([
      { root: "apps/web", basis: "artifact" },
      { root: "", basis: "repo-root" },
    ]);
  });
});

describe("joinUnder", () => {
  it("joins and normalises", () => {
    expect(joinUnder("packages/a", "./src/x.ts")).toBe("packages/a/src/x.ts");
    expect(joinUnder("", "src\\x.ts")).toBe("src/x.ts");
  });

  it("refuses a join that climbs out of the repository", () => {
    expect(joinUnder("packages/a", "../../../etc/x.ts")).toBeNull();
    expect(joinUnder("", "../x.ts")).toBeNull();
  });
});

describe("isAbsoluteName", () => {
  it("POSIX, drive letters and UNC are absolute; a relative name is not", () => {
    expect(isAbsoluteName("/w/repo/src/a.ts")).toBe(true);
    expect(isAbsoluteName("C:\\w\\a.ts")).toBe(true);
    expect(isAbsoluteName("\\\\host\\share\\a.ts")).toBe(true);
    expect(isAbsoluteName("src/a.ts")).toBe(false);
  });
});

describe("resolveRoot", () => {
  const candidates = rootCandidates("packages/core/coverage/lcov.info", "");

  it("the candidate whose joins exist on disk wins", () => {
    const onDisk = new Set(["packages/core/src/a.ts", "packages/core/src/b.ts"]);
    const resolved = resolveRoot([row("src/a.ts"), row("src/b.ts")], candidates, (p) => onDisk.has(p));
    expect(resolved).toEqual({ root: "packages/core", basis: "artifact", onDisk: 2, relative: 2 });
  });

  it("a later candidate wins only by finding MORE files, never by tying", () => {
    const onDisk = new Set(["packages/core/src/a.ts", "src/a.ts", "src/b.ts"]);
    const resolved = resolveRoot([row("src/a.ts"), row("src/b.ts")], candidates, (p) => onDisk.has(p));
    expect(resolved).toMatchObject({ root: "", basis: "lane-cwd", onDisk: 2 });
  });

  it("nothing on disk: the first candidate, not a coin toss", () => {
    expect(resolveRoot([row("src/a.ts")], candidates, () => false)).toMatchObject({
      root: "packages/core",
      basis: "artifact",
      onDisk: 0,
    });
  });

  it("absolute names are not counted -- they are anchored already", () => {
    const resolved = resolveRoot([row("/w/repo/src/a.ts")], candidates, () => true);
    expect(resolved).toMatchObject({ onDisk: 0, relative: 0 });
  });
});

describe("rebaseRows", () => {
  it("prefixes relative names, leaves absolute and escaping names exactly as written", () => {
    const rows = [row("src/a.ts"), row("/abs/b.ts"), row("../../../c.ts")];
    expect(rebaseRows(rows, "packages/core").map((entry): string => entry.name)).toEqual([
      "packages/core/src/a.ts",
      "/abs/b.ts",
      "../../../c.ts",
    ]);
  });

  it("at the repository root every row is returned byte-for-byte (the single-package regression)", () => {
    const rows = [row("src\\a.ts"), row("./b.ts")];
    expect(rebaseRows(rows, "")).toEqual(rows);
  });
});

describe("filterTouchedGroups", () => {
  it("a file matched by ANY report is matched; the first-declared row wins a duplicate", () => {
    const filter = filterTouchedGroups(
      [
        { rows: [row("packages/a/src/x.ts", 1, 2)], grain: "file" },
        { rows: [row("packages/a/src/x.ts", 2, 2), row("apps/web/src/p.tsx")], grain: "file" },
      ],
      ["apps/web/src/p.tsx", "README.md", "packages/a/src/x.ts"],
      null,
    );
    expect(filter.matched).toEqual(["apps/web/src/p.tsx", "packages/a/src/x.ts"]);
    expect(filter.unmatched).toEqual(["README.md"]);
    expect(filter.rows.map((entry): string => entry.name)).toEqual(["packages/a/src/x.ts", "apps/web/src/p.tsx"]);
    expect(filter.rows[0]?.lines.covered).toBe(1);
  });

  it("each report is matched at its OWN grain", () => {
    const filter = filterTouchedGroups(
      [
        { rows: [row("com/example")], grain: "package" },
        { rows: [row("web/a.ts")], grain: "file" },
      ],
      ["src/main/java/com/example/Foo.java", "web/a.ts"],
      null,
    );
    expect(filter.matched).toEqual(["src/main/java/com/example/Foo.java", "web/a.ts"]);
  });

  it("no groups: every touched file is unmatched", () => {
    expect(filterTouchedGroups([], ["a.ts"], null)).toEqual({ rows: [], matched: [], unmatched: ["a.ts"] });
  });
});
