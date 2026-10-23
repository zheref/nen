import { describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, runFamily, type Io } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { sessionCommand } from "./command.js";
import { SESSION_CONTRACT, sessionLedgerPath } from "./ledger.js";

const NOW = "2026-10-19T12:00:00.000Z";
async function capture(argv: string[], repo: string, full = false): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [], err: string[] = [];
  const io: Io = { out: (line): void => { out.push(line); }, err: (line): void => { err.push(line); } };
  // The one call the ledger home makes (zheref/nen#509): a temp dir is not a git
  // repository, so the ledger stays under --repo. Nothing else may be spawned.
  const commonDir = "git rev-parse --path-format=absolute --git-common-dir";
  const seams = new ScriptedSeams([{ match: commonDir, result: { code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git" } }], { now: (): Date => new Date(NOW), env: { SESSION_ID: "never infer", MODEL: "never infer" } });
  const code = full ? await run([...argv, "--repo", repo], io, seams) : await runFamily(sessionCommand, argv, repo, false, io, seams);
  expect(seams.calls.map((call): string => [call.command, ...call.args].join(" ")).filter((call): boolean => call !== commonDir)).toEqual([]);
  return { code, out, err };
}
const root = (): string => mkdtempSync(join(tmpdir(), "nen-session-command-"));

describe("session record/show", () => {
  it("dispatches through the registry, preserving every accepted value and the seam's clock", async () => {
    const repo = root();
    const result = await capture(["session", "record", "--effort", "HA/437", "--surface", " codex ", "--model", " sol ", "--dial", "custom HIGH", "--title", " Shibari attribution metadata ", "--id", "local_abc", "--source", " supplied log ", "--json"], repo, true);
    expect(result.code).toBe(0);
    const path = sessionLedgerPath(repo, "HA/437");
    expect(path).toContain("HA%2F437.json");
    const expected = { recordedAt: NOW, surface: " codex ", model: " sol ", dial: "custom HIGH", title: " Shibari attribution metadata ", id: "local_abc", source: " supplied log " };
    expect(JSON.parse(result.out.join("\n"))).toEqual({ path, entry: expected });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ contract: SESSION_CONTRACT, effort: "HA/437", entries: [expected] });
    const shown = await capture(["session", "show", "--effort", "HA/437", "--json"], repo);
    expect(JSON.parse(shown.out.join("\n"))).toEqual({ contract: SESSION_CONTRACT, effort: "HA/437", entries: [expected] });
    expect((await capture(["session", "show", "--effort", "HA/437"], repo)).out.join("\n")).toContain("Shibari attribution metadata");
  });

  it.each([["--title", "A title"], ["--id", "local_abc"]])("allows %s alone, uses null for every omitted value and appends", async (flag, value) => {
    const repo = root();
    for (let n = 0; n < 2; n += 1) expect((await capture(["session", "record", "--effort", "e", "--surface", "codex", flag, value], repo)).code).toBe(0);
    const doc = JSON.parse(readFileSync(sessionLedgerPath(repo, "e"), "utf8")) as { entries: Record<string, unknown>[] };
    expect(doc.entries).toHaveLength(2);
    expect(doc.entries[0]).toEqual({ recordedAt: NOW, surface: "codex", model: null, dial: null, title: flag === "--title" ? value : null, id: flag === "--id" ? value : null, source: null });
  });

  it.each([[], ["--title", ""], ["--title", " \t", "--id", "\n"], ["--id", " "]].map((args) => ({ args })))("refuses an identity with nothing meaningful (%j), naming both flags without writing", async ({ args: identity }) => {
    const repo = root();
    const result = await capture(["session", "record", "--effort", "e", "--surface", "codex", ...identity], repo);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("--title");
    expect(result.err.join("\n")).toContain("--id");
    expect(existsSync(join(repo, ".nen"))).toBe(false);
  });

  it("keeps a blank optional identity verbatim when its counterpart identifies something", async () => {
    const repo = root();
    expect((await capture(["session", "record", "--effort", "e", "--surface", "codex", "--title", " ", "--id", "real"], repo)).code).toBe(0);
    expect(JSON.parse(readFileSync(sessionLedgerPath(repo, "e"), "utf8")).entries[0].title).toBe(" ");
  });

  it("shows an absent ledger without creating a directory", async () => {
    const repo = root();
    const shown = await capture(["session", "show", "--effort", "e", "--json"], repo);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.out.join("\n"))).toEqual({ contract: SESSION_CONTRACT, effort: "e", entries: [] });
    expect(existsSync(join(repo, ".nen"))).toBe(false);
  });

  it.each([[], ["--effort", "../escape"], ["--effort", "e"], ["--effort", "e", "--surface", " "]].map((args) => ({ args })))("refuses missing or malformed required flags: %j", async ({ args: flags }) => {
    expect((await capture(["session", "record", ...flags, "--title", "title"], root())).code).toBe(2);
  });

  it("refuses a malformed ledger without overwriting its bytes", async () => {
    const repo = root();
    await capture(["session", "record", "--effort", "e", "--surface", "codex", "--id", "a"], repo);
    const path = sessionLedgerPath(repo, "e");
    writeFileSync(path, "broken JSON");
    expect((await capture(["session", "record", "--effort", "e", "--surface", "codex", "--id", "b"], repo)).code).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("broken JSON");
  });
});


describe("Hanten session regressions (#437)", () => {
  it.skipIf(process.platform === "win32").each(["show", "record"])("C437-1 refuses a dangling ledger link on %s, preserving the link", async (verb) => {
    // Creating a symlink requires a Windows host privilege this fixture does not assume.
    const repo = root(), path = sessionLedgerPath(repo, "e");
    mkdirSync(join(repo, ".nen/sessions"), { recursive: true });
    symlinkSync("missing-ledger.json", path);
    for (const argv of [verb === "show" ? ["session", "show", "--effort", "e", "--json"] : ["session", "record", "--effort", "e", "--surface", "codex", "--title", "Session"]]) {
      const result = await capture(argv, repo);
      expect(result.code, result.out.join("\n")).toBe(1);
      expect(result.err.join("\n")).toContain(path);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(readlinkSync(path)).toBe("missing-ledger.json");
    }
  });

  it.each([{ tail: ["tail"] }, { tail: ["--", "tail"] }])("C437-2 refuses stray ordinary/passthrough tokens before any append: %j", async ({ tail }) => {
    const repo = root();
    const record = ["session", "record", "--effort", "e", "--surface", "codex", "--title", "Session"];
    expect((await capture(record, repo)).code).toBe(0);
    const path = sessionLedgerPath(repo, "e"), before = readFileSync(path, "utf8");
    for (const argv of [[...record, ...tail], ["session", "show", "--effort", "e", ...tail]]) {
      const result = await capture(argv, repo);
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toContain('Unexpected positional "tail"');
      expect(result.out).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });
});
