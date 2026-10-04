import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLabelTaxonomy } from "../schema/labels.js";
import { addLabelArgv, validatePlan } from "./apply.js";
import { loadClassifyTaxonomy } from "./taxonomy.js";
import { capture, gh, issueCall, landedRepo, MINI, MINI_LABELS, SLUG, tmpRepo } from "./fixtures/harness.js";

const TARGET = { owner: "zheref", repo: "nen", slug: SLUG };

function plan(repo: string, rows: unknown, name = "plan.json"): string {
  writeFileSync(join(repo, name), typeof rows === "string" ? rows : JSON.stringify(rows));
  return name;
}

const apply = (repo: string, planFile: string, ...rest: string[]): string[] => [
  "classify", "apply", "--taxonomy", MINI, "--repo", repo, "--target", SLUG, "--plan", planFile, ...rest,
];

const edit = (issue: number, label: string): string => gh(...addLabelArgv(TARGET, issue, label));
const ledgerOf = (path: string): Record<string, unknown>[] =>
  readFileSync(path, "utf8").trim().split("\n").map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>);

describe("validatePlan -- every refusal named, nothing partial", () => {
  const taxonomy = loadClassifyTaxonomy("/", MINI);
  const declared = loadLabelTaxonomy(landedRepo());
  const refusals = (value: unknown): readonly string[] => validatePlan(taxonomy, declared, "plan.json", value).refusals;

  it("accepts a good plan, defaulting confidence to the taxonomy's first level and reading axes in order", () => {
    const result = validatePlan(taxonomy, declared, "plan.json", [
      { issue: 12, job: ["test", "build"], lang: ["alpha"] },
      { issue: 13, lang: ["beta"], confidence: "low", reason: "guess" },
    ]);
    expect(result.refusals).toEqual([]);
    expect(result.rows).toEqual([
      { issue: 12, labels: ["lang/alpha", "job/test", "job/build"], confidence: "high", reason: null },
      { issue: 13, labels: ["lang/beta"], confidence: "low", reason: "guess" },
    ]);
  });

  it("accepts an empty axis beside a populated one: the job label only, the empty axis stays empty", () => {
    const result = validatePlan(taxonomy, declared, "plan.json", [{ issue: 5, lang: [], job: ["build"] }]);
    expect(result.refusals).toEqual([]);
    expect(result.rows).toEqual([{ issue: 5, labels: ["job/build"], confidence: "high", reason: null }]);
  });

  it("accepts a row with both axes empty -- an undecidable row -- and renders 'nothing to apply' without refusing", async () => {
    const result = validatePlan(taxonomy, declared, "plan.json", [{ issue: 6, lang: [], job: [] }]);
    expect(result.refusals).toEqual([]);
    expect(result.rows).toEqual([{ issue: 6, labels: [], confidence: "high", reason: null }]);

    const repo = landedRepo();
    const run = await capture(apply(repo, plan(repo, [{ issue: 6, lang: [], job: [] }]), "--run"), [issueCall(6, [])]);
    expect(run.code).toBe(0);
    expect(run.out[0]).toBe("#6  nothing to apply");
    expect(existsSync(join(repo, "label-ledger.jsonl"))).toBe(false);
  });

  it("refuses a plan that is not an array, and a row that is not an object", () => {
    expect(refusals({ issue: 1 })[0]).toMatch(/at \$, expected a JSON array/);
    expect(refusals([7])[0]).toMatch(/at \[0\], expected an object/);
  });

  it("refuses a non-positive, fractional, stringly or missing issue", () => {
    for (const issue of [0, -1, 1.5, "12", null, undefined]) {
      expect(refusals([{ issue, lang: ["alpha"] }]).join("\n"), String(issue)).toMatch(/\[0\]\.issue, expected a positive whole number/);
    }
  });

  it("refuses a duplicate issue", () => {
    expect(refusals([{ issue: 5, lang: ["alpha"] }, { issue: 5, job: ["build"] }]).join("\n")).toMatch(
      /\[1\]\.issue, duplicates \[0\]\.issue \(#5\)/,
    );
  });

  it("refuses a key outside its axis, with the axis named, and the same key on the wrong axis", () => {
    expect(refusals([{ issue: 1, lang: ["nope"] }]).join("\n")).toMatch(/\[0\]\.lang\[0\], 'nope' is not a key of the lang axis/);
    expect(refusals([{ issue: 1, lang: ["build"] }]).join("\n")).toMatch(/'build' is not a key of the lang axis/);
  });

  it("refuses a label the consumer's declaration lacks, naming the way out", () => {
    const sparse = loadLabelTaxonomy(tmpRepo({ labels: MINI_LABELS.slice(0, 1) }));
    const out = validatePlan(taxonomy, sparse, "plan.json", [{ issue: 1, lang: ["beta"] }]).refusals.join("\n");
    expect(out).toMatch(/'lang\/beta' is not declared in .*labels\.json/);
    expect(out).toMatch(/nen classify install --write/);
  });

  it("refuses an unknown confidence, an unknown field and a malformed axis list", () => {
    expect(refusals([{ issue: 1, confidence: "certain" }])[0]).toMatch(/\[0\]\.confidence, expected one of \[high, medium, low\]/);
    expect(refusals([{ issue: 1, langs: ["alpha"] }])[0]).toMatch(/\[0\]\.langs, is not a plan field/);
    expect(refusals([{ issue: 1, lang: "alpha" }])[0]).toMatch(/\[0\]\.lang, expected an array/);
    expect(refusals([{ issue: 1, lang: ["alpha", "alpha"] }])[0]).toMatch(/'alpha' is listed twice/);
    expect(refusals([{ issue: 1, lang: [3] }])[0]).toMatch(/expected a key name/);
  });

  it("collects EVERY refusal and returns no rows at all", () => {
    const result = validatePlan(taxonomy, declared, "plan.json", [
      { issue: 1, lang: ["alpha"] },
      { issue: 0 },
      { issue: 3, job: ["x"] },
    ]);
    expect(result.refusals).toHaveLength(2);
    expect(result.rows).toEqual([]);
  });
});

describe("nen classify apply -- a plan with any invalid row is refused whole", () => {
  it("exits 2, names every refusal, reads nothing from gh and writes no ledger", async () => {
    const repo = landedRepo();
    const file = plan(repo, [
      { issue: 1, lang: ["alpha"] },
      { issue: 1, lang: ["nope"] },
      { issue: 2, confidence: "sure" },
    ]);
    const result = await capture(apply(repo, file, "--run"));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/duplicates \[0\]\.issue/);
    expect(result.err.join("\n")).toMatch(/'nope' is not a key/);
    expect(result.err.join("\n")).toMatch(/\[2\]\.confidence/);
    expect(result.err.join("\n")).toMatch(/refused whole \(3 refusal/);
    expect(result.seams.calls).toEqual([]);
    expect(existsSync(join(repo, "label-ledger.jsonl"))).toBe(false);
  });

  it("exits 2 for plan text that is not JSON, and for a plan file that is not there", async () => {
    const repo = landedRepo();
    const bad = await capture(apply(repo, plan(repo, "{ nope")));
    expect(bad.code).toBe(2);
    expect(bad.err.join("\n")).toMatch(/is not valid JSON/);
    const missing = await capture(apply(repo, "absent.json"));
    expect(missing.code).toBe(2);
    expect(missing.err.join("\n")).toMatch(/could not read/);
  });

  it("refuses a label the declaration lacks before anything else happens", async () => {
    const repo = tmpRepo({ labels: MINI_LABELS.slice(0, 1) });
    const result = await capture(apply(repo, plan(repo, [{ issue: 1, lang: ["beta"] }])));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/not declared/);
    expect(result.seams.calls).toEqual([]);
  });

  it("needs --plan, --target, --taxonomy and --repo at exit 2", async () => {
    const repo = landedRepo();
    expect((await capture(["classify", "apply", "--taxonomy", MINI, "--repo", repo, "--target", SLUG])).code).toBe(2);
    expect((await capture(["classify", "apply", "--taxonomy", MINI, "--repo", repo, "--plan", "p.json"])).code).toBe(2);
    expect((await capture(["classify", "apply", "--repo", repo, "--target", SLUG, "--plan", "p.json"])).code).toBe(2);
    expect((await capture(["classify", "apply", "--taxonomy", MINI, "--target", SLUG, "--plan", "p.json"])).code).toBe(2);
  });

  it("refuses a ledger whose directory does not exist, before any mutation", async () => {
    const repo = landedRepo();
    const file = plan(repo, [{ issue: 1, lang: ["alpha"] }]);
    const result = await capture(apply(repo, file, "--run", "--ledger", "missing-dir/ledger.jsonl"), [issueCall(1, [])]);
    expect(result.code).toBe(2);
    expect(result.seams.calls.every((call): boolean => call.args[0] === "api")).toBe(true);
  });
});

