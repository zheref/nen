// src/canon/lint.ts -- `nen canon lint`: a canon repository's prose held to a
// rules contract the CALLER owns, behind a shrink-only baseline (zheref/nen#481).
//
// THE PORT OF zheref/hatsu's interim guard, scripts/prose_ambiguity_check.mts
// (Hatsu ruling HR-13 -- the ratchet, with the stale-version and dangling-
// citation rules never baselined -- and HR-4, the one open-question marker).
// The guard's fixture is this verb's acceptance criteria; every case it holds
// is a test here, so the guard and the verb cannot disagree on a verdict and
// Hatsu can retire the guard at its repin.
//
// NEN DETECTS AND REPORTS; IT DECIDES NOTHING. Which rules exist, what each
// pattern is, which rows a marker may name, where the pin is read from, which
// paths are records -- all of it is the contract's (`--rules`), read at run
// time. A rule's CLASS selects the implementation (one class is one kind of
// check); its id, severity and patterns are the caller's. No path, persona or
// repository name is built in.
//
// THREE EXITS, AND "COULD NOT READ" IS NEVER "NOTHING FOUND".
//   0  no fail-severity finding outside the baseline, no stale row, no grown row;
//   1  at least one -- each printed `path:line · <rule> · text`;
//   2  wiring: an unreadable or invalid contract or baseline, an unlistable
//      directory, an unreadable or non-UTF-8 file, a symlink leaving the root,
//      a git read that failed under --base -- and every usage error. A file
//      the lint could not read is never a file it found clean.
//
// DIFFERENCES FROM THE GUARD, each deliberate and each named in the USAGE:
//   * No "is this a Hatsu checkout" probe: nen knows no consumer by name. The
//     contract's own files (`versionSource.file`, `decisionsFile`, ...) are the
//     root's credentials, and a root missing one is wiring.
//   * Rules dispatch on `class`, never on id, so a contract may renumber.
//   * A rule missing a field its class needs is wiring (the guard skipped it).
//   * The paths a per-file marker limit and the reading rule apply to are the
//     contract's `skillPaths` (absent: every included path), not a built-in
//     `claude/...` pattern; `paths.exclude` replaces the built-in `surfaces/`.
//   * A frontmatter finding names the file's own line (the guard reports one
//     line early there).

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { GIT, type Seams } from "../seam/exec.js";
import { globToRegex, headingNumber, lineAt, parseDoc, titleMatches, type Doc, type Para } from "./markdown.js";

export const CANON_LINT_CONTRACT = "nen.canon.lint/v0.1";
/** The `$schema` a rules contract may carry; any other value is refused. */
export const PROSE_LINT_SCHEMA = "nen.prose-lint/v0.1";

export type Severity = "fail" | "advisory";

export const RULE_CLASSES = [
  "by-hand",
  "stale-residue",
  "stale-version",
  "citation",
  "bare-ref",
  "unverified-claim",
  "hedge",
  "adjective",
  "number-not-declared",
  "residue-unfiled",
  "open-question-shape",
  "reading-cited-as-ruled",
] as const;
export type RuleClass = (typeof RULE_CLASSES)[number];

/** The pattern-valued fields each class needs; a missing one is wiring. */
const NEEDS: Readonly<Record<RuleClass, readonly string[]>> = {
  "by-hand": ["pattern", "negations"],
  "stale-residue": ["pattern", "requires"],
  "stale-version": ["otherPins"],
  citation: [],
  "bare-ref": ["pattern"],
  "unverified-claim": ["pattern", "date", "evidence"],
  hedge: ["pattern"],
  adjective: ["pattern"],
  "number-not-declared": ["pattern"],
  "residue-unfiled": ["requires"],
  "open-question-shape": ["pattern", "marker", "ledger"],
  "reading-cited-as-ruled": ["pattern"],
};
const PATTERN_KEYS = ["pattern", "negations", "requires", "date", "evidence", "marker", "ledger", "otherPins", "section"];
/** Classes a RETIRED block exempts: history is not a live claim. */
const RETIRED_EXEMPT: readonly RuleClass[] = ["stale-residue", "stale-version", "bare-ref", "residue-unfiled"];

export interface Rule {
  readonly id: string;
  readonly class: RuleClass;
  readonly severity: Severity;
  readonly [key: string]: unknown;
}

