// src/changelog/reconcile.integration.test.ts -- the release-PR allowance
// (zheref/nen#229) against the REAL git, in temporary repositories built in
// the shapes this repository's own history actually took.
//
// WHY THIS EXISTS BESIDE ./reconcile.test.ts. That suite proves the decision
// for every verdict against a scripted git. It cannot prove the argv MEANS
// what the decision assumes: that `git log -1 <end>^{commit}` peels an
// annotated tag to the merge it points at, that `<first>..<second>` walks
// exactly the PR's own branch, that `ls-tree` answers an empty exit-0 for a
// file a commit does not carry. Those are claims about git, and only git can
// answer them -- so the issue's three fixtures are built here as real merge
// graphs and driven through the real verb:
//
//   * the v0.12.0 shape: #221 delivered and cited, #222 the release PR and
//     the range's terminal merge -> reconciled, exit 0, #222 named;
//   * the #225 shape: the release bump (#222) merged into a feature branch
//     and CARRIED to main by #225 -> #225 still fails, naming #222 as the
//     merge that introduced the section;
//   * the negative: an uncited PR that is NOT the terminal merge still exits
//     1 and is named, while the terminal release PR is still reconciled.
//
// Plus the #226 shape (a reconcile PR ending the range after the section is
// already on main), the #242/#246 pair (a delivery PR opens the section as
// `— unreleased`, the release PR dates it -- only the latter introduced the
// DATED section), a release bump carried by a LOCAL `git merge` rather than a
// PR, the `--range` option-injection refusal, and the preflight table fed
// from the same reconciliation, which must reach the same verdict.
//
// IT SKIPS RATHER THAN FAILS where `git` is missing or older than 2.28 (for
// `init -b`), ../wc/squash.integration.test.ts's own rule -- a machine without
// a usable git is not a machine this rule was broken on.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { runPreflight } from "../release/preflight.js";
import { changelogCommand } from "./command.js";
import { describeReleasePrAllowance, type CompletenessReport } from "./completeness.js";
import { reconcileChangelog } from "./reconcile.js";

function usableGit(): boolean {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) return false;
  const version = /(\d+)\.(\d+)/.exec(probe.stdout ?? "");
  if (version === null) return false;
  const major = Number(version[1]);
  const minor = Number(version[2]);
  return major > 2 || (major === 2 && minor >= 28);
}

const HAVE_GIT = usableGit();

function mustGit(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} exited ${result.status}: ${result.stderr}`);
  return (result.stdout ?? "").trim();
}

/** A repository with a REPO-LOCAL identity, so neither the setup nor the verb depends on the host's git config. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "nen-reconcile-git-"));
  mustGit(root, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [
    ["user.name", "nen test"],
    ["user.email", "nen@example.invalid"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    ["core.autocrlf", "false"],
  ] as const) {
    mustGit(root, ["config", key, value]);
  }
  return root;
}

function commit(root: string, file: string, text: string, message: string): void {
  writeFileSync(join(root, file), text);
  mustGit(root, ["add", file]);
  mustGit(root, ["commit", "-q", "-m", message]);
}

/** GitHub's own merge-commit shape: a no-ff merge whose subject is `Merge pull request #N from <owner>/<branch>`. */
function mergePr(root: string, into: string, from: string, pr: number): void {
  mustGit(root, ["checkout", "-q", into]);
  mustGit(root, ["merge", "-q", "--no-ff", "-m", `Merge pull request #${pr} from o/${from}`, from]);
}

const LINK = (n: number): string => `[#${n}](https://github.com/o/r/pull/${n})`;
const V11 = `## v0.11.0 — 2026-09-19\n\nRelease unit: ${LINK(200)}.\n`;
const V12 = (...prs: number[]): string => `## v0.12.0 — 2026-09-20\n\nRelease unit for \`v0.11.0..main\` (${prs.map(LINK).join(", ")}).\n`;
const changelog = (...sections: string[]): string => `# Changelog\n\n${sections.join("\n")}`;
/** The v0.13.1-v0.14.2 shape: a delivery PR opens the next version UNDATED, the release PR dates it. */
const V12_UNRELEASED = `## v0.12.0 — unreleased\n\nWork toward v0.12.0.\n`;

