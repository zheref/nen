// src/schema/canonmirror.test.ts -- zheref/nen#262's acceptance for the
// `.claude/rules/` row of `nen schema check`, driven through a scripted git:
// the history a test means is stated here, never read off the host.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileMarker } from "../canon/mirror.js";
import type { CommandResult, Runner } from "../seam/exec.js";
import {
  CANON_VALUES_FILE,
  HARDCODED_REMEDY,
  HISTORY_LIMIT,
  REGENERATE_REMEDY,
  canonMirrorCheck,
  describeFinding,
  findMirrorFindings,
  literalOccurrences,
  mirrorRowFile,
  readValueHistory,
} from "./canonmirror.js";
import { checkTaxonomy } from "./taxonomy.js";

const PIN = { source: "owner/handbooks", ref: "v1.2.0", scenario: "swiftui" };
const marked = (file: string, body: string): string => `${fileMarker(PIN, file)}\n${body}`;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const result = (partial: Partial<CommandResult>): CommandResult => ({ code: 0, stdout: "", stderr: "", spawnFailed: false, ...partial });

/** A git that answers `log` with the given revisions and `cat-file` with each one's text. */
function scriptedGit(revisions: readonly (readonly [string, string])[], calls: string[][] = []): Runner {
  return (command, args): CommandResult => {
    calls.push([command, ...args]);
    if (command !== "git") throw new Error(`unexpected ${command}`);
    if (args[0] === "log") return result({ stdout: revisions.map(([sha]): string => sha).join("\n") + "\n" });
    if (args[0] === "cat-file") {
      const spec = args[2] ?? "";
      const found = revisions.find(([sha]): boolean => spec === `${sha}:./${CANON_VALUES_FILE}`);
      return found === undefined ? result({ code: 128, stderr: "fatal: path does not exist" }) : result({ stdout: found[1] });
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

const values = (pairs: Readonly<Record<string, string>>): string =>
  `scenario: swiftui\nsurfaces: claude-code\nvalues:\n${Object.entries(pairs).map(([k, v]): string => `  ${k}: "${v}"`).join("\n")}\n`;

function consumer(current: Readonly<Record<string, string>>, files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "nen-canonmirror-"));
  mkdirSync(join(root, ".claude", "rules"), { recursive: true });
  writeFileSync(join(root, CANON_VALUES_FILE), values(current));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, ".claude", "rules", name), text);
  return root;
}

const NOW = { SNAPSHOT_OS: "27.0", DEVICE: "iPhone 17" };
const BEFORE = { SNAPSHOT_OS: "26.5", DEVICE: "iPhone 17" };
const HISTORY: readonly (readonly [string, string])[] = [
  [SHA_A, values(NOW)],
  [SHA_B, values(BEFORE)],
];

describe("literalOccurrences", () => {
  it("finds a value as a whole literal, never inside a longer one", () => {
    expect(literalOccurrences("| `26.5` | (26.5) | 26.5.", "26.5")).toEqual([3, 12, 20]);
    for (const line of ["v26.5", "126.5", "26.5.1", "1.26.5", "26.5x", "iOS-26.5-beta"]) {
      expect(literalOccurrences(line, "26.5")).toEqual([]);
    }
    expect(literalOccurrences("anything", "")).toEqual([]);
  });
});

