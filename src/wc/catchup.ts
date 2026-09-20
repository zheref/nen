// src/wc/catchup.ts -- `nen wc catch-up`: bring the current branch up to date
// with its base, by rebase or by merge, and STOP on a conflict with both
// sides shown (zheref/nen#227; Hatsu's `ao` skill hand-rolled this).
//
// REBASE WHEN NOTHING IS PUBLISHED, MERGE OTHERWISE -- that is `--strategy
// auto`, and the detection is ./squash.ts's own `findPublishedCommit`, shared
// rather than copied so the two verbs cannot disagree about what "already
// pushed" means. A rebase rewrites every commit it replays, and rewriting one
// another actor already holds is the force-push nobody here will reach for
// silently (../pr/cascade.ts states the same rule for its own merge).
//
// A CONFLICT IS REPORTED, NEVER RESOLVED. The tree is left exactly as git
// left it -- the conflicted paths unmerged, the rebase or merge in progress
// -- and the report carries every conflicted path with OUR side and THEIR
// side (off the index stages, capped), plus the one line that backs out.
// Which side is right is a judgement, and a verb that made it would be
// making it on a JSON file's say-so.
//
// `ours` IS ALWAYS THIS BRANCH'S SIDE AND `theirs` THE BASE'S, whichever
// index stage holds it (Nobunaga N1). On a MERGE stage 2 is HEAD (this
// branch) and stage 3 is `origin/<base>`; on a REBASE git replays this
// branch's commits ON TOP of the base, so stage 2 is `origin/<base>` and
// stage 3 is the commit being replayed -- the reverse. The report labels by
// strategy so a reader never has to know which.
//
// PATHS ARE READ RAW (N3): `git diff --name-only` C-quotes a non-ASCII path
// under `core.quotePath`, and `git show :2:"\303\274.txt"` then fails --
// which used to read as "deleted on both sides". Every path list is asked
// for with `-c core.quotePath=false` and `-z` where the command has it, and
// a stage that IS there but cannot be shown is an error, never a deletion.
// A stage carrying a NUL is reported as `(binary, N bytes)` rather than
// copied into the report.
//
// RESUMING IS THE SAME COMMAND ON THE SAME TREE. Once the caller has staged
// its resolutions, re-running `nen wc catch-up` with the same `--base` and
// `--strategy` finds the rebase or merge in progress (`git rebase
// --show-current-patch` / `MERGE_HEAD`, asked of git through the seam so a
// worktree's relocated git directory changes nothing) and CONTINUES it -- `git rebase --continue`
// under `GIT_EDITOR=true`, or `git commit --no-edit` -- reporting `resumed:
// true`. Unmerged paths or leftover conflict markers still in the index are
// reported as `conflicted[]` again, at exit 1, with the abort line; nothing
// is continued over them. `--abort` runs the matching abort and reports
// `aborted: true`.
//
// `--base` IS VALIDATED BEFORE THE FIRST GIT CALL (Feitan S2). The argument
// reader admits `--base=--upload-pack=/x`, and handed to `git fetch origin
// <base>` that runs a program -- under `--dry-run` too, because the fetch is
// "a read". So the name goes through `git check-ref-format --branch` and
// ./publish.ts's refspec check first, and the fetch spells its refspec in
// full behind `--end-of-options`, where nothing in the name is an option.
//
// `git fetch` IS A READ, on ./squash.ts's argument: it moves a
// remote-tracking ref this repository already keeps and never a branch, and
// this module never pushes.

import { plainBlock, plainLine } from "../cli/plain.js";
import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { rawLines } from "../seam/lines.js";
import { fetchArgv, refuseBranchName, REMOTE } from "./publish.js";
import { findPublishedCommit, parseFolded, SquashStateError } from "./squash.js";

export const CATCH_UP_CONTRACT = "nen.wc.catch-up/v0.1";

export type Strategy = "rebase" | "merge";
export type RequestedStrategy = Strategy | "auto";

/** One conflicted path, with both sides' content as the index holds them. */
export interface CatchUpConflict {
  readonly path: string;
  /** THIS BRANCH's side (stage 2 on a merge, stage 3 on a rebase), capped; `(binary, N bytes)` for a blob carrying a NUL; null when this side deleted the path. */
  readonly ours: string | null;
  /** THE BASE's side (stage 3 on a merge, stage 2 on a rebase), capped; `(binary, N bytes)` for a blob carrying a NUL; null when that side deleted the path. */
  readonly theirs: string | null;
}

