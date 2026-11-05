import { describe, it, expect } from "vitest";
import { ledgerParts, ledgerIndex, assembleLedger, type PrComment } from "./ledger.js";

describe("multipart ledger transport", () => {
  const body = "a".repeat(85607) + "😀";
  const parts = ledgerParts(body, "test");
  const comments: PrComment[] = parts.map((body, i) => ({ body, id: i + 1, login: "owner", editor: null, url: `https://example.test/${i}` }));
  const index = ledgerIndex(body, "test", comments.map(c => c.url));
  it("preserves every character within bounded comments", () => {
    expect(parts.every(p => p.length <= 65536)).toBe(true);
    expect(assembleLedger(index, "test", comments, "owner")).toBe(body);
  });
  it("bounds astral Unicode and rejects malformed indexes", () => {
    expect(ledgerParts("😀".repeat(85607), "test").every(part => part.length <= 65536)).toBe(true);
    expect(() => assembleLedger(index.slice(0, index.indexOf("\n") + 1) + "null", "test", comments, "owner")).toThrow("malformed");
  });
  it("refuses missing and foreign parts by name", () => {
    expect(() => assembleLedger(index, "test", comments.slice(1), "owner")).toThrow("part 1");
    expect(() => assembleLedger(index, "test", comments.map(c => ({ ...c, editor: "foreign" })), "owner")).toThrow("foreign");
  });
  it("refuses changed payloads and reordered markers", () => {
    expect(() => assembleLedger(index, "test", comments.map(c => ({ ...c, body: c.body + "x" })), "owner")).toThrow("encoding");
    expect(() => assembleLedger(index, "test", comments.map(c => ({ ...c, body: parts[0]! })), "owner")).toThrow("part 2");
  });
  it("ignores superseded generations and keeps single-comment transport unchanged", () => {
    expect(assembleLedger(index, "test", [...comments, { ...comments[0]!, url: "old", body: "old" }], "owner")).toBe(body);
    expect(assembleLedger("single", "test", [], "owner")).toBe("single");
  });
});
