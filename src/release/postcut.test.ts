import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runFamily } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { makeTempDir } from "../testing/tempdir.js";
import { releaseCommand } from "./command.js";

const SHA = "a".repeat(40), OTHER = "b".repeat(40), TAG = "v1.1.0";
async function read(listing: string, post = true, extra: string[] = [], failRead = false): Promise<{code: number; out: string; err: string; seams: ScriptedSeams}> {
  const root = makeTempDir("nen-postcut-");
  writeFileSync(join(root, "CHANGELOG.md"), "No merged pull requests.\n");
  writeFileSync(join(root, "chores.json"), "[]");
  const calls: ScriptedCall[] = [
    {match: "gh variable get RELEASE_HOLD --repo o/r", result: {code: 1, stderr: "variable RELEASE_HOLD was not found"}},
    {match: "git log --merges --format=%s --end-of-options v1.0.0..main", result: {stdout: ""}},
    {match: "git ls-remote --tags origin", result: failRead ? {code: 128, stderr: "remote unavailable"} : {stdout: listing}},
  ];
  const seams = new ScriptedSeams(calls), out: string[] = [], err: string[] = [];
  const args = ["release", "preflight", "--repo-slug", "o/r", "--tag", TAG, "--range", "v1.0.0..main", "--changelog", "CHANGELOG.md", "--owner-repo", "o/r", "--critical-issues", "", "--live-chores-from", "chores.json", "--json", ...(post ? ["--expect-tag-at", SHA] : [])];
  for (let index = 0; index < extra.length; index += 2) {
    const flag = extra[index]!, value = extra[index + 1]!;
    const found = args.indexOf(flag);
    if (found >= 0) args[found + 1] = value;
    else args.push(flag, value);
  }
  const code = await runFamily(releaseCommand, args, root, false, {out: s => void out.push(s), err: s => void err.push(s)}, seams);
  return {code, out: out.join("\n"), err: err.join("\n"), seams};
}

describe("post-cut preflight (#649)", () => {
  it.each([`${SHA}\trefs/tags/${TAG}\n`, `${OTHER}\trefs/tags/${TAG}\n${SHA}\trefs/tags/${TAG}^{}\n`])("passes a lightweight or peeled annotated tag at the expected commit", async listing => {
    const result = await read(listing);
    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.ok).toBe(true);
    expect(report.checks.at(-1)).toMatchObject({name: "tag exists at expected commit", ok: true});
  });
  it.each([["", "absent"], [`${OTHER}\trefs/tags/${TAG}\n`, "another commit"]])("fails and names absence or mismatch", async (listing, reason) => {
    const result = await read(listing);
    expect(result.code, result.err).toBe(1);
    expect(JSON.parse(result.out).checks.at(-1)).toMatchObject({ok: false, detail: expect.stringContaining(reason)});
  });
  it("keeps every other row and pre-cut behavior unchanged", async () => {
    const before = await read("", false), after = await read(`${SHA}\trefs/tags/${TAG}\n`);
    expect(before.code, before.err).toBe(0);
    expect(after.code, after.err).toBe(0);
    expect(JSON.parse(after.out).checks.slice(0,-1)).toEqual(JSON.parse(before.out).checks.slice(0,-1));
    const present = await read(`${SHA}\trefs/tags/${TAG}\n`, false);
    expect(present.code).toBe(1);
    expect(JSON.parse(present.out).checks.at(-1).name).toBe("tag does not already exist");
  });
  it.each([`garbage\n`, `${SHA}\trefs/tags/${TAG}^{}\n`, `${SHA}\trefs/tags/${TAG}\n${OTHER}\trefs/tags/${TAG}\n`])("refuses malformed or ambiguous remote evidence", async listing => {
    const result = await read(listing);
    expect(result.code, result.err).toBe(1);
    expect(JSON.parse(result.out).checks.at(-1).detail).toContain("unreadable");
  });
  it("does not turn a failed remote read into an absent tag", async () => {
    const result = await read("", true, [], true);
    expect(result.code).toBe(1);
    expect(result.err).toContain("remote unavailable");
    expect(result.out).not.toContain("absent");
  });
  it("rejects an abbreviated expected commit before remote reads", async () => {
    const result = await read("", false, ["--expect-tag-at", "abc123"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("40");
    expect(result.seams.calls).toHaveLength(0);
  });
});

it("refuses a peeled-ref selector as the caller's tag name", async () => {
  const result = await read(`${OTHER}\trefs/tags/${TAG}\n${SHA}\trefs/tags/${TAG}^{}\n`, true, ["--tag", `${TAG}^{}`]);
  expect(result.code).toBe(2);
  expect(result.seams.calls).toHaveLength(0);
});
it("does not waive another failing row in post-cut mode", async () => {
  const result = await read(`${SHA}\trefs/tags/${TAG}\n`, true, ["--critical-issues", "1"]);
  expect(result.code).toBe(1);
  const report = JSON.parse(result.out);
  expect(report.checks.at(-1).ok).toBe(true);
  expect(report.checks.find((row: {name: string}) => row.name === "open critical issues").ok).toBe(false);
});
it("refuses the new flag on another release verb", async () => {
  const seams = new ScriptedSeams([]), err: string[] = [];
  const code = await runFamily(releaseCommand, ["release", "resolve-target", "--expect-tag-at", SHA], null, false, {out: () => {}, err: s => void err.push(s)}, seams);
  expect(code).toBe(2);
  expect(err.join("\n")).toContain("read only by release preflight");
  expect(seams.calls).toHaveLength(0);
});
