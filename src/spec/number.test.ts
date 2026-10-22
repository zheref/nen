import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { computeNext } from "./number.js";
import { fixtureCopy, spec } from "./testkit.testkit.js";

const SHA = "a".repeat(40);
const SLUG = "fixture-owner/fixture-spec";
const ok = (stdout: string): ScriptedCall["result"] => ({ code: 0, stdout, stderr: "", spawnFailed: false });
const fail = (stderr: string, code = 1): ScriptedCall["result"] => ({ code, stdout: "", stderr, spawnFailed: false });

function script(options: { base?: string; tree?: string; prs?: unknown; prResult?: ScriptedCall["result"]; rev?: ScriptedCall["result"]; origin?: boolean } = {}): ScriptedCall[] {
  const base = options.base ?? "main";
  return [
    { match: `git rev-parse --verify --quiet origin/${base}^{commit}`, result: options.rev ?? ok(`${SHA}\n`) },
    { match: `git ls-tree -d --name-only ${SHA} -- specs/`, result: ok(options.tree ?? "specs/001-sample-feature\nspecs/002-other-feature\nspecs/notes\n") },
    { match: "git remote get-url origin", result: ok(`git@github.com:${SLUG}.git\n`) },
    { match: `gh pr list --repo ${SLUG} --state open --limit 500 --json number,files`, result: options.prResult ?? ok(JSON.stringify(options.prs ?? [])) },
  ];
}

describe("nen spec number", () => {
  it("takes the highest {nnn} on origin/<base> and open PRs, plus one, reading the target from origin", async () => {
    const prs = [
      { number: 41, files: [{ path: "specs/005-reserved/spec.md" }, { path: "specs/005-reserved/tasks.md" }, { path: "README.md" }] },
      { number: 42, files: [{ path: "specs/002-other-feature/spec.md" }] },
    ];
    const run = await spec(["number", "--layout", "specs/{nnn}-{slug}"], fixtureCopy(), new ScriptedSeams(script({ prs })), true);
    expect(run.code).toBe(0);
    const report = run.json();
    expect(Object.keys(report)).toEqual(["contract", "repo", "target", "layout", "base", "baseSource", "baseSha", "openPrs", "taken", "collisions", "next", "reason"]);
    expect(report).toMatchObject({ contract: "nen.spec.number/v0.1", target: SLUG, base: "main", baseSource: "default: no nen/workflow.json", baseSha: SHA, openPrs: 2, collisions: [], next: "006", reason: null });
    expect(report["taken"]).toEqual([
      { nnn: "001", slug: "sample-feature", folder: "specs/001-sample-feature", source: "base", pr: null },
      { nnn: "002", slug: "other-feature", folder: "specs/002-other-feature", source: "base", pr: null },
      { nnn: "002", slug: "other-feature", folder: "specs/002-other-feature", source: "pr", pr: 42 },
      { nnn: "005", slug: "reserved", folder: "specs/005-reserved", source: "pr", pr: 41 },
    ]);
  });

  it("reads branch.base from nen/workflow.json and an explicit --target", async () => {
    const repo = fixtureCopy();
    mkdirSync(join(repo, "nen"));
    writeFileSync(join(repo, "nen", "workflow.json"), JSON.stringify({ branch: { template: "{descriptor}", base: "trunk" } }));
    const calls = script({ base: "trunk", tree: "" }).filter((call) => !call.match.startsWith("git remote"));
    const run = await spec(["number", "--layout", "specs/{nnn}-{slug}", "--target", SLUG], repo, new ScriptedSeams(calls), true);
    expect(run.code).toBe(0);
    expect(run.json()).toMatchObject({ base: "trunk", baseSource: "nen/workflow.json branch.base", next: "001", taken: [] });
  });

  it("names a collision and exits 1, picking no winner", async () => {
    const prs = [{ number: 7, files: [{ path: "specs/002-rival/spec.md" }] }];
    const run = await spec(["number", "--layout", "specs/{nnn}-{slug}"], fixtureCopy(), new ScriptedSeams(script({ prs })));
    expect(run.code).toBe(1);
    expect(run.out.join("\n")).toContain("collision: 002 claimed by more than one folder");
    expect(run.out.join("\n")).toContain("next: 003");
  });

  it.each([
    ["an unresolved base", { rev: fail("", 1) }, "does not resolve"],
    ["a gh failure", { prResult: fail("HTTP 401") }, "HTTP 401"],
    ["gh text that is not JSON", { prResult: ok("nope") }, "not JSON"],
    ["a PR with no files list", { prs: [{ number: 3 }] }, "no number or no files"],
    ["a PR at gh's file page size", { prs: [{ number: 9, files: Array.from({ length: 100 }, (_, index) => ({ path: `docs/${index}.md` })) }] }, "would be unread"],
    ["a list at the limit", { prs: Array.from({ length: 500 }, (_, index) => ({ number: index, files: [] })) }, "some may be unread"],
  ])("exits 1 on %s -- never 'no folders'", async (_name, options, words) => {
    const run = await spec(["number", "--layout", "specs/{nnn}-{slug}"], fixtureCopy(), new ScriptedSeams(script(options as Parameters<typeof script>[0])));
    expect(run.code).toBe(1);
    expect(run.err.join("\n")).toContain(words);
  });

  it.each([
    [["number"], "--layout is required"],
    [["number", "--layout", "../x/{nnn}-{slug}"], "--layout"],
    [["number", "--layout", "specs/{nnn}-{slug}", "--base=--evil"], "is not a branch name"], [["number", "--layout", "specs/{nnn}-{slug}", "--base", "a..b"], "is not a branch name"],
    [["number", "--layout", "specs/{nnn}-{slug}", "--target", "not-a-slug"], "owner/name"],
    [["number", "--layout", "specs/{nnn}-{slug}", "--folder", "x"], "is not read by 'spec number'"],
  ])("%j exits 2", async (argv, words) => {
    const run = await spec(argv, fixtureCopy(), new ScriptedSeams([]));
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toContain(words);
  });

  it("has no next value once 999 is taken", () => {
    expect(computeNext([{ nnn: "999", slug: "x", folder: "specs/999-x", source: "base", pr: null }])).toEqual({ next: null, collisions: [], reason: "999 is taken; a three-digit {nnn} has no next value" });
  });
});