describe("nen classify apply -- dry run (no --run)", () => {
  it("reads the issues, mutates nothing, and writes one dry-run ledger line per label under --repo's root", async () => {
    const repo = landedRepo();
    const file = plan(repo, [{ issue: 12, lang: ["alpha"], job: ["build", "test"], reason: "reads like a build task" }]);
    const result = await capture(apply(repo, file, "--reason", "sweep 2026-10-04"), [issueCall(12, ["bug"])]);
    expect(result.code).toBe(0);
    expect(result.seams.calls.map((call): string => call.args.join(" "))).toEqual([`api repos/${SLUG}/issues/12`]);
    expect(result.out).toEqual([
      "(dry run) nothing was written to GitHub; pass --run to apply.",
      "#12  would apply: lang/alpha, job/build, job/test",
      "1 issue(s): 0 applied, 3 would apply, 0 already, 0 failed, 0 listed",
      `ledger: ${join(repo, "label-ledger.jsonl")}`,
    ]);
    expect(ledgerOf(join(repo, "label-ledger.jsonl"))).toEqual([
      "lang/alpha", "job/build", "job/test",
    ].map((label): Record<string, unknown> => ({
      object: "zheref/nen#12",
      label,
      time: "2026-10-04T12:00:00.000Z",
      outcome: "dry-run",
      reason: "reads like a build task; sweep 2026-10-04",
    })));
  });

  it("records a null reason when neither the row nor the flag gave one, and the flag alone when the row has none", async () => {
    const repo = landedRepo();
    const ledger = join(repo, "own.jsonl");
    await capture(apply(repo, plan(repo, [{ issue: 1, lang: ["alpha"] }]), "--ledger", ledger), [issueCall(1, [])]);
    await capture(apply(repo, plan(repo, [{ issue: 1, lang: ["beta"] }]), "--ledger", ledger, "--reason", "flag only"), [issueCall(1, [])]);
    expect(ledgerOf(ledger).map((entry): unknown => entry["reason"])).toEqual([null, "flag only"]);
  });

  it("--ledger resolves against --repo's root, and an absolute one is used as-is", async () => {
    const repo = landedRepo();
    const file = plan(repo, [{ issue: 1, lang: ["alpha"] }]);
    await capture(apply(repo, file, "--ledger", "relative.jsonl"), [issueCall(1, [])]);
    expect(existsSync(join(repo, "relative.jsonl"))).toBe(true);
    const absolute = join(mkdtempSync(join(tmpdir(), "nen-ledger-")), "abs.jsonl");
    await capture(apply(repo, file, "--ledger", absolute), [issueCall(1, [])]);
    expect(existsSync(absolute)).toBe(true);
  });
});

