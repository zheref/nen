// src/schema/yaml.ts -- the STRICT, REFUSING reader for the taxonomy files'
// YAML, built on the `yaml` package.
//
// WHY NOT `yq`. D16 forbids it outright: "no make, no bats/pytest, no runtime
// python3, no jq/yq anywhere in an executed path". A machine gets one binary
// plus git and gh, so a colour lookup cannot shell out to a YAML processor that
// may not be installed and, when it is, may be one of two mutually incompatible
// programs with the same name.
//
// WHY THE DEPENDENCY, HAVING FIRST REFUSED IT. The original of this file was a
// ~250-line hand-rolled subset parser, taken on the argument that a supply chain
// a human can read beats a few thousand lines of YAML 1.2 that nobody will ever
// read. The adversarial pass killed that argument with a reproduction rather
// than a preference:
//
//   parseYaml("- - foo: bar\n")   // never returns
//
// A nested block sequence drove the mapping parser to consume zero lines while
// the caller advanced its cursor BACKWARDS, and the loop spun forever --
// reproduced end to end through the compiled binary, which had to be killed. A
// second finding rode along: a `__proto__:` key was assigned with
// `map[key] = value`, which sets the mapping's PROTOTYPE instead of a key, so the
// duplicate-key guard could not see it and later bracket reads could inherit a
// value the file never stated as its own.
//
// Both are the same lesson, and it outranks the readability argument: a parser
// is where the failure modes are not the ones you thought of. A HANG in a verb
// CI waits on is strictly worse than a dependency, because a hang has no error
// message, no exit code and no timeout. So the PARSING is now the `yaml`
// package's -- widely used, fuzzed, and prototype-safe (it makes `__proto__` an
// ordinary own key rather than a prototype assignment; pinned by a test below)
// -- and this file keeps the part that was actually load-bearing: THE REFUSALS.
//
// WHAT THIS WRAPPER STILL REFUSES, each with its own message and a line number.
// The package parses all of these happily; a taxonomy file must not contain
// them, because each is a construct whose meaning depends on a resolution step
// two readers can disagree about:
//
//   * anchors (`&x`) and aliases (`*x`)
//   * merge keys (`<<`)
//   * explicit tags (`!!str`, `!Foo`)
//   * YAML directives (`%YAML`)
//   * a second document in the stream
//   * `__proto__` / `constructor` / `prototype` as a mapping key
//
// and it surfaces the package's own hard errors -- a TAB in the indentation, a
// duplicate key, an unterminated scalar -- through the same channel, so a caller
// has ONE error type to handle and ./errors.ts stays the only failure path a
// loader has.
//
// THE INVARIANT IS UNCHANGED: this module never invents a value. Every path
// either produces what the file states or throws naming the line. That is the
// same discipline ../github/parse.ts applies to GitHub's JSON, for the same
// reason -- an absent or unreadable datum must never arrive downstream wearing a
// default's clothes.
//
// YAML 1.2 CORE, which is the package's default and is deliberately pinned
// rather than left implicit. Under YAML 1.1 the bare word `on` parses as the
// boolean `true`; under 1.2 it stays the string `"on"`. That is not academic
// here -- src/pipeline.test.ts reads the GitHub Actions workflows through this
// reader, and every one of them has a top-level `on:` key.

import YAML from "yaml";

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "YamlError";
    this.line = line;
  }
}

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

// Mapping keys that are refused outright. `__proto__` is the one that matters --
// the package is prototype-safe, so this is defence in depth rather than the fix,
// and it is here because a taxonomy file containing one is a file whose author
// meant something other than a label.
const REFUSED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

