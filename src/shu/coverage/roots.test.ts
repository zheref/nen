// src/shu/coverage/roots.test.ts -- the root a report's row names are resolved
// against (zheref/nen#236), on strings and an injected `exists`. No filesystem.

import { describe, expect, it } from "vitest";
import { counts, target, type CoverageTarget } from "./shape.js";
import {
  anchorUnder,
  anchorUnderAny,
  isAbsoluteName,
  joinUnder,
  nameCandidates,
  rebaseRows,
  resolveFileName,
  resolveRoot,
  rootCandidates,
  type NameContext,
  type PathProbe,
  type RootCandidate,
} from "./roots.js";
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

describe("anchorUnder (zheref/nen#296)", () => {
  it("makes an absolute path inside the repository repo-relative, on both separators", () => {
    expect(anchorUnder("/w/repo", "/w/repo/src/a.cs")).toBe("src/a.cs");
    expect(anchorUnder("C:\\work\\My Repo", "C:\\work\\My Repo\\Core\\A.cs")).toBe("Core/A.cs");
    expect(anchorUnder("C:/work/My Repo", "C:\\work\\My Repo\\View Models\\B.cs")).toBe("View Models/B.cs");
  });

  it("the repository root itself is '', with or without a trailing separator", () => {
    expect(anchorUnder("/w/repo", "/w/repo")).toBe("");
    expect(anchorUnder("/w/repo/", "/w/repo/")).toBe("");
    expect(anchorUnder("C:/work/My Repo", "C:\\work\\My Repo\\")).toBe("");
  });

  it("a Windows-shaped root is compared case-INSENSITIVELY -- drive letter and directories alike (review F2)", () => {
    // `C:\Work\repo` and `c:\work\repo` are one directory on Windows; this was
    // pinned as null before the review, which turned one report into exit 0
    // or exit 6 depending on how a tool happened to capitalise the path.
    expect(anchorUnder("C:/work/repo", "c:\\work\\repo\\a.cs")).toBe("a.cs");
    expect(anchorUnder("C:/work/repo", "C:\\Work\\REPO\\Src\\a.cs")).toBe("Src/a.cs");
    expect(anchorUnder("\\\\server\\share\\repo", "\\\\SERVER\\Share\\repo\\a.cs")).toBe("a.cs");
    // The remainder keeps the REPORT's spelling: the on-disk spelling is
    // `locate`'s answer, not this function's.
    expect(anchorUnder("c:/work/repo", "C:\\WORK\\repo\\Core\\A.cs")).toBe("Core/A.cs");
  });

  it("a POSIX root is compared exactly", () => {
    expect(anchorUnder("/w/repo", "/W/Repo/a.cs")).toBeNull();
  });

  it("outside the repository -- a sibling with a shared prefix, another drive, a climb back out -- is null", () => {
    expect(anchorUnder("/w/repo", "/w/repo-2/a.cs")).toBeNull();
    expect(anchorUnder("C:/work/repo", "C:\\work\\repo-2\\a.cs")).toBeNull();
    expect(anchorUnder("C:/work/repo", "D:\\agent\\_work\\1\\s\\a.cs")).toBeNull();
    expect(anchorUnder("/w/repo", "/w/repo/../elsewhere/a.cs")).toBeNull();
    expect(anchorUnder("", "/w/repo/a.cs")).toBeNull();
  });

  it("anchorUnderAny tries every spelling of the root -- a symlinked checkout is anchored through its real path (review F2)", () => {
    const spellings = ["/tmp/checkout", "/private/tmp/checkout"];
    expect(anchorUnderAny(spellings, "/private/tmp/checkout/src/a.cs")).toBe("src/a.cs");
    expect(anchorUnderAny(spellings, "/tmp/checkout/src/a.cs")).toBe("src/a.cs");
    expect(anchorUnderAny(spellings, "/elsewhere/src/a.cs")).toBeNull();
    // With only the spelling nen was handed, the tool's real path is outside.
    expect(anchorUnderAny(["/tmp/checkout"], "/private/tmp/checkout/src/a.cs")).toBeNull();
  });
});

