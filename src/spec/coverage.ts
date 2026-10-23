// src/spec/coverage.ts -- `nen spec coverage`, in its two forms (zheref/nen#493
// AC-7, AC-12, SP-14).
//
// THE CAPTURE FORM: every member inventory against the spec repository's
// folders. Per member and per row kind, covered over total -- a row is covered
// when some citation of that member names its path with an overlapping line
// range -- and per member the requirement <-> task/test traceability both
// ways, each a number WITH its denominator, never an adjective (SP-14). A kind
// whose total the inventory could not count stays `null` here too.
//
// THE DELIVERY FORM: a spec-derived issue's success criteria against the pull
// request's `## Spec` section (Hatsu docs/config/spec-repo.md § The PR Spec
// section). Every `F<nnn>-SC-###` the issue carries needs exactly one row,
// `— satisfied — test <test id>` or `— deferred — <reason> · <follow-up>`; an
// id the issue does not carry is refused (exit 2), a missing or empty section
// fails (exit 1). With --test-report, each satisfied row's test must be in the
// report and passing. `satisfied` is never read as validated: the report says a
// test ran, never that it exercises the criterion.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RepoRegistry } from "../schema/repos.js";
import { readTestReport, type ParsedReport } from "../shu/test-report/parse.js";
import { TestReportError } from "../shu/test-report/shape.js";
import { resolveProductCode } from "../verbs/pr_ready.js";
import { assertInsideRepo } from "./check.js";
import { InventoryReadError, loadInventory, type LoadedInventory } from "./diff.js";
import { citationsIn, markersIn, proseLines, requirementOf, type Citation } from "./lines.js";
import { matchFolder, type SpecLayout } from "./layout.js";

const foldAsciiCase = (value: string): string => value.replace(/[A-Z]/g, (char): string => char.toLowerCase());

export const SPEC_COVERAGE_CONTRACT = "nen.spec.coverage/v0.1";

export type CoverageVerdict = "measured" | "partial" | "accounted" | "unaccounted" | "could-not-read";

export interface Ratio {
  readonly covered: number;
  readonly total: number | null;
  /** covered/total as a percentage to one decimal; null when the total is unknown or zero. */
  readonly percent: number | null;
}

const ratio = (covered: number, total: number | null): Ratio => ({ covered, total, percent: total === null || total === 0 ? null : Math.round((covered / total) * 1000) / 10 });

export interface MemberCoverage {
  readonly file: string;
  readonly origin: string | null;
  readonly code: string | null;
  readonly sha: string | null;
  readonly reason: string | null;
  readonly kinds: readonly ({ readonly kind: string } & Ratio)[];
  readonly traceability: {
    readonly requirementsCited: Ratio;
    readonly requirementsTested: Ratio;
    readonly requirementsTasked: Ratio;
    readonly testsCited: Ratio;
    readonly tasksTraced: Ratio;
  } | null;
}

export interface FolderMarkers {
  readonly folder: string;
  readonly clarification: number;
  readonly ruling: number;
  readonly unverified: number;
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE (capture form). */
export interface CaptureCoverageReport {
  readonly contract: string;
  readonly form: "capture";
  readonly verdict: CoverageVerdict;
  readonly repo: string;
  readonly layout: string;
  readonly folders: readonly string[];
  readonly members: readonly MemberCoverage[];
  readonly markers: readonly FolderMarkers[];
  readonly reason: string | null;
}

interface FolderText {
  readonly folder: string;
  readonly spec: string | null;
  readonly tasks: string | null;
}

function readFolders(repo: string, layout: SpecLayout): FolderText[] {
  const root = join(repo, layout.root);
  if (!existsSync(root)) throw new InventoryReadError(`${layout.root}/ does not exist under --repo; a spec root that is missing is refused rather than read as covering nothing`);
  const out: FolderText[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b): number => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || matchFolder(layout, entry.name) === null) continue;
    const folder = `${layout.root}/${entry.name}`;
    const read = (name: string): string | null => {
      const path = join(repo, folder, name);
      if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return null;
      assertInsideRepo(repo, path, `${folder}/${name}`);
      return readFileSync(path, "utf8");
    };
    out.push({ folder, spec: read("spec.md"), tasks: read("tasks.md") });
  }
  return out;
}

