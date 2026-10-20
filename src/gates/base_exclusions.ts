// src/gates/base_exclusions.ts -- checks.excluded at BOTH the PR base and
// the default-branch tip (#403). A stacked base may carry an unreviewed ruling;
// only complete declarations shared with the pinned default tip may remove a
// check. Transports supply immutable reads; this module owns the pure policy.

import { SchemaError } from "../schema/errors.js";
import { parseCheckExclusions, parseGatesText, type DeclaredCheckExclusion } from "../schema/gates.js";

/** What reading `nen/gates.json` at the base produced. */
export type BaseGatesRead =
  | { readonly kind: "read"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly message: string };

export interface BaseExclusions {
  /** The exclusions authorised by both pinned sources, or none. */
  readonly exclusions: readonly DeclaredCheckExclusion[];
  /** Loud: a ruling someone declared did not apply, and why. */
  readonly warnings: readonly string[];
  /**
   * Quiet (hanten round 2, N3): a source could not be read and no declaration
   * is visible locally or on the other valid side. Every check still counts.
   * `--json` and `--explain` carry the pinned source and failure.
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

/** The file read at each trusted commit. */
export const BASE_GATES_PATH = "nen/gates.json";

/** One pinned source of a declaration; both must authorise its complete value. */
export interface ExclusionsSource {
  readonly read: BaseGatesRead;
  readonly source: string;
}

/** Full normalised declaration identity; a selector alone cannot extend a ruling. */
function declarationKey(entry: DeclaredCheckExclusion): string {
  return JSON.stringify([entry.match, entry.name, entry.reason, entry.ruled,
    typeof entry.until === "string" ? ["date", entry.until] : ["condition", entry.until.condition]]);
}

/**
 * The base/default-tip INTERSECTION, in base order (zheref/nen#403). Neither
 * a stacked base nor a newer default tip can widen the other's ruling. Parse
 * each independently through the version, duplicate-key and unknown-key guards;
 * a missing/refused/unreadable side authorises nothing. The local file is only
 * a diagnostic input, including when explicitly selected with --gates.
 */
export function exclusionsAtBoth(
  base: ExclusionsSource,
  defaultTip: ExclusionsSource,
  local: readonly DeclaredCheckExclusion[],
): BaseExclusions {
  const sides = [
    { ...base, label: "pull request's base" },
    { ...defaultTip, label: "default-branch tip" },
  ].map((side) => {
    let entries: readonly DeclaredCheckExclusion[] = [];
    let failure: string | null = null;
    if (side.read.kind === "failed") failure = `the ${side.label} could not be read (${side.read.message})`;
    if (side.read.kind === "read") {
      try {
        entries = parseCheckExclusions(side.source, parseGatesText(side.source, side.read.text));
      } catch (error) {
        if (!(error instanceof SchemaError)) throw error;
        failure = `the ${side.label} refused its declaration (${error.message})`;
      }
    }
    return { ...side, entries, failure, keys: new Set(entries.map(declarationKey)) };
  });
  const warnings: string[] = [];
  const notes: string[] = [];
  const visible = [...local, ...sides.flatMap((side) => side.entries)];
  const failed = sides.some((side): boolean => side.failure !== null);
  for (const side of sides) {
    if (side.failure === null) continue;
    const message = `${side.failure} at ${side.source}. No declared exclusion was applied; every check counts on CON-32(a).`;
    if (visible.length > 0) warnings.push(`declared check exclusions NOT honoured: ${message}`);
    else notes.push(`could not confirm the ${side.label} declares no exclusion: ${message}`);
  }
  const first = sides[0];
  const second = sides[1];
  const exclusions = failed ? [] : (first?.entries ?? []).filter((entry): boolean => second?.keys.has(declarationKey(entry)) === true);
  const applied = new Set(exclusions.map(declarationKey));
  const reported = new Set<string>();
  for (const entry of visible) {
    const key = declarationKey(entry);
    if (applied.has(key) || reported.has(key)) continue;
    reported.add(key);
    const rejecting = sides.filter((side): boolean => side.failure !== null || !side.keys.has(key));
    warnings.push(`declared exclusion '${entry.name}' NOT honoured: the complete declaration is not authorised by ${rejecting.map((side): string => `the ${side.label} (${side.source})`).join(" and ")}. Both pinned sources must declare the same match, name, reason, ruled and until.`);
  }
  return { exclusions, warnings, notes };
}
