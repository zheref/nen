// src/report/register.ts -- `nen report data --register <desk>`: the backlog
// register document (Hatsu backlog-board § 3) assembled by the verb, so the
// callers that render a Rikugan page stop composing it by hand (zheref/nen#276).
//
// THE DOCUMENT HAS TWO AUTHORS, AND THE LINE BETWEEN THEM IS THE POINT. Some of
// a register is FACT -- an object's readiness, its check and thread counts, its
// labels, its notation, the tallies those facts add up to, the spend its
// ledgers recorded -- and some is JUDGEMENT a model writes: the page's title,
// the asks on the desk, what each row is waiting on, who is driving it. Before
// this module both halves were assembled in a scratch builder, which meant the
// facts were re-typed by the same hand that wrote the judgement, and a
// readiness cell could say whatever the builder said. Now the caller hands over
// ONLY the judgement, in a "desk" file, and nen supplies every fact from the
// reads `report data` already made.
//
// A READINESS CELL IS QUOTED, NEVER WRITTEN. Every `verdict` on the page -- a
// register row's and a desk ask's -- is the object's own `readiness.reason`
// (the `nen pr ready` gate line, or the head's `readiness` check run's verdict
// line), verbatim. The desk file may not carry a `verdict` anywhere -- every
// level of it refuses a key it does not know, so that is a property of the
// parser rather than of a list of places somebody remembered to check -- and an
// ask that wants one names the pull request (`pr`) and nen quotes that row's.
// A row with no readiness (an issue, or a pull request neither authority could
// answer) has the empty verdict, which is the report-data convention for
// "nothing to say" -- and that row's `notes[]` says why, on the page.
//
// ON THE OFFLINE PATH THE VERDICT'S AUTHORITY IS THE CALLER'S FILE. Rows read
// through `--objects-from` carry whatever `readiness` that file carried; nen
// quotes it exactly as it quotes a live one, and says on the page -- in
// `footerNote` and in each such row's `notes[]` -- that it came from that file
// and not from GitHub. "Quoted verbatim" is true on both paths; "from `nen pr
// ready`" is true only on the live one.
//
// A DESK NAMES AN OBJECT BY ITS IDENTITY, NOT ITS NUMBER. A register can span
// repositories, and `#87` exists in each of them. So desk rows and an ask's
// `pr` are resolved against (repository, number) -- written as notation
// (`HA-PR-#87`), as `owner/name#87`, or bare (`pr#87`, `87`) only when exactly
// one object in scope answers to it; an ambiguous bare reference is refused
// naming the candidates.
//
// EVERY KEY THE TEMPLATE ITERATES IS ALWAYS PRESENT. `nen report render`
// refuses a token the document has not got, so an ask without an `objects`
// list would not render empty -- it would reach OUT to the register's
// top-level `objects` through the scope chain and fail on a row's missing
// `label`. Every list is `[]` and every string `""` when there is nothing.

import { VerbUsageError } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import { formatRef, OBJECT_REF, parseRef, type ObjectKind } from "../ref/notation.js";
import type { ReportPhase, ReportUsage } from "./data.js";
import type { ReportObject } from "./objects.js";

/** The ask kinds a desk carries, in Hatsu's own words. */
export const ASK_KINDS: readonly string[] = ["DECIDE", "DO", "MERGE"];

/** `star` and `starredClass` on a recommended option (PROCESS.md § Escaping). */
export const STAR_LABEL = "recommended";
export const STARRED_CLASS = "starred";

