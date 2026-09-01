// Tests for ../verbs/pr_ready.ts: ref resolution, identity resolution, the
// `--explain` rendering, the frozen `--json` contract's shape, and the whole
// verb end to end against a STUBBED transport (no gh, no octokit, no
// network -- `deps.openSource` is the one seam this file drives).

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTRACT,
  identitiesFromFlags,
  prReady,
  renderExplain,
  resolveIdentities,
  resolveRef,
  RefError,
  IdentityError,
  type Io,
  type PrReadyDeps,
  type PrReadyInput,
  type ReadyReport,
} from "./pr_ready.js";
import type { PrStateSource } from "../github/pr_state.js";
import {
  normalizePullRequestResponse,
  type CheckRollupPage,
  type PullRequestSnapshot,
  type ReviewThreadPage,
} from "../github/graphql.js";
import { ALT_REPO, BANKAI_REPO } from "../schema/fixtures/paths.js";
import { SchemaError } from "../schema/errors.js";
import { GATES_FILE, schemaPath } from "../schema/source.js";

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (line): void => {
        out.push(line);
      },
      err: (line): void => {
        err.push(line);
      },
    },
    out,
    err,
  };
}

// ── resolveRef ───────────────────────────────────────────────────────────────

describe("resolveRef", () => {
  const registry = (): { productCodes: Record<string, string>; consumers: { repo: string; code: string | null }[] } => ({
    productCodes: { KP: "KroApple" },
    consumers: [
      { repo: "zheref/KroApple", code: "KP" },
      { repo: "zheref/KroAndroid", code: "KA" },
    ],
  });

  it("refuses a bare number with no --gh-repo -- guessing the repo is the one shortcut it refuses", () => {
    expect(() => resolveRef("123", undefined, registry)).toThrow(RefError);
  });

  it("resolves a bare number against an explicit --gh-repo", () => {
    const ref = resolveRef("123", "zheref/nen", registry);
    expect(ref).toMatchObject({ owner: "zheref", repo: "nen", number: 123, typed: "123" });
  });

  it("resolves <CODE>#<N> via the registry's consumers, case-insensitively", () => {
    expect(resolveRef("ka#7", undefined, registry)).toMatchObject({
      owner: "zheref",
      repo: "KroAndroid",
      number: 7,
    });
  });

  it("accepts the '#' as optional", () => {
    expect(resolveRef("KP7", undefined, registry)).toMatchObject({ repo: "KroApple", number: 7 });
  });

  it("an explicit --gh-repo WINS over the code and need not agree with it", () => {
    const ref = resolveRef("KP#7", "someone/else", registry);
    expect(ref).toMatchObject({ owner: "someone", repo: "else", number: 7 });
  });

  it("an unknown code is an error that NAMES the known ones", () => {
    expect(() => resolveRef("ZZ#1", undefined, registry)).toThrow(/Known codes: KA, KP/);
  });

  it("a malformed --gh-repo is refused, not silently split", () => {
    expect(() => resolveRef("123", "not-a-slug", registry)).toThrow(/owner\/name/);
  });

  it("not a reference at all (no digits) is refused with the grammar restated", () => {
    expect(() => resolveRef("nonsense-ref!", undefined, registry)).toThrow(/is not a pull-request reference/);
  });
});

// ── resolveIdentities ────────────────────────────────────────────────────────

