import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOWS = join(process.cwd(), ".github", "workflows");
const CANONICAL_GUARD = "github.repository == 'zheref/nen'";
const MATRIX_RUNNER = "${{ fromJSON(matrix.runner) }}";
const ALLOWED_HOSTED = "ubuntu-latest";
const ALLOWED_SELF_HOSTED = new Set([
  JSON.stringify(["self-hosted", "macOS", "ARM64"]),
  JSON.stringify(["self-hosted", "Windows", "X64"]),
]);
const ALLOWED_EVENTS = new Set(["push", "release", "workflow_dispatch"]);

type Row = Record<string, unknown>;

const sources = Object.fromEntries(
  readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => [name, readFileSync(join(WORKFLOWS, name), "utf8")]),
);

function violations(workflows: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [name, source] of Object.entries(workflows)) {
    let document: Row;
    try {
      const parsed: unknown = parse(source);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a map");
      document = parsed as Row;
    } catch {
      found.push(`${name}: invalid workflow YAML`);
      continue;
    }

    const triggers = document.on;
    if (!triggers || typeof triggers !== "object" || Array.isArray(triggers)) {
      found.push(`${name}: triggers must be a map`);
    } else {
      for (const event of Object.keys(triggers as Row)) {
        if (!ALLOWED_EVENTS.has(event)) found.push(`${name}: forbidden event ${event}`);
      }
    }

    const jobs = document.jobs;
    if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
      found.push(`${name}: jobs must be a map`);
      continue;
    }
    for (const [jobName, value] of Object.entries(jobs as Row)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        found.push(`${name}:${jobName}: job must be a map`);
        continue;
      }
      const job = value as Row;
      if (job.if !== CANONICAL_GUARD) {
        found.push(`${name}:${jobName}: guard must exactly bind the canonical repository`);
      }

      if (job["runs-on"] === MATRIX_RUNNER) {
        const strategy = job.strategy as Row | undefined;
        const matrix = strategy?.matrix as Row | undefined;
        const include = matrix?.include;
        if (!matrix || Object.keys(matrix).length !== 1 || !Array.isArray(include) || include.length === 0) {
          found.push(`${name}:${jobName}: runner matrix must have finite include rows`);
          continue;
        }
        for (const row of include) {
          const runner = (row as Row).runner;
          if (runner === JSON.stringify(ALLOWED_HOSTED)) continue;
          if (typeof runner === "string" && ALLOWED_SELF_HOSTED.has(runner)) continue;
          found.push(`${name}:${jobName}: forbidden matrix runner ${String(runner)}`);
        }
      } else if (job["runs-on"] === ALLOWED_HOSTED) {
        // The only hosted exception is an actual Ubuntu job.
      } else if (Array.isArray(job["runs-on"]) && ALLOWED_SELF_HOSTED.has(JSON.stringify(job["runs-on"]))) {
        // Exact standard labels make an offline pool queue without fallback.
      } else {
        found.push(`${name}:${jobName}: forbidden or dynamic runner ${String(job["runs-on"])}`);
      }
    }
  }
  return found;
}

describe("GitHub Actions runner policy", () => {
  it("accepts every committed workflow", () => {
    expect(violations(sources)).toEqual([]);
  });

  it("keeps CI on canonical branch pushes and the declared runner pools", () => {
    const ci = parse(sources["ci.yml"]!) as Row;
    expect(ci.on).toEqual({ push: { branches: ["**"] } });
    const check = (ci.jobs as Row).check as Row;
    const include = ((check.strategy as Row).matrix as Row).include as Row[];
    expect(include.map((row) => row.runner)).toEqual([
      '"ubuntu-latest"',
      '["self-hosted","macOS","ARM64"]',
      '["self-hosted","Windows","X64"]',
    ]);
  });

  it("keeps checkout credentials off self-hosted machines", () => {
    for (const [name, source] of Object.entries(sources)) {
      const checkoutCount = source.match(/uses: actions\/checkout@/g)?.length ?? 0;
      const noCredentialCount = source.match(/persist-credentials: false/g)?.length ?? 0;
      expect(noCredentialCount, name).toBe(checkoutCount);
    }
  });

  it.each([
    ["pinned hosted macOS", "on:\n  push:\njobs:\n  bad:\n    if: github.repository == 'zheref/nen'\n    runs-on: macos-14\n"],
    ["guard with an escape", "on:\n  push:\njobs:\n  bad:\n    if: github.repository == 'zheref/nen' || true\n    runs-on: ubuntu-latest\n"],
    ["step-only guard", "on:\n  push:\njobs:\n  bad:\n    runs-on: ubuntu-latest\n    steps:\n      - if: github.repository == 'zheref/nen'\n        run: true\n"],
    ["fork-triggerable event", "on:\n  pull_request:\njobs:\n  bad:\n    if: github.repository == 'zheref/nen'\n    runs-on: ubuntu-latest\n"],
    ["indirect event", "on:\n  workflow_run:\njobs:\n  bad:\n    if: github.repository == 'zheref/nen'\n    runs-on: ubuntu-latest\n"],
    ["string trigger", "on: push\njobs:\n  bad:\n    if: github.repository == 'zheref/nen'\n    runs-on: ubuntu-latest\n"],
    ["dynamic runner", "on:\n  push:\njobs:\n  bad:\n    if: github.repository == 'zheref/nen'\n    runs-on: ${{ inputs.runner }}\n"],
    ["extra matrix axis", "on:\n  push:\njobs:\n  bad:\n    if: github.repository == 'zheref/nen'\n    runs-on: ${{ fromJSON(matrix.runner) }}\n    strategy:\n      matrix:\n        runner: ['\"macos-14\"']\n        include:\n          - runner: '\"ubuntu-latest\"'\n"],
    ["malformed YAML", "on: [\n"],
  ])("fails closed for %s", (_case, source) => {
    expect(violations({ "regression.yml": source })).not.toEqual([]);
  });
});
