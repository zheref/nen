import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderCommandLine, tokenizeCommandLine, type TokenizeRefusal } from "./command-line.js";
import { isScanFaithfulToken } from "./izanami.js";

// The tokeniser `nen watch until` classifies AND spawns with (zheref/nen#288).
// Two halves: the argv it builds must be the argv a POSIX shell builds from the
// same line -- proven against a REAL `sh` below, not only against expectations
// written by the same hand as the code -- and every line whose argv would be a
// guess must refuse, naming why.

function argvOf(line: string): readonly string[] {
  const result = tokenizeCommandLine(line);
  if (!result.ok) throw new Error(`expected '${line}' to tokenise, refused: ${JSON.stringify(result.refusal)}`);
  return result.argv;
}

function refusalOf(line: string): TokenizeRefusal {
  const result = tokenizeCommandLine(line);
  if (result.ok) throw new Error(`expected '${line}' to refuse, tokenised: ${JSON.stringify(result.argv)}`);
  return result.refusal;
}

// The issue's own line, as the AC spells it, with a real SHA prefix.
const ISSUE_LINE =
  'gh pr view 295 --repo zheref/nen --json reviews --jq "[.reviews[]|select(.commit.oid|startswith(\\"ecc420c\\"))|.author.login]"';

describe("tokenizeCommandLine -- POSIX quoting, and nothing a shell would act on", () => {
  it("builds the issue's --jq filter as ONE argument, pipes and escaped quotes included (#288)", () => {
    expect(argvOf(ISSUE_LINE)).toEqual([
      "gh",
      "pr",
      "view",
      "295",
      "--repo",
      "zheref/nen",
      "--json",
      "reviews",
      "--jq",
      '[.reviews[]|select(.commit.oid|startswith("ecc420c"))|.author.login]',
    ]);
  });

  it("keeps single-quoted content literal, every metacharacter included", () => {
    expect(argvOf("gh pr view 1 --jq '.a | .b; .c & .d > .e < .f (g) `h` $(i) $j'")).toEqual([
      "gh",
      "pr",
      "view",
      "1",
      "--jq",
      ".a | .b; .c & .d > .e < .f (g) `h` $(i) $j",
    ]);
  });

  it("keeps a pipe, a semicolon and parentheses inside double quotes as one argument", () => {
    expect(argvOf('x "a|b;c&&d>e<f(g)"')).toEqual(["x", "a|b;c&&d>e<f(g)"]);
  });

  it("joins a quote that closes mid-token into one word: a'|'b is a|b", () => {
    expect(argvOf("x a'|'b")).toEqual(["x", "a|b"]);
    expect(argvOf('x a"|"b')).toEqual(["x", "a|b"]);
  });

  it("treats a backslash-escaped metacharacter as a literal: \\| is |", () => {
    expect(argvOf("x a\\|b \\; \\& \\> \\( \\`")).toEqual(["x", "a|b", ";", "&", ">", "(", "`"]);
  });

  it("follows sh's double-quote escapes: only $ ` \" and \\ are escapable, anything else keeps its backslash", () => {
    expect(argvOf('x "a\\"b" "a\\\\b" "a\\$b" "a\\`b" "a\\nb"')).toEqual(["x", 'a"b', "a\\b", "a$b", "a`b", "a\\nb"]);
  });

  it("keeps an empty quoted pair as one empty argument, as a shell does", () => {
    expect(argvOf("x \"\" ''")).toEqual(["x", "", ""]);
  });

  it("splits on ASCII space and tab only, and skips leading/trailing blanks", () => {
    expect(argvOf(" \tgh\tpr  view \t1 \t")).toEqual(["gh", "pr", "view", "1"]);
  });

  it("passes $VAR, globs, ~ and # through literally -- nothing expands, because nothing is a shell", () => {
    expect(argvOf("x $HOME ${Y} *.ts ~/a #c \"$Z\"")).toEqual(["x", "$HOME", "${Y}", "*.ts", "~/a", "#c", "$Z"]);
  });
});

