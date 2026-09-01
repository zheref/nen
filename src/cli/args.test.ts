import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "./args.js";

const SPEC = {
  values: ["repo", "ref"],
  booleans: ["json", "version", "help"],
  aliases: { v: "version", h: "help" },
} as const;

describe("parseArgs", () => {
  it("collects positionals in order", () => {
    const parsed = parseArgs(["dev", "test"], SPEC);
    expect(parsed.positionals).toEqual(["dev", "test"]);
  });

  it("reads a value flag in both spellings", () => {
    expect(parseArgs(["--repo", "../x"], SPEC).values["repo"]).toBe("../x");
    expect(parseArgs(["--repo=../x"], SPEC).values["repo"]).toBe("../x");
  });

  it("reads boolean flags and their single-dash aliases", () => {
    expect(parseArgs(["--json"], SPEC).booleans.has("json")).toBe(true);
    expect(parseArgs(["-v"], SPEC).booleans.has("version")).toBe(true);
    expect(parseArgs(["-h"], SPEC).booleans.has("help")).toBe(true);
  });

  it("REFUSES an unknown flag rather than ignoring it", () => {
    // The whole reason this parser exists: `--reop` silently dropped means the
    // command runs against the wrong repository and succeeds.
    expect(() => parseArgs(["--reop", "../x"], SPEC)).toThrow(UsageError);
    expect(() => parseArgs(["--reop", "../x"], SPEC)).toThrow(/unknown option/);
  });

  it("refuses a value flag whose value is missing", () => {
    expect(() => parseArgs(["--repo"], SPEC)).toThrow(/--repo requires a value/);
  });

  it("refuses to swallow the NEXT FLAG as a missing value", () => {
    expect(() => parseArgs(["--repo", "--json"], SPEC)).toThrow(
      /--repo requires a value/,
    );
  });

  it("refuses a value attached to a boolean flag", () => {
    expect(() => parseArgs(["--json=yes"], SPEC)).toThrow(/does not take a value/);
  });

  it("passes everything after `--` through untouched", () => {
    const parsed = parseArgs(
      ["dev", "test", "--json", "--", "--reporter", "verbose", "-t", "x"],
      SPEC,
    );
    expect(parsed.positionals).toEqual(["dev", "test"]);
    expect(parsed.booleans.has("json")).toBe(true);
    expect(parsed.passthrough).toEqual(["--reporter", "verbose", "-t", "x"]);
  });

  it("treats a bare '-' as a positional", () => {
    expect(parseArgs(["-"], SPEC).positionals).toEqual(["-"]);
  });

  it("does not cluster short flags", () => {
    expect(() => parseArgs(["-vh"], SPEC)).toThrow(UsageError);
  });
});