/** The code a registry maps to `origin`, or null with the reason. */
export function codeFor(registry: RepoRegistry, origin: string): { code: string | null; reason: string | null } {
  const codes = [...new Set([...Object.keys(registry.productCodes).filter((code): boolean => !code.startsWith("$")), ...registry.consumers.map((consumer): string | null => consumer.code).filter((code): code is string => code !== null)])];
  const hits = codes.filter((code): boolean => {
    try {
      const slug = resolveProductCode(code, registry, { explicitForm: (bare): string => `a full 'owner/${bare}' slug` });
      return foldAsciiCase(`${slug.owner}/${slug.repo}`) === foldAsciiCase(origin);
    } catch {
      return false;
    }
  });
  const distinct = [...new Set(hits.map((code): string => code.toUpperCase()))];
  if (distinct.length === 1) return { code: hits[0] as string, reason: null };
  if (distinct.length === 0) return { code: null, reason: `no product code in the spec repository's nen/repos.json resolves to ${origin}` };
  return { code: null, reason: `${distinct.length} product codes resolve to ${origin} (${hits.join(", ")}); nen will not pick one` };
}

const overlaps = (citation: Citation, path: string, lines: readonly [number, number]): boolean => citation.path === path && citation.l1 <= lines[1] && lines[0] <= citation.l2;

