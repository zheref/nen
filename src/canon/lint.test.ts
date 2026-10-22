// src/canon/lint.test.ts -- `nen canon lint`, held to every case of zheref/hatsu's
// scripts/prose_ambiguity_check_fixture.mts (zheref/nen#481's acceptance
// criteria): each fail rule fires on a planted copy by its id, each advisory
// rule prints and never counts, every hostile case reads as named, and the
// baseline admits, goes stale and refuses to grow under --base. The rules
// contract is Hatsu's own, copied as ./fixtures/prose.lint.json, so the verb is
// proven against the file it will read.
import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { runFamily, type Io } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { canonCommand } from "./command.js";
import { exemptQuoted, parseLintContract, readingClauses, walk } from "./lint.js";
import { parseDoc } from "./markdown.js";

const CONTRACT = join(process.cwd(), "src", "canon", "fixtures", "prose.lint.json");
const scratch = mkdtempSync(join(tmpdir(), "nen-canon-lint-"));
afterAll((): void => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

function put(root: string, rel: string, text: string | Buffer): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const SKILL_TARGET = `---
name: target
description: >
  A folded description whose second line looks like a heading.
  # 7. Not a heading
---

# Target

## 1. Invocation

**§ 1a · The profile.** A bold numbered lead.

**State the cost plainly:** a bold lead cited by title.

\`\`\`md
## 9. Fenced, never a heading
\`\`\`

## 2 · Where it sits
`;

function base(): string {
  const root = join(scratch, `root-${++n}`);
  put(root, "nen/contract.json", JSON.stringify({ dependency: { minimum: "0.24", pinned_ref: "v0.24.0" } }));
  put(root, "nen/decisions.json", JSON.stringify({ rows: [
    { id: "missing-maintainer-choice", class: "ask-once-per-run" },
    { id: "missing-argument", class: "ask-once-per-run" },
    { id: "missing-configuration", class: "ask-once-per-run" },
    { id: "ambiguous-intent", class: "human-gate" },
    { id: "canon-merge", class: "human-gate" },
    { id: "red-lint", class: "autonomous" },
  ] }));
  put(root, "nen/workflow.json", JSON.stringify({ monitor: { cap: 20 } }));
  put(root, "contracts/config-catalogue.json", JSON.stringify({ values: [{ default: 7 }] }));
  mkdirSync(join(root, "contracts"), { recursive: true });
  copyFileSync(CONTRACT, join(root, "contracts/prose.lint.json"));
  put(root, "contracts/prose.lint.baseline.json", '{"findings":[]}\n');
  put(root, "docs/ROSTER.md", "# Roster\n\n| HR id | Q | O | P | Status | S |\n|---|---|---|---|---|---|\n" +
    '| <a id="hr-1"></a>**HR-1** | q | o | p | ruled | s |\n| <a id="hr-2"></a>**HR-2** | q | o | p | reading | s |\n');
  put(root, "claude/skills/target/SKILL.md", SKILL_TARGET);
  put(root, "claude/skills/citer/SKILL.md", "# Citer\n\nSee [`target`](../target/SKILL.md) § 1, [`target`](../target/SKILL.md) § 1a and\n[`target`](../target/SKILL.md) § *State the cost*, and [`target`](../target/SKILL.md) § 2; HR-1 rules it.\n");
  return root;
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function lint(root: string, extra: readonly string[] = [], json = false, baseline = true): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const argv = ["canon", "lint", "--root", root, "--rules", "contracts/prose.lint.json", ...(baseline ? ["--baseline", "contracts/prose.lint.baseline.json"] : []), ...extra];
  const code = await runFamily(canonCommand, argv, null, json, io, defaultSeams());
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

async function expectClean(root: string): Promise<void> {
  const r = await lint(root);
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
}

async function expectFinding(root: string, rule: string, needle: RegExp): Promise<void> {
  const r = await lint(root);
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(1);
  expect(r.stdout.split("\n").some((l): boolean => l.includes(` · ${rule} · `) && needle.test(l)), r.stdout).toBe(true);
}

async function expectWiring(root: string, needle: RegExp, extra: readonly string[] = []): Promise<void> {
  const r = await lint(root, extra, false, !extra.includes("--baseline"));
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(2);
  expect(r.stderr).toMatch(needle);
  expect(r.stdout).toBe("");
}

async function planted(rule: string, text: string, needle: RegExp, rel = "claude/skills/plant/SKILL.md"): Promise<void> {
  const root = base();
  put(root, rel, text);
  await expectFinding(root, rule, needle);
}

describe("nen canon lint -- the clean shape", () => {
  it("a clean tree with headings, bold leads and a numbered bold lead resolving exits 0", async () => {
    await expectClean(base());
  });
});

describe("nen canon lint -- every fail rule fires on a planted copy, by id", () => {
  it("PL-01 fires on an affirmative by-hand admission, not on a refusal or a human act", async () => {
    await planted("PL-01", "# P\n\nThe body is assembled by hand from the ledger.\n", /by hand/);
    const root = base();
    put(root, "claude/skills/plant/SKILL.md", "# P\n\nThe body is never assembled by hand; the maintainer merges by hand.\n");
    await expectClean(root);
  });

  it("PL-02 fires on 'until nen' with no zheref/nen#N; a filed residue and a version history are clean", async () => {
    await planted("PL-02", "# P\n\nThe lookup stays here until nen grows a verb.\n", /until nen/);
    const root = base();
    put(root, "claude/skills/plant/SKILL.md", "# P\n\nThe lookup stays here until nen grows a verb (zheref/nen#9).\nThe flag was unnamed until nen `0.7`.\n");
    await expectClean(root);
  });

  it("PL-03 fires on a stale pin wrapped across lines and on a present-tense pin claim", async () => {
    await planted("PL-03", "# P\n\nSelectors need nen v0.15.1+ (pin\nv0.21.0); older binaries exit 2.\n", /pin\s*v0\.21\.0/);
    await planted("PL-03", "# P\n\nAt the pinned nen `0.7.0` the hook refuses.\n", /0\.7\.0/);
  });

  it("PL-03: the pin, provenance, a past pin, RETIRED, a fence, quoted words and a record are clean", async () => {
    const root = base();
    put(root, "claude/skills/plant/SKILL.md", '# P\n\nThe pin is v0.24.0 and the floor needs nen 0.24. The hook arrived in nen 0.19\n(zheref/nen#357); through the pinned v0.6.0 it refused.\n\n> **RETIRED at nen `0.5`.** Once pinned v0.5.0.\n\n```sh\nnen v0.1.0+ (pin v0.1.0)\n```\n\nThe maintainer typed "need nen v0.1+ (pin v0.1.0)".\n');
    put(root, "docs/ab/old.md", "# Old\n\nThe pin v0.3.0 was current then.\n");
    await expectClean(root);
  });

  it("PL-04 fires on a missing number, title, file, anchor and a link leaving the root", async () => {
    await planted("PL-04", "# P\n\nSee [`target`](../target/SKILL.md) § 3.\n", /§ 3 — no such heading/);
    await planted("PL-04", "# P\n\nSee [`target`](../target/SKILL.md) § *Never there*.\n", /no heading or bold lead/);
    await planted("PL-04", "# P\n\nSee [`gone`](../gone/SKILL.md).\n", /no such file/);
    await planted("PL-04", "# P\n\nSee [`target`](../target/SKILL.md#nowhere).\n", /no anchor #nowhere/);
    await planted("PL-04", "# P\n\nSee [`out`](../../../../outside.md).\n", /leaves the root/);
  });

  it("PL-05 fires on a bare #N; coded references and a same-file anchor are clean", async () => {
    await planted("PL-05", "# P\n\nFixed in #154 last week.\n", /#154/);
    const root = base();
    put(root, "claude/skills/plant/SKILL.md", "# P\n\nFixed in zheref/hatsu#154, HA#12 and HA-PR-#303; see [x](#p).\n");
    await expectClean(root);
  });

  it("PL-06 fires on an undated verified-live claim; a dated one with its evidence path is clean", async () => {
    await planted("PL-06", "# P\n\nThe exit was verified live against the binary.\n", /verified live/);
    const root = base();
    put(root, "claude/skills/plant/SKILL.md", "# P\n\nThe exit was verified live 2026-10-20 (docs/ab/plant.md).\n");
    await expectClean(root);
  });

  it("PL-11 fires on a to-do word, a human-gate row, an autonomous row, a missing ledger and a fourth marker", async () => {
    await planted("PL-11", "# P\n\nTBD: who reviews this.\n", /TBD/);
    await planted("PL-11", "# P\n\n[NEEDS canon-merge: may this merge?] OPEN-1.\n", /human gate/);
    await planted("PL-11", "# P\n\n[NEEDS red-lint: retry?] OPEN-1.\n", /not an ask-class marker row/);
    await planted("PL-11", "# P\n\n[NEEDS missing-argument: which base?]\n", /no OPEN-n/);
    await planted("PL-11", "# P\n\n[NEEDS missing-argument: a?] OPEN-1.\n\n[NEEDS missing-argument: b?] OPEN-2.\n\n[NEEDS missing-argument: c?] OPEN-3.\n\n[NEEDS missing-argument: d?] OPEN-4.\n", /over the limit of 3/);
    const root = base();
    put(root, "claude/skills/plant/SKILL.md", "# P\n\n[NEEDS missing-configuration: is the cap a catalogue value?] OPEN-9 waits.\n[NEEDS ambiguous-intent: which reading?] (zheref/hatsu#9).\n");
    await expectClean(root);
  });

  it("PL-12 fires on a reading cited as ruled; a reading named as one is clean and HR-2 never matches HR-20", async () => {
    await planted("PL-12", "# P\n\nThe push path is HR-2.\n", /HR-2 is status reading/);
    const root = base();
    put(root, "claude/skills/plant/SKILL.md", "# P\n\nHR-2 is a reading, never a push path; HR-1 and HR-20 are not it.\n");
    await expectClean(root);
  });
});

describe("nen canon lint -- advisory rules", () => {
  it("PL-07..PL-10 print in --json advisory[] and never count", async () => {
    const root = base();
    put(root, "claude/skills/plant/SKILL.md", "# P\n\nThis might be fast for now.\nRun `nen loop slots --local-cap 9` today.\n\n## Residue\n\n1. The fetch is spelt in shell.\n");
    const r = await lint(root, [], true);
    expect(r.code, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout) as { contract: string; advisory: { rule: string }[]; counts: Record<string, { new: number }> };
    expect(j.contract).toBe("nen.canon.lint/v0.1");
    expect(Object.keys(j)).toEqual(["contract", "root", "rules", "baseline", "base", "files", "exit", "counts", "findings", "advisory", "staleBaseline", "grownBaseline"]);
    for (const rule of ["PL-07", "PL-08", "PL-09", "PL-10"]) expect(j.advisory.some((f): boolean => f.rule === rule), rule).toBe(true);
    expect(j.counts["PL-09"]?.new).toBe(0);
  });
});

describe("nen canon lint -- hostile cases", () => {
  it("CRLF headings resolve and a CRLF finding names its line", async () => {
    const root = base();
    put(root, "claude/skills/crlf/SKILL.md", "# C\r\n\r\n## 4. Real\r\n\r\nSee [`target`](../target/SKILL.md) § 5.\r\n");
    put(root, "claude/skills/ok/SKILL.md", "See [`crlf`](../crlf/SKILL.md) § 4.\n");
    const r = await lint(root);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/claude\/skills\/crlf\/SKILL\.md:5 · PL-04 · claude\/skills\/target\/SKILL\.md § 5/);
    expect(r.stdout).not.toMatch(/ok\/SKILL\.md/);
  });

  it("a heading inside a fence and a folded frontmatter line are no heading", async () => {
    await planted("PL-04", "See [`target`](../target/SKILL.md) § 9.\n", /§ 9 — no such heading/);
    await planted("PL-04", "See [`target`](../target/SKILL.md) § 7.\n", /§ 7 — no such heading/);
  });

  it("lines after folded frontmatter keep their numbers", async () => {
    const root = base();
    put(root, "claude/skills/plant/SKILL.md", "---\nname: plant\ndescription: >\n  folded\n  text\n---\n\nFixed in #77.\n");
    expect((await lint(root)).stdout).toMatch(/plant\/SKILL\.md:8 · PL-05/);
  });

  it("a finding inside frontmatter names the file's own line", async () => {
    const root = base();
    put(root, "claude/skills/plant/SKILL.md", "---\nname: plant\ndescription: fixed in #77\n---\n\n# P\n");
    expect((await lint(root)).stdout).toMatch(/plant\/SKILL\.md:3 · PL-05/);
  });

  it("a symlink leaving the root is wiring", async () => {
    const root = base();
    const outside = join(scratch, `outside-${n}.md`);
    writeFileSync(outside, "# Outside\n");
    symlinkSync(outside, join(root, "docs/linked.md"));
    await expectWiring(root, /symlink docs\/linked\.md leaves the root/);
  });

  it("a citation through a symlink that resolves outside the root is a finding, never a read outside", async () => {
    const root = base();
    const outside = join(scratch, `outside-cited-${n}.md`);
    writeFileSync(outside, "# Outside\n\n## 1. Here\n");
    mkdirSync(join(root, "other"), { recursive: true });
    symlinkSync(outside, join(root, "other/linked.md")); // a directory the walk never enters
    put(root, "claude/skills/plant/SKILL.md", "# P\n\nSee [`x`](../../../other/linked.md) § 1.\n");
    await expectFinding(root, "PL-04", /linked\.md — leaves the root/);
  });

  it("an unparseable contract and a contract of the wrong shape are wiring", async () => {
    const a = base();
    put(a, "contracts/prose.lint.json", '{ "rules": [ ');
    await expectWiring(a, /prose\.lint\.json is not valid JSON/);
    const b = base();
    put(b, "contracts/prose.lint.json", JSON.stringify({ paths: { include: [] }, rules: [{ id: "PL-01", class: "nonsense", severity: "fail" }] }));
    await expectWiring(b, /lacks|unknown class/);
  });

  it("a rule missing a field its class needs is wiring, never a rule silently skipped", async () => {
    const root = base();
    put(root, "contracts/prose.lint.json", JSON.stringify({ paths: { include: ["docs/**/*.md"] }, rules: [{ id: "PL-01", class: "by-hand", severity: "fail", pattern: "by hand" }] }));
    await expectWiring(root, /PL-01 \(class by-hand\) lacks negations/);
  });

  it("a non-UTF-8 file and an unreadable file are never read as clean", async () => {
    const a = base();
    put(a, "claude/skills/bad/SKILL.md", Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    await expectWiring(a, /not valid UTF-8/);
    if (process.getuid?.() !== 0 && process.platform !== "win32") {
      const b = base();
      put(b, "claude/skills/locked/SKILL.md", "# L\n");
      chmodSync(join(b, "claude/skills/locked/SKILL.md"), 0o000);
      await expectWiring(b, /cannot read claude\/skills\/locked\/SKILL\.md/);
      chmodSync(join(b, "claude/skills/locked/SKILL.md"), 0o644);
    }
  });

  it("an unparseable baseline, a missing rules contract and a missing named baseline are wiring", async () => {
    const a = base();
    put(a, "contracts/prose.lint.baseline.json", "[");
    await expectWiring(a, /baseline\.json is not valid JSON/);
    const plain = join(scratch, "plain");
    mkdirSync(plain, { recursive: true });
    await expectWiring(plain, /rules contract contracts\/prose\.lint\.json does not exist/);
    await expectWiring(base(), /baseline contracts\/none\.json is missing/, ["--baseline", "contracts/none.json"]);
  });

  it("an unknown flag and a missing --rules are usage errors (exit 2)", async () => {
    const root = base();
    const r = await lint(root, ["--nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--nope/);
    const out: string[] = [];
    const io: Io = { out: (l): void => void out.push(l), err: (l): void => void out.push(l) };
    expect(await runFamily(canonCommand, ["canon", "lint", "--root", root], null, false, io, defaultSeams())).toBe(2);
    expect(out.join("\n")).toMatch(/--rules <contract> is required/);
  });

  it("refuses a pin flag and differing --root/--repo", async () => {
    const root = base();
    expect((await lint(root, ["--source", "o/r"])).stderr).toMatch(/--source is not read by 'canon lint'/);
    const out: string[] = [];
    const io: Io = { out: (l): void => void out.push(l), err: (l): void => void out.push(l) };
    expect(await runFamily(canonCommand, ["canon", "lint", "--root", root, "--repo", scratch, "--rules", "x"], null, false, io, defaultSeams())).toBe(2);
    expect(out.join("\n")).toMatch(/name different directories/);
  });
});

describe("nen canon lint -- the ratchet", () => {
  it("admits a baselined finding, flags a stale row, and refuses a row the base did not carry", async () => {
    const root = base();
    put(root, "claude/skills/plant/SKILL.md", "# P\n\nFixed in #154 last week.\n");
    const j = JSON.parse((await lint(root, [], true)).stdout) as { findings: { path: string; rule: string; text: string }[] };
    const rows = j.findings.map((f) => ({ path: f.path, rule: f.rule, text: f.text, count: 1 }));
    put(root, "contracts/prose.lint.baseline.json", JSON.stringify({ findings: rows }));
    await expectClean(root);
    put(root, "claude/skills/plant/SKILL.md", "# P\n\nFixed in zheref/hatsu#154 last week.\n");
    const stale = await lint(root);
    expect(stale.code).toBe(1);
    expect(stale.stdout).toMatch(/baseline · PL-05 · claude\/skills\/plant\/SKILL\.md .* no longer found/);
    const git = (...a: string[]): void => {
      const r = spawnSync("git", ["-C", root, "-c", "user.name=f", "-c", "user.email=f@f", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
    };
    put(root, "contracts/prose.lint.baseline.json", '{"findings":[]}\n');
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("branch", "fixture-base");
    put(root, "claude/skills/plant/SKILL.md", "# P\n\nFixed in #154 last week.\n");
    put(root, "contracts/prose.lint.baseline.json", JSON.stringify({ findings: rows }));
    const grown = await lint(root, ["--base", "fixture-base"]);
    expect(grown.code, grown.stdout + grown.stderr).toBe(1);
    expect(grown.stdout).toMatch(/added over fixture-base; the baseline only shrinks/);
    // --base scopes the findings to the changed files: the untouched target is not read for findings.
    expect(grown.stdout).toMatch(/canon lint: 1 files/);
  });

  it("a PL-03 baseline row is refused, never admitted", async () => {
    const root = base();
    put(root, "contracts/pl03.json", JSON.stringify({ findings: [{ path: "claude/skills/target/SKILL.md", rule: "PL-03", text: "pin v0.1.0", count: 1 }] }));
    await expectWiring(root, /PL-03 is never baselined/, ["--baseline", "contracts/pl03.json"]);
  });

  it("without --baseline every fail finding is new", async () => {
    const root = base();
    put(root, "claude/skills/plant/SKILL.md", "# P\n\nFixed in #154 last week.\n");
    const r = await lint(root, [], true, false);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.stdout) as { baseline: unknown }).baseline).toBeNull();
  });

  it("--base on a ref git cannot read is wiring", async () => {
    const root = base();
    spawnSync("git", ["-C", root, "init", "-q"]);
    await expectWiring(root, /git merge-base/, ["--base", "no-such-ref"]);
  });
});

describe("canon lint internals", () => {
  it("quoted words are blanked, newlines kept", () => {
    expect(exemptQuoted('a "b c" d\n“e”')).toBe("a       d\n   ");
  });

  it("reads reading status from a Status column by header and from a (reading) token", () => {
    const doc = parseDoc("r.md", '| HR | Status | X |\n|--|--|--|\n| <a id="hr-3"></a>**HR-3** | reading | x |\n| <a id="hr-4"></a>**HR-4** | ruled | x |\n\n<a id="hr-5"></a>**HR-5** (reading) A paragraph ruling.\n');
    expect([...readingClauses(doc, "HR")].sort()).toEqual(["3", "5"]);
  });

  it("a new table without a Status header falls back to the fifth column", () => {
    const doc = parseDoc("r.md", '| A | Status |\n|--|--|\n| <a id="hr-1"></a>**HR-1** | reading |\n\nText.\n\n| HR | Q | O | P | S |\n|--|--|--|--|--|\n| <a id="hr-2"></a>**HR-2** | reading | o | p | ruled |\n');
    expect([...readingClauses(doc, "HR")]).toEqual(["1"]);
  });

  it("the contract may omit classes it does not use, and refuses an unknown $schema", () => {
    expect(parseLintContract({ paths: { include: ["**/*.md"] }, rules: [{ id: "X-1", class: "hedge", severity: "advisory", pattern: "maybe" }] }, "c").rules).toHaveLength(1);
    expect(() => parseLintContract({ $schema: "nen.prose-lint/v9", paths: { include: [] }, rules: [] }, "c")).toThrow(/this nen reads/);
  });

  it("walk honours paths.exclude", () => {
    const root = base();
    put(root, "docs/gen/x.md", "# X\n");
    expect(walk(root, realpathSync(root), ["docs/**/*.md"], ["docs/gen/**"])).toEqual(["docs/ROSTER.md"]);
  });
});
