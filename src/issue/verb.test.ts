import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { runIssue } from "./verb.js";
import type { VerbContext } from "../cli/verb.js";

function makeContext(overrides: Partial<VerbContext> = {}): { context: VerbContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const context: VerbContext = {
    args: [],
    values: {},
    booleans: new Set(),
    passthrough: [],
    repoFlag: null,
    json: false,
    io: { out: (l): void => void out.push(l), err: (l): void => void err.push(l) },
    ...overrides,
  };
  return { context, out, err };
}

describe("nen issue -- CLI wiring", () => {
  it("requires --target", () => {
    const { context, err } = makeContext({ args: ["search"], values: { subject: "x" } });
    const code = runIssue(context, new ScriptedRunner([]));
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/--target/);
  });

  it("refuses an unknown subcommand as a usage error", () => {
    const { context } = makeContext({ args: ["bogus"] });
    expect(runIssue(context, new ScriptedRunner([]))).toBe(2);
  });

  it("open-pr-check requires --issues", () => {
    const { context } = makeContext({ args: ["open-pr-check"], values: { target: "o/n" } });
    expect(runIssue(context, new ScriptedRunner([]))).toBe(2);
  });

  it("search emits the stable --json contract and a non-zero exit on a failed pass", () => {
    const { context, out } = makeContext({
      args: ["search"],
      values: { target: "o/n", subject: "x" },
      json: true,
    });
    const now = new Date("2026-08-31T00:00:00Z");
    const runner = new ScriptedRunner([
      {
        match: "gh issue list --repo o/n --state open --search x --limit 100 --json number,title,state,url,labels,updatedAt,closedAt",
        result: { code: 1, stderr: "down" },
      },
      {
        match: "gh issue list --repo o/n --state closed --search x closed:>=2026-06-02 --limit 100 --json number,title,state,url,labels,updatedAt,closedAt",
        result: { stdout: "[]" },
      },
    ]);
    const code = runIssue(context, runner, now);
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join("\n")) as { ok: boolean; passes: unknown[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.passes.length).toBe(4);
  });

  it("file requires --body-file", () => {
    const { context } = makeContext({
      args: ["file"],
      values: { target: "o/n", title: "t", label: "bug", assignee: "me" },
      repoFlag: BANKAI_REPO,
    });
    expect(runIssue(context, new ScriptedRunner([]))).toBe(2);
  });

  // Review finding #13: consolidate-close ran no open-PR guard at all --
  // 'nen issue open-pr-check' existed one verb over and nothing wired it in.
  it("consolidate-close refuses (exit 1) when a child has an open PR, and never reaches attach or close", () => {
    const runner = new ScriptedRunner([
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
      // calls -- if the guard fails to refuse first, ScriptedRunner throws
      // on the first unscripted call, which is itself a red test.
    ]);
    const { context, err } = makeContext({
      args: ["consolidate-close"],
      values: { target: "o/n", parent: "1", children: "5" },
      repoFlag: BANKAI_REPO,
    });
    expect(runIssue(context, runner)).toBe(1);
    expect(err.join("\n")).toMatch(/open PR/);
    expect(err.join("\n")).toMatch(/#99/);
  });

  it("consolidate-close --allow-open-pr overrides the refusal and proceeds to attach and close", () => {
    const runner = new ScriptedRunner([
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
      { match: 'gh issue close 5 --repo o/n --comment Consolidated into #1.', result: {} },
    ]);
    const { context } = makeContext({
      args: ["consolidate-close"],
      values: { target: "o/n", parent: "1", children: "5" },
      booleans: new Set(["allow-open-pr"]),
      repoFlag: BANKAI_REPO,
    });
    expect(runIssue(context, runner)).toBe(0);
  });

  it("consolidate-close proceeds with no guard triggered when no child has an open PR", () => {
    const runner = new ScriptedRunner([
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
      { match: 'gh issue close 5 --repo o/n --comment Consolidated into #1.', result: {} },
    ]);
    const { context } = makeContext({
      args: ["consolidate-close"],
      values: { target: "o/n", parent: "1", children: "5" },
      repoFlag: BANKAI_REPO,
    });
    expect(runIssue(context, runner)).toBe(0);
  });

  // Review finding #8: an unparseable --chain-labels entry must exit 2, never
  // be silently dropped -- and no gh call is made, since the flag is checked
  // before anything is fetched.
  it("chain-position exits 2 on an unparseable --chain-labels entry (typo'd role)", () => {
    const { context, err } = makeContext({
      args: ["chain-position"],
      values: { target: "o/n", issue: "5", "chain-labels": "buildng=stage/building" },
    });
    expect(runIssue(context, new ScriptedRunner([]))).toBe(2);
    expect(err.join("\n")).toMatch(/unknown role 'buildng'/);
  });

  // Review finding #14: 'undecidable' is a refusal and must exit non-zero.
  it("chain-position exits 1 when a critical role (here: 'building') was never mapped, even though the issue carries no error", () => {
    const runner = new ScriptedRunner([
      {
        match: "gh api repos/o/n/issues/5",
        result: { stdout: JSON.stringify({ number: 5, id: 55, title: "t", state: "open", labels: ["stage/building"] }) },
      },
    ]);
    const { context, out } = makeContext({
      args: ["chain-position"],
      values: {
        target: "o/n",
        issue: "5",
        "chain-labels": "idea=mode:idea,epic=type:epic,in-review=mode:review",
      },
    });
    expect(runIssue(context, runner)).toBe(1);
    expect(out.join("\n")).toMatch(/undecidable/);
  });

  it("chain-position exits 0 for a genuine 'routable' answer with every critical role mapped", () => {
    const runner = new ScriptedRunner([
      {
        match: "gh api repos/o/n/issues/5",
        result: { stdout: JSON.stringify({ number: 5, id: 55, title: "t", state: "open", labels: [] }) },
      },
    ]);
    const { context } = makeContext({
      args: ["chain-position"],
      values: {
        target: "o/n",
        issue: "5",
        "chain-labels": "idea=mode:idea,epic=type:epic,in-review=mode:review,building=mode:build",
      },
    });
    expect(runIssue(context, runner)).toBe(0);
  });

  it("terminus exits 2 on an unparseable --chain-labels entry", () => {
    const { context } = makeContext({
      args: ["terminus"],
      values: { target: "o/n", issue: "5", "chain-labels": "nonsense" },
    });
    expect(runIssue(context, new ScriptedRunner([]))).toBe(2);
  });
});
