// src/changelog/reconcile.test.ts -- the release-PR allowance's decision, one
// verdict at a time, against a SCRIPTED git (zheref/nen#229).
//
// WHY SCRIPTED HERE AND REAL IN ./reconcile.integration.test.ts. The real-git
// suite proves the argv MEANS what this module thinks -- that `ls-tree` tells
// "absent" from "could not look", that `<first>..<second>` walks the PR's own
// branch. This suite proves the DECISION: every way the allowance can decline
// is reached, each one declines rather than grants, and each stops the git
// traffic where it should. ScriptedSeams throws on any call nobody scripted,
// so a test that scripts only the calls up to a verdict also proves the
// module made no read past it.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { ToolError } from "../seam/exec.js";
import { VerbUsageError } from "../cli/command.js";
import { decideReleasePrAllowance, rangeEnd, reconcileChangelog, type ReconcileInput } from "./reconcile.js";

const T = "a".repeat(40); // the terminal merge
const P1 = "b".repeat(40); // its first parent: the trunk before it
const P2 = "c".repeat(40); // its second parent: the PR's head
const M = "d".repeat(40); // another PR's merge on the PR's branch
const MP1 = "e".repeat(40); // that merge's first parent
const BLOB_T = "1".repeat(40);
const BLOB_P1 = "2".repeat(40);
const BLOB_M = "3".repeat(40);
const BLOB_MP1 = "4".repeat(40);

const LINK = (n: number): string => `[#${n}](https://github.com/o/r/pull/${n})`;
const CUT = `# Changelog\n\n## v1.1.0 — 2026-09-20\n\nRelease unit: ${LINK(221)}.\n\n## v1.0.0 — 2026-09-01\n`;
const BEFORE = "# Changelog\n\n## v1.0.0 — 2026-09-01\n";

const MERGES = "git log --merges --format=%s --end-of-options v1.0.0..v1.1.0";
const TERMINAL = "git log -1 --no-show-signature --format=%H%x09%P%x09%s --end-of-options v1.1.0^{commit} --";
const BRANCH = `git log --merges --no-show-signature --format=%H%x09%P%x09%s --end-of-options ${P1}..${P2} --`;
const lsTree = (sha: string): string => `git ls-tree -z ${sha} -- CHANGELOG.md`;
const catBlob = (oid: string): string => `git cat-file blob ${oid}`;
const entry = (oid: string): string => `100644 blob ${oid}\tCHANGELOG.md\0`;

/** A checkout on disk holding `--changelog`, so the path check has something real to resolve. */
function checkout(text: string = CUT): string {
  const root = mkdtempSync(join(tmpdir(), "nen-reconcile-"));
  writeFileSync(join(root, "CHANGELOG.md"), text);
  return root;
}

function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    range: "v1.0.0..v1.1.0",
    changelogPath: "CHANGELOG.md",
    changelogText: CUT,
    ownerRepo: "o/r",
    fragmentNames: [],
    ...overrides,
  };
}

/** The merge log both verbs always read: #221 (cited) and the release PR #222 (not). */
const mergedTwo: ScriptedCall = { match: MERGES, result: { stdout: "Merge pull request #222 from o/release\nMerge pull request #221 from o/feature\n" } };
const terminalIs222: ScriptedCall = { match: TERMINAL, result: { stdout: `${T}\t${P1} ${P2}\tMerge pull request #222 from o/release\n` } };
const sectionAtTerminal: readonly ScriptedCall[] = [
  { match: lsTree(T), result: { stdout: entry(BLOB_T) } },
  { match: catBlob(BLOB_T), result: { stdout: CUT } },
];
const sectionAbsentAtFirstParent: readonly ScriptedCall[] = [
  { match: lsTree(P1), result: { stdout: entry(BLOB_P1) } },
  { match: catBlob(BLOB_P1), result: { stdout: BEFORE } },
];
const noOtherMerges: ScriptedCall = { match: BRANCH, result: { stdout: "" } };