describe("nameCandidates / resolveFileName (zheref/nen#296)", () => {
  const usual = rootCandidates("TestResults/coverage/core.cobertura.xml", "Core");
  const on = (...present: string[]) => (path: string): string | null => (present.includes(path) ? path : null);

  it("groups the report's stated roots FIRST, each in its own group, then artifact / lane cwd / repo root", () => {
    expect(nameCandidates("Models/A.cs", ["/w/repo/Core/", "/elsewhere"], ["/w/repo"], usual)).toEqual({
      stated: [[{ path: "Core/Models/A.cs", root: "Core", basis: "source" }], []],
      usual: [
        { path: "TestResults/Models/A.cs", root: "TestResults", basis: "artifact" },
        { path: "Models/A.cs", root: "", basis: "repo-root" },
      ],
    });
  });

  it("a RELATIVE stated root is tried under each usual candidate, since the report does not say what it is relative to", () => {
    const offered = nameCandidates("a.py", ["src"], ["/w/repo"], rootCandidates("coverage.xml", ""));
    expect(offered.stated.map((group) => group.map((entry) => entry.path))).toEqual([["src/a.py"]]);
    expect(offered.usual.map((entry) => entry.path)).toEqual(["a.py"]);
  });

  it("an absolute name is its own one candidate -- or none when it lies outside the repository", () => {
    expect(nameCandidates("/w/repo/src/a.cs", ["/w/repo"], ["/w/repo"], usual)).toEqual({
      stated: [],
      usual: [{ path: "src/a.cs", root: "", basis: "repo-root" }],
    });
    expect(nameCandidates("D:/agent/_work/a.cs", ["/w/repo"], ["/w/repo"], usual)).toEqual({ stated: [], usual: [] });
  });

  it("a name whose join climbs out of the repository is never a candidate", () => {
    expect(nameCandidates("../../outside.cs", [], ["/w/repo"], rootCandidates("coverage.xml", ""))).toEqual({
      stated: [],
      usual: [],
    });
  });

  /** No absolute path outside the repository exists on this "machine". */
  const nothingOutside: PathProbe = () => null;
  const ctx = (
    statedRoots: readonly string[],
    locate: (path: string) => string | null,
    options: { readonly candidates?: readonly RootCandidate[]; readonly probe?: PathProbe } = {},
  ): NameContext => ({
    statedRoots,
    repoRoots: ["/w/repo"],
    candidates: options.candidates ?? usual,
    locate,
    probe: options.probe ?? nothingOutside,
  });
  const atRoot = rootCandidates("coverage.xml", "");

  it("ONE stated root holding the file resolves it, under the spelling `locate` answers with", () => {
    const resolution = resolveFileName(
      "models/a.cs",
      1,
      ctx(["/w/repo/Core"], (path) => (path === "Core/models/a.cs" ? "Core/Models/A.cs" : null)),
    );
    expect(resolution).toEqual({ kind: "resolved", candidate: { path: "Core/Models/A.cs", root: "Core", basis: "source" } });
  });

  it("TWO stated roots holding two files: AMBIGUOUS, unresolved, naming both (review F1)", () => {
    const resolution = resolveFileName(
      "utils.py",
      2,
      ctx(["/w/repo/pkgA", "/w/repo/pkgB"], on("pkgA/utils.py", "pkgB/utils.py"), { candidates: atRoot }),
    );
    expect(resolution.kind).toBe("unresolved");
    if (resolution.kind !== "unresolved") return;
    expect(resolution.reason).toContain("is ambiguous: it exists as 'pkgA/utils.py' and 'pkgB/utils.py'");
  });

  it("two stated roots that reach ONE file on disk are one answer, not an ambiguity", () => {
    const resolution = resolveFileName(
      "utils.py",
      2,
      ctx(["/w/repo/pkgA", "/w/repo/PKGA"], (path) => (path.toLowerCase() === "pkga/utils.py" ? "pkgA/utils.py" : null), {
        candidates: atRoot,
      }),
    );
    expect(resolution).toMatchObject({ kind: "resolved", candidate: { path: "pkgA/utils.py", basis: "source" } });
  });

  it("the usual candidates are tried only when no stated root has the file, in order", () => {
    expect(resolveFileName("Models/A.cs", 1, ctx(["/w/repo/Core"], on("Models/A.cs")))).toEqual({
      kind: "resolved",
      candidate: { path: "Models/A.cs", root: "", basis: "repo-root" },
    });
  });

  it("nothing on disk: unresolved, naming where nen looked", () => {
    const resolution = resolveFileName("Models/B.cs", 1, ctx(["/w/repo/Core"], on()));
    expect(resolution).toEqual({
      kind: "unresolved",
      reason:
        "names no file in this tree (looked for 'Core/Models/B.cs', 'TestResults/Models/B.cs', 'Models/B.cs')",
    });
  });

  it("a URL and an outside absolute path are unresolved with their own reasons", () => {
    expect(
      resolveFileName("https://raw.example.invalid/o/r/abc123/src/A.cs", 1, ctx([], on("src/A.cs"))),
    ).toMatchObject({ kind: "unresolved", reason: expect.stringContaining("is a URL, not a path") });
    expect(resolveFileName("D:/agent/_work/1/s/A.cs", 1, ctx([], on()))).toEqual({
      kind: "unresolved",
      reason: "is an absolute path outside this repository",
    });
  });
});

