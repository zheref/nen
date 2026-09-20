// src/report/graph.ts -- the architecture-delta graph a report draws: a
// caller-written document of nodes and edges, validated, and turned into the
// four things a template can fill with.
//
// WHY NEN VALIDATES A DOCUMENT IT DOES NOT WRITE. The nodes and the edges are a
// MODEL'S account of what changed -- nen has no opinion about which modules a
// session touched and must never grow one, because that is a judgement about
// somebody else's architecture (./data.ts's `--tiers` header makes the same
// refusal). What nen CAN do is the half a model is bad at: hold the document to
// a shape, refuse an edge whose endpoint names a node nobody declared, and
// serialise it once so the page, the mermaid and the fallback list are three
// renderings of ONE validated set rather than three chances to disagree.
//
// AN EDGE TO AN UNDECLARED NODE IS REFUSED, NOT DROPPED. A dropped edge is a
// relationship the reader never learns was claimed: the diagram renders, looks
// finished, and is missing the arrow that was the point of drawing it. A typo
// in an id is a one-character fix if it is named at exit 2 and an invisible
// wrong answer if it is not.
//
// THE MERMAID IS DETERMINISTIC AND IN DOCUMENT ORDER. It is text that lands in
// a published report and in a pull-request body, so two runs over an unchanged
// document must produce byte-identical output -- otherwise every re-render is a
// diff. Nothing here sorts, groups or de-duplicates; the document's own order IS
// the order, which is also the order the author chose.
//
// THE FREE-TEXT FIELDS ARE HELD TO A CHARACTER SET, AND THE SERIALISER
// ESCAPES CHARACTERS RATHER THAN SEQUENCES. `label`, `caption` and `rel` are
// model-written prose that becomes mermaid source and JSON inside a `<script>`
// block -- two grammars, two ways for a character nobody thought about to stop
// being text. See `FORBIDDEN_IN_TEXT` and `serialiseGraph` for each.
//
// `<` AND `>` ARE ESCAPED IN THE SERIALISED JSON, AND THAT IS NOT DECORATION. The
// template writes `graphJson` RAW, inside `<script type="application/json">`,
// which is exactly where an HTML parser ends the element at the first `</`
// whatever the JSON says. A node label containing `</script>` -- or any `</` at
// all -- would close the block early and spill the rest of the graph into the
// page as markup. `<\/` is the one escape JSON and JavaScript both read as `</`,
// so the document round-trips and the parser never sees the sequence.

import { VerbUsageError } from "../cli/command.js";

export const GRAPH_CONTRACT = "nen.report.graph/v0.1";

/** The four words a node or an edge may say about itself. */
export const CHANGE_VALUES = ["added", "changed", "removed", "unchanged"] as const;
export type GraphChange = (typeof CHANGE_VALUES)[number];

/** A slug: an id, a kind. Lowercase, digits and single hyphens. */
const SLUG = /^[a-z][a-z0-9-]*$/;

/**
 * The characters a free-text field of this document may NEVER carry, and the
 * one place the rule lives (Feitan F3).
 *
 * `label`, `caption` and `rel` are model-written prose that becomes MERMAID
 * SOURCE, and mermaid's grammar is line-oriented: a newline inside a label
 * ends the statement and whatever follows is read as the NEXT statement, which
 * is how a `click` directive landed in a rendered diagram from a field nobody
 * thought of as code. `|` is the edge-label delimiter and ends a label early
 * the same way. U+2028 and U+2029 are line terminators to a JavaScript parser
 * even where they are not to mermaid's, so they travel with the other two.
 *
 * REFUSED AT THE BOUNDARY RATHER THAN ESCAPED AWAY, and the two are not the
 * same choice. `graphToMermaid` DOES escape `|` and `"`, because a renderer
 * that can be broken by its own input is a bug whatever the boundary does --
 * but a multi-line label is not a thing this document HAS: mermaid's own line
 * break is `<br/>`, which is the author's to write, and silently flattening a
 * newline would publish a label the author did not write. So the refusal names
 * the row and the character, at exit 2, and the author decides.
 */
