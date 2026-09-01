import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { VerbContext } from "../cli/verb.js";
import { runParse } from "./verb.js";

function makeContext(overrides: Partial<VerbContext> = {}): { context: VerbContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const context: VerbContext = {
    args: [],
    values: {},
    booleans: new Set(),
    passthrough: [],
    repoFlag: BANKAI_REPO,
    json: false,
    io: { out: (l): void => void out.push(l), err: (l): void => void err.push(l) },
    ...overrides,
  };
  return { context, out, err };
}

describe("nen parse futon -- CLI wiring", () => {
  it("resolves a known consumer code, build-only", () => {
    const { context, out } = makeContext({ args: ["futon", "KP@high"], values: { self: "zheref/bankai-core" } });
    const code = runParse(context, new ScriptedRunner([]));
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/repo: zheref\/KroApple \(KP\)/);
    expect(out.join("\n")).toMatch(/terminal: \(none -- build-only\)/);
  });

  it("emits the stable --json contract", () => {
    const { context, out } = makeContext({
      args: ["futon", "KP@high+"],
      values: { self: "zheref/bankai-core" },
      json: true,
    });
    expect(runParse(context, new ScriptedRunner([]))).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as { band: { severities: string[] } };
    expect(parsed.band.severities).toEqual(["critical", "high"]);
  });

  it("refuses a 'then tag' clause against a non-self consumer, with a corrected line", () => {
    const { context, err } = makeContext({ args: ["futon", "KP@high then tag"], values: { self: "zheref/bankai-core" } });
    expect(runParse(context, new ScriptedRunner([]))).toBe(2);
    expect(err.join("\n")).toMatch(/is refused against 'zheref\/KroApple'/);
    expect(err.join("\n")).toMatch(/try: KP@high/);
  });

  it("refuses an unparseable invocation before ever touching the registry", () => {
    const { context, err } = makeContext({ args: ["futon", "not an invocation"] });
    expect(runParse(context, new ScriptedRunner([]))).toBe(2);
    expect(err.join("\n")).toMatch(/no '@<severity>'/);
  });

  it("requires an invocation string", () => {
    expect(runParse(makeContext({ args: ["futon"] }).context, new ScriptedRunner([]))).toBe(2);
  });

  it("resolves 'the repo you are standing in' from origin when the token is omitted", () => {
    const { context, out } = makeContext({ args: ["futon", "@critical"] });
    const runner = new ScriptedRunner([
      { match: "git remote get-url origin", result: { stdout: "git@github.com:zheref/bankai-core.git\n" } },
    ]);
    expect(runParse(context, runner)).toBe(0);
    expect(out.join("\n")).toMatch(/repo: zheref\/bankai-core/);
  });

  it("refuses an unknown parse subcommand", () => {
    expect(runParse(makeContext({ args: ["bogus"] }).context, new ScriptedRunner([]))).toBe(2);
  });
});