describe("tokenizeCommandLine -- what a shell would ACT on refuses, by name", () => {
  it.each([
    ["an unquoted pipe", "gh pr view 1 | tee x", "|"],
    ["an unquoted semicolon", "gh pr view 1; git push", ";"],
    ["an unquoted &&", "gh pr view 1 && git push", "&"],
    ["an unquoted redirection", "git log > out.txt", ">"],
    ["an unquoted input redirection", "cat < x", "<"],
    ["an unquoted subshell", "git diff (git push)", "("],
    ["an unquoted $(", "gh run list $(git push)", "("],
    ["an unquoted backtick", "git diff `whoami`", "`"],
    ["a pipe glued to a word", "gh pr view 1|tee x", "|"],
    ["the issue's UNQUOTED filter", 'gh pr view 1 --jq [.a[]|select(.b|startswith("x"))]', "|"],
  ])("%s", (_name, line, char) => {
    const refusal = refusalOf(line);
    expect(refusal).toMatchObject({ kind: "shell-active", char, context: "unquoted" });
  });

  it("refuses $( and a backtick INSIDE double quotes -- a shell still substitutes there", () => {
    expect(refusalOf('gh pr view "$(git push)"')).toMatchObject({ kind: "shell-active", char: "$(", context: "double-quoted" });
    expect(refusalOf('gh pr view "`git push`"')).toMatchObject({ kind: "shell-active", char: "`", context: "double-quoted" });
    expect(refusalOf('gh pr view --jq ".a|$(whoami)"')).toMatchObject({ kind: "shell-active", char: "$(" });
  });

  it("does NOT refuse an escaped $( or backtick inside double quotes -- the backslash disarms it", () => {
    expect(argvOf('x "\\$(y)" "\\`z\\`"')).toEqual(["x", "$(y)", "`z`"]);
  });

  it("refuses the first shell-active character even after a quoted one", () => {
    expect(refusalOf("x 'a|b' | c")).toMatchObject({ kind: "shell-active", char: "|", index: 8 });
  });
});

describe("tokenizeCommandLine -- a line whose argv would be a guess refuses", () => {
  it("refuses a newline or CR anywhere -- bare, single-quoted or double-quoted", () => {
    for (const line of ["git log\n", "git log\ngit push", "x 'a\nb'", 'x "a\nb"', "x 'a\rb'", "git log\r"]) {
      expect(refusalOf(line).kind, JSON.stringify(line)).toBe("line-separator");
    }
  });

  it("refuses an unterminated single or double quote, naming where it opened", () => {
    expect(refusalOf("gh pr view 1 --jq '.a")).toEqual({ kind: "unterminated-quote", quote: "'", index: 18 });
    expect(refusalOf('gh pr view 1 --jq ".a')).toEqual({ kind: "unterminated-quote", quote: '"', index: 18 });
    // A backslash-escaped closing quote does not close it.
    expect(refusalOf('x "a\\"')).toEqual({ kind: "unterminated-quote", quote: '"', index: 2 });
    // A backslash as the last character inside an open double quote.
    expect(refusalOf('x "a\\')).toEqual({ kind: "unterminated-quote", quote: '"', index: 2 });
    // A backslash cannot escape a single quote's close -- inside '...' nothing is special.
    expect(argvOf("x 'a\\' b")).toEqual(["x", "a\\", "b"]);
  });

  it("refuses a trailing unquoted backslash", () => {
    expect(refusalOf("gh pr view 1 \\")).toEqual({ kind: "trailing-backslash", index: 13 });
  });

  // Defence in depth (#288 review, round three): an argv element is a C string
  // to the operating system, so a NUL ends it -- a program would receive a
  // different argument than the one tokenised. Refused anywhere, quoted or not.
  it("refuses a NUL byte anywhere -- bare, single-quoted or double-quoted", () => {
    expect(refusalOf("gh pr view 1\u0000")).toEqual({ kind: "nul-byte", index: 12 });
    expect(refusalOf("x 'a\u0000b'")).toEqual({ kind: "nul-byte", index: 4 });
    expect(refusalOf('x "a\u0000b"')).toEqual({ kind: "nul-byte", index: 4 });
  });

  it("refuses whitespace other than space and tab, quoted or not -- the readers disagree about it", () => {
    expect(refusalOf("gh pr view 1")).toEqual({ kind: "exotic-whitespace", codePoint: 0xa0, index: 5 });
    expect(refusalOf("x 'a b'")).toMatchObject({ kind: "exotic-whitespace", codePoint: 0x2003 });
    expect(refusalOf("x\u000bb")).toMatchObject({ kind: "exotic-whitespace", codePoint: 0x0b });
  });
});

// THE DIFFERENTIAL HALF. Every expectation above was written by the same hand
// as the tokeniser, so it proves consistency, not correctness. This block asks
// a real POSIX shell for the argv of the same lines and requires the two to
// agree -- the corpus is every accepted shape above that sh does NOT expand
// (no $VAR, no glob, no ~, no #), since those are the ones this tokeniser
// deliberately leaves literal and a shell deliberately does not.
function hasSh(): boolean {
  const probe = spawnSync("sh", ["-c", "exit 0"], { encoding: "utf8" });
  return probe.error === undefined && probe.status === 0;
}

