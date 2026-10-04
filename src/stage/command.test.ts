import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { stageCommand } from "./command.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  // `null` is a real case: the invocation that never typed --repo (zheref/nen#28).
  repoFlag: string | null = BANKAI_REPO,
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
  const code = await runFamily(stageCommand, argv, repoFlag, false, io, seams);
  return { code, out, err };
}

/** The same harness with `--json` on, for a case that reads the document. */
async function captureJson(
  argv: readonly string[],
  script: readonly ScriptedCall[],
  repoFlag: string,
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
  const code = await runFamily(stageCommand, argv, repoFlag, true, io, new ScriptedSeams(script));
  return { code, out, err };
}

describe("nen stage triage -- CLI wiring", () => {
  // zheref/nen#28: the usage line lists --repo unbracketed, so omitting it is
  // refused by name -- never silently pointed at the process's own cwd.
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["stage", "triage"], [], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("exits 0 when nothing is flagged", async () => {
    const result = await capture(["stage", "triage"], [
      { match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall", result: { stdout: " M src/a.ts\0" } },
    ]);
    expect(result.code).toBe(0);
  });

  it("exits 1 and lists the reason(s) when something is flagged", async () => {
    const result = await capture(["stage", "triage"], [
      { match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall", result: { stdout: "?? .env\0" } },
    ]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/\.env {2}\[secret-shape\]/);
  });

  it("passes --scope and --mentions through to the triage", async () => {
    const result = await capture(
      ["stage", "triage", "--scope", "src/", "--mentions", "renames src/old.ts"],
      [{ match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall", result: { stdout: " M src/old.ts\0" } }],
    );
    expect(result.code).toBe(0);
  });

  it("flags a real secret file even at a non-ASCII path (BLOCKER #3)", async () => {
    const result = await capture(["stage", "triage"], [
      {
        match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall",
        result: { stdout: "?? secrëts/.env\0" },
      },
    ]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/secrëts\/\.env {2}\[secret-shape\]/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["stage", "bogus"])).code).toBe(2);
  });
});

// zheref/nen#169: a git-ignored path leaves 'flagged' for its own bucket --
// a count in text (this verb has no --verbose flag, so the paths themselves
// are never listed there), a full array under --json, and it never moves the
// exit code.
describe("nen stage triage -- the ignored bucket (zheref/nen#169)", () => {
  it("on a mixed tree, counts ignored separately from clean and flagged, and never lists ignored paths in text", async () => {
    const result = await capture(["stage", "triage"], [
      {
        match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall",
        result: { stdout: " M src/a.ts\0?? .env\0!! node_modules/x\0!! node_modules/y/.env\0" },
      },
    ]);
    expect(result.code).toBe(1);
    const out = result.out.join("\n");
    expect(out).toMatch(/clean: 1 file\(s\)/);
    expect(out).toMatch(/ {2}src\/a\.ts/);
    expect(out).toMatch(/ignored: 2 file\(s\), not listed/);
    expect(out).not.toMatch(/node_modules/);
    expect(out).toMatch(/flagged: 1 file\(s\)/);
    expect(out).toMatch(/\.env {2}\[secret-shape\]/);
  });

  it("on a tree with only ignored rows, exits 0 -- the exit code follows 'flagged' only", async () => {
    const result = await capture(["stage", "triage"], [
      {
        match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall",
        result: { stdout: "!! node_modules/x\0!! node_modules/y/.env\0" },
      },
    ]);
    expect(result.code).toBe(0);
    const out = result.out.join("\n");
    expect(out).toMatch(/clean: 0 file\(s\)/);
    expect(out).toMatch(/ignored: 2 file\(s\), not listed/);
    expect(out).not.toMatch(/flagged/);
    expect(out).not.toMatch(/node_modules/);
  });

  it("--json carries the full ignored array, with a secret-shape reason preserved and never inside flagged", async () => {
    const result = await capture(
      ["stage", "triage", "--json"],
      [
        {
          match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall",
          result: { stdout: "!! node_modules/y/.env\0" },
        },
      ],
    );
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as {
      clean: string[];
      flagged: unknown[];
      ignored: { path: string; reasons: string[] }[];
    };
    expect(parsed.flagged).toEqual([]);
    expect(parsed.ignored).toEqual([{ path: "node_modules/y/.env", reasons: ["ignored", "secret-shape"] }]);
  });
});

// Copilot, PR #189: the size measurement used to stat every `git status` entry,
// ignored ones included -- thousands of synchronous stats on a repository with
// a `node_modules/` tree, buying one `--json` field nothing reads.
describe("nen stage triage -- an ignored path is never measured", () => {
  it("stats no ignored path, and still reports it in the ignored bucket", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-stage-"));
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "huge.js"), "x".repeat(2_000_000), "utf8");
    writeFileSync(join(root, "src.txt"), "ok\n", "utf8");
    const result = await captureJson(
      ["stage", "triage"],
      [
        {
          match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall",
          result: { stdout: "!! node_modules/huge.js\0?? src.txt\0" },
        },
      ],
      root,
    );
    expect(result.code).toBe(0);
    const triage = JSON.parse(result.out.join("\n")) as {
      ignored: { path: string; reasons: string[] }[];
      clean: string[];
    };
    // Present as a FACT, with the reason it always carried -- and with no
    // `large`, because its size was never asked for. A 2 MB file is well over
    // the default threshold, so this asserts the skip and not merely the size.
    expect(triage.ignored).toEqual([{ path: "node_modules/huge.js", reasons: ["ignored"] }]);
    expect(triage.clean).toEqual(["src.txt"]);
  });
});

