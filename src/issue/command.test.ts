import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import type { FlagSpec } from "../cli/args.js";
import { issueCommand, ISSUE_FLAGS, ISSUE_SUBCOMMANDS, ISSUE_SUBCOMMAND_FLAGS } from "./command.js";

/** A throwaway file, for the two flags that take a path. */
function tempFile(name: string, contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "nen-issue-")), name);
  writeFileSync(path, contents, "utf8");
  return path;
}

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

// zheref/nen#29: nothing in this family could post a comment a CALLER wrote, so
// every mechanized choreography kept one hand-run `gh issue comment` in its
// middle -- the one step with no dry run, no refusal and no seam.
describe("nen issue comment -- the general comment primitive", () => {
  it("posts through the Runner seam with the argv gh would run, and reports the URL", async () => {
    const result = await capture(
      ["issue", "comment", "--target", "o/n", "--issue", "12", "--body", "new evidence: the log line is on stderr."],
      [
        {
          match: "gh issue comment 12 --repo o/n --body new evidence: the log line is on stderr.",
          result: { stdout: "https://github.com/o/n/issues/12#issuecomment-42\n" },
        },
      ],
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toBe(
      "commented on o/n#12 https://github.com/o/n/issues/12#issuecomment-42",
    );
  });

  it("posts a --body-file as a FILE, keeping a body of any size off the command line", async () => {
    const path = tempFile("body.md", "## evidence\n\nthe log line is on stderr.\n");
    const result = await capture(
      ["issue", "comment", "--target", "o/n", "--issue", "12", "--body-file", path],
      [
        {
          match: `gh issue comment 12 --repo o/n --body-file ${path}`,
          result: { stdout: "https://github.com/o/n/issues/12#issuecomment-42\n" },
        },
      ],
    );
    expect(result.code).toBe(0);
  });

  // "--dry-run prints exactly what would be posted" is only true if the bytes
  // have been READ by the time it prints -- the argv alone names a path, and the
  // path's contents are the thing that becomes public.
  it("--dry-run prints the exact call AND the exact bytes, and makes no gh call at all", async () => {
    const path = tempFile("body.md", "## evidence\n\nthe log line is on stderr.");
    const result = await capture(
      ["issue", "comment", "--target", "o/n", "--issue", "12", "--body-file", path, "--dry-run"],
      // No scripted calls: ScriptedSeams throws on the first unscripted one, so
      // a dry run that posted would be a red test rather than a silent write.
      [],
    );
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      `would run: gh issue comment 12 --repo o/n --body-file ${path}`,
      "--- body as it would be posted ---",
      "## evidence",
      "",
      "the log line is on stderr.",
      "--- end of body (no trailing newline) ---",
    ]);
  });

  // ROUND-TWO REVIEW: the fence rendered the body as LINES, and a line-oriented
  // rendering can only show a trailing newline as a blank line before the
  // closing fence -- the one thing a scrollback, a copy-paste or a chat client
  // silently eats. --dry-run's promise is that the bytes printed are the bytes
  // sent, so the fence now states the final byte outright. Both directions are
  // pinned, because a note that is always there says nothing.
  it("--dry-run's fence states whether the body ends with a newline, both ways", async () => {
    const withNewline = tempFile("nl.md", "ship it\n");
    const without = tempFile("no-nl.md", "ship it");
    const argv = (path: string): readonly string[] => [
      "issue",
      "comment",
      "--target",
      "o/n",
      "--issue",
      "12",
      "--body-file",
      path,
      "--dry-run",
    ];

    expect((await capture(argv(withNewline), [])).out).toEqual([
      `would run: gh issue comment 12 --repo o/n --body-file ${withNewline}`,
      "--- body as it would be posted ---",
      "ship it",
      "",
      "--- end of body ---",
    ]);
    expect((await capture(argv(without), [])).out).toEqual([
      `would run: gh issue comment 12 --repo o/n --body-file ${without}`,
      "--- body as it would be posted ---",
      "ship it",
      "--- end of body (no trailing newline) ---",
    ]);
  });

  // The --json half of the same contract needs no note, and this pins WHY: it
  // carries the body verbatim, so the trailing newline is a byte in the value
  // rather than something a rendering has to convey.
  it("--dry-run --json carries the trailing newline verbatim, note or no note", async () => {
    const path = tempFile("nl.md", "ship it\n");
    const result = await capture(
      ["issue", "comment", "--target", "o/n", "--issue", "12", "--body-file", path, "--dry-run"],
      [],
      { json: true },
    );
    expect((JSON.parse(result.out.join("\n")) as { body: string }).body).toBe("ship it\n");
  });

  // ROUND THREE, MINOR 2: --dry-run's whole promise is that the bytes it
  // prints are the bytes that would be sent, and that was only half true for a
  // CRLF --body-file. readTextFile used to normalize `\r\n` -> `\n` for this
  // reading (correct for the changed-file-set readers it exists for), while
  // the argv below hands `gh` the ORIGINAL path -- so `gh` would read the
  // untouched `\r\n` bytes off disk while the transcript and --json showed
  // `\n`-only ones. This fixture pins that both sides now agree: the body
  // comes back with its `\r\n` intact, unmodified from what is on disk, which
  // is exactly what `gh --body-file <path>` would read from that same path.
  it("keeps a CRLF --body-file's bytes exactly as they are on disk for --dry-run, matching what 'gh' reads from the same path", async () => {
    const raw = "line one\r\nline two\r\n";
    const path = tempFile("crlf.md", raw);
    const result = await capture(
      ["issue", "comment", "--target", "o/n", "--issue", "12", "--body-file", path, "--dry-run"],
      [],
      { json: true },
    );
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as { body: string };
    expect(parsed.body).toBe(raw);
    // The file itself was never touched -- the fix is in the READ, not a
    // rewrite of the caller's file.
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("--dry-run --json carries the argv and the resolved body as a stable contract", async () => {
    const result = await capture(
      ["issue", "comment", "--target", "o/n", "--issue", "12", "--body", "hi", "--dry-run"],
      [],
      { json: true },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({
      dryRun: true,
      target: "o/n",
      issue: 12,
      source: "inline",
      argv: ["issue", "comment", "12", "--repo", "o/n", "--body", "hi"],
      body: "hi",
    });
  });

  it("refuses (exit 2) when neither --body nor --body-file was given, naming both", async () => {
    const result = await capture(["issue", "comment", "--target", "o/n", "--issue", "12"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--body-file <path> or --body <text>/);
  });

  it("refuses (exit 2) when BOTH spellings are given, rather than silently posting one", async () => {
    const path = tempFile("body.md", "from the file");
    const result = await capture([
      "issue",
      "comment",
      "--target",
      "o/n",
      "--issue",
      "12",
      "--body",
      "inline",
      "--body-file",
      path,
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/two spellings of ONE input/);
  });

  it("refuses (exit 2) an empty --body", async () => {
    const result = await capture(["issue", "comment", "--target", "o/n", "--issue", "12", "--body", "   "]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--body is empty/);
  });

  it("refuses (exit 2) a --body-file holding nothing but whitespace", async () => {
    const path = tempFile("body.md", "\n\n   \n");
    const result = await capture(["issue", "comment", "--target", "o/n", "--issue", "12", "--body-file", path]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/holds nothing but whitespace/);
  });

  // ACTIONABLE: the refusal names the path it actually looked for, so a caller
  // who mistyped one, or ran from the wrong directory, can see which it was.
  //
  // Review finding: the WHY clause used to be readTextFile's default, written
  // for the changed-file verbs ("would report a clean verdict for a check it
  // never ran") -- a sentence about a check this verb does not run and a verdict
  // it does not render. The actionable half is shared; the rationale is this
  // verb's own.
  it("refuses (exit 2) a --body-file that does not exist, naming the resolved path and THIS verb's reason", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "nen-issue-")), "nope.md");
    const result = await capture(["issue", "comment", "--target", "o/n", "--issue", "12", "--body-file", missing]);
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/could not read/);
    expect(err).toContain("nope.md");
    expect(err).toMatch(/names the bytes this verb posts/);
    expect(err).not.toMatch(/clean verdict for a check it never ran/);
  });

  it("requires --issue", async () => {
    const result = await capture(["issue", "comment", "--target", "o/n", "--body", "hi"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--issue <n>/);
  });

  // Review finding: `Number("1e3")` is 1000 and `Number("0x0c")` is 12 -- both
  // integers, both positive, so the family's `Number(...)` idiom accepted them
  // and this WRITE verb posted the caller's text on a different, perfectly valid
  // issue. The empty script is the assertion that matters: ScriptedSeams throws
  // on the first unscripted call, so a retargeted post would be red rather than
  // silent.
  it.each(["1e3", "0x0c", "12.0", " 12", "+12", "0"])(
    "refuses (exit 2) --issue '%s' rather than letting a loose read retarget the post",
    async (raw) => {
      const result = await capture(["issue", "comment", "--target", "o/n", "--issue", raw, "--body", "hi"], []);
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/--issue <n>: a positive whole number, digits only/);
    },
  );

  // Review finding: the parser refuses a value whose next token starts with '-'
  // so that `--repo --json` cannot swallow the next flag -- correct, and its
  // bare "requires a value" was misleading on the family's first FREE-PROSE
  // flag, where the caller plainly did give one. `--body` makes this reachable,
  // so the refusal names the token and the one unambiguous spelling.
  it("refuses a --body that begins with '-' by naming the --body= spelling, not just 'requires a value'", async () => {
    const result = await capture(["issue", "comment", "--target", "o/n", "--issue", "12", "--body", "-1 on this approach."]);
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/--body requires a value/);
    expect(err).toMatch(/--body='-1 on this approach\.'/);
  });

  it("posts a body that begins with '-' when it is spelled --body=<text>", async () => {
    const result = await capture(
      ["issue", "comment", "--target", "o/n", "--issue", "12", "--body=-1 on this approach."],
      [
        {
          match: "gh issue comment 12 --repo o/n --body -1 on this approach.",
          result: { stdout: "https://github.com/o/n/issues/12#issuecomment-7\n" },
        },
      ],
    );
    expect(result.code).toBe(0);
  });

  // DELIBERATE ACCEPTANCE, not an oversight -- ./comment.ts records the whole
  // argument, and the short form is that this verb classifies nothing, so unlike
  // chain-position/terminus (zheref/nen#25) there is no silently-wrong answer to
  // guard against: the text lands on the object the caller named and the printed
  // URL says so on the next line.
  it("comments on a number that names a PULL REQUEST, deliberately, and reports the pull URL", async () => {
    const result = await capture(
      ["issue", "comment", "--target", "o/n", "--issue", "925", "--body", "rebased onto main."],
      [
        {
          match: "gh issue comment 925 --repo o/n --body rebased onto main.",
          result: { stdout: "https://github.com/o/n/pull/925#issuecomment-9\n" },
        },
      ],
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/pull\/925#issuecomment-9/);
  });

  it("says so rather than staying silent when gh printed no comment URL", async () => {
    const result = await capture(
      ["issue", "comment", "--target", "o/n", "--issue", "12", "--body", "hi"],
      [{ match: "gh issue comment 12 --repo o/n --body hi", result: { stdout: "" } }],
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/gh printed no comment URL/);
  });

  // A family shares one flag spec, so `--body` now parses for every subcommand
  // in it. Before this verb existed, 'issue file --body x' was an `unknown
  // option` (exit 2); accepting-and-ignoring it would have silently dropped the
  // text the caller wrote.
  it("does not weaken 'issue file': --body is still refused there, by name", async () => {
    const result = await capture(
      ["issue", "file", "--target", "o/n", "--title", "t", "--label", "l", "--assignee", "a", "--body", "typed"],
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--body is not a flag of this subcommand/);
  });

  // REVIEW FINDING, AND THE WORST CASE OF IT. Adding `--body` to the shared
  // family spec downgraded it from `unknown option` (exit 2) to accepted-and-
  // ignored on every sibling that did not guard it -- and the most confusable
  // sibling is the OTHER verb in this family that posts comments, which is also
  // a mutating one. At base, this argv exited 2. Between the two commits it
  // exited 0, closed #5 with the DEFAULT `Consolidated into #1.`, and never
  // mentioned that the caller's text had been dropped.
  it("does not weaken 'issue consolidate-close': --body is refused there, not silently swapped for the default close comment", async () => {
    const result = await capture(
      [
        "issue",
        "consolidate-close",
        "--target",
        "o/n",
        "--parent",
        "1",
        "--children",
        "5",
        "--body",
        "Absorbed by section 2.",
        "--dry-run",
      ],
      // Empty: the refusal must land before the first `gh` read, so a close that
      // ran with the wrong text would be red rather than silent.
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/--body is not a flag of this subcommand/);
    expect(err).toMatch(/--close-comment <template>/);
    expect(err).toMatch(/--close-comment-map <path>/);
  });

  // The same regression in the other direction: `--close-comment` is
  // consolidate-close's, and a caller reaching for it at `issue comment` -- the
  // verb whose whole job IS comment text -- must be told which spelling posts.
  it.each(["close-comment", "close-comment-map"])(
    "refuses --%s at 'issue comment' rather than accepting and ignoring it",
    async (flag) => {
      const result = await capture(
        ["issue", "comment", "--target", "o/n", "--issue", "12", `--${flag}`, "x"],
        [],
      );
      expect(result.code).toBe(2);
      const err = result.err.join("\n");
      expect(err).toMatch(new RegExp(`--${flag} is not a flag of this subcommand`));
      expect(err).toMatch(/--body <text> or --body-file <path>/);
    },
  );

  // The guard is DERIVED from every subcommand's own spec, not a call placed
  // wherever a pair looked confusable -- so the read-only verbs, which nobody
  // would think to guard by hand, keep the exit-2 strictness they had at base
  // too. (The exhaustive cross-product lives in its own describe below; these
  // stay as the readable examples.)
  it.each([
    ["search", "body"],
    ["search", "close-comment"],
    ["open-pr-check", "body"],
    ["chain-position", "body"],
    ["terminus", "close-comment-map"],
  ])("keeps the exit-2 strictness base had: 'issue %s' refuses --%s", async (subcommand, flag) => {
    const result = await capture(["issue", subcommand, "--target", "o/n", `--${flag}`, "y"], []);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(new RegExp(`--${flag} is not a flag of this subcommand`));
  });

  // "report the whole problem" -- the idiom splitIntegerList and the
  // close-comment map check already follow. A caller fixing one flag per round
  // trip is the cost this repository designs against everywhere else.
  it("names EVERY foreign flag of the invocation in one refusal", async () => {
    const result = await capture(
      ["issue", "search", "--target", "o/n", "--subject", "x", "--body", "a", "--close-comment", "b"],
      [],
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/--body is not a flag of this subcommand/);
    expect(err).toMatch(/--close-comment is not a flag of this subcommand/);
  });

  it("issue --help documents the comment verb, both body spellings, and the --body= escape", async () => {
    const result = await capture(["issue", "--help"]);
    expect(result.code).toBe(0);
    const out = result.out.join("\n");
    expect(out).toMatch(/nen issue comment --target <owner\/name> --issue <n>/);
    expect(out).toMatch(/\(--body-file <path> \| --body <text>\) \[--dry-run\]/);
    expect(out).toMatch(/BEGINS WITH '-' must be spelled --body=<text>/);
  });
});

