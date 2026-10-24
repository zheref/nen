import { describe, expect, it } from "vitest";
import {
  bodyHasOptOut,
  firstDatedEntryCount,
  firstDatedVersion,
  fragmentRequired,
  isFragmentPath,
  isReleaseMove,
  matchesSpecPath,
  unreleasedEntryCount,
  type FragmentInputs,
} from "./fragment.js";
import { collateChangelog } from "./collate.js";
import { sectionHeadings } from "./completeness.js";

function inputs(overrides: Partial<FragmentInputs> = {}): FragmentInputs {
  return {
    specPaths: ["CONSTITUTION.md", "schemas/*"],
    fragmentDir: "changelog.d",
    changed: [],
    body: null,
    present: new Set(),
    baseUnreleased: 0,
    headUnreleased: 0,
    baseVersion: null,
    headVersion: null,
    headSectionEntries: 0,
    baseLatest: null,
    headLatest: null,
    ...overrides,
  };
}

describe("matchesSpecPath / isFragmentPath", () => {
  it("matches the shell's own glob semantics, '*' crossing '/'", () => {
    expect(matchesSpecPath("schemas/a/b.json", "schemas/*")).toBe(true);
  });

  it("a fragment is exactly one level deep", () => {
    expect(isFragmentPath("changelog.d/1-a.md", "changelog.d")).toBe(true);
    expect(isFragmentPath("changelog.d/nested/1-a.md", "changelog.d")).toBe(false);
  });
});

describe("bodyHasOptOut", () => {
  it("requires the reason, not just the phrase", () => {
    expect(bodyHasOptOut("no CHANGELOG entry: docs only")).toBe(true);
    expect(bodyHasOptOut("no CHANGELOG entry:")).toBe(false);
    expect(bodyHasOptOut(null)).toBe(false);
  });
});

describe("unreleasedEntryCount / firstDatedVersion / firstDatedEntryCount", () => {
  const changelog = "### Unreleased\n- **A** thing\n- **B** thing\n\n### v1.0.0\n- **C** thing\n";
  it("counts entries under Unreleased, before the next header", () => {
    expect(unreleasedEntryCount(changelog)).toBe(2);
  });
  it("finds the first dated section's version and entry count", () => {
    expect(firstDatedVersion(changelog)).toBe("v1.0.0");
    expect(firstDatedEntryCount(changelog)).toBe(1);
  });
});

// THE DATED FORM `collate` WRITES (Bugbot on zheref/nen#527, PRRT_kwDOUKPjns6v1Osm):
// a changelog whose releases are `## vX.Y.Z — <date>` -- nen's own -- gets its
// new section in that form, and the release-move readers must see it, or a
// release PR that collated its fragments is "fragment required" at exit 1.
describe("firstDatedVersion / firstDatedEntryCount -- the `## vX.Y.Z — <date>` form", () => {
  const nenForm = "# Changelog\n\nIntro.\n\n## v0.27.0 — 2026-10-22\n\nTheme.\n\n### Added\n\n- **A** one\n- **B** two\n\n### Fixed\n\n- **C** three\n\n## v0.26.0 — 2026-10-20\n\n- **D** older\n";
  it("reads the version of a level-2 dated heading", () => {
    expect(firstDatedVersion(nenForm)).toBe("v0.27.0");
  });
  it("counts every entry of the section, its `###` subsections included, and stops at the next `##`", () => {
    expect(firstDatedEntryCount(nenForm)).toBe(3);
  });
  it("still stops a `###` section at the next `###` heading", () => {
    expect(firstDatedEntryCount("### v1.0.0\n- **A** a\n### v0.9.0\n- **B** b\n")).toBe(1);
  });
  it("is not fooled by `### Unreleased` or a non-version heading", () => {
    expect(firstDatedVersion("## Notes\n\n### Unreleased\n\n- **A** a\n")).toBeNull();
    expect(firstDatedEntryCount("## Notes\n\n### Unreleased\n\n- **A** a\n")).toBe(0);
  });
  it("a release that collate wrote into the dated form is a release move", () => {
    const base = "# Changelog\n\n### Unreleased\n\n## v1.0.0 — 2026-10-01\n\n- **old** thing\n";
    const head = collateChangelog(base, "v1.1.0", "Theme.", [{ name: "1-a.md", content: "- **new** thing\n" }], { date: "2026-10-24" }).text;
    expect(head).toContain("## v1.1.0 — 2026-10-24");
    expect(firstDatedVersion(head)).toBe("v1.1.0");
    expect(firstDatedEntryCount(head)).toBe(1);
    const report = fragmentRequired(
      inputs({
        changed: ["CONSTITUTION.md", "changelog.d/1-a.md"],
        present: new Set(),
        baseUnreleased: unreleasedEntryCount(base),
        headUnreleased: unreleasedEntryCount(head),
        baseVersion: firstDatedVersion(base),
        headVersion: firstDatedVersion(head),
        headSectionEntries: firstDatedEntryCount(head),
      }),
    );
    expect(report.verdict).toBe("release-move");
    expect(report.required).toBe(false);
  });
});

