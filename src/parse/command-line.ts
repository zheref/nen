// src/parse/command-line.ts -- the ONE tokeniser `nen watch until` both
// classifies its --command with and spawns it from (zheref/nen#288).
//
// WHY THIS MODULE EXISTS. Through v0.17.0 the watch path carried TWO readings
// of one line, and they disagreed. ../parse/izanami.ts's metacharacter seam
// scanned the JOINED line, so a `|` anywhere refused -- including jq's own pipe
// inside a quoted `--jq` value that never meets a shell. And ../watch/command.ts
// then spawned `line.split(/\s+/)`, which keeps every quote as a literal
// character: the #78 fold certified `gh api <path> --jq '.number'` read-only,
// and the spawn handed jq the four characters `'.number'` with their quotes on,
// which jq refuses to parse. A classifier that reasons about one argument
// vector and an executor that builds another is exactly the "two tokenisers
// that can disagree" this module replaces. From here on there is one: the
// classifier tokenises with this function, decides about that argv, and the
// executor spawns the argv the classifier returned -- not a second call to it,
// the same array. "Decides about that argv" includes every row (#288's review,
// SEC-7): the gh api row walks the array itself, and every other row reads
// renderCommandLine's rendering of it, below, which tokenises back to exactly
// that array.
//
// WHAT IT MODELS: POSIX sh QUOTING (XCU 2.2) AND WORD BOUNDARIES (2.3), AND
// NOTHING ELSE. The executor spawns with NO shell, so the only reason to model
// a shell at all is that a human types these lines as they would at a
// terminal -- `--jq "[.a[]|.b]"` must arrive at gh as the one argument a shell
// would have built, not as eleven characters of quotes and filter.
//
//   * ASCII space and tab separate words when unquoted, and nothing else does.
//   * `'...'` is literal, whatever it carries, up to the next `'`.
//   * `"..."` is literal EXCEPT that a backslash escapes `$`, a backtick, `"`
//     and itself (and is kept, with what follows it, before anything else --
//     `"\a"` is the two characters `\a`, exactly as sh has it).
//   * An unquoted backslash escapes the next character, whatever it is.
//   * Adjacent pieces join: `a'|'b` is ONE word, `a|b`.
//
// WHAT IT REFUSES TO TOKENISE, each in the refusing direction, because a line
// the executor cannot build faithfully is a line no verdict can be about:
//
//   * A metacharacter a shell would ACT ON -- an unquoted `| & ; < > ( )` or
//     backtick, and a backtick or `$(` inside double quotes, where sh still
//     substitutes. Each one hands part of the line to a SECOND command in a
//     shell, and although this executor would pass it through as a literal,
//     a line that means two commands at a terminal and one here is a line
//     whose author and whose watch disagree about what is being observed.
//     Inside single quotes, or escaped, sh acts on none of them, and neither
//     does this tokeniser: that is the whole of #288.
//   * A newline or a CR ANYWHERE, quoted or not. Unquoted, a newline is a
//     command separator in every shell; quoted, sh would keep it literal, but
//     the caller's line is then a multi-line string whose quoting a reader
//     has to get exactly right to see one command -- and the classifier's own
//     seam has always refused both outright. Prefer refusing.
//   * An unterminated quote, or a trailing unquoted backslash. A shell would
//     wait for more input; there is no more input, so where the last argument
//     ends is a guess.
//   * A NUL byte (U+0000), ANYWHERE (#288 review, defence in depth). An argv
//     element is a C string to the operating system, so a NUL ends it: the
//     argument a program receives is not the one the classifier read. Bun's
//     spawn throws on one before that happens, which would surface as an
//     observation error rather than a refusal; refusing here makes it a
//     named exit 2 instead, and keeps the contract "an argv this function
//     returns is one a program can receive whole".
//   * Whitespace other than ASCII space and tab, ANYWHERE. U+00A0 and its
//     siblings are ordinary characters to sh, a word boundary to PowerShell,
//     and a `\s` to every row pattern ../parse/izanami.ts matches the line
//     against -- so the classifier and this tokeniser would place the word
//     boundaries differently, which is the one thing this module exists to
//     rule out.
//
// WHAT IT DELIBERATELY DOES NOT MODEL, stated so nobody mistakes the silence
// for coverage: parameter expansion (`$VAR`, `${x}`), globbing (`* ? [`),
// tilde expansion, brace expansion and word-initial `#` comments. The
// executor spawns without a shell, so none of them HAPPENS -- each reaches the
// command as the literal characters typed, exactly as it did through v0.17.0
// -- and none of them starts a second command, which is the line the
// classifier's seam draws. What the rows see of such an element is the literal
// argument the spawn will pass. The gh api row walks the argv itself, so a
// `$X` there is simply an argument gh receives (an endpoint `$X` is a GET of
// that path; a `--jq '$__loc__'` is a jq program) and is judged by its
// POSITION -- flag, value, endpoint -- as gh's pflag would. Every other row
// reads the rendering, where an element carrying `$`, a glob character or a
// word-initial `#` is single-quoted (it is outside ../parse/izanami.ts's
// scan-safe set), so a row that scans its arguments refuses it as it always
// has, and a row that reads only its head words reads head words that are
// plain. `~` is scan-safe and rendered bare; no verdict turns on it.

