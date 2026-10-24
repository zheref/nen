import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSeams } from "../seam/exec.js";
import { specSection } from "./coverage.js";
import { MEMBER_SLUG } from "./member.testkit.js";
import { spec } from "./testkit.testkit.js";

const SHA = "a".repeat(40);
const row = (id: string, lines: [number, number]): Record<string, unknown> => ({ id, kind: id.split(":")[0], path: (id.split(":")[1] as string).split("#")[0], lines, sha: SHA, excerptSha256: "0".repeat(64), tier: id.startsWith("test") ? "declared" : "observed", ruleId: null });

function captureWorld(): { repo: string; inventory: string } {
  const repo = mkdtempSync(join(tmpdir(), "nen-spec-cov-"));
  mkdirSync(join(repo, "nen"));
  writeFileSync(join(repo, "nen", "repos.json"), JSON.stringify({ consumers: [], product_codes: { FX: MEMBER_SLUG } }));
  mkdirSync(join(repo, "specs", "001-list"), { recursive: true });
  writeFileSync(
    join(repo, "specs", "001-list", "spec.md"),
    [
      "# Feature Specification: List",
      "- **FR-001**: Shows the list. [src: FX:app/ListScreen.kt:1-5 @ aaaaaaa · observed]",
      "- **FR-002**: Shows the empty state. [src: FX:app/ListFeatureTest.kt:3-3 @ aaaaaaa · declared]",
      "- **FR-003**: Sorts. [NEEDS CLARIFICATION: which order?]",
      "- **SC-001**: Opens fast. [NEEDS RULING]",
      "",
    ].join("\n"),
  );
  writeFileSync(join(repo, "specs", "001-list", "tasks.md"), "- [ ] T001 FR-001 list\n- [ ] T002 FR-009 ghost\n- [x] T003 no id\n");
  const inventory = join(repo, "inventory.json");
  writeFileSync(inventory, JSON.stringify({
    contract: "nen.spec.inventory/v0.1",
    verdict: "read",
    origin: MEMBER_SLUG,
    sha: SHA,
    rows: [row("screen:app/ListScreen.kt", [1, 40]), row("screen:app/SearchScreen.kt", [1, 9]), row("test:app/ListFeatureTest.kt#empty", [3, 3]), row("test:app/ListFeatureTest.kt#sorts", [7, 7])],
    totals: [{ kind: "screen", total: 2, unit: "file" }, { kind: "test", total: 2, unit: "case" }, { kind: "flag", total: null, unit: "unknown" }],
  }));
  return { repo, inventory };
}

describe("nen spec coverage (capture form)", () => {
  it("reports covered over total per kind per member, and the traceability both ways, each with its denominator", async () => {
    const w = captureWorld();
    const run = await spec(["coverage", "--inventory", w.inventory], w.repo, defaultSeams(), true);
    expect(run.code).toBe(0);
    const report = run.json();
    expect(Object.keys(report)).toEqual(["contract", "form", "verdict", "repo", "layout", "folders", "members", "markers", "reason"]);
    expect(report).toMatchObject({ contract: "nen.spec.coverage/v0.1", form: "capture", verdict: "measured", folders: ["specs/001-list"] });
    const [member] = report["members"] as Record<string, unknown>[];
    expect(member).toMatchObject({ code: "FX", origin: MEMBER_SLUG, sha: SHA, reason: null });
    expect(member?.["kinds"]).toEqual([
      { kind: "screen", covered: 1, total: 2, percent: 50 },
      { kind: "test", covered: 1, total: 2, percent: 50 },
      { kind: "flag", covered: 0, total: null, percent: null },
    ]);
    expect(member?.["traceability"]).toEqual({
      requirementsCited: { covered: 2, total: 4, percent: 50 },
      requirementsTested: { covered: 1, total: 4, percent: 25 },
      requirementsTasked: { covered: 1, total: 4, percent: 25 },
      testsCited: { covered: 1, total: 2, percent: 50 },
      tasksTraced: { covered: 1, total: 3, percent: 33.3 },
    });
    expect(report["markers"]).toEqual([{ folder: "specs/001-list", clarification: 1, ruling: 1, unverified: 0 }]);
  });

  it("is partial, exit 1, when an inventory cannot be read or its member has no code", async () => {
    const w = captureWorld();
    const stray = join(w.repo, "stray.json");
    writeFileSync(stray, JSON.stringify({ contract: "nen.spec.inventory/v0.1", origin: "fixture-owner/unregistered", sha: SHA, rows: [], totals: [] }));
    const run = await spec(["coverage", "--inventory", `${w.inventory},${stray},${join(w.repo, "absent.json")}`], w.repo, defaultSeams(), true);
    expect(run.code).toBe(1);
    expect(run.json()["verdict"]).toBe("partial");
    const members = run.json()["members"] as { code: string | null; reason: string | null }[];
    expect(members[1]?.reason).toContain("no product code");
    expect(members[2]?.reason).toContain("could not read");
  });

  it("says could-not-read for a spec root or a folder it cannot read", async () => {
    const w = captureWorld();
    mkdirSync(join(w.repo, "specs", "002-empty"));
    const run = await spec(["coverage", "--inventory", w.inventory], w.repo, defaultSeams(), true);
    expect(run.code).toBe(1);
    expect(run.json()).toMatchObject({ verdict: "could-not-read" });
    const none = await spec(["coverage", "--inventory", w.inventory, "--layout", "features/{nnn}-{slug}"], w.repo, defaultSeams(), true);
    expect(none.json()).toMatchObject({ verdict: "could-not-read" });
  });
});

