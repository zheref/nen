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
    expect(Object.keys(document)).toEqual(["contract", "template", "out", "tokens", "written"]);
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
