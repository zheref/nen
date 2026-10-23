// The CLI half of the issue-shape reads (./shape.ts) and the file-fed title
// (./title.ts, zheref/nen#444): `nen issue body-check`, `nen issue questions`,
// `--title-file` on `nen issue file` and `nen idea file`, and `nen idea file
// --dry-run`.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Command } from "../cli/command.js";
import { issueCommand } from "./command.js";
import { ideaCommand } from "../idea/command.js";

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

function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-issue-shape-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const CATALOGUE = JSON.stringify({
  contract: "example.issue-sections/v1",
  sections: [
    { id: "problem", title: "Problem", level: 2 },
    { id: "ac", title: "Acceptance criteria", level: 2, rows: { prefix: "AC", contiguous: true } },
  ],
  kinds: { feature: ["problem", "ac"], bug: ["problem"] },
  vagueAdjectives: ["fast"],
});

const BODY = "## Problem\n\nIt is fast.\n\n## Acceptance criteria\n\n- AC-1: one\n- AC-2: two\n";
const QUESTIONS = "- OQ-1 (G4): which?\n- ~~OQ-2~~ → A: this (2026-10-21, HR-4)\n[NEEDS CLARIFICATION: x]\n";

describe("nen issue body-check", () => {
  it("exits 0 on a body with every section, printing the verdict and the advisory", async () => {
    const dir = scratch({ "cat.json": CATALOGUE, "body.md": BODY });
    const result = await run(issueCommand, ["issue", "body-check", "--body-file", "body.md", "--requirements-from", "cat.json", "--kind", "feature"], [], { repoFlag: dir });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^2\/2 section\(s\) present for kind 'feature', 0 miss\(es\)/);
    expect(result.out).toMatch(/ADVISORY line 3: vague 'fast'/);
    expect(result.calls).toEqual([]);
  });

  it("exits 1 listing every miss, and --json carries the contract and the misses", async () => {
    const dir = scratch({ "cat.json": CATALOGUE, "body.md": "## Acceptance criteria\n- AC-2: two\n" });
    const result = await run(issueCommand, ["issue", "body-check", "--body-file", "body.md", "--requirements-from", "cat.json", "--kind", "feature"], [], { repoFlag: dir, json: true });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out) as { contract: string; ok: boolean; misses: { section: string; kind: string }[]; catalogue: { contract: string } };
    expect(report.contract).toBe("nen.issue.body-check/v0.1");
    expect(report.catalogue.contract).toBe("example.issue-sections/v1");
    expect(report.ok).toBe(false);
    expect(report.misses.map((miss) => `${miss.section}:${miss.kind}`)).toEqual(["problem:missing", "ac:row-order"]);
  });

  it("refuses (exit 2) several kinds with no --kind, a missing catalogue flag, and both or neither body source", async () => {
    const dir = scratch({ "cat.json": CATALOGUE, "body.md": BODY });
    const noKind = await run(issueCommand, ["issue", "body-check", "--body-file", "body.md", "--requirements-from", "cat.json"], [], { repoFlag: dir });
    expect(noKind.code).toBe(2);
    expect(noKind.err).toMatch(/Nen will not pick one/);
    expect((await run(issueCommand, ["issue", "body-check", "--body-file", "body.md"], [], { repoFlag: dir })).code).toBe(2);
    expect((await run(issueCommand, ["issue", "body-check", "--requirements-from", "cat.json", "--kind", "bug"], [], { repoFlag: dir })).code).toBe(2);
    const both = await run(issueCommand, ["issue", "body-check", "--body-file", "body.md", "--ref", "NN#1", "--target", "o/n", "--requirements-from", "cat.json", "--kind", "bug"], [], { repoFlag: dir });
    expect(both.code).toBe(2);
    expect(both.calls).toEqual([]);
  });

  it("refuses a malformed catalogue at exit 2, naming the file", async () => {
    const dir = scratch({ "cat.json": JSON.stringify({ sections: [], kinds: {} }), "body.md": BODY });
    const result = await run(issueCommand, ["issue", "body-check", "--body-file", "body.md", "--requirements-from", "cat.json"], [], { repoFlag: dir });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/cat\.json': 'sections' is not a non-empty array/);
  });

  it("reads the body of --ref from --target, and refuses a pull request (exit 2)", async () => {
    const dir = scratch({ "cat.json": CATALOGUE });
    const issue: ScriptedCall = { match: "gh api repos/o/n/issues/7", result: { stdout: JSON.stringify({ number: 7, title: "t", state: "open", labels: [], body: BODY }) } };
    const ok = await run(issueCommand, ["issue", "body-check", "--ref", "NN#7", "--target", "o/n", "--requirements-from", "cat.json", "--kind", "bug"], [issue], { repoFlag: dir });
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/o\/n#7/);
    const pr: ScriptedCall = { match: "gh api repos/o/n/issues/8", result: { stdout: JSON.stringify({ number: 8, pull_request: {}, body: BODY }) } };
    const refused = await run(issueCommand, ["issue", "body-check", "--ref", "#8", "--target", "o/n", "--requirements-from", "cat.json", "--kind", "bug"], [pr], { repoFlag: dir });
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/pull request/);
  });

  it("exits 1 when the issue could not be read or carried no body -- never an empty body", async () => {
    const dir = scratch({ "cat.json": CATALOGUE });
    const failed: ScriptedCall = { match: "gh api repos/o/n/issues/7", result: { code: 1, stderr: "HTTP 404" } };
    expect((await run(issueCommand, ["issue", "body-check", "--ref", "7", "--target", "o/n", "--requirements-from", "cat.json", "--kind", "bug"], [failed], { repoFlag: dir })).code).toBe(1);
    const bodiless: ScriptedCall = { match: "gh api repos/o/n/issues/7", result: { stdout: JSON.stringify({ number: 7 }) } };
    const result = await run(issueCommand, ["issue", "body-check", "--ref", "7", "--target", "o/n", "--requirements-from", "cat.json", "--kind", "bug"], [bodiless], { repoFlag: dir });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/never an empty one/);
  });

  it("refuses an owner/name ref that disagrees with --target, and a malformed ref, before any read", async () => {
    const dir = scratch({ "cat.json": CATALOGUE });
    const other = await run(issueCommand, ["issue", "body-check", "--ref", "a/b#7", "--target", "o/n", "--requirements-from", "cat.json", "--kind", "bug"], [], { repoFlag: dir });
    expect(other.code).toBe(2);
    expect(other.err).toMatch(/nen will not pick one/);
    expect((await run(issueCommand, ["issue", "body-check", "--ref", "HA12", "--target", "o/n", "--requirements-from", "cat.json", "--kind", "bug"], [], { repoFlag: dir })).code).toBe(2);
  });

  it("refuses --dry-run, a flag it does not declare (it writes nothing)", async () => {
    const dir = scratch({ "cat.json": CATALOGUE, "body.md": BODY });
    expect((await run(issueCommand, ["issue", "body-check", "--body-file", "body.md", "--requirements-from", "cat.json", "--dry-run"], [], { repoFlag: dir })).code).toBe(2);
  });
});