describe("resolveIdentities", () => {
  it("prefers --gates when given", () => {
    const gatesPath = schemaPath(BANKAI_REPO, GATES_FILE);
    const resolved = resolveIdentities(ALT_REPO, gatesPath, [], []);
    expect(resolved.source).toBe("schema");
    expect(resolved.path).toBe(gatesPath);
    // Proves the FILE, not the repo root, won: ALT_REPO's own gates.json has
    // different names, and this reads BANKAI_REPO's sasuke/tenma instead.
    expect(resolved.identities.defaultApprovers).toEqual(["sasuke", "tenma"]);
  });

  it("falls back to the target repo's schemas/gates.json when there is no --gates", () => {
    const resolved = resolveIdentities(BANKAI_REPO, undefined, [], []);
    expect(resolved.source).toBe("schema");
    expect(resolved.identities.defaultApprovers).toEqual(["sasuke", "tenma"]);
  });

  it("falls back to --reviewers only when the repo carries no gates file", () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-pr-ready-"));
    const resolved = resolveIdentities(empty, undefined, ["alice", "bob"], ["alice"]);
    expect(resolved.source).toBe("flags");
    expect(resolved.path).toBeNull();
    expect(resolved.identities.baseReviewers).toEqual(["alice", "bob"]);
    expect(resolved.identities.defaultApprovers).toEqual(["alice"]);
  });

  it("refuses outright with NO default reviewer set when none of the three sources apply", () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-pr-ready-"));
    expect(() => resolveIdentities(empty, undefined, [], [])).toThrow(IdentityError);
  });

  it("a malformed in-repo schemas/gates.json fails as a path-bearing SchemaError, not a bare SyntaxError", () => {
    // Mirrors ../schema/source.test.ts's "reports malformed JSON as itself"
    // case, but through the --gates-less fallback branch this same function
    // takes -- the branch Copilot's review on PR #9 found reading the file with
    // a raw JSON.parse and no SchemaError shaping (zheref/nen#9, pr_ready.ts:429).
    const root = mkdtempSync(join(tmpdir(), "nen-pr-ready-corrupt-gates-"));
    mkdirSync(join(root, "schemas"));
    const gatesPath = join(root, "schemas", "gates.json");
    writeFileSync(gatesPath, "{ not json");
    try {
      resolveIdentities(root, undefined, [], []);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      const schemaError = error as SchemaError;
      // Path-bearing: names the exact file, not just "a schema".
      expect(schemaError.path).toBe(gatesPath);
      expect(schemaError.message).toContain(gatesPath);
      expect(schemaError.message).toMatch(/not valid JSON/);
    }
  });
});

describe("identitiesFromFlags -- the reduced, conservative identity set", () => {
  it("each reviewer matches only its own login, case-insensitively, with no checks and no carve-outs", () => {
    const identities = identitiesFromFlags(["alice"], ["alice"]);
    const alice = identities.reviewer("alice");
    expect(alice?.loginPattern.test("Alice")).toBe(true);
    expect(alice?.loginPattern.test("bob")).toBe(false);
    expect(alice?.reviewCheckPattern).toBeNull();
    expect(alice?.roundCheckPattern).toBeNull();
    expect(alice?.boundedPolicyExempt).toBe(false);
    expect(alice?.approvesWhenPostedAtHead).toBe(false);
  });

  it("the delivery author pattern matches nothing -- an unconfigured carve-out must never fire", () => {
    const identities = identitiesFromFlags(["alice"], []);
    expect(identities.delivery.authorPattern.test("")).toBe(false);
    expect(identities.delivery.authorPattern.test("roy-bankai[bot]")).toBe(false);
  });

  it("an explicitly empty approver set is honoured as vacuous, not refused", () => {
    // NOTE (zheref/nen#2's review record, finding 1): this is a UNIT-level
    // claim about `identitiesFromFlags` taking `[]` LITERALLY -- it is not, on
    // its own, a claim about what the CLI does when `--approvers` is never
    // typed at all. That distinction used to be lost: `prReady` collapsed an
    // OMITTED `--approvers` into this same `[]` one line before calling this
    // function, which is what made the approve limb silently vacuous on the
    // ordinary `--reviewers` path. See the `prReady`-level describe block
    // "the --reviewers identity path never lets an omitted --approvers empty
    // the approve limb" below for the caller-level fix and its regression
    // test; this function's own contract -- an array it is HANDED is taken at
    // face value -- is unchanged and correct.
    const identities = identitiesFromFlags(["alice"], []);
    expect(identities.defaultApprovers).toEqual([]);
  });
});

// ── renderExplain ────────────────────────────────────────────────────────────

