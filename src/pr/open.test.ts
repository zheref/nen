// src/pr/open.test.ts -- `nen pr open`, through the real dispatch and the
// fake seam: every refusal before the create, the one-per-head rule, the one
// create.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { prCommand } from "./command.js";
import { OPEN_CONTRACT } from "./open.js";

const SHA = "abc123abc123abc123abc123abc123abc123abc1";
const ON_WORK = { match: "git symbolic-ref --short HEAD", result: { stdout: "feature/work\n" } };
const TRACKED = { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { stdout: "origin/feature/work\n" } };
const LOCAL = { match: "git rev-parse feature/work", result: { stdout: `${SHA}\n` } };
const REMOTE = { match: "git ls-remote origin refs/heads/feature/work", result: { stdout: `${SHA}\trefs/heads/feature/work\n` } };
const NONE_OPEN = { match: "gh pr list --repo zheref/nen --head feature/work --state open --json number,url", result: { stdout: "[]\n" } };
const PUSHED: readonly ScriptedCall[] = [ON_WORK, TRACKED, LOCAL, REMOTE, NONE_OPEN];

interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly seams: ScriptedSeams;
}

/** A temp checkout holding a title file and a body file. */
function repo(title = "feat: the thing\n"): { root: string; titleFile: string; bodyFile: string } {
  const root = mkdtempSync(join(tmpdir(), "nen-pr-open-"));
  writeFileSync(join(root, "title.txt"), title, "utf8");
  writeFileSync(join(root, "body.md"), "## Why\n\nBecause.\n", "utf8");
  return { root, titleFile: "title.txt", bodyFile: join(root, "body.md") };
}

async function capture(root: string, argv: readonly string[], script: readonly ScriptedCall[] = [], json = false): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const seams = new ScriptedSeams(script);
  const code = await runFamily(prCommand, ["pr", "open", "--target", "zheref/nen", "--base", "main", "--title-file", "title.txt", "--body-file", "body.md", ...argv], root, json, io, seams);
  return { code, out, err, seams };
}

const calls = (seams: ScriptedSeams): readonly string[] => seams.calls.map((call): string => [call.command, ...call.args].join(" "));
const createArgv = (bodyFile: string, draft = false): string =>
  `gh pr create --repo zheref/nen --base main --head feature/work --title feat: the thing --body-file ${bodyFile}${draft ? " --draft" : ""}`;

describe("nen pr open -- refusals before anything is created", () => {
  it("refuses a missing --target, --base, --title-file or --body-file at exit 2", async () => {
    const { root } = repo();
    const io: Io = { out: (): void => {}, err: (): void => {} };
    for (const argv of [
      ["pr", "open", "--base", "main", "--title-file", "title.txt", "--body-file", "body.md"],
      ["pr", "open", "--target", "zheref/nen", "--title-file", "title.txt", "--body-file", "body.md"],
      ["pr", "open", "--target", "zheref/nen", "--base", "main", "--body-file", "body.md"],
      ["pr", "open", "--target", "zheref/nen", "--base", "main", "--title-file", "title.txt"],
    ]) {
      expect(await runFamily(prCommand, argv, root, false, io, new ScriptedSeams([])), argv.join(" ")).toBe(2);
    }
  });

  it("refuses an empty title file and a missing body file at exit 2, before any git call", async () => {
    const { root } = repo("\n\n");
    const empty = await capture(root, []);
    expect(empty.code).toBe(2);
    expect(empty.err.join("\n")).toMatch(/no non-empty line/);
    expect(empty.seams.calls).toEqual([]);
    const { root: other } = repo();
    const missing = await capture(other, ["--body-file", "nope.md"]);
    expect(missing.code).toBe(2);
    expect(missing.seams.calls).toEqual([]);
  });

  it("refuses a detached HEAD with no --head, at exit 2", async () => {
    const { root } = repo();
    const result = await capture(root, [], [{ match: "git symbolic-ref --short HEAD", result: { code: 128, stderr: "fatal: ref HEAD is not a symbolic ref" } }]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/HEAD is detached/);
  });

  it("refuses a head with no upstream, at exit 2, naming the publish verb", async () => {
    const { root } = repo();
    const result = await capture(root, [], [ON_WORK, { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { code: 128 } }]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/has no upstream/);
    expect(result.err.join("\n")).toMatch(/nen wc publish --set-upstream/);
  });

  it("refuses when origin holds nothing at the head, or a different sha, at exit 2", async () => {
    const { root } = repo();
    const nothing = await capture(root, [], [ON_WORK, TRACKED, LOCAL, { match: "git ls-remote origin refs/heads/feature/work", result: { stdout: "" } }]);
    expect(nothing.code).toBe(2);
    expect(nothing.err.join("\n")).toMatch(/origin holds nothing at 'refs\/heads\/feature\/work'/);
    const stale = await capture(root, [], [ON_WORK, TRACKED, LOCAL, { match: "git ls-remote origin refs/heads/feature/work", result: { stdout: "0000000000000000000000000000000000000000\trefs/heads/feature/work\n" } }]);
    expect(stale.code).toBe(2);
    expect(stale.err.join("\n")).toMatch(/is not what origin holds/);
    for (const result of [nothing, stale]) expect(calls(result.seams).some((call): boolean => call.startsWith("gh"))).toBe(false);
  });

  it("exits 1 naming the pull request already open for the head, creating nothing", async () => {
    const { root } = repo();
    const result = await capture(root, [], [
      ON_WORK, TRACKED, LOCAL, REMOTE,
      { match: "gh pr list --repo zheref/nen --head feature/work --state open --json number,url", result: { stdout: JSON.stringify([{ number: 231, url: "https://github.com/zheref/nen/pull/231" }]) } },
    ], true);
    expect(result.code).toBe(1);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc).toMatchObject({ contract: OPEN_CONTRACT, number: 231, url: "https://github.com/zheref/nen/pull/231", head: "feature/work", existing: true, dryRun: false });
    expect(calls(result.seams).some((call): boolean => call.startsWith("gh pr create"))).toBe(false);
  });
});

