// src/canon/clause.test.ts -- `nen canon clause check`, held to every case of
// zheref/hatsu's scripts/clause_id_guard_fixture.mts (HR-2) and to the
// load-bearing behaviours of zheref/akatsuki-ai's clause_id_guard.ts and
// clause_leaf_guard.ts (CON-48), on throwaway files and repositories.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { runFamily, type Io } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { canonCommand } from "./command.js";
import { changedClauses, cites, clauseBlock, leafOptOut, scanClauses } from "./clause.js";

const scratch = mkdtempSync(join(tmpdir(), "nen-clause-"));
afterAll((): void => rmSync(scratch, { recursive: true, force: true }));
const def = (n: number, label = n): string => `| <a id="hr-${n}"></a>**HR-${label}** | a ruling | ruled |`;
let k = 0;

function roster(lines: readonly string[]): string {
  const name = `roster-${++k}.md`;
  writeFileSync(join(scratch, name), `${lines.join("\n")}\n`);
  return name;
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function check(repo: string, args: readonly string[], json = false): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l): void => void out.push(l), err: (l): void => void err.push(l) };
  const code = await runFamily(canonCommand, ["canon", "clause", "check", ...args], repo, json, io, defaultSeams());
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

const hr = (file: string, ...extra: string[]): Promise<Run> => check(scratch, ["--file", file, "--prefix", "HR", ...extra]);

describe("nen canon clause check -- the id space (Hatsu's fixture)", () => {
  it("unique ids pass", async () => {
    const r = await hr(roster([def(1), def(2), def(3)]));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/3 HR definitions/);
  });

  it("citations are never counted", async () => {
    const r = await hr(roster([def(1), def(2), "See [HR-1](#hr-1) and HR-2; status (reversed by HR-1).", "| x | superseded by HR-2 |"]));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/2 HR definitions/);
  });

  it("a duplicate id exits 1 and names its lines", async () => {
    const r = await hr(roster([def(1), def(2), def(2)]));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/duplicate · HR-2 · defined 2 times \(lines 2, 3\)/);
  });

  it("HR-2 never matches HR-20, either way", async () => {
    expect((await hr(roster([def(1), def(2), ...Array.from({ length: 18 }, (_, i): string => def(i + 3))]))).code).toBe(0);
    const r = await hr(roster([def(2), def(20), def(20)]));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/HR-20 · defined 2 times/);
    expect(r.stdout).not.toMatch(/HR-2 · defined/);
  });

  it("two anchors on one line both count", async () => {
    const r = await hr(roster([`${def(1)} <a id="hr-1"></a>**HR-1** (reading)`]));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/HR-1 · defined 2 times/);
  });

  it("an anchor and label that disagree exit 1", async () => {
    const r = await hr(roster([def(1), def(2, 3)]));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/mismatch · line 2 · anchor hr-2 labels HR-3/);
  });

  it("a gap is a notice, exit 0", async () => {
    const r = await hr(roster([def(1), def(2), def(5)]), "--json");
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { gaps: string[] }).gaps).toEqual(["HR-3", "HR-4"]);
  });

  it("order is not asserted", async () => {
    expect((await hr(roster([def(3), def(1), def(2)]))).code).toBe(0);
  });

  it("an unreadable file, a directory and no definitions are tooling failures (exit 2), never clean", async () => {
    expect((await hr("absent.md")).code).toBe(2);
    mkdirSync(join(scratch, "a-directory"), { recursive: true });
    const dir = await hr("a-directory");
    expect(dir.code).toBe(2);
    expect(dir.stderr).toMatch(/not a file/);
    const empty = await hr(roster(["# nothing here", "HR-1 cited only"]));
    expect(empty.code).toBe(2);
    expect(empty.stderr).toMatch(/no HR definitions/);
    expect(empty.stdout).toBe("");
  });

  it("usage: --file and --prefix are required, a prefix is upper-case, an extra positional is refused", async () => {
    expect((await check(scratch, ["--prefix", "HR"])).code).toBe(2);
    expect((await check(scratch, ["--file", "x.md"])).code).toBe(2);
    expect((await check(scratch, ["--file", "x.md", "--prefix", "hr"])).stderr).toMatch(/not an id prefix/);
    expect((await check(scratch, ["extra", "--file", "x.md", "--prefix", "HR"])).code).toBe(2);
    const sub = await runFamily(canonCommand, ["canon", "clause", "list"], scratch, false, { out: (): void => {}, err: (): void => {} }, defaultSeams());
    expect(sub).toBe(2);
    expect((await check(scratch, ["--file", "x.md", "--prefix", "HR", "--rules", "r"])).stderr).toMatch(/--rules is not read by 'canon clause check'/);
    expect((await check(scratch, ["--file", "x.md", "--prefix", "HR", "--body-from", "b"])).stderr).toMatch(/needs --leaves/);
  });

  it("--json carries the documented keys", async () => {
    const r = await hr(roster([def(1)]), "--json");
    expect(Object.keys(JSON.parse(r.stdout) as object)).toEqual(["contract", "repo", "file", "prefix", "definitions", "duplicates", "mismatches", "gaps", "base", "leaves", "exit"]);
  });
});

