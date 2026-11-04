import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runFamily } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { canonCommand } from "./command.js";
import { checkedCanonFile, portPair, readHandbookManifest } from "./manifest.js";
import { clauseCites, type StatusVocabulary } from "./cites.js";
import { parseRepoRegistry } from "../schema/repos.js";
import { rewritePin } from "./pin-write.js";
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const scratch = (): string => { const root = mkdtempSync(join(tmpdir(), "nen-canon-batch-")); roots.push(root); mkdirSync(join(root, ".git")); return root; };
function put(root: string, file: string, text: string): void {
  const path = join(root, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
async function run(root: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const code = await runFamily(canonCommand, ["canon", ...args], root, true, { out: (line) => { out.push(line); }, err: (line) => { err.push(line); } }, new ScriptedSeams([]));
  return { code, out: out.join("\n"), err: err.join("\n") };
}
function canonFixture(): { root: string; canon: string; resolve: string[] } {
  const root = scratch(); const canon = scratch();
  put(root, "nen/repos.json", JSON.stringify({ consumers: [], maintained_tools: [{ repo: "o/consumer", scenario: "target" }] }));
  for (const file of ["a.md", "stacks/source/architecture.md", "stacks/target/architecture.md", "stacks/third/architecture.md", "stacks/target/rules/01.md", "ports/source--target.md", "ports/target--source.md"]) put(canon, `handbooks/${file}`, `# ${file}\n`);
  put(canon, "handbooks/INDEX.md", ["# Manifest", "## Always load", "| File |", "|---|", "| [a](a.md) |", "## Load exactly ONE stack handbook", "| Scenario | File |", "|---|---|", ...["source", "target", "third"].map((name) => `| \`${name}\` | [stack](stacks/${name}/architecture.md) |`)].join("\n"));
  return { root, canon, resolve: ["resolve", "--target", "o/consumer", "--manifest", "handbooks/INDEX.md", "--canon-root", canon] };
}

describe("pin commit surgical registry shape (#506)", () => {
  it("adds or updates the full commit without rewriting other fields/bytes", () => {
    const commit = "a".repeat(40);
    const text = '{"maintained_tools":[{"pinned":"v1.0.0","role":"canon","repo":"o/canon"}]}\n';
    const next = rewritePin(text, 0, "v2.0.0", "o/canon", commit).text;
    expect(next).toBe(text.replace('"pinned":"v1.0.0"', `"pinned":"v2.0.0", "pinnedCommit": "${commit}"`));
    expect(parseRepoRegistry("fixture", { consumers: [], ...JSON.parse(next) }).toolPinCommits).toEqual({ "o/canon": commit });
    const updated = rewritePin(next, 0, "v3.0.0", "o/canon", "b".repeat(40)).text;
    expect(updated).toContain(`"pinnedCommit": "${"b".repeat(40)}"`);
    expect(() => parseRepoRegistry("fixture", { consumers: [], maintained_tools: [{ repo: "o/canon", pinnedCommit: "short" }] })).toThrow(/maintained_tools\[0\].pinnedCommit/);
  });
});

describe("manifest availability and directed pairs (#569/#457)", () => {
  it("resolves a valid scenario in fresh builder/reviewer contexts and refuses unknown/missing/typed rows", async () => {
    const fixture = canonFixture();
    for (const role of ["builder", "reviewer"]) {
      const result = await run(fixture.root, fixture.resolve);
      expect(result.code, role + result.err).toBe(0);
      expect(JSON.parse(result.out)).toMatchObject({ alwaysLoad: ["handbooks/a.md"], stackHandbook: "handbooks/stacks/target/architecture.md", availability: "verified" });
    }
    for (const scenario of ["not-a-scenario", "constructor", "toString", null, 42]) {
      put(fixture.root, "nen/repos.json", JSON.stringify({ consumers: [], maintained_tools: [{ repo: "o/consumer", ...(scenario === null ? {} : { scenario }) }] }));
      const result = await run(fixture.root, fixture.resolve);
      expect(result.code).not.toBe(0);
      expect(result.err + result.out).toMatch(/scenario/);
      expect(result.err + result.out).toMatch(/maintained_tools|repos.json/);
    }
  });
  it("resolves a pair, returns absent null+reason and refuses self/outside scenarios at exit2", async () => {
    const f = canonFixture();
    const pair = await run(f.root, [...f.resolve, "--port-from", "source"]);
    expect(pair.code).toBe(0);
    expect(JSON.parse(pair.out).portHandbook).toBe("handbooks/ports/source--target.md");
    const absent = await run(f.root, [...f.resolve, "--port-from", "third"]);
    expect(absent.code).toBe(0);
    expect(JSON.parse(absent.out).portHandbook).toBe(null);
    expect(absent.err).toMatch(/no rulings file/);
    for (const from of ["target", "outside", "../source"]) {
      const result = await run(f.root, [...f.resolve, "--port-from", from]);
      expect(result.code).toBe(2);
      expect(result.err + result.out).toContain("--port-from");
    }
  });
  it("mirrors only incoming pair files and checks drift through generated markers", async () => {
    const f = canonFixture();
    put(f.root, "values.yml", "scenario: target\nsurfaces: claude-code\nvalues:\n");
    const args = ["mirror", "generate", "--source", "o/canon", "--ref", "v1.0.0", "--rules-dir", join(f.canon, "handbooks/stacks/target/rules"), "--canon-root", f.canon, "--canon-values", "values.yml"];
    const generated = await run(f.root, args);
    expect(generated.code, generated.err).toBe(0);
    const body = readFileSync(join(f.root, ".claude/rules/source--target.md"), "utf8");
    expect(body).toMatch(/source--target.md/);
    expect((await run(f.root, args.map((arg) => arg === "generate" ? "check" : arg))).code).toBe(0);
    put(f.root, ".claude/rules/source--target.md", body + "edited\n");
    expect((await run(f.root, args.map((arg) => arg === "generate" ? "check" : arg))).code).toBe(1);
  });
  it("refuses escaping manifest/handbook/pair links and dangling pair symlinks", () => {
    if (process.platform === "win32") return; // symlink privilege is not assumed on Windows.
    const f = canonFixture(); const outside = scratch(); put(outside, "secret.md", "outside");
    symlinkSync(join(outside, "secret.md"), join(f.canon, "outside.md"));
    expect(() => checkedCanonFile(f.canon, "outside.md")).toThrow(/inside canon root/);
    symlinkSync(join(outside, "secret.md"), join(f.canon, "handbooks/ports/third--target.md"));
    expect(() => portPair(f.canon, "handbooks/ports", "third", "target", ["third", "target"])).toThrow(/inside canon root/);
    rmSync(join(f.canon, "handbooks/ports/third--target.md"));
    symlinkSync(join(outside, "missing"), join(f.canon, "handbooks/ports/third--target.md"));
    expect(() => portPair(f.canon, "handbooks/ports", "third", "target", ["third", "target"])).toThrow();
    put(f.canon, "handbooks/INDEX.md", "## Always load\n| [outside](../outside.md) |\n## Load exactly ONE stack handbook\n| `target` | [stack](stacks/target/architecture.md) |");
    expect(() => readHandbookManifest(f.canon, "handbooks/INDEX.md")).toThrow(/canon root/);
  });
});

const vocabulary: StatusVocabulary = { whole: ["ruled", "constitution"], none: ["reading"], displacement: ["reversed by", "superseded by"], unannotated: { CON: "constitution" } };
describe("clause citation closure (#554)", () => {
  it("matches Hatsu #505 fixture cited/followed read sets byte-for-byte", () => {
    const root = scratch();
    const def = (n: number, status: string): string => `| <a id="hr-${n}"></a>**HR-${n}** (${status}) a ruling | settles |`;
    put(root, "ROSTER.md", ["| HR | What |", "|---|---|", def(1, "ruled"), def(2, "reading"), def(3, "superseded by HR-4 (its first half; the rest stands)"), def(4, "ruled"), def(5, "reversed by HR-6"), def(6, "ruled"), def(10, "ruled"), def(20, "ruled")].join("\n"));
    put(root, "CONSTITUTION.md", [4, 5, 6, 7, 47, 15].map((n) => `- **CON-${n}.** **Clause ${n}.** Reserved to the human.`).join("\n"));
    // Request and expected listed arrays copied from Hatsu's
    // scripts/constitution_check_fixture.mts (cited/followed cases).
    for (const [request, expected] of [
      ["Leans on HR-1 and on HR-20.", ["HR-1", "HR-20"]],
      ["Cites HR-2.", []],
      ["Implements HR-3.", ["HR-3(part)", "HR-4"]],
      ["Per HR-5.", ["HR-6"]],
      ["Bound by CON-15.", ["CON-15"]],
    ] as const) {
      put(root, "request.md", request);
      const report = clauseCites({ root, text: "request.md", homes: { HR: "ROSTER.md", CON: "CONSTITUTION.md" }, vocabulary });
      expect(JSON.stringify(report.readSet)).toBe(JSON.stringify(expected));
      expect(report.exit).toBe(0);
    }
    put(root, "request.md", "HR-1 HR-1 HR-3 HR-99 CON-9");
    const report = clauseCites({ root, text: "request.md", homes: { HR: "ROSTER.md", CON: "CONSTITUTION.md" }, vocabulary });
    expect(report.dangling).toEqual(["CON-9", "HR-99"]);
    expect(report.exit).toBe(1);
    expect(report.clauses.filter((clause) => clause.id === "HR-1")).toHaveLength(1);
    expect(report.clauses.find((clause) => clause.id === "HR-3")).toMatchObject({ binding: "part", displacedBy: ["HR-4"], line: 5 });
  });
  it("reads a Status column, follows chains/cycles and refuses unreadable or empty homes", async () => {
    const root = scratch();
    put(root, "home.md", '| Clause | Status |\n|---|---|\n| <a id="p-1"></a>**P-1** | superseded by P-2 |\n| <a id="p-2"></a>**P-2** | ruled |');
    put(root, "request.md", "P-1"); put(root, "vocabulary.json", JSON.stringify(vocabulary));
    const result = await run(root, ["clause", "cites", "--text", "request.md", "--home", "P=home.md", "--status-vocabulary", "vocabulary.json"]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out).readSet).toEqual(["P-2"]);
    put(root, "home.md", '| Clause | Status |\n|---|---|\n| <a id="p-1"></a>**P-1** | superseded by P-2 |\n| <a id="p-2"></a>**P-2** | reversed by P-3 (part) |\n| <a id="p-3"></a>**P-3** | superseded by P-1 |');
    const closure = clauseCites({ root, text: "request.md", homes: { P: "home.md" }, vocabulary });
    expect(closure.clauses.map((row) => row.id)).toEqual(["P-1", "P-2", "P-3"]);
    expect(closure.readSet).toEqual(["P-2(part)"]);
    const included = clauseCites({ root, text: "request.md", homes: { P: "home.md" }, vocabulary, include: ["P-2"] });
    expect(included.clauses.find((row) => row.id === "P-2")?.via).toContain("included");
    for (const args of [["--text", "missing.md", "--home", "P=home.md"], ["--text", "request.md", "--home", "p=home.md"]]) {
      expect((await run(root, ["clause", "cites", ...args, "--status-vocabulary", "vocabulary.json"])).code).toBe(2);
    }
    put(root, "request.md", "P-99");
    expect((await run(root, ["clause", "cites", "--text", "request.md", "--home", "P=home.md", "--status-vocabulary", "vocabulary.json"])).code).toBe(1);
    put(root, "empty.md", "# no definitions");
    for (const home of ["empty.md", "missing.md"]) expect((await run(root, ["clause", "cites", "--text", "request.md", "--home", `P=${home}`, "--status-vocabulary", "vocabulary.json"])).code).toBe(2);
  });
});
