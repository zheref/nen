// src/stage/triage.ts -- staging triage, tensho §3's table: detection only.
//
// "A FLAGGED FILE IS NEVER COMMITTED WITHOUT AN EXPLICIT YES" is the skill's
// own rule, and it names the human as the one who answers. This module's job
// ends at flagging: it detects a secret shape, an ignored file, a binary, a
// file outside the declared scope, a deletion nobody mentioned, a
// local-config filename and a file over the size threshold, and it hands back
// WHY each one was flagged. It never decides to stage or skip a
// file, and it never asks the question itself -- that stays with whoever is
// driving, exactly as issue #4's "what stays with the LLM" section says.
//
// EVERY FLAG IS REPORTED, NOT JUST THE FIRST. "Present all flags AT ONCE" is
// the skill's own instruction, so a file matching two reasons (an ignored
// binary, say) carries both rather than whichever check ran first.
//
// A GIT-IGNORED PATH IS A FACT, NOT A QUESTION (zheref/nen#169). It cannot be
// staged without `-f`, so there is nothing for a human to answer yes or no
// to -- unlike every other reason here, which flags something a plain `git
// add` COULD put in a commit. `triageStage` therefore returns it in its own
// `ignored` bucket rather than `flagged`: a repository with a large ignored
// tree (`node_modules/`, a generated `.cursor/` mirror) no longer buries the
// handful of rows that genuinely need a decision under thousands that don't.

export interface StatusEntry {
  readonly path: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly ignored: boolean;
  /**
   * A rename's or copy's ORIGINAL path -- the second `-z` record. Carried
   * rather than discarded (zheref/nen#237, hanten N1): a WORKTREE-column rename
   * (`git add -N new` after a move) leaves the original's deletion unstaged,
   * and `stage list` must put it on the add list or the commit keeps the old
   * file. Absent on every entry that is not a rename or copy.
   */
  readonly origPath?: string;
  /**
   * The bytes git printed for this path (or its rename's original) are not
   * UTF-8 -- read by a FATAL decoder on the raw status output, never inferred
   * from the decoded text (Copilot round 1 on #237: U+FFFD is a legal
   * character, and a real file named with one is an ordinary path). The path
   * string is the lenient decode and cannot name the file on disk. Absent
   * unless set.
   */
  readonly undecodable?: true;
}

// `git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall`.
//
// -z, NOT NEWLINE-SPLIT, AND core.quotePath=false FORCED. With the default
// (newline-terminated) porcelain format, git C-quotes any path containing a
// non-ASCII byte -- `secrëts/.env` comes back as `"secr\303\253ts/.env"`,
// quotes and octal escapes included -- which defeats every `$`-anchored
// shape check below on exactly the paths most worth catching (a name someone
// chose to make less greppable). `-z` disables that quoting unconditionally
// and NUL-terminates every record instead of newline-terminating it, so an
// embedded space or newline in a path cannot be confused with a field
// separator either; `core.quotePath=false` is forced too, defensively, in
// case a caller's global config has already turned quoting off in a way that
// changes the non-`-z` behavior this comment doesn't rely on.
//
// A rename or copy is not a single NUL-terminated record with an " -> " in
// it (that spelling is newline-mode only) -- in `-z` mode it is TWO
// consecutive NUL-terminated records, `XY NEW_PATH\0ORIG_PATH\0`. Only the
// NEW path is kept, since that is what would be staged; the ORIG_PATH record
// is consumed and never treated as an entry of its own.
export function parseStatusPorcelain(text: string): readonly StatusEntry[] {
  return parseRecords(
    text
      .split("\0")
      .filter((record): boolean => record !== "")
      .map((record): StatusRecord => ({ text: record, undecodable: false, key: record })),
  );
}

interface StatusRecord {
  readonly text: string;
  readonly undecodable: boolean;
  /**
   * The record's identity on its RAW BYTES (zheref/nen#337, hanten round 2
   * N7): the text itself for a UTF-8 record, and a hex spelling of the bytes
   * for one that is not -- two different non-UTF-8 names can decode leniently
   * to the same string, and must never be merged into one.
   */
  readonly key: string;
}

