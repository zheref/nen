// src/issue/privacy.ts -- refuse text that names a PRIVATE repository before it
// is written to a PUBLIC one (zheref/nen#329).
//
// WHY THE BINARY OWNS IT. A consumer's policy can forbid naming a private
// repository in a public issue, and drafts drift: public issue bodies named
// private repositories for weeks before anyone noticed. The only guard was a
// script every skill had to remember to pipe each title, body and comment
// through BEFORE calling nen -- so a skill that forgot, or a caller outside
// that one consumer, published unchecked. So the check lives where the write
// does: every verb that puts caller-written text on GitHub runs it before the
// write (zheref/nen#329 for `issue file`, `issue comment` and `issue
// edit-body`; zheref/nen#363 for the rest -- GUARDED_VERBS below is the list,
// and ./privacyguard.ts is the command-side adapter they share).
//
// THE BEHAVIOUR MATCHED is zheref/hatsu's `scripts/private_name_check.sh`:
//
//   - the list is the CREDENTIAL's live private list, `user/repos?visibility=
//     private`, every page, read on every call and never cached or written;
//   - each repository's NAME (the part after the owner) is matched,
//     case-insensitive and whole-word, taken literally. A word is a run of
//     [A-Za-z0-9-], so `name` inside `name-tools` is another word, while `_`
//     and `.` BOUND a word, failing closed: `_name_`, `__name__`, `my_name`,
//     `name.git` and a sentence's `name.` all match, and `owner/name` slugs and
//     URLs match through the name;
//   - EXCEPT A NAME THAT IS AN ORDINARY WORD (zheref/nen#535, the maintainer's
//     ruling of 2026-10-25): a private repository whose whole name equals a
//     word of the list embedded in the binary (./ordinary-words.ts) is matched
//     ONLY in the forms that name a repository -- `owner/name`, `name#N`,
//     `owner/name#N` and a URL path (`https://github.com/owner/name`) -- and
//     never as a bare word, so prose, a flag (`--name`) or a dotted identifier
//     (`a.b.name/v1`) using the word passes. A bare use is still REPORTED
//     (`ruled`, class `ordinary-word`), never silent, and never blocks. Any
//     other name keeps the bare-word match;
//   - a line holding `%`, `&`, `<`, `\`, `*`, a backtick or a non-ASCII
//     character is also read NORMALISED, twice (see `normalise` below), so a
//     name spelt through an escape, an entity, URL encoding, inline markup or an
//     invisible character is still a hit;
//   - the refusal NEVER prints the name: a hit is an index into the sorted list
//     and the line it was found on.
//
// THE IGNORE FILE, and only when the caller names it. `--private-names-ignore-
// file <path>` lists private repositories the caller has ruled too generic to
// police -- one per line, `#` comments and blanks ignored; a bare `name`
// exempts that name under every owner, an `owner/name` line that slug only,
// case-insensitive. No default path is ever read: an ignore list nen found on
// its own is an exemption nobody passed. An ignored hit is NEVER silent -- it is
// reported (stderr, and `ignored: true` under --json), it just does not block.
//
// THE NAMED LIST, and only when the `--repo` checkout declares it
// (zheref/nen#441). `nen/workflow.json` -> `privateNames.namedFile` names a
// COMMITTED file of private repositories whose NAME a recorded ruling made
// public while their code stays private (Hatsu's `scripts/private_name_named.txt`,
// the ruling of 2026-10-19). One exact `owner/name` per line, `#` comments and
// blanks ignored; a bare `name` is refused (exit 2), because a ruling names ONE
// repository and a bare name would exempt every owner's repository of that
// name -- so a same-named private repository under another owner is still a
// hit. It is read AT THE REMOTE'S DEFAULT BRANCH, never from the checkout: F8
// below holds for it exactly as for the ignore file, since a committed file is
// what a branch can edit. Both the ref and the path are decided there too
// (Feitan, this change's review): the checkout's `nen/workflow.json` is head
// content, so a branch that retargeted `branch.base` at itself, or declared
// its own `namedFile`, would otherwise make its own unmerged file "the base".
// So the checkout's declaration is only the SWITCH -- declared there, the read
// runs; undeclared, nothing is read -- and the SOURCE is
// `refs/remotes/origin/HEAD` (the remote's default branch, what git recorded
// at clone or `git remote set-head`): `nen/workflow.json` is shown at that
// ref, ITS `privateNames.namedFile` is the path, and the list is shown at the
// same ref. A line reaches the guard once merged to the default branch.
// Anything that cannot be read on that route names nothing (stricter, never
// looser) and the run says so. An exemption by either list
// is reported with WHICH list made it (`ignoredBy`, and `(named list)` or
// `(ignore file)` on the stderr line); when both exempt an entry the named
// list, the exact-slug one, is the one named.
//
// WHAT IS NOT CARRIED OVER, deliberately: the script's one named exemption (a
// marker quoted byte for byte by one consumer's generator). That is the
// consumer's policy, not a property of the check, and an exemption nen invented
// would be a hole nobody reviewed.
//
// FAIL CLOSED, ALWAYS. An unreadable target visibility, an unreadable list, a
// list that may be truncated, a list that reads EMPTY and a credential that
// cannot be shown to see every private repository (no `repo` in its
// X-OAuth-Scopes, zheref/nen#363) are each a refusal --
// a token that cannot see private repositories would otherwise read green, and
// "could not look" must never read the same as "found nothing".

