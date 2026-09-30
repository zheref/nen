import { describe, expect, it } from "vitest";
import {
  classifyCommand,
  classifyInvocation,
  classifyWatchCommand,
  renderArgvForRows,
  type WatchCommandVerdict,
} from "./izanami.js";

// `nen watch until`'s own classification path (zheref/nen#288): the same table
// as classifyCommand, with a metacharacter seam that reasons over the argv the
// watch will actually spawn -- ./command-line.ts's -- instead of over the
// joined line. These tests pin both halves of that sentence: what moved (a
// metacharacter a shell would NOT act on no longer refuses, and the argv comes
// back with the verdict) and what did not (every other refusal, every row, and
// `nen parse izanami`'s own reader-agnostic seam).

const ISSUE_LINE =
  'gh pr view 295 --repo zheref/nen --json reviews --jq "[.reviews[]|select(.commit.oid|startswith(\\"ecc420c\\"))|.author.login]"';

// Every assertion below that does not name a host is about a POSIX one, where
// execve hands the argv over untouched; the Windows gate has its own block.
function onPosix(line: string): WatchCommandVerdict {
  return classifyWatchCommand(line, "linux");
}

const METACHAR_REFUSAL = /a shell metacharacter \(>, >>, \|, ;, &, <, \(, \), %, a backtick, a newline or a CR\) hands part of this line to the SHELL/;

