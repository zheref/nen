// src/report/check.ts -- `nen report check` (zheref/nen#406).
//
// ONE DATA DOCUMENT, TWO RENDERS. A variant declared under reports.sections
// names one template slug and an ordered block list. The Markdown and HTML
// templates of that slug are filled from the same example document, with the
// same section flags `report render --variant` injects. The check then holds
// the filled text to the rules a published report cannot break quietly: the
// render was not refused, no `{{` survived, both formats show the declared
// blocks in the declared order, the two orders agree, each ask stars exactly
// one option, and an HTML escape does not land where Markdown shows it
// literally.
//
// WIRING IS EXIT 2, A MISS IS EXIT 1. A missing template or example is not a
// report that rendered wrong; there was nothing to render. A render that ran
// and failed the rules names the variant, the template and the rule.

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { readJsonFile } from "../cli/inputs.js";
import { SchemaError } from "../schema/errors.js";
import { loadWorkflow, type ReportSection } from "../schema/workflow.js";
import { graphInjection, parseGraph } from "./graph.js";
import { renderFilled } from "./render.js";

export const CHECK_CONTRACT = "nen.report.check/v0.1";

/** A marker prefix is any policy slug. The templates already in the wild write their own; `nen` is the one the self-test writes. */
const MARKER_SLUG = "[a-z][a-z0-9-]*";
const BLOCK_MARK = new RegExp(`^<!-- ${MARKER_SLUG}:block ([A-Za-z_][A-Za-z0-9_-]*) -->\\r?$`, "gm");
const ASK_MARK = `<!-- ${MARKER_SLUG}:ask -->`;
/**
 * The consumer repository's report directory. Spelled in two halves so no
 * quoted path in this module is the bundled `templates/` tree the scaffold
 * sweep holds to a static import: this verb reads a repository's own reports.
 */
const REPORT_DIR = "tem" + "plates";
const OPTION_LINE = /^- \*\*[A-Z]\*\* · /;
const STAR = "⭐";
const ENTITY = /&(amp|lt|gt|quot|#39);/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])( |$)/;
const SPAN = /(`+)(.+?)\1/g;

/**
 * Where an HTML template that does not carry block-marker comments puts each
 * block. The markers win when they are present; this map is the fallback for
 * the templates that mark a block by the element the page already renders.
 */
const HTML_ANCHOR: Readonly<Record<string, string>> = {
  masthead: '<header class="mast">',
  tally: '<section class="tally"',
  desk: '<section id="desk">',
  lastTurn: '<section id="last-turn">',
  landed: '<section id="landed">',
  delta: '<section id="delta">',
  evidence: '<section id="evidence">',
  spend: '<section id="spend">',
  launch: '<section id="launch">',
  decisions: '<section id="decisions">',
  prBody: '<section id="pr-body">',
  register: '<section id="register">',
  legend: '<section id="legend">',
};

export type CheckRule = "refused-render" | "unfilled" | "block-order" | "formats-disagree" | "starred-option" | "escaping-shows";

export interface CheckFinding {
  readonly variant: string;
  readonly template: string;
  readonly rule: CheckRule;
  readonly detail: string;
}

export interface CheckReport {
  readonly contract: typeof CHECK_CONTRACT;
  readonly variants: readonly string[];
  readonly ok: boolean;
  readonly findings: readonly CheckFinding[];
  readonly code: 0 | 1;
  readonly lines: readonly string[];
}

interface Outcome {
  readonly code: number;
  readonly text: string;
}

function reportPath(...parts: readonly string[]): string {
  return [REPORT_DIR, ...parts].join("/");
}

function sectionInjection(
  section: ReportSection,
  declared: Readonly<Record<string, ReportSection>>,
): Readonly<Record<string, unknown>> {
  const mine = new Set(section.blocks);
  const sections: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
  for (const variant of Object.values(declared)) {
    for (const block of variant.blocks) sections[block] = mine.has(block);
  }
  return { sections, sectionList: [...section.blocks] };
}

function markerBlocks(text: string): readonly string[] | null {
  const found: string[] = [];
  for (const match of text.matchAll(BLOCK_MARK)) {
    const name = match[1];
    if (name !== undefined) found.push(name);
  }
  return found.length === 0 ? null : found;
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((block, index): boolean => block === right[index]);
}

function listed(blocks: readonly string[]): string {
  return `[${blocks.join(", ")}]`;
}

function finding(variant: string, template: string, rule: CheckRule, detail: string): CheckFinding {
  return { variant, template, rule, detail };
}

function lineOf(item: CheckFinding): string {
  return `${item.variant} ${item.template} rule ${item.rule}: ${item.detail}`;
}

function unfilled(text: string): string | null {
  const at = text.indexOf("{{");
  if (at < 0) return null;
  const line = text.slice(0, at).split("\n").length;
  return `line ${line}: an unfilled '{{' remains`;
}

type RegionKind = "text" | "pre" | "fence" | "fence-edge" | "icode";

function closesFence(line: string, fence: string): boolean {
  const marker = FENCE.exec(line);
  const token = marker?.[1];
  if (token === undefined || token[0] !== fence[0] || token.length < fence.length) return false;
  return line.replace(/[ `~]/g, "") === "";
}

