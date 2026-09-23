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
        const configuration = (triggers as Row)[event];
        if (
          configuration !== null &&
          (typeof configuration !== "object" || Array.isArray(configuration))
        ) {
          found.push(`${name}: ${event} configuration must be null or a map`);
        }
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

  it("signs, verifies and executes the darwin binary before the manifest, and executes the linux one on Ubuntu before anything is attached (zheref/nen#233)", () => {
    const release = parse(sources["release-assets.yml"]!) as Row;
    const jobs = release.jobs as Row;
    expect(Object.keys(jobs)).toEqual(["build", "publish"]);
    const build = jobs.build as Row;
    const publish = jobs.publish as Row;
    expect(build["runs-on"]).toEqual(["self-hosted", "macOS", "ARM64"]);
    expect(publish["runs-on"]).toBe("ubuntu-latest");
    expect(publish.needs).toBe("build");
    // Only the job that attaches assets holds the elevation and the token.
    expect((build.permissions as Row | undefined)?.contents).toBeUndefined();
    expect((publish.permissions as Row).contents).toBe("write");
    expect((build.env as Row).GH_TOKEN).toBeUndefined();
    expect((publish.env as Row).GH_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");

    const names = (job: Row): string[] => (job.steps as Row[]).map((step) => String(step.name));
    const runOf = (job: Row, name: string): string => String((job.steps as Row[]).find((step) => step.name === name)?.run ?? "");
    const buildNames = names(build);
    const sign = buildNames.indexOf("Sign the darwin binary after the bundle, verify it, and execute it");
    const manifest = buildNames.indexOf("Write dist/SHA256SUMS from the bytes about to be uploaded");
    const compile = buildNames.indexOf("Cross-compile the three release binaries");
    expect(compile).toBeGreaterThanOrEqual(0);
    expect(sign).toBeGreaterThan(compile);
    expect(manifest).toBeGreaterThan(sign);
    const signRun = runOf(build, buildNames[sign]!);
    expect(signRun).toContain("codesign -s - --force dist/nen-darwin-arm64");
    expect(signRun).toContain("codesign -v dist/nen-darwin-arm64");
    expect(signRun).toContain("./dist/nen-darwin-arm64 --version");
    expect(signRun).toContain('[ "${printed}" = "${expected}" ]');
    expect(signRun).toContain("set -euo pipefail");
    // The publish side: verify, execute the linux binary, THEN attach.
    const publishNames = names(publish);
    const verify = publishNames.indexOf("Verify the received set is intact and COMPLETE");
    const smoke = publishNames.indexOf("The linux binary answers --version");
    // The first of the per-asset attach steps (zheref/nen#228).
    const attach = publishNames.indexOf("Attach nen-darwin-arm64 (bounded, retried)");
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(smoke).toBeGreaterThan(verify);
    expect(attach).toBeGreaterThan(smoke);
    const smokeRun = runOf(publish, publishNames[smoke]!);
    expect(smokeRun).toContain("./dist/nen-linux-x64 --version");
    expect(smokeRun).toContain('[ "${printed}" = "${EXPECTED_VERSION}" ]');
    expect((publish.env as Row).EXPECTED_VERSION).toBe("${{ needs.build.outputs.version }}");
    // Nothing on the publish side rebuilds: no bun, no checkout.
    expect((publish.steps as Row[]).some((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"))).toBe(false);
    expect(publishNames.some((name) => /compile|bun/i.test(name))).toBe(false);
  });

  it("keeps credentials off every actual checkout step", () => {
    for (const [name, source] of Object.entries(sources)) {
      const workflow = parse(source) as Row;
      for (const [jobName, value] of Object.entries(workflow.jobs as Row)) {
        const steps = (value as Row).steps;
        expect(Array.isArray(steps), `${name}:${jobName}`).toBe(true);
        for (const step of steps as Row[]) {
          if (typeof step.uses !== "string" || !step.uses.startsWith("actions/checkout@")) continue;
          expect((step.with as Row | undefined)?.["persist-credentials"], `${name}:${jobName}`).toBe(
            false,
          );
        }
      }
    }
  });

  it.each([
    ["pinned hosted macOS", "on:\n  push:\njobs:\n  bad:\n    if: github.repository == 'zheref/nen'\n    runs-on: macos-14\n"],
    ["guard with an escape", "on:\n  push:\njobs:\n  bad:\n    if: github.repository == 'zheref/nen' || true\n    runs-on: ubuntu-latest\n"],
    ["step-only guard", "on:\n  push:\njobs:\n  bad:\n    runs-on: ubuntu-latest\n    steps:\n      - if: github.repository == 'zheref/nen'\n        run: true\n"],
    ["fork-triggerable event", "on:\n  pull_request:\njobs:\n  bad:\n    if: github.repository == 'zheref/nen'\n    runs-on: ubuntu-latest\n"],
    ["indirect event", "on:\n  workflow_run:\njobs:\n  bad:\n    if: github.repository == 'zheref/nen'\n    runs-on: ubuntu-latest\n"],
    ["string trigger", "on: push\njobs:\n  bad:\n    if: github.repository == 'zheref/nen'\n    runs-on: ubuntu-latest\n"],
    ["malformed event configuration", "on:\n  push: bad\njobs:\n  bad:\n    if: github.repository == 'zheref/nen'\n    runs-on: ubuntu-latest\n"],
    ["dynamic runner", "on:\n  push:\njobs:\n  bad:\n    if: github.repository == 'zheref/nen'\n    runs-on: ${{ inputs.runner }}\n"],
    ["extra matrix axis", "on:\n  push:\njobs:\n  bad:\n    if: github.repository == 'zheref/nen'\n    runs-on: ${{ fromJSON(matrix.runner) }}\n    strategy:\n      matrix:\n        runner: ['\"macos-14\"']\n        include:\n          - runner: '\"ubuntu-latest\"'\n"],
    ["duplicate workflow key", "on:\n  push:\n  push:\njobs: {}\n"],
    ["malformed YAML", "on: [\n"],
  ])("fails closed for %s", (_case, source) => {
    expect(violations({ "regression.yml": source })).not.toEqual([]);
  });
});
