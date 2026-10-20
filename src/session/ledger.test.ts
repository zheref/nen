import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { appendSessionEntry, isSessionEntry, readSessionLedger, sessionLedgerPath, SESSION_CONTRACT, type SessionEntry } from "./ledger.js";

const ENTRY: SessionEntry = { recordedAt: "2026-10-19T12:00:00.000Z", surface: "codex", model: null, dial: null, title: "Session", id: null, source: null };
const root = (): string => mkdtempSync(join(tmpdir(), "nen-session-ledger-"));

describe("session ledger", () => {
  it("creates and appends atomically, keeping slash and dash effort ids distinct", () => {
    const repo = root(), path = sessionLedgerPath(repo, "a/b");
    expect(path).not.toBe(sessionLedgerPath(repo, "a-b"));
    expect(appendSessionEntry(path, "a/b", ENTRY).entries).toEqual([ENTRY]);
    expect(appendSessionEntry(path, "a/b", { ...ENTRY, id: "second" }).entries).toHaveLength(2);
    expect(readSessionLedger(path, "a/b").entries).toHaveLength(2);
  });
  it.each(["bad JSON", "null", JSON.stringify({ contract: "foreign" }), JSON.stringify({ contract: SESSION_CONTRACT, effort: "wrong", entries: [] }), JSON.stringify({ contract: SESSION_CONTRACT, effort: "e", entries: null }), JSON.stringify({ contract: SESSION_CONTRACT, effort: "e", entries: [null] })])("refuses invalid on-disk data without overwriting it: %s", (bytes) => {
    const path = sessionLedgerPath(root(), "e");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    expect(() => appendSessionEntry(path, "e", ENTRY)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });
  it.each([null, 1, {}, { ...ENTRY, surface: " " }, { ...ENTRY, title: " ", id: "" }, { ...ENTRY, dial: 9 }, { ...ENTRY, recordedAt: null }])("rejects invalid entry shapes: %j", (entry) => {
    expect(isSessionEntry(entry)).toBe(false);
  });
  it("serializes competing processes without dropping invocations", async () => {
    const path = sessionLedgerPath(root(), "race");
    const module = join(process.cwd(), "src/session/ledger.ts");
    const jobs = Array.from({ length: 4 }, (_, i): Promise<void> => new Promise((resolve, reject) => {
      const script = `import {appendSessionEntry} from ${JSON.stringify(module)}; appendSessionEntry(${JSON.stringify(path)}, "race", ${JSON.stringify({ ...ENTRY, id: String(i) })});`;
      const child = spawn("bun", ["--eval", script], { stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      child.stderr.on("data", (chunk): void => { error += String(chunk); });
      child.on("error", reject);
      child.on("close", (code): void => { if (code === 0) resolve(); else reject(new Error(error)); });
    }));
    await Promise.all(jobs);
    expect(readSessionLedger(path, "race").entries.map((entry): string | null => entry.id).sort()).toEqual(["0", "1", "2", "3"]);
  });
});
