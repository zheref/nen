// src/shu/test-report.test.ts -- `nen shu test-report`, driven through the REAL
// dispatch (../index.ts's runFamily), against a fixture repository with one lane
// per answer this verb has to have.
//
// NO LIVE TOOLCHAIN AND NO LIVE TEST RUN. Every subprocess is a ScriptedSeams
// entry, which throws on a call nobody scripted; every report is a file
// committed under ../schema/fixtures/shu-test-report-repo/. What is being proved
// here is the SECOND half of this verb -- which artifact it chooses, when it
// parses and when it refuses to, and what the exit code is -- on top of an
// executor ../shu/run.test.ts already proves, and parsers ./test-report/parse
// .test.ts already proves.
//
// THE FOUR MUTANTS THIS FILE EXISTS TO KILL, each named at its assertion:
//   1. a verb that goes silent exactly when the suite goes red (it must parse a
//      failing run -- that report is the reason anybody asked);
//   2. a verb whose failures move the exit code (they never do, in either
//      direction);
//   3. a run that started NOTHING reporting the report on disk from an earlier
//      one (a dry run, an unmet precondition, a program that would not spawn);
//   4. an artifact chosen in one pass, so an extension-less build output
//      shadows the `.xml` declared after it.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { classifyCommand } from "../parse/izanami.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { SHU_TEST_REPORT_REPO } from "../schema/fixtures/paths.js";
import { shuCommand } from "./command.js";
import { contractName } from "./run.js";
import { chooseArtifact, SOURCE_VERB } from "./test-report.js";
import { TEST_REPORT_CONTRACT } from "./test-report/report.js";

/** Each lane's declared `test` command, which every run below scripts. */
const WEB = "pnpm --filter @placeholder/core test --reporter=json --outputFile=reports/test-results.json";
const CORE = "pnpm --filter @placeholder/app test";
const DROID = "placeholder-wrapper test";
const STRAY = "placeholder-wrapper test --stray";
const NOXML = "placeholder-wrapper test --none";
const MIXED = "npm run test:all";
const GONE = "npm run test";

interface Options {
  readonly script?: readonly ScriptedCall[];
  readonly repo?: string;
}

interface Captured {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly seams: ScriptedSeams;
}

async function capture(argv: readonly string[], options: Options = {}): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push(line),
  };
  const seams = new ScriptedSeams(options.script ?? [], { platform: "linux", env: {} });
  const code = await runFamily(
    shuCommand,
    ["shu", ...argv],
    options.repo ?? SHU_TEST_REPORT_REPO,
    false,
    io,
    seams,
  );
  return { code, out, err, seams };
}

function ok(match: string): ScriptedCall {
  return { match, result: { code: 0 } };
}

function red(match: string): ScriptedCall {
  return { match, result: { code: 1 } };
}

interface Row {
  readonly name: string;
  readonly suite: string | null;
  readonly status: string;
  readonly durationMs: number | null;
}

interface Document {
  readonly contract: string;
  readonly lane: string;
  readonly stack: string;
  readonly report: { readonly format: string; readonly path: string } | null;
  readonly tests: readonly Row[];
  readonly passed: number | null;
  readonly failed: number | null;
  readonly skipped: number | null;
  readonly total: number | null;
  readonly exitCode: number;
}

/** The one JSON document on stdout, refusing anything that is not exactly one. */
function document(result: Captured): Document {
  const text = result.out.join("\n");
  expect(text.trimStart().startsWith("{"), "stdout is not one JSON document").toBe(true);
  return JSON.parse(text) as Document;
}

function ran(result: Captured): readonly string[] {
  return result.seams.calls.map((call): string => [call.command, ...call.args].join(" "));
}

// ── the parse ───────────────────────────────────────────────────────────────

