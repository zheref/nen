// src/release/unitcheck.ts -- `nen release unit-check`: whether a pull
// request's changed files stay inside a DECLARED release unit.
//
// WHY THIS IS A NEN VERB AND NOT A PROSE STEP (maintainer's ruling,
// 2026-09-26: "make the three things that are still judged by reading rather
// than by a nen command be deterministic and rely on the nen command if
// they're processes that are meant to be deterministic"). "Does this PR touch
// only the release unit" used to be answered by a human reading a diff; the
// question is mechanical -- a changed-path set compared against a declared
// pattern list -- so it is answered here instead, the same way
// ../review/scopes.ts answers "which reviewer scopes does this diff raise"
// instead of leaving that to a reader's own judgement.
//
// THE PATTERN GRAMMAR IS ../report/patterns.ts's, NOT A SECOND ONE. See that
// module's header, and ../review/scopes.ts's, for why there is exactly one
// path-pattern language in this binary: `src/my-unit/**` claims the same files
// whether it sits in `review.scopes` or in `release.unitPaths`.
//
// `release.unitPaths` UNDECLARED IS A USAGE ERROR (exit 2), NEVER "EVERYTHING
// PASSES" OR "EVERYTHING FAILS". Both silent readings would let this verb
// report a verdict about a boundary the repository never drew -- see
// ../schema/workflow.ts's ReleasePolicy doc comment for the same rule stated
// at the schema layer.

import { matchesPattern } from "../report/patterns.js";
import { parseTarget, targetFromRemote, TargetError, type Target } from "../github/target.js";
import { GH, must, mustJson, ToolError, type Seams } from "../seam/exec.js";
import type { ReleaseUnitEntry, ReleaseUnitKeyedPath } from "../schema/workflow.js";

export type { ReleaseUnitEntry, ReleaseUnitKeyedPath } from "../schema/workflow.js";

export const UNIT_CHECK_CONTRACT = "nen.release.unit-check/v0.1";

export class UnitCheckRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitCheckRefError";
  }
}

/** `<n>` or `<owner/name>#<n>` -- the two forms `--pr` accepts. */
const PR_REF = /^(?:([^\s#]+)#)?([0-9]{1,9})$/;

export interface ResolvedPrRef {
  /** `null` means "this checkout's own origin". */
  readonly slug: string | null;
  readonly number: number;
}

/**
 * `--pr <n|owner/name#n>`, resolved to a slug (or none) and a number.
 *
 * REFUSED, NEVER GUESSED, exactly like every other ref grammar in this binary
 * (../verbs/pr_ready.ts's `resolveRef`, ../pr/command.ts's `requirePrStrict`):
 * an unparseable token is a usage error naming the two forms, not an attempt
 * to salvage a reading from it.
 */
export function resolvePrRef(raw: string): ResolvedPrRef {
  const trimmed = raw.trim();
  const match = PR_REF.exec(trimmed);
  if (match === null) {
    throw new UnitCheckRefError(
      `'${raw}' is not a pull-request reference. Write --pr <n> (this checkout's own repository) or --pr <owner/name>#<n>.`,
    );
  }
  const parsed = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UnitCheckRefError(`'${raw}' names no positive pull-request number.`);
  }
  return { slug: match[1] ?? null, number: parsed };
}

/** Resolves the ref's target: the named slug, or this checkout's own origin. */
export function resolveUnitCheckTarget(seams: Seams, repoRoot: string, ref: ResolvedPrRef): Target {
  if (ref.slug === null) return targetFromRemote(seams, repoRoot);
  try {
    return parseTarget(ref.slug);
  } catch (error) {
    if (error instanceof TargetError) throw new UnitCheckRefError(error.message);
    throw error;
  }
}

interface PrFileEntry {
  readonly filename: string;
  readonly previous_filename?: string;
}

interface PrMetaResponse {
  // GitHub's REST API spells this `changed_files`; some gh-side JSON
  // re-encodings camel-case it as `changedFiles` -- both are read.
  readonly changed_files?: number;
  readonly changedFiles?: number;
}

/** One changed path, and the path it was renamed FROM when it is a rename. */
export interface ChangedFile {
  readonly path: string;
  /** `null` unless this entry is a rename -- then the file's PREVIOUS path. */
  readonly previousPath: string | null;
}

/** GitHub silently caps a pull request's files listing at this many entries. */
export const GITHUB_FILES_CAP = 3000;

export class UnitCheckTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitCheckTruncatedError";
  }
}

