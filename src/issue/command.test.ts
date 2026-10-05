import { describe, expect, it } from "vitest";
import { cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import type { FlagSpec } from "../cli/args.js";
import { issueCommand, ISSUE_FLAGS, ISSUE_SUBCOMMANDS, ISSUE_SUBCOMMAND_FLAGS } from "./command.js";
import { mergedPullsArgv } from "./reconcile.js";

/** sha256 hex of a string's UTF-8 bytes -- the hash --expect-body-sha256 takes. */
function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A throwaway file, for the two flags that take a path. */
function tempFile(name: string, contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "nen-issue-")), name);
  writeFileSync(path, contents, "utf8");
  return path;
}

/** The three verbs that run the private-name guard (zheref/nen#329). */
const GUARDED_SUBCOMMANDS: readonly string[] = ["file", "comment", "edit-body"];

/**
 * THE DEFAULT PRIVATE-NAME GUARD ANSWER, for every test that is not about it.
 *
 * `file`, `comment` and `edit-body` read the target's visibility before any
 * write (zheref/nen#329). A test about something else gets that read answered
 * "private" -- so the guard skips and reads no list -- and the read is left out
 * of `calls`, so those tests keep asserting the calls THEIR behaviour makes.
 * The guard's own describe block passes `privateGuard: "scripted"`, scripts
 * every read itself and sees every call.
 */
function privateTargetRow(argv: readonly string[]): ScriptedCall | null {
  if (argv[0] !== "issue" || !GUARDED_SUBCOMMANDS.includes(argv[1] ?? "")) return null;
  const at = argv.indexOf("--target");
  const slug = at >= 0 ? argv[at + 1] : undefined;
  if (slug === undefined) return null;
  return { match: `gh api repos/${slug}`, result: { stdout: JSON.stringify({ visibility: "private" }) } };
}

async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  options: { repoFlag?: string | null; json?: boolean; now?: Date; privateGuard?: "private-target" | "scripted" } = {},
): Promise<{ code: number; out: string[]; err: string[]; calls: readonly string[] }> {
  const guardRow = options.privateGuard === "scripted" ? null : privateTargetRow(argv);
  if (guardRow !== null) script = [guardRow, ...script];
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
  return {
    code,
    out,
    err,
    // The shim log, so a refusal test can assert "and it wrote NOTHING"
    // positively rather than only by the absence of a scripted write.
    calls: scripted.calls
      .map((call): string => [call.command, ...call.args].join(" "))
      .filter((line): boolean => guardRow === null || line !== guardRow.match),
  };
}

/**
 * Every call a run made that is NOT a plain read -- the CLI-layer twin of
 * ./subissue.test.ts's `writes()`, and an allowlist for the same reason: a
 * "refused before any write" claim must be about EVERY write, not about the
 * two argv shapes this family happens to use today. A read is `gh api <path>`
 * or one of the read-only `gh` queries these verbs make; everything else --
 * a POST/PATCH/PUT/DELETE, `gh issue close`, `gh issue comment`, `gh issue
 * edit`, `gh label ...` -- counts.
 */
function writes(calls: readonly string[]): readonly string[] {
  return calls.filter(
    (line): boolean =>
      !/^gh api [^ -][^ ]*$/.test(line) && !/^gh (pr|issue|search) (list|view) /.test(line),
  );
}

/**
 * The `--parent 1` READ, which zheref/nen#77 added.
 *
 * Both choreography verbs now certify the parent as an ISSUE before their
 * first write -- nothing had ever looked at that number, so a pull request in
 * --parent collected sub-issues, or closed children into itself, at exit 0.
 * Every script that reaches the attach stage carries this row; a script that
 * refuses BEFORE it deliberately does not, so ScriptedSeams' "unscripted
 * subprocess" throw stays the assertion that the refusal came first.
 */
const PARENT_1: ScriptedCall = {
  match: "gh api repos/o/n/issues/1",
  result: {
    stdout: JSON.stringify({ number: 1, id: 11, title: "the consolidated issue", state: "open", labels: [] }),
  },
};

