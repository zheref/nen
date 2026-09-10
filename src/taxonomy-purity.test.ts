// src/taxonomy-purity.test.ts -- the §3 invariant, enforced rather than asserted.
//
// "No binary may hard-code a persona, label, check name, or colour; they are
// read from the target repo's schemas" (Akatsuki migration §3). A rule of that
// shape is worth nothing as prose: it is exactly the kind of discipline that
// holds for three commits and then quietly stops, because the violation is one
// convenient literal in a file nobody re-reads. So it is a TEST, and it fails
// the build.
//
// IT SWEEPS CODE, NOT COMMENTS, and that distinction is the whole design of this
// file. The seeded modules' comments are FULL of the names -- deliberately, and
// review-blockingly so: each one records the production incident its branch
// exists for, and stripping them to satisfy a grep would destroy the thing that
// makes the port safe (the BC-IS-#737 discipline). The prohibition is on a name
// a binary DECIDES with, not on a name a maintainer READS. So comments and the
// contents of string/template literals inside comments are removed first, and
// what remains -- executable code, including its string and regex literals -- is
// what is searched.
//
// WHAT IS EXCLUDED, and why each is legitimate:
//   * `**/*.test.ts` -- a test must be able to name what it is testing, and the
//     ported predicate suite in particular is the regression proof precisely
//     because it uses the original's own names.
//   * `**/fixtures/**` -- fixture repositories exist to state concrete
//     vocabularies. Two of them, with nothing in common; that pair is what
//     makes "the names are data" a proved claim (src/gates/predicates.test.ts).
// Nothing else is excluded, and adding an exclusion is a review finding.
//
// WHAT ELSE IS SWEPT, and what deliberately is not (zheref/nen#6 item 1, last
// bullet: "only `.ts` files are read"). `bootstrap/nen.sh` IS read now, because
// it is shipped EXECUTABLE code -- the one file outside `src/**` a consumer
// runs, and the one place a sweep of TypeScript could never see. Shipped DATA
// (`src/**/*.json`, `profiles/*.json`, `templates/**`) is NOT read, and that is
// the rule rather than a gap: §3 says the names are read FROM data, so data is
// exactly where a name is allowed to be. `src/shadow/targets.json` is the
// worked example -- a list of repositories nen is POINTED AT, moved out of
// `src/shadow/run.ts` into JSON for this sweep's own sake, its own `$comment`
// saying so. A rule that swept it would be a rule against the design.
//
// WHAT THIS SWEEP STILL CANNOT SEE, stated so a reader does not mistake a
// denylist for a proof: it knows the vocabularies that exist TODAY, so a fourth
// system's names stay invisible until somebody adds them here. The
// allowlist-over-the-shipped-bundle idea from the same review is NOT adopted:
// the bundle is a `bun build --compile` artifact produced at release time and
// absent from the tree, so a check over it could not FAIL THE BUILD -- this
// file's entire reason for being a test -- and over compiled output an
// allowlist cannot tell a persona from an English word. What is closed below is
// every defeat that needs no new vocabulary: assembly, casing, the narrow
// colour shape, glyphs, and the unswept shell.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(process.cwd(), "src");
const SHELL = join(process.cwd(), "bootstrap", "nen.sh");

// Read a shipped source with its line endings NORMALIZED.
//
// The tree is `* text=auto`, so a Windows checkout carries CRLF. Today that
// would only put a stray carriage return on the end of every line this sweep
// reports; what makes it worth fixing is the NEXT rule somebody adds, anchored
// with a multiline end-of-line, which would then match on two of the three CI
// lanes and not the third. This file is the guard for a rule that fails the
// build, so it must not itself be platform-conditional -- the same hazard that
// took pipeline.test.ts's upload assertion red on windows-latest and green
// everywhere else.
function readSource(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function shippedFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "fixtures") continue;
      shippedFiles(path, found);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    found.push(path);
  }
  return found;
}

// Where a regex literal ENDS, starting at the `/` that opens it, or -1 when the
// text from there is not one.
//
// Scanning is the ordinary rule and nothing more: a `\` escapes the next
// character, a `[` opens a character class in which a `/` is an ordinary
// character, and the literal closes at the first unescaped `/` outside a class.
// An unterminated one is not a regex at all -- a regex literal cannot span a
// newline -- so a `/` whose line has no closing partner answers -1 and the
// caller treats it as the division sign it must have been.
function regexLiteralEnd(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\n") return -1;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") {
      inClass = true;
    } else if (char === "/") {
      return index;
    }
    index += 1;
  }
  return -1;
}

