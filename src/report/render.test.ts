// src/report/render.test.ts -- `nen report render`, through the real
// ../index.ts `runFamily`, against a small template committed under
// ./fixtures/.
//
// THE SEAM THROWS ON EVERY CALL. This verb spawns nothing at all -- it reads two
// files and writes one -- and a stub that refuses every subprocess is how that
// stays true: a future `git rev-parse` sneaking in here would be an immediate
// red rather than a live subprocess in somebody's suite.
//
// THE FIXTURE IS A REAL, SMALL REPORT TEMPLATE rather than a string in this
// file: the shape it exercises (a header of scalars, a table over `{{#each}}`,
// a `{{#if}}` around a section that is often absent, and one `{{{raw}}}` cell)
// is the shape the rikugan report actually has, so the test that says "this
// language is enough" is checked against something written to be enough.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { reportCommand } from "./command.js";
import { noPortProbe } from "../seam/scripted.js";

const REFUSING_SEAMS: Seams = {
  run: (): never => {
    throw new Error("'report render' spawns nothing: it reads two files and writes one.");
  },
  probePort: noPortProbe,
  runInteractive: (): never => {
    throw new Error("this verb has no interactive form");
  },
  runStreamed: (): never => {
    throw new Error("this verb has no watched form");
  },
  now: (): Date => new Date("2026-09-09T12:34:56.000Z"),
  env: {},
  platform: "linux",
};

const FIXTURES = join(process.cwd(), "src", "report", "fixtures");

interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

async function capture(argv: readonly string[], repoFlag: string): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const code = await runFamily(reportCommand, argv, repoFlag, false, io, REFUSING_SEAMS);
  return { code, out, err };
}

const DATA = {
  contract: "nen.report.data/v0.1",
  repo: "nen",
  branch: "opus/kurapika/report-family",
  base: "main",
  generatedAt: "2026-09-09T12:34:56.000Z",
  commits: [
    { sha: "aaaaaaaabbbbbbbb", subject: "feat(report): add <the> family", author: "Sergio", date: "2026-09-09T09:00:00+02:00" },
    { sha: "ccccccccdddddddd", subject: "docs(usage): the family section", author: "Sergio", date: "2026-09-08T18:00:00+02:00" },
  ],
  files: [{ path: "src/report/data.ts", status: "A", tier: "source" }],
  evidence: [],
  coverage: { lane: "web", format: "istanbul-summary", path: "coverage/coverage-summary.json", total: { lines: { covered: 14, total: 17, percent: 82.35 } } },
  proof: null,
  lastStop: null,
  launch: "<pre>bun src/index.ts report data --repo . --base main</pre>",
};

/** A temp repository with the data document in it, ready for `--out`. */
function stagedRepo(data: unknown = DATA): string {
  const root = mkdtempSync(join(tmpdir(), "nen-report-render-"));
  writeFileSync(join(root, "data.json"), JSON.stringify(data, null, 2));
  return root;
}

