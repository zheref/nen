import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitCodeFor, reportUnhandled, run, runFamily, type Io } from "./index.js";
import { VerbUsageError, type Command } from "./cli/command.js";
import { RepoRootError } from "./repo/root.js";
import { ALT_REPO, BANKAI_REPO, LEGACY_REPO } from "./schema/fixtures/paths.js";
import { defaultSeams, type CommandResult, type Seams } from "./seam/exec.js";
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

// ASYNC for the same reason `capture` is: ./index.ts's `run()` is.
async function captureWithSeams(
  argv: readonly string[],
  runFn: Seams["run"],
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
  const seams: Seams = { run: runFn, now: (): Date => new Date("2026-01-01T00:00:00Z"), env: {} };
  return { code: await run(argv, io, seams), out, err };
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
    // NOT 'dev lint' here (main's own version of this test, before this
    // merge): verbs/4-remainders' ../dev/command.ts registers 'lint' as a
    // REAL, working subcommand (see ../cli/registry.ts's header), so it is no
    // longer an example of an unknown one. 'dev bogus' is genuinely unknown
    // under the union and exercises the same 'unknown subcommand' path.
    expect((await capture(["dev", "bogus"])).code).toBe(2);
    expect((await capture(["schema"])).code).toBe(2);
  });
});