describe("nen issue -- CLI wiring", () => {
  // zheref/nen#93: EXIT 2, not 1. Four families each kept a private
  // `requireTarget` that threw a plain Error, so sixteen verbs answered a
  // forgotten flag with "the thing you asked for did not work" instead of "you
  // typed it wrong" -- and a retry wrapper honouring that distinction retries a
  // 1 forever. One shared `requireTargetFlag` now answers for all of them, the
  // way every OTHER required flag in these same families already did.
  it("requires --target, as a USAGE error", async () => {
    const result = await capture(["issue", "search", "--subject", "x"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--target owner\/name is required/);
    expect(result.err.join("\n")).toMatch(/--repo names a checkout on disk/);
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
        // The parent read is the object-class certification's, which now runs
        // BEFORE this guard (zheref/nen#77 review) -- so every consolidate
        // script that gets as far as a plan carries it.
        PARENT_1,
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
        PARENT_1,
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
        PARENT_1,
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
        PARENT_1,
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
        PARENT_1,
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
        PARENT_1,
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
        PARENT_1,
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
        PARENT_1,
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

  // #25's own review noted this gap: only terminus's --json refusal was
  // pinned, and chain-position's went through the same helper unverified.
  // Both are pinned now, so a change to the shared renderer cannot silently
  // change one caller's contract.
  it("chain-position's --json refusal carries the SAME shape terminus's does", async () => {
    const result = await capture(
      ["issue", "chain-position", "--target", "o/n", "--issue", "925", "--chain-labels", "epic=type:epic"],
      [{ match: "gh api repos/o/n/issues/925", result: { stdout: PR_SHAPED } }],
      { json: true },
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toEqual({
      issue: 925,
      refused: true,
      reason: expect.stringContaining("names a pull request, not an issue"),
    });
  });

  // zheref/nen#82 review: the `--json` shape's `issue` field has always come
  // from the CLI-typed argument, but `reason` (NotAnIssueError's message) used
  // to come from the PAYLOAD's number -- so a caller reading both fields could
  // catch them disagreeing on the one case that tells the two apart, a GitHub
  // redirect. `--issue 925` is requested; the payload answers as `926`. Both
  // fields must now name #925, never #926.
  it("on a redirect, the --json refusal's 'issue' and 'reason' agree on the REQUESTED number, not the payload's", async () => {
    const result = await capture(
      ["issue", "chain-position", "--target", "o/n", "--issue", "925", "--chain-labels", "epic=type:epic"],
      [
        {
          match: "gh api repos/o/n/issues/925",
          result: {
            stdout: JSON.stringify({
              number: 926,
              id: 90926,
              title: "some pull request",
              state: "open",
              labels: [],
              pull_request: { url: "https://api.github.com/repos/o/n/pulls/926" },
            }),
          },
        },
      ],
      { json: true },
    );
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.out.join("\n")) as { issue: number; refused: boolean; reason: string };
    expect(parsed.issue).toBe(925);
    expect(parsed.reason).toMatch(/#925 names a pull request/);
    expect(parsed.reason).not.toMatch(/#926/);
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
          match: `gh issue comment 12 --repo o/n --body-file -`,
          result: { stdout: "https://github.com/o/n/issues/12#issuecomment-42\n" },
        },
      ],
    );
    expect(result.code).toBe(0);
  });

  // "--dry-run prints exactly what would be posted" is only true if the bytes
  // have been READ by the time it prints -- the argv alone names a path, and the
  // path's contents are the thing that becomes public.
  // Since zheref/nen#329 the dry run READS (the private-name guard's
  // visibility read, answered by capture()'s default row) and still WRITES
  // nothing.
  it("--dry-run prints the exact call AND the exact bytes, and makes no gh write", async () => {
    const path = tempFile("body.md", "## evidence\n\nthe log line is on stderr.");
    const result = await capture(
      ["issue", "comment", "--target", "o/n", "--issue", "12", "--body-file", path, "--dry-run"],
      // No scripted calls beyond the guard's default: ScriptedSeams throws on
      // the first unscripted one, so a dry run that posted would be a red test
      // rather than a silent write.
      [],
    );
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      `would run: gh issue comment 12 --repo o/n --body-file -`,
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
      `would run: gh issue comment 12 --repo o/n --body-file -`,
      "--- body as it would be posted ---",
      "ship it",
      "",
      "--- end of body ---",
    ]);
    expect((await capture(argv(without), [])).out).toEqual([
      `would run: gh issue comment 12 --repo o/n --body-file -`,
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

  // zheref/nen#75's review: every --body-file test above uses an ABSOLUTE temp
  // path, so nothing pinned how a RELATIVE one resolves. command.ts's own call
  // reads `readTextFile(bodyFile, process.cwd(), ..., true)` -- the SAME base
  // `gh --body-file rel.md` itself would use, never `--repo` (the flag `issue
  // file`'s schema read uses `--repo` for, for an unrelated purpose). Pin it
  // with two files of the same relative name in two different directories, so
  // a future refactor that resolved against --repo instead would read the
  // WRONG one and this test would see the decoy's text.
  // zheref/nen#100 REVERSED THIS, deliberately. `--body-file` used to resolve
  // against the process's directory while `--gates`, `--changelog`, `--ledger`
  // and every taxonomy file resolved against `--repo` -- two bases on one
  // surface. Nothing was inconsistent within an invocation run from the
  // repository root, which is why it survived; it appears the moment a caller
  // runs from somewhere else, and then this verb reads THIS tree's file while
  // every other flag on the line reads the named tree's. The decoy below is
  // what that costs when both files exist.
  it("resolves a RELATIVE --body-file against --repo, not the process's directory", async () => {
    const cwdDir = mkdtempSync(join(tmpdir(), "nen-issue-cwd-"));
    const repoDir = mkdtempSync(join(tmpdir(), "nen-issue-repo-"));
    // The decoy is now the one in the PROCESS's directory: a file at the same
    // relative name that must NOT be read.
    writeFileSync(join(cwdDir, "rel.md"), "the decoy the process happens to stand beside\n", "utf8");
    writeFileSync(join(repoDir, "rel.md"), "the file under --repo\n", "utf8");
    const previous = process.cwd();
    try {
      process.chdir(cwdDir);
      const result = await capture(
        ["issue", "comment", "--target", "o/n", "--issue", "12", "--body-file", "rel.md", "--dry-run"],
        [],
        { repoFlag: repoDir, json: true },
      );
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.out.join("\n")) as { body: string; argv: string[]; bodyFile: string };
      expect(parsed.body).toBe("the file under --repo\n");
      // AND THE PATH HANDED TO `gh` IS THE SAME ONE (Copilot, PR #197). The
      // dry-run document carries the argv, so this asserts that the resolved
      // absolute path travels onward rather than the typed relative string --
      // previewing one file while posting another would re-open the split this
      // whole change closes.
      //
      // ASSERTED ON THE PARSED ARRAY, never on the rendered text. A Windows
      // path carries backslashes and JSON escapes every one of them, so
      // searching the document's TEXT for `C:\Users\...` fails on exactly one
      // of the three CI lanes -- the platform-conditional assertion this
      // repository's own test headers keep warning about, and it went red on
      // windows-latest before this line was written this way.
      // Since zheref/nen#329 `gh` is handed the BYTES on stdin (`--body-file
      // -`), not a path -- so the resolved path is the one reported, and the
      // argv names no file at all.
      expect(parsed.bodyFile).toBe(join(repoDir, "rel.md"));
      expect(parsed.argv).toContain("-");
      expect(parsed.argv).not.toContain("rel.md");
    } finally {
      process.chdir(previous);
    }
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
      privateNameCheck: { result: "skipped-private-target", targetVisibility: "private", listSize: null, owners: null, hits: [], error: null },
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

describe("nen issue edit-body -- replaces an issue's body outright, byte for byte", () => {
  const CERTIFY_12: ScriptedCall = {
    match: "gh api repos/o/n/issues/12",
    // `body: null` is what GitHub sends for an issue never given a body -- the
    // key is always present on a real payload (a missing one is refused under
    // --expect-body-sha256; see the #205 block below).
    result: { stdout: JSON.stringify({ number: 12, id: 100, title: "an issue", state: "open", labels: [], body: null }) },
  };

  it("certifies the number first, then writes through the Runner seam", async () => {
    const path = tempFile("body.md", "## plan\n\nreplaced wholesale.\n");
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", path],
      [CERTIFY_12, { match: `gh issue edit 12 --repo o/n --body-file -`, result: {} }],
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toBe("replaced o/n#12's body (29 byte(s))");
    // The certifying read comes before the write, in argv order -- a write
    // ahead of it would mean the object class was never actually checked.
    expect(result.calls).toEqual([
      "gh api repos/o/n/issues/12",
      `gh issue edit 12 --repo o/n --body-file -`,
    ]);
  });

  it("--json carries the v0.3 contract, written: true on a real run, and says the (absent) check is not atomic", async () => {
    const path = tempFile("body.md", "hello");
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", path],
      [CERTIFY_12, { match: `gh issue edit 12 --repo o/n --body-file -`, result: {} }],
      { json: true },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({
      contract: "nen.issue.edit-body/v0.3",
      target: "o/n",
      number: 12,
      bytes: 5,
      bodySha256: sha("hello"),
      written: true,
      dryRun: false,
      outcome: "written",
      bodyCheck: { expectedSha256: null, currentSha256: EMPTY_SHA256, currentBytes: 0, result: "none", atomic: false },
      currentBodyOut: null,
      privateNameCheck: { result: "skipped-private-target", targetVisibility: "private", listSize: null, owners: null, hits: [], error: null },
    });
  });

  // --dry-run still reads GitHub to certify the number, exactly like
  // attach-sub/consolidate-close -- but never runs the write.
  it("--dry-run certifies (still reads GitHub), then prints target/number/bytes/first-last line and writes nothing", async () => {
    const path = tempFile("body.md", "first line\nmiddle\nlast line\n");
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", path, "--dry-run"],
      [CERTIFY_12],
    );
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      `would run: gh issue edit 12 --repo o/n --body-file -`,
      `stdin: the 28 byte(s) read and checked from ${path} (gh reads these, not the file)`,
      "target: o/n",
      "number: 12",
      "bytes: 28",
      "first line: first line",
      "last line: last line",
      `current body sha256: ${EMPTY_SHA256}`,
      "body check: none -- no --expect-body-sha256 given, so a concurrent edit would be overwritten unseen.",
    ]);
    expect(result.calls).toEqual(["gh api repos/o/n/issues/12"]);
  });

  // Copilot review (PR #151): splitting the preview on a bare "\n" left a
  // CRLF file's displayed last line carrying a trailing "\r" -- a caller
  // reading `last line: last line\r` could not tell whether that was really
  // in the file. `bytes` still counts every raw byte the CRLF file holds
  // (31, not 28): this fix touches only what the preview SPLITS ON, never
  // the bytes `--body-file` reads or reports.
  it("--dry-run's first/last line preview strips a CRLF cleanly, with no trailing \\r", async () => {
    const path = tempFile("crlf.md", "first line\r\nmiddle\r\nlast line\r\n");
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", path, "--dry-run"],
      [CERTIFY_12],
    );
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      `would run: gh issue edit 12 --repo o/n --body-file -`,
      `stdin: the 31 byte(s) read and checked from ${path} (gh reads these, not the file)`,
      "target: o/n",
      "number: 12",
      "bytes: 31",
      "first line: first line",
      "last line: last line",
      `current body sha256: ${EMPTY_SHA256}`,
      "body check: none -- no --expect-body-sha256 given, so a concurrent edit would be overwritten unseen.",
    ]);
  });

  it("--dry-run --json carries dryRun: true, written: false, outcome dry-run", async () => {
    const path = tempFile("body.md", "hi");
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", path, "--dry-run"],
      [CERTIFY_12],
      { json: true },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({
      contract: "nen.issue.edit-body/v0.3",
      target: "o/n",
      number: 12,
      bytes: 2,
      bodySha256: sha("hi"),
      written: false,
      dryRun: true,
      outcome: "dry-run",
      bodyCheck: { expectedSha256: null, currentSha256: EMPTY_SHA256, currentBytes: 0, result: "none", atomic: false },
      currentBodyOut: null,
      privateNameCheck: { result: "skipped-private-target", targetVisibility: "private", listSize: null, owners: null, hits: [], error: null },
    });
  });

  // UNLIKE 'issue comment', a pull request's number is refused -- certified
  // BEFORE any write, so an empty script would throw on an unscripted write
  // if the guard ever let one through.
  it("refuses (exit 2) a number that names a pull request, before any write", async () => {
    const path = tempFile("body.md", "hi");
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "925", "--body-file", path],
      [
        {
          match: "gh api repos/o/n/issues/925",
          result: {
            stdout: JSON.stringify({
              number: 925,
              id: 900,
              title: "a pull request",
              state: "open",
              labels: [],
              pull_request: { url: "https://api.github.com/repos/o/n/pulls/925" },
            }),
          },
        },
      ],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/#925 names a pull request .* not an issue/);
    expect(result.err.join("\n")).toMatch(/nen pr edit-body/);
  });

  it("--dry-run also refuses a pull request's number -- the dry run never lies about what a real run would do", async () => {
    const path = tempFile("body.md", "hi");
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "925", "--body-file", path, "--dry-run"],
      [
        {
          match: "gh api repos/o/n/issues/925",
          result: {
            stdout: JSON.stringify({
              number: 925,
              id: 900,
              title: "a pull request",
              state: "open",
              labels: [],
              pull_request: { url: "https://api.github.com/repos/o/n/pulls/925" },
            }),
          },
        },
      ],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/#925 names a pull request/);
  });

  it("requires --issue", async () => {
    const path = tempFile("body.md", "hi");
    const result = await capture(["issue", "edit-body", "--target", "o/n", "--body-file", path], []);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--issue <n>/);
  });

  it.each(["1e3", "0x0c", "12.0", " 12", "+12", "0"])(
    "refuses (exit 2) --issue '%s' rather than letting a loose read retarget the write",
    async (raw) => {
      const path = tempFile("body.md", "hi");
      const result = await capture(
        ["issue", "edit-body", "--target", "o/n", "--issue", raw, "--body-file", path],
        [],
      );
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/--issue <n>: a positive whole number, digits only/);
    },
  );

  it("requires --body-file, and there is no inline --body spelling", async () => {
    const result = await capture(["issue", "edit-body", "--target", "o/n", "--issue", "12"], []);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--body-file <path>/);
    expect(result.err.join("\n")).toMatch(/no inline --body/);
  });

  it("refuses (exit 2) an inline --body -- it belongs to 'issue comment'", async () => {
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body", "hi"],
      [],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/It belongs to 'issue comment'/);
  });

  it("refuses (exit 2) an empty --body-file", async () => {
    const path = tempFile("body.md", "\n   \n");
    const result = await capture(["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", path], []);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/is empty/);
  });

  it("refuses (exit 2) a --body-file that does not exist", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "nen-issue-")), "nope.md");
    const result = await capture(["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", missing], []);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/could not read/);
  });

  it("propagates a gh write failure as its own error (exit 1), after certification succeeded", async () => {
    const path = tempFile("body.md", "hi");
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", path],
      [CERTIFY_12, { match: `gh issue edit 12 --repo o/n --body-file -`, result: { code: 1, stderr: "HTTP 500" } }],
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not replace o\/n#12's body/);
  });

  it("never reports an unconfirmed write as written: plain-text failure prints no 'replaced' line", async () => {
    const path = tempFile("body.md", "hi");
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", path],
      [CERTIFY_12, { match: `gh issue edit 12 --repo o/n --body-file -`, result: { code: 1, stderr: "HTTP 502" } }],
    );
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/outcome UNCERTAIN/);
  });

  it("issue --help documents edit-body, --expect-body-sha256, exit 3 and that the check is not atomic", async () => {
    const result = await capture(["issue", "--help"]);
    const out = result.out.join("\n");
    expect(out).toMatch(/\[--expect-body-sha256 <hex>\]/);
    expect(out).toMatch(/THIS IS NOT\s+ATOMIC/);
    expect(out).toMatch(/\[--current-body-out <path>\]/);
    expect(out).toContain(`gh api repos/<o>/<n>/issues/<i> | jq -j '.body // ""' | shasum -a 256`);
    expect(out).toMatch(/--jq \.body', which adds a trailing newline/);
    expect(out).toMatch(/prints 'null' for a null body/);
    expect(out).toMatch(/NOT-SENT/);
    expect(out).toMatch(/exits 3 \(conflict\)/);
    expect(out).toMatch(/nen\.issue\.edit-body\/v0\.3/);
  });

  it("issue --help documents edit-body, its --body-file-only shape and the pull-request refusal", async () => {
    const result = await capture(["issue", "--help"]);
    expect(result.code).toBe(0);
    const out = result.out.join("\n");
    expect(out).toMatch(/nen issue edit-body --target <owner\/name> --issue <n>/);
    expect(out).toMatch(/no\s+inline --body/);
    expect(out).toMatch(/a number\s+that names a PULL REQUEST is refused/);
  });
});

