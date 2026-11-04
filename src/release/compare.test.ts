import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultSeams } from "../seam/exec.js";
import { scrubbedGitEnv } from "../wc/worktree.js";
import { runFamily } from "../index.js";
import { releaseCommand } from "./command.js";
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const env = { ...process.env, ...scrubbedGitEnv(process.env), GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_CONFIG_NOSYSTEM: "1" };
function git(root: string, args: string[], input?: string): string {
  const result = spawnSync("git", ["-C", root, "-c", "commit.gpgSign=false", ...args], { env, encoding: "utf8", input });
  if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim();
}
function graph(): { root: string; initial: string; judged: string; delivery: string; merged: string; same: string } {
  const root = mkdtempSync(join(tmpdir(), "nen-compare-race-")); roots.push(root); git(root, ["init", "-q"]);
  writeFileSync(join(root, "manifest.json"), '{"version":"0.123.0"}\n'); git(root, ["add", "."]); git(root, ["commit", "-qm", "initial"]); const initial = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "manifest.json"), '{"version":"0.124.0"}\n'); git(root, ["commit", "-qam", "reviewed proposal363"]); const judged = git(root, ["rev-parse", "HEAD"]);
  const same = git(root, ["commit-tree", git(root, ["rev-parse", `${judged}^{tree}`]), "-p", judged, "-m", "different commit, same reviewed tree"]);
  git(root, ["checkout", "-q", initial]); writeFileSync(join(root, "manifest.json"), '{"version":"0.125.0"}\n'); mkdirSync(join(root, "changelog.d")); writeFileSync(join(root, "changelog.d", "ha-355.md"), "delivery367 fragment\n"); git(root, ["add", "."]); git(root, ["commit", "-qm", "delivery367"]); const delivery = git(root, ["rev-parse", "HEAD"]);
  // Offline replay of the recorded 363/367 race: delivery and judged proposal
  // are the merge parents; the merged state retains later manifest+fragment.
  const merged = git(root, ["commit-tree", git(root, ["rev-parse", `${delivery}^{tree}`]), "-p", delivery, "-p", judged, "-m", "raced merge363"]);
  return { root, initial, judged, delivery, merged, same };
}
async function compare(root: string, left: string, right: string, extra: string[] = []): Promise<{ code: number; report: Record<string, unknown>; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const code = await runFamily(releaseCommand, ["release", "compare", "--left", left, "--right", right, ...extra, "--json"], root, true, { out: (line) => { out.push(line); }, err: (line) => { err.push(line); } }, defaultSeams());
  return { code, report: out.length === 0 ? {} : JSON.parse(out.join("\n")), err: err.join("\n") };
}
describe("public immutable whole-tree comparison (#572)", () => {
  it("distinguishes same-tree commits and the recorded raced graph, without changing refs/worktree", async () => {
    const g = graph(); const refs = git(g.root, ["show-ref"]); const head = git(g.root, ["rev-parse", "HEAD"]); const index = readFileSync(join(g.root, ".git/index"));
    const same = await compare(g.root, g.judged, g.same); expect(same.code, same.err).toBe(0); expect(same.report.outcome).toBe("equal");
    expect(same.report.left).toMatchObject({ sha: g.judged }); expect(same.report.right).toMatchObject({ sha: g.same });
    const race = await compare(g.root, g.judged, g.merged); expect(race.code).toBe(1); expect(race.report.outcome).toBe("different"); expect(race.report.compared).toBe("whole-git-tree");
    expect(git(g.root, ["show-ref"])).toBe(refs); expect(git(g.root, ["rev-parse", "HEAD"])).toBe(head); expect(readFileSync(join(g.root, ".git/index"))).toEqual(index);
    expect(readFileSync(join(g.root, "manifest.json"), "utf8")).toContain("0.125.0"); expect(git(g.root, ["status", "--porcelain"])).toBe("");
  });
  it("returns unreadable for missing refs and nested tree/blob objects, never equality", async () => {
    for (const kind of ["tree", "blob"]) {
      const g = graph(); const object = git(g.root, ["rev-parse", kind === "tree" ? `${g.merged}:changelog.d` : `${g.merged}:changelog.d/ha-355.md`]);
      rmSync(join(g.root, ".git/objects", object.slice(0, 2), object.slice(2)));
      const missing = await compare(g.root, g.merged, g.merged); expect(missing.code).toBe(3); expect(missing.report.outcome).toBe("unreadable");
    }
    const g = graph(); for (const ref of ["f".repeat(40), "main"]) expect((await compare(g.root, g.judged, ref)).code).toBe(3);
  });
  it("scrubs ambient repository redirects and refuses unrelated release intent", async () => {
    const g = graph(); const empty = mkdtempSync(join(tmpdir(), "nen-compare-empty-")); roots.push(empty); git(empty, ["init", "-q"]);
    const saved = process.env.GIT_DIR; process.env.GIT_DIR = join(g.root, ".git");
    try { const result = await compare(empty, g.judged, g.judged); expect(result.code).toBe(3); expect(result.report.outcome).toBe("unreadable"); }
    finally { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; }
    const foreignOut: string[] = [];
    const foreign = await runFamily(releaseCommand, ["release", "resolve-target", "--left", g.judged, "--token", "main"], g.root, false, { out: () => {}, err: (line) => { foreignOut.push(line); } }, defaultSeams());
    expect(foreign).toBe(2); expect(foreignOut.join(" ")).toContain("only read by release compare");
    const refusal = await compare(g.root, g.judged, g.same, ["--tag", "v1.0.0"]); expect(refusal.code).toBe(2); expect(refusal.err).toContain("--tag is not read");
  });
});
