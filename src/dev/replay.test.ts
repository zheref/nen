import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDedupeFixture,
  replayDedupeFixture,
  replayDedupeSlice,
  ReplayFixtureError,
  type DedupeFixture,
} from "./replay.js";

const SLICE_DIR = join(process.cwd(), "tests", "fixtures", "dualrun-slice", "dedupe");

describe("replayDedupeSlice -- the imported corpus slice replays green", () => {
  it("replays every imported fixture with no failures", () => {
    const report = replayDedupeSlice(SLICE_DIR);
    expect(report.total).toBeGreaterThan(0);
    expect(report.failed).toEqual([]);
    expect(report.passed.length).toBe(report.total);
    expect(report.error).toBeNull();
  });

  it("includes the ASCII-only-lowercase fixture that found the normalizeTitle divergence", () => {
    const report = replayDedupeSlice(SLICE_DIR);
    expect(report.passed).toContain("non-ascii-uppercase-survives-the-lowercaser");
  });

  // Review finding #9: a zero-fixture slice used to report "0 passed, 0
  // failed" with an implicit pass -- satisfiable by an empty or
  // wrongly-pointed directory.
  it("refuses (error set, not a silent 0/0 pass) when --slice-dir is empty", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "nen-replay-empty-"));
    const report = replayDedupeSlice(emptyDir);
    expect(report.total).toBe(0);
    expect(report.error).toMatch(/contains no fixtures/);
  });

  it("throws a located, actionable error (not a raw ENOENT) when --slice-dir does not exist", () => {
    const missing = join(tmpdir(), "nen-replay-does-not-exist-" + Date.now());
    expect(() => replayDedupeSlice(missing)).toThrow(ReplayFixtureError);
    expect(() => replayDedupeSlice(missing)).toThrow(/no such directory/);
  });
});

describe("parseDedupeFixture -- extracts the DECISION, never the shell's exact stdout", () => {
  it("reads a canonical (no-op) verdict", () => {
    const raw = {
      env: { NUMBER: "300", TITLE: "Gap X" },
      subprocess: [{ stdout: "300\tGap X\n" }],
      recorded: { stdout: "#300 is canonical (no older open duplicate) — no-op.\n" },
    };
    const fixture = parseDedupeFixture(raw, "test-fixture");
    expect(fixture.expectedCanonicalOf).toBeNull();
    expect(fixture.candidates).toEqual([{ number: 300, title: "Gap X" }]);
  });

  it("reads a duplicate-of verdict", () => {
    const raw = {
      env: { NUMBER: "300", TITLE: "Gap X" },
      subprocess: [{ stdout: "150\tGap X\n300\tGap X\n" }],
      recorded: { stdout: "closed as a duplicate of #150.\n" },
    };
    const fixture = parseDedupeFixture(raw, "test-fixture");
    expect(fixture.expectedCanonicalOf).toBe(150);
  });

  it("throws when recorded stdout matches neither pattern", () => {
    const raw = { env: { NUMBER: "1", TITLE: "x" }, subprocess: [{ stdout: "" }], recorded: { stdout: "something else entirely" } };
    expect(() => parseDedupeFixture(raw, "bad-fixture")).toThrow(ReplayFixtureError);
  });

  it("throws on a malformed TSV row", () => {
    const raw = { env: { NUMBER: "1", TITLE: "x" }, subprocess: [{ stdout: "no-tab-here\n" }], recorded: { stdout: "" } };
    expect(() => parseDedupeFixture(raw, "bad-fixture")).toThrow(/malformed TSV/);
  });
});

describe("replayDedupeFixture -- compares nen's findCanonical against the extracted verdict", () => {
  function fixture(overrides: Partial<DedupeFixture> = {}): DedupeFixture {
    return {
      id: "x",
      newNumber: 300,
      newTitle: "Gap",
      candidates: [{ number: 150, title: "Gap" }],
      expectedCanonicalOf: 150,
      ...overrides,
    };
  }

  it("passes when nen's own answer matches the recorded verdict", () => {
    expect(replayDedupeFixture(fixture()).ok).toBe(true);
  });

  it("fails, naming expected vs actual, when they disagree", () => {
    const result = replayDedupeFixture(fixture({ expectedCanonicalOf: 999 }));
    expect(result.ok).toBe(false);
    expect(result.expected).toBe(999);
    expect(result.actual).toBe(150);
  });
});
