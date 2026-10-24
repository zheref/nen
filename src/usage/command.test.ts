import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { spawnRunner, type CommandResult, type Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { USAGE_CONTRACT, USAGE_LEDGER_DIR, usageCommand } from "./command.js";

function seamsAt(iso: string): Seams {
  return {
    // Only git, and only to find the ledger's home (zheref/nen#509): a temp
    // dir is not a repository, so the ledger stays under --repo.
    run: (command, args, options): CommandResult => {
      if (command !== "git" || !args.includes("--git-common-dir")) throw new Error(`must not be called: ${command} ${args.join(" ")}`);
      return spawnRunner(command, args, options);
    },
    now: (): Date => new Date(iso),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("no watched form");
    },
    platform: "linux",
  };
}

async function capture(argv: readonly string[], repo: string, json = false): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l): void => { out.push(l); }, err: (l): void => { err.push(l); } };
  const code = await runFamily(usageCommand, argv, repo, json, io, seamsAt("2026-09-20T10:00:00Z"));
  return { code, out, err };
}

interface Ledger {
  contract: string;
  effort: string;
  entries: Record<string, unknown>[];
}

describe("nen usage record -- the per-effort usage ledger", () => {
  it("appends one entry with token counts, in the contract's key order", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-usage-"));
    const result = await capture(
      ["usage", "record", "--effort", "HA/85", "--surface", "claude-code", "--model", "opus", "--input", "1200", "--output", "300", "--cache-read", "9000", "--cache-write", "40", "--minutes", "7.5", "--source", "claude /cost"],
      root,
    );
    expect(result.code).toBe(0);
    const path = join(root, USAGE_LEDGER_DIR, "HA%2F85.json");
    expect(existsSync(path)).toBe(true);
    const ledger = JSON.parse(readFileSync(path, "utf8")) as Ledger;
    expect(ledger.contract).toBe(USAGE_CONTRACT);
    expect(ledger.effort).toBe("HA/85");
    expect(Object.keys(ledger.entries[0] ?? {})).toEqual([
      "recordedAt",
      "surface",
      "model",
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "minutes",
      "source",
      "note",
      "notReported",
      "dial",
    ]);
    expect(ledger.entries[0]).toMatchObject({
      recordedAt: "2026-09-20T10:00:00.000Z",
      surface: "claude-code",
      model: "opus",
      input: 1200,
      output: 300,
      cacheRead: 9000,
      cacheWrite: 40,
      minutes: 7.5,
      source: "claude /cost",
      note: null,
      notReported: false,
    });
  });

  it("--not-reported records every number null and notReported true", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-usage-"));
    const result = await capture(["usage", "record", "--effort", "e", "--surface", "cursor", "--not-reported"], root);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("(not reported)");
    const ledger = JSON.parse(readFileSync(join(root, USAGE_LEDGER_DIR, "e.json"), "utf8")) as Ledger;
    expect(ledger.entries[0]).toMatchObject({ surface: "cursor", model: null, input: null, output: null, cacheRead: null, cacheWrite: null, minutes: null, notReported: true });
  });

  it("refuses a number together with --not-reported, at exit 2, writing nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-usage-"));
    const result = await capture(["usage", "record", "--effort", "e", "--surface", "cursor", "--not-reported", "--input", "5"], root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/either reported its usage or it did not/);
    expect(existsSync(join(root, USAGE_LEDGER_DIR, "e.json"))).toBe(false);
  });

  it("refuses an entry with no number and no --not-reported, a bad count, and a bad effort", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-usage-"));
    expect((await capture(["usage", "record", "--effort", "e", "--surface", "cursor"], root)).code).toBe(2);
    expect((await capture(["usage", "record", "--effort", "e", "--surface", "cursor", "--input", "-1"], root)).code).toBe(2);
    expect((await capture(["usage", "record", "--effort", "e", "--surface", "cursor", "--minutes", "abc"], root)).code).toBe(2);
    expect((await capture(["usage", "record", "--effort", "../e", "--surface", "cursor", "--not-reported"], root)).code).toBe(2);
    expect((await capture(["usage", "record", "--effort", "e", "--not-reported"], root)).code).toBe(2);
  });

  it("appends: a second record keeps the first", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-usage-"));
    await capture(["usage", "record", "--effort", "e", "--surface", "codex", "--input", "10"], root);
    await capture(["usage", "record", "--effort", "e", "--surface", "codex", "--input", "20"], root);
    const ledger = JSON.parse(readFileSync(join(root, USAGE_LEDGER_DIR, "e.json"), "utf8")) as Ledger;
    expect(ledger.entries.map((entry): unknown => entry["input"])).toEqual([10, 20]);
  });

  it("refuses to append to a file that is not this contract's", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-usage-"));
    await capture(["usage", "record", "--effort", "e", "--surface", "codex", "--input", "10"], root);
    const path = join(root, USAGE_LEDGER_DIR, "e.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, JSON.stringify({ contract: "something.else/v9", entries: [] }));
    const result = await capture(["usage", "record", "--effort", "e", "--surface", "codex", "--input", "10"], root);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/does not carry contract/);
  });
});

