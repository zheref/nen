// src/quality/tooling.ts -- scenario -> test/perf tooling lookup.
//
// THE TABLE IS THE CALLER'S, ALWAYS. bankai-quality's own tables (E2E harness,
// adversarial layer, perf harness, per scenario) are a specific system's
// canon -- `handbooks/quality-baseline.md` and `stack-matrix.md` in the system
// this ports from -- and are exactly the kind of per-repository vocabulary §3
// keeps out of shipped code. This module is the LOOKUP, not the table: it
// reads a caller-supplied JSON file (the target repository's own tooling
// manifest) and answers "what does THIS scenario resolve to", refusing rather
// than guessing when the scenario is not in the table.

export interface ScenarioTooling {
  readonly e2e: string | null;
  readonly adversarial: string | null;
  readonly notUsed: readonly string[];
  readonly perfHarness: string | null;
  readonly perfDiagnosis: string | null;
}

export type ToolingTable = Readonly<Record<string, Partial<ScenarioTooling>>>;

export interface ToolingLookupResult {
  readonly ok: boolean;
  readonly scenario: string;
  readonly tooling: ScenarioTooling | null;
  readonly reason: string | null;
}

export function parseToolingTable(json: string): ToolingTable {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected a JSON object keyed by scenario name");
  }
  return parsed as ToolingTable;
}

export function resolveTooling(table: ToolingTable, scenario: string): ToolingLookupResult {
  const entry = table[scenario];
  if (entry === undefined) {
    return {
      ok: false,
      scenario,
      tooling: null,
      reason: `'${scenario}' has no entry in this tooling table. Known scenarios: ${Object.keys(table).join(", ") || "(none)"}`,
    };
  }
  return {
    ok: true,
    scenario,
    tooling: {
      e2e: entry.e2e ?? null,
      adversarial: entry.adversarial ?? null,
      notUsed: entry.notUsed ?? [],
      perfHarness: entry.perfHarness ?? null,
      perfDiagnosis: entry.perfDiagnosis ?? null,
    },
    reason: null,
  };
}
