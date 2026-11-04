// Whole-tree comparison over immutable local Git objects; no cut-point policy.
import { scrubbedGitEnv } from "../wc/worktree.js";
import { GIT_ENV } from "../schema/canonmirror.js";
import { GIT, type Seams } from "../seam/exec.js";
export const COMPARE_CONTRACT = "nen.release.compare/v0.1";
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
export function compareTrees(seams: Seams, root: string, left: string, right: string): { contract: string; outcome: "equal" | "different" | "unreadable"; compared: "whole-git-tree"; left: { input: string; sha: string; tree: string } | null; right: { input: string; sha: string; tree: string } | null; reason: string | null } {
  const read = (input: string): { input: string; sha: string; tree: string } => {
    if (!SHA.test(input)) throw new Error(`'${input}' is not an immutable full commit/object SHA`);
    const git = (args: string[]): string => {
      const result = seams.run(GIT, ["--no-replace-objects", "--no-lazy-fetch", "-C", root, ...args], { env: { ...scrubbedGitEnv(seams.env), ...GIT_ENV, GIT_NO_LAZY_FETCH: "1" } });
      if (result.code !== 0) throw new Error(`${input}: git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
      return result.stdout.trim();
    };
    const sha = git(["rev-parse", "--verify", `${input}^{commit}`]);
    const tree = git(["rev-parse", "--verify", `${sha}^{tree}`]);
    if (!SHA.test(sha) || !SHA.test(tree)) throw new Error(`${input}: Git returned an incomplete commit/tree identity`);
    const objects = git(["rev-list", "--objects", "--missing=print", "--no-walk", sha]).split("\n");
    if (!objects.includes(sha) || !objects.some((line) => line.split(" ")[0] === tree) || objects.some((line) => line.startsWith("?"))) throw new Error(`${input}: object closure is missing or incomplete`);
    return { input, sha, tree };
  };
  let before: ReturnType<typeof read> | null = null; let after: ReturnType<typeof read> | null = null;
  try { before = read(left); after = read(right); return { contract: COMPARE_CONTRACT, outcome: before.tree === after.tree ? "equal" : "different", compared: "whole-git-tree", left: before, right: after, reason: null }; }
  catch (error) { return { contract: COMPARE_CONTRACT, outcome: "unreadable", compared: "whole-git-tree", left: before, right: after, reason: error instanceof Error ? error.message : String(error) }; }
}
