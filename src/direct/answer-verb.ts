// src/direct/answer-verb.ts -- `nen direct answer`.
//
// WHY IT EXISTS. `nen direct resolve --record <id>` files the resolution under
// `.nen/direct/<id>.json` BEFORE the skill's picker runs: the maintainer's answer
// (continue here, or stop and restart elsewhere) does not exist yet, and nothing
// else could write it afterwards. This verb adds it to THE SAME RECORD: it reads the
// record `--record <id>` names (the same id, the same percent-encoding and the same
// traversal refusals as resolve's), sets `decision: { answer, answeredAt }`, and
// rewrites the file in the form resolve wrote it (two-space indent, trailing newline),
// every other field unchanged. A second answer REPLACES the first: the ledger holds the
// last word, which is what a restarted session needs to read.
//
// THE ANSWER BELONGS TO A RESOLUTION THAT EXISTS: a missing record is a failure (exit 1,
// naming the path), never a created file. A record that is not JSON, not an object, not
// a `nen.direct.resolve/v0.1` document, or one whose `effortId` is not the id asked for
// (a copied or stale record under this name) is refused the same way and never rewritten.
// The read, the edit and the write happen under the ledger lock (../ledger/lock.ts) and
// the write replaces the file by rename, so two answers, or an answer racing a new
// `resolve --record`, serialise instead of overwriting each other, and a racing reader
// never sees a torn record (Copilot review on zheref/nen#380). The vocabulary of the answer is the
// picker's own two outcomes; any other value is a usage error (exit 2).
//
// EXIT CODES (docs/USAGE.md, "Exit codes"): 0 answered, 1 a missing or unreadable
// record, 2 a missing flag, an answer that is not one of the two, or a refused --record.

import { existsSync, readFileSync } from "node:fs";
import { requireRepoFlag, requireValue, VerbUsageError, type CommandContext } from "../cli/command.js";
import { assertRepoRoot } from "../repo/root.js";
import { withLedgerLock } from "../ledger/lock.js";
import { assertRecordContained, recordPath, writeRecord } from "./record.js";
import { RESOLVE_CONTRACT } from "./resolve-verb.js";

export const ANSWER_CONTRACT = "nen.direct.answer/v0.1";

/** The picker's two outcomes. */
export const ANSWERS: readonly string[] = ["continue", "stop"];

export function runAnswer(context: CommandContext): number {
  const args = context.args;
  const id = requireValue(args, "record", "It is the effort's id, as 'nen direct resolve --record' was given it.");
  const answer = requireValue(args, "answer", `It is the maintainer's picker answer: ${ANSWERS.join(" or ")}.`);
  const repoFlag = requireRepoFlag(context, "It is the checkout whose .nen/direct/ holds the record.");
  const root = assertRepoRoot({ repoFlag });
  const path = recordPath(root, id);
  if (!ANSWERS.includes(answer)) {
    throw new VerbUsageError(`--answer '${answer}' is not one of: ${ANSWERS.join(", ")}.`);
  }

  // Before anything is read: a record the filesystem redirects is not this effort's.
  assertRecordContained(root, path);
  if (!existsSync(path)) {
    context.io.err(`nen: no record at '${path}'. The answer belongs to a resolution that exists: run 'nen direct resolve --record ${id}' first.`);
    return 1;
  }
  const decision = { answer, answeredAt: context.seams.now().toISOString() };
  const refused = withLedgerLock(path, (): string | null => {
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      return `is not readable JSON (${error instanceof Error ? error.message : String(error)})`;
    }
    if (typeof document !== "object" || document === null || Array.isArray(document)) return "is not a JSON object";
    const record = document as Record<string, unknown>;
    if (record["contract"] !== RESOLVE_CONTRACT) {
      return `is not a ${RESOLVE_CONTRACT} record (contract: ${JSON.stringify(record["contract"] ?? null)})`;
    }
    if (record["effortId"] !== id) {
      return `records the effort ${JSON.stringify(record["effortId"] ?? null)}, not '${id}'`;
    }
    writeRecord(root, path, { ...record, decision });
    return null;
  }, { warn: context.io.err });
  if (refused !== null) {
    context.io.err(`nen: '${path}' ${refused}; it is not rewritten. The answer belongs to the resolution 'nen direct resolve --record ${id}' filed.`);
    return 1;
  }

  if (context.json) {
    context.io.out(JSON.stringify({ contract: ANSWER_CONTRACT, record: path, decision }, null, 2));
    return 0;
  }
  context.io.out(`answered ${answer} at ${decision.answeredAt}`);
  context.io.out(`recorded ${path}`);
  return 0;
}
