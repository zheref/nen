// src/gates/base_exclusions.ts -- `checks.excluded` as the PULL REQUEST'S BASE
// declares it (zheref/nen#249, Feitan F1).
//
// WHY THE BASE. A declared exclusion removes a check from CON-32(a). Read from
// the checkout under `--repo` -- which in a worktree IS the pull request's own
// head -- a pull request could add an exclusion for its own failing check and
// read `ready` on the strength of a ruling nobody merged. So the exclusions are
// read from `nen/gates.json` AT THE BASE COMMIT GitHub reports for the pull
// request (`baseRefOid`), the same move `nen pr merge --release-unit` makes for
// `nen/workflow.json` (Feitan FEI-3). Reviewer identities keep their own
// source; only the exclusions move.
//
// EVERY FAILURE HONOURS NOTHING, AND SAYS SO. A base that could not be read, a
// base file that is not JSON, a base `checks.excluded` that does not validate:
// each yields no exclusion -- every check counts, the stricter verdict -- and a
// warning naming why. A base with NO `nen/gates.json` declares nothing; that is
// not a failure. An entry the LOCAL file declares that the base does not is
// named too, because that is exactly the shape of a pull request trying to
// exempt itself, and of an honest ruling that simply has not merged yet.
//
// Pure: the transports (`pr ready`'s token client, `pr next-blocker`'s `gh`)
// do the reading and hand the outcome here.

import { SchemaError } from "../schema/errors.js";
import { parseCheckExclusions, type DeclaredCheckExclusion } from "../schema/gates.js";

/** What reading `nen/gates.json` at the base produced. */
export type BaseGatesRead =
  | { readonly kind: "read"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly message: string };

export interface BaseExclusions {
  /** The exclusions to apply: the base's, or none. */
  readonly exclusions: readonly DeclaredCheckExclusion[];
  /** Loud: a ruling someone declared did not apply, and why. */
  readonly warnings: readonly string[];
  /**
   * Quiet (hanten round 2, N3): the base could not be read, but NEITHER the
   * local file declares an exclusion, so no ruling anybody can see was lost.
   * The verdict is still the stricter one; this only says it could not be
   * confirmed that the base declares none. `--json` and `--explain` carry it.
   */
  readonly notes: readonly string[];
}

/**
 * The file content a REST `contents/{path}?ref=` payload carries, decoded --
 * or a thrown Error naming why there is none (hanten round 2, N6). Refuses a
 * payload that is not a single file (`type` other than `file`, or an array
 * for a directory), one whose `encoding` is not `base64` (GitHub answers
 * `none` with empty content for a file over its inline limit, so the size is
 * named), and content outside the base64 alphabet, which `Buffer.from` would
 * otherwise silently mangle (the reason ../release/unitcheck.ts's
 * `fetchJsonAtRef` validates it too).
 */
export function decodeContentsPayload(data: unknown, path: string, ref: string): string {
  const where = `contents/${path}@${ref}`;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${where} answered ${Array.isArray(data) ? "a directory listing" : "no object"}, not a file`);
  }
  const record = data as { type?: unknown; encoding?: unknown; content?: unknown; size?: unknown };
  if (record.type !== "file") {
    throw new Error(`${where} is of type ${JSON.stringify(record.type ?? null)}, not a file`);
  }
  if (record.encoding !== "base64") {
    throw new Error(
      `${where} answered encoding ${JSON.stringify(record.encoding ?? null)} (size ${JSON.stringify(record.size ?? null)} bytes), not base64, so its content was not delivered inline`,
    );
  }
  if (typeof record.content !== "string") throw new Error(`${where} answered no file content`);
  const base64 = record.content.replace(/\n/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new Error(`${where} answered content that is not base64`);
  }
  return Buffer.from(base64, "base64").toString("utf8");
}

/** The file the exclusions are read from, at the base. */
export const BASE_GATES_PATH = "nen/gates.json";

/**
 * Resolve the base read into the exclusions to apply. `source` names the file
 * at the base (`<owner>/<repo>@<sha>:nen/gates.json`) in every message; `local`
 * is what the checkout's own file declares, compared so an entry not yet at the
 * base is named rather than silently dropped.
 */
export function exclusionsAtBase(
  read: BaseGatesRead,
  source: string,
  local: readonly DeclaredCheckExclusion[],
): BaseExclusions {
  // LOUD when the local file declares something -- a ruling the reader
  // believes in did not apply. QUIET otherwise (N3): nothing visible was lost,
  // and a repository that never uses the feature should not read a warning on
  // every run because its token lacks contents:read.
  const refused = (why: string): BaseExclusions =>
    local.length > 0
      ? {
          exclusions: [],
          warnings: [
            `declared check exclusions NOT honoured: ${why}. They are read from ${source}, the pull request's BASE, so a pull request cannot exempt its own checks; every check counts on CON-32(a).`,
          ],
          notes: [],
        }
      : {
          exclusions: [],
          warnings: [],
          notes: [
            `could not confirm the base declares no exclusion: ${why}. No declared exclusion was applied; every check counts on CON-32(a).`,
          ],
        };
  let exclusions: DeclaredCheckExclusion[] = [];
  if (read.kind === "failed") return refused(`the base could not be read (${read.message})`);
  if (read.kind === "read") {
    let value: unknown;
    try {
      value = JSON.parse(read.text);
    } catch (error) {
      return refused(`${source} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    try {
      exclusions = parseCheckExclusions(source, value);
    } catch (error) {
      if (error instanceof SchemaError) return refused(error.message);
      throw error;
    }
  }
  const atBase = new Set(exclusions.map((entry): string => `${entry.match}\u0000${entry.name}`));
  const warnings = local
    .filter((entry): boolean => !atBase.has(`${entry.match}\u0000${entry.name}`))
    .map(
      (entry): string =>
        `declared exclusion '${entry.name}' is in the local nen/gates.json but not at the pull request's base (${source}) — NOT honoured until it is merged there.`,
    );
  return { exclusions, warnings, notes: [] };
}
