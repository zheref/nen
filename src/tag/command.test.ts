import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { tagCommand } from "./command.js";

async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  // `null` is a real case: the invocation that never typed --repo (zheref/nen#28).
  repoFlag: string | null = BANKAI_REPO,
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const seams: Seams = new ScriptedSeams(script);
  const code = await runFamily(tagCommand, argv, repoFlag, false, io, seams);
  return { code, out, err };
}

describe("nen tag cut -- CLI wiring", () => {
  it("cuts a local-only tag by default", async () => {
    const result = await capture(["tag", "cut", "--name", "v1.0.0", "--at", "abc"], [
      { match: "git ls-remote --tags origin v1.0.0", result: { stdout: "" } },
      { match: "git tag -l v1.0.0", result: { stdout: "" } },
      { match: "git merge-base --is-ancestor abc origin/main", result: { code: 0 } },
      { match: "git tag -a -m v1.0.0 v1.0.0 abc", result: {} },
    ]);
    expect(result.code).toBe(0);
    expect(result.out.some((l): boolean => l.includes("NOT pushed"))).toBe(true);
  });

  it("--push actually pushes", async () => {
    const result = await capture(["tag", "cut", "--name", "v1.0.0", "--at", "abc", "--push"], [
      { match: "git ls-remote --tags origin v1.0.0", result: { stdout: "" } },
      { match: "git tag -l v1.0.0", result: { stdout: "" } },
      { match: "git merge-base --is-ancestor abc origin/main", result: { code: 0 } },
      { match: "git tag -a -m v1.0.0 v1.0.0 abc", result: {} },
      { match: "git push origin v1.0.0", result: {} },
    ]);
    expect(result.code).toBe(0);
  });

  // zheref/nen#28: the usage line lists --repo unbracketed, so omitting it is
  // refused by name -- a tag verb must never default to whatever repository
  // the process happens to be standing in.
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["tag", "cut", "--name", "v1.0.0", "--at", "abc"], [], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("requires --name and --at", async () => {
    expect((await capture(["tag", "cut"])).code).toBe(2);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["tag", "bogus"])).code).toBe(2);
  });
});
