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

export function checkBody(body: string, requirements: readonly BodyRequirement[]): BodyCheckReport {
  const results = requirements.map((requirement): RequirementResult => {
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
