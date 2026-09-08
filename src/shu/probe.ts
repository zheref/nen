// src/shu/probe.ts -- the HOST side of `nen shu tools`: run a declared version
// probe, and run an install plan, both through the one subprocess seam.
//
// ZERO TOOLCHAIN NAMES, ENFORCED (./purity.test.ts). Everything spawned here
// arrives as data: a probe argv comes out of the target repository's own
// `nen/contract.json`, and an install argv comes out of ./install.ts, which
// built it from that same declaration. This module knows only how to start
// something and how to read what came back.
//
// IT NEVER READS THE PROFILES PACK, AND IT NEVER IMPORTS THE MODULE THAT DOES.
// That is the split decision (e2) demands and ../profiles/inertness.test.ts
// computes: the catalogue may say what nen was TESTED against, and may never
// contribute a version, a URL or an argument to a command nen runs. The two
// halves of this verb are therefore two modules -- ./tools.ts reads the
// catalogue and spawns nothing; this file spawns and cannot see the catalogue
// -- and ./command.ts joins them by passing STRINGS from one into a report,
// never into an argv.
//
// A PROBE IS NOT CERTIFIED READ-ONLY BY NEN. The argv comes from the target's
// declaration, so this file makes no claim about what it does; that is why the
// bare form of this verb classifies `unknown` in ../parse/izanami.ts rather
// than read-only, and why `--dry-run` -- which runs NOTHING, not even a probe
// -- is the form a watcher may use.

import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { VersionFrom } from "../schema/contract.js";
import type { Seams } from "../seam/exec.js";
import type { InstallOutcome, InstallStepReport } from "./install.js";
import type { RenderedStep } from "./render.js";
import { extractVersion, firstLine, type Observation } from "./toolchain.js";

/** "Is something there?" -- ./run.ts's rule, for ./run.ts's reasons. */
function entryExists(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    // An EACCES on a parent directory is not an absence: the entry is there and
    // this process cannot see it, and reporting that as "not installed" would
    // send a developer to install something they already have.
    return true;
  }
}

/**
 * Run one declared probe and say what the host answered.
 *
 * THE EXIT CODE IS NOT THE VERDICT for the three members that read a version:
 * a tool that printed its version and exited non-zero is present, and the
 * version it printed is the observation. Only a failure to START it -- the
 * seam's own `spawnFailed`, which ../seam/exec.ts keeps apart from "the tool
 * ran and said no" precisely so callers here do not have to guess -- means
 * missing.
 *
 * FOR `path-exists` THE EXIT CODE IS PART OF THE ANSWER, because that member
 * has no version to stand as evidence: the probe must have started, succeeded,
 * and named a path that is actually there.
 */
export function probeTool(
  seams: Seams,
  step: RenderedStep,
  cwd: string,
  versionFrom: VersionFrom,
): Observation {
  const result = seams.run(step.exe, step.argv, { cwd });
  if (result.spawnFailed) {
    return {
      kind: "missing",
      why: `the probe could not be started at all -- '${step.exe}' is not on this PATH`,
    };
  }
  if (versionFrom === "path-exists") {
    if (result.code !== 0) {
      return { kind: "missing", why: `the probe exited ${result.code} and named no path` };
    }
    const named = firstLine(result.stdout);
    if (named === null) {
      return { kind: "missing", why: "the probe succeeded and printed no path" };
    }
    const path = isAbsolute(named) ? named : resolve(cwd, named);
    return entryExists(path)
      ? { kind: "present", version: null, output: named }
      : { kind: "missing", why: "the path the probe named is not there" };
  }
  // WHAT THE PROBE PRINTED, CARRIED BACK RATHER THAN DROPPED. When no member
  // could read a version out of it, this line is the finding -- the row says
  // "present, version unknown", and a reader who cannot see the line has no way
  // to tell a wrapper's banner from a permission error.
  //
  // THE DECLARED STREAM FIRST, THE OTHER AS A FALLBACK: "the declaration named
  // the wrong stream" is one of the two things this line diagnoses, and quoting
  // only the empty stream it named would diagnose neither.
  const declared = versionFrom === "first-semver-on-stderr" ? result.stderr : result.stdout;
  const other = versionFrom === "first-semver-on-stderr" ? result.stdout : result.stderr;
  return {
    kind: "present",
    version: extractVersion(versionFrom, result.stdout, result.stderr),
    output: firstLine(declared) ?? firstLine(other),
  };
}

/**
 * Run an install plan, in order, stopping at the first step that does not
 * succeed.
 *
 * NOTHING AFTER A FAILED STEP RUNS. The two steps of the one enabled installer
 * are a sequence, not a set: the second one activates what the first one turned
 * on, and running it anyway would produce a second, more confusing error about
 * a state the first step was supposed to establish.
 */
export function runInstallSteps(
  seams: Seams,
  steps: readonly RenderedStep[],
  cwd: string,
): InstallOutcome {
  const reports: InstallStepReport[] = [];
  for (const step of steps) {
    const started = seams.now().getTime();
    const result = seams.run(step.exe, step.argv, { cwd });
    const durationMs = seams.now().getTime() - started;
    if (result.spawnFailed) {
      // `code` is meaningless on a spawn failure and `durationMs` measured
      // nothing, so both are null -- this report's one rule for "nothing ran".
      reports.push({ exe: step.exe, argv: step.argv, exitCode: null, durationMs: null });
      return {
        steps: reports,
        ok: false,
        failure: `'${step.exe}' could not be started at all. nen installs only through an installer the declaration names, and this host does not carry it.`,
      };
    }
    reports.push({ exe: step.exe, argv: step.argv, exitCode: result.code, durationMs });
    if (result.code !== 0) {
      return {
        steps: reports,
        ok: false,
        failure: `the installer exited ${result.code}. Nothing after this step was run.`,
      };
    }
  }
  return { steps: reports, ok: true, failure: null };
}
