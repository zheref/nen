import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Io } from "./index.js";
import { ALT_REPO, BANKAI_REPO } from "./schema/fixtures/paths.js";
import type { CommandResult, Seams } from "./seam/exec.js";
import { VERSION } from "./version.js";

function capture(argv: readonly string[]): { code: number; out: string[]; err: string[] } {
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
  return { code: run(argv, io), out, err };
}

function captureWithSeams(
  argv: readonly string[],
  runFn: Seams["run"],
): { code: number; out: string[]; err: string[] } {
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
  return { code: run(argv, io, seams), out, err };
}

describe("nen --version", () => {
  it("prints the semver ALONE on stdout", () => {
    // zheref/hatsu#1's D10 gate parses this line. A banner, a leading `v`, or a
    // trailing note would each break a fail-closed contract in the direction
    // where it stops failing closed.
    const result = capture(["--version"]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([VERSION]);
    expect(result.err).toEqual([]);
  });

  it("accepts -v and the bare `version` verb, identically", () => {
    expect(capture(["-v"]).out).toEqual([VERSION]);
    expect(capture(["version"]).out).toEqual([VERSION]);
  });

  it("wins over a command, so a broken repository cannot break the version gate", () => {
    const result = capture(["--version", "schema", "check", "--repo", "/definitely/not/a/repo"]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([VERSION]);
  });
});

describe("nen --help", () => {
  it("prints usage and exits 0", () => {
    const result = capture(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/usage: nen/);
  });

  it("prints usage and exits 2 when given nothing", () => {
    // A bare invocation is a usage error, not a success: a caller that ran nen
    // with no arguments by accident must not read 0.
    const result = capture([]);
    expect(result.code).toBe(2);
  });

  it("documents --repo as a PATH", () => {
    expect(capture(["--help"]).out.join("\n")).toMatch(/A PATH,\s*\n?\s*never an owner\/name slug/);
  });
});

describe("usage errors are exit 2, distinct from failures", () => {
  it("refuses an unknown command", () => {
    const result = capture(["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/unknown command 'frobnicate'/);
  });

  it("refuses an unknown flag rather than ignoring it", () => {
    const result = capture(["--reop", "../x", "schema", "check"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/unknown option '--reop'/);
  });

  it("refuses an unknown subcommand", () => {
    expect(capture(["schema", "list"]).code).toBe(2);
    expect(capture(["dev", "lint"]).code).toBe(2);
    expect(capture(["schema"]).code).toBe(2);
  });
});

describe("nen schema check", () => {
  it("reads the repository --repo names, not the process's own", () => {
    const bankai = capture(["schema", "check", "--repo", BANKAI_REPO]);
    expect(bankai.code).toBe(0);
    expect(bankai.out.join("\n")).toContain(BANKAI_REPO);
    expect(bankai.out.join("\n")).toMatch(/ok {2}\s+schemas\/labels\.json\s+13 labels/);

    // The SAME command against a repository with an entirely different
    // vocabulary. The verb reports what the file says; it knows none of it.
    const alt = capture(["schema", "check", "--repo", ALT_REPO]);
    expect(alt.code).toBe(0);
    expect(alt.out.join("\n")).toMatch(/schemas\/labels\.json\s+8 labels/);
    expect(alt.out.join("\n")).toMatch(/schemas\/repos\.json\s+2 consumers/);
  });

  it("fails, loudly, when the taxonomy is unreadable -- and offers no fallback", () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-cli-"));
    const result = capture(["schema", "check", "--repo", empty]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/FAIL\s+schemas\/labels\.json/);
    expect(result.err.join("\n")).toMatch(/no built-in copy to fall back on/);
  });

  it("emits a stable --json contract", () => {
    const result = capture(["schema", "check", "--repo", BANKAI_REPO, "--json"]);
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
  it("requires --ref, with no default and no 'latest'", () => {
    const result = capture(["bootstrap"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/no default and no 'latest'/);
  });

  it("reports an unresolvable script without pretending it ran", () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-cli-"));
    const result = capture(["bootstrap", "--ref", "v0.1.0", "--repo", empty]);
    expect(result.code).toBe(7);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/bootstrap\/nen\.sh/);
  });
});

describe("exit codes distinguish a typo from a failure (review finding)", () => {
  it("reports a malformed --repo as a USAGE error (2), not a failure (1)", () => {
    // `--repo zheref/nen` is a malformed invocation -- the flag takes a path and
    // was handed an owner/name slug. Reporting it as 1 tells a caller "the thing
    // you asked for did not work" when the truth is "you typed it wrong", and a
    // retry wrapper obeying that distinction would retry a typo forever.
    const result = capture(["schema", "check", "--repo", "zheref/bankai-core"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--source/);
  });

  it("keeps a genuine verb failure at 1", () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-cli-"));
    // The repository exists and is readable; its taxonomy is simply not there.
    // That is a failure, not a usage error.
    expect(capture(["schema", "check", "--repo", empty]).code).toBe(1);
  });

  it("reports an empty --repo as a usage error too", () => {
    expect(capture(["schema", "check", "--repo="]).code).toBe(2);
  });
});

describe("usage goes to the right stream (review finding)", () => {
  it("prints ASKED-FOR help on stdout", () => {
    const result = capture(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/usage: nen/);
    expect(result.err).toEqual([]);
  });

  it("prints usage on STDERR when it is a complaint about the invocation", () => {
    // `nen > out.txt` with no command must not leave a usage message in a file
    // the caller will read as this command's output.
    const result = capture([]);
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
  const VALID_LABEL = "bankai:stage/idea"; // declared in the bankai-repo fixture's schemas/labels.json

  function neverCalled(): CommandResult {
    throw new Error("must not be called");
  }

  it("a successful verb: exit 0, with output, via findCommand -> mergeFlags re-parse -> family.run", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-dispatch-"));
    const ledger = join(dir, "l.jsonl");
    const result = captureWithSeams(
      ["label", "apply", "XX-PR-#12", "--label", VALID_LABEL, "--repo-slug", "o/r", "--repo", BANKAI_REPO, "--ledger", ledger],
      neverCalled, // dry run (no --run): the gh seam must never be reached
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/dry run/);
    expect(result.out.join("\n")).toMatch(/would apply/);
  });

  it("an unknown subcommand is a VerbUsageError -> exit 2, with 'Run --help' guidance", () => {
    const result = captureWithSeams(["label", "frobnicate", "--repo", BANKAI_REPO], neverCalled);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/unknown 'label' subcommand 'frobnicate'/);
    expect(result.err.join("\n")).toMatch(/Run 'nen label --help'/);
  });

  it("a ToolError from a failed gh call -> exit 1, not 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-dispatch-"));
    const ledger = join(dir, "l.jsonl");
    const result = captureWithSeams(
      ["label", "apply", "XX-PR-#12", "--label", VALID_LABEL, "--repo-slug", "o/r", "--repo", BANKAI_REPO, "--ledger", ledger, "--run"],
      (): CommandResult => ({ code: 1, stdout: "", stderr: "HTTP 404: not found", spawnFailed: false }),
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/HTTP 404/);
  });

  it("a malformed --repo (an owner/name slug, not a path) is a RepoRootError -> exit 2", () => {
    const result = captureWithSeams(
      ["label", "apply", "XX-PR-#12", "--label", VALID_LABEL, "--repo-slug", "o/r", "--repo", "zheref/bankai-core"],
      neverCalled,
    );
    expect(result.code).toBe(2);
  });

  it("'nen <family> --help' answers from the family's own usage, on stdout, exit 0", () => {
    const result = captureWithSeams(["label", "--help"], neverCalled);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/nen label apply/);
    expect(result.err).toEqual([]);
  });

  it("--repo and --json are the SAME invocation whether given before or after the family name", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-dispatch-"));
    const ledgerBefore = join(dir, "before.jsonl");
    const ledgerAfter = join(dir, "after.jsonl");

    const before = captureWithSeams(
      ["--repo", BANKAI_REPO, "--json", "label", "apply", "XX-PR-#12", "--label", VALID_LABEL, "--repo-slug", "o/r", "--ledger", ledgerBefore],
      neverCalled,
    );
    const after = captureWithSeams(
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