const FORBIDDEN_IN_TEXT = /[\u0000-\u001F\u007F-\u009F\u2028\u2029|]/;

/** Which forbidden character a free-text field carries, named for the refusal. */
function forbiddenCharacter(text: string): string | null {
  const match = FORBIDDEN_IN_TEXT.exec(text);
  if (match === null) return null;
  const found = match[0] as string;
  if (found === "\n") return "a newline";
  if (found === "\r") return "a carriage return";
  if (found === "|") return "a '|'";
  if (found === "\u2028") return "a U+2028 line separator";
  if (found === "\u2029") return "a U+2029 paragraph separator";
  // EVERY OTHER C0/C1 CONTROL (Copilot, #221 round 3). The first cut listed
  // the two line terminators and the pipe -- the characters that break
  // MERMAID -- and left the rest of the control range through, so an ESC in a
  // label travelled into a rendered page and into any terminal that printed
  // the document. A caption is prose; a control character in it is not.
  return `the control character U+${found.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** The sentence every free-text refusal ends with, written once. */
const TEXT_REFUSAL =
  "These three fields become MERMAID SOURCE, whose grammar is line-oriented: a newline ends the statement and whatever follows is read as the next one, and '|' ends an edge label early. Mermaid's own line break is '<br/>', which is yours to write; nen will not flatten a character you typed into a label you did not";

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  /** Free slug -- module, verb, file, service, skill, agent, template, … */
  readonly kind: string;
  readonly change: GraphChange;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** A short free string; the empty string when the document states none. */
  readonly rel: string;
  readonly change: GraphChange;
}

export interface GraphDocument {
  readonly contract: string;
  /** One model-written line, or the empty string. */
  readonly caption: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

function refuse(display: string, what: string): never {
  throw new VerbUsageError(
    `'${display}': ${what}. A graph document is '{ "contract": "${GRAPH_CONTRACT}", "caption": "<one line>", "nodes": [{ "id": "<slug>", "label": "<text>", "kind": "<slug>", "change": "added|changed|removed|unchanged" }], "edges": [{ "from": "<node id>", "to": "<node id>", "rel": "<short text>", "change": "added|changed|removed|unchanged" }] }'. The nodes and the edges are yours -- nen holds them to a shape and never invents one.`,
  );
}

function requireChange(value: unknown, display: string, where: string): GraphChange {
  if (typeof value !== "string" || !(CHANGE_VALUES as readonly string[]).includes(value)) {
    refuse(display, `${where} has 'change' of ${describe(value)} -- it is one of ${CHANGE_VALUES.join(", ")}`);
  }
  return value as GraphChange;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return `a list of ${value.length}`;
  if (typeof value === "string") return `'${value}'`;
  return `a ${typeof value}`;
}

/**
 * One graph document, validated whole.
 *
 * EVERY REFUSAL IS EXIT 2 AND NAMES THE ROW. The caller wrote this file by
 * hand (or a model did); the mistakes are typos and a forgotten key, and both
 * are fixed in one edit once somebody is told which node.
 */
export function parseGraph(document: unknown, display: string): GraphDocument {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    refuse(display, `is ${describe(document)}, not a graph document`);
  }
  const raw = document as Record<string, unknown>;
  if (raw["contract"] !== GRAPH_CONTRACT) {
    refuse(
      display,
      `states contract ${describe(raw["contract"])} -- this verb reads '${GRAPH_CONTRACT}' and refuses a document that does not name it, rather than guessing at a shape somebody else's version wrote`,
    );
  }
  const captionRaw = raw["caption"];
  if (captionRaw !== undefined && captionRaw !== null && typeof captionRaw !== "string") {
    refuse(display, `has a 'caption' of ${describe(captionRaw)}, not a line of text`);
  }
  if (typeof captionRaw === "string") {
    const bad = forbiddenCharacter(captionRaw);
    if (bad !== null) refuse(display, `has a 'caption' carrying ${bad}. ${TEXT_REFUSAL}`);
  }
  const nodesRaw = raw["nodes"];
  if (!Array.isArray(nodesRaw)) refuse(display, `has 'nodes' of ${describe(nodesRaw)}, not a list`);
  const edgesRaw = raw["edges"] ?? [];
  if (!Array.isArray(edgesRaw)) refuse(display, `has 'edges' of ${describe(edgesRaw)}, not a list`);

  const ids = new Set<string>();
  const nodes = nodesRaw.map((entry, index): GraphNode => {
    const where = `node ${index}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      refuse(display, `${where} is ${describe(entry)}, not an object`);
    }
    const node = entry as Record<string, unknown>;
    const id = node["id"];
    if (typeof id !== "string" || !SLUG.test(id)) {
      refuse(display, `${where} has 'id' of ${describe(id)} -- an id is a slug ([a-z][a-z0-9-]*), because it becomes a mermaid identifier`);
    }
    if (ids.has(id)) {
      refuse(display, `${where} repeats the id '${id}'. Two nodes with one id are one node in every rendering, and the edges then point at whichever came last`);
    }
    ids.add(id);
    const label = node["label"];
    if (typeof label !== "string" || label.trim() === "") {
      refuse(display, `${where} ('${id}') has 'label' of ${describe(label)} -- a node with no label draws as an empty box`);
    }
    const badLabel = forbiddenCharacter(label);
    if (badLabel !== null) {
      refuse(display, `${where} ('${id}') has a 'label' carrying ${badLabel}. ${TEXT_REFUSAL}`);
    }
    const kind = node["kind"];
    if (typeof kind !== "string" || !SLUG.test(kind)) {
      refuse(display, `${where} ('${id}') has 'kind' of ${describe(kind)} -- a kind is a free slug ([a-z][a-z0-9-]*): module, verb, file, service, skill, agent, template, whatever this repository's own vocabulary is`);
    }
    return { id, label, kind, change: requireChange(node["change"], display, `${where} ('${id}')`) };
  });

  const edges = edgesRaw.map((entry, index): GraphEdge => {
    const where = `edge ${index}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      refuse(display, `${where} is ${describe(entry)}, not an object`);
    }
    const edge = entry as Record<string, unknown>;
    const from = edge["from"];
    const to = edge["to"];
    for (const [key, value] of [["from", from], ["to", to]] as const) {
      if (typeof value !== "string" || !ids.has(value)) {
        refuse(
          display,
          `${where} has '${key}' of ${describe(value)}, which names no declared node. An edge to a node nobody declared is refused rather than dropped: a dropped edge draws a finished-looking diagram that is missing the arrow you meant. Declared ids: ${[...ids].join(", ") || "(none)"}`,
        );
      }
    }
    const relRaw = edge["rel"];
    if (relRaw !== undefined && relRaw !== null && typeof relRaw !== "string") {
      refuse(display, `${where} has 'rel' of ${describe(relRaw)}, not a short string`);
    }
    if (typeof relRaw === "string") {
      const badRel = forbiddenCharacter(relRaw);
      if (badRel !== null) refuse(display, `${where} has a 'rel' carrying ${badRel}. ${TEXT_REFUSAL}`);
    }
    return {
      from: from as string,
      to: to as string,
      rel: typeof relRaw === "string" ? relRaw : "",
      change: requireChange(edge["change"], display, where),
    };
  });

  return {
    contract: GRAPH_CONTRACT,
    caption: typeof captionRaw === "string" ? captionRaw : "",
    nodes,
    edges,
  };
}

/**
 * The validated document as compact JSON, safe to write RAW inside a
 * `<script type="application/json">` block.
 *
 * IT ESCAPES CHARACTERS, NOT SEQUENCES, AND THAT IS THE FIX (Feitan F2). The
 * first cut escaped the two-character sequence `</`, which closes the element
 * -- and missed the OTHER way out of a `<script>` body: HTML's script data
 * double-escaped state. A label containing `<!--<script` puts the tokenizer
 * into that state, after which the next `</script>` does NOT close the
 * element, and the rest of the page is swallowed into this block (reproduced
 * in headless Chrome). Chasing that sequence too would leave the next one, so
 * the rule is the whole class instead: `<` and `>` can never appear literally,
 * whatever they are next to. Both are escaped as `\u003c`/`\u003e`, which JSON
 * and JavaScript both read back as the original character, so the document
 * round-trips byte for byte through `JSON.parse`.
 *
 * U+2028 AND U+2029 GO WITH THEM, for a different reader: they are valid in a
 * JSON string and are LINE TERMINATORS in JavaScript, so a page that ever
 * inlines this text into a script rather than parsing it as JSON would break
 * on a label nobody could see.
 */
export function serialiseGraph(graph: GraphDocument): string {
  return JSON.stringify(graph)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * A mermaid string literal.
 *
 * MERMAID'S OWN ENTITY ESCAPES, NOT A BACKSLASH (Nobunaga N3, Feitan F3).
 * `\"` is not a thing mermaid's label grammar has; what it does have is
 * numeric character references, so a quote is `#quot;` and a pipe is `#124;`.
 * The pipe is the one that actually broke something: mermaid delimits an edge
 * label with `|`, so a `rel` containing one ended the label early and the rest
 * of the string became statement syntax. `parseGraph` already REFUSES a `|`
 * (and every line terminator) in a label, caption or rel, so this is the
 * second lock rather than the only one -- an escape in a renderer and a
 * refusal at the boundary fail in different directions, and a diagram is not
 * the place to rely on either alone.
 */
function mermaidLabel(text: string): string {
  return text.replace(/"/g, "#quot;").replace(/\|/g, "#124;");
}

/**
 * The mermaid text, in document order.
 *
 * A REMOVED EDGE IS DOTTED AND A REMOVED NODE IS CLASSED, rather than either
 * being left out: the whole point of an architecture DELTA is that it shows
 * what is no longer there beside what replaced it. `unchanged` carries no class
 * because it is the default appearance -- a class for "nothing to say" would be
 * a legend entry nobody reads.
 */
export function graphToMermaid(graph: GraphDocument): string {
  const lines = ["flowchart LR"];
  for (const node of graph.nodes) {
    const klass = node.change === "unchanged" ? "" : `:::${node.change}`;
    lines.push(`  ${node.id}["${mermaidLabel(node.label)}"]${klass}`);
  }
  for (const edge of graph.edges) {
    const arrow = edge.change === "removed" ? "-.->" : "-->";
    const label = edge.rel === "" ? "" : `|${mermaidLabel(edge.rel)}|`;
    lines.push(`  ${edge.from} ${arrow}${label} ${edge.to}`);
  }
  // THE CLASSES CARRY SHAPE, NEVER A COLOUR. A hex value here would be nen
  // shipping a palette, which is the one thing ../taxonomy-purity.test.ts's
  // "names are data" sweep forbids outright: a colour is the consuming
  // repository's, stated in its own `nen/colors.yml` or its own stylesheet, and
  // a diagram nen coloured would be nen's opinion rendered into somebody's
  // report. The class NAMES are the contract -- a page styles `.added`,
  // `.changed` and `.removed` however it likes -- and the stroke weights below
  // are what keeps the mermaid legible where nobody styles it at all.
  lines.push("  classDef added stroke-width:2px");
  lines.push("  classDef changed stroke-width:2px,stroke-dasharray:0");
  lines.push("  classDef removed stroke-width:1px,stroke-dasharray:4 2");
  return lines.join("\n");
}

/**
 * The four keys `--graph` injects into the data document, named once.
 *
 * ALL FOUR ARE ALWAYS PRESENT TOGETHER. ./template.ts refuses an unknown token
 * by name, so a template that draws the graph must be able to count on every
 * key it names being there whenever `--graph` was given -- a set that varied
 * with the document's content would make the template's refusal depend on what
 * a model happened to write that turn.
 */
export function graphInjection(graph: GraphDocument): Readonly<Record<string, unknown>> {
  return {
    graphJson: serialiseGraph(graph),
    graphMermaid: graphToMermaid(graph),
    graphNodes: graph.nodes,
    graphEdges: graph.edges,
  };
}