function sampleReport(overrides: Partial<ReadyReport> = {}): ReadyReport {
  return {
    contract: CONTRACT,
    verdict: "not-ready",
    gateLine: "not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)",
    firstFailing: "mergeable",
    conjuncts: [
      { id: "mergeable", order: 1, clause: "CON-42/1", title: "Mergeable", status: "failed", reason: "not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)" },
      { id: "checks-green", order: 2, clause: "CON-32(a)", title: "Every reported check green", status: "unevaluated", reason: null },
    ],
    caveats: [{ id: "addressed-is-approximated", clause: "CON-32(c)", text: "Approximated." }],
    remedy: null,
    meta: {
      ref: "AK#1",
      repo: "zheref/example",
      pr: 1,
      headSha: "deadbeef",
      reviewers: ["sasuke", "tenma"],
      approvers: ["sasuke", "tenma"],
      roundPolicy: "bounded",
      excludeRun: null,
      deliveryPr: false,
      identities: { source: "schema", path: "/repo/schemas/gates.json" },
      warnings: [],
      evaluatedAt: "2025-01-01T00:00:00Z",
      generator: { program: "nen", version: "0.0.0" },
    },
    ...overrides,
  };
}

describe("renderExplain", () => {
  it("renders the gate line, the conjunct table in order, and the fixed caveats", () => {
    const lines = renderExplain(sampleReport());
    const text = lines.join("\n");
    expect(text).toContain("zheref/example#1: not-ready: mergeable=CONFLICTING");
    expect(text).toMatch(/1\s+FAILED\s+CON-42\/1\s+Mergeable/);
    expect(text).toMatch(/2\s+unevaluated\s+CON-32\(a\)/);
    expect(text).toContain("What the gate does NOT decide:");
    expect(text).toContain("CON-32(c): Approximated.");
  });

  it("prints the remedy line only when one is present", () => {
    expect(renderExplain(sampleReport()).join("\n")).not.toContain("What would fix this:");
    expect(renderExplain(sampleReport({ remedy: "mint a token" })).join("\n")).toContain(
      "What would fix this: mint a token",
    );
  });

  it("says the approve row is vacuous when there are no approvers, rather than printing nothing", () => {
    const text = renderExplain(sampleReport({ meta: { ...sampleReport().meta, approvers: [] } })).join("\n");
    expect(text).toContain("approve row is vacuous");
  });
});

// ── the whole verb, end to end, transport stubbed ───────────────────────────

function stubSource(overrides: Partial<PrStateSource> = {}): PrStateSource {
  const snapshot: PullRequestSnapshot = {
    pullRequest: {
      number: 9,
      mergeable: "MERGEABLE",
      isDraft: false,
      headRefOid: "cafebabe",
      headRefName: "feature/x",
      baseRefName: "main",
      author: { login: "someone" },
      labels: [],
      reviewRequests: [],
    },
    defaultBranch: "main",
    checkRollup: [{ name: "ci / build", status: "COMPLETED", conclusion: "SUCCESS" }],
    checkRollupPageInfo: { hasNextPage: false, endCursor: null },
    reviewRequests: [],
  };
  return {
    pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => snapshot,
    reviews: async (): Promise<unknown[]> => [
      { user: { login: "sasuke" }, state: "APPROVED", commit_id: "cafebabe", submitted_at: "2025-01-01T00:00:00Z" },
      { user: { login: "tenma" }, state: "APPROVED", commit_id: "cafebabe", submitted_at: "2025-01-01T00:00:00Z" },
    ],
    reviewThreadsPage: async (): Promise<ReviewThreadPage> => ({ nodes: [], hasNextPage: false, endCursor: null }),
    timeline: async (): Promise<unknown[]> => [],
    checkRollupPage: async (): Promise<CheckRollupPage> => {
      throw new Error("checkRollupPage should not be called when hasNextPage is false");
    },
    ...overrides,
  };
}

function stubDeps(source: PrStateSource | null): PrReadyDeps {
  return {
    now: (): string => "2025-01-01T00:00:00Z",
    openSource: (): { ok: true; source: PrStateSource } | { ok: false; message: string } =>
      source === null ? { ok: false, message: "no usable token" } : { ok: true, source },
  };
}

