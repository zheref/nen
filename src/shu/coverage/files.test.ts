// src/shu/coverage/files.test.ts -- a Cobertura report's per-file view,
// resolved against a tree and made into FILE rows (zheref/nen#296). Strings,
// the committed coverlet-shaped fixture, and an injected `exists`: no
// filesystem beyond reading the fixture.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { coverageReport } from "../fixtures/paths.js";
import { COBERTURA } from "./formats/cobertura.js";
import { joinSourceFiles, type FileJoinContext } from "./files.js";
import { bandRows } from "./ladder.js";
import { assembleCoverage, renderCoverage } from "./report.js";
import {
  measureLines,
  unionLine,
  unionLines,
  type LineFact,
  type SourceFiles,
} from "./shape.js";
import { filterTouchedGroups } from "./touched.js";

const REPO = "C:/work/Placeholder Repo";

/** A `locate` over a fixed set of files, answering with each one's own spelling. */
function present(...files: string[]): (path: string) => string | null {
  return (path: string): string | null => (files.includes(path) ? path : null);
}

/** Every file the fixture names that is really in the (Windows) tree. */
const IN_TREE: ReadonlySet<string> = new Set([
  "PlaceholderCore/Models/Order.cs",
  "PlaceholderCore/Models/OrderStatusMetadata.cs",
  "PlaceholderCore/View Models/OrderViewModel.cs",
  "PlaceholderCore/Services/Clock.cs",
  "PlaceholderCore/Legacy/Old.cs",
  "PlaceholderApp/App.xaml.cs",
]);

function perFileView(): SourceFiles {
  const parsed = COBERTURA.parse(readFileSync(coverageReport("per-file.cobertura.xml"), "utf8"), "x");
  if (parsed.files === undefined) throw new Error("the fixture states filenames; the view must be present");
  return parsed.files;
}

function context(overrides: Partial<FileJoinContext> = {}): FileJoinContext {
  return {
    repoRoots: [REPO],
    artifactPath: "TestResults/core.cobertura.xml",
    format: "cobertura",
    laneCwd: "",
    locate: (path: string): string | null => (IN_TREE.has(path) ? path : null),
    probe: (): null => null,
    ...overrides,
  };
}

function lines(entries: readonly (readonly [number, boolean, [number, number]?])[]): Map<number, LineFact> {
  return new Map(
    entries.map(([number, hit, branch]): [number, LineFact] => [
      number,
      { hit, branches: branch === undefined ? null : { covered: branch[0], total: branch[1] } },
    ]),
  );
}

describe("the union rule (one line, several report entries)", () => {
  it("a line is counted once, and covered if ANY entry saw it run", () => {
    expect(unionLine({ hit: false, branches: null }, { hit: true, branches: null }).hit).toBe(true);
    expect(unionLine({ hit: true, branches: null }, { hit: false, branches: null }).hit).toBe(true);
    const into = lines([[16, false]]);
    unionLines(into, lines([[16, true], [17, false]]));
    expect([...into.keys()]).toEqual([16, 17]);
    expect(measureLines("f", into).lines).toEqual({ covered: 1, total: 2, percent: 50 });
  });

  it("branches keep ONE statement per line -- the larger total, then the larger covered -- never a sum", () => {
    const pick = (a: [number, number], b: [number, number]): LineFact["branches"] =>
      unionLine({ hit: true, branches: { covered: a[0], total: a[1] } }, { hit: true, branches: { covered: b[0], total: b[1] } })
        .branches;
    expect(pick([1, 2], [2, 2])).toEqual({ covered: 2, total: 2 });
    expect(pick([2, 2], [1, 4])).toEqual({ covered: 1, total: 4 });
    // Never covered from one entry beside total from another: (2/2) and (1/4)
    // is NOT 2/4, which is a combination no entry reported.
    expect(pick([2, 2], [1, 4])).not.toEqual({ covered: 2, total: 4 });
    expect(unionLine({ hit: true, branches: null }, { hit: true, branches: { covered: 1, total: 2 } }).branches).toEqual({
      covered: 1,
      total: 2,
    });
    expect(unionLine({ hit: true, branches: { covered: 1, total: 2 } }, { hit: true, branches: null }).branches).toEqual({
      covered: 1,
      total: 2,
    });
  });

  it("a file with no condition figure anywhere has no branches key at all", () => {
    expect(Object.keys(measureLines("f", lines([[1, true]])))).toEqual(["name", "lines"]);
  });

  it("a line stating more conditions covered than it has is a refusal, not a clamp", () => {
    expect(() => measureLines("f", lines([[1, true, [3, 2]]]))).toThrow(/f, line 1: states 3 of 2 conditions covered/);
  });

  it("an impossible figure is refused PER LINE -- a sound neighbour's sum cannot hide it (review note)", () => {
    // (5/2) beside (0/4) on the next line adds up to a plausible 5 of 6.
    expect(() => measureLines("f", lines([[1, true, [5, 2]], [2, true, [0, 4]]]))).toThrow(/line 1: states 5 of 2/);
  });

  it("an impossible figure is never OUTVOTED by a fuller one on the same line (review note)", () => {
    // Before the review, (1/4) won the union on its larger total and the
    // damaged (5/2) vanished without a word.
    const into = lines([[7, true, [5, 2]]]);
    unionLines(into, lines([[7, true, [1, 4]]]));
    expect(into.get(7)?.branches).toEqual({ covered: 5, total: 2 });
    expect(() => measureLines("f", into)).toThrow(/line 7: states 5 of 2/);
    const reversed = lines([[7, true, [1, 4]]]);
    unionLines(reversed, lines([[7, true, [5, 2]]]));
    expect(() => measureLines("f", reversed)).toThrow(/line 7: states 5 of 2/);
  });
});

