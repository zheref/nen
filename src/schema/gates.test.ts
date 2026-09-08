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
  const at = "/fake/nen/gates.json";
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

  // ── the ReDoS / `.*` guard, at the one seam a pattern is compiled ──────────
  //
  // zheref/nen#8 item 3 and zheref/nen#6 item 2 are the same code path. The
  // reasoning lives in ./pattern.ts's header; these cases pin that it is
  // actually WIRED, for every one of the five pattern fields, and that the
  // refusal is path- and pointer-bearing like every other refusal in this
  // loader.

  const reviewerWith = (field: string, pattern: string): unknown => ({
    ...minimal,
    reviewers: [
      {
        name: "a",
        login_pattern: { pattern: "a", ignoreCase: true },
        [field]: { pattern, ignoreCase: true },
      },
    ],
  });

  it("refuses a catastrophic login_pattern at LOAD, before any pull request is judged", () => {
    // The issue's own example. `new RegExp("(a+)+$","i").test("a".repeat(30)+"!")`
    // was measured at ~300ms in this runtime -- exponential, so a 39-character
    // login (GitHub's documented maximum) is 2**39 steps. It never runs.
    const started = performance.now();
    expect(() =>
      parseGateIdentities(at, {
        ...minimal,
        reviewers: [{ name: "a", login_pattern: { pattern: "(a+)+$", ignoreCase: true } }],
      }),
    ).toThrow(/exponential-backtracking/);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("refuses a catastrophic pattern in EVERY one of the five fields, not just the login", () => {
    for (const field of [
      "review_check_pattern",
      "round_check_pattern",
      "enrolment_check_pattern",
    ]) {
      expect(() => parseGateIdentities(at, reviewerWith(field, "(a|a)+$")), field).toThrow(
        /exponential-backtracking/,
      );
    }
    expect(() =>
      parseGateIdentities(at, {
        ...minimal,
        delivery: { ...minimal.delivery, author_pattern: { pattern: "(x+)+", ignoreCase: true } },
      }),
    ).toThrow(/exponential-backtracking/);
  });

  it("names the file, the pointer and the offending fragment", () => {
    try {
      parseGateIdentities(at, {
        ...minimal,
        reviewers: [{ name: "a", login_pattern: { pattern: "^z(a+)+$", ignoreCase: true } }],
      });
      expect.unreachable();
    } catch (error) {
      const schemaError = error as { path: string; pointer: string | null; message: string };
      expect(schemaError.path).toBe(at);
      expect(schemaError.pointer).toBe("reviewers[0].login_pattern.pattern");
      // The FRAGMENT, so the author can find it inside a long pattern.
      expect(schemaError.message).toContain("'(a+)+'");
    }
  });

  it("refuses a pattern that matches the EMPTY string -- unanchored, it matches everything", () => {
    // Not a broad pattern: the constant `true`. On login_pattern every login on
    // earth satisfies the reviewer's round and joins the approval set; on
    // round_check_pattern every green check clears a round nobody posted.
    expect(() =>
      parseGateIdentities(at, {
        ...minimal,
        reviewers: [{ name: "a", login_pattern: { pattern: ".*", ignoreCase: true } }],
      }),
    ).toThrow(/EMPTY string/);
    expect(() => parseGateIdentities(at, reviewerWith("round_check_pattern", "x?"))).toThrow(
      /EMPTY string/,
    );
  });

  it("still accepts the ordinary, anchored and unanchored patterns both fixtures ship", () => {
    // The guard's cost has to be zero on real reviewer identities, or it is a
    // worse defect than the one it closes. Both shipped fixtures load unchanged
    // -- asserted here as well as in loadGateIdentities' own cases above,
    // because THIS is the assertion that goes red if the guard tightens.
    expect(() => loadGateIdentities(BANKAI_REPO)).not.toThrow();
    expect(() => loadGateIdentities(ALT_REPO)).not.toThrow();
    expect(() =>
      parseGateIdentities(at, reviewerWith("review_check_pattern", "^a / audit$")),
    ).not.toThrow();
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