/**
 * `parseStatusPorcelain` over the RAW bytes of `git status -z`: each
 * NUL-terminated record is decoded on its own by a FATAL UTF-8 decoder, and a
 * record that is not UTF-8 is decoded leniently instead and its entry marked
 * `undecodable`. Splitting on the byte 0 first is exact -- UTF-8 never puts a
 * 0 byte inside a multi-byte character -- so one bad name cannot spoil the
 * records around it.
 */
export function parseStatusPorcelainBytes(bytes: Uint8Array): readonly StatusEntry[] {
  return parseRecords(splitNulRecords(bytes));
}

/**
 * Raw `-z` output split on the byte 0, each record decoded on its own by a
 * FATAL UTF-8 decoder and, where that fails, leniently with the record marked
 * `undecodable`. Shared by the status reader above and the committed-range
 * readers below (zheref/nen#337), so a non-UTF-8 name is detected the same way
 * whichever git command printed it. Empty records are dropped.
 */
function splitNulRecords(bytes: Uint8Array): readonly StatusRecord[] {
  const fatal = new TextDecoder("utf-8", { fatal: true });
  const lenient = new TextDecoder("utf-8");
  const records: StatusRecord[] = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 0) continue;
    if (i > start) {
      const slice = bytes.subarray(start, i);
      try {
        const text = fatal.decode(slice);
        records.push({ text, undecodable: false, key: text });
      } catch {
        const hex = Array.from(slice, (byte): string => byte.toString(16).padStart(2, "0")).join("");
        records.push({ text: lenient.decode(slice), undecodable: true, key: `\u0000bytes:${hex}` });
      }
    }
    start = i + 1;
  }
  return records;
}

