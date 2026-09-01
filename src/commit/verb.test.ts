import { describe, expect, it } from "vitest";
import type { VerbContext } from "../cli/verb.js";
import { commitVerb } from "./verb.js";

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

describe("nen commit format -- CLI wiring", () => {
  it("prints the formatted message", () => {
    const { context, out } = makeContext({
      args: ["format"],
      values: { type: "fix", subject: "stop dropping the last row" },
    });
    expect(commitVerb.run(context)).toBe(0);
    expect(out).toEqual(["fix: stop dropping the last row"]);
  });

  it("passes --scope, --body and --trailer through", () => {
    const { context, out } = makeContext({
      args: ["format"],
      values: { type: "feat", scope: "cli", subject: "add a verb", body: "why", trailer: "Closes=#4" },
    });
    expect(commitVerb.run(context)).toBe(0);
    expect(out.join("\n")).toBe("feat(cli): add a verb\n\nwhy\n\nCloses: #4");
  });

  it("exits 2 on a shape violation, printing every refusal", () => {
    const { context, err } = makeContext({ args: ["format"], values: { type: "bogus", subject: "" } });
    expect(commitVerb.run(context)).toBe(2);
    expect(err.length).toBeGreaterThan(0);
  });

  it("requires --type and --subject", () => {
    expect(commitVerb.run(makeContext({ args: ["format"], values: { type: "feat" } }).context)).toBe(2);
    expect(commitVerb.run(makeContext({ args: ["format"], values: { subject: "x" } }).context)).toBe(2);
  });

  it("refuses an unknown subcommand", () => {
    expect(commitVerb.run(makeContext({ args: ["bogus"] }).context)).toBe(2);
  });
});
