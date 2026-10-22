// The consumer's REAL catalogue shape, held by a test (delivery round on
// zheref/nen#498, reading 1): `nen issue body-check` reads a copy of Hatsu's
// contracts/issue-sections.json (hatsu.issue-sections/v1) and its five issue
// templates, and `nen issue questions` / `nen issue criteria` read the same
// catalogue's row grammar.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { issueCommand } from "./command.js";
import { checkIssueBody, countQuestions, parseCatalogue } from "./shape.js";
import { extractCriteria } from "./criteria.js";

const FIXTURES = join(process.cwd(), "src", "issue", "fixtures", "hatsu-issue-sections");
const RAW = JSON.parse(readFileSync(join(FIXTURES, "issue-sections.json"), "utf8")) as unknown;
const CATALOGUE = parseCatalogue(RAW);
const KINDS = ["product", "defect", "machinery", "canon-gap", "epic"] as const;

const FILLED_DEFECT = [
  "## Problem",
  "The export drops rows.",
  "## Audience and why",
  "Maintainers lose their data.",
  "## Reproduction",
  "Export a saved list twice.",
  "## Acceptance criteria",
  "- AC-1: Given a saved list When the user exports it Then every row appears in the export",
  "- [ ] AC-2: Given an empty list When the user exports it Then the export says so",
  "## Success criteria",
  "- SC-1: 100% of rows survive an export",
  "## Assumptions",
  "None.",
  "## Open questions",
  "- ~~OQ-1~~ → A: keep the order (2026-10-21, HR-4)",
  "## Scope boundaries",
  "Only the export.",
  "## Cross-references",
  "HR-4.",
].join("\n");

async function run(argv: readonly string[], repo: string, json = false): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(issueCommand, argv, repo, json, io, new ScriptedSeams([]));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("Hatsu's hatsu.issue-sections/v1 catalogue, read as it is written", () => {
  it("parses: object sections, required/optional kinds, top-level row rules, common as the no-kind default", () => {
    expect(CATALOGUE.contract).toBe("hatsu.issue-sections/v1");
    expect(Object.keys(CATALOGUE.kinds)).toEqual([...KINDS, "common"]);
    expect(CATALOGUE.defaultKind).toBe("common");
    expect(CATALOGUE.criteriaPrefix).toBe("AC");
    expect(CATALOGUE.criteriaSections).toEqual(["acceptance"]);
    expect(CATALOGUE.questions?.resolvedPattern).toMatch(/OQ/);
  });

  for (const kind of KINDS) {
    it(`reads the ${kind} template: every required section present and empty (only comments), nothing missing`, () => {
      const body = readFileSync(join(FIXTURES, "templates", `${kind}.md`), "utf8");
      const report = checkIssueBody(body, CATALOGUE, kind);
      expect(report.ok).toBe(false);
      expect(report.misses.filter((miss) => miss.kind === "missing")).toEqual([]);
      expect(report.misses.every((miss) => miss.kind === "empty")).toBe(true);
      expect(new Set(report.misses.map((miss) => miss.section))).toEqual(new Set(CATALOGUE.kinds[kind]?.required.concat(CATALOGUE.kinds[kind]?.optional ?? [])));
    });
  }

  it("passes a filled defect body: Given/When/Then rows, a measured SC row, None. under a none section, a dated resolved OQ row", () => {
    const report = checkIssueBody(FILLED_DEFECT, CATALOGUE, "defect");
    expect(report.misses).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.rows.map((row) => row.id)).toEqual(["AC-1", "AC-2", "SC-1", "OQ-1"]);
  });

  it("misses an AC row not in Given/When/Then shape, an unmeasured SC row and an undated resolved OQ row; technology words are advisories", () => {
    const body = FILLED_DEFECT.replace("- AC-1: Given a saved list When the user exports it Then every row appears in the export", "- AC-1: the JSON export keeps every row")
      .replace("- SC-1: 100% of rows survive an export", "- SC-1: rows survive an export")
      .replace("(2026-10-21, HR-4)", "");
    const report = checkIssueBody(body, CATALOGUE, "defect");
    expect(report.misses.map((miss) => `${miss.section}:${miss.kind}`)).toEqual(["acceptance:row-shape", "acceptance:row-order", "success:row-unmeasurable", "open-questions:row-shape"]);
    const tech = checkIssueBody(FILLED_DEFECT.replace("appears in the export", "appears in the JSON export"), CATALOGUE, "defect");
    expect(tech.ok).toBe(true);
    expect(tech.advisories).toEqual([{ kind: "technology", word: "JSON", line: 8 }]);
  });

  it("reads with no --kind against `common` only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-hatsu-catalogue-"));
    writeFileSync(join(dir, "cat.json"), JSON.stringify(RAW));
    writeFileSync(join(dir, "body.md"), FILLED_DEFECT);
    const result = await run(["issue", "body-check", "--body-file", "body.md", "--requirements-from", "cat.json"], dir, true);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect((JSON.parse(result.out) as { kind: string }).kind).toBe("common");
  });

  it("feeds the same grammar to issue questions and issue criteria", async () => {
    expect(countQuestions(FILLED_DEFECT, CATALOGUE.questions ?? undefined).counts).toEqual({ open: 0, resolved: 1, needsMarkers: 0, unrecognised: 0 });
    expect(extractCriteria(FILLED_DEFECT, CATALOGUE).criteria.map((row) => row.id)).toEqual(["AC-1", "AC-2"]);
    const dir = mkdtempSync(join(tmpdir(), "nen-hatsu-catalogue-"));
    writeFileSync(join(dir, "cat.json"), JSON.stringify(RAW));
    writeFileSync(join(dir, "body.md"), FILLED_DEFECT);
    const questions = await run(["issue", "questions", "--body-file", "body.md", "--requirements-from", "cat.json"], dir);
    expect(questions.code).toBe(0);
    expect(questions.out.split("\n")[0]).toMatch(/^0 open, 1 resolved, 0 \[NEEDS\] marker\(s\), 0 unrecognised/);
    const criteria = await run(["issue", "criteria", "--body-file", "body.md", "--requirements-from", "cat.json"], dir);
    expect(criteria.code).toBe(0);
    expect(criteria.out.split("\n")[0]).toMatch(/^2 AC row\(s\)/);
  });
});