/** Where a refused metacharacter sat: bare on the line, or inside `"..."`. */
export type ShellActiveContext = "unquoted" | "double-quoted";

/**
 * Why a line did not tokenise. `shell-active` and `line-separator` are the
 * cases ../parse/izanami.ts answers with its existing metacharacter refusal,
 * word for word; the other three name their own fact and fix.
 */
export type TokenizeRefusal =
  | { readonly kind: "shell-active"; readonly char: string; readonly index: number; readonly context: ShellActiveContext }
  | { readonly kind: "line-separator"; readonly index: number }
  | { readonly kind: "unterminated-quote"; readonly quote: "'" | '"'; readonly index: number }
  | { readonly kind: "trailing-backslash"; readonly index: number }
  | { readonly kind: "exotic-whitespace"; readonly codePoint: number; readonly index: number }
  | { readonly kind: "nul-byte"; readonly index: number };

export type TokenizeResult =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly refusal: TokenizeRefusal };

// A shell's control and redirection operators, plus the parentheses of a
// subshell or (in PowerShell's argument mode) a subexpression. `&&`, `||`,
// `>>` and `2>&1` are all spelled with these; `$(` is caught at its `(` when
// unquoted, and by name inside double quotes below.
const OPERATORS: ReadonlySet<string> = new Set(["|", "&", ";", "<", ">", "(", ")"]);

// The four characters a backslash escapes INSIDE double quotes (XCU 2.2.3; the
// fifth, newline, never reaches here -- see LINE_SEPARATOR). Before anything
// else the backslash is an ordinary character and is kept.
const DOUBLE_QUOTE_ESCAPABLE: ReadonlySet<string> = new Set(["$", "`", '"', "\\"]);

const LINE_SEPARATOR = /[\n\r]/;

// Every character JavaScript's `\s` matches EXCEPT ASCII space and tab --
// which is to say, every whitespace the classifier's row patterns would split
// on and this tokeniser would not. (Newline and CR are in it too, and are
// caught first, by LINE_SEPARATOR, so they keep their own refusal.)
const EXOTIC_WHITESPACE = /[^\S \t]/;

function refuse(refusal: TokenizeRefusal): TokenizeResult {
  return { ok: false, refusal };
}

/**
 * Split one command line into the argument vector a POSIX shell would build
 * from it -- or refuse, naming the first thing that makes that vector
 * unprovable. See this file's header for exactly what is modelled and what is
 * not.
 *
 * THE ARGV IS ONLY EVER RETURNED WHOLE. There is no partial result for a
 * refused line, so a caller cannot spawn "what tokenised so far" by accident.
 */
