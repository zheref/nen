// src/shu/coverage/touched.test.ts -- the pure matching this file's sibling
// (../coverage.ts) drives from `git diff --name-only`: which rows a set of
// touched files claims, and per-row `met` on top of them.

import { describe, expect, it } from "vitest";
import { counts, target } from "./shape.js";
import { filterTouched, grainOf, touchedByPackage } from "./touched.js";

describe("grainOf", () => {
  it("is 'package' for cobertura and jacoco, 'file' for everything else", () => {
    expect(grainOf("cobertura")).toBe("package");
    expect(grainOf("jacoco")).toBe("package");
    expect(grainOf("istanbul-summary")).toBe("file");
    expect(grainOf("lcov")).toBe("file");
    // xccov-report defaults to "file" here: ../coverage.ts has already
    // descended it into targets[].files[] before this module ever sees a row,
    // so by the time grainOf is asked, an xccov row IS a file row.
    expect(grainOf("xccov-report")).toBe("file");
    expect(grainOf("some-future-format-nobody-wrote-yet")).toBe("file");
  });
});

describe("touchedByPackage", () => {
  it("matches a slash-separated package against the directory-per-package convention", () => {
    // JaCoCo's own spelling: 'io/placeholder/core', and Java's own convention
    // nests the package as a literal directory run under the source root.
    expect(touchedByPackage("src/main/kotlin/io/placeholder/core/Store.kt", "io/placeholder/core")).toBe(true);
    expect(touchedByPackage("io/placeholder/core/Store.kt", "io/placeholder/core")).toBe(true);
  });

  it("matches a dot-separated namespace by splitting on '.'", () => {
    expect(touchedByPackage("src/Placeholder/Core/Store.cs", "Placeholder.Core")).toBe(true);
  });

  it("does not match a different package, or a package that is only a PREFIX of a segment", () => {
    expect(touchedByPackage("src/main/kotlin/io/placeholder/app/Program.kt", "io/placeholder/core")).toBe(false);
    // 'io/placeholder/core2' must not match a file under '.../core/...':
    // segment-by-segment equality, never a substring test.
    expect(touchedByPackage("io/placeholder/core/Store.kt", "io/placeholder/core2")).toBe(false);
  });

  it("requires at least one segment LEFT OVER for the file itself", () => {
    // The package's own segments filling the WHOLE path, with nothing after
    // them, is a directory equalling a file's full path -- never true, because
    // a package is a directory and a directory is not one of the files in it.
    expect(touchedByPackage("io/placeholder/core", "io/placeholder/core")).toBe(false);
  });

  it("finds the package's run anywhere in the path, not only at the root", () => {
    expect(touchedByPackage("modules/app/src/main/java/com/acme/widget/Widget.java", "com/acme/widget")).toBe(
      true,
    );
  });

  it("is false for an empty package name", () => {
    expect(touchedByPackage("a/b/c.ts", "")).toBe(false);
  });
});

const FILE_ROW = target("packages/core/src/index.ts", counts(11, 13), counts(3, 4));
const OTHER_FILE_ROW = target("packages/app/src/main.ts", counts(3, 4), null);
const PACKAGE_ROW = target("io/placeholder/core", counts(11, 13), null);