import { existsSync, realpathSync } from "node:fs";
import { dirname, join as joinPath, resolve as resolvePath, sep } from "node:path";
import { GH, GIT, outputLines, type Seams } from "../seam/exec.js";
import { plainLine } from "../cli/plain.js";
import type { Target } from "../github/target.js";
import { SchemaError } from "../schema/errors.js";
import { parseWorkflow } from "../schema/workflow.js";
import { isOrdinaryWord, ORDINARY_WORD_CLASS, ORDINARY_WORD_RULE } from "./ordinary-words.js";

/** The exit code a private-name refusal answers with, in every verb that runs the check. */
export const PRIVATE_NAME_EXIT = 4;

/** The opt-out: the caller attests it ran its own check. Named in every run that uses it. */
export const SKIP_PRIVATE_NAME_CHECK_FLAG = "skip-private-name-check";

/**
 * EVERY VERB THAT RUNS THE GUARD, as the docs and the help name them
 * (zheref/nen#329, #363). One list, so a test can hold USAGE's guard section
 * to it: a verb added here and not documented there fails a test, never a
 * reader.
 */
export const GUARDED_VERBS: readonly string[] = [
  "issue file",
  "issue comment",
  "issue edit-body",
  "issue consolidate-close",
  "idea file",
  "pr open",
  "pr edit-body",
  "pr threads reply",
  "pr threads settle",
  "pr ledger post",
  "wake fire",
  "wake verify",
  "release-publish",
];

/**
 * The one member of `Seams` the check uses. Narrowed so a caller outside the
 * `Seams` world (src/dev/release-publish.ts, which carries its own runner) can
 * hand it an adapter rather than a fake of every seam.
 */
export type GuardSeams = Pick<Seams, "run">;

/** Page size asked of `user/repos`, and the size a full page is judged against. */
const PAGE_SIZE = 100;

/**
 * The most pages read before the list is called possibly-truncated -- 10,000
 * private repositories. Past it the run REFUSES rather than checking against a
 * partial list: a narrower list is a quieter guard.
 */
const MAX_PAGES = 100;

export type Visibility = "public" | "private" | "internal";

/**
 * How a hit matched (zheref/nen#535): `bare`, the name as a word on its own;
 * `repository-shaped`, as `owner/name`, `name#N` or a URL path naming it.
 */
export type HitForm = "bare" | "repository-shaped";

/** The class a name the ordinary-word rule narrowed carries; null for any other name. */
export type NameClass = typeof ORDINARY_WORD_CLASS;

/** One place a private name was found. `index` is 1-based into the sorted list. */
export interface PrivateNameHit {
  /** Which input carried it: `title` or `body`. */
  readonly field: string;
  /** 1-based line within that field. */
  readonly line: number;
  readonly index: number;
  /** True when it was found only once the line was normalised. */
  readonly normalised: boolean;
  /** True when the caller's ignore file or the committed named list exempts this name: reported, never blocking. */
  readonly ignored: boolean;
  /** Which list exempted it (zheref/nen#441); null when `ignored` is false. */
  readonly ignoredBy: ExemptionSource | null;
  /** How it matched (zheref/nen#535). An ordinary-word name only ever hits `repository-shaped`. */
  readonly form: HitForm;
  /** `ordinary-word` when the name is one (zheref/nen#535), else null. */
  readonly class: NameClass | null;
}

/**
 * A BARE use of an ordinary-word private name (zheref/nen#535): found, not
 * matched by rule, never blocking -- and never silent. Carries the same
 * coordinates a hit does and never the name. A line that also names the
 * repository in a repository-shaped form reports the hit there instead.
 */
export interface RuledOccurrence {
  readonly field: string;
  readonly line: number;
  readonly index: number;
  readonly normalised: boolean;
  readonly form: "bare";
  readonly class: NameClass;
}

/**
 * Which list exempted a hit: the caller's `--private-names-ignore-file`, or
 * the `--repo` checkout's committed named list (`privateNames.namedFile`).
 */
export type ExemptionSource = "ignore-file" | "named-list";

/**
 * The caller's ignore list: bare names (exempt under every owner) and
 * `owner/name` slugs (exempt for that repository only), both lowercase.
 */
export interface IgnoreList {
  readonly names: ReadonlySet<string>;
  readonly slugs: ReadonlySet<string>;
}

/**
 * Parse an ignore file's text: one entry per line, `#` to end of line a
 * comment, whitespace removed, blank lines skipped, compared lowercase.
 */
export function parseIgnoreList(text: string): IgnoreList {
  const names = new Set<string>();
  const slugs = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const entry = raw.replace(/#.*/, "").replace(/\s+/g, "").toLowerCase();
    if (entry === "") continue;
    if (entry.includes("/")) slugs.add(entry);
    else names.add(entry);
  }
  return { names, slugs };
}

/**
 * The committed named list (zheref/nen#441): exact `owner/name` slugs, lowercase.
 * Never bare names -- `parseNamedList` refuses them.
 */
export interface NamedList {
  readonly slugs: ReadonlySet<string>;
}

/**
 * A named-list line that is not an exact `owner/name`. Carries the LINE, never
 * the entry: a bare name there may itself be a private repository's name.
 */
export class NamedListError extends Error {
  readonly line: number;
  constructor(line: number) {
    super(
      `line ${line} is not an exact owner/name. A ruling names one repository; a bare name would exempt every owner's repository of that name, so only the exact slug belongs on the list (a same-named private repository under another owner stays a hit).`,
    );
    this.name = "NamedListError";
    this.line = line;
  }
}

/**
 * Parse the named list's text: one exact `owner/name` per line, `#` to end of
 * line a comment, surrounding whitespace removed, blank lines skipped,
 * compared lowercase. Any other line throws NamedListError naming its number.
 */
