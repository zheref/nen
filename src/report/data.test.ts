// src/report/data.test.ts -- `nen report data`, driven through the real
// ../index.ts `runFamily` so the exit codes are the binary's own.
//
// NO LIVE GIT. Every subprocess is a ScriptedSeams entry, which THROWS on a call
// nobody scripted -- so "this verb reads and never writes" is proved by the
// fixture rather than asserted in a comment: a `git commit` or a `git checkout`
// growing into this module would be an unscripted call and a red test, and the
// recorded call list below is checked against the four reads this verb is
// allowed to make.
//
// THE COVERAGE HALF RUNS AGAINST A COMMITTED FIXTURE, ../schema/fixtures/
// shu-coverage-repo, which is `nen shu coverage`'s own: five lanes, one per
// answer -- a report that parses, a lane declaring no artifact, an artifact that
// is not a report, a declared report that is not on disk. Reusing it rather than
// building a second one is deliberate; the two verbs must not disagree about
// what an lcov file says, and they cannot, because they share the parser.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { matchesPattern, parseTiers, tierOf, type TierTable } from "./data.js";
import { reportCommand } from "./command.js";

const FIELD = "\u001f";
const LOG_FORMAT = `%H${FIELD}%s${FIELD}%an${FIELD}%aI`;
const NOW = new Date("2026-09-09T12:34:56.000Z");

const COVERAGE_REPO = join(process.cwd(), "src", "schema", "fixtures", "shu-coverage-repo");

/** The four reads this verb makes, all answered. */
function script(options: { base?: string; branch?: string | null; log?: string; diff?: string } = {}): ScriptedCall[] {
  const base = options.base ?? "main";
  const branch = options.branch === undefined ? "feat/report" : options.branch;
  return [
    { match: `git rev-parse --verify --quiet ${base}^{commit}`, result: { code: 0, stdout: "0123456789abcdef\n" } },
    {
      match: "git symbolic-ref --short HEAD",
      result: branch === null ? { code: 128, stderr: "fatal: ref HEAD is not a symbolic ref\n" } : { code: 0, stdout: `${branch}\n` },
    },
    { match: `git log ${base}..HEAD --format=${LOG_FORMAT}`, result: { code: 0, stdout: options.log ?? "" } },
    { match: `git diff --name-status ${base}...HEAD`, result: { code: 0, stdout: options.diff ?? "" } },
  ];
}

interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly seams: ScriptedSeams;
}

