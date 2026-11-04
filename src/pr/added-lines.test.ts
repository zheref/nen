import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { defaultSeams, type Seams, type CommandResult } from "../seam/exec.js";
import { addedLines, nextId } from "./added-lines.js";
import { compileEre } from "./ere.js";
import { prCommand } from "./command.js";
import { runFamily } from "../index.js";
const target = { owner: "o", repo: "n", slug: "o/n" }; const path = "handbooks/ports/a--b.md";
const A = "a".repeat(40), M = "b".repeat(40), H = "c".repeat(40), D = "d".repeat(40);
const BASE = "| PT-1 | one |\n| PT-2 | two |\n| PT-3 | three |\n";
function fixture(options: { collision?: boolean; advanced?: boolean; fail?: boolean; truncated?: boolean; oversized?: boolean; malformed?: boolean; moved?: boolean; base?: string; noPulls?: boolean } = {}): { seams: Seams; calls: string[] } {
  const calls: string[] = []; const records: Record<string, unknown> = {};
  const contents = { [A]: options.base ?? (options.advanced ? BASE.replace("one", "upstream edit") : BASE), [M]: BASE, [H]: BASE + "| PT-4 | added |\n", [D]: options.collision ? BASE + "| PT-4 | competing |\n" : BASE };
  const pulls = [H, D].map((sha, index) => ({ number: index + 1, state: "open", head: { ref: `effort-${index + 1}`, sha }, base: { sha: A } }));
  records["repos/o/n"] = { default_branch: "main" }; records["repos/o/n/commits/main"] = { sha: A };
  records["repos/o/n/pulls?state=open&per_page=100&page=1"] = options.noPulls ? [] : pulls;
  for (const pull of pulls) {
    records[`repos/o/n/compare/${A}...${pull.head.sha}`] = { merge_base_commit: { sha: M } };
    records[`repos/o/n/pulls/${pull.number}`] = options.moved && pull.number === 1 ? { ...pull, head: { ...pull.head, sha: D } } : pull;
  }
  let treeNumber = 1;
  for (const [sha, text] of Object.entries(contents)) {
    const tree = String(treeNumber++).repeat(40); const bytes = Buffer.from(text);
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    records[`repos/o/n/git/commits/${sha}`] = { sha, tree: { sha: tree } };
    records[`repos/o/n/git/trees/${tree}?recursive=1`] = { sha: tree, truncated: options.truncated && sha === H || false, tree: [{ path: options.malformed && sha === H ? null : path, type: "blob", mode: "100644", sha: blob }] };
    records[`repos/o/n/git/blobs/${blob}`] = { sha: blob, encoding: "base64", content: bytes.toString("base64"), size: options.oversized && sha === H ? 9 * 1024 * 1024 : bytes.length };
  }
  const seams: Seams = { ...defaultSeams(), run: (command, args): CommandResult => {
    expect(command).toBe("gh"); expect(args.slice(0, 3)).toEqual(["api", "--method", "GET"]);
    const endpoint = args[3] as string; calls.push(endpoint);
    if (options.fail && endpoint === `repos/o/n/compare/${A}...${H}`) return { spawnFailed: false, code: 1, stdout: "", stderr: "HTTP 403 rate limit" };
    if (!Object.hasOwn(records, endpoint)) throw new Error(`unscripted ${endpoint}`);
    return { spawnFailed: false, code: 0, stdout: JSON.stringify(records[endpoint]), stderr: "" };
  } };
  return { seams, calls };
}

