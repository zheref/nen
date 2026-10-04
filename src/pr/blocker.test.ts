import { describe, expect, it } from "vitest";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { loadGateIdentities, parseGateIdentities, type GateIdentities } from "../schema/gates.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrSnapshot } from "./fetch.js";
import type { CheckRun, Review } from "../github/types.js";
import { nextBlocker } from "./blocker.js";
import { evaluateReady } from "../gates/ready.js";

const IDENTITIES: GateIdentities = loadGateIdentities(BANKAI_REPO);

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    pr: {
      number: 1,
      headSha: "head1",
      baseRef: "main",
      headRef: "feature/x",
      author: "alice",
      labels: [],
      mergeable: "MERGEABLE",
      isDraft: false,
    },
    title: "t",
    url: "https://x/1",
    body: "## How to verify\n\nrun the thing",
    state: "OPEN",
    mergeStateStatus: "CLEAN",
    checks: [],
    reviews: [],
    reviewRequests: [],
    reviewThreads: [],
    ...overrides,
  };
}

describe("nextBlocker -- the FIRST condition, fixed order, and nothing past it", () => {
  it("a conflicting PR blocks before anything else, even with red checks too", () => {
    const result = nextBlocker(
      IDENTITIES,
      snapshot({ pr: { ...snapshot().pr, mergeable: "CONFLICTING" }, checks: [] }),
    );
    expect(result.kind).toBe("conflict");
  });

  it("a DIRTY mergeStateStatus is also a conflict, even when mergeable itself is UNKNOWN", () => {
    const result = nextBlocker(
      IDENTITIES,
      snapshot({ pr: { ...snapshot().pr, mergeable: "UNKNOWN" }, mergeStateStatus: "DIRTY" }),
    );
    expect(result.kind).toBe("conflict");
  });

  it("no checks at all is a red-check blocker, not a pass-through", () => {
    expect(nextBlocker(IDENTITIES, snapshot({ checks: [] })).kind).toBe("red-check");
  });

  it("a non-green latest check blocks before reviews are even considered", () => {
    const result = nextBlocker(
      IDENTITIES,
      snapshot({
        checks: [{ kind: "check_run", name: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: null, completedAt: null, detailsUrl: null }],
      }),
    );
    expect(result.kind).toBe("red-check");
  });

  it("a draft is a blocker of its own, ahead of the checks (zheref/nen#331)", () => {
    const base = snapshot();
    const result = nextBlocker(IDENTITIES, { ...base, pr: { ...base.pr, isDraft: true } });
    expect(result.kind).toBe("draft");
  });

  it("a head of nothing but SKIPPED checks is a red-check blocker that says nothing ran (zheref/nen#331)", () => {
    const result = nextBlocker(
      IDENTITIES,
      snapshot({
        checks: [{ kind: "check_run", name: "windows", status: "COMPLETED", conclusion: "SKIPPED", startedAt: null, completedAt: null, detailsUrl: null }],
      }),
    );
    expect(result.kind).toBe("red-check");
    expect(result.detail).toContain("no latest check succeeded");
    expect(result.detail).toContain("windows=SKIPPED");
  });

  it("an owed reviewer round blocks once checks are green", () => {
    const checks = [
      { kind: "check_run" as const, name: "ci", status: "COMPLETED" as const, conclusion: "SUCCESS" as const, startedAt: null, completedAt: null, detailsUrl: null },
    ];
    const result = nextBlocker(IDENTITIES, snapshot({ checks, reviews: [] }));
    expect(result.kind).toBe("owed-round");
    expect(result.detail).toMatch(/sasuke/);
  });

  it("an unresolved thread blocks once every reviewer round is satisfied", () => {
    const checks = [
      { kind: "check_run" as const, name: "ci", status: "COMPLETED" as const, conclusion: "SUCCESS" as const, startedAt: null, completedAt: null, detailsUrl: null },
    ];
    const reviews = [
      { author: "sasuke", state: "APPROVED" as const, commitId: "head1", submittedAt: null },
      { author: "tenma", state: "APPROVED" as const, commitId: "head1", submittedAt: null },
    ];
    const result = nextBlocker(
      IDENTITIES,
      snapshot({ checks, reviews, reviewThreads: [{ id: "t1", isResolved: false }] }),
    );
    expect(result.kind).toBe("unresolved-thread");
  });

  it("a missing '## How to verify' section blocks once threads are resolved", () => {
    const checks = [
      { kind: "check_run" as const, name: "ci", status: "COMPLETED" as const, conclusion: "SUCCESS" as const, startedAt: null, completedAt: null, detailsUrl: null },
    ];
    const reviews = [
      { author: "sasuke", state: "APPROVED" as const, commitId: "head1", submittedAt: null },
      { author: "tenma", state: "APPROVED" as const, commitId: "head1", submittedAt: null },
    ];
    const result = nextBlocker(IDENTITIES, snapshot({ checks, reviews, body: "no verify section here" }));
    expect(result.kind).toBe("missing-body-requirement");
  });

  // Review finding #7: an explicitly-empty reviewers override must not be
  // treated as "no reviewers, nothing owed" -- it made this exact snapshot
  // read as kind:"none" instead of the correct owed-round.
  it("an explicitly EMPTY reviewers override falls back to the default set, not to 'nothing owed'", () => {
    const checks = [
      { kind: "check_run" as const, name: "ci", status: "COMPLETED" as const, conclusion: "SUCCESS" as const, startedAt: null, completedAt: null, detailsUrl: null },
    ];
    const result = nextBlocker(IDENTITIES, snapshot({ checks, reviews: [] }), { reviewers: [] });
    expect(result.kind).toBe("owed-round");
    expect(result.detail).toMatch(/sasuke/);
  });

  it("finds no blocker when every condition clears", () => {
    const checks = [
      { kind: "check_run" as const, name: "ci", status: "COMPLETED" as const, conclusion: "SUCCESS" as const, startedAt: null, completedAt: null, detailsUrl: null },
    ];
    const reviews = [
      { author: "sasuke", state: "APPROVED" as const, commitId: "head1", submittedAt: null },
      { author: "tenma", state: "APPROVED" as const, commitId: "head1", submittedAt: null },
    ];
    const result = nextBlocker(IDENTITIES, snapshot({ checks, reviews }));
    expect(result.kind).toBe("none");
  });
});