describe("a test run, parsed", () => {
  it("runs the lane's declared TEST and reports what the report states", async () => {
    const result = await capture(["test-report", "--json"], { script: [ok(WEB)] });
    expect(result.code).toBe(0);
    // THE VERB IT RUNS IS `test`. There is no `test-report` row anywhere in the
    // fixture's declaration, and there must never need to be.
    expect(ran(result)).toEqual([WEB]);
    const parsed = document(result);
    expect(parsed.report).toEqual({
      format: "assertion-results",
      path: "reports/test-results.json",
    });
    expect([parsed.passed, parsed.failed, parsed.skipped, parsed.total]).toEqual([3, 1, 1, 5]);
    expect(parsed.tests).toHaveLength(5);
  });

  it("emits the ten published keys, in order", async () => {
    const parsed = document(await capture(["test-report", "--json"], { script: [ok(WEB)] }));
    expect(Object.keys(parsed)).toEqual([
      "contract",
      "lane",
      "stack",
      "report",
      "tests",
      "passed",
      "failed",
      "skipped",
      "total",
      "exitCode",
    ]);
    expect(parsed.contract).toBe(TEST_REPORT_CONTRACT);
    // The contract string is RESTATED in ./test-report/report.ts rather than
    // imported from ./run.ts (which reaches the seam). This is the pin.
    expect(TEST_REPORT_CONTRACT).toBe(contractName("test-report"));
    expect(parsed.lane).toBe("web");
    expect(parsed.stack).toBe("nextjs");
  });

  it("keeps each row's four keys in order, with nulls where the report is silent", async () => {
    const parsed = document(await capture(["test-report", "--json"], { script: [ok(WEB)] }));
    expect(Object.keys(parsed.tests[0] ?? {})).toEqual(["name", "suite", "status", "durationMs"]);
    expect(parsed.tests[4]).toEqual({
      name: "applies a discount",
      suite: "/home/placeholder/checkout/src/totals.test.ts",
      status: "skipped",
      durationMs: null,
    });
  });

  it("keeps the report's OWN order in the document", async () => {
    // The table prints failures first; the document does not. A machine reader
    // comparing two runs of one suite wants the order the runner produced.
    const parsed = document(await capture(["test-report", "--json"], { script: [ok(WEB)] }));
    expect(parsed.tests.map((test): string => test.status)).toEqual([
      "passed",
      "passed",
      "failed",
      "passed",
      "skipped",
    ]);
  });
});

// ── MUTANT 1 AND 2: the red suite, and the exit code ────────────────────────

describe("a run that failed", () => {
  it("STILL parses, because a failing suite is the interesting report", async () => {
    const result = await capture(["test-report", "--json"], { script: [red(WEB)] });
    const parsed = document(result);
    expect(parsed.failed).toBe(1);
    expect(parsed.tests).toHaveLength(5);
  });

  it("answers with the RUN's exit code, which the failures did not move", async () => {
    const result = await capture(["test-report", "--json"], { script: [red(WEB)] });
    expect(result.code).toBe(1);
    expect(document(result).exitCode).toBe(1);
  });

  it("does not turn a green run red for having found failures", async () => {
    // The other direction of the same rule, and the one a caller would notice
    // second: `--from-artifacts` runs nothing, so its code is about the READ.
    // The committed report carries a failure and the read worked.
    const result = await capture(["test-report", "--from-artifacts", "--json"]);
    expect(result.code).toBe(0);
    const parsed = document(result);
    expect(parsed.failed).toBe(1);
    expect(parsed.exitCode).toBe(0);
  });
});

// ── MUTANT 3: a run that started nothing parses nothing ─────────────────────