describe("nen report render", () => {
  it("fills the template and writes the report inside the repository", async () => {
    const root = stagedRepo();
    const captured = await capture(
      ["report", "render", "--template", join(FIXTURES, "report.html"), "--data", "data.json", "--out", "Reports/final.html"],
      root,
    );
    expect(captured.code).toBe(0);
    const written = readFileSync(join(root, "Reports", "final.html"), "utf8");
    expect(written).toContain("<h1>nen -- opus/kurapika/report-family</h1>");
    expect(written).toContain("<td>1</td><td>ccccccccdddddddd</td><td>docs(usage): the family section</td>");
    expect(written).toContain("82.35% of lines on 'web'");
    // The `{{{launch}}}` cell keeps its markup; the `{{subject}}` cell does not.
    expect(written).toContain("<pre>bun src/index.ts report data --repo . --base main</pre>");
    expect(written).toContain("feat(report): add &lt;the&gt; family");
  });

  it("creates the directory the report goes in", async () => {
    const root = stagedRepo();
    await capture(
      ["report", "render", "--template", join(FIXTURES, "report.html"), "--data", "data.json", "--out", "a/b/c/final.html"],
      root,
    );
    expect(existsSync(join(root, "a", "b", "c", "final.html"))).toBe(true);
  });

  it("renders nothing for an absent optional section, and the section when it is there", async () => {
    const root = stagedRepo({ ...DATA, coverage: null });
    await capture(
      ["report", "render", "--template", join(FIXTURES, "report.html"), "--data", "data.json", "--out", "out.html"],
      root,
    );
    const written = readFileSync(join(root, "out.html"), "utf8");
    expect(written).not.toContain("<section id=\"coverage\">");
    expect(written).toContain("<h1>nen");
  });

  it("emits the contract document under --json, with the paths as the caller typed them", async () => {
    const root = stagedRepo();
    const captured = await capture(
      ["report", "render", "--template", join(FIXTURES, "report.html"), "--data", "data.json", "--out", "Reports/final.html", "--json"],
      root,
    );
    const document = JSON.parse(captured.out.join("\n")) as Record<string, unknown>;
    // `variant` and `injected` are APPENDED (zheref/nen#220): the five keys
    // before them are v0.11's, in v0.11's order, so a consumer reading them
    // reads the same document. Both are null/empty when neither --variant nor
    // --graph was given, which is this invocation.
    expect(Object.keys(document)).toEqual([
      "contract",
      "template",
      "out",
      "tokens",
      "written",
      "variant",
      "injected",
    ]);
    expect(document["variant"]).toBeNull();
    expect(document["injected"]).toEqual([]);
    expect(document["contract"]).toBe("nen.report.render/v0.1");
    expect(document["out"]).toBe("Reports/final.html");
    expect(document["written"]).toBe(true);
    expect(document["tokens"]).toEqual([
      "repo",
      "branch",
      "base",
      "generatedAt",
      "commits",
      "@index",
      "sha",
      "subject",
      "coverage",
      "coverage.total.lines.percent",
      "coverage.lane",
      "launch",
    ]);
  });
});

describe("--dry-run", () => {
  it("prints every token the template names and writes nothing", async () => {
    const root = stagedRepo();
    const captured = await capture(
      ["report", "render", "--template", join(FIXTURES, "report.html"), "--data", "data.json", "--out", "Reports/final.html", "--dry-run"],
      root,
    );
    expect(captured.code).toBe(0);
    expect(existsSync(join(root, "Reports", "final.html"))).toBe(false);
    expect(captured.out.join("\n")).toMatch(/\(dry run\) nothing written/);
    expect(captured.out.join("\n")).toMatch(/^ {2}coverage\.total\.lines\.percent$/m);
  });

  it("lists the tokens ON THE REFUSAL too, so the advice to run it is not a loop", async () => {
    const root = stagedRepo({ ...DATA, branch: undefined });
    const captured = await capture(
      ["report", "render", "--template", join(FIXTURES, "report.html"), "--data", "data.json", "--out", "out.html", "--dry-run"],
      root,
    );
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/'branch', which the data document has not got/);
    expect(captured.err.join("\n")).toMatch(/This template names 12 token\(s\): repo, branch, base/);
  });

  it("makes the SAME refusals the real run makes, so a dry run proves something", async () => {
    const root = stagedRepo();
    const captured = await capture(
      ["report", "render", "--template", join(FIXTURES, "report.html"), "--data", "data.json", "--out", "../escape.html", "--dry-run"],
      root,
    );
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/resolves outside the repository/);
  });
});

