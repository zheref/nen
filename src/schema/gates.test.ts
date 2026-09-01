import { describe, expect, it } from "vitest";
import { ALT_REPO, BANKAI_REPO } from "./fixtures/paths.js";
import { loadGateIdentities, parseGateIdentities } from "./gates.js";

describe("loadGateIdentities -- reads the TARGET repository", () => {
  it("reads whichever reviewers the target repo declares", () => {
    const bankai = loadGateIdentities(BANKAI_REPO);
    const alt = loadGateIdentities(ALT_REPO);
    expect(bankai.reviewers.map((r): string => r.name)).toEqual([
      "sasuke",
      "tenma",
      "copilot",
      "bisky",
      "bugbot",
    ]);
    expect(alt.reviewers.map((r): string => r.name)).toEqual([
      "itachi",
      "kisame",
      "scribe",
      "sentry",
    ]);
    expect(bankai.reviewer("itachi")).toBeUndefined();
    expect(alt.reviewer("sasuke")).toBeUndefined();
  });

  it("compiles each pattern with the case-sensitivity the FILE states", () => {
    const bisky = loadGateIdentities(BANKAI_REPO).reviewer("bisky");
    // The asymmetry is the data's, and it is load-bearing: the enrolment check
    // is anchored and case-SENSITIVE so a sibling probe job cannot enrol the
    // reviewer, while the round check is case-insensitive.
    expect(bisky?.enrolmentCheckPattern?.flags).toBe("");
    expect(bisky?.roundCheckPattern?.flags).toBe("i");
    expect(bisky?.enrolmentCheckPattern?.test("bisky / review")).toBe(true);
    expect(bisky?.enrolmentCheckPattern?.test("Bisky / Review")).toBe(false);
    expect(bisky?.roundCheckPattern?.test("Bisky / Review")).toBe(true);

    const bugbot = loadGateIdentities(BANKAI_REPO).reviewer("bugbot");
    expect(bugbot?.enrolmentCheckPattern?.flags).toBe("i");
    expect(bugbot?.enrolmentCheckPattern?.test("Cursor Bugbot")).toBe(true);
  });

  it("carries the two structural flags", () => {
    const bankai = loadGateIdentities(BANKAI_REPO);
    expect(bankai.reviewer("copilot")?.boundedPolicyExempt).toBe(true);
    expect(bankai.reviewer("sasuke")?.boundedPolicyExempt).toBe(false);
    expect(bankai.reviewer("sasuke")?.deliveryHolisticPass).toBe(true);
    expect(bankai.reviewer("bisky")?.deliveryHolisticPass).toBe(false);

    const alt = loadGateIdentities(ALT_REPO);
    expect(alt.reviewer("scribe")?.boundedPolicyExempt).toBe(true);
    expect(alt.reviewer("itachi")?.deliveryHolisticPass).toBe(true);
  });

  it("carries a delivery convention that differs per repository", () => {
    const bankai = loadGateIdentities(BANKAI_REPO);
    expect(bankai.delivery.headRefPrefixes).toEqual(["integration/"]);
    expect(bankai.delivery.labels).toEqual(["bankai:epic"]);
    expect(bankai.delivery.authorPattern.test("app/roy-bankai")).toBe(true);
    expect(bankai.delivery.authorPattern.test("roy-bankai-evil")).toBe(false);

    const alt = loadGateIdentities(ALT_REPO);
    expect(alt.delivery.headRefPrefixes).toEqual(["train/"]);
    expect(alt.delivery.labels).toEqual(["akatsuki:migration"]);
    expect(alt.delivery.authorPattern.test("train-bot[bot]")).toBe(true);
    expect(alt.delivery.authorPattern.test("app/roy-bankai")).toBe(false);
  });

  it("is a LOUD error when the file is absent -- there is no built-in reviewer set", () => {
    // The most dangerous fallback available: judging readiness against another
    // repository's reviewers while reporting success.
    expect(() => loadGateIdentities("/definitely/not/a/repo")).toThrow(/no such file/);
  });
});

