import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { watchCommand } from "./command.js";
import { noPortProbe } from "../seam/scripted.js";

// A Seams whose run() results come from a queue -- one per call -- since the
// SAME observation command is invoked repeatedly with an evolving answer
// ("pending", then "ALL_GREEN"), which a match-by-argv stub cannot express.
class QueueSeams implements Seams {
  private readonly queue: CommandResult[];
  /** Every spawn, as (command, args) -- so a test can assert the EXACT argv the watch ran (zheref/nen#288). */
  readonly calls: { readonly command: string; readonly args: readonly string[] }[] = [];
  readonly now = (): Date => new Date("2026-01-01T00:00:00Z");
  readonly env = {};
  readonly platform: NodeJS.Platform;
  probePort: Seams["probePort"] = noPortProbe;
  runInteractive: Seams["runInteractive"] = (): never => {
    throw new Error("watch until never spawns an interactive child -- it observes");
  };
  runStreamed: Seams["runStreamed"] = (): never => {
    throw new Error("watch until never spawns a watched child -- it observes");
  };
  constructor(queue: readonly CommandResult[], platform: NodeJS.Platform = "linux") {
    this.queue = [...queue];
    this.platform = platform;
  }
  run: Seams["run"] = (command, args): CommandResult => {
    this.calls.push({ command, args: [...args] });
    const next = this.queue.shift();
    if (next === undefined) throw new Error("QueueSeams ran out of scripted results");
    return next;
  };
}

const OK = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", spawnFailed: false });

async function capture(
  argv: readonly string[],
  seams: Seams = new QueueSeams([]),
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
  const code = await runFamily(watchCommand, argv, null, false, io, seams);
  return { code, out, err };
}