function parseRecords(records: readonly StatusRecord[]): readonly StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const raw = record?.text ?? "";
    const indexStatus = raw[0] ?? " ";
    const worktreeStatus = raw[1] ?? " ";
    const path = raw.slice(3);
    const isRenameOrCopy = indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
    const ignored = indexStatus === "!" && worktreeStatus === "!";
    if (isRenameOrCopy) {
      // The next record is ORIG_PATH -- consumed here, never its own entry,
      // and carried on this one as `origPath`.
      const orig = records[i + 1];
      i++;
      const undecodable = record?.undecodable === true || orig?.undecodable === true;
      entries.push({
        path,
        indexStatus,
        worktreeStatus,
        ignored,
        ...(orig === undefined ? {} : { origPath: orig.text }),
        ...(undecodable ? { undecodable: true as const } : {}),
      });
    } else {
      entries.push({ path, indexStatus, worktreeStatus, ignored, ...(record?.undecodable === true ? { undecodable: true as const } : {}) });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// THE COMMITTED-RANGE READING (zheref/nen#337).
//
// `stage triage --range <base>..<head>` triages the paths a range of COMMITS
// changed, so a review of a branch whose work is already committed can read
// the secret-shape row instead of reporting it unread. The detectors do not
// change and do not learn where their entries came from: the range is read
// into the same `StatusEntry` shape, one per changed path, with the commit's
// change letter in `indexStatus` (so a `D` is a deletion to every detector
// exactly as a staged deletion is) and a blank `worktreeStatus`. Nothing in a
// commit is git-ignored -- it is already tracked -- so `ignored` is always
// false here.

/** One `<base>..<head>` range, as typed. Neither side is resolved yet. */
export interface CommitRange {
  readonly base: string;
  readonly head: string;
}

/**
 * Splits a `--range` value on its ONE `..`. `null` for anything else: a bare
 * ref, an empty side (git would read it as HEAD, which this verb never
 * guesses), or the three-dot form, which is refused rather than read as a
 * two-dot one with a stray dot.
 */
export function parseCommitRange(text: string): CommitRange | null {
  if (text.includes("...")) return null;
  const at = text.indexOf("..");
  if (at === -1 || text.indexOf("..", at + 2) !== -1) return null;
  const base = text.slice(0, at);
  const head = text.slice(at + 2);
  if (base === "" || head === "") return null;
  return { base, head };
}

/** The all-zero object id git prints for "no blob on this side" -- a deletion's destination. */
const NULL_OID = /^0+$/;

/** A gitlink's mode: a submodule commit, never a blob to measure. */
const GITLINK_MODE = "160000";

/**
 * One change git reported in `--raw` form: the path (as the `StatusEntry`
 * every detector reads), the path's raw-byte identity, and the DESTINATION
 * side's mode and object id -- the blob this change put at the path, or the
 * null id for a deletion. For a merge's combined record (`::`), the
 * destination is the merge result's.
 */
export interface RawChange {
  readonly entry: StatusEntry;
  readonly key: string;
  readonly mode: string;
  readonly oid: string;
}

/**
 * `git diff -z --raw --no-abbrev` or `git log -z --raw --no-abbrev --format=`,
 * raw bytes. Each change is a header record -- one `:` per parent, then one
 * mode per parent plus the result's, one object id per parent plus the
 * result's, then the status (`M`, `A`, `D`, `T`, `R<score>`, `C<score>`, or one
 * letter per parent for a merge's combined record) -- followed by its path, or
 * for a two-parent-free rename or copy, by the ORIGINAL path then the new one.
 * The new path is the entry and the original is carried as `origPath`, exactly
 * as an index rename is in the working-copy reading. A record where a header
 * was expected that is not one is skipped, never read as a path.
 */
export function parseRawChangesBytes(bytes: Uint8Array): readonly RawChange[] {
  const records = splitNulRecords(bytes);
  const changes: RawChange[] = [];
  for (let i = 0; i < records.length; i++) {
    const header = records[i]?.text ?? "";
    if (!header.startsWith(":")) continue;
    const parents = /^:+/.exec(header)?.[0].length ?? 1;
    const fields = header.slice(parents).split(" ");
    const mode = fields[parents] ?? "";
    const oid = fields[2 * parents + 1] ?? "";
    const status = fields[2 * parents + 2] ?? "";
    const letter = status.charAt(0);
    const twoPaths = parents === 1 && (letter === "R" || letter === "C");
    const orig = twoPaths ? records[i + 1] : undefined;
    const path = records[i + (twoPaths ? 2 : 1)];
    i += twoPaths ? 2 : 1;
    if (path === undefined) break;
    const undecodable = path.undecodable || orig?.undecodable === true;
    changes.push({
      entry: {
        path: path.text,
        indexStatus: letter === "" ? " " : letter,
        worktreeStatus: " ",
        ignored: false,
        ...(orig === undefined ? {} : { origPath: orig.text }),
        ...(undecodable ? { undecodable: true as const } : {}),
      },
      key: path.key,
      mode,
      oid,
    });
  }
  return changes;
}

/** True when a change's destination is a blob that exists and can be measured. */
export function measurableBlob(change: RawChange): boolean {
  return change.oid !== "" && !NULL_OID.test(change.oid) && change.mode !== GITLINK_MODE && change.entry.indexStatus !== "D";
}

/** The format `cat-file --batch-check` is asked for: every answer names the id it answers. */
export const BATCH_CHECK_FORMAT = "%(objectname) %(objecttype) %(objectsize)";

/**
 * `git cat-file --batch-check='%(objectname) %(objecttype) %(objectsize)'`'s
 * answer to bare object ids, one per line -- ids carry no newline, so no `-z`
 * is needed (and no git 2.38). A blob's size is keyed by its id; a `missing`
 * or `ambiguous` answer, or any non-blob, measures nothing: "not measured",
 * never "measured and small".
 */
export function parseBatchCheckIds(text: string): ReadonlyMap<string, number> {
  const sizes = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [oid, type, size] = line.trim().split(" ");
    if (oid === undefined || type !== "blob" || size === undefined || !/^\d+$/.test(size)) continue;
    sizes.set(oid, Number(size));
  }
  return sizes;
}

export type FlagReason =
  | "secret-shape"
  | "ignored"
  | "binary"
  | "out-of-scope"
  | "unmentioned-deletion"
  | "local-config"
  | "large"
  /**
   * `--range` only (zheref/nen#337): a reason on this row was found on
   * something NOT in the range's net change -- a path added then deleted,
   * renamed away, or changed and reverted, or a blob a commit introduced that
   * a later one replaced. It is not at `<head>`, and it is still in the
   * history the range pushes. Never produced in working-copy mode.
   */
  | "in-history"
  /**
   * `--range` only: git printed this name in bytes that are not UTF-8, so the
   * path shown is a lenient decode that cannot name the file and the name
   * detectors cannot be trusted on it. A human looks (hanten round 2 N7).
   */
  | "undecodable";

