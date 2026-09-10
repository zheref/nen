// src/shu/toolchain.ts -- version arithmetic for `nen shu tools`: read a
// version out of what a probe answered, and decide whether it satisfies the pin
// a declaration states. Pure: no seam, no filesystem, no clock, no catalogue.
//
// IT READS TWO LITERALS FROM ../version.ts AND NOTHING ELSE FROM ANYWHERE.
// `VERSION` and `COMPATIBLE_MINOR_FLOOR` are compiled INTO the binary, so
// reading them is arithmetic on a constant rather than a fourth kind of input:
// the `dependency.minimum` rule cannot be evaluated without knowing which
// releases declared breaking consumer notes, and the only honest place for that
// fact is data the build carries about itself (see that file's header).
//
// IT NAMES NO TOOL AND NO INSTALLER. ./purity.test.ts sweeps this file with
// every other module on the execution path; what it knows about is the closed
// `versionFrom` enum ../schema/contract.ts publishes and the shape of a number.
// The one module in this family allowed to name the single installer nen
// implements is ./install.ts, and it is excluded there by name and by argument.
//
// WHY THE EXTRACTION IS AN ENUM AND NOT A REGEX. A caller-supplied regular
// expression is a caller-supplied program -- a ReDoS surface ../schema/
// pattern.ts exists to guard -- and this family's discipline is that a
// declaration's data stays data. So a declaration picks one of four members and
// nen implements all four here; an output no member can read is reported as
// "present, version unknown" and is NOT satisfied, because an unperformed
// comparison must never render as one that came back clean (zheref/nen#83).
//
// THE PIN FORMS ARE CLOSED FOR THE SAME REASON. ../schema/contract.ts types
// `version` as a string, so the shapes nen can EVALUATE are decided here: an
// exact pin and a `>=` floor, which are the two the design's declarations
// state. A form nen cannot evaluate -- a caret, a tilde, a two-sided range, a
// dist-tag -- is refused at exit 2 naming the pointer and both supported forms,
// rather than silently reported as satisfied or as wrong. Refusing by name is
// the opposite of guessing which of the two a `^9` meant.

import { VerbUsageError } from "../cli/command.js";
import type { VersionFrom } from "../schema/contract.js";
import { COMPATIBLE_MINOR_FLOOR, VERSION } from "../version.js";

/**
 * What one tool's row says about the host.
 *
 * THREE OBSERVED STATES AND ONE UNOBSERVED. `not-probed` appears only when nen
 * ran nothing at all -- a `--dry-run`, whose whole contract is that it spawns
 * nothing -- and it exists rather than reusing `missing` because a tool nobody
 * looked for is not a tool that is absent. Reporting an unprobed row as
 * `missing` would be the fail-open version of #83's rule, in the direction that
 * invents a finding rather than the one that hides it.
 */
export type ToolState =
  | "present-and-matching"
  | "present-but-wrong-version"
  | "missing"
  | "not-probed";

/**
 * What a probe answered, as ./probe.ts hands it back.
 *
 * The type lives HERE, in the pure module, so the module that spawns and the
 * module that classifies agree on the vocabulary without either importing the
 * other -- which is the split ../profiles/inertness.test.ts holds this verb to.
 *
 * `version: null` on a `present` observation is not an error: for the
 * `path-exists` member there is no version to read, and presence IS the answer.
 * Everywhere else it means the probe ran and said something no member could
 * read a version out of.
 */
export type Observation =
  | { readonly kind: "not-probed" }
  | { readonly kind: "missing"; readonly why: string }
  | {
      readonly kind: "present";
      readonly version: string | null;
      /**
       * The first non-empty line the probe printed, kept so a row nen could
       * read NO version out of can quote what it actually saw. It is what
       * ./probe.ts looked at, not a second guess at the version.
       */
      readonly output: string | null;
    };

/**
 * A version string, as a comparable value.
 *
 * `build` metadata is parsed and then dropped, which is semver's own rule: it
 * takes no part in precedence. Keeping it would make `1.2.3+a` and `1.2.3+b`
 * two different versions to a comparison that must call them one.
 */
export interface ParsedVersion {
  readonly numbers: readonly number[];
  /** Dot-separated identifiers, or null when the version carries none. */
  readonly prerelease: readonly string[] | null;
}

