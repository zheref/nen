// src/pr/bodycheck.ts -- `nen pr body-check`: does a pull-request body carry
// every section this repository requires of it.
//
// PATH-SET MEMBERSHIP + TEMPLATE PRESENCE, per the issue's own framing. What a
// PR body must carry (a summary, a test plan, a "no CHANGELOG entry: <reason>"
// opt-out under the right conditions) is this repository's OWN template
// convention, never a literal shipped here -- so the required markers arrive
// as caller-supplied patterns (`--require <pattern>`), the same way
// ../gate/derive.ts takes its path sets as arguments rather than constants.
//
// EVERY REQUIREMENT IS CHECKED, NEVER STOPPING AT THE FIRST MISS -- the same
// "report the whole table, not the first failure" discipline this repository
// applies everywhere a caller round-trips on a check (see ../release/preflight.ts).

import { readLines, stripComments, validFenceOpening } from "./template.js";

export interface BodyRequirement {
  /** A short name for this requirement, reported in the result. */
  readonly name: string;
  /** A regular expression the body must match to satisfy this requirement. */
  readonly pattern: string;
}

export interface RequirementResult {
  readonly name: string;
  readonly pattern: string;
  readonly satisfied: boolean;
}

export interface BodyCheckReport {
  readonly results: readonly RequirementResult[];
  readonly ok: boolean;
  readonly findings?: readonly { line: number; message: string }[];
  readonly warnings?: readonly { section: string; words: number; budget: number }[];
}

export interface BodyCheckOptions {
  readonly exact?: boolean;
  readonly max?: number;
  readonly proseBudget?: number;
}

export class BodyCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyCheckError";
  }
}