// ── round_quorum in `nen pr next-blocker` (review of E7, finding H2) ─────────
//
// Before this, nextBlocker() asked only pendingRounds(), so on this
// repository's own nen/gates.json -- copilot `bounded_policy_exempt`, bugbot
// enrolled only by its check -- an unreviewed pull request answered `none`
// while `nen pr ready` refused it on the quorum. These cases read the file the
// maintainer's gate reads (vitest's cwd is the repository root).
describe("nextBlocker -- round_quorum, on this repository's own nen/gates.json (finding H2)", () => {
  const OWN: GateIdentities = loadGateIdentities(process.cwd());
  const green = {
    kind: "check_run" as const,
    name: "build",
    status: "COMPLETED" as const,
    conclusion: "SUCCESS" as const,
    startedAt: null,
    completedAt: null,
    detailsUrl: null,
  };
  const bugbotRun = (conclusion: "SUCCESS" | "NEUTRAL"): CheckRun => ({ ...green, name: "Cursor Bugbot", conclusion });
  const review = (author: string): Review => ({
    author,
    state: "COMMENTED",
    commitId: "old1",
    submittedAt: "2026-09-29T00:00:00Z",
  });

  it("THE REGRESSION: an unreviewed pull request is an owed round on the quorum, not `none`", () => {
    const result = nextBlocker(OWN, snapshot({ checks: [green] }));
    expect(result).toEqual({
      kind: "owed-round",
      detail:
        "round quorum not met (0 of 2 with a round, 1 required, CON-32b): " +
        "copilot (no round), bugbot (no round, no 'Cursor Bugbot' check)" +
        " (head only — `nen pr ready` also reads earlier commits of this PR)",
    });
  });

  // zheref/nen#361 (ruling 2026-10-04): a met quorum fulfils its members'
  // rounds, here as in `pr ready`'s row 4.
  it("#361: Bugbot errored (NEUTRAL, enrolled) plus Copilot's review: no owed-round for the covered member", () => {
    const result = nextBlocker(
      OWN,
      snapshot({ checks: [green, bugbotRun("NEUTRAL")], reviews: [review("copilot-pull-request-reviewer[bot]")] }),
    );
    expect(result.kind).toBe("none");
  });

  it("#361: Copilot requested and silent plus a Bugbot SUCCESS: no owed-round", () => {
    const result = nextBlocker(
      OWN,
      snapshot({
        checks: [green, bugbotRun("SUCCESS")],
        reviewRequests: [{ login: "Copilot", name: null }],
      }),
    );
    expect(result.kind).toBe("none");
    // The request does make Copilot owed: with no other member's round, it is named.
    const unmet = nextBlocker(
      OWN,
      snapshot({ checks: [green], reviewRequests: [{ login: "Copilot", name: null }] }),
    );
    expect(unmet.kind).toBe("owed-round");
    expect(unmet.detail).toMatch(/^copilot \(review-requested-not-yet-posted\) — and round quorum not met/);
  });

  it("#361: a non-member owed is still an owed-round, quorum met or not", () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "nen", "gates.json"), "utf8")) as {
      reviewers: unknown[];
    } & Record<string, unknown>;
    const withOutsider = parseGateIdentities("/fixture/nen/gates.json", {
      ...raw,
      reviewers: [...raw.reviewers, { name: "sasuke", login_pattern: { pattern: "^sasuke$", ignoreCase: true } }],
    });
    const result = nextBlocker(withOutsider, snapshot({ checks: [green, bugbotRun("SUCCESS")] }), {
      reviewers: ["copilot", "bugbot", "sasuke"],
    });
    expect(result).toEqual({ kind: "owed-round", detail: "sasuke (no-round-at-head)" });
  });

  it("Bugbot's review (as cursor[bot]) meets the quorum -- the blocker moves on", () => {
    expect(nextBlocker(OWN, snapshot({ checks: [green], reviews: [review("cursor[bot]")] })).kind).toBe("none");
  });

  it("Copilot's review at an earlier head meets it too, under the default bounded policy", () => {
    expect(
      nextBlocker(OWN, snapshot({ checks: [green], reviews: [review("copilot-pull-request-reviewer[bot]")] })).kind,
    ).toBe("none");
  });

  it("a clean 'Cursor Bugbot' run AT HEAD meets it", () => {
    expect(nextBlocker(OWN, snapshot({ checks: [green, bugbotRun("SUCCESS")] })).kind).toBe("none");
  });

  it("C1: a NEUTRAL (possibly cancelled) run at head is no round -- bugbot is owed, and the quorum clause follows", () => {
    const result = nextBlocker(OWN, snapshot({ checks: [green, bugbotRun("NEUTRAL")] }));
    expect(result.kind).toBe("owed-round");
    expect(result.detail).toBe(
      "bugbot (no-round-at-head) — and round quorum not met (0 of 2 with a round, 1 required, CON-32b): " +
        "copilot (no round), bugbot (no round, 'Cursor Bugbot' check concluded NEUTRAL, not SUCCESS)" +
        " (head only — `nen pr ready` also reads earlier commits of this PR)",
    );
  });

  it("M2: a review by the HUMAN account 'bugbot' is not Cursor Bugbot's round", () => {
    expect(nextBlocker(OWN, snapshot({ checks: [green], reviews: [review("bugbot")] })).kind).toBe("owed-round");
  });

  it("an owed round still leads, with the quorum clause after it -- nothing is hidden", () => {
    const result = nextBlocker(
      OWN,
      snapshot({ checks: [green], reviewRequests: [{ login: "Copilot", name: null }] }),
    );
    expect(result.kind).toBe("owed-round");
    expect(result.detail).toMatch(/^copilot \(review-requested-not-yet-posted\) — and round quorum not met/);
  });

  it("F2 + N2, zheref/nen#279's shape: `pr ready` counts the earlier-head run, next-blocker reads the head and SAYS so", () => {
    // The same facts, handed to both verbs: head 7cee8a5 with no Bugbot run
    // and no review, and Bugbot's SUCCESS run on 2851d2e, which GitHub lists
    // against #279. `pr ready` reads that run (the transport's
    // `earlier_round_checks`); next-blocker's snapshot carries the head only.
    const head = "7cee8a59bb43b3859de705bbdf4ff5eaf278fddc";
    const ready = evaluateReady(
      OWN,
      {
        mergeable: "MERGEABLE",
        head_sha: head,
        checks: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
        reviews: [],
        review_requests: [],
        unresolved_threads: 0,
        reviewers: "copilot",
        round_policy: "bounded",
        earlier_round_checks: [
          { sha: "2851d2ec9cae06fc0d4718a27afd085577014b53", name: "Cursor Bugbot", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      },
      { roundPolicyDefault: "bounded", stallMinutes: 30, now: "2026-09-29T20:00:00Z", excludeCheckNames: [] },
    );
    expect(ready.ready).toBe(true);
    expect(ready.conjuncts.find((row) => row.id === "rounds-owed")?.roundQuorum?.met).toBe(true);

    const blocked = nextBlocker(OWN, snapshot({ pr: { ...snapshot().pr, headSha: head }, checks: [green] }));
    // STRICTER than `pr ready`, never looser -- and the clause names the gap
    // rather than leaving two verbs to disagree silently.
    expect(blocked.kind).toBe("owed-round");
    expect(blocked.detail).toMatch(/ \(head only — `nen pr ready` also reads earlier commits of this PR\)$/);
  });

  it("F2: the head-only note appears ONLY where the verbs can differ", () => {
    // Under STRICT `pr ready` reads the head only too -- nothing to point at.
    const strict = nextBlocker(OWN, snapshot({ checks: [green] }), { policy: "strict" });
    expect(strict.kind).toBe("owed-round");
    expect(strict.detail).not.toContain("head only");
    // A SKIPPED run at head is green, is no round, and is exactly where `pr
    // ready` would look further -- so the note is there. (A run IN FLIGHT at
    // head is excluded too, as `pr ready` lets it supersede history, but this
    // verb never reaches the round step with one: CON-32(a) is red first.)
    const skipped = nextBlocker(OWN, snapshot({ checks: [green, { ...green, name: "Cursor Bugbot", conclusion: "SKIPPED" }] }));
    expect(skipped.kind).toBe("owed-round");
    expect(skipped.detail).toContain("'Cursor Bugbot' check SKIPPED");
    expect(skipped.detail).toMatch(/\(head only — `nen pr ready` also reads earlier commits of this PR\)$/);
    // A met quorum carries no clause at all.
    expect(nextBlocker(OWN, snapshot({ checks: [green, bugbotRun("SUCCESS")] })).kind).toBe("none");
  });

  it("a repository that declares NO quorum is unchanged: the bankai fixture's verdicts do not move", () => {
    const reviews: Review[] = [
      { author: "sasuke-bankai[bot]", state: "APPROVED", commitId: "head1", submittedAt: "2026-09-29T00:00:00Z" },
      { author: "tenma-bankai[bot]", state: "APPROVED", commitId: "head1", submittedAt: "2026-09-29T00:00:00Z" },
    ];
    expect(nextBlocker(IDENTITIES, snapshot({ checks: [green], reviews })).kind).toBe("none");
  });
});