describe("a run that started nothing parses nothing", () => {
  it("parses nothing on a dry run, even with the report sitting on disk", async () => {
    const result = await capture(["test-report", "--dry-run", "--json"]);
    expect(result.code).toBe(0);
    expect(ran(result)).toEqual([]);
    const parsed = document(result);
    expect(parsed.total).toBeNull();
    expect(parsed.tests).toEqual([]);
    // A DRY RUN IS TOLD BY exitCode 0 WITH total null, and it still says which
    // path a real run would have parsed.
    expect(parsed.report).toEqual({
      format: "assertion-results",
      path: "reports/test-results.json",
    });
    expect(result.err.join("\n")).not.toContain("could not");
  });

  it("parses nothing when a precondition stopped the run before a step", async () => {
    // The `blocked` lane's declared artifact IS a real, parseable report -- the
    // `web` lane's. Nothing ran, so nothing is this invocation's to report.
    const result = await capture(["test-report", "--lane", "blocked", "--json"]);
    expect(result.code).toBe(2);
    expect(ran(result)).toEqual([]);
    const parsed = document(result);
    expect(parsed.total).toBeNull();
    expect(parsed.tests).toEqual([]);
    expect(parsed.exitCode).toBe(2);
  });

  it("parses nothing when the declared program could not be started", async () => {
    const result = await capture(["test-report", "--json"], {
      script: [{ match: WEB, result: { spawnFailed: true, code: -1 } }],
    });
    expect(result.code).toBe(5);
    const parsed = document(result);
    expect(parsed.total).toBeNull();
    expect(parsed.exitCode).toBe(5);
    // AND THE EXECUTOR'S REPORT IS STILL PRINTED on the path that throws --
    // the argv that failed is the thing the reader needs.
    expect(result.err.join("\n")).toContain("could not be started");
    expect(result.err.join("\n")).toContain("--filter");
  });
});

// ── MUTANT 4: which artifact, and in what order ─────────────────────────────

describe("choosing the artifact", () => {
  it("prefers a NAMED format over an extension-less path, whatever the order", () => {
    // One pass over "recognised, or extension-less" would take the binary.
    expect(chooseArtifact(["reports/bin/app", "reports/results.xml"])).toBe("reports/results.xml");
    expect(chooseArtifact(["reports/notes.md", "reports/bin/app"])).toBe("reports/bin/app");
    expect(chooseArtifact(["reports/notes.md"])).toBeNull();
    expect(chooseArtifact([])).toBeNull();
  });

  it("passes over the decoys a real declaration carries", async () => {
    const result = await capture(["test-report", "--lane", "mixed", "--json"], {
      script: [ok(MIXED)],
    });
    expect(result.code).toBe(0);
    const parsed = document(result);
    expect(parsed.report).toEqual({ format: "junit", path: "reports/results/CartTest.xml" });
    expect(parsed.total).toBe(3);
  });

  it("reads a DIRECTORY artifact as every *.xml under it, merged", async () => {
    const result = await capture(["test-report", "--lane", "droid", "--json"], {
      script: [ok(DROID)],
    });
    expect(result.code).toBe(0);
    const parsed = document(result);
    expect(parsed.report).toEqual({ format: "junit", path: "reports/results" });
    expect([parsed.passed, parsed.failed, parsed.skipped, parsed.total]).toEqual([3, 1, 1, 5]);
    expect(parsed.tests.map((test): string => test.name)).toEqual([
      "addsOneItem",
      "addsTwoItems",
      "refusesANegativeQuantity",
      "sumsAnEmptyCart",
      "appliesADiscount",
    ]);
  });

  it("reads the summary a DECLARED extraction step wrote, spawning none of its own", async () => {
    const result = await capture(["test-report", "--lane", "native", "--json"], {
      script: [
        ok("placeholder-build-tool test -resultBundlePath reports/Placeholder.xcresult"),
        ok(
          "placeholder-result-tool get test-results summary --path reports/Placeholder.xcresult --format json --output-path reports/test-summary.json",
        ),
      ],
    });
    expect(result.code).toBe(0);
    // BOTH STEPS ARE THE DECLARATION'S, and nen added nothing to them.
    expect(ran(result)).toHaveLength(2);
    const parsed = document(result);
    expect(parsed.report?.format).toBe("xcresult-summary");
    expect(parsed.total).toBe(5);
    // The one format that states its totals and lists only its failures.
    expect(parsed.tests).toHaveLength(1);
    expect(parsed.tests[0]?.status).toBe("failed");
  });
});

// ── the refusals ────────────────────────────────────────────────────────────