/**
 * The longest thing that looks like a version, anywhere in a line.
 *
 * TWO DOTS ARE NOT REQUIRED. `MAJOR.MINOR` is what several real probes answer
 * (a build tool's banner, an IDE's `-version`), and demanding three components
 * would read no version at all out of them -- which this file would then have
 * to report as "version unknown" for a tool that told it the version plainly.
 * One dot IS required, so a bare year or a build number is not mistaken for a
 * version.
 */
const VERSION_TOKEN = /\d+(?:\.\d+)+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?/g;

/** How many dotted numeric components a token's CORE carries. */
function componentCount(token: string): number {
  return (token.split(/[-+]/)[0] ?? "").split(".").length;
}

/**
 * The version-shaped token a line means, when it offers more than one.
 *
 * A THREE-COMPONENT TOKEN WINS OVER AN EARLIER TWO-COMPONENT ONE, and that is
 * the whole rule. `MAJOR.MINOR.PATCH` is unambiguously a version; two
 * components are what a build date (`2024.01`), a schema stamp or a marketing
 * number also look like, and a banner that carries both is a banner whose
 * version is the specific one. Nothing here scores further than that: a line
 * with two three-component tokens (a build tool's banner that also prints its
 * runtime's version) still yields the FIRST, because preferring anything else
 * would be nen guessing which of two versions a probe meant -- and a
 * declaration whose probe prints an unrelated dotted number FIRST should name a
 * probe that prints the version alone, which is what the usage text says.
 */
function firstSemver(text: string): string | null {
  const tokens = [...text.matchAll(VERSION_TOKEN)].map((match): string => match[0]);
  if (tokens.length === 0) return null;
  return tokens.find((token): boolean => componentCount(token) === 3) ?? tokens[0] ?? null;
}

/**
 * The cap on any observed string that reaches a report.
 *
 * `whole-line-stdout` hands back whatever the probe printed, and a probe that
 * printed a paragraph would otherwise put a paragraph in a table cell and in a
 * `--json` field. 200 is the design's own number for the one quoted line an
 * unreadable verdict may carry.
 */
export const MAX_FOUND = 200;

/** A probe's answer, capped -- never a paragraph, never a page. */
export function truncate(value: string): string {
  return value.length <= MAX_FOUND ? value : `${value.slice(0, MAX_FOUND)}...`;
}

/** The first non-empty line of some output, trimmed, or null. */
export function firstLine(text: string): string | null {
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}

/**
 * Read a version out of a probe's output, per the member the declaration chose.
 *
 * `path-exists` returns null BY DESIGN and not by failure: that member says
 * "presence is the whole answer", and ./probe.ts is what decides presence.
 * ./tools.ts is where the two meet, and the row it renders says so rather than
 * printing an empty version column with no explanation.
 */
export function extractVersion(
  versionFrom: VersionFrom,
  stdout: string,
  stderr: string,
): string | null {
  switch (versionFrom) {
    case "first-semver-on-stdout":
      return firstSemver(stdout);
    case "first-semver-on-stderr":
      return firstSemver(stderr);
    case "whole-line-stdout": {
      const line = firstLine(stdout);
      return line === null ? null : truncate(line);
    }
    case "path-exists":
      return null;
  }
}

/**
 * SEMVER'S OWN IDENTIFIER CHARSET, for a pre-release identifier and a build
 * one alike: ASCII alphanumerics and a hyphen, and at least one of them.
 *
 * IT IS ENFORCED RATHER THAN ASSUMED, because this is the one part of a
 * declaration's `version` that reaches an argv WITHOUT being re-shaped. The
 * numbers are parsed into numbers; the pre-release was previously checked only
 * for emptiness, and the build half was split off and dropped unread -- so
 * `1.2.3-; rm -rf /`, `1.2.3+$(id)`, a backtick, a quote, a pipe and a space
 * all parsed cleanly and were handed to the one installer's argv as part of the
 * `<tool>@<version>` element. There is no shell on that path and each one
 * arrived as ONE argv element, so nothing was ever executed -- but "it is inert
 * because nothing splits it" is a property of the seam, and a version is a
 * version: anything that is not one is refused here, at exit 2, by pointer.
 */
