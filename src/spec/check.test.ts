import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedSeams } from "../seam/scripted.js";
import { categoryOf, CLARIFY_TAXONOMY, parseVocabulary, type Finding } from "./check.js";
import { FIXTURE_REPO, fixtureCopy, spec, VOCABULARY } from "./testkit.testkit.js";

const seams = (): ScriptedSeams => new ScriptedSeams([]);
const rules = (findings: unknown): string[] => (findings as Finding[]).map((finding) => `${finding.severity} ${finding.rule} ${finding.file.split("/").pop() ?? ""}:${finding.line ?? "-"}`);

describe("nen spec check --folder", () => {
  it("holds every FR, SC and story line to citation-or-marker and runs analyze's computable passes", async () => {
    const run = await spec(["check", "--folder", "specs/001-sample-feature", "--vocabulary", VOCABULARY], FIXTURE_REPO, seams(), true);
    expect(run.code).toBe(1);
    const report = run.json();
    expect(report["contract"]).toBe("nen.spec.check/v0.1");
    expect(Object.keys(report)).toEqual(["contract", "repo", "mode", "path", "files", "vocabulary", "requirements", "markers", "open", "ranked", "tasks", "findings", "counts"]);
    expect(report["requirements"]).toEqual({ total: 9, cited: 4, marked: 4, ruled: 0, stale: 0, FR: 5, SC: 2, US: 2 });
    expect(report["markers"]).toEqual({ needsClarification: 2, needsRuling: 2, unverified: 2, total: 6 });
    expect(report["tasks"]).toBe("checked");
    expect(rules(report["findings"])).toEqual([
      "CRITICAL inferred-tier spec.md:20",
      "CRITICAL uncited spec.md:22",
      "CRITICAL duplicate-id spec.md:23",
      "CRITICAL inferred-tier spec.md:31",
      "CRITICAL task-cites-unknown-fr tasks.md:5",
      "HIGH several-markers spec.md:32",
      "HIGH placeholder spec.md:22",
      "HIGH fr-without-task spec.md:21",
      "HIGH fr-without-task spec.md:22",
      "MEDIUM vague-term spec.md:20",
    ]);
    expect(report["counts"]).toEqual({ CRITICAL: 5, HIGH: 4, MEDIUM: 1, LOW: 0 });
    // The fenced FR-999 and its TODO are source data: neither defined nor a placeholder.
    expect(JSON.stringify(report)).not.toContain("FR-999");
    expect(report["open"]).toBeNull();
    expect(report["ranked"]).toBeNull();
  });

  it("does not run the vague-term pass without a caller list, and says so", async () => {
    const run = await spec(["check", "--folder", "specs/001-sample-feature"], FIXTURE_REPO, seams());
    expect(run.out.join("\n")).toContain("vocabulary: not supplied (vague-term pass not run)");
    expect(run.out.join("\n")).not.toContain("MEDIUM vague-term");
  });

  it("lists open markers and ranks clarifications by the clarify taxonomy, capped by --max", async () => {
    const all = (await spec(["check", "--folder", "specs/001-sample-feature", "--markers"], FIXTURE_REPO, seams(), true)).json();
    expect((all["open"] as unknown[]).length).toBe(6);
    const ranked = (await spec(["check", "--folder", "specs/001-sample-feature", "--markers", "--rank", "--max", "1"], FIXTURE_REPO, seams(), true)).json();
    expect(ranked["ranked"]).toEqual({
      max: 1,
      total: 2,
      shown: [{ file: "specs/001-sample-feature/spec.md", line: 21, category: "Functional Scope & Behavior", text: "[NEEDS CLARIFICATION: which order wins on a tie?]" }],
    });
    const text = await spec(["check", "--folder", "specs/001-sample-feature", "--markers", "--rank"], FIXTURE_REPO, seams());
    expect(text.out.join("\n")).toContain("2. [Domain & Data Model]");
  });

  it("passes a clean folder at exit 0 and reports tasks absent rather than checked", async () => {
    const run = await spec(["check", "--folder", "specs/002-other-feature"], FIXTURE_REPO, seams(), true);
    expect(run.code).toBe(0);
    expect(run.json()["tasks"]).toBe("absent");
    expect(run.json()["counts"]).toEqual({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 });
  });

  it("refuses a malformed citation, a reversed range and a cited-and-marked line", async () => {
    const repo = fixtureCopy();
    mkdirSync(join(repo, "specs", "003-bad"));
    writeFileSync(join(repo, "specs", "003-bad", "spec.md"), [
      "- **FR-001**: x [src: FX:a.kt:1 @ 0123abcd · declared]",
      "- **FR-002**: y [src: FX:a.kt:9-2 @ 0123abcd · declared]",
      "- **FR-003**: z [src: FX:a.kt:1-2 @ 0123abcd · declared] [UNVERIFIED]",
      "- **SC-001**: w [src: FX:a.kt:1-2 @ 0123abcd · observed] [src: FX:b.kt:1-2 @ 0123abcd · declared]",
      "",
    ].join("\n"));
    const report = (await spec(["check", "--folder", "specs/003-bad"], repo, seams(), true)).json();
    expect(rules(report["findings"])).toEqual(["CRITICAL malformed-citation spec.md:1", "CRITICAL malformed-citation spec.md:2", "HIGH cited-and-marked spec.md:3"]);
  });

  it("exits 1 on a folder that is not there or has no spec.md -- never a clean report", async () => {
    const missing = await spec(["check", "--folder", "specs/404-none"], FIXTURE_REPO, seams());
    expect(missing.code).toBe(1);
    expect(missing.err.join("\n")).toContain("is not a folder");
    const repo = fixtureCopy();
    mkdirSync(join(repo, "specs", "004-empty"));
    const empty = await spec(["check", "--folder", "specs/004-empty"], repo, seams());
    expect(empty.code).toBe(1);
    expect(empty.err.join("\n")).toContain("nothing to check");
  });
});

