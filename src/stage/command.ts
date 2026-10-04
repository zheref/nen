// src/stage/command.ts -- `nen stage triage`: tensho §3's flag table, detection
// only. The ask on every flagged file stays human -- see ./triage.ts's header.
// `nen stage list` is its complement: the exact add list, computed from the
// same triage and never re-derived in shell (zheref/nen#237).

import { assertRepoRoot } from "../repo/root.js";
import { GIT, outputLines } from "../seam/exec.js";
import { commaList } from "../cli/comma.js";
import { plainLine } from "../cli/plain.js";
import {
  requireRepoFlag,
  requireSubcommand,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  addListFrom,
  DEFAULT_LARGE_BYTES,
  expandWorktreeRenames,
  BATCH_CHECK_FORMAT,
  measurableBlob,
  parseBatchCheckIds,
  parseCommitRange,
  parseRawChangesBytes,
  parseStatusPorcelain,
  parseStatusPorcelainBytes,
  pathspecLine,
  triageRange,
  triageStage,
  type StatusEntry,
  type TriageResult,
} from "./triage.js";

const USAGE = `nen stage triage -- flag what should never be staged blind, tensho §3.
nen stage list   -- the exact add list: what a checkpoint stages, nothing else.

usage:
  nen stage triage --repo <path> [--scope src/,docs/] [--mentions "<free text>"]
                   [--large-bytes <n>] [--range <base>..<head>]
  nen stage list   --repo <path> [--scope src/,docs/] [--mentions "<free text>"]
                   [--large-bytes <n>] [--nul | --json]

  --scope        path prefixes considered in-scope for this change. Omit to
                 skip the out-of-scope check entirely (no scope declared,
                 nothing to compare against).
  --mentions     free text (a commit message draft, a PR description)
                 searched for a deleted path's basename -- an unmentioned
                 deletion is flagged, never silently staged.
  --large-bytes  bytes at or above which a file is flagged 'large'. Default
                 ${DEFAULT_LARGE_BYTES} (1 MiB): no ordinary source file trips
                 it, and a multi-megabyte accident does. A file this verb
                 could not measure -- a deletion -- is never flagged large,
                 because "not measured" must not read as "measured and small".
  --range        stage triage only. Triage the paths the COMMITS in
                 <base>..<head> changed instead of the working copy -- the
                 review of a branch whose work is already committed. Same
                 detectors and --json shape; see below for what is read.

WHICH MODE READ THE PATHS. Without --range, stage triage reads the working
copy (git status: staged, unstaged, untracked and ignored paths) and never a
commit. With --range it reads ONLY commits, never the working copy or the
index, so uncommitted changes are not in it. <base>..<head> means the commits
git log <base>..<head> lists: the diff runs from merge-base(<base>, <head>) to
<head>, as git diff <base>...<head> does, so a base that moved on contributes
nothing. Two readings, each for what it can answer:
  - HISTORY: every change any commit in the range made (git log --raw
    --no-renames --diff-merges=cc), merges read as combined diffs. Secret
    shape, binary, out-of-scope and local config run over every path it
    names, and every blob it introduced is measured. A finding on something
    NOT in the range's net change -- a path added then deleted, renamed away,
    or changed and reverted, or a blob a later commit replaced (a dump
    committed and dropped, a file grown then shrunk) -- is FLAGGED with its
    reason plus 'in-history': it is still in the history being pushed.
  - NET CHANGE: deletions, --mentions and each path's size at <head> come
    from the net diff (git diff --raw --find-renames, merge base to <head>).
    A path the range deleted is never measured at <head>; --mentions is
    matched against a deleted path's basename as in the working-copy mode.
Sizes are blob sizes from git cat-file --batch-check, by object id, never the
disk. Submodule ignore settings are overridden (--ignore-submodules=none), so
a gitlink is never hidden, and replace refs are bypassed
(--no-replace-objects), so git reads the objects being pushed. A name git
printed in bytes that are not UTF-8 is flagged 'undecodable'. Nothing in a
commit is git-ignored, so the ignored bucket is always empty. The text report
opens with a 'read: committed range ...' line naming both resolved commits
and the commit count -- or that the range names no commits (still exit 0) --
and prints every path with control characters removed. Same --json shape in
both modes: { read, clean[], flagged[], ignored[] }, where read is
{ mode: "working-copy" } or { mode: "range", base, head, mergeBase, headSha,
commits }. Needs git 2.31 or newer (log --diff-merges).

Detects, never decides: secret shapes (.env, *.pem, *.key, credentials*),
local-config filenames (the '.local' infix -- settings.local.json, .env.local,
config.local.yml), files at or over --large-bytes, binaries, out-of-scope
paths and unmentioned deletions -- these are FLAGGED,
and 'a flagged file is never committed without an explicit yes', a yes this
verb never gives. A git-ignored path is a FACT rather than a question -- it
cannot be staged without -f, so there is nothing to ask -- and is reported
separately as a count in text (the paths themselves are never printed in
text; read them from --json). Exits 1 only when something is flagged; an
all-ignored tree is exit 0. With --range it also exits 2 for a range that is
malformed (not <base>..<head>, an empty side, the three-dot form, a side
beginning with '-'), a side that does not resolve to a commit, two commits
with no common ancestor or a shallow clone missing the history -- never a fall
back to the working copy -- and exits 1 when a git read fails (merge-base,
commit count, log, diff or cat-file), naming the read.

stage list runs the SAME triage, with the same three flags, and prints its
complement on stdout: every modified, added, renamed, deleted and untracked
path triage called clean, one per line -- minus every flagged path and every
git-ignored one. It never runs git add. Feed it to git verbatim:

  nen stage list --repo <top> --nul | git --literal-pathspecs -C <top> add \\
      --pathspec-from-file=- --pathspec-file-nul

  --nul   NUL-terminate every path instead of newline-terminating it. In the
          default newline form a path carrying a control character, or one
          starting with '"', is C-quoted the way git's --pathspec-from-file
          unquotes it; every other path, spaces included, is written raw.

--repo must be the TOP of the working tree: git status names paths relative
to it, so a subdirectory is refused at exit 2 naming the top to pass. A
worktree rename (git add -N, then a move) lists the original's deletion too.

Each exclusion is named on stderr -- 'excluded:' for a flagged path with its
reason(s), 'unmerged:' for a path in conflict, 'embedded repository:' for a
nested repository, 'undecodable:' for a name that is not UTF-8, 'already
staged:' for a deletion already in the index (a pathspec git add would
refuse) -- plus the ignored count. --json carries { verdict, add[],
excluded[], alreadyStaged[], ignored[], unmerged[], embeddedRepos[],
undecodable[] } at every exit reached after a successful status read (0, the
classification 1, and 3). A git read failure (1) and a usage error (2) emit
no document.

Exit codes: 0 the list is non-empty and nothing needs a human; 1 something
does (any of the first four above) -- the list is WITHHELD from stdout (read
it from --json), so a pipe that ignores the code stages nothing rather than a
partial set -- or git could not read the tree; 2 usage; 3 the add list is
empty and nothing needs a human.`;

