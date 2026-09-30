// src/commit/linelength.test.ts -- commitlint's body-max-line-length and
// footer-max-line-length semantics, ported from 21.2.3, and the wrap `commit
// format` applies to --body (zheref/nen#290).

import { describe, expect, it } from "vitest";
import { lineLengthFindings, type LineLengthRule, type LineLengthRules } from "./bodywidth.js";
import {
  commitlintSections,
  CONVENTIONAL_MAX_LINE_LENGTH,
  lineFits,
  opensFooter,
  parseLineLengthTuple,
  unwrappable,
  URL_EXEMPTION,
  usableWidth,
  wrapBody,
  wrapLine,
  type Section,
} from "./linelength.js";

const WIDTHS = { body: 100, footer: 100 } as const;

/** Words of `size` letters, `count` of them, space-joined. */
const words = (count: number, size = 9): string => Array.from({ length: count }, (_, index): string => String.fromCharCode(97 + (index % 26)).repeat(size)).join(" ");

describe("parseLineLengthTuple -- commitlint's shape refused, its width read as commitlint reads it (review M1)", () => {
  it("reads [0], a level-1 and a level-2 rule, and ignores the condition as the upstream rule does", () => {
    expect(parseLineLengthTuple([0])).toEqual({ ok: true, spec: { level: 0 } });
    expect(parseLineLengthTuple([0, "always", "anything"])).toEqual({ ok: true, spec: { level: 0 } });
    expect(parseLineLengthTuple([1, "always", 72])).toEqual({ ok: true, spec: { level: 1, max: 72, stated: 72 } });
    expect(parseLineLengthTuple([2, "never", 100])).toEqual({ ok: true, spec: { level: 2, max: 100, stated: 100 } });
  });

  it.each([
    ['"100"', "100", 100],
    ['" 100 "', " 100 ", 100],
    ["[100]", [100], 100],
    ['"Infinity"', "Infinity", Number.POSITIVE_INFINITY],
    ["no width at all", undefined, 0],
    ["null", null, 0],
    ['""', "", 0],
    ["false", false, 0],
    ["true", true, 1],
    ["0.5", 0.5, 0.5],
    ["-5", -5, -5],
    ['"abc"', "abc", Number.NaN],
    ["{}", {}, Number.NaN],
  ])("never refuses the width %s -- commitlint compares each line against %j as JavaScript's <= coerces it", (_name, stated, max) => {
    const tuple = stated === undefined ? [2, "always"] : [2, "always", stated];
    const result = parseLineLengthTuple(tuple);
    expect(result.ok).toBe(true);
    if (result.ok && result.spec.level !== 0) {
      expect(result.spec.max).toBe(max);
      expect(result.spec.stated).toEqual(stated);
    }
  });

  it.each([
    ["not an array", 100, ""],
    ["a bad level", [3, "always", 100], "[0]"],
    ["a wrong length", [2, "always", 100, 1], ""],
    ["a bad condition", [2, "sometimes", 100], "[1]"],
  ])("refuses %s -- a shape commitlint itself rejects -- pointing at it", (_name, value, at) => {
    const result = parseLineLengthTuple(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.at).toBe(at);
      expect(result.refusedAtLoad).toBe(true);
    }
    const shape = parseLineLengthTuple("100");
    expect(!shape.ok && shape.problem).toBe("must be an array ([level, 'always'|'never', max])");
  });

  it("calls a width usable for wrapping only when it is at least 1", () => {
    expect([1, 72, Number.POSITIVE_INFINITY].map(usableWidth)).toEqual([true, true, true]);
    expect([0, 0.5, -5, Number.NaN].map(usableWidth)).toEqual([false, false, false, false]);
  });
});

