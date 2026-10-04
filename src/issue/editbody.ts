// src/issue/editbody.ts -- `nen issue edit-body`: replace one issue's body
// outright, byte for byte, through `gh issue edit --body-file`.
//
// WHY IT EXISTS. `nen issue file` writes an issue's OPENING body once, at
// create time, and there was no mechanised way to REPLACE it afterwards --
// a skill that needed to rewrite a stale plan, a reconciled parent body, or a
// template-filled section had to drop back to a hand-run `gh issue edit
// <n> --body-file <f>` for the one step that changes what an issue says,
// the same gap ./comment.ts's header records for posting. This verb closes
// it for the body specifically: no template, no merge, no diff -- the file's
// bytes become the issue's body, exactly.
//
// WHY IT DOES NOT ACCEPT A PULL REQUEST'S NUMBER, AND `issue comment` DOES.
// GitHub numbers issues and pull requests in one sequence and serves both
// from `issues/{n}`, and ./comment.ts's own header explains why a comment
// accepts either class deliberately: posting a caller's text is what the
// caller asked for either way, and the printed URL makes a mistyped number
// visible on the very next line. REPLACING THE WHOLE BODY IS A DIFFERENT
// ACT. It is not additive -- whatever the object said before is gone -- and
// it is invisible the moment the command exits, the same property that made
// ./subissue.ts's attach/close refuse a pull request rather than accept one
// silently. So this verb certifies the number as an ISSUE, over the same
// `issues/{n}` read `readIssue` already performs for that family, before it
// writes anything at all.
//
// THE FILE IS READ RAW, AND CHECKED BEFORE ANYTHING IS SENT -- the same two
// decisions ./comment.ts's `--body-file` path makes, for the same reasons: a
// `--dry-run` whose printed byte count is not the byte count that would be
// sent is not a dry run, and `gh` is handed the caller's ORIGINAL path
// untouched, so both sides read the same bytes without either one moving.
//
// LOST UPDATES, AND WHAT `--expect-body-sha256` DOES AND DOES NOT BUY
// (zheref/nen#205). A whole-body replacement is prepared from SOME earlier
// version of the body. If writers A and B both read v1, B writes v2, and A
// then submits a replacement prepared from v1, B's additions are gone and
// nothing says so. `--expect-body-sha256 <hex>` names the version the
// replacement was prepared from; the certifying read this verb already makes
// carries the CURRENT body, and when its sha256 differs the verb refuses at
// exit 3 (a conflict) and writes nothing, printing the current hash so the
// caller can re-read, re-fold and retry.
//
// IT IS NOT A COMPARE-AND-SWAP, AND NOTHING HERE MAY CALL IT ONE. GitHub's
// issue-update API takes no precondition (no If-Match, no expected version),
// so the check is read -> compare -> write: two requests, with a window
// between them in which another writer's update can land and then be
// overwritten by this one, undetected. Doing the compare on the very read
// that immediately precedes the write makes that window as narrow as this
// backend allows; it does not close it. Every report this verb prints under
// the flag says so (`atomic: false` under --json), and a caller that needs
// exclusion must still serialise its own writers or use an additive comment.
//
// AN UNCERTAIN WRITE IS NEVER REPORTED AS WRITTEN. A `gh issue edit` that
// started and then failed -- a non-zero exit, a dropped connection after
// GitHub applied the change -- cannot tell "refused" from "applied, answer
// lost". So the verb reads the body back once, reports what it saw
// (`written: null`, `outcome: "uncertain"`), and exits 1; it never prints
// "replaced". A `gh` that could not be STARTED is the one failure that is
// certain: nothing was sent, so it is `outcome: "not-sent"`, `written: false`,
// with no read-back (the read would need the same missing `gh`).
//
// WHERE A CALLER'S EXPECTED HASH COMES FROM. `--current-body-out <path>` writes
// the exact bytes of the certifying read -- on a dry run and on a conflict --
// so a fold is prepared from the very bytes whose sha256 the report prints,
// rather than from a second read taken at some other moment.

