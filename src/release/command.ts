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
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { readJsonFile, readTextFile, splitList } from "../cli/inputs.js";
import { extractChangelogRefs, extractFragmentRefs, extractMergedPrNumbers } from "../changelog/completeness.js";
import { assertRepoRoot, resolveRepoRoot } from "../repo/root.js";
import { GH, GIT, must, outputLines, type CommandResult } from "../seam/exec.js";
import { runPreflight, type HoldState, type LiveChoreCandidate } from "./preflight.js";
import { resolveReleaseTarget, ResolveTargetError } from "./target.js";
import { checkSelfEnumeration, SelfCheckError } from "./selfcheck.js";

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

/**
 * The hold value is PARSED for truthiness, never merely length-checked
 * (zheref/nen#23). The shell `hold_active()` this row replaced read only
 * case-insensitive `true`/`1`/`yes` as an active hold and EVERYTHING else --
 * unset or `"false"` alike -- as inactive; the port's `value === ""` check
 * inverted that for the falsy half of the vocabulary, so a variable someone
 * set to `"false"` (instead of deleting) read as permanently HELD, and
 * setting it to `"false"` again did nothing. Only these two vocabularies are
 * recognized; matching is against the trimmed, lowercased value.
 */
const HOLD_TRUTHY = new Set(["true", "1", "yes"]);
const HOLD_FALSY = new Set(["false", "0", "no"]);

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
  if (value === "") return { kind: "unset" };
  const lowered = value.toLowerCase();
  // An explicit falsy value releases the hold -- but as `clear`, not `unset`,
  // so the row can still tell the operator the variable is lingering and that
  // deleting it outright is the tidier repository state.
  if (HOLD_FALSY.has(lowered)) return { kind: "clear", value };
  // A DELIBERATE deviation from the pure shell convention (zheref/nen#23):
  // `hold_active()` read any value outside `true`/`1`/`yes` as inactive,
  // which means a hold set to the message that explains it -- `gh variable
  // set RELEASE_HOLD -b 'freeze until Monday'` -- would silently release
  // itself. An operator who typed a hold message intended a hold, and the
  // one row whose whole job is to stop a release must not fail open on a
  // spelling. So only the explicit falsy vocabulary above releases; every
  // other non-empty value stays HELD, with `recognizedTruthy` recording
  // whether it was the shared boolean vocabulary or a fail-closed arbitrary
  // string so the report can print WHY (../release/preflight.ts renders the
  // difference).
  return { kind: "held", value, recognizedTruthy: HOLD_TRUTHY.has(lowered) };
}

const USAGE = `nen release preflight --repo-slug <owner/name> --tag <vX.Y.Z> --range <vPrev>..<cut-point> --changelog <path> --owner-repo <owner/name> [--hold-var <name>] [--critical-issues <n,n>] [--live-chores-from <path>] [--fragment-dir <dir>]
nen release resolve-target --repo <path> --token <main|last-commit|checkout|hash|branch> [--trunk main]
nen release self-check --repo <path> --pr-merge-sha <sha> --previous-tag <ref> --cut-point <ref>

preflight:
  Every precondition of the release preflight table, checked and reported
  whole -- never the first failure (getsuga SKILL.md §2).

  --hold-var <name>         'gh variable get <name>' at --repo-slug. Defaults
                            to RELEASE_HOLD. Case-insensitive false/0/no (or
                            an unset variable) reads as not held; any other
                            non-empty value -- true/1/yes, or an arbitrary
                            hold message -- fails closed as an active hold.
                            A gh that cannot be reached (missing,
                            unauthenticated, no variable-read scope) fails
                            this check rather than reading as "not set".
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
  --tag <vX.Y.Z>            Checked against 'git ls-remote --tags origin'.

resolve-target:
  getsuga §1: resolves the token to a SHA (re-fetching origin/--trunk
  first) and tests 'git merge-base --is-ancestor <sha> origin/<trunk>' --
  the load-bearing check that a tag is only ever cut on the trunk. A dirty
  'checkout' is refused outright: uncommitted work is not in any commit.
  Exits 1 when the resolved commit is not yet an ancestor.

self-check:
  getsuga §3: whether a release PR should list itself -- true iff its own
  merge commit is reachable from --cut-point and not already reachable
  from --previous-tag. A git-mechanical fact, never a judgement.`;

const DEFAULT_HOLD_VAR = "RELEASE_HOLD";
const DEFAULT_FRAGMENT_DIR = "changelog.d";

export const releaseCommand: Command = {
  name: "release",
  summary: "Preflight table, target resolution, and a release PR's self-enumeration check.",
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
      "token",
      "trunk",
      "pr-merge-sha",
      "previous-tag",
      "cut-point",
    ],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("release", context.args, ["preflight", "resolve-target", "self-check"]);
    if (subcommand === "resolve-target") return resolveTarget(context);
    if (subcommand === "self-check") return selfCheck(context);

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

function resolveTarget(context: CommandContext): number {
  const token = context.args.values["token"];
  if (token === undefined) throw new VerbUsageError("--token <main|last-commit|checkout|hash|branch> is required.");
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  let result;
  try {
    result = resolveReleaseTarget(context.seams, root, token, context.args.values["trunk"] ?? "main");
  } catch (error) {
    if (error instanceof ResolveTargetError) {
      context.io.err(`nen: ${error.message}`);
      return 1;
    }
    throw error;
  }
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.isAncestorOfTrunk ? 0 : 1;
  }
  context.io.out(`${result.token} -> ${result.sha}`);
  context.io.out(
    result.isAncestorOfTrunk
      ? "an ancestor of the trunk -- safe to cut"
      : "NOT an ancestor of the trunk -- it has to reach the trunk first before it can be tagged",
  );
  return result.isAncestorOfTrunk ? 0 : 1;
}

function selfCheck(context: CommandContext): number {
  const prMergeSha = context.args.values["pr-merge-sha"];
  const previousTag = context.args.values["previous-tag"];
  const cutPoint = context.args.values["cut-point"];
  if (prMergeSha === undefined || previousTag === undefined || cutPoint === undefined) {
    throw new VerbUsageError("release self-check takes --pr-merge-sha, --previous-tag and --cut-point.");
  }
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  let result;
  try {
    result = checkSelfEnumeration(context.seams, root, prMergeSha, previousTag, cutPoint);
  } catch (error) {
    if (error instanceof SelfCheckError) {
      context.io.err(`nen: ${error.message}`);
      return 1;
    }
    throw error;
  }
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return 0;
  }
  context.io.out(
    result.shouldListItself
      ? `#${result.prMergeSha} should list ITSELF -- it falls inside <${result.previousTag}>..<${result.cutPoint}>`
      : `#${result.prMergeSha} should NOT list itself -- it is outside <${result.previousTag}>..<${result.cutPoint}>`,
  );
  return 0;
}