function input(overrides: Partial<PrReadyInput> = {}): PrReadyInput {
  return {
    positionals: ["pr", "ready", "9"],
    values: { "gh-repo": "zheref/example", gates: schemaPath(BANKAI_REPO, GATES_FILE) },
    booleans: new Set(["json"]),
    repoFlag: null,
    ...overrides,
  };
}

describe("prReady -- usage errors (exit 2, never a verdict)", () => {
  it("an unknown 'pr' subcommand", async () => {
    const { io, err } = capture();
    const code = await prReady(input({ positionals: ["pr", "list"] }), io, stubDeps(null));
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/unknown 'pr' subcommand/);
  });

  it("a missing ref", async () => {
    const { io } = capture();
    expect(await prReady(input({ positionals: ["pr", "ready"] }), io, stubDeps(null))).toBe(2);
  });

  it("an invalid --round-policy", async () => {
    const { io } = capture();
    const code = await prReady(
      input({ values: { ...input().values, "round-policy": "lax" } }),
      io,
      stubDeps(null),
    );
    expect(code).toBe(2);
  });

  it("a non-numeric --exclude-run", async () => {
    const { io } = capture();
    const code = await prReady(
      input({ values: { ...input().values, "exclude-run": "abc" } }),
      io,
      stubDeps(null),
    );
    expect(code).toBe(2);
  });

  it("a ref/identity error (caught internally) is a usage error, not a verdict", async () => {
    const { io, out } = capture();
    // Bare "9" with no --gh-repo in values.
    const code = await prReady(
      input({ values: { gates: schemaPath(BANKAI_REPO, GATES_FILE) } }),
      io,
      stubDeps(null),
    );
    expect(code).toBe(2);
    expect(out).toEqual([]); // no --json verdict was ever printed
  });
});

describe("prReady -- unevaluated is never mistaken for a verdict", () => {
  it("no usable token -> verdict 'unevaluated', exit 1, remedy present", async () => {
    const { io, out } = capture();
    const code = await prReady(input(), io, stubDeps(null));
    expect(code).toBe(1);
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.verdict).toBe("unevaluated");
    expect(report.remedy).not.toBeNull();
    // NOT ONE conjunct row is `ready` on an unevaluated verdict.
    expect(report.conjuncts.every((c): boolean => c.status !== "ready")).toBe(true);
  });

  it("fetchPrState throwing -> 'unevaluated', with the token-grants remedy", async () => {
    const { io, out } = capture();
    const throwing = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => {
        throw new Error("ECONNRESET");
      },
    });
    const code = await prReady(input(), io, stubDeps(throwing));
    expect(code).toBe(1);
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.verdict).toBe("unevaluated");
    expect(report.gateLine).toContain("ECONNRESET");
  });

  it("fetchPrState's own ok:false (a blanked PR node) -> 'unevaluated', passing its reason/remedy through", async () => {
    const { io, out } = capture();
    const blanked = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => ({
        pullRequest: undefined,
        defaultBranch: undefined,
        checkRollup: undefined,
        checkRollupPageInfo: { hasNextPage: undefined, endCursor: undefined },
        reviewRequests: undefined,
      }),
    });
    const code = await prReady(input(), io, stubDeps(blanked));
    expect(code).toBe(1);
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.verdict).toBe("unevaluated");
    expect(report.remedy).toContain("private repository");
  });
});