describe("a lane with nothing nen can read", () => {
  it("refuses at 1 when the lane declares no artifacts, naming the field", async () => {
    const result = await capture(["test-report", "--lane", "core"], { script: [ok(CORE)] });
    expect(result.code).toBe(1);
    const said = result.err.join("\n");
    expect(said).toContain("declares no artifacts at all");
    expect(said).toContain(`project.verbs.core.${SOURCE_VERB}.artifacts`);
    expect(said).toContain("junit");
    expect(result.out.join("\n")).toContain("(nothing parsed");
  });

  it("refuses at 1 when the declared report is not on disk, naming the path", async () => {
    const result = await capture(["test-report", "--lane", "gone"], { script: [ok(GONE)] });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("no test report at reports/gone/results.xml");
  });

  it("refuses a directory holding XML that is not a test report", async () => {
    const result = await capture(["test-report", "--lane", "stray"], { script: [ok(STRAY)] });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("reports/stray/other.xml");
  });

  it("refuses a directory holding no XML at all", async () => {
    const result = await capture(["test-report", "--lane", "noxml"], { script: [ok(NOXML)] });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("no *.xml file anywhere under it");
  });

  it("passes the executor's own refusals through unchanged", async () => {
    // A lane with no `test` row is exit 4 in the declaration's own words --
    // this verb declares nothing of its own, so it has nothing else to say.
    const result = await capture(["test-report", "--lane", "untested"]);
    expect(result.code).toBe(4);
    expect(result.err.join("\n")).toContain("declares no 'test'");
    expect(ran(result)).toEqual([]);
  });
});

// ── --from-artifacts ────────────────────────────────────────────────────────

