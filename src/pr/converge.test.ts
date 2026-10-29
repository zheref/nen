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

const VIEW = "gh pr view 5 --repo o/n --json number,url,headRefOid,baseRefName,body,closingIssuesReferences";
const REPO_VIEW = "gh repo view o/n --json defaultBranchRef";

function view(body: string, closing: readonly unknown[], base = "main"): ScriptedCall {
  return { match: VIEW, result: { stdout: JSON.stringify({ number: 5, url: "https://github.com/o/n/pull/5", headRefOid: "abc1234", baseRefName: base, body, closingIssuesReferences: closing }) } };
}

const DEFAULT_MAIN: ScriptedCall = { match: REPO_VIEW, result: { stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }) } };

function ref(number: number, slug = "o/n"): unknown {
  const [owner, name] = slug.split("/");
  return { number, url: `https://github.com/${slug}/issues/${number}`, repository: { name, owner: { login: owner } } };
}

function issueRead(number: number, body: string | null, slug = "o/n"): ScriptedCall {
  return { match: `gh api repos/${slug}/issues/${number}`, result: { stdout: JSON.stringify({ number, title: "t", state: "open", labels: [], ...(body === null ? {} : { body }) }) } };
}

const ISSUE_BODY = "## Acceptance criteria\n\n- AC-1: lists rows\n- AC-2: exits 2 unread\n";
const PR_BODY = "## Verify\n\n| Criterion | Coverage | Evidence |\n|---|---|---|\n| NN#12/AC-1 | satisfied | criteria.test.ts |\n| NN#12/AC-2 | partial | converge.test.ts |\n";