import { createHash } from "node:crypto";
import { GH, outputLines, type Seams } from "../seam/exec.js";
import { VerbUsageError } from "../cli/command.js";
import type { Target } from "../github/target.js";
import { readIssue, type IssueSummary } from "./subissue.js";

/**
 * The sha256 an expectation is compared against: lowercase hex over the
 * body's UTF-8 bytes, exactly as the REST payload's `body` field carries it
 * (GitHub's `null` -- an issue never given a body -- hashes as ""). No
 * trimming, no newline normalisation: a hash computed over a copy with an
 * extra trailing newline is a DIFFERENT version, and refusing it as a
 * conflict is the safe failure.
 */
export function bodySha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Read `--expect-body-sha256`'s value: 64 hex digits, case-insensitive,
 * returned lowercase. Anything else is a usage error (exit 2) -- a malformed
 * expectation could never match, and refusing it as a "conflict" would send a
 * caller off to reconcile a body that never changed.
 */
export function parseExpectedSha256(raw: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new VerbUsageError(
      `--expect-body-sha256 takes a sha256 as 64 hex digits -- got '${raw}'. It is the hash of the body your replacement was prepared from (UTF-8 bytes of the API's 'body' field, untrimmed); 'nen issue edit-body --dry-run --current-body-out <path>' writes the current body's bytes and prints their hash, so prepare your fold from that file.`,
    );
  }
  return raw.toLowerCase();
}

/** What the certifying read found about the current body, for the expectation check. */
export interface BodyCheck {
  /**
   * sha256 of the body as read just before the write; null only when the
   * payload carried no `body` key (and then no expectation can be checked).
   */
  readonly currentSha256: string | null;
  readonly currentBytes: number | null;
  /** The caller's expectation, or null when none was given. */
  readonly expectedSha256: string | null;
  /** "none" without an expectation; otherwise whether the read matched it. */
  readonly result: "none" | "matched" | "conflict";
}

/**
 * Refused, rather than compared, when the read carried no `body` key: hashing
 * an absent body as "" would let an expectation of the empty body "match" a
 * body nobody saw. Thrown as a plain error (exit 1) -- the invocation was
 * fine; the answer was not one this check can stand on.
 */
export class BodyUnreadError extends Error {
  constructor(slug: string, issue: number, why: string) {
    super(
      `${slug}#${issue}'s read carried no 'body' field, so ${why} -- nothing was written. A null body is "", but an absent field is a payload this check cannot stand on; re-run, and report it if it persists.`,
    );
    this.name = "BodyUnreadError";
  }
}

export function checkExpectedBody(summary: IssueSummary, expectedSha256: string | null, slug: string): BodyCheck {
  const current = summary.body;
  if (current === undefined) {
    if (expectedSha256 !== null) {
      throw new BodyUnreadError(slug, summary.number, "--expect-body-sha256 cannot be compared with it");
    }
    return { currentSha256: null, currentBytes: null, expectedSha256: null, result: "none" };
  }
  const currentSha256 = bodySha256(current);
  return {
    currentSha256,
    currentBytes: Buffer.byteLength(current, "utf8"),
    expectedSha256,
    result: expectedSha256 === null ? "none" : expectedSha256 === currentSha256 ? "matched" : "conflict",
  };
}

/**
 * The `gh` call, built once and used by BOTH the dry run and the real write --
 * see ../issue/comment.ts's `commentArgv` for why that matters: the argv a
 * caller approves in a dry run must be the argv that runs, not a rendering of
 * it a later edit can drift away from.
 */
export function editBodyArgv(target: Target, issue: number): readonly string[] {
  // `--body-file -`: the body travels on stdin, the very bytes this verb read,
  // hashed and checked -- never re-read from the path by `gh` after the checks
  // (zheref/nen#329).
  return ["issue", "edit", String(issue), "--repo", target.slug, "--body-file", "-"];
}

