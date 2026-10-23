// src/spec/check.ts -- `nen spec check`: a spec folder or a constitution held
// to citation-or-marker, and the rest of Spec Kit analyze's passes nen can
// compute without judgement (SDD plan piece N10, Hatsu ruling HR-12).
//
// IT REPORTS AND NEVER DECIDES. Each pass is a fact about the text: a line that
// ends in neither a citation nor a marker, a duplicated id, a task citing an FR
// the spec never defines, a term the CALLER listed as vague. nen ships no list
// of vague words -- `--vocabulary` is the caller's, and with none the pass is
// reported as not run, never as clean. Severity follows Spec Kit analyze's
// four levels, and only CRITICAL turns the exit to 1.
//
// THE RANKING IS THE TAXONOMY'S ORDER, NOT AN ESTIMATE OF IMPACT. Spec Kit
// clarify asks its questions by impact times uncertainty, which is a judgement;
// nen places each open [NEEDS CLARIFICATION] under the clarify taxonomy
// category its section heading names and orders by that taxonomy's own order,
// then by line. What to ask first stays the caller's; the order is a stable
// default it may take.

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { citationsIn, markersIn, proseLines, requirementOf, trailingAnnotation, unclosedFence, type MarkerKind, type SourceLine } from "./lines.js";

export const SPEC_CHECK_CONTRACT = "nen.spec.check/v0.1";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export const SEVERITIES: readonly Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

/** Spec Kit clarify's coverage taxonomy, in its own order. */
export const CLARIFY_TAXONOMY = [
  "Functional Scope & Behavior",
  "Domain & Data Model",
  "Interaction & UX Flow",
  "Non-Functional Quality Attributes",
  "Integration & External Dependencies",
  "Edge Cases & Failure Handling",
  "Constraints & Tradeoffs",
  "Terminology & Consistency",
  "Completion Signals",
  "Misc / Placeholders",
] as const;
export type ClarifyCategory = (typeof CLARIFY_TAXONOMY)[number];

/** Heading words -> category, tried in order (non-functional before functional). */
const CATEGORY_BY_HEADING: readonly [RegExp, ClarifyCategory][] = [
  [/non-functional|quality attribute|performance|security|reliability|accessibility/i, "Non-Functional Quality Attributes"],
  [/functional requirement|scope|behaviou?r/i, "Functional Scope & Behavior"],
  [/key entit|data model|entit/i, "Domain & Data Model"],
  [/user scenario|user stor|acceptance|ux|interaction|flow/i, "Interaction & UX Flow"],
  [/integration|dependenc|external/i, "Integration & External Dependencies"],
  [/edge case|failure|error/i, "Edge Cases & Failure Handling"],
  [/constraint|assumption|tradeoff|trade-off/i, "Constraints & Tradeoffs"],
  [/glossary|terminolog|vocabular/i, "Terminology & Consistency"],
  [/success criteri|measurable|outcome|completion/i, "Completion Signals"],
];

export function categoryOf(heading: string | null): ClarifyCategory {
  if (heading === null) return "Misc / Placeholders";
  for (const [pattern, category] of CATEGORY_BY_HEADING) if (pattern.test(heading)) return category;
  return "Misc / Placeholders";
}

export interface Finding {
  readonly id: string;
  readonly severity: Severity;
  readonly rule: string;
  readonly file: string;
  readonly line: number | null;
  readonly message: string;
}

export interface RankedMarker {
  readonly file: string;
  readonly line: number;
  readonly category: ClarifyCategory;
  readonly text: string;
}

