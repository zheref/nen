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
// line), verbatim. The desk file may not carry a `verdict` anywhere: an ask
// that wants one names the pull request (`pr: <n>`) and nen quotes that row's.
// A row with no readiness (an issue, or a pull request neither authority could
// answer) has the empty verdict, which is the report-data convention for
// "nothing to say" -- and that row's `notes[]` already says why.
//
// EVERY KEY THE TEMPLATE ITERATES IS ALWAYS PRESENT. `nen report render`
// refuses a token the document has not got, so an ask without an `objects`
// list would not render empty -- it would reach OUT to the register's
// top-level `objects` through the scope chain and fail on a row's missing
// `label`. Every list is `[]` and every string `""` when there is nothing.

import { VerbUsageError } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
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
  /** The pull request whose readiness this ask quotes, or null. */
  readonly pr: number | null;
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
  /** Keyed `pr#<n>` / `issue#<n>`. */
  readonly rows: ReadonlyMap<string, DeskRow>;
  readonly legendRows: readonly { readonly mark: string; readonly meaning: string }[];
  /** Which ledger efforts the spend block shows, in order; null = every one recorded. */
  readonly efforts: readonly string[] | null;
  readonly spendNotes: ReadonlyMap<string, string>;
}

// ── the desk file, validated at the read seam ───────────────────────────────

const DESK_SHAPE =
  '{ variant, title, scope, gate, generatedAtLocal?, footerNote?, architectureCaption?, gates: [{ gate, label, cleared?, asks: [{ kind: DECIDE|DO|MERGE, rank, title, why, pr?, options: [{ letter, label, command, consequence, star? }], objects?: [{ label, url }] }] }], rows?: { "pr#<n>"|"issue#<n>": { marks?, gate?, gateClass?, needs?, session?, lane?, thought? } }, legendRows?: [{ mark, meaning }], efforts?: [<effort>], spendNotes?: { "<effort>": "<line>" } }';

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

/** A desk key never carries a verdict; the verb quotes it. */
function forbidVerdict(record: Record<string, unknown>, display: string, where: string): void {
  if (Object.hasOwn(record, "verdict")) {
    refuseDesk(
      display,
      where,
      "carries a 'verdict'. A readiness verdict is QUOTED from 'nen pr ready', never written -- name the pull request with 'pr: <n>' on an ask and nen quotes that row's verdict verbatim",
    );
  }
}

function parseOption(entry: unknown, display: string, where: string): DeskOption {
  if (!isRecord(entry)) refuseDesk(display, where, `is ${kindOf(entry)}, not an option object`);
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
  forbidVerdict(entry, display, where);
  const kind = str(entry, "kind", display, where, true);
  if (!ASK_KINDS.includes(kind)) {
    refuseDesk(display, where, `has 'kind' of '${kind}'; an ask opens ${ASK_KINDS.join(", ")}`);
  }
  const rank = entry["rank"];
  if (typeof rank !== "number" || !Number.isInteger(rank) || rank <= 0) {
    refuseDesk(display, where, `has 'rank' of ${kindOf(rank)}, not a positive whole number (1 unblocks the most)`);
  }
  const pr = entry["pr"];
  if (pr !== undefined && pr !== null && (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0)) {
    refuseDesk(display, where, `has 'pr' of ${kindOf(pr)}, not a pull-request number`);
  }
  const options = list(entry, "options", display, where, true).map((option, index): DeskOption =>
    parseOption(option, display, `${where}.options[${index}]`),
  );
  const letters = options.map((option): string => option.letter);
  const duplicate = letters.find((letter, index): boolean => letters.indexOf(letter) !== index);
  if (duplicate !== undefined) refuseDesk(display, where, `letters two options '${duplicate}'; the picker cannot ask that`);
  const stars = options.filter((option): boolean => option.star).length;
  if (stars > 1) {
    refuseDesk(display, where, `stars ${stars} options; an ask recommends exactly one (or none, when the answer is the maintainer's word alone)`);
  }
  const objects = list(entry, "objects", display, where, false).map((object, index): { label: string; url: string } => {
    const at = `${where}.objects[${index}]`;
    if (!isRecord(object)) refuseDesk(display, at, `is ${kindOf(object)}, not a { label, url } object`);
    return { label: str(object, "label", display, at, true), url: url(str(object, "url", display, at, true), display, at) };
  });
  return {
    kind,
    rank,
    title: str(entry, "title", display, where, true),
    why: str(entry, "why", display, where, true),
    pr: typeof pr === "number" ? pr : null,
    options,
    objects,
  };
}

