// src/direct/record.ts -- where `nen direct resolve --record` writes, and the one
// refusal that keeps it there.
//
// WHY IT IS ITS OWN MODULE. A record is the ledger of what was recommended for one
// effort, so the maintainer (and the skill that asked once about a mismatch) can
// read it back. It is OUTPUT: it goes under `.nen/direct/` -- the gitignored
// scratch tree, never `nen/`, which is the repository's declarations -- and the
// name it is filed under is TYPED by the caller (an effort's branch, which
// legitimately contains `/`). A typed name that reached the filesystem unchecked
// is a way to write anywhere, so a name that is absolute, carries a backslash or
// a NUL, or has an empty, `.` or `..` segment is refused as a USAGE error (exit
// 2: "you typed it wrong"), and the resolved path is checked to still sit under
// the directory before a byte is written.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { VerbUsageError } from "../cli/command.js";

/** The one directory a record may be written under, relative to `--repo`'s root. */
export const RECORD_DIR = ".nen/direct";

/** The absolute path a record for `name` is written to, or a usage refusal. */
export function recordPath(root: string, name: string): string {
  const refuse = (why: string): never => {
    throw new VerbUsageError(`--record '${name}' is refused: ${why}. It names the effort's branch; the record is written as ${RECORD_DIR}/<name>.json.`);
  };
  if (name.trim() === "") return refuse("it is empty");
  if (name.includes("\\")) return refuse("it contains a backslash");
  if (name.includes("\0")) return refuse("it contains a NUL");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return refuse("it is an absolute path");
  const segments = name.split("/");
  if (segments.some((segment): boolean => segment === "" || segment === "." || segment === "..")) {
    return refuse("a segment is empty, '.' or '..'");
  }
  const directory = resolve(root, RECORD_DIR);
  const full = resolve(directory, `${name}.json`);
  if (!full.startsWith(directory + sep)) return refuse("it resolves outside the record directory");
  return full;
}

/** Write the document at `path`, creating its directories. */
export function writeRecord(path: string, document: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
}