// zheref/nen#14's fact-check, FINDING 1: the shadow window's real disagreement
// on zheref/akatsuki-ai#33 -- the oracle answered
// "not-ready: NO checks reported at head (CON-32a)" (an EMPTY, READABLE
// rollup) and nen answered "unevaluated: the check rollup came back empty or
// unreadable" (conflating that with the genuinely UNREADABLE case). These two
// tests drive the WHOLE live transport path -- a raw PULL_REQUEST_QUERY-shaped
// response through ../github/graphql.ts's normalizePullRequestResponse(),
// exactly as ../github/client.ts hands it to fetchPrState() -- rather than a
// hand-built PullRequestSnapshot that would skip the normalizer this bug lived
// in. Every other conjunct is held fixed and satisfied (mergeable, both
// approvers posted at head, zero unresolved threads) so checks-green is the
// ONLY thing either case is testing.
describe("prReady -- the checks-rollup distinction (zheref/nen#14, empty vs. unreadable)", () => {
  function rawResponse(commits: unknown): unknown {
    return {
      repository: {
        defaultBranchRef: { name: "main" },
        pullRequest: {
          number: 9,
          mergeable: "MERGEABLE",
          isDraft: false,
          headRefOid: "cafebabe",
          headRefName: "feature/x",
          baseRefName: "main",
          author: { login: "someone" },
          labels: { nodes: [] },
          reviewRequests: { nodes: [] },
          statusCheckRollup: { nodes: commits },
        },
      },
    };
  }

  function sourceFor(commits: unknown): PrStateSource {
    return stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> =>
        normalizePullRequestResponse(rawResponse(commits)),
    });
  }

  it("a head commit whose OWN statusCheckRollup is null -- readable, empty -- is not-ready with the shell's byte-identical reason, never unevaluated", async () => {
    const { io, out } = capture();
    const source = sourceFor([{ commit: { statusCheckRollup: null } }]);
    const code = await prReady(input(), io, stubDeps(source));
    expect(code).toBe(1); // not-ready still exits 1; only `verdict` distinguishes it from unevaluated
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.verdict).toBe("not-ready");
    expect(report.gateLine).toBe(
      "not-ready: NO checks reported at head (CON-32a) — an EMPTY rollup, not a red one. Either " +
        "CI has not started yet, or its run concluded startup_failure and no check will ever " +
        "attach. Tell them apart with: gh run list --branch <head-branch> --limit 5 --json " +
        "conclusion,path,headSha",
    );
  });

  it("a head commit that cannot be resolved at all is unevaluated, never a manufactured not-ready", async () => {
    const { io, out } = capture();
    // No `commit` object on the node at all -- the shape a partial-data blank
    // or an unrecognised response produces, distinct from a commit that
    // resolved and answered `null` for its own field.
    const source = sourceFor([{}]);
    const code = await prReady(input(), io, stubDeps(source));
    expect(code).toBe(1);
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.verdict).toBe("unevaluated");
    expect(report.gateLine).toContain("the check rollup could not be read");
    expect(report.conjuncts.every((c): boolean => c.status !== "ready")).toBe(true);
  });
});