export interface LintContract {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly quotedWords: boolean;
  readonly recordPaths: readonly string[];
  readonly recordRules: readonly string[];
  readonly versionSource: { readonly file: string; readonly minimum: string; readonly pinned: string } | null;
  readonly decisionsFile: string | null;
  readonly markerRows: readonly string[];
  readonly markerLimit: number | null;
  readonly emptyBaseline: readonly string[];
  readonly rulingsFile: string | null;
  readonly declaredValues: readonly string[];
  readonly skillPaths: readonly string[] | null;
  readonly rules: readonly Rule[];
}

export interface Finding {
  readonly path: string;
  readonly line: number;
  readonly rule: string;
  readonly severity: Severity;
  readonly text: string;
  inBaseline?: boolean;
}

export interface BaselineRow {
  readonly path: string;
  readonly rule: string;
  readonly text: string;
  readonly count: number;
}

export interface LintReport {
  readonly contract: typeof CANON_LINT_CONTRACT;
  readonly root: string;
  readonly rules: string;
  readonly baseline: string | null;
  readonly base: string | null;
  readonly files: number;
  readonly exit: 0 | 1;
  readonly counts: Readonly<Record<string, { total: number; baselined: number; new: number }>>;
  readonly findings: readonly Finding[];
  readonly advisory: readonly Omit<Finding, "inBaseline">[];
  readonly staleBaseline: readonly BaselineRow[];
  readonly grownBaseline: readonly BaselineRow[];
}

/** A wiring failure: the lint could not look, so it reports no verdict. Exit 2. */
export class LintWiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LintWiringError";
  }
}
const wiring = (message: string): never => {
  throw new LintWiringError(message);
};

