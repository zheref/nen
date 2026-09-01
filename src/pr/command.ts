// src/pr/command.ts -- `nen pr staleness` and `nen pr body-check`.
//
// `nen pr ready` (the CON-32 readiness verdict) is deliberately ABSENT: it
// belongs to the sibling zheref/nen#2 branch, which is where
// ../gates/predicates.ts's parameterized predicates land as a verb. This
// family's own row in the issue's table cites it only so the group reads
// whole.

import {
  emit,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { readJsonFile, readTextFile } from "../cli/inputs.js";
import { resolveRepoRoot } from "../repo/root.js";
import { checkBody, type BodyRequirement } from "./bodycheck.js";
import { computeStaleness, type VerifiedWake } from "./staleness.js";

const USAGE = `nen pr staleness --wakes-from <path> --last-activity <ISO> --now <ISO> [--ready] [--min-verified-wakes <n>] [--idle-minutes <n>]
nen pr body-check --body-from <path> --requirements-from <path>

staleness:
  A pull request is STALE at >=2 verified no-commit wakes AND >=60 minutes
  idle (both defaults, overridable). Stale + Ready is the one case a merge is
  permitted without a human.
  --wakes-from <path>   A JSON array of { at, noCommit }.

body-check:
  Every requirement is checked; never stops at the first miss.
  --requirements-from <path>  A JSON array of { name, pattern } -- this
                              repository's own template convention, never a
                              literal shipped here.`;

/**
 * `--<flag> <ISO-8601>`, refused by name AND VALUE when it does not parse
 * (review finding). Left unrefused, an unparseable instant survived as
 * `Date.parse` NaN, through `Math.max(0, NaN)`, into "NaN/60 idle minute(s)"
 * on the human line and `"idleMinutes": null` in --json, at exit 0 -- a
 * machine consumer of --json cannot distinguish "computed zero-ish idle time"
 * from "could not parse the timestamp at all", and neither can a human
 * reading a bare `null`.
 */
function requireIsoInstant(context: CommandContext, flag: string, why: string): string {
  const value = requireValue(context.args, flag, why);
  if (Number.isNaN(Date.parse(value))) {
    throw new VerbUsageError(`--${flag} '${value}' is not a parseable ISO-8601 instant. ${why}`);
  }
  return value;
}

// EVERY WAKE ELEMENT IS VALIDATED, NOT TRUTHINESS-TESTED (review finding).
// `wake.noCommit` read straight off unvalidated JSON would let the STRING
// "false" -- truthy in JavaScript -- count toward the threshold that
// authorizes the one merge a non-human actor may make. Each element must be
// an object with a string `at` and a BOOLEAN `noCommit`, or this refuses by
// index rather than silently coercing.
function validateWakes(raw: unknown, path: string): VerifiedWake[] {
  if (!Array.isArray(raw)) {
    throw new VerbUsageError(`'${path}' must be a JSON array of { at, noCommit }.`);
  }
  return raw.map((item, index): VerifiedWake => {
    if (typeof item !== "object" || item === null) {
      throw new VerbUsageError(`'${path}': element ${index} is not an object.`);
    }
    const at = (item as Record<string, unknown>)["at"];
    const noCommit = (item as Record<string, unknown>)["noCommit"];
    if (typeof at !== "string") {
      throw new VerbUsageError(`'${path}': element ${index} has no string 'at'.`);
    }
    if (typeof noCommit !== "boolean") {
      throw new VerbUsageError(
        `'${path}': element ${index} has 'noCommit' of type ${typeof noCommit}, not a boolean -- a truthy non-boolean (e.g. the string "false") must never count toward the merge-permitting threshold.`,
      );
    }
    return { at, noCommit };
  });
}

function staleness(context: CommandContext): number {
  const wakesPath = requireValue(context.args, "wakes-from", "The verified-wake history to reason over.");
  const lastActivity = requireIsoInstant(context, "last-activity", "The pull request's last-activity instant.");
  const now = requireIsoInstant(context, "now", "Read once, never the live clock -- so a replay is reproducible.");
  const ready = context.args.booleans.has("ready");
  const minVerifiedWakes = context.args.values["min-verified-wakes"];
  const idleMinutes = context.args.values["idle-minutes"];
  if (minVerifiedWakes !== undefined && !/^\d+$/.test(minVerifiedWakes)) {
    throw new VerbUsageError(`--min-verified-wakes takes a whole number, got '${minVerifiedWakes}'.`);
  }
  if (idleMinutes !== undefined && !/^\d+$/.test(idleMinutes)) {
    throw new VerbUsageError(`--idle-minutes takes a whole number, got '${idleMinutes}'.`);
  }

  const cwd = resolveRepoRoot({ repoFlag: context.repoFlag });
  const wakes = validateWakes(readJsonFile<unknown>(wakesPath, cwd), wakesPath);

  const result = computeStaleness({
    wakes,
    lastActivityAt: lastActivity,
    now,
    ready,
    ...(minVerifiedWakes === undefined ? {} : { minVerifiedWakes: Number.parseInt(minVerifiedWakes, 10) }),
    ...(idleMinutes === undefined ? {} : { idleMinutes: Number.parseInt(idleMinutes, 10) }),
  });

  const lines = [
    result.stale ? "stale" : "not stale",
    result.mergePermitted ? "merge PERMITTED (stale + Ready)" : "merge not permitted",
    ...result.reasons,
  ];
  emit(context.io, context.json, result, lines);
  return 0;
}

function bodyCheck(context: CommandContext): number {
  const bodyPath = requireValue(context.args, "body-from", "The pull-request body to check.");
  const requirementsPath = requireValue(context.args, "requirements-from", "This repository's own template requirements.");

  const cwd = resolveRepoRoot({ repoFlag: context.repoFlag });
  const body = readTextFile(bodyPath, cwd);
  const requirements = readJsonFile<readonly BodyRequirement[]>(requirementsPath, cwd);

  const report = checkBody(body, requirements);
  const satisfiedCount = report.results.filter((result): boolean => result.satisfied).length;
  // A VERDICT LINE ALWAYS PRINTS (review finding): zero output must never be a
  // passing result a caller's script can mistake for "nothing to report".
  const lines = [
    `${satisfiedCount}/${report.results.length} requirement(s) satisfied`,
    ...report.results.map((result): string => `${result.satisfied ? "ok" : "MISSING"}  ${result.name}`),
  ];
  emit(context.io, context.json, report, lines);
  return report.ok ? 0 : 1;
}

export const prCommand: Command = {
  name: "pr",
  summary: "PR staleness arithmetic, and PR-body requirement checks.",
  usage: USAGE,
  flags: {
    values: [
      "wakes-from",
      "last-activity",
      "now",
      "min-verified-wakes",
      "idle-minutes",
      "body-from",
      "requirements-from",
    ],
    booleans: ["ready"],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("pr", context.args, ["staleness", "body-check"]);
    return subcommand === "staleness" ? staleness(context) : bodyCheck(context);
  },
};