function bodies(issue: string, pr: string): { issue: string; pr: string } {
  const dir = mkdtempSync(join(tmpdir(), "nen-spec-cov-body-"));
  writeFileSync(join(dir, "issue.md"), issue);
  writeFileSync(join(dir, "pr.md"), pr);
  return { issue: join(dir, "issue.md"), pr: join(dir, "pr.md") };
}

const ISSUE = "## Spec\n\nSpec: specs/002-list@abc1234\n\n- SC: F002-SC-001, F002-SC-002\n\n```source-data\n- **SC-003**: quoted, unqualified\n```\n";

describe("nen spec coverage (delivery form)", () => {
  it("accounts for every success criterion the issue carries, satisfied with a test or deferred with a reason and a follow-up", async () => {
    const b = bodies(ISSUE, "## ✨ What changes\n\nx\n\n## Spec\n\n- F002-SC-001 — satisfied — test ListFeatureTest.empty_F002_SC_001\n- F002-SC-002 — deferred — needs a ruling on the threshold · HA#405\n\n## Agent attribution\n");
    const run = await spec(["coverage", "--issue-body", b.issue, "--pr-body", b.pr], null, defaultSeams(), true);
    expect(run.code).toBe(0);
    const report = run.json();
    expect(Object.keys(report)).toEqual(["contract", "form", "verdict", "issueBody", "prBody", "testReport", "section", "criteria", "outside", "counts", "reason"]);
    expect(report).toMatchObject({ form: "delivery", verdict: "accounted", section: "present", outside: [], counts: { total: 2, accounted: 2, unaccounted: 0 } });
    expect(report["criteria"]).toEqual([
      { id: "F002-SC-001", verdict: "satisfied-unverified", test: "ListFeatureTest.empty_F002_SC_001", reason: null, followUp: null, line: 7 },
      { id: "F002-SC-002", verdict: "deferred", test: null, reason: "needs a ruling on the threshold", followUp: "HA#405", line: 8 },
    ]);
  });

  it("fails a missing or empty Spec section, and an unaccounted, duplicated or incomplete row", async () => {
    for (const [pr, section] of [["## What changes\n\nx\n", "missing"], ["## Spec\n\n## Next\n- F002-SC-001 — satisfied — test a\n", "empty"]] as const) {
      const b = bodies(ISSUE, pr);
      const run = await spec(["coverage", "--issue-body", b.issue, "--pr-body", b.pr], null, defaultSeams(), true);
      expect(run.code).toBe(1);
      expect(run.json()).toMatchObject({ verdict: "unaccounted", section });
    }
    const b = bodies(ISSUE, "## Spec\n\n- F002-SC-001 — satisfied — test a\n- F002-SC-001 — satisfied — test b\n- F002-SC-002 — deferred — later\n");
    const run = await spec(["coverage", "--issue-body", b.issue, "--pr-body", b.pr], null, defaultSeams(), true);
    expect(run.code).toBe(1);
    expect((run.json()["criteria"] as { verdict: string }[]).map((row) => row.verdict)).toEqual(["duplicate", "deferred-incomplete"]);
    const none = bodies("no ids here\n", "## Spec\n\n- nothing\n");
    const empty = await spec(["coverage", "--issue-body", none.issue, "--pr-body", none.pr], null, defaultSeams(), true);
    expect(empty.code).toBe(1);
    expect(String(empty.json()["reason"])).toContain("carries no F<nnn>-SC-### id");
  });

  it("refuses an id the issue does not carry at exit 2", async () => {
    const b = bodies(ISSUE, "## Spec\n\n- F002-SC-001 — satisfied — test a\n- F002-SC-002 — satisfied — test b\n- F002-SC-009 — satisfied — test c\n");
    const run = await spec(["coverage", "--issue-body", b.issue, "--pr-body", b.pr], null, defaultSeams(), true);
    expect(run.code).toBe(2);
    expect(run.json()["outside"]).toEqual(["F002-SC-009"]);
  });

  it("holds each satisfied test to a passing case in the test report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-spec-cov-junit-"));
    const junit = join(dir, "junit.xml");
    writeFileSync(junit, `<?xml version="1.0"?>\n<testsuites><testsuite name="s" tests="2"><testcase classname="ListFeatureTest" name="empty" time="0.1"/><testcase classname="ListFeatureTest" name="sorts" time="0.1"><failure message="no"/></testcase></testsuite></testsuites>\n`);
    const b = bodies(ISSUE, "## Spec\n\n- F002-SC-001 — satisfied — test ListFeatureTest.empty\n- F002-SC-002 — satisfied — test ListFeatureTest.sorts\n");
    const run = await spec(["coverage", "--issue-body", b.issue, "--pr-body", b.pr, "--test-report", junit], null, defaultSeams(), true);
    expect(run.code).toBe(1);
    expect((run.json()["criteria"] as { verdict: string }[]).map((row) => row.verdict)).toEqual(["satisfied", "test-failing"]);
    const missing = bodies(ISSUE, "## Spec\n\n- F002-SC-001 — satisfied — test Nope.none\n- F002-SC-002 — deferred — later · HA#1\n");
    expect((((await spec(["coverage", "--issue-body", missing.issue, "--pr-body", missing.pr, "--test-report", junit], null, defaultSeams(), true)).json()["criteria"]) as { verdict: string }[])[0]?.verdict).toBe("test-not-found");
  });

  it("says could-not-read for an unreadable body or report, and refuses mixing the forms at exit 2", async () => {
    const b = bodies(ISSUE, "## Spec\n");
    const gone = await spec(["coverage", "--issue-body", join(tmpdir(), "absent-issue.md"), "--pr-body", b.pr], null, defaultSeams(), true);
    expect(gone.code).toBe(1);
    expect(gone.json()).toMatchObject({ verdict: "could-not-read" });
    const report = await spec(["coverage", "--issue-body", b.issue, "--pr-body", b.pr, "--test-report", join(tmpdir(), "absent-junit.xml")], null, defaultSeams(), true);
    expect(report.json()).toMatchObject({ verdict: "could-not-read" });
    expect((await spec(["coverage", "--issue-body", b.issue, "--pr-body", b.pr], ".", defaultSeams())).code).toBe(2);
    expect((await spec(["coverage", "--issue-body", b.issue], null, defaultSeams())).code).toBe(2);
    expect((await spec(["coverage"], null, defaultSeams())).code).toBe(2);
  });

  it("reads the Spec section to the next heading of its level, fences skipped", () => {
    expect(specSection("# T\n## 📐 Spec\na\n```\n## not a heading\n```\n### sub\nb\n## Next\nc\n")?.map((line) => line.text)).toEqual(["a", "### sub", "b"]);
    expect(specSection("## Specification\n")).toBeNull();
  });
});
