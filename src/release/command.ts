// src/release/command.ts -- `nen release preflight`.
//
// Gathers getsuga SKILL.md §2's six preconditions -- one `gh`/`git` call each,
// plus caller-supplied facts for the two that need per-repository judgement
// (which issues are critical, which chores exist) -- and hands them to
// ../release/preflight.ts's pure table, which reports every one, never
// stopping at the first failure.

import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  emit,
  requireSubcommand,
  requireValue,
  splitIntegerList,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { readJsonFile, readTextFile, splitList } from "../cli/inputs.js";
import { extractChangelogRefs, extractFragmentRefs, extractMergedPrNumbers } from "../changelog/completeness.js";
import { resolveRepoRoot } from "../repo/root.js";
import { GH, GIT, must, outputLines, type CommandResult } from "../seam/exec.js";
import { runPreflight, type HoldState, type LiveChoreCandidate } from "./preflight.js";

/**
 * RELEASE_HOLD has THREE states, not two (review finding): `gh` failing to
 * spawn, exiting non-zero for a reason other than "the variable was never
 * created", must never read the same as a repository that genuinely has no
 * hold set -- a `gh` that is not installed, unauthenticated, or scoped
 * without variable-read access must fail the check, not fail it open.
 *
 * `gh variable get <name>`'s own message for a variable that was never
 * created is exactly `variable <name> was not found` (confirmed against a
 * live `gh` -- both a missing variable AND a missing/inaccessible repository
 * produce this identical text, since GitHub's API 404s both cases the same
 * way; there is no way to tell them apart from stderr text alone, so this
 * treats the shape gh actually documents as "unset" and everything else,
 * including a 403/permission error or a generic "HTTP 404: Not Found", as
 * unreadable). A second review finding: matching any stderr that merely
 * CONTAINS "not found" as a substring also matches unrelated errors like an
 * `HTTP 404: Not Found` from a different failure mode -- that reintroduces
 * the exact fail-open hole this function exists to close, so the match must
 * be anchored to gh's whole message shape, not a substring sniff.
 */