describe("lineFits -- @commitlint/ensure 21.2.3's max-line-length, per line", () => {
  it("passes a line at the limit and fails one past it", () => {
    expect(lineFits("x".repeat(100), 100)).toBe(true);
    expect(lineFits("x".repeat(101), 100)).toBe(false);
  });

  it("exempts a line holding an http(s) URL ANYWHERE, whatever else it holds", () => {
    expect(URL_EXEMPTION.source).toBe("\\bhttps?:\\/\\/\\S+");
    expect(lineFits(`${"prose ".repeat(40)}https://example.com/x`, 100)).toBe(true);
    expect(lineFits(`see http://a.b ${"y".repeat(200)}`, 100)).toBe(true);
    // Not a URL to upstream's pattern: no scheme, another scheme, a word glued before it.
    expect(lineFits(`www.example.com/${"p".repeat(120)}`, 100)).toBe(false);
    expect(lineFits(`ftp://example.com/${"p".repeat(120)}`, 100)).toBe(false);
    expect(lineFits(`xhttps://example.com/${"p".repeat(120)}`, 100)).toBe(false);
  });

  it("measures in UTF-16 code units, as JavaScript's String length does", () => {
    expect(lineFits("é".repeat(100), 100)).toBe(true);
    expect(lineFits("😀".repeat(50), 100)).toBe(true);
    expect(lineFits("😀".repeat(51), 100)).toBe(false);
  });

  it("judges the widths commitlint cannot wrap to exactly as its comparison does", () => {
    expect([lineFits("", 0), lineFits("x", 0), lineFits("https://e.com", 0)]).toEqual([true, false, true]);
    expect([lineFits("", Number.NaN), lineFits("", -1), lineFits("https://e.com", Number.NaN)]).toEqual([false, false, true]);
  });
});

describe("commitlintSections -- which lines conventional-commits-parser 7.1.2 calls body and footer", () => {
  it("numbers body lines from the header, and a nen-formatted trailer block is footer", () => {
    const sections = commitlintSections("fix: x\n\nfirst\nsecond\n\nHatsu-Agent: kurapika\n");
    // The blank lines at a section's edges are trimmed, as the parser trims them.
    expect(sections.body.map((line) => [line.number, line.text])).toEqual([
      [3, "first"],
      [4, "second"],
    ]);
    expect(commitlintSections("fix: x\n\na\n\nb\n\n").body.map((line) => line.text)).toEqual(["a", "", "b"]);
    expect(sections.footer).toEqual([{ number: 6, text: "Hatsu-Agent: kurapika", section: "footer" }]);
  });

  it("opens the footer at the FIRST footer token or note, and keeps everything after it there", () => {
    const sections = commitlintSections("fix: x\n\nprose\nCloses #290 and a sentence\nmore prose\n\nBREAKING CHANGE: gone");
    expect(sections.body.map((line) => line.text)).toEqual(["prose"]);
    expect(sections.footer.map((line) => line.text)).toEqual(["Closes #290 and a sentence", "more prose", "", "BREAKING CHANGE: gone"]);
    for (const opener of ["BREAKING CHANGE: x", "BREAKING-CHANGE: x", "* BREAKING CHANGE: x", "Note: this", "refs #12", "Reviewed-by: someone"]) {
      expect(opensFooter(opener), opener).toBe(true);
    }
    for (const prose of ["Note:", "Note:this", "a sentence with Closes #1 in it", "  Refs: #1", "#12 at the start"]) {
      expect(opensFooter(prose), prose).toBe(false);
    }
  });

  it("drops what `commitlint --edit` never sees: '#' comment lines, the scissors and after, gpg lines -- and trailing newlines", () => {
    const message = [
      "fix: x",
      "",
      "kept",
      `# ${"c".repeat(200)}`,
      "gpg: Signature made",
      "also kept",
      "# ------------------------ >8 ------------------------",
      "diff --git a/x b/x",
      "",
      "",
    ].join("\n");
    const sections = commitlintSections(message);
    expect(sections.body.map((line) => line.text)).toEqual(["kept", "also kept"]);
    expect(sections.footer).toEqual([]);
    expect(commitlintSections("")).toEqual({ body: [], footer: [] });
    expect(commitlintSections("\n\nfix: x\n\nbody").body.map((line) => line.number)).toEqual([5]);
  });
});