// zheref/nen#237: `nen stage list` -- the exact add list, triage's complement.
describe("nen stage list -- CLI wiring (zheref/nen#237)", () => {
  const STATUS = "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall";
  const TOPLEVEL = "git rev-parse --show-toplevel";

  async function list(
    argv: readonly string[],
    stdout: string,
    json = false,
    withWrite = false,
    toplevel: string = BANKAI_REPO,
    stdoutBytes?: Uint8Array,
    repo: string = BANKAI_REPO,
  ): Promise<{ code: number; out: string[]; err: string[]; written: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const written: string[] = [];
    const io: Io = {
      out: (line): void => void out.push(line),
      err: (line): void => void err.push(line),
      ...(withWrite ? { write: (chunk: string): void => void written.push(chunk) } : {}),
    };
    const code = await runFamily(
      stageCommand,
      ["stage", "list", ...argv],
      repo,
      json,
      io,
      new ScriptedSeams([
        { match: TOPLEVEL, result: { stdout: `${toplevel}\n` } },
        { match: STATUS, result: { stdout, ...(stdoutBytes === undefined ? {} : { stdoutBytes }) } },
      ]),
    );
    return { code, out, err, written };
  }

  it("refuses an OMITTED --repo at exit 2", async () => {
    const result = await capture(["stage", "list"], [], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("prints only the paths on stdout, untracked ones included, at exit 0", async () => {
    const result = await list([], " M src/a.ts\0?? src/new.ts\0!! node_modules/x\0");
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["src/a.ts", "src/new.ts"]);
    expect(result.err).toEqual(["ignored: 1 file(s), not listed"]);
  });

  it("withholds the list on a flag (exit 1) and names each exclusion with its reasons on stderr", async () => {
    const result = await list([], " M src/a.ts\0?? .env\0");
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    const err = result.err.join("\n");
    expect(err).toMatch(/^excluded: \.env {2}\[secret-shape\]$/m);
    expect(err).toMatch(/1 path\(s\) need a human -- the add list \(1 path\(s\)\) is withheld/);
  });

  it("--json carries the whole classification at the flagged exit", async () => {
    const result = await list([], " M src/a.ts\0?? .env\0!! node_modules/x\0", true);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toEqual({
      verdict: "flagged",
      add: ["src/a.ts"],
      excluded: [{ path: ".env", reasons: ["secret-shape"] }],
      alreadyStaged: [],
      ignored: [{ path: "node_modules/x", reasons: ["ignored"] }],
      unmerged: [],
      embeddedRepos: [],
      undecodable: [],
    });
  });

  it("exits 3 on an empty tree, with nothing on stdout", async () => {
    const result = await list([], "");
    expect(result.code).toBe(3);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/nothing to add/);
  });

  it("exits 3 on an all-ignored tree, and --json says 'empty'", async () => {
    const result = await list([], "!! node_modules/x\0", true);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ verdict: "empty", add: [] });
  });

  it("--nul writes every path NUL-terminated through the raw sink, with no trailing newline", async () => {
    const result = await list(["--nul"], " M with space.ts\0?? new\nline.ts\0", false, true);
    expect(result.code).toBe(0);
    expect(result.written).toEqual(["with space.ts\0new\nline.ts\0"]);
    expect(result.out).toEqual([]);
  });

  it("the newline form C-quotes a path with a newline so git reads it back whole", async () => {
    const result = await list([], "?? new\nline.ts\0");
    expect(result.out).toEqual(['"new\\nline.ts"']);
  });

  it("names an already-staged deletion on stderr and keeps it off the list", async () => {
    const result = await list(["--mentions", "gone.ts"], "D  src/gone.ts\0 M src/a.ts\0");
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["src/a.ts"]);
    expect(result.err.join("\n")).toMatch(/^already staged: src\/gone\.ts {2}\[deletion in the index/m);
  });

  it("refuses a --repo that is not the top of its working tree (exit 2), naming the top to pass", async () => {
    const result = await list([], " M src/a.ts\0", false, false, join(BANKAI_REPO, ".."));
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/not its top[\s\S]*Pass --repo /);
  });

  it("names each unmerged path on stderr and withholds the list at exit 1", async () => {
    const result = await list([], "UU src/both.ts\0AA src/added.ts\0 M src/a.ts\0", true);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({
      verdict: "flagged",
      add: ["src/a.ts"],
      unmerged: ["src/both.ts", "src/added.ts"],
    });
    const text = await list([], "UU src/both.ts\0 M src/a.ts\0");
    expect(text.code).toBe(1);
    expect(text.out).toEqual([]);
    expect(text.err).toContain("unmerged: src/both.ts");
  });

  it("never lists an embedded repository, and names it on stderr at exit 1", async () => {
    const result = await list([], "?? vendor/lib/\0?? src/new.ts\0");
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/^embedded repository: vendor\/lib\/ {2}\[/m);
  });

  it("names a path whose raw bytes are not UTF-8 as undecodable and withholds the list", async () => {
    const enc = new TextEncoder();
    const bytes = new Uint8Array([...enc.encode("?? bad"), 0xff, ...enc.encode("name.ts\0 M src/a.ts\0")]);
    const result = await list([], "", true, false, BANKAI_REPO, bytes);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ verdict: "flagged", undecodable: ["bad\uFFFDname.ts"] });
  });

  it("lists a literal U+FFFD filename as an ordinary path at exit 0", async () => {
    const result = await list([], "?? bad\uFFFDname.ts\0 M src/a.ts\0");
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["bad\uFFFDname.ts", "src/a.ts"]);
  });

  it("counts a path in two buckets once: a DD is unmerged AND an unmentioned deletion", async () => {
    const result = await list([], "DD src/gone.ts\0 M src/a.ts\0");
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/nen: 1 path\(s\) need a human/);
  });

  it.skipIf(process.platform === "win32")("accepts a --repo whose toplevel ends in a space -- the path is read exactly", async () => {
    const top = join(mkdtempSync(join(tmpdir(), "nen-stage-top-")), "repo ");
    mkdirSync(top);
    const result = await list([], " M src/a.ts\0", false, false, top, undefined, top);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["src/a.ts"]);
  });

  it("lists a worktree rename's original as a deletion, flagged unless mentioned", async () => {
    const unmentioned = await list([], " R src/new.ts\0src/old.ts\0", true);
    expect(unmentioned.code).toBe(1);
    expect(JSON.parse(unmentioned.out.join("\n"))).toMatchObject({
      add: ["src/new.ts"],
      excluded: [{ path: "src/old.ts", reasons: ["unmentioned-deletion"] }],
    });
    const mentioned = await list(["--mentions", "moves old.ts"], " R src/new.ts\0src/old.ts\0");
    expect(mentioned.code).toBe(0);
    expect(mentioned.out).toEqual(["src/new.ts", "src/old.ts"]);
  });

  it("refuses --nul with --json, and --nul on triage, at exit 2", async () => {
    expect((await list(["--nul"], "", true)).code).toBe(2);
    expect((await capture(["stage", "triage", "--nul"])).code).toBe(2);
  });
});

