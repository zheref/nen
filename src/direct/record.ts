// src/direct/record.ts -- where `nen direct resolve --record` writes, and the one
// refusal that keeps it there.
//
// WHY IT IS ITS OWN MODULE. A record is the ledger of what was recommended for one
// effort, so the maintainer (and the skill that asked once about a mismatch) can
// read it back. It is OUTPUT: it goes under `.nen/direct/` -- the gitignored
// scratch tree, never `nen/`, which is the repository's declarations -- under
// `--repo`'s root, which is the core checkout, so it exists before any worktree does.
//
// THE NAME IS THE EFFORT'S IDENTITY, a string the CALLER types: `<CODE>-IS-#<N>` for
// an issue, `inline-<ISO-8601 UTC>` for a textual effort. It is percent-encoded
// into the file name exactly as `nen usage record` encodes `--effort` for
// `.nen/usage/<effort>.json` (../usage/ledger.ts `usageLedgerPath`:
// `encodeURIComponent`, which is injective, so no two efforts share a file and a `/`
// can never open a subdirectory). That helper is bound to the usage directory, so
// the one expression is mirrored here rather than imported; if the encoding there
// ever changes, this must move with it so one effort names both ledgers the same way.
//
// A typed name that reached the filesystem unchecked would be a way to write anywhere,
// so a name that is empty, absolute, carries a backslash or a NUL, or has a `..`
// segment is refused as a USAGE error (exit 2: "you typed it wrong"), and the
// resolved path is checked to still sit under the directory before a byte is written.
// The encoding makes the last check unreachable today; it stays because it is the
// property the refusal exists for, not the encoding's side effect.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { VerbUsageError } from "../cli/command.js";

/** The one directory a record may be written under, relative to `--repo`'s root. */
export const RECORD_DIR = ".nen/direct";

/** The absolute path a record for the effort `id` is written to, or a usage refusal. */
export function recordPath(root: string, id: string): string {
  const refuse = (why: string): never => {
    throw new VerbUsageError(`--record '${id}' is refused: ${why}. It is the effort's id; the record is written as ${RECORD_DIR}/<percent-encoded id>.json.`);
  };
  if (id.trim() === "") return refuse("it is empty");
  if (id.includes("\\")) return refuse("it contains a backslash");
  if (id.includes("\0")) return refuse("it contains a NUL");
  if (id.startsWith("/") || /^[A-Za-z]:/.test(id)) return refuse("it is an absolute path");
  if (id.split("/").some((segment): boolean => segment === "..")) return refuse("a segment is '..'");
  const directory = resolve(root, RECORD_DIR);
  const full = resolve(directory, `${encodeURIComponent(id)}.json`);
  if (!full.startsWith(directory + sep)) return refuse("it resolves outside the record directory");
  return full;
}

/** Write the document at `path`, creating its directories. */
export function writeRecord(path: string, document: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
}