function readLargeBytes(context: CommandContext): number {
  const rawLarge = context.args.values["large-bytes"];
  const largeBytes = rawLarge === undefined ? DEFAULT_LARGE_BYTES : Number(rawLarge);
  if (!Number.isInteger(largeBytes) || largeBytes <= 0) {
    throw new VerbUsageError(
      `--large-bytes takes a positive whole number of bytes -- got '${rawLarge}'. It is the size at or above which a file is flagged for a human to look at, so a zero or negative one would flag every file and say nothing.`,
    );
  }
  return largeBytes;
}

/**
 * Reads the working copy, measures it and triages it -- the one path both verbs
 * share, so `stage list` can never answer from a different reading of the tree
 * than `stage triage` would. `null` is a git status failure, already reported.
 */
function readAndTriage(
  context: CommandContext,
  root: string,
  expandRenames: boolean,
): { entries: readonly StatusEntry[]; triage: TriageResult } | null {
  const result = context.seams.run(
    GIT,
    ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--ignored", "-uall"],
    // RAW BYTES, so a name that is not UTF-8 is detected by a fatal decoder
    // rather than guessed from a U+FFFD a real filename may carry.
    { cwd: root, bytes: true },
  );
  if (result.code !== 0) {
    context.io.err(`nen: could not read working-copy status: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}`);
    return null;
  }
  const largeBytes = readLargeBytes(context);

  const parsed =
    result.stdoutBytes === undefined ? parseStatusPorcelain(result.stdout) : parseStatusPorcelainBytes(result.stdoutBytes);
  const entries = expandRenames ? expandWorktreeRenames(parsed) : parsed;
  // MEASURED HERE, NOT IN THE PURE MODULE. ./triage.ts has no filesystem --
  // that is what makes every one of its branches testable as data -- so the
  // sizes are read at this seam and handed in. A path that cannot be stat'd
  // (a deletion, a broken symlink) simply contributes no entry, and the
  // detector treats an absent size as "not measured" rather than as small.
  const sizes = new Map<string, number>();
  for (const entry of entries) {
    // AN IGNORED PATH IS NOT MEASURED (Copilot, PR #189). It can never reach
    // `flagged`, never affects the exit code and is never listed in text --
    // and `--ignored -uall` on a repository with a `node_modules/` tree is
    // thousands of entries, so statting them buys one unreadable `--json`
    // field for a synchronous stat storm on every invocation. The `ignored`
    // bucket is a bucket of FACTS about paths a plain `git add` cannot stage;
    // how big such a file is was never one of the facts it carried.
    if (entry.ignored) continue;
    if (entry.indexStatus === "D" || entry.worktreeStatus === "D") continue;
    try {
      const stats = statSync(join(root, ...entry.path.split("/")));
      if (stats.isFile()) sizes.set(entry.path, stats.size);
    } catch {
      // Unmeasurable is not small. Nothing is recorded for this path.
    }
  }

  const triage = triageStage(entries, {
    scopePrefixes: commaList(context.args.values["scope"]),
    mentionedText: context.args.values["mentions"] ?? "",
    sizes,
    largeBytes,
  });
  return { entries, triage };
}

