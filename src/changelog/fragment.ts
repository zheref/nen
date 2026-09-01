// src/changelog/fragment.ts -- "does this change owe a changelog fragment?",
// ported from bankai-core's `scripts/changelog_unreleased_check.sh`.
//
// THE RULE, in the source's own words: every pull request that changes a
// spec/canon path "MUST add its entry as a new `changelog.d/<pr-or-issue>-<slug>.md`
// fragment file in the same PR, or state `no CHANGELOG entry: <reason>` in the PR
// body (a genuinely non-spec change)".
//
// FOUR WAYS TO SATISFY IT, checked in the source's own order, because the order
// is what makes the messages useful:
//
//   1. NO SPEC/CANON PATH CHANGED     -> the rule does not apply at all.
//   2. THE BODY CARRIES THE OPT-OUT   -> skipped, by the rule's own escape hatch.
//   3. A FRAGMENT WAS ADDED           -> satisfied.
//   4. THIS IS THE RELEASE MOVE       -> satisfied natively, so a release PR
//                                        needs no opt-out to empty Unreleased.
//
// THE THREE SHAPES OF A RELEASE MOVE are carried whole, and each is a separate
// incident:
//
//   * the legacy direct-edit move: the base's `### Unreleased` held entries and
//     the head's new dated section holds at least as many -- content moved, not
//     lost.
//   * the fragment-era move: an ALREADY-EMPTY base Unreleased "proves nothing
//     either way", since a routine PR is no longer allowed to add a direct entry,
//     so the evidence is >=1 fragment collated (present at base, deleted at head).
//   * the integration-epic collation: same empty base, and no fragment
//     add/delete visible either, because the children added their fragments ON
//     the integration branch and the collation deleted them there too. The
//     registry's `latest` being bumped TO this exact new version is the signal
//     instead -- "that bump is the release assembly's own act, not forgeable by
//     an unrelated PR that merely adds a CHANGELOG section."
//
// A FRAGMENT IS ONE LEVEL DEEP, and the source says why the check is spelled the
// way it is: a `*` in a shell case pattern crosses `/`, so `changelog.d/*.md`
// would also match `changelog.d/a/b.md` and the script excludes anything with a
// second `/` explicitly. The same exclusion is written out here rather than
// relying on a regex reader's intuition about which `*` crosses what.
//
// NOTHING IS DEFAULTED. The spec paths, the fragment directory and the
// registry's version field arrive from the caller; the shell had them as
// constants because it served one repository.

export interface FragmentPaths {
  /** Spec/canon path patterns. A hit means the rule applies. */
  readonly specPaths: readonly string[];
  /** The fragment directory, relative to the repository root. */
  readonly fragmentDir: string;
}

export interface FragmentInputs extends FragmentPaths {
  readonly changed: readonly string[];
  /** The pull-request body, or null when it was not supplied. */
  readonly body: string | null;
  /** Paths that exist in the working tree, for the added/deleted distinction. */
  readonly present: ReadonlySet<string>;
  /** `### Unreleased` entry count at base and head. */
  readonly baseUnreleased: number;
  readonly headUnreleased: number;
  /** The first dated section's version at base and head, or null. */
  readonly baseVersion: string | null;
  readonly headVersion: string | null;
  /** Entry count in head's first dated section. */
  readonly headSectionEntries: number;
  /** The registry's `latest` at base and head, or null when unsupplied. */
  readonly baseLatest: string | null;
  readonly headLatest: string | null;
}

export type FragmentVerdict =
  | "not-applicable"
  | "opt-out"
  | "fragment-present"
  | "release-move"
  | "required";

export interface FragmentReport {
  readonly verdict: FragmentVerdict;
  readonly required: boolean;
  /** Changed paths that matched a spec pattern, with the pattern. */
  readonly triggers: readonly { path: string; pattern: string }[];
  readonly detail: string;
}

// Match a path against one pattern, with the SHELL's glob semantics: `*` crosses
// `/`. See ../gate/derive.ts, which carries the same reasoning for the same
// reason -- the two path sets are different sets and the matcher is one rule.
export function matchesSpecPath(path: string, pattern: string): boolean {
  if (pattern === "") return false;
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (pattern.includes("*")) {
    const source = pattern
      .split("*")
      .map((part): string => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\s\\S]*");
    return new RegExp(`^${source}$`).test(path);
  }
  return path === pattern;
}

/** `<dir>/<name>.md`, exactly one level deep. */
export function isFragmentPath(path: string, dir: string): boolean {
  const prefix = `${dir}/`;
  if (!path.startsWith(prefix) || !path.endsWith(".md")) return false;
  return !path.slice(prefix.length).includes("/");
}

// `no CHANGELOG entry: <reason>` -- case-insensitive, and the reason must be
// non-empty. A bare `no CHANGELOG entry:` is not an opt-out; it is the word
// without the justification the rule asks for.
const OPT_OUT = /no CHANGELOG entry:[ \t]*[^ \t\r\n]/i;

