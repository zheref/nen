import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerbContext } from "../cli/verb.js";
import { devVerb } from "./verb.js";

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

describe("nen dev replay -- CLI wiring", () => {
  it("replays the imported slice and exits 0 when everything agrees", () => {
    const sliceDir = join(process.cwd(), "tests", "fixtures", "dualrun-slice", "dedupe");
    const { context, out } = makeContext({ args: ["replay"], values: { "slice-dir": sliceDir } });
    expect(devVerb.run(context)).toBe(0);
    expect(out.join("\n")).toMatch(/0 failed/);
  });

  it("defaults --slice-dir to <repo>/tests/fixtures/dualrun-slice/dedupe", () => {
    const { context, out } = makeContext({ args: ["replay"] }); // repoFlag null -> process.cwd(), the nen checkout itself
    expect(devVerb.run(context)).toBe(0);
    expect(out.join("\n")).toMatch(/replayed \d+ fixture/);
  });
});

describe("nen dev test/lint -- CLI wiring refuses a checkout-less directory", () => {
  it("dev test reports no package.json rather than crashing", () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-dev-verb-"));
    const { context, err } = makeContext({ args: ["test"], repoFlag: empty });
    expect(devVerb.run(context)).toBe(2);
    expect(err.join("\n")).toMatch(/no package\.json/);
  });

  it("dev lint reports no package.json rather than crashing", () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-dev-verb-"));
    const { context, err } = makeContext({ args: ["lint"], repoFlag: empty });
    expect(devVerb.run(context)).toBe(2);
    expect(err.join("\n")).toMatch(/no package\.json/);
  });
});

describe("nen dev -- refuses an unknown subcommand", () => {
  it("exits 2", () => {
    expect(devVerb.run(makeContext({ args: ["bogus"] }).context)).toBe(2);
  });
});