describe("nen schema check", () => {
  it("reads the repository --repo names, not the process's own", async () => {
    const bankai = await capture(["schema", "check", "--repo", BANKAI_REPO]);
    expect(bankai.code).toBe(0);
    expect(bankai.out.join("\n")).toContain(BANKAI_REPO);
    expect(bankai.out.join("\n")).toMatch(/ok {2}\s+nen\/labels\.json\s+13 labels/);

    // The SAME command against a repository with an entirely different
    // vocabulary. The verb reports what the file says; it knows none of it.
    const alt = await capture(["schema", "check", "--repo", ALT_REPO]);
    expect(alt.code).toBe(0);
    expect(alt.out.join("\n")).toMatch(/nen\/labels\.json\s+8 labels/);
    expect(alt.out.join("\n")).toMatch(/nen\/repos\.json\s+2 consumers/);
  });

  // zheref/nen#17: the bankai fixture's product_codes nests a `$comment` the
  // same way the live bankai-core file does. This verb's row count is
  // `Object.keys(repos.productCodes).length` (../schema/taxonomy.ts) -- if the
  // loader ever counted the nested comment as a code, this line would read "7
  // product codes" for a registry that names exactly six.
  it("counts only real product codes, never a nested $comment (zheref/nen#17)", async () => {
    const result = await capture(["schema", "check", "--repo", BANKAI_REPO]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/nen\/repos\.json\s+3 consumers, 6 product codes/);
    expect(result.out.join("\n")).not.toContain("$comment");
  });

  it("fails, loudly, when the taxonomy is unreadable -- and offers no fallback", async () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-cli-"));
    const result = await capture(["schema", "check", "--repo", empty]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/FAIL\s+nen\/labels\.json/);
    expect(result.err.join("\n")).toMatch(/no built-in copy to fall back on/);
  });

  it("emits a stable --json contract", async () => {
    const result = await capture(["schema", "check", "--repo", BANKAI_REPO, "--json"]);
    expect(result.code).toBe(0);
    const parsed: unknown = JSON.parse(result.out.join("\n"));
    expect(parsed).toMatchObject({ root: BANKAI_REPO, ok: true, deprecations: [] });
    const checks = (
      parsed as {
        checks: { file: string; ok: boolean; required: boolean; location: string; note: string | null; shadowed: boolean }[];
      }
    ).checks;
    expect(checks.map((c): string => c.file)).toEqual([
      "nen/labels.json",
      "nen/repos.json",
      "nen/colors.yml",
      "nen/gates.json",
      "nen/contract.json",
    ]);
    expect(checks.every((c): boolean => c.ok)).toBe(true);
    // A fully migrated repository says so in the machine-readable output as
    // well as on screen: every row answered from `nen/`, nothing deprecated,
    // nothing shadowed. That is the shape a consumer's CI asserts on to know
    // the v0.4.0 removal will not break it.
    expect(checks.every((c): boolean => c.location === "nen")).toBe(true);
    expect(checks.every((c): boolean => c.note === null && !c.shadowed)).toBe(true);
  });

  it("prints the LEGACY location a file was actually read from, plus the migration line", async () => {
    const result = await capture(["schema", "check", "--repo", LEGACY_REPO]);
    // The un-migrated repository still PASSES for the whole v0.3 line.
    expect(result.code).toBe(0);
    const text = result.out.join("\n");
    expect(text).toMatch(/warn\s+schemas\/labels\.json\s+13 labels/);
    expect(text).toContain("^ legacy location. Move it to 'nen/labels.json'");
    expect(text).toContain("removed in v0.4.0");
    expect(text).not.toContain("nen/labels.json  13 labels");
  });

  it("FAILS on a shadowed leftover, and says which file it read", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-cli-shadow-"));
    mkdirSync(join(root, "nen"), { recursive: true });
    mkdirSync(join(root, "schemas"), { recursive: true });
    for (const file of ["labels.json", "repos.json", "colors.yml"]) {
      copyFileSync(join(BANKAI_REPO, "nen", file), join(root, "nen", file));
    }
    writeFileSync(join(root, "schemas", "labels.json"), '{"labels":[]}');

    const result = await capture(["schema", "check", "--repo", root]);
    expect(result.code).toBe(1);
    const text = result.out.join("\n");
    expect(text).toMatch(/FAIL\s+nen\/labels\.json\s+13 labels/);
    expect(text).toContain("^ SHADOWED LEFTOVER: 'schemas/labels.json'");
    // The stderr refusal describes the RIGHT failure -- not "could not be
    // read", which is false about a repository whose files all loaded.
    expect(result.err.join("\n")).toContain("with DIFFERENT contents");
    expect(result.err.join("\n")).not.toContain("no built-in copy");

    // Make the two copies identical and the same repository passes, with the
    // deletion offered as a note rather than demanded as a failure.
    writeFileSync(
      join(root, "schemas", "labels.json"),
      readFileSync(join(BANKAI_REPO, "nen", "labels.json"), "utf8"),
    );
    const clean = await capture(["schema", "check", "--repo", root]);
    expect(clean.code).toBe(0);
    expect(clean.out.join("\n")).toMatch(/ok {2}\s+nen\/labels\.json/);
    expect(clean.out.join("\n")).toContain("^ an identical copy is still at 'schemas/labels.json'");
  });

  it("carries a contract row: absent when there is none, validated when there is", async () => {
    const migrated = await capture(["schema", "check", "--repo", BANKAI_REPO]);
    expect(migrated.out.join("\n")).toMatch(
      /ok {2}\s+nen\/contract\.json\s+dependency \(nen >= 0\.3, pinned v0\.3\.0\), project \(2 lanes/,
    );

    const none = await capture(["schema", "check", "--repo", LEGACY_REPO]);
    expect(none.out.join("\n")).toMatch(/ok {2}\s+nen\/contract\.json\s+absent \(optional\)/);
  });

  // The owner/name-slug refusal is asserted in the exit-code block at the end of
  // this file, where its CODE (2, a usage error, corrected in review) is the
  // point rather than an aside.

  it("'nen schema --help' answers its OWN usage, not the global one (zheref/nen#14's fact-check)", async () => {
    // Pre-registry, so this never reaches ../cli/command.ts's mergeFlags ->
    // family.usage path a registered family gets for free -- it used to fall
    // straight through to the GLOBAL usage instead, the same as any other
    // command name would, README's own "each family's --help documents its
    // verbs and flags in full" claim notwithstanding.
    const result = await capture(["schema", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/^nen schema check --repo <path>/);
    expect(result.out.join("\n")).not.toMatch(/usage: nen \[--version\]/);
  });
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

  it("'nen bootstrap --help' answers its OWN usage, not the global one (zheref/nen#14's fact-check)", async () => {
    const result = await capture(["bootstrap", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/^nen bootstrap --ref <tag>/);
    expect(result.out.join("\n")).not.toMatch(/usage: nen \[--version\]/);
  });
});

describe("an unknown command with --help still gets the global usage (zheref/nen#14's fact-check, regression)", () => {
  it("'nen frobnicate --help' is not mistaken for a family with its own usage", async () => {
    const result = await capture(["frobnicate", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/usage: nen \[--version\]/);
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

// THE REGISTRY DISPATCH LAYER, DRIVEN END TO END (review finding, BLOCKER):
// the commit that wired all fifteen verb families into the registry and
// two-stage dispatch shipped with zero tests covering that wiring -- every
// family test file called `family.run(...)` directly and hand-copied
// `runFamily`'s error-to-exit-code mapping into its own local `capture()`
// helper. These tests drive the REAL top-level `run()` -- findCommand, the
// stage-one/stage-two re-parse (`mergeFlags`), a family's own `--help`, the
// `--repo`/`--json` merge across both stages, and the
// UsageError/VerbUsageError/RepoRootError/ToolError exit-code mapping -- for
// one error class each, using the `label` family (it exercises a taxonomy
// lookup, a `gh` mutation, and a ref parse in one small surface).
describe("registry family dispatch, through the real run() (review finding)", () => {
  const VALID_LABEL = "bankai:stage/idea"; // declared in the bankai-repo fixture's nen/labels.json

  function neverCalled(): CommandResult {
    throw new Error("must not be called");
  }

  it("a successful verb: exit 0, with output, via findCommand -> mergeFlags re-parse -> family.run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-dispatch-"));
    const ledger = join(dir, "l.jsonl");
    const result = await captureWithSeams(
      ["label", "apply", "XX-PR-#12", "--label", VALID_LABEL, "--repo-slug", "o/r", "--repo", BANKAI_REPO, "--ledger", ledger],
      neverCalled, // dry run (no --run): the gh seam must never be reached
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/dry run/);
    expect(result.out.join("\n")).toMatch(/would apply/);
  });

  it("an unknown subcommand is a VerbUsageError -> exit 2, with 'Run --help' guidance", async () => {
    const result = await captureWithSeams(["label", "frobnicate", "--repo", BANKAI_REPO], neverCalled);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/unknown 'label' subcommand 'frobnicate'/);
    expect(result.err.join("\n")).toMatch(/Run 'nen label --help'/);
  });

  it("a ToolError from a failed gh call -> exit 1, not 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-dispatch-"));
    const ledger = join(dir, "l.jsonl");
    const result = await captureWithSeams(
      ["label", "apply", "XX-PR-#12", "--label", VALID_LABEL, "--repo-slug", "o/r", "--repo", BANKAI_REPO, "--ledger", ledger, "--run"],
      (): CommandResult => ({ code: 1, stdout: "", stderr: "HTTP 404: not found", spawnFailed: false }),
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/HTTP 404/);
  });

  it("a malformed --repo (an owner/name slug, not a path) is a RepoRootError -> exit 2", async () => {
    const result = await captureWithSeams(
      ["label", "apply", "XX-PR-#12", "--label", VALID_LABEL, "--repo-slug", "o/r", "--repo", "zheref/bankai-core"],
      neverCalled,
    );
    expect(result.code).toBe(2);
  });

  it("'nen <family> --help' answers from the family's own usage, on stdout, exit 0", async () => {
    const result = await captureWithSeams(["label", "--help"], neverCalled);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/nen label apply/);
    expect(result.err).toEqual([]);
  });

  it("--repo and --json are the SAME invocation whether given before or after the family name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-dispatch-"));
    const ledgerBefore = join(dir, "before.jsonl");
    const ledgerAfter = join(dir, "after.jsonl");

    const before = await captureWithSeams(
      ["--repo", BANKAI_REPO, "--json", "label", "apply", "XX-PR-#12", "--label", VALID_LABEL, "--repo-slug", "o/r", "--ledger", ledgerBefore],
      neverCalled,
    );
    const after = await captureWithSeams(
      ["label", "apply", "XX-PR-#12", "--label", VALID_LABEL, "--repo-slug", "o/r", "--ledger", ledgerAfter, "--repo", BANKAI_REPO, "--json"],
      neverCalled,
    );

    expect(before.code).toBe(0);
    expect(after.code).toBe(0);
    const beforeParsed: unknown = JSON.parse(before.out.join("\n"));
    const afterParsed: unknown = JSON.parse(after.out.join("\n"));
    // Same shape from both orderings; the ledger PATH differs only because
    // this test pointed each at a different temp file.
    expect(beforeParsed).toMatchObject({ entry: { object: "XX-PR-#12", label: VALID_LABEL, outcome: "dry-run" } });
    expect(afterParsed).toMatchObject({ entry: { object: "XX-PR-#12", label: VALID_LABEL, outcome: "dry-run" } });
    expect(readFileSync(ledgerBefore, "utf8")).not.toEqual("");
    expect(readFileSync(ledgerAfter, "utf8")).not.toEqual("");
  });
});

