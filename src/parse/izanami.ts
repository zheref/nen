// src/parse/izanami.ts -- the izanami invocation grammar (`<task> until
// <condition>`, no cap), and the read-only/mutating classification against
// izanami's own explicit table (§2).
//
// CLASSIFY BEFORE RUNNING IT ONCE. The skill is explicit: "If any part of it
// writes, izanami refuses and names izanagi" -- and "refuse the WHOLE run, not
// the offending step", because a loop that runs four of five commands and
// skips the fifth reports a condition it never actually tested. So this module
// classifies every command up front and the caller (../watch/until.ts) never
// gets to observe a task with even one refused command in it.
//
// AN UNRECOGNIZED COMMAND IS TREATED AS MUTATING, NEVER AS SAFE. The skill's
// table is an ALLOWLIST (read-only) alongside named refusals; it is not
// exhaustive of every gh/git subcommand that exists. A command matching
// neither list is unknown, and "resolve or refuse, never guess" -- the rule
// every parser in this repository already follows -- means an unknown
// classification blocks the run exactly as a known-mutating one does.
//
// THE COMMAND VOCABULARY HERE IS gh/git's OWN -- structural CLI grammar, not a
// target repository's persona/label/check-name/colour vocabulary (§3). The
// skill's table also names its own mutating sibling skills by name (drive,
// build, file, tensho, jujisho, getsuga, backlog-synthesis, backlog-loop) as a
// refused example; that naming is NOT reproduced here as a literal, because
// this binary's taxonomy-purity sweep (src/taxonomy-purity.test.ts) treats a
// hard-coded system/skill name in shipped code exactly like a hard-coded label
// -- decided-with, not merely read. A task string that does not match a known
// gh/git read shape below already classifies as "unknown", which blocks the
// run exactly as the skill's named refusals would; naming the specific skill in
// the reason string is a UX nicety this port gives up rather than hard-coding
// a system name (a deviation, reported rather than hidden).

export interface IzanamiInvocation {
  readonly commands: readonly string[];
  readonly condition: string;
}

export interface IzanamiParseError {
  readonly message: string;
}

export type IzanamiParseResult =
  | { readonly ok: true; readonly value: IzanamiInvocation }
  | { readonly ok: false; readonly error: IzanamiParseError };

const UNTIL = /\buntil\b/gi;

function lastMatch(text: string, pattern: RegExp): RegExpMatchArray | undefined {
  return [...text.matchAll(pattern)].at(-1);
}

// Two forms (skill §1): `<task> until <condition>` on one line, or `until
// <condition>` on its own line followed by one command per subsequent line.
export function parseIzanamiInvocation(raw: string): IzanamiParseResult {
  const lines = raw.split("\n").map((line): string => line.trim());
  const firstLine = lines[0] ?? "";
  if (firstLine === "" && lines.length <= 1) {
    return { ok: false, error: { message: "empty invocation. Expected '<task> until <condition>'." } };
  }

  const until = lastMatch(firstLine, UNTIL);
  if (until === undefined || until.index === undefined) {
    return { ok: false, error: { message: "no 'until <condition>'. Expected '<task> until <condition>'." } };
  }
  const task = firstLine.slice(0, until.index).trim();
  const condition = firstLine.slice(until.index + until[0].length).trim();
  if (condition === "") {
    return { ok: false, error: { message: "the condition is empty." } };
  }

  const rest = lines.slice(1).filter((line): boolean => line !== "");
  if (task === "" && rest.length === 0) {
    return {
      ok: false,
      error: { message: "no task and no commands to repeat -- expected a task on the first line, or a command per following line." },
    };
  }
  const commands = task === "" ? rest : [task];
  return { ok: true, value: { commands, condition } };
}

export type Classification = "read-only" | "mutating" | "unknown";

export interface ClassifyResult {
  readonly classification: Classification;
  readonly reason: string;
}

// Read-only gh/git subcommands (§2's left column), matched on the FIRST two or
// three tokens -- deliberately narrow, so `gh pr merge` does not accidentally
// match a `gh pr` prefix meant for `view`/`checks`/`list`.
const READ_ONLY_PATTERNS: readonly RegExp[] = [
  /^gh\s+pr\s+(view|checks|list|diff|status)\b/i,
  /^gh\s+issue\s+(view|list)\b/i,
  /^gh\s+run\s+(view|list|watch)\b/i,
  /^gh\s+repo\s+view\b/i,
  /^git\s+(fetch|log|diff|status|ls-tree|show|branch|remote(\s+-v)?)\b/i,
];

// `gh api` is read-only ONLY for a GET (its default method, or an explicit
// `-X GET`/`--method GET`). Any other verb is a write.
const GH_API = /^gh\s+api\b/i;
const GH_API_WRITE_METHOD = /(-X|--method)\s+(POST|PATCH|PUT|DELETE)\b/i;

// Explicitly refused (§2's right column), named rather than left to fall
// through to "unknown" -- the skill states them, so the refusal message can
// name the actual rule instead of a generic "not on the allowlist".
const MUTATING_PATTERNS: readonly RegExp[] = [
  /^git\s+(push|commit|merge|tag|rebase|reset|clean)\b/i,
  /^git\s+checkout\s+-b\b/i,
  /^gh\s+(pr|issue)\s+(create|edit|close|merge|comment|review|reopen)\b/i,
  /^gh\s+(label|release)\s+(create|edit|delete)\b/i,
];

export function classifyCommand(command: string): ClassifyResult {
  const trimmed = command.trim();

  for (const pattern of MUTATING_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { classification: "mutating", reason: `matches a refused pattern (${pattern.source})` };
    }
  }

  if (GH_API.test(trimmed)) {
    if (GH_API_WRITE_METHOD.test(trimmed)) {
      return { classification: "mutating", reason: "gh api with a POST/PATCH/PUT/DELETE method" };
    }
    return { classification: "read-only", reason: "gh api with no write method -- GET by default" };
  }

  for (const pattern of READ_ONLY_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { classification: "read-only", reason: `matches izanami's allowlist (${pattern.source})` };
    }
  }

  return {
    classification: "unknown",
    reason: "matches neither izanami's allowlist nor a named refusal -- an unrecognized command is never assumed safe",
  };
}

export interface ClassifiedInvocation {
  readonly ok: boolean;
  readonly condition: string;
  readonly commands: readonly { readonly command: string; readonly classification: ClassifyResult }[];
}

export function classifyInvocation(invocation: IzanamiInvocation): ClassifiedInvocation {
  const commands = invocation.commands.map((command): { command: string; classification: ClassifyResult } => ({
    command,
    classification: classifyCommand(command),
  }));
  return {
    ok: commands.every((entry): boolean => entry.classification.classification === "read-only"),
    condition: invocation.condition,
    commands,
  };
}
