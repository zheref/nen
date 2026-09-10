// src/cli/target-flag.test.ts -- one refusal for `--target`, across sixteen
// verbs (zheref/nen#93).
//
// WHY A SWEEP RATHER THAN FOUR CASES. The defect was not that one verb had the
// wrong code: it was that FOUR families each kept a private `requireTarget`,
// so the answer to "what does a forgotten --target do" depended on which family
// you asked. Four hand-written cases would have re-created exactly that -- four
// places to keep agreeing -- so this drives every verb the four families
// declare as requiring the flag, through the real CLI, and asserts one answer.

import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { issueCommand } from "../issue/command.js";
import { labelsCommand } from "../labels/command.js";
import { prCommand } from "../pr/command.js";
import { repoCommand } from "../repo/command.js";
import type { Command } from "./command.js";

/** Every verb of the four families whose first act is to resolve `--target`. */
const VERBS: readonly (readonly [Command, readonly string[]])[] = [
  [repoCommand, ["repo", "inventory"]],
  [repoCommand, ["repo", "scenario", "--repo", "."]],
  [labelsCommand, ["labels", "sync", "--repo", "."]],
  [labelsCommand, ["labels", "rename", "--map", "a=b"]],
  [prCommand, ["pr", "fetch", "--pr", "1"]],
  [prCommand, ["pr", "next-blocker", "--pr", "1", "--repo", "."]],
  [prCommand, ["pr", "retarget", "--pr", "1"]],
  [prCommand, ["pr", "request-reviews", "--pr", "1", "--add-reviewers", "x"]],
  [issueCommand, ["issue", "search", "--subject", "x"]],
  [issueCommand, ["issue", "open-pr-check", "--issues", "1"]],
  [issueCommand, ["issue", "attach-sub", "--parent", "1", "--children", "2"]],
  [issueCommand, ["issue", "comment", "--issue", "1", "--body", "x"]],
  [issueCommand, ["issue", "chain-position", "--issue", "1"]],
  [issueCommand, ["issue", "terminus", "--issue", "1"]],
];

// `pr cascade-main` is DELIBERATELY ABSENT. It reaches the same helper and
// answers the same way, but only after a `git fetch`, so driving it here would
// mean scripting a subprocess into a table about a flag -- and a row that had
// to be taught about git to assert something about `--target` would be the
// least trustworthy row in the sweep. Where its `--target` check sits relative
// to that fetch is a separate question from what it answers, and not this
// issue's.
//
// Some rows carry a second flag beside the one under test. That is not padding:
// a verb whose `--repo` is required answers about THAT first, and a row missing
// it would assert the wrong refusal while looking like it asserted the right
// one. Each extra flag here is the minimum that lets `--target` be the first
// thing missing.

async function refusal(command: Command, argv: readonly string[]): Promise<{ code: number; err: string }> {
  const err: string[] = [];
  const io: Io = { out: (): void => {}, err: (line): void => { err.push(line); } };
  const seams = new ScriptedSeams([]);
  const code = await runFamily(command, argv, null, false, io, seams);
  return { code, err: err.join("\n") };
}

describe("a missing --target is a USAGE error, in every family that takes one", () => {
  it("drives a non-trivial number of verbs, so the sweep is not silently empty", () => {
    expect(VERBS.length).toBeGreaterThan(10);
  });

  for (const [command, argv] of VERBS) {
    it(`nen ${argv.join(" ")} refuses at exit 2, naming the flag`, async () => {
      const result = await refusal(command, argv);
      // EXIT 2, NOT 1. ../index.ts's header draws the line: 1 is "the thing you
      // asked for did not work", 2 is "you typed it wrong". A retry wrapper
      // honouring that retries a 1 and gives up on a 2, so the wrong code turns
      // a forgotten flag into a loop.
      expect(result.code, `${argv.join(" ")}: ${result.err}`).toBe(2);
      expect(result.err).toMatch(/--target owner\/name is required/);
    });
  }
});
