// src/commit/readback.ts -- read a WRITTEN commit's trailers back and name
// every one this repository refuses (zheref/nen#273). Shared by `nen commit
// write` (./write.ts) and `nen wc squash` (../wc/command.ts), the two verbs
// that run a child `git commit`.
//
// WHY READ BACK AT ALL. Both verbs validate the message they HAND git, and
// before this module both reported the trailers of that message as though
// they were the commit's. They are not always: a `prepare-commit-msg` or
// `commit-msg` hook -- a harness's own (Cursor appends `Co-authored-by:
// Cursor <cursoragent@cursor.com>`, zheref/hatsu#66) or the repository's --
// runs INSIDE the verb's child `git commit` and can append a trailer nen never
// saw. The verb then exited 0 over a commit carrying a key
// `commits.forbiddenTrailers` forbids. The only place the truth is recorded is
// the commit itself, so the commit is what is asked.
//
// GIT'S OWN PARSER ON BOTH SIDES, AND NO `git log` (hanten N2, N3). The
// written side is `git cat-file commit <sha>` -- plumbing, which no `log.*`
// configuration (`log.showSignature`, say) can add a line to -- with its
// headers dropped and its message handed to `git interpret-trailers --parse
// --unfold` on stdin. The SENT side is the same `interpret-trailers` call over
// the message nen is about to hand `git commit`, asked BEFORE the write so a
// git that cannot parse never leaves a commit behind it unchecked. One parser
// for both sides is what keeps a `Key:value` line (no space -- a trailer to
// git, prose to nen's stricter shape check) from ever being blamed on a hook.
//
// WHAT IS REFUSED -- THREE RULES, EACH NAMED IN THE REFUSAL:
//
//   1. an ADDED key (on the commit, not in the message) the policy refuses --
//      `trailerRefusal`, the function `commit format` and the generated
//      commit-msg hook ask, case-insensitive on the key;
//   2. an ADDED key ending in `-by` or `-with` (case-insensitive) that
//      `commits.allowedAttributionTrailers` does not admit -- Hatsu's own
//      guard's rule (kokusen § 5, aka § 4; hanten N1), because a harness's
//      stamp is not always on nen's attribution list (`Made-with: Cursor`).
//      It binds with NO nen/workflow.json too, where that list is empty: the
//      maintainer's ruling on the round, "no policy file still flags nothing
//      beyond item 1's built-in rule";
//   3. a key the MESSAGE itself carried that the policy refuses -- only
//      possible where git's parser reads a trailer nen's did not, and worded
//      as "carried by the message", never "added by a hook". Rule 2 is NOT
//      applied here: a message with no policy file was validated against
//      nothing, and refusing it after the write would be a refusal nobody
//      could have seen coming.
//
// An added key none of these refuse (a hook stamping the repository's own
// `Hatsu-Agent`, Gerrit's `Change-Id`) is a NOTE, and the exit is unchanged.
//
// NEVER AN AMEND. The commit is left exactly as git wrote it; the verb names
// the key, names the recovery, and exits 3. Rewriting a commit the caller's
// own hook produced -- on the caller's credentials, after the fact -- is a
// decision for the caller, not a side effect of a report.

import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { rawLines } from "../seam/lines.js";
import { trailerAdmitted, trailerRefusal, type LoadedWorkflow } from "../schema/workflow.js";
import type { Trailer } from "./format.js";

/**
 * git's own trailer parser, over stdin: trailers only, from the input only,
 * folded lines unfolded -- and `--no-divider` (Copilot, NN-PR-#357). Without
 * it git treats a standalone `---` line as the start of a patch and reads
 * nothing below it, so a hook appending a refused trailer under a Markdown
 * rule in the body would read back as `[]`: fail-open. A commit message is
 * never a patch email, so the divider is never meaningful here.
 */
export const PARSE_TRAILERS_ARGS: readonly string[] = ["interpret-trailers", "--parse", "--unfold", "--no-divider"];

/**
 * The repository's `trailer.separators`. `--parse` PRINTS every trailer with
 * the FIRST character of that value (Copilot, NN-PR-#357): under `=:`,
 * `Co-authored-by: Cursor` comes out as `Co-authored-by= Cursor`, and a
 * decoder that split on ':' alone dropped it. Read, never overridden with
 * `-c`, because that would also change which lines git ACCEPTS as trailers.
 */
export const SEPARATORS_ARGS: readonly string[] = ["config", "--get", "trailer.separators"];

/** The written commit, raw: plumbing, so no `log.*` configuration reaches it. */
export function catFileArgs(sha: string): readonly string[] {
  return ["cat-file", "commit", sha];
}

/** Hatsu's guard's rule for an attribution-shaped key nen's list may not name (hanten N1). */
const ATTRIBUTION_SHAPED = /-(by|with)$/i;