// AN EMPTY REQUIREMENT LIST IS REFUSED, NEVER A VACUOUS PASS (review finding).
// `results.every(...)` over zero elements is `true` by the empty-vacuous-truth
// rule of `Array.prototype.every` -- so an empty file, a mis-shaped file whose
// array sits one level down, or a file the caller meant to populate but didn't
// would otherwise report success having checked NOTHING, and print no output
// at all. ../cli/inputs.ts's `changedFiles` applies exactly this rule to the
// changed-file set ("An empty set is the permissive answer for every verb
// that reads one, so it is never assumed") -- this module carries the same
// rule for the requirement list.
//
// EXPORTED so a caller holding a requirements file but no body yet to check
// it against (../pr/command.ts's `pr merge` adapter) can refuse a malformed
// file on its own -- a non-array, an empty array, a missing 'name'/'pattern',
// or a pattern that does not compile as a regular expression -- BEFORE
// spending any network call on `gh`, rather than discovering the same defect
// only after `mergeUnit` has already fetched the pull request.
export function validateRequirements(raw: unknown): asserts raw is readonly BodyRequirement[] {
  if (!Array.isArray(raw)) {
    throw new BodyCheckError("the requirements file is not a JSON array -- expected '[{ \"name\": ..., \"pattern\": ... }, ...]'.");
  }
  if (raw.length === 0) {
    throw new BodyCheckError(
      "the requirement list is empty -- a body-check with nothing to check would report success having checked nothing. Give --requirements-from a file with at least one { name, pattern } entry.",
    );
  }
  raw.forEach((requirement: unknown, index: number): void => {
    const entry = requirement as Partial<BodyRequirement> | null;
    if (entry === null || typeof entry !== "object") {
      throw new BodyCheckError(`requirement at index ${index} is not an object.`);
    }
    if (typeof entry.name !== "string" || entry.name === "") {
      throw new BodyCheckError(`requirement at index ${index} has no string 'name'.`);
    }
    if (typeof entry.pattern !== "string" || entry.pattern === "") {
      throw new BodyCheckError(`requirement '${entry.name}' has no string 'pattern'.`);
    }
    try {
      new RegExp(entry.pattern, "im");
    } catch (error) {
      throw new BodyCheckError(
        `requirement '${entry.name}' has an unparseable pattern '${entry.pattern}' (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  });
}

export function checkBody(body: string, requirements: readonly BodyRequirement[], options: BodyCheckOptions = {}): BodyCheckReport {
  validateRequirements(requirements);
  if (options.max !== undefined && (!options.exact || !Number.isSafeInteger(options.max) || options.max < 1)) {
    throw new BodyCheckError("--max requires --exact and a positive safe integer.");
  }
  if (options.proseBudget !== undefined && (!Number.isSafeInteger(options.proseBudget) || options.proseBudget < 1)) {
    throw new BodyCheckError("--prose-budget requires a positive safe integer.");
  }
  const lines = readLines(body, { strictFences: true });
  const checked = options.exact ? lines.filter((line): boolean => line.kind === "heading").map((line): string => line.kind === "heading" ? line.text : "").join("\n") : body;
  const results = requirements.map((requirement): RequirementResult => {
    const regex = new RegExp(requirement.pattern, "im");
    return { name: requirement.name, pattern: requirement.pattern, satisfied: regex.test(checked) };
  });
  const findings: { line: number; message: string }[] = [];
  let previous = -1;
  let matched = 0;
  if (options.exact) lines.forEach((line, index): void => {
    if (line.kind !== "heading" || line.level !== 2) return;
    const matches = requirements.flatMap((requirement, at): number[] => new RegExp(requirement.pattern, "im").test(line.text) ? [at] : []);
    const at = matches[0];
    if (matches.length !== 1 || at === undefined) {
      findings.push({ line: index + 1, message: `${matches.length === 0 ? "undeclared" : "ambiguous"} level-2 heading: ${line.text}` });
      return;
    }
    matched++;
    if (at <= previous) findings.push({ line: index + 1, message: `out-of-order or repeated heading: ${line.text}` });
    previous = Math.max(previous, at);
    if (options.max !== undefined && matched === options.max + 1) findings.push({ line: index + 1, message: `matched heading count exceeds --max ${options.max}` });
  });
  const warnings = options.proseBudget === undefined ? [] : measureProse(body, options.proseBudget);
  return {
    results, ok: results.every((result): boolean => result.satisfied) && findings.length === 0,
    ...(options.exact ? { findings } : {}),
    ...(options.proseBudget === undefined ? {} : { warnings }),
  };
}

/** Measurement only; code (including Mermaid), tables and comments contribute no prose. */
export function measureProse(body: string, budget: number): { section: string; words: number; budget: number }[] {
  const classified = readLines(body, { strictFences: true });
  const sections: { section: string; words: number; budget: number }[] = [];
  let current = { section: "preamble", words: 0, budget };
  let fence: string | null = null;
  let comment = false;
  const rows = body.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const tableRows = new Set<number>();
  const cellsOf = (row: string): string[] => row.trim().replace(/\\\|/g, "escaped-pipe").replace(/^\||\|$/g, "").split("|");
  rows.forEach((row, index): void => {
    const cells = cellsOf(row);
    const header = rows[index - 1] ?? "";
    if ((!row.includes("|") && !header.includes("|")) || !cells.every((cell): boolean => /^\s*:?-+:?\s*$/.test(cell)) || index === 0 || header.trim() === "" || cellsOf(header).length !== cells.length) return;
    tableRows.add(index - 1);
    tableRows.add(index);
    // GFM permits omitted cells and pipe-free body rows. A blank or a new
    // block ends the table, rather than the first row without a pipe.
    for (let next = index + 1; next < rows.length; next++) {
      const following = rows[next] ?? "";
      if (following.trim() === "" || classified[next]?.kind === "heading" || validFenceOpening(following) !== null || /^ {0,3}(?:>|[-+*][ \t]|[0-9]{1,9}[.)][ \t]|<!--|<(?:div|table|details|pre|script|style|section|p)(?:[\s>])|([-*_])(?:[ \t]*\1){2,}[ \t]*$)/i.test(following)) break;
      tableRows.add(next);
    }
  });
  rows.forEach((raw, index): void => {
    if (fence !== null) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(raw)) fence = null;
      return;
    }
    const stripped = stripComments(raw, comment);
    comment = stripped.open;
    const line = stripped.text;
    const open = validFenceOpening(line);
    if (open !== null) { fence = open; return; }
    const parsed = classified[index];
    if (parsed?.kind === "heading" && parsed.level <= 2) {
      sections.push(current);
      current = { section: parsed.title, words: 0, budget };
    } else if (parsed?.kind !== "heading" && !tableRows.has(index) && !/^ {4}|^\t/.test(line)) {
      current.words += (line.replace(/<[^>]*>/g, " ").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length;
    }
  });
  sections.push(current);
  return sections.filter((section): boolean => section.words > budget);
}