// ONE PREDICATE FOR "DATED" (Bugbot on zheref/nen#528, PRRT_kwDOUKPjns6v4kDn):
// the release-move reader and completeness's allowance read the same heading
// as the release -- a `— unreleased` trailer is not dated, and a pre-release
// suffix is part of the version.
describe("firstDatedVersion agrees with completeness's sectionHeadings", () => {
  const cases = [
    "## v1.2.0 — unreleased\n\n- **A** a\n\n## v1.1.0 — 2026-10-01\n\n- **B** b\n- **C** c\n",
    "## v1.2.0-rc.2 — 2026-10-24\n\n- **A** a\n\n## v1.2.0-rc.1 — 2026-10-20\n",
    "### v0.3.0 — _(unreleased)_\n- **A** a\n### v0.2.0 — theme\n- **B** b\n",
    "## Notes\n\n### Unreleased\n\n- **A** a\n",
  ];
  it("names the same first dated version, the pre-release suffix kept and `— unreleased` skipped", () => {
    for (const text of cases) {
      expect(firstDatedVersion(text), text).toBe(sectionHeadings(text).find((h): boolean => h.dated)?.version ?? null);
    }
    expect(firstDatedVersion(cases[0] as string)).toBe("v1.1.0");
    expect(firstDatedEntryCount(cases[0] as string)).toBe(2);
    expect(firstDatedVersion(cases[1] as string)).toBe("v1.2.0-rc.2");
    expect(firstDatedVersion(cases[2] as string)).toBe("v0.2.0");
  });
  it("the PR that only dates an `— unreleased` heading is a release move", () => {
    const base = "## v1.2.0 — unreleased\n\n- **A** a\n\n## v1.1.0 — 2026-10-01\n";
    const head = "## v1.2.0 — 2026-10-24\n\n- **A** a\n\n## v1.1.0 — 2026-10-01\n";
    expect(
      isReleaseMove(
        inputs({
          baseVersion: firstDatedVersion(base),
          headVersion: firstDatedVersion(head),
          headSectionEntries: firstDatedEntryCount(head),
          baseLatest: "v1.1.0",
          headLatest: "v1.2.0",
        }),
      ),
    ).toBe(true);
  });
  it("distinct pre-releases are distinct versions", () => {
    const base = "## v1.2.0-rc.1 — 2026-10-20\n";
    const head = "## v1.2.0-rc.2 — 2026-10-24\n\n## v1.2.0-rc.1 — 2026-10-20\n";
    expect(isReleaseMove(inputs({ baseVersion: firstDatedVersion(base), headVersion: firstDatedVersion(head), baseLatest: "v1.2.0-rc.1", headLatest: "v1.2.0-rc.2" }))).toBe(true);
  });
});

// A VERSION HEADING AT LEVEL 2 OR 3 CLOSES THE SECTION (Bugbot on zheref/nen#528,
// PRRT_kwDOUKPjns6v4kDu): a `### vX.Y.Z` below a `## vX.Y.Z` release is the
// previous release, not a subsection, and its bullets are not the head's.
describe("firstDatedEntryCount -- a version heading at level 2 or 3 closes the section", () => {
  it("stops a `##` release at a following `### vX.Y.Z`, and still counts a `### Added` subsection", () => {
    const text = "## v2.0.0 — 2026-10-24\n\n### Added\n\n- **A** a\n\n### v1.9.0 — theme\n\n- **B** b\n- **C** c\n";
    expect(firstDatedEntryCount(text)).toBe(1);
  });
});

describe("fragmentRequired", () => {
  it("is not-applicable when no spec path changed", () => {
    const report = fragmentRequired(inputs({ changed: ["src/a.ts"] }));
    expect(report.verdict).toBe("not-applicable");
    expect(report.required).toBe(false);
  });

  it("is satisfied by an opt-out with a reason", () => {
    const report = fragmentRequired(
      inputs({ changed: ["CONSTITUTION.md"], body: "no CHANGELOG entry: internal only" }),
    );
    expect(report.verdict).toBe("opt-out");
  });

  it("is satisfied by a surviving fragment", () => {
    const report = fragmentRequired(
      inputs({
        changed: ["CONSTITUTION.md", "changelog.d/1-a.md"],
        present: new Set(["changelog.d/1-a.md"]),
      }),
    );
    expect(report.verdict).toBe("fragment-present");
  });

  it("is required when a spec path changed with no fragment and no opt-out", () => {
    const report = fragmentRequired(inputs({ changed: ["CONSTITUTION.md"] }));
    expect(report.verdict).toBe("required");
    expect(report.required).toBe(true);
  });

  it("recognizes the legacy direct-edit release move", () => {
    const report = fragmentRequired(
      inputs({
        changed: ["CONSTITUTION.md"],
        baseUnreleased: 2,
        headUnreleased: 0,
        baseVersion: "v1.0.0",
        headVersion: "v1.1.0",
        headSectionEntries: 2,
      }),
    );
    expect(report.verdict).toBe("release-move");
  });

  it("recognizes the fragment-era move via a deleted fragment", () => {
    const report = fragmentRequired(
      inputs({
        changed: ["CONSTITUTION.md", "changelog.d/1-a.md"],
        present: new Set(), // deleted at head
        baseUnreleased: 0,
        headUnreleased: 0,
        baseVersion: "v1.0.0",
        headVersion: "v1.1.0",
        headSectionEntries: 1,
      }),
    );
    expect(report.verdict).toBe("release-move");
  });

  it("recognizes the integration-epic collation via a registry latest bump", () => {
    const report = fragmentRequired(
      inputs({
        changed: ["CONSTITUTION.md"],
        baseUnreleased: 0,
        headUnreleased: 0,
        baseVersion: "v1.0.0",
        headVersion: "v1.1.0",
        headSectionEntries: 1,
        baseLatest: "v1.0.0",
        headLatest: "v1.1.0",
      }),
    );
    expect(report.verdict).toBe("release-move");
  });

  it("does NOT treat an omitted base as evidence of a bump", () => {
    expect(
      isReleaseMove(
        inputs({
          baseUnreleased: 0,
          headUnreleased: 0,
          baseVersion: "v1.0.0",
          headVersion: "v1.1.0",
          baseLatest: null,
          headLatest: "v1.1.0",
        }),
      ),
    ).toBe(false);
  });
});
