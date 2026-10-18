import { describe, expect, it, vi } from "vitest";
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});
import { ledgerLine, openLabelLedger, parseLedger, type LedgerEntry } from "./ledger.js";

const ENTRY: LedgerEntry = {
  object: "XX-PR-#12",
  label: "wake",
  time: "2026-01-01T00:00:00Z",
  outcome: "applied",
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
    const second: LedgerEntry = { ...ENTRY, outcome: "dry-run", reason: "dry run" };
    const text = ledgerLine(ENTRY) + "\n" + ledgerLine(second) + "\n";
    const parsed = parseLedger(text);
    expect(parsed.entries.map((e): string => e.outcome)).toEqual(["applied", "dry-run"]);
  });

  it("carries the THIRD outcome, 'failed', for a mutation GitHub refused", () => {
    const failed: LedgerEntry = { ...ENTRY, outcome: "failed", reason: null };
    const parsed = parseLedger(ledgerLine(failed) + "\n");
    expect(parsed.entries).toEqual([failed]);
  });
});


describe("openLabelLedger preflight", () => {
  it.skipIf(process.platform === "win32")("appends to regular files and their symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-ledger-file-"));
    try {
      const path = join(root, "ledger");
      let fd = openLabelLedger(path);
      writeSync(fd, "first\n");
      closeSync(fd);
      const link = join(root, "link");
      symlinkSync(path, link, "file");
      fd = openLabelLedger(link);
      writeSync(fd, "second\n");
      closeSync(fd);
      expect(readFileSync(path, "utf8")).toBe("first\nsecond\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("refuses an explicit FIFO in a bounded real CLI dry run", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-ledger-fifo-"));
    try {
      const path = join(root, "ledger");
      expect(spawnSync("mkfifo", [path]).status).toBe(0);
      const result = spawnSync("bun", [join(import.meta.dirname, "../index.ts"), "label", "apply", "XX-IS-#1", "--label", "bankai:stage/idea", "--repo-slug", "o/r", "--repo", BANKAI_REPO, "--ledger", path, "--json"], { encoding: "utf8", timeout: 2000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("cannot be appended to (EINVAL)");
      expect(result.stdout).toBe("");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("checks a swapped FIFO descriptor without blocking, and closes it", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const root = mkdtempSync(join(tmpdir(), "nen-ledger-race-"));
    let reader: number | undefined;
    let opened: number | undefined;
    try {
      const path = join(root, "ledger");
      writeFileSync(path, "");
      vi.mocked(openSync).mockImplementationOnce((name, flags, mode) => {
        // Fail immediately rather than hanging the test if NONBLOCK regresses.
        expect(typeof flags).toBe("number");
        expect((flags as number) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
        unlinkSync(path);
        expect(spawnSync("mkfifo", [path]).status).toBe(0);
        reader = actual.openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
        opened = actual.openSync(name, flags, mode);
        return opened;
      });
      expect(() => openLabelLedger(path)).toThrow("cannot be appended to (EINVAL)");
      expect(opened).toBeDefined();
      expect(() => fstatSync(opened!)).toThrow(/EBADF/);
    } finally {
      vi.mocked(openSync).mockReset().mockImplementation(actual.openSync);
      if (reader !== undefined) closeSync(reader);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