export interface FlaggedFile {
  readonly path: string;
  readonly reasons: readonly FlagReason[];
}

export interface TriageResult {
  readonly clean: readonly string[];
  readonly flagged: readonly FlaggedFile[];
  /**
   * Git-ignored paths, kept OUT of `flagged` (zheref/nen#169). An ignored
   * path is a FACT, not a question -- it cannot be staged without `-f`, so
   * there is nothing for a human to say yes or no to, and burying it among
   * paths that DO need a decision (an untracked-in-scope file, a
   * secret-shaped one) was the bug this bucket fixes. Every other reason
   * still computed for the entry travels with it here rather than being
   * dropped: a secret-shaped file inside an ignored tree still carries
   * `secret-shape` alongside `ignored`, recorded and never silently lost --
   * it is simply never counted toward `flagged`, because an ignored path can
   * never end up in a commit regardless of its name.
   */
  readonly ignored: readonly FlaggedFile[];
}

export interface TriageOptions {
  /** Path PREFIXES considered in-scope. Empty means "no scope declared" -- the out-of-scope check is skipped rather than flagging everything. */
  readonly scopePrefixes?: readonly string[];
  /** Free text (a commit message draft, a PR description) searched for a deleted path's basename. */
  readonly mentionedText?: string;
  /** Paths `git diff --numstat` reported as binary (both columns '-'). */
  readonly binaryPaths?: ReadonlySet<string>;
  /**
   * Working-tree size in bytes, per path. A path absent from the map is not
   * measured and is never flagged `large` -- a deletion has no file to stat,
   * and "could not be measured" must never render as "measured and small".
   */
  readonly sizes?: ReadonlyMap<string, number>;
  /** Bytes at or above which a file is `large`. Defaults to `DEFAULT_LARGE_BYTES`. */
  readonly largeBytes?: number;
}

/**
 * One mebibyte, and why a default exists here when `loop slots --local-cap`
 * refuses to have one.
 *
 * That flag is a concurrency GUARD, where a forgotten default silently WIDENS
 * what is allowed; this is a DETECTION threshold on a verb that decides
 * nothing, where the default errs toward flagging and a human answers anyway.
 * The two fail in opposite directions, so they get opposite treatments.
 *
 * A mebibyte is chosen so that no ordinary source file trips it and a
 * multi-megabyte accident -- a pasted dump, a captured log, a vendored blob
 * committed as text -- does. Callers with a stricter policy state their own.
 */
export const DEFAULT_LARGE_BYTES = 1024 * 1024;

// Filename shapes that carry a secret in this repository's own experience
// (tensho §3's table, verbatim): `.env`, `*.pem`, `*.key`, `credentials*`. This
// is a FILENAME check only -- it does not read file content, which is
// deliberate: content scanning is a different, heavier tool, and this check's
// whole value is that it is cheap enough to run on every file every time.
//
// `[^/]*`, NEVER `.*` (hanten round 2 N2): `.` does not match `\n`, `\r`,
// U+2028 or U+2029, so a name carrying one -- `n\nl.key` -- would slip past a
// `.*`. A path segment is everything but `/`, line terminators included.
const SECRET_SHAPE = /(^|\/)(\.env(\.[^/]*)?|[^/]*\.pem|[^/]*\.key|credentials[^/]*)$/i;

const BINARY_EXTENSION = /\.(png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|7z|exe|dll|so|dylib|bin|woff2?|ttf|otf)$/i;