describe("nen issue questions", () => {
  it("counts and exits 1 on an open row, with the counts in --json (zheref/nen#477 AC-1)", async () => {
    const dir = scratch({ "q.md": QUESTIONS });
    const result = await run(issueCommand, ["issue", "questions", "--body-file", "q.md"], [], { repoFlag: dir, json: true });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out) as { contract: string; counts: unknown };
    expect(report.contract).toBe("nen.issue.questions/v0.1");
    expect(report.counts).toEqual({ open: 1, resolved: 1, needsMarkers: 1, unrecognised: 0 });
  });

  it("prints one verdict line then a row per finding", async () => {
    const dir = scratch({ "q.md": QUESTIONS });
    const result = await run(issueCommand, ["issue", "questions", "--body-file", "q.md"], [], { repoFlag: dir });
    expect(result.out.split("\n")[0]).toMatch(/^1 open, 1 resolved, 1 \[NEEDS\] marker\(s\), 0 unrecognised/);
    expect(result.out).toMatch(/OPEN {6}OQ-1 \(G4\) line 1/);
  });

  it("exits 1 when --ref could not be read, never zero counts", async () => {
    const failed: ScriptedCall = { match: "gh api repos/o/n/issues/3", result: { code: 1, stderr: "HTTP 502" } };
    const result = await run(issueCommand, ["issue", "questions", "--ref", "NN#3", "--target", "o/n"], [failed]);
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
  });

  it("refuses a --ref that names a pull request (exit 2)", async () => {
    const pr: ScriptedCall = { match: "gh api repos/o/n/issues/4", result: { stdout: JSON.stringify({ number: 4, pull_request: {}, body: QUESTIONS }) } };
    const result = await run(issueCommand, ["issue", "questions", "--ref", "4", "--target", "o/n"], [pr]);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
  });

  it("exits 0 when every question is resolved, and 1 on a malformed OQ row or a [NEEDS] marker (AC-2, AC-3)", async () => {
    const dir = scratch({
      "clear.md": "- ~~OQ-1~~ → A: yes (2026-10-21, HR-4)\n- ~~OQ-2~~ → A: no (2026-10-22, HR-5)\n",
      "none.md": "## Open questions\n\nNone.\n",
      "bad.md": "- OQ-1 which?\n",
      "needs.md": "[NEEDS CLARIFICATION: scope]\n",
    });
    const clear = await run(issueCommand, ["issue", "questions", "--body-file", "clear.md"], [], { repoFlag: dir, json: true });
    expect(clear.code).toBe(0);
    expect((JSON.parse(clear.out) as { counts: unknown }).counts).toEqual({ open: 0, resolved: 2, needsMarkers: 0, unrecognised: 0 });
    expect((await run(issueCommand, ["issue", "questions", "--body-file", "none.md"], [], { repoFlag: dir })).code).toBe(0);
    const bad = await run(issueCommand, ["issue", "questions", "--body-file", "bad.md"], [], { repoFlag: dir });
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/UNRECOGNISED line 1: - OQ-1 which\?/);
    expect((await run(issueCommand, ["issue", "questions", "--body-file", "needs.md"], [], { repoFlag: dir })).code).toBe(1);
  });

  it("counts a batch of refs in one report, each on its own, an unread one listed (AC-4, SC-2)", async () => {
    const issue = (n: number, body: string): ScriptedCall => ({ match: `gh api repos/o/n/issues/${n}`, result: { stdout: JSON.stringify({ number: n, body }) } });
    const script: ScriptedCall[] = [issue(1, QUESTIONS), issue(2, "- ~~OQ-1~~ → A: yes (2026-10-21, HR-4)\n"), { match: "gh api repos/o/n/issues/3", result: { code: 1, stderr: "HTTP 502" } }];
    const result = await run(issueCommand, ["issue", "questions", "--ref", "NN#1,NN#2,NN#3", "--target", "o/n"], script, { json: true });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out) as { counts: unknown; issues: { source?: { number: number }; counts?: { open: number }; ref?: string; unread?: string }[] };
    expect(report.counts).toEqual({ issues: 3, blocking: 1, clear: 1, unread: 1 });
    expect(report.issues.map((entry) => entry.source?.number ?? entry.ref)).toEqual([1, 2, "NN#3"]);
    expect(report.issues[0]?.counts?.open).toBe(1);
    expect(report.issues[2]?.unread).toMatch(/502|could not read/i);

    const fifty = Array.from({ length: 50 }, (_, index): number => index + 1);
    const clearScript = fifty.map((n): ScriptedCall => issue(n, "None.\n"));
    const batch = await run(issueCommand, ["issue", "questions", "--ref", fifty.map((n): string => `NN#${n}`).join(","), "--target", "o/n"], clearScript);
    expect(batch.code).toBe(0);
    expect(batch.out.split("\n")[0]).toBe("50 issue(s): 0 with an open question, 50 clear, 0 unread -- o/n");
  });

  it("refuses a batch naming a pull request, a repeat, or --body-file beside it (exit 2)", async () => {
    const pr: ScriptedCall = { match: "gh api repos/o/n/issues/4", result: { stdout: JSON.stringify({ number: 4, pull_request: {}, body: "" }) } };
    const ok: ScriptedCall = { match: "gh api repos/o/n/issues/5", result: { stdout: JSON.stringify({ number: 5, body: "" }) } };
    expect((await run(issueCommand, ["issue", "questions", "--ref", "5,4", "--target", "o/n"], [ok, pr])).code).toBe(2);
    expect((await run(issueCommand, ["issue", "questions", "--ref", "5,5", "--target", "o/n"], [ok])).code).toBe(2);
    const dir = scratch({ "q.md": QUESTIONS });
    expect((await run(issueCommand, ["issue", "questions", "--ref", "5,6", "--body-file", "q.md", "--target", "o/n"], [], { repoFlag: dir })).code).toBe(2);
  });

  it("refuses --target with --body-file (exit 2)", async () => {
    const dir = scratch({ "q.md": QUESTIONS });
    expect((await run(issueCommand, ["issue", "questions", "--body-file", "q.md", "--target", "o/n"], [], { repoFlag: dir })).code).toBe(2);
  });
});

