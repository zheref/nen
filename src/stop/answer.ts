// src/stop/answer.ts -- `nen stop answer`: the stop-answer ledger.
//
// WHY IT EXISTS (findings A3 and A8 of the 2026-10-22 SDD plan; Hatsu's HR-2
// and HR-3 capture discipline). `nen direct answer --record` writes ONE answer,
// to ONE question (continue or stop), into the record `direct resolve` filed. Every
// other gate a skill stops at -- the G1..G5 questions, the pickers, a typed
// reply -- had no ledger: what was asked, which options were on the table, and
// what the maintainer said lived only in a transcript. This verb is the general
// form: one JSON record per answered stop, the question and every option as the
// caller stated them, and the answer -- a picked key or the typed text verbatim.
//
// IT RECORDS; IT NEVER CHOOSES. The caller states the question, the options and
// the answer; nen validates the shape, stamps the instant and an id, and writes.
// The one thing it DETECTS is whether a typed text is word for word one of the
// option labels (then the record is kind 'picked', the matching key named, the
// text still kept verbatim) -- an exact comparison, never a reading of intent.
//
// WHERE: `<git common dir>/.nen/stops/<percent-encoded effort>/<n>.json`. The
// common directory, not the worktree, so every worktree of one repository
// writes into, and `show` reads from, one ledger: an effort's stops outlive the
// worktree that asked them. `<n>` counts up from the records already present.
//
// THE ID IS NEVER REUSED. `R-YYYY-MM-DD-nn` (UTC date of the answer), nn
// counted from the ids already reserved that day across every effort, and
// RESERVED by an exclusive create (`wx`) of `<common>/.nen/stop-ids/<id>`
// before the record is written: two writers racing for the same nn get one
// success and one EEXIST, and the loser takes the next number. A reservation is
// never removed, so a record deleted later never frees its id.
//
// THE RECORD IS CREATED, NEVER REPLACED. It is written to a temp file and
// hard-linked to `<n>.json` (link(2) fails with EEXIST rather than replacing),
// so a reader never sees a torn record and a racing writer never overwrites one.
//
// "COULD NOT READ" IS NEVER "NOTHING FOUND": a git that cannot name the common
// directory, a record that is not JSON or not this contract's, is exit 1 naming
// it. Only an absent effort directory is an empty ledger.

