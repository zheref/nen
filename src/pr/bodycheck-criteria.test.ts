// src/pr/bodycheck-criteria.test.ts -- `nen pr body-check --criteria | --criteria-from`
// (zheref/nen#479 AC-1..AC-3 and AC-6; Akatsuki CON-17(c), ruled aligned with
// Hatsu HR-11 on 2026-10-23: one rule, one verb). One verify row per acceptance
// criterion, each with one status from satisfied · partial · missing ·
// contradicts · unrequested: an id with no row, a row outside the vocabulary or
// with two statuses, and a row reading missing or contradicts each refuse,
// quoted; a passing body under each of the three CON-17(b) verify titles.

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { prCommand } from "./command.js";

const dir = mkdtempSync(join(tmpdir(), "nen-body-criteria-"));
afterAll((): void => rmSync(dir, { recursive: true, force: true }));
let n = 0;

function file(text: string): string {
  const path = join(dir, `f-${++n}`);
  writeFileSync(path, text);
  return path;
}

async function check(body: string, extra: readonly string[], requirements: readonly { name: string; pattern: string }[] = [{ name: "verify", pattern: "^## How to verify$" }], json = false): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const argv = ["pr", "body-check", "--body-from", file(body), "--requirements-from", file(JSON.stringify(requirements)), ...extra];
  const code = await runFamily(prCommand, argv, dir, json, io, new ScriptedSeams([]));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const table = (title: string, rows: string): string => `${title}\n\n| Criterion | Coverage | Evidence |\n|---|---|---|\n${rows}`;

describe("pr body-check: one verify row per acceptance criterion (zheref/nen#479)", () => {
  it("AC-1: an id with no row refuses at exit 1, quoting the id; passed by flag or read from the issue body", async () => {
    const body = table("## How to verify", "| AC-1 | satisfied | a.test.ts |\n");
    const flag = await check(body, ["--criteria", "AC-1,AC-2"]);
    expect(flag.code).toBe(1);
    expect(flag.out).toContain("BLOCKING --criteria/AC-2: missing-row (no verify row names AC-2)");
    const issue = file("## Acceptance criteria\n\n- AC-1: lists rows\n- AC-2: exits 2 unread\n");
    const read = await check(body, ["--criteria-from", issue, "--criteria-issue", "zheref/nen#479"]);
    expect(read.code).toBe(1);
    expect(read.out).toContain("BLOCKING zheref/nen#479/AC-2: missing-row (no verify row names AC-2)");
  });

  it("AC-2: a status outside the five words, and a row with two statuses, are refused by name", async () => {
    const outside = await check(table("## How to verify", "| AC-1 | done | a |\n"), ["--criteria", "AC-1"]);
    expect(outside.code).toBe(1);
    expect(outside.out).toMatch(/BLOCKING --criteria\/AC-1: malformed-row -- row line 5: \| AC-1 \| done \| a \|/);
    const two = await check(table("## How to verify", "| AC-1 | satisfied, partial | a |\n"), ["--criteria", "AC-1"], undefined, true);
    expect(two.code).toBe(1);
    const report = JSON.parse(two.out) as { ok: boolean; criteria: { criteria: { coverage: string }[]; blocking: string[] } };
    expect(report.ok).toBe(false);
    expect(report.criteria.criteria[0]?.coverage).toBe("malformed-row");
  });

  it("AC-3: a row reading missing or contradicts reads not-ready, with the row quoted", async () => {
    for (const word of ["missing", "contradicts"]) {
      const result = await check(table("## How to verify", `| AC-1 | ${word} | b.test.ts |\n`), ["--criteria", "AC-1"]);
      expect(result.code).toBe(1);
      expect(result.out).toContain(`BLOCKING --criteria/AC-1: ${word} -- row line 5: | AC-1 | ${word} | b.test.ts |`);
    }
  });

  it("AC-6: a passing body under each of the three verify titles", async () => {
    for (const title of ["## How to verify", "## How a consumer verifies", "## What the guards prove"]) {
      const result = await check(table(title, "| AC-1 | satisfied | a.test.ts |\n| AC-2 | partial | b.test.ts |\n| none | unrequested | a typo fixed in passing |\n"), ["--criteria", "AC-1,AC-2"], [
        { name: "verify", pattern: `^${title}$` },
      ]);
      expect(result.code, result.out + result.err).toBe(0);
      expect(result.out).toContain("2 criterion row(s), 0 blocking (one verify row per acceptance criterion; CON-17(c), HR-11)");
    }
  });

  it("an issue body with no criterion is not verifiable and blocks, never passes", async () => {
    const result = await check(table("## How to verify", "| none | unrequested | x |\n"), ["--criteria-from", file("No criteria here.\n")]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/not-verifiable/);
  });

  it("usage: both flags, a malformed id, --criteria-issue or --catalogue alone are refused at exit 2", async () => {
    const body = table("## How to verify", "| AC-1 | satisfied | a |\n");
    expect((await check(body, ["--criteria", "AC-1", "--criteria-from", file("- AC-1: a\n")])).code).toBe(2);
    expect((await check(body, ["--criteria", "AC-x"])).code).toBe(2);
    expect((await check(body, ["--criteria-issue", "#4"])).code).toBe(2);
    expect((await check(body, ["--catalogue", file("{}")])).code).toBe(2);
    expect((await check(body, ["--criteria", "AC-1", "--criteria-issue", "nope"])).code).toBe(2);
  });

  it("without the flags the verdict is unchanged", async () => {
    const result = await check("## How to verify\nrun it\n", [], undefined, true);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).not.toHaveProperty("criteria");
  });
});
