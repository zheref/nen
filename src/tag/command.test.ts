import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { proofCalls, SHA } from "./fixtures.js";
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
  const seams: Seams = new ScriptedSeams(script.map(call => ({...call,match:call.match.startsWith("git ") ? call.match.replace("git ","git --no-replace-objects --no-lazy-fetch ") : call.match})));
  const code = await runFamily(tagCommand, argv, repoFlag, false, io, seams);
  return { code, out, err };
}

describe("nen tag cut -- CLI wiring", () => {
  it("cuts an explicit marker locally without pushing", async () => {
    const result = await capture(["tag", "cut", "--name", "v1.0.0", "--at", "abc123", "--previous-tag", "v0.9.0", "--mode", "marker"], [
      { match: "git ls-remote --tags origin v1.0.0", result: { stdout: "" } },
      { match: "git tag -l v1.0.0", result: { stdout: "" } },
      ...proofCalls(),
      { match: `git tag -a -m v1.0.0\n\nmode: marker\nuncollated fragments: 0 v1.0.0 ${SHA}`, result: {} },
    ]);
    expect(result.code).toBe(0);
    expect(result.out.some((l): boolean => l.includes("NOT pushed"))).toBe(true);
  });

  it("--push actually pushes", async () => {
    const result = await capture(["tag", "cut", "--name", "v1.0.0", "--at", "abc123", "--previous-tag", "v0.9.0", "--mode", "marker", "--push"], [
      { match: "git ls-remote --tags origin v1.0.0", result: { stdout: "" } },
      { match: "git tag -l v1.0.0", result: { stdout: "" } },
      ...proofCalls(),
      { match: `git tag -a -m v1.0.0\n\nmode: marker\nuncollated fragments: 0 v1.0.0 ${SHA}`, result: {} },
      { match: "git push origin v1.0.0", result: {} },
    ]);
    expect(result.code).toBe(0);
  });

  it("marker cuts with counted fragments while default release refuses without a tag write",async()=>{
    const reads:ScriptedCall[]=[{match:"git ls-remote --tags origin v1.0.0",result:{}},{match:"git tag -l v1.0.0",result:{}},...proofCalls().map(call=>call.match.includes("ls-tree") ? {...call,result:{stdout:"changelog.d/123.md\0"}} : call)];
    const args=["tag","cut","--name","v1.0.0","--at","abc123","--previous-tag","v0.9.0"];
    const marker=await capture([...args,"--mode","marker"],[...reads,{match:`git tag -a -m v1.0.0\n\nmode: marker\nuncollated fragments: 1 v1.0.0 ${SHA}`,result:{}}]);
    expect(marker.code).toBe(0);
    const release=await capture(args,reads);expect(release.code).toBe(1);expect(release.err.join(" ")).toContain("uncollated fragment");
  });
  // zheref/nen#28: the usage line lists --repo unbracketed, so omitting it is
  // refused by name -- a tag verb must never default to whatever repository
  // the process happens to be standing in.
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["tag", "cut", "--name", "v1.0.0", "--at", "abc123", "--previous-tag", "v0.9.0", "--mode", "marker"], [], null);
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
