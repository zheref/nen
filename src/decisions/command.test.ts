// src/decisions/command.test.ts -- `nen decisions summary`: the counts read
// from nen/decisions.json, an absent file never an empty summary.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { decisionsCommand } from "./command.js";

const scratch = mkdtempSync(join(tmpdir(), "nen-decisions-"));
afterAll((): void => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

function repo(rows: unknown[] | null, raw?: string): string {
  const root = join(scratch, `r-${++n}`);
  mkdirSync(join(root, "nen"), { recursive: true });
  if (raw !== undefined) writeFileSync(join(root, "nen/decisions.json"), raw);
  else if (rows !== null) writeFileSync(join(root, "nen/decisions.json"), JSON.stringify({ contract: "nen.decisions/v0.1", rows }));
  return root;
}

async function summary(root: string, json = false, extra: readonly string[] = []): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l): void => void out.push(l), err: (l): void => void err.push(l) };
  const code = await runFamily(decisionsCommand, ["decisions", "summary", ...extra], root, json, io, new ScriptedSeams([]));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const ROWS = [
  { id: "dirty-tree", class: "autonomous", default: "carry" },
  { id: "missing-argument", class: "ask-once-per-run", preferred: [{ key: "a", label: "Name it", command: "nen x --arg y" }] },
  { id: "merge", class: "human-gate", gate: "G2" },
  { id: "secret-shape", class: "human-gate", gate: "G5" },
  { id: "semantic-conflict", class: "human-gate", gate: "G5" },
];

describe("nen decisions summary", () => {
  it("counts rows per class and per gate and lists the G5 ids in file order", async () => {
    const r = await summary(repo(ROWS), true);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as Record<string, unknown>;
    expect(Object.keys(j)).toEqual(["contract", "repo", "path", "rows", "classes", "gates", "g5"]);
    expect(j["contract"]).toBe("nen.decisions.summary/v0.1");
    expect(j["rows"]).toBe(5);
    expect(j["classes"]).toEqual({ autonomous: 1, "ask-once-per-run": 1, "human-gate": 3 });
    expect(j["gates"]).toEqual({ G1: 0, "G1-M": 0, G2: 1, G3: 0, G4: 0, G5: 2, none: 2 });
    expect(j["g5"]).toEqual(["secret-shape", "semantic-conflict"]);
  });

  it("renders the same counts as text", async () => {
    const r = await summary(repo(ROWS));
    expect(r.out).toMatch(/classes: autonomous 1 · ask-once-per-run 1 · human-gate 3/);
    expect(r.out).toMatch(/g5: secret-shape, semantic-conflict/);
  });

  it("an absent file is exit 1, never an empty summary", async () => {
    const r = await summary(repo(null));
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/is absent/);
  });

  it("a malformed file is exit 1 naming the pointer", async () => {
    const r = await summary(repo([{ id: "x", class: "sometimes" }]));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/rows\[0\]\.class/);
    expect((await summary(repo(null, "{"))).code).toBe(1);
  });

  it("refuses an unknown subcommand and an extra positional", async () => {
    const root = repo(ROWS);
    const io: Io = { out: (): void => {}, err: (): void => {} };
    expect(await runFamily(decisionsCommand, ["decisions", "count"], root, false, io, new ScriptedSeams([]))).toBe(2);
    expect(await runFamily(decisionsCommand, ["decisions", "summary", "extra"], root, false, io, new ScriptedSeams([]))).toBe(2);
  });
});
