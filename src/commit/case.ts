// src/commit/case.ts -- commitlint's `subject-case` rule, ported line for line
// so `nen commit format` reaches the verdict commitlint itself would reach
// (zheref/nen#263). ./commitlint.ts reads WHICH rule a repository states;
// this module only answers "does this subject pass that rule".
//
// WHY A PORT AND NOT A DEPENDENCY. The rule is three small upstream files and
// five string functions from a case library, and the library is the part that
// would be a new supply chain for five functions. The port is short enough to
// read whole and to hold against the upstream files it names below, which is
// the property that matters for a check whose whole value is agreeing with
// another tool.
//
// THE UPSTREAM THIS MIRRORS, AT THE VERSION IT WAS READ FROM (2026-09-29):
//
//   * @commitlint/rules 21.2.3, src/subject-case.ts -- the rule itself: a
//     subject that does not start with a cased letter passes untouched; each
//     listed case is asked, and `always` passes when ANY matches while `never`
//     fails when any does.
//   * @commitlint/ensure 21.2.3, src/case.ts -- quoted ('...', "...") and
//     backticked spans are DELETED before the check (they "can contain proper
//     names", upstream's own comment), the rest is trimmed, transformed, and
//     compared with itself; an empty or digit-leading transform passes.
//   * @commitlint/ensure 21.2.3, src/to-case.ts -- the case names and the
//     transform behind each one.
//   * es-toolkit 1.52.0 -- the version @commitlint/ensure's `^1.46.0` range
//     resolves to today -- dist/compat/string/{words,camelCase,kebabCase,
//     snakeCase,startCase,upperFirst,deburr}.mjs, dist/string/{capitalize,
//     upperFirst,deburr}.mjs and dist/compat/_internal/normalizeForCase.mjs.
//
// WHAT CAN STILL DIFFER, SAID RATHER THAN HIDDEN. commitlint 19 and earlier
// used lodash's case functions (20 moved to es-toolkit), 17 and earlier gated
// on an ASCII-only `^[a-z]/i` letter test, and es-toolkit's word splitter has
// changed between its own releases. Every word-splitting difference is in how
// unusual Unicode splits into WORDS, which only the start-, camel-, pascal-,
// kebab- and snake-case transforms do; sentence-, upper- and lower-case never
// split words. @commitlint/config-conventional's default (`never` sentence-,
// start-, pascal-, upper-case) is decided almost entirely by sentence-case --
// a subject that is start-, pascal- or upper-case nearly always begins with an
// upper-case letter too -- so for the rule most repositories run, the verdicts
// of 18 through 21 part only on a subject that opens with a titlecase digraph
// ('ǲ', Unicode Lt), and 17 differs from them only on a subject that opens
// with a non-ASCII letter ('Élan', which 17 let through unchecked). nen gives
// 21.2.3's verdict in both; ./case.test.ts pins cases recorded from it.

/** Every case name @commitlint/ensure's to-case accepts; any other name makes it throw. */
export const CASE_NAMES = [
  "camel-case",
  "kebab-case",
  "snake-case",
  "pascal-case",
  "start-case",
  "upper-case",
  "uppercase",
  "sentence-case",
  "sentencecase",
  "lower-case",
  "lowercase",
  "lowerCase",
] as const;

export type CaseName = (typeof CASE_NAMES)[number];

export function isCaseName(value: unknown): value is CaseName {
  return typeof value === "string" && (CASE_NAMES as readonly string[]).includes(value);
}

export type Condition = "always" | "never";

/** One entry of the rule's case list, as @commitlint/rules normalizes it: a bare name is `always`. */
export interface CaseCheck {
  readonly when: Condition;
  readonly case: CaseName;
}

// ── es-toolkit 1.52.0's compat word splitter, verbatim ──────────────────────
//
// Built from the same named fragments upstream builds it from, in the same
// order, so a reader can diff the two. The apostrophe alternatives never fire
// in practice -- normalizeForCase() below deletes apostrophes before this runs
// -- and are kept because a port that "tidies" upstream is no longer a port.