describe("nen pr converge", () => {
  it("exits 0 when every criterion has a row with evidence and none says missing or contradicts", async () => {
    const result = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view(PR_BODY, [ref(12)]), issueRead(12, ISSUE_BODY)]);
    expect(result.code).toBe(0);
    expect(result.out.split("\n")).toEqual([
      "2 criterion row(s) across 1 closing issue(s), 0 blocking -- 2 covered with evidence, 0 without, 0 missing-row, 0 malformed-row, 0 duplicate-rows, 0 not-verifiable",
      "COVERED-WITH-EVIDENCE  o/n#12/AC-1 satisfied (line 5)",
      "COVERED-WITH-EVIDENCE  o/n#12/AC-2 partial (line 6)",
    ]);
    expect(result.calls).toEqual([VIEW, "gh api repos/o/n/issues/12"]);
  });

  it("exits 1 on a criterion without evidence, unless the catalogue's coverage block makes evidence optional", async () => {
    const body = PR_BODY.replace("converge.test.ts", " ");
    const strict = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5", "--json"], [view(body, [ref(12)]), issueRead(12, ISSUE_BODY)], { json: true });
    expect(strict.code).toBe(1);
    expect((JSON.parse(strict.out) as { blocking: string[] }).blocking).toEqual(["o/n#12/AC-2: no evidence"]);
    const dir = mkdtempSync(join(tmpdir(), "nen-converge-"));
    writeFileSync(join(dir, "cat.json"), JSON.stringify({ sections: [{ id: "ac", title: "Acceptance criteria", rows: { prefix: "AC" } }], kinds: { a: ["ac"] }, coverage: { evidence: "optional" } }));
    const lenient = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5", "--catalogue", "cat.json"], [view(body, [ref(12)]), issueRead(12, ISSUE_BODY)], { repoFlag: dir });
    expect(lenient.code).toBe(0);
    // --requirements-from stays a deprecated alias on this verb, said on stderr (Nobunaga 2 on #526).
    const alias = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5", "--requirements-from", "cat.json"], [view(body, [ref(12)]), issueRead(12, ISSUE_BODY)], { repoFlag: dir });
    expect(alias.code).toBe(0);
    expect(alias.err).toMatch(/deprecated alias of --catalogue/);
    const both = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5", "--catalogue", "cat.json", "--requirements-from", "cat.json"], [], { repoFlag: dir });
    expect(both.code).toBe(2);
  });

  it("--composite: a read that did not finish is exit 3, stdout empty -- never 1, never ready (Nobunaga 4 on #526)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-converge-"));
    writeFileSync(join(dir, "req.json"), JSON.stringify([{ name: "verify", pattern: "^## Verify$" }]));
    const result = await run(
      prCommand,
      ["pr", "converge", "--target", "o/n", "--pr", "5", "--composite", "--require-head", "a".repeat(40), "--body-requirements", "req.json"],
      [{ match: VIEW, result: { code: 1, stderr: "HTTP 502" } }],
      { repoFlag: dir },
    );
    expect(result.code).toBe(3);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/could not read/);
  });

  it("--composite: a first read at another head is exit 3 at the CLI (a moved head is held at the function layer, convergecomposite.test.ts AC-6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-converge-"));
    writeFileSync(join(dir, "req.json"), JSON.stringify([{ name: "verify", pattern: "^## Verify$" }]));
    const pin = "a".repeat(40);
    const argv = ["pr", "converge", "--target", "o/n", "--pr", "5", "--composite", "--require-head", pin, "--body-requirements", "req.json"];
    const other = await run(prCommand, argv, [view(PR_BODY, [ref(12)]), issueRead(12, ISSUE_BODY)], { repoFlag: dir });
    expect(other.code).toBe(3);
    expect(other.out).toBe("");
    expect(other.err).toMatch(/not the pinned/);
  });

  it("exits 1 on an unmatched row, a malformed row, unrequested on a criterion, and a none row with a problem", async () => {
    const cases = [
      "| AC-1 | satisfied | a |\n| AC-2 | satisfied | b |\n| AC-9 | satisfied | c |\n",
      "| AC-1 | satisfied | a |\n| AC-2 | satisfied | b |\n| <CODE>#<N>/AC-<k> | satisfied | c |\n",
      "| AC-1 | unrequested | a |\n| AC-2 | satisfied | b |\n",
      "| AC-1 | satisfied | a |\n| AC-2 | satisfied | b |\n| none | satisfied | c |\n",
      "| AC-1 | satisfied | a |\n| AC-2 | satisfied | b |\n| none | unrequested | <placeholder> |\n",
    ];
    for (const body of cases) {
      const result = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view(body, [ref(12)]), issueRead(12, ISSUE_BODY)]);
      expect(result.code, body).toBe(1);
    }
    const clean = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view("| AC-1 | satisfied | a |\n| AC-2 | satisfied | b |\n| none | unrequested | refactor.test.ts |\n", [ref(12)]), issueRead(12, ISSUE_BODY)]);
    expect(clean.code).toBe(0);
  });

  it("exits 1 on a closing issue whose AC row is in no admitted shape, and reads a checkbox row as a criterion", async () => {
    const issue = "## Acceptance criteria\n\n- [ ] AC-1: lists rows\n- AC-2 exits 2 unread\n";
    const result = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view("| AC-1 | satisfied | a |\n", [ref(12)]), issueRead(12, issue)]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/UNRECOGNISED o\/n#12 line 4: - AC-2 exits 2 unread/);
  });

  it("on a base that is not the default branch, reads the body's closing keywords instead of the empty GitHub list", async () => {
    const body = `Closes #12\n\n${PR_BODY}`;
    const result = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view(body, [], "integration/x"), DEFAULT_MAIN, issueRead(12, ISSUE_BODY)], { json: true });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out) as { closingSource: string; base: string; closingIssues: { issue: string }[] };
    expect(report.closingSource).toBe("body-keywords");
    expect(report.base).toBe("integration/x");
    expect(report.closingIssues.map((issue) => issue.issue)).toEqual(["o/n#12"]);
    const none = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view("no keyword", [], "integration/x"), DEFAULT_MAIN]);
    expect(none.code).toBe(0); // reported as none-on-non-default-base, never a blocking row (2026-10-23)
    expect(none.out).toMatch(/not the default branch/);
  });

  it("exits 1 on a missing row or a contradicts word, and --json carries the contract and the blocking list", async () => {
    const body = "| AC-1 | contradicts | x |\n";
    const result = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view(body, [ref(12)]), issueRead(12, ISSUE_BODY)], { json: true });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out) as { contract: string; pr: number; headSha: string; closingIssues: unknown[]; blocking: string[]; verifiable: boolean };
    expect(report.contract).toBe("nen.pr.converge/v0.1");
    expect(report.pr).toBe(5);
    expect(report.headSha).toBe("abc1234");
    expect(report.closingIssues).toEqual([{ issue: "o/n#12", criteria: 2, verifiable: true, unrecognised: [] }]);
    expect(report.blocking).toEqual(["o/n#12/AC-1: contradicts -- row line 1: | AC-1 | contradicts | x |", "o/n#12/AC-2: missing-row (no verify row names AC-2)"]);
    expect(report.verifiable).toBe(true);
  });

  it("reads a closing issue in its own repository, and reports an issue with no AC row as not-verifiable at exit 1", async () => {
    const result = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view("", [ref(3, "o/elsewhere")]), issueRead(3, "No criteria.", "o/elsewhere")], { json: true });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out) as { verifiable: boolean; criteria: { coverage: string; issue: string }[] };
    expect(report.verifiable).toBe(false);
    expect(report.criteria).toEqual([expect.objectContaining({ issue: "o/elsewhere#3", coverage: "not-verifiable" })]);
  });

  it("says a PR into the default branch closing no issue is not verifiable at exit 0, and its rows naming criteria are unmatched at exit 1", async () => {
    const plain = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view("No rows.", []), DEFAULT_MAIN]);
    expect(plain.code).toBe(0);
    expect(plain.out).toBe("o/n#5 closes no issue: no criterion to compare (not verifiable)");
    const result = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view(PR_BODY, []), DEFAULT_MAIN]);
    expect(result.code).toBe(1);
    expect(result.out.split("\n")).toEqual([
      "o/n#5 closes no issue: no criterion to compare (not verifiable)",
      "UNMATCHED line 5 'NN#12/AC-1': no closing issue states this criterion",
      "UNMATCHED line 6 'NN#12/AC-2': no closing issue states this criterion",
    ]);
  });

  it("exits 1 when it could not read: the PR, a closing issue, an issue with no body, a full page of references", async () => {
    const prFailed = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [{ match: VIEW, result: { code: 1, stderr: "HTTP 502" } }]);
    expect(prFailed.code).toBe(1);
    expect(prFailed.err).toMatch(/could not read o\/n#5: HTTP 502/);
    expect(prFailed.out).toBe("");
    const noField = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [{ match: VIEW, result: { stdout: JSON.stringify({ body: "" }) } }]);
    expect(noField.code).toBe(1);
    expect(noField.err).toMatch(/closingIssuesReferences/);
    const issueFailed = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view(PR_BODY, [ref(12)]), { match: "gh api repos/o/n/issues/12", result: { code: 1, stderr: "HTTP 404" } }]);
    expect(issueFailed.code).toBe(1);
    const noBody = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view(PR_BODY, [ref(12)]), issueRead(12, null)]);
    expect(noBody.code).toBe(1);
    expect(noBody.err).toMatch(/no 'body' field/);
    const traversal = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view(PR_BODY, [{ number: 1, repository: { name: "..", owner: { login: "o" } } }])]);
    expect(traversal.code).toBe(1);
    expect(traversal.calls).toEqual([VIEW]);
    const full = await run(prCommand, ["pr", "converge", "--target", "o/n", "--pr", "5"], [view(PR_BODY, Array.from({ length: CLOSING_PAGE }, (_, index) => ref(index + 1)))]);
    expect(full.code).toBe(1);
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

