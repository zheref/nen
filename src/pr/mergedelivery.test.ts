// src/pr/mergedelivery.test.ts -- `nen pr merge <ref> --delivery`
// (zheref/nen#286, narrowed by the maintainer's ruling of 2026-10-03, hardened
// by hanten round 1 on NN#286): a run's own pull request into a NON-MAIN,
// UNPROTECTED base. A protected name is refused by ruling (exit 2, document
// still emitted); every base read that fails is "unknown" (exit 1).

import { afterAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { PrReadyDeps } from "../verbs/pr_ready.js";
import type { PrStateSource } from "../github/pr_state.js";
import type { PullRequestSnapshot } from "../github/graphql.js";
import { MergeUnitUsageError } from "./mergeunit.js";
import { mergeExit } from "./command.js";
import {
  deliveryExit,
  EXIT_MERGED_OUTSIDE_AUTHORITY,
  EXIT_REFUSED_BY_RULING,
  MERGE_DELIVERY_CONTRACT,
  mergeDelivery,
  runBranchPattern,
  stripHeads,
  type MergeDeliveryReport,
} from "./mergedelivery.js";

const HEAD = "cafebabe";
const BASE_OID = "ba5e".repeat(10);
const INTEGRATION = "opus/kurapika/futon-integration";
const RUN_HEAD = "opus/kurapika/the-change";
const REQUIREMENTS = [{ name: "how to verify", pattern: "## How to verify" }];

const created: string[] = [];
afterAll((): void => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(workflow: unknown = null): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-merge-delivery-"));
  created.push(dir);
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
      headRefName: RUN_HEAD,
      baseRefName: INTEGRATION,
      baseRefOid: BASE_OID,
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

interface PrFields {
  headRefOid: string;
  baseRefOid: unknown;
  baseRefName: unknown;
  headRefName: unknown;
  body: string;
  author: string;
  isCrossRepository: boolean;
}

const PR_VIEW = "gh pr view 9 --repo zheref/example --json headRefOid,baseRefOid,baseRefName,headRefName,body,isCrossRepository,author,state";

function prOnceCall(overrides: Partial<PrFields> = {}): ScriptedCall {
  return {
    match: PR_VIEW,
    result: {
      code: 0,
      stdout: JSON.stringify({
        headRefOid: overrides.headRefOid ?? HEAD,
        baseRefOid: "baseRefOid" in overrides ? overrides.baseRefOid : BASE_OID,
        baseRefName: "baseRefName" in overrides ? overrides.baseRefName : INTEGRATION,
        headRefName: "headRefName" in overrides ? overrides.headRefName : RUN_HEAD,
        body: overrides.body ?? "## How to verify\nrun it\n",
        isCrossRepository: overrides.isCrossRepository ?? false,
        author: { login: overrides.author ?? "someone" },
        state: "OPEN",
      }),
    },
  };
}

function defaultBranchCall(name: string | null = "main"): ScriptedCall {
  return {
    match: "gh repo view zheref/example --json defaultBranchRef",
    result: { code: 0, stdout: JSON.stringify({ defaultBranchRef: name === null ? null : { name } }) },
  };
}

/** `nen/workflow.json` at one ref; `null` = the read fails. */
function workflowAt(ref: string, workflow: unknown = { branch: { base: "main" } }): ScriptedCall {
  const match = `gh api repos/zheref/example/contents/nen/workflow.json?ref=${encodeURIComponent(ref)}`;
  if (workflow === null) return { match, result: { code: 1, stderr: "HTTP 404: Not Found" } };
  const content = Buffer.from(JSON.stringify(workflow)).toString("base64");
  return { match, result: { code: 0, stdout: JSON.stringify({ content, encoding: "base64" }) } };
}

function protectionCalls(base: string = INTEGRATION, isProtected: unknown = false, rules: unknown = []): ScriptedCall[] {
  return [
    { match: `gh api repos/zheref/example/branches/${encodeURIComponent(base)}`, result: { code: 0, stdout: JSON.stringify({ name: base, protected: isProtected }) } },
    { match: `gh api repos/zheref/example/rules/branches/${encodeURIComponent(base)}`, result: { code: 0, stdout: JSON.stringify(rules) } },
  ];
}

function chainMatch(base: string = INTEGRATION): string {
  return `gh pr list --repo zheref/example --head ${base} --state open --limit 1000 --json number,baseRefName,autoMergeRequest`;
}

function chainCall(base: string = INTEGRATION, entries: unknown = []): ScriptedCall {
  return { match: chainMatch(base), result: { code: 0, stdout: JSON.stringify(entries) } };
}

const VIEWER_CALL: ScriptedCall = { match: "gh api user --jq .login", result: { code: 0, stdout: "someone\n" } };

function baseRereadCall(base: unknown = INTEGRATION): ScriptedCall {
  return { match: "gh pr view 9 --repo zheref/example --json baseRefName", result: { code: 0, stdout: JSON.stringify({ baseRefName: base }) } };
}

const MERGE_MATCH = "gh pr merge 9 --repo zheref/example --merge --match-head-commit cafebabe";
const MERGE_CALL: ScriptedCall = { match: MERGE_MATCH, result: { code: 0, stdout: "" } };

function stateCall(baseRefName: unknown = INTEGRATION): ScriptedCall {
  return {
    match: "gh pr view 9 --repo zheref/example --json state,mergedAt,baseRefName",
    result: { code: 0, stdout: JSON.stringify({ state: "MERGED", mergedAt: "2025-01-02T00:00:00Z", baseRefName }) },
  };
}

type Slot = "pr" | "default" | "baseWorkflow" | "defaultWorkflow" | "chain" | "viewer";

/** Every read a fully-passing plan makes, each replaceable (or droppable, with `null`) by name. */
function script(overrides: Partial<Record<Slot, ScriptedCall | null>> & { protection?: ScriptedCall[] } = {}): ScriptedCall[] {
  const pick = (slot: Slot, fallback: ScriptedCall): ScriptedCall[] => {
    const value = overrides[slot];
    if (value === null) return [];
    return [value ?? fallback];
  };
  return [
    ORIGIN_CALL,
    ...pick("pr", prOnceCall()),
    ...pick("default", defaultBranchCall()),
    ...pick("baseWorkflow", workflowAt(BASE_OID)),
    ...pick("defaultWorkflow", workflowAt("main")),
    ...(overrides.protection ?? protectionCalls()),
    ...pick("chain", chainCall()),
    ...pick("viewer", VIEWER_CALL),
  ];
}

async function run(
  root: string,
  calls: readonly ScriptedCall[],
  overrides: Partial<Parameters<typeof mergeDelivery>[0]> = {},
): ReturnType<typeof mergeDelivery> {
  return mergeDelivery({
    typedRef: "zheref/example#9",
    repoFlag: root,
    requirements: REQUIREMENTS,
    requireHead: null,
    run: false,
    seams: new ScriptedSeams(calls),
    root,
    deps: readyDeps(readySource()),
    ...overrides,
  });
}

/** The adapter's REAL mapping (round 2, N9): ../pr/command.ts's exported `mergeExit` behind `deliveryExit`. */
function exitOf(report: MergeDeliveryReport): number {
  return deliveryExit(report, mergeExit);
}

/** A protected-name base: the reads before the refusal, nothing after it. */
function refusedScript(base: string, baseWorkflow: unknown = { branch: { base: "main" } }, defaultWorkflow: unknown = { branch: { base: "main" } }): ScriptedCall[] {
  return [
    ORIGIN_CALL,
    prOnceCall({ baseRefName: base }),
    defaultBranchCall(),
    workflowAt(BASE_OID, baseWorkflow),
    workflowAt("main", defaultWorkflow),
    ...protectionCalls(stripHeads(base)),
  ];
}

describe("mergeDelivery -- refused by ruling (exit 2, the document still emitted)", () => {
  it("refuses the default branch before any other gate, handing over 'nen pr ready' before 'gh pr merge'", async () => {
    const outcome = await run(tmpRoot(), refusedScript("main"));
    expect(outcome.report.refused).toBe(true);
    expect(outcome.report.baseOk).toBe(false);
    expect(outcome.report.ran).toBe(false);
    expect(outcome.report.mergeArgv).toBeNull();
    expect(outcome.report.contract).toBe(MERGE_DELIVERY_CONTRACT);
    expect(outcome.report.gates.map((gate) => gate.name)).toEqual(["base"]);
    expect(exitOf(outcome.report)).toBe(EXIT_REFUSED_BY_RULING);
    const text = outcome.lines.join("\n");
    expect(text).toMatch(/^base: 'main' is the repository's default branch \('main'\)/m);
    expect(text).toMatch(/'pr ready' was NOT evaluated/);
    const check = text.indexOf("nen pr ready 9 --gh-repo zheref/example --require-head cafebabe");
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(text.indexOf("gh pr merge 9 --repo zheref/example --merge --match-head-commit cafebabe"));
    expect(outcome.lines.at(-1)).toMatch(/^nen pr merge: refused by ruling -- not merged \(exit 2\)\. Per the maintainer's merge-authority ruling of 2026-09-30/);
  });

  it("strips refs/heads/ before comparing (F7)", async () => {
    const outcome = await run(tmpRoot(), refusedScript("refs/heads/main"));
    expect(outcome.report.refused).toBe(true);
    expect(outcome.report.base).toBe("main");
  });

  it("refuses this checkout's branch.base", async () => {
    const outcome = await run(tmpRoot({ branch: { base: "trunk" } }), refusedScript("trunk"));
    expect(outcome.report.refused).toBe(true);
    expect(outcome.lines[0]).toMatch(/this checkout's nen\/workflow\.json branch\.base \('trunk'\)/);
  });

  it("refuses a head that edits branch.base to dodge it: the base commit's branch.base still matches", async () => {
    // The checkout is the head, edited to name another branch; the base commit
    // still says 'trunk', which is this PR's base.
    const outcome = await run(tmpRoot({ branch: { base: "dodged" } }), refusedScript("trunk", { branch: { base: "trunk" } }));
    expect(outcome.report.refused).toBe(true);
    expect(outcome.lines[0]).toMatch(/^base: 'trunk' is the base commit's nen\/workflow\.json branch\.base \('trunk'\) --/);
  });

  it("refuses the default branch's own branch.base (F7)", async () => {
    const outcome = await run(tmpRoot(), refusedScript("trunk", {}, { branch: { base: "trunk" } }));
    expect(outcome.report.refused).toBe(true);
    expect(outcome.report.defaultBranchBase).toBe("trunk");
    expect(outcome.lines[0]).toMatch(/the default branch's nen\/workflow\.json branch\.base \('trunk'\)/);
  });

  it("still refuses the default branch when the base-commit file is unreadable", async () => {
    const outcome = await run(tmpRoot(), refusedScript("main", null));
    expect(outcome.report.refused).toBe(true);
    expect(outcome.report.baseCommitBase).toBeNull();
  });

  it("refuses a base GitHub reports protected (F2)", async () => {
    const outcome = await run(tmpRoot(), script({ protection: protectionCalls(INTEGRATION, true), chain: null, viewer: null }));
    expect(outcome.report.refused).toBe(true);
    expect(outcome.report.baseProtected).toBe(true);
    expect(outcome.lines[0]).toMatch(/a protected branch \(GitHub branch protection\)/);
  });

  it("refuses a base a ruleset targets, counting DISTINCT rulesets (F2, round 2 N2): 4 rules from 1 ruleset", async () => {
    const rules = ["deletion", "non_fast_forward", "pull_request", "required_status_checks"].map((type) => ({ type, ruleset_id: 42 }));
    const outcome = await run(tmpRoot(), script({ protection: protectionCalls(INTEGRATION, false, rules), chain: null, viewer: null }));
    expect(outcome.report.refused).toBe(true);
    expect(outcome.report.baseRulesets).toBe(1);
    expect(outcome.lines[0]).toMatch(/targeted by 4 rule\(s\) from 1 ruleset\(s\)/);
  });

  it("refuses an auto-merge chain from the base into a protected name (F4), naming it", async () => {
    const outcome = await run(tmpRoot(), script({ chain: chainCall(INTEGRATION, [{ number: 12, baseRefName: "main", autoMergeRequest: { enabledAt: "x" } }]), viewer: null }));
    expect(outcome.report.refused).toBe(true);
    expect(outcome.lines[0]).toMatch(/is the head of #12 into 'main' with auto-merge enabled/);
  });

  it("judges each auto-merge target like a base: a protected release/1.x is refused (round 2, N6)", async () => {
    const outcome = await run(
      tmpRoot(),
      script({
        chain: chainCall(INTEGRATION, [{ number: 14, baseRefName: "release/1.x", autoMergeRequest: { enabledAt: "x" } }]),
        protection: [...protectionCalls(), ...protectionCalls("release/1.x", true)],
        viewer: null,
      }),
    );
    expect(outcome.report.refused).toBe(true);
    expect(outcome.lines[0]).toMatch(/#14 into 'release\/1\.x' \(a protected branch \(GitHub branch protection\)\) with auto-merge enabled/);
  });

  it("an auto-merge target whose protection cannot be read is unknown, exit 1 (round 2, N6)", async () => {
    const outcome = await run(
      tmpRoot(),
      script({
        chain: chainCall(INTEGRATION, [{ number: 14, baseRefName: "release/1.x", autoMergeRequest: { enabledAt: "x" } }]),
        protection: [...protectionCalls(), { match: "gh api repos/zheref/example/branches/release%2F1.x", result: { code: 1, stderr: "HTTP 403" } }],
      }),
    );
    expect(outcome.report.refused).toBe(false);
    expect(outcome.report.baseOk).toBe(false);
    expect(exitOf(outcome.report)).toBe(1);
    expect(outcome.lines[0]).toMatch(/auto-merge target 'release\/1\.x' of #14/);
  });

  it("reads every open pull request on the chain, past gh's default 30 (Copilot round 1)", async () => {
    const entries = Array.from({ length: 31 }, (_, index) => ({ number: 100 + index, baseRefName: "other/integration", autoMergeRequest: null }));
    entries.push({ number: 131, baseRefName: "main", autoMergeRequest: { enabledAt: "x" } as never });
    const outcome = await run(tmpRoot(), script({ chain: chainCall(INTEGRATION, entries), viewer: null }));
    expect(outcome.report.refused).toBe(true);
    expect(outcome.lines[0]).toMatch(/#131 into 'main'/);
  });

  it("refuses as unknown (exit 1) a chain list that fills --limit, whose completeness cannot be proven", async () => {
    const entries = Array.from({ length: 1000 }, (_, index) => ({ number: index + 1, baseRefName: "other/integration", autoMergeRequest: null }));
    const outcome = await run(tmpRoot(), script({ chain: chainCall(INTEGRATION, entries) }));
    expect(outcome.report.refused).toBe(false);
    expect(outcome.report.baseOk).toBe(false);
    expect(exitOf(outcome.report)).toBe(1);
    expect(outcome.lines[0]).toMatch(/its --limit of 1000, so the list may be cut off/);
  });

  it("an auto-merge entry with no baseRefName is UNREAD -- exit 1, not a refusal by ruling (Copilot round 1)", async () => {
    const outcome = await run(tmpRoot(), script({ chain: chainCall(INTEGRATION, [{ number: 15, autoMergeRequest: { enabledAt: "x" } }]) }));
    expect(outcome.report.refused).toBe(false);
    expect(outcome.report.baseOk).toBe(false);
    expect(exitOf(outcome.report)).toBe(1);
    expect(outcome.lines[0]).toMatch(/auto-merge pull request #15 answered no base branch name/);
  });

  it("lets a chain through when its auto-merge is off or its target is unprotected", async () => {
    const outcome = await run(
      tmpRoot(),
      script({
        chain: chainCall(INTEGRATION, [
          { number: 12, baseRefName: "main", autoMergeRequest: null },
          { number: 13, baseRefName: "other/integration", autoMergeRequest: { enabledAt: "x" } },
        ]),
        protection: [...protectionCalls(), ...protectionCalls("other/integration")],
      }),
    );
    expect(outcome.report.refused).toBe(false);
    expect(outcome.report.ok).toBe(true);
  });
});

describe("mergeDelivery -- a base nobody could establish is a failed gate (exit 1)", () => {
  async function expectUnknown(calls: readonly ScriptedCall[], pattern: RegExp, root: string = tmpRoot()): Promise<void> {
    const outcome = await run(root, calls);
    expect(outcome.report.refused).toBe(false);
    expect(outcome.report.ok).toBe(false);
    expect(outcome.report.baseOk).toBe(false);
    expect(outcome.report.mergeArgv).toBeNull();
    expect(exitOf(outcome.report)).toBe(1);
    expect(outcome.lines.filter((line) => line.startsWith("base: ")).join("\n")).toMatch(pattern);
  }

  it("the pull-request fetch fails", async () => {
    await expectUnknown([ORIGIN_CALL, { match: PR_VIEW, result: { code: 1, stderr: "HTTP 502" } }, defaultBranchCall(), workflowAt("main"), VIEWER_CALL], /could not fetch the pull request/);
  });

  it("defaultBranchRef is null", async () => {
    await expectUnknown(script({ default: defaultBranchCall(null), defaultWorkflow: null }), /answered no default branch/);
  });

  it("the default branch read fails", async () => {
    await expectUnknown(
      script({ default: { match: "gh repo view zheref/example --json defaultBranchRef", result: { code: 1, stderr: "HTTP 502" } }, defaultWorkflow: null }),
      /could not read the repository's default branch/,
    );
  });

  it("the base commit's nen/workflow.json cannot be read", async () => {
    await expectUnknown(script({ baseWorkflow: workflowAt(BASE_OID, null) }), /at the pull request's base commit .* -- the configured base is unknown/);
  });

  it("the base commit's 'branch' is not an object", async () => {
    await expectUnknown(script({ baseWorkflow: workflowAt(BASE_OID, { branch: "main" }) }), /the configured base is unknown/);
  });

  it("the base commit's 'branch.base' is not a string", async () => {
    await expectUnknown(script({ baseWorkflow: workflowAt(BASE_OID, { branch: { base: 7 } }) }), /the configured base is unknown/);
  });

  it("the default branch's nen/workflow.json cannot be read (F7)", async () => {
    await expectUnknown(script({ defaultWorkflow: workflowAt("main", null) }), /at the default branch \('main'\)/);
  });

  it("GitHub's protection cannot be read (F2)", async () => {
    await expectUnknown(
      script({ protection: [{ match: `gh api repos/zheref/example/branches/${encodeURIComponent(INTEGRATION)}`, result: { code: 1, stderr: "HTTP 403" } }] }),
      /could not read GitHub's protection/,
    );
  });

  it("the rules answer is not a list (F2)", async () => {
    await expectUnknown(script({ protection: protectionCalls(INTEGRATION, false, { message: "nope" }) }), /rules for .* are not a list/);
  });

  it("the auto-merge chain cannot be listed (F4)", async () => {
    await expectUnknown(script({ chain: { match: chainMatch(), result: { code: 1, stderr: "HTTP 502" } } }), /could not list the open pull requests whose head is/);
  });

  it("an empty baseRefName (F5)", async () => {
    await expectUnknown(script({ pr: prOnceCall({ baseRefName: "" }), protection: [], chain: null }), /answered no base branch name/);
  });

  it("a missing baseRefName (F5)", async () => {
    await expectUnknown(script({ pr: prOnceCall({ baseRefName: undefined }), protection: [], chain: null }), /answered no base branch name/);
  });

  it("a baseRefOid that is not a SHA (N4)", async () => {
    await expectUnknown(script({ pr: prOnceCall({ baseRefOid: "basebase" }), baseWorkflow: null }), /baseRefOid 'basebase' is not a commit SHA/);
  });
});

describe("mergeDelivery -- a non-main base, every gate reused", () => {
  it("prints the plan without --run, in --release-unit's transcript shape", async () => {
    const outcome = await run(tmpRoot(), script());
    expect(outcome.report.ok).toBe(true);
    expect(outcome.report.ran).toBe(false);
    expect(outcome.report.base).toBe(INTEGRATION);
    expect(outcome.report.baseCommitBase).toBe("main");
    expect(outcome.report.defaultBranchBase).toBe("main");
    expect(outcome.report.baseProtected).toBe(false);
    expect(outcome.report.baseRulesets).toBe(0);
    expect(outcome.report.bodyOk).toBe(true);
    expect(outcome.report.gates.map((gate) => gate.name)).toEqual(["base", "pr ready", "head pin", "pr body-check", "whose pr"]);
    expect(outcome.lines.at(-1)).toBe(`plan only (pass --run to execute): gh ${MERGE_MATCH.slice(3)}`);
    expect(exitOf(outcome.report)).toBe(0);
  });

  it("refuses a head ref outside the run form of branch.template (F1)", async () => {
    const outcome = await run(tmpRoot(), script({ pr: prOnceCall({ headRefName: "feature/x" }) }));
    expect(outcome.report.wholeOk).toBe(false);
    expect(outcome.lines.join("\n")).toMatch(/head 'feature\/x' is not in the run form of branch\.template '\{model\}\/\{persona\}\/\{descriptor\}'/);
  });

  it("addresses a slash-bearing base as ONE encoded path component (Copilot round 1)", async () => {
    const seams = new ScriptedSeams(script());
    const root = tmpRoot();
    const outcome = await mergeDelivery({
      typedRef: "zheref/example#9",
      repoFlag: root,
      requirements: REQUIREMENTS,
      requireHead: null,
      run: false,
      seams,
      root,
      deps: readyDeps(readySource()),
    });
    expect(outcome.report.ok).toBe(true);
    const lines = seams.calls.map((call) => [call.command, ...call.args].join(" "));
    expect(lines).toContain("gh api repos/zheref/example/branches/opus%2Fkurapika%2Ffuton-integration");
    expect(lines).toContain("gh api repos/zheref/example/rules/branches/opus%2Fkurapika%2Ffuton-integration");
    expect(lines.some((line) => line.includes("branches/opus/kurapika"))).toBe(false);
  });

  it("a base-commit branch.template with no {descriptor} is UNREADABLE: the whose gate fails, exit 1 (Copilot round 1)", async () => {
    const outcome = await run(tmpRoot(), script({ baseWorkflow: workflowAt(BASE_OID, { branch: { base: "main", template: "runs/fixed" } }) }));
    expect(outcome.report.refused).toBe(false);
    expect(outcome.report.wholeOk).toBe(false);
    expect(outcome.report.ok).toBe(false);
    expect(exitOf(outcome.report)).toBe(1);
    expect(outcome.lines.join("\n")).toMatch(/branch\.template at the pull request's base commit could not be read/);
  });

  it("refuses a pull request that answers no headRefName (round 2, N5)", async () => {
    const outcome = await run(tmpRoot(), script({ pr: prOnceCall({ headRefName: undefined }) }));
    expect(outcome.report.wholeOk).toBe(false);
    expect(outcome.lines.join("\n")).toMatch(/whose pr: the pull request answered no head branch name -- refused\./);
  });

  it("refuses a malformed local nen/workflow.json as usage, before any gh call (round 2, N5)", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "nen", "workflow.json"), "{ not json");
    await expect(run(root, [ORIGIN_CALL])).rejects.toThrow(MergeUnitUsageError);
  });

  it("reads the template from the base commit (F1)", async () => {
    const outcome = await run(
      tmpRoot(),
      script({ pr: prOnceCall({ headRefName: "runs/the-change" }), baseWorkflow: workflowAt(BASE_OID, { branch: { base: "main", template: "runs/{descriptor}" } }) }),
    );
    expect(outcome.report.ok).toBe(true);
  });

  it("refuses a pull request the viewer did not author", async () => {
    const outcome = await run(tmpRoot(), script({ pr: prOnceCall({ author: "someone-else" }) }));
    expect(outcome.report.wholeOk).toBe(false);
    expect(outcome.lines.join("\n")).toMatch(/whose pr: this pull request's author is 'someone-else'/);
  });

  it("is not ready when 'pr ready' is not -- the verdict line is quoted", async () => {
    const outcome = await run(tmpRoot(), script(), { deps: readyDeps(null) });
    expect(outcome.report.ready).toBe(false);
    expect(outcome.lines.some((line) => line.startsWith("pr ready: "))).toBe(true);
  });

  it("refuses when GitHub's head is not the head 'pr ready' judged", async () => {
    const outcome = await run(tmpRoot(), script({ pr: prOnceCall({ headRefOid: "0badf00d" }) }));
    expect(outcome.report.pinOk).toBe(false);
    expect(outcome.lines.join("\n")).toMatch(/head pin: 'pr ready' judged cafebabe, but the pull request's head is now 0badf00d/);
  });

  it("honours --require-head: a match pins, a mismatch refuses", async () => {
    const root = tmpRoot();
    const matched = await run(root, script(), { requireHead: "cafebab" });
    expect(matched.report.ok).toBe(true);
    expect(matched.lines.join("\n")).toMatch(/head pin: --require-head cafebab matches/);
    const mismatched = await run(root, script(), { requireHead: "1234567" });
    expect(mismatched.report.ok).toBe(false);
    expect(mismatched.report.pinOk).toBe(false);
  });

  it("refuses a malformed --require-head before any call", async () => {
    await expect(run(tmpRoot(), [], { requireHead: "not-a-sha" })).rejects.toThrow(MergeUnitUsageError);
  });

  it("fails the body gate on a body that misses a requirement", async () => {
    const outcome = await run(tmpRoot(), script(), { requirements: [{ name: "summary", pattern: "## Summary" }] });
    expect(outcome.report.bodyOk).toBe(false);
  });
});

describe("mergeDelivery -- under --run", () => {
  it("merges after the base re-read, and reports merged on a MERGED re-read into the gated base", async () => {
    const outcome = await run(tmpRoot(), [...script(), baseRereadCall(), MERGE_CALL, stateCall()], { run: true });
    expect(outcome.report.ok).toBe(true);
    expect(outcome.report.ran).toBe(true);
    expect(outcome.report.mergedBase).toBe(INTEGRATION);
    expect(outcome.report.rereadBase).toBe(INTEGRATION);
    expect(outcome.report.outsideAuthority).toBe(false);
    expect(outcome.report.gates.at(-1)).toEqual({ name: "base (re-read)", ok: true, lines: [`base (re-read): still '${INTEGRATION}'`] });
    expect(outcome.lines.at(-1)).toBe(`merged: gh ${MERGE_MATCH.slice(3)}`);
    expect(exitOf(outcome.report)).toBe(0);
  });

  it("is exit 7 when GitHub reports the merge landed in a protected name (F3)", async () => {
    const outcome = await run(tmpRoot(), [...script(), baseRereadCall(), MERGE_CALL, stateCall("main")], { run: true });
    expect(outcome.report.ran).toBe(true);
    expect(outcome.report.outsideAuthority).toBe(true);
    expect(outcome.report.ok).toBe(false);
    expect(exitOf(outcome.report)).toBe(EXIT_MERGED_OUTSIDE_AUTHORITY);
    expect(outcome.lines.at(-1)).toMatch(/MERGED INTO 'main' WITHOUT AUTHORITY .* Tell the maintainer now \(exit 7\)/);
  });

  it("R2: is exit 7 'authority unconfirmed' when the post-merge re-read fails (round 2, N1) -- never 0", async () => {
    const outcome = await run(
      tmpRoot(),
      [...script(), baseRereadCall(), MERGE_CALL, { match: "gh pr view 9 --repo zheref/example --json state,mergedAt,baseRefName", result: { code: 1, stderr: "HTTP 502" } }],
      { run: true },
    );
    expect(outcome.report.ran).toBe(true);
    expect(outcome.report.outsideAuthority).toBe(true);
    expect(outcome.report.ok).toBe(false);
    expect(exitOf(outcome.report)).toBe(EXIT_MERGED_OUTSIDE_AUTHORITY);
    expect(outcome.lines.at(-1)).toMatch(/AUTHORITY UNCONFIRMED/);
  });

  it("R3: is exit 7 when a QUEUED merge (state OPEN) reports a base of main (round 2, N1)", async () => {
    const queued: ScriptedCall = {
      match: "gh pr view 9 --repo zheref/example --json state,mergedAt,baseRefName",
      result: { code: 0, stdout: JSON.stringify({ state: "OPEN", mergedAt: null, baseRefName: "main" }) },
    };
    const outcome = await run(tmpRoot(), [...script(), baseRereadCall(), MERGE_CALL, queued], { run: true });
    expect(outcome.report.state).toBe("OPEN");
    expect(outcome.report.mergedBase).toBe("main");
    expect(outcome.report.outsideAuthority).toBe(true);
    expect(exitOf(outcome.report)).toBe(EXIT_MERGED_OUTSIDE_AUTHORITY);
    expect(outcome.lines.at(-1)).toMatch(/ACCEPTED \(state 'OPEN'\) INTO 'main' WITHOUT AUTHORITY/);
  });

  it("a queued merge into the gated base is exit 0, reported queued", async () => {
    const queued: ScriptedCall = {
      match: "gh pr view 9 --repo zheref/example --json state,mergedAt,baseRefName",
      result: { code: 0, stdout: JSON.stringify({ state: "OPEN", mergedAt: null, baseRefName: INTEGRATION }) },
    };
    const outcome = await run(tmpRoot(), [...script(), baseRereadCall(), MERGE_CALL, queued], { run: true });
    expect(outcome.report.outsideAuthority).toBe(false);
    expect(exitOf(outcome.report)).toBe(0);
    expect(outcome.lines.at(-1)).toMatch(/^queued \(auto-merge or merge queue\)/);
  });

  it("is exit 7 when the merged base cannot be confirmed (F3/F5)", async () => {
    const outcome = await run(tmpRoot(), [...script(), baseRereadCall(), MERGE_CALL, stateCall("")], { run: true });
    expect(outcome.report.outsideAuthority).toBe(true);
    expect(outcome.lines.at(-1)).toMatch(/MERGED INTO AN UNCONFIRMED BASE/);
  });

  it("appends a failed 'base (re-read)' gate when the re-read fails (N7): ran false, mergeArgv null", async () => {
    const outcome = await run(tmpRoot(), [...script(), { match: "gh pr view 9 --repo zheref/example --json baseRefName", result: { code: 1, stderr: "HTTP 502" } }], {
      run: true,
    });
    expect(outcome.report.ran).toBe(false);
    expect(outcome.report.mergeArgv).toBeNull();
    expect(outcome.report.baseOk).toBe(false);
    expect(outcome.report.gates.at(-1)).toMatchObject({ name: "base (re-read)", ok: false });
    expect(exitOf(outcome.report)).toBe(1);
  });

  it("an empty base on the re-read is a failed gate (F5)", async () => {
    const outcome = await run(tmpRoot(), [...script(), baseRereadCall("")], { run: true });
    expect(outcome.report.ran).toBe(false);
    expect(outcome.report.baseOk).toBe(false);
    expect(outcome.lines.join("\n")).toMatch(/no base branch name on the re-read/);
  });

  it("refuses by ruling a retarget onto the trunk between the gates and the merge", async () => {
    const outcome = await run(tmpRoot(), [...script(), baseRereadCall("refs/heads/main")], { run: true });
    expect(outcome.report.refused).toBe(true);
    expect(outcome.report.rereadBase).toBe("main");
    const text = outcome.lines.join("\n");
    expect(text).toMatch(/the gates judged base 'opus\/kurapika\/futon-integration', and the pull request has since been retargeted onto 'main'/);
    expect(text).toMatch(/'pr ready' passed at cafebabe; the base moved/);
    expect(text).not.toMatch(/'pr ready' was NOT evaluated/);
    expect(outcome.report.baseOk).toBe(false);
    expect(outcome.report.ready).toBe(true);
    expect(outcome.report.gates.at(-1)?.name).toBe("base (re-read)");
    expect(exitOf(outcome.report)).toBe(2);
  });

  it("does not merge when the base moved to another non-main branch (N7)", async () => {
    const outcome = await run(tmpRoot(), [...script(), baseRereadCall("other/integration")], { run: true });
    expect(outcome.report.ran).toBe(false);
    expect(outcome.report.rereadBase).toBe("other/integration");
    expect(outcome.report.baseOk).toBe(false);
    expect(outcome.report.gates.at(-1)).toMatchObject({ name: "base (re-read)", ok: false });
  });

  it("maps gh refusing the merge to exit 5", async () => {
    const outcome = await run(tmpRoot(), [...script(), baseRereadCall(), { match: MERGE_MATCH, result: { code: 1, stderr: "protected branch" } }], { run: true });
    expect(outcome.report.ran).toBe(false);
    expect(outcome.report.mergeArgv).not.toBeNull();
    expect(exitOf(outcome.report)).toBe(5);
  });
});

describe("helpers", () => {
  it("mergeExit / deliveryExit: the real mapping (round 2, N9)", () => {
    const base = { ok: false, ran: false, spawnFailed: false, mergeArgv: null as readonly string[] | null };
    expect(mergeExit({ ...base, ok: true })).toBe(0);
    expect(mergeExit(base)).toBe(1);
    expect(mergeExit({ ...base, mergeArgv: ["pr", "merge"] })).toBe(5);
    expect(mergeExit({ ...base, mergeArgv: ["pr", "merge"], spawnFailed: true })).toBe(6);
    const report = { refused: false, outsideAuthority: false, ...base } as unknown as MergeDeliveryReport;
    expect(deliveryExit({ ...report, refused: true }, mergeExit)).toBe(2);
    expect(deliveryExit({ ...report, outsideAuthority: true, ran: true }, mergeExit)).toBe(7);
    expect(deliveryExit({ ...report, mergeArgv: ["pr", "merge"] }, mergeExit)).toBe(5);
  });

  it("runBranchPattern: three non-empty segments for the default template", () => {
    const pattern = runBranchPattern("{model}/{persona}/{descriptor}");
    expect(pattern.test("opus/kurapika/x")).toBe(true);
    expect(pattern.test("opus/kurapika")).toBe(false);
    expect(pattern.test("opus//x")).toBe(false);
    expect(pattern.test("a/b/c/d")).toBe(false);
    expect(runBranchPattern("runs.{descriptor}").test("runsXy")).toBe(false);
  });

  it("stripHeads", () => {
    expect(stripHeads("refs/heads/main")).toBe("main");
    expect(stripHeads("main")).toBe("main");
  });
});