describe("findMirrorFindings", () => {
  const history = new Map([["SNAPSHOT_OS", new Set(["27.0", "26.5"])], ["DEVICE", new Set(["iPhone 17"])]]);

  it("STALE: a moved binding the mirror never picked up names the token, both values and every file", () => {
    const findings = findMirrorFindings(NOW, history, [
      { name: "07-testing.md", text: "Snapshots run on iOS 26.5.\n" },
      { name: "13-build.md", text: "Nothing here.\n" },
      { name: "16-ui.md", text: "| `26.5` | `26.5` |\n" },
    ]);
    expect(findings).toEqual([{ token: "SNAPSHOT_OS", bound: "27.0", superseded: "26.5", kind: "stale", sites: ["07-testing.md", "16-ui.md"] }]);
    expect(describeFinding(findings[0]!)).toBe("SNAPSHOT_OS is bound to '27.0' but 2 file(s) still carry '26.5': 07-testing.md, 16-ui.md");
  });

  it("BESIDE: the hardcoded column -- the bound value and the old one on one line -- FAILs by line", () => {
    const findings = findMirrorFindings(NOW, history, [{ name: "07-testing.md", text: "Run on iOS 27.0.\n\n| `27.0` | `26.5` |\n" }]);
    expect(findings).toEqual([{ token: "SNAPSHOT_OS", bound: "27.0", superseded: "26.5", kind: "beside", sites: ["07-testing.md:3"] }]);
    expect(describeFinding(findings[0]!)).toBe("SNAPSHOT_OS is bound to '27.0' but 1 line(s) still carry '26.5' beside it: 07-testing.md:3");
  });

  it("BESIDE: an old value on the line that names the token is a finding too", () => {
    const findings = findMirrorFindings(NOW, history, [{ name: "a.md", text: "Uses 27.0.\nSNAPSHOT_OS defaults to 26.5 here.\n" }]);
    expect(findings.map((f): string => f.sites.join())).toEqual(["a.md:2"]);
  });

  it("an old value occurring for unrelated reasons in a regenerated mirror is NOT a finding", () => {
    expect(
      findMirrorFindings(NOW, history, [
        { name: "a.md", text: "Snapshots run on iOS 27.0.\n" },
        { name: "b.md", text: "For example, a project still on 26.5 would migrate first.\n" },
        { name: "c.md", text: "Versions like 26.5.1 or v26.5 are not the binding.\n" },
      ]),
    ).toEqual([]);
  });

  it("never attributes a value that is ANY token's current binding", () => {
    const bound = { SNAPSHOT_OS: "27.0", MIN_OS: "26.5" };
    const moved = new Map([["SNAPSHOT_OS", new Set(["26.5"])]]);
    expect(findMirrorFindings(bound, moved, [{ name: "a.md", text: "| 27.0 | 26.5 |\n" }])).toEqual([]);
  });

  it("an old value inside the bound one is the bound one, and nen's own marker lines are never sites", () => {
    const bound = { NAME: "Kro App" };
    const moved = new Map([["NAME", new Set(["App"])]]);
    expect(findMirrorFindings(bound, moved, [{ name: "a.md", text: "Ship Kro App.\n" }])).toEqual([]);
    const ref = { REF: "1.2.0" };
    const old = new Map([["REF", new Set(["v1.2.0", "1.1.0"])]]);
    expect(findMirrorFindings(ref, old, [{ name: "a.md", text: `${fileMarker({ ...PIN, ref: "1.1.0" }, "a.md")}\nPinned at 1.2.0.\n` }])).toEqual([]);
  });

  it("an unmoved binding and an empty bound value raise nothing on their own", () => {
    expect(findMirrorFindings({ DEVICE: "iPhone 17" }, new Map([["DEVICE", new Set(["iPhone 17"])]]), [{ name: "a.md", text: "x\n" }])).toEqual([]);
    expect(findMirrorFindings({ EMPTY: "" }, new Map([["EMPTY", new Set(["old"])]]), [{ name: "a.md", text: "old prose\n" }])).toEqual([]);
    expect(findMirrorFindings({ EMPTY: "" }, new Map([["EMPTY", new Set(["old"])]]), [{ name: "a.md", text: "EMPTY is old\n" }])[0]?.kind).toBe("beside");
  });
});