/**
 * `gh api --paginate repos/{slug}/pulls/{n}/files`, not `gh pr view --json
 * files` -- that field is ITSELF paginated by `gh` without `--paginate`
 * ever being offered for it, so a large pull request's changed-path list
 * silently truncated with no signal this check could read. `--paginate`
 * walks every page of the REST endpoint directly, but WITHOUT `--slurp` it
 * writes each page's own JSON array to stdout back-to-back -- one page, one
 * array, no wrapping structure joining them -- which is not one parseable
 * JSON document once there is more than one page. `--slurp` is what turns
 * that into a single JSON array OF each page's array, which `JSON.parse`
 * can read, and which this function then flattens back into one changed-file
 * list.
 *
 * THE PR'S OWN `changed_files` COUNT IS CROSS-CHECKED against what the files
 * endpoint actually returned, and a mismatch -- or hitting GitHub's
 * documented 3000-file cap on this endpoint -- is refused rather than
 * silently reported as a possibly-incomplete unit-check verdict: this verb
 * exists so the answer is mechanical, and a mechanical answer over a
 * truncated list is worse than no answer.
 */
export function fetchChangedFiles(seams: Seams, target: Target, prNumber: number): readonly ChangedFile[] {
  const pages = mustJson<readonly (readonly PrFileEntry[])[]>(seams, GH, [
    "api",
    "--paginate",
    "--slurp",
    `repos/${target.slug}/pulls/${prNumber}/files`,
  ]);
  const entries = pages.flat();
  const meta = mustJson<PrMetaResponse>(seams, GH, ["api", `repos/${target.slug}/pulls/${prNumber}`]);
  const declared = meta.changed_files ?? meta.changedFiles;
  if (declared !== undefined && declared !== entries.length) {
    throw new UnitCheckTruncatedError(
      `'${target.slug}#${prNumber}' reports ${declared} changed file(s), but the files endpoint returned ${entries.length} -- the list is truncated, so a unit-check verdict off it would be a guess about files this check never saw.`,
    );
  }
  if (entries.length >= GITHUB_FILES_CAP) {
    throw new UnitCheckTruncatedError(
      `'${target.slug}#${prNumber}' has ${entries.length} changed file(s), at or past GitHub's ${GITHUB_FILES_CAP}-file cap on this endpoint -- the true changed-file set cannot be read past this point, so no unit-check verdict is given.`,
    );
  }
  return entries.map((entry): ChangedFile => ({ path: entry.filename, previousPath: entry.previous_filename ?? null }));
}

/** The pull request's base/head commits, for a caller (`nen release unit-check`) that has not already fetched them for some other reason. */
export function fetchPrRefs(seams: Seams, target: Target, prNumber: number): { readonly baseRefOid: string; readonly headRefOid: string } {
  return mustJson<{ readonly baseRefOid: string; readonly headRefOid: string }>(seams, GH, [
    "pr",
    "view",
    String(prNumber),
    "--repo",
    target.slug,
    "--json",
    "baseRefOid,headRefOid",
  ]);
}

/**
 * The MERGE BASE of `baseRefOid`/`headRefOid` -- N6: a content-scoped diff
 * must compare against the commit the merge would ACTUALLY combine with, not
 * the pull request's `baseRefOid` (the branch's tip at the moment GitHub last
 * recomputed it, which drifts forward as the target branch moves) -- an
 * unrelated commit landing on the base branch after this branch forked would
 * otherwise show up as a "change" this content-scoped check never made.
 * `repos/{slug}/compare/{base}...{head}` is the one GitHub endpoint that
 * states the actual merge-base commit for two refs; `merge_base_commit.sha`
 * is read off it rather than recomputed locally, because this module never
 * assumes a local clone of the target repository exists at all.
 */
export class MergeBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeBaseError";
  }
}