/** Why one key is refused, and where it came from -- each a different sentence. */
export interface InjectedFinding {
  /** The key as git spelled it on the commit. */
  readonly key: string;
  /** `hook`: on the commit and not in the message. `message`: the message nen wrote carried it. */
  readonly source: "hook" | "message";
  /** `policy`: the policy refuses it. `by-with`: rule 2 in this module's header. */
  readonly rule: "policy" | "by-with";
}

export interface Readback {
  /** Every trailer the WRITTEN commit carries, in order, as git reads them. */
  readonly written: readonly Trailer[];
  /** Keys on the written commit that the message nen wrote did not carry, as git spelled them, first-seen, case-insensitively unique. */
  readonly added: readonly string[];
  /** Every refused key the written commit carries, hook-added or not -- the verb's exit 3. */
  readonly injected: readonly string[];
  /** The same keys, each with its source and rule, for the refusal's wording. */
  readonly findings: readonly InjectedFinding[];
}

/** A read-back of a real commit: the comparison, plus whether that commit is a ROOT commit (no parent, so no `HEAD~1` to return to). */
export interface WrittenReadback extends Readback {
  readonly root: boolean;
}

/**
 * `--parse` output into trailers: `Key<separator> value` per line, the
 * separator being the one git printed with (`outputSeparator`, ':' by
 * default). A line without it (never produced by `--parse`) is skipped rather
 * than guessed at.
 */
export function parseTrailerLines(output: string, separator = ":"): Trailer[] {
  const trailers: Trailer[] = [];
  for (const line of rawLines(output)) {
    const index = line.indexOf(separator);
    if (index <= 0) continue;
    trailers.push({ key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() });
  }
  return trailers;
}

/** Whether a raw commit object names no parent -- a ROOT commit. Headers end at the first blank line. */
export function isRootCommit(raw: string): boolean {
  const normalized = raw.replace(/\r\n/g, "\n");
  const end = normalized.indexOf("\n\n");
  const headers = end === -1 ? normalized : normalized.slice(0, end);
  return !headers.split("\n").some((line): boolean => line.startsWith("parent "));
}

/** A raw commit object's MESSAGE: everything after the first blank line, which ends the headers (a signature's continuation lines start with a space, never blank). */
export function commitMessageOf(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const end = normalized.indexOf("\n\n");
  return end === -1 ? "" : normalized.slice(end + 2);
}

/** Whether the policy alone refuses `key` (rules 1 and 3). An absent policy refuses nothing by this route. */
function policyRefuses(policy: LoadedWorkflow, key: string): boolean {
  return policy.present && trailerRefusal(policy.workflow.commits, key) !== null;
}

/**
 * The comparison, with no git in it: which keys the written commit carries
 * MORE of than the message did (a multiset difference on the lower-cased
 * key, so a hook adding a second `Co-authored-by` beside one the message
 * already carried is still named), and which keys are refused, and why.
 */
export function compareTrailers(written: readonly Trailer[], sent: readonly Trailer[], policy: LoadedWorkflow): Readback {
  const remaining = new Map<string, number>();
  for (const trailer of sent) {
    const lower = trailer.key.toLowerCase();
    remaining.set(lower, (remaining.get(lower) ?? 0) + 1);
  }
  const addedSet = new Set<string>();
  const added: string[] = [];
  for (const trailer of written) {
    const lower = trailer.key.toLowerCase();
    const left = remaining.get(lower) ?? 0;
    if (left > 0) {
      remaining.set(lower, left - 1);
      continue;
    }
    if (addedSet.has(lower)) continue;
    addedSet.add(lower);
    added.push(trailer.key);
  }
  const findings: InjectedFinding[] = [];
  const judged = new Set<string>();
  for (const trailer of written) {
    const lower = trailer.key.toLowerCase();
    if (judged.has(lower)) continue;
    judged.add(lower);
    if (addedSet.has(lower)) {
      if (policyRefuses(policy, trailer.key)) {
        findings.push({ key: trailer.key, source: "hook", rule: "policy" });
      } else if (ATTRIBUTION_SHAPED.test(trailer.key) && !trailerAdmitted(policy.workflow.commits, trailer.key)) {
        findings.push({ key: trailer.key, source: "hook", rule: "by-with" });
      }
    } else if (policyRefuses(policy, trailer.key)) {
      findings.push({ key: trailer.key, source: "message", rule: "policy" });
    }
  }
  return { written, added, injected: findings.map((finding): string => finding.key), findings };
}

function gitFailure(result: { readonly stderr: string; readonly code: number }): string {
  return outputLines(result.stderr).join(" ") || `exit ${result.code}`;
}