describe("rangeEnd -- the one commit a '<vPrev>..<vNew>' range ends at", () => {
  it("is the right-hand side, and HEAD for an empty one, as git reads 'v1..'", () => {
    expect(rangeEnd("v1.0.0..v1.1.0")).toBe("v1.1.0");
    expect(rangeEnd("v1.0.0..")).toBe("HEAD");
  });

  it("is null for every shape with no single end: a symmetric range, a bare ref, two operators", () => {
    expect(rangeEnd("v1.0.0...v1.1.0")).toBeNull();
    expect(rangeEnd("v1.1.0")).toBeNull();
    expect(rangeEnd("a..b..c")).toBeNull();
  });
});

describe("reconcileChangelog -- the release-PR allowance applied", () => {
  it("reconciles the terminal merge's uncited PR when it introduced the section being cut", () => {
    const root = checkout();
    const seams = new ScriptedSeams([mergedTwo, terminalIs222, ...sectionAtTerminal, ...sectionAbsentAtFirstParent, noOtherMerges]);
    const report = reconcileChangelog(seams, root, input());
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.releasePrAllowance).toMatchObject({
      applied: true,
      verdict: "applied",
      pr: 222,
      mergeSha: T,
      firstParentSha: P1,
      section: "v1.1.0",
      carriedBy: null,
    });
    expect(report.releasePrAllowance?.detail).toMatch(/introduced the dated section v1\.1\.0 -- absent at the first parent bbbbbbb/);
    // Every git read ran in the repository, never the process's directory.
    expect(seams.calls.every((call): boolean => call.cwd === root)).toBe(true);
  });

  it("treats a CHANGELOG that did not exist at the first parent as the section being introduced", () => {
    const root = checkout();
    const seams = new ScriptedSeams([mergedTwo, terminalIs222, ...sectionAtTerminal, { match: lsTree(P1), result: { stdout: "" } }, noOtherMerges]);
    expect(reconcileChangelog(seams, root, input()).releasePrAllowance?.verdict).toBe("applied");
  });

  it("does not block on a merge -- a PR's or a local one -- whose first parent already had the dated section", () => {
    // A PR merged into the release branch, and a local sync merge, both after
    // the section was written: each found it already on its own first parent,
    // so neither introduced it.
    const root = checkout();
    const SYNC = "f".repeat(40);
    const seams = new ScriptedSeams([
      mergedTwo,
      terminalIs222,
      ...sectionAtTerminal,
      ...sectionAbsentAtFirstParent,
      {
        match: BRANCH,
        result: { stdout: `${M}\t${MP1} ${P1}\tMerge pull request #230 from o/fix-on-release\n${SYNC}\t${MP1} ${P1}\tMerge branch 'main' into release\n` },
      },
      { match: lsTree(M), result: { stdout: entry(BLOB_M) } },
      { match: catBlob(BLOB_M), result: { stdout: CUT } },
      { match: lsTree(SYNC), result: { stdout: entry(BLOB_M) } },
      { match: lsTree(MP1), result: { stdout: entry(BLOB_MP1) } },
      { match: catBlob(BLOB_MP1), result: { stdout: CUT } },
    ]);
    expect(reconcileChangelog(seams, root, input()).releasePrAllowance?.verdict).toBe("applied");
  });

  it("accepts an ABSOLUTE --changelog inside the root, even through a symlinked temp directory", () => {
    // macOS's tmpdir is a symlink into /private; both sides are realpath'd, so
    // the file is still found inside its own checkout.
    const root = checkout();
    const seams = new ScriptedSeams([mergedTwo, terminalIs222, ...sectionAtTerminal, ...sectionAbsentAtFirstParent, noOtherMerges]);
    expect(reconcileChangelog(seams, root, input({ changelogPath: join(root, "CHANGELOG.md") })).releasePrAllowance?.verdict).toBe("applied");
  });

  it("reads the history at a --changelog nested below the root, '/'-separated", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-reconcile-"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "CHANGELOG.md"), CUT);
    const seams = new ScriptedSeams([
      mergedTwo,
      terminalIs222,
      { match: `git ls-tree -z ${T} -- docs/CHANGELOG.md`, result: { stdout: `100644 blob ${BLOB_T}\tdocs/CHANGELOG.md\0` } },
      { match: catBlob(BLOB_T), result: { stdout: CUT } },
      { match: `git ls-tree -z ${P1} -- docs/CHANGELOG.md`, result: { stdout: "" } },
      noOtherMerges,
    ]);
    expect(reconcileChangelog(seams, root, input({ changelogPath: join("docs", "CHANGELOG.md") })).releasePrAllowance?.verdict).toBe("applied");
  });
});

