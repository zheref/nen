import { plainLine } from "../cli/plain.js";
import { existsSync } from "node:fs";
import { relative, resolve, isAbsolute, sep } from "node:path";
import { emit, requireRepoFlag, VerbUsageError, type CommandContext } from "../cli/command.js";
import { assertRepoRoot } from "../repo/root.js";
import { GIT } from "../seam/exec.js";

/** Stage literal repository paths, including tracked paths deleted from disk. */
export function stage(context: CommandContext): number {
  const root = assertRepoRoot({ repoFlag: requireRepoFlag(context, "It is the index being staged.") });
  if (context.args.passthrough.length && context.args.positionals.length > 2) throw new VerbUsageError("wc stage accepts paths before or after --, not both.");
  for (const flag of Object.keys(context.args.values)) if (flag !== "repo") throw new VerbUsageError(`--${flag} is not read by wc stage.`);
  for (const flag of context.args.booleans) if (!["dry-run", "json"].includes(flag)) throw new VerbUsageError(`--${flag} is not read by wc stage.`);
  const paths = context.args.passthrough.length ? context.args.passthrough : context.args.positionals.slice(2);
  if (!paths.length) throw new VerbUsageError("wc stage requires repository-relative paths after --.");
  for (const path of paths) {
    const rel = relative(root, resolve(root, path));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(path) || path.includes("\0")) throw new VerbUsageError(`wc stage refuses a path outside --repo: ${plainLine(path)}`);
  }
  const selected: string[] = [];
  const skipped: string[] = [];
  for (const path of paths) {
    if (existsSync(resolve(root, path))) { selected.push(path); continue; }
    const tracked = context.seams.run(GIT, ["ls-files", "--cached", "-z", "--", `:(top,literal)${path}`], { cwd: root });
    if (tracked.code !== 0 || tracked.spawnFailed) { context.io.err("wc stage could not read tracked deletions; nothing staged."); return 1; }
    (tracked.stdout.length ? selected : skipped).push(path);
  }
  const args = ["add", "-A", "--", ...selected.map(path => `:(top,literal)${path}`)];
  if (context.args.booleans.has("dry-run")) {
    emit(context.io, context.json, { verdict: "dry-run", paths: selected, skipped }, paths.map(path => `would stage: ${plainLine(path)}`));
    return 0;
  }
  const result = selected.length ? context.seams.run(GIT, args, { cwd: root }) : { code: 0, spawnFailed: false, stderr: "" };
  if (result.code !== 0 || result.spawnFailed) { context.io.err(`wc stage failed: ${result.stderr}`); return 1; }
  emit(context.io, context.json, { verdict: "staged", paths: selected, skipped }, [...selected.map(path => `staged: ${plainLine(path)}`), ...skipped.map(path => `skipped (absent and untracked): ${plainLine(path)}`)]);
  return 0;
}
