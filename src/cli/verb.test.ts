import { describe, expect, it } from "vitest";
import {
  allValueFlags,
  contextFrom,
  mergeFlags,
  peekCommand,
  usage,
  type Verb,
} from "./verb.js";
import { parseArgs } from "./args.js";

const ISSUE: Verb = {
  name: "issue",
  summary: "s",
  usage: "u",
  flags: { values: ["target"], booleans: ["dry-run"] },
  run: (): number => 0,
};
const EPIC: Verb = {
  name: "epic",
  summary: "s",
  usage: "u",
  flags: { values: ["cap"], booleans: [] },
  run: (): number => 0,
};

describe("peekCommand -- finds the verb name without consuming or validating", () => {
  it("returns the first positional", () => {
    expect(peekCommand(["issue", "search"], new Set())).toBe("issue");
  });

  it("skips a value flag's value, so it is never mistaken for the verb", () => {
    expect(peekCommand(["--repo", "build", "issue"], new Set(["repo"]))).toBe("issue");
  });

  it("does not skip past a boolean flag's own token", () => {
    expect(peekCommand(["--json", "issue"], new Set(["repo"]))).toBe("issue");
  });

  it("resolves an alias before checking whether it takes a value", () => {
    expect(peekCommand(["-r", "build", "issue"], new Set(["repo"]), { r: "repo" })).toBe("issue");
  });

  it("stops at a bare --", () => {
    expect(peekCommand(["--", "issue"], new Set())).toBeNull();
  });

  it("returns null with nothing but flags", () => {
    expect(peekCommand(["--json"], new Set())).toBeNull();
  });

  it("does not consume a value for an inline --name=value flag", () => {
    expect(peekCommand(["--repo=../x", "issue"], new Set(["repo"]))).toBe("issue");
  });
});

describe("allValueFlags -- union of the base and every verb's value flags", () => {
  it("collects from the base and every registered verb", () => {
    const set = allValueFlags({ values: ["repo"] }, [ISSUE, EPIC]);
    expect([...set].sort()).toEqual(["cap", "repo", "target"]);
  });
});

describe("mergeFlags", () => {
  it("unions values, booleans and aliases from base and extra", () => {
    const merged = mergeFlags(
      { values: ["repo"], booleans: ["json"], aliases: { r: "repo" } },
      { values: ["target"], booleans: ["dry-run"], aliases: { t: "target" } },
    );
    expect(merged.values).toEqual(["repo", "target"]);
    expect(merged.booleans).toEqual(["json", "dry-run"]);
    expect(merged.aliases).toEqual({ r: "repo", t: "target" });
  });
});

describe("contextFrom", () => {
  it("drops the verb name and carries the rest through", () => {
    const parsed = parseArgs(["issue", "search", "--target", "o/n", "--json"], {
      values: ["target"],
      booleans: ["json"],
    });
    const io = { out: (): void => {}, err: (): void => {} };
    const context = contextFrom(parsed, io);
    expect(context.args).toEqual(["search"]);
    expect(context.values["target"]).toBe("o/n");
    expect(context.json).toBe(true);
    expect(context.repoFlag).toBeNull();
  });
});

describe("usage", () => {
  it("writes to err and returns 2", () => {
    const err: string[] = [];
    const code = usage({ out: (): void => {}, err: (line): void => void err.push(line) }, "bad flag");
    expect(code).toBe(2);
    expect(err[0]).toMatch(/bad flag/);
  });
});
