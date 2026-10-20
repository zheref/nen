// src/schema/canonmirror.integration.test.ts -- zheref/nen#262 end to end,
// against a REAL git: a consumer rebinds a token, `nen schema check` FAILs the
// `.claude/rules/` row with the regenerate remedy, and passes once the mirror
// carries the new value. Repo-local identity, no network, and a SKIP where git
// is missing (the shape of ../canon/checkout.integration.test.ts).

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Io } from "../index.js";
import { fileMarker } from "../canon/mirror.js";
import { defaultSeams } from "../seam/exec.js";
import { BANKAI_REPO } from "./fixtures/paths.js";

const HAVE_GIT = spawnSync("git", ["--version"]).status === 0;

// Every repository a test makes is removed at the end, as the sibling suites do.
const temps: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-canonmirror-int-"));
  temps.push(dir);
  return dir;
}
afterAll((): void => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-c", "user.name=nen test", "-c", "user.email=nen@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} exited ${result.status ?? "?"}: ${result.stderr}`);
}

async function schemaCheck(root: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => { out.push(line); }, err: (line): void => { err.push(line); } };
  const code = await run(["schema", "check", "--repo", root], io, defaultSeams());
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const PIN = { source: "owner/handbooks", ref: "v1.0.0", scenario: "swiftui" };
const bindings = (os: string): string => `scenario: swiftui\nsurfaces: claude-code\nvalues:\n  SNAPSHOT_OS: "${os}"\n  DEVICE: iPhone 17\n`;
const rule = (name: string, os: string): string => `${fileMarker(PIN, name)}\n# Testing\n\nSnapshots run on iOS ${os} on an iPhone 17.\n\nAn older project on 25.0 migrates first.\n`;

describe.skipIf(!HAVE_GIT)("nen schema check -- the .claude/rules/ row against a real history (zheref/nen#262)", () => {
  it("FAILs a rebind the mirror missed, names the remedy, and passes once regenerated", async () => {
    const root = temp();
    cpSync(join(BANKAI_REPO, "nen"), join(root, "nen"), { recursive: true });
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    git(root, ["init", "-q"]);
    writeFileSync(join(root, ".claude", "canon-values.yml"), bindings("26.5"));
    for (const name of ["07-testing.md", "13-build-execution.md"]) writeFileSync(join(root, ".claude", "rules", name), rule(name, "26.5"));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "mirror at 26.5"]);

    const before = await schemaCheck(root);
    expect(before.code).toBe(0);
    expect(before.out).toMatch(/ok {4}\.claude\/rules\/ {2}mirror consistent with \.claude\/canon-values\.yml \(2 tokens, 2 files, 1 revision\(s\) read\)/);

    // The rebind, uncommitted -- exactly the session the issue describes.
    writeFileSync(join(root, ".claude", "canon-values.yml"), bindings("27.0"));
    const stale = await schemaCheck(root);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain(
      "FAIL  .claude/rules/  SNAPSHOT_OS is bound to '27.0' but 2 file(s) still carry '26.5': 07-testing.md, 13-build-execution.md. Regenerate the mirror (nen canon mirror generate); never hand-edit it (CON-13).",
    );
    expect(stale.err).toMatch(/Regenerate it with 'nen canon mirror generate'; never hand-edit a mirror file \(CON-13\)/);
    expect(stale.err).not.toMatch(/taxonomy could not be read/);

    // Regenerated: the bound value is in, the old one survives only as prose elsewhere.
    for (const name of ["07-testing.md", "13-build-execution.md"]) writeFileSync(join(root, ".claude", "rules", name), rule(name, "27.0"));
    writeFileSync(join(root, ".claude", "rules", "13-build-execution.md"), `${rule("13-build-execution.md", "27.0")}The 26.5 runtime was removed by Xcode.\n`);
    const fresh = await schemaCheck(root);
    expect(fresh.code).toBe(0);
    expect(fresh.out).toMatch(/ok {4}\.claude\/rules\/ {2}mirror consistent/);
  });

  it("an untracked bindings file is NOT CHECKED (no committed revision), and the report still passes", async () => {
    const root = temp();
    cpSync(join(BANKAI_REPO, "nen"), join(root, "nen"), { recursive: true });
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    git(root, ["init", "-q"]);
    git(root, ["add", "nen"]);
    git(root, ["commit", "-q", "-m", "base"]);
    writeFileSync(join(root, ".claude", "canon-values.yml"), bindings("27.0"));
    writeFileSync(join(root, ".claude", "rules", "07-testing.md"), rule("07-testing.md", "26.5"));
    const result = await schemaCheck(root);
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "warn  .claude/rules/  NOT CHECKED -- .claude/canon-values.yml has no committed revision, so no superseded value is known (2 tokens, 1 files)",
    );
  });

  it("a shallow clone of a stale mirror is NOT CHECKED, never consistent", async () => {
    const origin = temp();
    cpSync(join(BANKAI_REPO, "nen"), join(origin, "nen"), { recursive: true });
    mkdirSync(join(origin, ".claude", "rules"), { recursive: true });
    git(origin, ["init", "-q"]);
    writeFileSync(join(origin, ".claude", "canon-values.yml"), bindings("26.5"));
    writeFileSync(join(origin, ".claude", "rules", "07-testing.md"), rule("07-testing.md", "26.5"));
    git(origin, ["add", "-A"]);
    git(origin, ["commit", "-q", "-m", "one"]);
    writeFileSync(join(origin, ".claude", "canon-values.yml"), bindings("27.0"));
    git(origin, ["commit", "-q", "-a", "-m", "rebind"]);
    expect((await schemaCheck(origin)).code).toBe(1);

    const shallow = join(temp(), "clone");
    git(temp(), ["clone", "-q", "--depth", "1", `file://${origin}`, shallow]);
    const result = await schemaCheck(shallow);
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "warn  .claude/rules/  NOT CHECKED -- .claude/canon-values.yml has no readable git history (a shallow clone: earlier revisions are unavailable), so no superseded value is known (2 tokens, 1 files)",
    );
  });
});
