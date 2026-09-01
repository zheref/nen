// src/schema/gates.ts -- the REVIEWER IDENTITIES the readiness predicates are
// parameterised by, read from the TARGET repository's `schemas/gates.json`.
//
// WHY THIS FILE EXISTS AT ALL. bankai-core's `cli/src/gates/predicates.ts`
// decides CON-32 readiness against identities written into the source: a
// `case "sasuke": return /^sasuke \/ audit$/i`, a
// `/(^|\/)roy-bankai(\[bot\])?$/`, a `labels.includes("bankai:epic")`, a
// `["sasuke", "tenma", "copilot"]`. Every one of those is a NAME, and the
// Akatsuki migration's §3 makes names data: "No binary may hard-code a persona,
// label, check name, or colour; they are read from the target repo's schemas."
// The predicate LOGIC is unchanged and must stay so -- each branch encodes a
// production incident and is byte-equivalent in behaviour when handed this
// repository's own identities -- but the VALUES those branches compare against
// now arrive from the repository being judged.
//
// WHAT THE FOUR STRUCTURAL DISTINCTIONS ARE. They are not new policy; they are
// the shell's own branches, named so a file can state which reviewer is which:
//
//   loginPattern          the login a reviewer's review is posted under.
//   reviewCheckPattern    that reviewer's REVIEW job in the check rollup -- the
//                         check a delivery-PR abstain reports through. It must
//                         be the review job specifically and never a name
//                         prefix, because a runner-probe check is green on every
//                         PR whether or not the review ever ran.
//   roundCheckPattern     for a reviewer whose CHECK IS THE ROUND: one that
//                         posts a review only when it has findings and otherwise
//                         concludes silently. Absent for a reviewer whose review
//                         is the evidence and whose check is only a proxy.
//   enrolmentCheckPattern presence of this check AT HEAD is the evidence that
//                         the reviewer is configured for THIS pull request.
//
// plus two flags:
//
//   boundedPolicyExempt   a reviewer that nothing re-requests after the final
//                         push, so under the bounded policy only a PENDING
//                         request owes a round.
//   deliveryHolisticPass  a reviewer that casts ONE holistic pass on `opened`
//                         and deliberately never re-casts, so an approval at
//                         head is unreachable by design on a delivery PR.
//
// A REPOSITORY WITHOUT THE FILE GETS AN ERROR, NOT A DEFAULT SET. There is no
// built-in reviewer table, not even the one this code was ported from: a
// fallback would make `nen` judge readiness against another repository's
// reviewers while reporting success, which is the single most dangerous thing a
// readiness gate can do. See ./errors.ts.
//
// PATTERN CASE-SENSITIVITY IS PART OF THE DATA, and the asymmetry is
// load-bearing rather than untidy. In the system this was ported from, one
// reviewer's enrolment check is matched ANCHORED and CASE-SENSITIVELY (because a
// sibling probe job would otherwise enrol it) while another's is an UNANCHORED
// CASE-INSENSITIVE substring (because that check's name varies with the
// installation). "Tidying" either into the other's shape changes which reviewers
// a pull request is gated by -- so `ignoreCase` is per pattern, stated by the
// file, and never inferred.

import {
  describeValue,
  isRecord,
  requireArray,
  requireRecord,
  requireString,
  SchemaError,
} from "./errors.js";
import { GATES_FILE, readSchemaJson } from "./source.js";

export interface ReviewerIdentity {
  readonly name: string;
  readonly loginPattern: RegExp;
  readonly reviewCheckPattern: RegExp | null;
  readonly roundCheckPattern: RegExp | null;
  readonly enrolmentCheckPattern: RegExp | null;
  readonly boundedPolicyExempt: boolean;
  readonly deliveryHolisticPass: boolean;
}

export interface DeliveryIdentity {
  /** The author a delivery pull request must be opened by. */
  readonly authorPattern: RegExp;
  /** Head-ref prefixes that mark a delivery branch. */
  readonly headRefPrefixes: readonly string[];
  /** Labels that mark a delivery pull request. */
  readonly labels: readonly string[];
}

export interface GateIdentities {
  readonly path: string;
  readonly reviewers: readonly ReviewerIdentity[];
  /** The approval set when a caller names none. */
  readonly defaultApprovers: readonly string[];
  /** The reviewers configured on EVERY pull request, before enrolment. */
  readonly baseReviewers: readonly string[];
  readonly delivery: DeliveryIdentity;
  reviewer(name: string): ReviewerIdentity | undefined;
}

function readPattern(
  path: string,
  pointer: string,
  raw: unknown,
  required: false,
): RegExp | null;
function readPattern(path: string, pointer: string, raw: unknown, required: true): RegExp;
function readPattern(
  path: string,
  pointer: string,
  raw: unknown,
  required: boolean,
): RegExp | null {
  if (raw === undefined || raw === null) {
    if (!required) return null;
    throw new SchemaError(path, pointer, "is required and must be a pattern object");
  }
  if (!isRecord(raw)) {
    throw new SchemaError(
      path,
      pointer,
      `expected { "pattern": "...", "ignoreCase": true|false }, got ${describeValue(raw)}`,
    );
  }
  const source = requireString(path, `${pointer}.pattern`, raw["pattern"]);
  const ignoreCase = raw["ignoreCase"];
  if (typeof ignoreCase !== "boolean") {
    throw new SchemaError(
      path,
      `${pointer}.ignoreCase`,
      // Stated rather than defaulted: whether a check-name match is
      // case-sensitive decides which reviewers gate a pull request, and a file
      // that leaves it out has not said which behaviour it wants.
      `is required and must be a boolean. Case-sensitivity decides which checks match, so it is stated by the file rather than assumed; got ${describeValue(ignoreCase)}`,
    );
  }
  try {
    return new RegExp(source, ignoreCase ? "i" : "");
  } catch (error) {
    throw new SchemaError(
      path,
      `${pointer}.pattern`,
      `is not a valid regular expression (${error instanceof Error ? error.message : String(error)}). An unparseable pattern would match nothing, which silently excuses a reviewer from every round.`,
    );
  }
}