const IDENTIFIER = /^[0-9A-Za-z-]+$/;

/** Dot-separated identifiers, each held to semver's charset. */
function identifiersAreSemver(text: string): boolean {
  return text.split(".").every((identifier): boolean => IDENTIFIER.test(identifier));
}

/**
 * A version string, parsed, or null when it is not one.
 *
 * A LEADING `v` IS ACCEPTED AND DROPPED. Half the probes in the field answer
 * `v22.11.0`; the `first-semver-*` members never see the prefix because the
 * token starts at a digit, but `whole-line-stdout` does, and refusing it would
 * make the same version comparable through one member and not the other.
 */
export function parseVersion(raw: string): ParsedVersion | null {
  const text = raw.trim().replace(/^[vV]/, "");
  if (text === "") return null;
  const plus = text.indexOf("+");
  const withoutBuild = plus === -1 ? text : text.slice(0, plus);
  // BUILD METADATA TAKES NO PART IN PRECEDENCE and is dropped -- but it is
  // still READ first, because a string this function accepts is a string the
  // caller may put in an argv verbatim.
  if (plus !== -1 && !identifiersAreSemver(text.slice(plus + 1))) return null;
  const dash = withoutBuild.indexOf("-");
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? null : withoutBuild.slice(dash + 1);
  const parts = core.split(".");
  if (parts.length === 0) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    numbers.push(Number(part));
  }
  if (pre !== null && !identifiersAreSemver(pre)) return null;
  return { numbers, prerelease: pre === null ? null : pre.split(".") };
}

