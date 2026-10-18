import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BANKAI_REPO } from "./fixtures/paths.js";
import { run } from "../index.js";

// Model Windows' ENOENT-on-child-of-file on every host, and an unreadable
// parent. All other filesystem operations use the real temporary fixture.
const failures = vi.hoisted(() => ({ marker: "", parent: "", deniedParent: false, parentLink: "", deniedEntry: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>): ReturnType<typeof actual.lstatSync> => {
      if (args[0] === failures.parent && failures.deniedEntry) throw Object.assign(new Error("synthetic inaccessible parent entry"), { code: "EACCES" });
      if (args[0] === failures.marker) throw Object.assign(new Error("synthetic Windows missing child"), { code: "ENOENT" });
      const stat = actual.lstatSync(...args);
      if (args[0] === failures.parent && failures.parentLink !== "" && stat !== undefined) {
        return Object.assign(stat, { isSymbolicLink: (): boolean => true, isDirectory: (): boolean => false });
      }
      return stat;
    },
    statSync: (...args: Parameters<typeof actual.statSync>): ReturnType<typeof actual.statSync> => {
      if (args[0] === failures.parent && failures.parentLink === "dangling") throw Object.assign(new Error("synthetic dangling parent target"), { code: "ENOENT" });
      if (args[0] === failures.parent && failures.deniedParent) throw Object.assign(new Error("synthetic inaccessible parent"), { code: "EACCES" });
      return actual.statSync(...args);
    },
  };
});

afterEach(() => { failures.marker = ""; failures.parent = ""; failures.deniedParent = false; failures.parentLink = ""; failures.deniedEntry = false; });

describe("schema ledger absence is portable (#216, Windows CI)", () => {
  it.each([
    ["absent", true, 0], ["directory", true, 0], ["file", true, 1], ["denied", true, 1],
    ["file", false, 0], ["denied", false, 0],
    ["dangling", true, 1], ["dangling", false, 0],
    ["denied-entry", true, 1], ["denied-entry", false, 0],
    ["linked-directory", true, 0], ["linked-directory", false, 0],
  ] as const)("parent=%s ledger=%s exits %s even when the child probe says ENOENT", async (parent, ledger, expected) => {
    const root = mkdtempSync(join(tmpdir(), "nen-marker-errno-"));
    try {
      mkdirSync(join(root, "nen"));
      for (const file of ["labels.json", "repos.json"]) copyFileSync(join(BANKAI_REPO, "nen", file), join(root, "nen", file));
      failures.parent = join(root, ".nen");
      failures.marker = join(failures.parent, "last-stop.json");
      if (parent === "file") writeFileSync(failures.parent, "not a directory");
      else if (parent !== "absent") mkdirSync(failures.parent);
      failures.deniedParent = parent === "denied";
      failures.deniedEntry = parent === "denied-entry";
      failures.parentLink = parent === "dangling" || parent === "linked-directory" ? parent : "";
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(["schema", "check", "--repo", root, "--json", ...(ledger ? ["--ledger"] : [])], {
        out: (line): void => { out.push(line); }, err: (line): void => { err.push(line); },
      });
      expect(code).toBe(expected);
      expect(err).toEqual([]);
      const report = JSON.parse(out.join("\n")) as { ok: boolean; checks: { file: string; ok: boolean; required: boolean; detail: string }[] };
      expect(report.ok).toBe(expected === 0);
      const marker = report.checks.find((row): boolean => row.file === ".nen/last-stop.json");
      if (!ledger) expect(marker).toBeUndefined();
      else if (expected === 0) expect(marker).toMatchObject({ ok: true, required: false, detail: expect.stringContaining("absent (optional") });
      else expect(marker).toMatchObject({ ok: false, required: true, detail: expect.stringContaining("could not read marker") });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