describe("wrapLine -- at spaces and tabs, never inside a word", () => {
  it("fills each line up to the width and no further", () => {
    const line = words(20); // 20 nine-letter words, 199 characters
    const pieces = wrapLine(line, 100);
    expect(pieces).toEqual([words(10), words(20).slice(100)]);
    expect(pieces.every((piece) => piece.length <= 100)).toBe(true);
    expect(pieces.join(" ")).toBe(line);
  });

  it("keeps a URL, or any unbroken token, whole on a line of its own", () => {
    const url = `https://github.com/zheref/nen/issues/290?${"q".repeat(120)}`;
    const pieces = wrapLine(`${words(5)} ${url} ${words(3)}`, 100);
    expect(pieces).toEqual([words(5), url, words(3)]);
    expect(wrapLine("x".repeat(150), 100)).toEqual(["x".repeat(150)]);
  });

  it("keeps a list item's marker and hangs its continuation under the item's text", () => {
    expect(wrapLine(`- ${words(12)}`, 60)).toEqual([`- ${words(5)}`, `  ${words(12).slice(50, 99)}`, `  ${words(12).slice(100)}`]);
    const numbered = wrapLine(`  12. ${words(8)}`, 50);
    expect(numbered[0]?.startsWith("  12. ")).toBe(true);
    expect(numbered.slice(1).every((piece) => piece.startsWith("      ") && !piece.startsWith("       "))).toBe(true);
  });

  it("leaves preformatted text -- four spaces, or a tab -- exactly as it is", () => {
    const code = `    ${"const x = 1; ".repeat(12)}`;
    expect(wrapLine(code, 100)).toEqual([code]);
    const tabbed = `\t${"y ".repeat(80)}`;
    expect(wrapLine(tabbed, 100)).toEqual([tabbed]);
  });

  it("never breaks at a no-break space, even where the greedy break lands on one (review F3)", () => {
    // Under /\s+/ the break would fall at the NBSP: "a…a kept" is exactly 60.
    expect(`${"a".repeat(55)} kept`.length).toBe(60);
    expect(wrapLine(`${"a".repeat(55)} kept\u00a0together`, 60)).toEqual(["a".repeat(55), "kept\u00a0together"]);
  });

  it("keeps the whitespace between words on one line as it was, breaks at a tab, and never at a no-break space (review nit)", () => {
    const pieces = wrapLine(`two  spaces\tand a tab ${"a".repeat(40)} kept\u00a0together ${"b".repeat(30)}`, 60);
    expect(pieces).toEqual(["two  spaces\tand a tab", `${"a".repeat(40)} kept\u00a0together`, "b".repeat(30)]);
  });

  it("never opens a new line with a footer token, a note, a '#' or gpg: -- the break moves a word earlier", () => {
    const before = "a".repeat(80);
    for (const tail of ["Closes #290 now", "#290 is the issue", "Note: this matters", "BREAKING CHANGE: the flag", "gpg: sig"]) {
      const pieces = wrapLine(`${before} word ${tail} ${"z".repeat(40)}`, 100);
      for (const piece of pieces.slice(1)) {
        expect(opensFooter(piece) || piece.startsWith("#") || piece.startsWith("gpg:"), `${tail}: ${JSON.stringify(pieces)}`).toBe(false);
      }
      expect(pieces.join(" ")).toBe(`${before} word ${tail} ${"z".repeat(40)}`);
    }
  });

  it("moves the break LATER when no earlier one is safe, and leaves the line long rather than open a footer (review L1)", () => {
    // The only break inside the width would open the second line with '#1'.
    expect(wrapLine(`${"a".repeat(95)} #1`, 96)).toEqual([`${"a".repeat(95)} #1`]);
    // "Refs: xxxx #1" and "xxxx #1" both open a footer, so the first safe break is past them.
    expect(wrapLine("cccc Refs: xxxx #1 and more words here", 15)).toEqual(["cccc Refs: xxxx #1", "and more words", "here"]);
  });

  it("returns a whitespace-only line, and a one-word line, as it is", () => {
    expect(wrapLine("   ", 1)).toEqual(["   "]);
    expect(wrapLine("- word", 3)).toEqual(["- word"]);
  });
});

describe("unwrappable -- why the wrap cannot bring a line under its width", () => {
  it("names preformatted text, a word longer than the width, and a line with no safe break; null when a break does it", () => {
    expect(unwrappable("    code", 3)).toBe("preformatted");
    expect(unwrappable("x".repeat(200), 100)).toBe("unbroken");
    expect(unwrappable(`- ${"x".repeat(200)}`, 100)).toBe("unbroken");
    expect(unwrappable(`prefix ${"x".repeat(200)} suffix`, 100)).toBe("unbroken");
    expect(unwrappable(`${"a".repeat(95)} #1`, 96)).toBe("unsafe");
    // A footer-opening line keeps its token with the next word; when that word is longer than the width, IT is the overflow (F4).
    expect(unwrappable(`Refs: ${"t".repeat(120)}`, 100)).toBe("unbroken");
    expect(unwrappable("Note: ab cd", 6)).toBe("unsafe");
    expect(unwrappable(words(20), 100)).toBeNull();
  });
});

