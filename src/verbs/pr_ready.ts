// src/verbs/pr_ready.ts -- `nen pr ready <ref>`: the CON-32 readiness verdict,
// for a human, for a skill, and for CI (zheref/nen#2, Akatsuki migration P1).
//
// WHY THIS VERB IS THE ONE THAT MATTERS. §2 counts eleven call sites for the
// readiness verdict and calls it "the one readiness-claim path"; §3 makes it
// SHARED -- the plugin layer invokes it, so there is exactly one readiness
// authority for human, plugin and CI. The rule it serves is
// claude/skills/pr-state/SKILL.md § 5, unchanged by the migration:
//
//   A readiness claim is the deterministic gate's verdict, quoted, or it is not
//   made.
//
// The gate itself is ../gates/ready.ts (adopted from the source system's port);
// the transport is ../github/pr_state.ts. THIS file does three things and no
// more: it resolves what was asked about, it decides where the reviewer
// IDENTITIES come from, and it renders. No predicate lives here.
//
// AUTHORITY, TODAY. None. Throughout zheref/nen#2 the shell gate remains
// CON-32's authority and this verb holds no readiness authority until the shadow
// window (docs/evidence/shadow-window-p1.md) closes clean. That is §7's P1
// rollback position and it is why nothing here writes to GitHub: this verb
// cannot label, merge, comment, re-request or re-run, and adding any of those is
// a different issue with a different review.
//
// ── WHERE THE IDENTITIES COME FROM, AND WHY THERE IS NO DEFAULT SET ─────────
//
// §3: "No binary may hard-code a persona, label, check name, or colour; they are
// read from the target repo's schemas." A readiness gate is the worst possible
// place to break that rule -- a built-in reviewer table would make `nen` judge a
// repository against ANOTHER repository's reviewers while reporting success --
// so there are exactly three sources and NO fallback:
//
//   1. `--gates <path>`      an explicit gates file. It exists because the
//                            schema is NEW: no repository ships
//                            `nen/gates.json` yet, and the shadow window has
//                            to be able to state the identities the shell gate
//                            decides with in order to compare verdicts at all.
//                            A RELATIVE path is resolved against the `--repo`
//                            ROOT, not the current directory -- see
//                            `resolveIdentities` for the rule and why it is that
//                            way round (zheref/nen#8 item 4).
//   2. `nen/gates.json`  under the target repo root (`--repo`, else cwd).
//                            The steady state.
//   3. `--reviewers a,b,c`   the shell gate's own flag, mirrored. The named
//                            reviewers get the ORIGINAL's `default:` reading and
//                            nothing else: each matches its own login,
//                            case-insensitively; none has a review check, a
//                            round check, a bounded-policy exemption or a
//                            delivery carve-out. That is the conservative
//                            direction in every limb -- an unknown reviewer OWES
//                            a round rather than being excused -- and it is
//                            stated in the output, because a gate running on a
//                            reduced identity set must say so.
//
// With none of the three, the verb REFUSES. It does not guess, and it does not
// evaluate a conjunction whose reviewer set nobody stated.
//
// ── THE REF GRAMMAR, DELIBERATELY SMALL ─────────────────────────────────────
//
// `<CODE>#<N>` resolved through the target repo's `nen/repos.json`
// `product_codes` (case-insensitive, the `#` optional), or a bare `<N>` with an
// explicit `--gh-repo owner/name`. A BARE NUMBER WITH NO REPO IS AN ERROR rather
// than an assumption that it means the current directory's repository -- the
// skill's own rule, and the class of shortcut it exists to prevent. The full
// object-notation engine is zheref/nen#3's; this resolution is deliberately
// internal and simple so that it can be REPLACED by that engine rather than
// competed with.

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { evaluateReady, CAVEATS, type Conjunct, type ReadyEvaluation } from "../gates/ready.js";
import type { RoundPolicy } from "../gates/predicates.js";
import { createClient, tokenFromEnv } from "../github/client.js";
import { fetchPrState, type PrRef, type PrStateSource } from "../github/pr_state.js";
import { assertRepoRoot } from "../repo/root.js";
import { SchemaError } from "../schema/errors.js";
import { safePattern } from "../schema/pattern.js";
import {
  parseGateIdentities,
  type GateIdentities,
  type ReviewerIdentity,
} from "../schema/gates.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { GATES_FILE, readSchemaJson, REPOS_FILE, resolveSchemaFile } from "../schema/source.js";
import { PROGRAM, VERSION } from "../version.js";

/**
 * The flags this verb adds to the CLI's declared surface.
 *
 * Exported as ONE object so ../index.ts spreads it rather than restating the
 * names -- two sibling sessions are adding verbs to the same dispatch and a flag
 * list every verb edits by hand is a merge conflict per verb.
 */
export const PR_READY_FLAGS = {
  values: ["gh-repo", "reviewers", "approvers", "round-policy", "exclude-run", "gates", "token-env"],
  booleans: ["explain"],
} as const;

// `PR_READY_USAGE` USED TO LIVE HERE, and it is deliberately gone (zheref/nen#8,
// review minor 4). This verb's help text moved into ../pr/command.ts's `USAGE`
// when `pr ready` was converged into the one "pr" family -- see that file's
// header for why there is exactly one "pr" entry point -- and the constant here
// was left behind, exported and referenced by nothing. It went on being edited
// anyway: this branch added seven lines of `--gates` documentation to it before
// anybody noticed that no caller renders it. A second copy of the help that
// nothing prints is worse than no copy, because it is the one a maintainer
// updates and then wonders why `nen pr ready --help` did not change. The live
// text is in ../pr/command.ts, and it carries the `--gates` resolution rule.

// A token is never read ambiently the way `gh` reads one; the caller names the
// variable, and this is only the DEFAULT NAME, not a fallback chain.
const DEFAULT_TOKEN_ENV = "GH_TOKEN";