// THE FALSE-GREEN DEFECT, PINNED (zheref/nen#14's fact-check, verified live
// against zheref/bankai-core#927). `contexts(first:100)` never paginated:
// #927's rollup has totalCount 114 with hasNextPage true, and the only
// failing entry ('sasuke / audit') sits at position 101+, so this verb
// answered `ready` on a truncated, all-green-SO-FAR view while
// scripts/pr_ready_gate.sh -- whose `gh pr view --json statusCheckRollup`
// paginates the identical connection inside gh's own client -- answered
// `not-ready: required checks reported but are not all green (CON-32a)`.
// These two tests drive the whole verb end to end (not just fetchPrState's
// raw state, which ../github/pr_state.test.ts already pins) with a SMALLER
// stubbed two-page rollup: the failure on page two, and a page-two FETCH
// FAILURE, so both "the truncation is fixed" and "a partial read never reads
// as ready" are proved at the level a reader actually consumes.
describe("prReady -- check-rollup pagination (zheref/nen#14's fact-check, zheref/bankai-core#927)", () => {
  function pagedSnapshot(): PullRequestSnapshot {
    return {
      pullRequest: {
        number: 9,
        mergeable: "MERGEABLE",
        isDraft: false,
        headRefOid: "cafebabe",
        headRefName: "feature/x",
        baseRefName: "main",
        author: { login: "someone" },
        labels: [],
        reviewRequests: [],
      },
      defaultBranch: "main",
      // Page ONE: a single green entry, but hasNextPage:true -- exactly
      // #927's shape, scaled down from 100+114 entries to 1+1.
      checkRollup: [{ name: "kisuke / probe", status: "COMPLETED", conclusion: "SUCCESS" }],
      checkRollupPageInfo: { hasNextPage: true, endCursor: "cursor-2" },
      reviewRequests: [],
    };
  }

  it("THE PIN: a rollup spanning two pages, with the FAILING entry on page two, is not-ready -- byte-identical to the oracle's own reason, never a false green", async () => {
    const source = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => pagedSnapshot(),
      checkRollupPage: async (): Promise<CheckRollupPage> => ({
        nodes: [{ name: "sasuke / audit", status: "COMPLETED", conclusion: "FAILURE" }],
        hasNextPage: false,
        endCursor: null,
      }),
    });
    const { io, out } = capture();
    const code = await prReady(input(), io, stubDeps(source));
    expect(code).toBe(1);
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.verdict).toBe("not-ready");
    expect(report.firstFailing).toBe("checks-green");
    // The oracle's OWN reason string (scripts/pr_ready_gate.sh's
    // `evaluate_ready`), quoted verbatim -- this is the CON-32(a) branch the
    // shell reaches once the failing entry is actually visible to it.
    expect(report.gateLine).toBe("not-ready: required checks reported but are not all green (CON-32a)");
  });

  it("a FETCH FAILURE on page two is unevaluated, NEVER a partial ready -- the entry never seen cannot be weighed as green", async () => {
    const source = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => pagedSnapshot(),
      checkRollupPage: async (): Promise<CheckRollupPage> => {
        throw new Error("checks:read grant missing");
      },
    });
    const { io, out } = capture();
    const code = await prReady(input(), io, stubDeps(source));
    expect(code).toBe(1);
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.verdict).toBe("unevaluated");
    expect(report.conjuncts.every((c): boolean => c.status !== "ready")).toBe(true);
  });
});

// BLOCKER regression (zheref/nen#2's review record, finding 1): on the
// `--reviewers` identity path -- the ordinary way this verb runs today, since
// no repository ships `schemas/gates.json` yet -- an OMITTED `--approvers`
// used to be indistinguishable from an explicitly empty one, both collapsing
// to `defaultApprovers: []` one line before `identitiesFromFlags` was ever
// reached. That made CON-32(b)'s approve limb VACUOUSLY TRUE and returned
// `ready` on a pull request the shell gate -- and nen's own schema-file
// identity path -- both call not-ready. Proved here at the `prReady` level
// (not `identitiesFromFlags`'s own unit level, which cannot see the call-site
// collapse), against a stubbed transport with two COMMENTED-not-APPROVED
// rounds at head, matching the reviewer's own reproduction exactly.
describe("prReady -- the --reviewers identity path never lets an omitted --approvers empty the approve limb", () => {
  it("--reviewers sasuke,tenma with NO --approvers cannot return exit 0 on a PR neither has approved", async () => {
    const emptyRepo = mkdtempSync(join(tmpdir(), "nen-pr-ready-flags-"));
    const commentedNotApproved = stubSource({
      reviews: async (): Promise<unknown[]> => [
        { user: { login: "sasuke" }, state: "COMMENTED", commit_id: "cafebabe", submitted_at: "2025-01-01T00:00:00Z" },
        { user: { login: "tenma" }, state: "COMMENTED", commit_id: "cafebabe", submitted_at: "2025-01-01T00:00:00Z" },
      ],
    });
    const { io, out } = capture();
    const code = await prReady(
      input({
        values: { "gh-repo": "zheref/example", reviewers: "sasuke,tenma" },
        repoFlag: emptyRepo,
      }),
      io,
      stubDeps(commentedNotApproved),
    );
    expect(code).toBe(1);
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.verdict).toBe("not-ready");
    expect(report.meta.identities.source).toBe("flags");
    // The omitted flag defaulted to the FULL reviewer set -- the conservative
    // reading, "every named reviewer must approve" -- never to `[]`.
    expect(report.meta.approvers).toEqual(["sasuke", "tenma"]);
    expect(report.gateLine).toContain("sasuke (no APPROVE at the current head)");
    expect(report.gateLine).toContain("tenma (no APPROVE at the current head)");
  });

  it("an EXPLICIT --approvers '' is still honoured as vacuous -- the escape hatch survives the fix", async () => {
    const emptyRepo = mkdtempSync(join(tmpdir(), "nen-pr-ready-flags-"));
    const commentedNotApproved = stubSource({
      reviews: async (): Promise<unknown[]> => [
        { user: { login: "sasuke" }, state: "COMMENTED", commit_id: "cafebabe", submitted_at: "2025-01-01T00:00:00Z" },
        { user: { login: "tenma" }, state: "COMMENTED", commit_id: "cafebabe", submitted_at: "2025-01-01T00:00:00Z" },
      ],
    });
    const { io, out } = capture();
    const code = await prReady(
      input({
        values: { "gh-repo": "zheref/example", reviewers: "sasuke,tenma", approvers: "" },
        repoFlag: emptyRepo,
      }),
      io,
      stubDeps(commentedNotApproved),
    );
    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.verdict).toBe("ready");
    expect(report.meta.approvers).toEqual([]);
  });
});

