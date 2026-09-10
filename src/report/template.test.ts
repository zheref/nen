// src/report/template.test.ts -- the substitution language, from both sides.
//
// THE REFUSALS ARE THE POINT. A template engine's happy path is easy and
// uninteresting; what this module exists for is the four things it says no to --
// a token the data has not got, a tag this language does not have, a block left
// open, and a value with no text form -- because each of those, silently
// allowed, publishes a report with a hole in it.

import { describe, expect, it } from "vitest";
import { escapeHtml, parseTemplate, renderTemplate, TemplateError, truthy } from "./template.js";

function fill(template: string, data: unknown): string {
  return renderTemplate(parseTemplate(template), data);
}

describe("value tags", () => {
  it("substitutes a dotted path", () => {
    expect(fill("on {{branch}} against {{base}}", { branch: "x", base: "main" })).toBe("on x against main");
    expect(fill("{{coverage.total.lines.percent}}%", { coverage: { total: { lines: { percent: 87.5 } } } })).toBe("87.5%");
  });

  it("HTML-escapes by default and leaves {{{ }}} raw", () => {
    const data = { subject: `fix <b> & "quotes" & 'apostrophes'` };
    expect(fill("{{subject}}", data)).toBe("fix &lt;b&gt; &amp; &quot;quotes&quot; &amp; &#39;apostrophes&#39;");
    expect(fill("{{{subject}}}", data)).toBe(`fix <b> & "quotes" & 'apostrophes'`);
  });

  it("escapes the ampersand FIRST, so an escape is never escaped twice", () => {
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
  });

  it("renders a present null as the empty string -- the document's own 'nothing to say'", () => {
    expect(fill("[{{coverage}}]", { coverage: null })).toBe("[]");
  });

  it("renders numbers and booleans, and refuses an object or a list whole", () => {
    expect(fill("{{n}} {{b}}", { n: 0, b: false })).toBe("0 false");
    expect(() => fill("{{rows}}", { rows: [1, 2] })).toThrow(/a list of 2/);
    expect(() => fill("{{o}}", { o: { a: 1 } })).toThrow(/an object \(a\)/);
  });

  it("refuses a token the data has not got, NAMING it", () => {
    expect(() => fill("{{laststop}}", { lastStop: null })).toThrow(TemplateError);
    expect(() => fill("{{laststop}}", { lastStop: null })).toThrow(/'laststop', which the data document has not got/);
  });

  it("refuses a MISSING LATER SEGMENT rather than falling out to an outer scope", () => {
    // The outer scope has `coverage`; the row does too, and the row's has no
    // `lines`. Falling through would render the document's number on a row that
    // has none -- the blank this module refuses, wearing a value.
    const data = { coverage: { lines: 90 }, rows: [{ coverage: {} }] };
    expect(() => fill("{{#each rows}}{{coverage.lines}}{{/each}}", data)).toThrow(/'coverage.lines'/);
  });

  it("does not resolve a prototype key", () => {
    expect(() => fill("{{constructor}}", {})).toThrow(/has not got/);
  });
});

describe("{{#each}}", () => {
  it("iterates rows, with {{.}} for a scalar and {{@index}} for the position", () => {
    expect(fill("{{#each xs}}{{@index}}:{{.}} {{/each}}", { xs: ["a", "b"] })).toBe("0:a 1:b ");
  });

  it("resolves a row's own field before the document's", () => {
    const data = { name: "outer", rows: [{ name: "a" }, { name: "b" }] };
    expect(fill("{{#each rows}}{{name}}{{/each}}", data)).toBe("ab");
  });

  it("walks OUT to the document for a field the row has not got", () => {
    const data = { branch: "feat/x", rows: [{ sha: "a" }, { sha: "b" }] };
    expect(fill("{{#each rows}}{{branch}}/{{sha}} {{/each}}", data)).toBe("feat/x/a feat/x/b ");
  });

  it("nests", () => {
    const data = { groups: [{ items: ["a", "b"] }, { items: ["c"] }] };
    expect(fill("{{#each groups}}[{{#each items}}{{.}}{{/each}}]{{/each}}", data)).toBe("[ab][c]");
  });

  it("renders nothing for an empty list", () => {
    expect(fill("x{{#each xs}}{{.}}{{/each}}y", { xs: [] })).toBe("xy");
  });

  it("refuses a non-list, rather than quietly rendering nothing", () => {
    expect(() => fill("{{#each xs}}{{.}}{{/each}}", { xs: { a: 1 } })).toThrow(/needs a list/);
  });

  it("refuses {{.}} and {{@index}} outside an each block", () => {
    expect(() => fill("{{.}}", { a: 1 })).toThrow(/'\.', which the data document has not got/);
    expect(() => fill("{{@index}}", { a: 1 })).toThrow(/'@index'/);
  });
});

