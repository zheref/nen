import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonFilenames,
  checkMirror,
  generateMirror,
  MissingTokenError,
  mirrorReportOk,
  parseCanonValues,
  renderReportMarkdown,
  writeMirror,
  type HeaderTemplate,
} from "./mirror.js";

const HEADER: HeaderTemplate = {
  template: "<!-- GENERATED from {ref}/{scenario}/{file} -- DO NOT EDIT. -->\n",
  pattern: /^<!-- GENERATED from (?<ref>\S+)\/(?<scenario>[^/]+)\/(?<file>\S+) -- DO NOT EDIT\. -->\n/,
};
const NOT_MIRRORED = new Set(["README.md", "placeholders.md"]);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "nen-canon-"));
}

describe("parseCanonValues -- a flat TOKEN: value reader", () => {
  it("parses a scenario field and a values block", () => {
    const text = "scenario: swiftui-tca-uzf-v2\nvalues:\n  APP_NAME: MyApp\n  BUNDLE_ID: com.example.app\n";
    const result = parseCanonValues(text);
    expect(result.scenario).toBe("swiftui-tca-uzf-v2");
    expect(result.values).toEqual({ APP_NAME: "MyApp", BUNDLE_ID: "com.example.app" });
  });

  it("strips a trailing comment and surrounding quotes", () => {
    const text = "values:\n  NAME: \"Quoted Value\" # a comment\n";
    expect(parseCanonValues(text).values["NAME"]).toBe("Quoted Value");
  });

  it("ignores blank and comment-only lines", () => {
    const text = "values:\n\n  # a comment\n  X: 1\n";
    expect(parseCanonValues(text).values).toEqual({ X: "1" });
  });

  it("returns a null scenario and empty values for an empty file", () => {
    expect(parseCanonValues("")).toEqual({ scenario: null, values: {} });
  });
});

describe("canonFilenames -- .md files minus the not-mirrored set", () => {
  it("excludes README.md and placeholders.md, sorted", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "02-b.md"), "");
    writeFileSync(join(dir, "01-a.md"), "");
    writeFileSync(join(dir, "README.md"), "");
    writeFileSync(join(dir, "notes.txt"), "");
    expect(canonFilenames(dir, NOT_MIRRORED)).toEqual(["01-a.md", "02-b.md"]);
  });
});

describe("generateMirror -- substitutes {{TOKEN}} and prepends the header", () => {
  it("substitutes a bound token", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "01-a.md"), "Hello {{NAME}}.\n");
    const generated = generateMirror(dir, { NAME: "World" }, "v1.0.0", "scenario-x", HEADER, NOT_MIRRORED);
    expect(generated.get("01-a.md")).toBe(
      "<!-- GENERATED from v1.0.0/scenario-x/01-a.md -- DO NOT EDIT. -->\nHello World.\n",
    );
  });

  it("throws MissingTokenError, naming the file and the token, for an unbound one", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "01-a.md"), "{{UNBOUND}}");
    expect(() => generateMirror(dir, {}, "v1", "s", HEADER, NOT_MIRRORED)).toThrow(MissingTokenError);
  });
});

describe("writeMirror -- writes only what changed, deletes orphans", () => {
  it("writes new content and reports unchanged files as such", () => {
    const outDir = tempDir();
    writeFileSync(join(outDir, "01-a.md"), "old content");
    const generated = new Map([
      ["01-a.md", "new content"],
      ["02-b.md", "b content"],
    ]);
    const result = writeMirror(outDir, generated, NOT_MIRRORED);
    expect([...result.written].sort()).toEqual(["01-a.md", "02-b.md"]);
    expect(readFileSync(join(outDir, "01-a.md"), "utf8")).toBe("new content");

    const second = writeMirror(outDir, generated, NOT_MIRRORED);
    expect(second.written).toEqual([]);
    expect([...second.unchanged].sort()).toEqual(["01-a.md", "02-b.md"]);
  });

  it("deletes an orphaned mirror file whose canon source is gone", () => {
    const outDir = tempDir();
    writeFileSync(join(outDir, "orphan.md"), "stale");
    const result = writeMirror(outDir, new Map([["01-a.md", "content"]]), NOT_MIRRORED);
    expect(result.deleted).toEqual(["orphan.md"]);
  });

  it("never touches README.md or placeholders.md, or a non-.md file", () => {
    const outDir = tempDir();
    writeFileSync(join(outDir, "README.md"), "keep me");
    writeFileSync(join(outDir, "notes.txt"), "keep me too");
    const result = writeMirror(outDir, new Map([["01-a.md", "content"]]), NOT_MIRRORED);
    expect(result.deleted).toEqual([]);
    expect(readFileSync(join(outDir, "README.md"), "utf8")).toBe("keep me");
  });

  it("creates out-dir if it does not exist yet", () => {
    const outDir = join(tempDir(), "nested", "out");
    const result = writeMirror(outDir, new Map([["01-a.md", "content"]]), NOT_MIRRORED);
    expect(result.written).toEqual(["01-a.md"]);
  });
});

