// `nen pr ledger post|read` (zheref/nen#510, #512 folded in): one comment per
// effort, edited in place, read back only from the authenticated login, the
// findings checked by the caller's schema, never truncated, and restorable
// on a fresh clone. gh is scripted; the ledgers are real files.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { FULL_REACH_ROW, privateListRow, visibilityRow, withPrivateTarget } from "../issue/privacy.testkit.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { prCommand } from "./command.js";
import { commentsArgv, renderComment, type LedgerSlice } from "./ledger.js";

const TARGET = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const NOT_A_REPO: ScriptedCall = { match: "git rev-parse --path-format=absolute --git-common-dir", result: { code: 128, stderr: "fatal: not a git repository" } };
const PHASE = { phase: "rasengan", startedAt: "2026-10-23T00:00:00.000Z", endedAt: "2026-10-23T00:10:00.000Z", durationMs: 600000, exitCode: 0, surface: "claude-code", model: "opus", note: null, steps: [], dial: null };
const SCHEMA = join(process.cwd(), "src", "pr", "fixtures", "findings.schema.json");

function effortRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "nen-pr-ledger-"));
  mkdirSync(join(root, ".nen", "phases"), { recursive: true });
  writeFileSync(join(root, ".nen", "phases", "HA%2F12.json"), JSON.stringify({ contract: "nen.phase.ledger/v0.1", effort: "HA/12", phases: [PHASE] }));
  return root;
}

const pull = (head = HEAD): ScriptedCall => ({ match: "gh api repos/zheref/nen/pulls/7", result: { stdout: JSON.stringify({ number: 7, head: { sha: head } }) } });
const me: ScriptedCall = { match: "gh api user", result: { stdout: JSON.stringify({ login: "maintainer" }) } };
const comments = (rows: readonly { id: number; login: string; body: string; editor?: string }[]): ScriptedCall => ({
  match: ["gh", ...commentsArgv(TARGET, 7, null)].join(" "),
  result: {
    stdout: JSON.stringify({
      data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: rows.map((row) => ({ databaseId: row.id, author: { login: row.login }, editor: row.editor === undefined ? null : { login: row.editor }, body: row.body, url: `https://github.com/zheref/nen/pull/7#issuecomment-${row.id}` })) } } } },
    }),
  },
});
const created: ScriptedCall = { match: "gh api -X POST repos/zheref/nen/issues/7/comments --input -", result: { stdout: JSON.stringify({ html_url: "https://github.com/zheref/nen/pull/7#issuecomment-900" }) } };
const edited = (id: number): ScriptedCall => ({ match: `gh api -X PATCH repos/zheref/nen/issues/comments/${id} --input -`, result: { stdout: JSON.stringify({ html_url: `https://github.com/zheref/nen/pull/7#issuecomment-${id}` }) } });

async function run(argv: readonly string[], root: string, script: readonly ScriptedCall[]): Promise<{ code: number; out: string; err: string; seams: ScriptedSeams }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => { out.push(line); }, err: (line): void => { err.push(line); } };
  const seams = new ScriptedSeams([NOT_A_REPO, ...script]);
  const code = await runFamily(prCommand, argv, root, argv.includes("--json"), io, withPrivateTarget(seams, "zheref/nen"));
  return { code, out: out.join("\n"), err: err.join("\n"), seams };
}

const POST = ["pr", "ledger", "post", "--target", "zheref/nen", "--pr", "7", "--effort", "HA/12"];
const READ = ["pr", "ledger", "read", "--target", "zheref/nen", "--pr", "7", "--effort", "HA/12"];

function sliceFor(head = HEAD, phases: readonly unknown[] = [PHASE]): LedgerSlice {
  return { contract: "nen.pr.ledger/v0.1", effort: "HA/12", repo: "zheref/nen", pr: 7, head, phases: phases as LedgerSlice["phases"], usage: { entries: 0, totals: [] }, findings: null, proof: [] };
}

