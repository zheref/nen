// src/shu/tools.ts -- the REPORT side of `nen shu tools`: what the declaration
// requires, what the catalogue was tested against, and how the two read as one
// table. It spawns nothing, and it is the only module of this verb that may
// read the profiles pack.
//
// THIS IS THE ONE NARROWING OF DECISION (e2), AND IT IS WHY THIS VERB IS TWO
// MODULES. The pack is a catalogue, not an authority: nothing that spawns a
// process may read it, so that "the pack never contributes a version, a URL or
// an argument to a command nen runs" is a property of the program rather than a
// sentence in a header (../profiles/pack.ts, ../profiles/inertness.test.ts).
// This verb wants ONE thing from the catalogue -- an advisory `packMinimum`
// column, the version nen has been TESTED against -- and wants it beside a
// probe it ran. So:
//
//   * THIS module reads the pack. It imports no seam, imports ./probe.ts
//     never, and every value it takes from the pack is a STRING that lands in a
//     report column. There is no parameter on any function here through which a
//     pack value could reach an argv.
//   * ./probe.ts spawns. It cannot see the pack, and it cannot see this file.
//   * ./command.ts joins them, and imports no seam of its own -- exactly as it
//     already joins ./detect.ts (which reads the pack) with ./run.ts (which
//     spawns), which is the shape ../profiles/inertness.test.ts was written
//     around and holds green today.
//
// THE ADVISORY COLUMN NEVER MOVES THE EXIT CODE. A pin below the catalogue's
// tested minimum is a fact worth printing and never a failure: the pack is a
// catalogue, and a catalogue that failed a build would be an authority.
// ./tools.test.ts pins that from the mutation side -- a row whose packMinimum
// is far above everything still exits 0 when the declaration's own pin is met.
//
// NO TOOLCHAIN NAME LIVES HERE. ./purity.test.ts sweeps this file with the rest
// of the execution path; the one installer nen implements is named in
// ./install.ts alone, which that sweep excludes by name and then holds to
// naming exactly one.

import { VerbUsageError } from "../cli/command.js";
import { loadProfilesPack, profileById } from "../profiles/pack.js";
import type { Installer, ProjectBlock, RepositoryContract, VersionFrom } from "../schema/contract.js";
import { PROGRAM } from "../version.js";
import {
  isRunnable,
  readManifestPin,
  resolveInstall,
  type InstallOutcome,
  type InstallPlan,
} from "./install.js";
import { renderArgv, type RenderedStep } from "./render.js";
import {
  parseMinimum,
  parsePin,
  renderMinimum,
  renderPin,
  satisfiesMinimum,
  satisfiesPin,
  truncate,
  type Assessment,
  type ToolState,
} from "./toolchain.js";

/** `nen.shu.tools/v0.1` -- this verb's own versioned contract string. */
export const TOOLS_CONTRACT = "nen.shu.tools/v0.1";

/**
 * Which of the three things this invocation is doing.
 *
 * `dry-run` WINS OVER `install`, because it is the stronger statement: it says
 * nothing ran, and a caller reading `"install"` would reasonably believe
 * something did.
 */
export type ToolsMode = "check" | "install" | "dry-run";

/**
 * One row of the report.
 *
 * KEY ORDER IS PART OF THE CONTRACT and ./tools.test.ts pins it, so a field
 * inserted in the middle is a visible decision rather than a silent reshuffle
 * of somebody's golden file.
 *
 * `required` IS TRUE ON EVERY ROW IN THIS RELEASE, and the field is here rather
 * than omitted because the schema has no optionality to report yet: every
 * `project.toolchain` entry is a tool the repository says it needs, and the
 * `dependency` block is what it needs FROM nen. A future optional entry then
 * changes a value rather than the shape.
 *
 * `found` IS NEVER A PROBE'S WHOLE OUTPUT. It is the version that was read, or
 * null; the only member that can put arbitrary text here is `whole-line-stdout`
 * -- which is the declaration asking for exactly that -- and it is capped.
 *
 * `installCommand` IS NON-NULL ONLY FOR AN INSTALLER NEN RUNS in this release,
 * and only when there is something to do: a row that already passes has no way
 * out to print, and a `verify-only` row has no command to print at all -- its
 * way out is prose, built from `installer` and `why`, which is what the text
 * rendering shows and what a machine reader can rebuild.
 */