describe("review round 3 (N1): a stated root OUTSIDE the repository is a possible holder, never absent", () => {
  const atRoot = rootCandidates("coverage.xml", "");
  const on = (...present: string[]) => (path: string): string | null => (present.includes(path) ? path : null);
  // This "machine" has a site-packages directory outside the repository, with
  // a utils.py in it -- what coverage.py states for a non-editable install.
  const sitePackages: PathProbe = (absolute) =>
    absolute === "/venv/site-packages"
      ? { kind: "directory", real: "/venv/site-packages" }
      : absolute === "/venv/site-packages/utils.py"
        ? { kind: "file", real: "/venv/site-packages/utils.py" }
        : null;
  const ctx = (
    statedRoots: readonly string[],
    locate: (path: string) => string | null,
    probe: PathProbe,
  ): NameContext => ({ statedRoots, repoRoots: ["/w/repo"], candidates: atRoot, locate, probe });

  it("probeF1b: an in-repo root and an outside root BOTH holding the name -- ambiguous, naming the outside path", () => {
    const resolution = resolveFileName(
      "utils.py",
      2,
      ctx(["/w/repo/pkgA", "/venv/site-packages"], on("pkgA/utils.py"), sitePackages),
    );
    expect(resolution).toEqual({
      kind: "unresolved",
      reason:
        "is ambiguous: it exists as 'pkgA/utils.py' and '/venv/site-packages/utils.py', under different roots the report states, and nothing in the report says which of them these lines measured",
    });
  });

  it("the file exists ONLY under the outside root: unresolved, never credited to a same-named file inside", () => {
    const resolution = resolveFileName("utils.py", 1, ctx(["/w/repo/pkgA", "/venv/site-packages"], on("utils.py"), sitePackages));
    expect(resolution).toEqual({
      kind: "unresolved",
      reason:
        "exists only outside this repository, at '/venv/site-packages/utils.py' -- the file these lines measured is not one this repository holds",
    });
  });

  it("an outside root that does NOT hold the name is checked and silent: the inside root's file resolves", () => {
    expect(
      resolveFileName("other.py", 2, ctx(["/w/repo/pkgA", "/venv/site-packages"], on("pkgA/other.py"), sitePackages)),
    ).toMatchObject({ kind: "resolved", candidate: { path: "pkgA/other.py", basis: "source" } });
  });

  it("an outside SPELLING of a root that is really inside (a symlink) is an inside answer, not a second file", () => {
    const linked: PathProbe = (absolute) =>
      absolute === "/links/pkgA" ? { kind: "directory", real: "/w/repo/pkgA" } : null;
    expect(
      resolveFileName("utils.py", 2, ctx(["/w/repo/pkgA", "/links/pkgA"], on("pkgA/utils.py"), linked)),
    ).toMatchObject({ kind: "resolved", candidate: { path: "pkgA/utils.py" } });
  });

  it("UNVERIFIABLE: a root that cannot be checked here, 2+ roots, and a name merged from 2+ entries", () => {
    const resolution = resolveFileName(
      "utils.py",
      2,
      ctx(["/w/repo/pkgA", "/home/runner/work/x/pkgB"], on("pkgA/utils.py"), () => null),
    );
    expect(resolution).toEqual({
      kind: "unresolved",
      reason:
        "cannot be verified: the report names it in 2 entries and states 2 roots, and '/home/runner/work/x/pkgB' is not a directory on this machine, so nen cannot tell whether those entries measured one file or several",
    });
  });

  it("probeF1c: BOTH roots foreign -- the multi-entry name is unverifiable, never the fallback's same-named file", () => {
    const resolution = resolveFileName(
      "utils.py",
      2,
      ctx(["/home/runner/work/x/pkgA", "/home/runner/work/x/pkgB"], on("utils.py"), () => null),
    );
    expect(resolution.kind).toBe("unresolved");
    if (resolution.kind !== "unresolved") return;
    expect(resolution.reason).toMatch(/^cannot be verified: the report names it in 2 entries and states 2 roots/);
  });

  it("still resolves: a ONE-entry name beside a foreign root, and a ONE-root report whatever its entries (coverlet CI)", () => {
    expect(
      resolveFileName("utils.py", 1, ctx(["/w/repo/pkgA", "/home/runner/work/x/pkgB"], on("pkgA/utils.py"), () => null)),
    ).toMatchObject({ kind: "resolved", candidate: { path: "pkgA/utils.py" } });
    // A coverlet report written on a CI runner: one drive-root <source>, a C#
    // file as several <class> entries -- all under that one root, so the
    // fallback candidates still place it.
    expect(
      resolveFileName("Core/Order.cs", 3, ctx(["D:\\a\\repo\\repo\\"], on("Core/Order.cs"), () => null)),
    ).toMatchObject({ kind: "resolved", candidate: { path: "Core/Order.cs", basis: "lane-cwd" } });
  });

});
