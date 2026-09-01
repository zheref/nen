import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerbContext } from "../cli/verb.js";
import { loopVerb } from "./verb.js";

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

describe("nen loop slots -- CLI wiring", () => {
  it("exits 1 when a budget is fully occupied", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([
      { id: "a", plane: "ci", prOpen: false },
      { id: "b", plane: "ci", prOpen: false },
    ]));
    const { context, out } = makeContext({ args: ["slots"], values: { efforts: path } });
    expect(loopVerb.run(context)).toBe(1);
    expect(out.join("\n")).toMatch(/BINDING/);
  });

  it("exits 0 with free slots on both planes", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([]));
    const { context } = makeContext({ args: ["slots"], values: { efforts: path } });
    expect(loopVerb.run(context)).toBe(0);
  });

  it("reports a schema error from the efforts file loudly", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([{ id: "a" }]));
    const { context, err } = makeContext({ args: ["slots"], values: { efforts: path } });
    expect(loopVerb.run(context)).toBe(1);
    expect(err.join("\n")).toMatch(/must be "ci" or "local"/);
  });

  it("requires --efforts", () => {
    expect(loopVerb.run(makeContext({ args: ["slots"] }).context)).toBe(2);
  });
});