/** main at v0.11.0, tagged, with nothing merged since. */
function atV011(): string {
  const root = repository();
  commit(root, "CHANGELOG.md", changelog(V11), "chore(release): v0.11.0");
  mustGit(root, ["tag", "-a", "-m", "v0.11.0", "v0.11.0"]);
  return root;
}

/** A delivery PR: a branch off main with one code commit, merged back as #pr. */
function deliver(root: string, branch: string, pr: number): void {
  mustGit(root, ["checkout", "-q", "-b", branch, "main"]);
  commit(root, `${branch}.txt`, `${branch}\n`, `feat: ${branch}`);
  mergePr(root, "main", branch, pr);
}

/** The release PR: a branch off main that INTRODUCES the v0.12.0 section citing `cites`, merged back as #pr. */
function propose(root: string, pr: number, cites: number[]): void {
  mustGit(root, ["checkout", "-q", "-b", `release-${pr}`, "main"]);
  commit(root, "CHANGELOG.md", changelog(V12(...cites), V11), "chore(release): v0.12.0");
  mergePr(root, "main", `release-${pr}`, pr);
}

async function completeness(root: string, range: string, json = false): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const argv = ["changelog", "completeness", "--range", range, "--changelog", "CHANGELOG.md", "--owner-repo", "o/r", ...(json ? ["--json"] : [])];
  const code = await runFamily(changelogCommand, argv, root, json, io, defaultSeams());
  return { code, out, err };
}

/** The preflight table's CON-33(c) row, fed from the SAME reconciliation the verb above runs. */
function preflightRow(root: string, range: string): { ok: boolean; detail: string; report: CompletenessReport } {
  const report = reconcileChangelog(defaultSeams(), root, {
    range,
    changelogPath: "CHANGELOG.md",
    changelogText: mustGit(root, ["show", "HEAD:CHANGELOG.md"]),
    ownerRepo: "o/r",
    fragmentNames: [],
  });
  const table = runPreflight({
    hold: { kind: "unset" },
    holdVarName: "RELEASE_HOLD",
    openCriticalIssueNumbers: [],
    liveChores: [],
    fragmentFilesAtCutPoint: [],
    missingChangelogPrs: report.missing,
    releasePrAllowance: report.releasePrAllowance,
    tagAlreadyExists: false,
    tag: "v0.12.0",
  });
  const row = table.checks.find((check): boolean => check.name === "CON-33(c) reconciled");
  if (row === undefined) throw new Error("the preflight table has no CON-33(c) row");
  return { ok: row.ok, detail: row.detail, report };
}