/** The `url` shape a page may link to; anything else is a script waiting for a click. */
export const SAFE_URL = /^(https?:\/\/|mailto:|#|\/)/;

/** What the caller writes about one row. Every field optional; absent is `""`. */
export interface DeskRow {
  readonly marks: string;
  readonly gate: string;
  readonly gateClass: string;
  readonly needs: string;
  readonly session: string;
  readonly lane: string;
  readonly thought: string;
}

export interface DeskOption {
  readonly letter: string;
  readonly label: string;
  readonly command: string;
  readonly consequence: string;
  readonly star: boolean;
}

export interface DeskAsk {
  readonly kind: string;
  readonly rank: number;
  readonly title: string;
  readonly why: string;
  /**
   * The pull request whose readiness this ask quotes, AS WRITTEN -- a number,
   * notation, `owner/name#<n>` or `pr#<n>` -- or null. Resolved against the
   * objects in scope by `assembleRegister`, which is the one place that knows
   * them.
   */
  readonly pr: string | number | null;
  readonly options: readonly DeskOption[];
  readonly objects: readonly { readonly label: string; readonly url: string }[];
}

export interface DeskGate {
  readonly gate: string;
  readonly label: string;
  readonly cleared: string;
  readonly asks: readonly DeskAsk[];
}

/** `--register <file>`, validated. */
export interface Desk {
  readonly variant: string;
  readonly title: string;
  readonly scope: string;
  readonly gate: string;
  readonly generatedAtLocal: string | null;
  readonly footerNote: string;
  readonly architectureCaption: string;
  readonly gates: readonly DeskGate[];
  /** Keyed by an object reference AS WRITTEN; resolved by `assembleRegister`. */
  readonly rows: ReadonlyMap<string, DeskRow>;
  readonly legendRows: readonly { readonly mark: string; readonly meaning: string }[];
  /** Which ledger efforts the spend block shows, in order; null = every one recorded. */
  readonly efforts: readonly string[] | null;
  readonly spendNotes: ReadonlyMap<string, string>;
}

// ── the desk file, validated at the read seam ───────────────────────────────

const DESK_SHAPE =
  '{ variant, title, scope, gate, generatedAtLocal?, footerNote?, architectureCaption?, gates: [{ gate, label, cleared?, asks: [{ kind: DECIDE|DO|MERGE, rank, title, why, pr?, options: [{ letter, label, command, consequence, star? }], objects?: [{ label, url }] }] }], rows?: { "<CODE>-<IS|PR>-#<n>"|"<owner>/<name>#<n>"|"pr#<n>"|"issue#<n>": { marks?, gate?, gateClass?, needs?, session?, lane?, thought? } }, legendRows?: [{ mark, meaning }], efforts?: [<effort>], spendNotes?: { "<effort>": "<line>" } }';

function refuseDesk(display: string, where: string, what: string): never {
  throw new VerbUsageError(
    `'${display}': ${where} ${what}. The desk is the judgement half of the register -- ${DESK_SHAPE}. Every fact (readiness, counts, notation, tallies, spend) is nen's to fill, so a desk that cannot be read is refused whole rather than rendered with a hole in it.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "string") return `'${value}'`;
  return `a ${typeof value}`;
}

function str(record: Record<string, unknown>, key: string, display: string, where: string, required: boolean): string {
  const value = record[key];
  if (value === undefined && !required) return "";
  if (typeof value !== "string") refuseDesk(display, where, `has '${key}' of ${kindOf(value)}, not a string`);
  return value;
}

function list(record: Record<string, unknown>, key: string, display: string, where: string, required: boolean): unknown[] {
  const value = record[key];
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) refuseDesk(display, where, `has '${key}' of ${kindOf(value)}, not a list`);
  return value;
}

function url(value: string, display: string, where: string): string {
  if (!SAFE_URL.test(value)) {
    refuseDesk(
      display,
      where,
      `has a 'url' of '${value}', which does not start with https://, http://, mailto:, # or / -- escaping makes a 'javascript:' href harmless as text and harmless as nothing else`,
    );
  }
  return value;
}

/**
 * Every level of the desk admits only its own keys (Nobunaga N5/N13).
 *
 * A KEY NOBODY READS IS AN INSTRUCTION SILENTLY DROPPED, and one of them is
 * worse than the rest: a `verdict` written on a gate, an option or a legend
 * row would be ignored by the renderer's scope chain one day and answer a
 * `{{verdict}}` token the next. So `verdict` is refused by name with the
 * reason, and anything else unknown is refused naming what IS read there.
 */
function allowKeys(record: Record<string, unknown>, allowed: readonly string[], display: string, where: string): void {
  if (Object.hasOwn(record, "verdict")) {
    refuseDesk(
      display,
      where,
      "carries a 'verdict'. A readiness verdict is QUOTED from the object's own readiness, never written -- name the pull request with 'pr' on an ask and nen quotes that row's verdict verbatim",
    );
  }
  const unknown = Object.keys(record).filter((key): boolean => !allowed.includes(key));
  if (unknown.length > 0) {
    refuseDesk(
      display,
      where,
      `names ${unknown.map((key): string => `'${key}'`).join(", ")}, which the desk does not write there -- it reads ${allowed.join(", ")}`,
    );
  }
}

function parseOption(entry: unknown, display: string, where: string): DeskOption {
  if (!isRecord(entry)) refuseDesk(display, where, `is ${kindOf(entry)}, not an option object`);
  allowKeys(entry, ["letter", "label", "command", "consequence", "star"], display, where);
  const star = entry["star"];
  if (star !== undefined && typeof star !== "boolean") {
    refuseDesk(display, where, `has 'star' of ${kindOf(star)}; it is true on the recommended option and absent or false elsewhere`);
  }
  const letter = str(entry, "letter", display, where, true);
  if (letter.trim() === "") refuseDesk(display, where, "has an empty 'letter'");
  return {
    letter,
    label: str(entry, "label", display, where, true),
    command: str(entry, "command", display, where, true),
    consequence: str(entry, "consequence", display, where, true),
    star: star === true,
  };
}