describe("joinSourceFiles: the coverlet fixture, read on the machine that wrote it", () => {
  const joined = joinSourceFiles(perFileView(), context());
  const byName = new Map((joined.group?.rows ?? []).map((row) => [row.name, row] as const));

  it("resolves every in-repo name under the report's own <source> root, backslashes and spaces included", () => {
    expect([...byName.keys()]).toEqual([
      "PlaceholderApp/App.xaml.cs",
      "PlaceholderCore/Models/Order.cs",
      "PlaceholderCore/Models/OrderStatusMetadata.cs",
      "PlaceholderCore/Services/Clock.cs",
      "PlaceholderCore/View Models/OrderViewModel.cs",
    ]);
    expect(joined.group?.grain).toBe("file");
    expect(joined.artifact).toEqual({
      path: "TestResults/core.cobertura.xml",
      format: "cobertura",
      root: ".",
      basis: "source",
      rows: 6,
      onDisk: 5,
      error: null,
      unresolved: [
        {
          name: "D:/agent/_work/1/s/PlaceholderCore/Legacy/Old.cs",
          reason: "is an absolute path outside this repository",
        },
      ],
    });
  });

  it("aggregates a file's several <class> entries as the UNION of their lines -- 7 of 10, not 8 of 13", () => {
    const order = byName.get("PlaceholderCore/Models/Order.cs");
    expect(order?.lines).toEqual({ covered: 7, total: 10, percent: 70 });
    // Line 14 is (1/2) in one entry and (2/2) in the other: the fuller one.
    expect(order?.branches).toEqual({ covered: 3, total: 4, percent: 75 });
  });

  it("the path with a SPACE in a directory is a row of its own", () => {
    expect(byName.get("PlaceholderCore/View Models/OrderViewModel.cs")?.lines).toEqual({
      covered: 4,
      total: 5,
      percent: 80,
    });
  });

  it("another machine's absolute filename resolves to nothing: UNRESOLVED, and never a row", () => {
    expect(joined.artifact.unresolved?.map((entry) => entry.name)).toEqual([
      "D:/agent/_work/1/s/PlaceholderCore/Legacy/Old.cs",
    ]);
    expect(byName.has("PlaceholderCore/Legacy/Old.cs")).toBe(false);
  });
});