describe("nen report render refuses", () => {
  it("an --out outside the repository, at exit 2", async () => {
    const root = stagedRepo();
    const captured = await capture(
      ["report", "render", "--template", join(FIXTURES, "report.html"), "--data", "data.json", "--out", "../../escape.html"],
      root,
    );
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--out '\.\.\/\.\.\/escape\.html' resolves outside the repository/);
  });

  it("an --out redirected outside by a SYMLINK, naming the link", async () => {
    const root = stagedRepo();
    const elsewhere = mkdtempSync(join(tmpdir(), "nen-report-elsewhere-"));
    mkdirSync(join(elsewhere, "Reports"), { recursive: true });
    symlinkSync(join(elsewhere, "Reports"), join(root, "Reports"), "dir");
    const captured = await capture(
      ["report", "render", "--template", join(FIXTURES, "report.html"), "--data", "data.json", "--out", "Reports/final.html"],
      root,
    );
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/is a symlink to/);
    expect(existsSync(join(elsewhere, "Reports", "final.html"))).toBe(false);
  });

  it("a token the data document has not got, NAMING it, and writes nothing", async () => {
    const root = stagedRepo({ ...DATA, branch: undefined });
    const captured = await capture(
      ["report", "render", "--template", join(FIXTURES, "report.html"), "--data", "data.json", "--out", "out.html"],
      root,
    );
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/'branch', which the data document has not got/);
    expect(existsSync(join(root, "out.html"))).toBe(false);
  });

  it("a template this language does not have, naming the whole language", async () => {
    const root = stagedRepo();
    writeFileSync(join(root, "bad.html"), "{{#unless x}}no{{/unless}}");
    const captured = await capture(
      ["report", "render", "--template", "bad.html", "--data", "data.json", "--out", "out.html"],
      root,
    );
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/is not a tag this language has/);
  });

  it("a template that is not there, and a data file that is not JSON", async () => {
    const root = stagedRepo();
    const missing = await capture(
      ["report", "render", "--template", "nope.html", "--data", "data.json", "--out", "out.html"],
      root,
    );
    expect(missing.code).toBe(2);
    expect(missing.err.join("\n")).toMatch(/could not read/);

    writeFileSync(join(root, "bad.json"), "not json");
    writeFileSync(join(root, "ok.html"), "hello");
    const malformed = await capture(
      ["report", "render", "--template", "ok.html", "--data", "bad.json", "--out", "out.html"],
      root,
    );
    expect(malformed.code).toBe(2);
    expect(malformed.err.join("\n")).toMatch(/is not valid JSON/);
  });

  it("each of --template, --data and --out by name when it is missing", async () => {
    const root = stagedRepo();
    for (const [argv, flag] of [
      [["report", "render", "--data", "data.json", "--out", "o.html"], "template"],
      [["report", "render", "--template", "t.html", "--out", "o.html"], "data"],
      [["report", "render", "--template", "t.html", "--data", "data.json"], "out"],
    ] as const) {
      const captured = await capture(argv, root);
      expect(captured.code).toBe(2);
      expect(captured.err.join("\n")).toMatch(new RegExp(`--${flag} is required`));
    }
  });

  it("a flag the OTHER verb reads", async () => {
    const root = stagedRepo();
    const captured = await capture(
      ["report", "render", "--template", "t.html", "--data", "data.json", "--out", "o.html", "--base", "main"],
      root,
    );
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--base is not read by 'report render'/);
  });
});

describe("the bytes it writes", () => {
  it("are the template's own, tokens substituted -- a CRLF template stays CRLF", async () => {
    const root = stagedRepo();
    writeFileSync(join(root, "crlf.html"), "a\r\n{{repo}}\r\nb\r\n");
    await capture(["report", "render", "--template", "crlf.html", "--data", "data.json", "--out", "out.html"], root);
    expect(readFileSync(join(root, "out.html"), "utf8")).toBe("a\r\nnen\r\nb\r\n");
  });
});

// ── --variant and --graph (zheref/nen#220) ─────────────────────────────────
//
// THE INJECTION IS TESTED THROUGH A TEMPLATE, not through the report document
// alone: `sections.<block>` only means anything if `{{#if sections.desk}}`
// actually renders, and a test that asserted the injected object and stopped
// would pass for an injection the renderer never saw.

const VARIANT_TEMPLATE = `<html>
{{#if sections.desk}}<section id="desk">{{repo}}</section>{{/if}}
{{#if sections.spend}}<section id="spend">spend</section>{{/if}}
<ul>{{#each sectionList}}<li>{{.}}</li>{{/each}}</ul>
</html>
`;

const GRAPH_TEMPLATE = `<html>
<script type="application/json" id="graph">{{{graphJson}}}</script>
<pre>{{graphMermaid}}</pre>
<ul>{{#each graphNodes}}<li>{{id}} {{change}}</li>{{/each}}</ul>
<ol>{{#each graphEdges}}<li>{{from}}-&gt;{{to}}</li>{{/each}}</ol>
</html>
`;

