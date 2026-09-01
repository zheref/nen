// src/cli/args.ts -- a small, STRICT argv reader.
//
// STRICT IS THE FEATURE. Every flag a command accepts is declared, and anything
// undeclared is a usage ERROR rather than a silently ignored token. The failure
// this prevents is specific and has bitten every CLI that guesses: a typo'd
// `--reop ../bankai-core` is dropped on the floor, the command runs against the
// current directory instead, and it SUCCEEDS -- reporting a taxonomy that came
// from the wrong repository. A verb whose targeting can be silently wrong is
// worse than one that refuses to start.
//
// NO DEPENDENCY, deliberately. This is ~100 lines against an argv-parsing
// library's transitive tree, in a repo whose P1 thesis is that the supply chain
// is auditable. bun's own `util.parseArgs` was the other candidate and is
// rejected for a narrower reason: it accepts unknown options by default and its
// `strict` mode throws a message written for Node's CLI conventions rather than
// for this one, and the message IS the product here.
//
// WHAT IT DOES NOT DO: no short-flag clustering (`-abc`), no negation
// (`--no-json`), no repeated flags collapsing into arrays. Each of those is a
// convention with a surprising edge; none is needed by any verb, and adding one
// later is a reviewable diff rather than a silent behaviour change.

export interface FlagSpec {
  /** Flags that take a value: `--repo <path>` or `--repo=<path>`. */
  readonly values?: readonly string[];
  /** Flags that are present-or-absent: `--json`. */
  readonly booleans?: readonly string[];
  /** Single-dash aliases, e.g. `{ v: "version", h: "help" }`. */
  readonly aliases?: Readonly<Record<string, string>>;
}

export interface ParsedArgs {
  /** Positional tokens, in order. The verb path is read off the front. */
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly booleans: ReadonlySet<string>;
  /** Everything after a bare `--`, passed through untouched. */
  readonly passthrough: readonly string[];
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseArgs(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const valueFlags = new Set(spec.values ?? []);
  const booleanFlags = new Set(spec.booleans ?? []);
  const aliases = spec.aliases ?? {};

  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  const passthrough: string[] = [];

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;
    index += 1;

    // A bare `--` ends OUR reading of argv entirely. Everything after it is the
    // sub-tool's (vitest's, the bootstrap script's) and must not be interpreted
    // here -- a wrapper that re-parses its passthrough is a wrapper that will
    // one day disagree with the tool it wraps.
    if (token === "--") {
      passthrough.push(...argv.slice(index));
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    // `--name=value` -- resolved before the long/short split so an alias can
    // carry a value too.
    const equals = token.indexOf("=");
    const rawName =
      equals === -1
        ? token.replace(/^--?/, "")
        : token.slice(0, equals).replace(/^--?/, "");
    const inlineValue = equals === -1 ? null : token.slice(equals + 1);
    const name = aliases[rawName] ?? rawName;

    if (booleanFlags.has(name)) {
      if (inlineValue !== null) {
        throw new UsageError(
          `--${name} does not take a value (got '--${name}=${inlineValue}').`,
        );
      }
      booleans.add(name);
      continue;
    }

    if (valueFlags.has(name)) {
      if (inlineValue !== null) {
        values[name] = inlineValue;
        continue;
      }
      const next = argv[index];
      // A missing value must never be satisfied by the NEXT FLAG. `--repo
      // --json` would otherwise set repo to "--json", resolve a directory named
      // "--json", and fail three steps later with a filesystem error that says
      // nothing about the real mistake.
      if (next === undefined || next.startsWith("-")) {
        throw new UsageError(`--${name} requires a value.`);
      }
      values[name] = next;
      index += 1;
      continue;
    }

    throw new UsageError(
      `unknown option '${token}'. Known options here: ${
        [...valueFlags]
          .map((flag): string => `--${flag} <value>`)
          .concat([...booleanFlags].map((flag): string => `--${flag}`))
          .sort()
          .join(", ") || "(none)"
      }.`,
    );
  }

  return { positionals, values, booleans, passthrough };
}