export interface ToolRow {
  readonly name: string;
  readonly required: boolean;
  readonly packMinimum: string | null;
  readonly found: string | null;
  /** `null` only when nothing was observed -- a dry run. */
  readonly satisfied: boolean | null;
  readonly state: ToolState;
  readonly installer: Installer;
  /** The exact commands, in order, each rendered as one line. */
  readonly installCommand: readonly string[] | null;
  /** The declaration's own reason for the pin. Never nen's. */
  readonly why: string | null;
}

/** The one value both renderings come from (../cli/command.ts's `emit`). */
export interface ToolsReport {
  readonly contract: string;
  /** `null` when the declaration has no default lane and none was named. */
  readonly lane: string | null;
  readonly stack: string | null;
  readonly mode: ToolsMode;
  readonly tools: readonly ToolRow[];
  readonly exitCode: number;
}

/**
 * Everything about one tool BEFORE the host was looked at.
 *
 * `satisfiedBy` IS A CLOSURE so the two kinds of requirement in a contract --
 * a `project.toolchain` pin and the `dependency` block's `MAJOR.MINOR` floor
 * with its zero-major caveat -- can share every other part of a row without
 * either rule leaking into the other's comparison.
 */
export interface ToolPlan {
  readonly name: string;
  readonly required: boolean;
  readonly probe: RenderedStep;
  readonly versionFrom: VersionFrom;
  readonly installer: Installer;
  /** How the requirement reads to a human. */
  readonly pinned: string;
  readonly satisfiedBy: (found: string) => boolean;
  readonly install: InstallPlan;
  readonly why: string | null;
}

/** One plan, once the host has (or has not) been looked at. */
export interface AssessedTool {
  readonly plan: ToolPlan;
  readonly assessment: Assessment;
  readonly packMinimum: string | null;
  /** What `--install` actually ran for this row, or null when it ran nothing. */
  readonly install: InstallOutcome | null;
}

/**
 * The version nen has been TESTED against, per tool, for one stack.
 *
 * A STACK THE PACK DOES NOT CARRY IS AN EMPTY COLUMN, NOT A REFUSAL. A
 * declaration may name any stack id it likes -- the id is the repository's
 * word, and `project.lanes.<lane>.stack` is not validated against the
 * catalogue anywhere else either. Refusing here would make an advisory column
 * able to stop a check, which is precisely the authority the pack must not
 * have.
 */
export function packMinimums(stack: string | null): Readonly<Record<string, string | null>> {
  if (stack === null) return {};
  const pack = loadProfilesPack();
  if (!pack.ids.includes(stack)) return {};
  const profile = profileById(pack, stack);
  const minimums: Record<string, string | null> = {};
  for (const [tool, entry] of Object.entries(profile.toolchain)) minimums[tool] = entry.minimum;
  return minimums;
}

/**
 * Every row this invocation is about, in the order a reader wants them.
 *
 * THE `nen` ROW COMES FIRST, and it comes from the `dependency` block rather
 * than from `project.toolchain`: nen is itself a required tool of a nen-using
 * project, and the block that states which version is the one the repository
 * already writes for its own warm-up. It is `verify-only` by construction --
 * re-pinning nen is the bootstrap's job and the consuming repository's
 * decision, never this verb's.
 *
 * A `project.toolchain` ENTRY OF THE SAME NAME WINS, and the dependency row is
 * then not synthesised: an explicit entry is the repository saying it wants
 * this tool checked its own way, and two rows with one name would be a report
 * that contradicts itself.
 *
 * "THE SAME NAME" IS THE NAME THIS ROW WOULD ACTUALLY CARRY, read once into
 * `dependencyName` and used for both the collision test and the row. The block
 * may rename itself (`dependency.name`), and testing one name while naming the
 * row another produced two failures in one line: `dependency.name: "foo"` beside
 * a `toolchain.foo` entry emitted TWO rows called foo (and `--only foo` returned
 * both), while `dependency.name: "nenx"` beside a `toolchain.nen` entry
 * suppressed the nenx row entirely -- so the version the dependency block exists
 * to check was never checked, silently, which is the failure mode this whole
 * verb is written against.
 */
