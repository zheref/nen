// src/audit/verdict.ts -- the two ways `nen audit deps` stops short of a
// verdict, as types, so no reader can confuse them (zheref/nen#508, AC-8).
//
// FOUR EXITS, FOUR FACTS. 0 looked and found nothing at or above the floor;
// 1 looked and found something (a finding, an unrated id, or an entry that
// could not be queried); 2 WIRING -- the invocation or the contract is wrong,
// or nen itself failed -- which says nothing about the tree; 3 NOT SCANNED --
// the tree or the advisory service could not be read, named. A caller that
// collapsed 3 into 0 would read an unreachable advisory service as a clean
// tree, which is the one outcome this verb exists to make impossible.

/** The tree or the advisory service could not be read: exit 3, with the reason. */
export class NotScanned extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotScanned";
  }
}

/** The contract or the invocation is wrong: exit 2, never a verdict about the tree. */
export class Wiring extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Wiring";
  }
}

export function notScanned(reason: string): never {
  throw new NotScanned(reason);
}

/** One exact package pin, as the advisory service is asked about it. */
export interface Pin {
  readonly name: string;
  readonly version: string;
}

/** What one lockfile or resolved-file entry is. */
export type Entry =
  | { readonly kind: "registry"; readonly pin: Pin }
  | { readonly kind: "local" }
  | { readonly kind: "unqueried" };

/** What the tree resolved to, before any query. */
export interface Resolution {
  /** `pnpm`, `yarn`, `npm`, or `swiftpm`. */
  readonly manager: string;
  /** The file(s) read, relative to the audited directory. */
  readonly files: readonly string[];
  /** How the manager was selected, for the human line. */
  readonly source: string;
  readonly pins: readonly Pin[];
  readonly local: number;
  readonly unqueried: number;
  /** `audit-config:` evidence: a key or a file the verb saw and did not honour. */
  readonly evidence: readonly Evidence[];
}

export interface Evidence {
  readonly file: string;
  /** The key, `other-lockfile`, or the reason the file could not be read. */
  readonly key: string;
  readonly kind: "other-lockfile" | "key" | "unreadable";
}

/** Fold entries into a resolution's counts, deduplicating pins by name@version. */
export function tally(entries: readonly Entry[]): { pins: Pin[]; local: number; unqueried: number } {
  const seen = new Map<string, Pin>();
  let local = 0;
  let unqueried = 0;
  for (const entry of entries) {
    if (entry.kind === "registry") seen.set(`${entry.pin.name}@${entry.pin.version}`, entry.pin);
    else if (entry.kind === "local") local += 1;
    else unqueried += 1;
  }
  return { pins: [...seen.values()], local, unqueried };
}