/** KEY ORDER IS THE CONTRACT; ./command.test.ts pins it. */
export interface CatchUpReport {
  readonly contract: string;
  readonly base: string;
  /** The strategy that RAN (or would run) -- `auto` resolved to one of the two. */
  readonly strategy: Strategy;
  readonly before: string;
  /** HEAD afterwards; null on a dry run and on a conflict. */
  readonly after: string | null;
  readonly behindBefore: number;
  readonly aheadBefore: number;
  /** True when the branch was already up to date and nothing ran. */
  readonly noOp: boolean;
  readonly conflicted: readonly CatchUpConflict[];
  /** True when this invocation continued a rebase or merge already in progress. */
  readonly resumed: boolean;
  /** True when `--abort` backed an in-progress rebase or merge out. */
  readonly aborted: boolean;
  readonly dryRun: boolean;
}

export type CatchUpOutcome =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "done"; readonly report: CatchUpReport; readonly lines: readonly string[] };

/** How much of each side of a conflict travels in the report. */
export const HUNK_CAP = 4_000;

interface GitCall {
  readonly code: number;
  readonly stdout: string;
  readonly spawnFailed: boolean;
  readonly error: string;
}

function runGit(seams: Seams, cwd: string, args: readonly string[], env?: Readonly<Record<string, string>>): GitCall {
  const result = seams.run(GIT, [...args], env === undefined ? { cwd } : { cwd, env });
  return {
    code: result.code,
    stdout: result.stdout,
    spawnFailed: result.spawnFailed,
    error: outputLines(result.stderr).join(" ") || `exit ${result.code}`,
  };
}

function mustCount(seams: Seams, cwd: string, range: string): number {
  const result = runGit(seams, cwd, ["rev-list", "--count", range]);
  const raw = result.stdout.trim();
  if (result.code !== 0 || !/^\d+$/.test(raw)) {
    throw new SquashStateError(`could not count '${range}' ('git rev-list --count ${range}' failed: ${result.error}).`);
  }
  return Number(raw);
}

function mustHead(seams: Seams, cwd: string, what: string): string {
  const head = runGit(seams, cwd, ["rev-parse", "HEAD"]);
  if (head.code !== 0) throw new SquashStateError(`${what}, but could not read HEAD ('git rev-parse HEAD' failed: ${head.error}).`);
  return head.stdout.trim();
}

/**
 * Which of the two operations git says is in progress, or null. Asked of
 * git, never of `.git/` directly -- and asked as `git rebase
 * --show-current-patch`, NOT as `REBASE_HEAD`: git (2.50 measured) leaves
 * that ref behind after a rebase completes, so a check on it would read the
 * finished rebase this verb just continued as one still in progress, and the
 * next run would try to continue it again. `--show-current-patch` answers
 * from the rebase state itself: exit 0 mid-rebase, 128 otherwise.
 */
export function inProgress(seams: Seams, cwd: string): Strategy | null {
  if (runGit(seams, cwd, ["rebase", "--show-current-patch"]).code === 0) return "rebase";
  if (runGit(seams, cwd, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).code === 0) return "merge";
  return null;
}

function abortLine(strategy: Strategy): string {
  return `to back out: git ${strategy} --abort`;
}

function cap(text: string): string {
  if (text.length <= HUNK_CAP) return text;
  return `${text.slice(0, HUNK_CAP)}\n…(truncated: ${text.length - HUNK_CAP} more characters)`;
}

/** What a side reads as when the blob carries a NUL: its size, never its bytes. */
export function binarySide(bytes: number): string {
  return `(binary, ${bytes} bytes)`;
}
const BINARY_SIDE = /^\(binary, \d+ bytes\)$/;
/** True when a side is the `(binary, N bytes)` note rather than text. */
export function isBinarySide(text: string): boolean {
  return BINARY_SIDE.test(text);
}

/** `-c core.quotePath=false`: paths as bytes, never C-quoted, so a stage can be asked for by the same name. */
const RAW_PATHS = ["-c", "core.quotePath=false"];

