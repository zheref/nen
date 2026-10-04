// Tests for ./excludecheck.ts -- `nen pr ready --exclude-check`'s argv grammar
// (zheref/nen#243) -- at three levels: the pure split, the verb end to end
// against a STUBBED transport (the same `deps.openSource` seam
// ../verbs/pr_ready.test.ts drives), and the CLI's own argv reader, which is
// where "repeatable" is actually decided.

import { describe, expect, it } from "vitest";
import { ExcludeCheckError, parseExcludeCheckNames, splitCheckNames } from "./excludecheck.js";
import { prReady, type LocalCheckout, type PrReadyDeps, type PrReadyInput, type ReadyReport } from "../verbs/pr_ready.js";
import type { PrStateSource } from "../github/pr_state.js";
import type { CheckRollupPage, PullRequestSnapshot, ReviewRequestsPage, ReviewThreadPage } from "../github/graphql.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { GATES_FILE, schemaPath } from "../schema/source.js";
import { run, type Io } from "../index.js";

/** zheref/nen#243's own repro: this repository's CI matrix, as GitHub names the job. */
const WINDOWS = 'check (Windows, ["self-hosted","Windows","X64"])';
const LINUX = 'check (Linux, ["ubuntu-latest"])';
const MACOS = 'check (macOS, ["macos-latest"])';

describe("splitCheckNames -- commas separate names only outside brackets", () => {
  it("keeps the matrix-shaped name from zheref/nen#243 whole", () => {
    expect(splitCheckNames(WINDOWS)).toEqual([WINDOWS]);
  });

  it("still splits a plain comma-joined value exactly as it always did", () => {
    expect(splitCheckNames("readiness,status-summary")).toEqual(["readiness", "status-summary"]);
    expect(splitCheckNames(" readiness , status-summary ")).toEqual(["readiness", "status-summary"]);
  });

  it("splits two matrix names joined by a comma OUTSIDE their brackets", () => {
    expect(splitCheckNames(`${WINDOWS},${LINUX}`)).toEqual([WINDOWS, LINUX]);
  });

  it("mixes a plain name and a matrix name in one value", () => {
    expect(splitCheckNames(`compile,${WINDOWS}`)).toEqual(["compile", WINDOWS]);
  });

  it("treats {} and [] as groups too, and nests", () => {
    expect(splitCheckNames("job {a, b},x [c, (d, e)]")).toEqual(["job {a, b}", "x [c, (d, e)]"]);
  });

  it("a closer with no matching opener is an ordinary character, and the comma after it still splits", () => {
    expect(splitCheckNames("smile :),frown")).toEqual(["smile :)", "frown"]);
  });

  it("a mismatched closer does not close the group it does not match", () => {
    // `]` cannot close `(`, so the comma after it is still inside the group --
    // and the group never closes, so the value is refused as ambiguous.
    expect(() => splitCheckNames("check (a], b")).toThrow(ExcludeCheckError);
  });

  it("an unclosed opener with NO comma after it is kept as typed -- both readings agree", () => {
    expect(splitCheckNames("lint (")).toEqual(["lint ("]);
    expect(splitCheckNames("a,lint (")).toEqual(["a", "lint ("]);
  });

  it("REFUSES an unclosed opener with a comma after it, naming the character and the remedy", () => {
    try {
      splitCheckNames("lint (,build");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExcludeCheckError);
      const message = (error as ExcludeCheckError).message;
      expect(message).toContain("--exclude-check 'lint (,build'");
      expect(message).toMatch(/opens a '\(' at character 6 that is never closed/);
      expect(message).toMatch(/its own --exclude-check occurrence/);
    }
  });

  it("drops empty names, so an empty value excludes nothing", () => {
    expect(splitCheckNames("")).toEqual([]);
    expect(splitCheckNames(",, ,")).toEqual([]);
  });
});

describe("parseExcludeCheckNames -- every occurrence, in order, repeats folded", () => {
  it("reads each occurrence on its own", () => {
    expect(parseExcludeCheckNames(["readiness", WINDOWS])).toEqual(["readiness", WINDOWS]);
  });

  it("folds a name given twice to its first appearance", () => {
    expect(parseExcludeCheckNames(["a,b", "b", "a"])).toEqual(["a", "b"]);
  });

  it("no occurrence is no names", () => {
    expect(parseExcludeCheckNames([])).toEqual([]);
  });

  it("an ambiguous occurrence refuses the whole list, never drops just that one", () => {
    expect(() => parseExcludeCheckNames(["readiness", "lint (,build"])).toThrow(ExcludeCheckError);
  });
});

