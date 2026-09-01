// src/stage/command.ts -- `nen stage triage`: tensho §3's flag table, detection
// only. The ask on every flagged file stays human -- see ./triage.ts's header.

import { assertRepoRoot } from "../repo/root.js";
import { GIT, outputLines } from "../seam/exec.js";
import { commaList } from "../cli/comma.js";
import { requireSubcommand, type Command, type CommandContext } from "../cli/command.js";
import { parseStatusPorcelain, triageStage } from "./triage.js";

const USAGE = `nen stage triage -- flag what should never be staged blind, tensho §3.

usage:
  nen stage triage --repo <path> [--scope src/,docs/] [--mentions "<free text>"]

  --scope     path prefixes considered in-scope for this change. Omit to skip
              the out-of-scope check entirely (no scope declared, nothing to
              compare against).
  --mentions  free text (a commit message draft, a PR description) searched
              for a deleted path's basename -- an unmentioned deletion is
              flagged, never silently staged.

Detects, never decides: secret shapes (.env, *.pem, *.key, credentials*),
git-ignored files, binaries, out-of-scope paths and unmentioned deletions.
Exits 1 when anything is flagged -- 'a flagged file is never committed
without an explicit yes', and that yes is never this verb's to give.`;

export const stageCommand: Command = {
  name: "stage",
  summary: "Flag secrets, ignored files, binaries and unmentioned deletions before staging.",
  usage: USAGE,
  flags: { values: ["scope", "mentions"], booleans: [] },
  run(context: CommandContext): number {
    requireSubcommand("stage", context.args, ["triage"]);
    const root = assertRepoRoot({ repoFlag: context.repoFlag });
    const result = context.seams.run(
      GIT,
      ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--ignored", "-uall"],
      { cwd: root },
    );
    if (result.code !== 0) {
      context.io.err(`nen: could not read working-copy status: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}`);
      return 1;
    }
    const entries = parseStatusPorcelain(result.stdout);
    const triage = triageStage(entries, {
      scopePrefixes: commaList(context.args.values["scope"]),
      mentionedText: context.args.values["mentions"] ?? "",
    });

    if (context.json) {
      context.io.out(JSON.stringify(triage, null, 2));
      return triage.flagged.length === 0 ? 0 : 1;
    }
    context.io.out(`clean: ${triage.clean.length} file(s)`);
    for (const path of triage.clean) context.io.out(`  ${path}`);
    if (triage.flagged.length > 0) {
      context.io.out(`flagged: ${triage.flagged.length} file(s) -- never staged without an explicit yes`);
      for (const file of triage.flagged) context.io.out(`  ${file.path}  [${file.reasons.join(", ")}]`);
      return 1;
    }
    return 0;
  },
};