describe("nen spec check --constitution", () => {
  it("holds the product rules to citation-or-marker and wants a version line", async () => {
    const run = await spec(["check", "--constitution", "--vocabulary", VOCABULARY], FIXTURE_REPO, seams(), true);
    expect(run.code).toBe(1);
    const report = run.json();
    expect(report["mode"]).toBe("constitution");
    expect(report["path"]).toBe(".specify/memory/constitution.md");
    expect(report["tasks"]).toBe("not-applicable");
    expect(rules(report["findings"])).toEqual(["CRITICAL uncited constitution.md:10", "HIGH no-version-line constitution.md:-", "MEDIUM vague-term constitution.md:10"]);
  });

  it("reports a constitution with no product-rules section as LOW, not as clean", async () => {
    const repo = fixtureCopy();
    writeFileSync(join(repo, ".specify", "memory", "constitution.md"), "# C\n\n**Version**: 1.0.0\n\n## Governance\n\n- cite ids\n");
    const run = await spec(["check", "--constitution"], repo, seams(), true);
    expect(run.code).toBe(0);
    expect(rules(run.json()["findings"])).toEqual(["LOW no-product-rules constitution.md:-"]);
  });
});

describe("nen spec check refusals", () => {
  it.each([
    [["check"], "exactly one of"],
    [["check", "--folder", "specs/001-sample-feature", "--constitution"], "exactly one of"],
    [["check", "--constitution", "--rank"], "needs --markers"],
    [["check", "--constitution", "--markers", "--max", "2"], "needs --rank"],
    [["check", "--constitution", "--markers", "--rank", "--max", "0"], "positive whole number"],
    [["check", "--folder", "../up"], "relative path"],
    [["check", "--constitution", "--vocabulary", "/nonexistent/vocab.txt"], "could not be read"],
    [["check", "--constitution", "--write"], "is not read by 'spec check'"],
    [["check", "--constitution", "extra"], "Unexpected positional"],
  ])("%j exits 2 naming the problem", async (argv, words) => {
    const run = await spec(argv, FIXTURE_REPO, seams());
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toContain(words);
  });

  it("requires --repo by name", async () => {
    const run = await spec(["check", "--constitution"], null, seams());
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toContain("--repo <path> is required");
  });
});