/** What `--range` resolved to: the commits the readings actually ran between. */
interface ResolvedRange {
  readonly base: string;
  readonly head: string;
  readonly mergeBase: string;
  readonly headSha: string;
  readonly commits: number;
}

function gitFailure(result: { code: number; stderr: string }): string {
  return outputLines(result.stderr).join(" ") || `exit ${result.code}`;
}

/** Raw stdout bytes from a `bytes: true` call, whichever seam answered it. */
function stdoutBytesOf(result: { stdout: string; stdoutBytes?: Uint8Array }): Uint8Array {
  return result.stdoutBytes ?? new TextEncoder().encode(result.stdout);
}

/**
 * `stage triage --range` (zheref/nen#337): the commits in `<base>..<head>`,
 * triaged by the same detectors as the working copy -- names over every path
 * any commit touched, deletions and sizes over the net change (see
 * `triageRange`). NEVER FALLS BACK: a value that is not a range, a side that
 * begins with '-' or does not resolve to a commit, two commits with no common
 * ancestor and a shallow clone missing the history are each a usage error at
 * exit 2 naming what failed. `null` is a git read failure, already reported
 * with the read named.
 */
function readRangeAndTriage(
  context: CommandContext,
  root: string,
  rawRange: string,
): { range: ResolvedRange; triage: TriageResult } | null {
  const range = parseCommitRange(rawRange);
  if (range === null) {
    throw new VerbUsageError(
      `--range takes <base>..<head> -- got '${rawRange}'. Both sides are required and the three-dot form is refused: an empty side is not read as HEAD, and the range is never guessed.`,
    );
  }
  for (const [side, ref] of [
    ["base", range.base],
    ["head", range.head],
  ] as const) {
    // Refused BEFORE git sees it (hanten N7): a ref spelled like an option is
    // never handed to a git command line, whatever --end-of-options would
    // make of it.
    if (ref.startsWith("-")) {
      throw new VerbUsageError(
        `--range ${rawRange}: the ${side} ref '${ref}' begins with '-', which no ref this verb reads may. Nothing was triaged.`,
      );
    }
  }
  const largeBytes = readLargeBytes(context);

  // EVERY RANGE READ BYPASSES REPLACE REFS (hanten round 2 N6): a
  // `refs/replace/` entry would otherwise let git answer with a different
  // commit or tree than the one being pushed.
  const git = (args: readonly string[], options: { bytes?: boolean; stdin?: string } = {}): ReturnType<typeof context.seams.run> =>
    context.seams.run(GIT, ["--no-replace-objects", ...args], { cwd: root, ...options });

  const gitDir = git(["rev-parse", "--git-dir"]);
  if (gitDir.code !== 0) {
    context.io.err(`nen: ${root} is not a git repository: ${gitFailure(gitDir)}`);
    return null;
  }
  const failed = (what: string, result: { code: number; stderr: string }): null => {
    context.io.err(`nen: could not read ${what} for --range ${rawRange}: ${gitFailure(result)}`);
    return null;
  };

  const resolve = (side: "base" | "head", ref: string): string => {
    // `^{commit}` so a tree or blob id is refused rather than diffed.
    const result = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
    const sha = result.stdout.trim();
    if (result.code !== 0 || sha === "") {
      throw new VerbUsageError(
        `--range ${rawRange}: the ${side} ref '${ref}' does not resolve to a commit in ${root}. Nothing was triaged -- the working copy is never read in its place. Fetch it, or name a ref that exists.`,
      );
    }
    return sha;
  };
  const baseSha = resolve("base", range.base);
  const headSha = resolve("head", range.head);

  const mb = git(["merge-base", baseSha, headSha]);
  const mergeBase = mb.stdout.trim();
  if (mb.code === 1 && mergeBase === "") {
    // NO COMMON ANCESTOR -- or none VISIBLE (hanten N8): a shallow clone cut
    // above the fork point answers exactly like two unrelated histories.
    const shallow = git(["rev-parse", "--is-shallow-repository"]);
    if (shallow.code === 0 && shallow.stdout.trim() === "true") {
      throw new VerbUsageError(
        `--range ${rawRange}: no common ancestor of '${range.base}' and '${range.head}' is in this repository, and it is a shallow clone -- fetch more history (git fetch --unshallow, or --deepen) and run again. Nothing was triaged.`,
      );
    }
    throw new VerbUsageError(
      `--range ${rawRange}: '${range.base}' and '${range.head}' share no common ancestor, so the range names no commits. Nothing was triaged.`,
    );
  }
  if (mb.code !== 0 || mergeBase === "") return failed("the merge base", mb);

  const count = git(["rev-list", "--count", `${mergeBase}..${headSha}`]);
  const counted = count.stdout.trim();
  const commits = Number(counted);
  if (count.code !== 0 || counted === "" || !Number.isInteger(commits)) return failed("the commit count (git rev-list)", count);

  // EVERY CHANGE ANY COMMIT MADE (hanten N1, round 2 N1): renames off so both
  // names of a rename are here, merges read as combined diffs, the
  // destination blob of each change kept so a blob committed and later
  // replaced is still measured, submodule ignore settings overridden (N2).
  const log = git(
    [
      "-c",
      "core.quotePath=false",
      "log",
      "-z",
      "--raw",
      "--no-abbrev",
      "--format=",
      "--no-renames",
      "--diff-merges=cc",
      "--ignore-submodules=none",
      "--no-relative",
      `${mergeBase}..${headSha}`,
      "--",
    ],
    { bytes: true },
  );
  if (log.code !== 0) return failed("the changes the commits made (git log)", log);
  const history = parseRawChangesBytes(stdoutBytesOf(log));

  const diff = git(
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "-z",
      "--raw",
      "--no-abbrev",
      "--find-renames",
      "--ignore-submodules=none",
      "--no-relative",
      "--no-ext-diff",
      mergeBase,
      headSha,
      "--",
    ],
    { bytes: true },
  );
  if (diff.code !== 0) return failed("the net change (git diff)", diff);
  const net = parseRawChangesBytes(stdoutBytesOf(diff));

  // MEASURED BY OBJECT ID, never on disk and never by path (hanten round 2
  // N4): bare ids carry no newline, so cat-file needs no -z. A deletion, a
  // gitlink and the null id are never measured.
  const oids = [...new Set([...net, ...history].filter(measurableBlob).map((change): string => change.oid))];
  let blobSizes: ReadonlyMap<string, number> = new Map();
  if (oids.length > 0) {
    const check = git(["cat-file", `--batch-check=${BATCH_CHECK_FORMAT}`], { stdin: oids.map((oid): string => `${oid}\n`).join("") });
    if (check.code !== 0) return failed("the blob sizes (git cat-file)", check);
    blobSizes = parseBatchCheckIds(check.stdout);
  }

  const triage = triageRange(net, history, blobSizes, {
    scopePrefixes: commaList(context.args.values["scope"]),
    mentionedText: context.args.values["mentions"] ?? "",
    largeBytes,
  });
  return { range: { base: range.base, head: range.head, mergeBase, headSha, commits }, triage };
}

