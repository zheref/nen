import { describe, expect, it } from "vitest";
import { ledgerLine, parseLedger, type LedgerEntry } from "./ledger.js";

const ENTRY: LedgerEntry = {
  object: "XX-PR-#12",
  label: "wake",
  time: "2026-01-01T00:00:00Z",
  run: true,
  reason: null,
};

describe("ledgerLine / parseLedger", () => {
  it("round-trips one entry", () => {
    const line = ledgerLine(ENTRY);
    const parsed = parseLedger(line + "\n");
    expect(parsed.entries).toEqual([ENTRY]);
    expect(parsed.malformed).toEqual([]);
  });

  it("skips blank lines and reports malformed ones by line number", () => {
    const text = `${ledgerLine(ENTRY)}\n\nnot json\n{"object":"x"}\n`;
    const parsed = parseLedger(text);
    expect(parsed.entries).toEqual([ENTRY]);
    expect(parsed.malformed).toEqual([3, 4]);
  });

  it("appends in order across multiple calls", () => {
    const second: LedgerEntry = { ...ENTRY, run: false, reason: "dry run" };
    const text = ledgerLine(ENTRY) + "\n" + ledgerLine(second) + "\n";
    const parsed = parseLedger(text);
    expect(parsed.entries.map((e): boolean => e.run)).toEqual([true, false]);
  });
});