describe("--from-artifacts", () => {
  it("spawns nothing whatever and parses what is on disk", async () => {
    const result = await capture(["test-report", "--from-artifacts", "--json"]);
    expect(result.code).toBe(0);
    // THE READ-ONLY CLAIM, from the seam's own side: zero calls.
    expect(result.seams.calls).toEqual([]);
    const parsed = document(result);
    expect(parsed.total).toBe(5);
    expect(parsed.report?.path).toBe("reports/test-results.json");
  });

  it("says plainly that nothing ran and that nen cannot date the file", async () => {
    const result = await capture(["test-report", "--from-artifacts"]);
    const said = result.out.join("\n");
    expect(said).toContain("lane:");
    expect(said).toContain("--from-artifacts -- nothing was run");
    expect(said).toContain("cannot tell how old it is");
    // There is no executor report above it, because there was no run.
    expect(said).not.toContain("would run:");
    expect(said).not.toContain("ran:");
  });

  it("still answers the executor's refusals, because the artifacts are that verb's", async () => {
    const result = await capture(["test-report", "--lane", "untested", "--from-artifacts"]);
    expect(result.code).toBe(4);
    expect(result.err.join("\n")).toContain("declares no 'test'");
  });

  it("refuses to be given --dry-run as well, rather than picking one", async () => {
    const result = await capture(["test-report", "--from-artifacts", "--dry-run"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("both --dry-run and --from-artifacts");
    expect(result.seams.calls).toEqual([]);
  });

  it("is refused on every other verb in the family", async () => {
    const result = await capture(["test", "--from-artifacts"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("--from-artifacts is not read by 'shu test'");
  });
});

// ── the two renderings ──────────────────────────────────────────────────────

describe("the text rendering", () => {
  it("prints the totals, then the failures first", async () => {
    const result = await capture(["test-report"], { script: [red(WEB)] });
    const lines = result.out;
    const totals = lines.findIndex((line): boolean => line.startsWith("totals:"));
    const table = lines.findIndex((line): boolean => line === "tests:");
    expect(totals).toBeGreaterThan(-1);
    expect(table).toBeGreaterThan(totals);
    expect(lines[totals]).toContain("5 tests -- 3 passed, 1 failed, 1 skipped");
    // The first row under the header is the failure, though the document has
    // it third.
    expect(lines[table + 2]).toContain("FAILED");
    expect(lines[table + 2]).toContain("refuses a negative quantity");
  });

  it("indents its labels exactly as the executor's report above it does", async () => {
    // Two blocks printed one under the other, from two modules that restate the
    // width. A change to either is caught here rather than seen.
    const result = await capture(["test-report"], { script: [ok(WEB)] });
    const executor = result.out.find((line): boolean => line.startsWith("lane:")) ?? "";
    const own = result.out.find((line): boolean => line.startsWith("report:")) ?? "";
    expect(executor.indexOf("web")).toBe(own.indexOf("reports/"));
  });

  it("says when the rows are fewer than the total, rather than leaving it strange", async () => {
    const result = await capture(["test-report", "--lane", "native"], {
      script: [
        ok("placeholder-build-tool test -resultBundlePath reports/Placeholder.xcresult"),
        ok(
          "placeholder-result-tool get test-results summary --path reports/Placeholder.xcresult --format json --output-path reports/test-summary.json",
        ),
      ],
    });
    expect(result.out.join("\n")).toContain("rows:");
    expect(result.out.join("\n")).toContain("1 of 5");
  });

  it("puts the executor's report on stderr under --json, losing none of it", async () => {
    const result = await capture(["test-report", "--json"], { script: [ok(WEB)] });
    // stdout is exactly one document; the run's own report is beside it.
    document(result);
    expect(result.err.join("\n")).toContain("lane:");
    expect(result.err.join("\n")).toContain("ran:");
  });
});

// ── a suite name that is somebody's home directory ──────────────────────────

describe("a report whose rows name absolute paths", () => {
  it("makes a suite inside the repository repo-relative", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-test-report-repo-"));
    try {
      mkdirSync(join(root, "nen"), { recursive: true });
      mkdirSync(join(root, "reports"), { recursive: true });
      writeFileSync(
        join(root, "nen", "contract.json"),
        JSON.stringify({
          $schema: "nen.contract/v0.1",
          project: {
            lanes: { web: { stack: "nextjs", cwd: "." } },
            defaultLane: "web",
            preconditions: {},
            verbs: {
              web: {
                test: { exe: "placeholder", argv: ["test"], artifacts: ["reports/results.json"] },
              },
            },
            profiles: {},
            targets: {},
            hosts: { "*": ["darwin", "linux", "win32"] },
          },
        }),
      );
      writeFileSync(
        join(root, "reports", "results.json"),
        JSON.stringify({
          testResults: [
            {
              name: join(root, "src", "cart.test.ts"),
              assertionResults: [{ fullName: "cart > adds one item", status: "passed", duration: 1 }],
            },
          ],
        }),
      );
      const result = await capture(["test-report", "--from-artifacts", "--json"], { repo: root });
      expect(result.code).toBe(0);
      const parsed = document(result);
      expect(parsed.tests[0]?.suite).toBe("src/cart.test.ts");
      // The whole point: the machine that ran the suite is not in the document.
      expect(result.out.join("\n")).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── the automation-policy row ───────────────────────────────────────────────

describe("izanami classifies this verb's three forms", () => {
  it("refuses the bare form: the argv it spawns is the target repository's", () => {
    const verdict = classifyCommand("nen shu test-report");
    expect(verdict.classification).toBe("mutating");
    expect(verdict.reason).toContain("declared TEST command");
  });

  it("certifies the dry run, which renders and spawns nothing", () => {
    expect(classifyCommand("nen shu test-report --dry-run").classification).toBe("read-only");
  });

  it("certifies --from-artifacts, which never reaches the executor at all", () => {
    const verdict = classifyCommand("nen shu test-report --from-artifacts");
    expect(verdict.classification).toBe("read-only");
    expect(verdict.reason).toContain("starts no process at all");
  });

  it("still refuses a gate it cannot prove is an argument of its own", () => {
    // An unfaithful line can donate a `--from-artifacts` token no shell ever
    // produced. On a writes-by-default verb an unprovable gate is no gate.
    const verdict = classifyCommand("nen shu test-report --lane 'a --from-artifacts b'");
    expect(verdict.classification).toBe("mutating");
  });
});
