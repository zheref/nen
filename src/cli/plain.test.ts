// src/cli/plain.test.ts -- the one helper that stands between a terminal and a
// string somebody else typed (Feitan F4).

import { describe, expect, it } from "vitest";
import { escapeInvisibleJson, plainBlock, plainLine } from "./plain.js";

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

describe("plainLine -- invisible characters (zheref/nen#340)", () => {
  const BIDI = [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
  const ZERO_WIDTH = [0x200b, 0x200c, 0x200d, 0xfeff];

  it("removes every Unicode bidi control, so a name cannot be reordered on screen", () => {
    for (const code of BIDI) {
      expect(plainLine(`a${String.fromCharCode(code)}b`), `U+${code.toString(16)} survived`).toBe("ab");
    }
    // The classic: an RLO makes `NZ-NNR1<RLO>gpj.exe` read as `NZ-NNR1exe.jpg`.
    expect(plainLine(`NZ-NNR1${String.fromCharCode(0x202e)}gpj.exe`)).toBe("NZ-NNR1gpj.exe");
  });

  it("removes every zero-width character, so two names cannot look alike", () => {
    for (const code of ZERO_WIDTH) {
      expect(plainLine(`pool${String.fromCharCode(code)}-a`), `U+${code.toString(16)} survived`).toBe("pool-a");
    }
  });

  it("keeps the neighbours of those ranges, which are ordinary text", () => {
    // U+2028-2029 and U+206A-206F joined the class on zheref/nen#515 (Feitan 2).
    for (const code of [0x200a, 0x2010, 0x2027, 0x202f, 0x2065, 0x2070, 0xfefe]) {
      const text = `a${String.fromCharCode(code)}b`;
      expect(plainLine(text), `U+${code.toString(16)} was stripped`).toBe(text);
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

describe("escapeInvisibleJson -- one class for both renderings (zheref/nen#515 Feitan 2)", () => {
  const codes = [0x00ad, 0x061c, 0x180e, 0x200b, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x206f, 0xfeff];

  it("writes each as its \\uXXXX escape, parses back to the same value, and plainLine strips each", () => {
    for (const code of codes) {
      const value = { text: `a${String.fromCharCode(code)}b` };
      const escaped = escapeInvisibleJson(JSON.stringify(value));
      expect(escaped.includes(String.fromCharCode(code)), `U+${code.toString(16)}`).toBe(false);
      expect(JSON.parse(escaped)).toEqual(value);
      expect(plainLine(value.text)).toBe("ab");
    }
  });

  it("is idempotent", () => {
    const once = escapeInvisibleJson(JSON.stringify({ t: "\u202E" }));
    expect(escapeInvisibleJson(once)).toBe(once);
  });
});