function isVariableNotFoundMessage(stderr: string, holdVar: string): boolean {
  const escapedVar = holdVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^variable ${escapedVar} (?:was )?not found$`, "i");
  return pattern.test(stderr.trim());
}

function resolveHoldState(result: CommandResult, holdVar: string): HoldState {
  if (result.spawnFailed) {
    return { kind: "unreadable", detail: result.stderr.trim() || "gh could not be started" };
  }
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    if (isVariableNotFoundMessage(stderr, holdVar)) {
      return { kind: "unset" };
    }
    return { kind: "unreadable", detail: stderr || `gh exited ${result.code}` };
  }
  const value = result.stdout.trim();
  return value === "" ? { kind: "unset" } : { kind: "held", value };
}

const USAGE = `nen release preflight --repo-slug <owner/name> --tag <vX.Y.Z> --range <vPrev>..<cut-point> --changelog <path> --owner-repo <owner/name> [--hold-var <name>] [--critical-issues <n,n>] [--live-chores-from <path>] [--fragment-dir <dir>]

Every precondition of the release preflight table, checked and reported
whole -- never the first failure (getsuga SKILL.md §2).

  --hold-var <name>         'gh variable get <name>' at --repo-slug. Defaults
                            to RELEASE_HOLD. A gh that cannot be reached
                            (missing, unauthenticated, no variable-read scope)
                            fails this check rather than reading as "not set".
  --critical-issues <n,n>   Open critical-severity issue numbers, gathered by
                            the caller (this repository's own severity label
                            is not this binary's to know). REQUIRED to pass
                            this row -- omitting the flag reports "not
                            supplied -- not checked" and fails the table; pass
                            --critical-issues '' to assert there are none.
  --live-chores-from <path> A JSON array of { name, issueOpen,
                            integrationBranchExists,
                            openPrTargetsIntegrationOrMain } -- the CON-36
                            three-part test's inputs, per chore, gathered by
                            the caller. REQUIRED to pass this row -- omitting
                            it reports "not supplied -- not checked"; point it
                            at a file containing '[]' to assert none are live.
  --fragment-dir <dir>      Defaults to changelog.d.
  --range, --changelog, --owner-repo  Same contract as
                            'nen changelog completeness'.
  --tag <vX.Y.Z>            Checked against 'git ls-remote --tags origin'.`;

const DEFAULT_HOLD_VAR = "RELEASE_HOLD";
const DEFAULT_FRAGMENT_DIR = "changelog.d";

export const releaseCommand: Command = {
  name: "release",
  summary: "Run the whole release preflight table, never stopping at the first failure.",
  usage: USAGE,
  flags: {
    values: [
      "repo-slug",
      "tag",
      "range",
      "changelog",
      "owner-repo",
      "hold-var",
      "critical-issues",
      "live-chores-from",
      "fragment-dir",
    ],
  },
  run(context: CommandContext): number {
    requireSubcommand("release", context.args, ["preflight"]);

    const repoSlug = requireValue(context.args, "repo-slug", "The owner/name to check RELEASE_HOLD and the tag against.");
    const tag = requireValue(context.args, "tag", "The tag being proposed for this cut.");
    const range = requireValue(context.args, "range", "The <vPrev>..<cut-point> range CON-33(c) reconciles.");
    const changelogPath = requireValue(context.args, "changelog", "The CHANGELOG.md at the cut point.");
    const ownerRepo = requireValue(context.args, "owner-repo", "Scopes changelog link matching to this repository.");
    const holdVar = context.args.values["hold-var"] ?? DEFAULT_HOLD_VAR;
    const fragmentDir = context.args.values["fragment-dir"] ?? DEFAULT_FRAGMENT_DIR;
    // `undefined` (the flag was never given) and `""` (the caller explicitly
    // asserted "none") are DIFFERENT inputs (review finding): omitting
    // --critical-issues must not read the same as passing --critical-issues
    // '' to say there are none.
    const criticalIssuesRaw = context.args.values["critical-issues"];
    const criticalIssues =
      criticalIssuesRaw === undefined
        ? null
        : splitIntegerList(splitList(criticalIssuesRaw), "critical-issues");

    const root = resolveRepoRoot({ repoFlag: context.repoFlag });

    const holdResult = context.seams.run(GH, ["variable", "get", holdVar, "--repo", repoSlug]);
    const hold = resolveHoldState(holdResult, holdVar);

    const liveChoresPath = context.args.values["live-chores-from"];
    const liveChores: LiveChoreCandidate[] | null =
      liveChoresPath === undefined ? null : readJsonFile(liveChoresPath, root);

    const fragmentDirFull = isAbsolute(fragmentDir) ? fragmentDir : resolvePath(root, fragmentDir);
    const fragmentFiles = existsSync(fragmentDirFull)
      ? readdirSync(fragmentDirFull).filter((name): boolean => name.endsWith(".md"))
      : [];

    const changelog = readTextFile(changelogPath, root);
    const mergeLog = must(context.seams, GIT, ["log", range, "--merges", "--format=%s"], { cwd: root });
    const mergedPrNumbers = extractMergedPrNumbers(outputLines(mergeLog.stdout));
    const changelogRefs = extractChangelogRefs(changelog, ownerRepo);
    const fragmentRefs = extractFragmentRefs(fragmentFiles);
    const referenced = new Set([...changelogRefs, ...fragmentRefs]);
    const missingChangelogPrs = mergedPrNumbers.filter((n): boolean => !referenced.has(n));

    const tagsResult = must(context.seams, GIT, ["ls-remote", "--tags", "origin"], { cwd: root });
    const tagAlreadyExists = outputLines(tagsResult.stdout).some((line): boolean => line.endsWith(`refs/tags/${tag}`));

    const report = runPreflight({
      hold,
      openCriticalIssueNumbers: criticalIssues,
      liveChores,
      fragmentFilesAtCutPoint: fragmentFiles,
      missingChangelogPrs,
      tagAlreadyExists,
      tag,
    });

    const lines = report.checks.map((check): string => `${check.ok ? "ok  " : "FAIL"}  ${check.name} -- ${check.detail}`);
    emit(context.io, context.json, report, lines);
    return report.ok ? 0 : 1;
  },
};
