// src/pr/mergeunit.test.ts -- `nen pr merge <ref> --release-unit`: the bounded
// merge's gate composition -- pr ready, head pin, pr body-check, release
// unit-check (policy read from the pull request's BASE), and whose-pr.

import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { PrReadyDeps } from "../verbs/pr_ready.js";
import type { PrRef, PrStateSource } from "../github/pr_state.js";
import type { PullRequestSnapshot } from "../github/graphql.js";
import { EXIT_GH_NOT_RUNNABLE, EXIT_GH_REFUSED, MergeUnitUsageError, mergeUnit } from "./mergeunit.js";

const HEAD = "cafebabe";
const BASE = "deadbeef";

// A checkout carrying a real nen/gates.json copied from BANKAI_REPO
// (../schema/fixtures/bankai-repo) -- 'pr ready' needs it to resolve
// reviewer identities, and 'zheref/example#9' is judged against sasuke/tenma
// exactly as ../verbs/pr_ready.test.ts's own fixture is. This module's OWN
// concern (release.unitPaths) now comes from the pull request's BASE over
// the GitHub API, never from a local nen/workflow.json, so none is written
// here.
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-merge-unit-"));
  mkdirSync(join(dir, "nen"), { recursive: true });
  copyFileSync(join(BANKAI_REPO, "nen", "gates.json"), join(dir, "nen", "gates.json"));
  return dir;
}

