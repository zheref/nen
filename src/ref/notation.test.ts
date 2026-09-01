import { describe, expect, it } from "vitest";
import { formatRef, isRef, KIND_GLYPH, parseRef, RefError, STATE_MARK } from "./notation.js";

describe("parseRef", () => {
  it("parses <CODE>-<IS|PR>-#<N>", () => {
    const ref = parseRef("XX-PR-#42");
    expect(ref).toEqual({ ref: "XX-PR-#42", code: "XX", kind: "PR", number: 42, glyph: KIND_GLYPH.PR });
  });

  it("refuses a bare number, never guessing which repo or kind", () => {
    expect(() => parseRef("#42")).toThrow(RefError);
    expect(() => parseRef("42")).toThrow(RefError);
  });

  it("refuses a lowercase code -- the notation is uppercase only", () => {
    expect(() => parseRef("xx-PR-#42")).toThrow(RefError);
  });
});

describe("isRef", () => {
  it("is true only for the exact notation", () => {
    expect(isRef("XX-IS-#1")).toBe(true);
    expect(isRef("not a ref")).toBe(false);
  });
});

describe("formatRef", () => {
  it("renders the glyph, the token, and the state mark", () => {
    const formatted = formatRef({ code: "XX", kind: "IS", number: 7, state: "merged" });
    expect(formatted.ref).toBe("XX-IS-#7");
    expect(formatted.mark).toBe(STATE_MARK["merged"]);
    expect(formatted.token).toBe(`${KIND_GLYPH.IS} XX-IS-#7 ${STATE_MARK["merged"]}`);
  });

  it("renders NO mark for 'open' -- a fact, not an absence", () => {
    const formatted = formatRef({ code: "XX", kind: "IS", number: 7, state: "open" });
    expect(formatted.mark).toBe("");
    expect(formatted.unknownState).toBeNull();
  });

  it("reports an unknown state rather than silently rendering as open", () => {
    const formatted = formatRef({ code: "XX", kind: "IS", number: 7, state: "frobnicated" });
    expect(formatted.mark).toBe("");
    expect(formatted.unknownState).toBe("frobnicated");
  });

  it("wraps the WHOLE token as a link when a url is given", () => {
    const formatted = formatRef({ code: "XX", kind: "PR", number: 1, url: "https://example.invalid/1" });
    expect(formatted.token).toContain("[XX-PR-#1](https://example.invalid/1)");
  });

  it("--no-glyphs emits the bare notation", () => {
    const formatted = formatRef({ code: "XX", kind: "PR", number: 1, glyphs: false });
    expect(formatted.token).toBe("XX-PR-#1");
  });

  it("refuses a code that is not two or three uppercase letters", () => {
    expect(() => formatRef({ code: "x", kind: "IS", number: 1 })).toThrow(RefError);
  });

  it("refuses a non-positive or non-integer number", () => {
    expect(() => formatRef({ code: "XX", kind: "IS", number: 0 })).toThrow(RefError);
    expect(() => formatRef({ code: "XX", kind: "IS", number: 1.5 })).toThrow(RefError);
  });
});