describe("#296 acceptance: two touched files in one package, banded separately", () => {
  const joined = joinSourceFiles(perFileView(), context());
  const touched = [
    "PlaceholderCore/Models/Order.cs",
    "PlaceholderCore/Models/OrderStatusMetadata.cs",
    "PlaceholderCore/View Models/OrderViewModel.cs",
    "PlaceholderCore/Legacy/Old.cs",
    "PlaceholderCore.Tests/OrderTests.cs",
  ];
  const filter = filterTouchedGroups(joined.group === null ? [] : [joined.group], touched, null);
  const banded = bandRows(filter.rows, { minimum: 80, recommended: 85, ideal: 90 });
  const byName = new Map(banded.map((row) => [row.name, row] as const));

  it("names every matched touched file separately, each with its OWN figure", () => {
    expect(banded.map((row) => row.name)).toEqual([
      "PlaceholderCore/Models/Order.cs",
      "PlaceholderCore/Models/OrderStatusMetadata.cs",
      "PlaceholderCore/View Models/OrderViewModel.cs",
    ]);
    expect(byName.get("PlaceholderCore/Models/Order.cs")?.lines.percent).toBe(70);
    expect(byName.get("PlaceholderCore/Models/OrderStatusMetadata.cs")?.lines.percent).toBe(100);
  });

  it("the per-file bands DIFFER, and neither is the package's 19 of 27 (70.37%)", () => {
    expect(byName.get("PlaceholderCore/Models/Order.cs")?.band).toBe("under-minimum");
    expect(byName.get("PlaceholderCore/Models/OrderStatusMetadata.cs")?.band).toBe("ideal");
    expect(byName.get("PlaceholderCore/View Models/OrderViewModel.cs")?.band).toBe("minimum");
    for (const row of banded) {
      expect(row.name).not.toBe("PlaceholderCore");
      expect(row.lines).not.toEqual({ covered: 19, total: 27, percent: 70.37 });
    }
  });

  it("the test file and the unresolvable file stay explicitly unmatched -- never credited to the package", () => {
    expect(filter.matched).toEqual(touched.slice(0, 3));
    expect(filter.unmatched).toEqual(["PlaceholderCore/Legacy/Old.cs", "PlaceholderCore.Tests/OrderTests.cs"]);
  });

  it("the from: line names the dominant root and the unresolved count", () => {
    const text = renderCoverage(
      assembleCoverage({
        lane: "core",
        stack: "dotnet-winui",
        total: null,
        targets: banded,
        threshold: null,
        report: { format: "cobertura", path: "TestResults/core.cobertura.xml" },
        exitCode: 0,
        touched: { base: "main", files: touched, matched: filter.matched, unmatched: filter.unmatched, artifacts: [joined.artifact] },
        ladder: null,
      }),
      null,
      "file",
    ).join("\n");
    expect(text).toContain(
      "from: TestResults/core.cobertura.xml (cobertura) -- 6 rows, root . [source], 5 on disk, 1 unresolved (never matched)",
    );
    expect(text).toContain(
      "    unresolved: D:/agent/_work/1/s/PlaceholderCore/Legacy/Old.cs -- is an absolute path outside this repository",
    );
    expect(text).not.toMatch(/BY PACKAGE/);
  });
});