export function fetchMergeBaseSha(seams: Seams, target: Target, baseRef: string, headRef: string): string {
  const response = mustJson<{ readonly merge_base_commit?: { readonly sha?: string } }>(seams, GH, [
    "api",
    `repos/${target.slug}/compare/${baseRef}...${headRef}`,
  ]);
  const sha = response.merge_base_commit?.sha;
  if (sha === undefined || sha === "") {
    throw new MergeBaseError(`'repos/${target.slug}/compare/${baseRef}...${headRef}' answered with no 'merge_base_commit.sha'.`);
  }
  return sha;
}

/**
 * The pure classification: every changed path the declared unit does NOT
 * claim. A RENAME'S PREVIOUS PATH IS CHECKED TOO -- a file the unit now owns
 * that was renamed in FROM outside it is still a change outside the unit's
 * declared boundary, not a change the unit can claim just because its new
 * name happens to sit inside.
 */
export function outsideReleaseUnit(
  changedFiles: readonly ChangedFile[],
  unitPaths: readonly ReleaseUnitEntry[],
): readonly string[] {
  // A CONTENT-SCOPED ENTRY CLAIMS ITS PATH BY EXACT EQUALITY, NEVER A
  // PATTERN -- see ../schema/workflow.ts's `ReleaseUnitKeyedPath` doc
  // comment. Whether the change it carries stayed inside the declared
  // `keys` is a SEPARATE question, answered by `keyScopedViolations` below;
  // this function only decides path membership, exactly as it always has.
  const claims = (path: string): boolean =>
    unitPaths.some((entry): boolean => (typeof entry === "string" ? matchesPattern(path, entry) : entry.path === path));
  const outside: string[] = [];
  for (const file of changedFiles) {
    const previousOutside = file.previousPath !== null && !claims(file.previousPath);
    if (!claims(file.path) || previousOutside) outside.push(file.path);
  }
  return outside;
}

// ── the content-scoped diff engine (N1) ─────────────────────────────────────
//
// N1: DIFFING BY DOTTED STRING WAS THE BUG, NOT AN IMPLEMENTATION DETAIL OF
// IT. Concatenating segments into one string ('a.b') is lossy in both
// directions at once: a literal key that HAPPENS to contain a dot
// ('scripts.test') collides with a truly nested path ('scripts' -> 'test'),
// and an array index turned into a bare numeric segment is indistinguishable
// from an object key of the same spelling ('a.0' is both "array a, index 0"
// and "object a, key '0'"). Both directions let a change slip through
// UNDETECTED: a shadow write to a colliding literal key reads as "the same
// leaf, unchanged", and an array-to-object rewrite with equal-looking
// contents reads as "no structural change" even though every consumer of
// that file now sees a different type. This engine works on the PARSED TREE
// directly (`JValue` below) and diffs it structurally: every node carries its
// own kind (object / array / scalar), a changed node is reported by its
// SEGMENT ARRAY (never rejoined into a string until the very end, for
// display only), and a type change is reported at the node itself -- an
// object becoming a string, an array becoming an object -- rather than
// silently recursing into two incompatible shapes.

/** A JSON value, parsed with its own STRUCTURE preserved -- see this section's header, and `parseJsonPreservingNumbers` for why numbers keep their raw source text too (N16). */
export type JValue =
  | { readonly kind: "object"; readonly entries: ReadonlyMap<string, JValue> }
  | { readonly kind: "array"; readonly items: readonly JValue[] }
  | { readonly kind: "number"; readonly raw: string; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "null" };

export class JsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonParseError";
  }
}

/**
 * A hand-rolled JSON parser, not `JSON.parse` -- the ONE reason this exists
 * is N16: `JSON.parse` reads every number through an IEEE-754 double, so
 * `12345678901234567890` and `12345678901234567891` (both past
 * `Number.MAX_SAFE_INTEGER`) parse to the SAME double and then compare
 * EQUAL, even though their source text plainly differs -- a release-unit
 * check that missed exactly that kind of edit would be the one case this
 * whole feature exists to catch. This parser keeps each number's RAW SOURCE
 * TEXT (`JValue`'s `number` case) alongside its `Number()` value, so
 * `numbersEqual` below can fall back to comparing the text itself once the
 * value is outside safe-integer range. Object key order is insertion order
 * (a `Map`), and a duplicate key keeps the LAST value, exactly as
 * `JSON.parse` does.
 */