export function buildPlans(
  contract: RepositoryContract,
  project: ProjectBlock,
  laneDirectory: string,
): readonly ToolPlan[] {
  const plans: ToolPlan[] = [];
  const dependency = contract.dependency;
  const declared = project.toolchain;
  const dependencyName = dependency?.name ?? PROGRAM;
  if (dependency !== null && !Object.prototype.hasOwnProperty.call(declared, dependencyName)) {
    const floor = parseMinimum(dependency.minimum, "dependency.minimum");
    plans.push({
      name: dependencyName,
      required: true,
      probe: {
        exe: dependency.versionProbe[0] ?? dependencyName,
        argv: dependency.versionProbe.slice(1),
      },
      // The block states the shape of its own answer -- a bare version on
      // stdout -- rather than carrying a `versionFrom` field, so this is the
      // member that reads it, not a default nen fell back to.
      versionFrom: "first-semver-on-stdout",
      installer: "verify-only",
      pinned: renderMinimum(floor),
      satisfiedBy: (found): boolean => satisfiesMinimum(floor, found),
      install: {
        kind: "by-hand",
        why: `the bootstrap this repository pins installs ${dependency.pinnedRef}. Re-pinning ${dependencyName} is the bootstrap's job and this repository's decision; this verb reports the version and never changes it.`,
      },
      why: dependency.raw["minimum_semantics"] === undefined ? null : String(dependency.raw["minimum_semantics"]),
    });
  }

  // The manifest is read ONCE per invocation, not once per row: it is a fact
  // about the lane, and re-reading it per tool would let two rows of one report
  // disagree about what it says.
  const manifest = readManifestPin(laneDirectory);
  for (const entry of Object.values(declared)) {
    const pointer = `project.toolchain.${entry.tool}.version`;
    const pin = parsePin(entry.version, pointer);
    plans.push({
      name: entry.tool,
      required: true,
      probe: { exe: entry.probe[0] ?? "", argv: entry.probe.slice(1) },
      versionFrom: entry.versionFrom,
      installer: entry.installer,
      pinned: renderPin(pin),
      satisfiedBy: (found): boolean => satisfiesPin(pin, found),
      install: resolveInstall(entry, manifest),
      why: entry.why,
    });
  }
  return plans;
}

/**
 * Narrow the rows to the ones `--only` names, or refuse listing what there is.
 *
 * A NAME THE DECLARATION DOES NOT CARRY IS EXIT 2, not an empty report. `nen
 * shu tools --only pnmp` should say so rather than exit 0 having checked
 * nothing, which is the same class of silent success `--target` is refused for.
 */
export function narrowTo(
  plans: readonly ToolPlan[],
  only: readonly string[],
): readonly ToolPlan[] {
  if (only.length === 0) return plans;
  const declared = plans.map((plan): string => plan.name);
  const unknown = only.filter((name): boolean => !declared.includes(name));
  if (unknown.length > 0) {
    throw new VerbUsageError(
      `--only names ${unknown.map((name): string => `'${name}'`).join(", ")}, which this repository does not declare. It declares: ${declared.length === 0 ? "(no tools at all)" : declared.join(", ")}.`,
    );
  }
  return plans.filter((plan): boolean => only.includes(plan.name));
}

/** The rows `--install` would act on: not satisfied, and nen runs the installer. */
export function actionable(assessed: readonly AssessedTool[]): readonly AssessedTool[] {
  return assessed.filter(
    (entry): boolean => entry.assessment.satisfied !== true && isRunnable(entry.plan.install),
  );
}

/**
 * The rows `--install` was asked to act on and cannot build a command for.
 *
 * SEPARATE FROM `actionable` AND CHECKED BEFORE ANYTHING RUNS, so a declaration
 * whose pin nen will not act on stops the whole install rather than half of it.
 * A row that already PASSES is not here: there is nothing to install, so its
 * unusable pin is a finding to print, not a reason to refuse a run that would
 * have touched nothing.
 */
export function refusedInstalls(assessed: readonly AssessedTool[]): readonly AssessedTool[] {
  return assessed.filter(
    (entry): boolean => entry.assessment.satisfied !== true && entry.plan.install.kind === "refused",
  );
}