describe("reconcileChangelog -- every decline leaves the check exactly as strict as before", () => {
  it("does NO git work past the merge log when every merged PR is already cited", () => {
    const root = checkout(`${CUT}\n${LINK(222)}\n`);
    const seams = new ScriptedSeams([mergedTwo]);
    const report = reconcileChangelog(seams, root, input({ changelogText: `${CUT}\n${LINK(222)}\n` }));
    expect(report).toEqual({ missing: [], ok: true, releasePrAllowance: null });
    expect(seams.calls).toHaveLength(1);
  });

  it("keeps the merge log's own failure a ToolError, as it always was", () => {
    const seams = new ScriptedSeams([{ match: MERGES, result: { code: 128, stderr: "fatal: bad revision" } }]);
    expect(() => reconcileChangelog(seams, checkout(), input())).toThrow(ToolError);
  });

  it("range-not-two-dot: a symmetric range has no single terminal merge", () => {
    const seams = new ScriptedSeams([{ match: "git log --merges --format=%s --end-of-options v1.0.0...v1.1.0", result: { stdout: "Merge pull request #222 from o/r\n" } }]);
    const report = reconcileChangelog(seams, checkout(), input({ range: "v1.0.0...v1.1.0" }));
    expect(report.missing).toEqual([222]);
    expect(report.releasePrAllowance).toMatchObject({ applied: false, verdict: "range-not-two-dot", pr: null });
  });

  it("REFUSES a range with a revision beginning with '-' as a usage error, before ANY git call", () => {
    // `--range=--output=pwned..HEAD` used to reach `git log` as an option:
    // git wrote the log to a file, nothing was left to reconcile, and the
    // gate passed. ScriptedSeams throws on any call, so zero calls is proven.
    for (const range of ["--output=pwned..HEAD", "v1.0.0..--output=x", "-x...v1.1.0", "-p"]) {
      const seams = new ScriptedSeams([]);
      expect(() => reconcileChangelog(seams, checkout(), input({ range }))).toThrow(VerbUsageError);
      expect(seams.calls).toHaveLength(0);
    }
  });

  it("hands every revision to git behind --end-of-options, so a leading '-' reaching the terminal read is an honest 'could not be read'", () => {
    // Through the verbs this never happens -- the refusal above comes first.
    // Called directly, git is handed the end as a revision and cannot resolve it.
    const seams = new ScriptedSeams([
      {
        match: "git log -1 --no-show-signature --format=%H%x09%P%x09%s --end-of-options -x^{commit} --",
        result: { code: 128, stderr: "fatal: bad revision '-x^{commit}'\n" },
      },
    ]);
    const decided = decideReleasePrAllowance(seams, checkout(), input({ range: "v1.0.0..-x" }), [222]);
    expect(decided.verdict).toBe("terminal-unreadable");
    expect(decided.detail).toMatch(/bad revision/);
  });

  it("terminal-unreadable: git could not resolve the range's end", () => {
    const seams = new ScriptedSeams([mergedTwo, { match: TERMINAL, result: { code: 128, stderr: "fatal: bad revision 'v1.1.0^{commit}'\n" } }]);
    const report = reconcileChangelog(seams, checkout(), input());
    expect(report.missing).toEqual([222]);
    expect(report.releasePrAllowance?.verdict).toBe("terminal-unreadable");
    expect(report.releasePrAllowance?.detail).toMatch(/exited 128: fatal: bad revision/);
  });

  it("terminal-unreadable: git answered a line this module does not recognise", () => {
    const seams = new ScriptedSeams([mergedTwo, { match: TERMINAL, result: { stdout: "Merge pull request #222 from o/r\n" } }]);
    expect(reconcileChangelog(seams, checkout(), input()).releasePrAllowance?.verdict).toBe("terminal-unreadable");
  });

  it("terminal-unreadable: git answered nothing", () => {
    const seams = new ScriptedSeams([mergedTwo, { match: TERMINAL, result: { stdout: "" } }]);
    expect(reconcileChangelog(seams, checkout(), input()).releasePrAllowance?.detail).toMatch(/git answered no commit/);
  });

  it("terminal-not-pr-merge: the range ends at an ordinary commit", () => {
    const seams = new ScriptedSeams([mergedTwo, { match: TERMINAL, result: { stdout: `${T}\t${P1}\tchore: a direct commit\n` } }]);
    const report = reconcileChangelog(seams, checkout(), input());
    expect(report.missing).toEqual([222]);
    expect(report.releasePrAllowance).toMatchObject({ verdict: "terminal-not-pr-merge", pr: null, mergeSha: T });
  });

  it("terminal-not-pr-merge: an octopus merge is not GitHub's two-parent pull-request merge", () => {
    const seams = new ScriptedSeams([mergedTwo, { match: TERMINAL, result: { stdout: `${T}\t${P1} ${P2} ${M}\tMerge pull request #222 from o/release\n` } }]);
    expect(reconcileChangelog(seams, checkout(), input()).releasePrAllowance?.verdict).toBe("terminal-not-pr-merge");
  });

  it("terminal-not-pr-merge: the range ends at a branch-sync merge, not a pull request", () => {
    const seams = new ScriptedSeams([mergedTwo, { match: TERMINAL, result: { stdout: `${T}\t${P1} ${P2}\tMerge remote-tracking branch 'origin/release' into main\n` } }]);
    expect(reconcileChangelog(seams, checkout(), input()).releasePrAllowance?.verdict).toBe("terminal-not-pr-merge");
  });

  it("terminal-pr-cited: the release PR is cited and ANOTHER PR is the one missing -- nothing to excuse", () => {
    const text = `${CUT}\n${LINK(222)}\n`;
    const seams = new ScriptedSeams([
      { match: MERGES, result: { stdout: "Merge pull request #222 from o/release\nMerge pull request #220 from o/stray\n" } },
      terminalIs222,
    ]);
    const report = reconcileChangelog(seams, checkout(text), input({ changelogText: text }));
    expect(report.missing).toEqual([220]);
    expect(report.releasePrAllowance).toMatchObject({ verdict: "terminal-pr-cited", pr: 222 });
  });

  it("no-dated-section: a --changelog OPENING with '— unreleased' cuts no dated section (the #242 shape)", () => {
    const text = `# Changelog\n\n## v1.1.0 — unreleased\n\n${LINK(221)}\n\n## v1.0.0 — 2026-09-01\n`;
    const seams = new ScriptedSeams([mergedTwo, terminalIs222]);
    const report = reconcileChangelog(seams, checkout(text), input({ changelogText: text }));
    expect(report.missing).toEqual([222]);
    expect(report.releasePrAllowance).toMatchObject({ verdict: "no-dated-section", pr: 222, section: null });
    expect(report.releasePrAllowance?.detail).toMatch(/opens with v1\.1\.0 marked unreleased/);
  });

  it("no-dated-section: a CHANGELOG with no dated heading cuts no section", () => {
    const text = `# Changelog\n\n### Unreleased\n\n${LINK(221)}\n`;
    const seams = new ScriptedSeams([mergedTwo, terminalIs222]);
    const report = reconcileChangelog(seams, checkout(text), input({ changelogText: text }));
    expect(report.missing).toEqual([222]);
    expect(report.releasePrAllowance?.verdict).toBe("no-dated-section");
  });

  it("changelog-outside-repo: a CHANGELOG copied elsewhere has no history to read", () => {
    const elsewhere = checkout();
    const seams = new ScriptedSeams([mergedTwo, terminalIs222]);
    const report = reconcileChangelog(seams, checkout(), input({ changelogPath: join(elsewhere, "CHANGELOG.md") }));
    expect(report.missing).toEqual([222]);
    expect(report.releasePrAllowance).toMatchObject({ verdict: "changelog-outside-repo", section: "v1.1.0" });
  });

  it("changelog-outside-repo: a --changelog path that no longer resolves is not read as inside the repository", () => {
    const seams = new ScriptedSeams([mergedTwo, terminalIs222]);
    expect(decideReleasePrAllowance(seams, checkout(), input({ changelogPath: "gone/CHANGELOG.md" }), [222]).verdict).toBe("changelog-outside-repo");
  });

  it("section-not-at-terminal: the merge's CHANGELOG opens with a different section than --changelog", () => {
    const seams = new ScriptedSeams([mergedTwo, terminalIs222, { match: lsTree(T), result: { stdout: entry(BLOB_T) } }, { match: catBlob(BLOB_T), result: { stdout: BEFORE } }]);
    const report = reconcileChangelog(seams, checkout(), input());
    expect(report.missing).toEqual([222]);
    expect(report.releasePrAllowance?.verdict).toBe("section-not-at-terminal");
    expect(report.releasePrAllowance?.detail).toMatch(/opens with the dated section v1\.0\.0, not v1\.1\.0/);
  });

  it("section-not-at-terminal: the merge's CHANGELOG still opens with the section UNDATED", () => {
    const seams = new ScriptedSeams([
      mergedTwo,
      terminalIs222,
      { match: lsTree(T), result: { stdout: entry(BLOB_T) } },
      { match: catBlob(BLOB_T), result: { stdout: "# Changelog\n\n## v1.1.0 — unreleased\n\n## v1.0.0 — 2026-09-01\n" } },
    ]);
    expect(reconcileChangelog(seams, checkout(), input()).releasePrAllowance?.detail).toMatch(/opens with no dated section, not v1\.1\.0/);
  });

  it("section-not-at-terminal: the merge carries no CHANGELOG at all", () => {
    const seams = new ScriptedSeams([mergedTwo, terminalIs222, { match: lsTree(T), result: { stdout: "" } }]);
    expect(reconcileChangelog(seams, checkout(), input()).releasePrAllowance?.detail).toMatch(/opens with no dated section/);
  });

  it("section-on-first-parent: the section was already on the trunk, so this PR did not introduce it (the #226 shape)", () => {
    const seams = new ScriptedSeams([mergedTwo, terminalIs222, ...sectionAtTerminal, { match: lsTree(P1), result: { stdout: entry(BLOB_P1) } }, { match: catBlob(BLOB_P1), result: { stdout: CUT } }]);
    const report = reconcileChangelog(seams, checkout(), input());
    expect(report.missing).toEqual([222]);
    expect(report.releasePrAllowance).toMatchObject({ verdict: "section-on-first-parent", pr: 222, firstParentSha: P1 });
  });

  it("applied: the first parent carries the section only UNDATED -- the PR that dates it introduced the dated section (the #246 shape)", () => {
    const seams = new ScriptedSeams([
      mergedTwo,
      terminalIs222,
      ...sectionAtTerminal,
      { match: lsTree(P1), result: { stdout: entry(BLOB_P1) } },
      { match: catBlob(BLOB_P1), result: { stdout: "# Changelog\n\n## v1.1.0 — unreleased\n\n## v1.0.0 — 2026-09-01\n" } },
      noOtherMerges,
    ]);
    expect(reconcileChangelog(seams, checkout(), input()).releasePrAllowance).toMatchObject({ applied: true, verdict: "applied", pr: 222 });
  });

  it("section-carried: a LOCAL merge on the branch introduced the section -- carriedBy null, its sha in the detail", () => {
    const seams = new ScriptedSeams([
      mergedTwo,
      terminalIs222,
      ...sectionAtTerminal,
      ...sectionAbsentAtFirstParent,
      { match: BRANCH, result: { stdout: `${M}\t${MP1} ${P1}\tMerge branch 'release-v1.1.0' into feature\n` } },
      { match: lsTree(M), result: { stdout: entry(BLOB_M) } },
      { match: catBlob(BLOB_M), result: { stdout: CUT } },
      { match: lsTree(MP1), result: { stdout: entry(BLOB_MP1) } },
      { match: catBlob(BLOB_MP1), result: { stdout: BEFORE } },
    ]);
    const report = reconcileChangelog(seams, checkout(), input());
    expect(report.missing).toEqual([222]);
    expect(report.releasePrAllowance).toMatchObject({ verdict: "section-carried", pr: 222, carriedBy: null });
    expect(report.releasePrAllowance?.detail).toContain(`by the local merge ${M}`);
  });

  it("section-carried: another PR's merge on the branch introduced the section (the #225 shape)", () => {
    const seams = new ScriptedSeams([
      mergedTwo,
      terminalIs222,
      ...sectionAtTerminal,
      ...sectionAbsentAtFirstParent,
      { match: BRANCH, result: { stdout: `${M}\t${MP1} ${P1}\tMerge pull request #219 from o/release-bump\n` } },
      { match: lsTree(M), result: { stdout: entry(BLOB_M) } },
      { match: catBlob(BLOB_M), result: { stdout: CUT } },
      { match: lsTree(MP1), result: { stdout: entry(BLOB_MP1) } },
      { match: catBlob(BLOB_MP1), result: { stdout: BEFORE } },
    ]);
    const report = reconcileChangelog(seams, checkout(), input());
    expect(report.missing).toEqual([222]);
    expect(report.releasePrAllowance).toMatchObject({ verdict: "section-carried", pr: 222, carriedBy: 219 });
    expect(report.releasePrAllowance?.detail).toMatch(/introduced on #222's branch by #219's merge ddddddd/);
  });
});

describe("decideReleasePrAllowance -- a failed git read DECLINES, it never grants (history-unreadable)", () => {
  const known = [mergedTwo, terminalIs222];

  it("an ls-tree failure at the FIRST PARENT is not read as 'the section was absent there'", () => {
    // The one read whose misreading would GRANT: `git show <sha>:<path>`
    // exits 128 for "absent" and for "could not look" alike, which is why
    // ls-tree is asked first.
    const seams = new ScriptedSeams([...known, ...sectionAtTerminal, { match: lsTree(P1), result: { code: 128, stderr: "fatal: not a tree object\n" } }]);
    const report = reconcileChangelog(seams, checkout(), input());
    expect(report.missing).toEqual([222]);
    expect(report.releasePrAllowance?.verdict).toBe("history-unreadable");
    expect(report.releasePrAllowance?.detail).toMatch(/fails closed/);
  });

  it("an ls-tree that cannot be started", () => {
    const seams = new ScriptedSeams([...known, { match: lsTree(T), result: { code: -1, spawnFailed: true, stderr: "spawn git ENOENT" } }]);
    expect(decideReleasePrAllowance(seams, checkout(), input(), [222]).detail).toMatch(/could not be started/);
  });

  it("an ls-tree answering something other than one file entry", () => {
    const seams = new ScriptedSeams([...known, { match: lsTree(T), result: { stdout: `040000 tree ${BLOB_T}\tCHANGELOG.md\0` } }]);
    expect(decideReleasePrAllowance(seams, checkout(), input(), [222]).verdict).toBe("history-unreadable");
  });

  it("a blob that cannot be read", () => {
    const seams = new ScriptedSeams([...known, { match: lsTree(T), result: { stdout: entry(BLOB_T) } }, { match: catBlob(BLOB_T), result: { code: 128 } }]);
    expect(decideReleasePrAllowance(seams, checkout(), input(), [222]).verdict).toBe("history-unreadable");
  });

  it("a branch walk that fails, or answers a line it cannot parse", () => {
    const failing = new ScriptedSeams([...known, ...sectionAtTerminal, ...sectionAbsentAtFirstParent, { match: BRANCH, result: { code: 128 } }]);
    expect(decideReleasePrAllowance(failing, checkout(), input(), [222]).verdict).toBe("history-unreadable");
    const garbled = new ScriptedSeams([...known, ...sectionAtTerminal, ...sectionAbsentAtFirstParent, { match: BRANCH, result: { stdout: "not a commit line\n" } }]);
    expect(decideReleasePrAllowance(garbled, checkout(), input(), [222]).verdict).toBe("history-unreadable");
  });

  it("a carrier merge whose trees cannot be read", () => {
    const branch: ScriptedCall = { match: BRANCH, result: { stdout: `${M}\t${MP1} ${P1}\tMerge pull request #219 from o/release-bump\n` } };
    const atMerge = new ScriptedSeams([...known, ...sectionAtTerminal, ...sectionAbsentAtFirstParent, branch, { match: lsTree(M), result: { code: 128 } }]);
    expect(decideReleasePrAllowance(atMerge, checkout(), input(), [222]).verdict).toBe("history-unreadable");
    const beforeMerge = new ScriptedSeams([
      ...known,
      ...sectionAtTerminal,
      ...sectionAbsentAtFirstParent,
      branch,
      { match: lsTree(M), result: { stdout: entry(BLOB_M) } },
      { match: catBlob(BLOB_M), result: { stdout: CUT } },
      { match: lsTree(MP1), result: { code: 128 } },
    ]);
    expect(decideReleasePrAllowance(beforeMerge, checkout(), input(), [222]).verdict).toBe("history-unreadable");
  });
});