export function parseJsonPreservingNumbers(text: string): JValue {
  let i = 0;
  const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
  const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
  function skipWs(): void {
    while (isWs(text[i])) i++;
  }
  function expect(literal: string): void {
    if (text.slice(i, i + literal.length) !== literal) {
      throw new JsonParseError(`expected '${literal}' at offset ${i}`);
    }
    i += literal.length;
  }
  function parseString(): { readonly kind: "string"; readonly value: string } {
    if (text[i] !== '"') throw new JsonParseError(`expected a string at offset ${i}`);
    i++;
    let out = "";
    for (;;) {
      const c = text[i];
      if (c === undefined) throw new JsonParseError("unterminated string");
      if (c === '"') {
        i++;
        return { kind: "string", value: out };
      }
      if (c === "\\") {
        i++;
        const esc = text[i];
        if (esc === '"') out += '"';
        else if (esc === "\\") out += "\\";
        else if (esc === "/") out += "/";
        else if (esc === "n") out += "\n";
        else if (esc === "t") out += "\t";
        else if (esc === "r") out += "\r";
        else if (esc === "b") out += "\b";
        else if (esc === "f") out += "\f";
        else if (esc === "u") {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new JsonParseError(`bad \\u escape at offset ${i}`);
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
        } else throw new JsonParseError(`bad escape at offset ${i}`);
        i++;
        continue;
      }
      // Copilot round, item 1: an UNESCAPED control character (< U+0020)
      // inside a JSON string is not legal JSON -- RFC 8259 requires every
      // one of them to be written as a `\uXXXX` (or the short) escape. A
      // scanner that copies it verbatim would let a string leaf smuggle a
      // raw newline/NUL/etc past this parser without ever failing closed,
      // which is exactly the class of "reads as valid JSON when it is not"
      // this content-scoped check exists to refuse.
      if (c.charCodeAt(0) < 0x20) {
        throw new JsonParseError(`unescaped control character (U+${c.charCodeAt(0).toString(16).padStart(4, "0")}) in string at offset ${i}`);
      }
      out += c;
      i++;
    }
  }
  function parseNumber(): { readonly kind: "number"; readonly raw: string; readonly value: number } {
    const start = i;
    if (text[i] === "-") i++;
    if (!isDigit(text[i])) throw new JsonParseError(`expected a digit at offset ${i}`);
    // Copilot round, item 2: JSON's own integer-part grammar is `0 |
    // [1-9][0-9]*` -- a LEADING ZERO followed by more digits ('01', '-01')
    // is not a legal JSON number at all (every conforming parser, including
    // `JSON.parse`, refuses it), so a bare digit-run here would silently
    // accept a spelling `JSON.parse` never would and this reader would then
    // treat as a genuinely different number than the plain `1` it was
    // compared against. A single leading '0' is legal and stops the integer
    // part immediately -- '0.5' and '0e1' are fine, '05' is not.
    if (text[i] === "0") {
      i++;
    } else {
      while (isDigit(text[i])) i++;
    }
    if (text[i] === ".") {
      i++;
      if (!isDigit(text[i])) throw new JsonParseError(`expected a digit after '.' at offset ${i}`);
      while (isDigit(text[i])) i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      if (!isDigit(text[i])) throw new JsonParseError(`expected a digit in exponent at offset ${i}`);
      while (isDigit(text[i])) i++;
    }
    const raw = text.slice(start, i);
    return { kind: "number", raw, value: Number(raw) };
  }
  function parseArray(): { readonly kind: "array"; readonly items: readonly JValue[] } {
    i++;
    skipWs();
    const items: JValue[] = [];
    if (text[i] === "]") {
      i++;
      return { kind: "array", items };
    }
    for (;;) {
      items.push(parseValue());
      skipWs();
      if (text[i] === ",") {
        i++;
        skipWs();
        continue;
      }
      if (text[i] === "]") {
        i++;
        break;
      }
      throw new JsonParseError(`expected ',' or ']' at offset ${i}`);
    }
    return { kind: "array", items };
  }
  function parseObject(): { readonly kind: "object"; readonly entries: ReadonlyMap<string, JValue> } {
    i++;
    skipWs();
    const entries = new Map<string, JValue>();
    if (text[i] === "}") {
      i++;
      return { kind: "object", entries };
    }
    for (;;) {
      skipWs();
      const key = parseString().value;
      skipWs();
      if (text[i] !== ":") throw new JsonParseError(`expected ':' at offset ${i}`);
      i++;
      skipWs();
      entries.set(key, parseValue()); // last value wins on a duplicate key, exactly as JSON.parse.
      skipWs();
      if (text[i] === ",") {
        i++;
        skipWs();
        continue;
      }
      if (text[i] === "}") {
        i++;
        break;
      }
      throw new JsonParseError(`expected ',' or '}' at offset ${i}`);
    }
    return { kind: "object", entries };
  }
  function parseValue(): JValue {
    skipWs();
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "t") {
      expect("true");
      return { kind: "boolean", value: true };
    }
    if (c === "f") {
      expect("false");
      return { kind: "boolean", value: false };
    }
    if (c === "n") {
      expect("null");
      return { kind: "null" };
    }
    if (c === "-" || isDigit(c)) return parseNumber();
    throw new JsonParseError(`unexpected character at offset ${i}`);
  }
  const result = parseValue();
  skipWs();
  if (i !== text.length) throw new JsonParseError(`trailing content at offset ${i}`);
  return result;
}

