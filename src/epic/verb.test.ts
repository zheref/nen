import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerbContext } from "../cli/verb.js";
import { epicVerb } from "./verb.js";

function makeContext(overrides: Partial<VerbContext> = {}): { context: VerbContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const context: VerbContext = {
    args: [],
    values: {},
    booleans: new Set(),
    passthrough: [],
    repoFlag: null,
    json: false,
    io: { out: (l): void => void out.push(l), err: (l): void => void err.push(l) },
    ...overrides,
  };
  return { context, out, err };
}

describe("nen epic next-wave -- CLI wiring", () => {
  it("requires --citation, never defaulted", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "- [ ] #1");
    const { context, err } = makeContext({ args: ["next-wave"], values: { "body-file": bodyFile } });
    expect(epicVerb.run(context)).toBe(2);
    expect(err.join("\n")).toMatch(/--citation/);
  });

  it("computes without writing when --out is omitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "- [ ] #1");
    const { context, out } = makeContext({
      args: ["next-wave"],
      values: { "body-file": bodyFile, citation: "UZF-1" },
    });
    expect(epicVerb.run(context)).toBe(0);
    expect(out.join("\n")).toMatch(/next wave: #1/);
  });

  it("writes the rewritten body to --out", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "body.md");
    const outFile = join(dir, "out.md");
    writeFileSync(bodyFile, "- [ ] #1");
    const { context } = makeContext({
      args: ["next-wave"],
      values: { "body-file": bodyFile, citation: "UZF-1", completed: "1", out: outFile },
    });
    expect(epicVerb.run(context)).toBe(0);
    expect(readFileSync(outFile, "utf8")).toMatch(/- \[x\] #1/);
  });

  it("reports a missing --body-file loudly rather than crashing", () => {
    const { context, err } = makeContext({
      args: ["next-wave"],
      values: { "body-file": "/nope/nope.md", citation: "UZF-1" },
    });
    expect(epicVerb.run(context)).toBe(1);
    expect(err.join("\n")).toMatch(/could not read/);
  });

  // Review finding #18: exits 1 and never writes --out on a duplicated
  // checklist id, instead of silently picking a tie-break.
  it("exits 1 and does NOT write --out when the checklist has a duplicated child id", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "body.md");
    const outFile = join(dir, "out.md");
    writeFileSync(bodyFile, ["- [x] #5 **[alice]**", "- [ ] #5 **[bob]**"].join("\n"));
    const { context, err } = makeContext({
      args: ["next-wave"],
      values: { "body-file": bodyFile, citation: "UZF-1", out: outFile },
    });
    expect(epicVerb.run(context)).toBe(1);
    expect(err.join("\n")).toMatch(/duplicate child checklist id/);
    expect(err.join("\n")).toMatch(/#5/);
    expect(existsSync(outFile)).toBe(false);
  });

  it("refuses an unknown subcommand", () => {
    expect(epicVerb.run(makeContext({ args: ["bogus"] }).context)).toBe(2);
  });
});
