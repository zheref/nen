import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { issueCommand } from "./command.js";

async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  options: { repoFlag?: string | null; json?: boolean; now?: Date } = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const scripted = new ScriptedSeams(script, options.now === undefined ? {} : { now: (): Date => options.now! });
  const seams: Seams = scripted;
  const code = await runFamily(
    issueCommand,
    argv,
    options.repoFlag ?? null,
    options.json ?? false,
    io,
    seams,
  );
  return { code, out, err };
}

describe("nen issue -- CLI wiring", () => {
  it("requires --target", async () => {
    const result = await capture(["issue", "search", "--subject", "x"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/--target/);
  });

  it("refuses an unknown subcommand as a usage error", async () => {
    expect((await capture(["issue", "bogus"])).code).toBe(2);
  });

  // zheref/nen#28: file's and consolidate-close's usage lines list --repo
  // unbracketed, so omitting it is refused by name -- never silently read as
  // "validate against whatever taxonomy the cwd happens to hold". This
  // helper's default repoFlag is already null, i.e. the flag was never typed.
  it("file refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["issue", "file", "--target", "o/n"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("consolidate-close refuses an OMITTED --repo the same way", async () => {
    const result = await capture(["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("open-pr-check requires --issues", async () => {
    expect((await capture(["issue", "open-pr-check", "--target", "o/n"])).code).toBe(2);
  });

  it("search emits the stable --json contract and a non-zero exit on a failed pass", async () => {
    const now = new Date("2026-08-31T00:00:00Z");
    const result = await capture(
      ["issue", "search", "--target", "o/n", "--subject", "x"],
      [
        {
          match: "gh issue list --repo o/n --state open --search x --limit 100 --json number,title,state,url,labels,updatedAt,closedAt",
          result: { code: 1, stderr: "down" },
        },
        {
          match: "gh issue list --repo o/n --state closed --search x closed:>=2026-06-02 --limit 100 --json number,title,state,url,labels,updatedAt,closedAt",
          result: { stdout: "[]" },
        },
      ],
      { json: true, now },
    );
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.out.join("\n")) as { ok: boolean; passes: unknown[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.passes.length).toBe(4);
  });

  it("file requires --body-file", async () => {
    const result = await capture(
      ["issue", "file", "--target", "o/n", "--title", "t", "--label", "bug", "--assignee", "me"],
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
  });

  // Review finding #13: consolidate-close ran no open-PR guard at all --
  // 'nen issue open-pr-check' existed one verb over and nothing wired it in.
  it("consolidate-close refuses (exit 1) when a child has an open PR, and never reaches attach or close", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5"],
      [
        {
          match: "gh api repos/o/n/issues/5",
          result: { stdout: JSON.stringify({ number: 5, id: 55, title: "child", state: "open", labels: [] }) },
        },
        {
          match:
            "gh pr list --repo o/n --state open --limit 100 --json number,title,url,isDraft,body,closingIssuesReferences",
          result: {
            stdout: JSON.stringify([
              { number: 99, title: "wip: fix the thing", url: "https://x/pull/99", isDraft: true, body: "", closingIssuesReferences: [{ number: 5 }] },
            ]),
          },
        },
        // Deliberately NOT scripting the attach (POST sub_issues) or close
        // calls -- if the guard fails to refuse first, ScriptedSeams throws
        // on the first unscripted call, which is itself a red test.
      ],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/open PR/);
    expect(result.err.join("\n")).toMatch(/#99/);
  });

  it("consolidate-close --allow-open-pr overrides the refusal and proceeds to attach and close", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5", "--allow-open-pr"],
      [
        {
          match: "gh api repos/o/n/issues/5",
          result: { stdout: JSON.stringify({ number: 5, id: 55, title: "child", state: "open", labels: [] }) },
        },
        {
          match:
            "gh pr list --repo o/n --state open --limit 100 --json number,title,url,isDraft,body,closingIssuesReferences",
          result: {
            stdout: JSON.stringify([
              { number: 99, title: "wip: fix the thing", url: "https://x/pull/99", isDraft: true, body: "", closingIssuesReferences: [{ number: 5 }] },
            ]),
          },
        },
        { match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=55", result: {} },
        { match: "gh issue close 5 --repo o/n --comment Consolidated into #1.", result: {} },
      ],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(0);
  });

  // Issue #22: omitting --severity-family made planConsolidation's reduction
  // branch unreachable, so every child's severity label silently unioned onto
  // the parent -- the exact multi-severity state the mechanism exists to
  // prevent, on a mutating verb, with exit 0.
  it("consolidate-close refuses (exit 1) when --severity-family is omitted and severity labels would union, and never reaches the PR guard, attach or close", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5,6"],
      [
        {
          match: "gh api repos/o/n/issues/5",
          result: { stdout: JSON.stringify({ number: 5, id: 55, title: "a", state: "open", labels: [{ name: "bankai:severity/high" }] }) },
        },
        {
          match: "gh api repos/o/n/issues/6",
          result: { stdout: JSON.stringify({ number: 6, id: 66, title: "b", state: "open", labels: [{ name: "bankai:severity/medium" }] }) },
        },
        // Deliberately NOT scripting the pr list, attach or close calls -- the
        // refusal must fire before all of them, and ScriptedSeams throws on the
        // first unscripted call if it does not.
      ],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(1);
    const err = result.err.join("\n");
    expect(err).toMatch(/--severity-family/);
    expect(err).toMatch(/bankai:severity: bankai:severity\/high, bankai:severity\/medium/);
  });

  // Review finding on #62: the { plan, refused: true } refusal is a --json
  // contract like every other in this file, and an unpinned contract is one a
  // refactor can change silently while callers parse the old shape.
  it("consolidate-close --json emits the { plan, refused: true } contract for the omitted --severity-family refusal", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5,6"],
      [
        {
          match: "gh api repos/o/n/issues/5",
          result: { stdout: JSON.stringify({ number: 5, id: 55, title: "a", state: "open", labels: [{ name: "bankai:severity/high" }] }) },
        },
        {
          match: "gh api repos/o/n/issues/6",
          result: { stdout: JSON.stringify({ number: 6, id: 66, title: "b", state: "open", labels: [{ name: "bankai:severity/medium" }] }) },
        },
      ],
      { repoFlag: BANKAI_REPO, json: true },
    );
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.out.join("\n")) as {
      refused: boolean;
      plan: { unreducedFamilies: readonly { family: string; labels: readonly string[] }[] };
    };
    expect(parsed.refused).toBe(true);
    expect(parsed.plan.unreducedFamilies).toEqual([
      { family: "bankai:severity", labels: ["bankai:severity/high", "bankai:severity/medium"] },
    ]);
  });

  // Review finding on #62: any non-empty --severity-family used to count as
  // "named", so whitespace, a missing colon, a label instead of a family, or a
  // typo skipped BOTH the reduction and the omitted-flag refusal -- issue #22's
  // silent union back through a side door, with exit 0.
  it("consolidate-close exits 2 on a --severity-family with no ':' -- before any gh call", async () => {
    // No scripted calls at all: the shape check must fire before the children
    // are even read, and ScriptedSeams throws on the first unscripted call.
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5,6", "--severity-family", "bankai"],
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--severity-family takes '<ns>:<family>'/);
  });

  it("consolidate-close exits 2 when --severity-family is given a LABEL, and names the family to use instead", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5,6", "--severity-family", "bankai:severity/high"],
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/FAMILY 'bankai:severity', not one of its labels/);
    expect(err).toMatch(/Drop the '\/high'/);
  });

  it("consolidate-close refuses (exit 1) a --severity-family the target taxonomy does not declare, listing the ones it does", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5,6", "--severity-family", "bankai:sevrity"],
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(1);
    const err = result.err.join("\n");
    expect(err).toMatch(/'bankai:sevrity' names no '<ns>:<family>\/<leaf>' label/);
    // Actionable refusal: the families the taxonomy DOES declare, structurally.
    expect(err).toMatch(/bankai:agent, bankai:severity, bankai:stage/);
  });

  it("consolidate-close trims a whitespace-padded --severity-family and reduces normally", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5,6", "--severity-family", "  bankai:severity  "],
      [
        {
          match: "gh api repos/o/n/issues/5",
          result: { stdout: JSON.stringify({ number: 5, id: 55, title: "a", state: "open", labels: [{ name: "bankai:severity/high" }] }) },
        },
        {
          match: "gh api repos/o/n/issues/6",
          result: { stdout: JSON.stringify({ number: 6, id: 66, title: "b", state: "open", labels: [{ name: "bankai:severity/medium" }] }) },
        },
        {
          match:
            "gh pr list --repo o/n --state open --limit 100 --json number,title,url,isDraft,body,closingIssuesReferences",
          result: { stdout: "[]" },
        },
        { match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=55", result: {} },
        { match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=66", result: {} },
        { match: "gh issue close 5 --repo o/n --comment Consolidated into #1.", result: {} },
        { match: "gh issue close 6 --repo o/n --comment Consolidated into #1.", result: {} },
      ],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/severity: bankai:severity\/high \(set by #5\)/);
  });

  it("consolidate-close with an explicit --severity-family reduces to the single strongest label and proceeds", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5,6", "--severity-family", "bankai:severity"],
      [
        {
          match: "gh api repos/o/n/issues/5",
          result: { stdout: JSON.stringify({ number: 5, id: 55, title: "a", state: "open", labels: [{ name: "bankai:severity/high" }] }) },
        },
        {
          match: "gh api repos/o/n/issues/6",
          result: { stdout: JSON.stringify({ number: 6, id: 66, title: "b", state: "open", labels: [{ name: "bankai:severity/medium" }] }) },
        },
        {
          match:
            "gh pr list --repo o/n --state open --limit 100 --json number,title,url,isDraft,body,closingIssuesReferences",
          result: { stdout: "[]" },
        },
        { match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=55", result: {} },
        { match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=66", result: {} },
        { match: "gh issue close 5 --repo o/n --comment Consolidated into #1.", result: {} },
        { match: "gh issue close 6 --repo o/n --comment Consolidated into #1.", result: {} },
      ],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(0);
    const out = result.out.join("\n");
    expect(out).toMatch(/severity: bankai:severity\/high \(set by #5\)/);
    expect(out).not.toMatch(/label union:.*severity/);
  });

  it("consolidate-close still works without --severity-family when no family's labels would collide", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5,6"],
      [
        {
          match: "gh api repos/o/n/issues/5",
          // ONE severity-family label in total across the children: the union
          // carries it once, which is what a reduction would produce anyway.
          result: { stdout: JSON.stringify({ number: 5, id: 55, title: "a", state: "open", labels: [{ name: "bankai:severity/high" }] }) },
        },
        {
          match: "gh api repos/o/n/issues/6",
          result: { stdout: JSON.stringify({ number: 6, id: 66, title: "b", state: "open", labels: [{ name: "bankai:epic" }] }) },
        },
        {
          match:
            "gh pr list --repo o/n --state open --limit 100 --json number,title,url,isDraft,body,closingIssuesReferences",
          result: { stdout: "[]" },
        },
        { match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=55", result: {} },
        { match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=66", result: {} },
        { match: "gh issue close 5 --repo o/n --comment Consolidated into #1.", result: {} },
        { match: "gh issue close 6 --repo o/n --comment Consolidated into #1.", result: {} },
      ],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(0);
  });

  it("issue --help documents --severity-family on consolidate-close", async () => {
    const result = await capture(["issue", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/--severity-family <ns>:<family>/);
  });

  it("consolidate-close proceeds with no guard triggered when no child has an open PR", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5"],
      [
        {
          match: "gh api repos/o/n/issues/5",
          result: { stdout: JSON.stringify({ number: 5, id: 55, title: "child", state: "open", labels: [] }) },
        },
        {
          match:
            "gh pr list --repo o/n --state open --limit 100 --json number,title,url,isDraft,body,closingIssuesReferences",
          result: { stdout: "[]" },
        },
        { match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=55", result: {} },
        { match: "gh issue close 5 --repo o/n --comment Consolidated into #1.", result: {} },
      ],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(0);
  });

  // Review finding #8: an unparseable --chain-labels entry must exit 2, never
  // be silently dropped -- and no gh call is made, since the flag is checked
  // before anything is fetched.
  it("chain-position exits 2 on an unparseable --chain-labels entry (typo'd role)", async () => {
    const result = await capture([
      "issue",
      "chain-position",
      "--target",
      "o/n",
      "--issue",
      "5",
      "--chain-labels",
      "buildng=stage/building",
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/unknown role 'buildng'/);
  });

  // Review finding #14: 'undecidable' is a refusal and must exit non-zero.
  it("chain-position exits 1 when a critical role (here: 'building') was never mapped, even though the issue carries no error", async () => {
    const result = await capture([
      "issue",
      "chain-position",
      "--target",
      "o/n",
      "--issue",
      "5",
      "--chain-labels",
      "idea=mode:idea,epic=type:epic,in-review=mode:review",
    ], [
      {
        match: "gh api repos/o/n/issues/5",
        result: { stdout: JSON.stringify({ number: 5, id: 55, title: "t", state: "open", labels: ["stage/building"] }) },
      },
    ]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/undecidable/);
  });

  it("chain-position exits 0 for a genuine 'routable' answer with every critical role mapped", async () => {
    const result = await capture([
      "issue",
      "chain-position",
      "--target",
      "o/n",
      "--issue",
      "5",
      "--chain-labels",
      "idea=mode:idea,epic=type:epic,in-review=mode:review,building=mode:build",
    ], [
      {
        match: "gh api repos/o/n/issues/5",
        result: { stdout: JSON.stringify({ number: 5, id: 55, title: "t", state: "open", labels: [] }) },
      },
    ]);
    expect(result.code).toBe(0);
  });

  it("terminus exits 2 on an unparseable --chain-labels entry", async () => {
    const result = await capture(["issue", "terminus", "--target", "o/n", "--issue", "5", "--chain-labels", "nonsense"]);
    expect(result.code).toBe(2);
  });

  // Issue #25: fed a PR number, both chain verbs used to answer a plausible,
  // silently wrong classification ('#925: routable', exit 0 -- the issue's own
  // live transcript). The REST issues/{n} payload carries a non-null
  // `pull_request` exactly when the number names a PR, and that is the ONE
  // discriminator (`gh issue view --json pull_request` errors on every
  // object), so the verbs read it at the fetch and refuse.
  const PR_SHAPED = JSON.stringify({
    number: 925,
    id: 90925,
    title: "some pull request",
    state: "open",
    labels: [],
    pull_request: { url: "https://api.github.com/repos/o/n/pulls/925" },
  });

  it("chain-position refuses (exit 1) when --issue names a pull request, with the actionable message", async () => {
    const result = await capture(
      ["issue", "chain-position", "--target", "o/n", "--issue", "925", "--chain-labels", "idea=mode:idea,epic=type:epic,in-review=mode:review,building=mode:build"],
      [{ match: "gh api repos/o/n/issues/925", result: { stdout: PR_SHAPED } }],
    );
    expect(result.code).toBe(1);
    const err = result.err.join("\n");
    expect(err).toMatch(/#925 names a pull request, not an issue; a delivery-chain position is defined only for issues/);
    expect(err).toMatch(/'nen pr' family/);
    // Never the plausible wrong answer the defect produced.
    expect(result.out.join("\n")).not.toMatch(/routable/);
  });

  it("terminus refuses the same PR number -- both verbs carry the guard", async () => {
    const result = await capture(
      ["issue", "terminus", "--target", "o/n", "--issue", "925", "--chain-labels", "epic=type:epic,chore=type:chore"],
      [{ match: "gh api repos/o/n/issues/925", result: { stdout: PR_SHAPED } }],
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/names a pull request, not an issue/);
    expect(result.out.join("\n")).not.toMatch(/own-pr/);
  });

  it("the PR refusal keeps the stable --json shape: refused true, reason, exit 1", async () => {
    const result = await capture(
      ["issue", "terminus", "--target", "o/n", "--issue", "925", "--chain-labels", "epic=type:epic"],
      [{ match: "gh api repos/o/n/issues/925", result: { stdout: PR_SHAPED } }],
      { json: true },
    );
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.out.join("\n")) as { issue: number; refused: boolean; reason: string };
    expect(parsed.issue).toBe(925);
    expect(parsed.refused).toBe(true);
    expect(parsed.reason).toMatch(/names a pull request, not an issue/);
  });

  it("a genuine issue payload (no pull_request key) still classifies via terminus exactly as before", async () => {
    const result = await capture(
      ["issue", "terminus", "--target", "o/n", "--issue", "17", "--chain-labels", "epic=type:epic,chore=type:chore"],
      [
        {
          match: "gh api repos/o/n/issues/17",
          result: { stdout: JSON.stringify({ number: 17, id: 90017, title: "a real issue", state: "open", labels: [] }) },
        },
      ],
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/own-pr/);
  });

  it("issue --help documents the pull-request refusal on the chain verbs", async () => {
    const result = await capture(["issue", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/REFUSE \(exit 1\) when --issue <n> turns out to name a\s+pull request/);
  });
});