/**
 * nen's own exit code for this report.
 *
 * A CHECK IS 5 THE MOMENT ANYTHING IS MISSING OR WRONG -- the code v3 reserved
 * for "tool not installed", never 1: a missing tool is not a failed build, and
 * a caller that retried a 1 would retry forever on a machine that is simply not
 * set up.
 *
 * `--install` IS 0 WHEN EVERYTHING NEN COULD INSTALL NOW PASSES, even when
 * tools nen may never install are still absent. The alternative -- exiting 5
 * because a 10-gigabyte vendor IDE is not there -- makes the install form
 * permanently red on a machine nen can never fix, and a red that can never go
 * green is a red nobody reads. The caller who wants "is this host ready" asks
 * the CHECK, which is the whole reason exit 5 exists. The still-missing rows
 * stay in the report with their instructions either way.
 *
 * A DRY RUN IS 0 BECAUSE A RENDERING SUCCEEDED. It observed nothing, so it has
 * nothing to fail about; every row reads `not-probed`, which is what says so.
 */
export function toolsExitCode(assessed: readonly AssessedTool[], mode: ToolsMode): number {
  if (mode === "dry-run") return 0;
  if (mode === "install") {
    const acted = assessed.filter((entry): boolean => entry.install !== null);
    return acted.every((entry): boolean => entry.install?.ok === true && entry.assessment.satisfied === true)
      ? 0
      : 5;
  }
  return assessed.every((entry): boolean => entry.assessment.satisfied === true) ? 0 : 5;
}

/** Each plan's install command, rendered, or null when there is nothing to run. */
function installCommandOf(assessed: AssessedTool, mode: ToolsMode): readonly string[] | null {
  const plan = assessed.plan.install;
  if (!isRunnable(plan)) return null;
  // A row that already passes has no way out to print. A dry run has not looked
  // at the host at all, so every runnable command is printed -- which is what
  // "--dry-run prints every command it would run" has to mean when nothing was
  // observed to narrow the list.
  if (mode !== "dry-run" && assessed.assessment.satisfied === true) return null;
  return plan.steps.map(renderArgv);
}

/** The report, in the one key order this contract publishes. */
export function assembleToolsReport(
  assessed: readonly AssessedTool[],
  lane: string | null,
  stack: string | null,
  mode: ToolsMode,
  exitCode: number,
): ToolsReport {
  return {
    contract: TOOLS_CONTRACT,
    lane,
    stack,
    mode,
    tools: assessed.map((entry): ToolRow => ({
      name: entry.plan.name,
      required: entry.plan.required,
      packMinimum: entry.packMinimum,
      found: entry.assessment.found === null ? null : truncate(entry.assessment.found),
      satisfied: entry.assessment.satisfied,
      state: entry.assessment.state,
      installer: entry.plan.installer,
      installCommand: installCommandOf(entry, mode),
      why: entry.plan.why,
    })),
    exitCode,
  };
}

// ── the human rendering ─────────────────────────────────────────────────────

const MARKS: Readonly<Record<ToolState, string>> = {
  "present-and-matching": "ok",
  "present-but-wrong-version": "WRONG",
  missing: "MISSING",
  "not-probed": "?",
};

/** Wide enough for the longest mark plus one clear space after it. */
const MARK_WIDTH = 9;
const LABEL_WIDTH = 15;

function labelled(label: string, value: string): string {
  return `${`${label}:`.padEnd(LABEL_WIDTH)}${value}`;
}

/**
 * What the `found` column says.
 *
 * FOUR ANSWERS, AND THREE OF THEM ARE NOT A VERSION. A probe that ran and
 * whose output no member could read a version out of is PRESENT and unknown --
 * not missing, and not fine -- and saying so is the difference between "install
 * this" and "look at what this printed". The `path-exists` member has no
 * version to report by construction, and a dry run looked at nothing.
 */
function foundColumn(assessed: AssessedTool): string {
  const { found, state } = assessed.assessment;
  if (found !== null) return found;
  if (state === "present-and-matching") return "present";
  if (state === "present-but-wrong-version") return "unknown";
  return "--";
}

function pinnedColumn(plan: ToolPlan): string {
  return plan.versionFrom === "path-exists"
    ? `pinned ${plan.pinned} (presence only)`
    : `pinned ${plan.pinned}`;
}

/**
 * The way out of one row that does not pass, in the declaration's own terms.
 *
 * EVERY ARM NAMES A HUMAN ACTION. A row that nen can fix prints the exact
 * commands; a row nen will not fix prints why and what to do instead. The one
 * thing no arm does is stay silent: a tool a repository believes nen manages,
 * which nen quietly skips, is the failure this whole verb is written against.
 */