describe("joinSourceFiles: where a name can resolve", () => {
  const view = (roots: readonly string[], names: readonly string[]): SourceFiles => ({
    roots,
    files: names.map((name) => ({ name, lines: lines([[1, true]]), entries: 1 })),
  });

  it("read on ANOTHER machine: the <source> anchors nowhere, and the repo-relative name still resolves", () => {
    const joined = joinSourceFiles(perFileView(), context({ repoRoots: ["/Users/someone/src/placeholder-repo"] }));
    expect(joined.artifact).toMatchObject({ root: ".", basis: "lane-cwd", onDisk: 5 });
    expect(joined.artifact.unresolved?.map((entry) => entry.name)).toEqual([
      "D:/agent/_work/1/s/PlaceholderCore/Legacy/Old.cs",
    ]);
    expect(joined.group?.rows.map((row) => row.name)).toContain("PlaceholderCore/Models/Order.cs");
  });

  it("names written relative to the lane cwd resolve under it", () => {
    const joined = joinSourceFiles(
      view([], ["Models/Order.cs"]),
      context({ laneCwd: "PlaceholderCore", locate: present("PlaceholderCore/Models/Order.cs") }),
    );
    expect(joined.group?.rows.map((row) => row.name)).toEqual(["PlaceholderCore/Models/Order.cs"]);
    expect(joined.artifact).toMatchObject({ root: "PlaceholderCore", basis: "lane-cwd", onDisk: 1 });
  });

  it("several stated roots: each name resolves under the one it exists under (coverage.py's shape)", () => {
    const joined = joinSourceFiles(
      view(["/w/repo/pkg_a", "/w/repo/pkg_b"], ["a.py", "b.py"]),
      context({ repoRoots: ["/w/repo"], locate: present("pkg_a/a.py", "pkg_b/b.py") }),
    );
    expect(joined.group?.rows.map((row) => row.name)).toEqual(["pkg_a/a.py", "pkg_b/b.py"]);
    expect(joined.artifact).toMatchObject({ root: "pkg_a", basis: "source", onDisk: 2, rows: 2 });
  });

  it("two names that resolve to the SAME file are ONE row, their lines unioned", () => {
    const joined = joinSourceFiles(
      {
        roots: ["/w/repo/src", "/w/repo"],
        files: [
          { name: "src/x.cs", lines: lines([[1, true], [2, false]]), entries: 1 },
          { name: "x.cs", lines: lines([[2, true], [3, false]]), entries: 1 },
        ],
      },
      context({ repoRoots: ["/w/repo"], locate: present("src/x.cs") }),
    );
    expect(joined.group?.rows).toEqual([
      { name: "src/x.cs", lines: { covered: 2, total: 3, percent: 66.67 } },
    ]);
    expect(joined.artifact.onDisk).toBe(2);
  });

  it("nothing resolves: no rows, every name unresolved, and the account names where nen looked first", () => {
    const joined = joinSourceFiles(view(["/w/repo/"], ["gone.cs"]), context({ repoRoots: ["/w/repo"], locate: present() }));
    expect(joined.group?.rows).toEqual([]);
    expect(joined.artifact.unresolved).toEqual([
      { name: "gone.cs", reason: "names no file in this tree (looked for 'gone.cs')" },
    ]);
    expect(joined.artifact).toMatchObject({ root: ".", basis: "source", rows: 1, onDisk: 0, error: null });
  });

  it("nothing resolves and no stated root is inside the repo: the first usual candidate", () => {
    const joined = joinSourceFiles(view(["/elsewhere"], ["gone.cs"]), context({ repoRoots: ["/w/repo"], locate: present() }));
    // `TestResults/` proposes no artifact root (no trailing `coverage/`), and
    // a lane at the root folds the repo root into `lane-cwd`.
    expect(joined.artifact).toMatchObject({ root: ".", basis: "lane-cwd", onDisk: 0 });
  });

  it("an impossible condition count is the report's error, with its path -- never the package row", () => {
    const joined = joinSourceFiles(
      { roots: [], files: [{ name: "a.cs", lines: lines([[1, true, [5, 2]]]), entries: 1 }] },
      context({ locate: (path) => path }),
    );
    expect(joined.group).toBeNull();
    expect(joined.artifact.error).toMatch(/^TestResults\/core\.cobertura\.xml: a\.cs, line 1: states 5 of 2 conditions covered/);
    expect(joined.artifact).toMatchObject({ root: null, basis: null, rows: 0, onDisk: null, unresolved: [] });
  });
});

