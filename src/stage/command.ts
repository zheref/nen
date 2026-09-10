// src/stage/command.ts -- `nen stage triage`: tensho §3's flag table, detection
// only. The ask on every flagged file stays human -- see ./triage.ts's header.

import { assertRepoRoot } from "../repo/root.js";
import { GIT, outputLines } from "../seam/exec.js";
import { commaList } from "../cli/comma.js";
import {
  requireRepoFlag,
  requireSubcommand,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LARGE_BYTES, parseStatusPorcelain, triageStage } from "./triage.js";

const USAGE = `nen stage triage -- flag what should never be staged blind, tensho §3.

usage:
  nen stage triage --repo <path> [--scope src/,docs/] [--mentions "<free text>"]
                   [--large-bytes <n>]

  --scope        path prefixes considered in-scope for this change. Omit to
                 skip the out-of-scope check entirely (no scope declared,
                 nothing to compare against).
  --mentions     free text (a commit message draft, a PR description)
                 searched for a deleted path's basename -- an unmentioned
                 deletion is flagged, never silently staged.
  --large-bytes  bytes at or above which a file is flagged 'large'. Default
                 ${DEFAULT_LARGE_BYTES} (1 MiB): no ordinary source file trips
                 it, and a multi-megabyte accident does. A file this verb
                 could not measure -- a deletion -- is never flagged large,
                 because "not measured" must not read as "measured and small".

Detects, never decides: secret shapes (.env, *.pem, *.key, credentials*),
local-config filenames (the '.local' infix -- settings.local.json, .env.local,
config.local.yml), files at or over --large-bytes, binaries, out-of-scope
paths and unmentioned deletions -- these are FLAGGED,
and 'a flagged file is never committed without an explicit yes', a yes this
verb never gives. A git-ignored path is a FACT rather than a question -- it
cannot be staged without -f, so there is nothing to ask -- and is reported
separately as a count in text (the paths themselves are never printed in
text; read them from --json). Exits 1 only when something is flagged; an
all-ignored tree is exit 0.`;

export const stageCommand: Command = {
  name: "stage",
  summary: "Flag secrets, local config, oversized files, binaries and unmentioned deletions before staging.",
  usage: USAGE,
  flags: { values: ["scope", "mentions", "large-bytes"], booleans: [] },
  run(context: CommandContext): number {
    requireSubcommand("stage", context.args, ["triage"]);
    // Usage lists --repo unbracketed: omitting it is refused by name at exit 2,
    // never silently pointed at whatever working copy the process is standing
    // in (zheref/nen#28).
    const root = assertRepoRoot({
      repoFlag: requireRepoFlag(context, "It names the working tree whose unstaged files are triaged."),
    });
    const result = context.seams.run(
      GIT,
      ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--ignored", "-uall"],
      { cwd: root },
    );
    if (result.code !== 0) {
      context.io.err(`nen: could not read working-copy status: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}`);
      return 1;
    }
    const rawLarge = context.args.values["large-bytes"];
    const largeBytes = rawLarge === undefined ? DEFAULT_LARGE_BYTES : Number(rawLarge);
    if (!Number.isInteger(largeBytes) || largeBytes <= 0) {
      throw new VerbUsageError(
        `--large-bytes takes a positive whole number of bytes -- got '${rawLarge}'. It is the size at or above which a file is flagged for a human to look at, so a zero or negative one would flag every file and say nothing.`,
      );
    }

    const entries = parseStatusPorcelain(result.stdout);
    // MEASURED HERE, NOT IN THE PURE MODULE. ./triage.ts has no filesystem --
    // that is what makes every one of its branches testable as data -- so the
    // sizes are read at this seam and handed in. A path that cannot be stat'd
    // (a deletion, a broken symlink) simply contributes no entry, and the
    // detector treats an absent size as "not measured" rather than as small.
    const sizes = new Map<string, number>();
    for (const entry of entries) {
      // AN IGNORED PATH IS NOT MEASURED (Copilot, PR #189). It can never reach
      // `flagged`, never affects the exit code and is never listed in text --
      // and `--ignored -uall` on a repository with a `node_modules/` tree is
      // thousands of entries, so statting them buys one unreadable `--json`
      // field for a synchronous stat storm on every invocation. The `ignored`
      // bucket is a bucket of FACTS about paths a plain `git add` cannot stage;
      // how big such a file is was never one of the facts it carried.
      if (entry.ignored) continue;
      if (entry.indexStatus === "D" || entry.worktreeStatus === "D") continue;
      try {
        const stats = statSync(join(root, ...entry.path.split("/")));
        if (stats.isFile()) sizes.set(entry.path, stats.size);
      } catch {
        // Unmeasurable is not small. Nothing is recorded for this path.
      }
    }

    const triage = triageStage(entries, {
      scopePrefixes: commaList(context.args.values["scope"]),
      mentionedText: context.args.values["mentions"] ?? "",
      sizes,
      largeBytes,
    });

    if (context.json) {
      context.io.out(JSON.stringify(triage, null, 2));
      return triage.flagged.length === 0 ? 0 : 1;
    }
    context.io.out(`clean: ${triage.clean.length} file(s)`);
    for (const path of triage.clean) context.io.out(`  ${path}`);
    // A count only -- this verb carries no --verbose flag, so the paths
    // themselves are never listed in text (zheref/nen#169). Printed
    // unconditionally, even at zero, matching the 'clean' line above: both
    // are informational, never a call to answer yes or no to.
    context.io.out(`ignored: ${triage.ignored.length} file(s), not listed`);
    if (triage.flagged.length > 0) {
      context.io.out(`flagged: ${triage.flagged.length} file(s) -- never staged without an explicit yes`);
      for (const file of triage.flagged) context.io.out(`  ${file.path}  [${file.reasons.join(", ")}]`);
      return 1;
    }
    return 0;
  },
};
