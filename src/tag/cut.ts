// src/tag/cut.ts -- `nen tag cut --at <sha>`, getsuga §4: "pin the commit
// explicitly -- 'cut from main' is not an instruction a script can follow".
//
// THE SHA IS THE CALLER'S, ALWAYS -- never HEAD, never re-resolved here. The
// skill's own incident is exactly this class of bug: main advances between a
// release PR merging and the cut running, and a script that tags "the current
// HEAD" tags a LATER commit than the one that was verified. This module
// refuses to default; --at is required, and it is checked for reachability
// and non-existence before a single write.
//
// NEVER AUTO-PUSHED. Pushing a tag is a separate, explicit step
// (--push) -- the same discipline every other mutating verb in this
// repository already applies (--dry-run everywhere else): a tag that exists
// only locally can be inspected and discarded; one already pushed to a shared
// remote cannot be un-cut. "Never re-tag, never move a tag, never force a
// tag" -- this module creates a local tag once and stops there unless the
// caller explicitly asked for the push too.

import { lines, type Runner } from "../exec/seam.js";

export interface CutTagOptions {
  readonly name: string;
  readonly at: string;
  readonly message?: string;
  readonly trunk?: string;
  readonly push?: boolean;
}

export interface CutTagResult {
  readonly ok: boolean;
  readonly pushed: boolean;
  readonly log: readonly string[];
  readonly error: string | null;
}

function run(runner: Runner, args: readonly string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const result = runner.run({ bin: "git", args: [...args], cwd });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

export function cutTag(runner: Runner, cwd: string, options: CutTagOptions): CutTagResult {
  const log: string[] = [];
  const trunk = options.trunk ?? "main";

  // "Does not exist" is a claim that must be VERIFIED, never assumed from a
  // failed check. An unreachable remote, an expired credential, a flaky
  // proxy -- any of these makes `ls-remote`/`tag -l` fail without answering
  // the question, and treating that failure as "not found" is exactly the
  // "found nothing" vs "could not look" confusion this module exists to
  // avoid (../issue/search.ts:205-208 draws the same line). A tag is never
  // cut on a name whose existence was never actually checked.
  const existsRemote = run(runner, ["ls-remote", "--tags", "origin", options.name], cwd);
  if (existsRemote.code !== 0) {
    return {
      ok: false,
      pushed: false,
      log,
      error: `could not determine whether '${options.name}' already exists on origin (${lines(existsRemote.stderr).join(" ") || `exit ${existsRemote.code}`}) -- a tag is never cut on an unverified name`,
    };
  }
  if (existsRemote.stdout.trim() !== "") {
    return {
      ok: false,
      pushed: false,
      log,
      error: `tag '${options.name}' already exists on origin -- re-tagging is never the fix; cut a new name if this was a mistake`,
    };
  }
  const existsLocal = run(runner, ["tag", "-l", options.name], cwd);
  if (existsLocal.code !== 0) {
    return {
      ok: false,
      pushed: false,
      log,
      error: `could not determine whether '${options.name}' already exists locally (${lines(existsLocal.stderr).join(" ") || `exit ${existsLocal.code}`}) -- a tag is never cut on an unverified name`,
    };
  }
  if (existsLocal.stdout.trim() !== "") {
    return { ok: false, pushed: false, log, error: `tag '${options.name}' already exists locally -- never re-tagged` };
  }
  log.push(`'${options.name}' does not exist locally or on origin`);

  const ancestor = run(runner, ["merge-base", "--is-ancestor", options.at, `origin/${trunk}`], cwd);
  if (ancestor.code > 1) {
    return {
      ok: false,
      pushed: false,
      log,
      error: `could not test reachability of '${options.at}' against origin/${trunk}: ${lines(ancestor.stderr).join(" ") || `exit ${ancestor.code}`}`,
    };
  }
  if (ancestor.code !== 0) {
    return {
      ok: false,
      pushed: false,
      log,
      error: `'${options.at}' is not an ancestor of origin/${trunk} -- a tag is a promise the code is on the trunk, and this commit is not on it. Use 'nen release resolve-target' first.`,
    };
  }
  log.push(`'${options.at}' is an ancestor of origin/${trunk}`);

  // ALWAYS ANNOTATED, never lightweight. bankai-core's own tag_cut.sh cuts an
  // annotated tag, and bankai-core's own releases are annotated tag objects
  // (`git cat-file -t v0.11.3` -> `tag`, not `commit`) -- a lightweight tag
  // from an omitted --message would differ in KIND from every release this
  // system has made, and any tooling that resolves `v*^{}` or reads a tagger
  // date would see it. When no --message is given the tag name itself is the
  // message, rather than making the flag required.
  const tagArgs = ["tag", "-a", "-m", options.message ?? options.name, options.name, options.at];
  const tag = run(runner, tagArgs, cwd);
  if (tag.code !== 0) {
    return {
      ok: false,
      pushed: false,
      log,
      error: `git tag failed: ${lines(tag.stderr).join(" ") || `exit ${tag.code}`}`,
    };
  }
  log.push(`created local tag '${options.name}' at ${options.at}`);

  if (options.push !== true) {
    log.push("NOT pushed -- pass --push to push this tag; it is never automatic");
    return { ok: true, pushed: false, log, error: null };
  }

  const push = run(runner, ["push", "origin", options.name], cwd);
  if (push.code !== 0) {
    return {
      ok: false,
      pushed: false,
      log,
      error: `tag created locally but the push failed: ${lines(push.stderr).join(" ") || `exit ${push.code}`}`,
    };
  }
  log.push(`pushed '${options.name}' to origin`);
  return { ok: true, pushed: true, log, error: null };
}
