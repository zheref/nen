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
export function checkBody(body: string, requirements: readonly BodyRequirement[]): BodyCheckReport {
  if (requirements.length === 0) {
    throw new BodyCheckError(
      "the requirement list is empty -- a body-check with nothing to check would report success having checked nothing. Give --requirements-from a file with at least one { name, pattern } entry.",
    );
  }
  const results = requirements.map((requirement, index): RequirementResult => {
    if (typeof requirement.name !== "string" || requirement.name === "") {
      throw new BodyCheckError(`requirement at index ${index} has no string 'name'.`);
    }
    if (typeof requirement.pattern !== "string" || requirement.pattern === "") {
      throw new BodyCheckError(`requirement '${requirement.name}' has no string 'pattern'.`);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(requirement.pattern, "im");
    } catch (error) {
      throw new BodyCheckError(
        `requirement '${requirement.name}' has an unparseable pattern '${requirement.pattern}' (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    return { name: requirement.name, pattern: requirement.pattern, satisfied: regex.test(body) };
  });
  return { results, ok: results.every((result): boolean => result.satisfied) };
}
