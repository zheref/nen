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
    // `=== undefined`, not `??`: `repoFlag: null` is a REAL case (the
    // invocation that never typed --repo, zheref/nen#28) and must not be
    // coalesced back into the fixture default.
    options.repoFlag === undefined ? BANKAI_REPO : options.repoFlag,
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

  // zheref/nen#30: a single-slot template's `[ ... ]` clause used to collapse
  // into the first slot and exit 0 -- 'BC@G9' came back as repo='BC@G9', ok:true.
  it("splits a bracketed clause after the template's only leading slot (zheref/nen#30)", async () => {
    const result = await capture(
      ["parse", "backlog-state", "--grammar", "<repo>[@<gate:G1|G2|all>]", "--line", "BC@G2"],
      [],
      { json: true },
    );
    expect(result.code).toBe(0);
    // The asserted type carries `suffix` because the --json contract does: every
    // slot reports whether its `[+]` suffix was present, even when false.
    const parsed = JSON.parse(result.out.join("\n")) as {
      slots: { name: string; value: string; suffix: boolean }[];
    };
    expect(parsed.slots).toEqual([
      { name: "repo", value: "BC", suffix: false },
      { name: "gate", value: "G2", suffix: false },
    ]);
  });

  it("exits 2 on an out-of-set bracketed enum instead of swallowing it (zheref/nen#30)", async () => {
    const result = await capture([
      "parse",
      "backlog-state",
      "--grammar",
      "<repo>[@<gate:G1|G2|all>]",
      "--line",
      "BC@G9",
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/G1 \| G2 \| all/);
    expect(result.err.join("\n")).toMatch(/BC@<gate:/);
  });

  it("exits 2 on an unsupported template shape instead of mis-parsing the line (zheref/nen#30)", async () => {
    const result = await capture(["parse", "my-skill", "--grammar", "[<repo>]", "--line", "BC"]);
    expect(result.code).toBe(2);
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

  // zheref/nen#28: the futon usage line lists --repo unbracketed, so omitting
  // it is refused by name -- never silently resolved against the cwd's registry.
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["parse", "futon", "KP@high"], [], { repoFlag: null });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
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

  // zheref/nen#31's exact transcripts: a plain file read and a read-only nen
  // verb came back [unknown] and refused the whole run; both must accept now,
  // and a genuinely mutating nen verb must STILL refuse whole.
  it("izanami accepts a plain file read (#31)", async () => {
    const result = await capture(["parse", "izanami", "until it says ok\ncat somefile.txt"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/\[read-only\] cat somefile\.txt/);
  });

  it("izanami accepts a read-only nen verb invocation (#31)", async () => {
    const result = await capture(["parse", "izanami", "until it says ready\nnen pr ready 925 --gh-repo owner/repo"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/\[read-only\] nen pr ready 925/);
  });

  it("izanami still refuses a mutating nen verb, whole (#31)", async () => {
    const result = await capture([
      "parse",
      "izanami",
      "until applied\nnen label apply XX-PR-#1 --label wake --repo-slug o/r --run",
    ]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/\[mutating\] nen label apply/);
    expect(result.err.join("\n")).toMatch(/WHOLE run is refused/);
  });
});

describe("nen parse -- refuses an invocation with no skill named", () => {
  it("exits 2", async () => {
    expect((await capture(["parse"])).code).toBe(2);
  });
});