/**
 * N16 (Copilot round, item 3): two JSON numbers are equal when their raw
 * text is IDENTICAL, or when BOTH parsed values are SAFE INTEGERS and
 * numerically equal -- `1` and `1.0`/`1e0` (ordinary formatting variance for
 * the integer 1) compare equal under this rule regardless of which of the
 * three spellings either side used, because `Number.isSafeInteger` is the
 * one range where a precision-lossless `Number()` round-trip is provable
 * without re-parsing the digits by hand; the exponent form is INCLUDED in
 * that check (the earlier version excluded every exponent token outright,
 * which made `1` vs `1e0` at an undeclared key a false violation). A
 * NON-INTEGER value (`1.5`, `1.50`) is compared by raw text ONLY -- this is
 * the deliberately simplest safe rule, not a canonicalized-decimal compare
 * -- and any number whose value is NOT a safe integer (a big integer past
 * `Number.MAX_SAFE_INTEGER`, in particular) likewise falls straight to the
 * raw-text comparison: `12345678901234567890` vs `...67891` both round to
 * the SAME double under `Number()`, so resolving them by parsed value would
 * be exactly the precision loss this whole content-scoped check exists to
 * catch -- fail closed, a raw-text mismatch outside safe-integer range is
 * ALWAYS a difference.
 */
function numbersEqual(a: { readonly raw: string; readonly value: number }, b: { readonly raw: string; readonly value: number }): boolean {
  if (a.raw === b.raw) return true;
  if (Number.isSafeInteger(a.value) && Number.isSafeInteger(b.value)) return a.value === b.value;
  return false;
}

function scalarEqual(a: JValue, b: JValue): boolean {
  if (a.kind === "number" && b.kind === "number") return numbersEqual(a, b);
  if (a.kind === "string" && b.kind === "string") return a.value === b.value;
  if (a.kind === "boolean" && b.kind === "boolean") return a.value === b.value;
  if (a.kind === "null" && b.kind === "null") return true;
  return false; // a scalar KIND mismatch (number vs string, etc.) is a difference too.
}

/** `object` / `array` / everything else -- the one distinction that decides whether two nodes recurse together or are compared as a unit. */
function structuralKind(value: JValue): "object" | "array" | "scalar" {
  if (value.kind === "object") return "object";
  if (value.kind === "array") return "array";
  return "scalar";
}

/**
 * Every path (as a SEGMENT ARRAY, never a joined string -- this section's
 * header) at or under `path` where `base` and `head` disagree: a changed
 * scalar, an added/removed object key or array index, or a STRUCTURAL TYPE
 * CHANGE at that exact node (object -> array, object -> scalar, ...),
 * recorded at the node itself rather than recursed into. The empty path
 * (`[]`) names the root.
 */
