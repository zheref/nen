// The one effort-id grammar (zheref/nen#509 AC-1, AC-2): one regex in src/,
// one refusal text from every verb, one encoder.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run, type Io } from "../index.js";
import { effortIdProblem, encodeEffortId, isEffortId } from "./effort.js";

async function nen(argv: readonly string[]): Promise<{ code: number; err: string }> {
  const err: string[] = [];
  const io: Io = { out: (): void => {}, err: (line): void => { err.push(line); } };
  return { code: await run(argv, io), err: err.join("\n") };
}

describe("one effort-id grammar (zheref/nen#509)", () => {
  it("AC-1: exactly one EFFORT_ID declaration exists in shipped src/", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const needle = ["EFFORT_ID", "= /"].join(" ");
    const hits = (readdirSync(src, { recursive: true }) as string[])
      .filter((name): boolean => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name): boolean => readFileSync(join(src, name), "utf8").includes(needle))
      .map((name): string => relative(src, join(src, name)).split("\\").join("/"));
    expect(hits).toEqual(["ledger/effort.ts"]);
  });

  it.each(["HA/12", "NN-IS-#12", "inline-2026-10-23T12:00:00Z", "opus/kurapika/x", "a.b_c-d"])("admits %j", (id) => {
    expect(isEffortId(id)).toBe(true);
  });

  it.each(["", "HA 12", ".x", "/abs", "a\\b", "a/../b", "..", "a/./b", "C:x", "-x", "a\u0000b", "é"])("refuses %j", (id) => {
    expect(effortIdProblem(id)).not.toBeNull();
  });

  it("encodes injectively: '/', '#' and ':' are percent-encoded, nothing else changes", () => {
    expect(encodeEffortId("HA/12")).toBe("HA%2F12");
    expect(encodeEffortId("NN-IS-#12")).toBe("NN-IS-%2312");
    expect(encodeEffortId("a:b")).toBe("a%3Ab");
    expect(encodeEffortId("HA-12")).not.toBe(encodeEffortId("HA/12"));
  });

  it("AC-2: phase, usage and direct --record refuse 'HA 12' at exit 2 with the same text", async () => {
    const repo = mkdtempSync(join(tmpdir(), "nen-effort-grammar-"));
    const phase = await nen(["phase", "begin", "--effort", "HA 12", "--phase", "breath", "--repo", repo]);
    const usage = await nen(["usage", "record", "--effort", "HA 12", "--surface", "codex", "--not-reported", "--repo", repo]);
    const direct = await nen(["direct", "answer", "--record", "HA 12", "--answer", "stop", "--repo", repo]);
    for (const result of [phase, usage, direct]) expect(result.code).toBe(2);
    const text = (err: string): string => (/effort id 'HA 12' is refused: [^\n]*/.exec(err) ?? [""])[0];
    expect(text(phase.err)).not.toBe("");
    expect(text(usage.err)).toBe(text(phase.err));
    expect(text(direct.err)).toBe(text(phase.err));
  });
});
