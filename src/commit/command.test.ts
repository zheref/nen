import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { commitCommand } from "./command.js";

async function capture(argv: readonly string[], json = false): Promise<{ code: number; out: string[]; err: string[] }> {
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
      throw new Error("commit format makes no subprocess call");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
  };
  const code = await runFamily(commitCommand, argv, null, json, io, seams);
  return { code, out, err };
}

describe("nen commit format -- CLI wiring", () => {
  it("prints the formatted message", async () => {
    const result = await capture(["commit", "format", "--type", "fix", "--subject", "stop dropping the last row"]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["fix: stop dropping the last row"]);
  });

  it("passes --scope, --body and --trailer through", async () => {
    const result = await capture([
      "commit",
      "format",
      "--type",
      "feat",
      "--scope",
      "cli",
      "--subject",
      "add a verb",
      "--body",
      "why",
      "--trailer",
      "Closes=#4",
    ]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toBe("feat(cli): add a verb\n\nwhy\n\nCloses: #4");
  });

  it("exits 2 on a shape violation, printing every refusal", async () => {
    const result = await capture(["commit", "format", "--type", "bogus", "--subject", ""]);
    expect(result.code).toBe(2);
    expect(result.err.length).toBeGreaterThan(0);
  });

  it("requires --type and --subject", async () => {
    expect((await capture(["commit", "format", "--type", "feat"])).code).toBe(2);
    expect((await capture(["commit", "format", "--subject", "x"])).code).toBe(2);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["commit", "bogus"])).code).toBe(2);
  });
});