export interface OpenMarker {
  readonly file: string;
  readonly line: number;
  readonly kind: MarkerKind;
  readonly text: string;
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface SpecCheckReport {
  readonly contract: string;
  readonly repo: string;
  readonly mode: "folder" | "constitution";
  readonly path: string;
  readonly files: readonly string[];
  readonly vocabulary: string | null;
  readonly requirements: { readonly total: number; readonly cited: number; readonly marked: number; readonly ruled: number; readonly stale: number; readonly FR: number; readonly SC: number; readonly US: number };
  readonly markers: { readonly needsClarification: number; readonly needsRuling: number; readonly unverified: number; readonly total: number };
  /** Every open marker in line order, with --markers; null otherwise. */
  readonly open: readonly OpenMarker[] | null;
  readonly ranked: { readonly max: number | null; readonly total: number; readonly shown: readonly RankedMarker[] } | null;
  readonly tasks: "checked" | "absent" | "not-applicable";
  readonly findings: readonly Finding[];
  readonly counts: Readonly<Record<Severity, number>>;
}

export interface CheckInput {
  readonly repo: string;
  readonly mode: "folder" | "constitution";
  /** Repository-relative: the folder, or the constitution file. */
  readonly path: string;
  /** The caller's vague terms, or null when no list was supplied. */
  readonly vocabulary: { readonly path: string; readonly terms: readonly string[] } | null;
  readonly markers: boolean;
  readonly rank: boolean;
  readonly max: number | null;
  /** `spec.maxBytes` from the repository's nen/workflow.json, when it states one: a file over it is a HIGH finding. */
  readonly maxBytes?: number | null;
}

export class SpecReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecReadError";
  }
}

/** A spec file that resolves outside --repo (a symlink out of the root): a usage refusal, exit 2. */
export class SpecContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecContainmentError";
  }
}

/**
 * Refuse a path that resolves outside `repo` (as `canon lint` refuses a link
 * leaving its root): a verdict computed from a file outside the spec
 * repository would be a verdict about something git never commits.
 */
export function assertInsideRepo(repo: string, absolute: string, shown: string): void {
  let real: string;
  let root: string;
  try {
    real = realpathSync(absolute);
    root = realpathSync(repo);
  } catch {
    return;
  }
  const rel = relative(root, real);
  if (rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new SpecContainmentError(`${shown} resolves to ${real}, outside --repo (${root}); a symlink that leaves the spec repository is refused, never read.`);
  }
}

export const CONSTITUTION_PATH = ".specify/memory/constitution.md";

/** A caller's term list: one term per line, `#` lines and blanks skipped. */
export function parseVocabulary(text: string): string[] {
  return [...new Set(text.replace(/\r\n/g, "\n").split("\n").map((line): string => line.trim()).filter((line): boolean => line !== "" && !line.startsWith("#")))];
}

function readText(repo: string, file: string): string | null {
  const relative = file;
  const absolute = join(repo, file);
  let isFile: boolean;
  try {
    isFile = statSync(absolute).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SpecReadError(`could not read ${relative}: ${(error as Error).message}`);
  }
  if (!isFile) throw new SpecReadError(`${relative} is not a file`);
  assertInsideRepo(repo, absolute, relative);
  try {
    return readFileSync(absolute, "utf8");
  } catch (error) {
    throw new SpecReadError(`could not read ${relative}: ${(error as Error).message}`);
  }
}

