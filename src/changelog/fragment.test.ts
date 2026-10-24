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