describe("nen watch until -- CLI wiring", () => {
  it("refuses a mutating --command before ever observing", async () => {
    const result = await capture(["watch", "until", "--command", "git push origin main"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/classifies as mutating/);
  });

  // zheref/nen#31: a file-read watch and a nen-verb watch were both refused
  // as unknown; the classifier now admits them, and the verb wiring must too.
  it("accepts a plain file read as the observation (#31)", async () => {
    const result = await capture(
      ["watch", "until", "--command", "cat somefile.txt", "--true-pattern", "ok", "--interval-ms", "0"],
      new QueueSeams([OK("not yet"), OK("ok")]),
    );
    expect(result.code).toBe(0);
  });

  it("accepts a read-only nen verb as the observation (#31)", async () => {
    const result = await capture(
      ["watch", "until", "--command", "nen pr ready 925 --gh-repo owner/repo", "--interval-ms", "0"],
      new QueueSeams([OK("Ready")]),
    );
    expect(result.code).toBe(0);
  });

  it("still refuses a mutating nen verb before ever observing (#31)", async () => {
    const result = await capture([
      "watch",
      "until",
      "--command",
      "nen label apply XX-PR-#1 --label wake --repo-slug o/r --run",
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/classifies as mutating/);
  });

  // zheref/nen#70: the pre-existing gh/git rows carried no metacharacter
  // guard, so `git log > out.txt` classified read-only and this verb would
  // have accepted it. In-binary the redirection was inert (the observation is
  // spawned with NO shell, so `>` reached git as a literal argument), but the
  // verdict is also consumed by the skill side -- and the verb must refuse the
  // line before ever spawning either way.
  it("refuses a redirection on a gh/git read before ever observing (#70)", async () => {
    const result = await capture(["watch", "until", "--command", "git log > out.txt"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/classifies as unknown/);
    expect(result.err.join("\n")).toMatch(/shell metacharacter/);
  });

  it("still accepts the bare gh/git read the redirection was hiding behind (#70)", async () => {
    const result = await capture(
      ["watch", "until", "--command", "git log -1", "--interval-ms", "0"],
      new QueueSeams([OK()]),
    );
    expect(result.code).toBe(0);
  });

  // zheref/nen#70 ROUND TWO, and the only blocker of the three that this verb
  // could execute WITHOUT a skill-side shell. `git branch nen70-probe`
  // classified read-only, so this verb spawned it -- and git created the
  // branch. Verified by running it against a throwaway repository before the
  // fix: the watch printed "condition is true (exit 0)" and `git branch
  // --list` showed nen70-probe. This is the assertion that says the watch
  // never gets that far again.
  it("refuses 'git branch <name>' before ever spawning -- it CREATED the branch in-binary (#70)", async () => {
    const result = await capture(["watch", "until", "--command", "git branch nen70-probe"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/classifies as mutating/);
    // No observation was ever queued, so a spawn would have thrown out of
    // QueueSeams -- the refusal is proven to precede the first run, not merely
    // to accompany it.
  });

  it("still accepts the listing forms the create was riding beside (#70)", async () => {
    for (const command of ["git branch --list feature/x", "git branch --show-current", "git remote get-url origin"]) {
      const result = await capture(
        ["watch", "until", "--command", command, "--interval-ms", "0"],
        new QueueSeams([OK()]),
      );
      expect(result.code, command).toBe(0);
    }
  });

  // The gh api blockers reach this verb the same way, and gh parses its own
  // argv identically with or without a shell -- so `-ftitle=pwned` was a live
  // POST behind a [read-only] verdict on this path, not only on the skill's.
  it("refuses gh api's attached-value write spellings before ever observing (#70)", async () => {
    for (const command of ["gh api repos/o/r/issues -X=DELETE", "gh api repos/o/r/issues -ftitle=pwned"]) {
      const result = await capture(["watch", "until", "--command", command]);
      expect(result.code, command).toBe(2);
      expect(result.err.join("\n"), command).toMatch(/classifies as mutating/);
    }
  });

  // zheref/nen#288, the issue's own acceptance criterion: a jq filter's
  // internal pipe, inside a quoted --jq value, is ONE argument to gh -- no
  // shell ever sees it -- so the watch accepts the line, spawns exactly the
  // argv a shell would have built, and exits on its CONDITION (0 here), never
  // 2 for a metacharacter that never reaches a shell.
  it("accepts a quoted --jq filter's internal pipe and spawns it as ONE argument (#288)", async () => {
    const seams = new QueueSeams([OK('["cursor"]\n')]);
    const result = await capture(
      [
        "watch",
        "until",
        "--command",
        'gh pr view 295 --repo zheref/nen --json reviews --jq "[.reviews[]|select(.commit.oid|startswith(\\"ecc420c\\"))|.author.login]"',
        "--true-pattern",
        '"cursor"',
        "--interval-ms",
        "0",
      ],
      seams,
    );
    expect(result.code).toBe(0);
    expect(seams.calls).toEqual([
      {
        command: "gh",
        args: [
          "pr",
          "view",
          "295",
          "--repo",
          "zheref/nen",
          "--json",
          "reviews",
          "--jq",
          '[.reviews[]|select(.commit.oid|startswith("ecc420c"))|.author.login]',
        ],
      },
    ]);
  });

  it("exits 1 on its condition, not 2, when the quoted-pipe read is simply not true yet (#288)", async () => {
    const result = await capture(
      ["watch", "until", "--command", "gh pr view 1 --json reviews --jq '.reviews[]|.author.login'", "--true-pattern", "someone", "--max-iterations", "1", "--interval-ms", "0"],
      new QueueSeams([OK("nobody\n")]),
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/--max-iterations bound/);
  });

  // The latent twin of #288: the #78 fold CERTIFIED a single-quoted gh api
  // --jq, and v0.17.0 then spawned `line.split(/\s+/)` -- so jq received
  // `'.number'` with its quotes on and failed to parse it on every
  // observation. One tokeniser for both halves is what closes it.
  it("spawns a single-quoted --jq value WITHOUT its quotes (#288)", async () => {
    const seams = new QueueSeams([OK("295\n")]);
    const result = await capture(
      ["watch", "until", "--command", "gh api repos/zheref/nen/pulls/295 --jq '.number'", "--true-pattern", "^295", "--interval-ms", "0"],
      seams,
    );
    expect(result.code).toBe(0);
    expect(seams.calls).toEqual([{ command: "gh", args: ["api", "repos/zheref/nen/pulls/295", "--jq", ".number"] }]);
  });

  it("still refuses a genuine two-command line with the existing message, before ever spawning (#288)", async () => {
    for (const command of [
      "gh pr view 1 | tee leak.txt",
      "gh pr view 1; git push",
      'gh pr view "$(git push)"',
      'gh pr view "`git push`"',
      'gh pr view 1 --jq [.a[]|select(.b|startswith("x"))]',
    ]) {
      const seams = new QueueSeams([]);
      const result = await capture(["watch", "until", "--command", command], seams);
      expect(result.code, command).toBe(2);
      expect(result.err.join("\n"), command).toMatch(/classifies as unknown \(a shell metacharacter/);
      expect(seams.calls, command).toEqual([]);
    }
  });

  // The Windows gate, at the verb: the platform comes from the SEAMS, so this
  // lane proves the win32 branch on every host. A `.cmd`/`.bat` target would
  // be re-parsed by cmd.exe, so there the quoted pipe keeps v0.17.0's refusal
  // -- while the quote-stripping half of the fix still applies.
  it("keeps the whole-line refusal for a quoted pipe on win32, and still spawns stripped quotes there (#288)", async () => {
    const refused = new QueueSeams([], "win32");
    const refusal = await capture(["watch", "until", "--command", "gh pr view 1 --jq '.a|.b'"], refused);
    expect(refusal.code).toBe(2);
    expect(refusal.err.join("\n")).toMatch(/classifies as unknown \(a shell metacharacter/);
    expect(refused.calls).toEqual([]);

    const spawned = new QueueSeams([OK("1\n")], "win32");
    const read = await capture(
      ["watch", "until", "--command", "gh api repos/o/r/pulls/1 --jq '.number'", "--interval-ms", "0"],
      spawned,
    );
    expect(read.code).toBe(0);
    expect(spawned.calls).toEqual([{ command: "gh", args: ["api", "repos/o/r/pulls/1", "--jq", ".number"] }]);
  });

  // #288's REVIEW, SEC-7, at the verb: each of these reached `gh` in round one
  // of this fix as an argv gh 2.100.0 sends as a DELETE or a POST (`-q''` is a
  // bare `-q`, which takes the next argument as its value; `-q=` is the value
  // "=", which does not). The watch now walks the argv it would spawn, sees
  // the write, and never spawns.
  it("refuses all ten SEC-7 write spellings at exit 2 on every host and spawns nothing (#288 review)", async () => {
    // The review's four, then the six found settling it -- the same ten
    // ../parse/izanami.gh-api.test.ts pins at the classifier, driven here
    // through the verb on each host the watch distinguishes.
    for (const command of [
      "gh api repos/o/r/issues/1 -q'' -H -XDELETE",
      "gh api repos/o/r/issues/1 -q'' -H -ftitle=x",
      "gh api repos/o/r/issues/1 -q'' -H --method=DELETE",
      "gh api repos/o/r/issues -q'' -p --input=/etc/hosts",
      'gh api repos/o/r/issues/1 -q"" -H -XDELETE',
      "gh api repos/o/r/issues/1 -q= -XDELETE",
      "gh api repos/o/r/issues/1 -H= --method=DELETE",
      "gh api repos/o/r/issues/1 -p= -ftitle=x",
      "gh api repos/o/r/issues/1 -t= --input=body.json",
      "gh api repos/o/r/issues/1 -iq= -XDELETE",
    ]) {
      for (const platform of ["linux", "darwin", "win32"] as const) {
        const seams = new QueueSeams([], platform);
        const result = await capture(["watch", "until", "--command", command], seams);
        expect(result.code, `${platform}: ${command}`).toBe(2);
        expect(result.err.join("\n"), `${platform}: ${command}`).toMatch(/classifies as mutating/);
        expect(seams.calls, `${platform}: ${command}`).toEqual([]);
      }
    }
  });

  it("spawns a double-quoted gh api --jq as the one argument gh receives (#288 review)", async () => {
    const seams = new QueueSeams([OK("[1]\n")]);
    const result = await capture(
      ["watch", "until", "--command", 'gh api repos/o/r/pulls --jq "[.[]|.number]"', "--interval-ms", "0"],
      seams,
    );
    expect(result.code).toBe(0);
    expect(seams.calls).toEqual([{ command: "gh", args: ["api", "repos/o/r/pulls", "--jq", "[.[]|.number]"] }]);
  });

  // #288 review, round three: round two's rendering quoted `[`, `]` and `!`,
  // so this exact watch -- read at exit 0 by 0.15.1 and by round one -- exited
  // 2. It is a plain read again, on every host, and spawns the argv as typed.
  it("watches a [ ... ] and a test ! read again, on every host (#288 review)", async () => {
    for (const [command, argv] of [
      ["[ -e /etc/hosts ]", ["-e", "/etc/hosts", "]"]],
      ["[ ! -e /nonexistent ]", ["!", "-e", "/nonexistent", "]"]],
    ] as const) {
      for (const platform of ["linux", "darwin", "win32"] as const) {
        const seams = new QueueSeams([OK()], platform);
        const result = await capture(["watch", "until", "--command", command, "--interval-ms", "0"], seams);
        expect(result.code, `${platform}: ${command}`).toBe(0);
        expect(seams.calls, `${platform}: ${command}`).toEqual([{ command: "[", args: argv }]);
      }
    }
    const seams = new QueueSeams([OK()]);
    expect((await capture(["watch", "until", "--command", "test ! -e /nonexistent", "--interval-ms", "0"], seams)).code).toBe(0);
    expect(seams.calls).toEqual([{ command: "test", args: ["!", "-e", "/nonexistent"] }]);
  });

  it("refuses a NUL byte at exit 2 rather than spawning an argument the OS would cut short (#288 review)", async () => {
    const seams = new QueueSeams([]);
    const result = await capture(["watch", "until", "--command", "gh pr view 1\u0000x"], seams);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/a NUL byte at offset 12/);
    expect(seams.calls).toEqual([]);
  });

  it("refuses an unterminated quote at exit 2 rather than spawning a guessed argv (#288)", async () => {
    const seams = new QueueSeams([]);
    const result = await capture(["watch", "until", "--command", "gh pr view 1 --jq '.a|.b"], seams);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/quote at offset 18 is never closed/);
    expect(seams.calls).toEqual([]);
  });

  it("exits 0 the moment exit-code-0 is reached, with no --true-pattern given", async () => {
    const result = await capture(
      ["watch", "until", "--command", "gh pr checks 1", "--interval-ms", "0"],
      new QueueSeams([OK()]),
    );
    expect(result.code).toBe(0);
  });

  it("matches --true-pattern against stdout", async () => {
    const result = await capture(
      ["watch", "until", "--command", "gh pr checks 1", "--true-pattern", "ALL_GREEN", "--interval-ms", "0"],
      new QueueSeams([OK("pending"), OK("ALL_GREEN at last")]),
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/condition became true after 2 observation/);
  });

  it("exits 1 and reports the bound when --max-iterations is reached", async () => {
    const result = await capture(
      ["watch", "until", "--command", "gh pr checks 1", "--true-pattern", "NEVER", "--max-iterations", "2", "--interval-ms", "0"],
      new QueueSeams([OK("no"), OK("no")]),
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/--max-iterations bound/);
  });

  it("requires --command", async () => {
    expect((await capture(["watch", "until"])).code).toBe(2);
  });

  // Review finding #12: the default isError only catches a missing binary,
  // so a command that runs but fails fatally (git in a non-git directory,
  // gh unauthenticated) used to read as "condition is not yet true" forever
  // instead of stopping at the 3-consecutive-error streak.
  it("stops at the error streak, NOT --max-iterations, when the command itself fails fatally (exit-code-as-truth mode)", async () => {
    const FATAL = (): CommandResult => ({ code: 128, stdout: "", stderr: "fatal: not a git repository\n", spawnFailed: false });
    const result = await capture(
      ["watch", "until", "--command", "git log --oneline -1", "--max-iterations", "10", "--interval-ms", "0"],
      new QueueSeams([FATAL(), FATAL(), FATAL()]),
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/consecutive observation errors/);
    expect(result.out.join("\n")).toMatch(/fatal: not a git repository/);
  });

  it("a --true-pattern command that exits non-zero is an ERROR, not a false reading", async () => {
    const FATAL = (): CommandResult => ({ code: 1, stdout: "", stderr: "gh: not authenticated\n", spawnFailed: false });
    const result = await capture(
      ["watch", "until", "--command", "gh pr checks 1", "--true-pattern", "ALL_GREEN", "--max-iterations", "10", "--interval-ms", "0"],
      new QueueSeams([FATAL(), FATAL(), FATAL()]),
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/consecutive observation errors/);
  });

  it("--error-exit-threshold raises the bar for what counts as an error in exit-code-as-truth mode", async () => {
    const result = await capture(
      ["watch", "until", "--command", "git status", "--error-exit-threshold", "5", "--max-iterations", "2", "--interval-ms", "0"],
      // Exit code 3 is below the raised threshold -- a false reading, not an error.
      new QueueSeams([
        { code: 3, stdout: "", stderr: "", spawnFailed: false },
        { code: 3, stdout: "", stderr: "", spawnFailed: false },
      ]),
    );
    expect(result.code).toBe(1);
    // Reached the iteration bound, not the error streak -- exit 3 was read as
    // false (below the raised threshold), not as an observation error.
    expect(result.err.join("\n")).toMatch(/--max-iterations bound/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["watch", "bogus"])).code).toBe(2);
  });
});