// ── the verb, end to end, transport stubbed ─────────────────────────────────

/** A passing pull request except for whatever the rollup says (../verbs/pr_ready.test.ts's own fixture shape). */
function matrixSource(windowsConclusion: "FAILURE" | "SUCCESS" | null): PrStateSource {
  const snapshot: PullRequestSnapshot = {
    pullRequest: {
      number: 9,
      mergeable: "MERGEABLE",
      isDraft: false,
      headRefOid: "cafebabe",
      headRefName: "feature/x",
      baseRefName: "main",
      baseRefOid: "basebase",
      author: { login: "someone" },
      labels: [],
      reviewRequests: [],
    },
    defaultBranch: "main",
    checkRollup: [
      { name: "compile", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: LINUX, status: "COMPLETED", conclusion: "SUCCESS" },
      { name: MACOS, status: "COMPLETED", conclusion: "SUCCESS" },
      // No self-hosted Windows runner is enabled (the maintainer's ruling on
      // zheref/nen#242): the job never leaves the queue, or fails.
      windowsConclusion === null
        ? { name: WINDOWS, status: "QUEUED", conclusion: null }
        : { name: WINDOWS, status: "COMPLETED", conclusion: windowsConclusion },
    ],
    checkRollupPageInfo: { hasNextPage: false, endCursor: null },
    reviewRequests: [],
    reviewRequestsPageInfo: { hasNextPage: false, endCursor: null },
  };
  return {
    pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => snapshot,
    reviews: async (): Promise<unknown[]> => [
      { user: { login: "sasuke" }, state: "APPROVED", commit_id: "cafebabe", submitted_at: "2025-01-01T00:00:00Z" },
      { user: { login: "tenma" }, state: "APPROVED", commit_id: "cafebabe", submitted_at: "2025-01-01T00:00:00Z" },
    ],
    reviewThreadsPage: async (): Promise<ReviewThreadPage> => ({ nodes: [], hasNextPage: false, endCursor: null }),
    timeline: async (): Promise<unknown[]> => [],
    checkRollupPage: async (): Promise<CheckRollupPage> => {
      throw new Error("checkRollupPage should not be called when hasNextPage is false");
    },
    reviewRequestsPage: async (): Promise<ReviewRequestsPage> => {
      throw new Error("reviewRequestsPage should not be called when hasNextPage is false");
    },
    fileAtRef: async (): Promise<string | null> => null,
  };
}

function stubDeps(source: PrStateSource): PrReadyDeps {
  return {
    now: (): string => "2025-01-01T00:00:00Z",
    executable: (): string => "/opt/nen/nen-linux-x64",
    openSource: (): { ok: true; source: PrStateSource } => ({ ok: true, source }),
    localCheckout: (): LocalCheckout | null => null,
  };
}

function input(overrides: Partial<PrReadyInput> = {}): PrReadyInput {
  return {
    positionals: ["pr", "ready", "9"],
    values: { "gh-repo": "zheref/example", gates: schemaPath(BANKAI_REPO, GATES_FILE) },
    booleans: new Set(["json"]),
    repoFlag: null,
    ...overrides,
  };
}

async function verdict(source: PrStateSource, overrides: Partial<PrReadyInput>): Promise<{ code: number; report: ReadyReport; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await prReady(input(overrides), { out: (l): void => void out.push(l), err: (l): void => void err.push(l) }, stubDeps(source));
  return { code, report: (out.length > 0 ? JSON.parse(out.join("\n")) : null) as ReadyReport, err };
}

