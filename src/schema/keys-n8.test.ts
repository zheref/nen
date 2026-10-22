// src/schema/keys-n8.test.ts -- the keys Hatsu's rulings created, modelled and
// validated: nen/contract.json `precedence` (HR-1), nen/workflow.json
// `monitor.localSlotFrees` and `idle` (HR-5), nen/repos.json `families[]`
// (HR-16, zheref/nen#453).

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeContract, parseContract, type RepositoryContract } from "./contract.js";
import { parseRepoRegistry, type RepoRegistry } from "./repos.js";
import { checkTaxonomy, type SchemaCheck } from "./taxonomy.js";
import { parseWorkflow } from "./workflow.js";


// Hatsu's HR-1 order. The plane name lives here, in a test, never in shipped code (§3).
const HR1 = ["skill.hardLimit", "roster.ruling", "nen/decisions.json", "docs/WORKFLOW.md", "docs/PROCESS.md", "akatsuki.CON", "handbooks"];

describe("nen/contract.json precedence (HR-1)", () => {
  const parse = (value: unknown): RepositoryContract => parseContract("<doc>", "nen", value);

  it("reads the full ordered list, first wins, and describes it", () => {
    const contract = parse({ precedence: HR1 });
    expect(contract.precedence).toEqual(HR1);
    expect(describeContract(contract)).toBe(`precedence (7 sources: ${HR1.join(" > ")})`);
  });

  it("checks a <plane>.CON entry by shape: the plane is the repository's to name", () => {
    expect(parse({ precedence: ["one.CON", "other-plane.CON"] }).precedence).toEqual(["one.CON", "other-plane.CON"]);
    expect(() => parse({ precedence: ["Akatsuki.CON"] })).toThrow(/precedence\[0\].*not a precedence source.*<plane>\.CON/);
    expect(() => parse({ precedence: ["akatsuki.con"] })).toThrow(/precedence\[0\]/);
    expect(() => parse({ precedence: [".CON"] })).toThrow(/precedence\[0\]/);
    expect(() => parse({ precedence: ["one.CON", "one.CON"] })).toThrow(/precedence\[1\].*repeats precedence\[0\]/);
  });

  it("is optional: absent reads null", () => {
    expect(parse({ mechanical: { changelog: ["CHANGELOG.md"] } }).precedence).toBeNull();
  });

  it("keeps the repository's own order -- nen never reorders or prefers one", () => {
    expect(parse({ precedence: ["handbooks", "skill.hardLimit"] }).precedence).toEqual(["handbooks", "skill.hardLimit"]);
  });

  it("refuses an empty list", () => {
    expect(() => parse({ precedence: [] })).toThrow(/precedence.*empty array/);
  });

  it("refuses a source outside the vocabulary by pointer, naming the near miss", () => {
    expect(() => parse({ precedence: ["skill.hardLimit", "roster.rulings"] })).toThrow(/precedence\[1\].*not a precedence source.*one edit from 'roster.ruling'/);
  });

  it("refuses a repeated source", () => {
    expect(() => parse({ precedence: ["handbooks", "skill.hardLimit", "handbooks"] })).toThrow(/precedence\[2\].*repeats precedence\[0\]/);
  });

  it("refuses a non-string entry and a non-array value", () => {
    expect(() => parse({ precedence: [1] })).toThrow(/precedence\[0\]/);
    expect(() => parse({ precedence: "handbooks" })).toThrow(/precedence/);
  });

  it("refuses a root key one edit from precedence instead of preserving it unread", () => {
    expect(() => parse({ mechanical: { changelog: ["CHANGELOG.md"] }, precedense: ["handbooks"] })).toThrow(/precedense.*one edit from 'precedence'/);
  });
});

