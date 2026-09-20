// src/report/graph.test.ts -- the graph document's validation, its mermaid and
// its serialisation, plus `nen report mermaid` through the real dispatcher.
//
// THE FIXTURE IS A REAL DELTA, not a two-node toy: it carries all four `change`
// values on nodes, a removed EDGE, an edge with no `rel`, and a node whose
// label is prose. A validator tested only against the happy shape is a
// validator whose refusals nobody has read.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { noPortProbe } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { reportCommand } from "./command.js";
import { GRAPH_CONTRACT, graphToMermaid, parseGraph, serialiseGraph } from "./graph.js";

const REFUSING_SEAMS: Seams = {
  run: (): never => {
    throw new Error("'report mermaid' spawns nothing: it reads one file and prints text.");
  },
  probePort: noPortProbe,
  runInteractive: (): never => {
    throw new Error("this verb has no interactive form");
  },
  runStreamed: (): never => {
    throw new Error("this verb has no watched form");
  },
  now: (): Date => new Date("2026-09-20T00:00:00.000Z"),
  env: {},
  platform: "linux",
};

const FIXTURES = join(process.cwd(), "src", "report", "fixtures");
const GRAPH_FILE = join(FIXTURES, "graph.json");

async function capture(argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push(line),
  };
  const code = await runFamily(reportCommand, argv, process.cwd(), false, io, REFUSING_SEAMS);
  return { code, out, err };
}

/** The shipped fixture, re-read per call so no test can mutate another's. */
function fixture(): unknown {
  return JSON.parse(readFileSync(GRAPH_FILE, "utf8")) as unknown;
}

function graph(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: GRAPH_CONTRACT,
    caption: "one line",
    nodes: [
      { id: "a", label: "A", kind: "module", change: "added" },
      { id: "b", label: "B", kind: "verb", change: "unchanged" },
    ],
    edges: [{ from: "a", to: "b", rel: "calls", change: "added" }],
    ...overrides,
  };
}

describe("parseGraph", () => {
  it("accepts the shipped fixture whole, with its four change values", () => {
    const parsed = parseGraph(fixture(), "graph.json");
    expect(parsed.contract).toBe(GRAPH_CONTRACT);
    expect(parsed.nodes.map((node): string => node.change)).toEqual([
      "changed",
      "added",
      "added",
      "changed",
      "removed",
      "unchanged",
    ]);
    // An edge that states no `rel` comes back as the EMPTY STRING rather than
    // undefined: every key a template names must always be present, so an
    // optional field is defaulted at the boundary and never left absent.
    expect(parsed.edges.at(-1)?.rel).toBe("");
  });

  it("refuses a document that does not name the contract, rather than guessing a shape", () => {
    expect(() => parseGraph(graph({ contract: "nen.report.graph/v0.2" }), "g.json")).toThrow(
      /states contract 'nen\.report\.graph\/v0\.2'/,
    );
  });

  it("refuses an edge endpoint that names no declared node, NAMING the declared ids", () => {
    const bad = graph({ edges: [{ from: "a", to: "typo", rel: "calls", change: "added" }] });
    expect(() => parseGraph(bad, "g.json")).toThrow(/edge 0 has 'to' of 'typo', which names no declared node/);
    expect(() => parseGraph(bad, "g.json")).toThrow(/Declared ids: a, b/);
  });

  it("refuses a repeated id, because two nodes with one id are one node in every rendering", () => {
    const bad = graph({
      nodes: [
        { id: "a", label: "A", kind: "module", change: "added" },
        { id: "a", label: "A again", kind: "module", change: "changed" },
      ],
    });
    expect(() => parseGraph(bad, "g.json")).toThrow(/node 1 repeats the id 'a'/);
  });

  it("refuses a change value outside the four, an empty label and a non-slug id or kind", () => {
    expect(() => parseGraph(graph({ nodes: [{ id: "a", label: "A", kind: "module", change: "touched" }], edges: [] }), "g.json")).toThrow(
      /has 'change' of 'touched' -- it is one of added, changed, removed, unchanged/,
    );
    expect(() => parseGraph(graph({ nodes: [{ id: "a", label: "  ", kind: "module", change: "added" }], edges: [] }), "g.json")).toThrow(
      /has 'label' of '  ' -- a node with no label draws as an empty box/,
    );
    expect(() => parseGraph(graph({ nodes: [{ id: "Node_1", label: "A", kind: "module", change: "added" }], edges: [] }), "g.json")).toThrow(
      /has 'id' of 'Node_1' -- an id is a slug/,
    );
    expect(() => parseGraph(graph({ nodes: [{ id: "a", label: "A", kind: "Module", change: "added" }], edges: [] }), "g.json")).toThrow(
      /has 'kind' of 'Module' -- a kind is a free slug/,
    );
  });

  it("takes an absent `edges` as none, and an absent `caption` as the empty string", () => {
    const parsed = parseGraph({ contract: GRAPH_CONTRACT, nodes: [{ id: "a", label: "A", kind: "module", change: "added" }] }, "g.json");
    expect(parsed.edges).toEqual([]);
    expect(parsed.caption).toBe("");
  });
});