export function bodyHasOptOut(body: string | null): boolean {
  return body !== null && OPT_OUT.test(body);
}

/** `### Unreleased` entries: top-level `- **...` before the next `### ` header. */
export function unreleasedEntryCount(changelog: string): number {
  return countEntries(changelog, /^### Unreleased/);
}

/** The first dated `### vX.Y.Z` section's version, or null. */
export function firstDatedVersion(changelog: string): string | null {
  for (const line of changelog.split("\n")) {
    const match = /^### (v\d+\.\d+\.\d+)/.exec(line);
    if (match !== null) return match[1] ?? null;
  }
  return null;
}

/** Entries under the FIRST dated section. */
export function firstDatedEntryCount(changelog: string): number {
  return countEntries(changelog, /^### v\d+\.\d+\.\d+/);
}

function countEntries(changelog: string, header: RegExp): number {
  let inside = false;
  let count = 0;
  for (const line of changelog.split("\n")) {
    if (!inside && header.test(line)) {
      inside = true;
      continue;
    }
    if (line.startsWith("### ")) {
      if (inside) break;
      continue;
    }
    if (inside && line.startsWith("- **")) count += 1;
  }
  return count;
}

function fragmentAdded(inputs: FragmentInputs): boolean {
  return inputs.changed.some(
    (path): boolean => isFragmentPath(path, inputs.fragmentDir) && inputs.present.has(path),
  );
}

function fragmentDeleted(inputs: FragmentInputs): boolean {
  return inputs.changed.some(
    (path): boolean => isFragmentPath(path, inputs.fragmentDir) && !inputs.present.has(path),
  );
}

// The registry's `latest` was bumped TO this version in this diff.
//
// AN OMITTED BASE IS "NO EVIDENCE", NOT "DIFFERENT FROM HEAD". The source
// records the review that corrected this: treating an absent base as evidence
// would false-positive "against whatever `latest` happens to already be on disk".
function latestBumped(inputs: FragmentInputs, version: string): boolean {
  if (inputs.baseLatest === null) return false;
  return inputs.headLatest === version && inputs.baseLatest !== version;
}

export function isReleaseMove(inputs: FragmentInputs): boolean {
  if (inputs.headUnreleased !== 0) return false;
  if (inputs.headVersion === null) return false;
  if (inputs.headVersion === inputs.baseVersion) return false;

  if (inputs.baseUnreleased > 0) {
    return inputs.headSectionEntries >= inputs.baseUnreleased;
  }
  return fragmentDeleted(inputs) || latestBumped(inputs, inputs.headVersion);
}

export function fragmentRequired(inputs: FragmentInputs): FragmentReport {
  const triggers: { path: string; pattern: string }[] = [];
  for (const path of inputs.changed) {
    for (const pattern of inputs.specPaths) {
      if (matchesSpecPath(path, pattern)) triggers.push({ path, pattern });
    }
  }

  if (triggers.length === 0) {
    return {
      verdict: "not-applicable",
      required: false,
      triggers,
      detail: "no spec/canon paths changed, so the per-PR fragment rule does not apply",
    };
  }
  if (bodyHasOptOut(inputs.body)) {
    return {
      verdict: "opt-out",
      required: false,
      triggers,
      detail: "the body states the opt-out with a reason -- skipping the entry check, as the rule allows for a genuinely non-spec change",
    };
  }
  if (fragmentAdded(inputs)) {
    return {
      verdict: "fragment-present",
      required: false,
      triggers,
      detail: `a fragment under ${inputs.fragmentDir}/ is added or modified and survives at head -- satisfied`,
    };
  }
  if (isReleaseMove(inputs)) {
    const why =
      inputs.baseUnreleased > 0
        ? `Unreleased ${inputs.baseUnreleased} -> 0, collated into a new dated section`
        : fragmentDeleted(inputs)
          ? `${inputs.fragmentDir}/ fragment(s) collated and deleted, Unreleased already empty, new dated section landed`
          : "the registry's latest was bumped to the new dated section's version, Unreleased already empty (integration-epic collation)";
    return {
      verdict: "release-move",
      required: false,
      triggers,
      detail: `release move recognized (${why}) -- satisfied natively, so a release PR needs no opt-out to empty Unreleased`,
    };
  }

  return {
    verdict: "required",
    required: true,
    triggers,
    detail: `this change touches a spec/canon path (${[...new Set(triggers.map((hit): string => hit.pattern))].join(", ")}) but adds no ${inputs.fragmentDir}/ fragment, and its body carries no opt-out with a reason. Add ${inputs.fragmentDir}/<number>-<slug>.md -- never a direct edit to the changelog's Unreleased block, which the fragment convention retired as the per-PR mechanism -- or state the opt-out reason if this change is genuinely non-spec.`,
  };
}
