import type { CommandResult } from "../seam/exec.js";
import type { HoldState } from "./preflight.js";

/**
 * RELEASE_HOLD has THREE states, not two (review finding): `gh` failing to
 * spawn, exiting non-zero for a reason other than "the variable was never
 * created", must never read the same as a repository that genuinely has no
 * hold set -- a `gh` that is not installed, unauthenticated, or scoped
 * without variable-read access must fail the check, not fail it open.
 *
 * `gh variable get <name>`'s own message for a variable that was never
 * created is exactly `variable <name> was not found` (confirmed against a
 * live `gh` -- both a missing variable AND a missing/inaccessible repository
 * produce this identical text, since GitHub's API 404s both cases the same
 * way; there is no way to tell them apart from stderr text alone, so this
 * treats the shape gh actually documents as "unset" and everything else,
 * including a 403/permission error or a generic "HTTP 404: Not Found", as
 * unreadable). A second review finding: matching any stderr that merely
 * CONTAINS "not found" as a substring also matches unrelated errors like an
 * `HTTP 404: Not Found` from a different failure mode -- that reintroduces
 * the exact fail-open hole this function exists to close, so the match must
 * be anchored to gh's whole message shape, not a substring sniff.
 */
function isVariableNotFoundMessage(stderr: string, holdVar: string): boolean {
  const escapedVar = holdVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^variable ${escapedVar} (?:was )?not found$`, "i");
  return pattern.test(stderr.trim());
}

/**
 * The hold value is PARSED for truthiness, never merely length-checked
 * (zheref/nen#23). The shell `hold_active()` this row replaced read only
 * case-insensitive `true`/`1`/`yes` as an active hold and EVERYTHING else --
 * unset or `"false"` alike -- as inactive; the port's `value === ""` check
 * inverted that for the falsy half of the vocabulary, so a variable someone
 * set to `"false"` (instead of deleting) read as permanently HELD, and
 * setting it to `"false"` again did nothing. Only these two vocabularies are
 * recognized; matching is against the trimmed, lowercased value.
 */
const HOLD_TRUTHY = new Set(["true", "1", "yes"]);
const HOLD_FALSY = new Set(["false", "0", "no"]);

export function resolveHoldState(result: CommandResult, holdVar: string): HoldState {
  if (result.spawnFailed) {
    return { kind: "unreadable", detail: result.stderr.trim() || "gh could not be started" };
  }
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    if (isVariableNotFoundMessage(stderr, holdVar)) {
      return { kind: "unset" };
    }
    return { kind: "unreadable", detail: stderr || `gh exited ${result.code}` };
  }
  const value = result.stdout.trim();
  if (value === "") return { kind: "unset" };
  const lowered = value.toLowerCase();
  // An explicit falsy value releases the hold -- but as `clear`, not `unset`,
  // so the row can still tell the operator the variable is lingering and that
  // deleting it outright is the tidier repository state.
  if (HOLD_FALSY.has(lowered)) return { kind: "clear", value };
  // A DELIBERATE deviation from the pure shell convention (zheref/nen#23):
  // `hold_active()` read any value outside `true`/`1`/`yes` as inactive,
  // which means a hold set to the message that explains it -- `gh variable
  // set RELEASE_HOLD -b 'freeze until Monday'` -- would silently release
  // itself. An operator who typed a hold message intended a hold, and the
  // one row whose whole job is to stop a release must not fail open on a
  // spelling. So only the explicit falsy vocabulary above releases; every
  // other non-empty value stays HELD, with `recognizedTruthy` recording
  // whether it was the shared boolean vocabulary or a fail-closed arbitrary
  // string so the report can print WHY (../release/preflight.ts renders the
  // difference).
  return { kind: "held", value, recognizedTruthy: HOLD_TRUTHY.has(lowered) };
}