/** A staged repository that also declares `reports.sections` and a template. */
function variantRepo(data: unknown, template: string = VARIANT_TEMPLATE): string {
  const root = stagedRepo(data);
  mkdirSync(join(root, "nen"), { recursive: true });
  writeFileSync(
    join(root, "nen", "workflow.json"),
    JSON.stringify({
      reports: {
        // The variants declare `page`, which is what `--template page.html`
        // fills: a variant's declared template and the template actually being
        // filled must agree (Copilot, #221), and `assertVariantTemplate` is
        // exercised on its own below.
        sections: {
          turn: { template: "page", blocks: ["masthead", "desk"] },
          final: { template: "page", blocks: ["masthead", "register", "spend"] },
        },
      },
    }),
    "utf8",
  );
  writeFileSync(join(root, "page.html"), template, "utf8");
  return root;
}

describe("nen report render --variant", () => {
  it("injects a presence flag per declared block, and the block list in the file's order", async () => {
    const root = variantRepo(DATA);
    const captured = await capture(
      ["report", "render", "--template", "page.html", "--data", "data.json", "--out", "out.html", "--variant", "turn"],
      root,
    );
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const written = readFileSync(join(root, "out.html"), "utf8");
    // `desk` is declared by this variant and `spend` is not, so one section
    // renders and the other does not -- from the SAME template.
    expect(written).toContain('<section id="desk">nen</section>');
    expect(written).not.toContain('id="spend"');
    expect(written).toContain("<li>masthead</li><li>desk</li>");
  });

  it("switches blocks by variant, from one template and one data document", async () => {
    const root = variantRepo(DATA);
    await capture(
      ["report", "render", "--template", "page.html", "--data", "data.json", "--out", "final.html", "--variant", "final"],
      root,
    );
    const written = readFileSync(join(root, "final.html"), "utf8");
    expect(written).toContain('id="spend"');
    expect(written).not.toContain('id="desk"');
  });

  it("renders a block ANOTHER variant declares as FALSE, never as a refusal", async () => {
    // THE AMENDMENT (zheref/nen#220, from the template side's live finding).
    // ./template.ts resolves a dotted path BEFORE testing it, so
    // `{{#if sections.spend}}` against a `sections` map that lacks the key is
    // an unknown token at exit 2 -- not a falsy test. One template serves
    // several variants (`rikugan.html` is turn, turn-fast and landing), so the
    // injected map must carry EVERY block name `reports.sections` knows: true
    // for the chosen variant's, false for the rest. Without this the render
    // refuses on a block the variant legitimately does not show.
    const root = variantRepo(DATA);
    const captured = await capture(
      ["report", "render", "--template", "page.html", "--data", "data.json", "--out", "out.html", "--variant", "turn", "--json"],
      root,
    );
    expect(captured.code, captured.err.join("\n")).toBe(0);
    // `spend` is declared by `final` ALONE. The template names it, this
    // variant does not carry it, and the render succeeds with the section
    // simply absent.
    const written = readFileSync(join(root, "out.html"), "utf8");
    expect(written).not.toContain('id="spend"');
    expect(written).toContain('<section id="desk">');
    // `sectionList` stays THIS variant's own blocks, in the file's order --
    // the map is wide, the list is not.
    expect(written).toContain("<li>masthead</li><li>desk</li>");
    expect(written).not.toContain("<li>spend</li>");
  });

  it("still refuses a block NO variant declares -- the typo is caught, the union is not", async () => {
    const root = variantRepo(DATA, `<html>{{#if sections.nosuchblock}}x{{/if}}</html>`);
    const captured = await capture(
      ["report", "render", "--template", "page.html", "--data", "data.json", "--out", "out.html", "--variant", "turn"],
      root,
    );
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/names 'sections\.nosuchblock', which the data document has not got/);
  });

  it("refuses an undeclared variant at exit 2, NAMING the declared ones", async () => {
    const root = variantRepo(DATA);
    const captured = await capture(
      ["report", "render", "--template", "page.html", "--data", "data.json", "--out", "out.html", "--variant", "landing"],
      root,
    );
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--variant 'landing' is not declared by/);
    expect(captured.err.join("\n")).toMatch(/Declared: turn, final\./);
    expect(existsSync(join(root, "out.html"))).toBe(false);
  });

  it("refuses when the repository declares no sections at all, saying so rather than listing nothing", async () => {
    const root = stagedRepo();
    const captured = await capture(
      ["report", "render", "--template", join(FIXTURES, "report.html"), "--data", "data.json", "--out", "out.html", "--variant", "turn"],
      root,
    );
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/declares no 'reports\.sections' at all/);
  });

  it("refuses a --data document whose own `variant` disagrees", async () => {
    const root = variantRepo({ ...DATA, variant: "final" });
    const captured = await capture(
      ["report", "render", "--template", "page.html", "--data", "data.json", "--out", "out.html", "--variant", "turn"],
      root,
    );
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--variant 'turn' disagrees with --data 'data\.json', which states variant 'final'/);
  });

  it("accepts a --data document that AGREES, and one that states no variant at all", async () => {
    const agreeing = variantRepo({ ...DATA, variant: "turn" });
    expect(
      (await capture(["report", "render", "--template", "page.html", "--data", "data.json", "--out", "o.html", "--variant", "turn"], agreeing)).code,
    ).toBe(0);
    const silent = variantRepo(DATA);
    expect(
      (await capture(["report", "render", "--template", "page.html", "--data", "data.json", "--out", "o.html", "--variant", "turn"], silent)).code,
    ).toBe(0);
  });

  it("injects NOTHING without the flag -- the v0.11 render, byte for byte", async () => {
    const root = variantRepo(DATA);
    const captured = await capture(
      ["report", "render", "--template", "page.html", "--data", "data.json", "--out", "out.html", "--json"],
      root,
    );
    // The template names `sections.desk`, which the un-injected document has
    // not got -- and an unknown token is a refusal, which is the proof that
    // nothing was injected.
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/names 'sections\.desk', which the data document has not got/);
  });

  it("reports the variant and the injected keys in the render document", async () => {
    const root = variantRepo(DATA);
    const captured = await capture(
      ["report", "render", "--template", "page.html", "--data", "data.json", "--out", "out.html", "--variant", "turn", "--json"],
      root,
    );
    const document = JSON.parse(captured.out.join("\n")) as Record<string, unknown>;
    expect(document["variant"]).toBe("turn");
    expect(document["injected"]).toEqual(["sectionList", "sections"]);
  });
});

