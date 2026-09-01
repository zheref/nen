// src/cli/verb.ts -- the verb registry contract.
//
// WHY A REGISTRY AND NOT A BIGGER SWITCH. Three sessions add verbs to this
// repository in parallel, and every one of them has to touch `src/index.ts` to
// make its verb reachable. A `switch` grows a five-line block per verb in the
// middle of a function, which is a guaranteed conflict for whichever branch
// rebases second; an ALPHABETICAL array of names grows ONE line, in a place a
// three-way merge resolves without a human. The registry is a merge-conflict
// mitigation first and an abstraction second, and it is worth writing down that
// way round so nobody "simplifies" it back into a switch.
//
// A VERB OWNS ITS FLAGS. `parseArgs` is strict -- an undeclared flag is a usage
// error rather than a silently dropped token -- which is exactly the property
// that makes a mis-targeted run impossible, and exactly the property that means
// the parser has to know a verb's flags BEFORE it parses. Hence peekCommand():
// a first, non-consuming scan that finds the verb name so the real parse can be
// given that verb's spec. The scan is told which flags take values, so
// `--repo build` cannot be mistaken for the `build` verb.
//
// THE VERB RETURNS AN EXIT CODE AND WRITES THROUGH `io`, exactly as `run()`
// does. No verb calls `process.exit`, and no verb writes to `process.stdout`:
// the whole surface stays exercisable from vitest without spawning anything,
// which is what makes the `--json` contract testable at all.

import { PROGRAM } from "../version.js";
import type { FlagSpec, ParsedArgs } from "./args.js";

export interface VerbIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface VerbContext {
  /** Positionals AFTER the verb name -- `["search"]` for `nen issue search`. */
  readonly args: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly booleans: ReadonlySet<string>;
  /** Everything after a bare `--`. */
  readonly passthrough: readonly string[];
  /** The `--repo <path>` override, or null. A PATH, never an owner/name slug. */
  readonly repoFlag: string | null;
  /** `--json` was given. */
  readonly json: boolean;
  readonly io: VerbIo;
}

export interface Verb {
  /** The first positional that selects this verb, e.g. `"issue"`. */
  readonly name: string;
  /** One line for the top-level `--help` list. */
  readonly summary: string;
  /** The verb's own help block, printed by `nen <verb> --help`. */
  readonly usage: string;
  /** Flags this verb adds on top of the global set. */
  readonly flags: FlagSpec;
  run(context: VerbContext): number;
}

export function mergeFlags(base: FlagSpec, extra: FlagSpec): FlagSpec {
  return {
    values: [...(base.values ?? []), ...(extra.values ?? [])],
    booleans: [...(base.booleans ?? []), ...(extra.booleans ?? [])],
    aliases: { ...(base.aliases ?? {}), ...(extra.aliases ?? {}) },
  };
}

// Every value-taking flag in the program, so the peek below can tell a flag's
// VALUE from a positional. Computed from the registry rather than written out,
// because a verb whose value flag is missing here would have its value read as
// the command name -- a targeting bug of exactly the class ./args.ts exists to
// prevent.
export function allValueFlags(base: FlagSpec, verbs: readonly Verb[]): ReadonlySet<string> {
  const names = new Set<string>(base.values ?? []);
  for (const verb of verbs) for (const flag of verb.flags.values ?? []) names.add(flag);
  return names;
}

// The FIRST positional token, without consuming or validating anything.
//
// It deliberately duplicates a little of parseArgs' tokenizing rather than
// calling it: parseArgs THROWS on an unknown flag, and at this point the
// unknown flag may simply be one the not-yet-identified verb declares. Peeking
// must never fail; the strict parse happens once the spec is complete.
export function peekCommand(
  argv: readonly string[],
  valueFlags: ReadonlySet<string>,
  aliases: Readonly<Record<string, string>> = {},
): string | null {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) return null;
    index += 1;
    if (token === "--") return null;
    if (!token.startsWith("-") || token === "-") return token;
    // `--name=value` carries its value inline and consumes nothing after it.
    if (token.includes("=")) continue;
    const raw = token.replace(/^--?/, "");
    const name = aliases[raw] ?? raw;
    if (valueFlags.has(name)) index += 1;
  }
  return null;
}

export function contextFrom(
  parsed: ParsedArgs,
  io: VerbIo,
): VerbContext {
  return {
    args: parsed.positionals.slice(1),
    values: parsed.values,
    booleans: parsed.booleans,
    passthrough: parsed.passthrough,
    repoFlag: parsed.values["repo"] ?? null,
    json: parsed.booleans.has("json"),
    io,
  };
}

// The one shape every verb's `--json` answer takes when the verb has no richer
// payload of its own: a verdict plus its reasons. Verbs with a real payload
// print that payload instead; this exists so the trivial ones do not each
// invent a different envelope.
export interface Verdict {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

// A usage complaint from inside a verb: the message, and exit code 2.
export function usage(io: VerbIo, message: string): number {
  io.err(`${PROGRAM}: ${message}`);
  return 2;
}
