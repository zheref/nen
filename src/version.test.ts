import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPATIBLE_MINOR_FLOOR, PROGRAM, VERSION } from "./version.js";

// The drift guard the header of version.ts promises. It reads package.json
// through `process.cwd()` -- vitest runs from the repo root -- rather than from
// `import.meta.url`, so this test exercises the same root-resolution discipline
// the shipped code is held to (Akatsuki migration §3).
describe("VERSION", () => {
  it("matches package.json's version exactly", () => {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const pkg: unknown = JSON.parse(raw);
    expect(typeof pkg).toBe("object");
    const version = (pkg as { version?: unknown }).version;
    expect(version).toBe(VERSION);
  });

  it("is a semver-shaped string", () => {
    // The `-dev.N` pre-release suffix is gone as of the v0.1.0 release: this
    // is the exact string zheref/hatsu#1's D10 gate is meant to see. The
    // pre-release group stays optional (rather than dropped outright) so this
    // test does not need to change again for a future `-rc.N` or `-dev.N`
    // cycle ahead of v0.3.0.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it("names the program", () => {
    expect(PROGRAM).toBe("nen");
  });
});

// ── the compatibility floor, reconciled against the prose it summarises ─────
//
// `COMPATIBLE_MINOR_FLOOR` is one number standing for a claim written at length
// in CHANGELOG.md: which releases declared breaking consumer notes. The number
// is what ships (a compiled binary has no CHANGELOG beside it) and the prose is
// what a human writes, so the ONE thing that can go wrong is that a release cut
// writes breaking notes and forgets the constant -- which would hand every
// consumer a build that silently accepts a pin it breaks. That is the fail-OPEN
// direction, and this is the guard against it.
//
// IT READS THE TOPMOST RELEASED SECTION AND NO OTHER. Older sections are
// history: their floors are already shipped in binaries this test cannot reach,
// and re-deriving them here would be a second, drifting statement of what those
// releases were. `## Unreleased` is skipped for the same reason in the other
// direction -- nothing is released until it is dated, and a bullet written
// today must not move the floor of the build that shipped yesterday. The
// release cut is what moves both, in one commit (docs/USAGE.md, "Release
// mechanics").

/** The topmost `## vX.Y.Z` section of the changelog, with its own bullets. */
interface ReleasedSection {
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  /** Bullets under `### Breaking / consumer notes`, in order. */
  readonly breaking: readonly string[];
}

const BREAKING_HEADING = "### Breaking / consumer notes";

/**
 * THE DEDICATED MARKER a release cut writes on the pin bullet, and the only
 * thing this file treats as "not a breaking change".
 *
 * A BOLD LEAD-IN THAT *BEGINS* `Repin:` OR `No repin:`, and nothing looser.
 * Matching any lead that merely CONTAINS the word would exclude a substantive
 * bullet such as **"Compatibility requires a repin because …"** and let a
 * release with real breaking notes ship a stale floor -- the fail-open
 * direction, which is the whole thing this guard is here to prevent. The marker
 * is written down in docs/USAGE.md's release section so the cut knows to write
 * it; a bullet without it counts as substantive, which is the safe way for this
 * matcher to be wrong.
 */
const PIN_BULLET = /^(?:no\s+)?repin\b/i;

/**
 * A bullet that only reports the pin's status, which is not itself a break.
 *
 * THE PIN SENTENCE IS THE ONE BULLET THAT USED TO BE UNCONDITIONAL. Under the
 * old exact-minor rule every release owed a repin, so counting it as evidence
 * of a breaking change would make this guard say "breaking" about every release
 * forever -- precisely the reading the compatibility floor exists to end. Under
 * the new rule the same bullet reports the other outcome too (`No repin: the
 * compatibility floor stays 0.7`), and both are status rather than breakage.
 */
function isPinBullet(bullet: string): boolean {
  const lead = /^\*\*(.+?)\*\*/s.exec(bullet.trim());
  return lead !== null && PIN_BULLET.test((lead[1] ?? "").trim());
}

