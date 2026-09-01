// src/parse/izanagi.ts -- the izanagi invocation grammar: `<task> until
// <condition> up to <N>`, where the cap is REQUIRED, not defaulted.
//
// THE CAP IS GRAMMAR, NOT A DEFAULT (the skill's own §1). izanagi is the
// MUTATING half of the loop pair, and "there is no default N" is the whole
// safety property: an invocation without a well-formed 'up to <N>' is REFUSED,
// never run with an inferred or assumed cap, because a cap the caller did not
// type is a cap they did not agree to on a loop that performs writes.
//
// BOTH SEPARATORS ARE MATCHED ON THE LAST WHOLE-WORD OCCURRENCE, for the same
// reason ../parse/futon.ts reads its terminal that way: a task description
// containing the word "until" or the phrase "up to" in ordinary prose is a real
// thing someone types, and matching the first occurrence would silently split
// the sentence in the wrong place.

export interface IzanagiInvocation {
  readonly task: string;
  readonly condition: string;
  readonly cap: number;
}

export interface IzanagiParseError {
  readonly message: string;
  readonly correctedLine: string | null;
}

export type IzanagiParseResult =
  | { readonly ok: true; readonly value: IzanagiInvocation }
  | { readonly ok: false; readonly error: IzanagiParseError };

const UNTIL = /\buntil\b/gi;
const UP_TO = /\bup to\b/gi;

function lastMatch(text: string, pattern: RegExp): RegExpMatchArray | undefined {
  return [...text.matchAll(pattern)].at(-1);
}

export function parseIzanagiInvocation(raw: string): IzanagiParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {
      ok: false,
      error: { message: "empty invocation. Expected '<task> until <condition> up to <N>'.", correctedLine: null },
    };
  }

  const upTo = lastMatch(trimmed, UP_TO);
  if (upTo === undefined || upTo.index === undefined) {
    return {
      ok: false,
      error: {
        message:
          "no 'up to <N>'. Izanagi is the MUTATING half of the loop pair and the cap is required grammar, never defaulted or inferred -- an invocation without it is refused rather than run once 'to see'.",
        correctedLine: `${trimmed} up to <N>`,
      },
    };
  }
  const capText = trimmed.slice(upTo.index + upTo[0].length).trim();
  const cap = Number(capText);
  if (!Number.isInteger(cap) || cap <= 0) {
    return {
      ok: false,
      error: {
        message: `'up to ${capText || "(nothing)"}' is not a positive integer cap.`,
        correctedLine: `${trimmed.slice(0, upTo.index).trim()} up to 3`,
      },
    };
  }

  const beforeCap = trimmed.slice(0, upTo.index).trim();
  const until = lastMatch(beforeCap, UNTIL);
  if (until === undefined || until.index === undefined) {
    return {
      ok: false,
      error: {
        message: "no 'until <condition>'. Expected '<task> until <condition> up to <N>'.",
        correctedLine: `${beforeCap} until <condition> up to ${cap}`,
      },
    };
  }
  const task = beforeCap.slice(0, until.index).trim();
  const condition = beforeCap.slice(until.index + until[0].length).trim();
  if (task === "" || condition === "") {
    return {
      ok: false,
      error: {
        message: task === "" ? "the task description is empty." : "the condition is empty.",
        correctedLine: null,
      },
    };
  }

  return { ok: true, value: { task, condition, cap } };
}
