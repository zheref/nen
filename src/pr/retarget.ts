// src/pr/retarget.ts -- `gh pr edit --base <branch>`, the split skill's single
// documented command for cascading a stack after its first PR merges.
//
// ONE COMMAND, NOT A CHOREOGRAPHY. jujisho's stacked-PR retarget is exactly
// this call; the judgment (which PR moves, and to what) is the caller's, so
// this module's whole job is to build the argv correctly and read back
// whether `gh` accepted it.

import { lines, type Runner } from "../exec/seam.js";
import type { Target } from "../github/target.js";

export function retargetArgv(target: Target, prNumber: number, base: string): readonly string[] {
  return ["pr", "edit", String(prNumber), "--repo", target.slug, "--base", base];
}

export interface RetargetResult {
  readonly ok: boolean;
  readonly message: string;
}

export function retarget(runner: Runner, target: Target, prNumber: number, base: string): RetargetResult {
  const result = runner.run({ bin: "gh", args: [...retargetArgv(target, prNumber, base)] });
  if (result.code !== 0) {
    return {
      ok: false,
      message: `could not retarget ${target.slug}#${prNumber} to '${base}': ${
        (result.spawnError ?? lines(result.stderr).join(" ")) || `exit ${result.code}`
      }`,
    };
  }
  return { ok: true, message: `${target.slug}#${prNumber} now targets '${base}'` };
}
