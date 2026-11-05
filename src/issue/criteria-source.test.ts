import { describe, expect, it } from "vitest";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { CRITERIA_MARKER, readIssueCriteria } from "./criteria-source.js";
const target = { owner: "o", repo: "n", slug: "o/n" };
const page = (number: number, comments: unknown[]): ScriptedCall => ({ match: `gh api repos/o/n/issues/1/comments?per_page=100&page=${number}`, result: { stdout: JSON.stringify(comments) } });
const marked = { node_id: "C7", body: `${CRITERIA_MARKER}\n## Acceptance criteria\n- AC-2: comment criterion`, html_url: "https://github.com/o/n/issues/1#issuecomment-7" };

const proof = (comment = marked, association = "OWNER", overrides: Record<string, unknown> = {}): ScriptedCall => ({ match: `gh api graphql -f query=query($id:ID!){node(id:$id){... on IssueComment{body url authorAssociation author{login} editor{login}}}} -f id=${comment.node_id}`, result: { stdout: JSON.stringify({ data: { node: { body: comment.body, url: comment.html_url, authorAssociation: association, author: { login: "maintainer" }, editor: null, ...overrides } } }) } });

describe("marked criteria comments (#610)", () => {
  it("reads all pages and names the selected comment and ignored body", () => {
    const seams = new ScriptedSeams([page(1, Array.from({ length: 100 }, () => ({ body: "ordinary discussion" }))), page(2, [marked]), proof()]);
    const report = readIssueCriteria(seams, target, 1, "- AC-1: body", null);
    expect(report.criteria.map((row) => row.id)).toEqual(["AC-2"]);
    expect(report.criteriaSource).toEqual({ kind: "comment", url: marked.html_url, ignored: ["https://github.com/o/n/issues/1"] });
  });
  it("refuses untrusted marker authors", () => {
    expect(() => readIssueCriteria(new ScriptedSeams([page(1, [marked]), proof(marked, "NONE")]), target, 1, "", null)).toThrow(/untrusted marked/);
  });
  it("refuses edited provenance and a changed body or URL", () => {
    for (const change of [{ editor: { login: "someone-else" } }, { body: "changed" }, { url: "https://github.com/o/n/issues/1#issuecomment-other" }]) {
      expect(() => readIssueCriteria(new ScriptedSeams([page(1, [marked]), proof(marked, "OWNER", change)]), target, 1, "", null)).toThrow(/provenance|changed/);
    }
  });
  it("preserves empty and body criteria in the absence of a marker", () => {
    for (const body of ["", "- AC-1: body"]) {
      const report = readIssueCriteria(new ScriptedSeams([page(1, [{ body: `discussion ${CRITERIA_MARKER}` }])]), target, 1, body, null);
      expect(report.verifiable).toBe(body !== "");
      expect(report.criteriaSource.kind).toBe("body");
    }
  });
  it("refuses ambiguity and failed or malformed pages", () => {
    expect(() => readIssueCriteria(new ScriptedSeams([page(1, [marked, { ...marked, html_url: "second" }]), proof(), proof({ ...marked, html_url: "second" })]), target, 1, "", null)).toThrow(/multiple active.*issuecomment-7.*second/);
    expect(() => readIssueCriteria(new ScriptedSeams([{ match: "gh api repos/o/n/issues/1/comments?per_page=100&page=1", result: { code: 1, stderr: "offline" } }]), target, 1, "", null)).toThrow(/offline/);
    expect(() => readIssueCriteria(new ScriptedSeams([{ match: "gh api repos/o/n/issues/1/comments?per_page=100&page=1", result: { stdout: "{}" } }]), target, 1, "", null)).toThrow(/expected an array/);
  });
});