async function capture(argv: readonly string[], calls: readonly ScriptedCall[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const seams = new ScriptedSeams(calls, { now: (): Date => NOW, platform: "linux" });
  const code = await runFamily(reportCommand, argv, null, false, io, seams);
  return { code, out, err, seams };
}

function documentFrom(captured: Captured): Record<string, unknown> {
  return JSON.parse(captured.out.join("\n")) as Record<string, unknown>;
}

const LOG = [
  `aaaaaaaaaaaaaaaaaaaaaaaa${FIELD}feat(report): add the report family${FIELD}Sergio${FIELD}2026-09-09T09:00:00+02:00`,
  `bbbbbbbbbbbbbbbbbbbbbbbb${FIELD}docs(usage): a\tsubject with a tab${FIELD}Sergio${FIELD}2026-09-08T18:00:00+02:00`,
].join("\n");

const DIFF = ["M\tsrc/report/data.ts", "A\tsrc/report/data.test.ts", "R096\tdocs/OLD.md\tdocs/NEW.md", "D\tsrc/gone.ts"].join("\n");

describe("nen report data", () => {
  it("assembles one document in the contract's key order", async () => {
    const captured = await capture(
      ["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--json"],
      script({ log: LOG, diff: DIFF }),
    );
    expect(captured.code).toBe(0);
    const document = documentFrom(captured);
    expect(Object.keys(document)).toEqual([
      "contract",
      "repo",
      "branch",
      "base",
      "generatedAt",
      "commits",
      "files",
      "evidence",
      "coverage",
      "proof",
      "lastStop",
    ]);
    expect(document["contract"]).toBe("nen.report.data/v0.1");
    expect(document["branch"]).toBe("feat/report");
    expect(document["base"]).toBe("main");
    expect(document["generatedAt"]).toBe("2026-09-09T12:34:56.000Z");
  });

  it("carries the repository's NAME, never its absolute path", async () => {
    const captured = await capture(
      ["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--json"],
      script(),
    );
    expect(documentFrom(captured)["repo"]).toBe("shu-coverage-repo");
    expect(captured.out.join("\n")).not.toContain(COVERAGE_REPO);
  });

  it("splits a commit on the unit separator, so a subject with a TAB in it stays one field", async () => {
    const captured = await capture(
      ["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--json"],
      script({ log: LOG }),
    );
    const commits = documentFrom(captured)["commits"] as { subject: string; author: string; date: string }[];
    expect(commits).toHaveLength(2);
    expect(commits[1]?.subject).toBe("docs(usage): a\tsubject with a tab");
    expect(commits[1]?.author).toBe("Sergio");
    expect(commits[1]?.date).toBe("2026-09-08T18:00:00+02:00");
  });

  it("reports a rename's DESTINATION path and git's own status token", async () => {
    const captured = await capture(
      ["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--json"],
      script({ diff: DIFF }),
    );
    const files = documentFrom(captured)["files"] as { path: string; status: string; tier: string | null }[];
    expect(files.map((file): string => `${file.status} ${file.path}`)).toEqual([
      "M src/report/data.ts",
      "A src/report/data.test.ts",
      "R096 docs/NEW.md",
      "D src/gone.ts",
    ]);
    expect(files.every((file): boolean => file.tier === null)).toBe(true);
  });

  it("makes exactly four git reads, and no write of any kind", async () => {
    const captured = await capture(["report", "data", "--repo", COVERAGE_REPO, "--base", "main"], script());
    expect(captured.seams.calls.map((call): string => call.args[0] as string)).toEqual([
      "rev-parse",
      "symbolic-ref",
      "log",
      "diff",
    ]);
    expect(captured.seams.calls.every((call): boolean => call.cwd === COVERAGE_REPO)).toBe(true);
  });

  it("reports a detached HEAD as a null branch rather than refusing", async () => {
    const captured = await capture(
      ["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--json"],
      script({ branch: null }),
    );
    expect(captured.code).toBe(0);
    expect(documentFrom(captured)["branch"]).toBeNull();
  });

  it("uses the three-dot diff and the two-dot log -- the merge-base file set a PR shows", async () => {
    const captured = await capture(["report", "data", "--repo", COVERAGE_REPO, "--base", "origin/main"], script({ base: "origin/main" }));
    const joined = captured.seams.calls.map((call): string => call.args.join(" "));
    expect(joined).toContain(`log origin/main..HEAD --format=${LOG_FORMAT}`);
    expect(joined).toContain("diff --name-status origin/main...HEAD");
  });
});

describe("nen report data refuses rather than reporting an empty answer", () => {
  it("refuses an unresolvable --base at exit 2, naming the ref, before reading anything", async () => {
    const captured = await capture(["report", "data", "--repo", COVERAGE_REPO, "--base", "nope"], [
      { match: "git rev-parse --verify --quiet nope^{commit}", result: { code: 1, stdout: "" } },
    ]);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--base 'nope' does not resolve to a commit/);
    expect(captured.seams.calls).toHaveLength(1);
  });

  it("refuses a failed 'git log' rather than reporting a branch with nothing on it", async () => {
    const captured = await capture(["report", "data", "--repo", COVERAGE_REPO, "--base", "main"], [
      ...script().slice(0, 2),
      { match: `git log main..HEAD --format=${LOG_FORMAT}`, result: { code: 128, stderr: "fatal: bad object\n" } },
    ]);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/Refusing to report an empty commit list/);
  });

  it("refuses a failed 'git diff' rather than reporting a branch that changed nothing", async () => {
    const captured = await capture(["report", "data", "--repo", COVERAGE_REPO, "--base", "main"], [
      ...script().slice(0, 3),
      { match: "git diff --name-status main...HEAD", result: { code: 128, stderr: "fatal: bad object\n" } },
    ]);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/Refusing to report an empty file list/);
  });

  it("refuses a missing --repo and a missing --base by name", async () => {
    expect((await capture(["report", "data", "--base", "main"], [])).code).toBe(2);
    const noBase = await capture(["report", "data", "--repo", COVERAGE_REPO], []);
    expect(noBase.code).toBe(2);
    expect(noBase.err.join("\n")).toMatch(/--base is required/);
  });

  it("refuses a flag the OTHER verb reads, rather than ignoring it", async () => {
    const captured = await capture(["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--out", "x.html"], []);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--out is not read by 'report data'/);
  });

  it("refuses a subcommand it has not got, naming the two it has", async () => {
    const captured = await capture(["report", "publish"], []);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/unknown 'report' subcommand 'publish'\. Known: data, render\./);
  });
});

