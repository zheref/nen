// src/pr/retarget.ts -- `gh pr edit --base <branch>`, the split skill's single
// documented command for cascading a stack after its first PR merges.
//
// ONE COMMAND, NOT A CHOREOGRAPHY. jujisho's stacked-PR retarget is exactly
// this call; the judgment (which PR moves, and to what) is the caller's, so
// this module's whole job is to build the argv correctly and read back
// whether `gh` accepted it.
//
// `--dry-run` PRINTS THE ONE CALL AND MAKES NONE (Hatsu SDD plan N6): the
// exact `gh pr edit` line, rendered so a POSIX shell reads it back as the same
// argv, and nothing spawned -- not even a read, so the preview needs no token.

import { GH, outputLines, type Seams } from "../seam/exec.js";
import { renderCommand } from "../wc/mechanical.js";
import type { Target } from "../github/target.js";

export function retargetArgv(target: Target, prNumber: number, base: string): readonly string[] {
  return ["pr", "edit", String(prNumber), "--repo", target.slug, "--base", base];
}

/** KEY ORDER IS THE SHAPE: `ok` and `message` first, as before N6; `dryRun` and `command` appended. */
export interface RetargetResult {
  readonly ok: boolean;
  readonly message: string;
  readonly dryRun: boolean;
  /** The `gh` call, as one shell line -- the one made, or under --dry-run the one that would be. */
  readonly command: string;
}

export function retarget(seams: Seams, target: Target, prNumber: number, base: string, dryRun = false): RetargetResult {
  const argv = retargetArgv(target, prNumber, base);
  const command = renderCommand([GH, ...argv]);
  if (dryRun) return { ok: true, message: `would run: ${command}`, dryRun, command };
  const result = seams.run(GH, [...argv]);
  if (result.code !== 0) {
    return {
      ok: false,
      message: `could not retarget ${target.slug}#${prNumber} to '${base}': ${
        outputLines(result.stderr).join(" ") || `exit ${result.code}`
      }`,
      dryRun,
      command,
    };
  }
  return { ok: true, message: `${target.slug}#${prNumber} now targets '${base}'`, dryRun, command };
}