describe("parseGateIdentities -- validation", () => {
  const at = "/fake/schemas/gates.json";
  const minimal = {
    version: 1,
    reviewers: [
      { name: "a", login_pattern: { pattern: "a", ignoreCase: true } },
    ],
    default_approvers: ["a"],
    base_reviewers: ["a"],
    delivery: {
      author_pattern: { pattern: "bot", ignoreCase: true },
      head_ref_prefixes: ["x/"],
    },
  };

  it("accepts a minimal file", () => {
    const identities = parseGateIdentities(at, minimal);
    expect(identities.reviewers.length).toBe(1);
    expect(identities.version).toBe(1);
    expect(identities.defaultApprovers).toEqual(["a"]);
    expect(identities.baseReviewers).toEqual(["a"]);
  });

  it("REFUSES an omitted or empty default_approvers -- it would OPEN the approve limb", () => {
    // MERGE-BLOCKING CORRECTION. `reviewsAllApprovedAtHead` is vacuously true
    // over an empty approver set (deliberately -- it reproduces jq's `all` over
    // an empty list). Pairing that with a silently-defaulted `[]` here meant a
    // gates.json that simply forgot the key left CON-32(b)'s approve limb OPEN:
    // a pull request read ready with nobody having approved it. An earlier
    // version of this very suite asserted the empty default as correct.
    const withoutKey = { ...minimal, default_approvers: undefined };
    expect(() => parseGateIdentities(at, withoutKey)).toThrow(/default_approvers/);
    expect(() => parseGateIdentities(at, withoutKey)).toThrow(/VACUOUSLY TRUE/);
    expect(() => parseGateIdentities(at, { ...minimal, default_approvers: [] })).toThrow(
      /is empty/,
    );
  });

  it("REFUSES an omitted or empty base_reviewers", () => {
    const withoutKey = { ...minimal, base_reviewers: undefined };
    expect(() => parseGateIdentities(at, withoutKey)).toThrow(/base_reviewers/);
    expect(() => parseGateIdentities(at, { ...minimal, base_reviewers: [] })).toThrow(/is empty/);
  });

  it("requires a version, and refuses one it does not understand", () => {
    const withoutVersion = { ...minimal, version: undefined };
    expect(() => parseGateIdentities(at, withoutVersion)).toThrow(/version[\s\S]*is required/);
    expect(() => parseGateIdentities(at, { ...minimal, version: 2 })).toThrow(
      /understands version 1 only/,
    );
    expect(() => parseGateIdentities(at, { ...minimal, version: "1" })).toThrow(
      /understands version 1 only/,
    );
  });

  it("reads the version BEFORE interpreting any field", () => {
    // A version mismatch diagnosed as five unrelated field defects is a version
    // mismatch nobody recognises as one.
    expect(() => parseGateIdentities(at, { version: 99, reviewers: "not-an-array" })).toThrow(
      /version/,
    );
  });

  it("requires a login pattern for every declared reviewer", () => {
    expect(() => parseGateIdentities(at, { ...minimal, reviewers: [{ name: "a" }] })).toThrow(
      /login_pattern[\s\S]*required/,
    );
  });

  it("requires ignoreCase to be stated rather than assumed", () => {
    expect(() =>
      parseGateIdentities(at, {
        ...minimal,
        reviewers: [{ name: "a", login_pattern: { pattern: "a" } }],
      }),
    ).toThrow(/Case-sensitivity decides which checks match/);
  });

  it("refuses an unparseable pattern instead of letting it match nothing", () => {
    expect(() =>
      parseGateIdentities(at, {
        ...minimal,
        reviewers: [{ name: "a", login_pattern: { pattern: "a(", ignoreCase: true } }],
      }),
    ).toThrow(/silently excuses a reviewer from every round/);
  });

  it("refuses a duplicate reviewer name", () => {
    expect(() =>
      parseGateIdentities(at, {
        ...minimal,
        reviewers: [
          { name: "a", login_pattern: { pattern: "a", ignoreCase: true } },
          { name: "a", login_pattern: { pattern: "b", ignoreCase: true } },
        ],
      }),
    ).toThrow(/duplicates reviewers\[0\]\.name/);
  });

  it("refuses an approver or base reviewer that is not a declared reviewer", () => {
    expect(() => parseGateIdentities(at, { ...minimal, default_approvers: ["ghost"] })).toThrow(
      /not declared in 'reviewers'/,
    );
    expect(() => parseGateIdentities(at, { ...minimal, base_reviewers: ["ghost"] })).toThrow(
      /not declared in 'reviewers'/,
    );
  });

  it("refuses a delivery block that could never match anything", () => {
    expect(() =>
      parseGateIdentities(at, {
        ...minimal,
        delivery: { author_pattern: { pattern: "bot", ignoreCase: true } },
      }),
    ).toThrow(/carve-out is unreachable/);
  });

  it("requires a delivery author pattern", () => {
    expect(() =>
      parseGateIdentities(at, { ...minimal, delivery: { head_ref_prefixes: ["x/"] } }),
    ).toThrow(/delivery\.author_pattern[\s\S]*required/);
  });
});