describe("the coverage field", () => {
  it("parses the lane's declared report when it is on disk", async () => {
    const captured = await capture(
      ["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--json"],
      script(),
    );
    const coverage = documentFrom(captured)["coverage"] as Record<string, unknown>;
    expect(coverage["lane"]).toBe("web");
    expect(coverage["format"]).toBe("istanbul-summary");
    expect(coverage["path"]).toBe("coverage/coverage-summary.json");
    expect((coverage["total"] as { lines: { percent: number } }).lines.percent).toBe(82.35);
  });

  it("defaults to the declaration's OWN defaultLane", async () => {
    const captured = await capture(["report", "data", "--repo", COVERAGE_REPO, "--base", "main"], script());
    expect(captured.out.join("\n")).toMatch(/coverage: 82.35% lines on 'web'/);
  });

  it("is null, with the reason on stderr, for a lane declaring no report nen reads", async () => {
    const captured = await capture(
      ["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--lane", "native", "--json"],
      script(),
    );
    expect(captured.code).toBe(0);
    expect(documentFrom(captured)["coverage"]).toBeNull();
    expect(captured.err.join("\n")).toMatch(/declares no artifact nen recognises/);
  });

  it("is null, with the reason on stderr, for a declared report that is not on disk", async () => {
    const captured = await capture(
      ["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--lane", "gone", "--json"],
      script(),
    );
    expect(documentFrom(captured)["coverage"]).toBeNull();
    expect(captured.err.join("\n")).toMatch(/which is not there/);
  });

  it("is null for a lane that declares no coverage verb at all", async () => {
    const captured = await capture(
      ["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--lane", "nothing-here", "--json"],
      script(),
    );
    expect(documentFrom(captured)["coverage"]).toBeNull();
    expect(captured.err.join("\n")).toMatch(/declares no 'coverage' verb/);
  });

  it("refuses a --lane that would escape the tree through the proof path", async () => {
    const captured = await capture(
      ["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--lane", "../../../etc/passwd"],
      script(),
    );
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/resolves outside the repository/);
  });
});

describe("a repository that has declared nothing to nen", () => {
  function bareRepo(): string {
    return mkdtempSync(join(tmpdir(), "nen-report-bare-"));
  }

  it("still produces the whole document, with coverage, proof and lastStop null", async () => {
    const root = bareRepo();
    const captured = await capture(["report", "data", "--repo", root, "--base", "main", "--json"], script({ log: LOG }));
    expect(captured.code).toBe(0);
    const document = documentFrom(captured);
    expect(document["coverage"]).toBeNull();
    expect(document["proof"]).toBeNull();
    expect(document["lastStop"]).toBeNull();
    expect((document["commits"] as unknown[]).length).toBe(2);
  });

  it("reads .nen/proof/<lane>.json and .nen/last-stop.json VERBATIM when they are there", async () => {
    const root = bareRepo();
    mkdirSync(join(root, ".nen", "proof"), { recursive: true });
    writeFileSync(join(root, ".nen", "proof", "web.json"), JSON.stringify({ treeHash: "abc", lane: "web", exitCode: 0 }));
    writeFileSync(join(root, ".nen", "last-stop.json"), JSON.stringify({ gate: "G5", at: "2026-09-09T11:00:00Z" }));
    const captured = await capture(
      ["report", "data", "--repo", root, "--base", "main", "--lane", "web", "--json"],
      script(),
    );
    const document = documentFrom(captured);
    expect(document["proof"]).toEqual({ treeHash: "abc", lane: "web", exitCode: 0 });
    expect(document["lastStop"]).toEqual({ gate: "G5", at: "2026-09-09T11:00:00Z" });
  });

  it("reports a marker file that is not JSON as null, with the reason, rather than failing the run", async () => {
    const root = bareRepo();
    mkdirSync(join(root, ".nen"), { recursive: true });
    writeFileSync(join(root, ".nen", "last-stop.json"), "not json at all");
    const captured = await capture(["report", "data", "--repo", root, "--base", "main", "--json"], script());
    expect(captured.code).toBe(0);
    expect(documentFrom(captured)["lastStop"]).toBeNull();
    expect(captured.err.join("\n")).toMatch(/is present and is not valid JSON/);
  });
});