describe("check helpers", () => {
  it("maps headings onto the clarify taxonomy, non-functional before functional", () => {
    expect(categoryOf("Non-Functional Requirements")).toBe("Non-Functional Quality Attributes");
    expect(categoryOf("Functional Requirements")).toBe("Functional Scope & Behavior");
    expect(categoryOf("Edge Cases")).toBe("Edge Cases & Failure Handling");
    expect(categoryOf("Assumptions")).toBe("Constraints & Tradeoffs");
    expect(categoryOf("Glossary")).toBe("Terminology & Consistency");
    expect(categoryOf("Success Criteria")).toBe("Completion Signals");
    expect(categoryOf("External integrations")).toBe("Integration & External Dependencies");
    expect(categoryOf("Something else")).toBe("Misc / Placeholders");
    expect(categoryOf(null)).toBe("Misc / Placeholders");
    expect(CLARIFY_TAXONOMY).toHaveLength(10);
  });

  it("reads a vocabulary file: trimmed, de-duplicated, comments and blanks skipped", () => {
    expect(parseVocabulary("# c\r\n fast \n\nfast\nrobust\n")).toEqual(["fast", "robust"]);
  });
});

describe("nen spec check against Hatsu's spec grammar (delivery round on #498, readings 8, 17, 26)", () => {
  const HATSU = join(process.cwd(), "src", "spec", "fixtures", "hatsu-spec-family");

  it("passes a copy of Hatsu's fixture spec at exit 0 with zero CRITICAL: [ruled: CL-nnn], [STALE @ sha] and a US-n heading all read", async () => {
    const run = await spec(["check", "--folder", "specs/001-fixture-capability"], HATSU, seams(), true);
    expect(run.err).toEqual([]);
    expect(run.code).toBe(0);
    const report = run.json();
    expect(report["requirements"]).toEqual({ total: 6, cited: 2, marked: 3, ruled: 1, stale: 1, FR: 4, SC: 1, US: 1 });
    expect((report["counts"] as Record<string, number>)["CRITICAL"]).toBe(0);
  });

  it("is exit 1 with a no-held-lines finding for a spec.md that defines nothing, and flags an unclosed fence", async () => {
    const repo = fixtureCopy();
    mkdirSync(join(repo, "specs", "005-empty"), { recursive: true });
    writeFileSync(join(repo, "specs", "005-empty", "spec.md"), "");
    const empty = await spec(["check", "--folder", "specs/005-empty"], repo, seams(), true);
    expect(empty.code).toBe(1);
    expect(rules(empty.json()["findings"])).toContain("CRITICAL no-held-lines spec.md:-");
    mkdirSync(join(repo, "specs", "006-fence"), { recursive: true });
    writeFileSync(join(repo, "specs", "006-fence", "spec.md"), "- **FR-001**: a. [UNVERIFIED]\n\n```\n- **FR-002**: hidden\n");
    const fence = await spec(["check", "--folder", "specs/006-fence"], repo, seams(), true);
    expect(fence.code).toBe(1);
    expect(rules(fence.json()["findings"])).toContain("CRITICAL unclosed-fence spec.md:3");
  });

  it("refuses at exit 2 a spec.md or tasks.md that resolves outside --repo", async () => {
    const repo = fixtureCopy();
    const outside = mkdtempSync(join(tmpdir(), "nen-spec-outside-"));
    writeFileSync(join(outside, "outside-spec.md"), "- **FR-001**: outside. [UNVERIFIED]\n");
    mkdirSync(join(repo, "specs", "003-x"), { recursive: true });
    symlinkSync(join(outside, "outside-spec.md"), join(repo, "specs", "003-x", "spec.md"));
    const run = await spec(["check", "--folder", "specs/003-x"], repo, seams());
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toMatch(/outside --repo/);
    const index = await spec(["index"], repo, seams());
    expect(index.code).toBe(2);
    mkdirSync(join(repo, "specs", "004-y"), { recursive: true });
    writeFileSync(join(repo, "specs", "004-y", "spec.md"), "- **FR-001**: in. [UNVERIFIED]\n");
    writeFileSync(join(outside, "tasks.md"), "- [ ] T001 FR-001\n");
    symlinkSync(join(outside, "tasks.md"), join(repo, "specs", "004-y", "tasks.md"));
    expect((await spec(["check", "--folder", "specs/004-y"], repo, seams())).code).toBe(2);
  });
});