function readUtf8(abs: string, rel: string): string {
  let buffer: Buffer;
  try {
    buffer = readFileSync(abs);
  } catch (error) {
    return wiring(`cannot read ${rel}: ${(error as Error).message}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return wiring(`${rel} is not valid UTF-8`);
  }
}

function readJson(abs: string, rel: string): unknown {
  const text = readUtf8(abs, rel);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    return wiring(`${rel} is not valid JSON: ${(error as Error).message}`);
  }
}

/** RFC 6901, as far as the contract's pointers need it. */
export function pointer(document: unknown, ptr: string): unknown {
  let cur: unknown = document;
  for (const part of ptr.split("/").slice(1)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return cur;
}

function compile(source: unknown, where: string, flags = "gi"): RegExp {
  if (typeof source !== "string" || source === "") return wiring(`${where} is not a pattern string`);
  try {
    return new RegExp(source, flags);
  } catch (error) {
    return wiring(`${where} does not compile: ${(error as Error).message}`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const stringList = (value: unknown, where: string): string[] => {
  if (!Array.isArray(value) || value.some((item): boolean => typeof item !== "string")) return wiring(`${where} is not a list of strings`);
  return value as string[];
};

/** Validate a rules contract's shape. Every refusal names the pointer. */
export function parseLintContract(raw: unknown, rel: string): LintContract {
  if (!isRecord(raw)) return wiring(`${rel} is not a JSON object`);
  if (raw["$schema"] !== undefined && raw["$schema"] !== PROSE_LINT_SCHEMA) wiring(`${rel}: $schema is ${JSON.stringify(raw["$schema"])}; this nen reads "${PROSE_LINT_SCHEMA}"`);
  const paths = raw["paths"];
  if (!isRecord(paths) || !Array.isArray(paths["include"]) || !Array.isArray(raw["rules"])) return wiring(`${rel} lacks rules[] or paths.include[]`);
  const include = stringList(paths["include"], `${rel}: paths.include`);
  const exclude = paths["exclude"] === undefined ? [] : stringList(paths["exclude"], `${rel}: paths.exclude`);
  const exemptions = isRecord(raw["exemptions"]) ? raw["exemptions"] : {};
  const records = raw["records"];
  if (records !== undefined && (!isRecord(records) || !Array.isArray(records["paths"]) || !Array.isArray(records["rules"]))) wiring(`${rel} lacks records.paths[] / records.rules[]`);
  const seen = new Set<string>();
  const rules: Rule[] = [];
  for (const [index, value] of (raw["rules"] as unknown[]).entries()) {
    if (!isRecord(value)) return wiring(`${rel}: rules[${index}] is not an object`);
    const id = value["id"];
    if (typeof id !== "string" || !/^[A-Z][A-Z0-9]*-\d+$/.test(id) || seen.has(id)) wiring(`${rel}: rule id ${String(id)} is malformed or repeated`);
    seen.add(id as string);
    const klass = value["class"];
    if (!(RULE_CLASSES as readonly unknown[]).includes(klass)) wiring(`${rel}: ${String(id)} has unknown class ${String(klass)}`);
    const severity = value["severity"];
    if (severity !== "fail" && severity !== "advisory") wiring(`${rel}: ${String(id)} has severity ${String(severity)}`);
    for (const key of NEEDS[klass as RuleClass]) if (!(key in value)) wiring(`${rel}: ${String(id)} (class ${String(klass)}) lacks ${key}`);
    for (const key of PATTERN_KEYS) if (key in value) compile(value[key], `${rel}: ${String(id)}.${key}`);
    if (klass === "stale-version") {
      const patterns = value["patterns"];
      if (!Array.isArray(patterns) || patterns.length === 0) wiring(`${rel}: ${String(id)}.patterns is not a list`);
      (patterns as unknown[]).forEach((pattern, n): void => void compile(pattern, `${rel}: ${String(id)}.patterns[${n}]`));
      if (value["pastWords"] !== undefined) stringList(value["pastWords"], `${rel}: ${String(id)}.pastWords`);
    }
    rules.push(value as unknown as Rule);
  }
  const has = (klass: RuleClass): boolean => rules.some((rule): boolean => rule.class === klass);
  let versionSource: LintContract["versionSource"] = null;
  if (has("stale-version")) {
    const source = raw["versionSource"];
    if (!isRecord(source) || typeof source["file"] !== "string" || typeof source["minimum"] !== "string" || typeof source["pinned"] !== "string") return wiring(`${rel} lacks versionSource { file, minimum, pinned }`);
    versionSource = { file: source["file"], minimum: source["minimum"], pinned: source["pinned"] };
  }
  let decisionsFile: string | null = null;
  let markerRows: string[] = [];
  let markerLimit: number | null = null;
  if (has("open-question-shape")) {
    if (typeof raw["decisionsFile"] !== "string") wiring(`${rel} lacks decisionsFile`);
    decisionsFile = raw["decisionsFile"] as string;
    markerRows = stringList(raw["markerRows"], `${rel}: markerRows`);
    if (raw["markerLimit"] !== undefined && (!Number.isInteger(raw["markerLimit"]) || (raw["markerLimit"] as number) < 0)) wiring(`${rel}: markerLimit is not a whole number`);
    markerLimit = (raw["markerLimit"] as number | undefined) ?? null;
  }
  if (has("reading-cited-as-ruled") && typeof raw["rulingsFile"] !== "string") wiring(`${rel} lacks rulingsFile`);
  const declaredValues = has("number-not-declared") ? stringList(raw["declaredValues"], `${rel}: declaredValues`) : [];
  const emptyBaseline = raw["emptyBaseline"] === undefined ? [] : stringList(raw["emptyBaseline"], `${rel}: emptyBaseline`);
  const skillPaths = raw["skillPaths"] === undefined ? null : stringList(raw["skillPaths"], `${rel}: skillPaths`);
  return {
    include,
    exclude,
    quotedWords: exemptions["quotedWords"] !== false,
    recordPaths: records === undefined ? [] : stringList((records as Record<string, unknown>)["paths"], `${rel}: records.paths`),
    recordRules: records === undefined ? [] : stringList((records as Record<string, unknown>)["rules"], `${rel}: records.rules`),
    versionSource,
    decisionsFile,
    markerRows,
    markerLimit,
    emptyBaseline,
    rulingsFile: has("reading-cited-as-ruled") ? (raw["rulingsFile"] as string) : null,
    declaredValues,
    skillPaths,
    rules,
  };
}

/** Walk the root for the included paths, refusing a symlink that leaves it. */
export function walk(root: string, realRoot: string, include: readonly string[], exclude: readonly string[]): string[] {
  const included = include.map(globToRegex);
  const excluded = exclude.map(globToRegex);
  const prefixes = include.map((glob): string => glob.slice(0, glob.indexOf("*") < 0 ? glob.length : glob.indexOf("*")));
  const out: string[] = [];
  const visit = (relDir: string): void => {
    let names: string[] = [];
    try {
      names = readdirSync(join(root, relDir));
    } catch (error) {
      wiring(`cannot list ${relDir === "" ? "." : relDir}: ${(error as Error).message}`);
    }
    for (const name of names.sort()) {
      const rel = relDir === "" ? name : `${relDir}/${name}`;
      if (relDir === "" && [".git", "node_modules", ".nen", ".claude"].includes(name)) continue;
      if (excluded.some((re): boolean => re.test(rel) || re.test(`${rel}/`))) continue;
      const abs = join(root, rel);
      let st;
      try {
        st = lstatSync(abs);
        if (st.isSymbolicLink()) {
          let real = "";
          try {
            real = realpathSync(abs);
          } catch {
            wiring(`symlink ${rel} is dangling`);
          }
          if (real !== realRoot && !real.startsWith(realRoot + sep)) wiring(`symlink ${rel} leaves the root (${real})`);
          st = statSync(abs);
          if (st.isDirectory()) continue; // read through its real path, never twice
        }
      } catch (error) {
        if (error instanceof LintWiringError) throw error;
        return wiring(`cannot stat ${rel}: ${(error as Error).message}`);
      }
      if (st.isDirectory()) {
        if (prefixes.some((prefix): boolean => prefix.startsWith(`${rel}/`) || `${rel}/`.startsWith(prefix))) visit(rel);
      } else if (st.isFile() && included.some((re): boolean => re.test(rel))) out.push(rel);
    }
  };
  visit("");
  return out;
}

/** Quoted words -- "…" and “…” -- blanked, newlines kept: the maintainer's words are never linted. */
export function exemptQuoted(text: string): string {
  let out = text;
  for (const re of [/"[^"]{1,600}"/g, /“[^”]{1,600}”/g]) out = out.replace(re, (match): string => match.replace(/[^\n]/g, " "));
  return out;
}

interface Ctx {
  readonly root: string;
  readonly contract: LintContract;
  readonly min: string;
  readonly pin: string;
  readonly docs: Map<string, Doc>;
  readonly reading: ReadonlySet<string>;
  readonly declared: ReadonlySet<string>;
  readonly markerOk: ReadonlySet<string>;
  readonly humanGate: ReadonlySet<string>;
}

function loadDoc(ctx: { root: string; docs: Map<string, Doc> }, rel: string): Doc | null {
  const cached = ctx.docs.get(rel);
  if (cached !== undefined) return cached;
  const abs = join(ctx.root, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  const doc = parseDoc(rel, readUtf8(abs, rel));
  ctx.docs.set(rel, doc);
  return doc;
}

/** A link target resolved from the citing file's directory, kept inside the root. */
export function resolveLinkTarget(root: string, from: string, target: string): { rel: string | null; why?: string } {
  let path: string;
  try {
    path = decodeURIComponent(target.split("#")[0] ?? "");
  } catch {
    path = target.split("#")[0] ?? "";
  }
  if (path === "") return { rel: from };
  const abs = resolve(root, dirname(from), path);
  if (abs !== root && !abs.startsWith(root + sep)) return { rel: null, why: "leaves the root" };
  if (!existsSync(abs)) return { rel: null, why: "no such file" };
  // A symlink inside the root that resolves outside it leaves the root too:
  // nothing outside the checkout is read to answer a citation.
  const realRoot = realpathSync(root);
  const real = realpathSync(abs);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return { rel: null, why: "leaves the root" };
  return { rel: relative(root, abs).split(sep).join("/") };
}

/** Whether a doc carries a heading or bold lead numbered `n`. */
export function hasNumbered(doc: Doc, n: string): boolean {
  return [...doc.headings, ...doc.leads].some((h): boolean => headingNumber(h.text) === n);
}

/** Whether a doc carries a heading or bold lead answering the title. */
export function hasTitled(doc: Doc, title: string): boolean {
  return doc.headings.some((h): boolean => titleMatches(h.text, title)) || doc.leads.some((l): boolean => titleMatches(l.text, title));
}

const LINK = /\[(?:[^\]\n]|\n)*?\]\(([^)\s]+)\)((?:'s)?\s*§§?\s*(?:(\d+[a-z]?(?:\.\d+)*)|\*([^*\n]+)\*))?/g;

function checkDoc(ctx: Ctx, doc: Doc): Finding[] {
  const out: Finding[] = [];
  const c = ctx.contract;
  const skillRes = c.skillPaths === null ? null : c.skillPaths.map(globToRegex);
  const isSkill = skillRes === null || skillRes.some((re): boolean => re.test(doc.path));
  const isRecord = c.recordPaths.map(globToRegex).some((re): boolean => re.test(doc.path));
  const add = (rule: Rule, para: Para, offset: number, text: string): void => {
    const line = lineAt(para, offset);
    if (doc.retired.has(line) && RETIRED_EXEMPT.includes(rule.class)) return;
    if (isRecord && c.recordRules.includes(rule.id)) return;
    out.push({ path: doc.path, line, rule: rule.id, severity: rule.severity, text: text.replace(/\s+/g, " ").trim().slice(0, 160) });
  };
  const re = (rule: Rule, key = "pattern"): RegExp => new RegExp(rule[key] as string, "gi");
  let markers = 0;
  let section = "";
  for (const para of doc.paras) {
    if (para.kind === "heading") {
      const match = /^##\s+(.*)$/.exec(para.text);
      if (match !== null) section = match[1] ?? "";
      continue;
    }
    const masked = c.quotedWords ? exemptQuoted(para.text) : para.text;
    const flat = masked.replace(/\n/g, " ");
    const around = (offset: number, length: number): string => flat.slice(Math.max(0, offset - 24), offset + length + 24);
    for (const rule of c.rules) {
      switch (rule.class) {
        case "by-hand": {
          const negation = re(rule, "negations");
          for (const m of flat.matchAll(re(rule))) {
            const clause = flat.slice(0, m.index).split(/[.;:!?—–]\s|\(/).pop() ?? "";
            negation.lastIndex = 0;
            if (!negation.test(clause)) add(rule, para, m.index, around(m.index, m[0].length));
          }
          break;
        }
        case "stale-residue":
          if (!re(rule, "requires").test(flat)) for (const m of flat.matchAll(re(rule))) add(rule, para, m.index, around(m.index, m[0].length));
          break;
        case "stale-version": {
          const pastWords = ((rule["pastWords"] as string[] | undefined) ?? []).map((w): string => w.toLowerCase());
          (rule["patterns"] as string[]).forEach((source, n): void => {
            for (const m of flat.matchAll(new RegExp(source, "gi"))) {
              const [maj, min, pat] = [m[1], m[2], m[3]];
              const offset = m.index;
              if (n === 0) {
                // A pin claim: nen's (no other tool's pin named nearby), not after a past word.
                const near = flat.slice(Math.max(0, offset - 80), offset + m[0].length + 40);
                if (new RegExp(rule["otherPins"] as string, "i").test(near)) continue;
                const previous = (flat.slice(0, offset).match(/[A-Za-z]+/g) ?? []).slice(-2).map((w): string => w.toLowerCase());
                if (previous.some((w): boolean => pastWords.includes(w))) continue;
                if (`${maj}.${min}` === ctx.min && pat === undefined) continue;
                if (`${maj}.${min}.${pat}` === ctx.pin.replace(/^v/, "")) continue;
              } else if (`${maj}.${min}` === ctx.min) continue; // a floor claim equal to the minimum
              add(rule, para, offset, m[0]);
            }
          });
          break;
        }
        case "citation": {
          const unspanned = masked.replace(/`[^`\n]*`/g, (span): string => " ".repeat(span.length));
          for (const m of unspanned.matchAll(LINK)) {
            const target = m[1] ?? "";
            if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("<")) continue;
            const resolved = resolveLinkTarget(ctx.root, doc.path, target);
            if (resolved.rel === null) {
              add(rule, para, m.index, `${target} — ${resolved.why ?? "unresolved"}`);
              continue;
            }
            const anchor = target.includes("#") ? safeDecode(target.slice(target.indexOf("#") + 1)) : "";
            if (!resolved.rel.endsWith(".md")) continue;
            const linked = loadDoc(ctx, resolved.rel);
            if (linked === null) continue;
            if (anchor !== "" && !linked.anchors.has(anchor)) add(rule, para, m.index, `${target} — no anchor #${anchor}`);
            if (m[3] !== undefined) {
              if (!hasNumbered(linked, m[3])) add(rule, para, m.index, `${resolved.rel} § ${m[3]} — no such heading`);
            } else if (m[4] !== undefined && !hasTitled(linked, m[4])) {
              add(rule, para, m.index, `${resolved.rel} § *${m[4]}* — no heading or bold lead`);
            }
          }
          break;
        }
        case "bare-ref":
          for (const m of flat.matchAll(re(rule))) {
            if (/\]\([^)\s]*$/.test(flat.slice(0, m.index))) continue; // inside a link target
            add(rule, para, m.index, around(m.index, m[0].length));
          }
          break;
        case "unverified-claim":
          if (!(re(rule, "date").test(flat) && re(rule, "evidence").test(flat))) for (const m of flat.matchAll(re(rule))) add(rule, para, m.index, around(m.index, m[0].length));
          break;
        case "hedge":
        case "adjective":
          for (const m of flat.matchAll(re(rule))) add(rule, para, m.index, around(m.index, m[0].length));
          break;
        case "number-not-declared":
          if (/\bnen [a-z]/.test(flat)) for (const m of flat.matchAll(re(rule))) if (!ctx.declared.has(m[1] ?? "")) add(rule, para, m.index, m[0]);
          break;
        case "residue-unfiled": {
          const sectionRe = new RegExp((rule["section"] as string | undefined) ?? "^Residue\\b", "i");
          if (sectionRe.test(section) && para.kind === "prose" && /^\s*(?:\d+\.|[-*+])\s+/.test(para.lines[0] ?? "") && !re(rule, "requires").test(flat)) add(rule, para, 0, flat.slice(0, 120));
          break;
        }
        case "open-question-shape":
          for (const m of flat.matchAll(re(rule))) {
            const offset = m.index;
            const whole = new RegExp(rule["marker"] as string, "y");
            whole.lastIndex = offset;
            const marker = whole.exec(flat);
            if (marker === null) {
              add(rule, para, offset, `${around(offset, m[0].length)} — not [NEEDS <row-id>: question]`);
              continue;
            }
            markers++;
            const row = marker[1] ?? "";
            if (ctx.humanGate.has(row)) add(rule, para, offset, `${marker[0]} — row ${row} is a human gate: a stop, not a question`);
            else if (!ctx.markerOk.has(row)) add(rule, para, offset, `${marker[0]} — row ${row} is not an ask-class marker row`);
            if (!re(rule, "ledger").test(flat)) add(rule, para, offset, `${marker[0]} — no OPEN-n or zheref/<repo>#N ledger reference`);
            if (isSkill && c.markerLimit !== null && markers > c.markerLimit) add(rule, para, offset, `${marker[0]} — marker ${markers} over the limit of ${c.markerLimit}`);
          }
          break;
        case "reading-cited-as-ruled":
          if (isSkill && !/\breading\b/i.test(flat)) {
            const prefix = (rule["prefix"] as string | undefined) ?? "HR";
            for (const m of flat.matchAll(re(rule))) if (ctx.reading.has(m[1] ?? "")) add(rule, para, m.index, `${prefix}-${m[1] ?? ""} is status reading`);
          }
          break;
      }
    }
  }
  return out;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The clause numbers whose status is `reading` in the rulings file: a
 * definition anchor `<a id="hr-N"></a>**HR-N**` followed by `(reading)`, or a
 * table row carrying one in its first cell whose `Status` column (by header,
 * else the fifth) starts with `reading`.
 */