describe("readValueHistory", () => {
  it("reads every committed revision raw, one cat-file per revision, at most HISTORY_LIMIT", () => {
    const calls: string[][] = [];
    const history = readValueHistory(scriptedGit(HISTORY, calls), "/repo");
    expect(history.available).toBe(true);
    if (!history.available) return;
    expect(history.revisions).toBe(2);
    expect(history.capped).toBe(false);
    expect([...(history.values.get("SNAPSHOT_OS") ?? [])].sort()).toEqual(["26.5", "27.0"]);
    expect(calls[0]).toEqual(["git", "log", `--max-count=${HISTORY_LIMIT}`, "--format=%H", "--no-show-signature", "--", CANON_VALUES_FILE]);
    expect(calls.slice(1)).toEqual([
      ["git", "cat-file", "blob", `${SHA_A}:./${CANON_VALUES_FILE}`],
      ["git", "cat-file", "blob", `${SHA_B}:./${CANON_VALUES_FILE}`],
    ]);
  });

  it("skips a revision that deleted the file, and reports no history as unavailable rather than empty", () => {
    const SHA_C = "c".repeat(40);
    const withDeletion: Runner = (_c, args) =>
      args[0] === "log" ? result({ stdout: `${SHA_C}\n${SHA_A}\n` }) : args[2]?.startsWith(SHA_A) === true ? result({ stdout: values(BEFORE) }) : result({ code: 128 });
    const history = readValueHistory(withDeletion, "/repo");
    expect(history.available && history.revisions).toBe(2);
    expect(history.available && [...(history.values.get("SNAPSHOT_OS") ?? [])]).toEqual(["26.5"]);
    expect(readValueHistory((): CommandResult => result({ code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git\n" }), "/r")).toEqual({
      available: false,
      reason: "git log exited 128: fatal: not a git repository (or any of the parent directories): .git",
    });
    expect(readValueHistory((): CommandResult => result({ spawnFailed: true, code: 1 }), "/r")).toEqual({ available: false, reason: "git could not be started" });
    expect(readValueHistory(undefined, "/r")).toEqual({ available: false, reason: "no subprocess seam was given" });
  });
});

describe("canonMirrorCheck -- the row", () => {
  it("is named for the mirror directory", () => {
    expect(mirrorRowFile()).toBe(".claude/rules/");
  });

  it("no .claude/canon-values.yml: absent (optional), not a failure, and no subprocess", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-canonmirror-"));
    const row = canonMirrorCheck(root, (): never => { throw new Error("must not spawn"); });
    expect(row).toMatchObject({ file: ".claude/rules/", ok: true, required: false, detail: "absent (optional): no .claude/canon-values.yml" });
  });

  it("bindings but no generated mirror file: ok, nothing compared, and no subprocess", () => {
    const root = consumer(NOW, { "own-rule.md": "A consumer's own rule mentioning 26.5.\n" });
    const row = canonMirrorCheck(root, (): never => { throw new Error("must not spawn"); });
    expect(row.ok).toBe(true);
    expect(row.detail).toBe("no generated mirror under .claude/rules/ (no file carries nen's canon marker); nothing to compare against .claude/canon-values.yml (2 tokens)");
  });

  it("consistent: ok, with the counts", () => {
    const root = consumer(NOW, { "07-testing.md": marked("07-testing.md", "Run on 27.0 with an iPhone 17.\nExample: an old 26.5 project.\n") });
    expect(canonMirrorCheck(root, scriptedGit(HISTORY))).toMatchObject({
      ok: true,
      required: false,
      detail: "mirror consistent with .claude/canon-values.yml (2 tokens, 1 files, 2 revision(s) read)",
    });
  });

  it("a binding that moved while the mirror kept the old value: a required FAIL naming token, values, files and the regenerate remedy", () => {
    const root = consumer(NOW, {
      "07-testing.md": marked("07-testing.md", "Snapshots on iOS 26.5, iPhone 17.\n"),
      "13-build-execution.md": marked("13-build-execution.md", "Build for 26.5.\n"),
      "16-ui-screenshots.md": marked("16-ui-screenshots.md", "| `26.5` | `26.5` |\n"),
      "own.md": "a hand-written rule on 26.5 is the consumer's own\n",
    });
    const row = canonMirrorCheck(root, scriptedGit(HISTORY));
    expect(row.ok).toBe(false);
    expect(row.required).toBe(true);
    expect(row.detail).toBe(
      `SNAPSHOT_OS is bound to '27.0' but 3 file(s) still carry '26.5': 07-testing.md, 13-build-execution.md, 16-ui-screenshots.md. ${REGENERATE_REMEDY}`,
    );
    expect(row.detail).toMatch(/never hand-edit it \(CON-13\)/);
  });

  it("the hardcoded column FAILs and says the canon carries it", () => {
    const root = consumer(NOW, { "16-ui.md": marked("16-ui.md", "| Token | Value |\n| `27.0` | `26.5` |\n") });
    const row = canonMirrorCheck(root, scriptedGit(HISTORY));
    expect(row.detail).toBe(`SNAPSHOT_OS is bound to '27.0' but 1 line(s) still carry '26.5' beside it: 16-ui.md:3. ${REGENERATE_REMEDY} ${HARDCODED_REMEDY}`);
  });

  it("history git cannot read: a warn row reading NOT CHECKED, never an ok", () => {
    const root = consumer(NOW, { "a.md": marked("a.md", "26.5\n") });
    const row = canonMirrorCheck(root, (): CommandResult => result({ code: 128, stderr: "fatal: not a git repository" }));
    expect(row).toMatchObject({ ok: false, required: false });
    expect(row.detail).toBe("NOT CHECKED -- .claude/canon-values.yml has no readable git history (git log exited 128: fatal: not a git repository), so no superseded value is known (2 tokens, 1 files)");
  });

  it("an unreadable bindings file is a required FAIL, and a symlinked mirror entry is not read", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-canonmirror-"));
    mkdirSync(join(root, ".claude", "canon-values.yml"), { recursive: true });
    expect(canonMirrorCheck(root, undefined)).toMatchObject({ ok: false, required: true, detail: "could not read .claude/canon-values.yml: not a regular file" });

    const linked = consumer(NOW, {});
    const outside = join(mkdtempSync(join(tmpdir(), "nen-canonmirror-")), "x.md");
    writeFileSync(outside, marked("x.md", "26.5\n"));
    symlinkSync(outside, join(linked, ".claude", "rules", "x.md"));
    expect(canonMirrorCheck(linked, (): never => { throw new Error("must not spawn"); }).detail).toMatch(/^no generated mirror/);
  });

  it("is the row after nen/decisions.json in checkTaxonomy, and reads absent without a seam", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-canonmirror-"));
    const report = checkTaxonomy({ repoFlag: root });
    const files = report.checks.map((check): string => check.file);
    expect(files.slice(-2)).toEqual(["nen/decisions.json", ".claude/rules/"]);
    expect(report.checks.at(-1)?.detail).toBe("absent (optional): no .claude/canon-values.yml");
  });
});