/**
 * The character `--parse` prints between key and value: the first of
 * `trailer.separators`, ':' when it is unset (`git config --get` exit 1).
 * Any other failure throws -- a separator guessed is a trailer dropped.
 */
function outputSeparator(seams: Seams, root: string, failure: (what: string, why: string) => string): string {
  const result = seams.run(GIT, [...SEPARATORS_ARGS], { cwd: root });
  if (result.spawnFailed || result.code > 1) throw new Error(failure(SEPARATORS_ARGS.join(" "), gitFailure(result)));
  if (result.code === 1) return ":";
  const first = result.stdout.replace(/\r?\n$/, "").charAt(0);
  return first === "" ? ":" : first;
}

/** `text`'s trailers, as git's own parser reads them. Throws when git cannot answer. */
function parseWithGit(seams: Seams, root: string, text: string, failure: (what: string, why: string) => string): Trailer[] {
  const separator = outputSeparator(seams, root, failure);
  const result = seams.run(GIT, [...PARSE_TRAILERS_ARGS], { cwd: root, stdin: text });
  if (result.spawnFailed || result.code !== 0) throw new Error(failure(PARSE_TRAILERS_ARGS.join(" "), gitFailure(result)));
  return parseTrailerLines(result.stdout, separator);
}

/**
 * The trailers of the message nen is ABOUT to hand `git commit`, by git's
 * parser. Asked before the write: a git that cannot answer here stops the
 * verb with nothing committed.
 */
export function sentTrailers(seams: Seams, root: string, message: string): Trailer[] {
  return parseWithGit(
    seams,
    root,
    message,
    (what, why): string =>
      `could not read the message's trailers with git's own parser ('git ${what}' failed: ${why}). Nothing was committed: without them the written commit could not be checked.`,
  );
}

/**
 * Read `sha`'s trailers back and compare them with the ones nen sent. A git
 * that cannot answer THROWS: the commit exists, the check did not happen, and
 * "not checked" must never render as a clean `injected: []`.
 */
export function readBack(seams: Seams, root: string, sha: string, sent: readonly Trailer[], policy: LoadedWorkflow): WrittenReadback {
  const notChecked = (what: string, why: string): string =>
    `committed ${sha}, but could not read its trailers back ('git ${what}' failed: ${why}). The commit is in place; whether it carries a refused trailer was NOT checked.`;
  const cat = catFileArgs(sha);
  const raw = seams.run(GIT, [...cat], { cwd: root });
  if (raw.spawnFailed || raw.code !== 0) throw new Error(notChecked(cat.join(" "), gitFailure(raw)));
  const written = parseWithGit(seams, root, commitMessageOf(raw.stdout), notChecked);
  return { ...compareTrailers(written, sent, policy), root: isRootCommit(raw.stdout) };
}

/** The reason one finding is refused, as a clause. */
function findingReason(finding: InjectedFinding, policy: LoadedWorkflow): string {
  const origin =
    finding.source === "hook"
      ? "added by a hook inside 'git commit' (prepare-commit-msg, commit-msg, or a harness's own)"
      : "carried by the message nen wrote -- git reads it as a trailer where nen's stricter shape check did not (a 'Key:value' line with no space, say)";
  const rule =
    finding.rule === "policy"
      ? `refused by '${policy.path}'`
      : `an attribution-shaped '-by'/'-with' key that commits.allowedAttributionTrailers does not admit${policy.present ? ` in '${policy.path}'` : ` (there is no '${policy.path}', so it admits none)`}`;
  return `'${finding.key}' (${origin}; ${rule})`;
}

/** The refusal line both verbs print for a non-empty `injected`: every key, why, where it came from, and the way back. */
export function injectedMessage(sha: string, findings: readonly InjectedFinding[], policy: LoadedWorkflow, undo: string): string {
  const list = findings.map((finding): string => findingReason(finding, policy)).join(", ");
  return `the written commit ${sha} carries ${findings.length === 1 ? "a trailer" : "trailers"} this repository refuses: ${list}. The commit is left in place -- nen never amends it. Drop it (${undo}), remove the key's source, and commit again; or admit the key under commits.allowedAttributionTrailers.`;
}

/** The note for a key a hook added that nothing refuses -- said, never silent, and never a failure. */
export function addedNote(sha: string, admitted: readonly string[]): string {
  return `the written commit ${sha} also carries ${admitted.map((key): string => `'${key}'`).join(", ")}, which the message nen wrote did not -- added by a hook inside 'git commit'. Nothing refuses ${admitted.length === 1 ? "it" : "them"}, so the exit is unchanged.`;
}

/** The keys a hook added that are not refused -- the note's subject. */
export function admittedAdditions(back: Readback): readonly string[] {
  const refused = new Set(back.injected.map((key): string => key.toLowerCase()));
  return back.added.filter((key): boolean => !refused.has(key.toLowerCase()));
}