function parseAsk(entry: unknown, display: string, where: string): DeskAsk {
  if (!isRecord(entry)) refuseDesk(display, where, `is ${kindOf(entry)}, not an ask object`);
  allowKeys(entry, ["kind", "rank", "title", "why", "pr", "options", "objects"], display, where);
  const kind = str(entry, "kind", display, where, true);
  if (!ASK_KINDS.includes(kind)) {
    refuseDesk(display, where, `has 'kind' of '${kind}'; an ask opens ${ASK_KINDS.join(", ")}`);
  }
  const rank = entry["rank"];
  if (typeof rank !== "number" || !Number.isInteger(rank) || rank <= 0) {
    refuseDesk(display, where, `has 'rank' of ${kindOf(rank)}, not a positive whole number (1 unblocks the most)`);
  }
  const pr = entry["pr"];
  if (
    pr !== undefined &&
    pr !== null &&
    !(typeof pr === "number" && Number.isInteger(pr) && pr > 0) &&
    !(typeof pr === "string" && pr.trim() !== "")
  ) {
    refuseDesk(display, where, `has 'pr' of ${kindOf(pr)}, not a pull-request reference (a number, notation, or owner/name#<n>)`);
  }
  const options = list(entry, "options", display, where, true).map((option, index): DeskOption =>
    parseOption(option, display, `${where}.options[${index}]`),
  );
  const letters = options.map((option): string => option.letter);
  const duplicate = letters.find((letter, index): boolean => letters.indexOf(letter) !== index);
  if (duplicate !== undefined) refuseDesk(display, where, `letters two options '${duplicate}'; the picker cannot ask that`);
  const stars = options.filter((option): boolean => option.star).length;
  if (stars !== 1) {
    refuseDesk(display, where, `stars ${stars} options; an ask recommends exactly one, the same one the surface's picker stars`);
  }
  const objects = list(entry, "objects", display, where, false).map((object, index): { label: string; url: string } => {
    const at = `${where}.objects[${index}]`;
    if (!isRecord(object)) refuseDesk(display, at, `is ${kindOf(object)}, not a { label, url } object`);
    allowKeys(object, ["label", "url"], display, at);
    return { label: str(object, "label", display, at, true), url: url(str(object, "url", display, at, true), display, at) };
  });
  return {
    kind,
    rank,
    title: str(entry, "title", display, where, true),
    why: str(entry, "why", display, where, true),
    pr: typeof pr === "number" || typeof pr === "string" ? pr : null,
    options,
    objects,
  };
}

function parseGate(entry: unknown, display: string, where: string): DeskGate {
  if (!isRecord(entry)) refuseDesk(display, where, `is ${kindOf(entry)}, not a gate object`);
  allowKeys(entry, ["gate", "label", "cleared", "asks"], display, where);
  const gate = str(entry, "gate", display, where, true);
  if (gate.trim() === "") refuseDesk(display, where, "has an empty 'gate'");
  const asks = list(entry, "asks", display, where, true).map((ask, index): DeskAsk =>
    parseAsk(ask, display, `${where}.asks[${index}]`),
  );
  const cleared = str(entry, "cleared", display, where, false);
  // A GATE WITH NOTHING OWED IS RENDERED CLEARED, NEVER OMITTED -- and a
  // cleared gate with nothing to say about why reads as a gate nobody checked.
  if (asks.length === 0 && cleared.trim() === "") {
    refuseDesk(display, where, "has no asks and no 'cleared' line; a gate with nothing owed is shown cleared, with the line that says so");
  }
  if (asks.length > 0 && cleared !== "") {
    refuseDesk(display, where, "has asks AND a 'cleared' line; a gate is cleared only when nothing on it is owed");
  }
  // RANKED HERE, stably, so the desk's order is the rank and never the file's.
  const ranked = [...asks].sort((a, b): number => a.rank - b.rank);
  return { gate, label: str(entry, "label", display, where, true), cleared, asks: ranked };
}

const ROW_FIELDS: readonly (keyof DeskRow)[] = ["marks", "gate", "gateClass", "needs", "session", "lane", "thought"];

function parseRows(value: unknown, display: string): ReadonlyMap<string, DeskRow> {
  const rows = new Map<string, DeskRow>();
  if (value === undefined) return rows;
  if (!isRecord(value)) refuseDesk(display, "'rows'", `is ${kindOf(value)}, not an object keyed 'pr#<n>' / 'issue#<n>'`);
  for (const [key, entry] of Object.entries(value)) {
    const where = `rows['${key}']`;
    if (parseReference(key) === null) {
      refuseDesk(display, where, `is not keyed by an object reference -- ${REFERENCE_FORMS}`);
    }
    if (!isRecord(entry)) refuseDesk(display, where, `is ${kindOf(entry)}, not an object`);
    allowKeys(entry, ROW_FIELDS, display, where);
    const row: Record<string, string> = {};
    for (const field of ROW_FIELDS) row[field] = str(entry, field, display, where, false);
    rows.set(key, row as unknown as DeskRow);
  }
  return rows;
}

/** `--register <file>`'s parsed document, validated field by field. */
export function parseDesk(document: unknown, display: string): Desk {
  if (!isRecord(document)) refuseDesk(display, "the document", `is ${kindOf(document)}, not an object`);
  allowKeys(
    document,
    ["variant", "title", "scope", "gate", "generatedAtLocal", "footerNote", "architectureCaption", "gates", "rows", "legendRows", "efforts", "spendNotes"],
    display,
    "the document",
  );
  const variant = str(document, "variant", display, "the document", true);
  if (variant.trim() === "") refuseDesk(display, "the document", "has an empty 'variant'; it names the reports.sections variant this register renders as");
  const generatedAtLocal = document["generatedAtLocal"];
  if (generatedAtLocal !== undefined && typeof generatedAtLocal !== "string") {
    refuseDesk(display, "the document", `has 'generatedAtLocal' of ${kindOf(generatedAtLocal)}, not a string`);
  }
  const legendRows = list(document, "legendRows", display, "the document", false).map((entry, index) => {
    const where = `legendRows[${index}]`;
    if (!isRecord(entry)) refuseDesk(display, where, `is ${kindOf(entry)}, not a { mark, meaning } object`);
    allowKeys(entry, ["mark", "meaning"], display, where);
    return { mark: str(entry, "mark", display, where, true), meaning: str(entry, "meaning", display, where, true) };
  });
  const effortsRaw = document["efforts"];
  let efforts: string[] | null = null;
  if (effortsRaw !== undefined) {
    if (!Array.isArray(effortsRaw) || effortsRaw.some((entry): boolean => typeof entry !== "string" || entry === "")) {
      refuseDesk(display, "'efforts'", "is not a list of effort names");
    }
    efforts = [...new Set(effortsRaw as string[])];
  }
  const notesRaw = document["spendNotes"];
  const spendNotes = new Map<string, string>();
  if (notesRaw !== undefined) {
    if (!isRecord(notesRaw)) refuseDesk(display, "'spendNotes'", `is ${kindOf(notesRaw)}, not an object of effort to line`);
    for (const [effort, line] of Object.entries(notesRaw)) {
      if (typeof line !== "string") refuseDesk(display, `spendNotes['${effort}']`, `is ${kindOf(line)}, not a string`);
      spendNotes.set(effort, line);
    }
  }
  return {
    variant,
    title: str(document, "title", display, "the document", true),
    scope: str(document, "scope", display, "the document", true),
    gate: str(document, "gate", display, "the document", true),
    generatedAtLocal: typeof generatedAtLocal === "string" ? generatedAtLocal : null,
    footerNote: str(document, "footerNote", display, "the document", false),
    architectureCaption: str(document, "architectureCaption", display, "the document", false),
    gates: list(document, "gates", display, "the document", true).map((gate, index): DeskGate =>
      parseGate(gate, display, `gates[${index}]`),
    ),
    rows: parseRows(document["rows"], display),
    legendRows,
    efforts,
    spendNotes,
  };
}