describe("nen classify apply -- low confidence is listed, not applied", () => {
  const rows = [
    { issue: 1, lang: ["alpha"], confidence: "high" },
    { issue: 2, lang: ["beta"], job: ["test"], confidence: "medium" },
    { issue: 3, lang: ["alpha"], job: ["build"], confidence: "low" },
  ];

  it("applies high and medium, lists low, and writes no ledger line for the listed", async () => {
    const repo = landedRepo();
    const result = await capture(apply(repo, plan(repo, rows), "--run"), [
      issueCall(1, []), issueCall(2, []), issueCall(3, []),
      { match: edit(1, "lang/alpha"), result: {} },
      { match: edit(2, "lang/beta"), result: {} },
      { match: edit(2, "job/test"), result: {} },
    ]);
    expect(result.code).toBe(0);
    expect(result.out.slice(0, 3)).toEqual([
      "#1  applied: lang/alpha",
      "#2  applied: lang/beta, job/test",
      "#3  listed: lang/alpha, job/build",
    ]);
    expect(result.seams.calls.filter((call): boolean => call.args[0] === "issue")).toHaveLength(3);
    expect(ledgerOf(join(repo, "label-ledger.jsonl")).map((entry): unknown => entry["object"])).toEqual([
      "zheref/nen#1", "zheref/nen#2", "zheref/nen#2",
    ]);
  });

  it("--include-low applies the low rows too", async () => {
    const repo = landedRepo();
    const result = await capture(apply(repo, plan(repo, [rows[2]]), "--run", "--include-low"), [
      issueCall(3, []),
      { match: edit(3, "lang/alpha"), result: {} },
      { match: edit(3, "job/build"), result: {} },
    ]);
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("#3  applied: lang/alpha, job/build");
  });

  it("a plan of only low rows is a clean exit 0 that wrote nothing", async () => {
    const repo = landedRepo();
    const result = await capture(apply(repo, plan(repo, [rows[2]]), "--run"), [issueCall(3, [])]);
    expect(result.code).toBe(0);
    expect(existsSync(join(repo, "label-ledger.jsonl"))).toBe(false);
  });
});