// A LOCAL-CONFIG FILENAME: the `.local` infix a dozen tools agree means "this
// machine's copy, not the project's" -- `settings.local.json`, `.env.local`,
// `config.local.yml`, a bare `foo.local`.
//
// zheref/nen#57: two consuming skills independently kept this as a by-eye check
// on top of this verb's five detectors, which is the shape of a gap rather than
// a preference. A local-config file is not a secret and often is not ignored;
// it is simply somebody's own settings, and committing it hands every other
// contributor a machine they are not sitting at.
//
// A FILENAME CHECK ONLY, exactly like the secret shape above and for the same
// reason: it is cheap enough to run on every file every time, which is the whole
// value of running it at all. It is deliberately NOT a directory rule --
// `.claude/`, `.vscode/` and their neighbours hold committed project
// configuration as often as personal settings, and flagging every file in them
// would bury the rows that need a decision under the ones that do not, which is
// the defect zheref/nen#169's `ignored` bucket exists to undo.
const LOCAL_CONFIG_SHAPE = /(^|\/)[^/]*\.local(\.[^/]*)?$/i;

export function triageStage(entries: readonly StatusEntry[], options: TriageOptions = {}): TriageResult {
  const scopePrefixes = options.scopePrefixes ?? [];
  const mentioned = (options.mentionedText ?? "").toLowerCase();
  const binaryPaths = options.binaryPaths ?? new Set<string>();
  const sizes = options.sizes ?? new Map<string, number>();
  const largeBytes = options.largeBytes ?? DEFAULT_LARGE_BYTES;

  const clean: string[] = [];
  const flagged: FlaggedFile[] = [];
  const ignored: FlaggedFile[] = [];

  for (const entry of entries) {
    const reasons: FlagReason[] = [];
    const isDeletion = entry.indexStatus === "D" || entry.worktreeStatus === "D";

    if (entry.ignored) reasons.push("ignored");
    if (SECRET_SHAPE.test(entry.path)) reasons.push("secret-shape");
    if (binaryPaths.has(entry.path) || BINARY_EXTENSION.test(entry.path)) reasons.push("binary");
    if (scopePrefixes.length > 0 && !scopePrefixes.some((prefix): boolean => entry.path.startsWith(prefix))) {
      reasons.push("out-of-scope");
    }
    if (isDeletion) {
      const basename = entry.path.split("/").at(-1) ?? entry.path;
      if (!mentioned.includes(basename.toLowerCase())) reasons.push("unmentioned-deletion");
    }
    if (LOCAL_CONFIG_SHAPE.test(entry.path)) reasons.push("local-config");
    // MEASURED OR NOT FLAGGED. An unmeasured path -- a deletion, a file the
    // caller chose not to stat -- carries no size claim at all, because "could
    // not be measured" rendering as "measured and small" is the one reading
    // this must never produce.
    const size = sizes.get(entry.path);
    if (size !== undefined && size >= largeBytes) reasons.push("large");

    // An ignored path is routed here FIRST, ahead of the empty-reasons check
    // below -- `entry.ignored` always pushed "ignored" above, so this branch
    // can never see an empty `reasons` array. It never falls through to
    // `flagged`, whatever else it also matched (zheref/nen#169).
    if (entry.ignored) ignored.push({ path: entry.path, reasons });
    else if (reasons.length === 0) clean.push(entry.path);
    else flagged.push({ path: entry.path, reasons });
  }

  return { clean, flagged, ignored };
}

// ---------------------------------------------------------------------------
// THE ADD LIST (zheref/nen#237) -- the complement triage never printed.
//
// `triageStage` answers "what must NOT be staged blind". A checkpoint needs the
// other half, "what SHOULD be staged", and deriving it by re-walking `git
// status` in shell is how two untracked files were dropped from a commit on
// zheref/kro-pwa#95: a hand-written filter loses exactly the untracked rows,
// and the diff still looks whole locally because the file is on disk.
//
// So the list is computed HERE, from the same entries and the same triage, and
// never re-derived: every path triage called clean is on it, every flagged path
// is off it WITH its reasons, every ignored path is off it as the fact it is.
// It composes with triage rather than changing it -- no detector, no reason
// and no triage exit code moves for this.
//
// ONE CLEAN SHAPE IS NOT ADDABLE, and it is a fact about git rather than a
// policy: a deletion already staged (`D ` -- gone from the index AND the
// working tree) matches no pathspec, and `git add` answers it with `fatal:
// pathspec did not match any files`, staging NOTHING from the whole list. It
// is already in the commit-to-be, so it is reported in `alreadyStaged` rather
// than put on a list whose one job is to be fed to `git add` verbatim.