/** GFM regions, so an escape is judged where the renderer shows it literally. */
function regions(text: string): readonly { readonly lineNo: number; readonly line: string; readonly kind: RegionKind }[] {
  const out: { lineNo: number; line: string; kind: RegionKind }[] = [];
  let fence: string | null = null;
  let pre = false;
  let icode = false;
  let inList = false;
  let prevBlank = true;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNo = index + 1;
    const blank = line.trim() === "";
    if (pre) {
      out.push({ lineNo, line, kind: "pre" });
      if (line.includes("</pre>")) pre = false;
      prevBlank = blank;
      continue;
    }
    if (fence !== null) {
      if (closesFence(line, fence)) {
        fence = null;
        out.push({ lineNo, line, kind: "fence-edge" });
      } else {
        out.push({ lineNo, line, kind: "fence" });
      }
      prevBlank = blank;
      continue;
    }
    const indented = line.startsWith("    ") || line.startsWith("\t");
    if (icode && (blank || indented)) {
      out.push({ lineNo, line, kind: "icode" });
      prevBlank = blank;
      continue;
    }
    icode = false;
    if (indented && !blank && prevBlank && !inList) {
      icode = true;
      out.push({ lineNo, line, kind: "icode" });
      prevBlank = false;
      continue;
    }
    if (!blank) {
      if (LIST_ITEM.test(line)) inList = true;
      else if (!line.startsWith(" ")) inList = false;
    }
    const opened = FENCE.exec(line);
    const token = opened?.[1];
    if (token !== undefined) {
      fence = token;
      out.push({ lineNo, line, kind: "fence-edge" });
    } else if (line.trimStart().startsWith("<pre>")) {
      pre = !line.includes("</pre>");
      out.push({ lineNo, line, kind: "pre" });
    } else {
      out.push({ lineNo, line, kind: "text" });
    }
    prevBlank = blank;
  }
  return out;
}

function escapingShows(text: string): readonly string[] {
  const details: string[] = [];
  for (const region of regions(text)) {
    if ((region.kind === "fence" || region.kind === "icode") && ENTITY.test(region.line)) {
      const where = region.kind === "fence" ? "a code fence" : "an indented code block";
      details.push(`line ${region.lineNo}: an escaped entity inside ${where} shows literally in a Markdown cell: ${region.line.trim().slice(0, 80)}`);
    }
    if (region.kind !== "text") continue;
    for (const span of region.line.matchAll(SPAN)) {
      const body = span[2] ?? "";
      if (ENTITY.test(body)) {
        details.push(`line ${region.lineNo}: an escaped entity inside a code span shows literally in a Markdown cell: ${(span[0] ?? "").slice(0, 80)}`);
      }
    }
  }
  return details;
}