describe("nen pr open -- the create", () => {
  it("--dry-run prints the gh pr create argv, asks every question, creates nothing", async () => {
    const { root, bodyFile } = repo();
    const result = await capture(root, ["--dry-run", "--draft"], PUSHED, true);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["contract", "number", "url", "head", "base", "draft", "dryRun", "existing"]);
    expect(doc).toEqual({ contract: OPEN_CONTRACT, number: null, url: null, head: "feature/work", base: "main", draft: true, dryRun: true, existing: false });
    expect(calls(result.seams)).toEqual([
      "git symbolic-ref --short HEAD",
      "git rev-parse --abbrev-ref feature/work@{upstream}",
      "git rev-parse feature/work",
      "git ls-remote origin refs/heads/feature/work",
      "gh pr list --repo zheref/nen --head feature/work --state open --json number,url",
    ]);
    const text = await capture(root, ["--dry-run"], PUSHED);
    expect(text.out).toEqual([`would run: gh pr create --repo zheref/nen --base main --head feature/work --title "feat: the thing" --body-file ${bodyFile}`]);
  });

  it("creates through gh pr create and reads the number out of the url gh printed", async () => {
    const { root, bodyFile } = repo();
    const result = await capture(root, [], [...PUSHED, { match: createArgv(bodyFile), result: { stdout: "https://github.com/zheref/nen/pull/232\n" } }], true);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({ contract: OPEN_CONTRACT, number: 232, url: "https://github.com/zheref/nen/pull/232", head: "feature/work", base: "main", draft: false, dryRun: false, existing: false });
    const text = await capture(root, ["--draft"], [...PUSHED, { match: createArgv(bodyFile, true), result: { stdout: "https://github.com/zheref/nen/pull/233\n" } }]);
    expect(text.out).toEqual(["opened zheref/nen#233: https://github.com/zheref/nen/pull/233 (draft)"]);
  });

  it("--head names the branch instead of asking git which one is out", async () => {
    const { root, bodyFile } = repo();
    const result = await capture(root, ["--head", "feature/work"], [TRACKED, LOCAL, REMOTE, NONE_OPEN, { match: createArgv(bodyFile), result: { stdout: "https://github.com/zheref/nen/pull/234\n" } }]);
    expect(result.code).toBe(0);
    expect(calls(result.seams)).not.toContain("git symbolic-ref --short HEAD");
  });

  it("a create that prints no pull request url is exit 1, never reported as opened", async () => {
    const { root, bodyFile } = repo();
    const result = await capture(root, [], [...PUSHED, { match: createArgv(bodyFile), result: { stdout: "Warning: something\n" } }]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/returned no pull request URL/);
  });

  it("refuses open's own flags on the other pr subcommands", async () => {
    const { root } = repo();
    const io: Io = { out: (): void => {}, err: (): void => {} };
    for (const argv of [
      ["pr", "fetch", "--target", "zheref/nen", "--pr", "1", "--title-file", "t"],
      ["pr", "fetch", "--target", "zheref/nen", "--pr", "1", "--draft"],
      ["pr", "fetch", "--target", "zheref/nen", "--pr", "1", "--head", "x"],
    ]) {
      expect(await runFamily(prCommand, argv, root, false, io, new ScriptedSeams([])), argv.join(" ")).toBe(2);
    }
  });
});