export type AddVerdict = "ready" | "flagged" | "empty";

/**
 * A WORKTREE-column rename's original path, as the deletion it is (hanten N1).
 *
 * `git add -N new` after `mv old new` makes `git status` report ` R new\0old`:
 * the index holds `old` and an intent-to-add `new`, and the working tree has
 * moved one onto the other. Staging `new` alone commits a COPY -- `old` stays
 * in the index -- so the original goes on the entry list as an ordinary
 * worktree deletion, right after the rename, where every detector sees it and
 * an unmentioned one is flagged like any other deletion.
 *
 * Only `R`, not `C`: a copy's original is still on disk and still tracked, so
 * there is no deletion to stage. An INDEX-column rename (`R `) needs nothing
 * either -- the original's removal is already in the index.
 *
 * Used by `stage list` only. `stage triage`'s entries and output are left as
 * they were (#237's scope boundary), so on such a tree triage still does not
 * see the deletion; that is named as a follow-up rather than changed here.
 */
export function expandWorktreeRenames(entries: readonly StatusEntry[]): readonly StatusEntry[] {
  const expanded: StatusEntry[] = [];
  for (const entry of entries) {
    expanded.push(entry);
    if (entry.worktreeStatus === "R" && entry.origPath !== undefined) {
      expanded.push({
        path: entry.origPath,
        indexStatus: " ",
        worktreeStatus: "D",
        ignored: false,
        ...(entry.undecodable === true ? { undecodable: true as const } : {}),
      });
    }
  }
  return expanded;
}

/**
 * The seven unmerged XY pairs `git status` documents. A path in conflict is
 * not a change to stage: `git add` on it RECORDS A RESOLUTION, which is a
 * decision about the conflict, never a transcription (hanten N3).
 */
const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export interface AddList {
  /**
   * `ready` -- the list is non-empty and nothing needs a human. `flagged` --
   * something does: a triage flag, an unmerged path, an embedded repository or
   * an undecodable name. It outranks `empty`, because a tree whose every change
   * needs a human is not a tree with nothing to add. `empty` -- nothing to add
   * and nothing needing a human.
   */
  readonly verdict: AddVerdict;
  /** The exact add list, in `git status` order. Flagged and ignored paths are never on it. */
  readonly add: readonly string[];
  /** Triage's flagged paths, each with every reason it matched -- "excluded on purpose", never "not seen". */
  readonly excluded: readonly FlaggedFile[];
  /** Clean deletions already staged: in the commit-to-be, and a pathspec `git add` would refuse. */
  readonly alreadyStaged: readonly string[];
  /** Git-ignored paths, exactly as triage's `ignored` bucket carries them. */
  readonly ignored: readonly FlaggedFile[];
  /** Paths in conflict (UU AA DD AU UA DU UD). Never listed: adding one resolves the conflict. */
  readonly unmerged: readonly string[];
  /**
   * Untracked paths git reports with a trailing `/` under `-uall` -- a nested
   * repository, empty or populated (hanten N4). `git add` on one records a
   * gitlink with no `.gitmodules` entry, or refuses it; neither is a decision
   * a list may make.
   */
  readonly embeddedRepos: readonly string[];
  /**
   * Paths whose bytes in `git status` are not UTF-8, found by a fatal decoder
   * on the raw output (`StatusEntry.undecodable`): the string shown is a
   * lenient decode and can no longer name the file on disk (hanten N7).
   * Listing it would stage nothing, or the wrong thing. A real U+FFFD in a
   * name is NOT this -- it is an ordinary path, listed like any other.
   */
  readonly undecodable: readonly string[];
}