describe("the evidence seam", () => {
  it("is an empty list in this release, and says whose it is", async () => {
    const captured = await capture(["report", "data", "--repo", COVERAGE_REPO, "--base", "main"], script());
    expect(captured.out.join("\n")).toMatch(/evidence: 0 row\(s\) -- 'nen shu evidence' fills this/);
  });
});

describe("--tiers", () => {
  function table(document: unknown): TierTable {
    return parseTiers(document, "tiers.json");
  }

  it("labels each file with the FIRST tier whose patterns match, in the file's key order", () => {
    const tiers = table({ tests: ["src/**/*.test.ts"], source: ["src"], docs: ["docs"] });
    expect(tierOf("src/report/data.test.ts", tiers)).toBe("tests");
    expect(tierOf("src/report/data.ts", tiers)).toBe("source");
    expect(tierOf("docs/USAGE.md", tiers)).toBe("docs");
    expect(tierOf("README.md", tiers)).toBeNull();
  });

  it("matches a plain pattern as a PATH PREFIX, on segment boundaries", () => {
    expect(matchesPattern("src/report/data.ts", "src/report")).toBe(true);
    expect(matchesPattern("src/report", "src/report")).toBe(true);
    expect(matchesPattern("src/reporting.ts", "src/report")).toBe(false);
    expect(matchesPattern("src/report/data.ts", "src/report/")).toBe(true);
  });

  it("matches a glob narrowly: * stops at a separator, ** crosses one, ? is one character", () => {
    expect(matchesPattern("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesPattern("src/deep/a.ts", "src/*.ts")).toBe(false);
    expect(matchesPattern("src/deep/a.ts", "src/**/*.ts")).toBe(true);
    expect(matchesPattern("src/a.ts", "src/**/*.ts")).toBe(true);
    expect(matchesPattern("src/a.ts", "src/?.ts")).toBe(true);
    expect(matchesPattern("src/ab.ts", "src/?.ts")).toBe(false);
    expect(matchesPattern("src/a.ts", "")).toBe(false);
  });

  it("escapes a regex metacharacter in a glob instead of honouring it", () => {
    expect(matchesPattern("a+b/x.ts", "a+b/*.ts")).toBe(true);
    expect(matchesPattern("aab/x.ts", "a+b/*.ts")).toBe(false);
  });

  it("refuses a table that is not an object of string lists", () => {
    expect(() => table([1, 2])).toThrow(/is not a tier table/);
    expect(() => table({ tests: "src" })).toThrow(/is not a list of path patterns/);
    expect(() => table({ tests: [1] })).toThrow(/is not a list of path patterns/);
  });

  it("labels the changed files end to end", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-report-tiers-"));
    writeFileSync(join(root, "tiers.json"), JSON.stringify({ tests: ["src/**/*.test.ts"], source: ["src"] }));
    const captured = await capture(
      ["report", "data", "--repo", root, "--base", "main", "--tiers", "tiers.json", "--json"],
      script({ diff: DIFF }),
    );
    const files = documentFrom(captured)["files"] as { path: string; tier: string | null }[];
    expect(files.map((file): string | null => file.tier)).toEqual(["source", "tests", null, "source"]);
  });

  it("refuses an empty --tiers value rather than reading the repository root", async () => {
    const captured = await capture(["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--tiers", ""], []);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--tiers was given an empty value/);
  });

  it("refuses an empty --lane value the same way", async () => {
    const captured = await capture(["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--lane", ""], []);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--lane was given an empty value/);
  });
});
