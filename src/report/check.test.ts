// src/report/check.test.ts -- `nen report check` (zheref/nen#406).
//
// THE SEAM THROWS ON EVERY CALL. The verb reads templates and example data and
// fills them in process; a stub that refuses every subprocess is how a later
// `git` or `gh` cannot sneak in unnoticed.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { makeTempDir } from "../testing/tempdir.js";
import { reportCommand } from "./command.js";

const REFUSING_SEAMS: Seams = {
  run: (): never => {
    throw new Error("'report check' spawns nothing: it reads templates and fills them in process.");
  },
  probePort: noPortProbe,
  runInteractive: (): never => {
    throw new Error("this verb has no interactive form");
  },
  runStreamed: (): never => {
    throw new Error("this verb has no watched form");
  },
  now: (): Date => new Date("2026-10-14T00:00:00.000Z"),
  env: {},
  platform: "linux",
};

interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

async function capture(argv: readonly string[], repoFlag: string | null = null): Promise<Captured> {
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

const MD = `{{#if sections.masthead}}<!-- hatsu:block masthead -->
# {{title}}
{{/if}}{{#if sections.desk}}<!-- hatsu:block desk -->
<!-- hatsu:ask -->
- **A** · keep ⭐ the one
- **B** · drop
{{/if}}
`;

const HTML = `{{#if sections.masthead}}<header class="mast">{{title}}</header>{{/if}}{{#if sections.desk}}<section id="desk">{{title}}</section>{{/if}}
`;

const DATA = '{ "title": "Turn", "variant": "turn" }\n';

function writeTree(
  files: Readonly<Record<string, string>>,
  sections: Readonly<Record<string, { template: string; blocks: readonly string[] }>> = {
    turn: { template: "page", blocks: ["masthead", "desk"] },
  },
): string {
  const root = makeTempDir("nen-report-check-");
  mkdirSync(join(root, "nen"), { recursive: true });
  writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ reports: { sections } }), "utf8");
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text, "utf8");
  }
  return root;
}

function conformant(): string {
  return writeTree({
    "templates/page.md": MD,
    "templates/page.html": HTML,
    "templates/report-examples/turn.data.json": DATA,
  });
}

function textOf(captured: Captured): string {
  return `${captured.err.join("\n")}\n${captured.out.join("\n")}`;
}