describe.skipIf(!HAVE_GIT)("the release-PR allowance against a real merge graph (zheref/nen#229)", () => {
  it("the v0.12.0 shape: #221 cited, #222 the terminal release PR -> reconciled, exit 0, #222 named", async () => {
    const root = atV011();
    deliver(root, "reports", 221);
    propose(root, 222, [221]);
    // An ANNOTATED tag at the release PR's merge: the range's end must be
    // peeled to the merge commit, not read as the tag object.
    mustGit(root, ["tag", "-a", "-m", "v0.12.0", "v0.12.0"]);

    const result = await completeness(root, "v0.11.0..v0.12.0");
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("every PR merged in v0.11.0..v0.12.0 has a CHANGELOG entry or fragment, but one, excused by the release-PR allowance:");
    expect(result.out[1]).toMatch(/^ {2}#222 reconciled by the CON-33\(c\) release-PR allowance: the range ends at its merge [0-9a-f]{7}, which introduced the dated section v0\.12\.0/);

    const json = await completeness(root, "v0.11.0..v0.12.0", true);
    const parsed = JSON.parse(json.out.join("\n")) as CompletenessReport;
    expect(parsed.missing).toEqual([]);
    expect(parsed.releasePrAllowance).toMatchObject({
      applied: true,
      verdict: "applied",
      pr: 222,
      mergeSha: mustGit(root, ["rev-parse", "main"]),
      firstParentSha: mustGit(root, ["rev-parse", "main^1"]),
      section: "v0.12.0",
      carriedBy: null,
    });
  });

  it("reads an empty right-hand side as HEAD, as git does", async () => {
    const root = atV011();
    deliver(root, "reports", 221);
    propose(root, 222, [221]);
    const result = await completeness(root, "v0.11.0..");
    expect(result.code).toBe(0);
    expect(result.out[1]).toMatch(/#222 reconciled by the CON-33\(c\) release-PR allowance/);
  });

  it("the #225 shape: the release bump CARRIED to main by a later PR -> #225 still fails, naming #222's merge", async () => {
    const root = atV011();
    // #221: the feature branch's first delivery, merged and cited.
    mustGit(root, ["checkout", "-q", "-b", "reports", "main"]);
    commit(root, "reports.txt", "round 1\n", "feat: reports");
    mergePr(root, "main", "reports", 221);
    // #222: the release bump, stacked on the FEATURE branch and merged INTO it.
    mustGit(root, ["checkout", "-q", "-b", "release-v0.12.0", "reports"]);
    commit(root, "CHANGELOG.md", changelog(V12(221, 222), V11), "chore(release): v0.12.0");
    mergePr(root, "reports", "release-v0.12.0", 222);
    // #225: more work on the feature branch, which carries the bump to main.
    mustGit(root, ["checkout", "-q", "reports"]);
    commit(root, "reports.txt", "round 3\n", "fix: round 3");
    mergePr(root, "main", "reports", 225);

    const result = await completeness(root, "v0.11.0..main");
    expect(result.code).toBe(1);
    expect(result.out).toContain("  #225");
    expect(result.out).not.toContain("  #222");
    const said = result.out.join("\n");
    expect(said).toMatch(/#225 not reconciled by the release-PR allowance: v0\.12\.0 was introduced on #225's branch by #222's merge [0-9a-f]{7}/);

    const parsed = JSON.parse((await completeness(root, "v0.11.0..main", true)).out.join("\n")) as CompletenessReport;
    expect(parsed.missing).toEqual([225]);
    expect(parsed.releasePrAllowance).toMatchObject({ applied: false, verdict: "section-carried", pr: 225, carriedBy: 222 });
  });

  it("the negative: an uncited NON-terminal PR still exits 1 and is named -- the allowance covers the release PR only", async () => {
    const root = atV011();
    deliver(root, "stray", 220);
    deliver(root, "reports", 221);
    propose(root, 222, [221]);

    const result = await completeness(root, "v0.11.0..main");
    expect(result.code).toBe(1);
    expect(result.out.slice(0, 2)).toEqual(["missing CHANGELOG entry or fragment for:", "  #220"]);
    expect(result.out).not.toContain("  #222");
    // Still visible: #222 was reconciled by the allowance, #220 was not.
    expect(result.out[2]).toMatch(/^#222 reconciled by the CON-33\(c\) release-PR allowance/);
  });

  it("the #226 shape: a reconcile PR ending the range after the section is on main is NOT the release PR", async () => {
    const root = atV011();
    deliver(root, "reports", 221);
    propose(root, 222, [221]);
    mustGit(root, ["checkout", "-q", "-b", "reconcile", "main"]);
    commit(root, "CHANGELOG.md", changelog(V12(221, 222), V11), "docs: reconcile the v0.12.0 release unit");
    mergePr(root, "main", "reconcile", 226);

    const result = await completeness(root, "v0.11.0..main");
    expect(result.code).toBe(1);
    expect(result.out).toContain("  #226");
    expect(result.out.join("\n")).toMatch(/#226 not reconciled by the release-PR allowance: v0\.12\.0 was already on the trunk, dated, at the merge's first parent/);
  });

  it("preflight's CON-33(c) row reaches the SAME verdict as completeness, and names the same PR", async () => {
    const applied = atV011();
    deliver(applied, "reports", 221);
    propose(applied, 222, [221]);
    const good = preflightRow(applied, "v0.11.0..main");
    expect(good.ok).toBe((await completeness(applied, "v0.11.0..main")).code === 0);
    expect(good.ok).toBe(true);
    expect(good.detail).toBe(
      `every merged PR has a CHANGELOG entry or fragment, but one, excused by the release-PR allowance -- ${describeReleasePrAllowance(good.report.releasePrAllowance) ?? ""}`,
    );

    const negative = atV011();
    deliver(negative, "stray", 220);
    deliver(negative, "reports", 221);
    propose(negative, 222, [221]);
    const bad = preflightRow(negative, "v0.11.0..main");
    expect(bad.ok).toBe((await completeness(negative, "v0.11.0..main")).code === 0);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/^missing: #220 -- #222 reconciled by the CON-33\(c\) release-PR allowance/);
  });

  it("the #242 shape: a DELIVERY PR that opens the section UNDATED and ends the range is not excused (exit 1)", async () => {
    // 1c3ff7f in this repository: #242 opened `## v0.14.0 — unreleased`
    // inside a delivery. Read as dated, it was excused at its own merge.
    const root = atV011();
    mustGit(root, ["checkout", "-q", "-b", "wc-swap", "main"]);
    commit(root, "wc-swap.txt", "the delivery\n", "feat: wc swap");
    commit(root, "CHANGELOG.md", changelog(V12_UNRELEASED, V11), "docs: open v0.12.0");
    mergePr(root, "main", "wc-swap", 242);

    const result = await completeness(root, "v0.11.0..main");
    expect(result.code).toBe(1);
    expect(result.out.slice(0, 2)).toEqual(["missing CHANGELOG entry or fragment for:", "  #242"]);
    expect(result.out[2]).toMatch(/^#242 not reconciled by the release-PR allowance: --changelog opens with v0\.12\.0 marked unreleased/);
    const parsed = JSON.parse((await completeness(root, "v0.11.0..main", true)).out.join("\n")) as CompletenessReport;
    expect(parsed.releasePrAllowance).toMatchObject({ applied: false, verdict: "no-dated-section", pr: 242 });
  });

  it("the #246 shape: the release PR that DATES the unreleased heading introduced the dated section (exit 0)", async () => {
    const root = atV011();
    mustGit(root, ["checkout", "-q", "-b", "wc-swap", "main"]);
    commit(root, "wc-swap.txt", "the delivery\n", "feat: wc swap");
    commit(root, "CHANGELOG.md", changelog(V12_UNRELEASED, V11), "docs: open v0.12.0");
    mergePr(root, "main", "wc-swap", 242);
    propose(root, 246, [242]);

    const result = await completeness(root, "v0.11.0..main");
    expect(result.code).toBe(0);
    expect(result.out[1]).toMatch(/^ {2}#246 reconciled by the CON-33\(c\) release-PR allowance: .*introduced the dated section v0\.12\.0/);
  });

  it("a release bump carried by a LOCAL merge, not a PR, is still caught -- #225 fails, carriedBy null, the merge named", async () => {
    // This repository merges branches locally (fe35fbb, 297ad64). Condition 5
    // used to look at pull-request merges only, and passed this as `applied`.
    const root = atV011();
    mustGit(root, ["checkout", "-q", "-b", "reports", "main"]);
    commit(root, "reports.txt", "round 1\n", "feat: reports");
    mergePr(root, "main", "reports", 221);
    mustGit(root, ["checkout", "-q", "-b", "release-v0.12.0", "reports"]);
    commit(root, "CHANGELOG.md", changelog(V12(221), V11), "chore(release): v0.12.0");
    mustGit(root, ["checkout", "-q", "reports"]);
    mustGit(root, ["merge", "-q", "--no-ff", "-m", "Merge branch 'release-v0.12.0' into reports", "release-v0.12.0"]);
    const localMerge = mustGit(root, ["rev-parse", "HEAD"]);
    commit(root, "reports.txt", "round 3\n", "fix: round 3");
    mergePr(root, "main", "reports", 225);

    const result = await completeness(root, "v0.11.0..main");
    expect(result.code).toBe(1);
    expect(result.out).toContain("  #225");
    expect(result.out.join("\n")).toContain(`v0.12.0 was introduced on #225's branch by the local merge ${localMerge}`);
    const parsed = JSON.parse((await completeness(root, "v0.11.0..main", true)).out.join("\n")) as CompletenessReport;
    expect(parsed.releasePrAllowance).toMatchObject({ applied: false, verdict: "section-carried", pr: 225, carriedBy: null });
  });

  it("refuses --range=--output=<file>..HEAD at exit 2 -- git writes no file and the gate does not pass", async () => {
    const root = atV011();
    deliver(root, "reports", 221);
    const target = join(root, "pwned");
    // The `--flag=value` spelling is the one the argument parser lets through
    // with a leading '-'; it is exactly how the injection was reproduced.
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const argv = ["changelog", "completeness", `--range=--output=${target}..HEAD`, "--changelog", "CHANGELOG.md", "--owner-repo", "o/r"];
    const code = await runFamily(changelogCommand, argv, root, false, io, defaultSeams());
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/has a revision beginning with '-'/);
    expect(out).toEqual([]);
    expect(existsSync(target)).toBe(false);
  });
});
