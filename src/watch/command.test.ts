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
