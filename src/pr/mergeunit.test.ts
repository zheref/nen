// src/pr/mergeunit.test.ts -- `nen pr merge <ref> --release-unit`: the bounded
// merge's three-gate composition.

import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { PrReadyDeps } from "../verbs/pr_ready.js";
import type { PrStateSource } from "../github/pr_state.js";
import type { PullRequestSnapshot } from "../github/graphql.js";
import { EXIT_GH_REFUSED, MergeUnitUsageError, mergeUnit } from "./mergeunit.js";

// A checkout carrying BOTH nen/workflow.json's release.unitPaths (this
// module's own concern) AND a real nen/gates.json copied from BANKAI_REPO
// (../schema/fixtures/bankai-repo) -- 'pr ready' needs the LATTER to resolve
// reviewer identities, and 'zheref/example#9' is judged against sasuke/tenma
// exactly as ../verbs/pr_ready.test.ts's own `input()`/`stubSource()` fixture
// is.
function unitRepo(unitPaths: readonly string[] | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-merge-unit-"));
  mkdirSync(join(dir, "nen"), { recursive: true });
  const body = unitPaths === undefined ? {} : { release: { unitPaths } };
  writeFileSync(join(dir, "nen", "workflow.json"), JSON.stringify(body));
  copyFileSync(join(BANKAI_REPO, "nen", "gates.json"), join(dir, "nen", "gates.json"));
  return dir;
}

// A fully-passing PR, exactly ../verbs/pr_ready.test.ts's own `stubSource()`
// fixture: two APPROVED reviews at the head SHA, one green required check,
// no owed round. `zheref/example`'s reviewers/approvers -- `sasuke`, `tenma`
// -- are BANKAI_REPO's own nen/gates.json.
function readySource(): PrStateSource {
  const snapshot: PullRequestSnapshot = {
    pullRequest: {
      number: 9,
      mergeable: "MERGEABLE",
      isDraft: false,
      headRefOid: "cafebabe",
      headRefName: "feature/x",
      baseRefName: "main",
      author: { login: "someone" },
      labels: [],
      reviewRequests: [],
    },
    defaultBranch: "main",
    checkRollup: [{ name: "ci / build", status: "COMPLETED", conclusion: "SUCCESS" }],
    checkRollupPageInfo: { hasNextPage: false, endCursor: null },
    reviewRequests: [],
    reviewRequestsPageInfo: { hasNextPage: false, endCursor: null },
  };
  return {
    pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => snapshot,
    reviews: async (): Promise<unknown[]> => [
      { user: { login: "sasuke" }, state: "APPROVED", commit_id: "cafebabe", submitted_at: "2025-01-01T00:00:00Z" },
      { user: { login: "tenma" }, state: "APPROVED", commit_id: "cafebabe", submitted_at: "2025-01-01T00:00:00Z" },
    ],
    reviewThreadsPage: async () => ({ nodes: [], hasNextPage: false, endCursor: null }),
    timeline: async (): Promise<unknown[]> => [],
    checkRollupPage: async (): Promise<never> => {
      throw new Error("should not paginate");
    },
    reviewRequestsPage: async (): Promise<never> => {
      throw new Error("should not paginate");
    },
  };
}

function readyDeps(source: PrStateSource | null): PrReadyDeps {
  return {
    now: (): string => "2025-01-01T00:00:00Z",
    executable: (): string => "/opt/nen/nen-linux-x64",
    openSource: (): { ok: true; source: PrStateSource } | { ok: false; message: string } =>
      source === null ? { ok: false, message: "no usable token" } : { ok: true, source },
    localCheckout: (): null => null,
  };
}

const REQUIREMENTS = [{ name: "how to verify", pattern: "## How to verify" }];
const GOOD_BODY = "## Summary\ndone\n\n## How to verify\nrun the tests\n";

