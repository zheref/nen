// src/commit/readback.ts -- read a WRITTEN commit's trailers back and name
// every one a hook put there that this repository's policy refuses
// (zheref/nen#273). Shared by `nen commit write` (./write.ts) and `nen wc
// squash` (../wc/command.ts), the two verbs that run a child `git commit`.
//
// WHY READ BACK AT ALL. Both verbs validate the message they HAND git, and
// before this module both reported the trailers of that message as though
// they were the commit's. They are not always: a `prepare-commit-msg` or
// `commit-msg` hook -- a harness's own (Cursor appends `Co-authored-by:
// Cursor <cursoragent@cursor.com>`, zheref/hatsu#66) or the repository's --
// runs INSIDE the verb's child `git commit` and can append a trailer nen never
// saw. The verb then exited 0 over a commit carrying a key
// `commits.forbiddenTrailers` forbids. The only place the truth is recorded is
// the commit itself, so the commit is what is asked: `git log -1
// --format=%(trailers:only,unfold) <sha>`, git's own trailer parser, the one
// every tool that later reads the commit will use.
//
// WHAT COUNTS AS INJECTED -- THE ISSUE'S RULE, NOT "ANY NEW KEY". A trailer
// on the written commit that the message nen wrote did not carry is ADDED.
// An added key is INJECTED only when this repository's policy refuses it --
// the same `trailerRefusal` `commit format` and the generated commit-msg hook
// ask, case-insensitive on the key. An added key the policy admits (a hook
// stamping the repository's own `Hatsu-Agent`) or never restricts (Gerrit's
// `Change-Id`) is not a breach of anything, so it is reported as a NOTE and
// does not change the exit. A repository with NO nen/workflow.json refuses
// nothing here, exactly as `attributionRefusalMessages` refuses nothing for
// it: an absent policy is not silently replaced by nen's own defaults at the
// one moment the verb can no longer undo the write.
//
// NEVER AN AMEND. The commit is left exactly as git wrote it; the verb names
// the key, names the recovery, and exits non-zero. Rewriting a commit the
// caller's own hook produced -- on the caller's credentials, after the fact
// -- is a decision for the caller, not a side effect of a report.

import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { rawLines } from "../seam/lines.js";
import { trailerRefusal, type LoadedWorkflow } from "../schema/workflow.js";
import type { Trailer } from "./format.js";

/** The one git call: the written commit's trailers, as git's own parser reads them, folded lines unfolded. */
export function readBackArgs(sha: string): readonly string[] {
  return ["log", "-1", "--format=%(trailers:only,unfold)", sha];
}

export interface Readback {
  /** Every trailer the WRITTEN commit carries, in order, as git reads them. */
  readonly written: readonly Trailer[];
  /** Keys on the written commit that the message nen wrote did not carry, as git spelled them, first-seen, case-insensitively unique. */
  readonly added: readonly string[];
  /** The subset of `added` this repository's policy refuses -- the verb's non-zero exit. */
  readonly injected: readonly string[];
}

/** `Key: value` lines into trailers; a line with no colon (never produced by %(trailers)) is skipped rather than guessed at. */
export function parseTrailerLines(output: string): Trailer[] {
  const trailers: Trailer[] = [];
  for (const line of rawLines(output)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    trailers.push({ key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() });
  }
  return trailers;
}

/**
 * The comparison, with no git in it: which keys the written commit carries
 * MORE of than the message did (a multiset difference on the lower-cased
 * key, so a hook adding a second `Co-authored-by` beside one the message
 * already carried is still named), and which of those the policy refuses.
 */
export function compareTrailers(written: readonly Trailer[], sent: readonly Trailer[], policy: LoadedWorkflow): Readback {
  const remaining = new Map<string, number>();
  for (const trailer of sent) {
    const lower = trailer.key.toLowerCase();
    remaining.set(lower, (remaining.get(lower) ?? 0) + 1);
  }
  const added: string[] = [];
  const seen = new Set<string>();
  for (const trailer of written) {
    const lower = trailer.key.toLowerCase();
    const left = remaining.get(lower) ?? 0;
    if (left > 0) {
      remaining.set(lower, left - 1);
      continue;
    }
    if (seen.has(lower)) continue;
    seen.add(lower);
    added.push(trailer.key);
  }
  const injected = policy.present
    ? added.filter((key): boolean => trailerRefusal(policy.workflow.commits, key) !== null)
    : [];
  return { written, added, injected };
}

/**
 * Read `sha`'s trailers back and compare them with the ones nen sent. A git
 * that cannot answer THROWS: the commit exists, the check did not happen, and
 * "not checked" must never render as a clean `injected: []`.
 */
export function readBack(seams: Seams, root: string, sha: string, sent: readonly Trailer[], policy: LoadedWorkflow): Readback {
  const args = readBackArgs(sha);
  const result = seams.run(GIT, [...args], { cwd: root });
  if (result.spawnFailed || result.code !== 0) {
    const why = outputLines(result.stderr).join(" ") || `exit ${result.code}`;
    throw new Error(
      `committed ${sha}, but could not read its trailers back ('git ${args.join(" ")}' failed: ${why}). The commit is in place; whether a hook added a trailer to it was NOT checked.`,
    );
  }
  return compareTrailers(parseTrailerLines(result.stdout), sent, policy);
}

/** The refusal line both verbs print for a non-empty `injected`, naming the policy file, the keys and the way back. */
export function injectedMessage(sha: string, injected: readonly string[], policyPath: string, undo: string): string {
  const keys = injected.map((key): string => `'${key}'`).join(", ");
  return `the written commit ${sha} carries ${injected.length === 1 ? "a trailer" : "trailers"} the message nen wrote did not, and '${policyPath}' refuses: ${keys}. A hook that ran inside 'git commit' (prepare-commit-msg, commit-msg, or a harness's own) added ${injected.length === 1 ? "it" : "them"}. The commit is left in place -- nen never amends it. Drop it (${undo}), stop the hook from adding the key, and commit again; or admit the key under commits.allowedAttributionTrailers.`;
}

/** The note for a key a hook added that the policy does not refuse -- said, never silent, and never a failure. */
export function addedNote(sha: string, admitted: readonly string[]): string {
  return `the written commit ${sha} also carries ${admitted.map((key): string => `'${key}'`).join(", ")}, which the message nen wrote did not -- added by a hook inside 'git commit'. This repository's policy does not refuse ${admitted.length === 1 ? "it" : "them"}, so the exit is unchanged.`;
}
