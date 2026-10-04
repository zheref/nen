// src/stage/command.ts -- `nen stage triage`: tensho §3's flag table, detection
// only. The ask on every flagged file stays human -- see ./triage.ts's header.
// `nen stage list` is its complement: the exact add list, computed from the
// same triage and never re-derived in shell (zheref/nen#237).

import { assertRepoRoot } from "../repo/root.js";
import { GIT, outputLines } from "../seam/exec.js";
import { commaList } from "../cli/comma.js";
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
  parseStatusPorcelain,
  parseStatusPorcelainBytes,
  pathspecLine,
  triageStage,
  type StatusEntry,
  type TriageResult,
} from "./triage.js";

const USAGE = `nen stage triage -- flag what should never be staged blind, tensho §3.
nen stage list   -- the exact add list: what a checkpoint stages, nothing else.

usage:
  nen stage triage --repo <path> [--scope src/,docs/] [--mentions "<free text>"]
                   [--large-bytes <n>]
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

Detects, never decides: secret shapes (.env, *.pem, *.key, credentials*),
local-config filenames (the '.local' infix -- settings.local.json, .env.local,
config.local.yml), files at or over --large-bytes, binaries, out-of-scope
paths and unmentioned deletions -- these are FLAGGED,
and 'a flagged file is never committed without an explicit yes', a yes this
verb never gives. A git-ignored path is a FACT rather than a question -- it
cannot be staged without -f, so there is nothing to ask -- and is reported
separately as a count in text (the paths themselves are never printed in
text; read them from --json). Exits 1 only when something is flagged; an
all-ignored tree is exit 0.

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
  const rawLarge = context.args.values["large-bytes"];
  const largeBytes = rawLarge === undefined ? DEFAULT_LARGE_BYTES : Number(rawLarge);
  if (!Number.isInteger(largeBytes) || largeBytes <= 0) {
    throw new VerbUsageError(
      `--large-bytes takes a positive whole number of bytes -- got '${rawLarge}'. It is the size at or above which a file is flagged for a human to look at, so a zero or negative one would flag every file and say nothing.`,
    );
  }

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

function runTriage(context: CommandContext, triage: TriageResult): number {
  if (context.json) {
    context.io.out(JSON.stringify(triage, null, 2));
    return triage.flagged.length === 0 ? 0 : 1;
  }
  context.io.out(`clean: ${triage.clean.length} file(s)`);
  for (const path of triage.clean) context.io.out(`  ${path}`);
  // A count only -- this verb carries no --verbose flag, so the paths
  // themselves are never listed in text (zheref/nen#169). Printed
  // unconditionally, even at zero, matching the 'clean' line above: both
  // are informational, never a call to answer yes or no to.
  context.io.out(`ignored: ${triage.ignored.length} file(s), not listed`);
  if (triage.flagged.length > 0) {
    context.io.out(`flagged: ${triage.flagged.length} file(s) -- never staged without an explicit yes`);
    for (const file of triage.flagged) context.io.out(`  ${file.path}  [${file.reasons.join(", ")}]`);
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
  flags: { values: ["scope", "mentions", "large-bytes"], booleans: ["nul"] },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("stage", context.args, ["triage", "list"]);
    const nul = context.args.booleans.has("nul");
    if (nul && subcommand !== "list") {
      throw new VerbUsageError("--nul belongs to 'stage list' -- 'stage triage' prints a human report, not a list to feed git.");
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
    if (subcommand === "list" && requireToplevel(context, root) === null) return 1;
    const read = readAndTriage(context, root, subcommand === "list");
    if (read === null) return 1;
    return subcommand === "list" ? runList(context, read.entries, read.triage, nul) : runTriage(context, read.triage);
  },
};
