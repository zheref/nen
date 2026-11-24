// src/pr/version_collision.ts -- the ONE plugin-version collision evaluator
// (zheref/nen#663).
//
// THE PROBLEM. A repository that uses its plugin version as a cache key needs
// every delivery to publish a DISTINCT version. Two pull requests that each
// passed their checks can land the same version in sequence, and a head
// whose checks went green before its base took the version it proposes is
// still green afterwards: nothing about the head moved. So the decision has
// to be LIVE -- read against the base as it is now, and against every other
// open pull request -- and it has to be ONE decision, shared by `nen pr
// ready` (folded into CON-32(a)'s row as a limb) and the narrow trusted-CI
// verb `nen pr version-collision` (../verbs/pr_version_collision.ts).
//
// TWO HALVES, ON PURPOSE. `readVersionCollision` gathers the evidence -- every
// read is read-only, counted against one budget, and any read that fails, is
// capped or is not offered by the transport becomes a named MISSING piece;
// `decideVersionCollision` is pure and turns the evidence into one of four
// statuses. Neither surface decides anything of its own.
//
//   not-applicable  the default-branch tip's nen/gates.json declares no
//                   `version_collision`, or the pull request changes no
//                   shipped path;
//   clear           the proposed version is on no target tip and proposed by
//                   no other same-repository open pull request;
//   collision       it is (AC-1, AC-2, AC-3), each conflict named;
//   unknown         a piece of evidence is missing, capped, over budget or
//                   moved during inspection (AC-5). Never clear, never ready.
//
// THE POLICY IS THE DEFAULT BRANCH'S (the issue's AS-2). It is read at the
// pinned default-branch tip only; a copy at the pull request's base, in the
// checkout or under `--gates` is compared with it and a difference WARNS --
// the head can never opt itself out, and a base that has not merged the
// opt-in yet cannot opt itself in. ONE RULE, FAILING CLOSED: a default tip
// with no gates file (a clean 404) has not opted in; a default tip whose file
// cannot be READ, or exists and cannot be PARSED or VALIDATED by this build,
// is unknown whatever any other copy says. The other copies only ever warn.
//
// NOTHING HERE EXECUTES PULL REQUEST CONTENT. A manifest is read as text and
// parsed as JSON; the version is found by an RFC 6901 pointer, never by a
// pattern, and compared by a linear SemVer split. A FORK head never blocks:
// an outsider could otherwise grief a repository by opening a pull request
// that claims the next number. It is named in a warning instead.

import { readFileSync } from "node:fs";
import type { PrRef, PrStateSource } from "../github/pr_state.js";
import type { BaseGatesRead } from "../gates/base_exclusions.js";
import {
  findDuplicateKey,
  parseGatesText,
  parseVersionCollision,
  type VersionCollisionPolicy,
} from "../schema/gates.js";
import { matchesAnyGlob } from "../shu/evidence/glob.js";
import type {
  VersionCollisionEntry,
  VersionCollisionResult,
  VersionCollisionStatus,
} from "../gates/version_collision_result.js";

export type { VersionCollisionPolicy } from "../schema/gates.js";

// The result TYPES live in ../gates/version_collision_result.ts so the pure
// gate (../gates/ready.ts) reads them without importing from src/pr: the
// layering runs src/pr -> src/gates, never back (Chrollo F2).
export type {
  VersionCollisionEntry,
  VersionCollisionLimb,
  VersionCollisionResult,
  VersionCollisionStatus,
} from "../gates/version_collision_result.js";

/** What a caller gets: the result, and whether the repository opted in at all. */
export interface VersionCollisionOutcome {
  /** `false` -- the default tip was read and declares no opt-in: the limb is absent and the output stays as it was. */
  readonly optedIn: boolean;
  readonly result: VersionCollisionResult;
}

/** The caps (zheref/nen#663 design): 10 cursor pages of 100 open pull requests, 3000 files per PR, 200 requests. */
export interface VersionCollisionLimits {
  readonly maxPages: number;
  readonly perPage: number;
  readonly maxFiles: number;
  readonly budget: number;
}

export const VERSION_COLLISION_LIMITS: VersionCollisionLimits = { maxPages: 10, perPage: 100, maxFiles: 3000, budget: 200 };

// ── the policy, from the default-branch tip ─────────────────────────────────

/** One diagnostic copy of `nen/gates.json`: `undefined` policy means it could not be read or parsed. */
export interface PolicyCopy {
  readonly label: string;
  readonly policy: VersionCollisionPolicy | null | undefined;
}

/** One read of a `nen/gates.json` copy, named for every message about it. */
export interface GatesCopyRead {
  readonly label: string;
  readonly where: string;
  readonly read: BaseGatesRead;
}

export type PolicyResolution =
  | { readonly kind: "declared"; readonly policy: VersionCollisionPolicy; readonly source: string; readonly warnings: readonly string[] }
  | { readonly kind: "undeclared"; readonly source: string; readonly warnings: readonly string[] }
  | { readonly kind: "unknown"; readonly source: string; readonly missing: string; readonly warnings: readonly string[] };