// `${COPILOT_STALL_MINUTES:-30}` and `${MAX_THREAD_PAGES:-50}` -- the shell's
// two numeric knobs, at the shell's values. Operator settings, not PR data.
//
// A STATED DIVERGENCE, NOT AN OVERSIGHT (zheref/nen#8 item 1). The shell oracle
// reads TWO ENVIRONMENT OVERRIDES -- one for the stall bound above, one for the
// round policy `prReady` defaults to `bounded` below -- and nen reads NEITHER,
// deliberately and permanently. Both are named after a persona, and §3's
// names-are-data rule makes a persona-named environment variable data this
// binary must not know: teaching it those two names would put a reviewer's name
// into shipped code through the one door a value-level sweep waves through.
//
// The COST IS REAL and is stated here rather than discovered later: an operator
// with the shell oracle's policy override exported gets that policy from the
// shell and `bounded` from nen on the same invocation, and `bounded` is the more
// permissive of the two for a bounded-exempt reviewer. So the two
// implementations are only guaranteed comparable under a DEFAULT environment,
// which is the environment the shadow window ran both sides in
// (docs/evidence/shadow-window-p1.md). `--round-policy` and this fixed stall
// bound are the only knobs nen has, and a caller that needs the other policy
// passes `--round-policy strict` explicitly.
const STALL_MINUTES = 30;
const MAX_THREAD_PAGES = 50;
// The check-rollup pagination cap (../github/pr_state.ts's `fullCheckRollup`,
// zheref/nen#14's fact-check on zheref/bankai-core#927). NO shell counterpart
// to mirror: `gh pr view --json statusCheckRollup` paginates this connection
// inside gh's own client with no configurable cap the script exposes. Set to
// MAX_THREAD_PAGES's own default for the same reasoning -- large enough that
// no real rollup should ever hit it, small enough to backstop a server that
// never reports `hasNextPage:false`.
const MAX_ROLLUP_PAGES = 50;
// The reviewRequests pagination cap (../github/pr_state.ts's
// `fullReviewRequests`, zheref/nen#14's SECOND fact-check, 2026-09-01). Same
// reasoning as MAX_ROLLUP_PAGES: no shell counterpart, no operator-facing
// knob to mirror, set to the same default backstop value.
const MAX_REVIEW_REQUEST_PAGES = 50;

export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface PrReadyInput {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly booleans: ReadonlySet<string>;
  readonly repoFlag: string | null;
}

export interface PrReadyDeps {
  /** `date -u +%Y-%m-%dT%H:%M:%SZ`, injected so a report is reproducible. */
  readonly now: () => string;
  /**
   * The path of the executable that is deciding this verdict. Injected for the
   * same reason `now` is: a report a test asserts on must not carry a value
   * that changes with the machine. See "provenance" below for what it answers.
   */
  readonly executable: () => string;
  /** Opens the transport. Returns a message instead of throwing on a bad token. */
  readonly openSource: (
    tokenEnvVar: string,
  ) => { readonly ok: true; readonly source: PrStateSource } | { readonly ok: false; readonly message: string };
}