describe("complete open-PR added lines and next stable id (#456)", () => {
  it("uses the actual PR merge base, not the advanced base tip", () => {
    const f = fixture({ advanced: true }); const report = addedLines(f.seams, target, path, compileEre("^\\| PT-[[:digit:]]+"));
    expect(report.complete).toBe(true);
    expect(report.lines.map((line) => line.text)).toEqual(["| PT-4 | added |"]);
    expect(report.lines[0]).toMatchObject({ pr: 1, headRef: "effort-1", headSha: H, baseSha: M });
  });
  it("reports both competing PR sources for id4 and refuses allocation; clean next id is5", () => {
    const collision = nextId(fixture({ collision: true }).seams, target, path, "PT", null);
    expect(collision.complete).toBe(false); expect(collision.nextId).toBe(null); expect(collision.collisions).toEqual([4]);
    expect(collision.ids.filter((row) => row.id === 4).map((row) => row.source)).toEqual([`PR #1 (effort-1@${H})`, `PR #2 (effort-2@${D})`]);
    const clean = nextId(fixture().seams, target, path, "PT", null);
    expect(clean.complete).toBe(true); expect(clean.nextId).toBe(5); expect(clean.ids.map((row) => row.id)).toEqual([1, 2, 3, 4]);
  });
  it("names failed PR reads, truncated trees and budget failures, never allocating from partial reads", () => {
    for (const options of [{ fail: true }, { truncated: true }, { oversized: true }, { malformed: true }, { moved: true }]) {
      const report = nextId(fixture(options).seams, target, path, "PT", null);
      expect(report.complete).toBe(false); expect(report.nextId).toBe(null); expect(report.errors.join(" ")).toContain("PR #1");
    }
    expect(() => nextId(fixture({ noPulls: true, base: "row\n".repeat(100_001) }).seams, target, path, "PT", null)).toThrow(/row budget/);
  });
  it("serves the public commands through maintainer gh auth and returns named rate-limit refusal", async () => {
    for (const [verb, tail] of [["added-lines", ["--pattern", "^\\| PT-[[:digit:]]+"]], ["next-id", ["--prefix", "PT"]]] as const) {
      const out: string[] = [];
      const code = await runFamily(prCommand, ["pr", verb, "--target", "o/n", "--path", path, ...tail, "--json"], null, true, { out: (line) => { out.push(line); }, err: () => {} }, fixture({ fail: true }).seams);
      expect(code).toBe(1); expect(out.join("\n")).toContain("rate limit");
    }
  });
});

describe("bounded POSIX ERE filter", () => {
  const matches = (pattern: string, text: string): boolean => compileEre(pattern).match(text).kind === "match";
  it("preserves branch-local anchors, grouped alternatives, C classes and escaped metacharacters", () => {
    expect(matches("^foo|bar$", "foobarjunk")).toBe(true); expect(matches("^foo|bar$", "xxbar")).toBe(true);
    expect(matches("^(foo|bar)$", "foobarjunk")).toBe(false);
    expect(matches("^[[:upper:]][[:digit:]]+[[:space:]]\\+$", "A12 +")).toBe(true);
    expect(matches("[[:punct:]]", "abc!def")).toBe(true); expect(matches("[[:alpha:]]", "123")).toBe(false);
    expect(matches("[^^]", "x")).toBe(true); expect(matches("[[]", "[")).toBe(true);
    expect(matches(".", "\r")).toBe(true); expect(matches("^..$", "é")).toBe(true); // C-locale UTF-8 bytes.
  });
  it("refuses unsupported syntax explicitly and bounds adversarial repetitions", () => {
    for (const pattern of ["(?=a)", "\\1", "[[.ch.]]", "[[:unknown:]]", "(^a|b$)"]) expect(() => compileEre(pattern)).toThrow();
    expect(compileEre("(a+)+$").match("a".repeat(1000) + "!").kind).not.toBe("match");
  });
});

it("reads page2 of open PRs and refuses a page2 failure instead of using the first100 (#456)", async () => {
  const f = fixture(); const rows = Array.from({ length: 101 }, (_, index) => ({ number: index + 1, state: "open", head: { ref: `effort-${index + 1}`, sha: H }, base: { sha: A } }));
  const source = (fail: boolean): Seams => ({ ...f.seams, run: (command, args, options): CommandResult => {
    const endpoint = args[3] as string;
    if (endpoint.includes("pulls?state=open")) {
      if (endpoint.endsWith("page=2") && fail) return { spawnFailed: false, code: 1, stdout: "", stderr: "HTTP403 page2 rate limit" };
      const page = endpoint.endsWith("page=1") ? rows.slice(0, 100) : rows.slice(100);
      return { spawnFailed: false, code: 0, stdout: JSON.stringify(page), stderr: "" };
    }
    const pull = /^repos\/o\/n\/pulls\/(\d+)$/.exec(endpoint);
    if (pull !== null) return { spawnFailed: false, code: 0, stdout: JSON.stringify(rows[Number(pull[1]) - 1]), stderr: "" };
    return f.seams.run(command, args, options);
  } });
  const report = addedLines(source(false), target, path); expect(report.complete).toBe(true); expect(report.pulls).toHaveLength(101); expect(report.lines.at(-1)?.pr).toBe(101);
  expect(() => addedLines(source(true), target, path)).toThrow(/page2 rate limit/);
  const out: string[] = [];
  expect(await runFamily(prCommand, ["pr", "next-id", "--target", "o/n", "--path", path, "--prefix", "PT", "--json"], null, true, { out: (line) => { out.push(line); }, err: () => {} }, source(true))).toBe(1);
  expect(JSON.parse(out.join("\n"))).toMatchObject({ complete: false }); expect(out.join("\n")).toContain("page2 rate limit");
});