function runTriage(context: CommandContext, triage: TriageResult, range?: ResolvedRange): number {
  if (context.json) {
    // THE DOCUMENT NAMES ITS READING (hanten N4), in both modes: one shape,
    // `read` first, so a consumer never has to infer which tree it describes.
    const read = range === undefined ? { mode: "working-copy" } : { mode: "range", ...range };
    context.io.out(JSON.stringify({ read, ...triage }, null, 2));
    return triage.flagged.length === 0 ? 0 : 1;
  }
  if (range !== undefined) {
    // Text only in range mode: the working-copy text report is unchanged.
    const span = `${range.mergeBase.slice(0, 12)}..${range.headSha.slice(0, 12)}`;
    const typed = plainLine(`${range.base}..${range.head}`);
    context.io.out(
      range.commits === 0
        ? `read: committed range ${typed} (${span}) -- the range names no commits, not the working copy`
        : `read: committed range ${typed} (${span}, ${range.commits} commit(s)), not the working copy`,
    );
  }
  context.io.out(`clean: ${triage.clean.length} file(s)`);
  // plainLine on every rendered path (hanten round 2 N2): a `\r` in a name
  // would otherwise rewrite the row in place and hide it. --json keeps bytes.
  for (const path of triage.clean) context.io.out(`  ${plainLine(path)}`);
  // A count only -- this verb carries no --verbose flag, so the paths
  // themselves are never listed in text (zheref/nen#169). Printed
  // unconditionally, even at zero, matching the 'clean' line above: both
  // are informational, never a call to answer yes or no to.
  context.io.out(`ignored: ${triage.ignored.length} file(s), not listed`);
  if (triage.flagged.length > 0) {
    context.io.out(`flagged: ${triage.flagged.length} file(s) -- never staged without an explicit yes`);
    for (const file of triage.flagged) context.io.out(`  ${plainLine(file.path)}  [${file.reasons.join(", ")}]`);
    return 1;
  }
  return 0;
}