const NON_CHAR_LATIN = "\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\xbf\\xd7\\xf7";
const UPPER = "\\p{Lu}";
const LOWER = "\\p{Ll}";
const MISC = "(?:[\\p{Lm}\\p{Lo}]\\p{M}*)";
const NUMBER = "\\d";
const CONTRACTION_LOWER = "(?:['’](?:d|ll|m|re|s|t|ve))?";
const CONTRACTION_UPPER = "(?:['’](?:D|LL|M|RE|S|T|VE))?";
const BREAK = `[\\p{Z}\\p{P}${NON_CHAR_LATIN}]`;
const MISC_UPPER = `(?:${UPPER}|${MISC})`;
const MISC_LOWER = `(?:${LOWER}|${MISC})`;

const WORD = new RegExp(
  [
    `${UPPER}?${LOWER}+${CONTRACTION_LOWER}(?=${BREAK}|${UPPER}|$)`,
    `${MISC_UPPER}+${CONTRACTION_UPPER}(?=${BREAK}|${UPPER}${MISC_LOWER}|$)`,
    `${UPPER}?${MISC_LOWER}+${CONTRACTION_LOWER}`,
    `${UPPER}+${CONTRACTION_UPPER}`,
    `${NUMBER}*(?:1ST|2ND|3RD|(?![123])${NUMBER}TH)(?=\\b|[a-z_])`,
    `${NUMBER}*(?:1st|2nd|3rd|(?![123])${NUMBER}th)(?=\\b|[A-Z_])`,
    `${NUMBER}+`,
    "\\p{Emoji_Presentation}",
    "\\p{Extended_Pictographic}",
  ].join("|"),
  "gu",
);

/** es-toolkit's compat `words`: every match of the word pattern, empty ones dropped. */
export function words(input: string): string[] {
  return Array.from(input.match(WORD) ?? []).filter((word): boolean => word !== "");
}

/** Letters es-toolkit's deburr rewrites outright; everything else loses only its combining marks. */
const DEBURR_MAP: ReadonlyMap<string, string> = new Map([
  ["Æ", "Ae"],
  ["Ð", "D"],
  ["Ø", "O"],
  ["Þ", "Th"],
  ["ß", "ss"],
  ["æ", "ae"],
  ["ð", "d"],
  ["ø", "o"],
  ["þ", "th"],
  ["Đ", "D"],
  ["đ", "d"],
  ["Ħ", "H"],
  ["ħ", "h"],
  ["ı", "i"],
  ["Ĳ", "IJ"],
  ["ĳ", "ij"],
  ["ĸ", "k"],
  ["Ŀ", "L"],
  ["ŀ", "l"],
  ["Ł", "L"],
  ["ł", "l"],
  ["ŉ", "'n"],
  ["Ŋ", "N"],
  ["ŋ", "n"],
  ["Œ", "Oe"],
  ["œ", "oe"],
  ["Ŧ", "T"],
  ["ŧ", "t"],
  ["ſ", "s"],
]);

/**
 * es-toolkit's deburr: NFD, then drop the three combining-mark blocks and
 * rewrite the letters above. It walks UTF-16 code units, as upstream does --
 * a surrogate half is in neither the map nor a dropped block, so it survives.
 */
export function deburr(input: string): string {
  const decomposed = input.normalize("NFD");
  let result = "";
  for (let index = 0; index < decomposed.length; index += 1) {
    const char = decomposed[index] as string;
    if ((char >= "̀" && char <= "ͯ") || (char >= "⃐" && char <= "⃿") || (char >= "︠" && char <= "︯")) {
      continue;
    }
    result += DEBURR_MAP.get(char) ?? char;
  }
  return result;
}

