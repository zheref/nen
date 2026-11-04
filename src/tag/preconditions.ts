// CON-41's marker/release split, read only at the immutable target commit.
import { GH, GIT, type Seams } from "../seam/exec.js";
import { scrubbedGitEnv } from "../wc/worktree.js";
import { GIT_ENV } from "../schema/canonmirror.js";
import { parseRemoteUrl } from "../github/target.js";
import { remoteHost } from "../canon/checkout.js";
import { resolveHoldState } from "../release/hold.js";
import { reconcileChangelog } from "../changelog/reconcile.js";
import { openingDatedSection } from "../changelog/completeness.js";
export interface TagPreconditions { readonly mode: "marker" | "release"; readonly previousTag: string; readonly trunk?: string; readonly changelog?: string; readonly fragmentDir?: string }
export type TagProof = { ok: true; sha: string; mode: "marker" | "release"; fragmentCount: number } | { ok: false; exit: 1 | 2; reason: string };
class Unreadable extends Error {}
export function checkTagPreconditions(seams: Seams, cwd: string, at: string, name: string, options: TagPreconditions): TagProof {
  const env = { ...scrubbedGitEnv(seams.env), ...GIT_ENV, GIT_NO_LAZY_FETCH: "1" };
  const git = (args: string[]): string => {
    const result = seams.run(GIT, ["--no-replace-objects", "--no-lazy-fetch", ...args], { cwd, env });
    if (result.code !== 0 || result.spawnFailed) throw new Unreadable(`git ${args[0]}: ${result.stderr.trim() || `exit ${result.code}`}`);
    return result.stdout;
  };
  try {
    const trunk = options.trunk ?? "main";
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trunk) || trunk.includes("..") || trunk.endsWith("/")) throw new Unreadable("--trunk must name one exact branch");
    if (at.startsWith("-") || /[\0\r\n]/.test(at)) throw new Unreadable("--at must name a commit without options");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(options.previousTag) || options.previousTag.includes("..")) throw new Unreadable("--previous-tag must name a release tag");
    const remote = git(["remote", "get-url", "origin"]).trim(); const target = parseRemoteUrl(remote); const host = remoteHost(remote);
    if (target === null || host === null) throw new Unreadable("origin is not a readable GitHub repository identity");
    const hold = resolveHoldState(seams.run(GH, ["variable", "get", "RELEASE_HOLD", "--repo", target.slug], { cwd, env: { GH_HOST: host } }), "RELEASE_HOLD");
    if (hold.kind === "unreadable") throw new Unreadable(`RELEASE_HOLD could not be read: ${hold.detail}`);
    if (hold.kind === "held") return { ok: false, exit: 1, reason: `RELEASE_HOLD is active: ${hold.value}` };
    const previous = seams.run(GIT, ["--no-replace-objects", "--no-lazy-fetch", "rev-parse", "--verify", "--quiet", `refs/tags/${options.previousTag}^{commit}`], { cwd, env });
    if (previous.code === 1 && !previous.spawnFailed) return { ok: false, exit: 1, reason: `previous release tag '${options.previousTag}' is missing` };
    if (previous.code !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(previous.stdout.trim())) throw new Unreadable(`previous release tag '${options.previousTag}' could not be read`);
    const sha = git(["rev-parse", "--verify", "--end-of-options", `${at}^{commit}`]).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) throw new Unreadable("target commit could not be resolved to an immutable SHA");
    git(["fetch", "origin", trunk]);
    const ancestor = seams.run(GIT, ["--no-replace-objects", "--no-lazy-fetch", "merge-base", "--is-ancestor", sha, `origin/${trunk}`], { cwd, env });
    if (ancestor.spawnFailed || ancestor.code > 1 || ancestor.code < 0) throw new Unreadable(`could not test reachability against origin/${trunk}`);
    if (ancestor.code === 1) return { ok: false, exit: 1, reason: `${sha} is not an ancestor of origin/${trunk}` };
    const fragmentDir = options.fragmentDir ?? "changelog.d"; const changelog = options.changelog ?? "CHANGELOG.md";
    for (const path of [fragmentDir, changelog]) if (path === "" || path.startsWith("/") || path.split(/[\\/]/).some((part) => part === ".." || part === ".") || /[\0\r\n:]/.test(path)) throw new Unreadable("changelog and fragment paths must stay inside the target tree");
    const listing = git(["ls-tree", "-r", "--name-only", "-z", sha, "--", `:(literal)${fragmentDir}`]);
    const fragments = listing.split("\0").filter((path) => path !== "" && !path.endsWith("/.gitkeep"));
    if (options.mode === "marker") return { ok: true, sha, mode: options.mode, fragmentCount: fragments.length };
    if (fragments.length > 0) return { ok: false, exit: 1, reason: `${fragmentDir}/ is not empty at ${sha}: ${fragments.length} uncollated fragment(s)` };
    const text = git(["show", `${sha}:${changelog}`]).replace(/\r\n?/g, "\n");
    if (openingDatedSection(text) !== name || !new RegExp(`^#{2,3} +${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*\\b[0-9]{4}-[0-9]{2}-[0-9]{2}\\b`, "m").test(text)) return { ok: false, exit: 1, reason: `${name} has no current dated CHANGELOG section; Unreleased has not been moved` };
    const unreleased = /^#{2,3} Unreleased\s*\n([\s\S]*?)(?=^#{2,3} |$(?![\s\S]))/m.exec(text)?.[1];
    if (unreleased === undefined || unreleased.trim() !== "_(nothing awaiting release.)_") return { ok: false, exit: 1, reason: "CHANGELOG Unreleased is not explicitly empty after collation" };
    const range = `${previous.stdout.trim()}..${sha}`;
    const heading = new RegExp(`^#{2,3} +${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "m").exec(text);
    if (heading === null) throw new Unreadable("dated target section could not be bounded");
    const after = text.slice(heading.index); const depth = /^#+/.exec(heading[0])?.[0].length ?? 2; const next = new RegExp(`^#{1,${depth}} `, "m").exec(after.slice(after.indexOf("\n") + 1));
    const section = next === null ? after : after.slice(0, after.indexOf("\n") + 1 + next.index);
    const fenced: Seams = { ...seams, run: (command, args, runOptions) => seams.run(command, command === GIT ? ["--no-replace-objects", "--no-lazy-fetch", ...args] : args, { ...runOptions, ...(command === GIT ? { env } : {}) }) };
    const reconciliation = reconcileChangelog(fenced, cwd, { range, changelogPath: changelog, changelogText: section, ownerRepo: target.slug, fragmentNames: [] });
    if (reconciliation.releasePrAllowance?.verdict === "terminal-unreadable" || reconciliation.releasePrAllowance?.verdict === "history-unreadable") throw new Unreadable(reconciliation.releasePrAllowance.detail);
    if (!reconciliation.ok) return { ok: false, exit: 1, reason: `CON-33 range is not reconciled: missing PRs ${reconciliation.missing.join(", ")}` };
    return { ok: true, sha, mode: options.mode, fragmentCount: 0 };
  } catch (error) { return { ok: false, exit: 2, reason: error instanceof Error ? error.message : String(error) }; }
}
