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
//
// `git branch` and `git remote` are matched on their FORM, not just their
// subcommand name -- both have mutating flag forms (`git branch -D`, `git
// remote add`) that read the same "subcommand" as their read-only siblings.
// These two patterns admit only the listing forms; anything else (a flag
// outside this set) falls through to MUTATING_PATTERNS below or, failing
// that, to "unknown" -- never silently read-only.
const READ_ONLY_PATTERNS: readonly RegExp[] = [
  /^gh\s+pr\s+(view|checks|list|diff|status)\b/i,
  /^gh\s+issue\s+(view|list)\b/i,
  /^gh\s+run\s+(view|list|watch)\b/i,
  /^gh\s+repo\s+view\b/i,
  /^git\s+(fetch|log|diff|status|ls-tree|show)\b/i,
  /^git\s+branch(\s+(-l|--list|-a|-r|-v|--contains|--show-current))*(\s+[^-\s]\S*)?$/i,
  /^git\s+remote(\s+(-v|show|get-url))?(\s+\S+)?$/i,
];

// `gh api` is read-only ONLY for a verified GET: no explicit non-GET method,
// no `-f`/`-F`/`--field`/`--raw-field`/`--input` value (gh's own documented
// rule is that the method defaults to POST the moment any parameter is
// given -- https://cli.github.com/manual/gh_api, "the method is POST when
// any parameters are added"), and not the `graphql` endpoint (a query and a
// mutation are indistinguishable from the CLI form, so graphql is never
// treated as read-only).
const GH_API = /^gh\s+api\b/i;
const GH_API_METHOD = /(?:-X\s*|--method(?:=|\s)\s*)([A-Za-z]+)/i;
const GH_API_FIELD_FLAG = /(?:^|\s)(-f|-F|--field|--raw-field|--input)\b/i;
const GH_API_GRAPHQL = /\bgraphql\b/i;

// Explicitly refused (§2's right column), named rather than left to fall
// through to "unknown" -- the skill states them, so the refusal message can
// name the actual rule instead of a generic "not on the allowlist". Checked
// FIRST, so a mutating flag form of an otherwise read-only subcommand (`git
// branch -D`, `git remote add`) always wins over the allowlist below.
const MUTATING_PATTERNS: readonly RegExp[] = [
  /^git\s+(push|commit|merge|tag|rebase|reset|clean)\b/i,
  /^git\s+checkout\s+-b\b/i,
  /^git\s+branch\b.*(?:\s|^)(-(d|m)\b|--(delete|move)\b)/i,
  /^git\s+remote\s+(add|remove|rm|set-url|rename|prune|set-head)\b/i,
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
    const methodMatch = GH_API_METHOD.exec(trimmed);
    const method = methodMatch?.[1];
    if (method !== undefined && !/^GET$/i.test(method)) {
      return { classification: "mutating", reason: `gh api with an explicit non-GET method (${method})` };
    }
    if (GH_API_FIELD_FLAG.test(trimmed)) {
      return {
        classification: "mutating",
        reason: "gh api with a -f/-F/--field/--raw-field/--input value -- gh defaults to POST once any parameter is given",
      };
    }
    if (GH_API_GRAPHQL.test(trimmed)) {
      return { classification: "mutating", reason: "gh api graphql -- a query and a mutation are indistinguishable from the CLI form" };
    }
    return { classification: "read-only", reason: "gh api with no write method, no field flags, and not graphql -- GET by default" };
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