function parseGate(entry: unknown, display: string, where: string): DeskGate {
  if (!isRecord(entry)) refuseDesk(display, where, `is ${kindOf(entry)}, not a gate object`);
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

const ROW_KEY = /^(pr|issue)#([1-9][0-9]*)$/;
const ROW_FIELDS: readonly (keyof DeskRow)[] = ["marks", "gate", "gateClass", "needs", "session", "lane", "thought"];

function parseRows(value: unknown, display: string): ReadonlyMap<string, DeskRow> {
  const rows = new Map<string, DeskRow>();
  if (value === undefined) return rows;
  if (!isRecord(value)) refuseDesk(display, "'rows'", `is ${kindOf(value)}, not an object keyed 'pr#<n>' / 'issue#<n>'`);
  for (const [key, entry] of Object.entries(value)) {
    const where = `rows['${key}']`;
    if (!ROW_KEY.test(key)) refuseDesk(display, where, "is not keyed 'pr#<n>' or 'issue#<n>'");
    if (!isRecord(entry)) refuseDesk(display, where, `is ${kindOf(entry)}, not an object`);
    forbidVerdict(entry, display, where);
    const unknown = Object.keys(entry).filter((field): boolean => !(ROW_FIELDS as readonly string[]).includes(field));
    if (unknown.length > 0) {
      refuseDesk(
        display,
        where,
        `names ${unknown.map((field): string => `'${field}'`).join(", ")}, which the desk does not write -- a row's judgement is ${ROW_FIELDS.join(", ")}; every other column is a fact nen reads`,
      );
    }
    const row: Record<string, string> = {};
    for (const field of ROW_FIELDS) row[field] = str(entry, field, display, where, false);
    rows.set(key, row as unknown as DeskRow);
  }
  return rows;
}

/** `--register <file>`'s parsed document, validated field by field. */
export function parseDesk(document: unknown, display: string): Desk {
  if (!isRecord(document)) refuseDesk(display, "the document", `is ${kindOf(document)}, not an object`);
  forbidVerdict(document, display, "the document");
  const variant = str(document, "variant", display, "the document", true);
  if (variant.trim() === "") refuseDesk(display, "the document", "has an empty 'variant'; it names the reports.sections variant this register renders as");
  const generatedAtLocal = document["generatedAtLocal"];
  if (generatedAtLocal !== undefined && typeof generatedAtLocal !== "string") {
    refuseDesk(display, "the document", `has 'generatedAtLocal' of ${kindOf(generatedAtLocal)}, not a string`);
  }
  const legendRows = list(document, "legendRows", display, "the document", false).map((entry, index) => {
    const where = `legendRows[${index}]`;
    if (!isRecord(entry)) refuseDesk(display, where, `is ${kindOf(entry)}, not a { mark, meaning } object`);
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

// ── notation ────────────────────────────────────────────────────────────────

/**
 * `owner/name` → product code, from the registry, or null when unknown.
 *
 * A SEAM, so the register is testable without a registry on disk and the
 * command layer owns the one read of `nen/repos.json`.
 */
export interface NotationSource {
  readonly codeFor: (slug: string) => string | null;
  /** Why no code could be read at all (no registry), or null when one was. */
  readonly unavailable: string | null;
}

const OBJECT_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(?:pull|issues)\/\d+\/?$/;

/** The `owner/name` an object lives in: the target's, else its own URL's. */
function slugOf(object: ReportObject, target: string | null): string | null {
  if (target !== null) return target;
  return OBJECT_URL.exec(object.url)?.[1] ?? null;
}

function notationOf(kind: "IS" | "PR", number: number, slug: string | null, codes: NotationSource): { text: string; resolved: boolean } {
  const code = slug === null ? null : codes.codeFor(slug);
  // `nen ref format`'s bare token, spelled through its own grammar. A code the
  // registry holds is two or three uppercase letters by ../ref/notation.ts's
  // rule; anything else falls back like an unknown one.
  if (code !== null && /^[A-Z]{2,3}$/.test(code)) return { text: `${code}-${kind}-#${number}`, resolved: true };
  return { text: slug === null ? `#${number}` : `${slug}#${number}`, resolved: false };
}

// ── the rows ────────────────────────────────────────────────────────────────

/** The verdict to quote, or `""` when no authority answered. Never composed. */
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
  object: ReportObject,
  desk: DeskRow,
  target: string | null,
  codes: NotationSource,
  unresolved: Set<string>,
): RegisterRow {
  const slug = slugOf(object, target);
  const own = notationOf(object.kind === "pr" ? "PR" : "IS", object.number, slug, codes);
  if (!own.resolved) unresolved.add(slug ?? `#${object.number}`);
  // A PULL REQUEST'S `linked[]` ARE ISSUES, AN ISSUE'S ARE PULL REQUESTS, both
  // in the object's own repository -- which is how ./objects.ts reads them.
  const linkedKind = object.kind === "pr" ? "IS" : "PR";
  const linkedLine = object.linked.map((number): string => notationOf(linkedKind, number, slug, codes).text).join(", ");
  const notes = [...object.notes];
  let link = object.url;
  if (link !== "" && !SAFE_URL.test(link)) {
    notes.push(`'url' '${plainLine(link)}' is not an http(s), mailto, # or / link, so it is not published as one`);
    link = "";
  }
  return {
    ...object,
    url: link,
    notation: own.text,
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
    const notReported = entries.every((entry): boolean => entry.notReported);
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
  readonly objects: readonly ReportObject[];
  readonly phases: readonly ReportPhase[];
  readonly usage: readonly ReportUsage[];
  /** `--target`'s slug, or null on the offline path. */
  readonly target: string | null;
  readonly codes: NotationSource;
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
  const byKey = new Map(input.objects.map((object): [string, ReportObject] => [`${object.kind}#${object.number}`, object]));
  for (const key of desk.rows.keys()) {
    if (!byKey.has(key)) {
      throw new VerbUsageError(
        `the register desk writes a row for '${key}', which is not in this register's objects (${[...byKey.keys()].join(", ") || "none"}). Name it with --prs/--issues, or drop the row: judgement about an object the page does not show is judgement nobody reads.`,
      );
    }
  }
  const unresolved = new Set<string>();
  const rows = input.objects.map((object): RegisterRow =>
    registerRow(object, desk.rows.get(`${object.kind}#${object.number}`) ?? EMPTY_ROW, input.target, input.codes, unresolved),
  );

  const gates = desk.gates.map((gate) => ({
    gate: gate.gate,
    label: gate.label,
    cleared: gate.cleared,
    asks: gate.asks.map((ask) => {
      let verdict = "";
      if (ask.pr !== null) {
        const object = byKey.get(`pr#${ask.pr}`);
        if (object === undefined) {
          throw new VerbUsageError(
            `the register desk's ask '${ask.title}' quotes the readiness of pull request ${ask.pr}, which is not in this register's objects. A verdict is quoted from a row nen read, never from one it did not -- add ${ask.pr} to --prs.`,
          );
        }
        verdict = quotedVerdict(object);
      }
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

  // THE NOTATION FALLBACK IS SAID ON THE PAGE (PROCESS.md § Publishing a
  // report): a row reading `owner/name#7` instead of `XX-PR-#7` is a failed
  // resolution, and the footer names it rather than leaving the reader to
  // wonder why two notations share a page.
  const footer = [desk.footerNote];
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
    generatedAtLocal: desk.generatedAtLocal ?? input.generatedAt,
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
