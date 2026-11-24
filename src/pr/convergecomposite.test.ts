// src/pr/convergecomposite.test.ts -- `nen pr converge --composite` (zheref/nen#483
// AC-1): readiness, the body check, the closing-issue links and the criteria
// coverage, all read at one pinned head; a moved head or an unfinished read is
// no verdict.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { PrReadyDeps } from "../verbs/pr_ready.js";
import type { PrStateSource } from "../github/pr_state.js";
import type { PullRequestSnapshot } from "../github/graphql.js";
import { convergeComposite, type CompositeVerdict } from "./convergecomposite.js";
import { ConvergeReadError } from "./converge.js";

const HEAD = "c0ffee".padEnd(40, "0");
const OTHER = "beef".padEnd(40, "1");
const TARGET = { owner: "zheref", repo: "example", slug: "zheref/example" };
const VIEW = "gh pr view 5 --repo zheref/example --json number,url,headRefOid,baseRefName,body,closingIssuesReferences";
const HEAD_VIEW = "gh pr view 5 --repo zheref/example --json headRefOid";
const ISSUE = "## Acceptance criteria\n\n- AC-1: lists rows\n- AC-2: exits 2 unread\n";
const BODY = "## How to verify\n\nCloses zheref/example#12\n\n| Criterion | Coverage | Evidence |\n|---|---|---|\n| AC-1 | satisfied | a.test.ts |\n| AC-2 | partial | b.test.ts |\n";
const REQUIREMENTS = [{ name: "verify", pattern: "^## How to verify$" }];