describe("mergeUnit -- the three-gate composition, in order, every gate evaluated", () => {
  it("refuses a ref it cannot parse", async () => {
    const root = unitRepo(["src/unit/**"]);
    await expect(
      mergeUnit({
        typedRef: "not-a-ref",
        repoFlag: root,
        requirements: REQUIREMENTS,
        run: false,
        seams: new ScriptedSeams([]),
        root,
        deps: readyDeps(null),
      }),
    ).rejects.toThrow(MergeUnitUsageError);
  });

  it("plans (no --run) when all three gates pass, and never touches gh's merge endpoint", async () => {
    const root = unitRepo(["src/unit/**"]);
    const script: readonly ScriptedCall[] = [
      { match: "gh pr view 9 --repo zheref/example --json body", result: { code: 0, stdout: JSON.stringify({ body: GOOD_BODY }) } },
      {
        match: "gh pr view 9 --repo zheref/example --json files",
        result: { code: 0, stdout: JSON.stringify({ files: [{ path: "src/unit/a.ts" }] }) },
      },
    ];
    const outcome = await mergeUnit({
      typedRef: "zheref/example#9",
      repoFlag: root,
      requirements: REQUIREMENTS,
      run: false,
      seams: new ScriptedSeams(script),
      root,
      deps: readyDeps(readySource()),
    });
    expect(outcome.report.ok).toBe(true);
    expect(outcome.report.ran).toBe(false);
    expect(outcome.report.mergeArgv).toEqual(["pr", "merge", "9", "--repo", "zheref/example", "--merge"]);
    expect(outcome.lines.join("\n")).toMatch(/pr ready: ready/);
    expect(outcome.lines.join("\n")).toMatch(/plan only \(pass --run to execute\)/);
  });

  it("merges with --run when all three gates pass", async () => {
    const root = unitRepo(["src/unit/**"]);
    const script: readonly ScriptedCall[] = [
      { match: "gh pr view 9 --repo zheref/example --json body", result: { code: 0, stdout: JSON.stringify({ body: GOOD_BODY }) } },
      {
        match: "gh pr view 9 --repo zheref/example --json files",
        result: { code: 0, stdout: JSON.stringify({ files: [{ path: "src/unit/a.ts" }] }) },
      },
      { match: "gh pr merge 9 --repo zheref/example --merge", result: { code: 0, stdout: "" } },
    ];
    const outcome = await mergeUnit({
      typedRef: "zheref/example#9",
      repoFlag: root,
      requirements: REQUIREMENTS,
      run: true,
      seams: new ScriptedSeams(script),
      root,
      deps: readyDeps(readySource()),
    });
    expect(outcome.report.ok).toBe(true);
    expect(outcome.report.ran).toBe(true);
    expect(outcome.lines.join("\n")).toMatch(/^merged: gh pr merge/m);
  });

  it("never calls gh's merge endpoint when a gate fails, and reports every gate's line", async () => {
    const root = unitRepo(["src/unit/**"]);
    const script: readonly ScriptedCall[] = [
      // No 'how to verify' section -- body-check fails.
      { match: "gh pr view 9 --repo zheref/example --json body", result: { code: 0, stdout: JSON.stringify({ body: "## Summary\nno verify section\n" }) } },
      {
        match: "gh pr view 9 --repo zheref/example --json files",
        result: { code: 0, stdout: JSON.stringify({ files: [{ path: "src/unit/a.ts" }] }) },
      },
    ];
    const outcome = await mergeUnit({
      typedRef: "zheref/example#9",
      repoFlag: root,
      requirements: REQUIREMENTS,
      run: true, // --run is IGNORED once a gate fails
      seams: new ScriptedSeams(script), // no 'gh pr merge' entry: throws if ever called
      root,
      deps: readyDeps(readySource()),
    });
    expect(outcome.report.ok).toBe(false);
    expect(outcome.report.ran).toBe(false);
    expect(outcome.report.bodyOk).toBe(false);
    expect(outcome.report.ready).toBe(true);
    expect(outcome.report.unitOk).toBe(true);
    expect(outcome.lines.join("\n")).toMatch(/pr body-check: 0\/1 requirement/);
  });

  it("reports every gate's failure even when 'pr ready' itself is unevaluated", async () => {
    const root = unitRepo(["src/other/**"]);
    const script: readonly ScriptedCall[] = [
      { match: "gh pr view 9 --repo zheref/example --json body", result: { code: 0, stdout: JSON.stringify({ body: GOOD_BODY }) } },
      {
        match: "gh pr view 9 --repo zheref/example --json files",
        result: { code: 0, stdout: JSON.stringify({ files: [{ path: "src/unit/a.ts" }] }) },
      },
    ];
    const outcome = await mergeUnit({
      typedRef: "zheref/example#9",
      repoFlag: root,
      requirements: REQUIREMENTS,
      run: false,
      seams: new ScriptedSeams(script),
      root,
      deps: readyDeps(null), // no usable token -> pr ready is unevaluated
    });
    expect(outcome.report.ok).toBe(false);
    expect(outcome.report.ready).toBe(false);
    expect(outcome.report.bodyOk).toBe(true);
    expect(outcome.report.unitOk).toBe(false); // src/unit/a.ts is outside 'src/other/**'
  });

  it("exits code EXIT_GH_REFUSED's own value is distinct from every other pr exit code", () => {
    expect(EXIT_GH_REFUSED).toBe(5);
  });

  it("reports gh's own refusal and the exact command, without pretending it merged", async () => {
    const root = unitRepo(["src/unit/**"]);
    const script: readonly ScriptedCall[] = [
      { match: "gh pr view 9 --repo zheref/example --json body", result: { code: 0, stdout: JSON.stringify({ body: GOOD_BODY }) } },
      {
        match: "gh pr view 9 --repo zheref/example --json files",
        result: { code: 0, stdout: JSON.stringify({ files: [{ path: "src/unit/a.ts" }] }) },
      },
      { match: "gh pr merge 9 --repo zheref/example --merge", result: { code: 1, stderr: "branch protection: 1 required review is missing" } },
    ];
    const outcome = await mergeUnit({
      typedRef: "zheref/example#9",
      repoFlag: root,
      requirements: REQUIREMENTS,
      run: true,
      seams: new ScriptedSeams(script),
      root,
      deps: readyDeps(readySource()),
    });
    expect(outcome.report.ok).toBe(false);
    expect(outcome.report.ran).toBe(false);
    expect(outcome.report.mergeArgv).toEqual(["pr", "merge", "9", "--repo", "zheref/example", "--merge"]);
    expect(outcome.lines.join("\n")).toMatch(/gh refused -- branch protection/);
    expect(outcome.lines.join("\n")).toMatch(/gh pr merge 9 --repo zheref\/example --merge/);
  });
});
