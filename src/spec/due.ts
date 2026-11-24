// src/spec/due.ts -- `nen spec due`: per declared product family, is any member
// due a recapture? Each member's newest `v*` release tag is held against the
// commit the family's capture record holds for it (zheref/nen#673).
//
// FOUR ANSWERS PER FAMILY, AND "CURRENT" IS EARNED:
//
//   due          a member's newest release tag carries commits the recorded
//                commit does not (GitHub's compare says `ahead`, or `diverged`).
//   current      every member was read and none released since the capture.
//   no-capture   no member has a `capture/<CODE>/inventory.json` yet.
//   not-decided  some member could not be read -- its tags, its compare, or its
//                capture entry (absent while a sibling's is present, malformed,
//                or recording another repository's origin). Never current.
//
// THE CAPTURE RECORD is the committed `capture/<CODE>/inventory.json` of the
// spec checkout, read with diff.ts's own loader (the shape `spec inventory
// --out` writes); its `sha` is the recorded commit and its `origin` must be the
// repository the code resolves to through nen/repos.json (compared without
// case). It is the committed capture, not the local `hatsu.spec.run/v0.1` run
// record (zheref/nen#673 AS-1): that record is local state with no lookup from
// a family to its latest run.
//
// NEWER IS GITHUB'S ANSWER, NEVER A DATE. The newest tag is the highest
// `v<major>.<minor>.<patch>` by the comparator below (a prerelease or any other
// `v*` spelling is no release, and a `v*` tag outside that grammar -- a calendar
// version, `v1.2` -- leaves the member not read, since it cannot be ordered);
// whether it is newer than the recorded commit is
// `repos/{slug}/compare/{recorded}...{tag}`'s status, so a tag cut on an older
// commit after the capture is not mistaken for a release since it.
//
// READ-ONLY, ALWAYS. Every GitHub read is a `gh api` GET; nothing is written
// and no recapture is started -- that stays the maintainer's own typed command.

import { lstatSync } from "node:fs";
import { join } from "node:path";
import { looksLikeOwnerSlug } from "../repo/root.js";
import { GH, type Seams } from "../seam/exec.js";
import type { ProductFamily, RepoRegistry } from "../schema/repos.js";
import { resolveProductCode } from "../verbs/pr_ready.js";
import { assertInsideRepo, SpecContainmentError } from "./check.js";
import { InventoryReadError, loadInventory } from "./diff.js";

export const SPEC_DUE_CONTRACT = "nen.spec.due/v0.1";

export const DUE_ANSWERS = ["due", "current", "no-capture", "not-decided"] as const;
export type DueAnswer = (typeof DUE_ANSWERS)[number];
export type MemberState = "due" | "current" | "no-capture" | "not-read";
export type DueVerdict = DueAnswer | "no-family" | "could-not-read";
export type CompareStatus = "ahead" | "behind" | "identical" | "diverged";

export interface DueMember {
  readonly code: string;
  /** The `owner/name` the code names through `product_codes`; null when it does not resolve. */
  readonly repo: string | null;
  readonly platform: string | null;
  /** The capture entry, when the file exists; `sha` null when it could not be read. */
  readonly capture: { readonly file: string; readonly sha: string | null } | null;
  /** The newest release tag, when one was read. */
  readonly tag: { readonly name: string; readonly sha: string } | null;
  readonly compare: { readonly status: CompareStatus; readonly aheadBy: number; readonly behindBy: number } | null;
  readonly state: MemberState;
  readonly reason: string | null;
}