// ── zheref/nen#10's comment, closed here: runFamily's `await` is the line ────
//
// `return await family.run({...})` -- the single line the async conversion of
// this dispatcher exists for -- had no coverage. Removing the `await` left the
// whole suite green, because the ONE async family that exists today
// (`pr ready`) catches everything internally and so never returns a rejected
// promise. Without the `await`, a rejection is returned rather than thrown, the
// try/catch around it never sees it, and the family bypasses the exit-code
// contract this file's header says is written ONCE here rather than thirty-two
// times.
//
// MUTATION-CHECKED: deleting the `await` in ../index.ts's
// `return await family.run(...)` turns all three cases below red (the promise
// escapes runFamily and the awaiting test rejects), and restores them green.
// That is the whole point of the block -- it is a test OF the keyword.
describe("runFamily maps a family whose run() REJECTS through the same exit-code contract", () => {
  function rejectingFamily(error: Error): Command {
    return {
      name: "explode",
      summary: "test double: a family whose run() returns a rejected promise",
      usage: "nen explode",
      flags: { values: [], booleans: [] },
      // An ASYNC family that fails after its first await -- the shape a future
      // network-reading family has and today's `pr ready` does not, because it
      // catches its own transport failures and returns a verdict instead.
      run: async (): Promise<number> => {
        await Promise.resolve();
        throw error;
      },
    };
  }

  async function drive(error: Error): Promise<{ code: number; err: string[] }> {
    const err: string[] = [];
    const io: Io = {
      out: (): void => {},
      err: (line): void => {
        err.push(line);
      },
    };
    const code = await runFamily(
      rejectingFamily(error),
      ["explode", "go"],
      null,
      false,
      io,
      defaultSeams(),
    );
    return { code, err };
  }

  it("a rejected VerbUsageError is exit 2, with the message and the --help pointer", async () => {
    const result = await drive(new VerbUsageError("you typed it wrong"));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("nen explode: you typed it wrong");
    expect(result.err.join("\n")).toContain("Run 'nen explode --help'");
  });

  it("a rejected RepoRootError is exit 2 -- a malformed --repo stays a typo, not a failure", async () => {
    const result = await drive(new RepoRootError("--repo takes a path"));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("--repo takes a path");
  });

  it("anything else is exit 1, and the message is printed WHOLE", async () => {
    const result = await drive(new Error("the thing you asked for did not work"));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toBe("nen explode: the thing you asked for did not work");
  });

  it("a family that RESOLVES is still just its own number", async () => {
    // The control: the await must not change the successful path.
    const err: string[] = [];
    const io: Io = { out: (): void => {}, err: (line): void => void err.push(line) };
    const code = await runFamily(
      {
        name: "quiet",
        summary: "test double",
        usage: "nen quiet",
        flags: { values: [], booleans: [] },
        run: async (): Promise<number> => Promise.resolve(3),
      },
      ["quiet"],
      null,
      false,
      io,
      defaultSeams(),
    );
    expect(code).toBe(3);
    expect(err).toEqual([]);
  });
});

