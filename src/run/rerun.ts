// src/run/rerun.ts -- `gh run rerun --failed`, senkei §4's dead-reviewer
// recovery: "re-run the failed job; never re-label to force a re-vote."
//
// `--dry-run` prints the exact `gh run rerun` line and spawns nothing (Hatsu
// SDD plan N6) -- no read either, so the preview needs no token.

import { GH, outputLines, type Seams } from "../seam/exec.js";
import { renderCommand } from "../wc/mechanical.js";
import type { Target } from "../github/target.js";

export function rerunFailedArgv(target: Target, runId: number): readonly string[] {
  return ["run", "rerun", String(runId), "--repo", target.slug, "--failed"];
}

/** KEY ORDER IS THE SHAPE: `ok` and `message` first, as before N6; `dryRun` and `command` appended. */
export interface RerunResult {
  readonly ok: boolean;
  readonly message: string;
  readonly dryRun: boolean;
  /** The `gh` call, as one shell line -- the one made, or under --dry-run the one that would be. */
  readonly command: string;
}

export function rerunFailed(seams: Seams, target: Target, runId: number, dryRun = false): RerunResult {
  const argv = rerunFailedArgv(target, runId);
  const command = renderCommand([GH, ...argv]);
  if (dryRun) return { ok: true, message: `would run: ${command}`, dryRun, command };
  const result = seams.run(GH, [...argv]);
  if (result.code !== 0) {
    return {
      ok: false,
      message: `could not rerun ${target.slug}'s run ${runId}: ${
        outputLines(result.stderr).join(" ") || `exit ${result.code}`
      }`,
      dryRun,
      command,
    };
  }
  return { ok: true, message: `re-ran the failed job(s) of ${target.slug}'s run ${runId}`, dryRun, command };
}