export function parseNamedList(text: string): NamedList {
  const slugs = new Set<string>();
  text.split(/\r?\n/).forEach((raw, offset): void => {
    const entry = raw.replace(/#.*/, "").trim();
    if (entry === "") return;
    if (!VALID_FULL_NAME.test(entry)) throw new NamedListError(offset + 1);
    slugs.add(entry.toLowerCase());
  });
  return { slugs };
}

/** The symbolic ref git keeps for the remote's default branch. */
export const REMOTE_HEAD_REF = "refs/remotes/origin/HEAD";

/**
 * The remote's default branch as a remote-tracking ref
 * (`refs/remotes/origin/main`), from `git symbolic-ref REMOTE_HEAD_REF`; null
 * when it is unset (a clone that never recorded it, `git remote set-head
 * origin --auto` sets it), unreadable, or not an `origin` ref.
 */
export function resolveRemoteDefaultRef(seams: GuardSeams, root: string): string | null {
  const result = seams.run(GIT, ["-C", root, "symbolic-ref", "-q", REMOTE_HEAD_REF]);
  if (result.spawnFailed || result.code !== 0) return null;
  const ref = result.stdout.trim();
  return /^refs\/remotes\/origin\/[^\s]+$/.test(ref) ? ref : null;
}

/**
 * A committed file's bytes at `<ref>:<path>`, or null when git cannot show
 * them (no such ref, no such path at it, git not startable). Null is "names
 * nothing", stricter than any list; the caller says so.
 */
export function showAtRef(seams: GuardSeams, root: string, ref: string, path: string): string | null {
  const result = seams.run(GIT, ["-C", root, "show", `${ref}:${path}`]);
  if (result.spawnFailed || result.code !== 0) return null;
  return result.stdout;
}

/** What the base-branch read answered: the list, or null with the reason it names nothing. */
export interface CommittedNamedListRead {
  readonly named: NamedList | null;
  /** The ref the list was read at, or null when none could be. */
  readonly ref: string | null;
  /** The path the DEFAULT BRANCH's policy declares, or null. */
  readonly path: string | null;
  /** One sentence, without a verb prefix, when `named` is null; "" otherwise. */
  readonly reason: string;
}

/**
 * The committed named list as the guard reads it (zheref/nen#441; Feitan's
 * finding on this change): the remote's default branch decides EVERYTHING --
 * the ref, the policy copy and the path -- and the checkout decides nothing
 * but whether to look. `declared` is the checkout's own `privateNames.namedFile`,
 * the switch; it is compared, never used as the path. A `nen/workflow.json`
 * at the ref that this build cannot parse names nothing, said. A list line that
 * is not an exact `owner/name` throws NamedListError (the caller's exit 2).
 */
export function readCommittedNamedList(seams: GuardSeams, root: string, declared: string): CommittedNamedListRead {
  const ref = resolveRemoteDefaultRef(seams, root);
  if (ref === null) {
    return {
      named: null,
      ref: null,
      path: null,
      reason: `${REMOTE_HEAD_REF} is not set in this checkout (git remote set-head origin --auto records the remote's default branch), so the committed named list is read nowhere`,
    };
  }
  const policyText = showAtRef(seams, root, ref, WORKFLOW_POLICY_PATH);
  if (policyText === null) {
    return { named: null, ref, path: null, reason: `${WORKFLOW_POLICY_PATH} is not at ${ref}, so no committed named list is declared there` };
  }
  let path: string | null;
  try {
    const value: unknown = JSON.parse(policyText);
    path = parseWorkflow(`${ref}:${WORKFLOW_POLICY_PATH}`, value).privateNames.namedFile;
  } catch (error) {
    const message = error instanceof SchemaError ? error.message : `${ref}:${WORKFLOW_POLICY_PATH} is not valid JSON`;
    return { named: null, ref, path: null, reason: `the policy at the default branch could not be read -- ${message}` };
  }
  if (path === null) {
    return {
      named: null,
      ref,
      path: null,
      reason: `${ref}:${WORKFLOW_POLICY_PATH} declares no privateNames.namedFile; the checkout's own declaration ('${declared}') is head content and decides nothing`,
    };
  }
  // A REGULAR FILE, proved before it is shown: `git show <ref>:<dir>` prints a
  // tree listing and a symlink's entry prints its target path, and either
  // would reach the parser as "line 1 is not an exact owner/name", which
  // misdirects the reader (Nobunaga, this change's review).
  const kind = objectKindAtRef(seams, root, ref, path);
  if (kind !== "file") {
    return {
      named: null,
      ref,
      path,
      reason:
        kind === "absent"
          ? `named list '${path}' is not at ${ref} (it is read at the remote's default branch, never from the checkout)`
          : `named list '${path}' at ${ref} is a ${kind}, not a regular file`,
    };
  }
  const text = showAtRef(seams, root, ref, path);
  if (text === null) {
    return { named: null, ref, path, reason: `named list '${path}' could not be shown at ${ref}` };
  }
  return { named: parseNamedList(text), ref, path, reason: "" };
}

/**
 * What `<ref>:<path>` is: a regular file (mode 100644/100755), a `tree`, a
 * `symlink`, a `submodule` (160000), or `absent` -- from `git ls-tree`, whose
 * first column is the mode. Anything unreadable is `absent`.
 */
export function objectKindAtRef(seams: GuardSeams, root: string, ref: string, path: string): "file" | "tree" | "symlink" | "submodule" | "absent" {
  const result = seams.run(GIT, ["-C", root, "ls-tree", ref, "--", path]);
  if (result.spawnFailed || result.code !== 0) return "absent";
  const line = outputLines(result.stdout)[0];
  if (line === undefined) return "absent";
  const mode = line.split(/\s+/)[0] ?? "";
  if (mode === "100644" || mode === "100755") return "file";
  if (mode === "040000") return "tree";
  if (mode === "120000") return "symlink";
  if (mode === "160000") return "submodule";
  return "absent";
}

/** Where a repository states its workflow policy, as ../schema/workflow.ts resolves it. */
const WORKFLOW_POLICY_PATH = "nen/workflow.json";

/** One field of text to check, named for the report. */
export interface CheckedText {
  readonly field: string;
  readonly text: string;
}

/**
 * The check's verdict, carried on every --json report of the three verbs.
 *
 * `checked`/`clean` -- the target is public and nothing matched.
 * `skipped-private-target` -- a private target: naming a private repository
 *   inside one leaks nothing, so the list is never read. An INTERNAL target is
 *   checked like a public one (zheref/nen#363, Feitan F9): the whole
 *   enterprise can read it.
 * `skipped-by-flag` -- the opt-out was given; nothing was read.
 * `refused` -- at least one hit; nothing was written.
 * `unavailable` -- the check could not be performed (visibility or list
 *   unreadable, empty or possibly truncated, a credential that cannot be
 *   shown to see every private repository, or every name on it ignored
 *   without --allow-all-ignored); nothing was written.
 */
export interface PrivateNameCheck {
  readonly result: "clean" | "skipped-private-target" | "skipped-by-flag" | "refused" | "unavailable";
  readonly targetVisibility: Visibility | null;
  /**
   * How many private repositories the list held, and under how many owners --
   * COUNTS ONLY, never a name. Null when the list was never read.
   */
  readonly listSize: number | null;
  readonly owners: number | null;
  readonly hits: readonly PrivateNameHit[];
  /**
   * Bare uses of ordinary-word private names the rule did not match
   * (zheref/nen#535): reported, never blocking. Empty when the text was not
   * checked.
   */
  readonly ruled: readonly RuledOccurrence[];
  /** Why the check could not be performed; null unless `unavailable`. */
  readonly error: string | null;
}

/** Thrown when the check cannot run. Never carries a private name. */
export class PrivateListUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateListUnavailableError";
  }
}