describe("nen classify apply -- already, and the pull request refusal", () => {
  it("reports a label the issue already carries as 'already' and neither applies nor logs it", async () => {
    const repo = landedRepo();
    const result = await capture(apply(repo, plan(repo, [{ issue: 4, lang: ["alpha"], job: ["build"] }]), "--run"), [
      issueCall(4, ["lang/alpha"]),
      { match: edit(4, "job/build"), result: {} },
    ]);
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("#4  applied: job/build  already: lang/alpha");
    expect(ledgerOf(join(repo, "label-ledger.jsonl")).map((entry): unknown => entry["label"])).toEqual(["job/build"]);
  });

  it("refuses a pull request's number at exit 1 before ANY write, even when the other rows are fine", async () => {
    const repo = landedRepo();
    const result = await capture(apply(repo, plan(repo, [{ issue: 1, lang: ["alpha"] }, { issue: 2, lang: ["beta"] }]), "--run"), [
      issueCall(1, []),
      issueCall(2, [], { pull_request: { url: "https://example.test/pull/2" } }),
    ]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/#2 names a pull request in zheref\/nen/);
    expect(result.seams.calls.filter((call): boolean => call.args[0] === "issue")).toEqual([]);
    expect(existsSync(join(repo, "label-ledger.jsonl"))).toBe(false);
  });

  it("refuses a pull request even on a row that would only be listed", async () => {
    const repo = landedRepo();
    const result = await capture(apply(repo, plan(repo, [{ issue: 2, lang: ["beta"], confidence: "low" }])), [
      issueCall(2, [], { pull_request: {} }),
    ]);
    expect(result.code).toBe(1);
  });

  it("exits 1 when gh cannot read an issue, with nothing written", async () => {
    const repo = landedRepo();
    const result = await capture(apply(repo, plan(repo, [{ issue: 9, lang: ["alpha"] }]), "--run"), [
      { match: gh("api", `repos/${SLUG}/issues/9`), result: { code: 1, stderr: "HTTP 404" } },
    ]);
    expect(result.code).toBe(1);
    expect(existsSync(join(repo, "label-ledger.jsonl"))).toBe(false);
  });
});

describe("nen classify apply --run", () => {
  it("writes each ledger line AFTER its gh edit resolved, never before", async () => {
    const repo = landedRepo();
    const ledger = join(repo, "label-ledger.jsonl");
    const seen: number[] = [];
    await capture(
      apply(repo, plan(repo, [{ issue: 1, lang: ["alpha"], job: ["build"] }]), "--run"),
      [issueCall(1, []), { match: edit(1, "lang/alpha"), result: {} }, { match: edit(1, "job/build"), result: {} }],
      null,
      (_command, args): void => {
        if (args[0] === "issue") seen.push(existsSync(ledger) ? ledgerOf(ledger).length : 0);
      },
    );
    // At the first edit the ledger is absent (0 lines); at the second it holds exactly the first's line.
    expect(seen).toEqual([0, 1]);
    expect(ledgerOf(ledger).map((entry): unknown => entry["outcome"])).toEqual(["applied", "applied"]);
  });

  it("a failing label is named, recorded 'failed', does not stop the rest, and makes the exit 1", async () => {
    const repo = landedRepo();
    const result = await capture(apply(repo, plan(repo, [{ issue: 1, lang: ["alpha"], job: ["build"] }, { issue: 2, lang: ["beta"] }]), "--run"), [
      issueCall(1, []), issueCall(2, []),
      { match: edit(1, "lang/alpha"), result: { code: 1, stderr: "HTTP 403: forbidden" } },
      { match: edit(1, "job/build"), result: {} },
      { match: edit(2, "lang/beta"), result: {} },
    ]);
    expect(result.code).toBe(1);
    expect(result.out[0]).toBe("#1  applied: job/build  failed: lang/alpha");
    expect(result.out[1]).toBe("#2  applied: lang/beta");
    expect(result.err.join("\n")).toMatch(/could not apply lang\/alpha on #1: HTTP 403: forbidden/);
    expect(result.err.join("\n")).toMatch(/1 application\(s\) failed/);
    expect(ledgerOf(join(repo, "label-ledger.jsonl")).map((entry): unknown => entry["outcome"])).toEqual(["failed", "applied", "applied"]);
  });

  it("a gh that cannot be started is a failed application, not an unhandled throw", async () => {
    const repo = landedRepo();
    const result = await capture(apply(repo, plan(repo, [{ issue: 1, lang: ["alpha"] }]), "--run"), [
      issueCall(1, []),
      { match: edit(1, "lang/alpha"), result: { spawnFailed: true, code: -1, stderr: "ENOENT" } },
    ]);
    expect(result.code).toBe(1);
    expect(ledgerOf(join(repo, "label-ledger.jsonl"))[0]?.["outcome"]).toBe("failed");
  });

  it("--json: contract, target, run, ledger, per-issue buckets and totals", async () => {
    const repo = landedRepo();
    const result = await capture(
      apply(repo, plan(repo, [
        { issue: 1, lang: ["alpha"], job: ["build"] },
        { issue: 2, lang: ["beta"], confidence: "low" },
      ]), "--run", "--json"),
      [issueCall(1, ["job/build"]), issueCall(2, []), { match: edit(1, "lang/alpha"), result: {} }],
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({
      contract: "nen.classify.apply/v0.1",
      target: SLUG,
      run: true,
      ledger: join(repo, "label-ledger.jsonl"),
      issues: [
        { number: 1, applied: ["lang/alpha"], wouldApply: [], already: ["job/build"], failed: [], listed: [] },
        { number: 2, applied: [], wouldApply: [], already: [], failed: [], listed: ["lang/beta"] },
      ],
      totals: { issues: 2, applied: 1, wouldApply: 0, already: 1, failed: 0, listed: 1 },
    });
  });

  it("--json on a dry run says run:false and fills wouldApply", async () => {
    const repo = landedRepo();
    const result = await capture(apply(repo, plan(repo, [{ issue: 1, lang: ["alpha"] }]), "--json"), [issueCall(1, [])]);
    const json = JSON.parse(result.out.join("\n")) as { run: boolean; issues: { wouldApply: string[] }[] };
    expect(json.run).toBe(false);
    expect(json.issues[0]?.wouldApply).toEqual(["lang/alpha"]);
  });
});

describe("addLabelArgv", () => {
  it("is gh issue edit <n> --repo <slug> --add-label <label>, one label per call", () => {
    expect(addLabelArgv(TARGET, 12, "lang/alpha")).toEqual(["issue", "edit", "12", "--repo", SLUG, "--add-label", "lang/alpha"]);
  });
});