/** One directory, however spelled: symlinks and `/private` prefixes resolved. Unresolvable compares as written. */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * `--repo` must BE the top of its working tree (hanten N2). `git status`
 * prints every path relative to the toplevel whatever directory it runs in, so
 * a list read from `--repo sub/` and fed to `git -C sub add` names paths that
 * do not exist there, or worse, ones that do and are not the ones meant. A
 * subdirectory is refused at exit 2, naming the toplevel to pass instead.
 * `null` is a directory git does not recognise as a working tree, reported.
 */
function requireToplevel(context: CommandContext, root: string): string | null {
  const result = context.seams.run(GIT, ["rev-parse", "--show-toplevel"], { cwd: root });
  // EXACT BYTES, minus git's one terminating newline -- never `outputLines`,
  // which trims and redacts: a repository whose name ends in a space would
  // then refuse its own correct --repo (Copilot round 1 on #237).
  const toplevel = result.stdout.replace(/\r?\n$/, "");
  if (result.code !== 0 || toplevel === "") {
    context.io.err(
      `nen: ${root} is not inside a git working tree: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}`,
    );
    return null;
  }
  if (canonical(toplevel) !== canonical(root)) {
    throw new VerbUsageError(
      `--repo ${root} is inside the working tree whose top is ${toplevel}, not its top. git status names every path relative to the top, so a list read here would be fed to git add from the wrong directory. Pass --repo ${toplevel}.`,
    );
  }
  return toplevel;
}

/** `nen stage list` exit for an empty add list on an unflagged tree (zheref/nen#237). */
export const EXIT_EMPTY = 3;