const PLACEHOLDER_EXEMPT = new Set(["NEEDS RULING", "UNVERIFIED", "STALE", "P", "X"]);
const PLACEHOLDERS: readonly RegExp[] = [
  /\$ARGUMENTS\b/g,
  /\[###-[a-z-]+\]/g,
  /\[[A-Z][A-Z0-9_#]*(?:[ _-][A-Z0-9_#]+)*\]/g,
  /\b(?:TODO|TBD|FIXME)\b/g,
];

function placeholdersIn(line: string): string[] {
  const found: string[] = [];
  for (const pattern of PLACEHOLDERS) {
    for (const match of line.matchAll(pattern)) {
      const inner = match[0].replace(/^\[|\]$/g, "");
      if (match[0].startsWith("[") && (PLACEHOLDER_EXEMPT.has(inner) || /^US\d+$/.test(inner) || /^T\d+$/.test(inner))) continue;
      found.push(match[0]);
    }
  }
  return found;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The lines constitution mode holds to citation-or-marker: list items under a 'Product rules' heading. */
function productRuleLines(lines: readonly SourceLine[]): SourceLine[] {
  const out: SourceLine[] = [];
  let inside = false;
  let level = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.text);
    if (heading !== null) {
      const depth = (heading[1] as string).length;
      if (/product rules/i.test(heading[2] as string)) {
        inside = true;
        level = depth;
      } else if (inside && depth <= level) {
        inside = false;
      }
      continue;
    }
    if (inside && /^\s*(?:[-*+]|\d+\.)\s+\S/.test(line.text)) out.push(line);
  }
  return out;
}

export function checkSpec(input: CheckInput): SpecCheckReport {
  const findings: Omit<Finding, "id">[] = [];
  const add = (severity: Severity, rule: string, file: string, line: number | null, message: string): void => {
    findings.push({ severity, rule, file, line, message });
  };
  const mainFile = input.mode === "folder" ? `${input.path}/spec.md` : input.path;
  if (input.mode === "folder") {
    let isDir = false;
    try {
      isDir = statSync(join(input.repo, input.path)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SpecReadError(`could not read ${input.path}: ${(error as Error).message}`);
    }
    if (!isDir) throw new SpecReadError(`${input.path} is not a folder under --repo`);
    assertInsideRepo(input.repo, join(input.repo, input.path), input.path);
  }
  const text = readText(input.repo, mainFile);
  if (text === null) throw new SpecReadError(`${mainFile} does not exist; there is nothing to check, which is not the same as nothing found`);
  const lines = proseLines(text);
  const files = [mainFile];

  // ── requirement lines: citation-or-marker ──
  const held: { line: SourceLine; kind: "FR" | "SC" | "US" | "RULE"; id: string | null }[] =
    input.mode === "folder"
      ? lines.flatMap((line) => {
          const requirement = requirementOf(line.text);
          return requirement === null ? [] : [{ line, kind: requirement.kind, id: requirement.id }];
        })
      : productRuleLines(lines).map((line) => ({ line, kind: "RULE" as const, id: null }));
  let cited = 0;
  let marked = 0;
  let ruledCount = 0;
  let staleCount = 0;
  const seen = new Map<string, number>();
  for (const { line, kind, id } of held) {
    let annotation = trailingAnnotation(line.text);
    // A STORY HEADING MAY CARRY ITS ANNOTATION IN ITS PRIORITY FIELD --
    // `### US-1 — Title (Priority: [NEEDS RULING])`, Hatsu's spelling -- so a
    // heading with no trailing group is read for one anywhere on it.
    if (kind === "US" && annotation.citations.length === 0 && annotation.markers.length === 0 && annotation.malformed.length === 0 && annotation.ruled.length === 0) {
      const inline = citationsIn(line.text);
      annotation = {
        ...annotation,
        citations: inline.flatMap((entry) => (entry.citation === null ? [] : [entry.citation])),
        malformed: inline.flatMap((entry) => (entry.citation === null ? [entry.text] : [])),
        markers: markersIn(line.text),
      };
    }
    const label = id ?? "product rule";
    for (const bad of annotation.malformed) {
      add("CRITICAL", "malformed-citation", mainFile, line.number, `${label} ends in '${bad}', which is not '[src: <CODE>:<path>:<l1>-<l2> @ <sha> · declared|observed|inferred]' or a marker`);
    }
    for (const citation of annotation.citations) {
      if (citation.l1 < 1 || citation.l2 < citation.l1) add("CRITICAL", "malformed-citation", mainFile, line.number, `${label} cites lines ${citation.l1}-${citation.l2}, which is not a range`);
    }
    if (annotation.citations.length === 0 && annotation.markers.length === 0 && annotation.malformed.length === 0 && annotation.ruled.length === 0) {
      add("CRITICAL", "uncited", mainFile, line.number, `${label} ends in neither a [src:] citation nor one of [NEEDS CLARIFICATION: …] · [NEEDS RULING] · [UNVERIFIED] · [ruled: CL-nnn]`);
    }
    if (annotation.stale.length > 0) {
      staleCount += 1;
      if (annotation.citations.length === 0) add("HIGH", "stale-without-citation", mainFile, line.number, `${label} carries ${annotation.stale[0] as string} beside no citation; a STALE note is a citation's companion`);
    }
    if (annotation.markers.length > 1) add("HIGH", "several-markers", mainFile, line.number, `${label} ends in ${annotation.markers.length} markers; a line carries exactly one`);
    if (annotation.markers.length > 0 && annotation.citations.length > 0) add("HIGH", "cited-and-marked", mainFile, line.number, `${label} ends in both a citation and a marker; it is one or the other`);
    if (annotation.citations.length > 0) cited += 1;
    else if (annotation.markers.length > 0) marked += 1;
    else if (annotation.ruled.length > 0) ruledCount += 1;
    const inferred = annotation.citations.some((citation): boolean => citation.tier === "inferred");
    if (inferred && (kind === "SC" || (kind === "FR" && /\bMUST\b/.test(line.text)))) {
      add("CRITICAL", "inferred-tier", mainFile, line.number, `${label} rests on an inferred citation inside ${kind === "SC" ? "a success criterion" : "a MUST"}; an inferred row lives in research.md until a test or a ruling promotes it`);
    }
    if (id !== null) {
      const first = seen.get(id);
      if (first !== undefined) add("CRITICAL", "duplicate-id", mainFile, line.number, `${id} is defined again (first at line ${first})`);
      else seen.set(id, line.number);
    }
  }

  // ── markers, placeholders, vague terms ──
  const counts: Record<MarkerKind, number> = { "needs-clarification": 0, "needs-ruling": 0, unverified: 0 };
  const clarifications: RankedMarker[] = [];
  const open: OpenMarker[] = [];
  for (const line of lines) {
    for (const marker of markersIn(line.text)) {
      counts[marker.kind] += 1;
      open.push({ file: mainFile, line: line.number, kind: marker.kind, text: marker.text });
      if (marker.kind === "needs-clarification") clarifications.push({ file: mainFile, line: line.number, category: categoryOf(line.heading), text: marker.text });
    }
    for (const placeholder of placeholdersIn(line.text)) add("HIGH", "placeholder", mainFile, line.number, `template placeholder '${placeholder}' was never replaced`);
  }
  if (input.vocabulary !== null) {
    for (const { line, id } of held) {
      for (const term of input.vocabulary.terms) {
        if (new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, "iu").test(line.text)) {
          add("MEDIUM", "vague-term", mainFile, line.number, `${id ?? "product rule"} uses '${term}', a term the vocabulary lists as vague`);
        }
      }
    }
  }
  // NOTHING HELD IS NEVER CLEAN (Phinks, delivery round on zheref/nen#498): a
  // folder whose spec.md defines no FR, SC or story line was held to nothing,
  // and a fence that runs to the end of the file hid the rest of it.
  if (input.mode === "folder" && held.length === 0) {
    add("CRITICAL", "no-held-lines", mainFile, null, "spec.md defines no FR-###, SC-### or story line (User Story n / US-n), so nothing was held to citation-or-marker; an empty check is not a passing one");
  }
  const openFence = unclosedFence(text);
  if (openFence !== null) add("CRITICAL", "unclosed-fence", mainFile, openFence, "a fenced block opened here never closes, so every line after it was read as source data and held to nothing");
  if (input.mode === "constitution") {
    if (!lines.some((line): boolean => /\*\*Version\*\*\s*:/.test(line.text))) add("HIGH", "no-version-line", mainFile, null, "the constitution carries no '**Version**:' line");
    if (held.length === 0) add("LOW", "no-product-rules", mainFile, null, "no list item sits under a 'Product rules' heading, so no rule was held to citation-or-marker");
  }

  // ── FR <-> task, both ways ──
  let tasks: SpecCheckReport["tasks"] = "not-applicable";
  if (input.mode === "folder") {
    const tasksFile = `${input.path}/tasks.md`;
    const tasksText = readText(input.repo, tasksFile);
    if (tasksText === null) {
      tasks = "absent";
    } else {
      tasks = "checked";
      files.push(tasksFile);
      const defined = new Set(held.filter((entry): boolean => entry.kind === "FR").map((entry): string => entry.id as string));
      const referenced = new Map<string, number>();
      for (const line of proseLines(tasksText)) {
        if (!/^\s*[-*]\s+\[[ xX]\]\s+/.test(line.text)) continue;
        for (const match of line.text.matchAll(/(?<![A-Za-z0-9-])FR-(\d+)\b/g)) {
          const id = `FR-${match[1] as string}`;
          if (!referenced.has(id)) referenced.set(id, line.number);
          if (!defined.has(id)) add("CRITICAL", "task-cites-unknown-fr", tasksFile, line.number, `a task cites ${id}, which spec.md never defines`);
        }
      }
      for (const entry of held) {
        if (entry.kind === "FR" && !referenced.has(entry.id as string)) add("HIGH", "fr-without-task", mainFile, entry.line.number, `${entry.id as string} has no task in tasks.md`);
      }
    }
  }

  const ordered = clarifications
    .map((marker, index) => ({ marker, index }))
    .sort((a, b): number => CLARIFY_TAXONOMY.indexOf(a.marker.category) - CLARIFY_TAXONOMY.indexOf(b.marker.category) || a.index - b.index)
    .map(({ marker }): RankedMarker => marker);
  if (input.maxBytes !== undefined && input.maxBytes !== null) {
    for (const file of files) {
      const size = statSync(join(input.repo, file)).size;
      if (size > input.maxBytes) add("HIGH", "over-max-bytes", file, null, `${file} is ${size} bytes, over spec.maxBytes ${input.maxBytes} (nen/workflow.json)`);
    }
  }
  const severityCounts = Object.fromEntries(SEVERITIES.map((severity): [Severity, number] => [severity, findings.filter((finding): boolean => finding.severity === severity).length])) as Record<Severity, number>;
  const sorted = [...findings].sort((a, b): number => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  return {
    contract: SPEC_CHECK_CONTRACT,
    repo: input.repo,
    mode: input.mode,
    path: input.path,
    files,
    vocabulary: input.vocabulary?.path ?? null,
    requirements: {
      total: held.length,
      cited,
      marked,
      ruled: ruledCount,
      stale: staleCount,
      FR: held.filter((entry): boolean => entry.kind === "FR").length,
      SC: held.filter((entry): boolean => entry.kind === "SC").length,
      US: held.filter((entry): boolean => entry.kind === "US").length,
    },
    markers: {
      needsClarification: counts["needs-clarification"],
      needsRuling: counts["needs-ruling"],
      unverified: counts.unverified,
      total: counts["needs-clarification"] + counts["needs-ruling"] + counts.unverified,
    },
    open: input.markers ? open : null,
    ranked: input.rank ? { max: input.max, total: ordered.length, shown: input.max === null ? ordered : ordered.slice(0, input.max) } : null,
    tasks,
    findings: sorted.map((finding, index): Finding => ({ id: `${finding.severity[0] as string}${index + 1}`, ...finding })),
    counts: severityCounts,
  };
}

export function renderSpecCheck(report: SpecCheckReport): string[] {
  const lines = [
    `${report.mode} ${report.path}: ${report.requirements.total} requirement line(s) -- ${report.requirements.cited} cited, ${report.requirements.marked} marked, ${report.requirements.ruled} ruled, ${report.requirements.stale} stale (FR ${report.requirements.FR} · SC ${report.requirements.SC} · US ${report.requirements.US})`,
    `markers: ${report.markers.total} open -- ${report.markers.needsClarification} needs-clarification · ${report.markers.needsRuling} needs-ruling · ${report.markers.unverified} unverified`,
    `tasks: ${report.tasks} · vocabulary: ${report.vocabulary ?? "not supplied (vague-term pass not run)"}`,
    `findings: ${SEVERITIES.map((severity): string => `${report.counts[severity]} ${severity}`).join(" · ")}`,
    ...report.findings.map((finding): string => `  ${finding.id} ${finding.severity} ${finding.rule} ${finding.file}${finding.line === null ? "" : `:${finding.line}`} -- ${finding.message}`),
  ];
  if (report.open !== null && report.ranked === null) {
    lines.push(`open markers: ${report.open.length}`);
    for (const marker of report.open) lines.push(`  ${marker.file}:${marker.line} ${marker.kind} ${marker.text}`);
  }
  if (report.ranked !== null) {
    lines.push(`ranked clarifications: ${report.ranked.shown.length} of ${report.ranked.total}${report.ranked.max === null ? "" : ` (--max ${report.ranked.max})`}`);
    report.ranked.shown.forEach((marker, index): void => {
      lines.push(`  ${index + 1}. [${marker.category}] ${marker.file}:${marker.line} ${marker.text}`);
    });
  }
  return lines;
}

/** sha256 hex of a text, the one digest every spec verb uses. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