export function captureCoverage(repo: string, layout: SpecLayout, registry: RepoRegistry | null, registryError: string | null, inventoryFiles: readonly string[]): CaptureCoverageReport {
  const head = (verdict: CoverageVerdict): Pick<CaptureCoverageReport, "contract" | "form" | "verdict" | "repo" | "layout"> => ({ contract: SPEC_COVERAGE_CONTRACT, form: "capture" as const, verdict, repo, layout: layout.pattern });
  let folders: FolderText[];
  try {
    folders = readFolders(repo, layout);
  } catch (error) {
    if (error instanceof InventoryReadError) return { ...head("could-not-read"), folders: [], members: [], markers: [], reason: error.message };
    throw error;
  }
  const unreadable = folders.filter((folder): boolean => folder.spec === null).map((folder): string => folder.folder);
  if (unreadable.length > 0) return { ...head("could-not-read"), folders: folders.map((folder): string => folder.folder), members: [], markers: [], reason: `${unreadable.join(", ")} carr${unreadable.length === 1 ? "ies" : "y"} no spec.md; coverage over a folder nen cannot read is not measured` };

  // Every requirement and every task, per folder.
  interface Req { readonly key: string; readonly citations: readonly Citation[] }
  const requirements: Req[] = [];
  const tasks: { folder: string; ids: string[] }[] = [];
  const markers: FolderMarkers[] = [];
  for (const folder of folders) {
    const counts = { clarification: 0, ruling: 0, unverified: 0 };
    for (const line of proseLines(folder.spec as string)) {
      for (const marker of markersIn(line.text)) {
        if (marker.kind === "needs-clarification") counts.clarification += 1;
        else if (marker.kind === "needs-ruling") counts.ruling += 1;
        else counts.unverified += 1;
      }
      const requirement = requirementOf(line.text);
      if (requirement === null || requirement.kind === "US") continue;
      requirements.push({ key: `${folder.folder}#${requirement.id}`, citations: citationsIn(line.text).map((entry): Citation | null => entry.citation).filter((citation): citation is Citation => citation !== null) });
    }
    markers.push({ folder: folder.folder, ...counts });
    if (folder.tasks !== null) {
      for (const line of proseLines(folder.tasks)) {
        if (!/^\s*[-*]\s+\[[ xX]\]\s/.test(line.text)) continue;
        tasks.push({ folder: folder.folder, ids: [...line.text.matchAll(/\b(?:FR|SC)-\d+\b/g)].map((match): string => `${folder.folder}#${match[0]}`) });
      }
    }
  }
  const requirementKeys = new Set(requirements.map((requirement): string => requirement.key));
  const tasked = new Set(tasks.flatMap((task): string[] => task.ids));

  const members: MemberCoverage[] = [];
  let partial = false;
  for (const file of inventoryFiles) {
    let inventory: LoadedInventory;
    let rawTotals: { kind: string; total: number | null }[] = [];
    try {
      inventory = loadInventory(file);
      const doc = JSON.parse(readFileSync(file, "utf8")) as { totals?: unknown };
      rawTotals = Array.isArray(doc.totals) ? (doc.totals as { kind: string; total: number | null }[]).filter((entry): boolean => typeof entry?.kind === "string") : [];
    } catch (error) {
      if (!(error instanceof InventoryReadError)) throw error;
      members.push({ file, origin: null, code: null, sha: null, reason: error.message, kinds: [], traceability: null });
      partial = true;
      continue;
    }
    const resolved = inventory.origin === null ? { code: null, reason: `${file} names no origin` } : registry === null ? { code: null, reason: registryError ?? "no registry" } : codeFor(registry, inventory.origin);
    if (resolved.code === null) partial = true;
    const mine = (citations: readonly Citation[]): Citation[] => (resolved.code === null ? [] : citations.filter((citation): boolean => foldAsciiCase(citation.code) === foldAsciiCase(resolved.code as string)));
    const allCitations = requirements.flatMap((requirement): Citation[] => mine(requirement.citations));
    const kinds = rawTotals.map((total): { kind: string } & Ratio => {
      const rows = inventory.rows.filter((row): boolean => row.kind === total.kind);
      const covered = rows.filter((row): boolean => allCitations.some((citation): boolean => overlaps(citation, row.path, row.lines))).length;
      return { kind: total.kind, ...ratio(covered, total.total === null ? null : rows.length) };
    });
    const tests = inventory.rows.filter((row): boolean => row.kind === "test");
    const cited = requirements.filter((requirement): boolean => mine(requirement.citations).length > 0);
    const tested = requirements.filter((requirement): boolean => mine(requirement.citations).some((citation): boolean => tests.some((row): boolean => overlaps(citation, row.path, row.lines))));
    members.push({
      file,
      origin: inventory.origin,
      code: resolved.code,
      sha: inventory.sha,
      reason: resolved.reason,
      kinds,
      traceability: {
        requirementsCited: ratio(cited.length, requirements.length),
        requirementsTested: ratio(tested.length, requirements.length),
        requirementsTasked: ratio(requirements.filter((requirement): boolean => tasked.has(requirement.key)).length, requirements.length),
        testsCited: ratio(tests.filter((row): boolean => allCitations.some((citation): boolean => overlaps(citation, row.path, row.lines))).length, tests.length),
        tasksTraced: ratio(tasks.filter((task): boolean => task.ids.length > 0 && task.ids.every((id): boolean => requirementKeys.has(id))).length, tasks.length),
      },
    });
  }
  return { ...head(partial ? "partial" : "measured"), folders: folders.map((folder): string => folder.folder), members, markers, reason: null };
}

const pct = (value: Ratio): string => `${value.covered}/${value.total ?? "unknown"}${value.percent === null ? "" : ` (${value.percent}%)`}`;

