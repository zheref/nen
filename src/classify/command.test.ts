import { describe, expect, it } from "vitest";
import { classifyCommand } from "./command.js";
import { COMMANDS } from "../cli/registry.js";
import { capture, landedRepo, MINI, SLUG } from "./fixtures/harness.js";

describe("nen classify -- registration and dispatch", () => {
  it("is registered, between changelog and color, with its four subcommands", () => {
    const names = COMMANDS.map((command): string => command.name);
    expect(names.indexOf("classify")).toBe(names.indexOf("changelog") + 1);
    expect(names.indexOf("classify")).toBe(names.indexOf("color") - 1);
    expect(classifyCommand.subcommands).toEqual(["labels", "install", "status", "apply"]);
  });

  it("refuses a bare family, and an unknown subcommand, at exit 2", async () => {
    expect((await capture(["classify"])).code).toBe(2);
    const result = await capture(["classify", "bogus", "--taxonomy", MINI]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/unknown 'classify' subcommand 'bogus'/);
  });

  it("refuses --help on a subcommand it does not have", async () => {
    expect((await capture(["classify", "bogus", "--help"])).code).toBe(2);
  });
});

describe("nen classify --help -- the usage text names what the verbs take", () => {
  it("names every subcommand and every flag the family declares", async () => {
    const result = await capture(["classify", "--help"]);
    expect(result.code).toBe(0);
    const text = result.out.join("\n");
    for (const subcommand of classifyCommand.subcommands ?? []) {
      expect(text, `usage does not name 'nen classify ${subcommand}'`).toContain(`nen classify ${subcommand}`);
    }
    const flags = [
      ...(classifyCommand.flags.values ?? []),
      ...(classifyCommand.flags.booleans ?? []),
      "repo",
      "json",
    ];
    for (const flag of flags) {
      expect(text, `usage does not name --${flag}`).toContain(`--${flag}`);
    }
  });

  it("states the exit codes' meaning for the refusals a caller branches on", async () => {
    const text = (await capture(["classify", "--help"])).out.join("\n");
    expect(text).toMatch(/--write and --sync together are a usage error \(exit 2\)/);
    expect(text).toMatch(/Refuses at exit 1/);
    expect(text).toMatch(/refuses the plan whole \(exit 2/);
    expect(text).toContain("nen.classify.<verb>/v0.1");
  });
});

describe("nen classify -- a flag that belongs to another verb is a usage error", () => {
  // [verb, the verb's own valid argv, the foreign flag (and value) added, the flag, the verb that owns it]
  const cases: readonly (readonly [string, readonly string[], readonly string[], string, string])[] = [
    ["labels", [], ["--run"], "--run", "classify apply"],
    ["install", [], ["--plan", "p.json"], "--plan", "classify apply"],
    ["status", ["--target", SLUG, "--open"], ["--write"], "--write", "classify install"],
    ["apply", ["--target", SLUG, "--plan", "p.json"], ["--write"], "--write", "classify install"],
  ];
  for (const [verb, own, foreign, flag, owner] of cases) {
    it(`'${verb}' refuses ${flag} at exit 2, naming the flag, the verb and its owner`, async () => {
      const result = await capture(["classify", verb, "--taxonomy", MINI, "--repo", landedRepo(), ...own, ...foreign]);
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toContain(`${flag} is not a flag of 'classify ${verb}'`);
      expect(result.err.join("\n")).toContain(owner);
      expect(result.seams.calls).toEqual([]);
    });
  }

  it("still accepts a verb's own flags (the allow-list is not over-eager)", async () => {
    expect((await capture(["classify", "labels", "--taxonomy", MINI, "--json"])).code).toBe(0);
  });
});