function wayOut(assessed: AssessedTool, mode: ToolsMode, indent: string): readonly string[] {
  const plan = assessed.plan.install;
  const lines: string[] = [];
  const verb = mode === "dry-run" ? "would install" : "install";
  if (plan.kind === "runnable") {
    const commands = plan.steps.map(renderArgv);
    const head = `${indent}${verb}: `;
    commands.forEach((command, index): void => {
      lines.push(index === 0 ? `${head}${command}` : `${" ".repeat(head.length)}${command}`);
    });
    return lines;
  }
  if (plan.kind === "refused") {
    lines.push(`${indent}${assessed.plan.installer}: REFUSED -- ${plan.why}`);
    return lines;
  }
  if (plan.kind === "not-enabled") {
    lines.push(`${indent}${assessed.plan.installer}: not enabled in this release -- ${plan.why}`);
    return lines;
  }
  if (plan.kind === "nothing-to-install") {
    lines.push(`${indent}${assessed.plan.installer}: nothing to install -- ${plan.why}`);
    return lines;
  }
  lines.push(`${indent}${assessed.plan.installer}: install by hand -- ${plan.why}`);
  return lines;
}

/** The human rendering, derived from the same values `--json` prints. */
export function renderToolsReport(
  assessed: readonly AssessedTool[],
  lane: string | null,
  stack: string | null,
  mode: ToolsMode,
): readonly string[] {
  const lines: string[] = [];
  lines.push(
    labelled(
      "lane",
      lane === null
        ? "(none -- this declaration has no defaultLane, so no stack is named and no tested minimum is shown)"
        : `${lane}  (${stack ?? "no stack"})`,
    ),
  );
  lines.push(labelled("mode", mode));
  if (assessed.length === 0) {
    lines.push(labelled("tools", "(none declared)"));
    return lines;
  }
  const nameWidth = assessed.reduce((width, entry): number => Math.max(width, entry.plan.name.length), 4);
  const foundWidth = assessed.reduce((width, entry): number => Math.max(width, foundColumn(entry).length), 5);
  const pinWidth = assessed.reduce((width, entry): number => Math.max(width, pinnedColumn(entry.plan).length), 6);
  const indent = " ".repeat(2 + MARK_WIDTH + nameWidth + 2);
  for (const entry of assessed) {
    const pack = entry.packMinimum === null ? "" : `  (tested minimum ${entry.packMinimum})`;
    lines.push(
      `  ${MARKS[entry.assessment.state].padEnd(MARK_WIDTH)}${entry.plan.name.padEnd(nameWidth)}  ${foundColumn(entry).padEnd(foundWidth)}  ${pinnedColumn(entry.plan).padEnd(pinWidth)}${pack}`.trimEnd(),
    );
    if (mode === "dry-run") {
      lines.push(`${indent}would probe: ${renderArgv(entry.plan.probe)}`);
    }
    if (mode === "dry-run" || entry.assessment.satisfied !== true) {
      lines.push(...wayOut(entry, mode, indent));
    }
    if (entry.install !== null) {
      for (const step of entry.install.steps) {
        lines.push(
          `${indent}ran: ${renderArgv(step)}  -- ${step.exitCode === null ? "did not start" : `exit ${step.exitCode} in ${step.durationMs}ms`}`,
        );
      }
      if (entry.install.failure !== null) lines.push(`${indent}${entry.install.failure}`);
    }
  }
  return lines;
}

/**
 * The sentence a caller reads when the check did not pass, with the two lines
 * that fix it.
 *
 * IT NAMES `--dry-run` FIRST. Everything this verb can do to a host is one flag
 * away, and the flag that shows the commands without running them is the one a
 * reader should meet first.
 */
export function renderAdvice(
  assessed: readonly AssessedTool[],
  invocation: string,
): readonly string[] {
  const failing = assessed.filter((entry): boolean => entry.assessment.satisfied !== true);
  const fixable = failing.filter((entry): boolean => isRunnable(entry.plan.install));
  const head = `${failing.length} of ${assessed.length} declared tool${assessed.length === 1 ? " is" : "s are"} missing or not the pinned version.`;
  if (fixable.length === 0) {
    return [
      `${head} None of them has an installer nen runs in this release: each row above names what to do instead. nen never installs a toolchain on a repository's say-so.`,
    ];
  }
  return [
    `${head} nen can install ${fixable.length} of them (${fixable.map((entry): string => entry.plan.name).join(", ")}):`,
    `  ${invocation} --install --dry-run   # see the commands`,
    `  ${invocation} --install             # run them`,
  ];
}