import { linkSync, lstatSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { emit, VerbUsageError, type CommandContext } from "../cli/command.js";
import { readVerbatimTextFile } from "../cli/inputs.js";
import { realContainment } from "../repo/contain.js";
import { assertRepoRoot } from "../repo/root.js";
import { assertEffortId, encodeEffortId } from "../ledger/effort.js";
import { GATES, loadDecisions } from "../schema/decisions.js";
import { STOP_IDS_COMMON_SEGMENTS, STOPS_COMMON_SEGMENTS } from "../ledger/roots.js";

/** The record's own versioned contract string. */
export const STOP_ANSWER_CONTRACT = "nen.stop.answer/v0.1";
/** Under the git common directory: one subdirectory per effort (../ledger/roots.json, nen's one common-dir root). */
export const STOPS_DIR: readonly string[] = STOPS_COMMON_SEGMENTS;
/** Under the git common directory: one empty file per reserved id. */
export const STOP_IDS_DIR: readonly string[] = STOP_IDS_COMMON_SEGMENTS;

/** Flags only `stop answer` reads; refused on every other form of `nen stop`. */
export const ANSWER_VALUE_FLAGS: readonly string[] = ["record", "question-file", "pick", "typed-file", "row"];
export const ANSWER_LIST_FLAGS: readonly string[] = ["option"];
export const ANSWER_BOOLEAN_FLAGS: readonly string[] = ["dry-run"];
/** Flags of the banner form that `stop answer` refuses rather than ignores. */
export const BANNER_ONLY_FLAGS: readonly string[] = ["title", "body", "report-url", "options", "propose-issue"];
export const BANNER_ONLY_BOOLEANS: readonly string[] = ["notified", "template", "mark"];

export interface AnswerOption {
  readonly key: string;
  readonly label: string;
  readonly consequence: string;
}

export interface StopAnswerRecord {
  readonly contract: string;
  readonly id: string;
  readonly effortId: string;
  readonly n: number;
  /** The gate the stop asked at; null only when the stop names a decisions row instead (a picker, an ask-once row). */
  readonly gate: string | null;
  /** The `nen/decisions.json` row the stop answers, so an answer joins HR-5's idle answers; null when none was named. */
  readonly row: string | null;
  readonly who: string;
  readonly question: string;
  readonly options: readonly AnswerOption[];
  readonly kind: "picked" | "typed";
  readonly pick: string | null;
  readonly typed: string | null;
  readonly answeredAt: string;
}

/** A decisions row id as `nen/decisions.json` spells one. */
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A failure that is not the caller's typing: exit 1. */
export class StopAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StopAnswerError";
  }
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** `<key>=<label>::<consequence>`, every part non-empty. Exit 2 otherwise. */
export function parseOptionSpec(raw: string): AnswerOption {
  const refuse = (why: string): never => {
    throw new VerbUsageError(`--option '${raw}' is refused: ${why}. The form is <key>=<label>::<consequence>.`);
  };
  const eq = raw.indexOf("=");
  if (eq < 0) return refuse("it has no '='");
  const key = raw.slice(0, eq).trim();
  const rest = raw.slice(eq + 1);
  const sepAt = rest.indexOf("::");
  if (sepAt < 0) return refuse("it has no '::' before the consequence");
  const label = rest.slice(0, sepAt).trim();
  const consequence = rest.slice(sepAt + 2).trim();
  if (!KEY.test(key)) return refuse("the key must be letters, digits, '_' or '-', starting with a letter or digit");
  if (label === "") return refuse("the label is empty");
  if (consequence === "") return refuse("the consequence is empty -- an option whose consequence is unstated is not an informed choice");
  return { key, label, consequence };
}

/** The effort's directory under `<common>/.nen/stops/`, or a usage refusal for an id that could escape it. */
export function effortDirectory(common: string, id: string): string {
  const refuse = (why: string): never => {
    throw new VerbUsageError(`the effort id '${id}' is refused: ${why}. Records are written under ${STOPS_DIR.join("/")}/<percent-encoded id>/ in the git common directory.`);
  };
  // THE ONE EFFORT-ID GRAMMAR (../ledger/effort.ts, zheref/nen#509 with #511
  // folded in): an id `nen phase` and `nen usage` refuse is refused here too,
  // in the same words, so one effort keys every ledger the same way.
  assertEffortId(id);
  const base = resolve(common, ...STOPS_DIR);
  const full = resolve(base, encodeEffortId(id));
  if (!full.startsWith(base + sep)) return refuse("it resolves outside the stops directory");
  return full;
}

/** `git rev-parse --git-common-dir` under `root`, absolute. Unreadable is exit 1, never an empty ledger. */
export function gitCommonDir(context: CommandContext, root: string): string {
  // An inherited GIT_DIR / GIT_COMMON_DIR / GIT_WORK_TREE (a git hook, a
  // wrapper) would point the lookup at another repository's ledger, so they are
  // dropped; LC_ALL=C keeps git's message the one quoted on a refusal.
  const result = context.seams.run("git", ["-C", root, "rev-parse", "--git-common-dir"], {
    env: { LC_ALL: "C", LANGUAGE: undefined, GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined },
  });
  const lines = result.stdout.trim().split(/\r?\n/);
  const line = lines[0];
  if (result.code !== 0 || lines.length !== 1 || line === undefined || line === "") {
    throw new StopAnswerError(
      `could not read the git common directory under '${root}' (git rev-parse --git-common-dir exited ${result.code}${result.stderr.trim() === "" ? "" : `: ${result.stderr.trim().split(/\r?\n/)[0]}`}). The stop ledger lives there, so nothing was read or written.`,
    );
  }
  return isAbsolute(line) ? line : resolve(root, line);
}