export function readingClauses(doc: Doc, prefix: string): Set<string> {
  const out = new Set<string>();
  const lower = prefix.toLowerCase();
  const definition = new RegExp(`<a id="${lower}-(\\d+)"></a>\\*\\*${prefix}-\\d+\\*\\*`);
  let statusColumn = 5;
  let inTable = false;
  for (const line of doc.lines) {
    const isRow = /^\s*\|/.test(line);
    // A new table starts with the guard's fixed column; its header may move it.
    if (isRow && !inTable) statusColumn = 5;
    inTable = isRow;
    if (isRow && !definition.test(line)) {
      const cells = line.split(/(?<!\\)\|/).map((cell): string => cell.trim());
      const at = cells.findIndex((cell): boolean => /^status$/i.test(cell));
      if (at > 0) statusColumn = at;
      continue;
    }
    const match = definition.exec(line);
    if (match === null) continue;
    const id = match[1] ?? "";
    const after = line.slice((match.index ?? 0) + match[0].length);
    if (/^\s*\((?:status:\s*)?reading\b/i.test(after)) {
      out.add(id);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const cells = line.split(/(?<!\\)\|/).map((cell): string => cell.trim());
      if (/^`?reading\b/i.test(cells[statusColumn] ?? "")) out.add(id);
    }
  }
  return out;
}

function declaredNumbers(root: string, globs: readonly string[]): Set<string> {
  const out = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "number") out.add(String(value));
    else if (typeof value === "string" && /^\d+$/.test(value)) out.add(value);
    else if (Array.isArray(value)) value.forEach(add);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(add);
  };
  for (const glob of globs) {
    const re = globToRegex(glob);
    const dir = glob.includes("/") ? glob.slice(0, glob.lastIndexOf("/")) : ".";
    let names: string[] = [];
    try {
      names = readdirSync(join(root, dir));
    } catch {
      wiring(`declaredValues directory ${dir} cannot be listed`);
    }
    for (const name of names.sort()) {
      const rel = dir === "." ? name : `${dir}/${name}`;
      if (re.test(rel)) add(readJson(join(root, rel), rel));
    }
  }
  return out;
}

function git(seams: Seams, root: string, args: readonly string[]): string {
  const result = seams.run(GIT, ["-C", root, ...args]);
  if (result.spawnFailed) return wiring(`git could not be started for 'git ${args.join(" ")}'`);
  if (result.code !== 0) return wiring(`git ${args.join(" ")} failed: ${(result.stderr.split("\n")[0] ?? "").trim()}`);
  return result.stdout;
}

export function parseBaseline(text: string, rel: string, never: readonly string[]): BaselineRow[] {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (error) {
    return wiring(`${rel} is not valid JSON: ${(error as Error).message}`);
  }
  const rows = isRecord(document) ? document["findings"] : undefined;
  if (!Array.isArray(rows)) return wiring(`${rel} lacks findings[]`);
  for (const row of rows as BaselineRow[]) {
    if (!isRecord(row) || typeof row.path !== "string" || typeof row.rule !== "string" || typeof row.text !== "string" || !Number.isInteger(row.count) || row.count < 1) wiring(`${rel} has a malformed row`);
    if (never.includes(row.rule)) wiring(`${rel}: ${row.rule} is never baselined; fix the prose instead`);
  }
  return rows as BaselineRow[];
}

const keyOf = (path: string, rule: string, text: string): string => `${path}\u0000${rule}\u0000${text.toLowerCase()}`;

export interface LintOptions {
  readonly root: string;
  readonly rules: string;
  readonly baseline: string | null;
  readonly base: string | null;
}

/** Run the lint. Throws LintWiringError when it could not look. */
export function canonLint(options: LintOptions, seams: Seams): { readonly report: LintReport; readonly rules: readonly Rule[] } {
  const root = resolve(options.root);
  if (!existsSync(root) || !statSync(root).isDirectory()) wiring(`root ${options.root} is not a directory`);
  const realRoot = realpathSync(root);
  const rulesAbs = resolve(root, options.rules);
  if (!existsSync(rulesAbs)) wiring(`rules contract ${options.rules} does not exist under ${root}`);
  const contract = parseLintContract(readJson(rulesAbs, options.rules), options.rules);
  let min = "";
  let pin = "";
  if (contract.versionSource !== null) {
    const vs = contract.versionSource;
    const document = readJson(join(root, vs.file), vs.file);
    const minimum = pointer(document, vs.minimum);
    const pinned = pointer(document, vs.pinned);
    if (typeof minimum !== "string" || typeof pinned !== "string") wiring(`${vs.file} lacks the minimum or pinned value the contract names (${vs.minimum}, ${vs.pinned})`);
    min = minimum as string;
    pin = pinned as string;
  }
  let humanGate = new Set<string>();
  if (contract.decisionsFile !== null) {
    const decisions = readJson(join(root, contract.decisionsFile), contract.decisionsFile);
    const rows = isRecord(decisions) ? decisions["rows"] : undefined;
    if (!Array.isArray(rows)) wiring(`${contract.decisionsFile} lacks rows[]`);
    const typed = (rows as unknown[]).filter(isRecord) as { id?: unknown; class?: unknown }[];
    const ids = new Set(typed.map((row): unknown => row.id));
    for (const row of contract.markerRows) if (!ids.has(row)) wiring(`markerRows names ${row}, which ${contract.decisionsFile} does not carry`);
    humanGate = new Set(typed.filter((row): boolean => row.class === "human-gate" && typeof row.id === "string" && !contract.markerRows.includes(row.id)).map((row): string => row.id as string));
  }
  const docs = new Map<string, Doc>();
  let reading = new Set<string>();
  if (contract.rulingsFile !== null) {
    const rulings = loadDoc({ root, docs }, contract.rulingsFile);
    if (rulings === null) wiring(`rulings file ${contract.rulingsFile} is missing`);
    const rule = contract.rules.find((r): boolean => r.class === "reading-cited-as-ruled");
    reading = readingClauses(rulings as Doc, (rule?.["prefix"] as string | undefined) ?? "HR");
  }
  const ctx: Ctx = { root, contract, min, pin, docs, reading, declared: declaredNumbers(root, contract.declaredValues), markerOk: new Set(contract.markerRows), humanGate };
  let files = walk(root, realRoot, contract.include, contract.exclude);
  let baseRows: BaselineRow[] | null = null;
  if (options.base !== null) {
    const mergeBase = git(seams, root, ["merge-base", options.base, "HEAD"]).trim();
    const changed = new Set(git(seams, root, ["diff", "--name-only", "--relative", mergeBase]).split("\n").filter((line): boolean => line !== ""));
    files = files.filter((file): boolean => changed.has(file));
    if (options.baseline !== null) {
      const shown = seams.run(GIT, ["-C", root, "show", `${mergeBase}:./${options.baseline}`]);
      if (!shown.spawnFailed && shown.code === 0) baseRows = parseBaseline(shown.stdout, `${options.base}:${options.baseline}`, contract.emptyBaseline);
    }
  }
  const findings: Finding[] = [];
  for (const file of files) {
    const doc = loadDoc(ctx, file);
    if (doc === null) return wiring(`cannot read ${file}`);
    findings.push(...checkDoc(ctx, doc));
  }
  let rows: BaselineRow[] = [];
  if (options.baseline !== null) {
    const abs = resolve(root, options.baseline);
    if (!existsSync(abs)) wiring(`baseline ${options.baseline} is missing`);
    rows = parseBaseline(readUtf8(abs, options.baseline), options.baseline, contract.emptyBaseline);
  }
  const budget = new Map<string, number>();
  for (const row of rows) budget.set(keyOf(row.path, row.rule, row.text), (budget.get(keyOf(row.path, row.rule, row.text)) ?? 0) + row.count);
  const fails = findings.filter((f): boolean => f.severity === "fail");
  for (const finding of fails) {
    const key = keyOf(finding.path, finding.rule, finding.text);
    const left = budget.get(key) ?? 0;
    finding.inBaseline = left > 0;
    if (left > 0) budget.set(key, left - 1);
  }
  const scoped = new Set(files);
  const stale = rows
    .filter((row): boolean => scoped.has(row.path) && (budget.get(keyOf(row.path, row.rule, row.text)) ?? 0) > 0)
    .filter((row, i, all): boolean => all.findIndex((x): boolean => keyOf(x.path, x.rule, x.text) === keyOf(row.path, row.rule, row.text)) === i);
  const grown: BaselineRow[] = [];
  if (baseRows !== null) {
    const was = new Map<string, number>();
    for (const row of baseRows) was.set(keyOf(row.path, row.rule, row.text), (was.get(keyOf(row.path, row.rule, row.text)) ?? 0) + row.count);
    for (const row of rows) if (row.count > (was.get(keyOf(row.path, row.rule, row.text)) ?? 0)) grown.push(row);
  }
  const fresh = fails.filter((f): boolean => f.inBaseline !== true);
  const counts: Record<string, { total: number; baselined: number; new: number }> = {};
  for (const rule of contract.rules) counts[rule.id] = { total: 0, baselined: 0, new: 0 };
  for (const finding of findings) {
    const count = counts[finding.rule];
    if (count === undefined) continue;
    count.total++;
    if (finding.inBaseline === true) count.baselined++;
    else if (finding.severity === "fail") count.new++;
  }
  const report: LintReport = {
    contract: CANON_LINT_CONTRACT,
    root,
    rules: options.rules,
    baseline: options.baseline,
    base: options.base,
    files: files.length,
    exit: fresh.length > 0 || stale.length > 0 || grown.length > 0 ? 1 : 0,
    counts,
    findings: fails,
    advisory: findings.filter((f): boolean => f.severity === "advisory").map((f): Omit<Finding, "inBaseline"> => ({ path: f.path, line: f.line, rule: f.rule, severity: f.severity, text: f.text })),
    staleBaseline: stale,
    grownBaseline: grown,
  };
  return { report, rules: contract.rules };
}

/** The human rendering: new findings, stale and grown rows, then one summary line. */
export function renderLint(report: LintReport, rules: readonly Rule[]): string[] {
  const lines: string[] = [];
  const fresh = report.findings.filter((f): boolean => f.inBaseline !== true);
  for (const f of fresh) lines.push(`${f.path}:${f.line} · ${f.rule} · ${f.text}`);
  for (const r of report.staleBaseline) lines.push(`baseline · ${r.rule} · ${r.path} · ${r.text} — no longer found; remove the row`);
  for (const r of report.grownBaseline) lines.push(`baseline · ${r.rule} · ${r.path} · ${r.text} — added over ${report.base ?? "the base"}; the baseline only shrinks`);
  if (report.base !== null) for (const f of report.advisory) lines.push(`advisory ${f.path}:${f.line} · ${f.rule} · ${f.text}`);
  const summary = rules
    .map((rule): string => {
      const count = report.counts[rule.id] ?? { total: 0, baselined: 0, new: 0 };
      return `${rule.id} ${count.total}${rule.severity === "advisory" ? "a" : `/${count.baselined}b`}`;
    })
    .join(" · ");
  lines.push(`canon lint: ${report.files} files · ${fresh.length} new · ${report.staleBaseline.length} stale · ${report.grownBaseline.length} grown · ${summary}`);
  return lines;
}
