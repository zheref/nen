// Tests for ../verbs/pr_ready.ts: ref resolution, identity resolution, the
// `--explain` rendering, the frozen `--json` contract's shape, and the whole
// verb end to end against a STUBBED transport (no gh, no octokit, no
// network -- `deps.openSource` is the one seam this file drives).

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
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
import type { PullRequestSnapshot, ReviewThreadPage } from "../github/graphql.js";
import { ALT_REPO, BANKAI_REPO } from "../schema/fixtures/paths.js";
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