function assertContained(common: string, path: string): void {
  const real = realContainment(common, path);
  if (!real.contained) {
    throw new VerbUsageError(`'${path}' is refused: it resolves to '${real.real}', outside the git common directory. A stop record is written only as a plain file there.`);
  }
  let stats;
  try {
    stats = lstatSync(path, { throwIfNoEntry: false });
  } catch {
    stats = undefined;
  }
  if (stats !== undefined && stats.isSymbolicLink()) {
    throw new VerbUsageError(`'${path}' is refused: it is a symbolic link. A stop record is written only as a plain file.`);
  }
}

/** Entry names of a directory; absent is empty, anything else unreadable is exit 1. */
function entries(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new StopAnswerError(`could not read '${path}' (${(error as NodeJS.ErrnoException).code ?? String(error)}).`);
  }
}

const RECORD_NAME = /^([1-9][0-9]*)\.json$/;

function recordNumbers(directory: string): number[] {
  return entries(directory)
    .map((name): number | null => {
      const match = RECORD_NAME.exec(name);
      return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
    })
    .filter((n): n is number => n !== null)
    .sort((a, b): number => a - b);
}

/** The highest nn already reserved for `date`, or 0. */
function highestReserved(idsDir: string, date: string): number {
  const prefix = `R-${date}-`;
  let highest = 0;
  for (const name of entries(idsDir)) {
    if (!name.startsWith(prefix)) continue;
    const tail = name.slice(prefix.length);
    if (!/^[0-9]+$/.test(tail)) continue;
    highest = Math.max(highest, Number.parseInt(tail, 10));
  }
  return highest;
}

export function formatId(date: string, nn: number): string {
  return `R-${date}-${String(nn).padStart(2, "0")}`;
}

/** Reserve the next free id for `date` by exclusive create; EEXIST moves to the next number. */
function reserveId(common: string, idsDir: string, date: string): string {
  // Asked before AND after the mkdir: a `.nen` that is a link out of the common
  // directory must not have a directory created through it.
  assertContained(common, idsDir);
  mkdirSync(idsDir, { recursive: true });
  assertContained(common, idsDir);
  for (let nn = highestReserved(idsDir, date) + 1; ; nn += 1) {
    const id = formatId(date, nn);
    const path = join(idsDir, id);
    try {
      closeSync(openSync(path, "wx"));
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new StopAnswerError(`could not reserve the id '${id}' at '${path}' (${(error as NodeJS.ErrnoException).code ?? String(error)}).`);
    }
  }
}