describe("{{#if}}", () => {
  it("renders the body only when the key is truthy", () => {
    expect(fill("{{#if coverage}}yes{{/if}}", { coverage: { a: 1 } })).toBe("yes");
    expect(fill("{{#if coverage}}yes{{/if}}", { coverage: null })).toBe("");
  });

  it("treats an EMPTY LIST as false -- 'no rows' is what the block is written for", () => {
    expect(truthy([])).toBe(false);
    expect(truthy([1])).toBe(true);
    expect(fill("{{#if rows}}some{{/if}}", { rows: [] })).toBe("");
  });

  it("treats 0, NaN, '' and false as false and an empty object as true", () => {
    expect([0, Number.NaN, "", false, null, undefined].map(truthy)).toEqual([false, false, false, false, false, false]);
    expect(truthy({})).toBe(true);
  });

  it("refuses a key the data has not got -- a missing key is a disagreement, not a false", () => {
    expect(() => fill("{{#if nope}}x{{/if}}", {})).toThrow(/'nope'/);
  });
});

describe("what this language refuses to be", () => {
  it("refuses a tag it does not have, listing the whole language", () => {
    for (const tag of ["{{#unless x}}{{/unless}}", "{{> partial}}", "{{! comment }}"]) {
      expect(() => parseTemplate(tag)).toThrow(/is not a tag this language has/);
    }
  });

  it("refuses an unclosed block, naming it", () => {
    expect(() => parseTemplate("{{#each xs}}{{.}}")).toThrow(/'\{\{#each xs\}\}' is never closed/);
  });

  it("refuses a mismatched close, naming both", () => {
    expect(() => parseTemplate("{{#each xs}}{{/if}}")).toThrow(/closes a '\{\{#each xs\}\}'/);
  });

  it("refuses a close with nothing open", () => {
    expect(() => parseTemplate("{{/each}}")).toThrow(/closes a block that was never opened/);
  });

  it("refuses a token that is not a dotted path", () => {
    expect(() => parseTemplate("{{a b}}")).toThrow(/is not a token/);
    expect(() => parseTemplate("{{{1}}}")).toThrow(/is not a token/);
  });
});

describe("the token list", () => {
  it("is every token, in first-appearance order, de-duplicated", () => {
    const parsed = parseTemplate(
      "{{branch}} {{branch}} {{#if coverage}}{{coverage.total.lines.percent}}{{/if}}{{#each commits}}{{@index}}{{sha}}{{/each}}{{{raw}}}",
    );
    expect(parsed.tokens).toEqual([
      "branch",
      "coverage",
      "coverage.total.lines.percent",
      "commits",
      "@index",
      "sha",
      "raw",
    ]);
  });
});

describe("bytes outside the tags are carried through untouched", () => {
  it("keeps CRLF, leading text and trailing text exactly", () => {
    expect(fill("a\r\n{{x}}\r\nb", { x: "1" })).toBe("a\r\n1\r\nb");
  });

  it("leaves a lone brace alone", () => {
    expect(fill("{ {{x}} }", { x: "1" })).toBe("{ 1 }");
  });
});
