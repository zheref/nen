// src/shu/toolchain.ts -- version arithmetic for `nen shu tools`: read a
// version out of what a probe answered, and decide whether it satisfies the pin
// a declaration states. Pure: no seam, no filesystem, no clock, no catalogue.
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
  | { readonly kind: "present"; readonly version: string | null };

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
const VERSION_TOKEN = /\d+(?:\.\d+)+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?/;

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
      return VERSION_TOKEN.exec(stdout)?.[0] ?? null;
    case "first-semver-on-stderr":
      return VERSION_TOKEN.exec(stderr)?.[0] ?? null;
    case "whole-line-stdout": {
      const line = firstLine(stdout);
      return line === null ? null : truncate(line);
    }
    case "path-exists":
      return null;
  }
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
  const withoutBuild = text.split("+")[0] ?? "";
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
  if (pre !== null && (pre === "" || pre.split(".").some((id): boolean => id === ""))) return null;
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
 * The `dependency` block's `MAJOR.MINOR` floor, under the contract's own rule.
 *
 * THE ZERO-MAJOR CAVEAT IS THE CONTRACT'S, NOT NEN'S, and it is stated in every
 * declaration that carries the block: at major zero the MINOR is the
 * breaking-change vehicle, so `0.3` means `>=0.3.0 <0.4.0` EXACTLY -- a higher
 * minor is out of range in BOTH directions. Above zero the vehicle moves one
 * component up, so `1.4` means `>=1.4.0 <2.0.0`: the same rule, one component
 * along, rather than a second rule nen invented for a case the prose did not
 * spell out.
 *
 * The floor is refused when it is not two-or-more numeric components, because
 * a floor nen cannot read is a comparison nen must not pretend to have made.
 */
export function parseMinimum(minimum: string, pointer: string): Floor {
  const floor = parseVersion(minimum);
  if (floor === null || floor.numbers.length < 2) {
    throw new VerbUsageError(
      `${pointer} is '${minimum}', which is not the MAJOR.MINOR floor this block states. At major zero it means '>=0.M.0 <0.(M+1).0' exactly -- the minor is the breaking-change vehicle there -- and above zero it means '>=X.Y.0 <(X+1).0.0'. nen compares against neither when it cannot read the floor.`,
    );
  }
  return { major: floor.numbers[0] ?? 0, minor: floor.numbers[1] ?? 0 };
}

/** The range a floor stands for, spelled out. Rendered, never re-parsed. */
export function renderMinimum(floor: Floor): string {
  const ceiling = floor.major === 0 ? `0.${floor.minor + 1}.0` : `${floor.major + 1}.0.0`;
  return `>=${floor.major}.${floor.minor}.0 <${ceiling}`;
}

/** Whether an observed version falls inside the range a floor stands for. */
export function satisfiesMinimum(floor: Floor, found: string): boolean {
  const observed = parseVersion(found);
  if (observed === null) return false;
  if (compareVersions(observed, { numbers: [floor.major, floor.minor, 0], prerelease: null }) < 0) {
    return false;
  }
  const ceiling: ParsedVersion =
    floor.major === 0
      ? { numbers: [0, floor.minor + 1, 0], prerelease: null }
      : { numbers: [floor.major + 1, 0, 0], prerelease: null };
  return compareVersions(observed, ceiling) < 0;
}

/** One row's verdict: the state, whether it counts as satisfied, what was seen. */
export interface Assessment {
  readonly state: ToolState;
  /** `null` only when nothing was observed -- a dry run. */
  readonly satisfied: boolean | null;
  readonly found: string | null;
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
    return { state: "not-probed", satisfied: null, found: null };
  }
  if (observation.kind === "missing") {
    return { state: "missing", satisfied: false, found: null };
  }
  if (observation.version === null) {
    // PRESENCE IS THE WHOLE ANSWER for `path-exists`, because that is what the
    // declaration asked for by choosing the member: the entry still carries a
    // `version` (the schema requires one of every entry) and nen has nothing to
    // compare it against, which the row says in words. For every other member a
    // null version means the probe answered something no version could be read
    // out of -- present, version unknown, and NOT satisfied.
    return versionFrom === "path-exists"
      ? { state: "present-and-matching", satisfied: true, found: null }
      : { state: "present-but-wrong-version", satisfied: false, found: null };
  }
  const satisfied = isSatisfied(observation.version);
  return {
    state: satisfied ? "present-and-matching" : "present-but-wrong-version",
    satisfied,
    found: observation.version,
  };
}