export function addListFrom(entries: readonly StatusEntry[], triage: TriageResult): AddList {
  const byPath = new Map<string, StatusEntry>();
  for (const entry of entries) if (!byPath.has(entry.path)) byPath.set(entry.path, entry);

  // Paths no list may carry whatever triage said about them, each a fact a
  // human has to act on. Every one of them makes the verdict non-ready.
  const unmerged: string[] = [];
  const embeddedRepos: string[] = [];
  const undecodable: string[] = [];
  const held = new Set<string>();
  const hold = (bucket: string[], path: string): void => {
    if (!bucket.includes(path)) bucket.push(path);
    held.add(path);
  };
  for (const entry of entries) {
    if (entry.ignored) continue;
    if (UNMERGED.has(`${entry.indexStatus}${entry.worktreeStatus}`)) hold(unmerged, entry.path);
    if (entry.indexStatus === "?" && entry.path.endsWith("/")) hold(embeddedRepos, entry.path);
    if (entry.undecodable === true) hold(undecodable, entry.path);
  }

  // DEDUPED, FIRST-SEEN ORDER KEPT (hanten N8): a path reached twice -- a
  // rename's original that git also reports as its own row -- is one pathspec.
  const add: string[] = [];
  const seen = new Set<string>();
  const alreadyStaged: string[] = [];
  for (const path of triage.clean) {
    if (held.has(path) || seen.has(path)) continue;
    seen.add(path);
    const entry = byPath.get(path);
    if (entry !== undefined && entry.indexStatus === "D" && entry.worktreeStatus === " ") alreadyStaged.push(path);
    else add.push(path);
  }

  const needsHuman = triage.flagged.length + unmerged.length + embeddedRepos.length + undecodable.length > 0;
  const verdict: AddVerdict = needsHuman ? "flagged" : add.length === 0 ? "empty" : "ready";
  return {
    verdict,
    add,
    excluded: triage.flagged,
    alreadyStaged,
    ignored: triage.ignored,
    unmerged,
    embeddedRepos,
    undecodable,
  };
}

const NAMED_ESCAPES: Readonly<Record<string, string>> = {
  "\u0007": "\\a",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\v": "\\v",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
};

/**
 * One path as one LINE `git add --pathspec-from-file=-` reads back as that
 * exact path.
 *
 * Without `--pathspec-file-nul`, git reads one pathspec per line and C-unquotes
 * a line that BEGINS with a double quote, exactly as `core.quotePath` writes
 * one. So an ordinary path -- spaces, leading or trailing ones included, and
 * non-ASCII -- is written raw, and only a path that could not survive a line
 * is quoted: one carrying a control character (a newline would split it, a
 * trailing carriage return would be eaten as CR/LF) or one that itself starts
 * with `"` (which git would otherwise try to unquote). Inside the quotes `"` and
 * `\` are escaped, the usual control characters take their C names and the rest
 * are three-digit octal. Non-ASCII stays raw: git's unquote copies every byte it
 * does not recognise as an escape.
 */
export function pathspecLine(path: string): string {
  const needsQuoting = path.startsWith('"') || /[\u0000-\u001f\u007f]/.test(path);
  if (!needsQuoting) return path;
  let quoted = '"';
  for (const char of path) {
    const named = NAMED_ESCAPES[char];
    const code = char.codePointAt(0) ?? 0;
    if (named !== undefined) quoted += named;
    else if (code < 0x20 || code === 0x7f) quoted += `\\${code.toString(8).padStart(3, "0")}`;
    else quoted += char;
  }
  return `${quoted}"`;
}

/** The name detectors alone -- what a path's NAME says, with nothing to measure. */
function nameReasons(path: string, scopePrefixes: readonly string[], binaryPaths: ReadonlySet<string>): FlagReason[] {
  const reasons: FlagReason[] = [];
  if (SECRET_SHAPE.test(path)) reasons.push("secret-shape");
  if (binaryPaths.has(path) || BINARY_EXTENSION.test(path)) reasons.push("binary");
  if (scopePrefixes.length > 0 && !scopePrefixes.some((prefix): boolean => path.startsWith(prefix))) reasons.push("out-of-scope");
  if (LOCAL_CONFIG_SHAPE.test(path)) reasons.push("local-config");
  return reasons;
}

