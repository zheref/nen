// src/ref/resolve.test.ts -- `nen ref resolve --citation`, held to
// zheref/nen#482's acceptance criteria (the resolver cases of Hatsu's
// prose_ambiguity_check_fixture.mts) and to clause ids as
// `nen canon clause check` counts them.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { refCommand } from "./command.js";
import { CitationSyntaxError, parseCitation } from "./resolve.js";

const root = mkdtempSync(join(tmpdir(), "nen-ref-resolve-"));
afterAll((): void => rmSync(root, { recursive: true, force: true }));
const put = (rel: string, text: string | Buffer): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

put("claude/skills/target/SKILL.md", `---
name: target
description: >
  folded
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

## 2 · Where it sits

<a id="custom"></a>
`);
put("claude/skills/crlf/SKILL.md", "# C\r\n\r\n## 4. Real\r\n");
put("docs/ROSTER.md", '| HR | Status |\n|--|--|\n| <a id="hr-1"></a>**HR-1** | ruled |\n| <a id="hr-2"></a>**HR-2** | reading |\n| <a id="hr-20"></a>**HR-20** | ruled |\n');
put("CONSTITUTION.md", "# C\n\n- **CON-48.** **Clause-leaf coupling.**\n");
put("bad.md", Buffer.from([0x23, 0x20, 0xff, 0x0a]));
put("docs/with space.md", "# W\n\n## 1. First\n");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function resolve(citation: string, extra: readonly string[] = [], json = false): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l): void => void out.push(l), err: (l): void => void err.push(l) };
  const code = await runFamily(refCommand, ["ref", "resolve", "--citation", citation, "--root", root, ...extra], null, json, io, new ScriptedSeams([]));
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

const doc = async (citation: string, extra: readonly string[] = []): Promise<Record<string, unknown>> => JSON.parse((await resolve(citation, extra, true)).stdout) as Record<string, unknown>;

describe("nen ref resolve -- § N", () => {
  it("resolves to a heading opening with N and to a numbered bold lead", async () => {
    const r = await resolve("claude/skills/target/SKILL.md § 1");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/SKILL\.md:10 · heading · 1\. Invocation · #1-invocation/);
    expect((await resolve("claude/skills/target/SKILL.md § 1a")).stdout).toMatch(/:12 · lead · § 1a · The profile\./);
  });

  it("lists every match when two headings share a number, never picking one", async () => {
    const j = await doc("claude/skills/target/SKILL.md § 2");
    expect(j["resolved"]).toBe(true);
    expect((j["matches"] as { line: number; anchor: string }[]).map((m) => [m.line, m.anchor])).toEqual([[20, "2--where-it-sits"], [22, "2--where-it-sits-1"]]);
  });

  it("a heading in a fence and a folded frontmatter line never resolve; unresolved lists candidates (exit 1)", async () => {
    const r = await resolve("claude/skills/target/SKILL.md § 9");
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/unresolved · .* no heading or bold lead numbered 9/);
    expect(r.stdout).toMatch(/candidate · claude\/skills\/target\/SKILL\.md:10 · heading · 1\. Invocation/);
    expect((await resolve("claude/skills/target/SKILL.md § 7")).code).toBe(1);
  });

  it("CRLF reads as LF", async () => {
    expect((await resolve("claude/skills/crlf/SKILL.md § 4")).code).toBe(0);
  });
});

describe("nen ref resolve -- § *Title*, anchors, files", () => {
  it("resolves a title to a heading or lead by normalised prefix, ignoring a number prefix", async () => {
    expect((await resolve("claude/skills/target/SKILL.md § *State the cost*")).stdout).toMatch(/:14 · lead/);
    expect((await resolve("claude/skills/target/SKILL.md § *Invocation*")).stdout).toMatch(/:10 · heading/);
    expect((await resolve("claude/skills/target/SKILL.md § *Never there*")).code).toBe(1);
  });

  it("accepts the Markdown link form, relative to --from", async () => {
    expect((await resolve("[`target`](../target/SKILL.md) § 1", ["--from", "claude/skills/citer/SKILL.md"])).code).toBe(0);
    expect((await resolve("[t](../target/SKILL.md)'s § *State the cost*", ["--from", "claude/skills/citer/SKILL.md"])).code).toBe(0);
  });

  it("checks #anchors against GitHub slugs (duplicates suffixed) and explicit <a id> anchors", async () => {
    expect((await resolve("claude/skills/target/SKILL.md#2--where-it-sits-1")).stdout).toMatch(/:22 · heading/);
    expect((await resolve("claude/skills/target/SKILL.md#custom")).stdout).toMatch(/· anchor · custom/);
    const missing = await resolve("claude/skills/target/SKILL.md#nowhere");
    expect(missing.code).toBe(1);
    expect(missing.stdout).toMatch(/no anchor #nowhere/);
    expect((await resolve("#custom", ["--from", "claude/skills/target/SKILL.md"])).code).toBe(0);
  });

  it("a symlink inside the root that resolves outside it is unresolved, never read", async () => {
    const outside = join(tmpdir(), `nen-ref-outside-${process.pid}.md`);
    writeFileSync(outside, "# O\n\n## 1. Here\n");
    symlinkSync(outside, join(root, "linked.md"));
    const j = await doc("linked.md § 1");
    rmSync(outside, { force: true });
    expect(j["resolved"]).toBe(false);
    expect(j["reason"]).toBe("leaves the root");
  });

  it("a plain path resolves when the file exists; a missing one and one leaving the root are unresolved by name", async () => {
    expect((await resolve("docs/ROSTER.md")).code).toBe(0);
    expect((await doc("docs/NOPE.md"))["reason"]).toBe("no such file");
    const out = await doc("../../outside.md § 1");
    expect(out["reason"]).toBe("leaves the root");
    expect(out["target"]).toBeNull();
  });
});

describe("nen ref resolve -- clause ids", () => {
  it("resolves HR-n in docs/ROSTER.md and CON-n in CONSTITUTION.md by default; HR-2 never matches HR-20", async () => {
    const j = await doc("HR-2");
    expect(j["matches"]).toEqual([{ line: 4, text: '| <a id="hr-2"></a>**HR-2** | reading |', anchor: "hr-2", via: "definition" }]);
    expect((await resolve("CON-48")).code).toBe(0);
  });

  it("an undefined id is unresolved with the nearest defined ids as candidates", async () => {
    const j = await doc("HR-3");
    expect(j["resolved"]).toBe(false);
    expect((j["candidates"] as { anchor: string }[]).map((c) => c.anchor)).toEqual(["hr-2", "hr-1", "hr-20"]);
  });

  it("another prefix needs --in", async () => {
    const r = await resolve("QA-1");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--in <file>/);
    expect((await resolve("CON-48", ["--in", "CONSTITUTION.md"])).code).toBe(0);
  });
});