export const defaultDeps: PrReadyDeps = {
  now: (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  // `process.execPath`, NOT `import.meta.url`: a compiled bun binary's
  // `import.meta.url` is `/$bunfs/...`, a path on no filesystem, which is the
  // whole reason ../taxonomy-purity.test.ts forbids that constant outright.
  executable: (): string => process.execPath,
  openSource: (
    tokenEnvVar,
  ): { readonly ok: true; readonly source: PrStateSource } | { readonly ok: false; readonly message: string } => {
    const token = tokenFromEnv(tokenEnvVar);
    if (!token.ok) return { ok: false, message: token.message };
    return { ok: true, source: createClient(token.token) };
  },
};

// ── the frozen machine contract ─────────────────────────────────────────────
//
// FROZEN AT v0.1 FROM THE FIRST RELEASE. §1 makes `--json` "a stable contract
// for Hatsu and Ninjutsu ... stable from the first release", and §10 states the
// consumption shape every ported skill follows: run `nen pr ready <ref> --json`,
// quote the verdict verbatim, render the conjunct table FROM THE JSON, and add
// only the judgment layer. Two independent consumers read this shape, so the
// rules below are part of the deliverable and not documentation of it:
//
//   * `contract` is the FIRST thing a consumer reads and the thing it refuses
//     on. A consumer that does not recognise the string must stop, not
//     best-effort the fields it happens to know -- that is the same failure
//     ../schema/gates.ts's `version` exists to prevent, one layer up.
//   * ADDING a field is compatible and does NOT bump the version. REMOVING one,
//     RENAMING one, or changing what a value MEANS bumps it, and both consumers
//     are updated in the same change.
//   * `verdict` is a CLOSED set of three: `ready`, `not-ready`, `unevaluated`.
//     A consumer that treats anything it does not recognise as `ready` has
//     inverted the whole point; the safe reading of an unknown verdict is
//     `unevaluated` (SKILL.md § 4: absence is never a pass).
//   * `gateLine` is the string to QUOTE. It is the gate's own sentence, and on
//     a not-ready it is the FIRST failing conjunct's reason -- never a summary,
//     never a list. A skill that paraphrases it has re-derived the verdict.
//   * `conjuncts` is ALWAYS all six rows, ALWAYS in evaluation order, and
//     `status` is `ready` | `failed` | `unevaluated`. A row AFTER the failing
//     one is `unevaluated` and MUST NOT be rendered as passing: the gate
//     short-circuits, so those rows are unknown.
//   * `caveats` is the fixed "what the gate does not decide" set. It travels
//     with the verdict so every consumer states the same three things rather
//     than each keeping its own copy to drift.
//   * `meta` is context, never evidence. Nothing in it is a conjunct and
//     nothing in it may be read as one.
//
// ── provenance: what it is here, and what it is NOT (zheref/nen#16) ─────────
//
// bankai-core's `cli/src/ports/pr_ready_gate.ts` -- the file this readiness
// core is adopted from -- gained a self-reported provenance line in BC-PR-#934,
// answering "which copy of me decided this" on every invocation. The question
// was real there: the shell script could be sourced from a real checkout or
// from a plugin-cache MIRROR of one, so which bytes ran was genuinely ambiguous
// and only the tree and commit could settle it.
//
// NEN'S ANSWER TO THE SAME QUESTION IS DIFFERENT, because nen's ambiguity is:
//
//   * NOT a checkout SHA. A compiled binary has no checkout at evaluation time
//     and no `.git` to read -- `import.meta.url` inside one is `/$bunfs/...`,
//     which is why ../taxonomy-purity.test.ts forbids that constant outright.
//     Asking a released binary which commit built it would mean baking an
//     answer in at build time that a locally-built one would state just as
//     confidently and just as unverifiably.
//   * NOT a checkout-vs-cache CLASS either, which is bankai-core#938's
//     shell-only half and stays N/A here (D16/AK-11: Akatsuki has no host for a
//     bash-tree self-identification guard).
//   * IT IS THE VERSION AND THE PATH. `nen --version` says which nen a caller
//     BELIEVES it has; `meta.generator.executable` says which file actually
//     produced this verdict -- a checksum-verified binary under the bootstrap
//     cache (`~/.cache/nen/<source>/<ref>/...`), a locally built one, or `bun
//     src/index.ts` out of a working tree. Those three can carry the same
//     `version` string and different behaviour, and that is the whole of what
//     is ambiguous about a nen verdict. The version is verifiable against the
//     published SHA256SUMS for a ref; the path is what says WHICH of them ran.
//
// WHERE IT SURFACES: in `--json`'s `meta.generator` (already carried `program`
// and `version`; `executable` is ADDITIVE and therefore does not bump v0.1, by
// this contract's own rule above), and in `--explain`, which is the rendering a
// human reads at a gate and which named the binary nowhere at all.
//
// WHERE IT DELIBERATELY DOES NOT: on stderr, unconditionally, the way the shell
// printed it. The shell had no structured output to put it in, so stderr was
// the only place left; nen has one, and every verb in this binary shares one
// stderr that callers already treat as diagnostics. `pr ready` is not
// privileged among thirty-odd verbs, and a provenance line on every invocation
// of one of them is a line the other thirty would each have to justify not
// printing. The report carries it; a caller that wants it reads the report.
export const CONTRACT = "nen.pr.ready/v0.1";

export type Verdict = "ready" | "not-ready" | "unevaluated";

export interface ReadyReport {
  readonly contract: string;
  readonly verdict: Verdict;
  /** The line to quote verbatim. */
  readonly gateLine: string;
  readonly firstFailing: string | null;
  readonly conjuncts: readonly Conjunct[];
  readonly caveats: typeof CAVEATS;
  /** What would fix an `unevaluated`; `null` for a decided verdict. */
  readonly remedy: string | null;
  readonly meta: ReadyMeta;
}

export interface ReadyMeta {
  /** The ref exactly as the caller typed it. */
  readonly ref: string;
  readonly repo: string;
  readonly pr: number;
  readonly headSha: string | null;
  readonly reviewers: readonly string[];
  readonly approvers: readonly string[];
  readonly approvalPolicy: "required" | "review-round-only";
  readonly roundPolicy: RoundPolicy;
  readonly excludeRun: string | null;
  readonly deliveryPr: boolean | null;
  /**
   * Whether CON-30's `dependabot_carve_out` fired for this pull request
   * (zheref/nen#18). `null` when the gate never ran far enough to ask -- an
   * unevaluated report -- and never `true` on the `--reviewers` identity path,
   * which names no file and therefore declares no carve-out.
   */
  readonly dependabotCarveOut: boolean | null;
  readonly identities: { readonly source: "schema" | "flags"; readonly path: string | null };
  readonly warnings: readonly string[];
  readonly evaluatedAt: string;
  /**
   * WHICH BINARY DECIDED THIS. See the provenance note above the contract.
   * `executable` is additive at v0.1 and carries the resolved path of the
   * process that produced the report, never a checkout SHA -- nen has no
   * checkout at evaluation time.
   */
  readonly generator: {
    readonly program: string;
    readonly version: string;
    readonly executable: string;
  };
}

// ── ref resolution ──────────────────────────────────────────────────────────

export class RefError extends Error {}

export interface ResolvedRef extends PrRef {
  readonly number: number;
  readonly typed: string;
}

// ── the coded-ref split, and why there are TWO regexes ──────────────────────
//
// `<CODE>#<N>` is the UNAMBIGUOUS spelling: the '#' says exactly where the
// code ends, so the code group can stay greedy and no split is ever guessed.
const HASH_REF = /^([A-Za-z][A-Za-z0-9]*)#([0-9]+)$/;
// The no-# shorthand has no delimiter, so the split is a stated RULE, never a
// guess: the number is the LONGEST trailing run of digits, and the code is
// whatever precedes it. The lazy `*?` implements exactly that -- the digit
// group, anchored at `$`, swallows the whole trailing run instead of the one
// digit backtracking would concede it.
//
// zheref/nen#26: these were one regex, /^([A-Za-z][A-Za-z0-9]*)#?([0-9]+)$/,
// whose GREEDY first group plus optional '#' meant backtracking handed the
// digit group exactly ONE trailing digit -- 'BC925' read as code 'BC92' +
// number '5' -- so the shorthand only ever worked for single-digit numbers.
//
// PRECEDENCE, for a code that itself ends in a digit (codes are registry
// data and may carry digits after the first letter -- this binary has no
// opinion): the shorthand ALWAYS takes the longest trailing digit run, so
// 'A2925' splits as code 'A' + number 2925 even when the registry lists an
// 'A2'. A repository whose code ends in a digit can only be addressed with
// the '#' present -- the shorthand never consults the registry to out-guess
// its own rule, because a split that changed meaning when a registry gained
// a code would make the same typed ref name two different pull requests.
const SHORTHAND_REF = /^([A-Za-z][A-Za-z0-9]*?)([0-9]+)$/;
const BARE_REF = /^([0-9]+)$/;
const OWNER_SLUG = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

function splitSlug(slug: string): PrRef | null {
  const match = OWNER_SLUG.exec(slug);
  if (match === null) return null;
  return { owner: match[1] ?? "", repo: match[2] ?? "" };
}

/**
 * `<CODE>#<N>`, `<CODE><N>` or a bare `<N>` with `--gh-repo`.
 *
 * The `#` is optional and the code is CASE-INSENSITIVE, both carried from the
 * pr-state skill's own grammar. The no-# shorthand splits at the LONGEST
 * trailing run of digits (see SHORTHAND_REF above for the rule and its
 * precedence over digit-ending codes). An unknown code is an ERROR THAT NAMES
 * THE VALID ONES rather than a guess -- and when the token came through the
 * shorthand split, the error also states the split it applied and points at
 * the '#'-present form, because "'BC92' is not a product code" alone reads as
 * a registry problem when the actual problem is a missing '#'. A bare number
 * with no `--gh-repo` is an error rather than an assumption about the current
 * directory -- this verb is invoked across repositories, and guessing which
 * one is exactly the shortcut the skill exists to prevent.
 */
export function resolveRef(
  typed: string,
  ghRepoFlag: string | undefined,
  registry: () => { productCodes: Readonly<Record<string, string>>; consumers: readonly { repo: string; code: string | null }[] },
): ResolvedRef {
  const explicit = ghRepoFlag === undefined ? null : splitSlug(ghRepoFlag);
  if (ghRepoFlag !== undefined && explicit === null) {
    throw new RefError(`--gh-repo takes an 'owner/name' slug, got '${ghRepoFlag}'.`);
  }

  const bare = BARE_REF.exec(typed);
  if (bare !== null) {
    if (explicit === null) {
      throw new RefError(
        `'${typed}' is a bare pull-request number and names no repository. Either write it as <CODE>#${typed} -- the code is resolved through the target repository's ${REPOS_FILE} -- or pass --gh-repo owner/name. Guessing the repository from the current directory is the one shortcut this verb refuses.`,
      );
    }
    return { ...explicit, number: Number.parseInt(typed, 10), typed };
  }

  const hash = HASH_REF.exec(typed);
  // The shorthand is tried only when the '#' form did not match, so a typed
  // '#' always decides the split and the rule below never competes with it.
  const shorthand = hash === null ? SHORTHAND_REF.exec(typed) : null;
  const coded = hash ?? shorthand;
  if (coded === null) {
    throw new RefError(
      `'${typed}' is not a pull-request reference. Write <CODE>#<N> (the '#' is optional) or a bare <N> together with --gh-repo owner/name.`,
    );
  }
  const code = coded[1] ?? "";
  const number = Number.parseInt(coded[2] ?? "", 10);
  // An explicit --gh-repo WINS over the code, and does not have to agree with
  // it: a caller naming both has said which repository it means, and refusing
  // the combination would make the flag useless for a repository the registry
  // does not list at all.
  if (explicit !== null) return { ...explicit, number, typed };

  const loaded = registry();
  const wanted = code.toLowerCase();
  for (const consumer of loaded.consumers) {
    if (consumer.code !== null && consumer.code.toLowerCase() === wanted) {
      const slug = splitSlug(consumer.repo);
      if (slug !== null) return { ...slug, number, typed };
    }
  }
  for (const [key, name] of Object.entries(loaded.productCodes)) {
    if (key.toLowerCase() !== wanted) continue;
    const slug = splitSlug(name);
    if (slug !== null) return { ...slug, number, typed };
    // The registry's `product_codes` map a code to a bare repository NAME,
    // while `consumers[].repo` carries a full slug. When only the bare name is
    // available the owner is taken from the registry's own consumers -- and
    // ONLY when they agree on one, because picking one of several owners would
    // resolve a reference to a repository nobody named.
    const owners = new Set(
      loaded.consumers
        .map((consumer): string => splitSlug(consumer.repo)?.owner ?? "")
        .filter((owner): boolean => owner !== ""),
    );
    if (owners.size === 1) {
      const owner = [...owners][0] ?? "";
      return { owner, repo: name, number, typed };
    }
    throw new RefError(
      `'${code}' resolves to the repository name '${name}', but the registry does not state its owner and its consumers name ${owners.size} different owners. Pass --gh-repo owner/${name}.`,
    );
  }
  const known = [
    ...new Set([
      ...Object.keys(loaded.productCodes),
      ...loaded.consumers.map((consumer): string => consumer.code ?? "").filter((c): boolean => c !== ""),
    ]),
  ].sort();
  // A no-# token that fails code resolution must say HOW it was split, or the
  // refusal misdirects (zheref/nen#26): 'BC92' failing lookup reads as a
  // registry problem, when the caller's actual problem may be the split itself.
  const shorthandHint =
    shorthand === null
      ? ""
      : ` The ref '${typed}' carries no '#', so it was split by the shorthand's rule -- the number is the longest trailing digit run -- as code '${code}' + number ${number}. If that is not the split you meant, put a '#' between code and number: <CODE>#<N> is the unambiguous form.`;
  throw new RefError(
    `'${code}' is not a product code in the target repository's registry. Known codes: ${known.join(", ") || "(none)"}. Codes are resolved from the file at run time, never from memory -- they change.${shorthandHint}`,
  );
}

// ── identity resolution ─────────────────────────────────────────────────────

export interface ResolvedIdentities {
  readonly identities: GateIdentities;
  readonly source: "schema" | "flags";
  readonly path: string | null;
}

export class IdentityError extends Error {}

/**
 * Reviewer identities from a NAME LIST alone -- the original's `default:` arm,
 * made explicit.
 *
 * Every reviewer matches its own login case-insensitively and has nothing else:
 * no review check (so no delivery-PR abstain can satisfy its round), no round
 * check (so no silent check stands in for a review), no bounded exemption (so a
 * head it was never asked about is still waited on), no delivery carve-out. Each
 * of those is the CONSERVATIVE reading, which is why a reduced identity set can
 * only ever hold the gate SHUT longer than the full one -- never open it.
 *
 * The delivery author pattern is one that matches NOTHING, so the CON-40
 * carve-out is unreachable without a file. A carve-out WIDENS the gate; a
 * carve-out configured by nobody must therefore not fire.
 *
 * `approvers` IS TAKEN LITERALLY -- this function does not itself distinguish
 * an omitted `--approvers` from an explicitly empty one, and it must not: that
 * is a CALLER decision (`resolveIdentities`/`prReady`, below), because only the
 * caller knows whether the array it is holding came from a flag the operator
 * typed or from this function's own absence. Passing `[]` here always means
 * "the approve limb is vacuous", the reading ../gates/predicates.ts documents.
 * zheref/nen#2's review record: collapsing "the flag was never given" into that
 * same `[]` one layer up (rather than here) made `--reviewers a,b` with no
 * `--approvers` silently return `ready` on an unapproved pull request -- CON-32(b)'s
 * approve limb going vacuously true through the one identity source every
 * repository without a `nen/gates.json` actually uses. Fixed at the call
 * site: an omitted `--approvers` now defaults to the REVIEWER set (the
 * conservative reading -- every named reviewer must approve, never nobody).
 */
export function identitiesFromFlags(
  reviewers: readonly string[],
  approvers: readonly string[],
): GateIdentities {
  const list: ReviewerIdentity[] = reviewers.map((name): ReviewerIdentity => ({
    name,
    loginPattern: safePattern(name),
    reviewCheckPattern: null,
    roundCheckPattern: null,
    enrolmentCheckPattern: null,
    boundedPolicyExempt: false,
    deliveryHolisticPass: false,
    approvesWhenPostedAtHead: false,
  }));
  const byName = new Map(list.map((entry): [string, ReviewerIdentity] => [entry.name, entry]));
  return {
    path: "(flags)",
    version: 1,
    reviewers: list,
    // An EXPLICITLY empty approver set is a caller that said what it means, and
    // makes the approve limb vacuous -- the reading ../gates/predicates.ts
    // documents. The FILE is refused for being silent about it; a flag is not
    // silent PROVIDED the caller above never hands this an empty array to mean
    // "unspecified" -- see the doc comment above.
    defaultApprovers: approvers,
    approvalPolicy: "required",
    baseReviewers: reviewers,
    delivery: { authorPattern: /(?!)/, headRefPrefixes: [], labels: [] },
    // NO CARVE-OUT ON THE FLAGS PATH, and that is the conservative reading
    // rather than an omission (zheref/nen#18). CON-30's carve-out clears review
    // rounds for an author nobody reviews, on the strength of check contexts a
    // FILE names; `--reviewers a,b` names no file, so there is nothing that
    // could say which contexts stand in for a round. Inventing a default here
    // would be inventing the one rule whose whole purpose is to be declared.
    dependabotCarveOut: null,
    reviewer: (name): ReviewerIdentity | undefined => byName.get(name),
  };
}

// `safePattern` -- "an unparseable or catastrophic reviewer name matches
// NOTHING" -- now lives in ../schema/pattern.js and is IMPORTED rather than
// spelled here (zheref/nen#8, review MAJOR 1). It had a second, byte-identical
// body in ../gates/predicates.ts, and only this one was ever given the shape
// guard -- which left the UNGUARDED copy on the path production actually takes,
// since `identitiesFromFlags` above is never called once the target repository
// ships a `nen/gates.json`. One implementation, one guard, two importers;
// the contract and the reasoning are in that file's header.

/**
 * Where the reviewer identities come from, and -- for `--gates` -- WHICH FILE.
 *
 * A RELATIVE `--gates` IS RESOLVED AGAINST THE `--repo` ROOT (zheref/nen#8 item
 * 4). That is a decision, so here is the reasoning rather than the rule alone:
 *
 *   * Every other path this verb reads is anchored to the target repository --
 *     `nen/repos.json` for the ref, `nen/gates.json` two branches below,
 *     both through `schemaPath(repoRoot, ...)`. `--gates` was the one exception,
 *     and it was an exception nobody chose: `readFileSync(gatesFlag)` simply
 *     inherits `process.cwd()`.
 *   * The failure that exception produces is SILENT and WRONG, which is the
 *     worst pair available to a gate. `--repo ../other --gates nen/gates.json`
 *     from a checkout that also has a `nen/gates.json` read the CURRENT
 *     directory's reviewers, judged the OTHER repository's pull request against
 *     them, and reported a verdict -- with `meta.identities.path` printing the
 *     bare relative string, so nothing on screen said which file had been read.
 *   * An ABSOLUTE path is used as-is. `--gates` exists so the shadow window can
 *     point at a gates file that lives in neither repository, and taking that
 *     away would be a different defect.
 *
 * The path reported in `--explain` and `--json` is the RESOLVED, absolute one,
 * so a reader can always see which file the verdict was computed from.
 *
 * A `--gates` that does not resolve to a readable file is refused HERE, by this
 * codebase's own path-bearing SchemaError, rather than being left to surface as
 * a raw Node `ENOENT` string relayed through a catch. Both callers map it to
 * their own refusal code: `prReady`'s catch below returns 2 for everything this
 * function throws (a missing identity source is "you asked the wrong question",
 * never a verdict), and `nen pr next-blocker` -- which shares this resolver
 * rather than re-spelling it, so the rule above is the same rule there -- maps it
 * through ../index.ts's family contract like every other schema-read failure of
 * that verb.
 */
/**
 * ONE refusal for every way the filesystem can decline to hand over a `--gates`
 * file that exists and is not a directory: an EACCES on the file or a parent, a
 * symlink cycle, a file that vanished between the guard and the read.
 *
 * Shared by the `statSync` and the `readFileSync` below rather than written
 * twice, so the two cannot drift into two different messages for the same
 * errno -- and so the property the guards exist for ("no raw Node errno string
 * ever leaves this branch") is one function to check rather than two call sites
 * to keep in step.
 */
function gatesReadFailure(gatesPath: string, gatesFlag: string, error: unknown): SchemaError {
  const code = (error as NodeJS.ErrnoException).code;
  return new SchemaError(
    gatesPath,
    null,
    `could not be read (${code ?? String(error)}). --gates was given '${gatesFlag}'; check the file's permissions, or point the flag at one this process can read.`,
  );
}

export function resolveIdentities(
  repoRoot: string,
  gatesFlag: string | undefined,
  reviewers: readonly string[],
  approvers: readonly string[],
): ResolvedIdentities {
  if (gatesFlag !== undefined) {
    // `--gates ""` FIRST, before any resolution. An empty string resolves to
    // the repository root, so without this the operator got "expected a file,
    // found a directory" naming a directory they never typed -- a true sentence
    // about a path this function invented, and one that says nothing about the
    // flag that actually went wrong. The empty flag is a thing the operator can
    // see in their own command line, so it is named there.
    if (gatesFlag.trim() === "") {
      throw new IdentityError(
        `--gates was given an empty path. It names the gates file to read reviewer identities from, so there is nothing to resolve; pass a path, or omit --gates to use the target repository's '${GATES_FILE}'.`,
      );
    }
    // `resolve` is what makes this work on Windows too: an absolute path is
    // normalized and kept, a relative one is joined to the repo root, and
    // neither branch assumes a POSIX separator.
    const gatesPath = isAbsolute(gatesFlag) ? resolve(gatesFlag) : resolve(repoRoot, gatesFlag);
    // The RESOLUTION guard: ONE `statSync(gatesPath, { throwIfNoEntry: false
    // })` answers "does it exist", "is it a directory", and "can it even be
    // read", where this used to be an `existsSync` gate deciding "no such
    // file" ahead of a second, separate `statSync`. `existsSync` is the wrong
    // probe for that question: it returns `false` for ANY access failure, not
    // just ENOENT -- so an EACCES on a parent directory or an ELOOP symlink
    // cycle was misreported as absence here, before this branch ever got a
    // chance to say "could not be read" and name the errno. `throwIfNoEntry:
    // false` turns a genuine ENOENT into `undefined` without throwing, so
    // `undefined` is the ONLY outcome treated as "no such file" below; every
    // error this statSync instead THROWS (EACCES, ELOOP, ...) routes through
    // gatesReadFailure and names its errno, the same refusal the read failure
    // below uses.
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(gatesPath, { throwIfNoEntry: false });
    } catch (error) {
      throw gatesReadFailure(gatesPath, gatesFlag, error);
    }
    // The MISSING-FILE refusal, with the resolution it applied SPELLED OUT: a
    // caller who typed a relative path and got a refusal naming a directory
    // they were not standing in has to be told why, or the message reads as a
    // bug.
    if (stats === undefined) {
      throw new SchemaError(
        gatesPath,
        null,
        `no such file. --gates was given '${gatesFlag}'${
          isAbsolute(gatesFlag)
            ? ""
            : `, which is RELATIVE, so it was resolved against the target repository root '${repoRoot}' -- not the current directory. Every other path this verb reads is anchored to that root, and resolving this one anywhere else would judge that repository against another one's reviewers`
        }. Either pass an absolute path, or pass a path relative to the repository root.`,
      );
    }
    // The DIRECTORY guard.
    if (stats.isDirectory()) {
      throw new SchemaError(gatesPath, null, "expected a file, found a directory");
    }
    // The BACKSTOP the two guards above cannot cover: a file that exists and is
    // not a directory can still fail to open on the READ below -- a vanished
    // file between this statSync and the read, a permission change in that
    // same window, a dangling symlink `open()` resolves differently than
    // `stat()` did. Left unwrapped, that would be the same raw Node errno
    // string relayed through prReady's catch that this whole function exists
    // to stop -- so every way this read can fail leaves through ONE
    // path-bearing error, the shape ../schema/source.ts's readSchemaFile
    // already uses for the in-repo files.
    let text: string;
    try {
      text = readFileSync(gatesPath, "utf8");
    } catch (error) {
      throw gatesReadFailure(gatesPath, gatesFlag, error);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new SchemaError(
        gatesPath,
        null,
        `is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return { identities: parseGateIdentities(gatesPath, value), source: "schema", path: gatesPath };
  }
  // THE IN-REPO PATH IS THE RESOLVER'S, NOT THIS FILE'S. This verb bypasses
  // `openTaxonomy` on purpose -- `--gates <path>` may point outside the
  // repository -- but "where does gates.json live" is still one question with
  // one answer, and answering it here with a second join is how a repository
  // that has migrated to `nen/` gets told it has no gates file while
  // `nen schema check` reads one.
  //
  // ONLY THE CANONICAL CANDIDATE ADMITS THIS FILE. A `schemas/gates.json`
  // with no `nen/gates.json` beside it is, from here down, a repository that
  // carries no gates file at all -- ../schema/source.ts's own read refuses it
  // the same way, and this verb must fall through to `--reviewers` exactly as
  // it would for a repository with neither, rather than trying a read that can
  // now only throw.
  const inRepo = resolveSchemaFile(repoRoot, GATES_FILE);
  if (inRepo.canonical.present) {
    // Same shaping as the `--gates <path>` branch above: a malformed
    // gates.json must fail as a path-bearing SchemaError, not as a bare
    // SyntaxError with no file/pointer context. readSchemaJson is the shared
    // reader every other in-repo taxonomy load already goes through (see
    // ../schema/gates.ts's own loadGateIdentities, ../schema/repos.ts's
    // loadRepoRegistry) -- reusing it here instead of hand-rolling a second
    // JSON.parse keeps this the ONE failure channel schema/errors.ts documents.
    const { path, value } = readSchemaJson(repoRoot, GATES_FILE);
    return { identities: parseGateIdentities(path, value), source: "schema", path };
  }
  if (reviewers.length > 0) {
    return { identities: identitiesFromFlags(reviewers, approvers), source: "flags", path: null };
  }
  throw new IdentityError(
    `no reviewer identities. This gate never falls back to a built-in reviewer set: a binary that guessed the reviewers would judge this repository against another one's and report success. Give it one of: --gates <path>, a '${GATES_FILE}' in the target repository (looked for at '${inRepo.canonical.path}'${
      inRepo.legacy !== null && inRepo.legacy.present
        ? ` -- a legacy '${inRepo.legacy.relative}' is present but is never read; run 'nen scaffold init --accept-detected' (or copy it) to migrate, since the schemas/ fallback was removed in v0.5.0`
        : ""
    }), or --reviewers a,b,c.`,
  );
}

// ── rendering ───────────────────────────────────────────────────────────────

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

const STATUS_LABEL: Readonly<Record<string, string>> = {
  ready: "ready",
  failed: "FAILED",
  unevaluated: "unevaluated",
};

export function renderExplain(report: ReadyReport): string[] {
  const lines: string[] = [];
  lines.push(`${report.meta.repo}#${report.meta.pr}: ${report.gateLine}`);
  lines.push("");
  const delivery =
    report.meta.deliveryPr === null ? "unknown" : report.meta.deliveryPr ? "yes" : "no";
  lines.push(
    `  head ${report.meta.headSha ?? "(unread)"} · reviewers ${
      report.meta.reviewers.join(",") || "(none)"
    } · approvers ${report.meta.approvers.join(",") || "(none — the approve row is vacuous)"}`,
  );
  lines.push(
    `  policy ${report.meta.roundPolicy} · delivery PR ${delivery} · identities ${
      report.meta.identities.path ?? "from --reviewers (reduced: no review checks, no carve-outs)"
    }`,
  );
  // WHICH BINARY DECIDED THIS, on the rendering a human reads at a gate
  // (zheref/nen#16). `--json` has carried `program`/`version` since v0.1 and
  // this line has carried neither, so the one output a maintainer actually
  // looks at was the one that could not say whether the verdict came from the
  // bootstrap-cached binary or from a working tree.
  lines.push(
    `  decided by ${report.meta.generator.program} ${report.meta.generator.version} (${report.meta.generator.executable}) at ${report.meta.evaluatedAt}`,
  );
  if (report.meta.excludeRun !== null) {
    lines.push(`  excluding the checks of Actions run ${report.meta.excludeRun} (CON-36 clause 3)`);
  }
  for (const warning of report.meta.warnings) lines.push(`  warning: ${warning}`);
  lines.push("");
  lines.push("  The gate is a CONJUNCTION, evaluated in this order, short-circuiting on the");
  lines.push("  first failure. Everything after the failing row is genuinely unknown.");
  lines.push("");
  for (const conjunct of report.conjuncts) {
    lines.push(
      `  ${conjunct.order}  ${pad(STATUS_LABEL[conjunct.status] ?? conjunct.status, 12)}${pad(
        conjunct.clause,
        18,
      )}${conjunct.title}`,
    );
    if (conjunct.reason !== null) lines.push(`        └ ${conjunct.reason}`);
    // CON-30's "never a silent exemption" (zheref/nen#18). A CON-32(b) row that
    // passed because a review shim covered it, on a pull request nobody
    // reviewed, must say so on the row itself -- a reader who sees `ready`
    // against "No configured reviewer's round owed" and is not told why has
    // been told the wrong thing.
    if (conjunct.note !== null) lines.push(`        └ ${conjunct.note}`);
  }
  lines.push("");
  lines.push("  What the gate does NOT decide:");
  for (const caveat of report.caveats) {
    lines.push(`  - ${caveat.clause}: ${caveat.text}`);
  }
  if (report.remedy !== null) {
    lines.push("");
    lines.push(`  What would fix this: ${report.remedy}`);
  }
  return lines;
}

// ── the verb ────────────────────────────────────────────────────────────────

/**
 * Exit codes, and why `unevaluated` is not `ready`.
 *
 * 0 is READY and nothing else. `not-ready` and `unevaluated` both exit 1,
 * because the one property a caller must be able to rely on is that a non-zero
 * status never means the pull request cleared -- SKILL.md § 4's "absence is
 * never a pass", expressed as an exit code. The two are told apart by `verdict`
 * in `--json` and by the first line in every other mode; they are NOT told apart
 * by the status, so a caller cannot accidentally treat one as the other.
 */
export async function prReady(
  input: PrReadyInput,
  io: Io,
  deps: PrReadyDeps = defaultDeps,
): Promise<number> {
  const [, subcommand, typedRef] = input.positionals;
  if (subcommand !== "ready") {
    io.err(`${PROGRAM}: unknown 'pr' subcommand '${subcommand ?? "(none)"}'. Try 'pr ready <ref>'.`);
    return 2;
  }
  if (typedRef === undefined) {
    io.err(`${PROGRAM}: 'pr ready' requires a pull-request reference. Try 'pr ready <CODE>#<N>' or 'pr ready <N> --gh-repo owner/name'.`);
    return 2;
  }

  const json = input.booleans.has("json");
  const explain = input.booleans.has("explain");
  const policyText = input.values["round-policy"] ?? "bounded";
  if (policyText !== "strict" && policyText !== "bounded") {
    io.err(`${PROGRAM}: --round-policy must be strict or bounded (got '${policyText}').`);
    return 2;
  }
  const policy: RoundPolicy = policyText;
  const excludeRun = input.values["exclude-run"] ?? "";
  if (excludeRun !== "" && !/^[0-9]+$/.test(excludeRun)) {
    io.err(`${PROGRAM}: --exclude-run must be a numeric Actions run id (got '${excludeRun}').`);
    return 2;
  }
  const reviewersCsv = input.values["reviewers"] ?? "";
  const reviewerNames = splitCsv(reviewersCsv);
  // `--approvers` OMITTED is not the same value as `--approvers ""`, and the
  // difference has to survive to here: CON-32(b)'s approve limb reads an EMPTY
  // approver set as vacuously satisfied (../gates/predicates.ts), so collapsing
  // "the caller never said" into that same `[]` -- as `?? ""` did before this
  // was fixed -- silently emptied the approve limb on the `--reviewers` identity
  // path, which is the ordinary way this verb runs today (no repository ships
  // `nen/gates.json` yet). An omitted `--approvers` therefore defaults to
  // the REVIEWER set: the conservative reading, "every named reviewer must
  // approve", never "nobody has to". An explicit `--approvers ""` is still
  // honoured as the caller's own vacuous statement (identitiesFromFlags's own
  // contract, unchanged).
  const approversFlag = input.values["approvers"];
  const approverNames = approversFlag === undefined ? reviewerNames : splitCsv(approversFlag);

  let ref: ResolvedRef;
  let identities: ResolvedIdentities;
  try {
    const repoRoot = assertRepoRoot({ repoFlag: input.repoFlag });
    ref = resolveRef(typedRef, input.values["gh-repo"], () => loadRepoRegistry(repoRoot));
    identities = resolveIdentities(
      repoRoot,
      input.values["gates"],
      reviewerNames,
      approverNames,
    );
  } catch (error) {
    // A malformed ref, a missing registry, a missing identity source: all are
    // "you asked the wrong question", not "the answer is not-ready". Reporting
    // them as a verdict would put a readiness claim on a PR nobody looked at.
    io.err(`${PROGRAM}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  // `--approvers` is READ only on the flags identity branch (`identitiesFromFlags`,
  // above) -- when a gates file resolved instead, the file's own
  // `default_approvers` decides and the flag is silently unreachable code with
  // no diagnostic. Loud rather than silent: a caller who typed `--approvers` and
  // sees it ignored needs to know the identity source won, not guess.
  const flagWarnings: string[] =
    identities.source === "schema" && approversFlag !== undefined
      ? [
          `--approvers is read only when reviewer identities come from --reviewers; identities came from '${identities.path ?? "?"}' instead, so --approvers was ignored.`,
        ]
      : [];

  const opened = deps.openSource(input.values["token-env"] ?? DEFAULT_TOKEN_ENV);
  if (!opened.ok) {
    return emit(
      io,
      json,
      explain,
      unevaluatedReport(
        ref,
        deps.now(),
        deps.executable(),
        identities,
        policy,
        excludeRun,
        flagWarnings,
        "no usable token, so GitHub could not be read",
        opened.message,
      ),
    );
  }

  let fetched;
  try {
    fetched = await fetchPrState(opened.source, ref, ref.number, {
      identities: identities.identities,
      reviewersCsv,
      policy,
      excludeRun,
      maxThreadPages: MAX_THREAD_PAGES,
      maxRollupPages: MAX_ROLLUP_PAGES,
      maxReviewRequestPages: MAX_REVIEW_REQUEST_PAGES,
    });
  } catch (error) {
    // A network failure, a 403 from a token without checks:read, an
    // unauthenticated read: SKILL.md § 4's list, and its classification.
    return emit(
      io,
      json,
      explain,
      unevaluatedReport(
        ref,
        deps.now(),
        deps.executable(),
        identities,
        policy,
        excludeRun,
        flagWarnings,
        `GitHub could not be read (${error instanceof Error ? error.message : String(error)})`,
        "Check the token's grants (pull-requests:read AND checks:read AND actions:read), that it is not expired, and that the network reached github.com. Never read this as ready.",
      ),
    );
  }

  if (!fetched.ok) {
    return emit(
      io,
      json,
      explain,
      unevaluatedReport(
        ref,
        deps.now(),
        deps.executable(),
        identities,
        policy,
        excludeRun,
        flagWarnings,
        fetched.reason,
        fetched.remedy,
      ),
    );
  }

  const evaluation: ReadyEvaluation = evaluateReady(identities.identities, fetched.state, {
    roundPolicyDefault: policy,
    stallMinutes: STALL_MINUTES,
    now: deps.now(),
  });

  const report: ReadyReport = {
    contract: CONTRACT,
    verdict: evaluation.ready ? "ready" : "not-ready",
    gateLine: evaluation.line,
    firstFailing: evaluation.firstFailing,
    conjuncts: evaluation.conjuncts,
    caveats: CAVEATS,
    remedy: null,
    meta: {
      ref: ref.typed,
      repo: `${ref.owner}/${ref.repo}`,
      pr: ref.number,
      headSha: evaluation.context.headSha === "" ? null : evaluation.context.headSha,
      reviewers: evaluation.context.reviewers,
      approvers: evaluation.context.approvers,
      approvalPolicy: evaluation.context.approvalPolicy,
      roundPolicy: evaluation.context.policy,
      excludeRun: excludeRun === "" ? null : excludeRun,
      deliveryPr: evaluation.context.deliveryPr,
      identities: { source: identities.source, path: identities.path },
      dependabotCarveOut: evaluation.context.dependabotCarveOut,
      warnings: [...flagWarnings, ...fetched.warnings],
      evaluatedAt: deps.now(),
      generator: { program: PROGRAM, version: VERSION, executable: deps.executable() },
    },
  };
  return emit(io, json, explain, report);
}

function splitCsv(csv: string): string[] {
  return csv
    .split(",")
    .map((name): string => name.trim())
    .filter((name): boolean => name !== "");
}

function unevaluatedReport(
  ref: ResolvedRef,
  now: string,
  executable: string,
  identities: ResolvedIdentities,
  policy: RoundPolicy,
  excludeRun: string,
  warnings: readonly string[],
  reason: string,
  remedy: string,
): ReadyReport {
  return {
    contract: CONTRACT,
    verdict: "unevaluated",
    // The whole line, so a consumer that only quotes `gateLine` still says
    // `unevaluated` rather than something that could be mistaken for a verdict.
    gateLine: `unevaluated: ${reason}`,
    firstFailing: null,
    // NOT ONE ROW IS `ready`. The gate did not run; nothing about this pull
    // request was established, and a table with green rows in it would be a
    // claim about evidence nobody read.
    conjuncts: evaluateReady(identities.identities, {}, {
      roundPolicyDefault: policy,
      stallMinutes: STALL_MINUTES,
      now,
    }).conjuncts.map((conjunct): Conjunct => ({ ...conjunct, status: "unevaluated", reason: null })),
    caveats: CAVEATS,
    remedy,
    meta: {
      ref: ref.typed,
      repo: `${ref.owner}/${ref.repo}`,
      pr: ref.number,
      headSha: null,
      // Read off the RESOLVED identities, never off the raw flags: on the
      // schema path the flags are not what the gate would apply at all (the
      // file's own base_reviewers/default_approvers are), and reporting the
      // raw flags there would make `meta.reviewers`/`meta.approvers` mean a
      // different thing depending on which branch produced the report --
      // exactly what the decided path avoids by reading `evaluation.context`.
      reviewers: identities.identities.baseReviewers,
      approvers: identities.identities.defaultApprovers,
      approvalPolicy: identities.identities.approvalPolicy,
      roundPolicy: policy,
      excludeRun: excludeRun === "" ? null : excludeRun,
      deliveryPr: null,
      identities: { source: identities.source, path: identities.path },
      // The gate never ran, so it never asked -- `false` here would read as
      // "asked and no", which is a claim about evidence nobody looked at.
      dependabotCarveOut: null,
      warnings,
      evaluatedAt: now,
      generator: { program: PROGRAM, version: VERSION, executable },
    },
  };
}

function emit(io: Io, json: boolean, explain: boolean, report: ReadyReport): number {
  if (json) {
    // `--json` WINS over `--explain`: the JSON already carries the table and the
    // caveats `--explain` renders, so printing both would put a human report on
    // the stdout a program is parsing.
    io.out(JSON.stringify(report, null, 2));
  } else if (explain) {
    for (const line of renderExplain(report)) io.out(line);
  } else {
    // The default is the SHELL GATE'S OWN LINE, prefixed with the repository the
    // ref resolved to. Quotable as-is, which is what SKILL.md § 3 asks a caller
    // to do with it.
    io.out(`${report.meta.repo}#${report.meta.pr}: ${report.gateLine}`);
  }
  if (report.verdict === "unevaluated" && !json) {
    io.err(
      `${PROGRAM}: this pull request could NOT be evaluated, which is a finding and never a pass. ${report.remedy ?? ""}`,
    );
  }
  return report.verdict === "ready" ? 0 : 1;
}
