// src/run/rerun.ts -- `gh run rerun --failed`, senkei §4's dead-reviewer
// recovery: "re-run the failed job; never re-label to force a re-vote."

import { lines, type Runner } from "../exec/seam.js";
import type { Target } from "../github/target.js";

export function rerunFailedArgv(target: Target, runId: number): readonly string[] {
  return ["run", "rerun", String(runId), "--repo", target.slug, "--failed"];
}

export interface RerunResult {
  readonly ok: boolean;
  readonly message: string;
}

export function rerunFailed(runner: Runner, target: Target, runId: number): RerunResult {
  const result = runner.run({ bin: "gh", args: [...rerunFailedArgv(target, runId)] });
  if (result.code !== 0) {
    return {
      ok: false,
      message: `could not rerun ${target.slug}'s run ${runId}: ${
        (result.spawnError ?? lines(result.stderr).join(" ")) || `exit ${result.code}`
      }`,
    };
  }
  return { ok: true, message: `re-ran the failed job(s) of ${target.slug}'s run ${runId}` };
}