describe("checkMirror -- ok/missing/extra/stale/handEdited", () => {
  function setup(): { rulesDir: string; mirrorDir: string } {
    const rulesDir = tempDir();
    writeFileSync(join(rulesDir, "01-a.md"), "Hello {{NAME}}.\n");
    const mirrorDir = tempDir();
    return { rulesDir, mirrorDir };
  }

  it("reports OK for a byte-identical fresh generation", () => {
    const { rulesDir, mirrorDir } = setup();
    const generated = generateMirror(rulesDir, { NAME: "World" }, "v1", "s", HEADER, NOT_MIRRORED);
    for (const [name, content] of generated) writeFileSync(join(mirrorDir, name), content);
    const report = checkMirror(rulesDir, { NAME: "World" }, mirrorDir, "v1", "s", HEADER, NOT_MIRRORED);
    expect(report.ok).toEqual(["01-a.md"]);
    expect(mirrorReportOk(report)).toBe(true);
  });

  it("reports MISSING when the mirror has no file at all", () => {
    const { rulesDir, mirrorDir } = setup();
    mkdirSync(mirrorDir, { recursive: true });
    const report = checkMirror(rulesDir, { NAME: "World" }, mirrorDir, "v1", "s", HEADER, NOT_MIRRORED);
    expect(report.missing).toEqual(["01-a.md"]);
  });

  it("reports STALE when the header ref lags the pinned ref", () => {
    const { rulesDir, mirrorDir } = setup();
    const generated = generateMirror(rulesDir, { NAME: "World" }, "v0.9.0", "s", HEADER, NOT_MIRRORED);
    for (const [name, content] of generated) writeFileSync(join(mirrorDir, name), content);
    const report = checkMirror(rulesDir, { NAME: "World" }, mirrorDir, "v1.0.0", "s", HEADER, NOT_MIRRORED);
    expect(report.stale).toEqual(["01-a.md"]);
  });

  it("reports HAND_EDITED when the header ref matches but content differs", () => {
    const { rulesDir, mirrorDir } = setup();
    const generated = generateMirror(rulesDir, { NAME: "World" }, "v1", "s", HEADER, NOT_MIRRORED);
    writeFileSync(join(mirrorDir, "01-a.md"), `${generated.get("01-a.md") ?? ""}\nextra hand-added line`);
    const report = checkMirror(rulesDir, { NAME: "World" }, mirrorDir, "v1", "s", HEADER, NOT_MIRRORED);
    expect(report.handEdited).toEqual(["01-a.md"]);
  });

  it("reports HAND_EDITED when there is no generated header at all", () => {
    const { rulesDir, mirrorDir } = setup();
    writeFileSync(join(mirrorDir, "01-a.md"), "Hello World, hand-written.");
    const report = checkMirror(rulesDir, { NAME: "World" }, mirrorDir, "v1", "s", HEADER, NOT_MIRRORED);
    expect(report.handEdited).toEqual(["01-a.md"]);
  });

  // Review finding #16: header.pattern.exec was unanchored, so an UNANCHORED
  // caller pattern (the port dropped the original's implicit ^-anchoring)
  // would match a header-shaped line ANYWHERE in the file. The category this
  // actually flips (not just "not ok", but the WRONG not-ok reason a caller
  // would route differently) is stale vs. handEdited: a hand-written file
  // that happens to quote an OLD ref somewhere below (a changelog entry, a
  // worked example) has no real header at all -- correctly HAND_EDITED -- but
  // an unanchored whole-file search finds that quoted old ref, sees it does
  // not match --ref, and reports STALE ("just needs regenerating") instead,
  // which sends a caller who trusts that category to the wrong remediation.
  it("reports HAND_EDITED, never STALE, when the real header is gone but an OLD-ref-shaped line survives further down, even with an UNANCHORED caller pattern", () => {
    const { rulesDir, mirrorDir } = setup();
    // Deliberately unanchored -- no leading ^ -- exactly the caller mistake
    // the finding describes (--header-pattern has no requirement to anchor).
    const unanchored: HeaderTemplate = {
      template: HEADER.template,
      pattern: /<!-- GENERATED from (?<ref>\S+)\/(?<scenario>[^/]+)\/(?<file>\S+) -- DO NOT EDIT\. -->\n/,
    };
    writeFileSync(
      join(mirrorDir, "01-a.md"),
      // No generated header on line 1 -- a human wrote this by hand -- but a
      // header-shaped line quoting an OLD ref (v0.9.0, not the v1 pinned
      // below) appears further down, e.g. a changelog note.
      `Hello World, hand-written.\n\nPreviously:\n<!-- GENERATED from v0.9.0/s/01-a.md -- DO NOT EDIT. -->\n`,
    );
    const report = checkMirror(rulesDir, { NAME: "World" }, mirrorDir, "v1", "s", unanchored, NOT_MIRRORED);
    expect(report.handEdited).toEqual(["01-a.md"]);
    expect(report.stale).toEqual([]);
    expect(report.ok).toEqual([]);
  });

  it("reports EXTRA for a mirror file with no canon source", () => {
    const { rulesDir, mirrorDir } = setup();
    const generated = generateMirror(rulesDir, { NAME: "World" }, "v1", "s", HEADER, NOT_MIRRORED);
    for (const [name, content] of generated) writeFileSync(join(mirrorDir, name), content);
    writeFileSync(join(mirrorDir, "orphan.md"), "orphaned");
    const report = checkMirror(rulesDir, { NAME: "World" }, mirrorDir, "v1", "s", HEADER, NOT_MIRRORED);
    expect(report.extra).toEqual(["orphan.md"]);
    expect(mirrorReportOk(report)).toBe(false);
  });
});

describe("renderReportMarkdown", () => {
  it("renders a table row per non-OK entry", () => {
    const markdown = renderReportMarkdown({ ok: [], missing: ["a.md"], extra: [], stale: [], handEdited: [] });
    expect(markdown).toContain("| `a.md` |");
  });

  it("reports no drift when everything is OK", () => {
    expect(renderReportMarkdown({ ok: ["a.md"], missing: [], extra: [], stale: [], handEdited: [] })).toMatch(/No drift/);
  });
});
