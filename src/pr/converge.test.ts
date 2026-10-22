// The CLI half of acceptance-criterion coverage: `nen pr converge` (./converge.ts
// reads, ../issue/criteria.ts compares) and `nen issue criteria`.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Command } from "../cli/command.js";
import { prCommand } from "./command.js";
import { issueCommand } from "../issue/command.js";
import { CLOSING_PAGE } from "./converge.js";

async function run(
  command: Command,
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  options: { repoFlag?: string | null; json?: boolean } = {},
): Promise<{ code: number; out: string; err: string; calls: readonly string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const seams = new ScriptedSeams(script);
  const code = await runFamily(command, argv, options.repoFlag ?? null, options.json ?? false, io, seams);
  return { code, out: out.join("\n"), err: err.join("\n"), calls: seams.calls.map((call): string => [call.command, ...call.args].join(" ")) };
}

const VIEW = "gh pr view 5 --repo o/n --json number,url,headRefOid,body,closingIssuesReferences";

function view(body: string, closing: readonly unknown[]): ScriptedCall {
  return { match: VIEW, result: { stdout: JSON.stringify({ number: 5, url: "https://github.com/o/n/pull/5", headRefOid: "abc1234", body, closingIssuesReferences: closing }) } };
}

function ref(number: number, slug = "o/n"): unknown {
  const [owner, name] = slug.split("/");
  return { number, url: `https://github.com/${slug}/issues/${number}`, repository: { name, owner: { login: owner } } };
}

function issueRead(number: number, body: string | null, slug = "o/n"): ScriptedCall {
  return { match: `gh api repos/${slug}/issues/${number}`, result: { stdout: JSON.stringify({ number, title: "t", state: "open", labels: [], ...(body === null ? {} : { body }) }) } };
}

const ISSUE_BODY = "## Acceptance criteria\n\n- AC-1: lists rows\n- AC-2: exits 2 unread\n";
const PR_BODY = "## Verify\n\n| Criterion | Coverage | Evidence |\n|---|---|---|\n| NN#12/AC-1 | satisfied | criteria.test.ts |\n| NN#12/AC-2 | partial |  |\n";

