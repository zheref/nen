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
//                            `schemas/gates.json` yet, and the shadow window has
//                            to be able to state the identities the shell gate
//                            decides with in order to compare verdicts at all.
//   2. `schemas/gates.json`  under the target repo root (`--repo`, else cwd).
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
// `<CODE>#<N>` resolved through the target repo's `schemas/repos.json`
// `product_codes` (case-insensitive, the `#` optional), or a bare `<N>` with an
// explicit `--gh-repo owner/name`. A BARE NUMBER WITH NO REPO IS AN ERROR rather
// than an assumption that it means the current directory's repository -- the
// skill's own rule, and the class of shortcut it exists to prevent. The full
// object-notation engine is zheref/nen#3's; this resolution is deliberately
// internal and simple so that it can be REPLACED by that engine rather than
// competed with.

import { existsSync, readFileSync } from "node:fs";
import { evaluateReady, CAVEATS, type Conjunct, type ReadyEvaluation } from "../gates/ready.js";
import type { RoundPolicy } from "../gates/predicates.js";
import { createClient, tokenFromEnv } from "../github/client.js";
import { fetchPrState, type PrRef, type PrStateSource } from "../github/pr_state.js";
import { assertRepoRoot } from "../repo/root.js";
import { SchemaError } from "../schema/errors.js";
import {
  parseGateIdentities,
  type GateIdentities,
  type ReviewerIdentity,
} from "../schema/gates.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { GATES_FILE, readSchemaJson, schemaPath } from "../schema/source.js";
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

export const PR_READY_USAGE = `  pr ready <ref>            Report a pull request's CON-32 readiness: the gate's
                            verdict, the first failing conjunct, nothing else.
                            Read-only -- it never labels, merges or comments.
      <ref>                   <CODE>#<N> via the target repo's product codes,
                              or a bare <N> with --gh-repo.
      --gh-repo <owner/name>  The repository, when the ref is a bare number.
      --explain               The conjunct table, in evaluation order, plus
                              what the gate does NOT decide.
      --reviewers <a,b,c>     The configured reviewer set (mirrors the shell
                              gate's flag). Also the identity source of last
                              resort -- see --gates.
      --approvers <a,b>       The approval set, when identities come from flags.
      --round-policy <p>      strict | bounded. Default bounded.
      --exclude-run <id>      Drop one Actions run's own checks (CON-36 clause 3;
                              pass it only from inside that run's own job).
      --gates <path>          Read reviewer identities from this gates file
                              instead of the target repo's schemas/gates.json.
      --token-env <VAR>       Environment variable holding the token.
                              Default GH_TOKEN; never picked up ambiently.`;

// A token is never read ambiently the way `gh` reads one; the caller names the
// variable, and this is only the DEFAULT NAME, not a fallback chain.
const DEFAULT_TOKEN_ENV = "GH_TOKEN";

// `${COPILOT_STALL_MINUTES:-30}` and `${MAX_THREAD_PAGES:-50}` -- the shell's
// two numeric knobs, at the shell's values. Operator settings, not PR data.
const STALL_MINUTES = 30;
const MAX_THREAD_PAGES = 50;

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
  /** Opens the transport. Returns a message instead of throwing on a bad token. */
  readonly openSource: (
    tokenEnvVar: string,
  ) => { readonly ok: true; readonly source: PrStateSource } | { readonly ok: false; readonly message: string };
}

export const defaultDeps: PrReadyDeps = {
  now: (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
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
  readonly roundPolicy: RoundPolicy;
  readonly excludeRun: string | null;
  readonly deliveryPr: boolean | null;
  readonly identities: { readonly source: "schema" | "flags"; readonly path: string | null };
  readonly warnings: readonly string[];
  readonly evaluatedAt: string;
  readonly generator: { readonly program: string; readonly version: string };
}

// ── ref resolution ──────────────────────────────────────────────────────────

export class RefError extends Error {}

export interface ResolvedRef extends PrRef {
  readonly number: number;
  readonly typed: string;
}

const CODED_REF = /^([A-Za-z][A-Za-z0-9]*)#?([0-9]+)$/;
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
 * pr-state skill's own grammar. An unknown code is an ERROR THAT NAMES THE VALID
 * ONES rather than a guess, and a bare number with no `--gh-repo` is an error
 * rather than an assumption about the current directory -- this verb is invoked
 * across repositories, and guessing which one is exactly the shortcut the skill
 * exists to prevent.
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
        `'${typed}' is a bare pull-request number and names no repository. Either write it as <CODE>#${typed} -- the code is resolved through the target repository's ${GATES_FILE.replace("gates", "repos")} -- or pass --gh-repo owner/name. Guessing the repository from the current directory is the one shortcut this verb refuses.`,
      );
    }
    return { ...explicit, number: Number.parseInt(typed, 10), typed };
  }

  const coded = CODED_REF.exec(typed);
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
  throw new RefError(
    `'${code}' is not a product code in the target repository's registry. Known codes: ${known.join(", ") || "(none)"}. Codes are resolved from the file at run time, never from memory -- they change.`,
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
 * repository without a `schemas/gates.json` actually uses. Fixed at the call
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
    baseReviewers: reviewers,
    delivery: { authorPattern: /(?!)/, headRefPrefixes: [], labels: [] },
    reviewer: (name): ReviewerIdentity | undefined => byName.get(name),
  };
}

// The same "an unparseable name matches NOTHING" reading every other layer
// takes: a malformed reviewer name can never SATISFY something, only fail to
// match it.
function safePattern(source: string): RegExp {
  try {
    return new RegExp(source, "i");
  } catch {
    return /(?!)/;
  }
}

export function resolveIdentities(
  repoRoot: string,
  gatesFlag: string | undefined,
  reviewers: readonly string[],
  approvers: readonly string[],
): ResolvedIdentities {
  if (gatesFlag !== undefined) {
    const text = readFileSync(gatesFlag, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new SchemaError(
        gatesFlag,
        null,
        `is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return { identities: parseGateIdentities(gatesFlag, value), source: "schema", path: gatesFlag };
  }
  const inRepo = schemaPath(repoRoot, GATES_FILE);
  if (existsSync(inRepo)) {
    // Same shaping as the `--gates <path>` branch above: a malformed
    // schemas/gates.json must fail as a path-bearing SchemaError, not as a bare
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
    `no reviewer identities. This gate never falls back to a built-in reviewer set: a binary that guessed the reviewers would judge this repository against another one's and report success. Give it one of: --gates <path>, a '${GATES_FILE}' in the target repository (looked for at '${inRepo}'), or --reviewers a,b,c.`,
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
  // `schemas/gates.json` yet). An omitted `--approvers` therefore defaults to
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
      roundPolicy: evaluation.context.policy,
      excludeRun: excludeRun === "" ? null : excludeRun,
      deliveryPr: evaluation.context.deliveryPr,
      identities: { source: identities.source, path: identities.path },
      warnings: [...flagWarnings, ...fetched.warnings],
      evaluatedAt: deps.now(),
      generator: { program: PROGRAM, version: VERSION },
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
      roundPolicy: policy,
      excludeRun: excludeRun === "" ? null : excludeRun,
      deliveryPr: null,
      identities: { source: identities.source, path: identities.path },
      warnings,
      evaluatedAt: now,
      generator: { program: PROGRAM, version: VERSION },
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