describe("nen ref resolve -- the consumer's clause homes and CommonMark destinations (delivery round on #498)", () => {
  it("reads <root>/nen/contract.json clauseHomes before the documented defaults", async () => {
    const own = mkdtempSync(join(tmpdir(), "nen-ref-homes-"));
    mkdirSync(join(own, "nen"));
    mkdirSync(join(own, "canon"));
    writeFileSync(join(own, "nen", "contract.json"), JSON.stringify({ clauseHomes: { QA: "canon/QA.md" } }));
    writeFileSync(join(own, "canon", "QA.md"), "- **QA-1.** **One.**\n");
    const out: string[] = [];
    const io: Io = { out: (l): void => void out.push(l), err: (): void => {} };
    const code = await runFamily(refCommand, ["ref", "resolve", "--citation", "QA-1", "--root", own], null, true, io, new ScriptedSeams([]));
    expect(code).toBe(0);
    expect((JSON.parse(out.join("\n")) as { target: string }).target).toBe("canon/QA.md");
    writeFileSync(join(own, "nen", "contract.json"), JSON.stringify({ clauseHomes: { QA: "../out.md" } }));
    expect(await runFamily(refCommand, ["ref", "resolve", "--citation", "QA-1", "--root", own], null, false, io, new ScriptedSeams([]))).toBe(2);
  });

  it("accepts the CommonMark <...> link destination, so a path with a space resolves", async () => {
    expect((await resolve("[x](<docs/with space.md>) § 1")).code).toBe(0);
    expect((await resolve("[x](docs/with%20space.md) § 1")).code).toBe(0);
  });
});

describe("nen ref resolve -- usage and wiring", () => {
  it("--json carries the documented keys", async () => {
    expect(Object.keys(await doc("HR-1"))).toEqual(["contract", "citation", "kind", "root", "target", "resolved", "matches", "reason", "candidates"]);
    expect((await doc("HR-1"))["contract"]).toBe("nen.ref.resolve/v0.1");
  });

  it("a target that is not UTF-8 is exit 2, neither resolved nor unresolved", async () => {
    const r = await resolve("bad.md § 1");
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
  });

  it("refuses a malformed citation, a missing --citation and a format flag", async () => {
    expect((await resolve("docs/ROSTER.md § what")).code).toBe(2);
    const out: string[] = [];
    const io: Io = { out: (l): void => void out.push(l), err: (l): void => void out.push(l) };
    expect(await runFamily(refCommand, ["ref", "resolve", "--root", root], null, false, io, new ScriptedSeams([]))).toBe(2);
    expect((await resolve("HR-1", ["--code", "HA"])).stderr).toMatch(/--code is not read by 'ref resolve'/);
    expect(await runFamily(refCommand, ["ref", "parse", "XX-PR-#1", "--citation", "HR-1"], null, false, io, new ScriptedSeams([]))).toBe(2);
  });

  it("parseCitation reads every form and refuses a mixed one", () => {
    expect(parseCitation("HR-12")).toEqual({ kind: "clause", prefix: "HR", id: 12 });
    expect(parseCitation("a.md § 2.1")).toEqual({ kind: "section", path: "a.md", number: "2.1" });
    expect(parseCitation("a.md §§ *X y*")).toEqual({ kind: "title", path: "a.md", title: "X y" });
    expect(parseCitation("a.md#x")).toEqual({ kind: "anchor", path: "a.md", anchor: "x" });
    expect(() => parseCitation("a.md#x § 1")).toThrow(CitationSyntaxError);
    expect(() => parseCitation("§ 1")).toThrow(CitationSyntaxError);
  });
});
