import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerbContext } from "../cli/verb.js";
import { effortVerb } from "./verb.js";

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

describe("nen effort classify -- CLI wiring", () => {
  it("classifies every entry in the input array", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-effort-"));
    const path = join(dir, "efforts.json");
    writeFileSync(
      path,
      JSON.stringify([
        { kind: "child", issueState: "open", stageLabels: ["building"], modeLabelPresent: false, hasPr: false, prOpen: false, prIsDelivery: false, integrationBranchAlive: false },
      ]),
    );
    const { context, out } = makeContext({ args: ["classify"], values: { input: path } });
    expect(effortVerb.run(context)).toBe(0);
    expect(out[0]).toBe("stalled");
  });

  it("requires --input", () => {
    expect(effortVerb.run(makeContext({ args: ["classify"] }).context)).toBe(2);
  });

  it("reports an unreadable input loudly", () => {
    const { context, err } = makeContext({ args: ["classify"], values: { input: "/nope.json" } });
    expect(effortVerb.run(context)).toBe(1);
    expect(err.join("\n")).toMatch(/could not read/);
  });

  it("refuses an unknown subcommand", () => {
    expect(effortVerb.run(makeContext({ args: ["bogus"] }).context)).toBe(2);
  });
});
