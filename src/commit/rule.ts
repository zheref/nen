// src/commit/rule.ts -- a commitlint `subject-case` rule as DATA: the tuple
// shape, the one preset nen carries, and the one validator for both places a
// repository can state such a rule (zheref/nen#263).
//
// TWO PLACES, ONE VALIDATOR. A commitlint data config's `rules['subject-case']`
// (./commitlint.ts) and nen/workflow.json's own `commits.subjectCase`
// (../schema/workflow.ts) are the same tuple, and a tuple one of them accepted
// that the other refused would be two answers to "is this a rule". So the
// checks live here, return a PROBLEM rather than throw, and each caller wraps
// it in its own error: CommitlintConfigError naming the commitlint file, or a
// SchemaError naming the workflow pointer.
//
// THE CHECKS ARE COMMITLINT'S OWN -- @commitlint/config-validator's schema (a
// level of exactly 0, 1 or 2; a condition of 'always' or 'never') and
// @commitlint/lint's (2 or 3 items; `[0]` alone is the one short form) -- plus
// one nen adds on purpose: an unknown case name is refused outright, where
// commitlint only throws "Unknown target case" when it reaches the transform.
// ./commitlint.ts's parseChecks note states why that strictness is kept.
//
// A LEAF MODULE. It imports only ./case.ts, so ../schema/workflow.ts can use it
// without the schema loader depending on the commitlint reader.

import { isCaseName, type CaseCheck, type Condition } from "./case.js";

export const CONFIG_CONVENTIONAL = "@commitlint/config-conventional";

/** A `subject-case` rule, read: level 0 disables it, 1 warns, 2 refuses. */
export interface SubjectCaseSpec {
  readonly level: 0 | 1 | 2;
  readonly when: Condition;
  readonly checks: readonly CaseCheck[];
}

/**
 * @commitlint/config-conventional's `subject-case`, as published in its
 * src/index.ts (21.2.3, and unchanged for many majors before it):
 * `[2, "never", ["sentence-case", "start-case", "pascal-case", "upper-case"]]`.
 */
export const CONVENTIONAL_SUBJECT_CASE: SubjectCaseSpec = {
  level: 2,
  when: "never",
  checks: (["sentence-case", "start-case", "pascal-case", "upper-case"] as const).map((name): CaseCheck => ({ when: "always", case: name })),
};

/** The names @commitlint/ensure accepts, as a refusal lists them. */
const CASE_NAMES_TEXT = "lower-case, upper-case, camel-case, kebab-case, pascal-case, sentence-case, snake-case, start-case";

export type TupleResult =
  | { readonly ok: true; readonly spec: SubjectCaseSpec }
  | {
      readonly ok: false;
      /** Where inside the tuple the fault is: "" for the whole, "[0]", "[1]", "[2]" or "[2][i]". */
      readonly at: string;
      /** A sentence that completes "the rule ...". */
      readonly problem: string;
      /** True when commitlint refuses the whole config at load; false when it only throws while linting (an unknown case). */
      readonly refusedAtLoad: boolean;
    };

/**
 * A rule's case list, normalized as @commitlint/rules normalizes it: absent
 * is `[]`, a single value is a list of one, a bare name is `always`, and an
 * object entry's `when` negates only when it is exactly "never".
 */
function parseChecks(value: unknown): { readonly checks: CaseCheck[] } | { readonly at: string; readonly entry: unknown } {
  if (value === undefined) return { checks: [] };
  const list = Array.isArray(value);
  const entries: unknown[] = list ? value : [value];
  const checks: CaseCheck[] = [];
  for (const [index, entry] of entries.entries()) {
    const record = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    const name: unknown = record === null ? entry : record["case"];
    if (!isCaseName(name)) return { at: list ? `[2][${index}]` : "[2]", entry };
    checks.push({ when: record !== null && record["when"] === "never" ? "never" : "always", case: name });
  }
  return { checks };
}

/** A tuple fault: where it is, what it is, and whether commitlint refuses it at load. */
export type TupleFault = Extract<TupleResult, { readonly ok: false }>;

export function tupleFault(at: string, problem: string, refusedAtLoad = true): TupleFault {
  return { ok: false, at, problem, refusedAtLoad };
}

/**
 * A commitlint rule tuple's SHAPE, the part every rule shares: @commitlint/
 * lint's checks, in its order -- `[0]` alone is the one short form; otherwise
 * a level of 0, 1 or 2, 2 or 3 items, and 'always' or 'never'. `third` names
 * the rule's value in the not-an-array fault ("cases", "max"). The value
 * itself is the caller's to read: ./linelength.ts reads a length rule's, this
 * module's parseSubjectCaseTuple a case list (zheref/nen#290 shares the shape
 * rather than copying it).
 */
export function parseRuleShape(
  value: unknown,
  third: string,
): { readonly ok: true; readonly level: 0 | 1 | 2; readonly when: Condition; readonly value: unknown } | TupleFault {
  if (!Array.isArray(value)) return tupleFault("", `must be an array ([level, 'always'|'never', ${third}])`);
  const [level, when] = value as unknown[];
  if (level === 0 && value.length === 1) return { ok: true, level: 0, when: "always", value: undefined };
  if (level !== 0 && level !== 1 && level !== 2) return tupleFault("[0]", "must start with a level of 0, 1 or 2");
  if (value.length < 2 || value.length > 3) return tupleFault("", "must be 2 or 3 items long");
  if (when !== "always" && when !== "never") return tupleFault("[1]", "must have 'always' or 'never' as its condition");
  return { ok: true, level, when, value: value[2] };
}

/** A `[level, 'always'|'never', cases]` tuple, held to commitlint's checks and nen's case-name check. */
export function parseSubjectCaseTuple(value: unknown): TupleResult {
  const shape = parseRuleShape(value, "cases");
  if (!shape.ok) return shape;
  const { level, when } = shape;
  // A disabled rule is never run, so its case list is never read -- commitlint
  // does not reject a bad one either.
  if (level === 0) return { ok: true, spec: { level, when, checks: [] } };
  const parsed = parseChecks(shape.value);
  if ("at" in parsed) {
    return tupleFault(
      parsed.at,
      `lists ${JSON.stringify(parsed.entry)}, which is not a case commitlint knows -- it would throw "Unknown target case" on every subject. Use one of the names @commitlint/ensure accepts (${CASE_NAMES_TEXT})`,
      false,
    );
  }
  return { ok: true, spec: { level, when, checks: parsed.checks } };
}

/**
 * `commits.bodyMaxLineLength` -- the body width a repository DECLARES for nen
 * where its commitlint config cannot be read as data (zheref/nen#290, the
 * maintainer's ruling: "Refuse at 100, declarable"). ONE VALIDATOR, here in
 * the leaf module, for the one place the key is read (../schema/workflow.ts,
 * which refuses a bad value by pointer at load).
 *
 * A POSITIVE WHOLE NUMBER AND NOTHING ELSE. commitlint itself coerces a width
 * it is handed ("100" is 100; ./linelength.ts mirrors that for a commitlint
 * config, because that is the gate commitlint runs). This key is nen's own
 * data, read by nothing but nen, so there is no second reader to agree with:
 * a string, a fraction or a width below 1 is refused rather than read into a
 * number somebody did not write.
 */
export function parseBodyWidth(value: unknown): { readonly ok: true; readonly width: number } | { readonly ok: false; readonly problem: string } {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return { ok: true, width: value };
  return {
    ok: false,
    problem: "must be a whole number of at least 1 -- the longest body line the repository allows, as commitlint's body-max-line-length states it (@commitlint/config-conventional's is 100)",
  };
}