describe("filterTouched", () => {
  it("file grain: keeps only rows an exact touched path names", () => {
    const result = filterTouched(
      [FILE_ROW, OTHER_FILE_ROW],
      ["packages/core/src/index.ts", "README.md"],
      "file",
      null,
    );
    expect(result.rows.map((row): string => row.name)).toEqual(["packages/core/src/index.ts"]);
    expect(result.matched).toEqual(["packages/core/src/index.ts"]);
    expect(result.unmatched).toEqual(["README.md"]);
  });

  it("file grain: normalizes '\\\\' to '/' on both sides before comparing", () => {
    const windowsRow = target("packages\\core\\src\\index.ts", counts(11, 13), null);
    const result = filterTouched([windowsRow], ["packages/core/src/index.ts"], "file", null);
    expect(result.matched).toEqual(["packages/core/src/index.ts"]);
  });

  it("package grain: keeps a row when ANY touched file sits under it", () => {
    const result = filterTouched(
      [PACKAGE_ROW],
      ["src/main/kotlin/io/placeholder/core/Store.kt", "src/main/kotlin/io/placeholder/app/Program.kt"],
      "package",
      null,
    );
    expect(result.rows.map((row): string => row.name)).toEqual(["io/placeholder/core"]);
    expect(result.matched).toEqual(["src/main/kotlin/io/placeholder/core/Store.kt"]);
    expect(result.unmatched).toEqual(["src/main/kotlin/io/placeholder/app/Program.kt"]);
  });

  it("a row nothing touched is dropped, not kept at zero touched files", () => {
    const result = filterTouched([FILE_ROW, OTHER_FILE_ROW], ["packages/core/src/index.ts"], "file", null);
    expect(result.rows).toHaveLength(1);
  });

  it("no threshold: a kept row carries no 'met' key at all", () => {
    const result = filterTouched([FILE_ROW], ["packages/core/src/index.ts"], "file", null);
    expect(Object.keys(result.rows[0] ?? {})).not.toContain("met");
  });

  it("a threshold attaches 'met' PER ROW, against that row's own counts", () => {
    // FILE_ROW is 11/13 (84.62%, met at 80); OTHER_FILE_ROW is 3/4 (75%, not).
    const result = filterTouched(
      [FILE_ROW, OTHER_FILE_ROW],
      ["packages/core/src/index.ts", "packages/app/src/main.ts"],
      "file",
      80,
    );
    const byName = new Map(result.rows.map((row): [string, boolean | null | undefined] => [row.name, row.met]));
    expect(byName.get("packages/core/src/index.ts")).toBe(true);
    expect(byName.get("packages/app/src/main.ts")).toBe(false);
  });

  it("'met' compares the COUNTS, not the rounded percentage -- same rule as the aggregate", () => {
    // 19999/25000 is 79.996%, which rounds to the 80.00% a table would print;
    // a comparison against the rounded number would report 'met: true' for a
    // row under the bar, in the one direction this flag must never be wrong.
    const row = target("a.ts", counts(19999, 25000), null);
    const result = filterTouched([row], ["a.ts"], "file", 80);
    expect(result.rows[0]?.met).toBe(false);
  });

  it("'met' is null when there is no ratio to compare (0 of 0)", () => {
    const row = target("a.ts", counts(0, 0), null);
    const result = filterTouched([row], ["a.ts"], "file", 80);
    expect(result.rows[0]?.met).toBeNull();
  });

  it("matched/unmatched partition the WHOLE touched list, in git's own order", () => {
    const result = filterTouched(
      [FILE_ROW],
      ["z.ts", "packages/core/src/index.ts", "a.ts"],
      "file",
      null,
    );
    expect([...result.matched, ...result.unmatched].length).toBe(3);
    expect(result.matched).toEqual(["packages/core/src/index.ts"]);
    expect(result.unmatched).toEqual(["z.ts", "a.ts"]);
  });

  it("no touched files at all: every row dropped, nothing matched or unmatched", () => {
    const result = filterTouched([FILE_ROW, OTHER_FILE_ROW], [], "file", null);
    expect(result.rows).toEqual([]);
    expect(result.matched).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });

  it("no rows at all (nothing was parsed): every touched file is unmatched", () => {
    const result = filterTouched([], ["a.ts", "b.ts"], "file", null);
    expect(result.rows).toEqual([]);
    expect(result.matched).toEqual([]);
    expect(result.unmatched).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps the row's own branches beside 'met' -- 'met' is appended, not substituted", () => {
    const result = filterTouched([FILE_ROW], ["packages/core/src/index.ts"], "file", 80);
    expect(Object.keys(result.rows[0] ?? {})).toEqual(["name", "lines", "branches", "met"]);
    expect(result.rows[0]?.branches).toEqual({ covered: 3, total: 4, percent: 75 });
  });
});
