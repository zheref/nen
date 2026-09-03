import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { epicCommand } from "./command.js";

async function capture(argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const seams: Seams = {
    run: (): CommandResult => {
      throw new Error("epic next-wave makes no subprocess call");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
  };
  const code = await runFamily(epicCommand, argv, null, false, io, seams);
  return { code, out, err };
}

describe("nen epic next-wave -- CLI wiring", () => {
  it("requires --citation, never defaulted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "- [ ] #1");
    const result = await capture(["epic", "next-wave", "--body-file", bodyFile]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--citation/);
  });

  it("computes without writing when --out is omitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "- [ ] #1");
    const result = await capture(["epic", "next-wave", "--body-file", bodyFile, "--citation", "UZF-1"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/next wave: #1/);
  });

  it("writes the rewritten body to --out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "body.md");
    const outFile = join(dir, "out.md");
    writeFileSync(bodyFile, "- [ ] #1");
    const result = await capture([
      "epic",
      "next-wave",
      "--body-file",
      bodyFile,
      "--citation",
      "UZF-1",
      "--completed",
      "1",
      "--out",
      outFile,
    ]);
    expect(result.code).toBe(0);
    expect(readFileSync(outFile, "utf8")).toMatch(/- \[x\] #1/);
  });

  it("reports a missing --body-file loudly rather than crashing", async () => {
    const result = await capture(["epic", "next-wave", "--body-file", "/nope/nope.md", "--citation", "UZF-1"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not read/);
  });

  // Review finding #18: exits 1 and never writes --out on a duplicated
  // checklist id, instead of silently picking a tie-break.
  it("exits 1 and does NOT write --out when the checklist has a duplicated child id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "body.md");
    const outFile = join(dir, "out.md");
    writeFileSync(bodyFile, ["- [x] #5 **[alice]**", "- [ ] #5 **[bob]**"].join("\n"));
    const result = await capture(["epic", "next-wave", "--body-file", bodyFile, "--citation", "UZF-1", "--out", outFile]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/duplicate child checklist id/);
    expect(result.err.join("\n")).toMatch(/#5/);
    expect(existsSync(outFile)).toBe(false);
  });

  // ---- zheref/nen#51: the issue's transcript, replayed through the CLI.

  it("parses the trailing-reference body ('Phase 0a — #101') that used to report {total:0,done:0}", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "epic-trailing.md");
    writeFileSync(bodyFile, ["## Children", "", "- [ ] Phase 0a — #101", "- [x] Phase 0b — #102"].join("\n"));
    const result = await capture(["epic", "next-wave", "--body-file", bodyFile, "--citation", "CON-9", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({
      total: 2,
      done: 1,
      release: [{ child: 101, owner: null }],
      unparsed: [],
    });
  });

  it("parses markdown-link children ('[#570](url)' and '/issues/N' under other text)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "epic-links.md");
    writeFileSync(
      bodyFile,
      [
        "- [ ] **Child 1** [#570](https://github.com/o/r/issues/570)",
        "- [x] **Child 2** [the auth leg](https://github.com/o/r/issues/571)",
      ].join("\n"),
    );
    const result = await capture(["epic", "next-wave", "--body-file", bodyFile, "--citation", "CON-9", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ total: 2, done: 1, release: [{ child: 570, owner: null }] });
  });

  it("surfaces unresolvable checkboxes: 'unparsed' in --json, plus a warning in both modes' stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, ["- [ ] #1", "- [ ] write the docs"].join("\n"));
    const json = await capture(["epic", "next-wave", "--body-file", bodyFile, "--citation", "UZF-1", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out.join("\n"))).toMatchObject({
      total: 1,
      unparsed: [{ line: 2, text: "- [ ] write the docs" }],
    });
    expect(json.err.join("\n")).toMatch(/warning: line 2 .* NOT counted: - \[ \] write the docs/);
    const human = await capture(["epic", "next-wave", "--body-file", bodyFile, "--citation", "UZF-1"]);
    expect(human.code).toBe(0);
    expect(human.out.join("\n")).toMatch(/WARNING: 1 checkbox line\(s\) had no resolvable child reference/);
    expect(human.err.join("\n")).toMatch(/warning: line 2/);
  });

  it("exits 1 and does NOT write --out when EVERY checkbox is unresolvable, instead of reporting an empty checklist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "body.md");
    const outFile = join(dir, "out.md");
    writeFileSync(bodyFile, ["- [ ] first thing", "- [x] second thing"].join("\n"));
    const result = await capture([
      "epic",
      "next-wave",
      "--body-file",
      bodyFile,
      "--citation",
      "UZF-1",
      "--out",
      outFile,
      "--json",
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/none carries a resolvable child reference/);
    expect(result.err.join("\n")).toMatch(/1: - \[ \] first thing/);
    expect(existsSync(outFile)).toBe(false);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["epic", "bogus"])).code).toBe(2);
  });
});