describe("nen/workflow.json monitor.localSlotFrees (HR-5)", () => {
  it("defaults to ready+prompted, undeclared", () => {
    const { monitor } = parseWorkflow("<doc>", {});
    expect(monitor.localSlotFrees).toBe("ready+prompted");
    expect(monitor.localSlotFreesDeclared).toBe(false);
  });

  it.each(["ready+prompted", "merged", "stacked-open"])("reads %s, declared", (rule) => {
    const { monitor } = parseWorkflow("<doc>", { monitor: { localSlotFrees: rule } });
    expect(monitor.localSlotFrees).toBe(rule);
    expect(monitor.localSlotFreesDeclared).toBe(true);
  });

  it("refuses a value outside the closed set", () => {
    expect(() => parseWorkflow("<doc>", { monitor: { localSlotFrees: "open" } })).toThrow(/monitor.localSlotFrees.*CLOSED set: ready\+prompted, merged, stacked-open/);
  });

  it("refuses a near-miss key", () => {
    expect(() => parseWorkflow("<doc>", { monitor: { localSlotFree: "merged" } })).toThrow(/A monitor policy's three keys are/);
  });
});

describe("nen/workflow.json idle (HR-5)", () => {
  const idle = { decisions: { "pick-surface": "default", "merge-order": "hold", "cut-tag": "refuse" }, terminal: "ready-at-merge-prompt", budget: { minutes: 240, tokens: 2000000 } };

  it("is absent by default (null)", () => {
    expect(parseWorkflow("<doc>", {}).idle).toBeNull();
  });

  it("reads decisions, terminal and budget", () => {
    const parsed = parseWorkflow("<doc>", { idle }).idle;
    expect(parsed?.decisions).toEqual(idle.decisions);
    expect(parsed?.terminal).toBe("ready-at-merge-prompt");
    expect(parsed?.budget).toEqual({ minutes: 240, tokens: 2000000 });
  });

  it("tolerates a partial block: each key optional", () => {
    expect(parseWorkflow("<doc>", { idle: { terminal: "x" } }).idle).toMatchObject({ decisions: {}, budget: { minutes: null, tokens: null } });
  });

  it("refuses a resolution outside default|hold|refuse", () => {
    expect(() => parseWorkflow("<doc>", { idle: { decisions: { "pick-surface": "skip" } } })).toThrow(/idle.decisions.pick-surface.*default, hold, refuse/);
  });

  it("refuses a row id that is not a decisions.json slug", () => {
    expect(() => parseWorkflow("<doc>", { idle: { decisions: { Pick_Surface: "default" } } })).toThrow(/idle.decisions.Pick_Surface.*not a decision row id/);
  });

  it("refuses an empty terminal and a non-positive or fractional budget", () => {
    expect(() => parseWorkflow("<doc>", { idle: { terminal: " " } })).toThrow(/idle.terminal/);
    expect(() => parseWorkflow("<doc>", { idle: { budget: { minutes: 0 } } })).toThrow(/idle.budget.minutes/);
    expect(() => parseWorkflow("<doc>", { idle: { budget: { tokens: 1.5 } } })).toThrow(/idle.budget.tokens/);
  });

  it("refuses a near-miss key inside the block and at the root", () => {
    expect(() => parseWorkflow("<doc>", { idle: { decision: {} } })).toThrow(/An idle profile's three keys are/);
    expect(() => parseWorkflow("<doc>", { idles: {} })).toThrow(/A workflow's twenty-one blocks are/);
  });
});

describe("nen schema check's nen/workflow.json#idle row", () => {
  function repo(workflow: unknown, decisions?: unknown): string {
    const root = mkdtempSync(join(tmpdir(), "nen-idle-"));
    mkdirSync(join(root, "nen"));
    writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify(workflow));
    if (decisions !== undefined) writeFileSync(join(root, "nen", "decisions.json"), JSON.stringify(decisions));
    return root;
  }
  const row = (root: string): SchemaCheck | undefined => checkTaxonomy({ repoFlag: root }).checks.find((check) => check.file === "nen/workflow.json#idle");
  const matrix = {
    contract: "nen.decisions/v0.1",
    rows: [
      { id: "pick-surface", class: "ask-once-per-run", preferred: [{ key: "a", label: "Take a", command: "nen a" }] },
      { id: "merge-main", class: "human-gate", gate: "G4" },
    ],
  };

  it("reads none declared when the block is absent", () => {
    expect(row(repo({}))).toMatchObject({ ok: true, detail: "none declared" });
  });

  it("passes an ask-once row", () => {
    expect(row(repo({ idle: { decisions: { "pick-surface": "default" } } }, matrix))).toMatchObject({ ok: true, required: false });
  });

  it("FAILS, required, a row the local matrix declares as a human gate", () => {
    const found = row(repo({ idle: { decisions: { "merge-main": "default" } } }, matrix));
    expect(found).toMatchObject({ ok: false, required: true });
    expect(found?.detail).toMatch(/idle.decisions.merge-main.*'human-gate' row/);
  });

  it("WARNS (never passes) on a row the local matrix does not declare, and on an absent matrix", () => {
    expect(row(repo({ idle: { decisions: { "not-here": "hold" } } }, matrix))).toMatchObject({ ok: false, required: false });
    expect(row(repo({ idle: { decisions: { "pick-surface": "hold" } } }))?.detail).toMatch(/not cross-checked: no nen\/decisions.json here/);
  });
});

describe("nen/repos.json families[] (zheref/nen#453, HR-16)", () => {
  const base = {
    consumers: [],
    product_codes: { RA: "acme/app-ios", RB: "acme/app-android", RC: "acme/app-web" },
  };
  const family = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: "app",
    spec: { repo: "acme/app-spec", role: "spec", gate: "G2" },
    members: [{ code: "RA", platform: "ios" }, { code: "RB", platform: "android" }],
    ...overrides,
  });
  const parse = (families: unknown): RepoRegistry => parseRepoRegistry("<doc>", { ...base, families });

  it("reads a family with its spec and members", () => {
    expect(parse([family()]).families).toEqual([
      { name: "app", index: 0, spec: { repo: "acme/app-spec", role: "spec", gate: "G2" }, members: [{ code: "RA", platform: "ios" }, { code: "RB", platform: "android" }] },
    ]);
  });

  it("reads an absent families[] as none", () => {
    expect(parseRepoRegistry("<doc>", base).families).toEqual([]);
  });

  it("FAILS a typo'd member code by pointer, listing the declared codes", () => {
    expect(() => parse([family({ members: [{ code: "RA" }, { code: "RX" }] })])).toThrow(/families\[0\]\.members\[1\]\.code.*'RX' is not a key of product_codes.*RA, RB, RC/);
  });

  it("matches member codes exactly -- a case slip is a typo", () => {
    expect(() => parse([family({ members: [{ code: "ra" }] })])).toThrow(/members\[0\]\.code/);
  });

  it("refuses a spec gate other than G2 and a role other than spec", () => {
    expect(() => parse([family({ spec: { repo: "acme/app-spec", gate: "G4" } })])).toThrow(/families\[0\]\.spec\.gate.*exactly 'G2'/);
    expect(() => parse([family({ spec: { repo: "acme/app-spec", role: "canon", gate: "G2" } })])).toThrow(/families\[0\]\.spec\.role.*exactly 'spec'/);
    expect(() => parse([family({ spec: { repo: "acme/app-spec" } })])).toThrow(/families\[0\]\.spec\.gate/);
  });

  it("refuses a spec.repo that is not owner/name, and an empty name", () => {
    expect(() => parse([family({ spec: { repo: "app-spec", gate: "G2" } })])).toThrow(/families\[0\]\.spec\.repo.*owner\/name/);
    expect(() => parse([family({ name: "" })])).toThrow(/families\[0\]\.name/);
  });

  it("refuses an empty members list, a code twice in one family, and a code in two families", () => {
    expect(() => parse([family({ members: [] })])).toThrow(/families\[0\]\.members.*empty array/);
    expect(() => parse([family({ members: [{ code: "RA" }, { code: "RA" }] })])).toThrow(/members\[1\]\.code.*listed twice/);
    expect(() => parse([family(), family({ name: "other", members: [{ code: "RB" }] })])).toThrow(/families\[1\]\.members\[0\]\.code.*already a member of family 'app'/);
  });

  it("refuses two families with one name", () => {
    expect(() => parse([family(), family({ name: "APP", members: [{ code: "RC" }] })])).toThrow(/families\[1\]\.name.*duplicates families\[0\]/);
  });
});