// ── notation and references ─────────────────────────────────────────────────

/**
 * `owner/name` <-> product code, from the registry.
 *
 * A SEAM, so the register is testable without a registry on disk and the
 * command layer owns the one read of `nen/repos.json`.
 */
export interface NotationSource {
  readonly codeFor: (slug: string) => string | null;
  readonly slugFor: (code: string) => string | null;
  /** Why no code could be read at all (no registry), or null when one was. */
  readonly unavailable: string | null;
}

const OBJECT_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(?:pull|issues)\/\d+\/?$/;

/** The `owner/name` an object lives in: the target's, else its own URL's. */
function slugOf(object: ReportObject, target: string | null): string | null {
  if (target !== null) return target;
  return OBJECT_URL.exec(object.url)?.[1] ?? null;
}

/**
 * The notation for one object, through ../ref/notation.ts's own formatter --
 * the bare token, no glyph or state mark (the page has its own `marks`
 * column) -- or the `<owner>/<name>#<n>` fallback when no code resolves.
 *
 * `kind` NULL IS A NUMBER WHOSE KIND NOBODY READ (a `linked[]` entry that is
 * not in scope), and it is written KIND-FREE, `<CODE>#<n>`: a reference whose
 * IS/PR half is guessed is a reference that can be wrong (Nobunaga N4).
 */
function notationOf(kind: ObjectKind | null, number: number, slug: string | null, codes: NotationSource): { text: string; resolved: boolean } {
  const code = slug === null ? null : codes.codeFor(slug);
  if (code !== null) {
    try {
      const ref = formatRef({ code, kind: kind ?? "IS", number, glyphs: false }).ref;
      return { text: kind === null ? `${code}#${number}` : ref, resolved: true };
    } catch {
      // A registry code that is not two or three uppercase letters is no code
      // at all to the notation; it falls back like an unknown one.
    }
  }
  return { text: slug === null ? `#${number}` : `${slug}#${number}`, resolved: false };
}

/** The forms a desk may name an object in, said once for every refusal. */
const REFERENCE_FORMS =
  "notation ('HA-PR-#87'), '<owner>/<name>#87', or bare ('pr#87', 'issue#85', '87') when exactly one object in scope answers to it";

type Reference =
  | { readonly form: "notation"; readonly code: string; readonly kind: "pr" | "issue"; readonly number: number }
  | { readonly form: "slug"; readonly slug: string; readonly number: number }
  | { readonly form: "bare"; readonly kind: "pr" | "issue" | null; readonly number: number };

