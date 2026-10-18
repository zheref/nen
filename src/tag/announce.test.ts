import { afterEach, describe, expect, it, vi } from "vitest";
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { announceTag } from "./announce.js";
import { tagCommand } from "./command.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(value: unknown = { tags: { identity: { nameFrom: "identity" } } }, text: string = "v1+build\nabc123\n"): string {
  const root = mkdtempSync(join(tmpdir(), "nen-announce-")); roots.push(root);
  mkdirSync(join(root, "nen")); writeFileSync(join(root, "nen/workflow.json"), JSON.stringify(value));
  writeFileSync(join(root, "identity"), text); return root;
}
async function cli(root: string | null, args: readonly string[] = []): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = []; const err: string[] = []; const seams = new ScriptedSeams([]);
  const code = await runFamily(tagCommand, ["tag", "announce", ...args], root, false, { out: (s) => void out.push(s), err: (s) => void err.push(s) }, seams);
  expect(seams.calls).toEqual([]);
  return { code, out, err };
}

describe("tag announce -- archive identity data only", () => {
  it("prints exactly two CR-stripped lines, ignores extra lines, and changes no files", async () => {
    const root = fixture(undefined, "v\r1\r+build\r\nnot-a-validated-sha\r\nignored\n");
    const before = readFileSync(join(root, "identity")); const workflow = readFileSync(join(root, "nen/workflow.json"));
    const result = await cli(root);
    expect(result).toEqual({ code: 0, out: ["v1+build", "not-a-validated-sha"], err: [] });
    expect(readFileSync(join(root, "identity"))).toEqual(before); expect(readFileSync(join(root, "nen/workflow.json"))).toEqual(workflow);
  });
  it("accepts the second line without a final LF, and does not invent content validation", () => {
    expect(announceTag(fixture(undefined, "name\nsha"))).toMatchObject({ exitCode: 0, identity: "name", archiveSha: "sha" });
    expect(announceTag(fixture(undefined, "\n\n"))).toMatchObject({ exitCode: 0, identity: "", archiveSha: "" });
  });
  it.each([{}, { tags: null }, { tags: {} }, { tags: { identity: null } }])("reports no tag for %j at exit 3", async (value) => {
    expect(await cli(fixture(value))).toEqual({ code: 3, out: ["no tag declared"], err: [] });
  });
  it.each([{ tags: [] }, { tags: false }, { tags: { identity: [] } }, { tags: { identity: "x" } }, { tags: { identity: {} } }, { tags: { identity: { nameFrom: 3 } } }, { tags: { identity: { nameFrom: "" } } }, [], null])("refuses malformed declarations %j", async (value) => {
    const result = await cli(fixture(value)); expect(result.code).toBe(1); expect(result.out).toEqual([]); expect(result.err[0]).toContain("tag declaration error");
  });
  it.each(["", "name", "name\n"])("refuses fewer than two lines: %j", (text) => {
    expect(announceTag(fixture(undefined, text))).toMatchObject({ exitCode: 1, status: "invalid", identity: null, archiveSha: null });
  });
  it.each(["../identity", "sub/../identity", "..\\identity", "C:identity", "C:\\identity", "/identity"])("refuses traversal or nonrelative nameFrom %s", (nameFrom) => {
    expect(announceTag(fixture({ tags: { identity: { nameFrom } } }))).toMatchObject({ exitCode: 1, status: "invalid" });
  });
  it("refuses missing workflow, malformed JSON, missing identity files and directories", () => {
    const root = fixture(); unlinkSync(join(root, "nen/workflow.json")); expect(announceTag(root).exitCode).toBe(1);
    writeFileSync(join(root, "nen/workflow.json"), "{"); expect(announceTag(root).exitCode).toBe(1);
    writeFileSync(join(root, "nen/workflow.json"), JSON.stringify({ tags: { identity: { nameFrom: "missing" } } })); expect(announceTag(root).exitCode).toBe(1);
    writeFileSync(join(root, "nen/workflow.json"), JSON.stringify({ tags: { identity: { nameFrom: "nen" } } })); expect(announceTag(root).exitCode).toBe(1);
  });
  it.skipIf(process.platform === "win32")("refuses workflow, file and parent symlinks even pointing inside the repository", () => {
    for (const mode of ["workflow", "file", "parent"]) {
      const root = fixture();
      if (mode === "workflow") { unlinkSync(join(root, "nen/workflow.json")); symlinkSync(join(root, "identity"), join(root, "nen/workflow.json")); }
      if (mode === "file") { symlinkSync(join(root, "identity"), join(root, "link")); writeFileSync(join(root, "nen/workflow.json"), JSON.stringify({ tags: { identity: { nameFrom: "link" } } })); }
      if (mode === "parent") { symlinkSync(root, join(root, "link")); writeFileSync(join(root, "nen/workflow.json"), JSON.stringify({ tags: { identity: { nameFrom: "link/identity" } } })); }
      expect(announceTag(root).exitCode).toBe(1);
    }
  });
  it("bounds workflow and identity prefix reads, but ignores an arbitrarily long tail", () => {
    const root = fixture(undefined, "name\nsha\n" + "x".repeat(128 * 1024)); expect(announceTag(root).exitCode).toBe(0);
    writeFileSync(join(root, "identity"), "x".repeat(64 * 1024 + 1)); expect(announceTag(root).error).toContain("read limit");
    writeFileSync(join(root, "nen/workflow.json"), " ".repeat(1024 * 1024 + 1)); expect(announceTag(root).error).toContain("read limit");
  });
  it("provides exact JSON shapes without mixing the two plain success lines", async () => {
    const root = fixture(); const ok = await cli(root, ["--json"]);
    expect(ok.code).toBe(0); expect(JSON.parse(ok.out.join("\n"))).toEqual({ contract: "nen.tag.announce/v0.1", status: "announced", identity: "v1+build", archiveSha: "abc123", nameFrom: "identity", error: null, exitCode: 0 });
    const absent = await cli(fixture({}), ["--json"]); expect(absent.code).toBe(3); expect(JSON.parse(absent.out.join("\n"))).toMatchObject({ status: "undeclared", nameFrom: null, identity: null, archiveSha: null, error: null, exitCode: 3 });
    const invalid = await cli(fixture({ tags: [] }), ["--json"]); expect(invalid.code).toBe(1); expect(JSON.parse(invalid.out.join("\n"))).toMatchObject({ status: "invalid", exitCode: 1 });
  });
  it("uses wiring exit 2 for missing repo, extra arguments, or cut-only flags", async () => {
    expect((await cli(null)).code).toBe(2);
    for (const args of [["extra"], ["--name", "v1"], ["--push"], ["--at", "HEAD"], ["--", "extra"]]) expect((await cli(fixture(), args)).code).toBe(2);
  });
  it.skipIf(process.platform === "win32")("refuses FIFO workflow and identity files in bounded CLI processes", () => {
    for (const mode of ["workflow", "identity"]) {
      const root = fixture(); const path = mode === "workflow" ? join(root, "nen/workflow.json") : join(root, "identity"); unlinkSync(path);
      expect(spawnSync("mkfifo", [path]).status).toBe(0);
      const result = spawnSync("bun", [join(import.meta.dirname, "../index.ts"), "tag", "announce", "--repo", root], { encoding: "utf8", timeout: 2000 });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe("");
    }
  });
  it.skipIf(process.platform === "win32")("validates and closes a FIFO swapped in just before open without blocking", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs"); const root = fixture(); let reader: number | undefined; let opened: number | undefined;
    // The first open reads the workflow. Intercept the second, identity open.
    vi.mocked(openSync).mockImplementationOnce(actual.openSync).mockImplementationOnce((path, flags, mode) => {
      expect((flags as number) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      unlinkSync(path); expect(spawnSync("mkfifo", [String(path)]).status).toBe(0);
      reader = actual.openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); opened = actual.openSync(path, flags, mode); return opened;
    });
    try { expect(announceTag(root).exitCode).toBe(1); expect(opened).toBeDefined(); expect(() => fstatSync(opened!)).toThrow(/EBADF/); }
    finally { vi.mocked(openSync).mockReset().mockImplementation(actual.openSync); if (reader !== undefined) closeSync(reader); }
  });
});
