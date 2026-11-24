// src/commit/strip.ts -- the nen half of `commits.stripInjected`
// (zheref/nen#594), shared by `nen commit write` (./write.ts) and `nen wc
// squash` (../wc/command.ts), the two verbs that run a child `git commit`.
//
// THE STRIP ITSELF IS THE HOOK'S, NOT nen's. ../scaffold/hook.ts's generated
// commit-msg hook removes a listed key from the message's trailer block when
// the message nen composed did not carry it; this module only tells the hook
// which keys nen composed and reads back what the hook removed:
//
//   1. BEFORE the commit, the sidecar (`<git dir>/nen-stripped-trailers`) is
//      resolved through `git rev-parse --git-dir` -- the hook resolves it the
//      same way, so a linked worktree names its own -- and a stale one from an
//      earlier run is deleted, so nothing it says can be blamed on this one;
//   2. the child `git commit` runs with `NEN_COMPOSED_TRAILER_KEYS` set to the
//      composed message's keys, lower-cased and comma-joined (possibly empty:
//      SET is the signal, the value is the list). A plain `git commit` has no
//      such variable and the hook strips nothing;
//   3. AFTER it, the sidecar is read and deleted. Every key it names is
//      cross-checked against the read-back: a key the written commit still
//      carries was not stripped -- it is an injected key (exit 3), exactly as
//      before this module existed -- and only a key the commit does NOT carry
//      is reported as stripped (exit 4).
//
// NOTHING HERE ADMITS A KEY. The hook's refusal still runs on what is left;
// a key the composed message carried is never named to the hook as strippable;
// nothing is amended. The only new outcome is a commit that lacks a refused
// key a harness added -- said on stderr, in `--json`'s `stripped`, and in the
// exit code.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { rawLines } from "../seam/lines.js";
import type { LoadedWorkflow } from "../schema/workflow.js";
import type { Trailer } from "./format.js";
import { HOOK_COMPOSED_KEYS_ENV, STRIP_SIDECAR_FILE } from "../scaffold/hook.js";

/** The variable whose PRESENCE tells the generated hook a nen verb started this commit; its value is the composed keys. ONE name, the hook's. */
export const COMPOSED_KEYS_ENV = HOOK_COMPOSED_KEYS_ENV;

/** The file under the git dir the hook appends one stripped key per line to. ONE name, the hook's. */
export const STRIP_SIDECAR = STRIP_SIDECAR_FILE;

/** The exit a verb gives a commit it wrote with a hook-injected key stripped. */
export const STRIPPED_EXIT = 4;

/** `git rev-parse --git-dir`: the hook's own resolution, so both name one file. */
export const GIT_DIR_ARGS: readonly string[] = ["rev-parse", "--git-dir"];

/**
 * Resolve the sidecar and delete a stale one -- step 1 above. Throws when git
 * cannot name the git dir: the commit has not been attempted, and a strip the
 * verb could not read back would be a strip nobody reported.
 */
export function prepareStripSidecar(seams: Seams, root: string): string {
  const result = seams.run(GIT, [...GIT_DIR_ARGS], { cwd: root });
  if (result.spawnFailed || result.code !== 0) {
    throw new Error(
      `could not resolve the git dir ('git ${GIT_DIR_ARGS.join(" ")}' failed: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}). Nothing was committed: without it a trailer the commit-msg hook strips (commits.stripInjected) could not be read back.`,
    );
  }
  const dir = result.stdout.trim();
  const path = join(isAbsolute(dir) ? dir : join(root, dir), STRIP_SIDECAR);
  rmSync(path, { force: true });
  return path;
}

/** The child environment -- step 2: the composed keys, lower-cased, comma-joined, first-seen unique. */
export function composedKeysEnv(sent: readonly Trailer[]): Readonly<Record<string, string>> {
  const keys: string[] = [];
  for (const trailer of sent) {
    const lower = trailer.key.toLowerCase();
    if (!keys.includes(lower)) keys.push(lower);
  }
  return { [COMPOSED_KEYS_ENV]: keys.join(",") };
}

/** Read the sidecar and delete it -- step 3's first half. Absent is "nothing stripped". */
export function collectStripSidecar(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  rmSync(path, { force: true });
  const keys: string[] = [];
  for (const line of rawLines(text)) {
    const key = line.trim();
    if (key !== "" && !keys.some((other): boolean => other.toLowerCase() === key.toLowerCase())) keys.push(key);
  }
  return keys;
}

/** Delete the sidecar whatever happened -- the cleanup half for a commit that failed. */
export function discardStripSidecar(path: string | null): void {
  if (path !== null) rmSync(path, { force: true });
}

/**
 * The keys the hook reported that the written commit really lacks -- step 3's
 * cross-check. A key the read-back still finds on the commit was not removed,
 * whatever the sidecar says; it stays the read-back's (injected, exit 3).
 */
export function confirmStripped(reported: readonly string[], written: readonly Trailer[]): readonly string[] {
  const carried = new Set(written.map((trailer): string => trailer.key.toLowerCase()));
  return reported.filter((key): boolean => !carried.has(key.toLowerCase()));
}

/** The stderr line for a non-empty `stripped`, worded once for both verbs. */
export function strippedMessage(sha: string, stripped: readonly string[]): string {
  const list = stripped.map((key): string => `'${key}'`).join(", ");
  return `the written commit ${sha} does not carry ${list}: the repository's commit-msg hook stripped ${stripped.length === 1 ? "that key" : "those keys"} from the trailer block because a hook inside 'git commit' added ${stripped.length === 1 ? "it" : "them"} and the message nen composed did not (commits.stripInjected, zheref/nen#594). Nothing refused was admitted and nothing was amended; exit 4 says a strip happened.`;
}

/**
 * The exit for a written commit: 3 (a refused key is still on it) wins over 4
 * (a hook-injected key was stripped), which wins over 0. A commit carrying a
 * refused key is the one outcome the caller must act on, so a strip beside it
 * never hides it.
 */
export function writtenExit(injected: number, stripped: number): 0 | 3 | 4 {
  if (injected > 0) return 3;
  if (stripped > 0) return STRIPPED_EXIT;
  return 0;
}

/**
 * The hint appended to a failed `git commit` when the policy lists keys to
 * strip, or "" when it lists none: a hook generated before the list was
 * written refuses the key rather than stripping it.
 */
export function stripFailureHint(policy: LoadedWorkflow | null): string {
  if (policy === null || !policy.present || policy.workflow.commits.stripInjected.length === 0) return "";
  return ` ${policy.path} lists commits.stripInjected (${policy.workflow.commits.stripInjected.map((key): string => `'${key}'`).join(", ")}), but a commit-msg hook generated before that list was written refuses those keys instead of stripping them: regenerate it with 'nen scaffold init ... --force', then commit again.`;
}