function readySource(head: string = HEAD, approved = true): PrStateSource {
  const snapshot: PullRequestSnapshot = {
    pullRequest: {
      number: 5,
      mergeable: "MERGEABLE",
      isDraft: false,
      headRefOid: head,
      headRefName: "opus/kurapika/x",
      baseRefName: "main",
      baseRefOid: "ba5e".repeat(10),
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
    reviews: async (): Promise<unknown[]> =>
      approved
        ? [
            { user: { login: "sasuke" }, state: "APPROVED", commit_id: head, submitted_at: "2025-01-01T00:00:00Z" },
            { user: { login: "tenma" }, state: "APPROVED", commit_id: head, submitted_at: "2025-01-01T00:00:00Z" },
          ]
        : [],
    reviewThreadsPage: async () => ({ nodes: [], hasNextPage: false, endCursor: null }),
    timeline: async (): Promise<unknown[]> => [],
    checkRollupPage: async (): Promise<never> => {
      throw new Error("should not paginate");
    },
    reviewRequestsPage: async (): Promise<never> => {
      throw new Error("should not paginate");
    },
    fileAtRef: async (): Promise<string | null> => readFileSync(join(BANKAI_REPO, "nen", "gates.json"), "utf8"),
  };
}

function deps(source: PrStateSource): PrReadyDeps {
  return {
    now: (): string => "2025-01-01T00:00:00Z",
    executable: (): string => "/opt/nen/nen-linux-x64",
    openSource: () => ({ ok: true, source }),
    localCheckout: (): null => null,
  };
}

function view(body: string, closing: readonly number[], head = HEAD): ScriptedCall {
  return {
    match: VIEW,
    result: {
      stdout: JSON.stringify({
        number: 5,
        url: "https://github.com/zheref/example/pull/5",
        headRefOid: head,
        baseRefName: "main",
        body,
        closingIssuesReferences: closing.map((number) => ({ number, url: `https://github.com/zheref/example/issues/${number}`, repository: { name: "example", owner: { login: "zheref" } } })),
      }),
    },
  };
}

const issueCall = (body: string): ScriptedCall => ({ match: "gh api repos/zheref/example/issues/12", result: { stdout: JSON.stringify({ number: 12, title: "t", state: "open", labels: [], body }) } });
const headCall = (head = HEAD): ScriptedCall => ({ match: HEAD_VIEW, result: { stdout: JSON.stringify({ headRefOid: head }) } });

async function judge(calls: readonly ScriptedCall[], source: PrStateSource = readySource()): Promise<CompositeVerdict> {
  return convergeComposite({ seams: new ScriptedSeams(calls), target: TARGET, prNumber: 5, requireHead: HEAD, requirements: REQUIREMENTS, catalogue: null, repoFlag: null, deps: deps(source) });
}

describe("pr converge --composite (zheref/nen#483 AC-1)", () => {
  it("reports readiness, the body check, the closing links and the criteria at the pinned head: all four hold", async () => {
    const verdict = await judge([view(BODY, [12]), issueCall(ISSUE), headCall()]);
    expect(verdict.conjuncts.map((c) => [c.name, c.ok])).toEqual([
      ["pr ready", true],
      ["pr body-check", true],
      ["closing links", true],
      ["criteria", true],
    ]);
    expect(verdict.ready).toBe(true);
    expect(verdict.blocking).toEqual([]);
  });

  it("a criterion reading contradicts is not ready whatever the readiness verdict says", async () => {
    const verdict = await judge([view(BODY.replace("| AC-2 | partial |", "| AC-2 | contradicts |"), [12]), issueCall(ISSUE), headCall()]);
    expect(verdict.conjuncts[0]?.ok).toBe(true);
    expect(verdict.ready).toBe(false);
    expect(verdict.blocking).toContain("zheref/example#12/AC-2: contradicts -- row line 8: | AC-2 | contradicts | b.test.ts |");
  });

  it("a body closing keyword GitHub does not link, and a GitHub link the body does not name, block the links conjunct", async () => {
    const unlinked = await judge([view(BODY, []), headCall(), { match: "gh repo view zheref/example --json defaultBranchRef", result: { stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }) } }]);
    expect(unlinked.conjuncts.find((c) => c.name === "closing links")?.ok).toBe(false);
    expect(unlinked.blocking.some((line) => /the body closes zheref\/example#12, but GitHub links no such closing issue/.test(line))).toBe(true);
    const unnamed = await judge([view(BODY.replace("Closes zheref/example#12", "Related to the work."), [12]), issueCall(ISSUE), headCall()]);
    expect(unnamed.blocking.some((line) => /GitHub links zheref\/example#12 as closing, but the body names it in no closing keyword/.test(line))).toBe(true);
  });

  it("not ready when pr ready is not, and a missing body requirement blocks too", async () => {
    const verdict = await judge([view(BODY.replace("## How to verify", "## Verify"), [12]), issueCall(ISSUE), headCall()], readySource(HEAD, false));
    expect(verdict.ready).toBe(false);
    expect(verdict.blocking).toContain("pr ready: not ready");
    expect(verdict.blocking).toContain("pr body-check: requirement 'verify' not satisfied");
  });

  it("AC-6: a head other than the pin, or one that moved before the closing re-read, is no verdict", async () => {
    await expect(judge([view(BODY, [12], OTHER), issueCall(ISSUE), headCall()])).rejects.toThrow(ConvergeReadError);
    await expect(judge([view(BODY, [12]), issueCall(ISSUE), headCall(OTHER)])).rejects.toThrow(/moved from/);
  });

  it("AC-7: a closing issue that cannot be read is no verdict, never ready", async () => {
    await expect(judge([view(BODY, [12]), { match: "gh api repos/zheref/example/issues/12", result: { code: 1, stderr: "HTTP 502" } }, headCall()])).rejects.toThrow(ConvergeReadError);
  });
});

describe("pr converge --composite: usage", () => {
  it("needs --require-head and --body-requirements; --body-requirements alone is refused", async () => {
    const { runFamily } = await import("../index.js");
    const { prCommand } = await import("./command.js");
    const run = async (extra: readonly string[]): Promise<{ code: number; err: string }> => {
      const err: string[] = [];
      const code = await runFamily(prCommand, ["pr", "converge", "--target", "zheref/example", "--pr", "5", ...extra], null, false, { out: (): void => undefined, err: (line): void => void err.push(line) }, new ScriptedSeams([]));
      return { code, err: err.join("\n") };
    };
    expect((await run(["--composite", "--body-requirements", "r.json"])).err).toMatch(/--require-head <sha> is required/);
    expect((await run(["--composite", "--require-head", HEAD])).err).toMatch(/body-requirements/);
    const alone = await run(["--body-requirements", "r.json"]);
    expect(alone.code).toBe(2);
    expect(alone.err).toMatch(/pass --composite/);
  });
});
