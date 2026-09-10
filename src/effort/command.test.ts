import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { effortCommand } from "./command.js";
import { EFFORT_CLASSES, TAXONOMY_CLASSES } from "./classify.js";
import { noPortProbe } from "../seam/scripted.js";

async function capture(argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const seams: Seams = {
    run: (): CommandResult => {
      throw new Error("effort classify makes no subprocess call");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("this verb has no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("this verb has no watched form");
    },
    platform: "linux",
  };
  const code = await runFamily(effortCommand, argv, null, false, io, seams);
  return { code, out, err };
}

describe("nen effort classify -- CLI wiring", () => {
  it("classifies every entry in the input array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-effort-"));
    const path = join(dir, "efforts.json");
    writeFileSync(
      path,
      JSON.stringify([
        { kind: "child", issueState: "open", stageLabels: ["building"], modeLabelPresent: false, hasPr: false, prOpen: false, prIsDelivery: false, integrationBranchAlive: false },
      ]),
    );
    const result = await capture(["effort", "classify", "--input", path]);
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("stalled");
  });

  it("requires --input", async () => {
    expect((await capture(["effort", "classify"])).code).toBe(2);
  });

  it("reports an unreadable input loudly", async () => {
    const result = await capture(["effort", "classify", "--input", "/nope.json"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not read/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["effort", "bogus"])).code).toBe(2);
  });
});

// zheref/nen#53. `--help` described a "five-class taxonomy" and then listed six
// names, while the verb really returns seven -- `undecidable` appeared in
// neither the count nor the list, so a caller reading only `--help` had no
// signal it existed at all. The prose is fixed; this is what keeps it fixed.
describe("nen effort --help -- the vocabulary it prints is the vocabulary it has", () => {
  it("names every class the verb can return", () => {
    // A sentence goes stale; a list checked against the union does not. The
    // `satisfies` in ./classify.ts fails the build if a class is added to the
    // union and not to EFFORT_CLASSES; this fails it if one is in
    // EFFORT_CLASSES and not in the help text.
    for (const name of EFFORT_CLASSES) {
      expect(effortCommand.usage, name).toContain(name);
    }
  });

  it("does not claim a count that contradicts that list", () => {
    // The five ARE senkei's taxonomy and the verb's own name for itself says
    // so; what the text may not do is let "five-class" stand as the whole
    // output vocabulary, which is how `undecidable` went unmentioned.
    expect(effortCommand.usage).toContain("SEVEN VALUES ARE PRINTABLE");
    for (const name of TAXONOMY_CLASSES) expect(effortCommand.usage).toContain(name);
  });
});
