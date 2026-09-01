import { describe, expect, it } from "vitest";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { VerbContext } from "../cli/verb.js";
import { canonVerb } from "./verb.js";

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

describe("nen canon resolve -- CLI wiring", () => {
  it("resolves the scenario recorded for the target and derives the stack path", () => {
    const { context, out } = canonContext({
      target: "zheref/KroApple",
      "always-load": "handbooks/uzf-core.md,handbooks/security-baseline.md",
      "stack-dir": "handbooks/stacks",
    });
    expect(canonVerb.run(context)).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/scenario: swiftui-tca-uzf-v2/);
    expect(text).toMatch(/always load: handbooks\/uzf-core\.md, handbooks\/security-baseline\.md/);
    expect(text).toMatch(/stack handbook: handbooks\/stacks\/swiftui-tca-uzf-v2\/architecture\.md/);
  });

  it("exits 1 when the target repo has no recorded scenario", () => {
    const { context, err } = canonContext({ target: "zheref/nonexistent", "stack-dir": "handbooks/stacks" });
    expect(canonVerb.run(context)).toBe(1);
    expect(err.join("\n")).toMatch(/is not a consumer/);
  });

  it("requires --target and --stack-dir", () => {
    expect(canonVerb.run(canonContext({}).context)).toBe(2);
    expect(canonVerb.run(canonContext({ target: "o/n" }).context)).toBe(2);
  });

  it("refuses an unknown subcommand", () => {
    expect(canonVerb.run(makeContext({ args: ["bogus"] }).context)).toBe(2);
  });
});

function canonContext(values: Record<string, string>): { context: VerbContext; out: string[]; err: string[] } {
  return makeContext({ args: ["resolve"], values });
}