// MINOR fix (zheref/nen#2's review record, finding 7): `--approvers` is READ
// only on the flags identity branch; whenever a gates FILE resolved instead
// (as `input()`'s default `--gates` fixture does), the flag was silently
// dropped on the floor with no diagnostic, and `unevaluatedReport` published
// the raw, unused flag value as `meta.approvers` -- a different answer to "who
// are the approvers" depending on which branch produced the report.
describe("prReady -- --approvers is diagnosed, never silently dropped, when identities come from a schema", () => {
  it("warns in meta.warnings when --approvers is passed but the gates FILE decides identities", async () => {
    const { io, out } = capture();
    const code = await prReady(
      input({ values: { ...input().values, approvers: "someone-the-file-never-heard-of" } }),
      io,
      stubDeps(stubSource()),
    );
    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.meta.identities.source).toBe("schema");
    expect(report.meta.warnings.some((w): boolean => w.includes("--approvers is read only"))).toBe(
      true,
    );
    // The FILE's own approvers decided -- the flag never touched the verdict.
    expect(report.meta.approvers).toEqual(["sasuke", "tenma"]);
  });

  it("does not warn when --approvers is simply absent on the schema path", async () => {
    const { io, out } = capture();
    await prReady(input(), io, stubDeps(stubSource()));
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.meta.warnings.some((w): boolean => w.includes("--approvers"))).toBe(false);
  });

  it("an UNEVALUATED report on the schema path states the FILE's own reviewers/approvers, not a raw flag", async () => {
    const { io, out } = capture();
    const code = await prReady(
      input({
        values: {
          ...input().values,
          reviewers: "nobody-the-file-declares",
          approvers: "nobody-the-file-declares-either",
        },
      }),
      io,
      stubDeps(null), // no usable token -> unevaluated, before any evaluation.context exists
    );
    expect(code).toBe(1);
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.verdict).toBe("unevaluated");
    expect(report.meta.identities.source).toBe("schema");
    expect(report.meta.reviewers).toEqual(["sasuke", "tenma", "copilot"]);
    expect(report.meta.approvers).toEqual(["sasuke", "tenma"]);
  });
});

