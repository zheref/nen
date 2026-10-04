// src/schema/fixtures/own_gates.ts -- THIS repository's own nen/gates.json, as
// the suites that pin the maintainer's live gate read it, while zheref/nen#240
// is open.
//
// WHY THIS EXISTS, AND WHEN IT GOES. From zheref/nen#310 an unknown key fails
// the read, and this repository's own file still declares
// `round_policy.minRounds` and `maxRounds`, which nen does not read until
// zheref/nen#240 tables them (maintainer ruling of 2026-10-04: #310 ships after
// #240). Until then the file is REFUSED -- `gates.test.ts` pins that refusal,
// naming exactly those two keys, so it flips when #240 lands. The suites that
// pin the gate's CONTENT keep running against the real file by reading it with
// exactly those two keys removed and nothing else. Removing more would hide a
// real refusal; the pinned refusal test is what proves it is only these two.
//
// TODO(zheref/nen#240): delete this file and load the file directly
// (`loadGateIdentities(process.cwd())`) once #240 makes both keys nen's.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGateIdentities, type GateIdentities } from "../gates.js";

/** The two keys zheref/nen#240 adopts; the only ones removed. */
export const PENDING_240_KEYS = ["minRounds", "maxRounds"] as const;

export interface OwnGates {
  readonly path: string;
  /** The parsed file with only `round_policy.minRounds`/`maxRounds` removed. */
  readonly raw: Record<string, unknown>;
  readonly identities: GateIdentities;
}

export function loadOwnGates(): OwnGates {
  const path = join(process.cwd(), "nen", "gates.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const policy = parsed["round_policy"];
  const raw =
    typeof policy === "object" && policy !== null && !Array.isArray(policy)
      ? {
          ...parsed,
          round_policy: Object.fromEntries(
            Object.entries(policy).filter(
              ([key]): boolean => !(PENDING_240_KEYS as readonly string[]).includes(key),
            ),
          ),
        }
      : parsed;
  return { path, raw, identities: parseGateIdentities(path, raw) };
}