describe("wrapBody -- only the lines a rule would refuse, section by section", () => {
  it("returns the SAME string when every line is within its limit -- byte for byte, CRLF and all", () => {
    const body = `first paragraph\r\n\r\n- item\r\n${"x".repeat(100)}\r\nsee https://e.com/${"u".repeat(200)}`;
    const wrapped = wrapBody(body, WIDTHS);
    expect(wrapped).toEqual({ text: body, rewrapped: [], leftOver: [] });
  });

  it("rewraps an over-long line, keeps blank-line paragraph breaks, and reports what it rewrote", () => {
    const body = `${words(20)}\n\nshort\n\n${words(3)}`;
    const wrapped = wrapBody(body, WIDTHS);
    expect(wrapped.text).toBe(`${words(10)}\n${words(20).slice(100)}\n\nshort\n\n${words(3)}`);
    expect(wrapped.rewrapped).toEqual([{ index: 0, length: 199, section: "body" }]);
    expect(wrapped.leftOver).toEqual([]);
  });

  it("keeps each line's own terminator: a rewrapped CRLF line stays CRLF, the rest untouched (review nit)", () => {
    const body = `${words(20)}\r\nnext\nlast ${words(15)}`;
    const wrapped = wrapBody(body, WIDTHS);
    expect(wrapped.text).toBe(`${words(10)}\r\n${words(20).slice(100)}\r\nnext\nlast ${words(15).slice(0, 89)}\n${words(15).slice(90)}`);
    // A bare CR stays inside its line, as commitlint's /\r?\n/ split leaves it.
    expect(wrapBody(`a\rb ${words(12)}`, WIDTHS).text).toBe(`a\rb ${words(12).slice(0, 89)}\n${words(12).slice(90)}`);
  });

  it("wraps a line in the footer section to the FOOTER's width", () => {
    const body = `${words(8)}\nRefs #1 ${words(8)}`;
    const wrapped = wrapBody(body, { body: 100, footer: 40 });
    const lines = wrapped.text.split("\n");
    expect(lines[0]).toBe(words(8));
    expect(lines.slice(1).every((line) => line.length <= 40)).toBe(true);
    expect(wrapped.rewrapped).toEqual([{ index: 1, length: 87, section: "footer" }]);
  });

  it("never wraps a section whose width is null -- a rule turned off, or one no wrap can meet (review L2)", () => {
    const body = `${words(20)}\nRefs #1 ${words(20)}`;
    expect(wrapBody(body, { body: null, footer: null })).toEqual({ text: body, rewrapped: [], leftOver: [] });
    expect(wrapBody(body, { body: null, footer: 100 }).text.split("\n")[0]).toBe(words(20));
  });

  it("reports what it could not shorten, measured under the section it parses into -- and never touches a comment line", () => {
    const body = [`prefix ${"w".repeat(120)} suffix`, `    ${"p".repeat(120)}`, `# ${"c".repeat(120)}`].join("\n");
    const wrapped = wrapBody(body, WIDTHS);
    expect(wrapped.text.split("\n")).toEqual(["prefix", "w".repeat(120), "suffix", `    ${"p".repeat(120)}`, `# ${"c".repeat(120)}`]);
    expect(wrapped.leftOver).toEqual([
      { index: 1, text: "w".repeat(120), section: "body", why: "unbroken" },
      { index: 3, text: `    ${"p".repeat(120)}`, section: "body", why: "preformatted" },
    ]);
    // Under 96 this body line has no safe break: left whole, and reported as body.
    const unsafe = wrapBody(`x ${"a".repeat(93)} #1`, { body: 96, footer: 96 });
    expect(unsafe.leftOver).toEqual([{ index: 0, text: `x ${"a".repeat(93)} #1`, section: "body", why: "unsafe" }]);
    // A line that opens the footer keeps its token with the word after it (the property test found this).
    expect(wrapBody("Note:\tCloses\tthe\tissue", { body: 100, footer: 12 }).text).toBe("Note:\tCloses\nthe\tissue");
    // Every word fits 6, but the token must keep the word after it: no safe break.
    expect(wrapBody("Note: ab cd", { body: 100, footer: 6 }).leftOver).toEqual([{ index: 0, text: "Note: ab", section: "footer", why: "unsafe" }]);
    // A word longer than the width is the overflow, even on a footer-opening line (F4).
    expect(wrapBody("Note: Closes", { body: 100, footer: 4 }).leftOver).toEqual([{ index: 0, text: "Note: Closes", section: "footer", why: "unbroken" }]);
    expect(wrapped.rewrapped).toEqual([{ index: 0, length: 134, section: "body" }]);
  });

  it("floors a fractional width to wrap, and judges the exact one", () => {
    const wrapped = wrapBody(words(20), { body: 100.5, footer: 100 });
    expect(wrapped.text.split("\n")[0]).toBe(words(10));
    expect(CONVENTIONAL_MAX_LINE_LENGTH).toBe(100);
  });
});