/** `version_collision` out of one read of `nen/gates.json`: the block or `null`, or why it could not be had. */
export function policyFromRead(
  where: string,
  read: BaseGatesRead,
):
  | { readonly kind: "read"; readonly policy: VersionCollisionPolicy | null }
  | { readonly kind: "unread"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string } {
  if (read.kind === "absent") return { kind: "read", policy: null };
  if (read.kind === "failed") return { kind: "unread", message: read.message };
  try {
    return { kind: "read", policy: parseVersionCollision(where, parseGatesText(where, read.text)) };
  } catch (error) {
    return { kind: "refused", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The DIAGNOSTIC copies, built one way for both surfaces (SC-1): the pull
 * request's base (unless it is the default tip itself) and the caller's own
 * file -- the checkout's, or `pr ready --gates`. Each only ever warns.
 */
export function collectPolicyCopies(
  defaultTip: { readonly where: string },
  base: { readonly where: string; readonly read: BaseGatesRead } | undefined,
  local: GatesCopyRead | null,
): PolicyCopy[] {
  const copies: PolicyCopy[] = [];
  const copy = (label: string, where: string, read: BaseGatesRead): PolicyCopy => {
    const parsed = policyFromRead(where, read);
    return { label, policy: parsed.kind === "read" ? parsed.policy : undefined };
  };
  if (base !== undefined && base.where !== defaultTip.where) copies.push(copy(`the pull request's base (${base.where})`, base.where, base.read));
  if (local !== null) copies.push(copy(local.label, local.where, local.read));
  return copies;
}

/** A local file as a diagnostic copy's read: its text, `absent`, or why it could not be read. */
export function readLocalGatesCopy(label: string, path: string): GatesCopyRead {
  try {
    return { label, where: path, read: { kind: "read", text: readFileSync(path, "utf8") } };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { label, where: path, read: code === "ENOENT" ? { kind: "absent" } : { kind: "failed", message: String(code ?? error) } };
  }
}

/** A copy as one stable string, for the difference warning. */
function policyKey(policy: VersionCollisionPolicy | null): string {
  return policy === null ? "none" : JSON.stringify([policy.versionFile, policy.versionPointer, policy.shippedPaths]);
}

function describePolicy(policy: VersionCollisionPolicy | null): string {
  return policy === null
    ? "no version_collision"
    : `version_collision ${policy.versionFile} ${policy.versionPointer} over ${policy.shippedPaths.join(", ")}`;
}

/**
 * Decide WHICH policy applies: the default-branch tip's, alone, failing
 * closed (zheref/nen#663 review round 1, A). No file there (a clean 404) is
 * no opt-in. A file that could not be read, or that this build cannot parse
 * or validate (malformed JSON, a refused `version_collision`, an unknown key,
 * a newer `version`), is UNKNOWN naming the read or the pointer -- whatever
 * any other copy declares. The copies only add a warning when they differ.
 */
export function resolveCollisionPolicy(
  defaultTip: { readonly where: string; readonly read: BaseGatesRead },
  copies: readonly PolicyCopy[],
): PolicyResolution {
  const atDefault = policyFromRead(defaultTip.where, defaultTip.read);
  if (atDefault.kind === "unread") {
    return {
      kind: "unknown",
      source: defaultTip.where,
      missing: `the version_collision policy: the default-branch tip's nen/gates.json (${defaultTip.where}) could not be read (${atDefault.message})`,
      warnings: [],
    };
  }
  if (atDefault.kind === "refused") {
    return {
      kind: "unknown",
      source: defaultTip.where,
      missing: `the version_collision policy: the default-branch tip's nen/gates.json was refused by this build (${atDefault.message})`,
      warnings: [],
    };
  }
  const warnings = copies
    .filter((copy): boolean => copy.policy !== undefined && policyKey(copy.policy ?? null) !== policyKey(atDefault.policy))
    .map(
      (copy): string =>
        `version collision: ${copy.label} declares ${describePolicy(copy.policy ?? null)}, but the default-branch tip (${defaultTip.where}) declares ${describePolicy(atDefault.policy)}; only the default tip's copy applies (zheref/nen#663).`,
    );
  return atDefault.policy === null
    ? { kind: "undeclared", source: defaultTip.where, warnings }
    : { kind: "declared", policy: atDefault.policy, source: defaultTip.where, warnings };
}

// ── the version, read through a pointer ─────────────────────────────────────

/** One version read: a value, no file, a file with no usable version, or a failed read. */
export type VersionRead =
  | { readonly kind: "value"; readonly version: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unparseable"; readonly why: string }
  | { readonly kind: "unread"; readonly why: string };

const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_VERSION_LENGTH = 256;

/** The value an RFC 6901 pointer names in `text`, as a version string -- or why there is none. */
export function versionFromManifest(text: string, pointer: string): VersionRead {
  if (text.length > MAX_MANIFEST_BYTES) return { kind: "unparseable", why: `larger than ${MAX_MANIFEST_BYTES} bytes` };
  let value: unknown;
  try {
    // A repeated key is refused, never collapsed: JSON.parse keeps the LAST
    // and a reviewer of the file sees the first.
    const repeated = findDuplicateKey(text);
    if (repeated !== null) return { kind: "unparseable", why: `a repeated key '${repeated.key}' at ${repeated.pointer}` };
    value = JSON.parse(text);
  } catch (error) {
    return { kind: "unparseable", why: `not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  for (const raw of pointer.split("/").slice(1)) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value) && /^(0|[1-9][0-9]*)$/.test(token)) {
      value = value[Number(token)];
    } else if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, token)) {
      value = (value as Record<string, unknown>)[token];
    } else {
      return { kind: "unparseable", why: `no member at ${pointer}` };
    }
  }
  if (typeof value !== "string" || value === "") return { kind: "unparseable", why: `${pointer} is not a non-empty string` };
  if (value.length > MAX_VERSION_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return { kind: "unparseable", why: `${pointer} is not a printable version of at most ${MAX_VERSION_LENGTH} characters` };
  }
  return { kind: "value", version: value };
}

/**
 * A SemVer 2.0.0 version with its build metadata dropped, or `null` when it
 * is not one. A split, never one big regex: the text is the head's, and every
 * pattern below is a single character class with no nesting.
 */
function semverKey(version: string): string | null {
  const plus = version.indexOf("+");
  const main = plus === -1 ? version : version.slice(0, plus);
  if (plus !== -1 && !version.slice(plus + 1).split(".").every((id): boolean => /^[0-9A-Za-z-]+$/.test(id))) return null;
  const dash = main.indexOf("-");
  const core = dash === -1 ? main : main.slice(0, dash);
  const parts = core.split(".");
  if (parts.length !== 3 || !parts.every((part): boolean => /^(0|[1-9][0-9]*)$/.test(part))) return null;
  if (dash !== -1 && !main.slice(dash + 1).split(".").every((id): boolean => /^[0-9A-Za-z-]+$/.test(id) && !/^0[0-9]+$/.test(id))) return null;
  return main;
}

/** SemVer equality ignoring build metadata when both are SemVer; exact string equality otherwise. */
export function sameVersion(a: string, b: string): boolean {
  const left = semverKey(a);
  const right = semverKey(b);
  return left !== null && right !== null ? left === right : a === b;
}

// ── the evidence, and the pure decision ─────────────────────────────────────

/** The pull request being judged, as the caller's own read named it. */
export interface CollisionSubject {
  readonly number: number;
  /** The judged head; `""` when none was read. */
  readonly headSha: string;
  readonly baseRef: string;
  readonly defaultBranch: string;
}

/** One same-repository peer whose head proposes the subject's version, fully read. */
export interface CollisionPeer {
  readonly number: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly draft: boolean;
  readonly touchesShipped: boolean;
  /** Its own merge base already carried the version: it inherited it, and reserves nothing. */
  readonly inherited: boolean;
}

export interface VersionCollisionEvidence {
  readonly subject: CollisionSubject;
  /** Every failed, capped or over-budget read, in order. */
  readonly missing: readonly string[];
  /** What moved between the two passes. */
  readonly moved: readonly string[];
  /** `null` when unread (`missing` says why). */
  readonly subjectFiles: readonly string[] | null;
  readonly head: VersionRead | null;
  readonly baseTip: { readonly sha: string; readonly version: VersionRead } | null;
  /** `null` when the base IS the default branch, or unread. */
  readonly defaultTip: { readonly sha: string; readonly version: VersionRead } | null;
  readonly mergeBase: VersionRead | null;
  readonly peers: readonly CollisionPeer[];
}

export interface VersionCollisionDecision {
  readonly status: VersionCollisionStatus;
  readonly line: string;
  readonly proposedVersion: string | null;
  readonly collisions: readonly VersionCollisionEntry[];
  readonly missing: readonly string[];
  /** What the evidence showed that changes nothing but must be seen: a tip that publishes no version. */
  readonly warnings: readonly string[];
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function readWhy(read: VersionRead | null, label: string): string | null {
  if (read === null) return `${label} was not read`;
  if (read.kind === "unread") return read.why;
  return null;
}

/**
 * THE DECISION, pure. In order: no policy -> not applicable; the subject's
 * files unread -> unknown; no shipped path changed -> not applicable; no
 * usable version at the head -> unknown; anything moved between the passes ->
 * unknown; a target tip or a counted peer holding the version -> collision
 * (every one named); any other missing piece -> unknown; otherwise clear.
 */
export function decideVersionCollision(
  policy: VersionCollisionPolicy | null,
  evidence: VersionCollisionEvidence | null,
): VersionCollisionDecision {
  const none = { proposedVersion: null, collisions: [], missing: [], warnings: [] };
  if (policy === null || evidence === null) {
    return { status: "not-applicable", line: "not-applicable: the default-branch tip's nen/gates.json declares no version_collision", ...none };
  }
  if (evidence.subjectFiles === null) {
    const missing = evidence.missing.length > 0 ? evidence.missing : ["the pull request's changed files"];
    return { status: "unknown", line: `unknown: ${missing.join("; ")}`, proposedVersion: null, collisions: [], missing, warnings: [] };
  }
  if (!evidence.subjectFiles.some((file): boolean => matchesAnyGlob(file, policy.shippedPaths))) {
    return { status: "not-applicable", line: `not-applicable: the pull request changes no shipped path (${policy.shippedPaths.join(", ")})`, ...none };
  }
  const head = evidence.head;
  if (head === null || head.kind !== "value") {
    const why =
      head === null || head.kind === "unread"
        ? (readWhy(head, `${policy.versionFile} at the head`) ?? "")
        : head.kind === "absent"
          ? `the head ${short(evidence.subject.headSha)} carries no ${policy.versionFile}, so it proposes no version`
          : `the version at the head ${short(evidence.subject.headSha)} could not be parsed: ${policy.versionFile} ${head.why}`;
    const missing = [why, ...evidence.missing.filter((entry): boolean => entry !== why)];
    return { status: "unknown", line: `unknown: ${missing.join("; ")}`, proposedVersion: null, collisions: [], missing, warnings: [] };
  }
  const proposed = head.version;
  if (evidence.moved.length > 0) {
    const missing = [`moved during inspection: ${evidence.moved.join("; ")}`, ...evidence.missing];
    return { status: "unknown", line: `unknown: ${missing.join("; ")}`, proposedVersion: proposed, collisions: [], missing, warnings: [] };
  }
  const missing = [...evidence.missing];
  // Every APPLICABLE comparison input must be there, whatever the reader
  // recorded (round 2, N5): a null tip or merge base is evidence nobody read,
  // never "nothing to compare". (A tip read WITHOUT a version file is
  // different: that is evidence, and a named warning below.)
  const stackedBase = evidence.subject.baseRef !== evidence.subject.defaultBranch;
  const required: readonly [unknown, string][] = [
    [evidence.baseTip, `the live tip of the base branch '${evidence.subject.baseRef}' and its version`],
    [evidence.mergeBase, `the version at the pull request's merge base with '${evidence.subject.baseRef}'`],
    ...(stackedBase ? [[evidence.defaultTip, `the live tip of the default branch '${evidence.subject.defaultBranch}' and its version`] as [unknown, string]] : []),
  ];
  for (const [input, name] of required) if (input === null) missing.push(`${name} (not in the evidence)`);
  const warnings: string[] = [];
  const collisions: VersionCollisionEntry[] = [];
  const clauses: string[] = [];
  const tipVersion = (tip: { readonly sha: string; readonly version: VersionRead } | null, branch: string): string | null => {
    if (tip === null) return null;
    if (tip.version.kind === "value") return tip.version.version;
    // A tip with NO version file publishes no version: nothing there to
    // collide with -- said, never silent -- and the rest is still compared.
    if (tip.version.kind === "absent") {
      warnings.push(`version collision: the tip of '${branch}' (${short(tip.sha)}) carries no ${policy.versionFile}, so it publishes no version to collide with`);
    } else if (tip.version.kind === "unparseable") {
      missing.push(`the version at the tip of '${branch}' (${short(tip.sha)}) could not be parsed: ${policy.versionFile} ${tip.version.why}`);
    } else if (tip.version.kind === "unread" && !missing.includes(tip.version.why)) {
      missing.push(tip.version.why);
    }
    return null;
  };
  const baseVersion = tipVersion(evidence.baseTip, evidence.subject.baseRef);
  if (evidence.baseTip !== null && baseVersion !== null && sameVersion(proposed, baseVersion)) {
    collisions.push({ kind: "base", version: proposed, pr: null, head: evidence.baseTip.sha, baseRef: evidence.subject.baseRef, draft: null });
    clauses.push(`is already at the tip of '${evidence.subject.baseRef}' (${short(evidence.baseTip.sha)})`);
  }
  const defaultVersion = tipVersion(evidence.defaultTip, evidence.subject.defaultBranch);
  if (evidence.defaultTip !== null && defaultVersion !== null && sameVersion(proposed, defaultVersion)) {
    collisions.push({ kind: "base", version: proposed, pr: null, head: evidence.defaultTip.sha, baseRef: evidence.subject.defaultBranch, draft: null });
    clauses.push(`is already at the tip of the default branch '${evidence.subject.defaultBranch}' (${short(evidence.defaultTip.sha)})`);
  }
  // NOT BUMPED: the head carries its merge base's version, and the base tip
  // has since moved to another one. Merged, the version file keeps the base
  // tip's value -- a version the base already published -- so the delivery
  // would ship under a consumed number even though no tip equals the head.
  const mergeBase = evidence.mergeBase;
  if (mergeBase?.kind === "unread" && !missing.includes(mergeBase.why)) missing.push(mergeBase.why);
  if (
    mergeBase !== null &&
    mergeBase.kind === "value" &&
    sameVersion(proposed, mergeBase.version) &&
    evidence.baseTip !== null &&
    baseVersion !== null &&
    !sameVersion(proposed, baseVersion)
  ) {
    collisions.push({ kind: "unbumped", version: baseVersion, pr: null, head: evidence.baseTip.sha, baseRef: evidence.subject.baseRef, draft: null });
    clauses.push(
      `is unchanged from the pull request's merge base, so merged it would ship under '${evidence.subject.baseRef}''s ${baseVersion} (${short(evidence.baseTip.sha)}), already published`,
    );
  }
  const counted = evidence.peers.filter((peer): boolean => peer.touchesShipped && !peer.inherited);
  for (const peer of counted) {
    collisions.push({ kind: "peer", version: proposed, pr: peer.number, head: peer.headSha, baseRef: peer.baseRef, draft: peer.draft });
  }
  if (counted.length > 0) {
    clauses.push(
      `is also proposed by open pull request${counted.length === 1 ? "" : "s"} ${counted
        .map((peer): string => `#${peer.number}${peer.draft ? " (draft)" : ""}`)
        .join(", ")}`,
    );
  }
  if (collisions.length > 0) {
    // A collision proven by the evidence that WAS read stays a collision; what
    // was not read rides on the line too, never on the JSON alone.
    const unread = missing.length === 0 ? "" : `; also not read: ${missing.join("; ")}`;
    return { status: "collision", line: `collision: version ${proposed} ${clauses.join("; and ")}${unread}`, proposedVersion: proposed, collisions, missing, warnings };
  }
  if (missing.length > 0) {
    return { status: "unknown", line: `unknown: ${missing.join("; ")}`, proposedVersion: proposed, collisions: [], missing, warnings };
  }
  return {
    status: "clear",
    line: `clear: version ${proposed} is on no target tip and proposed by no other open pull request`,
    proposedVersion: proposed,
    collisions: [],
    missing: [],
    warnings,
  };
}

// ── the reader ──────────────────────────────────────────────────────────────

/** One open pull request as the inventory lists it. */
interface InventoryRow {
  readonly number: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly sameRepo: boolean;
  readonly draft: boolean;
}

const SHA = /^[0-9a-f]{40}$/i;

/** A request budget the whole evaluation shares, and the first read it refused. */
class Budget {
  reads = 0;
  exhaustedAt: string | null = null;
  constructor(readonly limit: number) {}
  /** Whether `cost` more requests fit; records the first refusal. */
  allows(cost: number, what: string): boolean {
    if (this.reads + cost <= this.limit) return true;
    this.exhaustedAt ??= what;
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Gather the evidence and decide -- the one entry point both surfaces call.
 * Read-only throughout: inventory pages, branch tips, merge bases, one file
 * per commit and the changed-file lists, each counted against `limits.budget`.
 */
export async function readVersionCollision(
  source: PrStateSource,
  repo: PrRef,
  subject: CollisionSubject,
  resolution: PolicyResolution,
  limits: VersionCollisionLimits = VERSION_COLLISION_LIMITS,
): Promise<VersionCollisionOutcome> {
  const budget = new Budget(limits.budget);
  const counters = { pages: 0, inspected: 0 };
  const warnings: string[] = [...resolution.warnings];
  const notes: string[] = [];
  const tips: { base: string | null; default: string | null } = { base: null, default: null };
  const finish = (
    status: VersionCollisionDecision,
    policy: VersionCollisionPolicy | null,
    source: string | null,
  ): VersionCollisionResult => ({
    status: status.status,
    line: status.line,
    judgedHead: subject.headSha === "" ? null : subject.headSha,
    base: { ref: subject.baseRef, sha: tips.base },
    default: { ref: subject.defaultBranch, sha: subject.baseRef === subject.defaultBranch ? tips.base : tips.default },
    policySource: source,
    policy,
    proposedVersion: status.proposedVersion,
    collisions: status.collisions,
    missing: status.missing,
    inventory: { pages: counters.pages, inspected: counters.inspected, reads: budget.reads, budget: budget.limit },
    warnings: [...warnings, ...status.warnings],
    notes,
  });

  if (resolution.kind === "undeclared") {
    return { optedIn: false, result: finish(decideVersionCollision(null, null), null, resolution.source) };
  }
  if (resolution.kind === "unknown") {
    const missing = [resolution.missing];
    return {
      optedIn: true,
      result: finish({ status: "unknown", line: `unknown: ${missing.join("; ")}`, proposedVersion: null, collisions: [], missing, warnings: [] }, null, resolution.source),
    };
  }
  const policy = resolution.policy;
  const missing: string[] = [];
  const moved: string[] = [];
  const decide = (evidence: VersionCollisionEvidence): VersionCollisionOutcome => {
    const withBudget =
      budget.exhaustedAt === null
        ? evidence
        : {
            ...evidence,
            missing: [
              ...evidence.missing,
              `the request budget (${budget.limit} requests) would be exceeded by reading ${budget.exhaustedAt}, so it was not read`,
            ],
          };
    return { optedIn: true, result: finish(decideVersionCollision(policy, withBudget), policy, resolution.source) };
  };
  const evidence = (partial: Partial<VersionCollisionEvidence>): VersionCollisionEvidence => ({
    subject,
    missing,
    moved,
    subjectFiles: null,
    head: null,
    baseTip: null,
    defaultTip: null,
    mergeBase: null,
    peers: [],
    ...partial,
  });

  // The subject's own changed files FIRST: a pull request that ships nothing
  // is not applicable, and needs no inventory at all.
  if (subject.headSha === "") {
    missing.push("the pull request's head commit (GitHub answered none)");
    return decide(evidence({}));
  }
  const files = await changedFiles(subject.number, `the pull request's (#${subject.number}) changed files`);
  if (files === null) return decide(evidence({}));
  if (!files.some((file): boolean => matchesAnyGlob(file, policy.shippedPaths))) return decide(evidence({ subjectFiles: files }));

  // Every read below needs these; a transport without one cannot judge.
  const absentMethods = (["fileAtRef", "openPullRequestsPage", "branchTip", "mergeBase"] as const).filter(
    (name): boolean => typeof source[name] !== "function",
  );
  if (absentMethods.length > 0) {
    for (const name of absentMethods) missing.push(`this transport cannot read ${METHOD_EVIDENCE[name]} (no ${name})`);
    return decide(evidence({ subjectFiles: files }));
  }

  const head = await versionAt(subject.headSha, `${policy.versionFile} at the head ${short(subject.headSha)}`);
  if (head.kind !== "value") return decide(evidence({ subjectFiles: files, head }));

  const baseTipSha = await tipOf(subject.baseRef, "base");
  tips.base = baseTipSha;
  const defaultTipSha = subject.defaultBranch === subject.baseRef ? baseTipSha : await tipOf(subject.defaultBranch, "default");
  tips.default = defaultTipSha;
  const baseTip = baseTipSha === null ? null : { sha: baseTipSha, version: await versionAt(baseTipSha, `${policy.versionFile} at the tip of '${subject.baseRef}'`) };
  const defaultTip =
    subject.defaultBranch === subject.baseRef || defaultTipSha === null
      ? null
      : { sha: defaultTipSha, version: await versionAt(defaultTipSha, `${policy.versionFile} at the tip of '${subject.defaultBranch}'`) };
  const subjectBase = await mergeBaseOf(subject.baseRef, subject.headSha, `the pull request's merge base with '${subject.baseRef}'`);
  // `null` when unread: `missing` (or the budget) already says why.
  const mergeBase: VersionRead | null =
    subjectBase === null ? null : await versionAt(subjectBase, `${policy.versionFile} at the pull request's merge base ${short(subjectBase)}`);

  const first = await inventory();
  const peers: CollisionPeer[] = [];
  if (first !== null) {
    const own = first.find((row): boolean => row.number === subject.number);
    if (own !== undefined && own.headSha.toLowerCase() !== subject.headSha.toLowerCase()) {
      moved.push(`the pull request's own head is ${short(own.headSha)} in the inventory, but ${short(subject.headSha)} was judged`);
    } else if (own !== undefined && own.baseRef !== subject.baseRef) {
      moved.push(`the pull request's own base is '${own.baseRef}' in the inventory, but '${subject.baseRef}' was judged`);
    }
    const forks: number[] = [];
    for (const row of first) {
      if (row.number === subject.number) continue;
      counters.inspected += 1;
      if (!row.sameRepo) {
        forks.push(row.number);
        continue;
      }
      const peerVersion = await versionAt(row.headSha, `${policy.versionFile} at #${row.number}'s head ${short(row.headSha)}`);
      if (peerVersion.kind === "unread") continue;
      if (peerVersion.kind === "unparseable") {
        notes.push(`version collision: #${row.number}'s ${policy.versionFile} could not be parsed (${peerVersion.why}), so it reserves no version`);
        continue;
      }
      if (peerVersion.kind === "absent" || !sameVersion(peerVersion.version, head.version)) continue;
      const peerFiles = await changedFiles(row.number, `#${row.number}'s changed files`);
      if (peerFiles === null) continue;
      const touchesShipped = peerFiles.some((file): boolean => matchesAnyGlob(file, policy.shippedPaths));
      if (!touchesShipped) {
        peers.push({ ...peerOf(row), touchesShipped, inherited: false });
        continue;
      }
      const peerBase = await mergeBaseOf(row.baseRef, row.headSha, `#${row.number}'s merge base with '${row.baseRef}'`);
      if (peerBase === null) continue;
      const atPeerBase = await versionAt(peerBase, `${policy.versionFile} at #${row.number}'s merge base ${short(peerBase)}`);
      if (atPeerBase.kind === "unread") continue;
      // An unparseable or absent merge-base manifest is NOT an inheritance:
      // nothing shows the version came from the base, so the peer counts.
      const inherited = atPeerBase.kind === "value" && sameVersion(atPeerBase.version, head.version);
      peers.push({ ...peerOf(row), touchesShipped, inherited });
    }
    if (forks.length > 0) {
      warnings.push(
        `version collision: open pull request${forks.length === 1 ? "" : "s"} ${forks.map((n): string => `#${n}`).join(", ")} ${forks.length === 1 ? "has a head" : "have heads"} in another repository (a fork); a fork head never blocks -- an outsider could otherwise claim the next version -- and was not inspected.`,
      );
    }
    // THE SECOND PASS: the inventory and both tips again, after every other
    // read. Anything that differs is a view that was not stable -- unknown,
    // never retried here.
    const second = await inventory();
    if (second !== null) moved.push(...inventoryDrift(first, second));
  }
  const baseAgain = await tipOf(subject.baseRef, "base");
  if (baseTipSha !== null && baseAgain !== null && baseAgain !== baseTipSha) {
    moved.push(`the tip of '${subject.baseRef}' moved from ${short(baseTipSha)} to ${short(baseAgain)}`);
  }
  if (subject.defaultBranch !== subject.baseRef) {
    const defaultAgain = await tipOf(subject.defaultBranch, "default");
    if (defaultTipSha !== null && defaultAgain !== null && defaultAgain !== defaultTipSha) {
      moved.push(`the tip of '${subject.defaultBranch}' moved from ${short(defaultTipSha)} to ${short(defaultAgain)}`);
    }
  }
  return decide(evidence({ subjectFiles: files, head, baseTip, defaultTip, mergeBase, peers }));

  // ── the reads, each counted ──

  async function changedFiles(number: number, label: string): Promise<string[] | null> {
    if (typeof source.pullRequestFiles !== "function") {
      missing.push(`this transport cannot read ${label} (no pullRequestFiles)`);
      return null;
    }
    // The list pages itself, up to maxFiles / perPage requests: reserve them all.
    if (!budget.allows(Math.ceil(limits.maxFiles / limits.perPage), label)) return null;
    let list: unknown[];
    try {
      list = await source.pullRequestFiles(repo, number);
    } catch (error) {
      budget.reads += 1;
      missing.push(`${label} could not be read (${errorText(error)})`);
      return null;
    }
    budget.reads += Math.max(1, Math.ceil(list.length / limits.perPage));
    if (list.length >= limits.maxFiles) {
      missing.push(`${label} reached the ${limits.maxFiles}-file cap, so the list may be incomplete`);
      return null;
    }
    const names: string[] = [];
    for (const entry of list) {
      const filename = typeof entry === "object" && entry !== null ? (entry as { filename?: unknown }).filename : undefined;
      if (typeof filename !== "string" || filename === "") {
        missing.push(`${label}: an entry carried no filename`);
        return null;
      }
      names.push(filename);
      const previous = (entry as { previous_filename?: unknown }).previous_filename;
      if (typeof previous === "string" && previous !== "") names.push(previous);
    }
    return names;
  }

  async function versionAt(sha: string, label: string): Promise<VersionRead> {
    const read = source.fileAtRef;
    if (read === undefined) return { kind: "unread", why: `${label}: this transport cannot read files at a commit (no fileAtRef)` };
    // A 404 costs two requests (the contents read, then the commit check).
    if (!budget.allows(2, label)) return { kind: "unread", why: `${label} was not read (the request budget would be exceeded)` };
    let text: string | null;
    try {
      text = await read.call(source, repo, policy.versionFile, sha);
    } catch (error) {
      budget.reads += 1;
      const why = `${label} could not be read (${errorText(error)})`;
      missing.push(why);
      return { kind: "unread", why };
    }
    budget.reads += text === null ? 2 : 1;
    return text === null ? { kind: "absent" } : versionFromManifest(text, policy.versionPointer);
  }

  async function tipOf(branch: string, which: "base" | "default"): Promise<string | null> {
    const label = `the live tip of the ${which === "base" ? "base branch" : "default branch"} '${branch}'`;
    if (branch === "") {
      pushOnce(`${label}: GitHub answered no branch name`);
      return null;
    }
    const read = source.branchTip;
    if (read === undefined || !budget.allows(1, label)) return null;
    try {
      const sha = await read.call(source, repo, branch);
      budget.reads += 1;
      return sha;
    } catch (error) {
      budget.reads += 1;
      pushOnce(`${label} could not be read (${errorText(error)})`);
      return null;
    }
  }

  async function mergeBaseOf(branch: string, head: string, label: string): Promise<string | null> {
    const read = source.mergeBase;
    if (read === undefined || !budget.allows(1, label)) return null;
    try {
      const sha = await read.call(source, repo, branch, head);
      budget.reads += 1;
      return sha;
    } catch (error) {
      budget.reads += 1;
      missing.push(`${label} could not be read (${errorText(error)})`);
      return null;
    }
  }

  // CURSOR pagination (round 2, N1): each page continues AFTER the last row
  // read, so a row closed or reopened between two page reads can never shift
  // another out of the walk -- an offset (`page=N`) could skip a same-repo
  // peer in BOTH passes while only fork rows churned.
  async function inventory(): Promise<InventoryRow[] | null> {
    const read = source.openPullRequestsPage;
    if (read === undefined) return null;
    const rows: InventoryRow[] = [];
    let cursor: string | null = null;
    for (let page = 1; page <= limits.maxPages; page += 1) {
      const label = `the open pull request inventory (page ${page})`;
      if (!budget.allows(1, label)) return null;
      let data: unknown;
      try {
        data = await read.call(source, repo, cursor);
      } catch (error) {
        budget.reads += 1;
        missing.push(`${label} could not be read (${errorText(error)})`);
        return null;
      }
      budget.reads += 1;
      counters.pages += 1;
      const connection = typeof data === "object" && data !== null ? (data as { nodes?: unknown; pageInfo?: unknown }) : null;
      const info = typeof connection?.pageInfo === "object" && connection.pageInfo !== null
        ? (connection.pageInfo as { hasNextPage?: unknown; endCursor?: unknown })
        : null;
      if (connection === null || !Array.isArray(connection.nodes) || info === null || typeof info.hasNextPage !== "boolean") {
        missing.push(`${label} was not a pull request connection with nodes and pageInfo`);
        return null;
      }
      for (const [index, entry] of connection.nodes.entries()) {
        const row = inventoryRow(entry);
        if (row === null) {
          missing.push(`${label} entry ${index} carried no number, head SHA, base branch, fork flag or (same-repository) head repository`);
          return null;
        }
        rows.push(row);
      }
      if (!info.hasNextPage) return rows;
      if (typeof info.endCursor !== "string" || info.endCursor === "") {
        missing.push(`${label} answered hasNextPage with no endCursor`);
        return null;
      }
      cursor = info.endCursor;
    }
    missing.push(
      `the open pull request inventory is capped: all ${limits.maxPages} pages of ${limits.perPage} were read and GitHub still answered hasNextPage, so more open pull requests may exist`,
    );
    return null;
  }

  function pushOnce(entry: string): void {
    if (!missing.includes(entry)) missing.push(entry);
  }
}

const METHOD_EVIDENCE: Readonly<Record<"fileAtRef" | "openPullRequestsPage" | "branchTip" | "mergeBase", string>> = {
  fileAtRef: "the version file at a commit",
  openPullRequestsPage: "the open pull request inventory",
  branchTip: "a branch's live tip",
  mergeBase: "a pull request's merge base",
};

function peerOf(row: InventoryRow): Omit<CollisionPeer, "touchesShipped" | "inherited"> {
  return { number: row.number, headSha: row.headSha, baseRef: row.baseRef, draft: row.draft };
}

/** One GraphQL `pullRequests` node, or `null` when it lacks a field the comparison needs. */
function inventoryRow(entry: unknown): InventoryRow | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as {
    number?: unknown;
    isDraft?: unknown;
    isCrossRepository?: unknown;
    baseRefName?: unknown;
    headRefOid?: unknown;
    headRepository?: unknown;
  };
  if (typeof record.number !== "number" || !Number.isSafeInteger(record.number) || record.number <= 0) return null;
  if (typeof record.headRefOid !== "string" || !SHA.test(record.headRefOid)) return null;
  if (typeof record.baseRefName !== "string" || record.baseRefName === "") return null;
  // `isCrossRepository` IS the fork flag. Missing, it is malformed -- read as
  // a fork it would silently stop blocking. A same-repository row with no
  // head repository is malformed too; on a fork row it is a deleted fork.
  if (typeof record.isCrossRepository !== "boolean") return null;
  if (!("headRepository" in record)) return null;
  if (!record.isCrossRepository && (typeof record.headRepository !== "object" || record.headRepository === null)) return null;
  return {
    number: record.number,
    headSha: record.headRefOid,
    baseRef: record.baseRefName,
    sameRepo: !record.isCrossRepository,
    draft: record.isDraft === true,
  };
}

/** Every (number, head, base) difference between the two inventory passes, same-repository rows only. */
function inventoryDrift(first: readonly InventoryRow[], second: readonly InventoryRow[]): string[] {
  // SAME-REPOSITORY rows only (Feitan, round 1): a fork never blocks, so a
  // fork opened, pushed or closed mid-evaluation must not turn the result
  // unknown either -- that would be the griefing the fork rule closes.
  const own = (rows: readonly InventoryRow[]): Map<number, InventoryRow> =>
    new Map(rows.filter((row): boolean => row.sameRepo).map((row): [number, InventoryRow] => [row.number, row]));
  const before = own(first);
  const after = own(second);
  const drift: string[] = [];
  for (const [number, row] of before) {
    const now = after.get(number);
    if (now === undefined) drift.push(`#${number} left the open inventory`);
    else if (now.headSha !== row.headSha) drift.push(`#${number}'s head moved from ${short(row.headSha)} to ${short(now.headSha)}`);
    else if (now.baseRef !== row.baseRef) drift.push(`#${number}'s base moved from '${row.baseRef}' to '${now.baseRef}'`);
  }
  for (const number of after.keys()) if (!before.has(number)) drift.push(`#${number} opened during inspection`);
  return drift;
}

/** The `--explain` lines both surfaces print for one result. */
export function renderVersionCollisionDetail(result: VersionCollisionResult): string[] {
  return [
    `version collision policy: ${result.policySource ?? "(none read)"}${
      result.policy === null ? "" : ` · ${result.policy.versionFile} ${result.policy.versionPointer} · shipped ${result.policy.shippedPaths.join(", ")}`
    }`,
    `version collision reads: ${result.inventory.reads} of ${result.inventory.budget} requests · ${result.inventory.pages} inventory page(s) · ${result.inventory.inspected} open pull request(s) inspected`,
  ];
}