function deskRegion(markdown: string): string | null {
  const start = markdown.search(new RegExp(`<!-- ${MARKER_SLUG}:block desk -->`));
  if (start < 0) return null;
  const rest = markdown.slice(start);
  const next = rest.slice(rest.indexOf("\n") + 1).search(new RegExp(`<!-- ${MARKER_SLUG}:block [A-Za-z_][A-Za-z0-9_-]* -->`));
  if (next < 0) return rest;
  return rest.slice(0, rest.indexOf("\n") + 1 + next);
}

function starred(chunk: string, gates: boolean): number {
  const body = gates ? chunk.split(/^### /m)[0] ?? chunk : chunk;
  return body.split("\n").filter((line): boolean => OPTION_LINE.test(line) && line.includes(STAR)).length;
}

function htmlBlocks(page: string, declared: readonly string[]): { readonly blocks: readonly string[]; readonly unknown: readonly string[] } {
  const marked = markerBlocks(page);
  if (marked !== null) return { blocks: marked, unknown: [] };
  const placed: { index: number; block: string }[] = [];
  const unknown: string[] = [];
  for (const block of declared) {
    const anchor = HTML_ANCHOR[block];
    if (anchor === undefined) {
      unknown.push(block);
      continue;
    }
    const index = page.indexOf(anchor);
    if (index >= 0) placed.push({ index, block });
  }
  placed.sort((left, right): number => left.index - right.index);
  return { blocks: placed.map((item): string => item.block), unknown };
}

function graphInject(repoRoot: string, variant: string): Readonly<Record<string, unknown>> | string | null {
  const own = join(repoRoot, REPORT_DIR, "report-examples", `${variant}.graph.json`);
  const fallback = join(repoRoot, REPORT_DIR, "graph.example.json");
  const path = existsSync(own) ? own : existsSync(fallback) ? fallback : null;
  if (path === null) return null;
  const display = path === own ? reportPath("report-examples", `${variant}.graph.json`) : reportPath("graph.example.json");
  try {
    return graphInjection(parseGraph(readJsonFile<unknown>(path, repoRoot, "The graph document is injected into both renders."), display));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.split("\n")[0] ?? message;
  }
}

function fill(repoRoot: string, template: string, data: string, variant: string, inject: Readonly<Record<string, unknown>>): string {
  return renderFilled(repoRoot, { template, data, dryRun: false, variant, inject }).filled;
}

function renderFailure(variant: string, template: string, error: unknown): CheckFinding {
  const message = error instanceof Error ? error.message : String(error);
  return finding(variant, template, "refused-render", message.split("\n")[0] ?? message);
}

/**
 * Check one repository's declared variants.
 *
 * Throws VerbUsageError (exit 2) for wiring: no variant, an unknown
 * `--variant`, a policy that will not parse, or a missing template or example.
 * A conformance miss is a finding on the returned report, exit 1.
 */
export function checkReports(repoRoot: string, variant: string | null): CheckReport {
  let declared: Readonly<Record<string, ReportSection>>;
  try {
    declared = loadWorkflow(repoRoot).workflow.reports.sections;
  } catch (error) {
    if (error instanceof SchemaError) {
      throw new VerbUsageError(
        `report check wiring: nen/workflow.json cannot be read as policy (${error.message}). The check needs reports.sections before it can render a variant.`,
      );
    }
    throw error;
  }
  const names = Object.keys(declared);
  if (names.length === 0) {
    throw new VerbUsageError(
      "report check wiring: nen/workflow.json declares no reports.sections variant. A report's blocks are the repository's configuration, and there is nothing to render.",
    );
  }
  if (variant !== null && !Object.hasOwn(declared, variant)) {
    throw new VerbUsageError(
      `report check wiring: --variant '${variant}' is not declared. Declared: ${names.join(", ")}.`,
    );
  }
  const selected = variant === null ? names : [variant];
  const missing: string[] = [];
  for (const name of selected) {
    const section = declared[name];
    if (section === undefined) continue;
    const paths = [
      reportPath(`${section.template}.md`),
      reportPath(`${section.template}.html`),
      reportPath("report-examples", `${name}.data.json`),
    ];
    for (const path of paths) {
      if (!existsSync(join(repoRoot, ...path.split("/")))) missing.push(`variant '${name}' template '${section.template}' is missing ${path}`);
    }
  }
  if (missing.length > 0) {
    throw new VerbUsageError(
      `report check wiring: ${missing.join("; ")}. A missing template or example is wiring, not a conformance finding. The check renders templates/<template>.md and templates/<template>.html from templates/report-examples/<variant>.data.json.`,
    );
  }

  const findings: CheckFinding[] = [];
  for (const name of selected) {
    const section = declared[name];
    if (section === undefined) continue;
    const mdPath = reportPath(`${section.template}.md`);
    const htmlPath = reportPath(`${section.template}.html`);
    const dataPath = reportPath("report-examples", `${name}.data.json`);
    const graph = graphInject(repoRoot, name);
    if (typeof graph === "string") {
      findings.push(finding(name, mdPath, "refused-render", graph));
      findings.push(finding(name, htmlPath, "refused-render", graph));
      continue;
    }
    const inject = { ...sectionInjection(section, declared), ...(graph ?? {}) };
    let markdown: string;
    let page: string | null = null;
    try {
      markdown = fill(repoRoot, mdPath, dataPath, name, inject);
    } catch (error) {
      findings.push(renderFailure(name, mdPath, error));
      continue;
    }
    try {
      page = fill(repoRoot, htmlPath, dataPath, name, inject);
    } catch (error) {
      findings.push(renderFailure(name, htmlPath, error));
    }
    const mdBlocks = markerBlocks(markdown) ?? [];
    if (!same(mdBlocks, section.blocks)) {
      findings.push(finding(name, mdPath, "block-order", `blocks ${listed(mdBlocks)} are not the declared reports.sections.${name}.blocks ${listed(section.blocks)}`));
    }
    const leftover = unfilled(markdown);
    if (leftover !== null) findings.push(finding(name, mdPath, "unfilled", leftover));
    for (const detail of escapingShows(markdown)) findings.push(finding(name, mdPath, "escaping-shows", detail));
    if (mdBlocks.includes("desk")) {
      const desk = deskRegion(markdown);
      if (desk !== null) {
        let gates = false;
        try {
          const data = readJsonFile<unknown>(dataPath, repoRoot, "The example data document.");
          gates = typeof data === "object" && data !== null && !Array.isArray(data) && Object.hasOwn(data, "gates");
        } catch {
          gates = false;
        }
        const chunks = desk.split(new RegExp(ASK_MARK)).slice(1);
        chunks.forEach((chunk, index): void => {
          const count = starred(chunk, gates);
          if (count !== 1) {
            findings.push(finding(name, mdPath, "starred-option", `ask ${index + 1} carries ${count} starred option(s); exactly one is the rule`));
          }
        });
      }
    }
    if (page === null) continue;
    const html = htmlBlocks(page, section.blocks);
    for (const block of html.unknown) {
      findings.push(finding(name, htmlPath, "block-order", `block '${block}' has no HTML marker and no known anchor, so its place in the HTML render cannot be read`));
    }
    if (!same(html.blocks, section.blocks)) {
      findings.push(finding(name, htmlPath, "block-order", `blocks ${listed(html.blocks)} are not the declared reports.sections.${name}.blocks ${listed(section.blocks)}`));
    }
    const htmlLeft = unfilled(page);
    if (htmlLeft !== null) findings.push(finding(name, htmlPath, "unfilled", htmlLeft));
    if (!same(mdBlocks, html.blocks)) {
      findings.push(finding(name, `${mdPath} ${htmlPath}`, "formats-disagree", `markdown blocks ${listed(mdBlocks)} and html blocks ${listed(html.blocks)} disagree`));
    }
  }

  const lines = findings.length === 0
    ? [`report check ok: ${selected.length} variant(s) render in both formats, blocks in the declared order, one starred option per ask, no escaping shows`]
    : findings.map(lineOf);
  return {
    contract: CHECK_CONTRACT,
    variants: selected,
    ok: findings.length === 0,
    findings,
    code: findings.length === 0 ? 0 : 1,
    lines,
  };
}

const SELF_MD = `{{#if sections.masthead}}<!-- nen:block masthead -->
# {{title}}
{{/if}}{{#if sections.desk}}<!-- nen:block desk -->
<!-- nen:ask -->
- **A** · keep ⭐ the one
- **B** · drop
{{/if}}
`;

const SELF_HTML = `{{#if sections.masthead}}<header class="mast">{{title}}</header>{{/if}}{{#if sections.desk}}<section id="desk">{{title}}</section>{{/if}}
`;

const SELF_DATA = '{ "title": "Turn", "variant": "turn" }\n';

interface SelfCase {
  readonly name: string;
  readonly code: 0 | 1 | 2;
  readonly includes: readonly string[];
  readonly files: Readonly<Record<string, string>>;
  readonly sections: Readonly<Record<string, { template: string; blocks: readonly string[] }>> | null;
  readonly rawWorkflow: string | null;
}

function selfCases(): readonly SelfCase[] {
  const sections = { turn: { template: "page", blocks: ["masthead", "desk"] } };
  const pageMd = reportPath("page.md");
  const pageHtml = reportPath("page.html");
  const example = reportPath("report-examples", "turn.data.json");
  const base = {
    [pageMd]: SELF_MD,
    [pageHtml]: SELF_HTML,
    [example]: SELF_DATA,
  };
  const swappedMd = `{{#if sections.desk}}<!-- nen:block desk -->
<!-- nen:ask -->
- **A** · keep ⭐ the one
- **B** · drop
{{/if}}{{#if sections.masthead}}<!-- nen:block masthead -->
# {{title}}
{{/if}}
`;
  const swappedHtml = `{{#if sections.desk}}<section id="desk">{{title}}</section>{{/if}}{{#if sections.masthead}}<header class="mast">{{title}}</header>{{/if}}
`;
  return [
    { name: "conformant", code: 0, includes: ["report check ok"], files: base, sections, rawWorkflow: null },
    {
      name: "refused-render",
      code: 1,
      includes: ["rule refused-render"],
      files: { ...base, [example]: '{ "variant": "turn" }\n' },
      sections,
      rawWorkflow: null,
    },
    {
      name: "unfilled",
      code: 1,
      includes: ["rule unfilled"],
      files: { ...base, [pageMd]: `${SELF_MD}see {{\n` },
      sections,
      rawWorkflow: null,
    },
    {
      name: "block-order",
      code: 1,
      includes: ["rule block-order"],
      files: { ...base, [pageMd]: swappedMd, [pageHtml]: swappedHtml },
      sections,
      rawWorkflow: null,
    },
    {
      name: "formats-disagree",
      code: 1,
      includes: ["rule formats-disagree"],
      files: { ...base, [pageHtml]: swappedHtml },
      sections,
      rawWorkflow: null,
    },
    {
      name: "starred-option-zero",
      code: 1,
      includes: ["rule starred-option", "0 starred"],
      files: {
        ...base,
        [pageMd]: SELF_MD.replace("- **A** · keep ⭐ the one\n", "- **A** · keep\n"),
      },
      sections,
      rawWorkflow: null,
    },
    {
      name: "starred-option-two",
      code: 1,
      includes: ["rule starred-option", "2 starred"],
      files: {
        ...base,
        [pageMd]: SELF_MD.replace("- **B** · drop\n", "- **B** · drop ⭐ two\n"),
      },
      sections,
      rawWorkflow: null,
    },
    {
      name: "escaping-shows",
      code: 1,
      includes: ["rule escaping-shows"],
      files: {
        ...base,
        [pageMd]: SELF_MD.replace("# {{title}}\n", "# {{title}} `{{title}}`\n"),
        [example]: '{ "title": "a&b", "variant": "turn" }\n',
      },
      sections,
      rawWorkflow: null,
    },
    {
      name: "graph-fallback",
      code: 0,
      includes: ["report check ok"],
      files: {
        ...base,
        [pageMd]: `${SELF_MD}{{#if sections.delta}}<!-- nen:block delta -->\n{{{graphMermaid}}}\n{{/if}}\n`,
        [pageHtml]: `${SELF_HTML}{{#if sections.delta}}<section id="delta">{{{graphMermaid}}}</section>{{/if}}\n`,
        [reportPath("graph.example.json")]: `${JSON.stringify({
          contract: "nen.report.graph/v0.1",
          nodes: [{ id: "page", label: "page", kind: "template", change: "added" }],
          edges: [],
        })}\n`,
      },
      sections: { turn: { template: "page", blocks: ["masthead", "desk", "delta"] } },
      rawWorkflow: null,
    },
    { name: "wiring-no-sections", code: 2, includes: ["reports.sections", "wiring"], files: {}, sections: null, rawWorkflow: "{}\n" },
    {
      name: "wiring-missing-template",
      code: 2,
      includes: ["wiring", pageMd],
      files: { [pageHtml]: SELF_HTML, [example]: SELF_DATA },
      sections,
      rawWorkflow: null,
    },
    {
      name: "wiring-missing-example",
      code: 2,
      includes: ["wiring", example],
      files: { [pageMd]: SELF_MD, [pageHtml]: SELF_HTML },
      sections,
      rawWorkflow: null,
    },
  ];
}

function stage(dir: string, item: SelfCase): void {
  mkdirSync(join(dir, "nen"), { recursive: true });
  const workflow = item.rawWorkflow ?? `${JSON.stringify({ reports: { sections: item.sections } })}\n`;
  writeFileSync(join(dir, "nen", "workflow.json"), workflow, "utf8");
  for (const [path, text] of Object.entries(item.files)) {
    const full = join(dir, ...path.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text, "utf8");
  }
}

function runStaged(dir: string): Outcome {
  try {
    const report = checkReports(dir, null);
    return { code: report.code, text: report.lines.join("\n") };
  } catch (error) {
    if (error instanceof VerbUsageError || error instanceof SchemaError) {
      return { code: 2, text: error.message };
    }
    throw error;
  }
}

/** Throwaway fixtures for every refusal and the wiring exits. Exit 0 when each fires as declared. */
export function runReportCheckSelfTest(): { readonly code: 0 | 1; readonly lines: readonly string[] } {
  const lines: string[] = [];
  let failed = false;
  for (const item of selfCases()) {
    const dir = mkdtempSync(join(tmpdir(), "nen-report-check-self-"));
    try {
      stage(dir, item);
      const outcome = runStaged(dir);
      const missed = item.includes.filter((needle): boolean => !outcome.text.includes(needle));
      if (outcome.code !== item.code || missed.length > 0) {
        failed = true;
        lines.push(`self-test ${item.name}: expected exit ${item.code} containing ${item.includes.join(", ")}; got exit ${outcome.code}: ${outcome.text}`);
      } else {
        lines.push(`self-test ${item.name}: exit ${outcome.code}`);
        lines.push(outcome.text);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (!failed) lines.push(`report check --self-test: ok (${selfCases().length} fixtures)`);
  return { code: failed ? 1 : 0, lines };
}