describe("nen pr converge", () => {
  it("exits 0 when every criterion has a row and none says missing or contradicts", async () => {
    const result = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view(PR_BODY, [ref(12)]), issueRead(12, ISSUE_BODY)]);
    expect(result.code).toBe(0);
    expect(result.out.split("\n")).toEqual([
      "2 criterion row(s) across 1 closing issue(s), 0 blocking -- 1 covered with evidence, 1 without, 0 missing-row, 0 malformed-row, 0 duplicate-rows, 0 not-verifiable",
      "COVERED-WITH-EVIDENCE  o/n#12/AC-1 satisfied (line 5)",
      "COVERED-WITHOUT-EVIDENCE  o/n#12/AC-2 partial (line 6)",
    ]);
    expect(result.calls).toEqual([VIEW, "gh api repos/o/n/issues/12"]);
  });

  it("exits 1 on a missing row or a contradicts word, and --json carries the contract and the blocking list", async () => {
    const body = "| AC-1 | contradicts | x |\n";
    const result = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view(body, [ref(12)]), issueRead(12, ISSUE_BODY)], { json: true });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out) as { contract: string; pr: number; headSha: string; closingIssues: unknown[]; blocking: string[]; verifiable: boolean };
    expect(report.contract).toBe("nen.pr.converge/v0.1");
    expect(report.pr).toBe(5);
    expect(report.headSha).toBe("abc1234");
    expect(report.closingIssues).toEqual([{ issue: "o/n#12", criteria: 2, verifiable: true }]);
    expect(report.blocking).toEqual(["o/n#12/AC-1: contradicts", "o/n#12/AC-2: missing-row"]);
    expect(report.verifiable).toBe(true);
  });

  it("reads a closing issue in its own repository, and reports an issue with no AC row as not-verifiable at exit 0", async () => {
    const result = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view("", [ref(3, "o/elsewhere")]), issueRead(3, "No criteria.", "o/elsewhere")], { json: true });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out) as { verifiable: boolean; criteria: { coverage: string; issue: string }[] };
    expect(report.verifiable).toBe(false);
    expect(report.criteria).toEqual([expect.objectContaining({ issue: "o/elsewhere#3", coverage: "not-verifiable" })]);
  });

  it("says a PR closing no issue is not verifiable, never covered", async () => {
    const result = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view(PR_BODY, [])]);
    expect(result.code).toBe(0);
    expect(result.out.split("\n")).toEqual([
      "o/n#5 closes no issue: no criterion to compare (not verifiable)",
      "UNMATCHED line 5 'NN#12/AC-1': no closing issue states this criterion",
      "UNMATCHED line 6 'NN#12/AC-2': no closing issue states this criterion",
    ]);
  });

  it("exits 2 when it could not read: the PR, a closing issue, an issue with no body, a full page of references", async () => {
    const prFailed = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [{ match: VIEW, result: { code: 1, stderr: "HTTP 502" } }]);
    expect(prFailed.code).toBe(2);
    expect(prFailed.err).toMatch(/could not read o\/n#5: HTTP 502/);
    expect(prFailed.out).toBe("");
    const noField = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [{ match: VIEW, result: { stdout: JSON.stringify({ body: "" }) } }]);
    expect(noField.code).toBe(2);
    expect(noField.err).toMatch(/closingIssuesReferences/);
    const issueFailed = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view(PR_BODY, [ref(12)]), { match: "gh api repos/o/n/issues/12", result: { code: 1, stderr: "HTTP 404" } }]);
    expect(issueFailed.code).toBe(2);
    const noBody = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view(PR_BODY, [ref(12)]), issueRead(12, null)]);
    expect(noBody.code).toBe(2);
    expect(noBody.err).toMatch(/no 'body' field/);
    const full = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view(PR_BODY, Array.from({ length: CLOSING_PAGE }, (_, index) => ref(index + 1)))]);
    expect(full.code).toBe(2);
    expect(full.err).toMatch(/full page/);
  });

  it("refuses usage at exit 2 before any gh call: no --target, no --pr, a flag it does not read", async () => {
    for (const argv of [["pr", "converge", "--pr", "5"], ["pr", "converge", "--target", "o/n"], ["pr", "converge", "--target", "o/n", "--pr", "5", "--base", "main"]]) {
      const result = await run(prCommand, argv);
      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
    }
  });
});

describe("nen issue criteria", () => {
  it("lists an issue's AC rows from --ref and --target, and --json carries the contract", async () => {
    const result = await run(issueCommand, ["issue", "criteria", "--ref", "NN#12", "--target", "o/n"], [issueRead(12, ISSUE_BODY)]);
    expect(result.code).toBe(0);
    expect(result.out.split("\n")).toEqual(["2 AC row(s), 0 duplicate number(s) -- o/n#12", "AC-1 line 3: lists rows", "AC-2 line 4: exits 2 unread"]);
    const json = await run(issueCommand, ["issue", "criteria", "--ref", "NN#12", "--target", "o/n"], [issueRead(12, ISSUE_BODY)], { json: true });
    const report = JSON.parse(json.out) as { contract: string; verifiable: boolean; source: { kind: string; number: number } };
    expect(report.contract).toBe("nen.issue.criteria/v0.1");
    expect(report.verifiable).toBe(true);
    expect(report.source).toEqual({ kind: "issue", ref: "NN#12", target: "o/n", number: 12 });
  });

  it("reads a --body-file, and says a body with no AC row is not verifiable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-criteria-"));
    writeFileSync(join(dir, "body.md"), "No criteria.\n");
    const result = await run(issueCommand, ["issue", "criteria", "--body-file", "body.md"], [], { repoFlag: dir });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^0 AC row\(s\): not verifiable -- '/);
  });

  it("exits 1 when the issue could not be read, and 2 on usage", async () => {
    const failed = await run(issueCommand, ["issue", "criteria", "--ref", "12", "--target", "o/n"], [{ match: "gh api repos/o/n/issues/12", result: { code: 1, stderr: "HTTP 404" } }]);
    expect(failed.code).toBe(1);
    expect(failed.out).toBe("");
    expect((await run(issueCommand, ["issue", "criteria", "--ref", "12"])).code).toBe(2);
    expect((await run(issueCommand, ["issue", "criteria"])).code).toBe(2);
  });
});