/**
 * The floor the pin bullet's own lead-in NAMES, as `MAJOR.MINOR`, or null.
 *
 * WHY THE LEAD-IN AND NOT THE WHOLE BULLET. The bullet's body legitimately
 * names other floors -- the one being left behind, the one still refused -- and
 * reading a number out of prose that discusses several would pick whichever
 * came last by accident. The lead-in is the sentence USAGE prescribes, and both
 * spellings it prescribes END on the floor that now applies:
 * `**Repin: \`"0.6"\` → \`"0.7"\`, …**` and
 * `**No repin: the compatibility floor stays \`0.7\`.**`
 *
 * SO IT READS THE LAST TWO-COMPONENT VERSION IN THE LEAD-IN'S BACKTICKED SPANS.
 * A three-component tag (`v0.7.0`) is not a floor and is SKIPPED rather than
 * truncated to one: `parseMinimum` refuses a third component by name, and a
 * floor inferred from a tag would be a comparison nobody wrote.
 */
function floorNamedBy(bullet: string): string | null {
  const lead = /^\*\*(.+?)\*\*/s.exec(bullet.trim());
  if (lead === null) return null;
  const named = [...(lead[1] ?? "").matchAll(/`([^`]+)`/g)]
    .map((match): string => (match[1] ?? "").replace(/["']/g, "").trim())
    .filter((value): boolean => /^\d+\.\d+$/.test(value));
  return named.at(-1) ?? null;
}

function topmostRelease(changelog: string): ReleasedSection {
  const lines = changelog.split("\n");
  let version: string | null = null;
  let inBreaking = false;
  const breaking: string[] = [];
  for (const line of lines) {
    const release = /^## v(\d+)\.(\d+)\.(\d+)\b/.exec(line);
    if (release !== null) {
      // The SECOND released heading ends the section: everything below it is
      // history this test has nothing true to say about.
      if (version !== null) break;
      version = `${release[1]}.${release[2]}.${release[3]}`;
      continue;
    }
    if (version === null) continue;
    if (line.startsWith("### ")) {
      inBreaking = line.trim() === BREAKING_HEADING;
      continue;
    }
    if (inBreaking && line.startsWith("- ")) breaking.push(line.slice(2));
  }
  if (version === null) throw new Error("CHANGELOG.md carries no released `## vX.Y.Z` section");
  const [major, minor] = version.split(".").map(Number);
  return { version, major: major ?? 0, minor: minor ?? 0, breaking };
}

