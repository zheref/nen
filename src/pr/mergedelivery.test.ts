// src/pr/mergedelivery.test.ts -- `nen pr merge <ref> --delivery`
// (zheref/nen#286, narrowed by the maintainer's ruling of 2026-10-03): a run's
// own pull request into a NON-MAIN base. The trunk is refused by
// construction; every other gate is ./mergeunit.ts's.

import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { PrReadyDeps } from "../verbs/pr_ready.js";
import type { PrStateSource } from "../github/pr_state.js";
import type { PullRequestSnapshot } from "../github/graphql.js";
import { MergeUnitUsageError } from "./mergeunit.js";
import { MERGE_DELIVERY_CONTRACT, mergeDelivery } from "./mergedelivery.js";

const HEAD = "cafebabe";
const INTEGRATION = "opus/kurapika/futon-integration";

function tmpRoot(workflow: unknown = null): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-merge-delivery-"));
  mkdirSync(join(dir, "nen"), { recursive: true });
  copyFileSync(join(BANKAI_REPO, "nen", "gates.json"), join(dir, "nen", "gates.json"));
  if (workflow !== null) writeFileSync(join(dir, "nen", "workflow.json"), JSON.stringify(workflow));
  return dir;
}

/** ./mergeunit.test.ts's own passing fixture, with the base set to the integration branch. */
function readySource(head: string = HEAD): PrStateSource {
  const snapshot: PullRequestSnapshot = {
    pullRequest: {
      number: 9,
      mergeable: "MERGEABLE",
      isDraft: false,
      headRefOid: head,
      headRefName: "feature/x",
      baseRefName: INTEGRATION,
      baseRefOid: "basebase",
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
    fileAtRef: async (): Promise<string | null> => null,
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

const ORIGIN_CALL: ScriptedCall = {
  match: "git remote get-url origin",
  result: { code: 0, stdout: "https://github.com/zheref/example.git\n" },
};

function prOnceCall(overrides: Partial<{ headRefOid: string; baseRefName: string; body: string; author: string; isCrossRepository: boolean }> = {}): ScriptedCall {
  return {
    match: "gh pr view 9 --repo zheref/example --json headRefOid,baseRefOid,baseRefName,body,isCrossRepository,author,state",
    result: {
      code: 0,
      stdout: JSON.stringify({
        headRefOid: overrides.headRefOid ?? HEAD,
        baseRefOid: "basebase",
        baseRefName: overrides.baseRefName ?? INTEGRATION,
        body: overrides.body ?? "## How to verify\nrun it\n",
        isCrossRepository: overrides.isCrossRepository ?? false,
        author: { login: overrides.author ?? "someone" },
        state: "OPEN",
      }),
    },
  };
}

function defaultBranchCall(name: string = "main"): ScriptedCall {
  return { match: "gh repo view zheref/example --json defaultBranchRef", result: { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name } }) } };
}

/** `nen/workflow.json` at the PR's base commit ('basebase'); `null` body = the read fails. */
function baseWorkflowCall(workflow: unknown = { branch: { base: "main" } }): ScriptedCall {
  if (workflow === null) {
    return { match: "gh api repos/zheref/example/contents/nen/workflow.json?ref=basebase", result: { code: 1, stderr: "HTTP 404: Not Found" } };
  }
  const content = Buffer.from(JSON.stringify(workflow)).toString("base64");
  return { match: "gh api repos/zheref/example/contents/nen/workflow.json?ref=basebase", result: { code: 0, stdout: JSON.stringify({ content, encoding: "base64" }) } };
}

const VIEWER_CALL: ScriptedCall = { match: "gh api user --jq .login", result: { code: 0, stdout: "someone\n" } };

function baseRereadCall(base: string = INTEGRATION): ScriptedCall {
  return { match: "gh pr view 9 --repo zheref/example --json baseRefName", result: { code: 0, stdout: JSON.stringify({ baseRefName: base }) } };
}

const MERGE_CALL: ScriptedCall = { match: "gh pr merge 9 --repo zheref/example --merge --match-head-commit cafebabe", result: { code: 0, stdout: "" } };
const STATE_CALL: ScriptedCall = {
  match: "gh pr view 9 --repo zheref/example --json state,mergedAt",
  result: { code: 0, stdout: JSON.stringify({ state: "MERGED", mergedAt: "2025-01-02T00:00:00Z" }) },
};

function passingScript(): ScriptedCall[] {
  return [ORIGIN_CALL, prOnceCall(), defaultBranchCall(), baseWorkflowCall(), VIEWER_CALL];
}

async function run(
  root: string,
  script: readonly ScriptedCall[],
  overrides: Partial<Parameters<typeof mergeDelivery>[0]> = {},
): ReturnType<typeof mergeDelivery> {
  return mergeDelivery({
    typedRef: "zheref/example#9",
    repoFlag: root,
    requirements: null,
    requireHead: null,
    run: false,
    seams: new ScriptedSeams(script),
    root,
    deps: readyDeps(readySource()),
    ...overrides,
  });
}