// --- reads -------------------------------------------------------------------

/**
 * The target's visibility, from `repos/{owner}/{name}`. Fail closed: a read
 * that fails, does not parse, or carries neither a known `visibility` nor a
 * boolean `private` throws. gh's own message is NOT echoed: it may name the
 * repository being asked about.
 */
export function readTargetVisibility(seams: GuardSeams, target: Target): Visibility {
  const result = seams.run(GH, ["api", `repos/${target.slug}`]);
  if (result.spawnFailed) {
    throw new PrivateListUnavailableError("gh could not be started, so the target's visibility could not be read");
  }
  if (result.code !== 0) {
    throw new PrivateListUnavailableError(`could not read the target's visibility (gh exited ${result.code})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new PrivateListUnavailableError("the target's repository read did not parse as JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new PrivateListUnavailableError("the target's repository read was not an object");
  }
  const record = parsed as Record<string, unknown>;
  const visibility = record["visibility"];
  if (typeof visibility === "string") {
    const lowered = visibility.toLowerCase();
    if (lowered === "public" || lowered === "private" || lowered === "internal") return lowered;
    throw new PrivateListUnavailableError("the target's visibility is not public, private or internal");
  }
  // An older server carries only the boolean. `false` reads as public, which is
  // the direction that CHECKS -- never the one that skips.
  const isPrivate = record["private"];
  if (typeof isPrivate === "boolean") return isPrivate ? "private" : "public";
  throw new PrivateListUnavailableError("the target's repository read carried no visibility");
}

/**
 * THE LIST MAY BE PARTIAL, and a partial list is a quieter guard (zheref/nen#363,
 * Feitan F7). A fine-grained PAT limited to selected repositories, a GitHub App
 * token, or an SSO-restricted token answers `user/repos?visibility=private`
 * with SOME private repositories, and a name it was never given reads clean.
 * Only a classic token proves its reach: `gh api -i user` answers an
 * `X-OAuth-Scopes` header, and `repo` in it means every private repository
 * the user can see. So the header must be present and name `repo`; absent (a
 * fine-grained or app token) or without `repo`, the check is unavailable --
 * the caller that has run its own check passes --skip-private-name-check.
 */
export function requireFullPrivateReach(seams: GuardSeams): void {
  const result = seams.run(GH, ["api", "-i", "user"]);
  if (result.spawnFailed) {
    throw new PrivateListUnavailableError("gh could not be started, so the credential's reach could not be read");
  }
  if (result.code !== 0) {
    throw new PrivateListUnavailableError(`could not read the credential's scopes (gh exited ${result.code})`);
  }
  let scopes: string | null = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim() === "") break;
    const match = /^x-oauth-scopes:(.*)$/i.exec(line);
    if (match !== null) scopes = match[1] ?? "";
  }
  if (scopes === null) {
    throw new PrivateListUnavailableError(
      "the private-repository list may be partial: the credential carries no X-OAuth-Scopes header (a fine-grained, app or CI token), so it cannot be shown to see every private repository",
    );
  }
  const granted = scopes.split(",").map((scope): string => scope.trim().toLowerCase());
  if (!granted.includes("repo")) {
    throw new PrivateListUnavailableError(
      "the private-repository list may be partial: the credential's scopes do not include 'repo', so it cannot be shown to see every private repository",
    );
  }
}