/** es-toolkit's normalizeForCase: contraction apostrophes (' and U+2019) removed. */
function normalizeForCase(input: string): string {
  return input.replace(/['’]/g, "");
}

/** The first UTF-16 unit upper-cased, the rest untouched (es-toolkit's upperFirst). */
export function upperFirst(input: string): string {
  return input.substring(0, 1).toUpperCase() + input.substring(1);
}

/** The first unit upper-cased, the rest lower-cased (es-toolkit's capitalize). */
function capitalize(input: string): string {
  return input.charAt(0).toUpperCase() + input.slice(1).toLowerCase();
}

function caseWords(input: string): string[] {
  return words(normalizeForCase(deburr(input)));
}

export function camelCase(input: string): string {
  const [first, ...rest] = caseWords(input);
  if (first === undefined) return "";
  return `${first.toLowerCase()}${rest.map(capitalize).join("")}`;
}

export function kebabCase(input: string): string {
  return caseWords(input)
    .map((word): string => word.toLowerCase())
    .join("-");
}

export function snakeCase(input: string): string {
  return caseWords(input)
    .map((word): string => word.toLowerCase())
    .join("_");
}

/**
 * es-toolkit's compat startCase. NOT lodash's: an all-upper-case word is kept
 * as it is, and any other word is capitalized (first unit up, the rest down)
 * rather than only having its first unit raised. It is also the one transform
 * that trims before splitting, exactly as upstream does.
 */
export function startCase(input: string): string {
  return words(normalizeForCase(deburr(input)).trim())
    .map((word): string => (word === word.toUpperCase() ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(" ");
}

/** @commitlint/ensure's to-case: the transform each case name stands for. */
export function toCase(input: string, target: CaseName): string {
  switch (target) {
    case "camel-case":
      return camelCase(input);
    case "kebab-case":
      return kebabCase(input);
    case "snake-case":
      return snakeCase(input);
    case "pascal-case":
      return upperFirst(camelCase(input));
    case "start-case":
      return startCase(input);
    case "upper-case":
    case "uppercase":
      return input.toUpperCase();
    case "sentence-case":
    case "sentencecase":
      return upperFirst(input);
    case "lower-case":
    case "lowercase":
    case "lowerCase":
      return input.toLowerCase();
  }
}

/**
 * @commitlint/ensure's `case`: is `raw` already in `target`'s case?
 *
 * The quoted and backticked spans go FIRST, and whole -- quotes included --
 * which is why "`Escape` closes the modal" is lower-case: what is left is
 * "closes the modal". The regex is upstream's, non-greedy and single-line.
 */
export function ensureCase(raw: string, target: CaseName): boolean {
  const input = raw.replace(/`.*?`|".*?"|'.*?'/g, "").trim();
  const transformed = toCase(input, target);
  if (transformed === "" || /^\d/.test(transformed)) return true;
  return transformed === input;
}

/**
 * @commitlint/rules's own first gate: a subject that does not start with a
 * cased letter (Unicode Ll, Lu or Lt) is not checked at all. Upstream's regex,
 * `i` flag included.
 */
const STARTS_WITH_CASED_LETTER = /^[\p{Ll}\p{Lu}\p{Lt}]/iu;

export interface CaseVerdict {
  readonly valid: boolean;
  /** commitlint's own sentence ("subject must not be sentence-case"), or null when the subject was not checked or passed. */
  readonly message: string | null;
  /** The case names the message reports -- for `never`, the ones that matched; for `always`, every one listed. */
  readonly reported: readonly CaseName[];
}

/**
 * @commitlint/rules's subjectCase, on a subject and a rule already read.
 *
 * `never` FAILS WHEN ANY LISTED CASE MATCHES and reports only the ones that
 * did; `always` FAILS WHEN NONE DOES and reports every one listed -- the same
 * asymmetry upstream's own comment states. An entry's own `when: "never"`
 * inverts that entry alone, before the rule's condition is applied.
 */
export function subjectCaseVerdict(subject: string, when: Condition, checks: readonly CaseCheck[]): CaseVerdict {
  if (!STARTS_WITH_CASED_LETTER.test(subject)) return { valid: true, message: null, reported: [] };
  const matches = checks.filter((check): boolean => {
    const inCase = ensureCase(subject, check.case);
    return check.when === "never" ? !inCase : inCase;
  });
  const result = matches.length > 0;
  const valid = when === "never" ? !result : result;
  if (valid) return { valid: true, message: null, reported: [] };
  const reported = (when === "never" && result ? matches : checks).map((check): CaseName => check.case);
  // @commitlint/message: the parts joined with a space, the null one dropped.
  const message = ["subject must", when === "never" ? "not" : null, `be ${reported.join(", ")}`].filter(Boolean).join(" ");
  return { valid: false, message, reported };
}