describe("mergeDelivery -- the trunk is refused by construction", () => {
  it("refuses (usage, exit 2) a base that is the repository's default branch, naming the ruling and handing the command over", async () => {
    const root = tmpRoot();
    // No viewer call, no merge call: an unscripted call would throw, so the
    // refusal provably lands before any other gate runs.
    const script = [ORIGIN_CALL, prOnceCall({ baseRefName: "main" }), defaultBranchCall("main"), baseWorkflowCall()];
    const error = await run(root, script).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MergeUnitUsageError);
    const message = (error as Error).message;
    expect(message).toMatch(/its base 'main' is the repository's default branch \('main'\) and this checkout's nen\/workflow\.json branch\.base \('main'\) and the base commit's nen\/workflow\.json branch\.base \('main'\)/);
    expect(message).toMatch(/merge-authority ruling of 2026-09-30/);
    expect(message).toMatch(/gh pr merge 9 --repo zheref\/example --merge --match-head-commit cafebabe$/);
  });

  it("refuses a base equal to the configured branch.base even when GitHub's default branch differs", async () => {
    const root = tmpRoot({ branch: { base: "trunk" } });
    const script = [ORIGIN_CALL, prOnceCall({ baseRefName: "trunk" }), defaultBranchCall("main"), baseWorkflowCall({ branch: { base: "trunk" } })];
    await expect(run(root, script)).rejects.toThrow(/its base 'trunk' is this checkout's nen\/workflow\.json branch\.base \('trunk'\) and the base commit's/);
  });

  it("refuses a base equal to GitHub's default branch even when branch.base names another", async () => {
    const root = tmpRoot({ branch: { base: "trunk" } });
    const script = [ORIGIN_CALL, prOnceCall({ baseRefName: "develop" }), defaultBranchCall("develop"), baseWorkflowCall({ branch: { base: "trunk" } })];
    await expect(run(root, script)).rejects.toThrow(/its base 'develop' is the repository's default branch \('develop'\)\./);
  });

  it("refuses a head that edits branch.base to dodge the refusal: the base commit's branch.base still matches", async () => {
    // The checkout is the head: its nen/workflow.json was edited to name
    // another branch. The base commit still says 'trunk', which is this PR's
    // base -- refused at exit 2 all the same, and before any other gate.
    const root = tmpRoot({ branch: { base: "dodged" } });
    const script = [ORIGIN_CALL, prOnceCall({ baseRefName: "trunk" }), defaultBranchCall("main"), baseWorkflowCall({ branch: { base: "trunk" } })];
    const error = await run(root, script).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MergeUnitUsageError);
    expect((error as Error).message).toMatch(/its base 'trunk' is the base commit's nen\/workflow\.json branch\.base \('trunk'\)\./);
  });

  it("treats an unreadable base-commit nen/workflow.json as 'configured base unknown': exit 1, nothing merged", async () => {
    const root = tmpRoot();
    const outcome = await run(root, [ORIGIN_CALL, prOnceCall(), defaultBranchCall(), baseWorkflowCall(null), VIEWER_CALL], { run: true });
    expect(outcome.report.ok).toBe(false);
    expect(outcome.report.ran).toBe(false);
    expect(outcome.report.baseOk).toBe(false);
    expect(outcome.report.baseCommitBase).toBeNull();
    expect(outcome.report.mergeArgv).toBeNull();
    expect(outcome.lines[0]).toMatch(/^base: could not read branch\.base from nen\/workflow\.json at the pull request's base commit \(basebase\) -- the configured base is unknown/);
  });

  it("still refuses at exit 2 on the default branch when the base-commit file is unreadable", async () => {
    const root = tmpRoot();
    const script = [ORIGIN_CALL, prOnceCall({ baseRefName: "main" }), defaultBranchCall("main"), baseWorkflowCall(null)];
    await expect(run(root, script)).rejects.toThrow(/its base 'main' is the repository's default branch/);
  });

  it("a base-commit file that states no branch.base falls back to the schema default", async () => {
    const root = tmpRoot({ branch: { base: "trunk" } });
    const script = [ORIGIN_CALL, prOnceCall({ baseRefName: "main" }), defaultBranchCall("develop"), baseWorkflowCall({})];
    await expect(run(root, script)).rejects.toThrow(/its base 'main' is the base commit's nen\/workflow\.json branch\.base \('main'\)\./);
  });

  it("fails the base gate (exit 1, not a pass) when the default branch cannot be read", async () => {
    const root = tmpRoot();
    const script = [
      ORIGIN_CALL,
      prOnceCall(),
      { match: "gh repo view zheref/example --json defaultBranchRef", result: { code: 1, stderr: "HTTP 502" } },
      baseWorkflowCall(),
      VIEWER_CALL,
    ];
    const outcome = await run(root, script);
    expect(outcome.report.ok).toBe(false);
    expect(outcome.report.baseOk).toBe(false);
    expect(outcome.report.mergeArgv).toBeNull();
    expect(outcome.lines[0]).toMatch(/^base: could not read the repository's default branch/);
  });
});

describe("mergeDelivery -- a non-main base, every gate reused", () => {
  it("prints the plan without --run, in --release-unit's transcript shape", async () => {
    const root = tmpRoot();
    const outcome = await run(root, passingScript());
    expect(outcome.report.contract).toBe(MERGE_DELIVERY_CONTRACT);
    expect(outcome.report.ok).toBe(true);
    expect(outcome.report.ran).toBe(false);
    expect(outcome.report.base).toBe(INTEGRATION);
    expect(outcome.report.defaultBranch).toBe("main");
    expect(outcome.report.configuredBase).toBe("main");
    expect(outcome.report.baseCommitBase).toBe("main");
    expect(outcome.report.bodyOk).toBeNull();
    expect(outcome.report.gates.map((gate) => gate.name)).toEqual(["base", "pr ready", "head pin", "whose pr"]);
    expect(outcome.lines.at(-1)).toBe("plan only (pass --run to execute): gh pr merge 9 --repo zheref/example --merge --match-head-commit cafebabe");
  });

  it("merges with --run, re-reading the base first and reporting merged only on a MERGED re-read", async () => {
    const root = tmpRoot();
    const outcome = await run(root, [...passingScript(), baseRereadCall(), MERGE_CALL, STATE_CALL], { run: true });
    expect(outcome.report.ok).toBe(true);
    expect(outcome.report.ran).toBe(true);
    expect(outcome.report.state).toBe("MERGED");
    expect(outcome.lines.at(-1)).toBe("merged: gh pr merge 9 --repo zheref/example --merge --match-head-commit cafebabe");
  });

  it("refuses (exit 2) under --run when the pull request was retargeted onto the trunk after the gates read it", async () => {
    const root = tmpRoot();
    await expect(run(root, [...passingScript(), baseRereadCall("main")], { run: true })).rejects.toThrow(/its base 'main' is the repository's default branch/);
  });

  it("does not merge under --run when the base moved to another non-main branch", async () => {
    const root = tmpRoot();
    const outcome = await run(root, [...passingScript(), baseRereadCall("other/integration")], { run: true });
    expect(outcome.report.ok).toBe(false);
    expect(outcome.report.ran).toBe(false);
    expect(outcome.lines.join("\n")).toMatch(/retargeted from '.*futon-integration' to 'other\/integration'/);
  });

  it("refuses a pull request the viewer did not author", async () => {
    const root = tmpRoot();
    const outcome = await run(root, [ORIGIN_CALL, prOnceCall({ author: "someone-else" }), defaultBranchCall(), baseWorkflowCall(), VIEWER_CALL]);
    expect(outcome.report.ok).toBe(false);
    expect(outcome.report.wholeOk).toBe(false);
    expect(outcome.lines.join("\n")).toMatch(/whose pr: this pull request's author is 'someone-else'/);
  });

  it("is not ready when 'pr ready' is not -- the verdict line is quoted", async () => {
    const root = tmpRoot();
    const outcome = await run(root, passingScript(), { deps: readyDeps(null) });
    expect(outcome.report.ready).toBe(false);
    expect(outcome.report.ok).toBe(false);
    expect(outcome.lines.some((line) => line.startsWith("pr ready: "))).toBe(true);
  });

  it("refuses when GitHub's head is not the head 'pr ready' judged", async () => {
    const root = tmpRoot();
    const outcome = await run(root, [ORIGIN_CALL, prOnceCall({ headRefOid: "0badf00d" }), defaultBranchCall(), baseWorkflowCall(), VIEWER_CALL]);
    expect(outcome.report.pinOk).toBe(false);
    expect(outcome.lines.join("\n")).toMatch(/head pin: 'pr ready' judged cafebabe, but the pull request's head is now 0badf00d/);
  });

  it("honours --require-head: a match pins, a mismatch refuses", async () => {
    const root = tmpRoot();
    const matched = await run(root, passingScript(), { requireHead: "cafebab" });
    expect(matched.report.ok).toBe(true);
    expect(matched.report.requiredHead).toBe("cafebab");
    expect(matched.lines.join("\n")).toMatch(/head pin: --require-head cafebab matches/);

    const mismatched = await run(root, passingScript(), { requireHead: "1234567" });
    expect(mismatched.report.ok).toBe(false);
    expect(mismatched.report.pinOk).toBe(false);
    expect(mismatched.report.ready).toBe(false);
  });

  it("refuses a malformed --require-head before any call", async () => {
    const root = tmpRoot();
    await expect(run(root, [], { requireHead: "not-a-sha" })).rejects.toThrow(/--require-head takes a commit SHA/);
  });

  it("adds the body gate only when requirements are given", async () => {
    const root = tmpRoot();
    const outcome = await run(root, passingScript(), { requirements: [{ name: "summary", pattern: "## Summary" }] });
    expect(outcome.report.bodyOk).toBe(false);
    expect(outcome.report.gates.map((gate) => gate.name)).toEqual(["base", "pr ready", "head pin", "pr body-check", "whose pr"]);
  });
});