/**
 * The working tree a path sits inside, or null: the nearest ancestor of
 * `root` holding a `.git` entry (a directory, or a linked worktree's file).
 */
function workingTreeOf(root: string): string | null {
  let dir = resolvePath(root);
  for (;;) {
    if (existsSync(joinPath(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * AN IGNORE FILE INSIDE THE TREE UNDER REVIEW IS REFUSED (zheref/nen#363,
 * Feitan F8). The file exempts names; one the change under review can edit is
 * an exemption that change wrote for itself. Returns the reason when the
 * file's REAL path (symlinks resolved) lies inside the working tree holding
 * `root`, else null. A file that cannot be resolved is the reader's to refuse.
 */
export function ignoreFileInsideTree(path: string, root: string): string | null {
  const tree = workingTreeOf(root);
  if (tree === null) return null;
  let realFile: string;
  let realTree: string;
  try {
    realFile = realpathSync(path);
    realTree = realpathSync(tree);
  } catch {
    return null;
  }
  const inside = realFile === realTree || realFile.startsWith(realTree.endsWith(sep) ? realTree : `${realTree}${sep}`);
  return inside
    ? `the ignore file '${path}' lies inside the working tree '${tree}': a list the change under review can edit is an exemption it wrote for itself. Keep it outside the checkout (e.g. under your config directory).`
    : null;
}

/**
 * The credential's private repositories, as `owner/name`, sorted bytewise and
 * de-duplicated -- the order the refusal's indices point into. Every page is
 * read; a list that may be truncated, fails, or reads EMPTY throws.
 */
export function readPrivateList(seams: GuardSeams): readonly string[] {
  const names: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = seams.run(GH, ["api", `user/repos?visibility=private&per_page=${PAGE_SIZE}&page=${page}`]);
    if (result.spawnFailed) {
      throw new PrivateListUnavailableError("gh could not be started, so the private repository list could not be read");
    }
    if (result.code !== 0) {
      const first = outputLines(result.stderr)[0];
      throw new PrivateListUnavailableError(
        `gh could not list the credential's private repositories (${first === undefined ? `exit ${result.code}` : first})`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new PrivateListUnavailableError(`page ${page} of the private repository list did not parse as JSON`);
    }
    if (!Array.isArray(parsed)) {
      throw new PrivateListUnavailableError(`page ${page} of the private repository list was not an array`);
    }
    for (const entry of parsed) {
      const fullName = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>)["full_name"] : undefined;
      if (typeof fullName !== "string" || fullName === "") {
        throw new PrivateListUnavailableError(`page ${page} of the private repository list carried an entry with no full_name`);
      }
      // EXACTLY `owner/name`, both halves non-empty and whitespace-free. A
      // malformed entry (`owner/`, `a/b/c`, a bare name) would be dropped or
      // mis-split by the matcher and police nothing, so the whole list is
      // refused rather than checked with a hole in it. The value is not echoed:
      // it may be a private name.
      if (!VALID_FULL_NAME.test(fullName)) {
        throw new PrivateListUnavailableError(
          `page ${page} of the private repository list carried a malformed full_name (entry ${names.length + 1}; not exactly owner/name), so the list is not checked against`,
        );
      }
      names.push(fullName);
    }
    if (parsed.length < PAGE_SIZE) {
      if (names.length === 0) {
        throw new PrivateListUnavailableError(
          "the private repository list read EMPTY -- the credential may not see private repositories (gh auth status; the token needs the repo scope), so nothing would be checked",
        );
      }
      return sortedUnique(names);
    }
  }
  throw new PrivateListUnavailableError(
    `the private repository list filled ${MAX_PAGES} pages of ${PAGE_SIZE}; it may be truncated, so it is not checked against`,
  );
}

/** One slash, a non-empty whitespace-free owner and name on either side. */
const VALID_FULL_NAME = /^[^\s/]+\/[^\s/]+$/;

/** Bytewise (LC_ALL=C) sort, de-duplicated -- the order an index points into. */
function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((a, b): number => {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    return Buffer.compare(left, right);
  });
}

// --- matching ----------------------------------------------------------------

/**
 * A compiled matcher over one list: ONE REGEX PER NAME, and each lowercase
 * name's index.
 *
 * Per name, never one alternation: an alternation consumes the text it
 * matches, so a longer name (`vault.tools`, `my_vault`) hides every shorter
 * name it contains (`vault`) -- and when the longer one is ignored, the
 * shorter, still-policed one passed unseen. Each name is tested against the
 * whole line with its own boundary test, overlaps included, and exemptions
 * are applied only after every occurrence is found.
 */
export interface NameMatcher {
  /** The bare-word test, per lowercase name. */
  readonly patterns: ReadonlyMap<string, RegExp>;
  /**
   * The repository-shaped test, per lowercase name (zheref/nen#535): the name
   * after `<owner char>/` (`owner/name`, `owner/name#N`, a URL path), or
   * bounded before and followed by `#<digit>` (`name#N`).
   */
  readonly shaped: ReadonlyMap<string, RegExp>;
  /** Lowercase names that are ordinary words: matched by `shaped` only. */
  readonly ordinary: ReadonlySet<string>;
  readonly indexOf: ReadonlyMap<string, number>;
  /**
   * Each still-policed name's index: the FIRST entry carrying it that the
   * ignore list does not exempt. A blocking hit reports this one, so `#k`
   * resolves to the repository that actually blocked -- never to an exempt
   * twin that happens to sort first.
   */
  readonly policedIndexOf: ReadonlyMap<string, number>;
  /**
   * Lowercase names the ignore list or the named list exempts: a name is
   * exempt only when EVERY list entry carrying it is -- ignoring `a/thing`
   * leaves `b/thing` policed, and the two share one index, so the name still
   * blocks.
   */
  readonly ignored: ReadonlySet<string>;
  /**
   * Which list exempted the FIRST entry carrying each exempt name -- the entry
   * `index` points at. The named list is tried first, so an entry both lists
   * exempt reports the exact-slug one.
   */
  readonly exemptedBy: ReadonlyMap<string, ExemptionSource>;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/**
 * Compile the list. Each entry's NAME (after the `/`) is matched; the first
 * entry wins a case twin across owners, so they share one index.
 */
export function compileMatcher(
  list: readonly string[],
  ignore: IgnoreList | null = null,
  named: NamedList | null = null,
): NameMatcher {
  const indexOf = new Map<string, number>();
  const names: string[] = [];
  const policedIndexOf = new Map<string, number>();
  const exemptedBy = new Map<string, ExemptionSource>();
  list.forEach((entry, position): void => {
    const name = entry.replace(/^.*\//, "");
    const key = name.toLowerCase();
    if (name === "") return;
    const slug = entry.toLowerCase();
    // The named list holds exact slugs only, so it can never exempt a twin
    // under another owner; the ignore file's bare names can.
    const source: ExemptionSource | null =
      named !== null && named.slugs.has(slug)
        ? "named-list"
        : ignore !== null && (ignore.names.has(key) || ignore.slugs.has(slug))
          ? "ignore-file"
          : null;
    if (source === null && !policedIndexOf.has(key)) policedIndexOf.set(key, position + 1);
    if (indexOf.has(key)) return;
    indexOf.set(key, position + 1);
    if (source !== null) exemptedBy.set(key, source);
    names.push(name);
  });
  const ignored = new Set([...indexOf.keys()].filter((key): boolean => !policedIndexOf.has(key)));
  for (const key of exemptedBy.keys()) if (!ignored.has(key)) exemptedBy.delete(key);
  const patterns = new Map<string, RegExp>(
    names.map((name): [string, RegExp] => [
      name.toLowerCase(),
      new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(name)}(?![A-Za-z0-9-])`, "i"),
    ]),
  );
  // REPOSITORY-SHAPED (zheref/nen#535): the name right after `<owner char>/`
  // -- `owner/name`, `owner/name#N`, and every URL path naming it, since
  // `github.com/owner/name` holds `owner/name` -- or a bounded name followed
  // by `#<digit>`. A path segment `dir/name` reads as `owner/name`,
  // failing closed.
  const shaped = new Map<string, RegExp>(
    names.map((name): [string, RegExp] => {
      const escaped = escapeRegExp(name);
      return [
        name.toLowerCase(),
        new RegExp(`(?<=[A-Za-z0-9-]\\/)${escaped}(?![A-Za-z0-9-])|(?<![A-Za-z0-9-])${escaped}#[0-9]`, "i"),
      ];
    }),
  );
  const ordinary = new Set(names.filter(isOrdinaryWord).map((name): string => name.toLowerCase()));
  return { patterns, shaped, ordinary, indexOf, policedIndexOf, ignored, exemptedBy };
}

/**
 * Named HTML entities the normalised reading decodes -- the script's own
 * table. A MAP, never an object literal: `&constructor;` or `&toString;` must
 * not resolve through Object.prototype into a function's source text.
 */
const ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", " "],
  ["hyphen", "-"], ["dash", "-"], ["minus", "-"], ["ndash", "-"], ["mdash", "-"], ["lowbar", "_"],
  ["UnderBar", "_"], ["period", "."], ["sol", "/"], ["bsol", "\\"], ["colon", ":"], ["commat", "@"],
  ["num", "#"], ["percnt", "%"], ["shy", ""], ["zwsp", ""], ["zwj", ""], ["zwnj", ""], ["NewLine", " "],
]);

function codePoint(value: number): string {
  return value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff) ? "�" : String.fromCodePoint(value);
}

/** %XX decoded as BYTES, then the whole read as UTF-8 (invalid sequences become U+FFFD). */
function percentDecode(line: string): string {
  const source = Buffer.from(line, "utf8");
  const bytes: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const byte = source[i] as number;
    if (byte === 0x25 && i + 2 < source.length) {
      const hex = String.fromCharCode(source[i + 1] as number, source[i + 2] as number);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(byte);
  }
  return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
}

/**
 * The first normalised reading: %XX decoded, UTF-8 decoded, HTML entities
 * decoded (twice, for a doubly-escaped one), inline tags and backslash escapes
 * before ASCII punctuation dropped, NFKC applied, format characters and
 * default-ignorable code points (zero width, soft hyphen, U+034F, variation
 * selectors) deleted and every dash, U+2212 included, folded to `-`. Those
 * transformations are what is handled; nothing else is claimed.
 */
export function normalise(line: string): string {
  return normaliseReading(line, true);
}

/**
 * The same reading with inline tags KEPT. Stripping a tag strips what is
 * inside it too -- an autolink `<https://…/v%61ult>` or an `href="…"` -- so
 * the decoded text is scanned before the tags go as well as after.
 */
export function normaliseKeepingTags(line: string): string {
  return normaliseReading(line, false);
}

function normaliseReading(line: string, stripTags: boolean): string {
  let text = percentDecode(line);
  for (let pass = 0; pass < 2; pass++) {
    text = text.replace(/&#[xX]([0-9A-Fa-f]{1,6});/g, (_m, hex: string): string => codePoint(Number.parseInt(hex, 16)));
    text = text.replace(/&#([0-9]{1,7});/g, (_m, dec: string): string => codePoint(Number.parseInt(dec, 10)));
    text = text.replace(/&([A-Za-z][A-Za-z0-9]{1,31});/g, (whole, name: string): string => ENTITIES.get(name) ?? whole);
  }
  if (stripTags) text = text.replace(/<\/?[A-Za-z][^<>]*>/g, "");
  text = text.replace(/\\(?=[!-/:-@[-`{-~])/g, "");
  text = text.normalize("NFKC");
  // Format characters AND every default-ignorable code point (U+034F
  // combining grapheme joiner, variation selectors, ...): each renders as
  // nothing, so each can split a name invisibly.
  text = text.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "");
  // Every dash, and U+2212 MINUS SIGN, which is a math symbol (Sm) rather than
  // a dash (Pd) but renders as one.
  text = text.replace(/[\p{Pd}\u2212]/gu, "-");
  return text;
}

/**
 * The second normalised reading: HTML comments, `*`, `~` and backticks
 * removed, so intraword emphasis, strikethrough (`~~`) and code spans that
 * RENDER as one word read as one. `_` stays: CommonMark never renders an
 * intraword `_` as emphasis.
 */
export function normaliseMarkup(text: string): string {
  return text.replace(/<!--.*?-->/g, "").replace(/[*~`]/g, "");
}

function needsNormalising(line: string): boolean {
  return /[%&<\\*~`]|[^\x00-\x7F]/.test(line);
}

/** Every hit in the given fields, raw first, then each normalised reading. */
export function findPrivateNames(matcher: NameMatcher, fields: readonly CheckedText[]): readonly PrivateNameHit[] {
  return findPrivateNameOccurrences(matcher, fields).hits;
}

/**
 * Every hit AND every rule-skipped bare use of an ordinary-word name
 * (zheref/nen#535), per line: a name reported as a hit on a line is never
 * also reported as ruled there, whichever reading found which.
 */
export function findPrivateNameOccurrences(
  matcher: NameMatcher,
  fields: readonly CheckedText[],
): { readonly hits: readonly PrivateNameHit[]; readonly ruled: readonly RuledOccurrence[] } {
  const hits: PrivateNameHit[] = [];
  const ruled: RuledOccurrence[] = [];
  for (const { field, text } of fields) {
    text.split(/\r?\n/).forEach((line, offset): void => {
      const reported = new Set<string>();
      const lineRuled = new Map<string, RuledOccurrence>();
      const scan = (candidate: string, normalised: boolean): void => {
        for (const [key, pattern] of matcher.patterns) {
          if (reported.has(key)) continue;
          const ignored = matcher.ignored.has(key);
          const index = ignored ? matcher.indexOf.get(key) : matcher.policedIndexOf.get(key);
          if (index === undefined) continue;
          const ordinary = matcher.ordinary.has(key);
          const shapedHit = matcher.shaped.get(key)?.test(candidate) ?? false;
          if (!shapedHit) {
            if (!pattern.test(candidate)) continue;
            if (ordinary) {
              // A bare use of an ordinary word: reported once per line, never a hit.
              if (!lineRuled.has(key)) {
                lineRuled.set(key, { field, line: offset + 1, index, normalised, form: "bare", class: ORDINARY_WORD_CLASS });
              }
              continue;
            }
          }
          reported.add(key);
          hits.push({
            field,
            line: offset + 1,
            index,
            normalised,
            ignored,
            ignoredBy: ignored ? (matcher.exemptedBy.get(key) ?? null) : null,
            form: shapedHit ? "repository-shaped" : "bare",
            class: ordinary ? ORDINARY_WORD_CLASS : null,
          });
        }
      };
      scan(line, false);
      if (needsNormalising(line)) {
        // Decoded with tags kept FIRST, so a name inside a link destination or
        // an attribute is read before the tag-stripped reading removes it.
        const withTags = normaliseKeepingTags(line);
        scan(withTags, true);
        scan(normaliseMarkup(withTags), true);
        const first = normalise(line);
        scan(first, true);
        scan(normaliseMarkup(first), true);
      }
      for (const [key, occurrence] of lineRuled) if (!reported.has(key)) ruled.push(occurrence);
    });
  }
  return { hits, ruled };
}

// --- the check, as a verb runs it -----------------------------------------------

/**
 * Run the whole check for one write: the opt-out, then the target's
 * visibility, then the live list and the match. Never throws for a check that
 * could not run -- that is the `unavailable` verdict, which the caller refuses
 * on exactly as it refuses a hit.
 */
export function checkPrivateNames(
  seams: GuardSeams,
  target: Target,
  fields: readonly CheckedText[],
  skip: boolean,
  ignore: IgnoreList | null = null,
  allowAllIgnored: boolean = false,
  named: NamedList | null | (() => NamedList | null) = null,
): PrivateNameCheck {
  const unread = { listSize: null, owners: null };
  if (skip) return { result: "skipped-by-flag", targetVisibility: null, ...unread, hits: [], ruled: [], error: null };
  let visibility: Visibility;
  try {
    visibility = readTargetVisibility(seams, target);
  } catch (error) {
    if (!(error instanceof PrivateListUnavailableError)) throw error;
    return { result: "unavailable", targetVisibility: null, ...unread, hits: [], ruled: [], error: error.message };
  }
  if (visibility === "private") {
    return { result: "skipped-private-target", targetVisibility: visibility, ...unread, hits: [], ruled: [], error: null };
  }
  let list: readonly string[];
  try {
    requireFullPrivateReach(seams);
    list = readPrivateList(seams);
  } catch (error) {
    if (!(error instanceof PrivateListUnavailableError)) throw error;
    return { result: "unavailable", targetVisibility: visibility, ...unread, hits: [], ruled: [], error: error.message };
  }
  const counts = {
    listSize: list.length,
    owners: new Set(list.map((entry): string => entry.replace(/\/.*$/, "").toLowerCase())).size,
  };
  // THE NAMED LIST IS READ LAZILY, here, after the visibility row: a write to
  // a PRIVATE target spends no `git show` and cannot be refused over a
  // committed list it would never have compared against (Nobunaga). A thunk's
  // throw (a bare name on the list, the caller's exit 2) therefore reaches a
  // public target only.
  const resolvedNamed = typeof named === "function" ? named() : named;
  const matcher = compileMatcher(list, ignore, resolvedNamed);
  // EVERY NAME IGNORED is a check that polices nothing: refused as
  // unavailable, the script's rule, unless the caller says it means it. Both
  // lists are counted: the refusal names whichever did the exempting.
  if (matcher.policedIndexOf.size === 0 && !allowAllIgnored) {
    const exemptors = [ignore !== null ? "the ignore file" : null, resolvedNamed !== null ? "the named list" : null].filter(
      (name): name is string => name !== null,
    );
    const subject = exemptors.length === 0 ? "the lists" : exemptors.join(" and ");
    return {
      result: "unavailable",
      targetVisibility: visibility,
      ...counts,
      hits: [],
      ruled: [],
      error: `every private name is ignored (${subject} exempt${exemptors.length === 1 ? "s" : ""} all ${counts.listSize}), so nothing would be checked; pass --allow-all-ignored if that is meant`,
    };
  }
  const { hits, ruled } = findPrivateNameOccurrences(matcher, fields);
  const blocking = hits.some((hit): boolean => !hit.ignored);
  return { result: blocking ? "refused" : "clean", targetVisibility: visibility, ...counts, hits, ruled, error: null };
}

/** Whether a verdict stops the write. */
export function blocksWrite(check: PrivateNameCheck): boolean {
  return check.result === "refused" || check.result === "unavailable";
}

/** The exit a blocking verdict answers with: 4 for a hit, 1 for a check that could not run. */
export function blockingExit(check: PrivateNameCheck): number {
  return check.result === "refused" ? PRIVATE_NAME_EXIT : 1;
}

/**
 * The human lines for a verdict, for stderr. Empty for `clean` and for a
 * private target (nothing to say), so a passing run's text output is
 * unchanged. The opt-out is always named.
 *
 * `verb` is the prefix every line carries -- `nen issue` for the three verbs
 * #329 guarded, the guarded verb's own name for the rest (`nen pr open`,
 * `release-publish`, ...) -- so a caller can tell the guard's lines from the
 * verb's own and from gh's, and knows which verb refused.
 */
export function privateNameLines(check: PrivateNameCheck, target: Target, verb: string = "nen issue"): readonly string[] {
  const where = (hit: PrivateNameHit): string =>
    `${hit.field}:${hit.line}: private repository #${hit.index}${hit.normalised ? " (spelt through an escape, entity, encoding, markup or invisible character)" : ""}`;
  // An ignored hit is never silent, whatever the verdict.
  const ignoredLines = check.hits
    .filter((hit): boolean => hit.ignored)
    .map((hit): string => `${verb}: ignored: ${where(hit)} (${hit.ignoredBy === "named-list" ? "named list" : "ignore file"})`);
  // A bare use of an ordinary-word name (zheref/nen#535) is never silent either.
  const ruledLines = check.ruled.map(
    (occurrence): string =>
      `${verb}: not matched: ${occurrence.field}:${occurrence.line}: private repository #${occurrence.index}${occurrence.normalised ? " (spelt through an escape, entity, encoding, markup or invisible character)" : ""} (${ORDINARY_WORD_RULE})`,
  );
  switch (check.result) {
    case "clean":
      return [...ruledLines, ...ignoredLines];
    case "skipped-private-target":
      return [];
    case "skipped-by-flag":
      return [
        `${verb}: private-name check SKIPPED by --${SKIP_PRIVATE_NAME_CHECK_FLAG} -- the caller attests it ran its own; nothing was compared against the private repository list.`,
      ];
    case "unavailable":
      return [
        // plainLine: the error can carry gh's stderr, which is text nen did
        // not write; --json keeps the bytes.
        `${verb}: private-name check could not run -- ${plainLine(check.error ?? "unknown error")}.`,
        `  ${target.slug} may be public, so nothing was written: a check that cannot read is a refusal, never a pass. Fix the read, or pass --${SKIP_PRIVATE_NAME_CHECK_FLAG} after running your own check.`,
      ];
    case "refused": {
      const blocking = check.hits.filter((hit): boolean => !hit.ignored);
      return [
        ...ruledLines,
        ...ignoredLines,
        ...blocking.map((hit): string => `${verb}: ${where(hit)}`),
        `${verb}: ${blocking.length} mention(s) of a private repository in text bound for PUBLIC ${target.slug}; nothing was written. Redact them and retry.`,
        `  #k indexes the credential's private list, sorted bytewise: gh api --paginate 'user/repos?visibility=private&per_page=100' -q '.[].full_name' | LC_ALL=C sort -u | sed -n '<k>p'`,
      ];
    }
  }
}