function runList(context: CommandContext, entries: readonly StatusEntry[], triage: TriageResult, nul: boolean): number {
  const list = addListFrom(entries, triage);
  const code = list.verdict === "flagged" ? 1 : list.verdict === "empty" ? EXIT_EMPTY : 0;

  if (context.json) {
    // EVERY EXIT REACHED HERE -- every one after a successful status read --
    // CARRIES THE WHOLE DOCUMENT, `add` included. A git read failure returned
    // 1 before this point and a usage error threw 2; neither emits one. The JSON reader
    // branches on `verdict`, and withholding a field it might want to show a
    // human buys nothing a structured caller needs protecting from.
    context.io.out(JSON.stringify(list, null, 2));
    return code;
  }

  // STDOUT IS THE LIST AND NOTHING ELSE, so `git add --pathspec-from-file=-`
  // reads it with no awk, grep or cut in between. Everything a human reads --
  // each exclusion and why -- goes to stderr, where a pipe never takes it.
  //
  // WITHHELD ON A FLAG. A caller piping this into git add without checking the
  // exit code would otherwise stage the tree minus the flagged path -- a
  // partial commit that looks whole, which is the exact silent drop #237 was
  // filed against. Nothing on stdout means such a pipe stages nothing.
  if (list.verdict === "ready") {
    if (nul) {
      const chunk = list.add.map((path): string => `${path}\0`).join("");
      if (context.io.write !== undefined) context.io.write(chunk);
      else context.io.out(chunk);
    } else {
      for (const path of list.add) context.io.out(pathspecLine(path));
    }
  }
  for (const file of list.excluded) context.io.err(`excluded: ${pathspecLine(file.path)}  [${file.reasons.join(", ")}]`);
  for (const path of list.unmerged) context.io.err(`unmerged: ${pathspecLine(path)}`);
  for (const path of list.embeddedRepos) {
    context.io.err(`embedded repository: ${pathspecLine(path)}  [git add would record a gitlink with no .gitmodules entry]`);
  }
  for (const path of list.undecodable) {
    context.io.err(`undecodable: ${pathspecLine(path)}  [git status gave bytes that are not UTF-8; this name cannot reach the file]`);
  }
  for (const path of list.alreadyStaged) {
    context.io.err(`already staged: ${pathspecLine(path)}  [deletion in the index -- nothing to add, and git add would refuse the pathspec]`);
  }
  context.io.err(`ignored: ${list.ignored.length} file(s), not listed`);
  if (list.verdict === "flagged") {
    // UNIQUE PATHS, not a sum of buckets: a `DD` is unmerged AND an
    // unmentioned deletion, and is one path a human has to look at.
    const needing = new Set([
      ...list.excluded.map((file): string => file.path),
      ...list.unmerged,
      ...list.embeddedRepos,
      ...list.undecodable,
    ]).size;
    context.io.err(
      `nen: ${needing} path(s) need a human -- the add list (${list.add.length} path(s)) is withheld from stdout. A flagged file is never staged without an explicit yes; resolve each one, or read the list from --json.`,
    );
  } else if (list.verdict === "empty") {
    context.io.err(`nen: nothing to add -- no modified, added, deleted or untracked path outside the ignored set.`);
  }
  return code;
}

export const stageCommand: Command = {
  name: "stage",
  subcommands: ["triage", "list"],
  summary: "Flag secrets, local config, oversized files, binaries and unmentioned deletions before staging; emit the exact add list.",
  usage: USAGE,
  flags: { values: ["scope", "mentions", "large-bytes", "range"], booleans: ["nul"] },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("stage", context.args, ["triage", "list"]);
    const nul = context.args.booleans.has("nul");
    if (nul && subcommand !== "list") {
      throw new VerbUsageError("--nul belongs to 'stage list' -- 'stage triage' prints a human report, not a list to feed git.");
    }
    const rawRange = context.args.values["range"];
    if (rawRange !== undefined && subcommand !== "triage") {
      throw new VerbUsageError(
        "--range belongs to 'stage triage' -- 'stage list' is the add list for the working copy, and a committed range has nothing left to add.",
      );
    }
    if (nul && context.json) {
      throw new VerbUsageError("--nul and --json are two different forms of the same list; pass one.");
    }
    // Usage lists --repo unbracketed: omitting it is refused by name at exit 2,
    // never silently pointed at whatever working copy the process is standing
    // in (zheref/nen#28).
    const root = assertRepoRoot({
      repoFlag: requireRepoFlag(
        context,
        subcommand === "list"
          ? "It names the working tree whose add list is emitted."
          : "It names the working tree whose unstaged files are triaged.",
      ),
    });
    if (rawRange !== undefined) {
      const ranged = readRangeAndTriage(context, root, rawRange);
      if (ranged === null) return 1;
      return runTriage(context, ranged.triage, ranged.range);
    }
    if (subcommand === "list" && requireToplevel(context, root) === null) return 1;
    const read = readAndTriage(context, root, subcommand === "list");
    if (read === null) return 1;
    return subcommand === "list" ? runList(context, read.entries, read.triage, nul) : runTriage(context, read.triage);
  },
};
