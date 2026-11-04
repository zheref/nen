import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { shuCommand } from "./command.js";

async function select(pattern: unknown = ["src/one/**"], options: { stdout?: string; code?: number; extra?: string[] } = {}): Promise<{ code: number; report: Record<string, unknown> | null; err: string; calls: number; gitEnv: Readonly<Record<string, string | undefined>> | null }> {
  const root = mkdtempSync(join(tmpdir(), "nen-lanes-"));
  try {
    mkdirSync(join(root, "nen"));
    writeFileSync(join(root, "nen/contract.json"), JSON.stringify({ project: { defaultLane: "one", lanes: { one: { stack: "fixture", cwd: ".", paths: pattern }, two: { stack: "fixture", cwd: ".", paths: ["src/two/*.ts"] }, unknown: { stack: "fixture", cwd: "." } }, verbs: { one: { test: { exe: "must-not-start", argv: ["test"] } }, two: { test: { exe: "must-not-start", argv: ["test"] } }, unknown: { test: { exe: "must-not-start", argv: ["test"] } } } } }));
    const seams = new ScriptedSeams([{ match: "git --no-replace-objects --no-lazy-fetch diff --no-ext-diff --no-textconv --name-only -z --no-renames base...HEAD --", result: { stdout: options.stdout ?? "src/one/a.ts\0src/two/b.ts\0docs/uncovered.md\0", code: options.code ?? 0 } }], { env: { GIT_DIR: "/decoy", GIT_WORK_TREE: "/other", GIT_CONFIG_KEY_4: "core.hooksPath", GIT_CONFIG_VALUE_4: "/untrusted" } });
    const out: string[] = [], err: string[] = [];
    const code = await runFamily(shuCommand, ["shu", "test", "--changed", "--base", "base", "--dry-run", "--json", ...(options.extra ?? [])], root, true, { out: line => out.push(line), err: line => err.push(line) }, seams);
    return { code, report: out.length ? JSON.parse(out.join("\n")) : null, err: err.join("\n"), calls: seams.calls.length, gitEnv: seams.calls[0]?.env ?? null };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
describe("read-only changed lane selection", () => {
  it("reports exactly two selected, one uncovered path and one undeclared lane without executing", async () => {
    const result = await select(); expect(result.err).toBe(""); expect(result.code).toBe(0); expect(result.calls).toBe(1);
    expect(result.report?.["selected"]).toEqual([{ lane: "one", paths: ["src/one/a.ts"] }, { lane: "two", paths: ["src/two/b.ts"] }]);
    expect(result.report?.["uncovered"]).toEqual(["docs/uncovered.md"]); expect(result.report?.["undeclared"]).toEqual(["unknown"]); expect(result.report?.["executed"]).toBe(false);
  });
  it("preserves newline filenames in structured mapping", async () => {
    const result = await select(undefined, { stdout: "src/one/a\nb.ts\0" });
    expect(result.report?.["selected"]).toEqual([{ lane: "one", paths: ["src/one/a\nb.ts"] }]);
  });
  it("scrubs repository/config redirects and disables lazy fetch and optional locks", async () => {
    const result = await select();
    expect(result.code).toBe(0);
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG_KEY_4", "GIT_CONFIG_VALUE_4"]) expect(result.gitEnv).toHaveProperty(key, undefined);
    expect(result.gitEnv).toMatchObject({ GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" });
  });
  it.each(["src/one/a.ts", "src/one/a.ts\0\0"])("refuses incomplete or malformed NUL path reads", async stdout => {
    const result = await select(undefined, { stdout }); expect(result.code).toBe(1); expect(result.report).toBeNull();
  });
  it("never emits a complete selection after a failed Git read", async () => {
    const result = await select(undefined, { code: 1 }); expect(result.code).toBe(1); expect(result.report).toBeNull();
  });
  it.each([{ extra: ["--lane", "one"] }, { extra: ["--lanes", "one,two"] }, { extra: ["--stream"] }, { extra: ["--", "ignored"] }])("refuses conflicting selectors before any subprocess", async ({ extra }) => {
    const result = await select(undefined, { extra }); expect(result.code).toBe(2); expect(result.calls).toBe(0);
  });
  it.each(["src/[bad", "../escape/**", "/outside", "src\\unsafe", "a/**bad", "src//bad"])("refuses malformed pattern %s at contract read naming lane", async pattern => {
    const result = await select([pattern]); expect(result.code).not.toBe(0); expect(result.calls).toBe(0); expect(result.err).toContain("project.lanes.one.paths");
  });
});