describe("nen pr ledger post (zheref/nen#510)", () => {
  it("AC-1: posts one marked comment holding the slice, phases from the durable ledger and a proof index", async () => {
    const root = effortRepo();
    writeFileSync(join(root, "proof.json"), "{}\n");
    const result = await run([...POST, "--proof", "proof.json", "--json"], root, [pull(), me, comments([]), created]);
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out) as { verdict: string; url: string; slice: LedgerSlice };
    expect(document.verdict).toBe("posted");
    expect(document.url).toBe("https://github.com/zheref/nen/pull/7#issuecomment-900");
    expect(document.slice.phases).toEqual([PHASE]);
    expect(document.slice.proof).toEqual([{ path: "proof.json", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: 3 }]);
    const posted = result.seams.calls.find((call) => call.args.includes("POST"));
    const body = (JSON.parse(posted?.stdin ?? "{}") as { body: string }).body;
    expect(body.split("\n")[0]).toMatch(/^<!-- nen:ledger effort=HA%2F12 sha256=[0-9a-f]{64} -->$/);
    expect(body).toContain("```json");
  });

  it("AC-3: posting again edits the marked comment in place, and the same bytes are 'unchanged'", async () => {
    const root = effortRepo();
    const body = renderComment(sliceFor());
    const same = await run(POST, root, [pull(), me, comments([{ id: 55, login: "maintainer", body }])]);
    expect(same.code).toBe(0);
    expect(same.out).toMatch(/^unchanged:/);
    expect(same.seams.calls.some((call) => call.args.includes("PATCH") || call.args.includes("POST"))).toBe(false);
    const moved = await run([...POST, "--json"], root, [pull(MOVED), me, comments([{ id: 55, login: "maintainer", body }]), edited(55)]);
    expect(JSON.parse(moved.out).verdict).toBe("updated");
    expect(moved.seams.calls.some((call) => call.args.includes("POST"))).toBe(false);
  });

  it("AC-2: a findings file that fails its schema exits 1 naming the pointer, and posts nothing", async () => {
    const root = effortRepo();
    writeFileSync(join(root, "findings.json"), JSON.stringify({ scopes: [], findings: [{ id: "F1", scope: "s", persona: "p", rule: "HR-10", severity: "critical", path: "a", line: 1, evidence: "e", proposedFix: "f", disposition: { state: "pushed-back", detail: "no" } }] }));
    const result = await run([...POST, "--findings", "findings.json", "--findings-schema", SCHEMA], root, []);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/fails --findings-schema at \/findings\/0\/disposition\/state/);
    expect(result.seams.calls.filter((call) => call.command === "gh")).toEqual([]);
  });

  it("validates a findings file that meets the schema, and records the schema's id and digest", async () => {
    const root = effortRepo();
    writeFileSync(join(root, "findings.json"), JSON.stringify({ scopes: [], findings: [] }));
    const result = await run([...POST, "--findings", "findings.json", "--findings-schema", SCHEMA, "--dry-run", "--json"], root, [pull(), me, comments([])]);
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out) as { verdict: string; slice: LedgerSlice };
    expect(document.verdict).toBe("dry-run");
    expect(document.slice.findings?.schema.id).toBe("hatsu.hanten.findings/v0.1");
    expect(result.seams.calls.some((call) => call.args.includes("POST"))).toBe(false);
  });

  it("AC-4: refuses a slice over GitHub's comment limit, naming both sizes, never truncating", async () => {
    const root = effortRepo();
    writeFileSync(join(root, "findings.json"), JSON.stringify({ scopes: [], findings: [], notes: "x".repeat(70_000) }));
    writeFileSync(join(root, "open.schema.json"), JSON.stringify({ type: "object" }));
    const result = await run([...POST, "--findings", "findings.json", "--findings-schema", "open.schema.json"], root, [pull(), me, comments([])]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/renders to \d+ characters, over GitHub's 65536-character comment limit/);
    expect(result.seams.calls.some((call) => call.args.includes("POST"))).toBe(false);
  });

  it("AC-8: --dry-run prints the gh call and the body and writes nothing", async () => {
    const root = effortRepo();
    const result = await run([...POST, "--dry-run"], root, [pull(), me, comments([])]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("would run: gh api -X POST repos/zheref/nen/issues/7/comments --input -");
    expect(result.out).toContain("<!-- nen:ledger effort=HA%2F12");
  });

  it("refuses at exit 2: no --effort, a schema keyword it cannot assert, --findings alone, read's --restore", async () => {
    const root = effortRepo();
    writeFileSync(join(root, "findings.json"), "{}");
    writeFileSync(join(root, "fmt.schema.json"), JSON.stringify({ format: "email" }));
    expect((await run(["pr", "ledger", "post", "--target", "zheref/nen", "--pr", "7"], root, [])).code).toBe(2);
    expect((await run([...POST, "--findings", "findings.json", "--findings-schema", "fmt.schema.json"], root, [])).code).toBe(2);
    expect((await run([...POST, "--findings", "findings.json"], root, [])).code).toBe(2);
    expect((await run([...POST, "--restore"], root, [])).code).toBe(2);
    expect((await run(["pr", "ledger", "bogus", "--target", "zheref/nen", "--pr", "7", "--effort", "x"], root, [])).code).toBe(2);
  });
});