function compareIdentifiers(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    // A shorter set of identifiers is the lower precedence, semver's own rule.
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Semver precedence over two parsed versions: -1, 0 or 1.
 *
 * MISSING COMPONENTS ARE ZERO, so `9.15` and `9.15.0` compare equal. That is
 * what a repository means when it pins `MAJOR.MINOR`, and treating the shorter
 * form as smaller would make an exact pin of `9.15` unsatisfiable by the
 * version it names.
 */
export function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  const width = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < width; index += 1) {
    const a = left.numbers[index] ?? 0;
    const b = right.numbers[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  if (left.prerelease === null && right.prerelease === null) return 0;
  // A pre-release is lower precedence than the release it precedes.
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return compareIdentifiers(left.prerelease, right.prerelease);
}

/** The two pin forms nen can evaluate. */
export type Pin =
  | { readonly kind: "exact"; readonly version: string }
  | { readonly kind: "at-least"; readonly version: string };

/** How a pin reads back to a human, in the declaration's own spelling. */
export function renderPin(pin: Pin): string {
  return pin.kind === "exact" ? pin.version : `>=${pin.version}`;
}

/**
 * The declaration's `version` string as a pin, or a refusal naming both forms.
 *
 * A FORM NEN CANNOT EVALUATE IS EXIT 2, NOT A ROW. Reporting `^9.15.9` as
 * "wrong version" would blame the host for a pin nen never read, and reporting
 * it as satisfied would certify a comparison nobody made. The refusal is the
 * same shape every closed set in this repository uses: name the pointer, name
 * what was found, name what is accepted.
 */
export function parsePin(raw: string, pointer: string): Pin {
  const text = raw.trim();
  const atLeast = text.startsWith(">=");
  const version = atLeast ? text.slice(2).trim() : text;
  if (parseVersion(version) === null) {
    throw new VerbUsageError(
      `${pointer} is '${raw}', which is not a version pin nen can evaluate. Two forms are read: an exact version ('9.15.9') and a floor ('>=20.19.0'). There is no caret, no tilde, no two-sided range and no dist-tag -- a pin nen cannot compare is never reported as satisfied, and never blamed on the host.`,
    );
  }
  return atLeast ? { kind: "at-least", version } : { kind: "exact", version };
}

/**
 * Whether an observed version satisfies a pin.
 *
 * A found value that is not a version at all is NOT satisfied. That happens
 * when a declaration chose `whole-line-stdout` for a probe whose line carries
 * prose; the row then says "present, version unknown", which is the honest
 * answer to "is this the pinned version".
 */
export function satisfiesPin(pin: Pin, found: string): boolean {
  const observed = parseVersion(found);
  const wanted = parseVersion(pin.version);
  if (observed === null || wanted === null) return false;
  const order = compareVersions(observed, wanted);
  return pin.kind === "exact" ? order === 0 : order >= 0;
}

/** A `dependency.minimum` floor, read. */
export interface Floor {
  readonly major: number;
  readonly minor: number;
}

/**
 * This build's own identity, as the two facts a `minimum` is judged against.
 *
 * IT IS A VALUE RATHER THAN AN IMPORT AT EVERY CALL SITE so a test can hand
 * this module a SYNTHETIC build and read the rule's answers for a release line
 * that does not exist yet. Every exported function below defaults it to the
 * real one, so no caller has to know the rule needs it.
 */
export interface Build {
  /** The binary's own version -- ../version.ts's `VERSION`, parsed. */
  readonly version: ParsedVersion;
  /** The lowest `minimum` pin this build satisfies -- `COMPATIBLE_MINOR_FLOOR`. */
  readonly floor: Floor;
}

/**
 * The running build, read once per call out of the two literals ../version.ts
 * ships.
 *
 * BOTH ARE PARSED HERE RATHER THAN AT MODULE LOAD, because a malformed literal
 * must fail the one comparison that needs it -- naming the pointer, at exit 2,
 * the way every other refusal in this file does -- and never take the whole CLI
 * down before `--help` can print. ../version.test.ts is what keeps the literals
 * well-formed; this is what keeps a mistake in them survivable.
 */
export function thisBuild(): Build {
  const version = parseVersion(VERSION);
  if (version === null) {
    throw new VerbUsageError(
      `this build's own VERSION is '${VERSION}', which is not a version -- src/version.ts is the one place it is written and src/version.test.ts is what guards it.`,
    );
  }
  return { version, floor: parseMinimum(COMPATIBLE_MINOR_FLOOR, "COMPATIBLE_MINOR_FLOOR") };
}

/** A floor as a declaration spells it: `0.7`, never `0.7.0`. */
export function renderFloor(floor: Floor): string {
  return `${floor.major}.${floor.minor}`;
}

/**
 * Whether the zero-major COMPATIBILITY FLOOR applies to this comparison at all.
 *
 * It applies only when the pin and this build are both on a zero-major line,
 * which is the one line the caveat is about. Above major zero the vehicle has
 * moved and the range rule below carries the whole answer.
 */
function floorApplies(floor: Floor, build: Build): boolean {
  return floor.major === 0 && build.floor.major === 0 && (build.version.numbers[0] ?? 0) === 0;
}

/** This build's own minor, for the zero-major arm. */
function buildMinor(build: Build): number {
  return build.version.numbers[1] ?? 0;
}

/**
 * The `dependency` block's `MAJOR.MINOR` floor, under the contract's own rule.
 *
 * THE ZERO-MAJOR CAVEAT IS THE CONTRACT'S, NOT NEN'S, and it is stated in every
 * declaration that carries the block: at major zero the MINOR is the
 * breaking-change vehicle. Until v0.7.0 nen read that as `0.3` meaning
 * `>=0.3.0 <0.4.0` EXACTLY -- out of range in BOTH directions -- which made
 * every minor release, breaking or not, owe a repin PR in every consuming
 * repository. The maintainer's ruling of 2026-09-10 is the narrower reading
 * this file now implements: exact minor is fine, UNLESS there is a breaking
 * change, and which releases had one is a fact the binary ships
 * (`COMPATIBLE_MINOR_FLOOR`) rather than a fact it guesses. Above zero the
 * vehicle moves one component up, so `1.4` still means `>=1.4.0 <2.0.0`,
 * untouched by any of this.
 *
 * THE FLOOR IS EXACTLY TWO COMPONENTS, and a third is REFUSED rather than
 * dropped. `0.3.5` used to parse and silently become `0.3` -- a floor a
 * repository wrote to exclude `0.3.4`, applied as one that admits it, with no
 * line of output saying so. There is no reading of `MAJOR.MINOR.PATCH` under
 * this block's zero-major rule in either its old or its new form, so the honest
 * answer to a third component is to name the pointer and refuse: a comparison
 * nen quietly weakened is a comparison nobody made.
 *
 * A LEADING `v` IS ACCEPTED AND NORMALISED AWAY, exactly as `parseVersion`
 * accepts it everywhere else in this file -- and `renderMinimum` renders the
 * range back out of the NUMBERS, so no `v` a declaration wrote can reach a
 * report or a comparison.
 */
export function parseMinimum(minimum: string, pointer: string): Floor {
  const floor = parseVersion(minimum);
  if (floor === null || floor.numbers.length !== 2) {
    throw new VerbUsageError(
      `${pointer} is '${minimum}', which is not the MAJOR.MINOR floor this block states. It is exactly two components: at major zero it means '>=0.M.0' up to the minor of the build reading it, and no further back than that build's compatibility floor -- the minor is the breaking-change vehicle there -- and above zero it means '>=X.Y.0 <(X+1).0.0'. A third component has no reading under either rule and is refused rather than dropped, because a floor nen quietly widened is a comparison nobody made.`,
    );
  }
  return { major: floor.numbers[0] ?? 0, minor: floor.numbers[1] ?? 0 };
}

/**
 * The exclusive top of the range a floor admits, as a minor, on a zero-major
 * line -- and the ONE place the widening is decided.
 *
 * A PIN AT OR ABOVE THIS BUILD'S FLOOR REACHES UP TO THIS BUILD'S OWN MINOR,
 * and no further. The floor says which releases declared breaking consumer
 * notes UP TO AND INCLUDING this one, and it says nothing whatever about a
 * release that has not happened yet -- so a `0.7` pin is satisfied by the
 * 0.7 and 0.8 lines when THIS binary is 0.8.0 with a floor of `0.7`, and a
 * 0.9.0 answered by a probe is out of range to a 0.7.0 binary asking the
 * question, because a 0.7.0 binary has no way to know what 0.9.0 broke.
 * Guessing "compatible" there would be the fail-OPEN read of the one range
 * where compatibility is least guaranteed (zheref/nen#83's rule, applied to a
 * comparison rather than to an extraction).
 *
 * A PIN BELOW THE FLOOR, OR ABOVE THIS BUILD, KEEPS THE OLD EXACT MINOR. Its
 * own minor is the only one it admits: `0.6` against a floor of `0.7` still
 * means `>=0.6.0 <0.7.0`, which is what makes the refusal below a refusal
 * rather than a re-interpretation, and `0.9` against a 0.7.0 build still means
 * `>=0.9.0 <0.10.0`, because an older binary must not certify a newer line.
 */
function zeroMajorCeilingMinor(floor: Floor, build: Build): number {
  const live = floor.minor >= build.floor.minor && floor.minor <= buildMinor(build);
  return (live ? buildMinor(build) : floor.minor) + 1;
}

/**
 * The range a floor stands for, spelled out. Rendered, never re-parsed.
 *
 * IT IS THE EXACT RANGE `satisfiesMinimum` APPLIES, which is why it takes the
 * same build: a table that printed `>=0.7.0 <0.8.0` beside a satisfied `0.8.0`
 * would be a report contradicting itself in two adjacent columns.
 * ./toolchain.test.ts sweeps both functions over the same versions and fails
 * when they disagree by one input.
 */
export function renderMinimum(floor: Floor, build: Build = thisBuild()): string {
  const numbers = ceilingOf(floor, build).numbers;
  return `>=${floor.major}.${floor.minor}.0 <${numbers[0] ?? 0}.${numbers[1] ?? 0}.${numbers[2] ?? 0}`;
}

/** The exclusive ceiling a floor stands for, as one parsed version. */
function ceilingOf(floor: Floor, build: Build): ParsedVersion {
  if (floor.major !== 0) return { numbers: [floor.major + 1, 0, 0], prerelease: null };
  const minor = floorApplies(floor, build) ? zeroMajorCeilingMinor(floor, build) : floor.minor + 1;
  return { numbers: [0, minor, 0], prerelease: null };
}

/** Whether an observed version falls inside the range a floor stands for. */
export function satisfiesMinimum(floor: Floor, found: string, build: Build = thisBuild()): boolean {
  const observed = parseVersion(found);
  if (observed === null) return false;
  if (compareVersions(observed, { numbers: [floor.major, floor.minor, 0], prerelease: null }) < 0) {
    return false;
  }
  return compareVersions(observed, ceilingOf(floor, build)) < 0;
}

/**
 * WHY THIS BUILD CAN NEVER SATISFY THIS PIN, in words -- or null when it can.
 *
 * IT IS A FACT ABOUT THE DECLARATION AND THE BINARY, NOT ABOUT THE HOST, which
 * is why it is answered before the probe runs and why it names no observed
 * version. A `minimum` below this build's compatibility floor is refused
 * whatever `nen --version` prints, and a reader who is told only "WRONG" beside
 * the version they just installed has been told the least useful true thing in
 * the report.
 *
 * IT NAMES THE REPIN AND THE RULE THAT NOW GOVERNS IT. The old rule owed a
 * repin on every minor; this one owes it only when the floor moves, and the
 * sentence says so, because the reader's real question is "will I be here
 * again in a fortnight".
 */
export function minimumBelowFloor(floor: Floor, build: Build = thisBuild()): string | null {
  if (!floorApplies(floor, build) || floor.minor >= build.floor.minor) return null;
  const wanted = renderFloor(build.floor);
  return `minimum '${renderFloor(floor)}' is below this build's compatibility floor '${wanted}' -- the ${wanted} line declared breaking consumer notes, so no ${VERSION} binary satisfies a pin under '${wanted}', whatever the host answers. Repin to '${wanted}'. A pin at or above the floor is satisfied by every later 0.x release that keeps it, so a repin is owed again when the floor moves and not when the minor does.`;
}

/** One row's verdict: the state, whether it counts as satisfied, what was seen. */
export interface Assessment {
  readonly state: ToolState;
  /** `null` only when nothing was observed -- a dry run. */
  readonly satisfied: boolean | null;
  readonly found: string | null;
  /**
   * WHAT THE PROBE PRINTED, kept for exactly one row state and null in every
   * other: `present-but-wrong-version` with no `found`, which is the row that
   * says "present, version unknown".
   *
   * That row used to discard the output entirely, so a reader was told a
   * comparison had failed and never told what nen had been looking at -- the
   * one case where the output IS the finding. Everywhere else it stays null on
   * purpose: on a satisfied row `found` is the answer, and repeating the line
   * beside it would be two fields racing to be the version.
   */
  readonly probeOutput: string | null;
}

/**
 * Turn one observation into one row's verdict.
 *
 * `isSatisfied` IS A CALLBACK so this module never has to know whether the pin
 * came from `project.toolchain.<tool>.version` or from `dependency.minimum`.
 * The two obey different rules -- one is a pin, the other a floor with a
 * zero-major caveat -- and folding them into one branch here is how the caveat
 * would eventually be applied to the wrong one.
 */
export function assess(
  observation: Observation,
  versionFrom: VersionFrom,
  isSatisfied: (found: string) => boolean,
): Assessment {
  if (observation.kind === "not-probed") {
    return { state: "not-probed", satisfied: null, found: null, probeOutput: null };
  }
  if (observation.kind === "missing") {
    return { state: "missing", satisfied: false, found: null, probeOutput: null };
  }
  if (observation.version === null) {
    // PRESENCE IS THE WHOLE ANSWER for `path-exists`, because that is what the
    // declaration asked for by choosing the member: the entry still carries a
    // `version` (the schema requires one of every entry) and nen has nothing to
    // compare it against, which the row says in words. For every other member a
    // null version means the probe answered something no version could be read
    // out of -- present, version unknown, and NOT satisfied.
    return versionFrom === "path-exists"
      ? { state: "present-and-matching", satisfied: true, found: null, probeOutput: null }
      : {
          state: "present-but-wrong-version",
          satisfied: false,
          found: null,
          // THE ONE ROW THAT QUOTES THE OUTPUT, capped like every other observed
          // string that reaches a report.
          probeOutput: observation.output === null ? null : truncate(observation.output),
        };
  }
  const satisfied = isSatisfied(observation.version);
  return {
    state: satisfied ? "present-and-matching" : "present-but-wrong-version",
    satisfied,
    found: observation.version,
    probeOutput: null,
  };
}