describe("wrapBody's contract, as a property (review L1): nothing left over means commitlint accepts it, and wrapping again changes nothing", () => {
  /** A seeded linear congruential generator, so a failure names a reproducible case. */
  function generator(seed: number): (n: number) => number {
    let state = seed;
    return (n: number): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
  }
  const POOL = [
    "the", "capture", "prompt", "Inbox", "Closes", "#290", "Refs:", "Refs", "Note:", "BREAKING", "CHANGE:", "BREAKING-CHANGE:", "*", "-",
    "gpg:", "a".repeat(40), "x", "word-with-dash", "Key:", "#", "é", "😀", "https://ex.com/a", `http://x.y/${"z".repeat(30)}`, "no break", "1.",
  ];
  const LEADS = ["", "", "", "  ", "    ", "- ", "1. ", "# ", "\t", "* "];
  const WIDTH_CHOICES = [15, 30, 40, 72, 100, null] as const;
  const ruleAt = (width: number | null): LineLengthRule =>
    width === null ? { kind: "off", file: "f" } : { kind: "rule", file: "f", origin: "rules", level: 2, max: width, stated: width };
  /** The lines that open the footer, or that commitlint never sees -- the ones the wrap must never create. */
  const markers = (text: string): number =>
    text.split(/\r?\n/).filter((line) => opensFooter(line) || line.startsWith("#") || /^\s*gpg:/.test(line)).length;

  it("holds for 3000 generated bodies, under body and footer widths drawn independently", () => {
    const next = generator(290);
    for (let run = 0; run < 3000; run += 1) {
      const lines = Array.from({ length: 1 + next(6) }, (): string => {
        if (next(5) === 0) return "";
        const count = next(24);
        const parts = Array.from({ length: count }, (): string => POOL[next(POOL.length)] ?? "x");
        return (LEADS[next(LEADS.length)] ?? "") + parts.join([" ", " ", " ", "  ", "\t"][next(5)] ?? " ");
      });
      const body = lines.join(next(4) === 0 ? "\r\n" : "\n");
      const widths: Record<Section, number | null> = { body: WIDTH_CHOICES[next(6)] ?? null, footer: WIDTH_CHOICES[next(6)] ?? null };
      const wrapped = wrapBody(body, widths);
      const label = JSON.stringify({ run, body, widths });
      // The words, in order, are the caller's.
      expect(wrapped.text.split(/\s+/).filter(Boolean), label).toEqual(body.split(/\s+/).filter(Boolean));
      // No line the wrap made opens a footer, or is one commitlint never sees.
      expect(markers(wrapped.text), label).toBe(markers(body));
      // Every left-over line really is over its section's width.
      for (const line of wrapped.leftOver) {
        const width = widths[line.section];
        expect(width !== null && !lineFits(line.text, width), label).toBe(true);
      }
      if (wrapped.leftOver.length > 0) continue;
      const rules: LineLengthRules = { body: ruleAt(widths.body), footer: ruleAt(widths.footer), shadowed: null };
      expect(lineLengthFindings(`fix: x\n\n${wrapped.text}\n`, rules).refusals, label).toEqual([]);
      expect(wrapBody(wrapped.text, widths).text, label).toBe(wrapped.text);
    }
  });
});