describe("nen pr ledger read (zheref/nen#510)", () => {
  it("AC-5: returns the slice from this login's marked comment, ok at the current head", async () => {
    const root = effortRepo();
    const result = await run([...READ, "--json"], root, [pull(), me, comments([{ id: 55, login: "maintainer", body: renderComment(sliceFor()) }])]);
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out) as { verdict: string; login: string; foreign: number; slice: LedgerSlice };
    expect(document).toMatchObject({ verdict: "ok", login: "maintainer", foreign: 0 });
    expect(document.slice.phases).toEqual([PHASE]);
  });

  it("AC-5: reports stale when the PR's head moved, and could-not-read when there is none", async () => {
    const root = effortRepo();
    const stale = await run([...READ, "--json"], root, [pull(MOVED), me, comments([{ id: 55, login: "maintainer", body: renderComment(sliceFor()) }])]);
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.out).verdict).toBe("stale");
    const none = await run([...READ, "--json"], root, [pull(), me, comments([])]);
    expect(none.code).toBe(1);
    expect(JSON.parse(none.out).verdict).toBe("could-not-read");
  });

  it("AC-7: a marked comment by another login is counted as foreign and never read", async () => {
    const root = effortRepo();
    const result = await run([...READ, "--json"], root, [pull(), me, comments([{ id: 56, login: "someone-else", body: renderComment(sliceFor()) }])]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ verdict: "could-not-read", foreign: 1 });
  });

  it("refuses an edited or malformed comment by name (#512 AC-3)", async () => {
    const root = effortRepo();
    const edited = renderComment(sliceFor()).replace('"rasengan"', '"kokusen"');
    const result = await run(READ, root, [pull(), me, comments([{ id: 55, login: "maintainer", body: edited }])]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/could-not-read: .*edited/);
    const broken = await run(READ, root, [pull(), me, comments([{ id: 55, login: "maintainer", body: "<!-- nen:ledger effort=HA%2F12 sha256=zz -->\nnothing" }])]);
    expect(broken.out).toMatch(/could-not-read: .*marker line is malformed/);
  });

  it("AC-6: --restore writes the phase ledger on a fresh clone, agrees with itself, refuses a disagreeing local ledger", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "nen-pr-ledger-fresh-"));
    const script = [pull(), me, comments([{ id: 55, login: "maintainer", body: renderComment(sliceFor()) }])];
    const restored = await run([...READ, "--restore"], fresh, script);
    expect(restored.code).toBe(0);
    const path = join(fresh, ".nen", "phases", "HA%2F12.json");
    expect(existsSync(path)).toBe(true);
    expect((JSON.parse(readFileSync(path, "utf8")) as { phases: unknown[] }).phases).toEqual([PHASE]);
    expect((await run([...READ, "--restore"], fresh, script)).out).toContain("unchanged:");
    writeFileSync(path, JSON.stringify({ contract: "nen.phase.ledger/v0.1", effort: "HA/12", phases: [] }));
    const refused = await run([...READ, "--restore"], fresh, script);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/disagrees with the slice/);
    expect((JSON.parse(readFileSync(path, "utf8")) as { phases: unknown[] }).phases).toEqual([]);
  });
});

