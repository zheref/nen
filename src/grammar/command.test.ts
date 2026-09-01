import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { parseCommand } from "./command.js";

async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  options: { repoFlag?: string | null; json?: boolean } = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const seams: Seams = new ScriptedSeams(script);
  const code = await runFamily(
    parseCommand,
    argv,
    options.repoFlag ?? BANKAI_REPO,
    options.json ?? false,
    io,
    seams,
  );
  return { code, out, err };
}

describe("nen parse <skill> -- the generic --grammar/--line engine (main's own family)", () => {
  it("parses and echoes a matching line", async () => {
    const result = await capture([
      "parse",
      "my-skill",
      "--grammar",
      "do <thing>",
      "--line",
      "do the dishes",
    ]);
    expect(result.code).toBe(0);
  });

  it("requires --grammar and --line for a skill that is not futon/izanagi/izanami", async () => {
    expect((await capture(["parse", "my-skill"])).code).toBe(2);
  });
});

describe("nen parse futon -- CLI wiring (verbs/4-remainders, merged into this family)", () => {
  it("resolves a known consumer code, build-only", async () => {
    const result = await capture(["parse", "futon", "KP@high", "--self", "zheref/bankai-core"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/repo: zheref\/KroApple \(KP\)/);
    expect(result.out.join("\n")).toMatch(/terminal: \(none -- build-only\)/);
  });

  it("emits the stable --json contract", async () => {
    const result = await capture(
      ["parse", "futon", "KP@high+", "--self", "zheref/bankai-core"],
      [],
      { json: true },
    );
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as { band: { severities: string[] } };
    expect(parsed.band.severities).toEqual(["critical", "high"]);
  });

  it("refuses a 'then tag' clause against a non-self consumer, with a corrected line", async () => {
    const result = await capture(["parse", "futon", "KP@high then tag", "--self", "zheref/bankai-core"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/is refused against 'zheref\/KroApple'/);
    expect(result.err.join("\n")).toMatch(/try: KP@high/);
  });

  it("refuses an unparseable invocation before ever touching the registry", async () => {
    const result = await capture(["parse", "futon", "not an invocation"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/no '@<severity>'/);
  });

  it("requires an invocation string", async () => {
    expect((await capture(["parse", "futon"])).code).toBe(2);
  });

  it("resolves 'the repo you are standing in' from origin when the token is omitted", async () => {
    const result = await capture(["parse", "futon", "@critical"], [
      { match: "git remote get-url origin", result: { stdout: "git@github.com:zheref/bankai-core.git\n" } },
    ]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/repo: zheref\/bankai-core/);
  });
});

describe("nen parse izanagi/izanami -- dispatch through the merged family", () => {
  it("izanagi parses a valid invocation", async () => {
    const result = await capture(["parse", "izanagi", "retry the build until it is green up to 3"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/cap: 3/);
  });

  it("izanami classifies a read-only command", async () => {
    const result = await capture(["parse", "izanami", "gh pr checks 42 until it is green"]);
    expect(result.code).toBe(0);
  });
});

describe("nen parse -- refuses an invocation with no skill named", () => {
  it("exits 2", async () => {
    expect((await capture(["parse"])).code).toBe(2);
  });
});