// THE COVERAGE TEST FOR THE DERIVED GUARD (round-two review's MAJOR, and the
// same shape as zheref/nen#74's parseArgs-coupling test one directory over).
//
// The hand-maintained `flag -> one owner` table this replaced could not express
// a flag with TWO owners, so `--body-file` -- real on `file` and `comment`,
// foreign to the other five -- was simply left out, and `consolidate-close
// --body-file <path>` parsed, was ignored, closed the children with the DEFAULT
// comment and exited 0. A hand-written list of examples is exactly what missed
// it, so this test writes no list: it derives the foreign set from the REAL
// specs and drives the whole cross-product through the REAL CLI. A new flag on
// one subcommand, or a whole new subcommand, is covered the moment it is
// declared -- and a flag that reappears in the parser with no owner turns the
// coupling assertion red instead of quietly reopening the hole.
describe("nen issue -- foreign flags derived from each subcommand's own spec (round two)", () => {
  /**
   * A runnable, flags-this-subcommand-OWNS invocation per subcommand. Values
   * only need to parse: the guard fires before the subcommand runs, so nothing
   * here is ever read from disk or sent to `gh`.
   */
  const BASE: Readonly<Record<string, readonly string[]>> = {
    search: ["--target", "o/n", "--subject", "x"],
    "open-pr-check": ["--target", "o/n", "--issues", "1"],
    file: ["--target", "o/n", "--title", "t", "--body-file", "b.md", "--label", "l", "--assignee", "a"],
    comment: ["--target", "o/n", "--issue", "1", "--body", "hi"],
    "attach-sub": ["--target", "o/n", "--parent", "1", "--children", "2"],
    "consolidate-close": ["--target", "o/n", "--parent", "1", "--children", "2"],
    "chain-position": ["--target", "o/n", "--issue", "1"],
    terminus: ["--target", "o/n", "--issue", "1"],
  };

  const valueFlags = new Set(ISSUE_FLAGS.values ?? []);
  const booleanFlags = new Set(ISSUE_FLAGS.booleans ?? []);
  const allFlags = [...valueFlags, ...booleanFlags].sort();

  /** Every (subcommand, flag) pair the guard must refuse, straight off the specs. */
  const foreignPairs: { subcommand: string; flag: string }[] = [];
  for (const subcommand of ISSUE_SUBCOMMANDS) {
    const spec = ISSUE_SUBCOMMAND_FLAGS[subcommand];
    for (const flag of allFlags) {
      if (spec !== undefined && !declaresFlag(spec, flag)) foreignPairs.push({ subcommand, flag });
    }
  }

  function declaresFlag(spec: FlagSpec, flag: string): boolean {
    return (spec.values ?? []).includes(flag) || (spec.booleans ?? []).includes(flag);
  }

  // THE COUPLING. The parser's spec must be exactly the union of the
  // per-subcommand specs -- a flag in the parser that no subcommand declares is
  // a flag the guard cannot see and the verb ignores, which is the whole class
  // of defect this rewrite closes.
  it("the family's parsed flags are exactly the union of its subcommands' own specs", () => {
    const unionValues = new Set<string>();
    const unionBooleans = new Set<string>();
    for (const spec of Object.values(ISSUE_SUBCOMMAND_FLAGS)) {
      for (const flag of spec.values ?? []) unionValues.add(flag);
      for (const flag of spec.booleans ?? []) unionBooleans.add(flag);
    }
    expect([...valueFlags].sort()).toEqual([...unionValues].sort());
    expect([...booleanFlags].sort()).toEqual([...unionBooleans].sort());
    // And the two subcommand lists cannot drift either: the run() switch's
    // known-names list is read off the same table.
    expect([...ISSUE_SUBCOMMANDS].sort()).toEqual(Object.keys(ISSUE_SUBCOMMAND_FLAGS).sort());
    expect([...ISSUE_SUBCOMMANDS].sort()).toEqual(Object.keys(BASE).sort());
  });

  // NON-VACUITY. A guard that refuses nothing passes every refusal assertion
  // below by never being asked, so the cross-product must be big and must reach
  // every subcommand -- `--body-file`, the flag the old table could not hold,
  // named explicitly because it is the finding.
  it("has a foreign flag for every subcommand, and --body-file is foreign to five of them", () => {
    expect(foreignPairs.length).toBeGreaterThan(50);
    for (const subcommand of ISSUE_SUBCOMMANDS) {
      expect(
        foreignPairs.some((pair): boolean => pair.subcommand === subcommand),
        `'issue ${subcommand}' has no foreign flag at all -- the guard is vacuous for it`,
      ).toBe(true);
    }
    expect(
      foreignPairs.filter((pair): boolean => pair.flag === "body-file").map((pair): string => pair.subcommand),
    ).toEqual(["search", "open-pr-check", "attach-sub", "consolidate-close", "chain-position", "terminus"]);
  });

  it.each(foreignPairs.map((pair): [string, string] => [pair.subcommand, pair.flag]))(
    "'issue %s' refuses the foreign --%s at exit 2, naming an owner",
    async (subcommand, flag) => {
      const base = BASE[subcommand] ?? [];
      const argv = [
        "issue",
        subcommand,
        ...base,
        `--${flag}`,
        // A boolean takes no value; a value flag needs one to parse at all.
        ...(booleanFlags.has(flag) ? [] : ["v"]),
      ];
      // Empty script: ScriptedSeams throws on the first unscripted call, so a
      // refusal that landed AFTER a `gh` read would be red rather than silent.
      const result = await capture(argv, [], { repoFlag: BANKAI_REPO });
      expect(result.code).toBe(2);
      const err = result.err.join("\n");
      expect(err).toContain(`--${flag} is not a flag of this subcommand`);
      // Whatever the wording, the refusal must point at a subcommand that DOES
      // declare the flag -- a refusal that names no destination is a dead end.
      const owners = ISSUE_SUBCOMMANDS.filter((name): boolean => {
        const spec = ISSUE_SUBCOMMAND_FLAGS[name];
        return spec !== undefined && declaresFlag(spec, flag);
      });
      expect(owners.length).toBeGreaterThan(0);
      expect(owners.some((owner): boolean => err.includes(`'issue ${owner}'`))).toBe(true);
    },
  );

  // The control: every base invocation must get PAST the guard, or the sweep
  // above would pass by refusing everything.
  it.each(ISSUE_SUBCOMMANDS)("does not refuse 'issue %s's own flags", async (subcommand) => {
    const result = await capture(["issue", subcommand, ...(BASE[subcommand] ?? [])], [], {
      repoFlag: BANKAI_REPO,
    });
    expect(result.err.join("\n")).not.toContain("is not a flag of this subcommand");
  });

  // THE REGRESSION, spelled out on its own because it is the finding: this
  // exact argv exited 0 in round one, closed #5 with `Consolidated into #1.`,
  // and never said the caller's file had been dropped.
  it("refuses 'consolidate-close --body-file <path> --dry-run' at exit 2, before any plan work", async () => {
    const result = await capture(
      [
        "issue",
        "consolidate-close",
        "--target",
        "o/n",
        "--parent",
        "1",
        "--children",
        "5",
        "--body-file",
        "close.md",
        "--dry-run",
      ],
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toContain("--body-file is not a flag of this subcommand");
    // And it says what DOES carry the close text, both spellings.
    expect(err).toMatch(/--close-comment <template>/);
    expect(err).toMatch(/--close-comment-map <path>/);
  });

  // The minor the same rewrite closed: the untabled flags nobody had enumerated
  // were all accepted-and-ignored at exit 0 too.
  it.each([
    ["chain-position", "title"],
    ["file", "severity-family"],
    ["search", "trunk"],
    ["terminus", "allow-open-pr"],
    ["open-pr-check", "dry-run"],
  ])("'issue %s' refuses the previously-untabled --%s", async (subcommand, flag) => {
    const argv = [
      "issue",
      subcommand,
      ...(BASE[subcommand] ?? []),
      `--${flag}`,
      ...(booleanFlags.has(flag) ? [] : ["v"]),
    ];
    const result = await capture(argv, [], { repoFlag: BANKAI_REPO });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain(`--${flag} is not a flag of this subcommand`);
  });

  // The generic arm no longer asserts anything about COMMENTING -- it used to
  // end "'issue <sub>' posts no comment", which is a claim about a verb that
  // has nothing to do with the flag being refused.
  it("the generic advice names the owners and claims nothing else about the verb", async () => {
    const result = await capture(["issue", "file", "--target", "o/n", "--trunk", "main"], [], {
      repoFlag: BANKAI_REPO,
    });
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toContain("--trunk is not a flag of this subcommand. It belongs to 'issue terminus'.");
    expect(err).not.toContain("posts no comment");
  });

  // Two owners render as two owners -- the shape the old Record<string,string>
  // could not hold at all -- and four render as a sentence rather than a chain
  // of "and"s, because a refusal a caller does not read is a refusal they route
  // around.
  it("names BOTH owners of a two-owner flag, and conjoins a four-owner one", async () => {
    const two = await capture(["issue", "search", "--target", "o/n", "--body-file", "b.md"], []);
    expect(two.code).toBe(2);
    expect(two.err.join("\n")).toContain("It belongs to 'issue file' and 'issue comment'.");

    const four = await capture(["issue", "search", "--target", "o/n", "--dry-run"], []);
    expect(four.code).toBe(2);
    expect(four.err.join("\n")).toContain(
      "It belongs to 'issue file', 'issue comment', 'issue attach-sub' and 'issue consolidate-close'.",
    );
  });

  // ROUND THREE, MINOR 4: deriving --dry-run's ownership from the real specs
  // changed its behaviour on these four READ-ONLY verbs -- they used to accept
  // and silently ignore it (exit 0, nothing to preview because nothing was
  // ever written) and now refuse it (exit 2) like any other foreign flag. The
  // direction is right; this pins that the WORDING is honest about it: the
  // refusal says the verb never wrote anything and the flag never did
  // anything either way, rather than just pointing at --dry-run's four WRITING
  // owners as if the caller had typed it at the wrong verb.
  it.each(["search", "open-pr-check", "chain-position", "terminus"])(
    "'issue %s --dry-run' is refused with the read-only rationale, not only the generic owners list",
    async (subcommand) => {
      const result = await capture(["issue", subcommand, ...(BASE[subcommand] ?? []), "--dry-run"], [], {
        repoFlag: BANKAI_REPO,
      });
      expect(result.code).toBe(2);
      const err = result.err.join("\n");
      expect(err).toContain("--dry-run is not a flag of this subcommand");
      expect(err).toContain(`'issue ${subcommand}' itself never writes anything`);
      expect(err).toMatch(/--dry-run never changed what it ran/);
      expect(err).toMatch(/accepted and silently ignored \(exit 0\)/);
      expect(err).toMatch(/refused now \(exit 2\)/);
      // The generic owners sentence is still there too -- naming what
      // --dry-run DOES belong to remains useful, it is just not the whole
      // answer for a verb that never had a write to preview.
      expect(err).toContain(
        "It belongs to 'issue file', 'issue comment', 'issue attach-sub' and 'issue consolidate-close'.",
      );
    },
  );
});

// zheref/nen#29's second half: consolidate-close's close message was a fixed
// string, so a caller whose choreography closes each absorbed member with a
// comment naming WHICH section absorbed it had to follow the verb with a
// hand-run `gh issue comment` per child.
describe("nen issue consolidate-close -- the caller-supplied close comment", () => {
  const CHILD_5 = {
    match: "gh api repos/o/n/issues/5",
    result: { stdout: JSON.stringify({ number: 5, id: 55, title: "a", state: "open", labels: [] }) },
  };
  const CHILD_6 = {
    match: "gh api repos/o/n/issues/6",
    result: { stdout: JSON.stringify({ number: 6, id: 66, title: "b", state: "open", labels: [] }) },
  };
  const NO_OPEN_PRS = {
    match:
      "gh pr list --repo o/n --state open --limit 100 --json number,title,url,isDraft,body,closingIssuesReferences",
    result: { stdout: "[]" },
  };

  // BACK-COMPAT, AT THE CLI: omitting the flags posts what it always posted.
  it("omitting both flags closes with the historical fixed string, byte for byte", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5"],
      [
        CHILD_5,
        NO_OPEN_PRS,
        { match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=55", result: {} },
        { match: "gh issue close 5 --repo o/n --comment Consolidated into #1.", result: {} },
      ],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/closed #5 with a comment naming #1/);
  });

  it("--close-comment replaces the text for every child, substituting {parent}/{child}", async () => {
    const result = await capture(
      [
        "issue",
        "consolidate-close",
        "--target",
        "o/n",
        "--parent",
        "1",
        "--children",
        "5,6",
        "--close-comment",
        "Absorbed into #{parent} (was #{child}).",
      ],
      [
        CHILD_5,
        CHILD_6,
        NO_OPEN_PRS,
        { match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=55", result: {} },
        { match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=66", result: {} },
        { match: "gh issue close 5 --repo o/n --comment Absorbed into #1 (was #5).", result: {} },
        { match: "gh issue close 6 --repo o/n --comment Absorbed into #1 (was #6).", result: {} },
      ],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(0);
  });

  it("--close-comment-map gives each child ITS OWN text -- the per-child channel the issue names", async () => {
    const path = tempFile(
      "closes.json",
      JSON.stringify({
        "5": "Absorbed by section 2 of #{parent}.",
        "6": "Absorbed by section 4 of #{parent}.",
      }),
    );
    const result = await capture(
      [
        "issue",
        "consolidate-close",
        "--target",
        "o/n",
        "--parent",
        "1",
        "--children",
        "5,6",
        "--close-comment-map",
        path,
      ],
      [
        CHILD_5,
        CHILD_6,
        NO_OPEN_PRS,
        { match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=55", result: {} },
        { match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=66", result: {} },
        { match: "gh issue close 5 --repo o/n --comment Absorbed by section 2 of #1.", result: {} },
        { match: "gh issue close 6 --repo o/n --comment Absorbed by section 4 of #1.", result: {} },
      ],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/closed #5 with the caller-supplied close comment/);
  });

  it("--dry-run shows the RENDERED close comment for each child and posts nothing", async () => {
    const result = await capture(
      [
        "issue",
        "consolidate-close",
        "--target",
        "o/n",
        "--parent",
        "1",
        "--children",
        "5",
        "--close-comment",
        "Absorbed by section 2 of #{parent}.",
        "--dry-run",
      ],
      [CHILD_5, NO_OPEN_PRS],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "would run: gh issue close 5 --repo o/n --comment Absorbed by section 2 of #1.",
    );
  });

  it("--json reports the rendered close comments, so a machine caller can see its own substitution", async () => {
    const result = await capture(
      [
        "issue",
        "consolidate-close",
        "--target",
        "o/n",
        "--parent",
        "1",
        "--children",
        "5",
        "--close-comment",
        "Absorbed by section 2 of #{parent}.",
        "--dry-run",
      ],
      [CHILD_5, NO_OPEN_PRS],
      { repoFlag: BANKAI_REPO, json: true },
    );
    const parsed = JSON.parse(result.out.join("\n")) as {
      report: { closeComments: readonly { child: number; body: string }[] };
    };
    expect(parsed.report.closeComments).toEqual([{ child: 5, body: "Absorbed by section 2 of #1." }]);
  });

  // Every refusal below fires BEFORE a single gh call -- no scripted calls, so
  // ScriptedSeams throws if one is made.
  it("exits 2 when both --close-comment and --close-comment-map are given", async () => {
    const path = tempFile("closes.json", JSON.stringify({ "5": "x" }));
    const result = await capture(
      [
        "issue",
        "consolidate-close",
        "--target",
        "o/n",
        "--parent",
        "1",
        "--children",
        "5",
        "--close-comment",
        "x",
        "--close-comment-map",
        path,
      ],
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/two spellings of ONE input/);
  });

  it("exits 2 on an unknown {placeholder}, which would otherwise be posted literally", async () => {
    const result = await capture(
      [
        "issue",
        "consolidate-close",
        "--target",
        "o/n",
        "--parent",
        "1",
        "--children",
        "5",
        "--close-comment",
        "Absorbed by {section} of #{parnet}.",
      ],
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/\{section\}, \{parnet\}/);
    expect(err).toMatch(/\{parent\}, \{child\}/);
  });

  // REVIEW FINDING, verified live at exit 0 before this: the guard matched only
  // brace runs whose interior was word characters, so `#{{parent}}` posted
  // `#{1}` and `#{ parent }` posted itself -- both onto a public timeline, by a
  // verb that closes issues. The empty script is the assertion: the refusal
  // lands before the first `gh` read.
  it.each(["Absorbed into #{{parent}}.", "Absorbed into #{ parent }.", "Absorbed into #{parent }."])(
    "exits 2 on the mis-spelled placeholder in %s rather than posting it literally",
    async (template) => {
      const result = await capture(
        ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5", "--close-comment", template],
        [],
        { repoFlag: BANKAI_REPO },
      );
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/unknown placeholder/);
    },
  );

  // ROUND-TWO REVIEW, THE OTHER HALF OF THE SAME KEYSTROKE: the brace-run scan
  // required braces on BOTH sides, so a DROPPED closing brace matched nothing
  // at all -- neither refused nor substituted -- and `Consolidated into
  // #{parent` went out literally on a REAL close, at exit 0. The refusal names
  // the fragment, not just the character, so the caller can see which word they
  // meant to spell.
  it.each([
    ["Absorbed into #{parent.", "{parent."],
    ["Absorbed into {child by #9.", "{child"],
    ["Absorbed into parent} of #9.", "}"],
  ])("exits 2 on the unmatched brace in %s rather than posting it literally", async (template, offender) => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5", "--close-comment", template],
      // Empty: the refusal must land before the first `gh` read.
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/unmatched brace/);
    expect(err).toContain(`'${offender}'`);
  });

  // A template carrying one of each is told about both at once -- the "report
  // the whole problem" idiom, applied to the two brace faults.
  it("names an unmatched brace AND an unknown placeholder in one refusal", async () => {
    const result = await capture(
      [
        "issue",
        "consolidate-close",
        "--target",
        "o/n",
        "--parent",
        "1",
        "--children",
        "5",
        "--close-comment",
        "{section} absorbed #{parent",
      ],
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/unmatched brace '\{parent'/);
    expect(err).toMatch(/unknown placeholder \{section\}/);
  });

  it("names the widened guard in --help, so the refusal is not a surprise", async () => {
    const out = (await capture(["issue", "--help"])).out.join("\n");
    expect(out).toMatch(/Any OTHER run of braces is a usage error/);
    expect(out).toMatch(/a brace with no partner/);
    expect(out).toMatch(/the dropped-brace '#\{parent'/);
  });

  it("exits 2 on an empty --close-comment rather than closing a child saying nothing", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5", "--close-comment", "  "],
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--close-comment is empty/);
  });

  // A map that is a SUBSET closes some children with the default while their
  // siblings get bespoke text -- the half-mechanized state this channel exists
  // to remove, and invisible afterwards.
  it("exits 2 when the map has no entry for a named child, naming which", async () => {
    const path = tempFile("closes.json", JSON.stringify({ "5": "Absorbed by section 2." }));
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5,6", "--close-comment-map", path],
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/no entry for #6/);
  });

  // ...and a SUPERSET is text the caller wrote that nobody would ever see.
  it("exits 2 when the map names a child --children does not, naming which", async () => {
    const path = tempFile("closes.json", JSON.stringify({ "5": "a", "7": "b" }));
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5", "--close-comment-map", path],
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/an entry for #7/);
  });

  it("exits 2 on a map key that is not an issue number", async () => {
    const path = tempFile("closes.json", JSON.stringify({ "#5": "a" }));
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5", "--close-comment-map", path],
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/keys are child issue NUMBERS/);
  });

  it("exits 2 on a map that is a JSON array rather than an object", async () => {
    const path = tempFile("closes.json", JSON.stringify(["a"]));
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5", "--close-comment-map", path],
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/must hold a JSON OBJECT/);
  });

  it("exits 2 on a --close-comment-map path that does not exist", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "nen-issue-")), "nope.json");
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5", "--close-comment-map", missing],
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/could not read/);
  });

  /** A fresh --repo root: real enough for loadLabelTaxonomy, empty otherwise. */
  function tempRepoRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "nen-issue-repo-"));
    mkdirSync(join(root, "schemas"));
    writeFileSync(
      join(root, "schemas", "labels.json"),
      readFileSync(join(BANKAI_REPO, "schemas", "labels.json"), "utf8"),
    );
    return root;
  }

  // ROUND THREE, MAJOR: consolidate() computes the --repo root with
  // assertRepoRoot() three statements before it reads --close-comment-map, and
  // every OTHER file-reading flag in this binary (pr body-check --body-from,
  // backlog order --from, board/changelog/release/label/gate's own reads)
  // resolves a relative path against that root with zero exceptions. This map
  // path used to be the one exception, resolved against process.cwd()
  // instead. The map file lives INSIDE a --repo far from this test process's
  // own cwd, named with a bare relative path, so a cwd-relative resolution
  // would report "could not read" here and a root-relative one finds it.
  it("resolves a relative --close-comment-map path against --repo's root, not process.cwd()", async () => {
    const root = tempRepoRoot();
    writeFileSync(
      join(root, "closes.json"),
      JSON.stringify({ "5": "Absorbed by section 2 of #{parent}." }),
    );

    const result = await capture(
      [
        "issue",
        "consolidate-close",
        "--target",
        "o/n",
        "--parent",
        "1",
        "--children",
        "5",
        "--close-comment-map",
        "closes.json", // relative: must resolve against --repo's root
      ],
      [
        CHILD_5,
        NO_OPEN_PRS,
        { match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=55", result: {} },
        { match: "gh issue close 5 --repo o/n --comment Absorbed by section 2 of #1.", result: {} },
      ],
      { repoFlag: root },
    );
    expect(result.code).toBe(0);
  });

  // The other half of the same finding: a relative path that does NOT exist at
  // --repo's root is refused NAMING THE ROOT-RESOLVED PATH, not a path under
  // process.cwd() the caller never typed and the checkout has nothing to do
  // with.
  it("names the --repo-resolved path in the refusal for a relative --close-comment-map that does not exist there", async () => {
    const root = tempRepoRoot();
    // closes.json is deliberately never written under `root`.

    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5", "--close-comment-map", "closes.json"],
      [],
      { repoFlag: root },
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/could not read/);
    expect(err).toContain(join(root, "closes.json"));
  });

  // ROUND THREE, MINOR 1: readCloseComments's own header promises the caller
  // is "told everything wrong with it at once", and a map with TWO bad entries
  // used to break that promise -- a throwing `reject()` stopped the loop on
  // the FIRST malformed entry, so a caller who fixed '5' and re-ran only THEN
  // heard about '6'. Two DIFFERENT fault kinds here (empty text; an unknown
  // placeholder), both named in one refusal, from one round trip.
  it("collects every malformed --close-comment-map entry and refuses naming all of them, not just the first", async () => {
    const path = tempFile(
      "closes.json",
      JSON.stringify({
        "5": "   ",
        "6": "Absorbed by {oops}.",
      }),
    );
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5,6", "--close-comment-map", path],
      // Empty script: the refusal must land before any `gh` read, AND both
      // entries must have been inspected -- a version that threw from inside
      // the loop on '5' would never even look at '6'.
      [],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/entry '5' is empty/);
    expect(err).toMatch(/entry '6' carries an unknown placeholder \{oops\}/);
  });

  // The issue asked for the channel on consolidate-close "and/or" attach-sub.
  // Leaving attach-sub out is a decision, so a caller who tries it is TOLD --
  // an accepted-and-ignored flag would read as "the comment was posted".
  it("attach-sub refuses a close-comment flag by name rather than ignoring it", async () => {
    const result = await capture(
      ["issue", "attach-sub", "--target", "o/n", "--parent", "1", "--children", "5", "--close-comment", "x"],
      [],
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/--close-comment is not a flag of this subcommand/);
    expect(err).toMatch(/posts no comment/);
  });

  it("issue --help documents both close-comment flags and the placeholder vocabulary", async () => {
    const result = await capture(["issue", "--help"]);
    const out = result.out.join("\n");
    expect(out).toMatch(/--close-comment <template>/);
    expect(out).toMatch(/--close-comment-map <path>/);
    expect(out).toMatch(/\{parent\} and \{child\}/);
  });
});