describe("nen usage show -- the ledger and its totals", () => {
  it("prints every entry and one total per surface+model, counting the not-reported ones", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-usage-"));
    await capture(["usage", "record", "--effort", "e", "--surface", "claude-code", "--model", "opus", "--input", "100", "--output", "10", "--minutes", "1"], root);
    await capture(["usage", "record", "--effort", "e", "--surface", "claude-code", "--model", "opus", "--input", "50", "--cache-read", "7"], root);
    await capture(["usage", "record", "--effort", "e", "--surface", "cursor", "--not-reported"], root);
    const show = await capture(["usage", "show", "--effort", "e"], root);
    expect(show.code).toBe(0);
    const text = show.out.join("\n");
    expect(text).toContain("effort: e (3 usage entries)");
    expect(text).toContain("totals:");
    expect(text).toMatch(/claude-code\/opus\s+in 150  out 10  cache r\/w 7\/0  1 min  \(2 entries\)/);
    expect(text).toMatch(/cursor\s+in 0  out 0  cache r\/w 0\/0  0 min  \(1 entry, 1 not reported\)/);
  });

  it("keys a total on the (surface, model) tuple, so 'ab'+'c' and 'a'+'bc' are two totals (N11)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-usage-"));
    await capture(["usage", "record", "--effort", "e", "--surface", "ab", "--model", "c", "--input", "1"], root);
    await capture(["usage", "record", "--effort", "e", "--surface", "a", "--model", "bc", "--input", "2"], root);
    await capture(["usage", "record", "--effort", "e", "--surface", "abc", "--input", "4"], root);
    const show = await capture(["usage", "show", "--effort", "e", "--json"], root);
    const totals = (JSON.parse(show.out.join("\n")) as { totals: { surface: string; model: string | null; input: number }[] }).totals;
    expect(totals.map((t): [string, string | null, number] => [t.surface, t.model, t.input])).toEqual([["ab", "c", 1], ["a", "bc", 2], ["abc", null, 4]]);
  });

  it("--json is the ledger plus totals", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-usage-"));
    await capture(["usage", "record", "--effort", "e", "--surface", "codex", "--input", "5"], root);
    const show = await capture(["usage", "show", "--effort", "e"], root, true);
    const parsed = JSON.parse(show.out.join("\n")) as { contract: string; effort: string; entries: unknown[]; totals: { surface: string; input: number }[] };
    expect(parsed.contract).toBe(USAGE_CONTRACT);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.totals).toEqual([{ surface: "codex", model: null, entries: 1, notReported: 0, input: 5, output: 0, cacheRead: 0, cacheWrite: 0, minutes: 0 }]);
  });

  it("an effort with no ledger shows zero entries at exit 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-usage-"));
    const show = await capture(["usage", "show", "--effort", "nothing"], root);
    expect(show.code).toBe(0);
    expect(show.out.join("\n")).toContain("(0 usage entries)");
  });
});

describe("usage effort dial (#437)", () => {
  it("records the dial verbatim without counting it as usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-usage-dial-"));
    const flags = ["usage", "record", "--effort", "e", "--surface", "claude-code", "--dial", " max "];
    const missing = await capture(flags, root);
    expect(missing.code).toBe(2);
    expect(existsSync(join(root, USAGE_LEDGER_DIR, "e.json"))).toBe(false);
    expect((await capture([...flags, "--not-reported"], root)).code).toBe(0);
    const result = await capture(["usage", "show", "--effort", "e", "--json"], root);
    expect(JSON.parse(result.out.join("\n")).entries[0].dial).toBe(" max ");
  });
});


it("normalizes legacy usage dial to null on show and the next append", async () => {
  const root = mkdtempSync(join(tmpdir(), "nen-usage-legacy-"));
  const flags = ["usage", "record", "--effort", "e", "--surface", "codex", "--not-reported"];
  await capture(flags, root);
  const path = join(root, USAGE_LEDGER_DIR, "e.json");
  const ledger = JSON.parse(readFileSync(path, "utf8"));
  delete ledger.entries[0].dial;
  writeFileSync(path, JSON.stringify(ledger));
  const shown = await capture(["usage", "show", "--effort", "e", "--json"], root);
  expect(JSON.parse(shown.out.join("\n")).entries[0].dial).toBeNull();
  await capture(flags, root);
  expect(JSON.parse(readFileSync(path, "utf8")).entries.map((entry: { dial: unknown }) => entry.dial)).toEqual([null, null]);
});