describe("nen pr converge --require-head (zheref/nen#483 AC-6)", () => {
  const HEAD = "a".repeat(40);
  const MOVED = "b".repeat(40);
  const HEAD_VIEW = "gh pr view 5 --repo o/n --json headRefOid";
  const pinnedView = (head: string): ScriptedCall => ({
    match: VIEW,
    result: { stdout: JSON.stringify({ number: 5, url: "https://github.com/o/n/pull/5", headRefOid: head, baseRefName: "main", body: PR_BODY, closingIssuesReferences: [ref(12)] }) },
  });
  const reRead = (head: string): ScriptedCall => ({ match: HEAD_VIEW, result: { stdout: JSON.stringify({ headRefOid: head }) } });
  const argv = (pin: string): string[] => ["pr", "converge", "--target", "o/n", "--pr", "5", "--require-head", pin];

  it("reports the verdict when both reads see the pinned head, re-reading it after the closing issues", async () => {
    const result = await run(prCommand, argv(HEAD), [pinnedView(HEAD), issueRead(12, ISSUE_BODY), reRead(HEAD)]);
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([VIEW, "gh api repos/o/n/issues/12", HEAD_VIEW]);
  });

  it("refuses a first read at another head, a head that moved between reads, and an unreadable re-read -- stdout empty", async () => {
    const other = await run(prCommand, argv(HEAD), [pinnedView(MOVED), issueRead(12, ISSUE_BODY)]);
    expect(other.code).toBe(1);
    expect(other.out).toBe("");
    expect(other.err).toMatch(/head is b{40}, not the pinned a{40}/);
    const moved = await run(prCommand, argv(HEAD), [pinnedView(HEAD), issueRead(12, ISSUE_BODY), reRead(MOVED)]);
    expect(moved.code).toBe(1);
    expect(moved.out).toBe("");
    expect(moved.err).toMatch(/head moved from a{40} to b{40} between the reads/);
    const failed = await run(prCommand, argv(HEAD), [pinnedView(HEAD), issueRead(12, ISSUE_BODY), { match: HEAD_VIEW, result: { code: 1, stderr: "HTTP 502" } }]);
    expect(failed.code).toBe(1);
    expect(failed.err).toMatch(/could not re-read .* HTTP 502/);
  });

  it("refuses a pin that is not a full SHA at exit 2 before any read", async () => {
    const result = await run(prCommand, argv("abc1234"), []);
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
  });
});

describe("nen issue criteria", () => {
  it("lists an issue's AC rows from --ref and --target, and --json carries the contract", async () => {
    const result = await run(issueCommand, ["issue", "criteria", "--ref", "NN#12", "--target", "o/n"], [issueRead(12, ISSUE_BODY)]);
    expect(result.code).toBe(0);
    expect(result.out.split("\n")).toEqual(["2 AC row(s), 0 duplicate id(s) -- o/n#12", "AC-1 line 3: lists rows", "AC-2 line 4: exits 2 unread"]);
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
