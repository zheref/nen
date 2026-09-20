// src/cli/plain.test.ts -- the one helper that stands between a terminal and a
// string somebody else typed (Feitan F4).

import { describe, expect, it } from "vitest";
import { plainBlock, plainLine } from "./plain.js";

const ESC = String.fromCharCode(0x1b);

describe("plainLine", () => {
  it("removes the escape a terminal would EXECUTE, and keeps the text around it", () => {
    // The reproducer: `ESC[2K` in a pull-request title erases the rendered row
    // the reader was about to read.
    expect(plainLine(`${ESC}[2Kfeat(pr): review threads`)).toBe("[2Kfeat(pr): review threads");
    expect(plainLine(`a${ESC}b`)).toBe("ab");
  });

  it("removes every C0, DEL and C1 character, not a hand-picked few", () => {
    for (let code = 0; code <= 0x9f; code += 1) {
      if (code > 0x1f && code < 0x7f) continue; // ordinary printable ASCII
      expect(plainLine(`a${String.fromCharCode(code)}b`), `U+${code.toString(16)} survived`).toBe("ab");
    }
  });

  it("removes a NEWLINE too, because these renderings are one row per line", () => {
    // A two-line field is a row that has broken its own table; a caller who
    // wants the break kept is rendering a block, not a row.
    expect(plainLine("first\nsecond")).toBe("firstsecond");
    expect(plainLine("first\r\nsecond")).toBe("firstsecond");
  });

  it("leaves ordinary text -- including every non-ASCII character -- alone", () => {
    for (const text of ["plain", "acentuación", "日本語", "emoji 🎌", "a|b", "<script>", "  spaced  "]) {
      expect(plainLine(text)).toBe(text);
    }
  });
});

describe("plainBlock", () => {
  it("keeps the newline and the tab a block is made of, and strips every other control byte", () => {
    expect(plainBlock(`a${ESC}[2K\tb\nc`)).toBe("a[2K\tb\nc");
    for (let code = 0; code <= 0x9f; code += 1) {
      if (code > 0x1f && code < 0x7f) continue;
      const expected = code === 0x0a || code === 0x09 ? `a${String.fromCharCode(code)}b` : "ab";
      expect(plainBlock(`a${String.fromCharCode(code)}b`), `U+${code.toString(16)}`).toBe(expected);
    }
  });

  it("strips a carriage return: it rewrites a line in place, which is the complaint", () => {
    expect(plainBlock("first\r\nsecond")).toBe("first\nsecond");
  });
});