const SH = hasSh();

function shArgv(line: string): readonly string[] {
  const result = spawnSync("sh", ["-c", `printf '%s\\n' ${line}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sh refused '${line}': ${result.stderr}`);
  return result.stdout.replace(/\r\n/g, "\n").split("\n").slice(0, -1);
}

const AGREED_CORPUS: readonly string[] = [
  ISSUE_LINE,
  "gh pr view 1 --jq '.a | .b; .c & .d > .e < .f (g) `h` $(i) $j'",
  'x "a|b;c&&d>e<f(g)"',
  "x a'|'b",
  'x a"|"b',
  "x a\\|b \\; \\& \\> \\( \\`",
  'x "a\\"b" "a\\\\b" "a\\$b" "a\\`b" "a\\nb"',
  "x \"\" ''",
  " \tgh\tpr  view \t1 \t",
  "x 'it'\"'\"'s'",
  "x a\"b\"'c'\\d",
  "x 'a\\' b",
  'x "\\$(y)" "\\`z\\`"',
  "gh api repos/o/r --jq '.[] | select(.x) | .y'",
];

describe.skipIf(!SH)("tokenizeCommandLine -- agrees with a real sh, argument for argument", () => {
  it.each(AGREED_CORPUS)("%s", (line) => {
    expect(argvOf(line)).toEqual(shArgv(line));
  });

  // And the refusal is about something REAL: inside double quotes a shell
  // still runs the substitution, which is why "quoted" is not "inert" there.
  it("sh really does substitute $( and a backtick inside double quotes", () => {
    expect(shArgv('x "a$(printf X)b" "c`printf Y`d"')).toEqual(["x", "aXb", "cYd"]);
  });
});

// renderCommandLine: the rendering every non-gh-api row reads on the watch
// path (#288 review, SEC-7). Its whole contract is the ROUND TRIP -- the line
// must tokenise back to exactly the argv -- checked here against the
// tokeniser and against a real sh, and at runtime by classifyWatchCommand.
describe("renderCommandLine -- tokenises back to exactly the argv", () => {
  const ARGVS: readonly (readonly string[])[] = [
    ["gh", "pr", "view", "1"],
    ["gh", "api", "repos/o/r/issues/1", "-q", "-H", "-XDELETE"],
    ["x", ""],
    ["x", "a b", "\tc"],
    ["x", "it's", "'", "''"],
    ["x", "a|b;c&d>e<f(g)`h`"],
    ["x", "$HOME", "${Y}", "$(z)", "*.ts", "?"],
    ["x", "\\", "a\\b", 'say "hi"'],
    ["x", "#c", "@a", ",x", "x,", "XX-PR-#1", "a@b", "a,b"],
    ["x", "-", "--", "--dry-run", "--repo=", "-q="],
    ['[.reviews[]|select(.commit.oid|startswith("ecc420c"))|.author.login]'],
  ];

  it.each(ARGVS)("round-trips %j", (...argv) => {
    const rendered = renderCommandLine(argv, isScanFaithfulToken);
    expect(tokenizeCommandLine(rendered)).toEqual({ ok: true, argv });
  });

  it("writes a scan-safe element bare and quotes everything else", () => {
    expect(renderCommandLine(["gh", "pr", "view", "1"], isScanFaithfulToken)).toBe("gh pr view 1");
    expect(renderCommandLine(["x", "", "a b", "it's", "#c"], isScanFaithfulToken)).toBe("x '' 'a b' 'it'\\''s' '#c'");
  });

  // Why classifyWatchCommand checks the round trip rather than trusting it: a
  // `bare` predicate that admits a blank would render two arguments as one.
  it("is only as good as its bare predicate -- a lying one breaks the round trip", () => {
    expect(tokenizeCommandLine(renderCommandLine(["a b"], (): boolean => true))).toEqual({ ok: true, argv: ["a", "b"] });
  });
});

describe.skipIf(!SH)("renderCommandLine -- a real sh reads it back to the same argv", () => {
  // Word-initial `~` is the one scan-safe character sh expands and this
  // tokeniser does not; no element here starts with one.
  it.each([
    ["gh", "api", "repos/o/r/issues/1", "-q", "-H", "-XDELETE"],
    ["x", ""],
    ["x", "a b", "it's", "a|b;c&d>e<f(g)`h`", "$HOME", "$(z)", "*.ts", "\\", 'say "hi"', "#c", "@a"],
  ])("%j", (...argv) => {
    expect(shArgv(renderCommandLine(argv, isScanFaithfulToken))).toEqual(argv);
  });
});