describe("review F1: one name under two stated roots is AMBIGUOUS, never the first root's file", () => {
  // Nobunaga's reproduction, byte for byte in shape: coverage.py writes one
  // <source> per measured package and names each file relative to one of
  // them, so pkgA's utils.py (0 of 2) and pkgB's utils.py (2 of 2) are both
  // `filename="utils.py"`. Taking the first root that holds a `utils.py`
  // reported pkgA's 0% file at 100%.
  const report =
    '<coverage line-rate="0.5" lines-covered="2" lines-valid="4"><sources><source>/w/repo/pkgA</source><source>/w/repo/pkgB</source></sources><packages><package name="."><classes>' +
    '<class name="utils.py" filename="utils.py"><lines><line number="1" hits="0"/><line number="2" hits="0"/></lines></class>' +
    '<class name="utils.py" filename="utils.py"><lines><line number="1" hits="3"/><line number="2" hits="3"/></lines></class>' +
    "</classes></package></packages></coverage>";

  it("both files exist: no row at all, the name unresolved with a reason naming BOTH paths", () => {
    const parsed = COBERTURA.parse(report, "coverage.xml");
    if (parsed.files === undefined) throw new Error("the report names files");
    const joined = joinSourceFiles(parsed.files, {
      repoRoots: ["/w/repo"],
      artifactPath: "coverage.xml",
      format: "cobertura",
      laneCwd: "",
      locate: present("pkgA/utils.py", "pkgB/utils.py"),
      probe: () => null,
    });
    expect(joined.group?.rows).toEqual([]);
    expect(joined.artifact).toMatchObject({ rows: 1, onDisk: 0, error: null });
    expect(joined.artifact.unresolved).toEqual([
      {
        name: "utils.py",
        reason:
          "is ambiguous: it exists as 'pkgA/utils.py' and 'pkgB/utils.py', under different roots the report states, and nothing in the report says which of them these lines measured",
      },
    ]);
    // And so neither touched file is matched -- the false pass is gone.
    const filter = filterTouchedGroups(joined.group === null ? [] : [joined.group], ["pkgA/utils.py", "pkgB/utils.py"], 80);
    expect(filter.rows).toEqual([]);
    expect(filter.unmatched).toEqual(["pkgA/utils.py", "pkgB/utils.py"]);
  });

  it("only ONE of them exists: the name is not ambiguous, and resolves there", () => {
    const parsed = COBERTURA.parse(report, "coverage.xml");
    if (parsed.files === undefined) throw new Error("the report names files");
    const joined = joinSourceFiles(parsed.files, {
      repoRoots: ["/w/repo"],
      artifactPath: "coverage.xml",
      format: "cobertura",
      laneCwd: "",
      locate: present("pkgB/utils.py"),
      probe: () => null,
    });
    expect(joined.group?.rows.map((row) => row.name)).toEqual(["pkgB/utils.py"]);
    expect(joined.artifact.unresolved).toEqual([]);
  });
});

describe("review F3: rows take the file's ON-DISK spelling, and two spellings of one file are one row", () => {
  // A case-insensitive filesystem: every spelling of Core/Models/A.cs exists,
  // and `locate` answers with the one on disk -- which is what git names.
  const insensitive = (path: string): string | null =>
    path.toLowerCase() === "core/models/a.cs" ? "Core/Models/A.cs" : null;

  it("a report spelling in another letter case becomes the on-disk spelling, matched against git's", () => {
    const joined = joinSourceFiles(
      { roots: [], files: [{ name: "core/models/a.cs", lines: lines([[1, true], [2, false]]), entries: 1 }] },
      context({ locate: insensitive }),
    );
    expect(joined.group?.rows.map((row) => row.name)).toEqual(["Core/Models/A.cs"]);
    const filter = filterTouchedGroups(joined.group === null ? [] : [joined.group], ["Core/Models/A.cs"], null);
    expect(filter.matched).toEqual(["Core/Models/A.cs"]);
  });

  it("two spellings of ONE file merge into one row, their lines unioned", () => {
    const joined = joinSourceFiles(
      {
        roots: [],
        files: [
          { name: "Core/Models/A.cs", lines: lines([[1, true], [2, false]]), entries: 1 },
          { name: "core/models/a.cs", lines: lines([[2, true], [3, false]]), entries: 1 },
        ],
      },
      context({ locate: insensitive }),
    );
    expect(joined.group?.rows).toEqual([
      { name: "Core/Models/A.cs", lines: { covered: 2, total: 3, percent: 66.67 } },
    ]);
    expect(joined.artifact).toMatchObject({ rows: 2, onDisk: 2, unresolved: [] });
  });
});

describe("source-link URLs", () => {
  it("a URL filename is unresolved with its own reason -- never joined as a path", () => {
    const joined = joinSourceFiles(
      {
        roots: [],
        files: [{ name: "https://raw.example.invalid/o/r/abc123/src/A.cs", lines: lines([[1, true]]), entries: 1 }],
      },
      context({ locate: (path) => path }),
    );
    expect(joined.group?.rows).toEqual([]);
    expect(joined.artifact.unresolved?.[0]?.reason).toBe(
      "is a URL, not a path -- a report that writes source-link URLs names no file in any working tree",
    );
  });
});

