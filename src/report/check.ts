import layout from "./layout.json";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { emit, VerbUsageError, type CommandContext } from "../cli/command.js";
import { assertRepoRoot } from "../repo/root.js";
import { realContainment } from "../repo/contain.js";
import { loadWorkflow } from "../schema/workflow.js";
import { renderReport } from "./render.js";
import { graphInjection, parseGraph } from "./graph.js";

const same = (a: readonly string[], b: readonly string[]): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Render every declared variant, with no filesystem writes or external execution. */
export function runReportCheck(context: CommandContext): number {
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const declarations = loadWorkflow(root).workflow.reports.sections;
  const variants = context.args.values["variant"] ? [context.args.values["variant"]!] : Object.keys(declarations);
  if (!variants.length || variants.some(name => !Object.hasOwn(declarations, name))) throw new VerbUsageError("report check needs declared reports.sections variants.");
  const read = (relative: string): string => {
    const path = resolve(root, relative), checked = realContainment(root, path);
    if (!checked.contained || checked.link !== null || !existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new VerbUsageError(`report check wiring: missing, nonregular or redirected template/example ${relative}`);
    return readFileSync(path, "utf8");
  };
  const findings: { variant: string; template: string; rule: string }[] = [];
  const allBlocks = [...new Set(Object.values(declarations).flatMap(section => section.blocks))];
  for (const variant of variants) {
    const section = declarations[variant]!;
    const mdPath = `${layout.directory}/${section.template}.md`, htmlPath = `${layout.directory}/${section.template}.html`;
    const mdTemplate = read(mdPath), htmlTemplate = read(htmlPath), example = read(`${layout.examples}/${variant}.data.json`);
    const finding = (template: string, rule: string): void => { findings.push({ variant, template, rule }); };
    let data: Record<string, unknown>;
    try { const raw: unknown = JSON.parse(example); if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("example is not an object"); data = raw as Record<string, unknown>; }
    catch (error) { finding(mdPath, `refused example: ${String(error)}`); continue; }
    const sections = Object.fromEntries(allBlocks.map(block => [block, section.blocks.includes(block)]));
    let injection: Readonly<Record<string, unknown>> = { sections, sectionList: section.blocks };
    const ownGraph = `${layout.examples}/${variant}.graph.json`;
    const graphPath = existsSync(resolve(root, ownGraph)) ? ownGraph : layout.graph;
    if (existsSync(resolve(root, graphPath))) {
      try { injection = { ...injection, ...graphInjection(parseGraph(JSON.parse(read(graphPath)) as unknown, graphPath)) }; }
      catch (error) { finding(mdPath, `refused graph: ${String(error)}`); continue; }
    }
    const rendered: Record<string, string> = {};
    for (const [path, template, language] of [[mdPath, mdTemplate, "markdown"], [htmlPath, htmlTemplate, "html"]] as const) {
      try { void template; rendered[language] = renderReport(root, { template: path, data: `${layout.examples}/${variant}.data.json`, out: "-", dryRun: false, language, variant, inject: injection }).content!; }
      catch (error) { finding(path, `refused render: ${String(error)}`); }
    }
    const md = rendered["markdown"], html = rendered["html"];
    if (md === undefined || html === undefined) continue;
    for (const [path, text] of [[mdPath, md], [htmlPath, html]]) if (text!.includes("{{")) finding(path!, "unfilled token survives");
    const blocks = [...md.matchAll(/^<!-- [A-Za-z0-9_-]+:block ([A-Za-z0-9_-]+) -->$/gm)].map(match => match[1]!);
    if (!same(blocks, section.blocks)) finding(mdPath, `block sequence ${JSON.stringify(blocks)} differs from declared ${JSON.stringify(section.blocks)}`);
    const htmlBlocks = [...html.matchAll(/<(header|section)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)].flatMap(match => {
      const attributes = Object.fromEntries([...match[2]!.matchAll(/(?:^|\s)([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(attribute => [attribute[1]!.toLowerCase(), attribute[2] ?? attribute[3] ?? ""]));
      const classes = (attributes["class"] ?? "").split(/\s+/);
      const known = allBlocks.filter(block => {
        const id = block.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
        return block === "masthead" ? match[1] === "header" && classes.includes("mast") : block === "tally" ? classes.includes("tally") : attributes["id"] === id;
      });
      return known.length ? known : match[1] === "section" && attributes["id"] ? [`undeclared:${attributes["id"]}`] : [];
    });
    if (!same(htmlBlocks, section.blocks)) finding(htmlPath, `block sequence ${JSON.stringify(htmlBlocks)} differs from declared ${JSON.stringify(section.blocks)}`);
    if (!same(blocks, htmlBlocks)) finding(htmlPath, "HTML and Markdown block sequences disagree");
    const gates = Array.isArray(data["gates"]) ? data["gates"] as { asks?: unknown[] }[] : [];
    const expectedAsks = gates.length ? gates.reduce((n, gate) => n + (Array.isArray(gate.asks) ? gate.asks.length : 0), 0) : data["ask"] ? 1 : 0;
    const deskStart = /^<!-- [A-Za-z0-9_-]+:block desk -->$/m.exec(md);
    const deskTail = deskStart ? md.slice(deskStart.index + deskStart[0].length) : "";
    const desk = deskTail.split(/^<!-- [A-Za-z0-9_-]+:block [A-Za-z0-9_-]+ -->$/m)[0]!;
    const asks = desk.split(/<!-- [A-Za-z0-9_-]+:ask -->/).slice(1);
    if (asks.length !== expectedAsks) finding(mdPath, `desk renders ${asks.length} asks; data declares ${expectedAsks}`);
    asks.forEach((ask, index) => { const stars = ask.split("\n").filter(line => /^- \*\*[A-Z]\*\* · /.test(line) && line.includes("⭐")).length; if (stars !== 1) finding(mdPath, `ask ${index + 1} has ${stars} starred options, expected one`); });
    for (const line of md.split("\n")) {
      if (line.startsWith("|") && /&(?:amp|lt|gt|quot|#39);/.test(line)) finding(mdPath, "HTML escaping shows in a Markdown cell");
      if (/`[^`]*\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~][^`]*`/.test(line)) finding(mdPath, "escaping shows literally in a Markdown code cell");
    }
  }
  emit(context.io, context.json, { conformant: findings.length === 0, variants, findings }, findings.length ? findings.map(row => `${row.variant}: ${row.template}: ${row.rule}`) : [`report check: ${variants.length} variants conform`]);
  return findings.length ? 1 : 0;
}