const SLUG_REFERENCE = /^([^/\s#]+\/[^/\s#]+)#([1-9][0-9]*)$/;
const BARE_REFERENCE = /^(?:(pr|issue)#|#)?([1-9][0-9]*)$/;

/** A desk reference parsed, or null when it is none of the forms. */
export function parseReference(raw: string | number): Reference | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? { form: "bare", kind: null, number: raw } : null;
  const text = raw.trim();
  if (OBJECT_REF.test(text)) {
    const ref = parseRef(text);
    return { form: "notation", code: ref.code, kind: ref.kind === "PR" ? "pr" : "issue", number: ref.number };
  }
  const slug = SLUG_REFERENCE.exec(text);
  if (slug !== null) return { form: "slug", slug: slug[1] as string, number: Number(slug[2]) };
  const bare = BARE_REFERENCE.exec(text);
  if (bare !== null) return { form: "bare", kind: (bare[1] as "pr" | "issue" | undefined) ?? null, number: Number(bare[2]) };
  return null;
}

/** One object in scope, with the identity a desk reference resolves against. */
interface Scoped {
  readonly object: ReportObject;
  readonly slug: string | null;
  readonly notation: string;
}

/**
 * Two repository names for the same repository.
 *
 * A BARE NAME MATCHES A SLUG'S NAME HALF, on src/repo/resolve.ts's own rule: a
 * registry may record a product code's value as `KroApple` with no owner, and
 * a bare value cannot disagree about an owner it never states.
 */
function sameSlug(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  if (!x.includes("/") && y.includes("/")) return y.split("/")[1] === x;
  if (!y.includes("/") && x.includes("/")) return x.split("/")[1] === y;
  return false;
}

/**
 * A desk reference -> the one object in scope it names, or a refusal at exit 2.
 *
 * GITHUB NUMBERS ISSUES AND PULL REQUESTS FROM ONE SEQUENCE PER REPOSITORY, so
 * (repository, number) is an identity and the kind is a check rather than a
 * key: `HA-IS-#87` naming a pull request is a wrong reference, refused.
 */
function resolveReference(raw: string | number, scope: readonly Scoped[], codes: NotationSource, what: string, want: "pr" | null): Scoped {
  const ref = parseReference(raw);
  const shown = typeof raw === "number" ? String(raw) : `'${raw}'`;
  if (ref === null) throw new VerbUsageError(`the register desk's ${what} names ${shown}, which is not an object reference -- ${REFERENCE_FORMS}.`);
  let candidates: Scoped[];
  if (ref.form === "notation") {
    const slug = codes.slugFor(ref.code);
    if (slug === null) {
      throw new VerbUsageError(
        `the register desk's ${what} names ${shown}, and '${ref.code}' is not a product code in nen/repos.json${codes.unavailable === null ? "" : ` (${codes.unavailable})`}. Write it as '<owner>/<name>#${ref.number}' instead.`,
      );
    }
    candidates = scope.filter((entry): boolean => sameSlug(entry.slug, slug) && entry.object.number === ref.number);
    const kind = ref.kind;
    const wrong = candidates.find((entry): boolean => entry.object.kind !== kind);
    if (wrong !== undefined) {
      throw new VerbUsageError(`the register desk's ${what} names ${shown}, but ${wrong.notation} is ${wrong.object.kind === "pr" ? "a pull request" : "an issue"}.`);
    }
  } else if (ref.form === "slug") {
    candidates = scope.filter((entry): boolean => sameSlug(entry.slug, ref.slug) && entry.object.number === ref.number);
  } else {
    const kind = ref.kind ?? want;
    candidates = scope.filter((entry): boolean => entry.object.number === ref.number && (kind === null || entry.object.kind === kind));
  }
  if (candidates.length === 0) {
    throw new VerbUsageError(
      `the register desk's ${what} names ${shown}, which is not in this register's objects (${scope.map((entry): string => entry.notation).join(", ") || "none"}). Name it with --prs/--issues, or drop it: judgement about an object the page does not show is judgement nobody reads.`,
    );
  }
  if (candidates.length > 1) {
    throw new VerbUsageError(
      `the register desk's ${what} names ${shown}, which is ambiguous in this register: ${candidates.map((entry): string => entry.notation).join(", ")}. Write the repository too -- notation or '<owner>/<name>#<n>'.`,
    );
  }
  const found = candidates[0] as Scoped;
  if (want !== null && found.object.kind !== want) {
    throw new VerbUsageError(`the register desk's ${what} names ${found.notation}, which is an issue; a readiness verdict is a statement about a pull request.`);
  }
  return found;
}

// ── the rows ────────────────────────────────────────────────────────────────

/**
 * The verdict to quote, or `""` when no authority answered. Never composed.
 *
 * THE BARE-WORD FALLBACK IS STILL A QUOTE (Nobunaga N9). `reason` is empty only
 * when the authority gave a verdict word and no line -- a gate whose `gateLine`
 * was empty. Its `verdict` (`ready`, `not-ready`) is then the whole of what it
 * said, so that word is quoted rather than nothing: nen adds no text of its
 * own to either.
 */
export function quotedVerdict(object: ReportObject): string {
  if (object.readiness === null) return "";
  return object.readiness.reason !== "" ? object.readiness.reason : object.readiness.verdict;
}

export type RegisterRow = ReportObject & {
  readonly notation: string;
  readonly marks: string;
  readonly gate: string;
  readonly gateClass: string;
  readonly verdict: string;
  readonly needs: string;
  readonly session: string;
  readonly lane: string;
  readonly thought: string;
  readonly labelsLine: string;
  readonly checksLine: string;
  readonly threadsLine: string;
  readonly linkedLine: string;
  readonly head: string;
  readonly notes: readonly string[];
};

const EMPTY_ROW: DeskRow = { marks: "", gate: "", gateClass: "", needs: "", session: "", lane: "", thought: "" };

function registerRow(
  entry: Scoped,
  desk: DeskRow,
  scope: readonly Scoped[],
  codes: NotationSource,
  verdictFile: string | null,
): RegisterRow {
  const { object, slug } = entry;
  // EACH LINKED NUMBER TAKES ITS KIND FROM THE OBJECT IN SCOPE THAT HAS IT, and
  // is written kind-free when none does (Nobunaga N4): a PR body's `#12` may be
  // an issue or another pull request, and `linked[]` does not say which.
  const linkedLine = object.linked
    .map((number): string => {
      const known = scope.find((other): boolean => sameSlug(other.slug, slug) && other.object.number === number);
      if (known !== undefined) return known.notation;
      return notationOf(null, number, slug, codes).text;
    })
    .join(", ");
  const notes = [...object.notes];
  if (object.kind === "pr" && object.readiness === null && !notes.some((line): boolean => /readiness/i.test(line))) {
    // THE BLANK VERDICT IS EXPLAINED ON THE PAGE (Nobunaga N7), even when the
    // row arrived with nothing to say about why.
    notes.push("no readiness authority answered for this pull request, so its verdict is blank");
  }
  if (object.kind === "pr" && object.readiness !== null && verdictFile !== null) {
    notes.push(`verdict read from ${verdictFile}, not from GitHub`);
  }
  let link = object.url;
  if (link !== "" && !SAFE_URL.test(link)) {
    notes.push(`'url' '${plainLine(link)}' is not an http(s), mailto, # or / link, so it is not published as one`);
    link = "";
  }
  return {
    ...object,
    url: link,
    notation: entry.notation,
    marks: desk.marks,
    gate: desk.gate,
    gateClass: desk.gateClass,
    verdict: quotedVerdict(object),
    needs: desk.needs,
    session: desk.session,
    lane: desk.lane,
    thought: desk.thought,
    labelsLine: object.labels.join(", "),
    checksLine:
      object.kind === "pr"
        ? `${object.checks.green}/${object.checks.total} green · ${object.checks.red} red · ${object.checks.pending} pending`
        : "",
    threadsLine: object.kind === "pr" ? `${object.threads.unresolved}/${object.threads.total} unresolved` : "",
    linkedLine,
    head: object.kind === "pr" ? object.head : "",
    notes,
  } as RegisterRow;
}

// ── the tallies ─────────────────────────────────────────────────────────────

/** A pull request still open: the only kind a tally of readiness speaks about. */
function openPr(object: ReportObject): boolean {
  return object.kind === "pr" && object.state.toUpperCase() === "OPEN";
}

/**
 * A pull request something concrete stands in front of: a red check, an
 * unresolved thread, or a merge conflict. Facts on the row, never the eye's.
 */
function blocked(object: ReportObject): boolean {
  if (!openPr(object) || object.kind !== "pr") return false;
  return object.checks.red > 0 || object.threads.unresolved > 0 || object.mergeStateStatus.toUpperCase() === "DIRTY";
}

export interface Tallies {
  readonly tallyScope: number;
  readonly tallyNeedsYou: number;
  readonly tallyBlockers: number;
  readonly tallyReady: number;
  readonly tallyInFlight: number;
}

/**
 * The five numbers at the top of the page, each a count of facts.
 *
 *   scope      every row in the register
 *   needsYou   every ask on the desk
 *   blockers   open pull requests with a red check, an unresolved thread, or a
 *              DIRTY merge state
 *   ready      open pull requests whose quoted readiness verdict is `ready`
 *   inFlight   open pull requests that are neither
 */
export function tallies(objects: readonly ReportObject[], gates: readonly DeskGate[]): Tallies {
  const open = objects.filter(openPr);
  const ready = open.filter((object): boolean => object.readiness?.verdict === "ready" && !blocked(object));
  const blockers = open.filter(blocked);
  return {
    tallyScope: objects.length,
    tallyNeedsYou: gates.reduce((sum, gate): number => sum + gate.asks.length, 0),
    tallyBlockers: blockers.length,
    tallyReady: ready.length,
    tallyInFlight: open.length - ready.length - blockers.length,
  };
}

// ── spend ───────────────────────────────────────────────────────────────────

/** `12.3 s` under a minute, `4 m 05 s` from one. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${(Math.round(seconds * 10) / 10).toFixed(1)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} m ${String(whole % 60).padStart(2, "0")} s`;
}

export interface SpendPhase {
  readonly lane: string;
  readonly percent: string;
  readonly amount: string;
  readonly steps: string;
}

export interface SpendUsage {
  readonly surface: string;
  readonly model: string | null;
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly minutes: number | null;
  readonly source: string | null;
  readonly notReported: boolean;
  readonly reported: boolean;
}

export interface SpendEffort {
  readonly name: string;
  readonly actionsMinutes: number | string;
  readonly spendNote: string;
  readonly hasSpendPhases: boolean;
  readonly noSpendPhases: boolean;
  readonly spendPhases: readonly SpendPhase[];
  readonly spendUsage: readonly SpendUsage[];
}

function sum(entries: readonly ReportUsage[], key: "input" | "output" | "cacheRead" | "cacheWrite" | "minutes"): number | null {
  const values = entries.map((entry): number | null => entry[key]).filter((value): value is number => value !== null);
  return values.length === 0 ? null : values.reduce((a, b): number => a + b, 0);
}

/**
 * One effort's spend block, from its two ledgers, as Hatsu's
 * spiritual-message § 4 builds it: a phase bar's `percent` is its duration
 * over the effort's longest, a usage row is one surface+model with its
 * counters summed, and `actionsMinutes` is the sum of every `minutes` entry --
 * `not read` when none was recorded.
 */
export function spendEffort(name: string, phases: readonly ReportPhase[], usage: readonly ReportUsage[], note: string): SpendEffort {
  const mine = phases.filter((phase): boolean => phase.effort === name);
  const longest = Math.max(0, ...mine.map((phase): number => phase.durationMs ?? 0));
  const spendPhases = mine.map((phase): SpendPhase => ({
    lane: phase.phase,
    percent:
      phase.durationMs === null || longest === 0
        ? "0"
        : String(Math.round((phase.durationMs / longest) * 1000) / 10),
    amount: phase.durationMs === null ? "not ended" : formatDuration(phase.durationMs),
    steps: phase.steps
      .map((step): string => `${step.verb} ${step.durationMs === null ? "not timed" : formatDuration(step.durationMs)}`)
      .join(" · "),
  }));
  const groups = new Map<string, ReportUsage[]>();
  for (const entry of usage) {
    if (entry.effort !== name) continue;
    const key = `${entry.surface}\u0000${entry.model ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const spendUsage = [...groups.values()].map((entries): SpendUsage => {
    const first = entries[0] as ReportUsage;
    // ANY `--not-reported` ENTRY MARKS ITS GROUP (spiritual-message § 4,
    // Nobunaga N10): a surface that could not report part of its spend has
    // not reported its spend, and a sum of the parts it did report would read
    // as the whole.
    const notReported = entries.some((entry): boolean => entry.notReported);
    const sources = [...new Set(entries.map((entry): string | null => entry.source).filter((s): s is string => s !== null))];
    return {
      surface: first.surface,
      model: first.model,
      input: sum(entries, "input"),
      output: sum(entries, "output"),
      cacheRead: sum(entries, "cacheRead"),
      cacheWrite: sum(entries, "cacheWrite"),
      minutes: sum(entries, "minutes"),
      source: sources.length === 0 ? null : sources.join(", "),
      notReported,
      reported: !notReported,
    };
  });
  const minutes = sum(usage.filter((entry): boolean => entry.effort === name), "minutes");
  return {
    name,
    actionsMinutes: minutes ?? "not read",
    spendNote: note,
    hasSpendPhases: spendPhases.length > 0,
    noSpendPhases: spendPhases.length === 0,
    spendPhases,
    spendUsage,
  };
}

// ── the document ────────────────────────────────────────────────────────────

export interface RegisterInput {
  readonly generatedAt: string;
  /**
   * `report data`'s derived local clock (zheref/nen#258), or null when the
   * zone could not be named. The desk's own `generatedAtLocal` still wins.
   */
  readonly generatedAtLocal: string | null;
  readonly objects: readonly ReportObject[];
  readonly phases: readonly ReportPhase[];
  readonly usage: readonly ReportUsage[];
  /** `--target`'s slug, or null on the offline path. */
  readonly target: string | null;
  readonly codes: NotationSource;
  /**
   * `--objects-from`'s FILE NAME (never its path) when the rows -- and so
   * their verdicts -- came from a caller's file; null on the live path.
   */
  readonly verdictFile: string | null;
}

/** The register keys, in backlog-board § 3's order, after `objects`. */
export interface RegisterKeys {
  readonly objects: readonly RegisterRow[];
  readonly variant: string;
  readonly title: string;
  readonly scope: string;
  readonly gate: string;
  readonly generatedAtLocal: string;
  readonly footerNote: string;
  readonly footerCount: string;
  readonly tallyScope: number;
  readonly tallyNeedsYou: number;
  readonly tallyBlockers: number;
  readonly tallyReady: number;
  readonly tallyInFlight: number;
  readonly gates: readonly unknown[];
  readonly architectureCaption: string;
  readonly graphJson: string;
  readonly graphMermaid: string;
  readonly graphNodes: readonly unknown[];
  readonly graphEdges: readonly unknown[];
  readonly spendEfforts: readonly SpendEffort[];
  readonly legendRows: readonly { readonly mark: string; readonly meaning: string }[];
}

/**
 * The register, from the desk and the facts.
 *
 * A DESK THAT TALKS ABOUT AN OBJECT NOT IN SCOPE IS REFUSED, at exit 2 naming
 * it: a row note for `pr#88` in a register with no #88 is a typo or a stale
 * desk, and either way rendering it silently drops the judgement somebody wrote.
 */
export function assembleRegister(desk: Desk, input: RegisterInput): RegisterKeys {
  const unresolved = new Set<string>();
  const scope = input.objects.map((object): Scoped => {
    const slug = slugOf(object, input.target);
    const own = notationOf(object.kind === "pr" ? "PR" : "IS", object.number, slug, input.codes);
    if (!own.resolved) unresolved.add(slug ?? `#${object.number}`);
    return { object, slug, notation: own.text };
  });
  // ONE IDENTITY, ONE ROW (Copilot, NN-PR-#365). The live path cannot read an
  // object twice, but an --objects-from file can carry it twice -- and a
  // register that rendered and COUNTED both would publish tallies about
  // objects that do not exist. Refused, naming the identity.
  const identities = new Map<string, Scoped>();
  for (const entry of scope) {
    const identity = `${(entry.slug ?? "").toLowerCase()}#${entry.object.number}`;
    if (identities.has(identity)) {
      throw new VerbUsageError(
        `the register carries ${entry.notation} twice. GitHub numbers issues and pull requests from one sequence per repository, so two rows with the same repository and number are one object read twice -- drop the duplicate from the objects file rather than publishing a register that counts it twice.`,
      );
    }
    identities.set(identity, entry);
  }
  const deskRows = new Map<Scoped, DeskRow>();
  for (const [key, row] of desk.rows) {
    const found = resolveReference(key, scope, input.codes, `row '${key}'`, null);
    if (deskRows.has(found)) {
      throw new VerbUsageError(`the register desk writes two rows for ${found.notation}; one object, one row of judgement.`);
    }
    deskRows.set(found, row);
  }
  const rows = scope.map((entry): RegisterRow =>
    registerRow(entry, deskRows.get(entry) ?? EMPTY_ROW, scope, input.codes, input.verdictFile),
  );

  const gates = desk.gates.map((gate) => ({
    gate: gate.gate,
    label: gate.label,
    cleared: gate.cleared,
    asks: gate.asks.map((ask) => {
      const verdict =
        ask.pr === null ? "" : quotedVerdict(resolveReference(ask.pr, scope, input.codes, `ask '${ask.title}'`, "pr").object);
      return {
        kind: ask.kind,
        rank: ask.rank,
        title: ask.title,
        why: ask.why,
        verdict,
        options: ask.options.map((option) => ({
          letter: option.letter,
          label: option.label,
          command: option.command,
          consequence: option.consequence,
          star: option.star ? STAR_LABEL : "",
          starredClass: option.star ? STARRED_CLASS : "",
        })),
        objects: ask.objects.map((object) => ({ label: object.label, url: object.url })),
      };
    }),
  }));

  const counts = tallies(input.objects, desk.gates);
  const efforts =
    desk.efforts ?? [...new Set([...input.phases.map((p): string => p.effort), ...input.usage.map((u): string => u.effort)])];
  // A SPEND NOTE NOBODY WILL SHOW IS REFUSED, not dropped (Copilot,
  // NN-PR-#365): a misspelled effort name, or one `efforts` leaves out, would
  // otherwise lose a line somebody wrote for the page, at exit 0.
  const strays = [...desk.spendNotes.keys()].filter((name): boolean => !efforts.includes(name));
  if (strays.length > 0) {
    throw new VerbUsageError(
      `the register desk's spendNotes name ${strays.map((name): string => `'${name}'`).join(", ")}, which ${strays.length === 1 ? "is" : "are"} not among the efforts this page shows (${efforts.map((name): string => `'${name}'`).join(", ") || "none"}). Fix the name, or add it to 'efforts'.`,
    );
  }

  // THE NOTATION FALLBACK IS SAID ON THE PAGE (PROCESS.md § Publishing a
  // report): a row reading `owner/name#7` instead of `XX-PR-#7` is a failed
  // resolution, and the footer names it rather than leaving the reader to
  // wonder why two notations share a page.
  const footer = [desk.footerNote];
  if (input.verdictFile !== null) {
    footer.push(`Verdicts read from ${input.verdictFile}, not from GitHub.`);
  }
  if (unresolved.size > 0) {
    footer.push(
      `Object notation unresolved for ${[...unresolved].sort().join(", ")}${input.codes.unavailable === null ? " (no product code in nen/repos.json)" : ` (${input.codes.unavailable})`}; those rows read <owner>/<name>#<n>.`,
    );
  }
  const asks = counts.tallyNeedsYou;
  return {
    objects: rows,
    variant: desk.variant,
    title: desk.title,
    scope: desk.scope,
    gate: desk.gate,
    generatedAtLocal: desk.generatedAtLocal ?? input.generatedAtLocal ?? input.generatedAt,
    footerNote: footer.filter((line): boolean => line !== "").join(" "),
    footerCount: `${rows.length} object${rows.length === 1 ? "" : "s"} in scope · ${asks} ask${asks === 1 ? "" : "s"} on the desk`,
    ...counts,
    gates,
    architectureCaption: desk.architectureCaption,
    // THE GRAPH KEYS ARE PRESENT AND EMPTY, so the template's `{{#if
    // graphNodes}}` answers "no drawing" instead of refusing the render; `nen
    // report render --graph` injects all four over these when there is one.
    graphJson: "",
    graphMermaid: "",
    graphNodes: [],
    graphEdges: [],
    spendEfforts: efforts.map((name): SpendEffort =>
      spendEffort(name, input.phases, input.usage, desk.spendNotes.get(name) ?? ""),
    ),
    legendRows: desk.legendRows.map((row) => ({ mark: row.mark, meaning: row.meaning })),
  };
}

/** The human lines under `register:`. */
export function renderRegister(register: RegisterKeys): readonly string[] {
  const lines = [
    `register: ${plainLine(register.variant)} -- ${plainLine(register.title)}`,
    `  tally: ${register.tallyScope} in scope, ${register.tallyNeedsYou} need you, ${register.tallyBlockers} blocker(s), ${register.tallyReady} ready, ${register.tallyInFlight} in flight`,
  ];
  for (const gate of register.gates as { gate: string; label: string; cleared: string; asks: { kind: string; rank: number; title: string; verdict: string }[] }[]) {
    lines.push(`  ${plainLine(gate.gate)} ${plainLine(gate.label)}: ${gate.asks.length === 0 ? `cleared -- ${plainLine(gate.cleared)}` : `${gate.asks.length} ask(s)`}`);
    for (const ask of gate.asks) {
      lines.push(`    ${ask.rank}. ${ask.kind} ${plainLine(ask.title)}${ask.verdict === "" ? "" : `  [${plainLine(ask.verdict)}]`}`);
    }
  }
  for (const row of register.objects) {
    lines.push(`  ${plainLine(row.notation)}  ${row.verdict === "" ? "(no verdict)" : plainLine(row.verdict)}`);
  }
  lines.push(`  spend: ${register.spendEfforts.length} effort(s)`);
  return lines;
}
