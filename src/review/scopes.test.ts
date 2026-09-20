// src/review/scopes.test.ts -- `nen review scopes`: the classification, and
// the three exits.
//
// THE POLICY IS A REAL FILE IN A TEMPORARY TREE, not a hand-built object: the
// point of this verb is that the scope table is the REPOSITORY's, so the test
// writes a `nen/workflow.json` and lets the shipped loader read it. A table
// that only ever exists as a TypeScript literal is a table nobody has proved
// the schema accepts.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { loadWorkflow } from "../schema/workflow.js";
import { reviewCommand } from "./command.js";
import { assembleScopes, classifyScopes, SCOPES_CONTRACT } from "./scopes.js";

const NOW = new Date("2026-09-20T12:00:00.000Z");

const SCOPES = {
  code: { persona: "nobunaga", tier: "deep", budget: 2, paths: ["**"] },
  security: { persona: "feitan", tier: "deep", budget: 1, paths: ["hooks/**", "nen/contract.json"] },
  architecture: { persona: "chrollo", tier: "deep", budget: 1, paths: ["docs/ROSTER.md", "nen/*.json"] },
};

function repoWith(review: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "nen-review-"));
  mkdirSync(join(root, "nen"), { recursive: true });
  writeFileSync(
    join(root, "nen", "workflow.json"),
    JSON.stringify(review === undefined ? { branch: { base: "main" } } : { review }),
    "utf8",
  );
  return root;
}

const DIFF = ["hooks/pre-commit.sh", "nen/contract.json", "docs/ROSTER.md", "README.md"].join("\n");

function script(diff = DIFF, base = "origin/main"): ScriptedCall[] {
  return [
    { match: `git rev-parse --verify --quiet ${base}^{commit}`, result: { code: 0, stdout: "abc123\n" } },
    { match: `git diff --name-only ${base}...HEAD`, result: { code: 0, stdout: diff } },
  ];
}

interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

async function capture(argv: readonly string[], calls: readonly ScriptedCall[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push(line),
  };
  const seams = new ScriptedSeams(calls, { now: (): Date => NOW, platform: "linux" });
  const code = await runFamily(reviewCommand, argv, null, false, io, seams);
  return { code, out, err };
}

describe("classifyScopes", () => {
  it("lets ONE path raise SEVERAL scopes -- a file has one tier and any number of readers", () => {
    const classified = classifyScopes(["nen/contract.json"], SCOPES);
    expect(classified.scopes.map((scope): string => scope.scope)).toEqual(["code", "security", "architecture"]);
    expect(classified.unclaimed).toEqual([]);
  });

  it("reports raised scopes in the DECLARATION's order, never the diff's", () => {
    const classified = classifyScopes(["docs/ROSTER.md", "hooks/x.sh"], SCOPES);
    expect(classified.scopes.map((scope): string => scope.scope)).toEqual(["code", "security", "architecture"]);
    expect(classified.scopes[1]?.paths).toEqual(["hooks/x.sh"]);
  });

  it("reports an unclaimed path rather than swallowing it", () => {
    const classified = classifyScopes(["docs/ROSTER.md", "src/deep/a.ts"], {
      architecture: SCOPES.architecture,
    });
    expect(classified.scopes).toHaveLength(1);
    expect(classified.unclaimed).toEqual(["src/deep/a.ts"]);
  });

  it("leaves a scope OUT when nothing raised it, rather than listing it empty", () => {
    const classified = classifyScopes(["README.md"], { security: SCOPES.security });
    expect(classified.scopes).toEqual([]);
    expect(classified.unclaimed).toEqual(["README.md"]);
  });
});

describe("assembleScopes", () => {
  it("states the contract, the base and the file count", () => {
    const root = repoWith({ scopes: SCOPES });
    const report = assembleScopes(DIFF.split("\n"), "origin/main", loadWorkflow(root).workflow);
    expect(report.contract).toBe(SCOPES_CONTRACT);
    expect(report.base).toBe("origin/main");
    expect(report.files).toBe(4);
    expect(Object.keys(report)).toEqual(["contract", "base", "files", "scopes", "unclaimed"]);
  });
});

describe("nen review scopes", () => {
  it("classifies the diff at exit 0 and carries the document under --json", async () => {
    const root = repoWith({ scopes: SCOPES });
    const captured = await capture(["review", "scopes", "--base", "origin/main", "--repo", root, "--json"], script());
    expect(captured.code).toBe(0);
    const document = JSON.parse(captured.out.join("\n")) as { scopes: { scope: string; persona: string }[]; unclaimed: string[] };
    expect(document.scopes.map((scope): string => scope.persona)).toEqual(["nobunaga", "feitan", "chrollo"]);
    // `code` claims `**`, so nothing is unclaimed in this table.
    expect(document.unclaimed).toEqual([]);
  });

  it("prints the raised scopes and the unclaimed list in the human rendering", async () => {
    const root = repoWith({ scopes: { security: SCOPES.security } });
    const captured = await capture(["review", "scopes", "--base", "origin/main", "--repo", root], script());
    expect(captured.code).toBe(0);
    const text = captured.out.join("\n");
    expect(text).toContain("base 'origin/main': 4 changed file(s)");
    expect(text).toContain("security  feitan (deep, budget 1)  2 path(s)");
    expect(text).toMatch(/unclaimed: 2 path\(s\) no scope claims/);
  });

  it("says NOTHING WAS CLASSIFIED on an empty diff, not 'every path is claimed' (N10)", async () => {
    // Zero changed paths is not a clean table: the table was never exercised,
    // so it has been neither proved nor found wanting, and the old sentence
    // read as a finding it had not made.
    const root = repoWith({ scopes: SCOPES });
    const captured = await capture(["review", "scopes", "--base", "origin/main", "--repo", root], script(""));
    expect(captured.code).toBe(0);
    const text = captured.out.join("\n");
    expect(text).toContain("nothing classified: 'origin/main...HEAD' carries no changed path");
    expect(text).not.toContain("every changed path is claimed");
  });

  it("exits 1, NAMED, when the repository declares no review block", async () => {
    const root = repoWith(undefined);
    const captured = await capture(["review", "scopes", "--base", "origin/main", "--repo", root], script());
    expect(captured.code).toBe(1);
    expect(captured.err.join("\n")).toMatch(/declares no 'review' block/);
    expect(captured.err.join("\n")).toMatch(/"persona"/);
  });

  it("exits 2 on an unresolvable --base, with nothing read", async () => {
    const root = repoWith({ scopes: SCOPES });
    const captured = await capture(["review", "scopes", "--base", "nope", "--repo", root], [
      { match: "git rev-parse --verify --quiet nope^{commit}", result: { code: 1, stdout: "" } },
    ]);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--base 'nope' does not resolve to a commit/);
  });

  it("exits 2 on a malformed review block, refused BY POINTER by the policy loader", async () => {
    const root = repoWith({ scopes: { security: { persona: "feitan", tier: "deep", budget: 1, paths: [] } } });
    const captured = await capture(["review", "scopes", "--base", "origin/main", "--repo", root], script());
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/review\.scopes\.security\.paths/);
  });

  it("refuses a missing --base by name", async () => {
    const root = repoWith({ scopes: SCOPES });
    const captured = await capture(["review", "scopes", "--repo", root], []);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--base is required/);
  });

  it("refuses a subcommand it has not got, naming the one it has", async () => {
    const captured = await capture(["review", "raise"], []);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/unknown 'review' subcommand 'raise'\. Known: scopes\./);
  });
});
