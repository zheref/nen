import { describe, expect, it } from "vitest";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { parseTarget } from "../github/target.js";
import { viewArgv } from "../pr/fetch.js";
import { listArgv } from "../pr/threads.js";
import { commentsArgv, PR_LEDGER_CONTRACT, renderComment, type LedgerSlice } from "../pr/ledger.js";
import { reportCommand } from "./command.js";
import { assembleObjects, parseObjects } from "./objects.js";
import { parseDesk } from "./register.js";

const target = parseTarget("owner/repo");
const head = "a".repeat(40);
const effort = "feat/ledger";
const url = "https://github.com/owner/repo/pull/7#issuecomment-9";
const slice: LedgerSlice = { contract: PR_LEDGER_CONTRACT, effort, repo: target.slug, pr: 7, head, phases: [], usage: { entries: 0, totals: [] }, findings: null, proof: [] };
const comment = { databaseId: 9, url, body: renderComment(slice), author: { login: "alice" }, editor: null };
function call(args: readonly string[], value: unknown): ScriptedCall {
  return { match: `gh ${args.join(" ")}`, result: { code: 0, stdout: JSON.stringify(value) } };
}
async function row(comments: unknown[], failed = false, branch = effort): Promise<Record<string, unknown>> {
  const seams = new ScriptedSeams([
    call(viewArgv(target, 7), { number: 7, title: "test", body: "", url: "https://github.com/owner/repo/pull/7", state: "MERGED", headRefOid: head, headRefName: branch, labels: [], statusCheckRollup: [], reviewRequests: [], mergeStateStatus: "CLEAN" }),
    call(listArgv(target, 7), { data: { repository: { pullRequest: { headRefOid: head, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }),
    call(["api", "repos/owner/repo/pulls/7"], { number: 7, head: { sha: head } }),
    call(["api", "user"], { login: "alice" }),
    failed ? { match: `gh ${commentsArgv(target, 7, null).join(" ")}`, result: { code: 1, stderr: "comments forbidden" } } : call(commentsArgv(target, 7, null), { data: { repository: { pullRequest: { comments: { nodes: comments, pageInfo: { hasNextPage: false } } } } } }),
  ]);
  return (await assembleObjects(seams, { target, prs: [7], issues: [], backlog: false, from: null, repoRoot: process.cwd() }, () => {}))[0] as unknown as Record<string, unknown>;
}

describe("NN#674: ledger evidence on report PR rows", () => {
  it("AC-1: carries the link and exact read-back verdict", async () => {
    expect((await row([comment])).ledger).toMatchObject({ state: "valid", url, verdict: "ok", line: `ok: ${url} by alice -- effort '${effort}', 0 phase entries, recorded at head ${head.slice(0, 12)}; foreign: 0` });
  });
  it("AC-2: distinguishes no comment from a read failure", async () => {
    expect((await row([])).ledger).toMatchObject({ state: "none", verdict: "could-not-read", url: null, reason: expect.stringContaining("no ledger comment") });
  });
  it.each([
    { ...comment, author: { login: "other" } },
    { ...comment, editor: { login: "other" } },
    { ...comment, body: comment.body.replace('"proof": []', '"proof": [1]') },
  ])("AC-3: retains refusal of a foreign or edited slice", async (value) => {
    expect((await row([value])).ledger).toMatchObject({ state: "refused", verdict: "could-not-read", reason: expect.any(String) });
  });
  it("AC-4: unreadable comments are not read, never none", async () => {
    expect((await row([], true)).ledger).toMatchObject({ state: "not-read", verdict: "could-not-read", reason: expect.stringContaining("comments forbidden") });
  });
  it("does not publish the absolute path of an offline source", async () => {
    const offline = parseObjects([await row([comment])], "/private/confidential/work/objects.json");
    expect(JSON.stringify(offline)).not.toContain("/private/confidential");
    expect(offline[0]).toMatchObject({ ledger: { state: "not-read" } });
  });
  it("documents ledger evidence and all four states in CLI help", () => {
    for (const word of ["ledgerLine", "ledger", "valid", "none", "refused", "not-read"]) expect(reportCommand.usage).toContain(word);
  });
  it.each(["feat@ledger", "feat+ledger"])("refuses non-Nen effort %s before reading comments", async (branch) => {
    expect((await row([], false, branch)).ledger).toMatchObject({ state: "not-read", reason: expect.stringContaining("effort id") });
    const value = { ...comment, body: renderComment({ ...slice, effort: branch }) };
    expect((await row([value], false, branch)).ledger).toMatchObject({ state: "not-read", reason: expect.stringContaining("effort id") });
  });
  it.each(["ledger", "ledgerLine"])("AC-5: refuses a desk-written %s", (field) => {
    expect(() => parseDesk({ variant: "register", title: "test", scope: "owner/repo", gate: "G4", gates: [], rows: { "pr#7": { [field]: "valid" } } }, "desk.json")).toThrow(/desk does not write/);
  });
});