describe("classifyWatchCommand -- a metacharacter no shell would act on is one argument (#288)", () => {
  it("accepts the issue's --jq filter as one safe read and returns the argv it vouched for", () => {
    const verdict = onPosix(ISSUE_LINE);
    expect(verdict.classification.classification).toBe("read-only");
    expect(verdict.argv).toEqual([
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

  it.each([
    ["a pipe in single quotes", "gh pr view 1 --json reviews --jq '.reviews[]|.author.login'"],
    ["a pipe in double quotes", 'gh pr view 1 --json reviews --jq ".reviews[]|.author.login"'],
    ["a semicolon, & and > in single quotes", "gh pr list --search 'a;b & c > d'"],
    ["a semicolon in double quotes", 'gh issue list --search "a;b"'],
    ["a backslash-escaped pipe", "gh pr view 1 --jq .a\\|.b"],
    ["a quote that closes mid-token", "gh pr view 1 --jq .a'|'.b"],
    ["a single-quoted $( and backtick", "gh pr view 1 --jq '$(x) `y`'"],
    ["an escaped $( inside double quotes", 'gh pr view 1 --jq "\\$(x)"'],
  ])("accepts %s", (_name, line) => {
    const verdict = onPosix(line);
    expect(verdict.classification.classification, verdict.classification.reason).toBe("read-only");
    expect(verdict.argv).toBeDefined();
  });

  it("folds a single-quoted gh api --jq with a pipe in it -- the #78 row, now reachable on the watch path", () => {
    const verdict = onPosix("gh api repos/o/r/pulls --jq '.[] | select(.draft) | .number'");
    expect(verdict.classification.classification).toBe("read-only");
    expect(verdict.argv).toEqual(["gh", "api", "repos/o/r/pulls", "--jq", ".[] | select(.draft) | .number"]);
  });

  it("returns the argv WITHOUT the quotes the #78 fold certified -- v0.17.0 spawned them literally", () => {
    const verdict = onPosix("gh api repos/o/r/pulls/1 --jq '.number'");
    expect(verdict.argv).toEqual(["gh", "api", "repos/o/r/pulls/1", "--jq", ".number"]);
  });
});

describe("classifyWatchCommand -- what a shell would act on still refuses, with the existing message", () => {
  it.each([
    "gh pr view 1 | tee leak.txt",
    "git status; git push",
    "gh issue list && git push",
    "git log > out.txt",
    "git log >> out.txt",
    "cat < x",
    "git diff `whoami`",
    "gh run list $(git push)",
    'gh pr view "$(git push)"',
    'gh pr view "`git push`"',
    'gh pr view 1 --jq ".a|$(whoami)"',
    // The issue's filter as the live evidence actually typed it: UNQUOTED, so
    // a shell really would pipe it.
    'gh pr view 123 --repo zheref/hatsu --json reviews --jq [.reviews[]|select(.commit.oid|startswith("8a822c99"))|.author.login]',
  ])("%s", (line) => {
    const verdict = onPosix(line);
    expect(verdict.classification.classification).toBe("unknown");
    expect(verdict.argv).toBeUndefined();
    // WORD FOR WORD the raw seam's sentence -- same fact, same refusal.
    expect(verdict.classification.reason).toBe(classifyCommand(line).reason);
    expect(verdict.classification.reason).toMatch(METACHAR_REFUSAL);
  });

  it("refuses a newline or CR anywhere, even inside single quotes -- prefer refusing", () => {
    for (const line of ["git log\n", "cat a.txt\ngit push", "gh pr view 1 --jq '.a\n|.b'", "git log\r"]) {
      const verdict = onPosix(line);
      expect(verdict.classification.classification, JSON.stringify(line)).toBe("unknown");
      expect(verdict.classification.reason, JSON.stringify(line)).toMatch(METACHAR_REFUSAL);
      expect(verdict.argv).toBeUndefined();
    }
  });

  it("refuses % anywhere, quoted or not -- unchanged from the raw seam", () => {
    for (const line of ["git diff %X%", "gh pr view 1 --jq '.a % 2'", 'gh pr view 1 --jq ".a % 2"']) {
      const verdict = onPosix(line);
      expect(verdict.classification.classification, line).toBe("unknown");
      expect(verdict.classification.reason, line).toMatch(METACHAR_REFUSAL);
    }
  });
});

describe("classifyWatchCommand -- a line whose argv would be a guess refuses, naming the fix", () => {
  it("refuses an unterminated quote", () => {
    for (const [line, quote] of [
      ["gh pr view 1 --jq '.a|.b", "single"],
      ['gh pr view 1 --jq ".a|.b', "double"],
    ] as const) {
      const verdict = onPosix(line);
      expect(verdict.classification.classification, line).toBe("unknown");
      expect(verdict.classification.reason, line).toContain(`the ${quote} quote at offset 18 is never closed`);
      expect(verdict.classification.reason, line).toMatch(/Close the quote/);
    }
  });

  it("refuses an unterminated quote even with NO metacharacter on the line -- a spawn would have guessed", () => {
    const verdict = onPosix("gh pr view 1 --jq '.a");
    expect(verdict.classification.classification).toBe("unknown");
    // ...where the reader-agnostic seam, which builds no argv, has nothing to refuse.
    expect(classifyCommand("gh pr view 1 --jq '.a").classification).toBe("read-only");
  });

  it("refuses a trailing backslash", () => {
    const verdict = onPosix("gh pr view 1 \\");
    expect(verdict.classification.classification).toBe("unknown");
    expect(verdict.classification.reason).toMatch(/ends in a backslash that escapes nothing/);
  });

  it("refuses whitespace other than space and tab", () => {
    const verdict = onPosix("gh pr view 1");
    expect(verdict.classification.classification).toBe("unknown");
    expect(verdict.classification.reason).toMatch(/U\+00A0 at offset 10 is whitespace other than a space or a tab/);
  });
});

describe("classifyWatchCommand -- the rest of the table is unchanged", () => {
  it("still names a mutating command first, however its arguments are quoted", () => {
    for (const line of ["git push 'a|b'", "gh pr merge 1 --body 'x|y'", 'gh pr comment 1 --body "a|b"']) {
      const verdict = onPosix(line);
      expect(verdict.classification.classification, line).toBe("mutating");
      expect(verdict.argv, line).toBeUndefined();
    }
  });

  it("still refuses a quoted line on a LINE-SCAN row -- the seam moved, the faithfulness gate did not", () => {
    for (const line of ["git log --grep 'a|b'", "git branch '-D' x", "git log '--output' f"]) {
      const verdict = onPosix(line);
      expect(verdict.classification.classification, line).not.toBe("read-only");
      expect(verdict.argv, line).toBeUndefined();
    }
  });

  // THE GH API ROW WALKS THE SPAWNED ARGV on this path (#288 review, SEC-7),
  // so a double-quoted --jq is simply the element after --jq -- one argument,
  // a GET -- while `parse izanami`, which must answer for every shell, keeps
  // refusing it and keeps telling the caller to respell it with single quotes.
  it("reads a double-quoted gh api --jq as the one argument gh receives -- parse izanami still refuses it", () => {
    const line = 'gh api repos/o/r --jq "[.a[]|.b]"';
    const verdict = onPosix(line);
    expect(verdict.classification.classification).toBe("read-only");
    expect(verdict.argv).toEqual(["gh", "api", "repos/o/r", "--jq", "[.a[]|.b]"]);
    expect(classifyCommand(line).classification).toBe("unknown");
    expect(classifyCommand('gh api repos/o/r --jq ".a"').reason).toMatch(/respell it with single quotes/);
  });

  // The #70 repro, read as the argv the watch would spawn: `-X DELETE`. That
  // is a NAMED mutating verdict now rather than an unprovable one -- the walk
  // sees the method gh would send. `parse izanami` answers exactly as #70's
  // review left it.
  it("names the #70 repro's DELETE on the watch path, and parse izanami still answers unknown", () => {
    const verdict = onPosix("gh api repos/o/r/issues -X 'DELETE'");
    expect(verdict.classification.classification).toBe("mutating");
    expect(verdict.classification.reason).toMatch(/explicit non-GET method \(DELETE\)/);
    expect(classifyCommand("gh api repos/o/r/issues -X 'DELETE'").classification).toBe("unknown");
  });

  it("still refuses an unclassified command whose argument carries a quoted pipe", () => {
    const verdict = onPosix("sh -c 'git push | x'");
    expect(verdict.classification.classification).toBe("unknown");
    expect(verdict.classification.reason).toMatch(/matches neither izanami's allowlist nor a named refusal/);
  });

  // THE EQUIVALENCE, stated as a property over a corpus: on a line with no
  // metacharacter at all and nothing the tokeniser refuses, the two seams
  // both pass and every verdict is the SAME object -- only the seam differs.
  it("agrees with classifyCommand verdict for verdict on every line with no metacharacter", () => {
    const corpus: readonly string[] = [
      "gh pr checks 1",
      "gh pr list --search is:open",
      'gh pr list --search "is:open"',
      "git log -1",
      "git log --output f",
      "git branch nen70-probe",
      "git branch --list feature/x",
      "gh api repos/o/r/issues -X=DELETE",
      "gh api repos/o/r --jq '.name'",
      "nen pr ready 925 --gh-repo owner/repo",
      "nen label apply XX-PR-#1 --label wake --repo-slug o/r --run",
      "nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake -run",
      "cat somefile.txt",
      "test -f x",
      "rm -rf x",
    ];
    for (const line of corpus) {
      expect(onPosix(line).classification, line).toEqual(classifyCommand(line));
    }
  });
});

describe("nen parse izanami keeps the reader-agnostic seam (#288 is the watch's alone)", () => {
  // Its verdict is handed to a skill-side shell -- cmd.exe included, where a
  // single quote quotes nothing and `'a|b'` IS a pipe. Relaxing it there would
  // certify a line for a reader this module never swept.
  it("still refuses a quoted pipe through classifyCommand / classifyInvocation", () => {
    for (const line of [ISSUE_LINE, "gh pr view 1 --jq '.a|.b'"]) {
      expect(classifyCommand(line).classification, line).toBe("unknown");
      expect(classifyCommand(line).reason, line).toMatch(METACHAR_REFUSAL);
      expect(classifyInvocation({ commands: [line], condition: "it settles" }).ok, line).toBe(false);
    }
  });
});

describe("classifyWatchCommand -- Windows keeps the whole-line seam until the spawn is verified there", () => {
  // A `.cmd`/`.bat` target is re-parsed by cmd.exe, where `a|b` in one argv
  // element is a pipe, and whether this runtime can resolve a bare `gh` to
  // such a shim is unverified -- so on win32 the relaxation does not apply.
  it("refuses the issue's quoted --jq pipe on win32, with the existing message", () => {
    for (const line of [ISSUE_LINE, "gh pr view 1 --jq '.a|.b'", "gh pr view 1 --jq .a\\|.b"]) {
      const verdict = classifyWatchCommand(line, "win32");
      expect(verdict.classification.classification, line).toBe("unknown");
      expect(verdict.classification.reason, line).toBe(classifyCommand(line).reason);
      expect(verdict.argv, line).toBeUndefined();
    }
  });

  it("still spawns the tokeniser's argv on win32 -- the quote-stripping fix is not Windows-gated", () => {
    const verdict = classifyWatchCommand("gh api repos/o/r/pulls/1 --jq '.number'", "win32");
    expect(verdict.classification.classification).toBe("read-only");
    expect(verdict.argv).toEqual(["gh", "api", "repos/o/r/pulls/1", "--jq", ".number"]);
  });

  it("accepts the same quoted pipe on every POSIX host", () => {
    for (const platform of ["linux", "darwin", "freebsd"] as const) {
      expect(classifyWatchCommand(ISSUE_LINE, platform).classification.classification, platform).toBe("read-only");
    }
  });
});

// #288's REVIEW (SEC-7): on the watch path EVERY row reads the argv that will
// be spawned -- gh api walks it directly, every other row reads its canonical
// rendering (./command-line.ts's renderCommandLine) -- never the caller's own
// spelling of it. These pin the rows that answer differently for that reason,
// each beside what `parse izanami` (which must answer for every shell) says.
describe("classifyWatchCommand -- every row reads the argv the watch spawns (#288 review)", () => {
  it("reads the spawned head words, not the caller's spelling of them", () => {
    // `view"x"` is `viewx` to the spawn: not a subcommand any row vouches for.
    expect(onPosix('gh pr view"x" 1').classification.classification).toBe("unknown");
    // `'pr'` is `pr` to the spawn: the plain read it looks like.
    const quotedHead = onPosix("gh 'pr' view 1");
    expect(quotedHead.classification.classification).toBe("read-only");
    expect(quotedHead.argv).toEqual(["gh", "pr", "view", "1"]);
  });

  it("names a write a quote hid from the line, because the spawn would carry it bare", () => {
    expect(onPosix("git branch '-D' x").classification.classification).toBe("mutating");
    expect(onPosix("git log '--output' f").classification.classification).toBe("mutating");
    expect(onPosix('nen label apply XX-PR-#1 --label wake --repo-slug o/r "--run"').classification.classification).toBe(
      "mutating",
    );
    expect(classifyCommand("git branch '-D' x").classification).toBe("unknown");
  });

  it("reads a line-scan row when every SPAWNED element is scan-safe, whatever quoting spelled it", () => {
    const verdict = onPosix('git log --grep "a"');
    expect(verdict.classification.classification).toBe("read-only");
    expect(verdict.argv).toEqual(["git", "log", "--grep", "a"]);
    expect(classifyCommand('git log --grep "a"').classification).toBe("unknown");
  });

  it("still refuses a line-scan row whose spawned element is outside the safe set", () => {
    expect(onPosix('git log --grep "a b"').classification.classification).toBe("unknown");
    expect(onPosix("git log --grep 'a|b'").classification.classification).toBe("unknown");
  });

  // The dry-run gate is where a quote used to DONATE a flag (#31): `--title
  // "x --dry-run"` is one argument, never the gate. Read off the spawned argv,
  // that one element is quoted in the rendering and refuses; a quoted
  // `"--dry-run"` IS the gate, because the spawned argv carries it verbatim.
  it("finds the dry-run gate only where the spawned argv carries it as its own element", () => {
    expect(onPosix('nen shu test "--dry-run"').classification.classification).toBe("read-only");
    expect(onPosix('nen shu test --lane "x --dry-run"').classification.classification).toBe("mutating");
    expect(onPosix("nen shu test --lane x\\ --dry-run").classification.classification).toBe("mutating");
  });
});

// THE TEST ROUND TWO LACKED (#288 review, round three). Its equivalence corpus
// never touched the test/[ rows, so rendering `[`, `]` and `!` quoted turned
// every `[ ... ]` read `unknown` on the watch and nothing went red. This one is
// organised by ROW, not by example: one plain spelling of every read-only row
// family the table has, each of which must get EXACTLY parse izanami's verdict
// on every host. A new row whose literal words fall outside the rendering's
// bare set fails here the day it lands.
describe("classifyWatchCommand -- every read-only row, plainly spelled, reads as parse izanami reads it", () => {
  const EVERY_ROW: readonly string[] = [
    "gh pr view 1",
    "gh pr checks 1",
    "gh pr list",
    "gh pr diff 1",
    "gh pr status",
    "gh issue view 1",
    "gh issue list",
    "gh run view 1",
    "gh run list",
    "gh run watch 1",
    "gh repo view",
    "gh api repos/o/r",
    "git status",
    "git ls-tree HEAD",
    "git log -1",
    "git diff HEAD~1",
    "git show HEAD",
    "git fetch origin",
    "git branch --list",
    "git remote -v",
    "cat a.txt",
    "type a.txt",
    "head a.txt",
    "tail -n 5 a.txt",
    "wc -l a.txt",
    "stat a.txt",
    "test -f a.txt",
    "test ! -f a.txt",
    "[ -f a.txt ]",
    "[ ! -f a.txt ]",
    "nen pr ready 1 --gh-repo o/r",
    "nen --json pr ready 1 --gh-repo o/r",
    "nen watch until --command x",
  ];

  it.each(EVERY_ROW)("%s", (line) => {
    expect(classifyCommand(line).classification, "the corpus must be reads to parse izanami").toBe("read-only");
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(classifyWatchCommand(line, platform).classification, platform).toEqual(classifyCommand(line));
    }
  });
});

describe("renderArgvForRows -- the round trip classifyWatchCommand refuses without", () => {
  it("renders `[`, `]` and `!` bare, and the rendering reads back to the argv", () => {
    expect(renderArgvForRows(["[", "!", "-f", "a b", "]"])).toEqual({ faithful: true, line: "[ ! -f 'a b' ]" });
    expect(renderArgvForRows(["test", "!", "-f", "x"])).toEqual({ faithful: true, line: "test ! -f x" });
  });

  // The refusing branch is unreachable with the real predicate -- that is the
  // point of it -- so this drives it with one that lies: it calls `a b` bare,
  // the line splits in two, and the helper must say so rather than let a row
  // read two arguments where one would be spawned.
  it("reports a rendering that does not read back as UNFAITHFUL", () => {
    expect(renderArgvForRows(["gh", "a b"], (): boolean => true)).toEqual({ faithful: false, line: "gh a b" });
    // A lie about a quote: `a'b` written bare opens a quote that never closes.
    expect(renderArgvForRows(["gh", "a'b"], (): boolean => true)).toEqual({ faithful: false, line: "gh a'b" });
    // An EMPTY element is quoted whatever the predicate says -- renderCommandLine
    // never trusts `bare` with it -- so even a lying predicate round-trips it.
    expect(renderArgvForRows(["gh", ""], (): boolean => true)).toEqual({ faithful: true, line: "gh ''" });
  });
});

describe("classifyWatchCommand -- a NUL byte refuses (defence in depth)", () => {
  it("refuses U+0000 anywhere, naming it, where a spawn would have thrown", () => {
    for (const line of ["gh pr view 1\u0000", "gh pr view '1\u0000x'", "cat a\u0000b"]) {
      const verdict = classifyWatchCommand(line, "linux");
      expect(verdict.classification.classification, JSON.stringify(line)).toBe("unknown");
      expect(verdict.classification.reason, JSON.stringify(line)).toMatch(/a NUL byte at offset \d+ can be no part of any argument/);
      expect(verdict.argv, JSON.stringify(line)).toBeUndefined();
    }
  });
});