// Replace every comment with an equal number of newlines, so reported line
// numbers still point at the real line.
//
// It tracks single-quoted, double-quoted and template strings, because a `//`
// inside a string is not a comment.
//
// IT TRACKS REGEX LITERALS AND `${...}` NESTING TOO, and neither is cosmetic
// (zheref/nen#12 item 1). Both are ways this scanner used to open a string that
// was never a string and then swallow every line until the next matching quote
// -- hiding all of it from the sweep, SILENTLY: the sweep still passed, over
// less code, and nothing said so. The mechanism that makes "names are data" a
// proved claim must not fail quietly.
//
//   * A regex containing a QUOTE character -- `/["']/`, the shape any CSV or
//     TSV splitter is written with -- was read as an opening quote. A `/` opens
//     a regex only where a VALUE may begin: never straight after an identifier,
//     a number, a `)` or a `]`, the four things a division sign follows. That is
//     the standard disambiguation and it is decidable without parsing; a `/`
//     that opens nothing terminable on its own line is division too.
//   * A `${...}` substitution holds ORDINARY CODE, and that code can open
//     another template literal -- arbitrarily deep. Read flat, the inner
//     template's opening backtick closes the OUTER one, and everything after it
//     is scanned as code: in `src/verbs/pr_ready.ts` the apostrophe in a nested
//     template's prose then opened a string that ran eighty lines down the file.
//     That was live on main, found by the guard below rather than by reading.
//     So the state is a stack, not a flag.
// AND WHATEVER IT CONCLUDES, THE SCAN REPORTS ITS OWN QUOTE STATE. That is the
// loud half, and it is the part that matters more than the heuristic: the
// failure was never that one case scanned wrong, it was that scanning wrong cost
// the sweep an unbounded run of lines and said nothing. `Scan.unterminated` is
// asserted null for every shipped file below, so a construct that confuses this
// scanner in future reddens the build instead of quietly shrinking its reach.
export interface Scan {
  /** The source with every comment gone and line numbering preserved. */
  readonly code: string;
  /** The quote this scan was still inside when the file ended, or null. */
  readonly unterminated: string | null;
  /**
   * 1-based line numbers where the scan carried a `'` or `"` string ACROSS a
   * newline. In TypeScript that is impossible -- only a template literal spans
   * lines -- so every entry is the scanner having mistaken something for an
   * opening quote, which is precisely the swallow this file must not do
   * silently. Asserted empty for every shipped file.
   */
  readonly spanningQuotes: readonly number[];
}

export function scanSource(source: string): Scan {
  let out = "";
  let index = 0;
  let line = 1;
  // A simple `'`/`"` string, which cannot nest and cannot span a line.
  let quote: string | null = null;
  let previousSignificant = "";
  const spanningQuotes: number[] = [];

  // The nesting stack. A template literal can hold a `${...}` substitution, that
  // substitution holds ORDINARY CODE, and that code can open another template --
  // arbitrarily deep. A flat scanner reads the second template's opening
  // backtick as the FIRST one's closing backtick, ends the string half-way
  // through a substitution, and reads the rest of the line as code (see
  // `src/verbs/pr_ready.ts`, where the apostrophe in a nested template's prose
  // then opened a string that ran on for eighty lines). So the state is a stack.
  type Frame = { kind: "code" } | { kind: "template" } | { kind: "sub"; depth: number };
  const stack: Frame[] = [{ kind: "code" }];
  const top = (): Frame => stack[stack.length - 1] as Frame;

  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (char === "\n") line += 1;

    if (quote !== null) {
      out += char;
      if (char === "\\") {
        out += next;
        if (next === "\n") line += 1;
        index += 2;
        continue;
      }
      // A `'`/`"` string cannot contain a newline in TypeScript. Reaching one
      // means this scanner opened a string that was never one, so the line is
      // recorded and the string is abandoned rather than swallowing the file.
      if (char === "\n") {
        spanningQuotes.push(line - 1);
        quote = null;
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (top().kind === "template") {
      out += char;
      if (char === "\\") {
        out += next;
        if (next === "\n") line += 1;
        index += 2;
        continue;
      }
      if (char === "`") {
        stack.pop();
        previousSignificant = "`";
        index += 1;
        continue;
      }
      if (char === "$" && next === "{") {
        out += next;
        stack.push({ kind: "sub", depth: 0 });
        previousSignificant = "{";
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    // Code, or the inside of a `${...}` substitution -- which is code.
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      previousSignificant = char;
      index += 1;
      continue;
    }

    if (char === "`") {
      stack.push({ kind: "template" });
      out += char;
      previousSignificant = char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") {
          out += "\n";
          line += 1;
        }
        index += 1;
      }
      index += 2;
      continue;
    }

    if (char === "/" && !/[A-Za-z0-9_$)\]]/.test(previousSignificant)) {
      const end = regexLiteralEnd(source, index);
      if (end !== -1) {
        // Emitted VERBATIM: a regex literal is executable code and its own
        // contents are exactly what this sweep searches.
        out += source.slice(index, end + 1);
        previousSignificant = "/";
        index = end + 1;
        continue;
      }
    }

    const frame = top();
    if (frame.kind === "sub" && char === "{") frame.depth += 1;
    if (frame.kind === "sub" && char === "}") {
      if (frame.depth === 0) {
        out += char;
        stack.pop();
        previousSignificant = "}";
        index += 1;
        continue;
      }
      frame.depth -= 1;
    }

    out += char;
    if (!/\s/.test(char)) previousSignificant = char;
    index += 1;
  }

  const open = stack.length > 1 ? "`" : null;
  return { code: out, unterminated: quote ?? open, spanningQuotes };
}

