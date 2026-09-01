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

// `git status --porcelain=v1 --ignored -uall`. Two status columns (index,
// worktree), a space, then the path -- except a rename, which spells
// `old -> new`; only the NEW path is kept, since that is what would be staged.
export function parseStatusPorcelain(text: string): readonly StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (raw === "") continue;
    const indexStatus = raw[0] ?? " ";
    const worktreeStatus = raw[1] ?? " ";
    let path = raw.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    entries.push({
      path,
      indexStatus,
      worktreeStatus,
      ignored: indexStatus === "!" && worktreeStatus === "!",
    });
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