describe("nen report render --graph", () => {
  const GRAPH_FILE = join(FIXTURES, "graph.json");

  it("injects all four graph keys together, every time", async () => {
    const root = variantRepo(DATA, GRAPH_TEMPLATE);
    const captured = await capture(
      ["report", "render", "--template", "page.html", "--data", "data.json", "--out", "out.html", "--graph", GRAPH_FILE, "--json"],
      root,
    );
    expect(captured.code).toBe(0);
    expect(JSON.parse(captured.out.join("\n"))["injected"]).toEqual([
      "graphEdges",
      "graphJson",
      "graphMermaid",
      "graphNodes",
    ]);
    const written = readFileSync(join(root, "out.html"), "utf8");
    // `{{{graphJson}}}` lands RAW inside the script block, and carries no `</`.
    expect(written).toContain('<script type="application/json" id="graph">{"contract":"nen.report.graph/v0.1"');
    expect(written.split('id="graph">')[1]?.split("</script>")[0]).not.toContain("</");
    expect(written).toContain("<li>report-render changed</li>");
    expect(written).toContain("<li>report-render-&gt;report-graph</li>");
    // The escaped `{{graphMermaid}}` cell carries the diagram as text.
    expect(written).toContain("flowchart LR");
  });

  it("refuses a malformed graph at exit 2, writing nothing", async () => {
    const root = variantRepo(DATA, GRAPH_TEMPLATE);
    writeFileSync(join(root, "bad-graph.json"), JSON.stringify({ contract: "nen.report.graph/v0.1", nodes: [], edges: [{ from: "a", to: "b", change: "added" }] }), "utf8");
    const captured = await capture(
      ["report", "render", "--template", "page.html", "--data", "data.json", "--out", "out.html", "--graph", "bad-graph.json"],
      root,
    );
    expect(captured.code).toBe(2);
    expect(existsSync(join(root, "out.html"))).toBe(false);
  });
});