/** The target's visibility read answered "private", so the private-name guard skips. */
const PRIVATE_TARGET: ScriptedCall = { match: "gh api repos/zheref/nen", result: { stdout: JSON.stringify({ visibility: "private" }) } };
const HOSTILE_TITLE = "Ship `rm -rf /` and $(id) as text";

function filing(family: "issue" | "idea", titleFlags: readonly string[], extra: readonly string[] = []): string[] {
  return [family, "file", "--target", "zheref/nen", ...titleFlags, "--body-file", "body.md", "--label", "bankai:severity/high", "--assignee", "me", ...extra];
}


describe("--title-file on nen issue file and nen idea file (zheref/nen#444)", () => {
  for (const family of ["issue", "idea"] as const) {
    const command = family === "issue" ? issueCommand : ideaCommand;

    it(`${family} file: reads the title verbatim with one trailing newline stripped, backticks and $(...) untouched`, async () => {
      const dir = scratch({ "title.txt": `${HOSTILE_TITLE}\n`, "body.md": "the body" });
      const result = await run(command, filing(family, ["--title-file", join(dir, "title.txt")], ["--dry-run"]).map((arg) => (arg === "body.md" ? join(dir, "body.md") : arg)), [PRIVATE_TARGET], { repoFlag: BANKAI_REPO, json: true });
      expect(result.code).toBe(0);
      const report = JSON.parse(result.out) as { dryRun: boolean; argv: string[] };
      expect(report.dryRun).toBe(true);
      expect(report.argv[report.argv.indexOf("--title") + 1]).toBe(HOSTILE_TITLE);
      expect(result.calls.filter((call) => call.startsWith("gh issue create"))).toEqual([]);
    });

    it(`${family} file: refuses --title with --title-file, and a two-line title, at exit 2 before any gh call`, async () => {
      const dir = scratch({ "title.txt": "one\n", "two.txt": "one\ntwo\n", "body.md": "the body" });
      const body = join(dir, "body.md");
      const both = await run(command, filing(family, ["--title", "t", "--title-file", join(dir, "title.txt")]).map((arg) => (arg === "body.md" ? body : arg)), [], { repoFlag: BANKAI_REPO });
      expect(both.code).toBe(2);
      expect(both.err).toMatch(/two spellings of ONE input/);
      expect(both.calls).toEqual([]);
      const two = await run(command, filing(family, ["--title-file", join(dir, "two.txt")]).map((arg) => (arg === "body.md" ? body : arg)), [], { repoFlag: BANKAI_REPO });
      expect(two.code).toBe(2);
      expect(two.err).toMatch(/more than one line/);
    });

    it(`${family} file: an unreadable --title-file exits 2`, async () => {
      const dir = scratch({ "body.md": "the body" });
      const result = await run(command, filing(family, ["--title-file", join(dir, "absent.txt")]).map((arg) => (arg === "body.md" ? join(dir, "body.md") : arg)), [], { repoFlag: BANKAI_REPO });
      expect(result.code).toBe(2);
    });

    it(`${family} file: a --title-file that is not valid UTF-8 is refused at exit 2 naming the file, never filed with U+FFFD in it`, async () => {
      const dir = scratch({ "body.md": "the body" });
      writeFileSync(join(dir, "bad.txt"), Buffer.from([0xff, 0xfe, 0x54, 0x69, 0x74, 0x6c, 0x65]));
      const result = await run(command, filing(family, ["--title-file", join(dir, "bad.txt")], ["--dry-run"]).map((arg) => (arg === "body.md" ? join(dir, "body.md") : arg)), [PRIVATE_TARGET], { repoFlag: BANKAI_REPO });
      expect(result.code).toBe(2);
      expect(result.err).toMatch(/bad\.txt' is not valid UTF-8/);
      expect(result.calls.filter((call) => call.startsWith("gh issue create"))).toEqual([]);
    });

    it(`${family} file: a leading BOM in --title-file is dropped, not sent`, async () => {
      const dir = scratch({ "title.txt": "\uFEFFPlain title\r\n", "body.md": "the body" });
      const result = await run(command, filing(family, ["--title-file", join(dir, "title.txt")], ["--dry-run"]).map((arg) => (arg === "body.md" ? join(dir, "body.md") : arg)), [PRIVATE_TARGET], { repoFlag: BANKAI_REPO, json: true });
      const report = JSON.parse(result.out) as { argv: string[] };
      expect(report.argv[report.argv.indexOf("--title") + 1]).toBe("Plain title");
    });
  }

  it("idea file --dry-run prints the gh argv and the stdin line and creates nothing (it used to be 'unknown option')", async () => {
    const dir = scratch({ "body.md": "the body" });
    const result = await run(ideaCommand, filing("idea", ["--title", "t"], ["--dry-run"]).map((arg) => (arg === "body.md" ? join(dir, "body.md") : arg)), [PRIVATE_TARGET], { repoFlag: BANKAI_REPO });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^would run: gh issue create --repo zheref\/nen --title t --body-file - --assignee me --label bankai:severity\/high/);
    expect(result.out).toMatch(/stdin: the 8 byte\(s\) read and checked from/);
    expect(result.calls).toEqual(["gh api repos/zheref/nen"]);
  });

  it("idea file --help lists --title-file and --dry-run", async () => {
    const result = await run(ideaCommand, ["idea", "file", "--help"]);
    expect(result.out + result.err).toMatch(/--title-file <path>/);
    expect(result.out + result.err).toMatch(/--dry-run/);
  });
});
