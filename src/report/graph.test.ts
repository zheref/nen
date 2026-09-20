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

  it("refuses --json BY NAME rather than accepting and ignoring it (N8)", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (l): void => void out.push(l), err: (l): void => void err.push(l) };
    const code = await runFamily(
      reportCommand,
      ["report", "mermaid", "--graph", GRAPH_FILE, "--json"],
      process.cwd(),
      false,
      io,
      REFUSING_SEAMS,
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--json is not read by 'report mermaid'/);
    expect(out).toEqual([]);
  });

  it("refuses a flag the OTHER verbs read, rather than ignoring it", async () => {
    const captured = await capture(["report", "mermaid", "--graph", GRAPH_FILE, "--out", "x.html"]);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--out (is|are) not read by 'report mermaid'/);
  });
});


// ── the injection surfaces (Nobunaga N3, Feitan F2/F3) ─────────────────────
//
// `label`, `caption` and `rel` are model-written prose that becomes TWO
// grammars: mermaid source, and JSON inside a `<script>` element. Each of the
// cases below is a way a field nobody thought of as code stopped being text.

describe("serialiseGraph escapes CHARACTERS, not sequences (Feitan F2)", () => {
  const withLabel = (label: string): string =>
    serialiseGraph(
      parseGraph(graph({ nodes: [{ id: "a", label, kind: "module", change: "added" }], edges: [] }), "g.json"),
    );

  it("leaves no literal < or > at all, whatever they sit next to", () => {
    for (const label of ["closes with </script> inside", "<!--<script", "a > b < c", "</SCRIPT >"]) {
      const serialised = withLabel(label);
      expect(serialised, `'${label}' left a literal angle bracket in the script body`).not.toMatch(/[<>]/);
      // ...and it still round-trips to the exact label.
      expect((JSON.parse(serialised) as { nodes: { label: string }[] }).nodes[0]?.label).toBe(label);
    }
  });

  it("closes the double-escaped-state hole `</` alone left open", () => {
    // `<!--<script` puts an HTML tokenizer into script data double-escaped
    // state, after which the NEXT `</script>` does not close the element and
    // the rest of the page is swallowed into this block. Escaping the two-
    // character sequence `</` never touched it.
    const serialised = withLabel("<!--<script");
    expect(serialised).not.toContain("<!--");
    expect(serialised).toContain("\\u003c");
  });

  it("escapes the two JavaScript line terminators that are legal in JSON", () => {
    // `parseGraph` REFUSES these in a label, so this exercises the serialiser
    // on a document built in code -- defence in depth, and the half that has
    // to hold if a later field is ever added without a boundary rule.
    const serialised = serialiseGraph({
      contract: GRAPH_CONTRACT,
      caption: `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`,
      nodes: [],
      edges: [],
    });
    expect(serialised).not.toContain(String.fromCharCode(0x2028));
    expect(serialised).not.toContain(String.fromCharCode(0x2029));
    expect((JSON.parse(serialised) as { caption: string }).caption).toHaveLength(5);
  });
});

describe("parseGraph refuses a free-text field that would become syntax (Feitan F3)", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["a newline", "one\ntwo"],
    ["a carriage return", "one\rtwo"],
    ["a '|'", "calls|click a href"],
    ["a U+2028 line separator", `one${String.fromCharCode(0x2028)}two`],
    ["a U+2029 paragraph separator", `one${String.fromCharCode(0x2029)}two`],
  ];

  it("refuses each of them in a node LABEL, naming the row and the character", () => {
    for (const [named, text] of cases) {
      let message = "";
      try {
        parseGraph(graph({ nodes: [{ id: "a", label: text, kind: "module", change: "added" }], edges: [] }), "g.json");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, `'${named}' in a label was not refused`).toContain(
        `node 0 ('a') has a 'label' carrying ${named}`,
      );
    }
  });

  it("refuses each of them in an edge REL", () => {
    for (const [, text] of cases) {
      expect(() => parseGraph(graph({ edges: [{ from: "a", to: "b", rel: text, change: "added" }] }), "g.json")).toThrow(
        /edge 0 has a 'rel' carrying/,
      );
    }
  });

  it("refuses each of them in the CAPTION", () => {
    for (const [, text] of cases) {
      expect(() => parseGraph(graph({ caption: text }), "g.json")).toThrow(/has a 'caption' carrying/);
    }
  });

  it("names mermaid's own line break as the repair, rather than flattening one", () => {
    expect(() =>
      parseGraph(graph({ nodes: [{ id: "a", label: "one\ntwo", kind: "module", change: "added" }], edges: [] }), "g.json"),
    ).toThrow(/Mermaid's own line break is '<br\/>'/);
    // And `<br/>` itself is accepted: it is the author's to write.
    expect(() =>
      parseGraph(graph({ nodes: [{ id: "a", label: "one<br/>two", kind: "module", change: "added" }], edges: [] }), "g.json"),
    ).not.toThrow();
  });
});

describe("graphToMermaid escapes with mermaid's own entities (Nobunaga N3)", () => {
  it("escapes a '|' as #124; so an edge label cannot end early", () => {
    // `parseGraph` refuses a `|` at the boundary, so this exercises the
    // renderer directly -- the second lock, which must hold on its own.
    const mermaid = graphToMermaid({
      contract: GRAPH_CONTRACT,
      caption: "",
      nodes: [
        { id: "a", label: "A|B", kind: "module", change: "added" },
        { id: "b", label: "B", kind: "module", change: "added" },
      ],
      edges: [{ from: "a", to: "b", rel: "calls|click", change: "added" }],
    });
    expect(mermaid).toContain('a["A#124;B"]');
    expect(mermaid).toContain("a -->|calls#124;click| b");
    // No raw pipe survives inside a label or a rel -- only the two mermaid
    // itself writes as the edge-label delimiters.
    expect(mermaid.split("\n").filter((line): boolean => line.includes("|"))).toEqual([
      "  a -->|calls#124;click| b",
    ]);
  });

  it("escapes a quote as #quot;, not as a backslash mermaid's grammar has not got", () => {
    const mermaid = graphToMermaid(
      parseGraph(
        graph({ nodes: [{ id: "a", label: 'the "quoted" one', kind: "module", change: "added" }], edges: [] }),
        "g.json",
      ),
    );
    expect(mermaid).toContain('  a["the #quot;quoted#quot; one"]:::added');
    expect(mermaid).not.toContain('\\"');
  });
});