describe("prReady -- the happy path and the frozen --json contract", () => {
  it("a fully-passing PR is 'ready', exit 0, and the JSON matches the frozen v0.1 shape", async () => {
    const { io, out } = capture();
    const code = await prReady(input(), io, stubDeps(stubSource()));
    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.contract).toBe(CONTRACT);
    expect(report.verdict).toBe("ready");
    expect(report.gateLine).toBe("ready");
    expect(report.firstFailing).toBeNull();
    expect(report.conjuncts).toHaveLength(6);
    expect(report.conjuncts.every((c): boolean => c.status === "ready")).toBe(true);
    expect(report.caveats.length).toBe(3);
    expect(report.meta.repo).toBe("zheref/example");
    expect(report.meta.pr).toBe(9);
    expect(report.meta.headSha).toBe("cafebabe");
    expect(report.meta.identities.source).toBe("schema");
  });

  // PORT ADDITION (zheref/nen#2's review record, finding 9): `contract` and the
  // six-row conjunct table (`clause`, `title`) are published, FROZEN v0.1
  // strings -- pr_ready.ts's own header makes them the first thing a consumer
  // reads and the thing it refuses on -- but nothing pinned the LITERALS
  // before this: `expect(report.contract).toBe(CONTRACT)` above compares the
  // symbol to itself and moves with any edit, and no test wrote the six rows
  // down. Mutating any one of them left the whole suite green.
  it("pins the frozen v0.1 contract string and the six-row conjunct table as LITERALS", async () => {
    const { io, out } = capture();
    const code = await prReady(input(), io, stubDeps(stubSource()));
    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.contract).toBe("nen.pr.ready/v0.1");
    expect(
      report.conjuncts.map(({ id, order, clause, title }) => ({ id, order, clause, title })),
    ).toEqual([
      { id: "mergeable", order: 1, clause: "CON-42/1", title: "Mergeable" },
      {
        id: "checks-green",
        order: 2,
        clause: "CON-32(a)",
        title: "Every reported check green, on the latest run per check name",
      },
      {
        id: "round-stalled",
        order: 3,
        clause: "CON-32(b)",
        title: "No configured reviewer's requested round has stalled",
      },
      {
        id: "rounds-owed",
        order: 4,
        clause: "CON-32(b)",
        title: "No configured reviewer's round owed at the current head",
      },
      {
        id: "approvals-at-head",
        order: 5,
        clause: "CON-32(b)/CON-16",
        title: "Every approving reviewer's latest round is an APPROVE at the current head",
      },
      { id: "unresolved-threads", order: 6, clause: "CON-32(d)", title: "Zero unresolved review threads" },
    ]);
  });

  it("--json wins over --explain -- a human table never lands on a program's stdout", async () => {
    const { io, out } = capture();
    await prReady(input({ booleans: new Set(["json", "explain"]) }), io, stubDeps(stubSource()));
    expect(() => JSON.parse(out.join("\n"))).not.toThrow();
  });

  it("without --json, --explain renders the human table", async () => {
    const { io, out } = capture();
    await prReady(input({ booleans: new Set(["explain"]) }), io, stubDeps(stubSource()));
    expect(out.join("\n")).toContain("zheref/example#9: ready");
    expect(out.join("\n")).toContain("What the gate does NOT decide:");
  });

  it("the plain default is the gate's own quotable line, repo-prefixed", async () => {
    const { io, out } = capture();
    await prReady(input({ booleans: new Set() }), io, stubDeps(stubSource()));
    expect(out).toEqual(["zheref/example#9: ready"]);
  });

  it("a not-ready PR exits 1 and quotes the FIRST failing conjunct's reason verbatim", async () => {
    const notReady = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => ({
        pullRequest: {
          number: 9,
          mergeable: "CONFLICTING",
          isDraft: false,
          headRefOid: "cafebabe",
          headRefName: "feature/x",
          baseRefName: "main",
          author: { login: "someone" },
          labels: [],
          reviewRequests: [],
        },
        defaultBranch: "main",
        checkRollup: [{ name: "ci / build", status: "COMPLETED", conclusion: "SUCCESS" }],
        checkRollupPageInfo: { hasNextPage: false, endCursor: null },
        reviewRequests: [],
      }),
    });
    const { io, out } = capture();
    const code = await prReady(input(), io, stubDeps(notReady));
    expect(code).toBe(1);
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.verdict).toBe("not-ready");
    expect(report.firstFailing).toBe("mergeable");
    expect(report.gateLine).toContain("mergeable=CONFLICTING");
  });
});