describe("settle round on #518 (Feitan 1, 2, 5; Nobunaga 9, 10)", () => {
  it("SEC-1: refuses a slice that carries a credential's shape, naming the field and never the value", async () => {
    const root = effortRepo();
    // built at runtime from a placeholder, so no literal token sits in the repository
    const token = ["gh", "p_", "Z".repeat(4), "9".repeat(32)].join("");
    writeFileSync(join(root, "findings.json"), JSON.stringify({ evidence: `curl -H "Authorization: ${token}"` }));
    writeFileSync(join(root, "open.schema.json"), JSON.stringify({ type: "object" }));
    const result = await run([...POST, "--findings", "findings.json", "--findings-schema", "open.schema.json", "--dry-run"], root, [pull(), me, comments([])]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/findings\.document: GitHub token/);
    expect(result.err).not.toContain(token);
    expect(result.out).not.toContain(token);
  });

  it("SEC-7: a marked comment of ours edited by another login is foreign on read and refused on post", async () => {
    const root = effortRepo();
    const body = renderComment(sliceFor());
    const read = await run([...READ, "--json"], root, [pull(), me, comments([{ id: 55, login: "maintainer", editor: "intruder", body }])]);
    expect(read.code).toBe(1);
    expect(JSON.parse(read.out)).toMatchObject({ verdict: "could-not-read", foreign: 1 });
    const post = await run(POST, root, [pull(), me, comments([{ id: 55, login: "maintainer", editor: "intruder", body }])]);
    expect(post.code).toBe(1);
    expect(post.err).toMatch(/last edited by intruder/);
  });

  it("SEC-8: step argv names the repository as '.', and a --proof outside the repository is refused", async () => {
    const root = effortRepo();
    writeFileSync(join(root, ".nen", "phases", "HA%2F12.json"), JSON.stringify({ contract: "nen.phase.ledger/v0.1", effort: "HA/12", phases: [{ ...PHASE, steps: [{ verb: "build", argv: `bun ${root}/src/index.ts`, exitCode: 0, durationMs: 1, stalled: false }] }] }));
    const result = await run([...POST, "--dry-run", "--json"], root, [pull(), me, comments([])]);
    const slice = (JSON.parse(result.out) as { slice: LedgerSlice }).slice;
    expect(slice.phases[0]?.steps?.[0]?.argv).toBe("bun ./src/index.ts");
    const outside = join(mkdtempSync(join(tmpdir(), "nen-pr-ledger-out-")), "p.json");
    writeFileSync(outside, "{}");
    expect((await run([...POST, "--proof", outside], root, [])).code).toBe(2);
  });

  it("--login names the poster when the token cannot read 'user'", async () => {
    const root = effortRepo();
    const result = await run([...READ, "--login", "app[bot]", "--json"], root, [pull(), comments([{ id: 55, login: "app[bot]", body: renderComment(sliceFor()) }])]);
    expect(result.code).toBe(0);
    expect(result.seams.calls.some((call) => call.args.join(" ") === "api user")).toBe(false);
  });

  it("--restore on a stale slice restores and says the exit is 1 because it is stale", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "nen-pr-ledger-stale-"));
    const result = await run([...READ, "--restore"], fresh, [pull(MOVED), me, comments([{ id: 55, login: "maintainer", body: renderComment(sliceFor()) }])]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/restored: .*from a STALE slice/);
  });
});

describe("the private-name guard judges only the caller's text (Bugbot on #518)", () => {
  // A private repository named "ledger": the word nen's own marker and summary carry.
  const guardRows: readonly ScriptedCall[] = [visibilityRow("zheref/nen", "public"), FULL_REACH_ROW, privateListRow(["someone/ledger"])];
  async function publicRun(argv: readonly string[], root: string, script: readonly ScriptedCall[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => { out.push(line); }, err: (line): void => { err.push(line); } };
    const code = await runFamily(prCommand, argv, root, false, io, new ScriptedSeams([NOT_A_REPO, ...guardRows, ...script]));
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("passes when the private name appears only in nen's marker and summary", async () => {
    const root = effortRepo();
    const result = await publicRun([...POST, "--dry-run"], root, [pull(), me, comments([])]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("<!-- nen:ledger effort=");
  });

  it("refuses at exit 4 when the private name is in a phase note the caller wrote", async () => {
    const root = effortRepo();
    writeFileSync(join(root, ".nen", "phases", "HA%2F12.json"), JSON.stringify({ contract: "nen.phase.ledger/v0.1", effort: "HA/12", phases: [{ ...PHASE, note: "ported from ledger" }] }));
    const result = await publicRun([...POST, "--dry-run"], root, [pull(), me, comments([])]);
    expect(result.code).toBe(4);
    expect(result.err).toMatch(/phases\[0\]\.note/);
  });
});

it("refuses at exit 4 a private name in the caller schema's $id, which the comment prints (Nobunaga delta on #518)", async () => {
  const root = effortRepo();
  writeFileSync(join(root, "findings.json"), JSON.stringify({ scopes: [] }));
  writeFileSync(join(root, "id.schema.json"), JSON.stringify({ $id: "https://github.com/someone/ledger/blob/main/findings.schema.json", type: "object" }));
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => { out.push(line); }, err: (line): void => { err.push(line); } };
  const seams = new ScriptedSeams([NOT_A_REPO, visibilityRow("zheref/nen", "public"), FULL_REACH_ROW, privateListRow(["someone/ledger"]), pull(), me, comments([])]);
  const code = await runFamily(prCommand, [...POST, "--findings", "findings.json", "--findings-schema", "id.schema.json", "--dry-run"], root, false, io, seams);
  expect(code).toBe(4);
  expect(err.join("\n")).toMatch(/findings\.schema\.id/);
});
