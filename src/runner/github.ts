// src/runner/github.ts -- every GitHub call the `runner` family makes, through
// the one subprocess seam, and the one place a `gh` answer becomes an exit code.
//
// `gh api`, NOT OCTOKIT, AND FOR THE `pr` FAMILY'S OWN REASON. ../pr/fetch.ts
// reads REST through `gh api` so a test drives it from a table of recorded
// answers (../seam/scripted.ts) and no test in this repository opens a socket;
// the octokit path ../github/client.ts keeps is `pr ready`'s alone. Every read
// here names `--method GET` explicitly -- ../pr/fetch.ts's header records the
// incident that made that a rule (a read that inferred POST and wrote) -- and
// the three writes (`registration-token` is NOT among them: nen never mints a
// token; the host script does, inside the elevated process) are `gh workflow
// run` and `gh variable set`, each named at its call site.
//
// THREE EXIT CODES LEAVE THIS FILE, and they are USAGE.md's, not new ones:
//   5 -- `gh` could not be started at all. The `shu` family's "the declared
//        program could not be started", reused because it is the same fact:
//        "the tool is not installed" and "the tool ran and said no" want
//        different reactions from a caller (../seam/exec.ts keeps them apart).
//   1 -- GitHub answered and refused, or answered something unreadable. There
//        is no code of its own for a network or API failure in this CLI's
//        table: `pr ready` reports "GitHub could not be read" at 1, and so
//        does this family.
//   2 -- raised by the verbs, never here.
//
// NOTHING A SUBPROCESS PRINTED IS ECHOED UNREDACTED. Every stderr that reaches
// a message goes through `outputLines`, which strips URL userinfo and GitHub
// token shapes (../seam/exec.ts, Feitan S6) -- a `gh` failure can quote the
// token it was handed, and this family's whole contract is that no token, no
// password and no registration token is ever printed by nen.

import { GH, outputLines, type CommandResult, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";

/** `gh` could not be started: USAGE.md § Exit codes' `5`. */
export const EXIT_TOOL_MISSING = 5;

/**
 * A refusal this family raises with its OWN exit code (1 or 5). A usage error
 * is a VerbUsageError and exits 2 through ../index.ts like every family's.
 */
export class RunnerFailure extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.name = "RunnerFailure";
    this.exitCode = exitCode;
  }
}

/** A subprocess's stderr, redacted and on one line, or its exit code when it said nothing. */
export function describeFailure(result: CommandResult): string {
  const lines = outputLines(result.stderr);
  return lines.length === 0 ? `exit ${result.code}, no stderr` : lines.join(" ");
}

/** Run `gh`; a binary that cannot be started is exit 5, named. */
export function gh(seams: Seams, args: readonly string[]): CommandResult {
  const result = seams.run(GH, args);
  if (result.spawnFailed) {
    throw new RunnerFailure(
      EXIT_TOOL_MISSING,
      `'gh' could not be started (${outputLines(result.stderr).join(" ") || "no such program"}). Every 'nen runner' verb that reads or writes GitHub shells out to the GitHub CLI: install it and put it on PATH, then 'gh auth login'.`,
    );
  }
  return result;
}

/**
 * Why GitHub refused, in the words a maintainer can act on.
 *
 * A 403 ON THE RUNNERS ENDPOINTS MEANS ONE THING: listing, registering and
 * downloading runners are repository-ADMIN operations, so a token that can
 * read the code and still gets 403 here belongs to somebody who is not an
 * admin of the repository, or carries no `repo` scope. Saying "HTTP 403" alone
 * would send the reader looking at the network.
 */
export function apiRefusal(result: CommandResult, target: Target, what: string): RunnerFailure {
  const detail = describeFailure(result);
  if (/\b403\b/.test(result.stderr) || /must have admin/i.test(result.stderr)) {
    return new RunnerFailure(
      1,
      `${what} was refused (403): needs admin on ${target.slug}. Self-hosted runners are a repository-admin surface -- the maintainer's gh token must carry the 'repo' scope and its user must be an admin of ${target.slug}. gh said: ${detail}`,
    );
  }
  return new RunnerFailure(1, `${what} failed on ${target.slug}: ${detail}`);
}

/** A `gh` call that answers JSON; a refusal or an unreadable answer is exit 1. */
export function ghJson<T>(seams: Seams, args: readonly string[], target: Target, what: string): T {
  const result = gh(seams, args);
  if (result.code !== 0) throw apiRefusal(result, target, what);
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new RunnerFailure(
      1,
      `${what} on ${target.slug} answered something that is not JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

/** A plain object, or null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** How long each poll waits: the spec's 10 s, in one place. */
export const POLL_INTERVAL_MS = 10_000;

/** A blocking wait. The command layer owns the real one; tests hand in a recorder. */
export type Sleep = (ms: number) => void;

/** The real wait: blocks this (synchronous) verb without a busy loop, as ../watch/until.ts does. */
export const realSleep: Sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