// ── zheref/nen#8 item 2: the entry point's last resort ──────────────────────
//
// `run(...).then(code => ...)` had no `.catch`, so anything that escaped all
// three of run()'s own try/catches became an unhandled rejection: exitCode never
// assigned, and the status a property of the hosting runtime rather than of this
// program, whose exit codes are a published contract. The handler is a named
// export precisely so it has a test rather than being a closure inside an
// `import.meta.main` block no harness can reach.
describe("reportUnhandled -- the exit code on that path is this file's, not the runtime's", () => {
  it("prints the message with the program prefix and returns 1", () => {
    const lines: string[] = [];
    const code = reportUnhandled(new Error("escaped"), (line): void => void lines.push(line));
    // 1, not 2: an error nobody classified is a failure. Calling it a usage
    // error would tell a caller "you typed it wrong" about something no one
    // established was theirs.
    expect(code).toBe(1);
    expect(lines).toEqual(["nen: escaped"]);
  });

  it("survives a thrown non-Error without printing '[object Object]'", () => {
    const lines: string[] = [];
    expect(reportUnhandled("a bare string", (line): void => void lines.push(line))).toBe(1);
    expect(lines).toEqual(["nen: a bare string"]);
  });
});

// THE WIRING, not just the handler (zheref/nen#8 item 2, review MAJOR 2).
//
// `reportUnhandled` above was tested from the day it landed -- but the thing
// that decides whether anything ever CALLS it was a `.catch` chained onto
// `run()`'s promise inside `import.meta.main`, which no harness can reach.
// Deleting that whole `.catch` left the suite green and the typecheck clean:
// the guard against an unhandled rejection was itself unguarded. `exitCodeFor`
// is that composition as a function, so it has a test.
describe("exitCodeFor -- the composition that decides whether the handler is reached", () => {
  it("turns a REJECTION into 1 and one prefixed line", async () => {
    const lines: string[] = [];
    const code = await exitCodeFor(
      Promise.reject(new Error("escaped")),
      (line): void => void lines.push(line),
    );
    expect(code).toBe(1);
    // ONE line, and the sink is the one that appends the newline -- so this is
    // also the assertion that nothing here writes a second trailing newline of
    // its own on the way out.
    expect(lines).toEqual(["nen: escaped"]);
  });

  it("passes a RESOLVED code straight through and prints nothing", async () => {
    const lines: string[] = [];
    // 0 specifically: the success path is the one a mutation that swallowed
    // every code and returned 1 would still have to get right.
    expect(await exitCodeFor(Promise.resolve(0), (line): void => void lines.push(line))).toBe(0);
    expect(lines).toEqual([]);
    expect(await exitCodeFor(Promise.resolve(2), (line): void => void lines.push(line))).toBe(2);
    expect(lines).toEqual([]);
  });

  it("handles a rejection with a non-Error the same way the handler does", async () => {
    const lines: string[] = [];
    // A reject() with something that is NOT an Error, which is exactly what an
    // escaped throw from third-party code can be.
    expect(await exitCodeFor(Promise.reject("a bare string"), (line): void => void lines.push(line))).toBe(1);
    expect(lines).toEqual(["nen: a bare string"]);
  });
});
