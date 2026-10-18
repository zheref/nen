import publishGates from "./publish-gates.json";
import { plainLine } from "../cli/plain.js";
// The six-gate published-branch update. No first publication or implicit persona.
import { emit, requireRepoFlag, requireValue, VerbUsageError, type CommandContext } from "../cli/command.js";
import { assertRepoRoot } from "../repo/root.js";
import { GIT, type Seams } from "../seam/exec.js";
import { loadWorkflow, type Workflow } from "../schema/workflow.js";
import { runVerb } from "../shu/run.js";
import { catchUp } from "./catchup.js";
import { publish } from "./publish.js";
import { scrubbedGitEnv } from "./worktree.js";

class GateFailure extends Error {}

/** Same identity/trailer and clean-base-merge tests as the outgoing author guard. */
export function outgoingAuthorship(seams: Seams, root: string, upstream: string, trunk: string, persona: string): void {
  const git = (args: string[]): string => {
    const result = seams.run(GIT, args, { cwd: root, env: scrubbedGitEnv(seams.env) });
    if (result.spawnFailed || result.code !== 0) throw new GateFailure(`authorship wiring: git ${args[0]} failed (${result.code})`);
    return result.stdout.trim();
  };
  const own = git(["config", "user.email"]).toLowerCase();
  if (own === "") throw new GateFailure("authorship wiring: no repository user.email");
  const trunkSha = git(["rev-parse", "--verify", `${trunk}^{commit}`]);
  git(["merge-tree", "--write-tree", trunkSha, trunkSha]);
  const commits = git(["rev-list", "HEAD", `^${upstream}`, `^${trunkSha}`]).split(/\r?\n/).filter(Boolean);
  const failures: string[] = [];
  for (const sha of commits) {
    const [author, committer, parentText] = git(["log", "-1", "--format=%ae%x00%ce%x00%P", sha]).split("\0");
    if (author?.toLowerCase() !== own || committer?.toLowerCase() !== own) failures.push(`${sha}: foreign author/committer identity`);
    const values = git(["log", "-1", `--format=%(trailers:key=${publishGates.provenanceTrailer},valueonly,separator=%x0a)`, sha]).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (values.length > 0) {
      if (values.some((value) => value.toLowerCase() !== persona.toLowerCase())) failures.push(`${sha}: foreign ${publishGates.provenanceTrailer} trailer`);
      continue;
    }
    const parents = (parentText ?? "").split(" ").filter(Boolean);
    let cleanBaseMerge = false;
    if (parents.length === 2) {
      const onBase = seams.run(GIT, ["merge-base", "--is-ancestor", parents[1]!, trunkSha], { cwd: root, env: scrubbedGitEnv(seams.env) });
      if (!onBase.spawnFailed && onBase.code === 0) {
        const merged = seams.run(GIT, ["merge-tree", "--write-tree", parents[0]!, parents[1]!], { cwd: root, env: scrubbedGitEnv(seams.env) });
        cleanBaseMerge = !merged.spawnFailed && merged.code === 0 && merged.stdout.trim() === git(["rev-parse", `${sha}^{tree}`]);
      }
    }
    if (!cleanBaseMerge) failures.push(`${sha}: no ${publishGates.provenanceTrailer} trailer and not an exact clean base merge`);
  }
  if (failures.length > 0) throw new GateFailure(failures.join("; "));
}