// Turn a source offset into a 1-based line number. The package reports positions
// as offsets; a reader chasing a refusal needs a line.
function lineAt(source: string, offset: number | undefined): number {
  if (offset === undefined || offset < 0) return 1;
  let line = 1;
  const limit = Math.min(offset, source.length);
  for (let index = 0; index < limit; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function nodeLine(source: string, node: unknown): number {
  if (node !== null && typeof node === "object" && "range" in node) {
    const range = (node as { range?: readonly number[] }).range;
    return lineAt(source, range?.[0]);
  }
  return 1;
}

function scalarKeyName(key: unknown): string {
  if (key !== null && typeof key === "object" && "value" in key) {
    return String((key as { value: unknown }).value);
  }
  return String(key);
}

export function parseYaml(source: string): YamlValue {
  // `parseAllDocuments`, not `parseDocument`: a second document must be a
  // REFUSAL carrying our message and a line, and `parseDocument` silently
  // returns only the first.
  const documents = YAML.parseAllDocuments(source, {
    // A duplicate key is an error, never last-one-wins. Two entries for one
    // label means the file has two answers for its colour, and whichever a
    // reader takes is arbitrary. (This is the package's default, restated
    // because it is load-bearing rather than incidental.)
    uniqueKeys: true,
    // `<<` stays an ordinary key rather than being resolved as a merge, so the
    // walk below can see it and refuse. Resolving it would be exactly the
    // "assembled by reference" construct this reader exists to reject.
    merge: false,
    strict: true,
    version: "1.2",
  });

  if (documents.length === 0) return null;
  if (documents.length > 1) {
    throw new YamlError(
      "a second document starts here; this reader accepts exactly one, because a taxonomy file with two of them has two answers to every question",
      nodeLine(source, documents[1]),
    );
  }

  const doc = documents[0];
  if (doc === undefined) return null;

  const firstError = doc.errors[0];
  if (firstError !== undefined) {
    throw new YamlError(
      `${firstError.message.split("\n")[0] ?? firstError.message} [${firstError.code}]`,
      lineAt(source, firstError.pos[0]),
    );
  }
  // Warnings are refused too. The package warns about what it chose to tolerate;
  // a taxonomy file is not a place to tolerate anything, and a warning nobody
  // reads is a silent acceptance.
  const firstWarning = doc.warnings[0];
  if (firstWarning !== undefined) {
    throw new YamlError(
      `${firstWarning.message.split("\n")[0] ?? firstWarning.message} [${firstWarning.code}]`,
      lineAt(source, firstWarning.pos[0]),
    );
  }

  if (doc.directives?.yaml.explicit === true) {
    throw new YamlError(
      "YAML directives (%YAML) are not supported -- this reader parses one profile and does not switch on a file's request",
      1,
    );
  }

  // ONE walk for anchors, aliases, tags, merge keys and refused key names, so
  // the refusals cannot drift apart from one another.
  YAML.visit(doc, {
    Alias(_key, node): void {
      throw new YamlError(
        `aliases are not supported ('*${String(node.source)}') -- a taxonomy value resolved through a reference is a value two readers can disagree about`,
        nodeLine(source, node),
      );
    },
    Node(_key, node): void {
      if (typeof node.anchor === "string" && node.anchor !== "") {
        throw new YamlError(
          `anchors are not supported ('&${node.anchor}') -- a taxonomy value resolved through a reference is a value two readers can disagree about`,
          nodeLine(source, node),
        );
      }
      if (typeof node.tag === "string" && node.tag !== "") {
        throw new YamlError(
          `explicit tags are not supported ('${node.tag}') -- the type of a taxonomy value is decided by this reader, never by the file`,
          nodeLine(source, node),
        );
      }
    },
    Pair(_key, pair): void {
      const name = scalarKeyName(pair.key);
      const at = nodeLine(source, pair.key);
      if (name === "<<") {
        throw new YamlError(
          "merge keys ('<<') are not supported -- a taxonomy value assembled by merge is a value two readers can disagree about",
          at,
        );
      }
      if (REFUSED_KEYS.has(name)) {
        throw new YamlError(
          `'${name}' is not an acceptable mapping key -- it names a JavaScript object internal, and a taxonomy file that uses one means something other than what it appears to`,
          at,
        );
      }
    },
  });

  // `maxAliasCount: 0` is belt and braces: the walk above has already refused
  // every alias, so this can only fire if that walk is ever weakened.
  return doc.toJS({ maxAliasCount: 0 }) as YamlValue;
}