export function stripComments(source: string): string {
  return scanSource(source).code;
}

// Replace every `#` comment in a POSIX shell source with nothing, so the shell
// half of the sweep obeys the same code-not-comments rule the TypeScript half
// does. `bootstrap/nen.sh`'s header records zheref/bankai-core#740 the way every
// seeded module records its incident, and that is a name a maintainer READS.
//
// A `#` opens a comment only at the start of a WORD -- `${x#prefix}` and a bare
// `#` inside a quoted string are not comments -- so this tracks the same three
// quote states the TypeScript scanner does, and additionally requires the `#` to
// sit at the start of the line or after whitespace. Line numbering is preserved
// exactly as above.
export function stripShellComments(source: string): string {
  let out = "";
  let index = 0;
  let quote: string | null = null;

  while (index < source.length) {
    const char = source[index] ?? "";
    const previous = index === 0 ? "\n" : (source[index - 1] ?? "");

    if (quote !== null) {
      out += char;
      // Backslash escapes inside single quotes are NOT escapes in POSIX shell:
      // `'\''` ends the string. Only the double-quoted form takes them.
      if (char === "\\" && quote === '"') {
        out += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (char === "\\") {
      out += char + (source[index + 1] ?? "");
      index += 2;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }

    if (char === "#" && (previous === "\n" || previous === " " || previous === "\t")) {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    out += char;
    index += 1;
  }
  return out;
}

// Fold `"sas" + "uke"` into `"sasuke"` before the line is searched.
//
// String concatenation is the cheapest way to walk a value-level sweep past a
// name it knows (zheref/nen#6 item 1, "blind to assembly"), and it is the one
// assembly form that is decidable without evaluating anything: two adjacent
// LITERALS joined by `+` have exactly one possible value. So they are joined
// here first, and the FORBIDDEN patterns then see the string the program will.
//
// Deliberately LINE-LOCAL and loop-to-a-fixed-point: line-local because reported
// line numbers are what makes an offence findable, and a fold across a newline
// would move them; looped because one pass over `"s" + "as" + "uke"` leaves a
// second `+` behind. A literal carrying a quote of its own, an escape, or a
// template substitution is left alone rather than guessed at -- and a
// concatenation split across two lines by the formatter is the one shape this
// still does not see. Runtime assembly (`String.fromCharCode`, `atob`) is not
// decidable here at all and is refused outright by its own rule below.
export function foldConcatenations(line: string): string {
  const pair = /(["'`])([^"'`\\\n$]*)\1[ \t]*\+[ \t]*(["'`])([^"'`\\\n$]*)\3/;
  let out = line;
  for (let pass = 0; pass < 20; pass += 1) {
    const next = out.replace(pair, (_match, _q1, left: string, _q2, right: string): string => {
      return `"${left}${right}"`;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

// Split a line into the WORDS its identifiers and literals are made of.
//
// The regex rules below are substring rules with boundary lookarounds, which is
// why `patternForSasuke` and `pattern_for_sasuke` walked straight past them: the
// character before the name is a letter or an underscore in both. A word-level
// rule asks the question the reviewer actually means -- "is one of these names a
// PART of anything shipped here" -- and it is casing-agnostic by construction.
//
// Splitting is on every non-alphanumeric character plus the two boundaries a
// compound identifier is written with: lowercase-or-digit followed by uppercase
// (`patternForSasuke`), and an acronym run followed by a capitalised word
// (`HTTPSasuke`). Words are lowercased and compared WHOLE, so an ordinary
// identifier that merely contains a name as a substring is not an offence --
// the same false-positive discipline the boundary lookarounds were reaching for.
export function words(line: string): string[] {
  return line
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word): boolean => word !== "")
    .map((word): string => word.toLowerCase());
}

interface Forbidden {
  readonly what: string;
  readonly pattern: RegExp;
  /** Where the rule applies. `code` is every shipped source; `ts` is TypeScript only. */
  readonly scope?: "code" | "ts";
  /** Lines this rule MUST catch, and lines it must not. Exercised below. */
  readonly catches: readonly string[];
  readonly allows: readonly string[];
}

// Each entry names a CLASS of value §3 forbids, with the reason a violation
// matters. The lists are the live system's vocabulary plus the fixture
// vocabulary, because a leak of either would be the same defect.
const FORBIDDEN: readonly Forbidden[] = [
  {
    what: "a persona / reviewer / bot name",
    // Word-ish boundaries, so an ordinary identifier that merely contains one of
    // these as a substring is not a false positive. `cursor` is deliberately
    // ABSENT from this list: it is a legitimate identifier (GraphQL pagination,
    // this file's own scanner) and the reviewer it could name is covered by
    // `bugbot`.
    pattern:
      /(?<![A-Za-z0-9_])(sasuke|tenma|bisky|bugbot|copilot|kisuke|naruto|yamamoto|ichigo|okkotsu|rukia|natsu|kurapika|tanjiro|neferpitou|itachi|kisame|roy-bankai|train-bot)(?![A-Za-z0-9_])/i,
    catches: ['const a = "sasuke";', 'const b = "roy-bankai";', "const c = SASUKE;"],
    allows: ["const cursor = page.cursor;", "const d = narutoish;"],
  },
  {
    what: "a label namespace",
    pattern: /(?<![A-Za-z0-9_])(bankai|akatsuki|shikai)\s*:/i,
    catches: ['const a = "bankai:mode/build";'],
    allows: ['const a = "mode/build";'],
  },
  {
    what: "the name of a system nen serves",
    // BROADER than the label-namespace rule above, and it caught something the
    // narrower one waved through: an example repository name inside an ERROR
    // MESSAGE (`e.g. --repo ../bankai-core`). Not a value the binary decides
    // with, but a system's name shipped in a string all the same -- and error
    // messages are exactly where such a name survives a value-level sweep.
    pattern: /(?<![A-Za-z0-9_])(bankai|akatsuki|shikai|hatsu|ninjutsu)(?![A-Za-z0-9_])/i,
    catches: ['throw new Error("e.g. --repo ../bankai-core");'],
    allows: ['throw new Error("e.g. --repo ../some-repo");'],
  },
  {
    what: "a check-name fragment",
    // `<caller job> / <called job>` is the rollup's shape; a literal naming a
    // specific reviewer job is a check name written into the binary.
    pattern: /["'`][^"'`]*\/\s(audit|review|probe|sweep|inspect)\b/i,
    catches: ['const a = "sasuke / audit";'],
    allows: ['const a = context.check;'],
  },
  {
    what: "a concrete colour",
    // Three alternatives, because a colour has three spellings and this used to
    // look for one: the six-digit hex, the SHORT hex, and the functional forms
    // (zheref/nen#6 item 1, "colour rule is 6-digit only" -- `#f00` and
    // `rgb(217, 63, 11)` both passed).
    //
    // The six-digit limb is unchanged, and the character-class SHAPES the
    // loaders validate against (`/^#[0-9a-fA-F]{6}$/`) still do not match it:
    // the character after their `#` is `[`, not a hex digit.
    //
    // THE SHORT HEX IS THE DELICATE ONE, and its two guards are why this is not
    // simply `{3}`. `#123` is a three-hex-digit token AND this repository's own
    // issue-reference notation, written a few dozen times across `src/epic/**`,
    // `src/ref/**` and half the refusal messages -- a bare `{3}` rule fails the
    // build on every one of them. So the limb requires (a) the token to be a
    // whole quoted literal, `'#f00'`, which no issue reference in this codebase
    // is written as, and (b) at least one hex LETTER, which no issue number
    // has. The cost is stated rather than hidden: an all-decimal short hex
    // (`'#888'`) is NOT caught, because nothing distinguishes it from an issue
    // reference, and a rule that guessed would be a rule that goes red on
    // honest text.
    //
    // The functional limb requires a DIGIT after the paren, so `rgb(` inside a
    // type name, or an `hsl(x)` helper called over variables, is not an offence
    // -- a concrete colour is the forbidden thing, not the function.
    pattern:
      /#[0-9a-fA-F]{6}(?![0-9a-fA-F])|["'`]#(?![0-9]{3}["'`])[0-9a-fA-F]{3}["'`]|(?:rgb|hsl)a?\(\s*\d/i,
    catches: [
      'const a = "#d93f0b";',
      'const b = "#f00";',
      'const c = "rgb(217, 63, 11)";',
      'const d = "hsla(12, 90%, 45%, 0.5)";',
    ],
    allows: [
      "const shape = /^#[0-9a-fA-F]{6}$/;",
      "throw new Error(\"a child names its issue as '#123'\");",
      'const e = "#888";',
      "const f = hsl(hue);",
    ],
  },
  {
    what: "a status colour glyph",
    // The colour rule above reads `#rrggbb`; a board's colours ship as GLYPHS,
    // and `schemas/colors.yml` is where they live (`nen color list` prints
    // `value.emoji` -- the repository's, never this binary's). So a literal
    // `"🔴"` in shipped code is precisely the leak the colour rule exists for,
    // arriving in the one shape it could not see (zheref/nen#6 item 1, "no
    // emoji rule").
    //
    // Narrow ON PURPOSE: the coloured circles, squares and the two monochrome
    // pairs that stand in for them, and nothing else. `src/ref/notation.ts`'s
    // ✓ ✗ ✎ are a KIND vocabulary, not a status one -- its own comment calls it
    // "deliberately circle-free" for exactly this reason -- and a rule over
    // every pictographic character would forbid them along with the tick in
    // `src/dev/matrix.ts`, which nothing asked for.
    pattern: /[\u{1F534}-\u{1F53A}\u{1F7E0}-\u{1F7EB}\u{26AA}\u{26AB}\u{2B1B}\u{2B1C}]/u,
    catches: ['const a = "\u{1F534} blocked";', 'const b = "\u{1F7E1}";', 'const c = "\u{26AB}";'],
    // The KIND vocabulary this rule must NOT reach.
    allows: ['const merged = "\u2713";', 'const closed = "\u2717";', 'const draft = "\u270E";'],
  },
  {
    what: "a delivery branch-naming convention",
    pattern: /["'`](integration|train|epic)\//i,
    catches: ['const a = "integration/v1";'],
    allows: ["const a = branchFor(kind);"],
  },
  {
    what: "a runtime string assembly",
    // The other way a name is assembled past a sweep over source (zheref/nen#6
    // item 1, "blind to assembly"): `String.fromCharCode(115, 97, ...)` and
    // `atob("c2FzdWtl")` each spell a name the vocabulary rules cannot read.
    // Adjacent string concatenation is FOLDED before the rules run, because it
    // has exactly one decidable value; these do not, so they are refused.
    //
    // REFUSED ONLY OVER LITERALS, which is the whole precision of the rule. A
    // name can only be hidden here if the characters are IN THE FILE -- numeric
    // literals for the two `from…` methods, a string literal for `atob`. A call
    // over a variable (`String.fromCodePoint(code)`) encodes nothing at all: the
    // source carries no name to find, and the value comes from whatever the tool
    // was pointed at. That distinction is not academic -- `src/shu/coverage/
    // formats/xml.ts` decodes XML numeric character references exactly that way,
    // and a rule that forbade the method outright would forbid an entity decoder
    // for being able to produce letters.
    //
    // MATCHED ON THE METHOD NAME, never on the receiver, so the lookbehind
    // excludes identifier characters and NOT `.`: `String.x(`, `globalThis.x(`
    // and a destructured bare `x(` all read the same, and no spelling of the
    // same call walks past. (A first draft did put `.` in that class and
    // anchored the `String` forms on the receiver, so `String.fromCodePoint(`
    // matched neither limb -- caught in review of the PR that added this.)
    pattern:
      /(?<![A-Za-z0-9_])(?:fromCharCode|fromCodePoint)\s*\(\s*[0-9]|(?<![A-Za-z0-9_])atob\s*\(\s*["'`]/,
    scope: "ts",
    catches: [
      "const a = String.fromCharCode(115, 97);",
      "const b = String.fromCodePoint(0x73);",
      'const c = atob("c2FzdWtl");',
      "const d = fromCharCode(115);",
    ],
    // The legitimate half: a decode over a value the source does not carry.
    allows: [
      "const a = String.fromCodePoint(code);",
      "const b = atob(seed);",
      "const c = String(value);",
      "const d = codePointAt(0);",
    ],
  },
];

// Every single-word entry of the vocabulary rules above, as WORDS rather than as
// substrings-with-boundaries. The two hyphenated entries (`roy-bankai`,
// `train-bot`) are absent by construction -- a word split would break them into
// halves whose second half is already forbidden on its own -- so they stay the
// regex rules' business and this one takes the compound-identifier question.
const FORBIDDEN_WORDS: ReadonlySet<string> = new Set([
  "sasuke",
  "tenma",
  "bisky",
  "bugbot",
  "copilot",
  "kisuke",
  "naruto",
  "yamamoto",
  "ichigo",
  "okkotsu",
  "rukia",
  "natsu",
  "kurapika",
  "tanjiro",
  "neferpitou",
  "itachi",
  "kisame",
  "bankai",
  "akatsuki",
  "shikai",
  "hatsu",
  "ninjutsu",
]);

interface Swept {
  readonly label: string;
  readonly code: string;
  readonly kind: "ts" | "shell";
  /** The quote the scanner ended this file inside, or null. Asserted below. */
  readonly unterminated: string | null;
  /** Lines where a `'`/`"` string ran across a newline. Asserted empty below. */
  readonly spanningQuotes: readonly number[];
}

function swept(): Swept[] {
  const rows: Swept[] = shippedFiles(SRC).map((file): Swept => {
    const scan = scanSource(readSource(file));
    return {
      label: `src/${relative(SRC, file).split(sep).join("/")}`,
      code: scan.code,
      kind: "ts",
      unterminated: scan.unterminated,
      spanningQuotes: scan.spanningQuotes,
    };
  });
  // The shipped shell, swept under the same code-not-comments rule. It is ONE
  // file, named rather than walked, because that is the whole of nen's shipped
  // shell surface -- a directory walk here would be a walk over one entry and
  // would quietly start sweeping the next `.sh` somebody adds for a different
  // purpose without anyone deciding it should be.
  rows.push({
    label: "bootstrap/nen.sh",
    code: stripShellComments(readSource(SHELL)),
    kind: "shell",
    unterminated: null,
    spanningQuotes: [],
  });
  return rows;
}

describe("§3: names are data", () => {
  const files = swept();

  it("sweeps a non-trivial number of shipped files", () => {
    // A sweep that silently matched nothing would pass forever. This asserts the
    // walker is actually finding the tree, and that the seeded modules -- the
    // ones the prohibition is aimed at -- are in it.
    expect(files.length).toBeGreaterThan(10);
    const names = files.map((file): string => file.label);
    expect(names).toContain("src/gates/predicates.ts");
    expect(names).toContain("src/github/client.ts");
    expect(names).toContain("src/schema/labels.ts");
    // The shipped shell is in the sweep, not merely reachable by it.
    expect(names).toContain("bootstrap/nen.sh");
  });

  it("scans every shipped file to its END, inside no string", () => {
    // zheref/nen#12 item 1, the loud half. A scanner that mistakes something for
    // an opening quote does not stop -- it swallows every line until the next
    // matching character and hides all of it, and the sweep still passes, over
    // less code, saying nothing. `/["']/` -- the shape any CSV or TSV splitter
    // is written with -- was exactly such a construct before this scanner
    // learned regex literals.
    //
    // So the property is asserted rather than reasoned about: whatever the
    // heuristic concludes about a `/`, no shipped file may end inside a string.
    // A future construct that confuses the scanner is a red test.
    const offences = files
      .filter((file): boolean => file.unterminated !== null)
      .map((file): string => `${file.label}: ends inside a ${file.unterminated} string`);
    expect(offences).toEqual([]);
  });

  it("carries no quoted string across a newline", () => {
    // The second half of the same guard, for a confusion that RE-BALANCES before
    // EOF and so escapes the check above -- which `/["']/` does, opening on the
    // `"` and closing on the next one somewhere further down the file.
    //
    // The invariant is a fact about the language rather than a threshold: a `'`
    // or `"` string cannot contain a newline in TypeScript. Only a template
    // literal spans lines. So a scan that carried one across a line break did
    // not find a string -- it found something it mistook for one, and everything
    // between is code this sweep never looked at.
    const offences: string[] = [];
    for (const file of files) {
      for (const line of file.spanningQuotes) {
        offences.push(`${file.label}:${line}: a quoted string ran past the end of its line`);
      }
    }
    expect(offences).toEqual([]);
  });

  for (const { what, pattern, scope } of FORBIDDEN) {
    it(`finds no hard-coded ${what} in shipped code`, () => {
      const offences: string[] = [];
      for (const file of files) {
        if (scope === "ts" && file.kind !== "ts") continue;
        file.code.split("\n").forEach((line, index): void => {
          // Folded FIRST, so a name split across a `+` is searched as the string
          // the program will actually hold, and the ORIGINAL line is reported so
          // the offence is findable in the file.
          const match = pattern.exec(foldConcatenations(line));
          if (match === null) return;
          offences.push(`${file.label}:${index + 1}: ${match[0]} -- in: ${line.trim()}`);
        });
      }
      expect(offences).toEqual([]);
    });
  }

  // A rule that has never been seen to FIRE is a rule nobody has tested, and a
  // sweep whose rules all quietly match nothing passes forever. The self-check
  // at the top proves the walker finds the tree; this proves each RULE finds the
  // thing it was written for, and leaves alone the thing that made it delicate
  // -- the issue-reference notation, the KIND glyphs, the validator shapes.
  //
  // It is the guard the review of this file's own hardening needed: the assembly
  // rule's first draft was anchored on the RECEIVER, so `String.fromCodePoint`
  // matched no limb of it at all, and nothing here would have said so.
  for (const { what, pattern, catches, allows } of FORBIDDEN) {
    it(`the ${what} rule catches what it claims to`, () => {
      for (const line of catches) {
        expect(pattern.exec(foldConcatenations(line)), line).not.toBeNull();
      }
      for (const line of allows) {
        expect(pattern.exec(foldConcatenations(line)), line).toBeNull();
      }
    });
  }

  it("finds no persona or system name inside a COMPOUND identifier", () => {
    // The rule the boundary lookarounds above were reaching for and could not
    // state: `patternForSasuke` and `pattern_for_sasuke` are the same leak as a
    // bare `sasuke`, and both walked past a substring rule whose lookbehind
    // excludes a letter and an underscore. Asked at the word level it is one
    // set membership, and casing stops mattering (zheref/nen#6 item 1).
    const offences: string[] = [];
    for (const file of files) {
      file.code.split("\n").forEach((line, index): void => {
        for (const word of words(foldConcatenations(line))) {
          if (!FORBIDDEN_WORDS.has(word)) continue;
          offences.push(`${file.label}:${index + 1}: ${word} -- in: ${line.trim()}`);
        }
      });
    }
    expect(offences).toEqual([]);
  });

  it("derives no repository root from import.meta.url", () => {
    // A compiled bun binary's `import.meta.url` is `/$bunfs/...`, which is not a
    // path on any filesystem. The five constants this repo replaced were all
    // computed that way (Akatsuki migration §3); the root now comes from
    // process.cwd() at the call site plus an explicit --repo override.
    const offences: string[] = [];
    for (const file of files) {
      if (file.kind !== "ts") continue;
      if (file.code.includes("import.meta.url")) offences.push(file.label);
    }
    expect(offences).toEqual([]);
  });

  it("spawns no forbidden tool from shipped code (D16)", () => {
    // "no make, no bats/pytest, no runtime python3, no jq/yq anywhere in an
    // executed path". A binary plus git and gh is the whole requirement.
    //
    // TWO SHAPES, because the two languages spell a spawn differently. In
    // TypeScript the tool is an argv entry, so it sits against a quote. In the
    // shell it is a bare word in COMMAND POSITION -- start of line, or after a
    // pipe, `&&`, `;` or a `$(` -- and anchoring there is what keeps the
    // ordinary English of `could not make it executable` from reading as a
    // spawn.
    const inTypeScript = /["'`](make|bats|pytest|python3?|jq|yq)["'`]/;
    const inShell = /(?:^|[|&;(]|\$\()[ \t]*(?:make|bats|pytest|python3?|jq|yq)\b/;
    const offences: string[] = [];
    for (const file of files) {
      const pattern = file.kind === "ts" ? inTypeScript : inShell;
      file.code.split("\n").forEach((line, index): void => {
        const match = pattern.exec(line);
        if (match !== null) offences.push(`${file.label}:${index + 1}: ${match[0].trim()}`);
      });
    }
    expect(offences).toEqual([]);
  });
});

describe("stripComments", () => {
  // The sweep is only as trustworthy as its scanner, so the scanner has its own
  // cases -- including the two that would make a violation invisible.
  it("removes line and block comments", () => {
    expect(stripComments('const a = 1; // sasuke\n')).toBe("const a = 1; \n");
    expect(stripComments("/* sasuke */const a = 1;")).toBe("const a = 1;");
  });

  it("does NOT remove a `//` inside a string -- that would hide a violation", () => {
    expect(stripComments('const a = "https://x";')).toBe('const a = "https://x";');
    expect(stripComments("const a = `a//b`;")).toBe("const a = `a//b`;");
  });

  it("keeps string contents, which is where a hard-coded name would live", () => {
    expect(stripComments('const a = "sasuke"; // ok')).toBe('const a = "sasuke"; ');
  });

  it("preserves line numbering across a multi-line block comment", () => {
    expect(stripComments("a\n/* x\ny\n*/\nb").split("\n").length).toBe(5);
  });

  it("reads a regex literal as a regex, not as an opening quote", () => {
    // The shape zheref/nen#12 item 1 named: a splitter's character class. Read
    // flat, the `"` opens a string and everything after it vanishes.
    const scan = scanSource('const split = /["\']/;\nconst a = "sasuke";\n');
    expect(scan.unterminated).toBeNull();
    expect(scan.spanningQuotes).toEqual([]);
    expect(scan.code).toContain('"sasuke"');
  });

  it("still reads a `/` after a value as division, not as a regex", () => {
    // The other half of the disambiguation: over-eager regex detection would
    // swallow real code just as thoroughly as the bug it replaces.
    const scan = scanSource("const half = total / 2;\nconst rest = items[0] / 3;\n");
    expect(scan.code).toContain("total / 2");
    expect(scan.code).toContain("items[0] / 3");
  });

  it("follows a template literal into its `${...}` and back out", () => {
    const scan = scanSource("const a = `x ${cond ? `y '\''s z` : \"\"} w`;\nconst b = \"sasuke\";\n");
    expect(scan.unterminated).toBeNull();
    expect(scan.spanningQuotes).toEqual([]);
    expect(scan.code).toContain('"sasuke"');
  });

  it("reports the line where a quoted string ran past its own end", () => {
    // The scanner cannot be right about every construct forever; what it must
    // never do is be wrong in silence.
    const scan = scanSource("const a = 'unclosed\nconst b = 1;\n");
    expect(scan.spanningQuotes).toEqual([1]);
  });

  it("reports an unterminated template literal at EOF", () => {
    expect(scanSource("const a = `open").unterminated).toBe("`");
  });
});

describe("stripShellComments", () => {
  // Same discipline as the TypeScript scanner: the shell half is only worth its
  // exit code if the scanner under it is right about what a comment is.
  it("removes a whole-line and a trailing comment", () => {
    expect(stripShellComments("# sasuke\nx=1\n")).toBe("\nx=1\n");
    expect(stripShellComments("x=1 # sasuke\n")).toBe("x=1 \n");
  });

  it("does NOT remove a `#` inside a string -- that would hide a violation", () => {
    expect(stripShellComments('echo "bankai-core#740"')).toBe('echo "bankai-core#740"');
    expect(stripShellComments("echo 'a#b'")).toBe("echo 'a#b'");
  });

  it("does NOT treat a parameter expansion's `#` as a comment", () => {
    expect(stripShellComments('ref="${1#--ref=}"')).toBe('ref="${1#--ref=}"');
  });

  it("preserves line numbering", () => {
    expect(stripShellComments("a\n# x\n# y\nb").split("\n").length).toBe(4);
  });
});

describe("foldConcatenations", () => {
  // Each case is a way a name was assembled past the sweep before this existed.
  it("folds an adjacent pair into the value the program will hold", () => {
    expect(foldConcatenations('const a = "sas" + "uke";')).toBe('const a = "sasuke";');
  });

  it("folds a chain, not merely the first pair", () => {
    expect(foldConcatenations('const a = "s" + "as" + "uke";')).toBe('const a = "sasuke";');
  });

  it("folds across quote styles, which is how it is usually written", () => {
    expect(foldConcatenations(`const a = 'sas' + "uke";`)).toBe('const a = "sasuke";');
  });

  it("leaves a template substitution alone rather than guessing its value", () => {
    expect(foldConcatenations("const a = `${x}` + `y`;")).toBe("const a = `${x}` + `y`;");
  });

  it("leaves arithmetic and identifier addition untouched", () => {
    expect(foldConcatenations("const a = 1 + 2;")).toBe("const a = 1 + 2;");
    expect(foldConcatenations("const a = left + right;")).toBe("const a = left + right;");
  });
});

describe("words", () => {
  // The compound-identifier rule is only as good as this split, and every case
  // below is a spelling that walked past the boundary lookarounds.
  it("splits camelCase, so a suffixed name is a word", () => {
    expect(words("patternForSasuke")).toEqual(["pattern", "for", "sasuke"]);
    expect(words("sasukePattern")).toEqual(["sasuke", "pattern"]);
  });

  it("splits snake_case and kebab-case", () => {
    expect(words("pattern_for_sasuke")).toEqual(["pattern", "for", "sasuke"]);
    expect(words("pattern-for-sasuke")).toEqual(["pattern", "for", "sasuke"]);
  });

  it("splits an acronym run from the word after it", () => {
    expect(words("HTTPSasukeClient")).toEqual(["http", "sasuke", "client"]);
  });

  it("keeps a merely-containing identifier whole, so it is not an offence", () => {
    expect(words("narutoish")).toEqual(["narutoish"]);
  });
});