/** The index stages each unmerged path has (`git ls-files -u -z`: `<mode> <sha> <stage>\t<path>`). */
function unmergedStages(seams: Seams, cwd: string): ReadonlyMap<string, ReadonlySet<number>> {
  const listed = runGit(seams, cwd, ["ls-files", "-u", "-z"]);
  if (listed.code !== 0) throw new SquashStateError(`could not list the unmerged index entries ('git ls-files -u -z' failed: ${listed.error}).`);
  const stages = new Map<string, Set<number>>();
  for (const entry of listed.stdout.split("\0")) {
    const match = /^\S+ \S+ ([123])\t(.+)$/s.exec(entry);
    if (match === null || match[1] === undefined || match[2] === undefined) continue;
    const set = stages.get(match[2]) ?? new Set<number>();
    set.add(Number(match[1]));
    stages.set(match[2], set);
  }
  return stages;
}

/** One index stage of one path: its text, the binary note, or null when the stage is not there. A stage that is there and cannot be read is an error. */
function readStage(seams: Seams, cwd: string, path: string, stage: number, present: boolean): string | null {
  if (!present) return null;
  const shown = runGit(seams, cwd, ["show", `:${stage}:${path}`]);
  if (shown.code !== 0) {
    throw new SquashStateError(`could not read stage ${stage} of '${path}' ('git show :${stage}:${path}' failed: ${shown.error}); the index says the stage is there, so this is not a deletion.`);
  }
  if (!shown.stdout.includes("\0")) return cap(shown.stdout);
  const size = runGit(seams, cwd, ["cat-file", "-s", `:${stage}:${path}`]);
  if (size.code !== 0 || !/^\d+$/.test(size.stdout.trim())) {
    throw new SquashStateError(`could not size stage ${stage} of '${path}' ('git cat-file -s :${stage}:${path}' failed: ${size.error}).`);
  }
  return binarySide(Number(size.stdout.trim()));
}

/**
 * Every conflicted path: the unmerged ones (`--diff-filter=U`) plus any path
 * `git diff --cached --check` says still carries a conflict marker -- a
 * resolution that left `<<<<<<<` in a staged file is not a resolution. Each
 * side is read off the index stages `git ls-files -u` says are there; a
 * stage that is not there is a side that deleted the path, and one that is
 * there but cannot be shown is an error. `ours` is this branch's side and
 * `theirs` the base's, by `strategy` (see the header).
 */
export function collectConflicts(seams: Seams, cwd: string, strategy: Strategy): readonly CatchUpConflict[] {
  const unmerged = runGit(seams, cwd, [...RAW_PATHS, "diff", "--name-only", "-z", "--diff-filter=U"]).stdout
    .split("\0")
    .filter((path): boolean => path !== "");
  const check = runGit(seams, cwd, [...RAW_PATHS, "diff", "--cached", "--check"]);
  const marked = check.code === 0
    ? []
    : rawLines(check.stdout)
        .map((line): string | null => /^(.+?):\d+: leftover conflict marker/.exec(line)?.[1] ?? null)
        .filter((path): path is string => path !== null);
  const paths = [...new Set([...unmerged, ...marked])];
  if (paths.length === 0) return [];
  const stages = unmergedStages(seams, cwd);
  // On a rebase the replayed commit -- this branch's side -- sits in stage 3.
  const [oursStage, theirsStage] = strategy === "rebase" ? [3, 2] : [2, 3];
  return paths.map((path): CatchUpConflict => {
    const present = stages.get(path) ?? new Set<number>();
    return {
      path,
      ours: readStage(seams, cwd, path, oursStage, present.has(oursStage)),
      theirs: readStage(seams, cwd, path, theirsStage, present.has(theirsStage)),
    };
  });
}

export interface CatchUpOptions {
  readonly base: string;
  readonly strategy: RequestedStrategy;
  readonly dryRun: boolean;
  readonly abort: boolean;
}

/**
 * The verb, from the first read to the report. `refused` is a usage error
 * (exit 2); a git failure this module did not expect throws `SquashStateError`
 * (exit 1); a conflict is a `done` report whose `conflicted` is non-empty,
 * which the command exits 1 on.
 */
