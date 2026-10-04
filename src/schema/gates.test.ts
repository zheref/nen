import { describe, expect, it } from "vitest";
import { ALT_REPO, BANKAI_REPO } from "./fixtures/paths.js";
import { loadGateIdentities, parseGateIdentities } from "./gates.js";
import { SchemaError } from "./errors.js";

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
    expect(identities.approvalPolicy).toBe("required");
    expect(identities.baseReviewers).toEqual(["a"]);
    // No round_policy declared: null, so the CALLER's own default applies --
    // not a silently substituted number (zheref/nen#214 item 2).
    expect(identities.stallMinutes).toBeNull();
  });

  describe("round_policy.stallMinutes (zheref/nen#214 item 2)", () => {
    it("is null when the block is absent", () => {
      expect(parseGateIdentities(at, minimal).stallMinutes).toBeNull();
    });

    it("is null when round_policy is declared but stallMinutes is not", () => {
      const identities = parseGateIdentities(at, { ...minimal, round_policy: {} });
      expect(identities.stallMinutes).toBeNull();
    });

    it("reads a declared override", () => {
      const identities = parseGateIdentities(at, {
        ...minimal,
        round_policy: { stallMinutes: 10 },
      });
      expect(identities.stallMinutes).toBe(10);
    });

    it("accepts zero -- a repository that wants an immediate stall verdict", () => {
      const identities = parseGateIdentities(at, {
        ...minimal,
        round_policy: { stallMinutes: 0 },
      });
      expect(identities.stallMinutes).toBe(0);
    });

    it("REFUSES a negative number", () => {
      expect(() =>
        parseGateIdentities(at, { ...minimal, round_policy: { stallMinutes: -1 } }),
      ).toThrow(/stallMinutes/);
    });

    it("REFUSES a non-number", () => {
      expect(() =>
        parseGateIdentities(at, { ...minimal, round_policy: { stallMinutes: "30" } }),
      ).toThrow(/stallMinutes/);
    });

    it("REFUSES a round_policy that is not an object", () => {
      expect(() => parseGateIdentities(at, { ...minimal, round_policy: "bounded" })).toThrow(
        /round_policy/,
      );
    });
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

  it("allows an explicitly empty approver set only with review-round-only policy", () => {
    const identities = parseGateIdentities(at, {
      ...minimal,
      approval_policy: "review-round-only",
      default_approvers: [],
    });
    expect(identities.approvalPolicy).toBe("review-round-only");
    expect(identities.defaultApprovers).toEqual([]);
    expect(() =>
      parseGateIdentities(at, { ...minimal, approval_policy: "unknown", default_approvers: [] }),
    ).toThrow(/approval_policy/);
    expect(() =>
      parseGateIdentities(at, {
        ...minimal,
        approval_policy: "review-round-only",
        default_approvers: undefined,
      }),
    ).toThrow(/is required/);
    expect(() =>
      parseGateIdentities(at, { ...minimal, approval_policy: "review-round-only" }),
    ).toThrow(/must be empty/);
  });

  it("reads CON-30's dependabot_carve_out when the file declares one", () => {
    const identities = parseGateIdentities(at, {
      ...minimal,
      dependabot_carve_out: {
        author_pattern: { pattern: "^dependabot(\\[bot\\])?$", ignoreCase: true },
        satisfied_by_context: ["x / audit", "y / review"],
      },
    });
    expect(identities.dependabotCarveOut?.satisfiedByContext).toEqual(["x / audit", "y / review"]);
    expect(identities.dependabotCarveOut?.authorPattern.test("dependabot[bot]")).toBe(true);
    expect(identities.dependabotCarveOut?.authorPattern.test("alice")).toBe(false);
  });

  it("leaves the carve-out NULL when the file declares none -- it is optional", () => {
    // A repository with no dependency bot says nothing and the gate behaves
    // exactly as it always has. `nen schema check` reported `ok` on a file
    // carrying this block long before any build parsed it (zheref/nen#18); this
    // is the other direction of the same compatibility.
    expect(parseGateIdentities(at, minimal).dependabotCarveOut).toBeNull();
  });

  it("REFUSES an EMPTY satisfied_by_context -- it would clear the rounds on no evidence", () => {
    // Same shape and same reasoning as the empty-approver-set refusal above: a
    // carve-out satisfied by NO context is satisfied by nothing at all, so it
    // fires on every pull request that author opens and opens CON-32(b) outright
    // for the one author whose whole premise is that nobody reviews its work.
    expect(() =>
      parseGateIdentities(at, {
        ...minimal,
        dependabot_carve_out: {
          author_pattern: { pattern: "bot", ignoreCase: true },
          satisfied_by_context: [],
        },
      }),
    ).toThrow(/satisfied by no context/);
  });

  it("REFUSES a carve-out with no author_pattern", () => {
    expect(() =>
      parseGateIdentities(at, {
        ...minimal,
        dependabot_carve_out: { satisfied_by_context: ["x / audit"] },
      }),
    ).toThrow(/dependabot_carve_out\.author_pattern/);
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

// ── round_quorum (maintainer ruling 2026-09-29) ─────────────────────────────
//
// "Copilot credits are exhausted. Expect Cursor instead. Let's make it canon on
// the repo so that we solve at least one round of reviews from both Copilot OR
// Cursor (or both) as applicable." The quorum is OPTIONAL and additive; what is
// proved here is that a malformed one is refused AT LOAD, BY POINTER, and never
// reaches a verdict as a rule that silently means something else.
describe("parseGateIdentities -- round_quorum", () => {
  const at = "/fake/nen/gates.json";
  const twoReviewers = {
    version: 1,
    reviewers: [
      { name: "copilot", login_pattern: { pattern: "^copilot$", ignoreCase: true } },
      {
        name: "bugbot",
        login_pattern: { pattern: "^(cursor|bugbot)(\\[bot\\])?$", ignoreCase: true },
        round_check_pattern: { pattern: "^Cursor Bugbot$", ignoreCase: true },
      },
    ],
    approval_policy: "review-round-only",
    default_approvers: [],
    base_reviewers: ["copilot"],
    delivery: {
      author_pattern: { pattern: "^maintainer$", ignoreCase: true },
      head_ref_prefixes: ["codex/"],
    },
  };
  const withQuorum = (quorum: unknown): Record<string, unknown> => ({
    ...twoReviewers,
    round_quorum: quorum,
  });

  /** The refusal a malformed quorum produces -- a SchemaError, never a pass. */
  function refusal(quorum: unknown): SchemaError {
    try {
      parseGateIdentities(at, withQuorum(quorum));
    } catch (error) {
      if (error instanceof SchemaError) return error;
      throw error;
    }
    throw new Error("expected a SchemaError, but the file was accepted");
  }

  it("is null when the file declares none -- the gate is then exactly what it was", () => {
    expect(parseGateIdentities(at, twoReviewers).roundQuorum).toBeNull();
    expect(parseGateIdentities(at, withQuorum(null)).roundQuorum).toBeNull();
  });

  it("reads a valid quorum, in the file's order, with its $comment ignored", () => {
    const identities = parseGateIdentities(
      at,
      withQuorum({ $comment: "why", any_of: ["bugbot", "copilot"], minimum: 1 }),
    );
    expect(identities.roundQuorum).toEqual({ anyOf: ["bugbot", "copilot"], minimum: 1 });
  });

  it("accepts minimum equal to the group's size -- 'all of them' is a legitimate quorum", () => {
    const identities = parseGateIdentities(at, withQuorum({ any_of: ["copilot", "bugbot"], minimum: 2 }));
    expect(identities.roundQuorum?.minimum).toBe(2);
  });

  it("REFUSES a quorum that is not an object", () => {
    expect(refusal(["copilot"]).pointer).toBe("round_quorum");
    expect(refusal("copilot").pointer).toBe("round_quorum");
  });

  it("REFUSES a missing or non-array any_of, by pointer", () => {
    const missing = refusal({ minimum: 1 });
    expect(missing.pointer).toBe("round_quorum.any_of");
    expect(missing.message).toMatch(/is required/);
    expect(refusal({ any_of: "copilot", minimum: 1 }).pointer).toBe("round_quorum.any_of");
  });

  it("REFUSES an EMPTY any_of -- a quorum over nobody has no path out", () => {
    const error = refusal({ any_of: [], minimum: 1 });
    expect(error.pointer).toBe("round_quorum.any_of");
    expect(error.message).toMatch(/is empty/);
  });

  it("REFUSES a member that is not a non-empty string, at that member's pointer", () => {
    expect(refusal({ any_of: ["copilot", 7], minimum: 1 }).pointer).toBe("round_quorum.any_of[1]");
    expect(refusal({ any_of: [""], minimum: 1 }).pointer).toBe("round_quorum.any_of[0]");
  });

  it("REFUSES a member that is not a declared reviewer, naming the declared set", () => {
    const error = refusal({ any_of: ["copilot", "ghost"], minimum: 1 });
    expect(error.pointer).toBe("round_quorum.any_of[1]");
    expect(error.message).toMatch(/'ghost', which is not declared in 'reviewers'/);
    expect(error.message).toMatch(/Declared: copilot, bugbot/);
  });

  it("REFUSES a DUPLICATE member -- one round would count twice toward the minimum", () => {
    const error = refusal({ any_of: ["bugbot", "copilot", "bugbot"], minimum: 2 });
    expect(error.pointer).toBe("round_quorum.any_of[2]");
    expect(error.message).toMatch(/duplicates round_quorum\.any_of\[0\] \('bugbot'\)/);
  });

  it("REFUSES a missing or non-integer minimum -- it is stated, never defaulted", () => {
    for (const minimum of [undefined, null, "1", 1.5, Number.NaN, Number.POSITIVE_INFINITY, true]) {
      const error = refusal({ any_of: ["copilot", "bugbot"], minimum });
      expect(error.pointer).toBe("round_quorum.minimum");
      expect(error.message).toMatch(/must be an integer/);
    }
  });

  it("REFUSES a minimum below 1 -- met by nobody having reviewed", () => {
    for (const minimum of [0, -1]) {
      const error = refusal({ any_of: ["copilot", "bugbot"], minimum });
      expect(error.pointer).toBe("round_quorum.minimum");
      expect(error.message).toMatch(/below 1 is met by nobody having reviewed/);
    }
  });

  it("REFUSES a minimum above the group's size -- met by no set of rounds", () => {
    const error = refusal({ any_of: ["copilot", "bugbot"], minimum: 3 });
    expect(error.pointer).toBe("round_quorum.minimum");
    expect(error.message).toMatch(/names only 2 reviewer\(s\)/);
  });

  it("refuses AT LOAD, so the error names the file as well as the pointer", () => {
    expect(refusal({ any_of: ["ghost"], minimum: 1 }).message).toMatch(
      /^\/fake\/nen\/gates\.json: at round_quorum\.any_of\[0\], /,
    );
  });
});

describe("loadGateIdentities -- THIS repository's own nen/gates.json (ruling 2026-09-29)", () => {
  // vitest's cwd is the repository root (see ./fixtures/paths.ts), so this is
  // the file the maintainer's gate actually reads -- not a fixture of it.
  const own = loadGateIdentities(process.cwd());

  it("declares copilot and bugbot, copilot exempt, base set copilot, rounds-only approval", () => {
    expect(own.reviewers.map((r): string => r.name)).toEqual(["copilot", "bugbot"]);
    expect(own.reviewer("copilot")?.boundedPolicyExempt).toBe(true);
    expect(own.reviewer("bugbot")?.boundedPolicyExempt).toBe(false);
    expect(own.baseReviewers).toEqual(["copilot"]);
    expect(own.approvalPolicy).toBe("review-round-only");
    expect(own.defaultApprovers).toEqual([]);
  });

  it("declares the quorum: at least one of copilot, bugbot", () => {
    expect(own.roundQuorum).toEqual({ anyOf: ["copilot", "bugbot"], minimum: 1 });
  });

  it("matches Cursor Bugbot's BOT logins, anchored -- REST's cursor[bot], GraphQL's cursor, and bugbot[bot]", () => {
    const login = own.reviewer("bugbot")?.loginPattern;
    for (const author of ["cursor", "cursor[bot]", "bugbot[bot]", "Cursor[bot]", "BugBot[bot]"]) {
      expect(login?.test(author), author).toBe(true);
    }
    for (const author of ["cursor-evil", "evilcursor", "cursor[bot]x", "copilot", "", "cursorbugbot"]) {
      expect(login?.test(author), author).toBe(false);
    }
  });

  it("M2: does NOT match the bare 'bugbot' -- a HUMAN GitHub account (User 7030920) on a public repository", () => {
    // `gh api users/bugbot` answers `BugBot`, type User. With the earlier
    // `^(cursor|bugbot)(\[bot\])?$` and ignoreCase, a review that account
    // posted would have been Cursor Bugbot's round.
    const login = own.reviewer("bugbot")?.loginPattern;
    for (const author of ["bugbot", "BugBot", "BUGBOT"]) {
      expect(login?.test(author), author).toBe(false);
    }
  });

  it("keeps copilot's login pattern, and the two never match each other's logins", () => {
    const copilot = own.reviewer("copilot")?.loginPattern;
    const bugbot = own.reviewer("bugbot")?.loginPattern;
    for (const author of ["copilot-pull-request-reviewer[bot]", "copilot-pull-request-reviewer", "Copilot"]) {
      expect(copilot?.test(author)).toBe(true);
      expect(bugbot?.test(author)).toBe(false);
    }
    expect(copilot?.test("cursor[bot]")).toBe(false);
  });

  it("enrols and rounds bugbot on exactly the 'Cursor Bugbot' check, case-insensitively", () => {
    const bugbot = own.reviewer("bugbot");
    for (const pattern of [bugbot?.roundCheckPattern, bugbot?.enrolmentCheckPattern]) {
      expect(pattern?.flags).toBe("i");
      expect(pattern?.test("Cursor Bugbot")).toBe(true);
      expect(pattern?.test("cursor bugbot")).toBe(true);
      expect(pattern?.test("Cursor Bugbot / probe")).toBe(false);
      expect(pattern?.test("Bugbot")).toBe(false);
    }
  });
});

describe("parseGateIdentities -- checks.excluded (zheref/nen#249)", () => {
  const at = "/fake/nen/gates.json";
  const base = {
    version: 1,
    reviewers: [{ name: "a", login_pattern: { pattern: "^a$", ignoreCase: true } }],
    default_approvers: ["a"],
    base_reviewers: ["a"],
    delivery: {
      author_pattern: { pattern: "^bot$", ignoreCase: true },
      head_ref_prefixes: ["x/"],
    },
  };
  const WINDOWS = 'check (Windows, ["self-hosted","Windows","X64"])';
  const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: WINDOWS,
    reason: "no Windows runner exists",
    ruled: "2026-09-22",
    until: { condition: "a Windows runner exists" },
    ...overrides,
  });
  const withExcluded = (...entries: unknown[]): unknown => ({ ...base, checks: { excluded: entries } });

  it("absent, an absent checks.excluded, and an empty list all read as no exclusion", () => {
    expect(parseGateIdentities(at, base).excludedChecks).toEqual([]);
    expect(parseGateIdentities(at, { ...base, checks: {} }).excludedChecks).toEqual([]);
    expect(parseGateIdentities(at, withExcluded()).excludedChecks).toEqual([]);
  });

  it("reads a matrix name WHOLE -- commas, brackets and quotes are part of it -- as exact by default", () => {
    const [only] = parseGateIdentities(at, withExcluded(entry())).excludedChecks ?? [];
    expect(only).toEqual({
      name: WINDOWS,
      match: "exact",
      reason: "no Windows runner exists",
      ruled: "2026-09-22",
      until: { condition: "a Windows runner exists" },
      untilDate: null,
    });
  });

  it("a strict date until is the lapse date; a stated glob with a 3+ character prefix is kept", () => {
    const [only] =
      parseGateIdentities(at, withExcluded(entry({ name: "check (Windows*", match: "glob", until: "2026-12-31" })))
        .excludedChecks ?? [];
    expect(only?.match).toBe("glob");
    expect(only?.until).toBe("2026-12-31");
    expect(only?.untilDate).toBe("2026-12-31");
    expect(() => parseGateIdentities(at, withExcluded(entry({ name: "che*", match: "glob" })))).not.toThrow();
  });

  it("refuses every near-date until spelling, so none can be read as a never-lapsing condition", () => {
    const nearDates = [
      "2026/10/01",
      "2026-10-1",
      "2026-1-01",
      "26-10-01",
      "2026-10-01T00:00:00Z",
      "2026-10-01 ",
      "\uFF12\uFF10\uFF12\uFF16-\uFF11\uFF10-\uFF10\uFF11", // fullwidth digits
      "2026\u201010\u201001", // U+2010 HYPHEN
      "2026\u221210\u221201", // U+2212 MINUS SIGN
      "2026-02-30",
      "a Windows runner exists", // a bare condition string: conditions are { condition }
      "October 1st",
    ];
    for (const until of nearDates) {
      expect(() => parseGateIdentities(at, withExcluded(entry({ until }))), JSON.stringify(until)).toThrow(
        /checks\.excluded\[0\]\.until/,
      );
    }
  });

  it("refuses surrounding whitespace with its own message, on every field", () => {
    for (const field of ["name", "reason", "ruled", "until"]) {
      const padded = field === "ruled" || field === "until" ? " 2026-09-23" : ` x${field}`;
      expect(() => parseGateIdentities(at, withExcluded(entry({ [field]: padded }))), field).toThrow(
        /leading or trailing whitespace/,
      );
    }
    expect(() => parseGateIdentities(at, withExcluded(entry({ until: { condition: "x " } })))).toThrow(
      /until\.condition[\s\S]*leading or trailing whitespace/,
    );
  });

  it("refuses every malformed entry by pointer", () => {
    const refusals: [unknown, RegExp][] = [
      [{ ...base, checks: [] }, /checks/],
      [{ ...base, checks: { excluded: {} } }, /checks\.excluded/],
      [withExcluded("x"), /checks\.excluded\[0\]/],
      [withExcluded(entry({ name: undefined })), /checks\.excluded\[0\]\.name/],
      [withExcluded(entry({ reason: undefined })), /checks\.excluded\[0\]\.reason/],
      [withExcluded(entry({ reason: "  " })), /reason[\s\S]*is blank/],
      [withExcluded(entry({ ruled: undefined })), /\.ruled/],
      [withExcluded(entry({ until: undefined })), /\.until[\s\S]*is required/],
      [withExcluded(entry({ until: 20261001 })), /\.until[\s\S]*is required/],
      [withExcluded(entry({ until: {} })), /\.until\.condition/],
      [withExcluded(entry({ until: { condition: "" } })), /\.until\.condition[\s\S]*non-empty/],
      [withExcluded(entry({ until: { condition: "x", date: "2026-10-01" } })), /\.until[\s\S]*'date'/],
      [withExcluded(entry({ ruled: "22/09/2026" })), /\.ruled[\s\S]*YYYY-MM-DD/],
      [withExcluded(entry({ ruled: "2026-02-30" })), /\.ruled/],
      [withExcluded(entry({ until: "2026-09-21" })), /before ruled/],
      [withExcluded(entry({ name: "check *" })), /\.match[\s\S]*is required because/],
      [withExcluded(entry({ match: "regex" })), /expected 'exact' or 'glob'/],
      [withExcluded(entry(), entry({ reason: "again" })), /checks\.excluded\[1\]\.name[\s\S]*duplicates checks\.excluded\[0\]/],
    ];
    for (const [file, message] of refusals) {
      expect(() => parseGateIdentities(at, file), String(message)).toThrow(SchemaError);
      expect(() => parseGateIdentities(at, file), String(message)).toThrow(message);
    }
  });

  it("refuses a glob whose literal prefix before the first '*' is under 3 characters (Feitan F4)", () => {
    for (const name of ["*", "**", "*)", "*e*", "* *", "?*", "ab*", "a*bcdef"]) {
      expect(() => parseGateIdentities(at, withExcluded(entry({ name, match: "glob" }))), name).toThrow(
        /literal prefix before the first '\*'/,
      );
    }
    expect(() => parseGateIdentities(at, withExcluded(entry({ name: "check (*", match: "glob" })))).not.toThrow();
  });

  it("a literal '*' is admitted when the file says exact, and the same name may be declared once per match", () => {
    const identities = parseGateIdentities(
      at,
      withExcluded(entry({ name: "abc*d", match: "exact" }), entry({ name: "abc*d", match: "glob" })),
    );
    expect(identities.excludedChecks?.map((e): string => e.match)).toEqual(["exact", "glob"]);
  });
});
