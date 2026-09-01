// src/stage/triage.ts -- staging triage, tensho §3's table: detection only.
//
// "A FLAGGED FILE IS NEVER COMMITTED WITHOUT AN EXPLICIT YES" is the skill's
// own rule, and it names the human as the one who answers. This module's job
// ends at flagging: it detects a secret shape, an ignored file, a binary, a
// file outside the declared scope, and a deletion nobody mentioned, and it
// hands back WHY each one was flagged. It never decides to stage or skip a
// file, and it never asks the question itself -- that stays with whoever is
// driving, exactly as issue #4's "what stays with the LLM" section says.
//
// EVERY FLAG IS REPORTED, NOT JUST THE FIRST. "Present all flags AT ONCE" is
// the skill's own instruction, so a file matching two reasons (an ignored
// binary, say) carries both rather than whichever check ran first.

export interface StatusEntry {
  readonly path: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly ignored: boolean;
}

// `git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall`.
//
// -z, NOT NEWLINE-SPLIT, AND core.quotePath=false FORCED. With the default
// (newline-terminated) porcelain format, git C-quotes any path containing a
// non-ASCII byte -- `secrëts/.env` comes back as `"secr\303\253ts/.env"`,
// quotes and octal escapes included -- which defeats every `$`-anchored
// shape check below on exactly the paths most worth catching (a name someone
// chose to make less greppable). `-z` disables that quoting unconditionally
// and NUL-terminates every record instead of newline-terminating it, so an
// embedded space or newline in a path cannot be confused with a field
// separator either; `core.quotePath=false` is forced too, defensively, in
// case a caller's global config has already turned quoting off in a way that
// changes the non-`-z` behavior this comment doesn't rely on.
//
// A rename or copy is not a single NUL-terminated record with an " -> " in
// it (that spelling is newline-mode only) -- in `-z` mode it is TWO
// consecutive NUL-terminated records, `XY NEW_PATH\0ORIG_PATH\0`. Only the
// NEW path is kept, since that is what would be staged; the ORIG_PATH record
// is consumed and never treated as an entry of its own.
export function parseStatusPorcelain(text: string): readonly StatusEntry[] {
  const entries: StatusEntry[] = [];
  const records = text.split("\0").filter((record): boolean => record !== "");
  for (let i = 0; i < records.length; i++) {
    const raw = records[i] ?? "";
    const indexStatus = raw[0] ?? " ";
    const worktreeStatus = raw[1] ?? " ";
    const path = raw.slice(3);
    entries.push({
      path,
      indexStatus,
      worktreeStatus,
      ignored: indexStatus === "!" && worktreeStatus === "!",
    });
    const isRenameOrCopy = indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
    if (isRenameOrCopy) {
      // The next record is ORIG_PATH -- skip it, it is not its own entry.
      i++;
    }
  }
  return entries;
}

export type FlagReason = "secret-shape" | "ignored" | "binary" | "out-of-scope" | "unmentioned-deletion";

export interface FlaggedFile {
  readonly path: string;
  readonly reasons: readonly FlagReason[];
}

export interface TriageResult {
  readonly clean: readonly string[];
  readonly flagged: readonly FlaggedFile[];
}

export interface TriageOptions {
  /** Path PREFIXES considered in-scope. Empty means "no scope declared" -- the out-of-scope check is skipped rather than flagging everything. */
  readonly scopePrefixes?: readonly string[];
  /** Free text (a commit message draft, a PR description) searched for a deleted path's basename. */
  readonly mentionedText?: string;
  /** Paths `git diff --numstat` reported as binary (both columns '-'). */
  readonly binaryPaths?: ReadonlySet<string>;
}

// Filename shapes that carry a secret in this repository's own experience
// (tensho §3's table, verbatim): `.env`, `*.pem`, `*.key`, `credentials*`. This
// is a FILENAME check only -- it does not read file content, which is
// deliberate: content scanning is a different, heavier tool, and this check's
// whole value is that it is cheap enough to run on every file every time.
const SECRET_SHAPE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|credentials.*)$/i;

const BINARY_EXTENSION = /\.(png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|7z|exe|dll|so|dylib|bin|woff2?|ttf|otf)$/i;

export function triageStage(entries: readonly StatusEntry[], options: TriageOptions = {}): TriageResult {
  const scopePrefixes = options.scopePrefixes ?? [];
  const mentioned = (options.mentionedText ?? "").toLowerCase();
  const binaryPaths = options.binaryPaths ?? new Set<string>();

  const clean: string[] = [];
  const flagged: FlaggedFile[] = [];

  for (const entry of entries) {
    const reasons: FlagReason[] = [];
    const isDeletion = entry.indexStatus === "D" || entry.worktreeStatus === "D";

    if (entry.ignored) reasons.push("ignored");
    if (SECRET_SHAPE.test(entry.path)) reasons.push("secret-shape");
    if (binaryPaths.has(entry.path) || BINARY_EXTENSION.test(entry.path)) reasons.push("binary");
    if (scopePrefixes.length > 0 && !scopePrefixes.some((prefix): boolean => entry.path.startsWith(prefix))) {
      reasons.push("out-of-scope");
    }
    if (isDeletion) {
      const basename = entry.path.split("/").at(-1) ?? entry.path;
      if (!mentioned.includes(basename.toLowerCase())) reasons.push("unmentioned-deletion");
    }

    if (reasons.length === 0) clean.push(entry.path);
    else flagged.push({ path: entry.path, reasons });
  }

  return { clean, flagged };
}