/** Create `<n>.json` for the next free n, never replacing one. */
function createRecord(common: string, directory: string, build: (n: number) => StopAnswerRecord): { path: string; record: StopAnswerRecord } {
  assertContained(common, directory);
  mkdirSync(directory, { recursive: true });
  assertContained(common, directory);
  const existing = recordNumbers(directory);
  for (let n = (existing[existing.length - 1] ?? 0) + 1; ; n += 1) {
    const path = join(directory, `${n}.json`);
    const record = build(n);
    const temp = join(directory, `.${n}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    try {
      writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      linkSync(temp, path);
      return { path, record };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new StopAnswerError(`could not write '${path}' (${(error as NodeJS.ErrnoException).code ?? String(error)}).`);
    } finally {
      rmSync(temp, { force: true });
    }
  }
}

function requireValue(context: CommandContext, flag: string, why: string): string {
  const value = context.args.values[flag];
  if (value === undefined || value.trim() === "") throw new VerbUsageError(`--${flag} is required. ${why}`);
  return value;
}

function refuseForeignFlags(context: CommandContext, values: readonly string[], booleans: readonly string[], form: string): void {
  for (const flag of values) {
    if (context.args.values[flag] !== undefined) throw new VerbUsageError(`--${flag} does not belong to '${form}'.`);
  }
  for (const flag of booleans) {
    if (context.args.booleans.has(flag)) throw new VerbUsageError(`--${flag} does not belong to '${form}'.`);
  }
}

/** `nen stop answer --record ...` and `nen stop answer show <effort-id>`. */
export function runAnswer(context: CommandContext): number {
  refuseForeignFlags(context, BANNER_ONLY_FLAGS, BANNER_ONLY_BOOLEANS, "nen stop answer");
  if (context.args.positionals[2] === "show") return showAnswers(context);
  if (context.args.positionals[2] !== undefined) {
    throw new VerbUsageError(`'nen stop answer ${context.args.positionals[2]}' is not a form of this verb: it is 'nen stop answer --record <effort-id> ...' or 'nen stop answer show <effort-id>'.`);
  }
  return recordAnswer(context);
}

function recordAnswer(context: CommandContext): number {
  const effort = requireValue(context, "record", "It names the effort whose stop this answer belongs to.");
  // A STOP AT A GATE, OR AT A DECISIONS ROW. Every ask-once row of a
  // decisions file carries gate null (a picker, a typed reply), so a stop may
  // name its row with --row and no gate; one of the two is required, and the
  // row id is kept so the answer joins HR-5's idle answers, which are keyed by
  // row (Chrollo, delivery round on zheref/nen#498).
  const row = context.args.values["row"] ?? null;
  if (row !== null && !ROW_ID.test(row)) {
    throw new VerbUsageError(`--row '${row}' is not a decisions row id (a letter or digit, then letters, digits, '.', '_', ':' or '-').`);
  }
  const gateFlag = context.args.values["gate"];
  if (gateFlag === undefined && row === null) {
    throw new VerbUsageError(`--gate <${GATES.join("|")}> or --row <decisions-row-id> is required: a stop asks at a gate, or answers one decisions row whose gate is null.`);
  }
  if (gateFlag !== undefined && !(GATES as readonly string[]).includes(gateFlag)) {
    throw new VerbUsageError(`--gate must be one of ${GATES.join(", ")}, got '${gateFlag}'.`);
  }
  const gate = gateFlag ?? null;
  const who = requireValue(context, "who", "It is the persona that asked; nen ships no built-in name.");
  const questionFile = requireValue(context, "question-file", "It is the file holding the question as it was asked.");
  const rawOptions = context.args.lists["option"] ?? [];
  if (rawOptions.length === 0) {
    throw new VerbUsageError("--option <key>=<label>::<consequence> is required at least once: the record keeps every option the stop offered.");
  }
  const options = rawOptions.map(parseOptionSpec);
  const keys = new Set<string>();
  const labels = new Set<string>();
  for (const option of options) {
    if (keys.has(option.key)) throw new VerbUsageError(`--option key '${option.key}' is given twice; each option needs its own key.`);
    // Two options with one label would make a typed reply of that label name
    // either of them, and the verb would have to choose: refused instead.
    if (labels.has(option.label)) throw new VerbUsageError(`--option label '${option.label}' is given twice; each option needs its own label.`);
    keys.add(option.key);
    labels.add(option.label);
  }
  const pickFlag = context.args.values["pick"];
  const typedFile = context.args.values["typed-file"];
  if ((pickFlag === undefined) === (typedFile === undefined)) {
    throw new VerbUsageError("give exactly one of --pick <key> or --typed-file <path>: the answer is a picked option or the typed text, never both and never neither.");
  }

  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  // THE ROW IS CHECKED AGAINST --repo's nen/decisions.json when it has one: a
  // typo'd row id joins no idle answer, so it is refused (exit 2) naming the
  // ask-once ids; with no file the row is recorded and said to be unchecked
  // (delivery round on zheref/nen#498, verification pass).
  let rowChecked: boolean | null = null;
  let decisionsPath: string | null = null;
  if (row !== null) {
    let matrix;
    try {
      matrix = loadDecisions(root);
    } catch (error) {
      throw new StopAnswerError(`could not read nen/decisions.json to check --row '${row}': ${error instanceof Error ? error.message : String(error)}`);
    }
    decisionsPath = matrix.path;
    if (matrix.present) {
      if (matrix.row(row) === undefined) {
        const askOnce = matrix.rows.filter((r): boolean => r.class === "ask-once-per-run").map((r): string => r.id);
        throw new VerbUsageError(
          `--row '${row}' is no row of ${matrix.path}; its ask-once rows are: ${askOnce.length === 0 ? "(none)" : askOnce.join(", ")}.`,
        );
      }
      rowChecked = true;
    } else {
      rowChecked = false;
    }
  }
  const question = readVerbatimTextFile(questionFile, root, "The question is what this record is about; an unreadable file is refused rather than recorded as an empty question.");
  if (question.trim() === "") throw new VerbUsageError(`--question-file ${questionFile} is empty: a record of an answer to no question says nothing.`);

  let kind: "picked" | "typed";
  let pick: string | null;
  let typed: string | null;
  if (pickFlag !== undefined) {
    if (!keys.has(pickFlag)) {
      throw new VerbUsageError(`--pick '${pickFlag}' is not one of the option keys (${[...keys].join(", ")}). A reply in other words is --typed-file.`);
    }
    kind = "picked";
    pick = pickFlag;
    typed = null;
  } else {
    typed = readVerbatimTextFile(typedFile as string, root, "The typed answer is kept verbatim; an unreadable file is refused rather than recorded as no answer.", true);
    if (typed.trim() === "") throw new VerbUsageError(`--typed-file ${String(typedFile)} is empty: an empty reply is not an answer.`);
    const match = options.find((option): boolean => option.label === typed?.trim());
    kind = match === undefined ? "typed" : "picked";
    pick = match === undefined ? null : match.key;
  }

  const common = gitCommonDir(context, root);
  const directory = effortDirectory(common, effort);
  const idsDir = resolve(common, ...STOP_IDS_DIR);
  // Both directories are proven to stay in the common directory BEFORE an id is
  // reserved or a listing is read: a refusal then burns no id, and a dry run
  // refuses exactly what the real run would.
  assertContained(common, directory);
  assertContained(common, idsDir);
  const answeredAt = context.seams.now().toISOString();
  const date = answeredAt.slice(0, 10);
  const dryRun = context.args.booleans.has("dry-run");
  const build = (id: string, n: number): StopAnswerRecord => ({
    contract: STOP_ANSWER_CONTRACT, id, effortId: effort, n, gate, row, who, question, options, kind, pick, typed, answeredAt,
  });

  let path: string;
  let record: StopAnswerRecord;
  if (dryRun) {
    const existing = recordNumbers(directory);
    const n = (existing[existing.length - 1] ?? 0) + 1;
    path = join(directory, `${n}.json`);
    record = build(formatId(date, highestReserved(idsDir, date) + 1), n);
  } else {
    const id = reserveId(common, idsDir, date);
    ({ path, record } = createRecord(common, directory, (n): StopAnswerRecord => build(id, n)));
  }

  const answerLine = record.kind === "typed"
    ? `typed (verbatim): ${firstLine(record.typed ?? "")}`
    : `picked: ${record.pick ?? ""}${record.typed === null ? "" : " (typed text matched that option's label)"}`;
  emit(context.io, context.json, { dryRun, path, record, rowChecked }, [
    `${dryRun ? "(dry run) would record" : "recorded"} ${record.id} -> ${path}`,
    `  ${record.gate ?? `row ${record.row ?? ""}`}${record.gate !== null && record.row !== null ? ` (row ${record.row})` : ""} · ${record.who} · ${answerLine}`,
    ...(rowChecked === false ? [`row ${record.row ?? ""} not checked: ${decisionsPath ?? "nen/decisions.json"} is absent`] : []),
    ...(dryRun ? ["nothing written -- the id shown is the next free one now and is not reserved."] : []),
  ]);
  return 0;
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** Validate one record as this contract's, for this effort. A defect is a string. */
export function recordDefect(document: unknown, effort: string, n: number): string | null {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return "is not a JSON object";
  const r = document as Record<string, unknown>;
  if (r["contract"] !== STOP_ANSWER_CONTRACT) return `is not a ${STOP_ANSWER_CONTRACT} record (contract: ${JSON.stringify(r["contract"] ?? null)})`;
  if (r["effortId"] !== effort) return `records the effort ${JSON.stringify(r["effortId"] ?? null)}, not '${effort}'`;
  if (r["n"] !== n) return `records n ${JSON.stringify(r["n"] ?? null)} but is named ${n}.json`;
  if (typeof r["id"] !== "string" || !/^R-\d{4}-\d{2}-\d{2}-\d{2,}$/.test(r["id"])) return "has no R-YYYY-MM-DD-nn id";
  const row = r["row"] ?? null;
  if (row !== null && (typeof row !== "string" || !ROW_ID.test(row))) return "has a row that is neither a decisions row id nor null";
  if (r["gate"] === null || r["gate"] === undefined) {
    if (row === null) return "has neither a known gate nor a decisions row";
  } else if (typeof r["gate"] !== "string" || !(GATES as readonly string[]).includes(r["gate"])) {
    return "has no known gate";
  }
  for (const key of ["who", "question", "answeredAt"]) if (typeof r[key] !== "string") return `has no '${key}' string`;
  if (!Array.isArray(r["options"])) return "has no options array";
  const optionKeys: string[] = [];
  for (const option of r["options"] as unknown[]) {
    if (typeof option !== "object" || option === null) return "has an option that is not an object";
    const o = option as Record<string, unknown>;
    if (typeof o["key"] !== "string" || typeof o["label"] !== "string" || typeof o["consequence"] !== "string") {
      return "has an option without a string key, label and consequence";
    }
    optionKeys.push(o["key"]);
  }
  if (typeof r["pick"] === "string" && !optionKeys.includes(r["pick"])) return `picks '${r["pick"]}', which is none of its options' keys`;
  if (r["kind"] !== "picked" && r["kind"] !== "typed") return "has a kind that is neither 'picked' nor 'typed'";
  if (r["pick"] !== null && typeof r["pick"] !== "string") return "has a pick that is neither a key nor null";
  if (r["typed"] !== null && typeof r["typed"] !== "string") return "has typed text that is neither a string nor null";
  if (r["kind"] === "picked" && r["pick"] === null) return "is kind 'picked' with no pick";
  if (r["kind"] === "typed" && (r["typed"] === null || r["pick"] !== null)) return "is kind 'typed' without typed text only";
  return null;
}

function showAnswers(context: CommandContext): number {
  const effort = context.args.positionals[3];
  if (effort === undefined) throw new VerbUsageError("'nen stop answer show' needs the effort id: nen stop answer show <effort-id>.");
  if (context.args.positionals[4] !== undefined) throw new VerbUsageError(`'nen stop answer show' takes one effort id, got also '${context.args.positionals[4]}'.`);
  for (const flag of [...ANSWER_VALUE_FLAGS, "gate", "who"]) {
    if (context.args.values[flag] !== undefined) throw new VerbUsageError(`--${flag} does not belong to 'nen stop answer show'.`);
  }
  if ((context.args.lists["option"] ?? []).length > 0) throw new VerbUsageError("--option does not belong to 'nen stop answer show'.");
  if (context.args.booleans.has("dry-run")) throw new VerbUsageError("--dry-run does not belong to 'nen stop answer show': it writes nothing.");
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const common = gitCommonDir(context, root);
  const directory = effortDirectory(common, effort);
  assertContained(common, directory);
  const records: StopAnswerRecord[] = [];
  for (const n of recordNumbers(directory)) {
    const path = join(directory, `${n}.json`);
    assertContained(common, path);
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new StopAnswerError(`'${path}' could not be read as JSON (${error instanceof Error ? error.message : String(error)}); the ledger is not reported as shorter than it is.`);
    }
    const defect = recordDefect(document, effort, n);
    if (defect !== null) throw new StopAnswerError(`'${path}' ${defect}; the ledger is not reported as shorter than it is.`);
    records.push(document as StopAnswerRecord);
  }
  const lines = records.length === 0
    ? [`no stop answers recorded for '${effort}' (${directory}).`]
    : records.map((r): string => `${r.id}  ${r.gate ?? `row:${r.row ?? ""}`}  ${r.who}  ${r.kind === "typed" ? `typed: ${firstLine(r.typed ?? "")}` : `picked: ${r.pick ?? ""}`}  · ${firstLine(r.question)}`);
  emit(context.io, context.json, { effortId: effort, directory, records }, lines);
  return 0;
}