// ── the variant's own template, and a variant that is not a name ───────────
//
// Copilot #221, threads …ctd (the declared template was validated and then
// ignored) and …ctz (a non-string `variant` sailed through the agreement
// check). Both produce the same class of outcome: a page that looks finished
// and is the wrong page.

describe("--variant is checked against --template (Copilot #221)", () => {
  /** A repository whose two variants name two DIFFERENT templates. */
  function twoTemplates(): string {
    const root = stagedRepo(DATA);
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(
      join(root, "nen", "workflow.json"),
      JSON.stringify({
        reports: {
          sections: {
            turn: { template: "rikugan", blocks: ["masthead", "desk"] },
            final: { template: "spiritual-message", blocks: ["masthead", "spend"] },
          },
        },
      }),
      "utf8",
    );
    writeFileSync(join(root, "rikugan.html"), VARIANT_TEMPLATE, "utf8");
    writeFileSync(join(root, "spiritual-message.html"), VARIANT_TEMPLATE, "utf8");
    return root;
  }

  it("refuses the variant's blocks in another variant's template, naming both", async () => {
    const root = twoTemplates();
    const captured = await capture(
      ["report", "render", "--template", "spiritual-message.html", "--data", "data.json", "--out", "out.html", "--variant", "turn"],
      root,
    );
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(
      /--variant 'turn' declares template 'rikugan', and --template 'spiritual-message\.html' is 'spiritual-message'/,
    );
    expect(existsSync(join(root, "out.html"))).toBe(false);
  });

  it("accepts the declared template however the caller spells its PATH", async () => {
    const root = twoTemplates();
    mkdirSync(join(root, "templates"), { recursive: true });
    writeFileSync(join(root, "templates", "rikugan.html"), VARIANT_TEMPLATE, "utf8");
    // `reports.template` names a slug, never a path -- so where the caller
    // keeps their templates is not nen's business.
    for (const spelling of ["rikugan.html", "./rikugan.html", join("templates", "rikugan.html")]) {
      const captured = await capture(
        ["report", "render", "--template", spelling, "--data", "data.json", "--out", "out.html", "--variant", "turn"],
        root,
      );
      expect(captured.code, `${spelling}: ${captured.err.join("\n")}`).toBe(0);
    }
  });

  it("checks nothing without --variant, which declares no template to check against", async () => {
    const root = twoTemplates();
    const captured = await capture(
      ["report", "render", "--template", "spiritual-message.html", "--data", "data.json", "--out", "out.html"],
      root,
    );
    // It fails on the unknown `sections.desk` token, not on a template
    // mismatch: with no variant there is no policy to disagree with.
    expect(captured.err.join("\n")).toMatch(/names 'sections\.desk'/);
  });
});

describe("a --data `variant` that is not a name (Copilot #221)", () => {
  it("refuses a present non-string variant rather than ignoring it", async () => {
    for (const stated of [123, true, ["turn"], { name: "turn" }]) {
      const root = variantRepo({ ...DATA, variant: stated });
      const captured = await capture(
        ["report", "render", "--template", "page.html", "--data", "data.json", "--out", "out.html", "--variant", "turn"],
        root,
      );
      expect(captured.code, `${JSON.stringify(stated)} was accepted`).toBe(2);
      expect(captured.err.join("\n")).toMatch(/states a 'variant' that is not a variant name/);
    }
  });

  it("still treats an absent or null variant as 'this assembler does not write the key'", async () => {
    for (const data of [DATA, { ...DATA, variant: null }]) {
      const root = variantRepo(data);
      const captured = await capture(
        ["report", "render", "--template", "page.html", "--data", "data.json", "--out", "out.html", "--variant", "turn"],
        root,
      );
      expect(captured.code, captured.err.join("\n")).toBe(0);
    }
  });
});