/**
 * Refuse (as a usage error, exit 2) when `issue` turns out to name a pull
 * request, BEFORE anything is written.
 *
 * Reuses `readIssue` rather than a second `gh api issues/{n}` call of its
 * own: that function already reads the one endpoint that discriminates both
 * object classes for this family (`pull_request` present on a pull request,
 * absent on a genuine issue), and it is already the certification
 * `attach-sub`/`consolidate-close` run for the same reason -- see
 * ./subissue.ts's header.
 *
 * A USAGE ERROR, NOT `NotAnIssueError`, AND THAT IS A DELIBERATE DIFFERENCE
 * FROM THIS FAMILY'S OTHER OBJECT-CLASS REFUSAL. `attach-sub` and
 * `consolidate-close` throw `NotAnIssueError` (exit 1, a "this specific
 * write was refused" report) because they may be certifying several numbers
 * at once and reporting which ones were the problem. `edit-body` certifies
 * exactly one number that the caller named directly with `--issue`, on a
 * verb whose whole shape says "you are pointed at the wrong family" -- the
 * same class of mistake a malformed flag is. `VerbUsageError` (exit 2) says
 * that plainly, and matches the exit code this verb's own spec requires.
 */
export function certifyIssue(seams: Seams, target: Target, issue: number): IssueSummary {
  const summary = readIssue(seams, target, issue);
  if (!summary.isPullRequest) return summary;
  throw new VerbUsageError(
    `#${issue} names a pull request in ${target.slug}, not an issue -- 'nen issue edit-body' replaces an ISSUE's body only, and it is certified before any write, so nothing was changed. ` +
      `Ask 'nen pr edit-body' for the pull request's body instead.`,
  );
}

/**
 * `gh` could not be STARTED, so nothing was sent -- the one write failure whose
 * outcome is certain, and therefore never reported as "uncertain".
 */
export class BodyNotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyNotSentError";
  }
}

/** Replace the issue's body. Throws on anything `gh` did not exit 0 on. */
export function writeIssueBody(seams: Seams, target: Target, issue: number, body: string): void {
  const argv = editBodyArgv(target, issue);
  const result = seams.run(GH, argv, { stdin: body });
  if (result.spawnFailed) {
    throw new BodyNotSentError(
      `could not replace ${target.slug}#${issue}'s body: gh could not be started (${
        outputLines(result.stderr).join(" ") || `exit ${result.code}`
      }), so nothing was sent`,
    );
  }
  if (result.code !== 0) {
    throw new Error(
      `could not replace ${target.slug}#${issue}'s body: ${
        outputLines(result.stderr).join(" ") || `exit ${result.code}`
      }`,
    );
  }
}

/**
 * After a write `gh` did not confirm: read the body back ONCE and say what it
 * holds. Never a verdict of "written" -- a body equal to the submitted bytes
 * may equally be another writer's identical text, and a body that differs may
 * still be overwritten by a request GitHub has not finished applying. The
 * read-back narrows what the caller has to reconcile; it certifies nothing.
 */
export interface ReadBack {
  readonly currentSha256: string | null;
  /** The body now equals the bytes this run submitted. */
  readonly matchesSubmitted: boolean | null;
  /** The body now equals what the certifying read saw (bodyCheck.currentSha256). */
  readonly matchesPrevious: boolean | null;
  readonly readError: string | null;
}

export function readBackAfterFailedWrite(
  seams: Seams,
  target: Target,
  issue: number,
  submittedSha256: string,
  previousSha256: string | null,
): ReadBack {
  try {
    const summary = readIssue(seams, target, issue);
    if (summary.body === undefined) {
      return {
        currentSha256: null,
        matchesSubmitted: null,
        matchesPrevious: null,
        readError: `${target.slug}#${issue}'s read-back carried no 'body' field`,
      };
    }
    const currentSha256 = bodySha256(summary.body);
    return {
      currentSha256,
      matchesSubmitted: currentSha256 === submittedSha256,
      matchesPrevious: previousSha256 === null ? null : currentSha256 === previousSha256,
      readError: null,
    };
  } catch (error) {
    return {
      currentSha256: null,
      matchesSubmitted: null,
      matchesPrevious: null,
      readError: error instanceof Error ? error.message : String(error),
    };
  }
}