function diffJsonTree(base: JValue, head: JValue, path: readonly string[], out: (readonly string[])[]): void {
  const baseKind = structuralKind(base);
  const headKind = structuralKind(head);
  if (baseKind !== headKind) {
    out.push(path);
    return;
  }
  if (baseKind === "object") {
    const baseEntries = (base as { readonly kind: "object"; readonly entries: ReadonlyMap<string, JValue> }).entries;
    const headEntries = (head as { readonly kind: "object"; readonly entries: ReadonlyMap<string, JValue> }).entries;
    for (const key of new Set([...baseEntries.keys(), ...headEntries.keys()])) {
      const inBase = baseEntries.has(key);
      const inHead = headEntries.has(key);
      if (!inBase || !inHead) {
        out.push([...path, key]);
        continue;
      }
      diffJsonTree(baseEntries.get(key)!, headEntries.get(key)!, [...path, key], out);
    }
    return;
  }
  if (baseKind === "array") {
    const baseItems = (base as { readonly kind: "array"; readonly items: readonly JValue[] }).items;
    const headItems = (head as { readonly kind: "array"; readonly items: readonly JValue[] }).items;
    const length = Math.max(baseItems.length, headItems.length);
    for (let index = 0; index < length; index++) {
      if (index >= baseItems.length || index >= headItems.length) {
        out.push([...path, String(index)]);
        continue;
      }
      diffJsonTree(baseItems[index]!, headItems[index]!, [...path, String(index)], out);
    }
    return;
  }
  if (!scalarEqual(base, head)) out.push(path);
}

/**
 * A declared key parsed into a SEGMENT ARRAY (N1/N5) -- never a dotted
 * string, and never re-split from one, so a literal key that happens to
 * contain a `.` or a `/` cannot be misread as a nested path. TWO SPELLINGS:
 * a key starting with `/` is an RFC 6901 JSON POINTER -- split on `/`, the
 * leading empty segment dropped, each segment decoded `~1` -> `/` THEN `~0`
 * -> `~` (the ORDER matters: decoding `~0` first would turn a literal `~1`
 * sequence into `~` + `1`, silently manufacturing a `/`). A key with no
 * leading `/` is DOTTED shorthand -- split on `.` -- for the common case of
 * an ordinary nested object path (`nested.allowed`) where no segment itself
 * contains a `.` or a `/`; a key that needs either belongs in pointer form.
 */
