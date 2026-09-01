// src/cli/command.ts -- what a verb family IS, so that adding one is a single
// line in ./registry.ts rather than a new branch in the dispatcher.
//
// WHY THE REGISTRY SHAPE, AND WHY IT IS ONE LINE PER FAMILY. Two sessions add
// verbs to this CLI in parallel. A dispatcher that grows a `case` per SUBCOMMAND
// makes every family's arrival a conflicting edit to the same switch; a registry
// whose entries are one import and one array element per FAMILY makes the
// conflicting surface exactly one line, in a file whose merge resolution is
// obvious. The families are listed alphabetically for the same reason: a
// canonical order means two independent appends land in different places.
//
// EACH FAMILY OWNS ITS FLAGS. The alternative -- a single union of every flag
// every verb accepts -- reintroduces the failure ../cli/args.ts's strictness
// exists to prevent, one level up: `nen backlog fetch --max-runs-per-pr 3` would
// parse cleanly against another family's flag and be silently ignored. So the
// top-level parse stops at the first positional, and the family re-parses the
// rest against its OWN spec plus the global flags.

import type { Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import type { FlagSpec, ParsedArgs } from "./args.js";

export interface CommandContext {
  /** Positionals with the family name still at index 0, as the family declared it. */
  readonly args: ParsedArgs;
  /** `--repo <path>`, the TARGET repository's working tree, or null. */
  readonly repoFlag: string | null;
  readonly json: boolean;
  readonly io: Io;
  readonly seams: Seams;
}

export interface Command {
  /** The first positional that selects this family. */
  readonly name: string;
  /** One line for the top-level `--help` listing. */
  readonly summary: string;
  /** The family's own `--help` body. */
  readonly usage: string;
  /** Flags this family accepts, ON TOP of the global ones. */
  readonly flags: FlagSpec;
  /**
   * A `Promise<number>` is allowed because ONE subcommand of ONE family --
   * `nen pr ready` (../verbs/pr_ready.ts) -- reads GitHub over the network and
   * there is no synchronous way to do that. Every other family stays
   * synchronous under the hood (spawnSync, readFileSync); ../index.ts's
   * `runFamily` awaits either return the same way.
   */
  run(context: CommandContext): number | Promise<number>;
}

/** The global flags every family also accepts. */
export const GLOBAL_FLAGS: FlagSpec = {
  values: ["repo"],
  booleans: ["json", "help"],
  aliases: { h: "help" },
};

export function mergeFlags(spec: FlagSpec): FlagSpec {
  return {
    values: [...(GLOBAL_FLAGS.values ?? []), ...(spec.values ?? [])],
    booleans: [...(GLOBAL_FLAGS.booleans ?? []), ...(spec.booleans ?? [])],
    aliases: { ...(GLOBAL_FLAGS.aliases ?? {}), ...(spec.aliases ?? {}) },
  };
}

/**
 * A verb's own refusal: the invocation was understood and is wrong.
 *
 * Separate from ./args.ts's UsageError only in where it is raised -- both exit
 * 2, because "you typed it wrong" and "the thing you asked for did not work"
 * must stay distinguishable to a caller that retries.
 */
export class VerbUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerbUsageError";
  }
}

/** The subcommand a family was asked for, or a refusal naming the ones it has. */
export function requireSubcommand(
  family: string,
  args: ParsedArgs,
  known: readonly string[],
): string {
  const subcommand = args.positionals[1];
  if (subcommand === undefined) {
    throw new VerbUsageError(
      `'${family}' needs a subcommand. Try: ${known.map((name): string => `${family} ${name}`).join(", ")}.`,
    );
  }
  if (!known.includes(subcommand)) {
    throw new VerbUsageError(
      `unknown '${family}' subcommand '${subcommand}'. Known: ${known.join(", ")}.`,
    );
  }
  return subcommand;
}

/** A required `--flag <value>`, refused by name when absent. */
export function requireValue(args: ParsedArgs, flag: string, why: string): string {
  const value = args.values[flag];
  if (value === undefined || value === "") {
    throw new VerbUsageError(`--${flag} is required. ${why}`);
  }
  return value;
}

/** A `--flag <n>` read as a non-negative integer. */
export function readInteger(
  args: ParsedArgs,
  flag: string,
  fallback: number,
): number {
  const raw = args.values[flag];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new VerbUsageError(`--${flag} takes a non-negative whole number, got '${raw}'.`);
  }
  return Number.parseInt(raw, 10);
}

/**
 * `--flag <n,n,n>` read as a list of non-negative integers, refused as a
 * usage error (exit 2) at the FIRST non-numeric entry rather than letting it
 * become `NaN` (review finding: `Number.parseInt` on an unvalidated entry
 * silently produces `NaN`, which then flows into the report/JSON where a
 * caller cannot distinguish it from a real issue number). Every entry is
 * named in the refusal, not just the first, on the same "report the whole
 * problem" idiom the rest of this CLI follows -- a caller fixing one typo at
 * a time is exactly the round-trip cost this repository designs against
 * elsewhere.
 */
export function splitIntegerList(entries: readonly string[], flag: string): number[] {
  const bad = entries.filter((entry): boolean => !/^\d+$/.test(entry));
  if (bad.length > 0) {
    throw new VerbUsageError(
      `--${flag} takes a comma-separated list of non-negative whole numbers, got non-numeric entr${bad.length === 1 ? "y" : "ies"}: ${bad.map((entry): string => `'${entry}'`).join(", ")}.`,
    );
  }
  return entries.map((entry): number => Number.parseInt(entry, 10));
}

/**
 * Emit a report both ways: `--json` prints the object, otherwise the lines.
 *
 * EVERY VERB GOES THROUGH HERE (§1: "human-readable by default, a stable --json
 * contract from the first release"). The point is not the two lines it saves --
 * it is that the JSON is produced from the SAME value the human rendering
 * describes, so a verb cannot grow a `--json` shape that has quietly stopped
 * matching what it prints.
 */
export function emit(io: Io, json: boolean, value: unknown, lines: readonly string[]): void {
  if (json) {
    io.out(JSON.stringify(value, null, 2));
    return;
  }
  for (const line of lines) io.out(line);
}