describe("serialiseGraph", () => {
  it("escapes '</' so the document survives a raw <script type=\"application/json\"> block", () => {
    const parsed = parseGraph(
      graph({ nodes: [{ id: "a", label: "closes with </script> inside", kind: "module", change: "added" }], edges: [] }),
      "g.json",
    );
    const serialised = serialiseGraph(parsed);
    // The sequence an HTML parser ends the element on must not appear at all...
    expect(serialised).not.toContain("</");
    // ...and the document must still round-trip to the same label.
    expect((JSON.parse(serialised) as { nodes: { label: string }[] }).nodes[0]?.label).toBe(
      "closes with </script> inside",
    );
  });
});

describe("graphToMermaid", () => {
  it("is deterministic, in document order, with a class per change and a dotted removed edge", () => {
    const parsed = parseGraph(fixture(), "graph.json");
    const first = graphToMermaid(parsed);
    expect(graphToMermaid(parsed)).toBe(first);
    const lines = first.split("\n");
    expect(lines[0]).toBe("flowchart LR");
    expect(lines[1]).toBe('  report-render["nen report render"]:::changed');
    // `unchanged` carries NO class -- a class for "nothing to say" would be a
    // legend entry nobody reads.
    expect(lines).toContain('  pr-ready["nen pr ready"]');
    expect(lines).toContain("  report-render -->|validates with| report-graph");
    // A removed edge is dotted, and one with no `rel` carries no label pipe.
    expect(lines).toContain("  old-summary -.-> rikugan");
  });

  it("carries stroke weights and NO colour -- a palette is the consuming repository's", () => {
    const mermaid = graphToMermaid(parseGraph(graph(), "g.json"));
    expect(mermaid).toContain("classDef added stroke-width:2px");
    expect(mermaid).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
  });

  it("escapes a quote inside a label rather than ending the mermaid string early", () => {
    const parsed = parseGraph(
      graph({ nodes: [{ id: "a", label: 'the "quoted" one', kind: "module", change: "added" }], edges: [] }),
      "g.json",
    );
    expect(graphToMermaid(parsed)).toContain('  a["the \\"quoted\\" one"]:::added');
  });
});

describe("nen report mermaid", () => {
  it("prints the mermaid and nothing else", async () => {
    const captured = await capture(["report", "mermaid", "--graph", GRAPH_FILE]);
    expect(captured.code).toBe(0);
    expect(captured.out[0]).toBe("flowchart LR");
    expect(captured.out.at(-1)).toBe("  classDef removed stroke-width:1px,stroke-dasharray:4 2");
    expect(captured.err).toEqual([]);
  });

  it("refuses a missing --graph by name, and a malformed document at exit 2", async () => {
    const missing = await capture(["report", "mermaid"]);
    expect(missing.code).toBe(2);
    expect(missing.err.join("\n")).toMatch(/--graph <file> is required/);
    const notGraph = await capture(["report", "mermaid", "--graph", join(FIXTURES, "report.html")]);
    expect(notGraph.code).toBe(2);
  });

  it("refuses a flag the OTHER verbs read, rather than ignoring it", async () => {
    const captured = await capture(["report", "mermaid", "--graph", GRAPH_FILE, "--out", "x.html"]);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--out (is|are) not read by 'report mermaid'/);
  });
});