export function catchUp(seams: Seams, cwd: string, options: CatchUpOptions): CatchUpOutcome {
  const { base, dryRun } = options;
  const badBase = refuseBranchName(seams, cwd, base, "--base");
  if (badBase !== null) return { kind: "refused", reason: badBase };
  const remoteBase = `${REMOTE}/${base}`;
  const lines: string[] = [];
  const pending = inProgress(seams, cwd);

  // ── --abort: back out whatever is in progress, and nothing else ──────────
  if (options.abort) {
    if (pending === null) {
      return { kind: "refused", reason: "--abort was given and no rebase or merge is in progress here (git reports no rebase, and MERGE_HEAD does not resolve). There is nothing to back out of." };
    }
    const before = mustHead(seams, cwd, "found an in-progress " + pending);
    if (!dryRun) {
      const abort = runGit(seams, cwd, [pending, "--abort"]);
      if (abort.code !== 0) throw new SquashStateError(`could not abort the in-progress ${pending} ('git ${pending} --abort' failed: ${abort.error}).`);
    }
    const after = dryRun ? null : mustHead(seams, cwd, `aborted the ${pending}`);
    lines.push(dryRun ? `would run: git ${pending} --abort` : `aborted the in-progress ${pending}; HEAD is ${after}`);
    return {
      kind: "done",
      lines,
      report: {
        contract: CATCH_UP_CONTRACT,
        base,
        strategy: pending,
        before,
        after,
        behindBefore: 0,
        aheadBefore: 0,
        noOp: false,
        conflicted: [],
        resumed: false,
        aborted: !dryRun,
        dryRun,
      },
    };
  }

  // ── resume: the same command, on the tree the conflict left ──────────────
  if (pending !== null) {
    if (options.strategy !== "auto" && options.strategy !== pending) {
      return {
        kind: "refused",
        reason: `a ${pending} is in progress here and --strategy ${options.strategy} was asked for. Re-run with --strategy ${pending} (or auto) to continue it, or --abort to back it out; nen will not start a second operation over one that is not finished.`,
      };
    }
    const before = mustHead(seams, cwd, `found an in-progress ${pending}`);
    const behindBefore = mustCount(seams, cwd, `HEAD..${remoteBase}`);
    const aheadBefore = mustCount(seams, cwd, `${remoteBase}..HEAD`);
    const stillConflicted = collectConflicts(seams, cwd, pending);
    const report = (after: string | null, conflicted: readonly CatchUpConflict[]): CatchUpReport => ({
      contract: CATCH_UP_CONTRACT,
      base,
      strategy: pending,
      before,
      after,
      behindBefore,
      aheadBefore,
      noOp: false,
      conflicted,
      resumed: !dryRun && conflicted.length === 0,
      aborted: false,
      dryRun,
    });
    if (stillConflicted.length > 0) {
      lines.push(`${pending} in progress, and ${stillConflicted.length} path(s) still conflicted -- nothing continued:`);
      lines.push(abortLine(pending));
      return { kind: "done", lines, report: report(null, stillConflicted) };
    }
    if (dryRun) {
      lines.push(pending === "rebase" ? "would run: git rebase --continue  (GIT_EDITOR=true)" : "would run: git commit --no-edit");
      return { kind: "done", lines, report: report(null, []) };
    }
    const resumed = pending === "rebase"
      ? runGit(seams, cwd, ["rebase", "--continue"], { GIT_EDITOR: "true" })
      : runGit(seams, cwd, ["commit", "--no-edit"]);
    if (resumed.code !== 0) {
      const conflicted = collectConflicts(seams, cwd, pending);
      if (conflicted.length === 0) {
        throw new SquashStateError(`could not continue the ${pending} ('git ${pending === "rebase" ? "rebase --continue" : "commit --no-edit"}' failed: ${resumed.error}). The tree is as git left it.`);
      }
      lines.push(`continued the ${pending}; a later commit conflicted on ${conflicted.length} path(s) -- nen picked no side:`);
      lines.push(abortLine(pending));
      return { kind: "done", lines, report: report(null, conflicted) };
    }
    const after = mustHead(seams, cwd, `continued the ${pending}`);
    lines.push(`continued the ${pending}; HEAD is ${after}`);
    return { kind: "done", lines, report: report(after, []) };
  }

  // ── the ordinary path: clean tree, fetch, choose, run ─────────────────────
  const status = runGit(seams, cwd, ["status", "--porcelain=v1", "-uall"]);
  if (status.code !== 0) throw new SquashStateError(`could not read the working copy's status ('git status --porcelain=v1 -uall' failed: ${status.error}).`);
  const dirty = rawLines(status.stdout).map((line): string => line.slice(3).trim()).filter((path): boolean => path !== "");
  if (dirty.length > 0) {
    return {
      kind: "refused",
      reason: `the working tree is dirty -- ${dirty.length} uncommitted or untracked path(s): ${dirty.join(", ")}. Commit or stash them first; a catch-up never replays work that was never committed.`,
    };
  }
  const fetchArgs = fetchArgv(REMOTE, base);
  const fetch = runGit(seams, cwd, fetchArgs);
  if (fetch.code !== 0) throw new SquashStateError(`could not fetch ${remoteBase} ('git ${fetchArgs.join(" ")}' failed: ${fetch.error}).`);
  lines.push(`fetched ${remoteBase}`);

  const before = mustHead(seams, cwd, `fetched ${remoteBase}`);
  const behindBefore = mustCount(seams, cwd, `HEAD..${remoteBase}`);
  const aheadBefore = mustCount(seams, cwd, `${remoteBase}..HEAD`);

  let strategy: Strategy;
  if (options.strategy === "auto") {
    // REBASE UNLESS SOMETHING IS PUBLISHED. The branch's own commits are the
    // ones a rebase would rewrite, and the upstream is where they would
    // already be held by somebody else.
    const log = runGit(seams, cwd, ["log", `${remoteBase}..HEAD`, "--format=%H%x09%s"]);
    if (log.code !== 0) throw new SquashStateError(`could not list this branch's commits ('git log ${remoteBase}..HEAD' failed: ${log.error}).`);
    const own = parseFolded(log.stdout).reverse();
    const { upstream, published } = findPublishedCommit(seams, cwd, own);
    strategy = published === null ? "rebase" : "merge";
    lines.push(
      published === null
        ? `strategy: rebase (auto -- ${upstream === null ? "no upstream is set" : `nothing on '${upstream}' yet`})`
        : `strategy: merge (auto -- ${published.sha} is already on '${upstream ?? ""}')`,
    );
  } else {
    strategy = options.strategy;
    lines.push(`strategy: ${strategy}`);
  }

  const report = (after: string | null, noOp: boolean, conflicted: readonly CatchUpConflict[]): CatchUpReport => ({
    contract: CATCH_UP_CONTRACT,
    base,
    strategy,
    before,
    after,
    behindBefore,
    aheadBefore,
    noOp,
    conflicted,
    resumed: false,
    aborted: false,
    dryRun,
  });

  if (behindBefore === 0) {
    lines.push(`already up to date with ${remoteBase} (${aheadBefore} ahead, 0 behind) -- nothing to do`);
    return { kind: "done", lines, report: report(before, true, []) };
  }
  const argv = strategy === "rebase" ? ["rebase", remoteBase] : ["merge", "--no-edit", remoteBase];
  if (dryRun) {
    lines.push(`would run: git ${argv.join(" ")}  (${aheadBefore} ahead, ${behindBefore} behind)`);
    return { kind: "done", lines, report: report(null, false, []) };
  }
  const ran = runGit(seams, cwd, argv);
  if (ran.code !== 0) {
    const conflicted = collectConflicts(seams, cwd, strategy);
    if (conflicted.length === 0) {
      throw new SquashStateError(`'git ${argv.join(" ")}' failed without leaving a conflict nen can read: ${ran.error}. The tree is as git left it.`);
    }
    lines.push(`${strategy} stopped on ${conflicted.length} conflicted path(s) -- nen picked no side; the tree is left as git left it:`);
    lines.push(abortLine(strategy));
    return { kind: "done", lines, report: report(null, false, conflicted) };
  }
  const after = mustHead(seams, cwd, `${strategy}d ${remoteBase}`);
  lines.push(`${strategy === "rebase" ? "rebased onto" : "merged"} ${remoteBase}; HEAD is ${after}`);
  return { kind: "done", lines, report: report(after, false, []) };
}

/**
 * The conflict block the human rendering prints, one path at a time. `ours`
 * is this branch's side whatever the strategy. The hunks are somebody's file
 * contents headed for a terminal, so every control byte but the newline and
 * tab is stripped (../cli/plain.ts's argument); `--json` keeps the bytes.
 */
export function renderConflicts(conflicted: readonly CatchUpConflict[]): readonly string[] {
  const lines: string[] = [];
  const side = (label: string, text: string | null): void => {
    if (text === null) {
      lines.push(`    ${label}: (deleted on this side)`);
      return;
    }
    if (isBinarySide(text)) {
      lines.push(`    ${label}: ${text}`);
      return;
    }
    lines.push(`    ${label}:`);
    for (const line of plainBlock(text).replace(/\n$/, "").split("\n")) lines.push(`      ${line}`);
  };
  for (const conflict of conflicted) {
    lines.push(`  ${plainLine(conflict.path)}`);
    side("ours  ", conflict.ours);
    side("theirs", conflict.theirs);
  }
  return lines;
}