describe("COMPATIBLE_MINOR_FLOOR", () => {
  const changelog = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8");
  const release = topmostRelease(changelog);
  const [floorMajor, floorMinor] = COMPATIBLE_MINOR_FLOOR.split(".").map(Number);

  it("is a MAJOR.MINOR floor, spelled the way a `dependency.minimum` pin is", () => {
    // Exactly two components, because that is the shape `parseMinimum` reads
    // and the shape a declaration writes. A third would be refused by the very
    // function that consumes this constant.
    expect(COMPATIBLE_MINOR_FLOOR).toMatch(/^\d+\.\d+$/);
  });

  it("is never above this build's own version", () => {
    // A floor above the binary would admit NOTHING: every pin at or above it
    // would also be above this build's minor, and every pin below it would be
    // refused by the floor. A build that satisfies no pin at all is a build no
    // consumer can declare.
    const [major, minor] = VERSION.split(".").map(Number);
    expect(floorMajor).toBe(major);
    expect(floorMinor).toBeLessThanOrEqual(minor ?? 0);
  });

  it("sits at the topmost release's own minor when that release declared breaking notes", () => {
    // The rule, in one assertion. A release whose `### Breaking / consumer
    // notes` section carries a bullet that is not merely the repin sentence
    // MUST have moved the floor to its own minor; one that carries none (or no
    // such section at all) must have left the floor where it was, which is
    // what lets a consumer's existing pin keep working.
    const substantive = release.breaking.filter((bullet): boolean => !isPinBullet(bullet));
    expect(release.major).toBe(floorMajor);
    if (substantive.length > 0) {
      expect(
        `${floorMajor}.${floorMinor}`,
        `v${release.version} declares ${substantive.length} breaking consumer note(s), so COMPATIBLE_MINOR_FLOOR must be '${release.major}.${release.minor}'`,
      ).toBe(`${release.major}.${release.minor}`);
    } else {
      expect(
        floorMinor,
        `v${release.version} declares no breaking consumer notes, so COMPATIBLE_MINOR_FLOOR must not have moved up to its minor`,
      ).toBeLessThanOrEqual(release.minor);
    }
  });

  it("counts a bullet that merely MENTIONS repinning as a breaking note", () => {
    // The matcher is a marker, not a keyword search. A substantive bullet that
    // happens to use the word must still count, or a release with real
    // breaking notes ships a stale floor -- and a stale floor is a build that
    // silently accepts a pin it breaks.
    expect(isPinBullet('**Repin: `"0.6"` → `"0.7"`.** …')).toBe(true);
    expect(isPinBullet("**No repin: the compatibility floor stays `0.7`.** …")).toBe(true);
    expect(isPinBullet("**Compatibility requires a repin because the exit codes moved.** …")).toBe(
      false,
    );
    expect(isPinBullet("**`nen pr ready` now reads the carve-out.** …")).toBe(false);
    // No bold lead-in at all is a bullet this matcher must not claim.
    expect(isPinBullet("Repin: this one has no lead-in")).toBe(false);
  });

  it("reads the floor a pin bullet names out of BOTH spellings USAGE prescribes", () => {
    // The extraction, pinned on the two lead-ins the release step writes, so
    // the assertion below is testing the changelog rather than this regex. The
    // `Repin:` spelling names four values and only two of them are floors: the
    // `v0.6.0`/`v0.7.0` tags are skipped, and the LAST floor -- the one now in
    // force -- is what comes back.
    expect(floorNamedBy('**Repin: `"0.6"` → `"0.7"`, and `v0.6.0` → `v0.7.0`.** …')).toBe("0.7");
    expect(floorNamedBy("**No repin: the compatibility floor stays `0.7`.** …")).toBe("0.7");
    // A lead-in that names no floor at all is null rather than a guess.
    expect(floorNamedBy("**No repin: nothing moved.** …")).toBeNull();
    expect(floorNamedBy("no bold lead-in here `0.7`")).toBeNull();
  });

  it("holds the pin bullet's OWN WORDS to the constant the build ships", () => {
    // The case below proves a marker was WRITTEN; this one proves it is TRUE,
    // and without it the pair has a hole a release cut can fall into. The
    // outcome branch above bounds the floor only from ABOVE
    // (`floorMinor <= release.minor`) when a release declares no substantive
    // note -- so a v0.8.0 cut could set COMPATIBLE_MINOR_FLOOR to `0.8`, ship a
    // bullet reading "No repin: the compatibility floor stays `0.7`", and pass:
    // 8 <= 8. The consequence is not a stale floor, it is a LIE in the one
    // document a consumer acts on. They read the bullet, leave `minimum: "0.7"`
    // alone on its word, and meet exit 5 from a binary that says the pin is
    // below its floor.
    //
    // (Raised by Copilot's review of #201, which found exactly this gap.)
    for (const pin of release.breaking.filter(isPinBullet)) {
      expect(
        floorNamedBy(pin),
        `v${release.version}'s pin bullet must name the floor this build ships (${COMPATIBLE_MINOR_FLOOR}): ${pin.slice(0, 96)}`,
      ).toBe(COMPATIBLE_MINOR_FLOOR);
    }
  });

  it("requires the cut to write exactly one pin bullet, whichever way the floor went", () => {
    // WHAT THIS ASSERTION USED TO BE, AND WHY IT COULD NOT SURVIVE v0.8.0.
    // Through the v0.7.0 line it read "v0.7.0's section is breaking, which is
    // why the floor is seeded there" -- a true statement about the topmost
    // section for exactly as long as v0.7.0 WAS the topmost section. The v0.8.0
    // cut put a non-breaking release above it, and neither repair was
    // available: re-pointing it at v0.7.0 BY NAME breaks this file's own rule
    // (it reads the topmost released section AND NO OTHER, because older
    // sections are history already shipped in binaries it cannot reach), while
    // re-asserting `substantive > 0` on whatever is topmost would assert that
    // every release from here on is a breaking one -- the exact claim
    // COMPATIBLE_MINOR_FLOOR exists to stop making.
    //
    // WHAT GENERALISES IS THE OTHER HALF, and it is a rule docs/USAGE.md's
    // release section states outright: the pin bullet is written EITHER WAY --
    // `Repin:` when the floor moved, `No repin:` when it stayed -- so a reader
    // is never left to infer the outcome from a section that says nothing. The
    // test above decides whether the floor is RIGHT; this one decides whether
    // the cut SAID SO, which is a distinct failure the other cannot see: a
    // release that moves the floor correctly and omits the repin sentence
    // hands every consumer an exit 5 with no instruction in the changelog.
    // Exactly one, because two pin bullets are two answers to a question with
    // one.
    expect(
      release.breaking.filter(isPinBullet),
      `v${release.version} must carry exactly one pin bullet, with a bold lead-in beginning "Repin:" or "No repin:"`,
    ).toHaveLength(1);
  });
});