export function renderCaptureCoverage(report: CaptureCoverageReport): string[] {
  if (report.verdict === "could-not-read") return [`could-not-read: ${report.reason ?? ""}`];
  const lines = [`${report.verdict}: ${report.folders.length} folder(s) under ${report.layout}, ${report.members.length} member inventor${report.members.length === 1 ? "y" : "ies"}`];
  for (const member of report.members) {
    lines.push(`  ${member.code ?? "(no code)"} ${member.origin ?? member.file}${member.sha === null ? "" : ` @ ${member.sha.slice(0, 12)}`}${member.reason === null ? "" : ` -- ${member.reason}`}`);
    if (member.kinds.length > 0) lines.push(`    kinds: ${member.kinds.map((kind): string => `${kind.kind} ${pct(kind)}`).join(" · ")}`);
    const trace = member.traceability;
    if (trace !== null) lines.push(`    requirements cited ${pct(trace.requirementsCited)} · tested ${pct(trace.requirementsTested)} · tasked ${pct(trace.requirementsTasked)} · tests cited ${pct(trace.testsCited)} · tasks traced ${pct(trace.tasksTraced)}`);
  }
  for (const folder of report.markers) lines.push(`  ${folder.folder}: ${folder.clarification} clarification · ${folder.ruling} ruling · ${folder.unverified} unverified open`);
  return lines;
}

// ---------------------------------------------------------------- delivery form

export type CriterionVerdict = "satisfied" | "satisfied-unverified" | "test-not-found" | "test-failing" | "deferred" | "deferred-incomplete" | "unaccounted" | "duplicate" | "malformed";
const ACCOUNTED: ReadonlySet<CriterionVerdict> = new Set(["satisfied", "satisfied-unverified", "deferred"]);
export type SectionState = "present" | "missing" | "empty";