// A fully-passing PR, exactly ../verbs/pr_ready.test.ts's own `stubSource()`
// fixture: two APPROVED reviews at the head SHA, one green required check, no
// owed round. `zheref/example`'s reviewers/approvers -- `sasuke`, `tenma` --
// are read from GH_TOKEN-less deps below (pr_ready never touches gates.json
// through this path -- see readyDeps()).
function readySource(head: string = HEAD): PrStateSource {
  const snapshot: PullRequestSnapshot = {
    pullRequest: {
      number: 9,
      mergeable: "MERGEABLE",
      isDraft: false,
      headRefOid: head,
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
      { user: { login: "sasuke" }, state: "APPROVED", commit_id: head, submitted_at: "2025-01-01T00:00:00Z" },
      { user: { login: "tenma" }, state: "APPROVED", commit_id: head, submitted_at: "2025-01-01T00:00:00Z" },
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

const ORIGIN_CALL: ScriptedCall = {
  match: "git remote get-url origin",
  result: { code: 0, stdout: "https://github.com/zheref/example.git\n" },
};

function prOnceCall(overrides: Partial<{ headRefOid: string; baseRefOid: string; body: string; isCrossRepository: boolean; author: string | null; state: string }> = {}): ScriptedCall {
  return {
    match: "gh pr view 9 --repo zheref/example --json headRefOid,baseRefOid,body,isCrossRepository,author,state",
    result: {
      code: 0,
      stdout: JSON.stringify({
        headRefOid: overrides.headRefOid ?? HEAD,
        baseRefOid: overrides.baseRefOid ?? BASE,
        body: overrides.body ?? GOOD_BODY,
        isCrossRepository: overrides.isCrossRepository ?? false,
        author: overrides.author === null ? null : { login: overrides.author ?? "someone" },
        state: overrides.state ?? "OPEN",
      }),
    },
  };
}

function workflowContentsCall(
  unitPaths: readonly (string | { readonly path: string; readonly keys: readonly string[] })[] | null = ["src/unit/**"],
  base: string = BASE,
): ScriptedCall {
  const body = unitPaths === null ? {} : { release: { unitPaths } };
  const content = Buffer.from(JSON.stringify(body)).toString("base64");
  return {
    match: `gh api repos/zheref/example/contents/nen/workflow.json?ref=${base}`,
    result: { code: 0, stdout: JSON.stringify({ content, encoding: "base64" }) },
  };
}

function changedFilesCall(files: readonly { filename: string; previous_filename?: string }[] = [{ filename: "src/unit/a.ts" }]): readonly ScriptedCall[] {
  return [
    { match: "gh api --paginate --slurp repos/zheref/example/pulls/9/files", result: { code: 0, stdout: JSON.stringify(files) } },
    { match: "gh api repos/zheref/example/pulls/9", result: { code: 0, stdout: JSON.stringify({ changed_files: files.length }) } },
  ];
}

function treeCall(entries: readonly { path: string; mode: string }[] = [{ path: "src/unit/a.ts", mode: "100644" }], sha: string = HEAD): ScriptedCall {
  return {
    match: `gh api repos/zheref/example/git/trees/${sha}?recursive=1`,
    result: { code: 0, stdout: JSON.stringify({ tree: entries }) },
  };
}

/** The base tree call: same shape as `treeCall`, keyed on `BASE` unless told otherwise. */
function baseTreeCall(entries: readonly { path: string; mode: string }[] = [{ path: "src/unit/a.ts", mode: "100644" }], base: string = BASE): ScriptedCall {
  return treeCall(entries, base);
}

const VIEWER_CALL: ScriptedCall = { match: "gh api user --jq .login", result: { code: 0, stdout: "someone\n" } };

/** Every call a fully-passing run makes, in the order this module makes them. */
function passingScript(): ScriptedCall[] {
  return [ORIGIN_CALL, prOnceCall(), ...changedFilesCall(), workflowContentsCall(), treeCall(), baseTreeCall(), VIEWER_CALL];
}

async function run(
  root: string,
  script: readonly ScriptedCall[],
  overrides: Partial<Parameters<typeof mergeUnit>[0]> = {},
): ReturnType<typeof mergeUnit> {
  return mergeUnit({
    typedRef: "zheref/example#9",
    repoFlag: root,
    requirements: REQUIREMENTS,
    run: false,
    seams: new ScriptedSeams(script),
    root,
    deps: readyDeps(readySource()),
    ...overrides,
  });
}

describe("mergeUnit -- every gate evaluated, every verdict line quoted", () => {
  it("refuses a ref it cannot parse", async () => {
    const root = tmpRoot();
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

  it("refuses when --repo's origin names a different repository than the ref (item 7)", async () => {
    const root = tmpRoot();
    const script: readonly ScriptedCall[] = [
      { match: "git remote get-url origin", result: { code: 0, stdout: "https://github.com/someone-else/other.git\n" } },
    ];
    await expect(run(root, script)).rejects.toThrow(/must be the same repository/);
  });

  it("plans (no --run) when every gate passes, and never touches gh's merge endpoint", async () => {
    const root = tmpRoot();
    const outcome = await run(root, passingScript());
    expect(outcome.report.ok).toBe(true);
    expect(outcome.report.ran).toBe(false);
    expect(outcome.report.judgedHead).toBe(HEAD);
    expect(outcome.report.mergeArgv).toEqual([
      "pr", "merge", "9", "--repo", "zheref/example", "--merge", "--match-head-commit", HEAD,
    ]);
    expect(outcome.lines.join("\n")).toMatch(/pr ready: ready/);
    expect(outcome.lines.join("\n")).toMatch(/head pin: pinned to cafebabe/);
    expect(outcome.lines.join("\n")).toMatch(/plan only \(pass --run to execute\)/);
  });

  it("merges with --run when every gate passes, carrying the judged SHA in argv (item 3)", async () => {
    const root = tmpRoot();
    const script = [
      ...passingScript(),
      { match: "gh pr merge 9 --repo zheref/example --merge --match-head-commit cafebabe", result: { code: 0, stdout: "" } },
      { match: "gh pr view 9 --repo zheref/example --json state,mergedAt", result: { code: 0, stdout: JSON.stringify({ state: "MERGED", mergedAt: "2025-01-02T00:00:00Z" }) } },
    ];
    const outcome = await run(root, script, { run: true });
    expect(outcome.report.ok).toBe(true);
    expect(outcome.report.ran).toBe(true);
    expect(outcome.report.state).toBe("MERGED");
    expect(outcome.lines.join("\n")).toMatch(/^merged: gh pr merge 9 --repo zheref\/example --merge --match-head-commit cafebabe$/m);
  });

  it("FEI-5: reports 'queued' rather than 'merged' when gh exits 0 but the PR's re-read state is not MERGED", async () => {
    const root = tmpRoot();
    const script = [
      ...passingScript(),
      { match: "gh pr merge 9 --repo zheref/example --merge --match-head-commit cafebabe", result: { code: 0, stdout: "" } },
      { match: "gh pr view 9 --repo zheref/example --json state,mergedAt", result: { code: 0, stdout: JSON.stringify({ state: "OPEN", mergedAt: null }) } },
    ];
    const outcome = await run(root, script, { run: true });
    expect(outcome.report.ok).toBe(true);
    expect(outcome.report.ran).toBe(true);
    expect(outcome.report.state).toBe("OPEN");
    expect(outcome.lines.join("\n")).toMatch(/queued \(auto-merge or merge queue\)/);
  });

  it("never calls gh's merge endpoint when a gate fails, and reports every gate's line", async () => {
    const root = tmpRoot();
    const script = [
      ORIGIN_CALL,
      prOnceCall({ body: "## Summary\nno verify section\n" }), // body-check fails
      ...changedFilesCall(),
      workflowContentsCall(),
      treeCall(),
      baseTreeCall(),
      VIEWER_CALL,
    ];
    const outcome = await run(root, script, { run: true }); // --run is IGNORED once a gate fails
    expect(outcome.report.ok).toBe(false);
    expect(outcome.report.ran).toBe(false);
    expect(outcome.report.bodyOk).toBe(false);
    expect(outcome.report.ready).toBe(true);
    expect(outcome.report.unitOk).toBe(true);
    expect(outcome.lines.join("\n")).toMatch(/pr body-check: 0\/1 requirement/);
  });

  it("reports every gate's failure even when 'pr ready' itself is unevaluated", async () => {
    const root = tmpRoot();
    const script = [
      ORIGIN_CALL,
      prOnceCall(),
      ...changedFilesCall([{ filename: "src/other/a.ts" }]),
      workflowContentsCall(),
      treeCall([{ path: "src/other/a.ts", mode: "100644" }]),
      baseTreeCall([{ path: "src/other/a.ts", mode: "100644" }]),
      VIEWER_CALL,
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
    expect(outcome.report.unitOk).toBe(false); // src/other/a.ts is outside 'src/unit/**'
  });

  it("exit codes are distinct across the family: refused, not-runnable", () => {
    expect(EXIT_GH_REFUSED).toBe(5);
    expect(EXIT_GH_NOT_RUNNABLE).toBe(6);
    expect(EXIT_GH_NOT_RUNNABLE).not.toBe(EXIT_GH_REFUSED);
  });

  it("reports gh's own refusal and the exact command, without pretending it merged", async () => {
    const root = tmpRoot();
    const script = [
      ...passingScript(),
      { match: "gh pr merge 9 --repo zheref/example --merge --match-head-commit cafebabe", result: { code: 1, stderr: "branch protection: 1 required review is missing" } },
    ];
    const outcome = await run(root, script, { run: true });
    expect(outcome.report.ok).toBe(false);
    expect(outcome.report.ran).toBe(false);
    expect(outcome.report.spawnFailed).toBe(false);
    expect(outcome.lines.join("\n")).toMatch(/gh refused -- branch protection/);
    expect(outcome.lines.join("\n")).toMatch(/gh pr merge 9 --repo zheref\/example --merge --match-head-commit cafebabe/);
  });

  it("F8(b): gh spawnFailed on merge is reported distinctly from a refusal, never as exit 5's message", async () => {
    const root = tmpRoot();
    const script = [
      ...passingScript(),
      { match: "gh pr merge 9 --repo zheref/example --merge --match-head-commit cafebabe", result: { code: -1, stderr: "spawn gh ENOENT", spawnFailed: true } },
    ];
    const outcome = await run(root, script, { run: true });
    expect(outcome.report.ok).toBe(false);
    expect(outcome.report.ran).toBe(false);
    expect(outcome.report.spawnFailed).toBe(true);
    expect(outcome.lines.join("\n")).toMatch(/gh could not be run -- spawn gh ENOENT/);
  });

  it("FEI-6: redacts a credential surfaced in gh's own stderr on a merge refusal", async () => {
    const root = tmpRoot();
    const token = "gh" + "p_" + "x".repeat(36);
    const script = [
      ...passingScript(),
      { match: "gh pr merge 9 --repo zheref/example --merge --match-head-commit cafebabe", result: { code: 1, stderr: `remote: authentication failed for token ${token}` } },
    ];
    const outcome = await run(root, script, { run: true });
    expect(outcome.lines.join("\n")).not.toContain(token);
    expect(outcome.lines.join("\n")).toContain("***");
  });

  describe("F7/FEI-1 -- pinned to one head", () => {
    it("refuses when 'pr ready' reports no judged head", async () => {
      const root = tmpRoot();
      const source = readySource();
      const noJudgedHeadSource: PrStateSource = {
        ...source,
        pullRequestSnapshot: async (repo: PrRef, prNumber: number): Promise<PullRequestSnapshot> => {
          const snapshot = await source.pullRequestSnapshot(repo, prNumber);
          if (snapshot.pullRequest === undefined) return snapshot;
          return { ...snapshot, pullRequest: { ...snapshot.pullRequest, headRefOid: "" } };
        },
      };
      const script = [ORIGIN_CALL, prOnceCall(), ...changedFilesCall(), workflowContentsCall(), treeCall(), baseTreeCall(), VIEWER_CALL];
      const outcome = await mergeUnit({
        typedRef: "zheref/example#9",
        repoFlag: root,
        requirements: REQUIREMENTS,
        run: false,
        seams: new ScriptedSeams(script),
        root,
        deps: readyDeps(noJudgedHeadSource),
      });
      expect(outcome.report.ok).toBe(false);
      expect(outcome.report.pinOk).toBe(false);
      expect(outcome.lines.join("\n")).toMatch(/head pin: 'pr ready' reported no judged head/);
    });

    it("refuses when the pull request's head has moved past what 'pr ready' judged, naming both SHAs", async () => {
      const root = tmpRoot();
      const script = [
        ORIGIN_CALL,
        prOnceCall({ headRefOid: "newsha000" }),
        ...changedFilesCall(),
        workflowContentsCall(),
        treeCall([{ path: "src/unit/a.ts", mode: "100644" }], "newsha000"),
        baseTreeCall(),
        VIEWER_CALL,
      ];
      const outcome = await mergeUnit({
        typedRef: "zheref/example#9",
        repoFlag: root,
        requirements: REQUIREMENTS,
        run: false,
        seams: new ScriptedSeams(script),
        root,
        deps: readyDeps(readySource(HEAD)),
      });
      expect(outcome.report.ok).toBe(false);
      expect(outcome.report.pinOk).toBe(false);
      expect(outcome.lines.join("\n")).toMatch(/head pin: 'pr ready' judged cafebabe, but the pull request's head is now newsha000/);
    });

    it("carries --match-head-commit <judgedHead> in the merge argv", async () => {
      const root = tmpRoot();
      const outcome = await run(root, passingScript());
      expect(outcome.report.mergeArgv).toContain("--match-head-commit");
      expect(outcome.report.mergeArgv?.at(-1)).toBe(HEAD);
    });
  });

  describe("FEI-3 -- the release policy is the PR's base's, never this checkout's own file", () => {
    it("exits usage-shaped (throws) when the base declares no release.unitPaths, naming the key", async () => {
      const root = tmpRoot();
      const script = [ORIGIN_CALL, prOnceCall(), ...changedFilesCall(), workflowContentsCall(null), treeCall(), VIEWER_CALL];
      const outcome = await run(root, script);
      expect(outcome.report.unitOk).toBe(false);
      expect(outcome.lines.join("\n")).toMatch(/declares no 'release\.unitPaths'/);
    });

    it("refuses a pull request that itself changes nen/workflow.json", async () => {
      const root = tmpRoot();
      const script = [
        ORIGIN_CALL,
        prOnceCall(),
        ...changedFilesCall([{ filename: "nen/workflow.json" }, { filename: "src/unit/a.ts" }]),
        workflowContentsCall(),
        treeCall([{ path: "nen/workflow.json", mode: "100644" }, { path: "src/unit/a.ts", mode: "100644" }]),
        VIEWER_CALL,
      ];
      const outcome = await run(root, script);
      expect(outcome.report.unitOk).toBe(false);
      expect(outcome.lines.join("\n")).toMatch(/this pull request changes 'nen\/workflow\.json' or 'nen\/gates\.json'/);
    });
  });

  describe("content-scoped release unit -- an object {path, keys} entry (item 4)", () => {
    function contractContentsCall(json: unknown, ref: string): ScriptedCall {
      return {
        match: `gh api repos/zheref/example/contents/nen/contract.json?ref=${ref}`,
        result: { code: 0, stdout: JSON.stringify({ content: Buffer.from(JSON.stringify(json)).toString("base64") }) },
      };
    }

    it("passes when the changed file only touches its declared key (version-only)", async () => {
      const root = tmpRoot();
      const script = [
        ORIGIN_CALL,
        prOnceCall(),
        ...changedFilesCall([{ filename: "nen/contract.json" }]),
        workflowContentsCall([{ path: "nen/contract.json", keys: ["version"] }]),
        treeCall([{ path: "nen/contract.json", mode: "100644" }]),
        baseTreeCall([{ path: "nen/contract.json", mode: "100644" }]),
        contractContentsCall({ version: "1.0.0", description: "same" }, BASE),
        contractContentsCall({ version: "1.0.1", description: "same" }, HEAD),
        VIEWER_CALL,
      ];
      const outcome = await run(root, script);
      expect(outcome.report.unitOk).toBe(true);
    });

    it("fails and names 'description' when the changed file also touches an undeclared key (version + description)", async () => {
      const root = tmpRoot();
      const script = [
        ORIGIN_CALL,
        prOnceCall(),
        ...changedFilesCall([{ filename: "nen/contract.json" }]),
        workflowContentsCall([{ path: "nen/contract.json", keys: ["version"] }]),
        treeCall([{ path: "nen/contract.json", mode: "100644" }]),
        baseTreeCall([{ path: "nen/contract.json", mode: "100644" }]),
        contractContentsCall({ version: "1.0.0", description: "old" }, BASE),
        contractContentsCall({ version: "1.0.1", description: "new" }, HEAD),
        VIEWER_CALL,
      ];
      const outcome = await run(root, script);
      expect(outcome.report.unitOk).toBe(false);
      expect(outcome.lines.join("\n")).toMatch(/description/);
    });

    it("fails closed when the declared file is not valid JSON at one of the two refs", async () => {
      const root = tmpRoot();
      const script: ScriptedCall[] = [
        ORIGIN_CALL,
        prOnceCall(),
        ...changedFilesCall([{ filename: "nen/contract.json" }]),
        workflowContentsCall([{ path: "nen/contract.json", keys: ["version"] }]),
        treeCall([{ path: "nen/contract.json", mode: "100644" }]),
        baseTreeCall([{ path: "nen/contract.json", mode: "100644" }]),
        {
          match: `gh api repos/zheref/example/contents/nen/contract.json?ref=${BASE}`,
          result: { code: 0, stdout: JSON.stringify({ content: Buffer.from("not json").toString("base64") }) },
        },
        contractContentsCall({ version: "1.0.1" }, HEAD),
        VIEWER_CALL,
      ];
      const outcome = await run(root, script);
      expect(outcome.report.unitOk).toBe(false);
      expect(outcome.lines.join("\n")).toMatch(/unreadable or not valid JSON/);
    });
  });

  describe("FEI-8 -- a changed path inside the unit that is a symlink or submodule is refused", () => {
    it("refuses a symlink (mode 120000) inside the release unit", async () => {
      const root = tmpRoot();
      const script = [ORIGIN_CALL, prOnceCall(), ...changedFilesCall(), workflowContentsCall(), treeCall([{ path: "src/unit/a.ts", mode: "120000" }]), baseTreeCall([{ path: "src/unit/a.ts", mode: "120000" }]), VIEWER_CALL];
      const outcome = await run(root, script);
      expect(outcome.report.unitOk).toBe(false);
      expect(outcome.lines.join("\n")).toMatch(/is a symlink \(mode 120000\)/);
    });

    it("refuses a submodule (mode 160000) inside the release unit", async () => {
      const root = tmpRoot();
      const script = [ORIGIN_CALL, prOnceCall(), ...changedFilesCall(), workflowContentsCall(), treeCall([{ path: "src/unit/a.ts", mode: "160000" }]), baseTreeCall([{ path: "src/unit/a.ts", mode: "160000" }]), VIEWER_CALL];
      const outcome = await run(root, script);
      expect(outcome.report.unitOk).toBe(false);
      expect(outcome.lines.join("\n")).toMatch(/is a submodule \(mode 160000\)/);
    });

    it("refuses a PR that DELETES a symlink inside the unit (present only in the base tree)", async () => {
      const root = tmpRoot();
      const script = [
        ORIGIN_CALL,
        prOnceCall(),
        ...changedFilesCall([{ filename: "src/unit/a.ts" }]),
        workflowContentsCall(),
        treeCall([]), // deleted -- absent from the head tree
        baseTreeCall([{ path: "src/unit/a.ts", mode: "120000" }]),
        VIEWER_CALL,
      ];
      const outcome = await run(root, script);
      expect(outcome.report.unitOk).toBe(false);
      expect(outcome.lines.join("\n")).toMatch(/"src\/unit\/a\.ts" inside the release unit is a symlink \(mode 120000\)/);
    });

    it("refuses a rename whose PREVIOUS path was a submodule at the base", async () => {
      const root = tmpRoot();
      const script = [
        ORIGIN_CALL,
        prOnceCall(),
        ...changedFilesCall([{ filename: "src/unit/b.ts", previous_filename: "src/unit/a.ts" }]),
        workflowContentsCall(),
        treeCall([{ path: "src/unit/b.ts", mode: "100644" }]),
        baseTreeCall([{ path: "src/unit/a.ts", mode: "160000" }]),
        VIEWER_CALL,
      ];
      const outcome = await run(root, script);
      expect(outcome.report.unitOk).toBe(false);
      expect(outcome.lines.join("\n")).toMatch(/"src\/unit\/a\.ts" inside the release unit is a submodule \(mode 160000\)/);
    });

    it("refuses a truncated recursive tree rather than reporting it clean", async () => {
      const root = tmpRoot();
      const script = [
        ORIGIN_CALL,
        prOnceCall(),
        ...changedFilesCall(),
        workflowContentsCall(),
        { match: `gh api repos/zheref/example/git/trees/${HEAD}?recursive=1`, result: { code: 0, stdout: JSON.stringify({ tree: [{ path: "src/unit/a.ts", mode: "100644" }], truncated: true }) } },
        VIEWER_CALL,
      ];
      const outcome = await run(root, script);
      expect(outcome.report.unitOk).toBe(false);
      expect(outcome.lines.join("\n")).toMatch(/truncated/);
    });
  });

  describe("FEI-4 -- whose pull request this is", () => {
    it("refuses a cross-repository (fork) pull request", async () => {
      const root = tmpRoot();
      const script = [ORIGIN_CALL, prOnceCall({ isCrossRepository: true }), ...changedFilesCall(), workflowContentsCall(), treeCall(), baseTreeCall(), VIEWER_CALL];
      const outcome = await run(root, script);
      expect(outcome.report.wholeOk).toBe(false);
      expect(outcome.lines.join("\n")).toMatch(/whose pr: this pull request is cross-repository/);
    });

    it("refuses a pull request whose author is not the authenticated viewer", async () => {
      const root = tmpRoot();
      const script = [ORIGIN_CALL, prOnceCall({ author: "someone-else" }), ...changedFilesCall(), workflowContentsCall(), treeCall(), baseTreeCall(), VIEWER_CALL];
      const outcome = await run(root, script);
      expect(outcome.report.wholeOk).toBe(false);
      expect(outcome.lines.join("\n")).toMatch(/author is 'someone-else', but the viewer authenticated as 'someone'/);
    });
  });

  describe("F8(a) -- a unit-gate gh failure still lets ready and body gates report", () => {
    it("does not let a thrown tree-fetch failure abort the whole run", async () => {
      const root = tmpRoot();
      const script = [
        ORIGIN_CALL,
        prOnceCall(),
        ...changedFilesCall(),
        workflowContentsCall(),
        { match: `gh api repos/zheref/example/git/trees/${HEAD}?recursive=1`, result: { code: 1, stderr: "gh: not found" } },
        VIEWER_CALL,
      ];
      const outcome = await run(root, script);
      expect(outcome.report.unitOk).toBe(false);
      expect(outcome.report.ready).toBe(true);
      expect(outcome.report.bodyOk).toBe(true);
      expect(outcome.lines.join("\n")).toMatch(/pr ready: ready/);
      expect(outcome.lines.join("\n")).toMatch(/pr body-check: 1\/1 requirement/);
    });
  });
});