describe("review round 3 (N1): probeF1b -- a stated root OUTSIDE the repository that holds the same name", () => {
  // Nobunaga's shape: <source> 1 is the repo's pkgA, <source> 2 a directory
  // OUTSIDE the repository with a real utils.py in it (coverage.py's
  // site-packages for a non-editable install). utils.py is listed twice --
  // 0 of 2, then 2 of 2 -- and the parser has already unioned the two.
  const report =
    '<coverage line-rate="0.5" lines-covered="4" lines-valid="6"><sources><source>/w/repo/pkgA</source><source>/venv/site-packages</source></sources><packages><package name="."><classes>' +
    '<class name="utils.py" filename="utils.py"><lines><line number="1" hits="0"/><line number="2" hits="0"/></lines></class>' +
    '<class name="utils.py" filename="utils.py"><lines><line number="1" hits="3"/><line number="2" hits="3"/></lines></class>' +
    '<class name="other.py" filename="other.py"><lines><line number="1" hits="1"/><line number="2" hits="1"/></lines></class>' +
    "</classes></package></packages></coverage>";
  const parsed = COBERTURA.parse(report, "coverage.xml");
  const sitePackages = (absolute: string): { kind: "file" | "directory"; real: string } | null =>
    absolute === "/venv/site-packages"
      ? { kind: "directory", real: absolute }
      : absolute === "/venv/site-packages/utils.py"
        ? { kind: "file", real: absolute }
        : null;

  it("the parser counts the entries each name was merged from", () => {
    expect(parsed.files?.files.map((file) => [file.name, file.entries])).toEqual([
      ["other.py", 1],
      ["utils.py", 2],
    ]);
  });

  it("utils.py is AMBIGUOUS -- never pkgA's 0% file at the union's 100%", () => {
    if (parsed.files === undefined) throw new Error("the report names files");
    const joined = joinSourceFiles(parsed.files, {
      repoRoots: ["/w/repo"],
      artifactPath: "coverage.xml",
      format: "cobertura",
      laneCwd: "",
      locate: present("pkgA/utils.py", "pkgA/other.py"),
      probe: sitePackages,
    });
    expect(joined.group?.rows.map((row) => row.name)).toEqual(["pkgA/other.py"]);
    expect(joined.artifact).toMatchObject({ rows: 2, onDisk: 1 });
    expect(joined.artifact.unresolved).toEqual([
      {
        name: "utils.py",
        reason:
          "is ambiguous: it exists as 'pkgA/utils.py' and '/venv/site-packages/utils.py', under different roots the report states, and nothing in the report says which of them these lines measured",
      },
    ]);
  });

  it("the outside root cannot be checked on this machine: utils.py (2 entries, 2 roots) is UNVERIFIABLE; other.py (1 entry) resolves", () => {
    if (parsed.files === undefined) throw new Error("the report names files");
    const joined = joinSourceFiles(parsed.files, {
      repoRoots: ["/w/repo"],
      artifactPath: "coverage.xml",
      format: "cobertura",
      laneCwd: "",
      locate: present("pkgA/utils.py", "pkgA/other.py"),
      probe: () => null,
    });
    expect(joined.group?.rows.map((row) => row.name)).toEqual(["pkgA/other.py"]);
    expect(joined.artifact.unresolved?.[0]?.reason).toMatch(
      /^cannot be verified: the report names it in 2 entries and states 2 roots, and '\/venv\/site-packages' is not a directory on this machine/,
    );
  });
});

describe("review round 3 (NIT): a view that cannot be measured still lists what it could not place", () => {
  it("the error artifact carries `unresolved` -- the names refused before the measurement did", () => {
    const joined = joinSourceFiles(
      {
        roots: [],
        files: [
          { name: "a.cs", lines: lines([[1, true, [5, 2]]]), entries: 1 },
          { name: "https://raw.example.invalid/o/r/abc/b.cs", lines: lines([[1, true]]), entries: 1 },
        ],
      },
      context({ locate: (path) => path }),
    );
    expect(joined.group).toBeNull();
    expect(joined.artifact.error).toMatch(/states 5 of 2 conditions covered/);
    expect(joined.artifact.unresolved?.map((entry) => entry.name)).toEqual(["https://raw.example.invalid/o/r/abc/b.cs"]);
  });
});
