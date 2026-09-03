import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { watchCommand } from "./command.js";

// A Seams whose run() results come from a queue -- one per call -- since the
// SAME observation command is invoked repeatedly with an evolving answer
// ("pending", then "ALL_GREEN"), which a match-by-argv stub cannot express.
class QueueSeams implements Seams {
  private readonly queue: CommandResult[];
  readonly now = (): Date => new Date("2026-01-01T00:00:00Z");
  readonly env = {};
  constructor(queue: readonly CommandResult[]) {
    this.queue = [...queue];
  }
  run: Seams["run"] = (): CommandResult => {
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