/**
 * THE COMMITTED-RANGE TRIAGE (zheref/nen#337). The NET change -- what `<head>`
 * holds against the merge base -- goes through `triageStage` exactly as a
 * working-copy reading does: deletions and `--mentions` are about what the
 * range lands, and each net path is measured by the blob it has at `<head>`.
 *
 * Then the HISTORY -- every change any commit in the range made, merges read
 * as combined diffs -- is read for what the endpoints cannot show:
 *  - a path NOT in the net change (added then deleted, renamed away, changed
 *    and reverted) is run through the name detectors, keyed on its raw bytes;
 *  - every blob a commit introduced at a path, other than the one the path
 *    holds at `<head>`, is measured, so a dump committed and deleted, or a file
 *    grown and shrunk, still trips `large` (hanten round 2 N1).
 * Any such finding carries `in-history`. A history-only path with no finding
 * is not reported: it is not in the change the range lands, and nothing about
 * it needs a human. A non-UTF-8 name -- net or history-only -- is flagged
 * `undecodable` (hanten round 2 N7).
 *
 * `blobSizes` is keyed by object id; an id it does not carry is not measured.
 */
export function triageRange(
  net: readonly RawChange[],
  history: readonly RawChange[],
  blobSizes: ReadonlyMap<string, number>,
  options: Omit<TriageOptions, "sizes"> = {},
): TriageResult {
  const largeBytes = options.largeBytes ?? DEFAULT_LARGE_BYTES;
  const scopePrefixes = options.scopePrefixes ?? [];
  const binaryPaths = options.binaryPaths ?? new Set<string>();

  // KEYED ON RAW BYTES, NEVER ON THE DISPLAY PATH (Copilot round 1 on #379):
  // two non-UTF-8 names can decode to the same lenient string, so a size or
  // a reason looked up by `entry.path` could land on the wrong file. Each net
  // change is triaged on its own, with its own size, and every extra reason
  // is filed under `RawChange.key`; `entry.path` is only ever rendered.
  const headOid = new Map<string, string>();
  for (const change of net) headOid.set(change.key, change.oid);

  const extra = new Map<string, FlagReason[]>();
  const add = (key: string, reason: FlagReason): void => {
    const list = extra.get(key) ?? [];
    if (!list.includes(reason)) list.push(reason);
    extra.set(key, list);
  };
  for (const change of net) if (change.entry.undecodable === true) add(change.key, "undecodable");

  // History, per raw-byte key, first-seen order kept.
  interface Finding {
    path: string;
    undecodable: boolean;
    large: boolean;
  }
  const historyOnly = new Map<string, Finding>();
  for (const change of history) {
    const inNet = headOid.has(change.key);
    const size = measurableBlob(change) ? blobSizes.get(change.oid) : undefined;
    const largeHere = size !== undefined && size >= largeBytes && change.oid !== headOid.get(change.key);
    if (inNet) {
      if (largeHere) {
        add(change.key, "large");
        add(change.key, "in-history");
      }
      continue;
    }
    const finding = historyOnly.get(change.key) ?? {
      path: change.entry.path,
      undecodable: change.entry.undecodable === true,
      large: false,
    };
    finding.large ||= largeHere;
    historyOnly.set(change.key, finding);
  }

  const clean: string[] = [];
  const flagged: FlaggedFile[] = [];
  let ignored: readonly FlaggedFile[] = [];
  for (const change of net) {
    const size = measurableBlob(change) ? blobSizes.get(change.oid) : undefined;
    const sizes = new Map<string, number>(size === undefined ? [] : [[change.entry.path, size]]);
    const one = triageStage([change.entry], { ...options, sizes });
    ignored = [...ignored, ...one.ignored];
    const own = one.flagged[0]?.reasons ?? [];
    const more = (extra.get(change.key) ?? []).filter((reason): boolean => !own.includes(reason));
    const reasons = [...own, ...more];
    if (reasons.length === 0) clean.push(change.entry.path);
    else flagged.push({ path: change.entry.path, reasons });
  }
  for (const finding of historyOnly.values()) {
    const reasons = nameReasons(finding.path, scopePrefixes, binaryPaths);
    if (finding.undecodable) reasons.push("undecodable");
    if (finding.large) reasons.push("large");
    if (reasons.length > 0) flagged.push({ path: finding.path, reasons: [...reasons, "in-history"] });
  }
  return { clean, flagged, ignored };
}