describe("nen report check", () => {
  it("exits 0 when every declared variant renders both formats in the declared order", async () => {
    const root = conformant();
    const captured = await capture(["report", "check", "--repo", root], root);
    expect(captured.code, textOf(captured)).toBe(0);
    expect(captured.out.join("\n")).toMatch(/report check ok: 1 variant/);
  });

  it("names the variant, template and rule when a render is refused", async () => {
    const root = writeTree({
      "templates/page.md": MD,
      "templates/page.html": HTML,
      "templates/report-examples/turn.data.json": '{ "variant": "turn" }\n',
    });
    const captured = await capture(["report", "check", "--repo", root], root);
    expect(captured.code, textOf(captured)).toBe(1);
    expect(textOf(captured)).toMatch(/turn templates\/page\.md rule refused-render/);
  });

  it("refuses a surviving '{{' by name", async () => {
    const root = writeTree({
      "templates/page.md": `${MD}see {{\n`,
      "templates/page.html": HTML,
      "templates/report-examples/turn.data.json": DATA,
    });
    const captured = await capture(["report", "check", "--repo", root], root);
    expect(captured.code, textOf(captured)).toBe(1);
    expect(textOf(captured)).toMatch(/turn templates\/page\.md rule unfilled/);
  });

  it("refuses a block sequence that is not the declared one when both formats agree on the wrong order", async () => {
    const swappedMd = `{{#if sections.desk}}<!-- hatsu:block desk -->
<!-- hatsu:ask -->
- **A** · keep ⭐ the one
- **B** · drop
{{/if}}{{#if sections.masthead}}<!-- hatsu:block masthead -->
# {{title}}
{{/if}}
`;
    const swappedHtml = `{{#if sections.desk}}<section id="desk">{{title}}</section>{{/if}}{{#if sections.masthead}}<header class="mast">{{title}}</header>{{/if}}
`;
    const root = writeTree({
      "templates/page.md": swappedMd,
      "templates/page.html": swappedHtml,
      "templates/report-examples/turn.data.json": DATA,
    });
    const captured = await capture(["report", "check", "--repo", root], root);
    const text = textOf(captured);
    expect(captured.code, text).toBe(1);
    expect(text).toMatch(/turn templates\/page\.md rule block-order/);
    expect(text).toMatch(/turn templates\/page\.html rule block-order/);
    expect(text).not.toMatch(/formats-disagree/);
  });

  it("refuses when the two formats' block sequences disagree", async () => {
    const swappedHtml = `{{#if sections.desk}}<section id="desk">{{title}}</section>{{/if}}{{#if sections.masthead}}<header class="mast">{{title}}</header>{{/if}}
`;
    const root = writeTree({
      "templates/page.md": MD,
      "templates/page.html": swappedHtml,
      "templates/report-examples/turn.data.json": DATA,
    });
    const captured = await capture(["report", "check", "--repo", root], root);
    const text = textOf(captured);
    expect(captured.code, text).toBe(1);
    expect(text).toMatch(/turn templates\/page\.md templates\/page\.html rule formats-disagree/);
    expect(text).toMatch(/templates\/page\.html rule block-order/);
  });

  it("reads HTML block comments ahead of the anchor map", async () => {
    const html = `<section id="desk">{{title}}</section><header class="mast">{{title}}</header>
<!-- hatsu:block masthead -->
<!-- hatsu:block desk -->
`;
    const root = writeTree({
      "templates/page.md": MD,
      "templates/page.html": html,
      "templates/report-examples/turn.data.json": DATA,
    });
    const captured = await capture(["report", "check", "--repo", root], root);
    expect(captured.code, textOf(captured)).toBe(0);
  });

  it("refuses an HTML block that has neither a marker nor a known anchor", async () => {
    const root = writeTree(
      {
        "templates/page.md": "<!-- hatsu:block custom -->\n# {{title}}\n",
        "templates/page.html": "<p>{{title}}</p>\n",
        "templates/report-examples/turn.data.json": DATA,
      },
      { turn: { template: "page", blocks: ["custom"] } },
    );
    const captured = await capture(["report", "check", "--repo", root], root);
    const text = textOf(captured);
    expect(captured.code, text).toBe(1);
    expect(text).toMatch(/turn templates\/page\.html rule block-order/);
    expect(text).toMatch(/no known anchor/);
  });

  it.each([
    ["zero", "- **A** · keep\n- **B** · drop\n", /0 starred/],
    ["two", "- **A** · keep ⭐ one\n- **B** · drop ⭐ two\n", /2 starred/],
  ])("refuses an ask with %s starred options", async (_name, options, pattern) => {
    const md = `{{#if sections.masthead}}<!-- hatsu:block masthead -->
# {{title}}
{{/if}}{{#if sections.desk}}<!-- hatsu:block desk -->
<!-- hatsu:ask -->
${options}{{/if}}
`;
    const root = writeTree({
      "templates/page.md": md,
      "templates/page.html": HTML,
      "templates/report-examples/turn.data.json": DATA,
    });
    const captured = await capture(["report", "check", "--repo", root], root);
    const text = textOf(captured);
    expect(captured.code, text).toBe(1);
    expect(text).toMatch(/turn templates\/page\.md rule starred-option/);
    expect(text).toMatch(pattern);
  });

  it("does not count a later gate heading's option as this ask's star", async () => {
    const md = `{{#if sections.masthead}}<!-- hatsu:block masthead -->
# {{title}}
{{/if}}{{#if sections.desk}}<!-- hatsu:block desk -->
<!-- hatsu:ask -->
- **A** · keep ⭐ the one
### next gate
- **B** · drop ⭐ not this ask
{{/if}}
`;
    const root = writeTree({
      "templates/page.md": md,
      "templates/page.html": HTML,
      "templates/report-examples/turn.data.json": '{ "title": "Turn", "variant": "turn", "gates": [] }\n',
    });
    const captured = await capture(["report", "check", "--repo", root], root);
    expect(captured.code, textOf(captured)).toBe(0);
  });

  it.each([
    ["a code span", "# {{title}} `{{title}}`\n"],
    ["a code fence", "# {{title}}\n\n```\n{{title}}\n```\n"],
    ["an indented code block", "# {{title}}\n\n    {{title}}\n"],
  ])("refuses escaping that shows in %s", async (_name, masthead) => {
    const md = `{{#if sections.masthead}}<!-- hatsu:block masthead -->
${masthead}{{/if}}{{#if sections.desk}}<!-- hatsu:block desk -->
<!-- hatsu:ask -->
- **A** · keep ⭐ the one
- **B** · drop
{{/if}}
`;
    const root = writeTree({
      "templates/page.md": md,
      "templates/page.html": HTML,
      "templates/report-examples/turn.data.json": '{ "title": "a&b", "variant": "turn" }\n',
    });
    const captured = await capture(["report", "check", "--repo", root], root);
    const text = textOf(captured);
    expect(captured.code, text).toBe(1);
    expect(text).toMatch(/turn templates\/page\.md rule escaping-shows/);
  });

  it("reports every conformance finding, not only the first", async () => {
    const md = `{{#if sections.masthead}}<!-- hatsu:block masthead -->
# {{title}} \`{{title}}\`
{{/if}}{{#if sections.desk}}<!-- hatsu:block desk -->
<!-- hatsu:ask -->
- **A** · keep
- **B** · drop
{{/if}}
`;
    const root = writeTree({
      "templates/page.md": md,
      "templates/page.html": HTML,
      "templates/report-examples/turn.data.json": '{ "title": "a&b", "variant": "turn" }\n',
    });
    const captured = await capture(["report", "check", "--repo", root], root);
    const text = textOf(captured);
    expect(captured.code, text).toBe(1);
    expect(text).toMatch(/rule starred-option/);
    expect(text).toMatch(/rule escaping-shows/);
  });

  it("exits 2 when the policy file is not JSON", async () => {
    const root = makeTempDir("nen-report-check-");
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "workflow.json"), "{", "utf8");
    const captured = await capture(["report", "check", "--repo", root], root);
    expect(captured.code, textOf(captured)).toBe(2);
    expect(textOf(captured)).toMatch(/workflow\.json/);
  });

  it("exits 2 when reports.sections declares no variant", async () => {
    const root = makeTempDir("nen-report-check-");
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "workflow.json"), "{}\n", "utf8");
    const captured = await capture(["report", "check", "--repo", root], root);
    expect(captured.code, textOf(captured)).toBe(2);
    expect(textOf(captured)).toMatch(/reports\.sections/);
  });

  it.each([
    ["template", { "templates/page.html": HTML, "templates/report-examples/turn.data.json": DATA }, "templates/page.md"],
    ["example", { "templates/page.md": MD, "templates/page.html": HTML }, "templates/report-examples/turn.data.json"],
  ])("exits 2 when a declared %s is missing", async (_name, files, missing) => {
    const root = writeTree(files);
    const captured = await capture(["report", "check", "--repo", root], root);
    const text = textOf(captured);
    expect(captured.code, text).toBe(2);
    expect(text).toMatch(/turn/);
    expect(text).toMatch(new RegExp(missing.replace(/\//g, "\\/")));
  });

  it("checks only the named variant", async () => {
    const root = writeTree(
      {
        "templates/page.md": MD,
        "templates/page.html": HTML,
        "templates/report-examples/turn.data.json": DATA,
        "templates/report-examples/final.data.json": "{}\n",
      },
      {
        turn: { template: "page", blocks: ["masthead", "desk"] },
        final: { template: "page", blocks: ["masthead", "desk"] },
      },
    );
    const held = await capture(["report", "check", "--repo", root, "--variant", "turn"], root);
    expect(held.code, textOf(held)).toBe(0);
    const broken = await capture(["report", "check", "--repo", root, "--variant", "final"], root);
    expect(broken.code, textOf(broken)).toBe(1);
    expect(textOf(broken)).toMatch(/final templates\/page\.md rule refused-render/);
    const all = await capture(["report", "check", "--repo", root], root);
    expect(all.code, textOf(all)).toBe(1);
    const unknown = await capture(["report", "check", "--repo", root, "--variant", "nope"], root);
    expect(unknown.code, textOf(unknown)).toBe(2);
    expect(textOf(unknown)).toMatch(/nope/);
  });

  it("injects a variant's own graph document when one is declared", async () => {
    const md = `${MD}{{#if sections.delta}}<!-- hatsu:block delta -->
{{{graphMermaid}}}
{{/if}}
`;
    const html = `${HTML}{{#if sections.delta}}<section id="delta">{{{graphMermaid}}}</section>{{/if}}
`;
    const root = writeTree(
      {
        "templates/page.md": md,
        "templates/page.html": html,
        "templates/report-examples/turn.data.json": DATA,
        "templates/report-examples/turn.graph.json": `${JSON.stringify({
          contract: "nen.report.graph/v0.1",
          nodes: [{ id: "page", label: "page", kind: "template", change: "added" }],
          edges: [],
        })}\n`,
      },
      { turn: { template: "page", blocks: ["masthead", "desk", "delta"] } },
    );
    const captured = await capture(["report", "check", "--repo", root], root);
    expect(captured.code, textOf(captured)).toBe(0);
  });

  it("--self-test carries a fixture for each refusal and for wiring", async () => {
    const captured = await capture(["report", "check", "--self-test"]);
    const text = textOf(captured);
    expect(captured.code, text).toBe(0);
    for (const rule of ["refused-render", "unfilled", "block-order", "formats-disagree", "starred-option", "escaping-shows"]) {
      expect(text, rule).toContain(rule);
    }
    expect(text).toMatch(/wiring/);
    expect(text).toMatch(/0 starred/);
    expect(text).toMatch(/2 starred/);
  });

  it("refuses a flag another report verb reads", async () => {
    const root = conformant();
    const captured = await capture(["report", "check", "--repo", root, "--out", "x.html"], root);
    expect(captured.code, textOf(captured)).toBe(2);
    expect(textOf(captured)).toMatch(/--out is not read by 'report check'/);
  });

  it("emits a JSON document under --json", async () => {
    const root = conformant();
    const captured = await capture(["report", "check", "--repo", root, "--json"], root);
    expect(captured.code, textOf(captured)).toBe(0);
    const document = JSON.parse(captured.out.join("\n")) as { contract: string; ok: boolean; variants: string[]; findings: unknown[] };
    expect(document.contract).toBe("nen.report.check/v0.1");
    expect(document.ok).toBe(true);
    expect(document.variants).toEqual(["turn"]);
    expect(document.findings).toEqual([]);
  });
});