// zheref/nen#249 (Nobunaga N4): the declared exclusions, applied as pr ready
// applies them. The caller hands in the BASE's declarations.
describe("nextBlocker -- declared checks.excluded", () => {
  const WINDOWS = 'check (Windows, ["self-hosted","Windows","X64"])';
  const run = (name: string, conclusion: "SUCCESS" | "FAILURE"): CheckRun => ({
    kind: "check_run",
    name,
    status: "COMPLETED",
    conclusion,
    startedAt: null,
    completedAt: null,
    detailsUrl: null,
  });
  const green = run("ci", "SUCCESS");
  const red = run(WINDOWS, "FAILURE");
  const ruling = {
    name: "check (Windows*",
    match: "glob" as const,
    reason: "no runner",
    ruled: "2026-01-01",
    until: "2026-12-31",
    untilDate: "2026-12-31",
  };
  const NOW = "2026-10-04T00:00:00Z";

  it("drops an honoured excluded check before the red-check step", () => {
    const withExclusion = nextBlocker(IDENTITIES, snapshot({ checks: [green, red] }), {
      declaredExclusions: [ruling],
      now: NOW,
    });
    expect(withExclusion.kind).not.toBe("red-check");
    const without = nextBlocker(IDENTITIES, snapshot({ checks: [green, red] }));
    expect(without.kind).toBe("red-check");
  });

  it("an expired one, or one with no clock, drops nothing", () => {
    expect(
      nextBlocker(IDENTITIES, snapshot({ checks: [green, red] }), { declaredExclusions: [ruling], now: "2027-01-01T00:00:00Z" }).kind,
    ).toBe("red-check");
    expect(nextBlocker(IDENTITIES, snapshot({ checks: [green, red] }), { declaredExclusions: [ruling] }).kind).toBe("red-check");
  });

  it("a rollup holding only excluded checks is still a red-check, named as such", () => {
    const result = nextBlocker(IDENTITIES, snapshot({ checks: [red] }), { declaredExclusions: [ruling], now: NOW });
    expect(result.kind).toBe("red-check");
    expect(result.detail).toMatch(/^no checks remain after the declared exclusion\(s\): check \(Windows/);
  });
});