export interface CriterionRow {
  readonly id: string;
  readonly verdict: CriterionVerdict;
  readonly test: string | null;
  readonly reason: string | null;
  readonly followUp: string | null;
  readonly line: number | null;
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE (delivery form). */
export interface DeliveryCoverageReport {
  readonly contract: string;
  readonly form: "delivery";
  readonly verdict: CoverageVerdict;
  readonly issueBody: string;
  readonly prBody: string;
  readonly testReport: string | null;
  readonly section: SectionState;
  readonly criteria: readonly CriterionRow[];
  /** Ids the PR's section names that the issue does not carry: refused, exit 2. */
  readonly outside: readonly string[];
  readonly counts: { readonly total: number; readonly accounted: number; readonly unaccounted: number };
  readonly reason: string | null;
}

/**
 * The `nen pr body-check --requirements-from` row for a PR body's Spec
 * section (zheref/nen#493 AC-12): the heading, a glyph before `Spec` allowed,
 * then -- past blank lines only -- at least one criterion row. A missing
 * section and an empty one both fail it. It proves the section is there and
 * not empty; `spec coverage --issue-body --pr-body` proves every criterion is
 * accounted for. docs/USAGE.md quotes it verbatim, held by coverage.test.ts.
 */
export const SPEC_SECTION_REQUIREMENT = {
  name: "spec-rows",
  pattern: "^ {0,3}##[ \\t]+(?:[^A-Za-z0-9#\\r\\n]+[ \\t]*)?Spec[ \\t]*\\r?\\n(?:[ \\t]*\\r?\\n)*[ \\t]*(?:[-*+][ \\t]+)?F\\d{3}-SC-\\d{3}[ \\t]+[—–-]",
} as const;

const SC_ID = /\bF\d{3}-SC-\d{3}\b/g;
const SECTION_HEADING = /^(#{1,6})\s+(?:\S+\s+)?Spec\s*#*\s*$/;
const ROW = /^\s*(?:[-*+]\s+)?(F\d{3}-SC-\d{3})\s+[—–-]{1,2}\s+(satisfied|deferred)\s+[—–-]{1,2}\s+(.+?)\s*$/;
const FOLLOW_UP = /^(?:[A-Z][A-Z0-9]{1,7}-(?:IS|PR)-#\d+|[A-Z][A-Z0-9]{1,7}#\d+|[A-Za-z0-9-]+\/[A-Za-z0-9._-]+#\d+|\[[^\]]+\]\([^)\s]+\))$/;

/** The `## Spec` section's prose lines (fences skipped), or null when the body has no such heading. */
export function specSection(body: string): { line: number; text: string }[] | null {
  const lines = proseLines(body);
  const start = lines.findIndex((line): boolean => SECTION_HEADING.test(line.text));
  if (start === -1) return null;
  const level = ((SECTION_HEADING.exec((lines[start] as { text: string }).text) as RegExpExecArray)[1] as string).length;
  const out: { line: number; text: string }[] = [];
  for (const line of lines.slice(start + 1)) {
    const heading = /^(#{1,6})\s/.exec(line.text);
    if (heading !== null && (heading[1] as string).length <= level) break;
    out.push({ line: line.number, text: line.text });
  }
  return out;
}

export function deliveryCoverage(input: { issueBodyFile: string; issueBody: string; prBodyFile: string; prBody: string; testReportFile: string | null; testReport: ParsedReport | null }): DeliveryCoverageReport {
  const issueIds = [...new Set([...input.issueBody.matchAll(SC_ID)].map((match): string => match[0]))];
  const section = specSection(input.prBody);
  const head = (verdict: CoverageVerdict): Pick<DeliveryCoverageReport, "contract" | "form" | "verdict" | "issueBody" | "prBody" | "testReport"> => ({ contract: SPEC_COVERAGE_CONTRACT, form: "delivery" as const, verdict, issueBody: input.issueBodyFile, prBody: input.prBodyFile, testReport: input.testReportFile });
  const rows = new Map<string, CriterionRow[]>();
  const outside = new Set<string>();
  const malformed: CriterionRow[] = [];
  for (const line of section ?? []) {
    const ids = [...line.text.matchAll(SC_ID)].map((match): string => match[0]);
    if (ids.length === 0) continue;
    for (const id of ids) if (!issueIds.includes(id)) outside.add(id);
    const match = ROW.exec(line.text);
    if (match === null || ids.length !== 1) {
      for (const id of ids) if (issueIds.includes(id)) malformed.push({ id, verdict: "malformed", test: null, reason: `not '${id} — satisfied — test <test id>' or '${id} — deferred — <reason> · <follow-up>'`, followUp: null, line: line.line });
      continue;
    }
    const id = match[1] as string;
    if (!issueIds.includes(id)) continue;
    const rest = match[3] as string;
    let row: CriterionRow;
    if (match[2] === "satisfied") {
      const test = /^test\s+(\S.*)$/.exec(rest)?.[1]?.replace(/^`|`$/g, "") ?? null;
      if (test === null) row = { id, verdict: "malformed", test: null, reason: "a satisfied row names its test: '— satisfied — test <test id>'", followUp: null, line: line.line };
      else if (input.testReport === null) row = { id, verdict: "satisfied-unverified", test, reason: null, followUp: null, line: line.line };
      else {
        const hits = input.testReport.parsed.tests.filter((entry): boolean => entry.name === test || (entry.suite !== null && (`${entry.suite}.${entry.name}` === test || `${entry.suite}/${entry.name}` === test || `${entry.suite}::${entry.name}` === test)));
        row = hits.length === 0
          ? { id, verdict: "test-not-found", test, reason: `no test named '${test}' in ${input.testReportFile ?? "the report"}`, followUp: null, line: line.line }
          : hits.some((entry): boolean => entry.status !== "passed")
            ? { id, verdict: "test-failing", test, reason: `'${test}' is ${hits.map((entry): string => entry.status).join("/")} in the report`, followUp: null, line: line.line }
            : { id, verdict: "satisfied", test, reason: null, followUp: null, line: line.line };
      }
    } else {
      const split = rest.lastIndexOf(" · ");
      const reason = split === -1 ? rest.trim() : rest.slice(0, split).trim();
      const followUp = split === -1 ? null : rest.slice(split + 3).trim();
      row = reason === "" || followUp === null || !FOLLOW_UP.test(followUp)
        ? { id, verdict: "deferred-incomplete", test: null, reason: `a deferred row carries a reason and a follow-up object ('<reason> · <CODE>#<n>'); read reason ${JSON.stringify(reason)}, follow-up ${JSON.stringify(followUp)}`, followUp, line: line.line }
        : { id, verdict: "deferred", test: null, reason, followUp, line: line.line };
    }
    rows.set(id, [...(rows.get(id) ?? []), row]);
  }
  const criteria: CriterionRow[] = issueIds.map((id): CriterionRow => {
    const found = rows.get(id) ?? [];
    if (found.length > 1) return { id, verdict: "duplicate", test: null, reason: `${found.length} rows account for ${id} (lines ${found.map((row): number | null => row.line).join(", ")}); one row per criterion`, followUp: null, line: found[0]?.line ?? null };
    if (found.length === 1) return found[0] as CriterionRow;
    const broken = malformed.find((row): boolean => row.id === id);
    return broken ?? { id, verdict: "unaccounted", test: null, reason: `the Spec section has no row for ${id}`, followUp: null, line: null };
  });
  const accounted = criteria.filter((row): boolean => ACCOUNTED.has(row.verdict)).length;
  const sectionState: SectionState = section === null ? "missing" : section.some((line): boolean => line.text.trim() !== "") ? "present" : "empty";
  let reason: string | null = null;
  if (issueIds.length === 0) reason = `${input.issueBodyFile} carries no F<nnn>-SC-### id; a coverage check with nothing to account for reports nothing, never success`;
  else if (sectionState === "missing") reason = `${input.prBodyFile} has no '## Spec' section`;
  else if (sectionState === "empty") reason = `${input.prBodyFile}'s '## Spec' section is empty`;
  const ok = issueIds.length > 0 && sectionState === "present" && accounted === criteria.length && outside.size === 0;
  return { ...head(ok ? "accounted" : "unaccounted"), section: sectionState, criteria, outside: [...outside].sort(), counts: { total: criteria.length, accounted, unaccounted: criteria.length - accounted }, reason };
}

export function unreadableDelivery(input: { issueBodyFile: string; prBodyFile: string; testReportFile: string | null }, reason: string): DeliveryCoverageReport {
  return { contract: SPEC_COVERAGE_CONTRACT, form: "delivery", verdict: "could-not-read", issueBody: input.issueBodyFile, prBody: input.prBodyFile, testReport: input.testReportFile, section: "missing", criteria: [], outside: [], counts: { total: 0, accounted: 0, unaccounted: 0 }, reason };
}

/** A test report read through `shu test-report`'s parsers; null with the reason when it cannot be. */
export function readReport(absolute: string, display: string): { report: ParsedReport | null; reason: string | null } {
  try {
    return { report: readTestReport(absolute, display), reason: null };
  } catch (error) {
    if (error instanceof TestReportError) return { report: null, reason: error.message };
    throw error;
  }
}

export function renderDeliveryCoverage(report: DeliveryCoverageReport): string[] {
  if (report.verdict === "could-not-read") return [`could-not-read: ${report.reason ?? ""}`];
  const lines = [`${report.verdict}: ${report.counts.accounted}/${report.counts.total} success criteria accounted for · Spec section ${report.section}${report.testReport === null ? " · no test report (satisfied rows unverified)" : ""}`];
  if (report.reason !== null) lines.push(`  ${report.reason}`);
  for (const row of report.criteria) lines.push(`  ${row.id} ${row.verdict}${row.test === null ? "" : ` -- test ${row.test}`}${row.followUp === null || row.verdict !== "deferred" ? "" : ` -- ${row.reason ?? ""} · ${row.followUp}`}${row.reason === null || row.verdict === "deferred" ? "" : ` -- ${row.reason}`}`);
  for (const id of report.outside) lines.push(`  ${id} outside -- the issue does not carry this id`);
  return lines;
}
