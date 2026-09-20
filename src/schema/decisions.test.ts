import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALT_REPO, BANKAI_REPO } from "./fixtures/paths.js";
import { DECISIONS_CONTRACT, describeDecisions, loadDecisions, mergeDecisions, parseDecisions } from "./decisions.js";
import { checkTaxonomy } from "./taxonomy.js";

function repoWith(document: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "nen-decisions-"));
  mkdirSync(join(root, "nen"), { recursive: true });
  writeFileSync(join(root, "nen", "decisions.json"), JSON.stringify(document));
  return root;
}

describe("loadDecisions -- reads the TARGET repository's nen/decisions.json", () => {
  it("reads the fixture's three rows, one per class", () => {
    const matrix = loadDecisions(BANKAI_REPO);
    expect(matrix.present).toBe(true);
    expect(matrix.rows.map((r): string => r.id)).toEqual(["dirty-tree", "mode-unknown", "semantic-conflict"]);
    expect(matrix.row("dirty-tree")?.class).toBe("autonomous");
    expect(matrix.row("dirty-tree")?.default).toContain("--carry");
    expect(matrix.row("mode-unknown")?.preferred.find((o): boolean => o.recommended)?.key).toBe("A");
    expect(matrix.row("semantic-conflict")?.gate).toBe("G5");
    expect(matrix.row("mode-unknown")?.surfaces["codex"]).toEqual({ picker: "request_user_input" });
    expect(describeDecisions(matrix)).toBe("3 rows: 1 autonomous, 1 ask-once-per-run, 1 human-gate");
  });

  it("an ABSENT file is an empty matrix, never an error", () => {
    const matrix = loadDecisions(ALT_REPO);
    expect(matrix.present).toBe(false);
    expect(matrix.rows).toEqual([]);
    expect(describeDecisions(matrix)).toBe("absent (none declared)");
  });

  it("nen schema check reports the row: ok on the fixture, 'absent (none declared)' elsewhere", () => {
    const withRow = checkTaxonomy({ repoFlag: BANKAI_REPO }).checks.find((c): boolean => c.file === "nen/decisions.json");
    expect(withRow?.ok).toBe(true);
    expect(withRow?.detail).toMatch(/3 rows/);
    const without = checkTaxonomy({ repoFlag: ALT_REPO }).checks.find((c): boolean => c.file === "nen/decisions.json");
    expect(without?.ok).toBe(true);
    expect(without?.required).toBe(false);
    expect(without?.detail).toBe("absent (none declared)");
  });
});

describe("parseDecisions -- refuses by pointer", () => {
  const row = (extra: Record<string, unknown>): unknown => ({ contract: DECISIONS_CONTRACT, rows: [{ id: "x", ...extra }] });

  it("an autonomous row without a default", () => {
    expect(() => parseDecisions("p", row({ class: "autonomous" }))).toThrow(/rows\[0\]\.default.*required/);
  });
  it("a human-gate row without a gate, or with a default", () => {
    expect(() => parseDecisions("p", row({ class: "human-gate" }))).toThrow(/rows\[0\]\.gate.*required/);
    expect(() => parseDecisions("p", row({ class: "human-gate", gate: "G5", default: "x" }))).toThrow(/no default/);
  });
  it("an ask-once-per-run row with no seed options", () => {
    expect(() => parseDecisions("p", row({ class: "ask-once-per-run" }))).toThrow(/preferred.*empty/);
  });
  it("an option that names the report is not an option", () => {
    const doc = row({
      class: "ask-once-per-run",
      preferred: [{ key: "A", label: "open the report", command: "open x.html" }],
    });
    expect(() => parseDecisions("p", doc)).toThrow(/never one of the decisions/);
  });
  it("an option with nothing to execute, two stars, a duplicate id, an unknown class", () => {
    expect(() =>
      parseDecisions("p", row({ class: "ask-once-per-run", preferred: [{ key: "A", label: "do", command: "  " }] })),
    ).toThrow(/command.*empty/);
    expect(() =>
      parseDecisions(
        "p",
        row({
          class: "ask-once-per-run",
          preferred: [
            { key: "A", label: "a", command: "a", recommended: true },
            { key: "B", label: "b", command: "b", recommended: true },
          ],
        }),
      ),
    ).toThrow(/more than one option recommended/);
    expect(() =>
      parseDecisions("p", {
        contract: DECISIONS_CONTRACT,
        rows: [
          { id: "x", class: "autonomous", default: "a" },
          { id: "x", class: "autonomous", default: "b" },
        ],
      }),
    ).toThrow(/declared twice/);
    expect(() => parseDecisions("p", row({ class: "maybe" }))).toThrow(/expected one of/);
  });
  it("a present but malformed file FAILS the schema check by pointer", () => {
    const root = repoWith({ contract: DECISIONS_CONTRACT, rows: [{ id: "Bad Id", class: "autonomous", default: "x" }] });
    const check = checkTaxonomy({ repoFlag: root }).checks.find((c): boolean => c.file === "nen/decisions.json");
    expect(check?.ok).toBe(false);
    expect(check?.required).toBe(true);
    expect(check?.detail).toMatch(/rows\[0\]\.id/);
  });
});

describe("mergeDecisions -- a consumer narrows, never widens", () => {
  const canon = parseDecisions("canon", {
    contract: DECISIONS_CONTRACT,
    rows: [
      { id: "merge", class: "human-gate", gate: "G2" },
      { id: "dirty-tree", class: "ask-once-per-run", preferred: [{ key: "A", label: "carry", command: "nen shu warmup --carry" }] },
    ],
  });
  it("adds rows and may make an ask row autonomous", () => {
    const override = parseDecisions("mine", {
      contract: DECISIONS_CONTRACT,
      rows: [
        { id: "dirty-tree", class: "autonomous", default: "nen shu warmup --carry" },
        { id: "extra", class: "autonomous", default: "true" },
      ],
    });
    const merged = mergeDecisions(canon, override);
    expect(merged.row("dirty-tree")?.class).toBe("autonomous");
    expect(merged.rows.map((r): string => r.id)).toEqual(["merge", "dirty-tree", "extra"]);
  });
  it("refuses to reclassify a human gate", () => {
    const override = parseDecisions("mine", {
      contract: DECISIONS_CONTRACT,
      rows: [{ id: "merge", class: "autonomous", default: "gh pr merge" }],
    });
    expect(() => mergeDecisions(canon, override)).toThrow(/cannot be widened/);
  });
});