describe("prReady -- --exclude-check names a matrix job (zheref/nen#243)", () => {
  it("baseline: the queued Windows matrix job alone keeps the verdict not-ready", async () => {
    const { code, report } = await verdict(matrixSource(null), {});
    expect(code).toBe(1);
    expect(report.verdict).toBe("not-ready");
  });

  it("excluding the matrix name, as one occurrence, reads ready -- the exact call #242 could not make", async () => {
    const { code, report } = await verdict(matrixSource(null), { lists: { "exclude-check": [WINDOWS] } });
    expect(code).toBe(0);
    expect(report.verdict).toBe("ready");
    expect(report.meta.excludedChecks).toEqual([WINDOWS]);
    // Nothing fragmented into four names that match nothing.
    expect(report.meta.warnings).toEqual([]);
  });

  it("a FAILED Windows job is excluded the same way", async () => {
    const { code, report } = await verdict(matrixSource("FAILURE"), { lists: { "exclude-check": [WINDOWS] } });
    expect(code).toBe(0);
    expect(report.verdict).toBe("ready");
  });

  it("repeated occurrences exclude every name, plain and matrix alike", async () => {
    const { code, report } = await verdict(matrixSource("FAILURE"), { lists: { "exclude-check": ["compile", WINDOWS] } });
    expect(code).toBe(0);
    expect(report.meta.excludedChecks).toEqual(["compile", WINDOWS]);
  });

  it("the comma-joined spelling still works, and may now carry a matrix name beside a plain one", async () => {
    const { code, report } = await verdict(matrixSource("FAILURE"), { lists: { "exclude-check": [`compile,${WINDOWS}`] } });
    expect(code).toBe(0);
    expect(report.meta.excludedChecks).toEqual(["compile", WINDOWS]);
  });

  it("an in-process caller's single values['exclude-check'] is read as one more occurrence", async () => {
    const { code, report } = await verdict(matrixSource(null), {
      values: { ...input().values, "exclude-check": WINDOWS },
    });
    expect(code).toBe(0);
    expect(report.meta.excludedChecks).toEqual([WINDOWS]);
  });

  it("a fragment that matches no check is still warned about, never silently dropped", async () => {
    const { code, report } = await verdict(matrixSource(null), { lists: { "exclude-check": ["check (Windows"] } });
    expect(code).toBe(1);
    expect(report.verdict).toBe("not-ready");
    expect(report.meta.warnings).toContain("--exclude-check 'check (Windows' matched no check in the rollup");
  });

  it("an ambiguous value is a usage error (exit 2) with no verdict printed", async () => {
    const { code, report, err } = await verdict(matrixSource(null), { lists: { "exclude-check": ["check (Windows,X"] } });
    expect(code).toBe(2);
    expect(report).toBeNull();
    expect(err.join("\n")).toMatch(/never closed, with a comma after it/);
  });
});

// ── the CLI: the argv reader is where "repeatable" is decided ────────────────
//
// Reaches ONLY the token-check no-network path, exactly as ./command.test.ts's
// own `--json` fold test does: an unset token env var refuses before GitHub is
// read, and the resulting `unevaluated` report still states which checks it
// was asked to exclude.
describe("nen pr ready --exclude-check -- the CLI flag repeats (zheref/nen#243)", () => {
  const TOKEN_ENV = "NEN_TEST_DEFINITELY_UNSET_TOKEN_243";

  async function cli(argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    delete process.env[TOKEN_ENV];
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (l): void => void out.push(l), err: (l): void => void err.push(l) };
    const code = await run(
      ["pr", "ready", "5", "--gh-repo", "o/r", "--reviewers", "alice", "--token-env", TOKEN_ENV, "--json", ...argv],
      io,
    );
    return { code, out, err };
  }

  it("accepts the flag twice -- it used to be refused as a repeated value flag", async () => {
    const result = await cli(["--exclude-check", "readiness", "--exclude-check", WINDOWS]);
    expect(result.code).toBe(1); // unevaluated: no token, by construction
    const report = JSON.parse(result.out.join("\n")) as ReadyReport;
    expect(report.verdict).toBe("unevaluated");
    expect(report.meta.excludedChecks).toEqual(["readiness", WINDOWS]);
  });

  it("keeps the comma-joined single occurrence working", async () => {
    const result = await cli(["--exclude-check", "readiness,status-summary"]);
    const report = JSON.parse(result.out.join("\n")) as ReadyReport;
    expect(report.meta.excludedChecks).toEqual(["readiness", "status-summary"]);
  });

  it("refuses the ambiguous shape at exit 2 before anything is read", async () => {
    const result = await cli(["--exclude-check", "lint (,build"]);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/--exclude-check 'lint \(,build' opens a '\('/);
  });

  it("'nen pr --help' documents the repeat and the bracket rule", async () => {
    const out: string[] = [];
    const io: Io = { out: (l): void => void out.push(l), err: (): void => undefined };
    await run(["pr", "--help"], io);
    const help = out.join("\n");
    expect(help).toMatch(/\[--exclude-check <name>\]\.\.\./);
    expect(help).toMatch(/REPEATABLE, one\s+name per occurrence/);
    expect(help).toMatch(/a comma\s+inside \(\)\/\[\]\/\{\} is part of the name/);
  });
});
