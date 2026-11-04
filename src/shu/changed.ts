import { plainLine } from "../cli/plain.js";
import { emit, VerbUsageError, type CommandContext } from "../cli/command.js";
import { scrubbedGitEnv } from "../wc/worktree.js";
import { GIT_ENV } from "../schema/canonmirror.js";
import { GIT } from "../seam/exec.js";
import { loadWorkflow } from "../schema/workflow.js";
import { openDeclaration } from "./declaration.js";
import { globToRegExp } from "./evidence/glob.js";

/** Map a committed merge-base diff; this function never executes a selected lane. */
export function changedLanes(context: CommandContext, root: string): number {
  if (context.args.positionals.length !== 2 || context.args.passthrough.length) throw new VerbUsageError("--changed accepts no positional selection or passthrough arguments.");
  for (const flag of Object.keys(context.args.values)) if (!["repo", "base"].includes(flag)) throw new VerbUsageError(`--${flag} is not read by --changed; selection runs no lanes.`);
  for (const flag of context.args.booleans) if (!["changed", "dry-run", "json", "help"].includes(flag)) throw new VerbUsageError(`--${flag} is not read by --changed.`);
  for (const [flag, values] of Object.entries(context.args.lists)) if (values.length) throw new VerbUsageError(`--${flag} is not read by --changed.`);
  const { project } = openDeclaration(root);
  const base = context.args.values["base"] ?? `origin/${loadWorkflow(root).workflow.branch.base}`;
  if (!base || base.startsWith("-") || /[\x00-\x1f\x7f]/.test(base)) throw new VerbUsageError("--base must be a non-option Git reference.");
  const read = context.seams.run(GIT, ["--no-replace-objects", "--no-lazy-fetch", "diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--no-renames", `${base}...HEAD`, "--"], { cwd: root, env: { ...scrubbedGitEnv(context.seams.env), ...GIT_ENV, GIT_NO_LAZY_FETCH: "1" } });
  if (read.code !== 0 || read.spawnFailed) { context.io.err(`changed lane selection could not read the diff: ${read.stderr}`); return 1; }
  if (read.stdout !== "" && !read.stdout.endsWith("\0")) { context.io.err("changed lane selection received incomplete NUL-delimited Git paths"); return 1; }
  const listed = read.stdout === "" ? [] : read.stdout.slice(0, -1).split("\0");
  if (listed.some(path => path === "")) { context.io.err("changed lane selection received an empty Git path"); return 1; }
  const paths = [...new Set(listed)].sort();
  const declared = Object.values(project.lanes).filter(lane => lane.paths?.length);
  const selected = declared.flatMap(lane => {
    // Git paths may contain line breaks; globstar still means every character.
    const rules = lane.paths!.map(pattern => new RegExp(globToRegExp(pattern).source, "s"));
    const matched = paths.filter(path => rules.some(rule => rule.test(path)));
    return matched.length ? [{ lane: lane.name, paths: matched }] : [];
  });
  const covered = new Set(selected.flatMap(lane => lane.paths));
  const uncovered = paths.filter(path => !covered.has(path));
  const undeclared = Object.values(project.lanes).filter(lane => !lane.paths?.length).map(lane => lane.name);
  emit(context.io, context.json, { contract: "nen.shu.changed/v0.1", base, paths, selected, uncovered, undeclared, executed: false }, [...selected.map(row => `selected ${plainLine(row.lane)}: ${row.paths.map(plainLine).join(", ")}`), ...uncovered.map(path => `uncovered: ${plainLine(path)}`), ...undeclared.map(lane => `undeclared: ${plainLine(lane)}`), "selection only: no lane executed"]);
  return 0;
}
