import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../cli/args.js";
import { mergeFlags, VerbUsageError } from "../cli/command.js";
import type { Io } from "../index.js";
import { RepoRootError } from "../repo/root.js";
import { defaultSeams } from "../seam/exec.js";
import { stopCommand } from "./command.js";

// Mirrors ../index.ts's own runFamily() error-to-exit-code mapping, so a test
// calling a family's run() directly still sees the same contract a real
// invocation would.
function capture(argv: readonly string[], repoFlag: string | null = null): { code: number; out: string[]; err: string[] } {
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
  const args = parseArgs(argv, mergeFlags(stopCommand.flags));
  try {
    const code = stopCommand.run({ args, repoFlag, json: args.booleans.has("json"), io, seams: defaultSeams() });
    return { code, out, err };
  } catch (error) {
    err.push(error instanceof Error ? error.message : String(error));
    const code = error instanceof VerbUsageError || error instanceof UsageError || error instanceof RepoRootError ? 2 : 1;
    return { code, out, err };
  }
}

describe("nen stop --template", () => {
  it("renders a blank 5-column table and no signal line", () => {
    const result = capture(["stop", "--template"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).not.toMatch(/YOUR INPUT IS NEEDED/);
    expect(result.out.join("\n")).toMatch(/Effort/);
    expect(result.out.join("\n")).toMatch(/Session \/ lane/);
  });
});

describe("nen stop", () => {
  it("carries no built-in persona name -- --who states it, or it is absent", () => {
    const result = capture(["stop"]);
    expect(result.out.join("\n")).toMatch(/YOUR INPUT IS NEEDED/);
    expect(result.out.join("\n")).not.toMatch(/who:/);
  });

  it("names the gate given by --gate", () => {
    const result = capture(["stop", "--gate", "G4"]);
    expect(result.out.join("\n")).toMatch(/G4 -- policy\/spec change/);
  });

  it("refuses an unknown gate", () => {
    expect(capture(["stop", "--gate", "G9"]).code).toBe(2);
  });

  it("reports rung 1's status honestly, and states rungs 2-3 are not fired", () => {
    const notFired = capture(["stop"]);
    expect(notFired.out.join("\n")).toMatch(/NOT fired/);
    const fired = capture(["stop", "--notified"]);
    expect(fired.out.join("\n")).toMatch(/reported sent by the caller/);
    expect(fired.out.join("\n")).toMatch(/not fired by nen/);
  });

  it("renders an efforts table read from a file, padded", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-stop-"));
    const file = join(dir, "efforts.md");
    writeFileSync(file, "| a | bb |\n| --- | --- |\n| x | yy |\n");
    const result = capture(["stop", file], dir);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/\| a\s+\| bb\s+\|/);
  });

  it("emits a stable --json contract", () => {
    const result = capture(["stop", "--gate", "G2", "--json"]);
    const parsed: unknown = JSON.parse(result.out.join("\n"));
    expect(parsed).toMatchObject({ gate: "G2", who: null, notified: false });
  });
});