describe("nen canon clause check -- Akatsuki's CON form", () => {
  it("counts the column-0 bullet, never an indented or cited one", async () => {
    const file = roster(["# C", "", "## 1", "- **CON-1.** **One.** text", "  - **CON-9.** nested is no definition", "See CON-1.", "- **CON-2.** **Two.**"]);
    const r = await check(scratch, ["--file", file, "--prefix", "CON", "--json"]);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { definitions: number }).definitions).toBe(2);
    const dup = roster(["- **CON-4.** a", "- **CON-4.** b"]);
    expect((await check(scratch, ["--file", dup, "--prefix", "CON"])).code).toBe(1);
  });
});

describe("clause blocks and the leaf obligation's pieces", () => {
  it("a table-row definition's block is the row; a bullet's runs to the next definition or ## heading", () => {
    const text = [def(1), def(2), "", "- **CON-1.** One", "  more of one", "- **CON-2.** Two", "", "## Next", "not two"].join("\n");
    expect(clauseBlock(text, "HR", 1)).toBe(def(1));
    expect(clauseBlock(text, "CON", 1)).toBe("- **CON-1.** One\n  more of one");
    expect(clauseBlock(text, "CON", 2)).toBe("- **CON-2.** Two");
  });

  it("trailing blank lines are not a change; minted, removed and edited are told apart", () => {
    const before = ["- **CON-1.** One", "- **CON-2.** Two", "- **CON-3.** Three"].join("\n");
    const after = ["- **CON-1.** One", "", "", "- **CON-2.** Two, amended", "- **CON-4.** Four"].join("\n");
    expect(changedClauses(before, after, "CON")).toEqual({ minted: [4], removed: [3], edited: [2] });
  });

  it("a citation is a whole token: CON-2 is not CON-20 nor XCON-2", () => {
    expect(cites("see CON-2.", "CON", 2)).toBe(true);
    expect(cites("see CON-20", "CON", 2)).toBe(false);
    expect(cites("see XCON-2", "CON", 2)).toBe(false);
  });

  it("the opt-out needs a reason on its own line", () => {
    expect(leafOptOut("x\nno-leaf-change: wording only\n")).toBe("wording only");
    expect(leafOptOut("No-Leaf-Change:   \nreason on the next line")).toBeNull();
  });

  it("scan reports gaps from 1 to the highest id", () => {
    expect(scanClauses(["- **CON-1.** a", "- **CON-4.** b"].join("\n"), "CON").gaps).toEqual([2, 3]);
  });
});