function parseKeySegments(key: string): readonly string[] {
  const trimmed = key.trim();
  if (trimmed.startsWith("/")) {
    return trimmed
      .split("/")
      .slice(1)
      .map((segment): string => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  }
  if (trimmed === "") return [];
  return trimmed.split(".");
}

/** True when `path` is AT or BENEATH one of `allowedSegments` -- an ancestor of a declared key is never itself allowed (a type change there could destroy the declared key too), which falls straight out of requiring `path` to be at least as long and share the declared prefix exactly. */
function pathAllowed(path: readonly string[], allowedSegments: readonly (readonly string[])[]): boolean {
  return allowedSegments.some(
    (segments): boolean => path.length >= segments.length && segments.every((segment, index): boolean => path[index] === segment),
  );
}

/** A segment path, joined for DISPLAY only -- never compared as a string; empty path renders as `(root)`. */
function displayPath(path: readonly string[]): string {
  return path.length === 0 ? "(root)" : path.join(".");
}

/** Every changed leaf/segment path (as `displayPath` strings) present at or under the root, outside every declared key. */
function offendingSegmentPaths(base: JValue, head: JValue, keys: readonly string[]): readonly string[] {
  const allowedSegments = keys.map(parseKeySegments);
  const changed: (readonly string[])[] = [];
  diffJsonTree(base, head, [], changed);
  return changed.filter((path): boolean => !pathAllowed(path, allowedSegments)).map(displayPath);
}

/** One content-scoped entry's verdict: `offendingKeys` is empty exactly when `ok`. */
export interface KeyScopedOutcome {
  readonly path: string;
  readonly ok: boolean;
  readonly offendingKeys: readonly string[];
}

/** Reads and parses a repo file's content at one git ref; `null` when it cannot be read as JSON at all (missing, not JSON, fetch failure) -- every caller treats `null` as fail-closed. */
export type ReadJsonAt = (path: string, ref: string) => JValue | null;

/**
 * `repos/{slug}/contents/<path>?ref=<sha>` decoded and parsed, or `null`
 * on ANY failure along the way -- a missing file, a non-JSON body, an
 * unparseable base64 payload, or `gh` itself refusing. FAIL CLOSED (this
 * module's own header): a file this function cannot read as JSON is a file
 * whose change nen cannot prove stayed inside its declared keys, which is
 * exactly the same posture ../pr/mergeunit.ts's `fetchBaseReleasePolicy`
 * already takes for `nen/workflow.json` itself. Uses
 * `parseJsonPreservingNumbers`, never `JSON.parse`, for N16's reason.
 *
 * N2: EACH PATH SEGMENT IS PERCENT-ENCODED before it is interpolated into
 * the contents URL -- a segment carrying a `#`, `?`, `%`, or a space would
 * otherwise change what the URL means (a fragment, a second query string, an
 * escape byte, a broken request) rather than naming the file verbatim.
 * `#`/`?`/`%` are ALSO refused outright at schema load
 * (../schema/workflow.ts's `parseUnitPathEntry`), so this encoding is a
 * second, independent layer for the segments GitHub's own path grammar could
 * still contain (spaces, non-ASCII).
 */
export function fetchJsonAtRef(seams: Seams, target: Target, path: string, ref: string): JValue | null {
  const encodedPath = path
    .split("/")
    .map((segment): string => encodeURIComponent(segment))
    .join("/");
  let response;
  try {
    response = must(seams, GH, ["api", `repos/${target.slug}/contents/${encodedPath}?ref=${ref}`]);
  } catch (error) {
    if (error instanceof ToolError) return null;
    throw error;
  }
  let contents: { readonly content?: string };
  try {
    contents = JSON.parse(response.stdout) as { readonly content?: string };
  } catch {
    return null;
  }
  if (contents.content === undefined) return null;
  // Copilot round, item 4: `Buffer.from(str, "base64")` is LENIENT -- it
  // silently DROPS any byte that is not a base64 alphabet character rather
  // than refusing the string, so a corrupted or truncated payload (or one
  // this reader misdecoded some other way) would still decode to SOMETHING
  // rather than failing closed. GitHub's own contents API wraps its base64
  // body at a fixed column with '\n', which is legitimate and stripped
  // before validating; what remains must be the base64 alphabet, optionally
  // padded with 0-2 trailing '=', and a length that is a multiple of 4 --
  // anything else is refused (`null`) rather than handed to `Buffer.from`
  // to quietly mangle.
  const base64 = contents.content.replace(/\n/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) return null;
  let text: string;
  try {
    text = Buffer.from(base64, "base64").toString("utf8");
  } catch {
    return null;
  }
  try {
    return parseJsonPreservingNumbers(text);
  } catch {
    return null;
  }
}

/**
 * The content-scoped verdict for one `ReleaseUnitKeyedPath`: reads the file
 * at `baseRef` and `headRef`, diffs every leaf STRUCTURALLY (N1), and
 * refuses (fail closed) when either read could not be parsed as JSON at all
 * -- an unreadable file is a file this check cannot prove stayed inside its
 * keys, not a file that passes by default.
 */
export function checkKeyScopedPath(
  entry: ReleaseUnitKeyedPath,
  baseRef: string,
  headRef: string,
  readJson: ReadJsonAt,
): KeyScopedOutcome {
  const base = readJson(entry.path, baseRef);
  const head = readJson(entry.path, headRef);
  if (base === null || head === null) {
    return {
      path: entry.path,
      ok: false,
      offendingKeys: ["(whole file -- unreadable or not valid JSON at its base or head commit)"],
    };
  }
  const offendingKeys = offendingSegmentPaths(base, head, entry.keys);
  return { path: entry.path, ok: offendingKeys.length === 0, offendingKeys };
}

/** The base/head refs and the JSON reader a content-scoped entry's check runs over -- omitted, N4 applies instead (see `assembleUnitCheck`). */
export interface KeyScopedContext {
  readonly baseRef: string;
  readonly headRef: string;
  readonly readJson: ReadJsonAt;
}

export interface UnitCheckReport {
  readonly contract: string;
  readonly target: string;
  readonly pr: number;
  /** N15: the STRING (whole-path pattern) entries only -- exactly the shape this field had before content-scoped entries existed. */
  readonly unitPaths: readonly string[];
  /** N15: the OBJECT (content-scoped) entries, kept in their own field rather than widening `unitPaths`'s type. */
  readonly keyedPaths: readonly ReleaseUnitKeyedPath[];
  readonly changedFiles: readonly string[];
  readonly outsideUnit: readonly string[];
  /** Content-scoped entries whose changed file stepped outside its declared 'keys', or (N4) whose content could not be read at all because no `keyScoped` context was available. Empty when none are declared, none changed, or every one stayed in bounds. */
  readonly keyScopedViolations: readonly KeyScopedOutcome[];
  readonly ok: boolean;
}

export function assembleUnitCheck(
  target: Target,
  prNumber: number,
  unitPaths: readonly ReleaseUnitEntry[],
  changedFiles: readonly ChangedFile[],
  keyScoped?: KeyScopedContext,
): UnitCheckReport {
  const outsideUnit = outsideReleaseUnit(changedFiles, unitPaths);
  const keyScopedViolations: KeyScopedOutcome[] = [];
  for (const entry of unitPaths) {
    if (typeof entry === "string") continue;
    // Only a KEYED entry whose declared file was actually touched (as its
    // path, or as a rename's previous path) needs a content read at all --
    // every other one is silently in bounds, the same as an untouched
    // plain-pattern entry never appearing in 'outsideUnit'.
    const touched = changedFiles.some((file): boolean => file.path === entry.path || file.previousPath === entry.path);
    if (!touched) continue;
    // N4: a TOUCHED keyed entry with no keyScoped context is a violation
    // this check COULD NOT EVEN ATTEMPT, never a silent pass -- a caller
    // that declares a keyed entry but supplies no way to read blob content
    // must not have that entry read as "in bounds by default".
    if (keyScoped === undefined) {
      keyScopedViolations.push({
        path: entry.path,
        ok: false,
        offendingKeys: ["(content not read -- no base/head content reader was available to this check)"],
      });
      continue;
    }
    const outcome = checkKeyScopedPath(entry, keyScoped.baseRef, keyScoped.headRef, keyScoped.readJson);
    if (!outcome.ok) keyScopedViolations.push(outcome);
  }
  return {
    contract: UNIT_CHECK_CONTRACT,
    target: target.slug,
    pr: prNumber,
    unitPaths: unitPaths.filter((entry): entry is string => typeof entry === "string"),
    keyedPaths: unitPaths.filter((entry): entry is ReleaseUnitKeyedPath => typeof entry !== "string"),
    changedFiles: changedFiles.map((file): string => file.path),
    outsideUnit,
    keyScopedViolations,
    ok: outsideUnit.length === 0 && keyScopedViolations.length === 0,
  };
}

export function renderUnitCheck(report: UnitCheckReport): readonly string[] {
  const unitDescription = [
    ...report.unitPaths,
    ...report.keyedPaths.map((entry): string => `${entry.path} {keys: ${entry.keys.join(", ")}}`),
  ].join(", ");
  const lines = [
    `${report.target}#${report.pr}: ${report.changedFiles.length} changed file(s), unit '${unitDescription}'`,
    report.ok
      ? "every changed path is inside the release unit"
      : `${report.outsideUnit.length} path(s) outside the release unit, ${report.keyScopedViolations.length} content-scoped violation(s)`,
  ];
  // FEI-7: each path printed via JSON.stringify, so a path carrying a quote,
  // control character or leading/trailing space is unambiguous in the text
  // rendering rather than blending into the line around it.
  for (const path of report.outsideUnit) lines.push(`  outside: ${JSON.stringify(path)}`);
  for (const violation of report.keyScopedViolations) {
    lines.push(`  outside (content-scoped): ${JSON.stringify(violation.path)} changed at ${violation.offendingKeys.map((key): string => JSON.stringify(key)).join(", ")}`);
  }
  return lines;
}
