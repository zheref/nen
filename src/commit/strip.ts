// src/commit/strip.ts -- the nen half of `commits.stripInjected`
// (zheref/nen#594), shared by `nen commit write` (./write.ts) and `nen wc
// squash` (../wc/command.ts), the two verbs that run a child `git commit`.
//
// THE STRIP ITSELF IS THE HOOK'S, NOT nen's. ../scaffold/hook.ts's generated
// commit-msg hook removes a listed key from the message's trailer block when
// the message nen composed did not carry it; this module only tells the hook
// which keys nen composed and reads back what the hook removed:
//
//   1. BEFORE the commit, a fresh RUN ID is drawn (random lower-case hex) and
//      the sidecar `<git dir>/nen-stripped-trailers.<run id>` is resolved
//      through `git rev-parse --git-dir` -- the hook resolves it the same way,
//      so a linked worktree names its own. The file is this run's alone (hanten
//      round 1, Feitan SEC-12): two runs interleaved in one git dir never read
//      each other's. Other runs' files are NOT swept -- one is only ever left
//      by a run that died between its commit and its read-back, nothing reads
//      it, and deleting a file another live run is about to read would be the
//      race this id exists to close;
//   2. the child `git commit` runs with `NEN_COMPOSED_TRAILER_KEYS` set to the
//      composed message's keys, lower-cased and comma-joined (possibly empty:
//      SET is the signal, the value is the list), and `NEN_STRIP_RUN` set to
//      the run id. A plain `git commit` has neither and the hook strips
//      nothing. NEITHER IS EVER EXPORTED BY HAND: the hook reads a
//      composed-keys variable with no well-formed run id as exported or
//      leaked, still strips, says so, and records nothing;
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

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { rawLines } from "../seam/lines.js";
import type { LoadedWorkflow } from "../schema/workflow.js";
import type { Trailer } from "./format.js";
import { HOOK_COMPOSED_KEYS_ENV, HOOK_STRIP_RUN_ENV, STRIP_SIDECAR_FILE } from "../scaffold/hook.js";

/** The variable whose PRESENCE tells the generated hook a nen verb started this commit; its value is the composed keys. ONE name, the hook's. */
export const COMPOSED_KEYS_ENV = HOOK_COMPOSED_KEYS_ENV;

/** The variable naming this run's id, which names its sidecar. ONE name, the hook's. */
export const STRIP_RUN_ENV = HOOK_STRIP_RUN_ENV;

/** The file under the git dir the hook appends one stripped key per line to, `.<run id>` appended. ONE name, the hook's. */
export const STRIP_SIDECAR = STRIP_SIDECAR_FILE;

/** One run's strip bookkeeping: its id, and the sidecar that id names. */
export interface StripRun {
  readonly runId: string;
  readonly path: string;
}

/**
 * A fresh run id: 16 lower-case hex digits, the shape the hook accepts (it
 * spells the set out as `0123456789abcdef`, never a range, so no locale widens
 * it). The `[0-9a-f]` below is a JavaScript range, which is by code point and
 * never by locale.
 */
export function newStripRunId(): string {
  return randomBytes(8).toString("hex");
}

/** The exit a verb gives a commit it wrote with a hook-injected key stripped. */
export const STRIPPED_EXIT = 4;

/** `git rev-parse --git-dir`: the hook's own resolution, so both name one file. */
export const GIT_DIR_ARGS: readonly string[] = ["rev-parse", "--git-dir"];

/**
 * Draw the run id and resolve its sidecar -- step 1 above -- deleting a file
 * already at that path (only an id collision could put one there). Throws when
 * git cannot name the git dir: the commit has not been attempted, and a strip
 * the verb could not read back would be a strip nobody reported. `runId` is a
 * parameter so a test can name two runs; a verb never passes one.
 */
export function prepareStripSidecar(seams: Seams, root: string, runId: string = newStripRunId()): StripRun {
  if (!/^[0-9a-f]+$/.test(runId)) throw new Error(`a strip run id is lower-case hex, got '${runId}'`);
  const result = seams.run(GIT, [...GIT_DIR_ARGS], { cwd: root });
  if (result.spawnFailed || result.code !== 0) {
    throw new Error(
      `could not resolve the git dir ('git ${GIT_DIR_ARGS.join(" ")}' failed: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}). Nothing was committed: without it a trailer the commit-msg hook strips (commits.stripInjected) could not be read back.`,
    );
  }
  const dir = result.stdout.trim();
  const path = join(isAbsolute(dir) ? dir : join(root, dir), `${STRIP_SIDECAR}.${runId}`);
  rmSync(path, { force: true });
  return { runId, path };
}

/** The child environment -- step 2: the composed keys, lower-cased, comma-joined, first-seen unique; and the run id. */
export function composedKeysEnv(sent: readonly Trailer[], run: StripRun): Readonly<Record<string, string>> {
  const keys: string[] = [];
  for (const trailer of sent) {
    const lower = trailer.key.toLowerCase();
    if (!keys.includes(lower)) keys.push(lower);
  }
  return { [COMPOSED_KEYS_ENV]: keys.join(","), [STRIP_RUN_ENV]: run.runId };
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
 * The hint appended to a failed `git commit`, or "": only when the policy
 * lists keys to strip AND git's stderr carries the generated hook's refusal
 * line for one of THOSE keys (`commit-msg: this message carries a '<Key>:'
 * trailer`, any case) -- the one failure a hook generated before the list
 * was written would produce. Worded as a possibility, because the same line
 * also comes from a current hook refusing a listed key it could not strip (one
 * below a scissors line, or in body prose). A commit that failed for any other
 * reason gets no hint: it would send the caller to regenerate a hook that is
 * not the problem.
 */
export function stripFailureHint(policy: LoadedWorkflow | null, gitStderr: string): string {
  if (policy === null || !policy.present) return "";
  const listed = policy.workflow.commits.stripInjected;
  const said = gitStderr.toLowerCase();
  const refused = listed.filter((key): boolean => said.includes(`commit-msg: this message carries a '${key.toLowerCase()}:' trailer`));
  if (refused.length === 0) return "";
  return ` The commit-msg hook refused ${refused.map((key): string => `'${key}'`).join(", ")}, which ${policy.path} lists under commits.stripInjected: the hook may predate commits.stripInjected; regenerate it with 'nen scaffold init ... --force', then commit again.`;
}