export interface DueFamily {
  readonly name: string;
  readonly answer: DueAnswer;
  readonly members: readonly DueMember[];
  readonly reason: string | null;
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface SpecDueReport {
  readonly contract: string;
  readonly verdict: DueVerdict;
  readonly repo: string;
  readonly families: readonly DueFamily[];
  readonly counts: Readonly<Record<DueAnswer, number>>;
  readonly reason: string | null;
}

/** A release tag: `v` and three dot-separated whole numbers, no leading zeros, no prerelease or build suffix. */
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PLAIN_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const HEX_SHA = /^[0-9a-f]{7,40}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

/** A prerelease tag: a release version with a `-suffix`; it is never the newest release. */
const PRERELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[0-9A-Za-z.-]+$/;

/**
 * The `v*` tags that are neither a release (`v1.2.3`) nor a prerelease (`v1.2.3-rc.1`): a calendar
 * version, `v1.2`, a floating `v1`, a build-metadata tag. They cannot be ordered against a release, so a
 * member carrying one cannot be said to be current (zheref/nen#673 AC-4); other names are not release tags.
 */
export function unorderedTags(tags: readonly Tag[]): string[] {
  return tags.map((tag): string => tag.name).filter((name): boolean => name.startsWith("v") && !RELEASE_TAG.test(name) && !PRERELEASE_TAG.test(name));
}

/** The version a release tag names, or null for a prerelease, a non-semver `v*` or any other tag (the last two are `unorderedTags`' business). */
export function releaseVersion(name: string): readonly [bigint, bigint, bigint] | null {
  const match = RELEASE_TAG.exec(name);
  if (match === null) return null;
  return [BigInt(match[1] as string), BigInt(match[2] as string), BigInt(match[3] as string)];
}

/** Semver precedence of two release versions: negative, zero or positive. */
export function compareVersions(a: readonly [bigint, bigint, bigint], b: readonly [bigint, bigint, bigint]): number {
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] as bigint;
    const right = b[index] as bigint;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

export interface Tag {
  readonly name: string;
  readonly sha: string;
}

/** The highest release tag of a list, or null when it holds none. */
export function newestRelease(tags: readonly Tag[]): Tag | null {
  let best: { tag: Tag; version: readonly [bigint, bigint, bigint] } | null = null;
  for (const tag of tags) {
    const version = releaseVersion(tag.name);
    if (version === null) continue;
    if (best === null || compareVersions(version, best.version) > 0) best = { tag, version };
  }
  return best?.tag ?? null;
}

class MemberUnread extends Error {}

/** Every tag of the repository, every page, through one read-only `gh api` call. */
function readTags(seams: Seams, slug: string): Tag[] {
  const result = seams.run(GH, ["api", "--paginate", "--slurp", `repos/${slug}/tags?per_page=100`]);
  if (result.spawnFailed) throw new MemberUnread("gh could not be started, so its tags were not read");
  if (result.code !== 0) throw new MemberUnread(`gh api repos/${slug}/tags failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch (error) {
    throw new MemberUnread(`gh api repos/${slug}/tags answered something that is not JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new MemberUnread(`gh api repos/${slug}/tags answered something that is not a list`);
  // --slurp wraps each page's array in one outer array.
  const entries = raw.every((page): boolean => Array.isArray(page)) ? (raw as unknown[][]).flat() : raw;
  return entries.map((entry, index): Tag => {
    const record = entry as { name?: unknown; commit?: { sha?: unknown } | null } | null;
    const name = record?.name;
    const sha = record?.commit?.sha;
    if (typeof name !== "string" || typeof sha !== "string" || !FULL_SHA.test(sha)) throw new MemberUnread(`gh api repos/${slug}/tags entry ${index} is not {name, commit: {sha}}`);
    return { name, sha };
  });
}

/** GitHub's comparison of the recorded commit (base) with the tag's (head). */
function readCompare(seams: Seams, slug: string, base: string, head: string): { status: CompareStatus; aheadBy: number; behindBy: number } {
  const path = `repos/${slug}/compare/${base}...${head}`;
  const result = seams.run(GH, ["api", path]);
  if (result.spawnFailed) throw new MemberUnread("gh could not be started, so the compare was not read");
  if (result.code !== 0) throw new MemberUnread(`gh api ${path} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  let raw: { status?: unknown; ahead_by?: unknown; behind_by?: unknown } | null;
  try {
    raw = JSON.parse(result.stdout) as typeof raw;
  } catch (error) {
    throw new MemberUnread(`gh api ${path} answered something that is not JSON: ${(error as Error).message}`);
  }
  const status = raw?.status;
  const aheadBy = raw?.ahead_by;
  const behindBy = raw?.behind_by;
  if ((status !== "ahead" && status !== "behind" && status !== "identical" && status !== "diverged") || !Number.isSafeInteger(aheadBy) || !Number.isSafeInteger(behindBy)) {
    throw new MemberUnread(`gh api ${path} answered no {status: ahead|behind|identical|diverged, ahead_by, behind_by}`);
  }
  return { status, aheadBy: aheadBy as number, behindBy: behindBy as number };
}

type CaptureRead = { readonly kind: "absent" } | { readonly kind: "read"; readonly sha: string; readonly origin: string | null } | { readonly kind: "unread"; readonly reason: string };

/** `capture/<CODE>/inventory.json` of the spec checkout, read with `spec diff`'s loader. */
function readCapture(repo: string, file: string): CaptureRead {
  const absolute = join(repo, file);
  try {
    if (lstatSync(absolute, { throwIfNoEntry: false }) === undefined) return { kind: "absent" };
    assertInsideRepo(repo, absolute, file);
    const loaded = loadInventory(absolute);
    if (loaded.sha === null) return { kind: "unread", reason: `${file} records no sha, so there is no recorded commit to compare` };
    if (!HEX_SHA.test(loaded.sha)) return { kind: "unread", reason: `${file} records sha '${loaded.sha}', which is not a 7-40 character hex commit` };
    return { kind: "read", sha: loaded.sha, origin: loaded.origin };
  } catch (error) {
    if (error instanceof InventoryReadError || error instanceof SpecContainmentError) return { kind: "unread", reason: error.message.replace(absolute, file) };
    // ENOTDIR (capture/<CODE> is a file), EACCES and the like: this member is unread, the other families still report.
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") return { kind: "unread", reason: `${file} could not be read (${code})` };
    throw error;
  }
}

const short = (sha: string): string => sha.slice(0, 12);

function resolveSlug(registry: RepoRegistry, code: string): { slug: string | null; reason: string | null } {
  try {
    const ref = resolveProductCode(code, registry, { explicitForm: (bare): string => `a full 'owner/${bare}' slug as the product_codes value` });
    const slug = `${ref.owner}/${ref.repo}`;
    return looksLikeOwnerSlug(slug) ? { slug, reason: null } : { slug: null, reason: `'${slug}' is not an owner/name slug` };
  } catch (error) {
    return { slug: null, reason: `code ${code} does not resolve through nen/repos.json: ${(error as Error).message}` };
  }
}

function dueFamily(seams: Seams, repo: string, registry: RepoRegistry, family: ProductFamily): DueFamily {
  const read = family.members.map((member) => {
    const file = `capture/${member.code}/inventory.json`;
    // A code is a registry key; one that is not a plain name is never joined into a path.
    const capture: CaptureRead = PLAIN_CODE.test(member.code) ? readCapture(repo, file) : { kind: "unread", reason: `member code '${member.code}' is not a plain name, so no capture path is formed from it` };
    return { member, file, capture, resolved: resolveSlug(registry, member.code) };
  });
  if (read.every((entry): boolean => entry.capture.kind === "absent")) {
    return {
      name: family.name,
      answer: "no-capture",
      members: read.map(({ member, resolved }): DueMember => ({ code: member.code, repo: resolved.slug, platform: member.platform, capture: null, tag: null, compare: null, state: "no-capture", reason: "no capture record" })),
      reason: `no capture exists: no member has a capture/<CODE>/inventory.json (${read.map((entry): string => entry.file).join(", ")})`,
    };
  }
  const members = read.map(({ member, file, capture, resolved }): DueMember => {
    const base = { code: member.code, repo: resolved.slug, platform: member.platform };
    const unread = (reason: string, captureSha: string | null, tag: Tag | null = null): DueMember => ({ ...base, capture: capture.kind === "absent" ? null : { file, sha: captureSha }, tag, compare: null, state: "not-read", reason });
    if (capture.kind === "absent") return unread(`${file} does not exist while a sibling member's capture does, so this member's recorded commit is unknown`, null);
    if (capture.kind === "unread") return unread(capture.reason, null);
    if (resolved.slug === null) return unread(resolved.reason ?? `code ${member.code} names no repository`, capture.sha);
    if (capture.origin?.toLowerCase() !== resolved.slug.toLowerCase()) return unread(`${file} records origin ${capture.origin ?? "(none)"}, not ${resolved.slug}, so it is not this member's capture`, capture.sha);
    let newest: Tag | null;
    let count: number;
    try {
      const tags = readTags(seams, resolved.slug);
      count = tags.length;
      const unordered = unorderedTags(tags);
      if (unordered.length > 0) return unread(`${unordered.length} v* tag(s) outside vMAJOR.MINOR.PATCH (${unordered.slice(0, 3).join(", ")}${unordered.length > 3 ? ", ..." : ""}), so the newest release cannot be ordered and nothing is assumed current`, capture.sha);
      newest = newestRelease(tags);
    } catch (error) {
      if (error instanceof MemberUnread) return unread(error.message, capture.sha);
      throw error;
    }
    const recorded = { file, sha: capture.sha };
    if (newest === null) return { ...base, capture: recorded, tag: null, compare: null, state: "current", reason: `no v<major>.<minor>.<patch> release tag (${count} tag(s) read), so nothing was released since the capture` };
    if (newest.sha === capture.sha) return { ...base, capture: recorded, tag: newest, compare: null, state: "current", reason: `${newest.name} is the recorded commit ${short(capture.sha)}` };
    let compare: { status: CompareStatus; aheadBy: number; behindBy: number };
    try {
      compare = readCompare(seams, resolved.slug, capture.sha, newest.sha);
    } catch (error) {
      if (error instanceof MemberUnread) return unread(error.message, capture.sha, newest);
      throw error;
    }
    const row = { ...base, capture: recorded, tag: newest, compare };
    switch (compare.status) {
      case "ahead":
        return { ...row, state: "due", reason: `${newest.name} (${short(newest.sha)}) is ${compare.aheadBy} commit(s) ahead of the recorded ${short(capture.sha)}` };
      case "diverged":
        return { ...row, state: "due", reason: `${newest.name} (${short(newest.sha)}) has diverged from the recorded ${short(capture.sha)}: ${compare.aheadBy} ahead, ${compare.behindBy} behind` };
      case "identical":
        return { ...row, state: "current", reason: `${newest.name} is identical to the recorded ${short(capture.sha)}` };
      case "behind":
        return { ...row, state: "current", reason: `${newest.name} is ${compare.behindBy} commit(s) behind the recorded ${short(capture.sha)}; nothing released since the capture` };
    }
  });
  const unreadCodes = members.filter((member): boolean => member.state === "not-read").map((member): string => member.code);
  const dueText = members.filter((member): boolean => member.state === "due").map((member): string => `${member.code} ${member.tag?.name ?? ""}`);
  if (unreadCodes.length > 0) {
    return { name: family.name, answer: "not-decided", members, reason: `not decided: ${unreadCodes.join(", ")} not read${dueText.length > 0 ? `; due already: ${dueText.join(", ")}` : ""}` };
  }
  if (dueText.length > 0) return { name: family.name, answer: "due", members, reason: `due a recapture: released since the capture -- ${dueText.join(", ")}` };
  return { name: family.name, answer: "current", members, reason: "no member released since the capture" };
}

const zeroCounts = (): Record<DueAnswer, number> => ({ due: 0, current: 0, "no-capture": 0, "not-decided": 0 });

/** The report over `families` (every declared one, or the one --family named). */
export function specDue(seams: Seams, repo: string, registry: RepoRegistry, families: readonly ProductFamily[]): SpecDueReport {
  const rows = families.map((family): DueFamily => dueFamily(seams, repo, registry, family));
  const counts = zeroCounts();
  for (const row of rows) counts[row.answer] += 1;
  const verdict: DueVerdict = rows.length === 0 ? "no-family" : counts["not-decided"] > 0 ? "not-decided" : counts.due > 0 ? "due" : counts["no-capture"] > 0 ? "no-capture" : "current";
  return { contract: SPEC_DUE_CONTRACT, verdict, repo, families: rows, counts, reason: rows.length === 0 ? "nen/repos.json declares no family under families[], so no family can be reported" : null };
}

export function unreadableDue(repo: string, reason: string): SpecDueReport {
  return { contract: SPEC_DUE_CONTRACT, verdict: "could-not-read", repo, families: [], counts: zeroCounts(), reason };
}

export function renderDue(report: SpecDueReport): string[] {
  if (report.verdict === "could-not-read") return [`could-not-read: ${report.reason ?? ""}`];
  const lines = [`${report.verdict}: ${report.families.length} family(ies) -- ${DUE_ANSWERS.map((answer): string => `${report.counts[answer]} ${answer}`).join(" · ")}`];
  if (report.reason !== null) lines.push(`  ${report.reason}`);
  for (const family of report.families) {
    lines.push(`  ${family.name}: ${family.answer}${family.reason === null ? "" : ` -- ${family.reason}`}`);
    if (family.answer !== "due" && family.answer !== "not-decided") continue;
    for (const member of family.members) {
      const tag = member.tag === null ? "no release tag" : `newest ${member.tag.name} (${short(member.tag.sha)})`;
      const recordedSha = member.capture?.sha ?? null;
      const recorded = recordedSha === null ? "no recorded commit" : `recorded ${short(recordedSha)}`;
      lines.push(`    ${member.code} ${member.repo ?? "(unresolved)"} ${member.state} · ${tag} · ${recorded}${member.reason === null ? "" : ` -- ${member.reason}`}`);
    }
  }
  return lines;
}
