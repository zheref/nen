// Tests for ../verbs/pr_ready.ts: ref resolution, identity resolution, the
// `--explain` rendering, the frozen `--json` contract's shape, and the whole
// verb end to end against a STUBBED transport (no gh, no octokit, no
// network -- `deps.openSource` is the one seam this file drives).

import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  type ReviewRequestsPage,
  type ReviewThreadPage,
} from "../github/graphql.js";
import { ALT_REPO, BANKAI_REPO } from "../schema/fixtures/paths.js";
import { PROGRAM, VERSION } from "../version.js";
import { SchemaError } from "../schema/errors.js";
import { GATES_FILE, schemaPath } from "../schema/source.js";
import { loadRepoRegistry } from "../schema/repos.js";

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
      // zheref/nen#26's own repro code, so the regression cases below read
      // exactly as the issue states them.
      { repo: "zheref/bankai-core", code: "BC" },
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

  // ── zheref/nen#26: the no-# shorthand for MULTI-digit numbers ──────────────
  //
  // One greedy regex with an optional '#' used to hand the digit group exactly
  // ONE trailing digit, so 'BC925' read as code 'BC92' + number '5' and the
  // shorthand only worked below PR #10. The rule now is: the number is the
  // LONGEST trailing run of digits, always.

  it("no-# shorthand, single digit: BC9 splits as code BC + number 9 (the case that always worked)", () => {
    expect(resolveRef("BC9", undefined, registry)).toMatchObject({
      owner: "zheref",
      repo: "bankai-core",
      number: 9,
    });
  });

  it("no-# shorthand, multi-digit: BC925 splits as code BC + number 925, never BC92 + 5 (zheref/nen#26's exact repro)", () => {
    expect(resolveRef("BC925", undefined, registry)).toMatchObject({
      owner: "zheref",
      repo: "bankai-core",
      number: 925,
    });
  });

  it("the '#'-present form BC#925 is unchanged -- it stays the unambiguous spelling", () => {
    expect(resolveRef("BC#925", undefined, registry)).toMatchObject({
      owner: "zheref",
      repo: "bankai-core",
      number: 925,
    });
  });

  it("an unresolvable no-# token's refusal states the split it applied and points at the '#' form", () => {
    try {
      resolveRef("ZZ925", undefined, registry);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RefError);
      const message = (error as RefError).message;
      // Still the honest registry half...
      expect(message).toMatch(/'ZZ' is not a product code/);
      // ...plus the half that stops the misdirection: how the token was split,
      // and the unambiguous spelling to reach for.
      expect(message).toMatch(/longest trailing digit run/);
      expect(message).toMatch(/code 'ZZ' \+ number 925/);
      expect(message).toMatch(/<CODE>#<N> is the unambiguous form/);
    }
  });

  it("an unresolvable '#'-present token's refusal carries NO shorthand hint -- no split was guessed", () => {
    try {
      resolveRef("ZZ#925", undefined, registry);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RefError);
      const message = (error as RefError).message;
      expect(message).toMatch(/'ZZ' is not a product code/);
      expect(message).not.toMatch(/longest trailing digit run/);
    }
  });

  it("an explicit --gh-repo WINS over the code and need not agree with it", () => {
    const ref = resolveRef("KP#7", "someone/else", registry);
    expect(ref).toMatchObject({ owner: "someone", repo: "else", number: 7 });
  });

  // zheref/nen#72's own review: --gh-repo bypasses the registry lookup
  // entirely (the `explicit !== null` early return above), but it still goes
  // through the SAME shorthand split as the registry path -- so the #26 bug
  // (one greedy regex handing the digit group exactly one trailing digit) was
  // reachable here too: a caller naming an unregistered code with --gh-repo
  // and a no-'#' multi-digit number would have gotten 'ZZ92' + 5 instead of
  // 'ZZ' + 925. This never depends on 'ZZ' resolving through the registry.
  it("an explicit --gh-repo bypasses the registry but still uses the longest-trailing-digit-run split (no-# multi-digit)", () => {
    const ref = resolveRef("ZZ925", "someone/else", registry);
    expect(ref).toMatchObject({ owner: "someone", repo: "else", number: 925 });
  });

  it("an unknown code is an error that NAMES the known ones", () => {
    expect(() => resolveRef("ZZ#1", undefined, registry)).toThrow(/Known codes: BC, KA, KP/);
  });

  // zheref/nen#17: against a REAL loaded registry -- the bankai fixture's
  // product_codes nests a `$comment`, the same shape the live bankai-core file
  // carries -- the "Known codes:" roster this refusal builds from
  // `Object.keys(loaded.productCodes)` must list only the real codes.
  it("'Known codes:' never lists a nested $comment, against a REAL loaded registry (zheref/nen#17)", () => {
    const loaded = loadRepoRegistry(BANKAI_REPO);
    try {
      resolveRef("ZZ#1", undefined, () => loaded);
      expect.unreachable("ZZ is not a code in the bankai fixture");
    } catch (error) {
      expect(error).toBeInstanceOf(RefError);
      const message = (error as RefError).message;
      expect(message).toMatch(/Known codes: BC, BS, KC, KN, KP, KW\./);
      expect(message).not.toContain("$comment");
    }
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

  it("falls back to the target repo's nen/gates.json when there is no --gates", () => {
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

  // ── the schemas/ fallback's removal: a legacy-only gates.json is ABSENT ────
  //
  // Through v0.4.0 a `schemas/gates.json` with no `nen/gates.json` beside it
  // still answered this read, through ../schema/source.ts's fallback. That
  // fallback is gone: `resolveSchemaFile` never resolves to the legacy path
  // any more, so this repository is now the SAME as one carrying no gates
  // file at all -- `--reviewers` must still win, and the closing refusal
  // (when neither is given) must name the migration.
  function legacyOnlyRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "nen-pr-ready-legacy-"));
    mkdirSync(join(root, "schemas"), { recursive: true });
    writeFileSync(
      join(root, "schemas", "gates.json"),
      readFileSync(schemaPath(BANKAI_REPO, GATES_FILE), "utf8"),
    );
    return root;
  }

  it("falls through to --reviewers for a repo carrying ONLY the legacy schemas/gates.json", () => {
    const root = legacyOnlyRepo();
    const resolved = resolveIdentities(root, undefined, ["alice", "bob"], ["alice"]);
    expect(resolved.source).toBe("flags");
    expect(resolved.path).toBeNull();
    expect(resolved.identities.baseReviewers).toEqual(["alice", "bob"]);
  });

  it("names the legacy copy and the migration when NEITHER --reviewers nor nen/gates.json is given", () => {
    const root = legacyOnlyRepo();
    try {
      resolveIdentities(root, undefined, [], []);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(IdentityError);
      const message = (error as IdentityError).message;
      expect(message).toContain("schemas/gates.json");
      expect(message).toContain("nen scaffold init --accept-detected");
      expect(message).toContain("v0.5.0");
    }
  });

  // ── zheref/nen#8 item 4: WHICH FILE a relative `--gates` names ─────────────
  //
  // `readFileSync(gatesFlag)` inherits `process.cwd()`, so
  // `--repo ../other --gates nen/gates.json` read the CURRENT directory's
  // file, judged the OTHER repository's pull request against those reviewers,
  // and reported a verdict -- with `meta.identities.path` printing the bare
  // relative string, so nothing on screen said which file had been read. The
  // rule is now stated: relative resolves against the --repo ROOT, absolute is
  // used as-is, and the RESOLVED path is what gets reported.
  //
  // Every case below is OS-neutral: the paths are built with join()/resolve()
  // and never spelled with a literal separator.

  it("resolves a RELATIVE --gates against the --repo root, never against the cwd", () => {
    // The exact shape of the defect: two directories that each carry a
    // nen/gates.json, with the process standing in the wrong one.
    const decoy = mkdtempSync(join(tmpdir(), "nen-gates-decoy-"));
    mkdirSync(join(decoy, "nen"));
    writeFileSync(
      join(decoy, "nen", "gates.json"),
      JSON.stringify({
        version: 1,
        reviewers: [{ name: "decoy", login_pattern: { pattern: "decoy", ignoreCase: true } }],
        default_approvers: ["decoy"],
        base_reviewers: ["decoy"],
        delivery: {
          author_pattern: { pattern: "decoy-bot", ignoreCase: true },
          head_ref_prefixes: ["decoy/"],
        },
      }),
    );
    const previous = process.cwd();
    try {
      process.chdir(decoy);
      const resolved = resolveIdentities(BANKAI_REPO, join("nen", "gates.json"), [], []);
      // The TARGET repository's reviewers, not the decoy's -- this is the whole
      // finding. Before the fix this read ["decoy"].
      expect(resolved.identities.defaultApprovers).toEqual(["sasuke", "tenma"]);
      // ...and the reported path is the RESOLVED one, so --explain and --json
      // can show a reader which file the verdict came from.
      expect(resolved.path).toBe(schemaPath(BANKAI_REPO, GATES_FILE));
    } finally {
      process.chdir(previous);
    }
  });

  it("uses an ABSOLUTE --gates as-is, so a file in neither repository still works", () => {
    // `--gates` exists so the shadow window can point at a gates file that
    // lives outside the target repo; anchoring an absolute path to --repo would
    // be a different defect.
    const previous = process.cwd();
    try {
      process.chdir(tmpdir());
      const gatesPath = schemaPath(BANKAI_REPO, GATES_FILE);
      const resolved = resolveIdentities(ALT_REPO, gatesPath, [], []);
      expect(resolved.path).toBe(gatesPath);
      expect(resolved.identities.defaultApprovers).toEqual(["sasuke", "tenma"]);
    } finally {
      process.chdir(previous);
    }
  });

  it("refuses a --gates that does not exist with THIS codebase's own message, not a raw ENOENT", () => {
    try {
      resolveIdentities(BANKAI_REPO, join("nen", "typo.json"), [], []);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      const schemaError = error as SchemaError;
      // The RESOLVED path, the root it was resolved against, and the two ways
      // out -- everything needed to fix it without reading the source.
      expect(schemaError.path).toBe(schemaPath(BANKAI_REPO, "nen/typo.json"));
      expect(schemaError.message).toContain(BANKAI_REPO);
      expect(schemaError.message).toMatch(/no such file/);
      expect(schemaError.message).toMatch(/RELATIVE/);
      expect(schemaError.message).toMatch(/absolute path/);
      expect(schemaError.message).toMatch(/relative to the repository root/);
      // The raw Node string is what this replaces.
      expect(schemaError.message).not.toMatch(/ENOENT/);
    }
  });

  it("an absent ABSOLUTE --gates is refused too, without claiming a resolution it did not do", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "nen-gates-missing-")), "nowhere.json");
    try {
      resolveIdentities(BANKAI_REPO, missing, [], []);
      expect.unreachable();
    } catch (error) {
      const schemaError = error as SchemaError;
      expect(schemaError.message).toMatch(/no such file/);
      // It was absolute, so the message must NOT tell the caller it anchored
      // the path to the repo root -- that would be a false explanation.
      expect(schemaError.message).not.toMatch(/RELATIVE/);
    }
  });

  it("refuses a --gates that resolves to a DIRECTORY rather than reading it as a file", () => {
    try {
      resolveIdentities(BANKAI_REPO, "nen", [], []);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      expect((error as SchemaError).message).toMatch(/found a directory/);
    }
  });

  it("refuses an EMPTY --gates by naming the flag, not the directory the empty string resolves to", () => {
    // zheref/nen#8 review, minor 5. `--gates ""` resolves to the repository
    // ROOT, so the directory guard above caught it -- and answered "expected a
    // file, found a directory" about a path the operator never typed. A true
    // sentence about a path this function invented, saying nothing about what
    // actually went wrong. The flag is the thing they can see in their own
    // command line, so the flag is what the message names.
    for (const empty of ["", "   "]) {
      try {
        resolveIdentities(BANKAI_REPO, empty, [], []);
        expect.unreachable();
      } catch (error) {
        expect(error, JSON.stringify(empty)).toBeInstanceOf(IdentityError);
        const message = (error as IdentityError).message;
        expect(message).toMatch(/--gates was given an empty path/);
        // The refusal that used to happen, and must not any more.
        expect(message).not.toMatch(/found a directory/);
        expect(message).not.toContain(BANKAI_REPO);
      }
    }
  });

  it("a file that exists but cannot be OPENED is still a path-bearing error, not a raw errno", () => {
    // The residue the existence and directory guards cannot cover: a permission
    // failure, a dangling symlink, a file that vanished between check and read.
    // Every one of those used to leave as the same bare Node string the
    // existence guard exists to stop, so they all leave through one error now.
    // chmod is skipped where it is not meaningful (a root test runner, or a
    // filesystem that does not enforce the bit) rather than asserted into a
    // platform-dependent failure.
    const root = mkdtempSync(join(tmpdir(), "nen-gates-unreadable-"));
    const gatesPath = join(root, "locked.json");
    writeFileSync(gatesPath, "{}");
    chmodSync(gatesPath, 0o000);
    let readable = true;
    try {
      readFileSync(gatesPath, "utf8");
    } catch {
      readable = false;
    }
    if (!readable) {
      try {
        resolveIdentities(root, "locked.json", [], []);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaError);
        const message = (error as SchemaError).message;
        expect(message).toContain(gatesPath);
        expect(message).toMatch(/could not be read/);
        expect(message).toMatch(/permissions/);
      }
    }
    chmodSync(gatesPath, 0o600);
  });

  it("a --gates whose PARENT directory cannot be traversed is 'could not be read', not 'no such file'", () => {
    // zheref/nen#86 review: `existsSync` returns `false` for ANY access
    // failure, not just ENOENT -- so an EACCES on a parent directory used to
    // read as absence here, before the read below ever got a chance to say
    // "could not be read" and name the errno. This is the case the fix moved
    // onto the single `statSync(gatesPath, { throwIfNoEntry: false })` probe:
    // an EACCES thrown by THAT call must route through gatesReadFailure, not
    // the missing-file refusal. chmod is skipped where it is not meaningful (a
    // root test runner, or a filesystem that does not enforce the bit) rather
    // than asserted into a platform-dependent failure -- same guard pattern as
    // the unreadable-file case above.
    const root = mkdtempSync(join(tmpdir(), "nen-gates-locked-parent-"));
    const lockedDir = join(root, "locked");
    mkdirSync(lockedDir);
    const gatesPath = join(lockedDir, "gates.json");
    writeFileSync(gatesPath, "{}");
    chmodSync(lockedDir, 0o000);
    let traversable = true;
    try {
      statSync(gatesPath);
    } catch {
      traversable = false;
    }
    if (!traversable) {
      try {
        resolveIdentities(root, join("locked", "gates.json"), [], []);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaError);
        const message = (error as SchemaError).message;
        expect(message).toMatch(/could not be read/);
        expect(message).toMatch(/EACCES/);
        expect(message).not.toMatch(/no such file/);
      }
    }
    chmodSync(lockedDir, 0o700);
  });

  it("a malformed in-repo nen/gates.json fails as a path-bearing SchemaError, not a bare SyntaxError", () => {
    // Mirrors ../schema/source.test.ts's "reports malformed JSON as itself"
    // case, but through the --gates-less fallback branch this same function
    // takes -- the branch Copilot's review on PR #9 found reading the file with
    // a raw JSON.parse and no SchemaError shaping (zheref/nen#9, pr_ready.ts:429).
    const root = mkdtempSync(join(tmpdir(), "nen-pr-ready-corrupt-gates-"));
    mkdirSync(join(root, "nen"));
    const gatesPath = join(root, "nen", "gates.json");
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

  // zheref/nen#8 item 3: `safePattern` compiles an operator-typed `--reviewers`
  // entry and the result is then run against review AUTHOR LOGINS off the
  // network -- the identical exposure ../schema/gates.ts's five pattern fields
  // have. It does not throw (its whole contract is that a name it cannot use
  // matches NOTHING, which is the conservative direction: an unrecognised
  // reviewer OWES a round rather than being excused), so the guard has to show
  // up as a pattern that matches nothing rather than as an error.
  it("a catastrophic --reviewers entry matches NOTHING instead of being handed a login", () => {
    const identities = identitiesFromFlags(["(a+)+$"], []);
    const pattern = identities.reviewer("(a+)+$")?.loginPattern;
    // The subject the issue measured at ~300ms against the unguarded pattern.
    const started = performance.now();
    expect(pattern?.test(`${"a".repeat(40)}!`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("still compiles the ordinary reviewer names anyone would actually type", () => {
    // The guard's cost on real input has to be zero, or it has broken the
    // shell-faithful reading this function exists to preserve.
    const identities = identitiesFromFlags(["alice", "some-bot"], []);
    expect(identities.reviewer("alice")?.loginPattern.test("ALICE")).toBe(true);
    expect(identities.reviewer("some-bot")?.loginPattern.test("Some-Bot")).toBe(true);
    // ...including the escaped spelling of a bracketed bot login, which is a
    // REGEX here and not a literal (unchanged by this guard, asserted so the
    // guard is not later blamed for it).
    expect(identitiesFromFlags(["x\\[bot\\]"], []).reviewer("x\\[bot\\]")?.loginPattern.test("x[bot]")).toBe(true);
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
      { id: "mergeable", order: 1, clause: "CON-42/1", title: "Mergeable", status: "failed", reason: "not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)", note: null },
      { id: "checks-green", order: 2, clause: "CON-32(a)", title: "Every reported check green", status: "unevaluated", reason: null, note: null },
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
    approvalPolicy: "required",
    roundPolicy: "bounded",
      excludeRun: null,
      deliveryPr: false,
      identities: { source: "schema", path: "/repo/nen/gates.json" },
      dependabotCarveOut: false,
      warnings: [],
      evaluatedAt: "2025-01-01T00:00:00Z",
      generator: { program: "nen", version: "0.0.0", executable: "/opt/nen/nen-linux-x64" },
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

  it("names WHICH BINARY decided the verdict", () => {
    // zheref/nen#16. `--json`'s `meta.generator` has carried `program` and
    // `version` since v0.1; this rendering -- the one a human reads at a gate --
    // named neither, so it could not say whether the verdict came from the
    // bootstrap-cached binary, a locally built one, or `bun src/index.ts` out of
    // a working tree. Those three can carry the same version string.
    const text = renderExplain(sampleReport()).join("\n");
    expect(text).toContain("decided by nen 0.0.0 (/opt/nen/nen-linux-x64) at 2025-01-01T00:00:00Z");
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
    reviewRequestsPageInfo: { hasNextPage: false, endCursor: null },
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
    reviewRequestsPage: async (): Promise<ReviewRequestsPage> => {
      throw new Error("reviewRequestsPage should not be called when hasNextPage is false");
    },
    ...overrides,
  };
}

function stubDeps(source: PrStateSource | null): PrReadyDeps {
  return {
    now: (): string => "2025-01-01T00:00:00Z",
    executable: (): string => "/opt/nen/nen-linux-x64",
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

  it("carries the deciding binary on the UNEVALUATED path too", async () => {
    // zheref/nen#16. An unevaluated report is the one a caller is most likely to
    // be puzzled by, so it is the one that must least be able to hide which
    // binary produced it -- and it is built by a different function from the
    // decided path, which is exactly how a field ends up on one and not the
    // other.
    const { io, out } = capture();
    await prReady(input(), io, stubDeps(null));
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.meta.generator.program).toBe(PROGRAM);
    expect(report.meta.generator.version).toBe(VERSION);
    expect(report.meta.generator.executable).toBe("/opt/nen/nen-linux-x64");
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
        reviewRequestsPageInfo: { hasNextPage: undefined, endCursor: undefined },
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
          reviewRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
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
// when observed on 2026-08-31, #927's rollup had totalCount 114 with
// hasNextPage true, and the only failing entry ('sasuke / audit') sat at
// position 101+, so this verb answered `ready` on a truncated,
// all-green-SO-FAR view while scripts/pr_ready_gate.sh -- whose
// `gh pr view --json statusCheckRollup`
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
      reviewRequestsPageInfo: { hasNextPage: false, endCursor: null },
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
// no repository ships `nen/gates.json` yet -- an OMITTED `--approvers`
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
        reviewRequestsPageInfo: { hasNextPage: false, endCursor: null },
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

// ── zheref/nen#8 item 4, at the VERB level ──────────────────────────────────
//
// The unit cases above pin `resolveIdentities`. These pin what a caller of the
// verb actually SEES: which file the verdict was computed from, printed in both
// machine and human modes, and the exit code a bad `--gates` lands on.
describe("prReady -- a relative --gates is the target repository's file, and the report says which", () => {
  it("--json reports the RESOLVED absolute path, never the bare relative string", async () => {
    const previous = process.cwd();
    try {
      // Standing anywhere at all: the answer must not depend on it.
      process.chdir(tmpdir());
      const { io, out } = capture();
      const code = await prReady(
        input({
          values: { "gh-repo": "zheref/example", gates: join("nen", "gates.json") },
          repoFlag: BANKAI_REPO,
        }),
        io,
        stubDeps(stubSource()),
      );
      expect(code).toBe(0);
      const report = JSON.parse(out.join("\n")) as ReadyReport;
      expect(report.meta.identities.path).toBe(schemaPath(BANKAI_REPO, GATES_FILE));
      expect(report.meta.identities.source).toBe("schema");
    } finally {
      process.chdir(previous);
    }
  });

  it("--explain prints the resolved path on the identities line", async () => {
    const { io, out } = capture();
    await prReady(
      input({
        values: { "gh-repo": "zheref/example", gates: join("nen", "gates.json") },
        booleans: new Set(["explain"]),
        repoFlag: BANKAI_REPO,
      }),
      io,
      stubDeps(stubSource()),
    );
    expect(out.join("\n")).toContain(`identities ${schemaPath(BANKAI_REPO, GATES_FILE)}`);
  });

  it("a --gates that does not exist is exit 2 with an actionable refusal, not a raw ENOENT", async () => {
    const { io, err } = capture();
    const code = await prReady(
      input({
        values: { "gh-repo": "zheref/example", gates: join("nen", "typo.json") },
        repoFlag: BANKAI_REPO,
      }),
      io,
      stubDeps(stubSource()),
    );
    // 2, the same code every other "you asked the wrong question" from this
    // verb lands on -- a bad flag is never reported as a verdict.
    expect(code).toBe(2);
    const text = err.join("\n");
    expect(text).toMatch(/no such file/);
    expect(text).toContain(BANKAI_REPO);
    expect(text).toMatch(/absolute path/);
    expect(text).not.toMatch(/ENOENT/);
  });
});
