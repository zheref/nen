// src/direct/record.ts -- where `nen direct resolve --record` writes, and the one
// refusal that keeps it there.
//
// WHY IT IS ITS OWN MODULE. A record is the ledger of what was recommended for one
// effort, so the maintainer (and the skill that asked once about a mismatch) can
// read it back. It is OUTPUT: it goes under `.nen/direct/` -- never `nen/`, which
// is the repository's declarations -- and since zheref/nen#509 under the GIT
// COMMON DIRECTORY (`<git-common-dir>/.nen/direct/`, ../ledger/home.ts), so a
// worktree cleanup never takes it; under `--repo` only outside git. A record an
// older build wrote at `<checkout>/.nen/direct/` is moved there once on the next
// write.
//
// THE NAME IS THE EFFORT'S IDENTITY, a string the CALLER types: `<CODE>-IS-#<N>` for
// an issue, `inline-<ISO-8601 UTC>` for a textual effort. It is held to the ONE
// effort-id grammar every nen ledger admits (../ledger/effort.ts, which admits '#'
// and ':' for exactly these two ids) and percent-encoded into the file name by
// the one injective encoder, so no two efforts share a file and a `/` can never
// open a subdirectory. A refused id is a USAGE error (exit 2: "you typed it
// wrong"), in the same words `nen phase` and `nen usage` use, and the resolved path
// is checked to still sit under the directory before a byte is written. The
// encoding makes the last check unreachable today; it stays because it is the
// property the refusal exists for, not the encoding's side effect.

import { lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { writeLedgerAtomically } from "../ledger/lock.js";
import { realContainment } from "../repo/contain.js";
import { assertEffortId, encodeEffortId } from "../ledger/effort.js";
import type { EffortHome } from "../ledger/home.js";

/** The directory's last two segments: under the git common dir since #509, under `--repo` outside git. */
export const RECORD_DIR = ".nen/direct";

/** The absolute path a record for the effort `id` is written to in `home`, or a usage refusal. */
export function recordPath(home: EffortHome, id: string): string {
  assertEffortId(id);
  const directory = resolve(home.dir);
  const full = resolve(directory, `${encodeEffortId(id)}.json`);
  if (!full.startsWith(directory + sep)) {
    throw new VerbUsageError(`--record '${id}' is refused: it resolves outside the record directory ${home.display}.`);
  }
  return full;
}

/**
 * Refuse a record path the FILESYSTEM would send somewhere else (exit 2). The
 * lexical check in `recordPath` cannot see a `.nen/direct` directory, or an
 * existing target file, that is a symlink out of the home's base: `writeFileSync` follows
 * both. So the path is asked of ../repo/contain.ts's `realContainment` -- the real
 * path the kernel would reach must stay under the real root -- and a record that is
 * ITSELF a symlink is refused outright, even a dangling one or one pointing back
 * inside, because a record is a plain file this verb owns and `realContainment`
 * cannot prove a dangling link stays in. Called immediately before every read or
 * write of a record, so nothing is followed that this check has not seen.
 */
export function assertRecordContained(root: string, path: string): void {
  const refuse = (why: string): never => {
    throw new VerbUsageError(`the record '${path}' is refused: ${why}. A record is written only as a plain file under ${RECORD_DIR}/ in the git common directory (or --repo outside git).`);
  };
  const real = realContainment(root, path);
  if (!real.contained) {
    refuse(`it resolves to '${real.real}', outside the repository${real.link === null ? "" : ` (through the link '${real.link}' -> '${real.target ?? "?"}')`}`);
  }
  let stats;
  try {
    stats = lstatSync(path, { throwIfNoEntry: false });
  } catch {
    stats = undefined;
  }
  if (stats !== undefined && stats.isSymbolicLink()) refuse("it is a symbolic link");
}

/**
 * Write the document at `path` (under `root`), creating its directories, after the
 * containment check -- THROUGH A TEMP FILE AND A RENAME (../ledger/lock.ts's
 * `writeLedgerAtomically`, the phase and usage ledgers' writer), so a reader racing
 * the write sees the old record or the new one, never a torn one (Copilot review on
 * zheref/nen#380). The read-modify-write that `answer` performs takes the ledger lock
 * around this call; a fresh `resolve --record` write needs only the atomic replace.
 */
export function writeRecord(root: string, path: string, document: unknown): void {
  assertRecordContained(root, path);
  mkdirSync(dirname(path), { recursive: true });
  // mkdir may have created a directory a racing link redirected; ask again before the bytes go.
  assertRecordContained(root, path);
  writeLedgerAtomically(path, document);
}