export function tokenizeCommandLine(line: string): TokenizeResult {
  // Checked over the whole line before anything is read, so a quoted newline
  // refuses exactly as a bare one does -- the header says why.
  const separator = LINE_SEPARATOR.exec(line);
  if (separator !== null) return refuse({ kind: "line-separator", index: separator.index });
  const nul = line.indexOf("\u0000");
  if (nul !== -1) return refuse({ kind: "nul-byte", index: nul });
  const exotic = EXOTIC_WHITESPACE.exec(line);
  if (exotic !== null) {
    return refuse({ kind: "exotic-whitespace", codePoint: exotic[0].codePointAt(0) ?? 0, index: exotic.index });
  }

  const argv: string[] = [];
  let word = "";
  // Whether a word has STARTED, separately from whether it has characters: an
  // empty quoted pair (`""`, `''`) is one empty argument to a shell, and a
  // `word !== ""` test would drop it.
  let inWord = false;
  let index = 0;

  while (index < line.length) {
    const char = line.charAt(index);

    if (char === " " || char === "\t") {
      if (inWord) {
        argv.push(word);
        word = "";
        inWord = false;
      }
      index += 1;
      continue;
    }

    if (char === "\\") {
      if (index + 1 >= line.length) return refuse({ kind: "trailing-backslash", index });
      word += line.charAt(index + 1);
      inWord = true;
      index += 2;
      continue;
    }

    if (char === "'") {
      const close = line.indexOf("'", index + 1);
      if (close === -1) return refuse({ kind: "unterminated-quote", quote: "'", index });
      word += line.slice(index + 1, close);
      inWord = true;
      index = close + 1;
      continue;
    }

    if (char === '"') {
      const open = index;
      inWord = true;
      index += 1;
      for (;;) {
        if (index >= line.length) return refuse({ kind: "unterminated-quote", quote: '"', index: open });
        const inner = line.charAt(index);
        if (inner === '"') {
          index += 1;
          break;
        }
        if (inner === "\\") {
          // A backslash as the LAST character inside an open double quote
          // escapes the end of input, which is the unterminated quote.
          if (index + 1 >= line.length) return refuse({ kind: "unterminated-quote", quote: '"', index: open });
          const escaped = line.charAt(index + 1);
          if (DOUBLE_QUOTE_ESCAPABLE.has(escaped)) {
            word += escaped;
            index += 2;
          } else {
            word += "\\";
            index += 1;
          }
          continue;
        }
        // Double quotes stop word splitting and the operators; they do NOT
        // stop command substitution, which is the half of sh's double-quote
        // rule a "quoted means safe" shortcut gets wrong.
        if (inner === "`") return refuse({ kind: "shell-active", char: "`", index, context: "double-quoted" });
        if (inner === "$" && line.charAt(index + 1) === "(") {
          return refuse({ kind: "shell-active", char: "$(", index, context: "double-quoted" });
        }
        word += inner;
        index += 1;
      }
      continue;
    }

    if (OPERATORS.has(char) || char === "`") {
      return refuse({ kind: "shell-active", char, index, context: "unquoted" });
    }

    word += char;
    inWord = true;
    index += 1;
  }

  if (inWord) argv.push(word);
  return { ok: true, argv };
}

/**
 * The inverse of tokenizeCommandLine: one line that tokenises back to exactly
 * `argv` (zheref/nen#288 review, SEC-7).
 *
 * WHY IT EXISTS. ../parse/izanami.ts's rows are regexes and scans over a LINE,
 * and on the watch path the thing they must be right about is the ARGV that is
 * spawned. Handing them the caller's own line made every row's verdict a claim
 * about a string the spawn never runs -- the review proved that costs a DELETE
 * on the one row (gh api) that folded a value. Handing them THIS rendering
 * makes each row read the spawned argv in the only form a row can read: every
 * element the caller's `bare` predicate accepts is written as it is, and every
 * other one -- empty, quoted, spaced, carrying a metacharacter -- inside single
 * quotes, with an inner `'` spelled `'\''`. A row that scans arguments then
 * sees those quotes and refuses exactly as it always has; a row that reads
 * only its head words reads the argv's head words, not the caller's spelling
 * of them.
 *
 * THE ROUND TRIP IS THE CONTRACT, and it is checked where it is relied on
 * (classifyWatchCommand refuses if tokenising this line does not give `argv`
 * back) as well as pinned in ./command-line.test.ts -- a caller whose `bare`
 * predicate admits a quote, a blank or an operator gets a refusal, not a
 * silently different argv.
 */
export function renderCommandLine(argv: readonly string[], bare: (argument: string) => boolean): string {
  return argv
    .map((argument): string => (argument !== "" && bare(argument) ? argument : `'${argument.replace(/'/g, "'\\''")}'`))
    .join(" ");
}