describe("nen issue edit-body --expect-body-sha256 -- lost-update guard, honestly not atomic (zheref/nen#205)", () => {
  const V1 = "## plan\n\nwriter A and B both read this.\n";
  const V2 = "## plan\n\nwriter A and B both read this.\n\n- B's material addition\n";
  const readReturning = (body: string | null): ScriptedCall => ({
    match: "gh api repos/o/n/issues/12",
    result: { stdout: JSON.stringify({ number: 12, id: 100, title: "an issue", state: "open", labels: [], body }) },
  });
  const writeOf = (path: string, result: ScriptedCall["result"] = {}): ScriptedCall => ({
    match: `gh issue edit 12 --repo o/n --body-file -`,
    result,
  });
  const argv = (path: string, expected: string, ...rest: string[]): string[] => [
    "issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", path, "--expect-body-sha256", expected, ...rest,
  ];

  it("writes when the current body matches the expected hash, and says the check was not atomic", async () => {
    const path = tempFile("body.md", "replacement\n");
    const result = await capture(argv(path, sha(V1)), [readReturning(V1), writeOf(path)]);
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("replaced o/n#12's body (12 byte(s))");
    expect(result.out[1]).toMatch(/matched --expect-body-sha256 .* NOT atomic/);
    expect(result.calls).toEqual(["gh api repos/o/n/issues/12", `gh issue edit 12 --repo o/n --body-file -`]);
  });

  it("accepts the hash in upper case, compared lowercase", async () => {
    const path = tempFile("body.md", "replacement\n");
    const result = await capture(argv(path, sha(V1).toUpperCase()), [readReturning(V1), writeOf(path)]);
    expect(result.code).toBe(0);
  });

  it("hashes GitHub's null body as the empty string", async () => {
    const path = tempFile("body.md", "first body\n");
    const result = await capture(argv(path, EMPTY_SHA256), [readReturning(null), writeOf(path)]);
    expect(result.code).toBe(0);
  });

  it("refuses a mismatched hash at exit 3 WITHOUT writing, printing the current hash to reconcile against", async () => {
    const path = tempFile("body.md", "A's fold of v1\n");
    const result = await capture(argv(path, sha(V1)), [readReturning(V2)]);
    expect(result.code).toBe(3);
    expect(result.calls).toEqual(["gh api repos/o/n/issues/12"]);
    expect(result.out).toEqual([]);
    const err = result.err.join("\n");
    expect(err).toMatch(/conflict -- o\/n#12's body is not the version this replacement was prepared from, so nothing was written/);
    expect(err).toContain(`expected body sha256: ${sha(V1)}`);
    expect(err).toContain(`current body sha256:  ${sha(V2)}`);
  });

  it("--json on a conflict: outcome conflict, written false, both hashes, atomic false, exit 3", async () => {
    const path = tempFile("body.md", "A's fold of v1\n");
    const result = await capture(argv(path, sha(V1)), [readReturning(V2)], { json: true });
    expect(result.code).toBe(3);
    expect(JSON.parse(result.out.join("\n"))).toEqual({
      contract: "nen.issue.edit-body/v0.3",
      target: "o/n",
      number: 12,
      bytes: 15,
      bodySha256: sha("A's fold of v1\n"),
      written: false,
      dryRun: false,
      outcome: "conflict",
      bodyCheck: {
        expectedSha256: sha(V1),
        currentSha256: sha(V2),
        currentBytes: Buffer.byteLength(V2, "utf8"),
        result: "conflict",
        atomic: false,
      },
      currentBodyOut: null,
      // Never reached: the conflict refuses first.
      privateNameCheck: null,
    });
    expect(result.calls).toEqual(["gh api repos/o/n/issues/12"]);
  });

  it("--dry-run performs the same comparison: a mismatch is exit 3 there too, and a match says what was and was not checked", async () => {
    const path = tempFile("body.md", "x\n");
    const conflict = await capture(argv(path, sha(V1), "--dry-run"), [readReturning(V2)]);
    expect(conflict.code).toBe(3);
    expect(conflict.calls).toEqual(["gh api repos/o/n/issues/12"]);

    const matched = await capture(argv(path, sha(V1), "--dry-run"), [readReturning(V1)]);
    expect(matched.code).toBe(0);
    expect(matched.calls).toEqual(["gh api repos/o/n/issues/12"]);
    expect(matched.out).toContain(`current body sha256: ${sha(V1)}`);
    expect(matched.out.join("\n")).toMatch(/matches --expect-body-sha256 at this read; a real run re-reads and re-checks, and even then the check is NOT atomic/);
  });

  it("refuses a malformed hash at exit 2 before any read -- never as a conflict", async () => {
    const path = tempFile("body.md", "x\n");
    for (const bad of ["abc", sha(V1).slice(1), `${sha(V1)}0`, `g${sha(V1).slice(1)}`]) {
      const result = await capture(argv(path, bad), []);
      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
      expect(result.err.join("\n")).toMatch(/--expect-body-sha256 takes a sha256 as 64 hex digits/);
    }
  });

  it("keeps the pull-request refusal (exit 2) ahead of the hash comparison", async () => {
    const path = tempFile("body.md", "x\n");
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "925", "--body-file", path, "--expect-body-sha256", sha(V1)],
      [
        {
          match: "gh api repos/o/n/issues/925",
          result: {
            stdout: JSON.stringify({
              number: 925, id: 900, title: "a pull request", state: "open", labels: [], body: V2,
              pull_request: { url: "https://api.github.com/repos/o/n/pulls/925" },
            }),
          },
        },
      ],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/#925 names a pull request/);
  });

  // THE ISSUE'S OWN INTERLEAVING, end to end on one shared backend: A and B
  // both read v1; B writes v2 (its expectation holds); A then submits its fold
  // of v1 with v1's hash -- and is refused, with B's v2 left standing.
  // N7: A STATEFUL BACKEND -- a write changes what every later read returns,
  // so the interleavings below are played out against one issue whose body
  // actually moves, not against a script of canned answers. `afterRead` lets
  // a test land another writer's edit at a chosen moment.
  class IssueBackend implements Seams {
    readonly calls: string[] = [];
    private readonly delegate = new ScriptedSeams([]);
    readonly runInteractive = this.delegate.runInteractive.bind(this.delegate);
    readonly runStreamed = this.delegate.runStreamed.bind(this.delegate);
    readonly probePort = this.delegate.probePort;
    readonly now = this.delegate.now;
    readonly env = this.delegate.env;
    readonly platform = this.delegate.platform;
    afterRead: (() => void) | null = null;
    constructor(public body: string) {}
    readonly run = (command: string, args: readonly string[], options: { stdin?: string } = {}): CommandResult => {
      const line = [command, ...args].join(" ");
      this.calls.push(line);
      const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", spawnFailed: false });
      // The private-name guard's visibility read (zheref/nen#329): private, so
      // it skips and reads no list. Recorded in `calls` like every other call.
      if (line === "gh api repos/o/n") return ok(JSON.stringify({ visibility: "private" }));
      if (line === "gh api repos/o/n/issues/12") {
        const stdout = JSON.stringify({ number: 12, id: 100, title: "t", state: "open", labels: [], body: this.body });
        const hook = this.afterRead;
        this.afterRead = null;
        hook?.();
        return ok(stdout);
      }
      // The body arrives on stdin since zheref/nen#329: the checked bytes, never a path.
      if (line === "gh issue edit 12 --repo o/n --body-file -" && options.stdin !== undefined) {
        this.body = options.stdin;
        return ok();
      }
      throw new Error(`unscripted: '${line}'`);
    };
  }
  const silent: Io = { out: (): void => undefined, err: (): void => undefined };

  it("the #205 interleaving: A and B both read v1, B writes v2, A's stale fold is refused and B's addition survives", async () => {
    const backend = new IssueBackend(V1);
    const baseOf = sha(V1); // what BOTH writers read
    const pathB = tempFile("b.md", V2);
    const pathA = tempFile("a.md", "## plan\n\nA's fold, prepared from v1 only.\n");
    expect(await runFamily(issueCommand, argv(pathB, baseOf), null, false, silent, backend)).toBe(0);
    expect(backend.body).toBe(V2);
    expect(await runFamily(issueCommand, argv(pathA, baseOf), null, false, silent, backend)).toBe(3);
    expect(backend.body).toBe(V2);
    expect(backend.calls).toEqual([
      "gh api repos/o/n/issues/12",
      "gh api repos/o/n",
      `gh issue edit 12 --repo o/n --body-file -`,
      "gh api repos/o/n/issues/12",
    ]);

    // A reconciles from the bytes the conflict handed it, and lands on top of B.
    const out = join(mkdtempSync(join(tmpdir(), "nen-issue-")), "current.md");
    expect(await runFamily(issueCommand, argv(pathA, baseOf, "--current-body-out", out), null, false, silent, backend)).toBe(3);
    const current = readFileSync(out, "utf8");
    const refold = tempFile("a2.md", `${current}- A's addition\n`);
    expect(await runFamily(issueCommand, argv(refold, sha(current)), null, false, silent, backend)).toBe(0);
    expect(backend.body).toBe(`${V2}- A's addition\n`);
  });

  // THE WINDOW THIS FLAG CANNOT CLOSE, played out rather than asserted: B's
  // write lands AFTER A's certifying read but BEFORE A's write. A's read saw
  // v1, the check matched, and A's write overwrites B -- the lost update the
  // flag narrows but cannot prevent. What the verb MUST do is never claim
  // otherwise.
  it("the undetectable window: a write between A's read and A's write is lost, and the report never claims it would be caught", async () => {
    const backend = new IssueBackend(V1);
    backend.afterRead = (): void => {
      backend.body = V2; // B lands in the window
    };
    const path = tempFile("body.md", "A's fold of v1\n");
    const out: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (): void => undefined };
    expect(await runFamily(issueCommand, argv(path, sha(V1)), null, true, io, backend)).toBe(0);
    expect(backend.body).toBe("A's fold of v1\n"); // B's addition is gone
    const report = JSON.parse(out.join("\n")) as { outcome: string; bodyCheck: { result: string; atomic: boolean } };
    expect(report.outcome).toBe("written");
    expect(report.bodyCheck.result).toBe("matched");
    expect(report.bodyCheck.atomic).toBe(false);
  });

  it("an uncertain write (gh failed) is never written: --json gives written null, outcome uncertain, and the read-back", async () => {
    const path = tempFile("body.md", "A's fold of v1\n");
    const result = await capture(
      argv(path, sha(V1)),
      // The write's answer was lost (502) -- but GitHub applied it: the read-back sees the submitted bytes.
      [readReturning(V1), readReturning("A's fold of v1\n"), writeOf(path, { code: 1, stderr: "HTTP 502: Bad Gateway" })],
      { json: true },
    );
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(report["written"]).toBeNull();
    expect(report["outcome"]).toBe("uncertain");
    expect(report["error"]).toMatch(/could not replace o\/n#12's body: HTTP 502/);
    expect(report["readBack"]).toEqual({
      currentSha256: sha("A's fold of v1\n"),
      matchesSubmitted: true,
      // N8: compared with bodyCheck.currentSha256 -- the version the certifying read saw.
      matchesPrevious: false,
      readError: null,
    });
    expect((report["bodyCheck"] as { currentSha256: string }).currentSha256).toBe(sha(V1));
    expect(result.calls).toEqual([
      "gh api repos/o/n/issues/12",
      `gh issue edit 12 --repo o/n --body-file -`,
      "gh api repos/o/n/issues/12",
    ]);
  });

  it("an uncertain write whose read-back still shows the previous body, or fails, is still uncertain -- never 'replaced', never 'not written'", async () => {
    const path = tempFile("body.md", "A's fold of v1\n");
    const unchanged = await capture(
      argv(path, sha(V1)),
      [readReturning(V1), readReturning(V1), writeOf(path, { code: 1, stderr: "HTTP 504: Gateway Timeout" })],
      { json: true },
    );
    expect(unchanged.code).toBe(1);
    const report = JSON.parse(unchanged.out.join("\n")) as { outcome: string; written: unknown; readBack: Record<string, unknown> };
    expect(report.outcome).toBe("uncertain");
    expect(report.written).toBeNull();
    expect(report.readBack).toEqual({ currentSha256: sha(V1), matchesSubmitted: false, matchesPrevious: true, readError: null });

    const plain = await capture(
      argv(path, sha(V1)),
      [readReturning(V1), readReturning(V1), writeOf(path, { code: 1, stderr: "HTTP 504" })],
    );
    expect(plain.out).toEqual([]);
    expect(plain.err.join("\n")).toMatch(/outcome UNCERTAIN/);
    expect(plain.err.join("\n")).toMatch(/still equals what the certifying read saw .* a delayed apply cannot be ruled out/);

    const elsewhere = await capture(
      argv(path, sha(V1)),
      [readReturning(V1), readReturning(V2), writeOf(path, { code: 1, stderr: "HTTP 504" })],
    );
    expect(elsewhere.err.join("\n")).toMatch(/equals NEITHER the submitted bytes NOR what the certifying read saw/);

    const unreadable = await capture(
      argv(path, sha(V1)),
      [
        readReturning(V1),
        { match: "gh api repos/o/n/issues/12", result: { code: 1, stderr: "HTTP 503" } },
        writeOf(path, { code: 1, stderr: "timeout" }),
      ],
    );
    expect(unreadable.code).toBe(1);
    expect(unreadable.out).toEqual([]);
    expect(unreadable.err.join("\n")).toMatch(/read-back failed too: could not read o\/n#12: HTTP 503/);
  });

  // N5: a gh that never STARTED sent nothing -- that outcome is certain, so it
  // is "not-sent", never "uncertain". The fixture's read-back fails too (the
  // same gh is missing), and the verb does not even attempt it.
  it("a gh that could not be started is 'not-sent' (written: false), never uncertain, and attempts no read-back", async () => {
    const path = tempFile("body.md", "A's fold of v1\n");
    const spawnFail = { code: -1, stderr: "spawn gh ENOENT", spawnFailed: true };
    const script = [readReturning(V1), { match: "gh api repos/o/n/issues/12", result: spawnFail }, writeOf(path, spawnFail)];
    const json = await capture(argv(path, sha(V1)), script, { json: true });
    expect(json.code).toBe(1);
    const report = JSON.parse(json.out.join("\n")) as Record<string, unknown>;
    expect(report["outcome"]).toBe("not-sent");
    expect(report["written"]).toBe(false);
    expect(report["error"]).toMatch(/gh could not be started \(spawn gh ENOENT\), so nothing was sent/);
    expect(report).not.toHaveProperty("readBack");
    expect(json.calls).toEqual(["gh api repos/o/n/issues/12", `gh issue edit 12 --repo o/n --body-file -`]);

    const plain = await capture(argv(path, sha(V1)), script);
    expect(plain.code).toBe(1);
    expect(plain.out).toEqual([]);
    expect(plain.err.join("\n")).toMatch(/Nothing reached GitHub/);
    expect(plain.err.join("\n")).not.toMatch(/UNCERTAIN/);
  });

  // N9: a payload with no `body` key is not GitHub's null body.
  it("refuses an expectation against a read that carried no body field (exit 1, nothing written)", async () => {
    const path = tempFile("body.md", "x\n");
    const result = await capture(argv(path, EMPTY_SHA256), [
      { match: "gh api repos/o/n/issues/12", result: { stdout: JSON.stringify({ number: 12, id: 100, title: "t", state: "open", labels: [] }) } },
    ]);
    expect(result.code).toBe(1);
    expect(result.calls).toEqual(["gh api repos/o/n/issues/12"]);
    expect(result.err.join("\n")).toMatch(/carried no 'body' field, so --expect-body-sha256 cannot be compared with it -- nothing was written/);
  });

  // N1: --current-body-out writes the certifying read's exact bytes, so a fold
  // is prepared from the very bytes whose hash the report prints.
  it("--current-body-out on a dry run writes the read's exact bytes, whose sha256 is the one printed", async () => {
    const path = tempFile("body.md", "draft\n");
    const out = join(mkdtempSync(join(tmpdir(), "nen-issue-")), "current.md");
    const crlf = "line one\r\nline two with no trailing newline";
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", path, "--dry-run", "--current-body-out", out],
      [readReturning(crlf)],
    );
    expect(result.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(crlf);
    expect(result.out).toContain(`current body sha256: ${sha(crlf)}`);
    expect(result.out).toContain(`current body written to: ${out} (the exact bytes of this read)`);
    expect(result.calls).toEqual(["gh api repos/o/n/issues/12"]);
  });

  it("--current-body-out on a conflict writes the current bytes and keeps exit 3; the fold then succeeds against them", async () => {
    const path = tempFile("body.md", "A's fold of v1\n");
    const out = join(mkdtempSync(join(tmpdir(), "nen-issue-")), "current.md");
    const conflict = await capture(argv(path, sha(V1), "--current-body-out", out), [readReturning(V2)], { json: true });
    expect(conflict.code).toBe(3);
    expect(readFileSync(out, "utf8")).toBe(V2);
    const report = JSON.parse(conflict.out.join("\n")) as { currentBodyOut: unknown; bodyCheck: { currentSha256: string } };
    expect(report.currentBodyOut).toEqual({ path: out, written: true, error: null });
    expect(sha(readFileSync(out, "utf8"))).toBe(report.bodyCheck.currentSha256);

    // Re-fold from the written bytes and retry with their hash: it matches.
    const refold = tempFile("refold.md", `${readFileSync(out, "utf8")}\n- A's addition\n`);
    const retry = await capture(argv(refold, sha(readFileSync(out, "utf8"))), [readReturning(V2), writeOf(refold)]);
    expect(retry.code).toBe(0);
  });

  it("--current-body-out is NOT written on a real write that proceeds", async () => {
    const path = tempFile("body.md", "replacement\n");
    const out = join(mkdtempSync(join(tmpdir(), "nen-issue-")), "current.md");
    const result = await capture(argv(path, sha(V1), "--current-body-out", out), [readReturning(V1), writeOf(path)], { json: true });
    expect(result.code).toBe(0);
    expect(() => readFileSync(out, "utf8")).toThrow();
    expect((JSON.parse(result.out.join("\n")) as { currentBodyOut: unknown }).currentBodyOut).toEqual({ path: out, written: false, error: null });
  });

  it("refuses --current-body-out naming the --body-file (exit 2) -- a conflict would overwrite the caller's fold", async () => {
    const path = tempFile("body.md", "my fold\n");
    const result = await capture(argv(path, sha(V1), "--current-body-out", path), []);
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("my fold\n");
  });

  // Copilot round 1 (NN-PR-#356): a lexical compare misses a link to the same
  // file, and writeFileSync follows it. Identity (dev + ino) catches both.
  it.each([
    ["a symlink", (target: string, link: string): void => symlinkSync(target, link)],
    ["a hard link", (target: string, link: string): void => linkSync(target, link)],
  ])("refuses --current-body-out that is %s to the --body-file (exit 2), leaving the fold untouched", async (_kind, makeLink) => {
    const path = tempFile("body.md", "my fold\n");
    const alias = join(mkdtempSync(join(tmpdir(), "nen-issue-")), "alias.md");
    makeLink(path, alias);
    const result = await capture(argv(path, sha(V1), "--current-body-out", alias), [readReturning(V2)]);
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
    expect(result.err.join("\n")).toMatch(/is the --body-file itself \(the same path, or a link or alias to the same file\)/);
    expect(readFileSync(path, "utf8")).toBe("my fold\n");
  });

  it("accepts a --current-body-out that does not exist yet, or that exists as a DIFFERENT file", async () => {
    const path = tempFile("body.md", "my fold\n");
    const other = tempFile("other.md", "stale\n");
    const result = await capture(argv(path, sha(V1), "--current-body-out", other), [readReturning(V2)]);
    expect(result.code).toBe(3);
    expect(readFileSync(other, "utf8")).toBe(V2);
    expect(readFileSync(path, "utf8")).toBe("my fold\n");
  });

  it("a dry run whose --current-body-out cannot be written fails (exit 1) rather than succeeding without the file", async () => {
    const path = tempFile("body.md", "x\n");
    const out = join(mkdtempSync(join(tmpdir(), "nen-issue-")), "no-such-dir", "current.md");
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", path, "--dry-run", "--current-body-out", out],
      [readReturning(V1)],
    );
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/current body NOT written to/);
  });

  it("--current-body-out refuses a read that carried no body field rather than writing an invented empty file", async () => {
    const path = tempFile("body.md", "x\n");
    const out = join(mkdtempSync(join(tmpdir(), "nen-issue-")), "current.md");
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", path, "--dry-run", "--current-body-out", out],
      [{ match: "gh api repos/o/n/issues/12", result: { stdout: JSON.stringify({ number: 12, id: 100, title: "t", state: "open", labels: [] }) } }],
    );
    expect(result.code).toBe(1);
    expect(() => readFileSync(out, "utf8")).toThrow();
    expect(result.err.join("\n")).toMatch(/--current-body-out has no bytes to write/);
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
    "edit-body": ["--target", "o/n", "--issue", "1", "--body-file", "b.md"],
    "attach-sub": ["--target", "o/n", "--parent", "1", "--children", "2"],
    "consolidate-close": ["--target", "o/n", "--parent", "1", "--children", "2"],
    "chain-position": ["--target", "o/n", "--issue", "1"],
    terminus: ["--target", "o/n", "--issue", "1"],
    reconcile: ["--target", "o/n"],
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
    ).toEqual(["search", "open-pr-check", "attach-sub", "consolidate-close", "chain-position", "terminus", "reconcile"]);
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
  it("names all three owners of a three-owner flag, and conjoins a five-owner one", async () => {
    const three = await capture(["issue", "search", "--target", "o/n", "--body-file", "b.md"], []);
    expect(three.code).toBe(2);
    expect(three.err.join("\n")).toContain(
      "It belongs to 'issue file', 'issue comment' and 'issue edit-body'.",
    );

    const five = await capture(["issue", "search", "--target", "o/n", "--dry-run"], []);
    expect(five.code).toBe(2);
    expect(five.err.join("\n")).toContain(
      "It belongs to 'issue file', 'issue comment', 'issue edit-body', 'issue attach-sub' and 'issue consolidate-close'.",
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
        "It belongs to 'issue file', 'issue comment', 'issue edit-body', 'issue attach-sub' and 'issue consolidate-close'.",
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
        PARENT_1,
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
        PARENT_1,
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
        PARENT_1,
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
      [PARENT_1, CHILD_5, NO_OPEN_PRS],
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
      [PARENT_1, CHILD_5, NO_OPEN_PRS],
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
    mkdirSync(join(root, "nen"));
    writeFileSync(
      join(root, "nen", "labels.json"),
      readFileSync(join(BANKAI_REPO, "nen", "labels.json"), "utf8"),
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
        PARENT_1,
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

  // zheref/nen#33. The lines were COMPUTED, RETURNED and unreachable: the log
  // line said "the lines are in this report" while the text renderer printed the
  // log and not the lines, which was true of `--json` and false of the thing a
  // text caller was looking at. A fallback that is detected and then not shown
  // is a fallback nobody can perform.
  it("attach-sub PRINTS the fallback task list, and says who performs it", async () => {
    const result = await capture(
      ["issue", "attach-sub", "--target", "o/n", "--parent", "1", "--children", "2"],
      [
        PARENT_1,
        {
          match: "gh api repos/o/n/issues/2",
          result: {
            stdout: JSON.stringify({ number: 2, id: 22, title: "a child", state: "open", labels: [] }),
          },
        },
        {
          match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=22",
          result: { code: 1, stderr: "HTTP 404: Not Found" },
        },
      ],
    );
    expect(result.code).toBe(1);
    const out = result.out.join("\n");
    expect(out).toContain("fallback task list for the parent's body:");
    expect(out).toContain("- [ ] #2");
    // Who performs it, and the invocation that does -- nen has a verb for
    // exactly this write and the caller should not have to find it.
    expect(out).toContain("nen does NOT write this");
    expect(out).toContain("nen issue edit-body --target o/n --issue 1 --body-file <file>");
    // And the discipline the fallback carries with it.
    expect(out).toContain("say which form was used");
  });

  it("attach-sub prints no fallback block when the endpoint is fine", async () => {
    const result = await capture(
      ["issue", "attach-sub", "--target", "o/n", "--parent", "1", "--children", "2"],
      [
        PARENT_1,
        {
          match: "gh api repos/o/n/issues/2",
          result: {
            stdout: JSON.stringify({ number: 2, id: 22, title: "a child", state: "open", labels: [] }),
          },
        },
        {
          match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=22",
          result: {},
        },
      ],
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).not.toContain("fallback task list");
  });

  it("issue --help says the fallback is DETECTED here and performed by the caller", async () => {
    const out = (await capture(["issue", "--help"])).out.join("\n");
    expect(out).toMatch(/does NOT perform the write/);
    // THE WHOLE INVOCATION, --target included. A help block whose entire job is
    // to say what to run must be copy/pastable: `issue edit-body` requires
    // --target the same way this verb does, and an invocation missing it fails
    // for a reader who trusted the text (Copilot, PR #183). Matched across the
    // line wrap the help block puts in, so the assertion pins the command
    // rather than one line's happening to hold all of it.
    const helpText = out.replace(/\s+/g, " ");
    expect(helpText).toContain(
      "nen issue edit-body --target <owner/name> --issue <parent> --body-file <f>",
    );
  });

  it("issue --help documents both close-comment flags and the placeholder vocabulary", async () => {
    const result = await capture(["issue", "--help"]);
    const out = result.out.join("\n");
    expect(out).toMatch(/--close-comment <template>/);
    expect(out).toMatch(/--close-comment-map <path>/);
    expect(out).toMatch(/\{parent\} and \{child\}/);
  });
});

// zheref/nen#77. `attach-sub` and `consolidate-close` never checked that the
// numbers in --parent/--children name ISSUES. Issues and pull requests share
// one number sequence and one issues/{n} endpoint, so a pull request number ran
// the whole choreography cleanly -- attached as a sub-issue, or CLOSED with a
// consolidation comment -- at exit 0, with no warning. #25 (PR #71) fixed
// exactly this class for the CLASSIFYING verbs above and left the MUTATING
// consumers of the same fetch unguarded, which is the worse half: a wrong
// classification is a sentence a caller can disbelieve, a wrong close is a
// state change nobody re-reads.
describe("nen issue attach-sub / consolidate-close -- a pull request is refused before any write", () => {
  /** A PR-shaped `issues/{n}` payload for one number. */
  function pr(number: number): ScriptedCall {
    return {
      match: `gh api repos/o/n/issues/${number}`,
      result: {
        stdout: JSON.stringify({
          number,
          id: 90000 + number,
          title: "some pull request",
          state: "open",
          labels: [],
          pull_request: { url: `https://api.github.com/repos/o/n/pulls/${number}` },
        }),
      },
    };
  }

  function issue(number: number, id: number): ScriptedCall {
    return {
      match: `gh api repos/o/n/issues/${number}`,
      result: { stdout: JSON.stringify({ number, id, title: "a real issue", state: "open", labels: [] }) },
    };
  }

  /** consolidate-close's open-PR guard, answering "none" -- a read, not a write. */
  const NO_OPEN_PRS: ScriptedCall = {
    match:
      "gh pr list --repo o/n --state open --limit 100 --json number,title,url,isDraft,body,closingIssuesReferences",
    result: { stdout: "[]" },
  };

  // EVERY script below deliberately omits the sub-issue POST and the close, so
  // a guard that ever runs one line too late fails on ScriptedSeams'
  // "unscripted subprocess" throw instead of passing quietly. That absence is
  // the assertion that nothing was mutated.

  it("attach-sub refuses (exit 1) when --parent names a pull request, and attaches nothing", async () => {
    const result = await capture(
      ["issue", "attach-sub", "--target", "o/n", "--parent", "925", "--children", "5"],
      [pr(925), issue(5, 55)],
    );
    expect(result.code).toBe(1);
    const err = result.err.join("\n");
    expect(err).toMatch(/#925 \(--parent\) names a pull request, not an issue/);
    expect(err).toMatch(/'nen pr' family/);
    expect(result.out.join("\n")).not.toMatch(/attached/);
  });

  it("attach-sub refuses when a --children entry names a pull request", async () => {
    const result = await capture(
      ["issue", "attach-sub", "--target", "o/n", "--parent", "1", "--children", "925"],
      [PARENT_1, pr(925)],
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/#925 \(--children\) names a pull request/);
  });

  // THE MIXED LIST is the whole reason the check is a pre-flight: a per-child
  // test inside the write loop would refuse #925 correctly and leave #5
  // already attached.
  it("attach-sub attaches NOTHING when one child of several is a pull request", async () => {
    const result = await capture(
      ["issue", "attach-sub", "--target", "o/n", "--parent", "1", "--children", "5,925"],
      [PARENT_1, issue(5, 55), pr(925)],
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/#925 \(--children\)/);
  });

  it("attach-sub names parent and child offenders in ONE refusal", async () => {
    const result = await capture(
      ["issue", "attach-sub", "--target", "o/n", "--parent", "925", "--children", "5,926"],
      [pr(925), issue(5, 55), pr(926)],
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(
      /#925 \(--parent\) and #926 \(--children\) name pull requests, not issues/,
    );
  });

  // A dry run that PREVIEWED attaching a pull request would be a wrong preview,
  // and this family's dry-run promise is that what the caller approves is what
  // runs.
  it("attach-sub --dry-run refuses too, rather than previewing the attach", async () => {
    const result = await capture(
      ["issue", "attach-sub", "--target", "o/n", "--parent", "925", "--children", "5", "--dry-run"],
      [pr(925), issue(5, 55)],
    );
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).not.toMatch(/would run/);
  });

  it("attach-sub --json pins the refusal shape: parent, children, pullRequests, refused, reason", async () => {
    const result = await capture(
      ["issue", "attach-sub", "--target", "o/n", "--parent", "1", "--children", "5,925"],
      [PARENT_1, issue(5, 55), pr(925)],
      { json: true },
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toEqual({
      parent: 1,
      children: [5, 925],
      pullRequests: [925],
      refused: true,
      reason: expect.stringContaining("#925 (--children) names a pull request, not an issue"),
    });
  });

  it("attach-sub still attaches a genuine issue, exactly as before", async () => {
    const result = await capture(
      ["issue", "attach-sub", "--target", "o/n", "--parent", "1", "--children", "5"],
      [
        PARENT_1,
        issue(5, 55),
        { match: "gh api --method POST repos/o/n/issues/1/sub_issues -F sub_issue_id=55", result: {} },
      ],
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/attached #5 \(id 55\) to #1/);
  });

  it("consolidate-close refuses (exit 1) when a child names a pull request, and closes nothing", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "925"],
      [PARENT_1, pr(925), NO_OPEN_PRS],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(1);
    const err = result.err.join("\n");
    expect(err).toMatch(/#925 \(--children\) names a pull request, not an issue/);
    expect(err).toMatch(/Nothing was attached, closed or commented on/);
  });

  it("consolidate-close refuses when the PARENT names a pull request", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "925", "--children", "5"],
      [pr(925), issue(5, 55), NO_OPEN_PRS],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/#925 \(--parent\)/);
    expect(writes(result.calls)).toEqual([]);
    // The parent is certified by the HOISTED check, not only by the write-stage
    // pre-flight underneath it: NO_OPEN_PRS is scripted, so reaching the
    // open-PR guard would succeed quietly -- this is what says the refusal came
    // first (zheref/nen#77 review, minor).
    expect(result.calls.filter((line): boolean => line.startsWith("gh pr list"))).toEqual([]);
  });

  it("consolidate-close closes NOTHING when only one child of several is a pull request", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5,925"],
      [PARENT_1, issue(5, 55), pr(925), NO_OPEN_PRS],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/#925 \(--children\)/);
  });

  it("consolidate-close --json pins the same refusal shape attach-sub emits", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5,925"],
      [PARENT_1, issue(5, 55), pr(925), NO_OPEN_PRS],
      { repoFlag: BANKAI_REPO, json: true },
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toEqual({
      parent: 1,
      children: [5, 925],
      pullRequests: [925],
      refused: true,
      reason: expect.stringContaining("names a pull request, not an issue"),
    });
  });

  it("consolidate-close --dry-run refuses rather than previewing the attach and the close", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "925", "--dry-run"],
      [PARENT_1, pr(925), NO_OPEN_PRS],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).not.toMatch(/would run/);
  });

  // THE ORDER OF THE REFUSALS IS ITSELF THE CONTRACT (zheref/nen#77 review,
  // minor). consolidate-close had two refusals older than this one -- the
  // unreduced-families check and the open-PR guard -- and both used to fire
  // FIRST, so a pull request in --children was answered with a remedy that
  // does not apply to it. Certification now runs before either.
  it("consolidate-close answers a PR child with the OBJECT-CLASS refusal, not the omitted-severity-family one", async () => {
    const result = await capture(
      // Two children carrying two labels of one family: without
      // --severity-family this is exactly the unreduced-families refusal's
      // trigger, and #925 is a pull request.
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5,925"],
      [
        PARENT_1,
        {
          match: "gh api repos/o/n/issues/5",
          result: { stdout: JSON.stringify({ number: 5, id: 55, title: "a", state: "open", labels: [{ name: "bankai:severity/high" }] }) },
        },
        {
          match: "gh api repos/o/n/issues/925",
          result: {
            stdout: JSON.stringify({
              number: 925,
              id: 90925,
              title: "some pull request",
              state: "open",
              labels: [{ name: "bankai:severity/medium" }],
              pull_request: { url: "https://api.github.com/repos/o/n/pulls/925" },
            }),
          },
        },
      ],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(1);
    const err = result.err.join("\n");
    expect(err).toMatch(/#925 \(--children\) names a pull request, not an issue/);
    expect(err).not.toMatch(/--severity-family/);
    expect(writes(result.calls)).toEqual([]);
  });

  // The --json half of the same finding, and the sharper one: the
  // unreduced-families refusal PUBLISHES the plan, so answering it first put
  // the pull request itself -- `isPullRequest: true`, `toClose: [925]` -- into
  // the body of a refusal whose own comment says the plan is withheld.
  it("consolidate-close --json publishes NO plan when a child is a pull request", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "5,925"],
      [
        PARENT_1,
        {
          match: "gh api repos/o/n/issues/5",
          result: { stdout: JSON.stringify({ number: 5, id: 55, title: "a", state: "open", labels: [{ name: "bankai:severity/high" }] }) },
        },
        {
          match: "gh api repos/o/n/issues/925",
          result: {
            stdout: JSON.stringify({
              number: 925,
              id: 90925,
              title: "some pull request",
              state: "open",
              labels: [{ name: "bankai:severity/medium" }],
              pull_request: { url: "https://api.github.com/repos/o/n/pulls/925" },
            }),
          },
        },
      ],
      { repoFlag: BANKAI_REPO, json: true },
    );
    expect(result.code).toBe(1);
    const body = result.out.join("\n");
    expect(JSON.parse(body)).toEqual({
      parent: 1,
      children: [5, 925],
      pullRequests: [925],
      refused: true,
      reason: expect.stringContaining("#925 (--children) names a pull request, not an issue"),
    });
    expect(body).not.toMatch(/"plan"/);
    expect(body).not.toMatch(/isPullRequest/);
    expect(writes(result.calls)).toEqual([]);
  });

  // The other pre-existing refusal, same finding: "pass --allow-open-pr" is
  // advice a caller can follow, and following it on a pull request would have
  // been following it into the choreography this verb must refuse outright.
  it("consolidate-close answers a PR child with the object-class refusal, not the --allow-open-pr advice", async () => {
    const result = await capture(
      ["issue", "consolidate-close", "--target", "o/n", "--parent", "1", "--children", "925"],
      [
        PARENT_1,
        pr(925),
        // The open-PR guard's own read is scripted so that reaching it is a
        // WRONG ANSWER rather than a crash: this test has to fail on the
        // message, not on the fixture running out.
        {
          match:
            "gh pr list --repo o/n --state open --limit 100 --json number,title,url,isDraft,body,closingIssuesReferences",
          result: {
            stdout: JSON.stringify([
              { number: 99, title: "wip", url: "https://x/pull/99", isDraft: true, body: "", closingIssuesReferences: [{ number: 925 }] },
            ]),
          },
        },
      ],
      { repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(1);
    const err = result.err.join("\n");
    expect(err).toMatch(/#925 \(--children\) names a pull request, not an issue/);
    expect(err).not.toMatch(/--allow-open-pr/);
    expect(writes(result.calls)).toEqual([]);
  });

  // KEY ORDER IS PART OF THE --json CONTRACT and nothing pinned it: `toEqual`
  // compares objects, so a refactor that reordered the fields would keep every
  // shape assertion in this file green while changing the bytes a caller
  // diffing or golden-testing this output reads (zheref/nen#77 review, minor).
  // One classifier verb and one choreography verb, since those are the two
  // shapes `refuseNotAnIssue` renders.
  it("pins the classifier refusal's --json KEY ORDER: issue, refused, reason", async () => {
    const result = await capture(
      ["issue", "chain-position", "--target", "o/n", "--issue", "925"],
      [pr(925)],
      { json: true },
    );
    expect(result.code).toBe(1);
    expect(Object.keys(JSON.parse(result.out.join("\n")) as object)).toEqual([
      "issue",
      "refused",
      "reason",
    ]);
  });

  it("pins the choreography refusal's --json KEY ORDER: parent, children, pullRequests, refused, reason", async () => {
    const result = await capture(
      ["issue", "attach-sub", "--target", "o/n", "--parent", "1", "--children", "5,925"],
      [PARENT_1, issue(5, 55), pr(925)],
      { json: true },
    );
    expect(result.code).toBe(1);
    expect(Object.keys(JSON.parse(result.out.join("\n")) as object)).toEqual([
      "parent",
      "children",
      "pullRequests",
      "refused",
      "reason",
    ]);
  });

  // Minor 4's CLI half: `--children 12,12` is one wrong number typed twice.
  it("names a repeated --children number once, and returns it once", async () => {
    const result = await capture(
      ["issue", "attach-sub", "--target", "o/n", "--parent", "1", "--children", "925,925"],
      [PARENT_1, pr(925)],
      { json: true },
    );
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.out.join("\n")) as { pullRequests: number[]; reason: string };
    expect(parsed.pullRequests).toEqual([925]);
    expect(parsed.reason).toMatch(/^#925 \(--children\) names a pull request, not an issue;/);
  });

  it("issue --help documents the refusal on both choreography verbs", async () => {
    const out = (await capture(["issue", "--help"])).out.join("\n");
    expect(out).toMatch(
      /Every number must name an ISSUE\. --parent and each --children entry are\s+read and checked BEFORE the first write/,
    );
    expect(out).toMatch(/Every number must name an ISSUE, exactly as 'attach-sub' requires/);
  });
});

describe("nen issue file/comment/edit-body -- the private-name guard (zheref/nen#329)", () => {
  const PUBLIC: ScriptedCall = { match: "gh api repos/o/n", result: { stdout: JSON.stringify({ visibility: "public" }) } };
  const PRIVATE: ScriptedCall = { match: "gh api repos/o/n", result: { stdout: JSON.stringify({ visibility: "private" }) } };
  const listOf = (names: readonly string[]): ScriptedCall => ({
    match: "gh api user/repos?visibility=private&per_page=100&page=1",
    result: { stdout: JSON.stringify(names.map((full_name): { full_name: string } => ({ full_name }))) },
  });
  const LIST = listOf(["acme/hidden-thing", "acme/vault"]);
  const CERTIFY: ScriptedCall = {
    match: "gh api repos/o/n/issues/12",
    result: { stdout: JSON.stringify({ number: 12, id: 100, title: "an issue", state: "open", labels: [], body: null }) },
  };
  const guarded = { privateGuard: "scripted" as const };
  const commentArgs = (body: string, ...extra: string[]): string[] => [
    "issue", "comment", "--target", "o/n", "--issue", "12", `--body=${body}`, ...extra,
  ];

  it("comment: a bare name on a PUBLIC target refuses with exit 4, posts nothing, and never prints the name", async () => {
    const result = await capture(commentArgs("ported from vault last week"), [PUBLIC, LIST], guarded);
    expect(result.code).toBe(4);
    expect(writes(result.calls)).toEqual([]);
    expect(result.calls).toEqual(["gh api repos/o/n", "gh api user/repos?visibility=private&per_page=100&page=1"]);
    const all = [...result.out, ...result.err].join("\n");
    expect(all).toContain("body:1: private repository #2");
    expect(all).not.toMatch(/vault/i);
  });

  it("comment: an owner/name slug, a case variant and markdown emphasis are each refused", async () => {
    for (const body of ["see acme/hidden-thing", "VAULT", "_vault_", "**Hidden-Thing**"]) {
      const result = await capture(commentArgs(body), [PUBLIC, LIST], guarded);
      expect(result.code, body).toBe(4);
      expect(writes(result.calls), body).toEqual([]);
    }
  });

  it("comment: --dry-run runs the same check and refuses the same way, before printing the body", async () => {
    const result = await capture(commentArgs("the vault", "--dry-run"), [PUBLIC, LIST], guarded);
    expect(result.code).toBe(4);
    expect(result.out).toEqual([]);
  });

  it("comment --json: the refusal carries the verdict and NO body", async () => {
    const result = await capture(commentArgs("the vault"), [PUBLIC, LIST], { ...guarded, json: true });
    expect(result.code).toBe(4);
    const report = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(report["body"]).toBeUndefined();
    expect(report["posted"]).toBe(false);
    expect(report["privateNameCheck"]).toEqual({
      result: "refused",
      targetVisibility: "public",
      listSize: 2,
      owners: 1,
      hits: [{ field: "body", line: 1, index: 2, normalised: false, ignored: false }],
      error: null,
    });
    expect(result.out.join("\n")).not.toMatch(/vault/i);
  });

  it("comment: a clean body on a PUBLIC target posts, and says nothing extra", async () => {
    const result = await capture(
      commentArgs("nothing private here"),
      [PUBLIC, LIST, { match: "gh issue comment 12 --repo o/n --body nothing private here", result: { stdout: "" } }],
      guarded,
    );
    expect(result.code).toBe(0);
    expect(result.err).toEqual([]);
  });

  it("comment: an EMPTY private list is a refusal (exit 1), never a pass", async () => {
    const result = await capture(commentArgs("anything"), [PUBLIC, listOf([])], guarded);
    expect(result.code).toBe(1);
    expect(writes(result.calls)).toEqual([]);
    expect(result.err.join("\n")).toMatch(/read EMPTY/);
  });

  it("comment: an unreadable visibility or list is a refusal (exit 1)", async () => {
    const noVisibility = await capture(commentArgs("anything"), [{ match: "gh api repos/o/n", result: { code: 1 } }], guarded);
    expect(noVisibility.code).toBe(1);
    expect(noVisibility.err.join("\n")).toMatch(/could not run/);
    const noList = await capture(
      commentArgs("anything"),
      [PUBLIC, { match: "gh api user/repos?visibility=private&per_page=100&page=1", result: { code: 1, stderr: "HTTP 401" } }],
      guarded,
    );
    expect(noList.code).toBe(1);
    expect(writes(noList.calls)).toEqual([]);
  });

  it("comment: a PRIVATE target is not checked -- the list is never read, and the post goes ahead", async () => {
    const result = await capture(
      commentArgs("the vault"),
      [PRIVATE, { match: "gh issue comment 12 --repo o/n --body the vault", result: { stdout: "" } }],
      guarded,
    );
    expect(result.code).toBe(0);
    expect(result.calls).toEqual(["gh api repos/o/n", "gh issue comment 12 --repo o/n --body the vault"]);
  });

  it("comment: --skip-private-name-check reads nothing, posts, and is NAMED in the output", async () => {
    const result = await capture(
      commentArgs("the vault", "--skip-private-name-check"),
      [{ match: "gh issue comment 12 --repo o/n --body the vault", result: { stdout: "" } }],
      guarded,
    );
    expect(result.code).toBe(0);
    expect(result.calls).toEqual(["gh issue comment 12 --repo o/n --body the vault"]);
    expect(result.err.join("\n")).toMatch(/SKIPPED by --skip-private-name-check/);
  });

  it("file: a name in the TITLE refuses with exit 4 before the create call", async () => {
    const path = tempFile("body.md", "a clean body\n");
    const result = await capture(
      [
        "issue", "file", "--target", "o/n", "--title", "Port the Vault adapter", "--body-file", path,
        "--label", "bankai:severity/low", "--assignee", "me",
      ],
      [PUBLIC, LIST],
      { ...guarded, repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(4);
    expect(writes(result.calls)).toEqual([]);
    expect(result.err.join("\n")).toContain("title:1: private repository #2");
  });

  it("file: a name spelt through an entity in the body is found on its own line, and the dry run refuses too", async () => {
    const path = tempFile("body.md", "line one\nsee hidden&#45;thing\n");
    const result = await capture(
      [
        "issue", "file", "--target", "o/n", "--title", "t", "--body-file", path,
        "--label", "bankai:severity/low", "--assignee", "me", "--dry-run",
      ],
      [PUBLIC, LIST],
      { ...guarded, repoFlag: BANKAI_REPO },
    );
    expect(result.code).toBe(4);
    expect(result.err.join("\n")).toMatch(/body:2: private repository #1 \(spelt through/);
  });

  it("file: a clean dry run carries privateNameCheck and the resolved bodyFile under --json, and argv names stdin", async () => {
    const path = tempFile("body.md", "a clean body\n");
    const result = await capture(
      [
        "issue", "file", "--target", "o/n", "--title", "t", "--body-file", path,
        "--label", "bankai:severity/low", "--assignee", "me", "--dry-run",
      ],
      [PUBLIC, LIST],
      { ...guarded, repoFlag: BANKAI_REPO, json: true },
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as {
      argv: string[];
      bodyFile: string;
      privateNameCheck: { result: string };
    };
    expect(report.privateNameCheck.result).toBe("clean");
    expect(report.bodyFile).toBe(path);
    expect(report.argv).toContain("-");
  });

  it("edit-body: a name in the replacement refuses with exit 4 after certifying, before any write", async () => {
    const path = tempFile("body.md", "## plan\n\nmerge vault first\n");
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", path],
      [CERTIFY, PUBLIC, LIST],
      { ...guarded, json: true },
    );
    expect(result.code).toBe(4);
    expect(writes(result.calls)).toEqual([]);
    const report = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(report["contract"]).toBe("nen.issue.edit-body/v0.3");
    expect(report["outcome"]).toBe("private-name");
    expect(report["written"]).toBe(false);
    expect((report["privateNameCheck"] as { hits: unknown[] }).hits).toEqual([
      { field: "body", line: 3, index: 2, normalised: false, ignored: false },
    ]);
  });

  it("edit-body: an unavailable check is outcome private-name-check-unavailable, exit 1", async () => {
    const path = tempFile("body.md", "anything\n");
    const result = await capture(
      ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", path],
      [CERTIFY, PUBLIC, listOf([])],
      { ...guarded, json: true },
    );
    expect(result.code).toBe(1);
    expect((JSON.parse(result.out.join("\n")) as { outcome: string }).outcome).toBe("private-name-check-unavailable");
  });

  describe("--private-names-ignore-file", () => {
    const ignoreFile = (text: string): string => tempFile("redaction-ignore", text);

    it("a bare name in the ignore file exempts it under every owner: the post goes ahead, and the hit is reported, not silent", async () => {
      const path = ignoreFile("# too generic to police\n\nVAULT\n");
      const result = await capture(
        commentArgs("the vault", "--private-names-ignore-file", path),
        [PUBLIC, LIST, { match: "gh issue comment 12 --repo o/n --body the vault", result: { stdout: "" } }],
        guarded,
      );
      expect(result.code).toBe(0);
      expect(result.err).toEqual(["nen issue: ignored: body:1: private repository #2 (ignore file)"]);
    });

    it("--json records the ignored hit as ignored: true, with a clean verdict", async () => {
      const path = ignoreFile("vault\n");
      const result = await capture(
        commentArgs("the vault", "--dry-run", "--private-names-ignore-file", path),
        [PUBLIC, LIST],
        { ...guarded, json: true },
      );
      expect(result.code).toBe(0);
      const report = JSON.parse(result.out.join("\n")) as { privateNameCheck: unknown };
      expect(report.privateNameCheck).toEqual({
        result: "clean",
        targetVisibility: "public",
        listSize: 2,
        owners: 1,
        hits: [{ field: "body", line: 1, index: 2, normalised: false, ignored: true }],
        error: null,
      });
    });

    it("an owner/name line exempts that slug only: the same name under another owner still refuses", async () => {
      const path = ignoreFile("acme/vault\n");
      const twin = listOf(["acme/vault", "other/vault"]);
      const result = await capture(commentArgs("the vault", "--private-names-ignore-file", path), [PUBLIC, twin], guarded);
      expect(result.code).toBe(4);
      expect(writes(result.calls)).toEqual([]);
      const exact = await capture(
        commentArgs("the vault", "--dry-run", "--private-names-ignore-file", path),
        [PUBLIC, LIST],
        guarded,
      );
      expect(exact.code).toBe(0);
    });

    it("an ignored hit beside a policed one: still exit 4, both reported, the name never printed", async () => {
      const path = ignoreFile("vault\n");
      const result = await capture(
        commentArgs("vault and hidden-thing", "--private-names-ignore-file", path),
        [PUBLIC, LIST],
        guarded,
      );
      expect(result.code).toBe(4);
      const err = result.err.join("\n");
      expect(err).toContain("ignored: body:1: private repository #2 (ignore file)");
      expect(err).toContain("nen issue: body:1: private repository #1");
      expect(err).toMatch(/1 mention\(s\)/);
      expect(err).not.toMatch(/vault|hidden-thing/i);
    });

    it("a missing ignore file is a usage error (exit 2) before any gh call", async () => {
      for (const argv of [
        commentArgs("x", "--private-names-ignore-file", "/nonexistent/redaction-ignore"),
        ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", tempFile("b.md", "x\n"),
          "--private-names-ignore-file", "/nonexistent/redaction-ignore"],
      ]) {
        const result = await capture(argv, [], guarded);
        expect(result.code).toBe(2);
        expect(result.calls).toEqual([]);
      }
    });

    it("works on 'file' too, and on 'edit-body'", async () => {
      const ignore = ignoreFile("hidden-thing\n");
      const body = tempFile("body.md", "about hidden-thing\n");
      const filed = await capture(
        [
          "issue", "file", "--target", "o/n", "--title", "t", "--body-file", body,
          "--label", "bankai:severity/low", "--assignee", "me", "--dry-run", "--private-names-ignore-file", ignore,
        ],
        [PUBLIC, LIST],
        { ...guarded, repoFlag: BANKAI_REPO },
      );
      expect(filed.code).toBe(0);
      expect(filed.err).toEqual(["nen issue: ignored: body:1: private repository #1 (ignore file)"]);
      const edited = await capture(
        ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", body, "--dry-run",
          "--private-names-ignore-file", ignore],
        [CERTIFY, PUBLIC, LIST],
        guarded,
      );
      expect(edited.code).toBe(0);
    });
  });

  describe("relative paths resolve against --repo's root, never the process's directory (N1)", () => {
    /** A --repo checkout with a taxonomy, a decoy cwd, run with the cwd moved there. */
    async function fromElsewhere<T>(setup: (repo: string, cwd: string) => void, run: (repo: string) => Promise<T>): Promise<T> {
      const repo = mkdtempSync(join(tmpdir(), "nen-issue-repo-"));
      cpSync(BANKAI_REPO, repo, { recursive: true });
      const cwd = mkdtempSync(join(tmpdir(), "nen-issue-cwd-"));
      setup(repo, cwd);
      const previous = process.cwd();
      try {
        process.chdir(cwd);
        return await run(repo);
      } finally {
        process.chdir(previous);
      }
    }
    const fileArgs = (...extra: string[]): string[] => [
      "issue", "file", "--target", "o/n", "--title", "t", "--body-file", "body.md",
      "--label", "bankai:severity/low", "--assignee", "me", ...extra,
    ];

    it("file --body-file body.md: the guard reads <repo>/body.md, and gh gets exactly those bytes", async () => {
      await fromElsewhere(
        (repo, cwd) => {
          writeFileSync(join(repo, "body.md"), "the body under --repo\n", "utf8");
          writeFileSync(join(cwd, "body.md"), "a decoy beside the process, naming vault\n", "utf8");
        },
        async (repo) => {
          const create = "gh issue create --repo o/n --title t --body-file - --assignee me --label bankai:severity/low";
          const scripted = new ScriptedSeams([PUBLIC, LIST, { match: create, result: { stdout: "https://github.com/o/n/issues/7\n" } }]);
          const out: string[] = [];
          const io: Io = { out: (line): void => void out.push(line), err: (): void => undefined };
          const code = await runFamily(issueCommand, fileArgs(), repo, true, io, scripted);
          expect(code).toBe(0);
          const report = JSON.parse(out.join("\n")) as { bodyFile: string };
          expect(report.bodyFile).toBe(join(repo, "body.md"));
          const write = scripted.calls.find((call): boolean => call.args[1] === "create");
          expect(write?.stdin).toBe("the body under --repo\n");
        },
      );
    });

    it("file --body-file body.md: a private name in <repo>/body.md is what the guard refuses", async () => {
      await fromElsewhere(
        (repo, cwd) => {
          writeFileSync(join(repo, "body.md"), "merge vault first\n", "utf8");
          writeFileSync(join(cwd, "body.md"), "a clean decoy\n", "utf8");
        },
        async (repo) => {
          const result = await capture(fileArgs(), [PUBLIC, LIST], { ...guarded, repoFlag: repo });
          expect(result.code).toBe(4);
          expect(result.err.join("\n")).toContain("body:1: private repository #2");
        },
      );
    });

    it("--private-names-ignore-file ignore.txt is read from --repo's root", async () => {
      await fromElsewhere(
        (repo, cwd) => {
          writeFileSync(join(repo, "ignore.txt"), "vault\n", "utf8");
          writeFileSync(join(cwd, "ignore.txt"), "# a decoy that ignores nothing\n", "utf8");
        },
        async (repo) => {
          const result = await capture(
            commentArgs("the vault", "--dry-run", "--private-names-ignore-file", "ignore.txt"),
            [PUBLIC, LIST],
            { ...guarded, repoFlag: repo },
          );
          expect(result.code).toBe(0);
          expect(result.err).toEqual(["nen issue: ignored: body:1: private repository #2 (ignore file)"]);
        },
      );
    });
  });

  describe("an ignore file that exempts EVERY private name (N4)", () => {
    const ignoreAll = (): string => tempFile("redaction-ignore", "vault\nhidden-thing\n");

    it("refuses as unavailable (exit 1) and writes nothing", async () => {
      const result = await capture(commentArgs("the vault", "--private-names-ignore-file", ignoreAll()), [PUBLIC, LIST], guarded);
      expect(result.code).toBe(1);
      expect(writes(result.calls)).toEqual([]);
      expect(result.err.join("\n")).toMatch(/every private name is ignored/);
    });

    it("--allow-all-ignored permits it: the post goes ahead, each ignored hit still reported", async () => {
      const result = await capture(
        commentArgs("the vault", "--private-names-ignore-file", ignoreAll(), "--allow-all-ignored"),
        [PUBLIC, LIST, { match: "gh issue comment 12 --repo o/n --body the vault", result: { stdout: "" } }],
        guarded,
      );
      expect(result.code).toBe(0);
      expect(result.err).toEqual(["nen issue: ignored: body:1: private repository #2 (ignore file)"]);
    });

    it("--allow-all-ignored without an ignore file is a usage error (exit 2) before any gh call", async () => {
      const result = await capture(commentArgs("x", "--allow-all-ignored"), [], guarded);
      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
    });
  });

  describe("gh is handed the CHECKED bytes on stdin, never the path (N10)", () => {
    it("comment --body-file: a file rewritten after the check is NOT what is posted", async () => {
      const path = tempFile("body.md", "a clean body\n");
      const post = "gh issue comment 12 --repo o/n --body-file -";
      const scripted = new ScriptedSeams([PUBLIC, LIST, { match: post, result: { stdout: "" } }]);
      // A writer lands DURING the check -- after nen read the file, before gh runs.
      const racing: Seams = {
        ...scripted,
        run: (command, args, options) => {
          if (args[1]?.startsWith("user/repos") === true) writeFileSync(path, "now naming vault\n", "utf8");
          return scripted.run(command, args, options);
        },
        runInteractive: scripted.runInteractive,
        runStreamed: scripted.runStreamed,
        probePort: scripted.probePort,
        now: scripted.now,
        env: scripted.env,
        platform: scripted.platform,
      };
      const silent: Io = { out: (): void => undefined, err: (): void => undefined };
      const code = await runFamily(
        issueCommand,
        ["issue", "comment", "--target", "o/n", "--issue", "12", "--body-file", path],
        null,
        false,
        silent,
        racing,
      );
      expect(code).toBe(0);
      const write = scripted.calls.find((call): boolean => call.args[1] === "comment");
      expect(write?.args).toContain("-");
      expect(write?.args).not.toContain(path);
      expect(write?.stdin).toBe("a clean body\n");
    });

    it("edit-body: the write carries the replacement on stdin, byte for byte (CRLF kept)", async () => {
      const path = tempFile("body.md", "line one\r\nline two\r\n");
      const write = "gh issue edit 12 --repo o/n --body-file -";
      const scripted = new ScriptedSeams([CERTIFY, PUBLIC, LIST, { match: write, result: {} }]);
      const silent: Io = { out: (): void => undefined, err: (): void => undefined };
      const code = await runFamily(
        issueCommand,
        ["issue", "edit-body", "--target", "o/n", "--issue", "12", "--body-file", path],
        null,
        false,
        silent,
        scripted,
      );
      expect(code).toBe(0);
      expect(scripted.calls.find((call): boolean => call.args[1] === "edit")?.stdin).toBe("line one\r\nline two\r\n");
    });
  });

  it("the opt-out belongs to the three writing verbs only: 'search' refuses it as foreign (exit 2)", async () => {
    const result = await capture(["issue", "search", "--target", "o/n", "--subject", "x", "--skip-private-name-check"]);
    expect(result.code).toBe(2);
  });

  it("issue --help documents the guard, exit 4 and the opt-out", async () => {
    const out = (await capture(["issue", "--help"])).out.join("\n");
    expect(out).toMatch(/PRIVATE REPOSITORY NAMES/);
    expect(out).toMatch(/REFUSES with exit 4/);
    expect(out).toMatch(/--skip-private-name-check/);
    expect(out).toMatch(/--private-names-ignore-file <path>/);
  });
});

describe("nen issue reconcile -- read-only, proposes only (zheref/nen#332)", () => {
  const DEFAULT_BRANCH: ScriptedCall = {
    match: "gh repo view o/n --json defaultBranchRef",
    result: { stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }) },
  };
  const OPEN_ISSUES: ScriptedCall = {
    match: "gh issue list --repo o/n --state open --limit 100 --json number,title,url,labels,stateReason",
    result: { stdout: JSON.stringify([{ number: 5, title: "five", url: "u5", labels: [], stateReason: "" }]) },
  };
  const MERGED = ["gh", ...mergedPullsArgv({ owner: "o", repo: "n", slug: "o/n" }, 100, null, null)].join(" ");
  const MERGED_PRS: ScriptedCall = {
    match: MERGED,
    result: {
      stdout: JSON.stringify({
        data: {
          search: {
            issueCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 40, title: "pr", url: "u40", baseRefName: "main", mergedAt: "2026-10-01T00:00:00Z", mergeCommit: { oid: "f".repeat(40) }, body: "Closes #5",
                closingIssuesReferences: { totalCount: 0, nodes: [] }, commits: { totalCount: 0, nodes: [] },
              },
            ],
          },
        },
      }),
    },
  };
  const OPEN_PRS: ScriptedCall = {
    match: "gh pr list --repo o/n --state open --limit 100 --json number,title,url,isDraft,body,closingIssuesReferences",
    result: { stdout: "[]" },
  };

  it("emits the versioned --json document, exit 0, and writes nothing", async () => {
    const result = await capture(["issue", "reconcile", "--target", "o/n"], [DEFAULT_BRANCH, OPEN_ISSUES, MERGED_PRS, OPEN_PRS], { json: true });
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc["contract"]).toBe("nen.issue.reconcile/v0.1");
    expect(doc["proposesOnly"]).toBe(true);
    expect(doc["complete"]).toBe(true);
    expect((doc["proposals"] as { issue: number; action: string }[]).map((p) => [p.issue, p.action])).toEqual([[5, "close"]]);
    expect(result.calls.every((call) => / list | view /.test(call) || (call.startsWith("gh api graphql -f query=query(") && !/mutation/.test(call)))).toBe(true);
  });

  it("renders the same proposals for a human, saying it proposes only", async () => {
    const result = await capture(["issue", "reconcile", "--target", "o/n"], [DEFAULT_BRANCH, OPEN_ISSUES, MERGED_PRS, OPEN_PRS]);
    expect(result.code).toBe(0);
    const out = result.out.join("\n");
    expect(out).toMatch(/proposes only -- nothing was closed, commented on or labelled/);
    expect(out).toMatch(/propose: close -- PR #40/);
  });

  it("exits 1 on an unreadable source, in --json too, and says what was not read", async () => {
    const result = await capture(
      ["issue", "reconcile", "--target", "o/n"],
      [DEFAULT_BRANCH, OPEN_ISSUES, { match: MERGED, result: { code: 1, stderr: "HTTP 502" } }],
      { json: true },
    );
    expect(result.code).toBe(1);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc["complete"]).toBe(false);
    expect(doc["proposals"]).toEqual([]);
    expect(result.err.join("\n")).toMatch(/could not be read in full; what was not read was not reconciled/);
  });

  it("refuses --dry-run at exit 2, naming the propose-only ruling", async () => {
    const result = await capture(["issue", "reconcile", "--target", "o/n", "--dry-run"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/proposes only, by the maintainer's ruling recorded on this verb's PR \(zheref\/nen#332's delivery\)/);
    expect(result.calls).toEqual([]);
  });

  it.each([
    [["--since", "2026-02-30"], /--since takes a calendar date/],
    [["--since", "yesterday"], /--since takes a calendar date/],
    // Copilot A on zheref/nen#387: an Invalid Date used to reach toISOString()
    // and throw a RangeError instead of refusing.
    [["--since", "2026-99-99"], /--since takes a calendar date/],
    [["--limit", "0"], /--limit takes a whole number from 1 to 1000/],
    [["--limit", "1001"], /--limit takes a whole number/],
    [["--issues", "5,x"], /not one: 'x'/],
  ])("refuses a malformed %j at exit 2 before any read", async (flags, pattern) => {
    const result = await capture(["issue", "reconcile", "--target", "o/n", ...flags]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(pattern);
    expect(result.calls).toEqual([]);
  });

  it("requires --target", async () => {
    expect((await capture(["issue", "reconcile"])).code).toBe(2);
  });

  it("issue --help documents reconcile as read-only and propose-only", async () => {
    const out = (await capture(["issue", "--help"])).out.join("\n");
    expect(out).toMatch(/nen issue reconcile --target <owner\/name> \[--since <YYYY-MM-DD>\]/);
    expect(out).toMatch(/READ-ONLY, PROPOSES ONLY/);
    // Copilot E on zheref/nen#387: the --json shape in --help matches USAGE.
    expect(out).toMatch(/landing, delivery: \{ pr,\s+url, mergedAt \} \| null, references:/);
  });
});