describe("nen canon clause check --base and --leaves (a real repository)", () => {
  function repo(): { root: string; git: (...a: string[]) => string } {
    const root = join(scratch, `repo-${++k}`);
    mkdirSync(root, { recursive: true });
    const git = (...a: string[]): string => {
      const r = spawnSync("git", ["-C", root, "-c", "user.name=f", "-c", "user.email=f@f", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };
    const put = (rel: string, text: string): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put("CONSTITUTION.md", "# C\n\n## Rules\n\n- **CON-1.** One.\n- **CON-2.** Two.\n");
    put("agents/a.md", "Cites CON-1 and CON-20.\n");
    put("agents/b.md", "Cites CON-2.\n");
    put("docs/c.md", "Cites CON-1.\n");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("branch", "base");
    return { root, git };
  }

  it("an edited clause with an unchanged citer is a stale leaf (exit 1); changing the citer or opting out clears it", async () => {
    const { root } = repo();
    writeFileSync(join(root, "CONSTITUTION.md"), "# C\n\n## Rules\n\n- **CON-1.** One, amended.\n- **CON-2.** Two.\n");
    const r = await check(root, ["--file", "CONSTITUTION.md", "--prefix", "CON", "--base", "base:CONSTITUTION.md", "--leaves", "agents/*.md,docs/**/*.md", "--json"]);
    expect(r.code, r.stderr).toBe(1);
    const j = JSON.parse(r.stdout) as { base: { edited: string[]; kind: string }; leaves: { obligations: { id: string; citing: string[]; stale: string[] }[]; stale: number } };
    expect(j.base.kind).toBe("ref");
    expect(j.base.edited).toEqual(["CON-1"]);
    expect(j.leaves.obligations).toEqual([{ id: "CON-1", citing: ["agents/a.md", "docs/c.md"], stale: ["agents/a.md", "docs/c.md"] }]);
    writeFileSync(join(root, "agents/a.md"), "Cites CON-1 (amended) and CON-20.\n");
    writeFileSync(join(root, "docs/c.md"), "Cites CON-1, amended.\n");
    expect((await check(root, ["--file", "CONSTITUTION.md", "--prefix", "CON", "--base", "base:CONSTITUTION.md", "--leaves", "agents/*.md,docs/**/*.md"])).code).toBe(0);
  });

  it("the opt-out line in --body-from waives the obligation and is reported", async () => {
    const { root } = repo();
    writeFileSync(join(root, "CONSTITUTION.md"), "# C\n\n## Rules\n\n- **CON-1.** One, amended.\n- **CON-2.** Two.\n");
    writeFileSync(join(root, "body.md"), "## Summary\n\nno-leaf-change: a typo, the meaning is unchanged\n");
    const r = await check(root, ["--file", "CONSTITUTION.md", "--prefix", "CON", "--base", "base:CONSTITUTION.md", "--leaves", "agents/*.md", "--body-from", "body.md"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/stale leaf · CON-1 · agents\/a\.md/);
    expect(r.stdout).toMatch(/opt-out · no-leaf-change: a typo, the meaning is unchanged/);
  });

  it("a base given as a file reports minted and edited ids, and --leaves then refuses (no ref to compare with)", async () => {
    const { root } = repo();
    writeFileSync(join(root, "old.md"), "- **CON-1.** One.\n");
    const r = await check(root, ["--file", "CONSTITUTION.md", "--prefix", "CON", "--base", "old.md", "--json"]);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { base: { minted: string[]; kind: string } }).base).toMatchObject({ kind: "file", minted: ["CON-2"] });
    const leaves = await check(root, ["--file", "CONSTITUTION.md", "--prefix", "CON", "--base", "old.md", "--leaves", "agents/*.md"]);
    expect(leaves.code).toBe(2);
    expect(leaves.stderr).toMatch(/--leaves needs --base <ref>:<path>/);
  });

  it("a leaf pattern matching no tracked file, an unreadable base ref and a ref starting with '-' are tooling failures", async () => {
    const { root } = repo();
    expect((await check(root, ["--file", "CONSTITUTION.md", "--prefix", "CON", "--base", "base:CONSTITUTION.md", "--leaves", "nowhere/*.md"])).stderr).toMatch(/matches no tracked file/);
    expect((await check(root, ["--file", "CONSTITUTION.md", "--prefix", "CON", "--base", "nope:CONSTITUTION.md"])).code).toBe(2);
    expect((await check(root, ["--file", "CONSTITUTION.md", "--prefix", "CON", "--base", "missing-file.md"])).stderr).toMatch(/no such file, and not a <ref>:<path>/);
    expect((await check(root, ["--file", "CONSTITUTION.md", "--prefix", "CON", "--base", "-x:CONSTITUTION.md"])).code).toBe(2);
  });

  it("an unchanged clause owes nothing; a minted clause's citers are held too", async () => {
    const { root } = repo();
    writeFileSync(join(root, "CONSTITUTION.md"), "# C\n\n## Rules\n\n- **CON-1.** One.\n- **CON-2.** Two.\n- **CON-20.** Twenty.\n");
    const r = await check(root, ["--file", "CONSTITUTION.md", "--prefix", "CON", "--base", "base:CONSTITUTION.md", "--leaves", "agents/*.md"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/stale leaf · CON-20 · agents\/a\.md/);
    expect(r.stdout).not.toMatch(/agents\/b\.md/);
  });
});