describe("nen/workflow.json alwaysOverlaps (NN#488 AC-2)", () => {
  it("reads a list of repository-relative paths and refuses an empty, absolute, climbing or repeated one by pointer", () => {
    expect(parseWorkflow("<doc>", { alwaysOverlaps: ["CHANGELOG.md", "dist/"] }).alwaysOverlaps).toEqual(["CHANGELOG.md", "dist/"]);
    expect(parseWorkflow("<doc>", {}).alwaysOverlaps).toEqual([]);
    for (const bad of [[""], ["/abs"], ["../up"], ["a", "a"], "CHANGELOG.md"]) {
      expect(() => parseWorkflow("<doc>", { alwaysOverlaps: bad })).toThrow(/alwaysOverlaps/);
    }
  });
});

describe("nen/workflow.json idle.localSlotFrees (delivery round on #498, reading 5)", () => {
  it("reads the idle profile's slot rule, refuses a value outside the set, lists keys nen does not read, and refuses two values for one rule", () => {
    expect(parseWorkflow("<doc>", { idle: { localSlotFrees: "merged" } }).idle?.localSlotFrees).toBe("merged");
    expect(() => parseWorkflow("<doc>", { idle: { localSlotFrees: "whenever" } })).toThrow(/idle.localSlotFrees/);
    expect(parseWorkflow("<doc>", { idle: { cadence: "daily", $note: "x" } }).idle?.unreadKeys).toEqual(["cadence"]);
    expect(() => parseWorkflow("<doc>", { idle: { localSlotFrees: "merged" }, monitor: { localSlotFrees: "ready+prompted" } })).toThrow(/State the rule once/);
    expect(parseWorkflow("<doc>", { idle: { localSlotFrees: "merged" }, monitor: { localSlotFrees: "merged" } }).idle?.localSlotFrees).toBe("merged");
  });
});