function readFlag(path: string, pointer: string, raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== "boolean") {
    throw new SchemaError(path, pointer, `expected a boolean, got ${describeValue(raw)}`);
  }
  return raw;
}

export function parseGateIdentities(path: string, value: unknown): GateIdentities {
  const root = requireRecord(path, "$", value);

  const rawReviewers = requireArray(path, "reviewers", root["reviewers"]);
  const reviewers: ReviewerIdentity[] = [];
  const seen = new Map<string, number>();

  rawReviewers.forEach((entry, index): void => {
    const pointer = `reviewers[${index}]`;
    const record = requireRecord(path, pointer, entry);
    const name = requireString(path, `${pointer}.name`, record["name"]);
    const previous = seen.get(name);
    if (previous !== undefined) {
      throw new SchemaError(
        path,
        `${pointer}.name`,
        `duplicates reviewers[${previous}].name ('${name}'); two identities for one reviewer means the gate would use whichever it indexed last`,
      );
    }
    seen.set(name, index);

    reviewers.push({
      name,
      loginPattern: readPattern(path, `${pointer}.login_pattern`, record["login_pattern"], true),
      reviewCheckPattern: readPattern(
        path,
        `${pointer}.review_check_pattern`,
        record["review_check_pattern"],
        false,
      ),
      roundCheckPattern: readPattern(
        path,
        `${pointer}.round_check_pattern`,
        record["round_check_pattern"],
        false,
      ),
      enrolmentCheckPattern: readPattern(
        path,
        `${pointer}.enrolment_check_pattern`,
        record["enrolment_check_pattern"],
        false,
      ),
      boundedPolicyExempt: readFlag(
        path,
        `${pointer}.bounded_policy_exempt`,
        record["bounded_policy_exempt"],
      ),
      deliveryHolisticPass: readFlag(
        path,
        `${pointer}.delivery_holistic_pass`,
        record["delivery_holistic_pass"],
      ),
    });
  });

  const declared = new Set(reviewers.map((reviewer): string => reviewer.name));

  // A name in either list that is not a declared reviewer is REFUSED rather than
  // tolerated. Both lists feed the gate: an approver with no identity would be
  // matched by the fall-back "a name matches itself" rule and could silently
  // approve under a login nobody intended, and a base reviewer with no identity
  // owes a round no check can ever satisfy -- a gate with no path out.
  const readNames = (key: string): string[] => {
    const raw = root[key];
    if (raw === undefined || raw === null) return [];
    return requireArray(path, key, raw).map((item, index): string => {
      const name = requireString(path, `${key}[${index}]`, item);
      if (!declared.has(name)) {
        throw new SchemaError(
          path,
          `${key}[${index}]`,
          `names '${name}', which is not declared in 'reviewers'. Declared: ${[...declared].join(", ")}.`,
        );
      }
      return name;
    });
  };

  const defaultApprovers = readNames("default_approvers");
  const baseReviewers = readNames("base_reviewers");

  const rawDelivery = requireRecord(path, "delivery", root["delivery"]);
  const rawPrefixes = rawDelivery["head_ref_prefixes"];
  const headRefPrefixes =
    rawPrefixes === undefined || rawPrefixes === null
      ? []
      : requireArray(path, "delivery.head_ref_prefixes", rawPrefixes).map(
          (item, index): string =>
            requireString(path, `delivery.head_ref_prefixes[${index}]`, item),
        );
  const rawLabels = rawDelivery["labels"];
  const labels =
    rawLabels === undefined || rawLabels === null
      ? []
      : requireArray(path, "delivery.labels", rawLabels).map((item, index): string =>
          requireString(path, `delivery.labels[${index}]`, item),
        );

  if (headRefPrefixes.length === 0 && labels.length === 0) {
    throw new SchemaError(
      path,
      "delivery",
      "declares neither a head-ref prefix nor a label, so no pull request could ever be recognised as a delivery PR and the carve-out is unreachable. State at least one, or delete the reviewers that rely on it.",
    );
  }

  const delivery: DeliveryIdentity = {
    authorPattern: readPattern(path, "delivery.author_pattern", rawDelivery["author_pattern"], true),
    headRefPrefixes,
    labels,
  };

  const byName = new Map(
    reviewers.map((reviewer): [string, ReviewerIdentity] => [reviewer.name, reviewer]),
  );

  return {
    path,
    reviewers,
    defaultApprovers,
    baseReviewers,
    delivery,
    reviewer: (name): ReviewerIdentity | undefined => byName.get(name),
  };
}

export function loadGateIdentities(repoRoot: string): GateIdentities {
  const { path, value } = readSchemaJson(repoRoot, GATES_FILE);
  return parseGateIdentities(path, value);
}