export async function runGatedPublish(context: CommandContext): Promise<number> {
  const root = assertRepoRoot({ repoFlag: requireRepoFlag(context, "It names the already-published branch being updated.") });
  const proved = requireValue(context.args, "proved", "Name the exact commit already proved by the caller's tests and coverage.");
  const persona = requireValue(context.args, "persona", "The responsible persona is explicit caller input, never inferred from the branch.");
  if (!/^[0-9a-f]{40}$/.test(proved) || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(persona)) throw new VerbUsageError("--proved must be a full 40-hex SHA; --persona must be a plain token.");
  if (context.args.positionals.length !== 2 || context.args.passthrough.length > 0) throw new VerbUsageError("gated publish takes no positional/refspec arguments.");
  for (const flag of Object.keys(context.args.values)) if (!["repo", "base", "proved", "persona", "lane"].includes(flag)) throw new VerbUsageError(`--${flag} is not read by gated publish.`);
  for (const [flag, values] of Object.entries(context.args.lists)) if (values.length > 0) throw new VerbUsageError(`--${flag} is not read by gated publish.`);
  for (const flag of context.args.booleans) if (!["gated", "dry-run", "json", "help"].includes(flag)) throw new VerbUsageError(`--${flag} is not read by gated publish.`);
  let workflow: Workflow;
  try { workflow = loadWorkflow(root).workflow; }
  catch (error) { throw new VerbUsageError(`gated publish policy is unreadable: ${error instanceof Error ? error.message : String(error)}`); }
  const base = context.args.values["base"] ?? workflow.branch.base;
  const lane = workflow.iteration.lane ?? context.args.values["lane"] ?? null;
  if (lane === null || workflow.iteration.checks.length === 0 || (context.args.values["lane"] !== undefined && context.args.values["lane"] !== lane)) throw new VerbUsageError("gated publish requires the declared iteration lane/checks; supply --lane only when the policy leaves it open.");
  const dryRun = context.args.booleans.has("dry-run");
  const gates: { gate: number; label: string; ok: boolean; detail: string }[] = [];
  let current = 0;
  let label = "git repository";
  let pushed = false;
  const seams: Seams = { ...context.seams, now: context.seams.now.bind(context.seams), probePort: context.seams.probePort.bind(context.seams), runInteractive: context.seams.runInteractive.bind(context.seams), runStreamed: context.seams.runStreamed.bind(context.seams), run: (command, args, options) => context.seams.run(command, args, command === GIT ? { ...options, env: { ...options?.env, ...scrubbedGitEnv(context.seams.env) } } : options) };
  const git = (args: string[]): string => {
    const result = seams.run(GIT, args, { cwd: root });
    if (result.spawnFailed || result.code !== 0) throw new GateFailure(`git ${args[0]} failed (${result.code})`);
    return result.stdout.trim();
  };
  const ok = (detail: string): void => { gates.push({ gate: current, label, ok: true, detail }); };
  try {
    git(["rev-parse", "--git-dir"]);
    current = 1; label = "catch-up re-probe";
    const caught = catchUp(seams, root, { base, strategy: "auto", dryRun, abort: false });
    if (caught.kind !== "done" || !caught.report.noOp) throw new GateFailure(caught.kind === "refused" ? caught.reason : "catch-up changed the tree; return it to the caller to refresh evidence");
    ok("no-op");
    current = 2; label = "proved HEAD";
    if (git(["rev-parse", "HEAD"]) !== proved) throw new GateFailure("HEAD differs from --proved; re-prove before publishing");
    ok(proved);
    current = 3; label = "same-name published upstream";
    const branch = git(["branch", "--show-current"]);
    const upname = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    if (branch === "" || upname.indexOf("/") <= 0 || upname.slice(upname.indexOf("/") + 1) !== branch) throw new GateFailure("no same-name published upstream; first publish belongs to the caller's separate publish step");
    const upstream = git(["rev-parse", "--verify", "@{upstream}^{commit}"]);
    ok(`${upname} ${upstream}`);
    current = 4; label = "declared iteration checks";
    for (const check of workflow.iteration.checks) {
      const stdout: string[] = []; const stderr: string[] = [];
      // The wrapper's dry run still runs iteration checks; it only previews catch-up/push.
      const code = await runVerb({ ...context, seams, json: true, io: { out: (line) => void stdout.push(line), err: (line) => void stderr.push(line) } }, root, { verb: check, lane, dryRun: false, target: null, run: false });
      if (code !== 0) throw new GateFailure(`${check} exited ${code}; ${stderr.join(" ")}`);
      ok(`${check}: exit 0`);
    }
    current = 5; label = "outgoing authorship";
    outgoingAuthorship(seams, root, upstream, `origin/${base}`, persona);
    ok(`${upstream}..HEAD excluding origin/${base}`);
    current = 6; label = "HEAD re-read and publish";
    if (git(["rev-parse", "HEAD"]) !== proved) throw new GateFailure("HEAD moved during the gates; nothing pushed");
    const outcome = publish(seams, root, { base: workflow.branch.base, setUpstream: false, dryRun });
    if (outcome.kind !== "done" || outcome.report.needsForce) throw new GateFailure(outcome.kind === "refused" ? outcome.reason : "the update would require a force");
    pushed = outcome.report.pushed;
    ok(dryRun ? "would publish" : "published");
  } catch (error) {
    gates.push({ gate: current, label, ok: false, detail: error instanceof Error ? error.message : String(error) });
    const exitCode = current === 0 ? 2 : 1;
    emit(context.io, context.json, { contract: "nen.wc.publish-gated/v0.1", proved, dryRun, pushed, gates, exitCode }, gates.map((gate) => plainLine(`${gate.ok ? "ok" : "FAIL"} ${gate.gate} ${gate.label}: ${gate.detail}`)));
    return exitCode;
  }
  emit(context.io, context.json, { contract: "nen.wc.publish-gated/v0.1", proved, dryRun, pushed, gates, exitCode: 0 }, gates.map((gate) => plainLine(`ok ${gate.gate} ${gate.label}: ${gate.detail}`)));
  return 0;
}
