import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Io } from "./index.js";
import { ALT_REPO, BANKAI_REPO } from "./schema/fixtures/paths.js";
import { VERSION } from "./version.js";

// `capture` is ASYNC because ./index.ts's `run()` is (../verbs/pr_ready.ts
// reads GitHub over the network). Every call site below awaits it.
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
  return { code: await run(argv, io), out, err };
}

describe("nen --version", () => {
  it("prints the semver ALONE on stdout", async () => {
    // zheref/hatsu#1's D10 gate parses this line. A banner, a leading `v`, or a
    // trailing note would each break a fail-closed contract in the direction
    // where it stops failing closed.
    const result = await capture(["--version"]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([VERSION]);
    expect(result.err).toEqual([]);
  });

  it("accepts -v and the bare `version` verb, identically", async () => {
    expect((await capture(["-v"])).out).toEqual([VERSION]);
    expect((await capture(["version"])).out).toEqual([VERSION]);
  });

  it("wins over a command, so a broken repository cannot break the version gate", async () => {
    const result = await capture(["--version", "schema", "check", "--repo", "/definitely/not/a/repo"]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([VERSION]);
  });
});

describe("nen --help", () => {
  it("prints usage and exits 0", async () => {
    const result = await capture(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/usage: nen/);
  });

  it("prints usage and exits 2 when given nothing", async () => {
    // A bare invocation is a usage error, not a success: a caller that ran nen
    // with no arguments by accident must not read 0.
    const result = await capture([]);
    expect(result.code).toBe(2);
  });

  it("documents --repo as a PATH", async () => {
    expect((await capture(["--help"])).out.join("\n")).toMatch(/A PATH,\s*\n?\s*never an owner\/name slug/);
  });
});

describe("usage errors are exit 2, distinct from failures", () => {
  it("refuses an unknown command", async () => {
    const result = await capture(["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/unknown command 'frobnicate'/);
  });

  it("refuses an unknown flag rather than ignoring it", async () => {
    const result = await capture(["--reop", "../x", "schema", "check"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/unknown option '--reop'/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["schema", "list"])).code).toBe(2);
    expect((await capture(["dev", "lint"])).code).toBe(2);
    expect((await capture(["schema"])).code).toBe(2);
  });
});

describe("nen schema check", () => {
  it("reads the repository --repo names, not the process's own", async () => {
    const bankai = await capture(["schema", "check", "--repo", BANKAI_REPO]);
    expect(bankai.code).toBe(0);
    expect(bankai.out.join("\n")).toContain(BANKAI_REPO);
    expect(bankai.out.join("\n")).toMatch(/ok {2}\s+schemas\/labels\.json\s+13 labels/);

    // The SAME command against a repository with an entirely different
    // vocabulary. The verb reports what the file says; it knows none of it.
    const alt = await capture(["schema", "check", "--repo", ALT_REPO]);
    expect(alt.code).toBe(0);
    expect(alt.out.join("\n")).toMatch(/schemas\/labels\.json\s+8 labels/);
    expect(alt.out.join("\n")).toMatch(/schemas\/repos\.json\s+2 consumers/);
  });

  it("fails, loudly, when the taxonomy is unreadable -- and offers no fallback", async () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-cli-"));
    const result = await capture(["schema", "check", "--repo", empty]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/FAIL\s+schemas\/labels\.json/);
    expect(result.err.join("\n")).toMatch(/no built-in copy to fall back on/);
  });

  it("emits a stable --json contract", async () => {
    const result = await capture(["schema", "check", "--repo", BANKAI_REPO, "--json"]);
    expect(result.code).toBe(0);
    const parsed: unknown = JSON.parse(result.out.join("\n"));
    expect(parsed).toMatchObject({ root: BANKAI_REPO, ok: true });
    const checks = (parsed as { checks: { file: string; ok: boolean; required: boolean }[] }).checks;
    expect(checks.map((c): string => c.file)).toEqual([
      "schemas/labels.json",
      "schemas/repos.json",
      "schemas/colors.yml",
      "schemas/gates.json",
    ]);
    expect(checks.every((c): boolean => c.ok)).toBe(true);
  });

  // The owner/name-slug refusal is asserted in the exit-code block at the end of
  // this file, where its CODE (2, a usage error, corrected in review) is the
  // point rather than an aside.
});

describe("nen bootstrap", () => {
  it("requires --ref, with no default and no 'latest'", async () => {
    const result = await capture(["bootstrap"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/no default and no 'latest'/);
  });

  it("reports an unresolvable script without pretending it ran", async () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-cli-"));
    const result = await capture(["bootstrap", "--ref", "v0.1.0", "--repo", empty]);
    expect(result.code).toBe(7);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/bootstrap\/nen\.sh/);
  });
});

describe("exit codes distinguish a typo from a failure (review finding)", () => {
  it("reports a malformed --repo as a USAGE error (2), not a failure (1)", async () => {
    // `--repo zheref/nen` is a malformed invocation -- the flag takes a path and
    // was handed an owner/name slug. Reporting it as 1 tells a caller "the thing
    // you asked for did not work" when the truth is "you typed it wrong", and a
    // retry wrapper obeying that distinction would retry a typo forever.
    const result = await capture(["schema", "check", "--repo", "zheref/bankai-core"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--source/);
  });

  it("keeps a genuine verb failure at 1", async () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-cli-"));
    // The repository exists and is readable; its taxonomy is simply not there.
    // That is a failure, not a usage error.
    expect((await capture(["schema", "check", "--repo", empty])).code).toBe(1);
  });

  it("reports an empty --repo as a usage error too", async () => {
    expect((await capture(["schema", "check", "--repo="])).code).toBe(2);
  });
});

describe("usage goes to the right stream (review finding)", () => {
  it("prints ASKED-FOR help on stdout", async () => {
    const result = await capture(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/usage: nen/);
    expect(result.err).toEqual([]);
  });

  it("prints usage on STDERR when it is a complaint about the invocation", async () => {
    // `nen > out.txt` with no command must not leave a usage message in a file
    // the caller will read as this command's output.
    const result = await capture([]);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/usage: nen/);
  });
});