describe("nen stage triage --range -- every git read that can fail, through the seam (zheref/nen#337)", () => {
  const BASE = "a".repeat(40);
  const HEAD = "b".repeat(40);
  const MB = "c".repeat(40);
  const LOG = `git -c core.quotePath=false log -z --format= --name-only --no-renames --diff-merges=cc --ignore-submodules=none --no-relative ${MB}..${HEAD} --`;
  const DIFF = `git -c core.quotePath=false diff -z --name-status --find-renames --ignore-submodules=none --no-relative --no-ext-diff ${MB} ${HEAD} --`;
  const CAT = "git cat-file --batch-check=%(objecttype) %(objectsize) -z";
  const fail = { code: 128, stderr: "fatal: boom" };

  function script(overrides: Readonly<Record<string, ScriptedCall["result"]>> = {}): ScriptedCall[] {
    const calls: Record<string, ScriptedCall["result"]> = {
      "git rev-parse --git-dir": { stdout: ".git\n" },
      "git rev-parse --verify --quiet --end-of-options main^{commit}": { stdout: `${BASE}\n` },
      "git rev-parse --verify --quiet --end-of-options topic^{commit}": { stdout: `${HEAD}\n` },
      [`git merge-base ${BASE} ${HEAD}`]: { stdout: `${MB}\n` },
      [`git rev-list --count ${MB}..${HEAD}`]: { stdout: "2\n" },
      [LOG]: { stdout: "src/a.ts\0" },
      [DIFF]: { stdout: "M\0src/a.ts\0" },
      [CAT]: { stdout: "blob 3\n" },
      ...overrides,
    };
    return Object.entries(calls).map(([match, result]): ScriptedCall => ({ match, result }));
  }

  it("reads clean through every step when nothing fails", async () => {
    const result = await capture(["stage", "triage", "--range", "main..topic"], script());
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      `read: committed range main..topic (${MB.slice(0, 12)}..${HEAD.slice(0, 12)}, 2 commit(s)), not the working copy`,
      "clean: 1 file(s)",
      "  src/a.ts",
      "ignored: 0 file(s), not listed",
    ]);
  });

  it.each([
    [`git merge-base ${BASE} ${HEAD}`, "the merge base"],
    [`git rev-list --count ${MB}..${HEAD}`, "the commit count \\(git rev-list\\)"],
    [LOG, "the paths the commits touched \\(git log\\)"],
    [DIFF, "the net change \\(git diff\\)"],
    [CAT, "the sizes at the head \\(git cat-file\\)"],
  ])("exits 1 when '%s' fails, naming %s", async (match, named) => {
    const result = await capture(["stage", "triage", "--range", "main..topic"], script({ [match]: fail }));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(new RegExp(`could not read ${named} for --range main\\.\\.topic: fatal: boom`));
    expect(result.out).toEqual([]);
  });

  it("names a shallow clone at exit 2 when the merge base is not in the repository (hanten N8)", async () => {
    const result = await capture(
      ["stage", "triage", "--range", "main..topic"],
      [
        ...script({ [`git merge-base ${BASE} ${HEAD}`]: { code: 1 } }),
        { match: "git rev-parse --is-shallow-repository", result: { stdout: "true\n" } },
      ],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/shallow clone -- fetch more history/);
  });

  it("calls two complete histories unrelated at exit 2 when the clone is not shallow", async () => {
    const result = await capture(
      ["stage", "triage", "--range", "main..topic"],
      [
        ...script({ [`git merge-base ${BASE} ${HEAD}`]: { code: 1 } }),
        { match: "git rev-parse --is-shallow-repository", result: { stdout: "false\n" } },
      ],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/share no common ancestor/);
  });

  it("refuses --large-bytes 0 in range mode at exit 2, before any git read", async () => {
    const result = await capture(["stage", "triage", "--range", "main..topic", "--large-bytes", "0"], []);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--large-bytes takes a positive whole number/);
  });

  it("refuses a '-' ref at exit 2 with no git call at all (hanten N7)", async () => {
    const result = await capture(["stage", "triage", "--range", "--upload-pack=x..main"], []);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/begins with '-'/);
  });
});
