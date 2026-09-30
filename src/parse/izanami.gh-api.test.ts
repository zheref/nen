import { describe, expect, it } from "vitest";
import { run, type Io } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { tokenizeCommandLine } from "./command-line.js";
import { classifyCommand, classifyGhApiArgv, classifyWatchCommand } from "./izanami.js";

// zheref/nen#288's review (SEC-7, QA-18): a value flag whose value is EMPTY or
// a bare `=` must never let the classifier and gh disagree about which
// argument is a flag. Two live fail-opens, both verified against the real gh
// 2.100.0 with GH_DEBUG=api against an unresolvable host:
//
//   * `-q''` -- a shell (and the watch's tokeniser) hands gh a BARE `-q`,
//     which takes the NEXT argument as its value; the #78 fold read it as `-q`
//     carrying a placeholder. `-q'' -H -XDELETE` sent DELETE.
//   * `-q=` -- pflag gives it the value "=" and parses the next argument as a
//     flag of its own; the walk stripped the `=` and took the next argument as
//     the value. `-q= -XDELETE` sent DELETE -- on a line with no quote in it,
//     so v0.15.1's `parse izanami` certified it too.

const WRITES_THE_REVIEW_PROVED: readonly string[] = [
  "gh api repos/o/r/issues/1 -q'' -H -XDELETE",
  "gh api repos/o/r/issues/1 -q'' -H -ftitle=x",
  "gh api repos/o/r/issues/1 -q'' -H --method=DELETE",
  "gh api repos/o/r/issues -q'' -p --input=/etc/hosts",
];

const WRITES_FOUND_SETTLING_IT: readonly string[] = [
  'gh api repos/o/r/issues/1 -q"" -H -XDELETE',
  "gh api repos/o/r/issues/1 -q= -XDELETE",
  "gh api repos/o/r/issues/1 -H= --method=DELETE",
  "gh api repos/o/r/issues/1 -p= -ftitle=x",
  "gh api repos/o/r/issues/1 -t= --input=body.json",
  "gh api repos/o/r/issues/1 -iq= -XDELETE",
];

describe("SEC-7 -- an empty or bare-= value never hides the next flag", () => {
  it.each([...WRITES_THE_REVIEW_PROVED, ...WRITES_FOUND_SETTLING_IT])("refuses %s on every path and host", (line) => {
    expect(classifyCommand(line).classification, "parse izanami").not.toBe("read-only");
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const verdict = classifyWatchCommand(line, platform);
      // The watch walks the argv gh would get, so it SEES the write and names it.
      expect(verdict.classification.classification, platform).toBe("mutating");
      expect(verdict.argv, platform).toBeUndefined();
    }
  });

  it("walks the spawned argv of the review's first repro exactly as gh parses it", () => {
    expect(tokenizeCommandLine("gh api repos/o/r/issues/1 -q'' -H -XDELETE")).toEqual({
      ok: true,
      argv: ["gh", "api", "repos/o/r/issues/1", "-q", "-H", "-XDELETE"],
    });
    const verdict = classifyGhApiArgv(["gh", "api", "repos/o/r/issues/1", "-q", "-H", "-XDELETE"]);
    expect(verdict).toEqual({ classification: "mutating", reason: "gh api with an explicit non-GET method (DELETE)" });
  });

  it("still reads a NON-EMPTY value in every spelling the #78 fold takes", () => {
    for (const line of [
      "gh api repos/o/r --jq '.name'",
      "gh api repos/o/r -q'.name'",
      "gh api repos/o/r -q '.name'",
      "gh api repos/o/r -q='.name'",
      "gh api repos/o/r --jq='.name'",
    ]) {
      expect(classifyCommand(line).classification, line).toBe("read-only");
      expect(classifyWatchCommand(line, "linux").classification.classification, line).toBe("read-only");
    }
  });

  // The EMPTY `=`-attached spellings, pinned by name (round three). They are
  // not the `-q''` shape: `--jq=` carries the value "" and `-q=` the value
  // "=", so neither takes the next argument -- verified against gh 2.100.0,
  // where each alone sent GET and each followed by -XDELETE sent DELETE. So:
  // `parse izanami` refuses them (the fold takes only a non-empty value, and
  // the quote left behind keeps the line unfaithful); the watch READS them,
  // because the argv it would spawn is a GET; and on both, the next flag is
  // walked as a flag -- a write after one is never hidden.
  it("refuses the empty =-attached spellings under parse izanami, reads them on the watch, and never hides the next flag", () => {
    for (const line of ["gh api repos/o/r --jq=''", "gh api repos/o/r -q=''", 'gh api repos/o/r --jq=""', 'gh api repos/o/r -q=""']) {
      expect(classifyCommand(line).classification, line).toBe("unknown");
      expect(classifyWatchCommand(line, "linux").classification.classification, line).toBe("read-only");
      expect(classifyCommand(`${line} -XDELETE`).classification, `${line} -XDELETE`).toBe("mutating");
      for (const platform of ["linux", "darwin", "win32"] as const) {
        expect(classifyWatchCommand(`${line} -XDELETE`, platform).classification.classification, `${platform}: ${line} -XDELETE`).toBe(
          "mutating",
        );
      }
    }
  });

  // gh 2.100.0's one new flag, entered as the no-value boolean it was verified
  // to be (GH_DEBUG=api, round three): it never takes the next argument and
  // never changes the request. Before, it refused as unclassified.
  it("reads --allow-escape-sequences as a no-value boolean, and still sees a write after it", () => {
    expect(classifyGhApiArgv(["gh", "api", "repos/o/r", "--allow-escape-sequences"]).classification).toBe("read-only");
    expect(classifyGhApiArgv(["gh", "api", "repos/o/r", "--allow-escape-sequences", "-XDELETE"]).classification).toBe("mutating");
    expect(classifyGhApiArgv(["gh", "api", "repos/o/r", "--allow-escape-sequences=true", "-ftitle=x"]).classification).toBe(
      "mutating",
    );
    expect(classifyCommand("gh api repos/o/r --allow-escape-sequences").classification).toBe("read-only");
    // A flag no gh this table was read from lists still refuses, naming the version.
    const unknown = classifyGhApiArgv(["gh", "api", "repos/o/r", "--frobnicate"]);
    expect(unknown.classification).toBe("unknown");
    expect(unknown.reason).toMatch(/lists on gh 2\.100\.0; a flag a newer gh adds refuses until it is classified/);
  });

  it("reads -q= as pflag does: '=' is the value, and the next argument is walked as a flag", () => {
    expect(classifyGhApiArgv(["gh", "api", "repos/o/r", "-q=", "--paginate"]).classification).toBe("read-only");
    expect(classifyGhApiArgv(["gh", "api", "repos/o/r", "-q=", "-XDELETE"]).classification).toBe("mutating");
    // An `=` WITH something after it is pflag's `-X=v` form: v is the value.
    expect(classifyGhApiArgv(["gh", "api", "repos/o/r", "-X=DELETE"]).classification).toBe("mutating");
    expect(classifyGhApiArgv(["gh", "api", "repos/o/r", "-X=GET"]).classification).toBe("read-only");
    // A bare `-X=` is the method "=", which no scan can resolve to a GET.
    expect(classifyGhApiArgv(["gh", "api", "repos/o/r", "-X=", "GET"]).classification).toBe("unknown");
  });

  // THE WALK READS gh's ARGUMENTS, not a line that stands for them: a header
  // value with a space in it is ONE argument after `-H`, a GET. Read off any
  // line -- even the argv's own rendering, where that element must be quoted
  // -- the space splits it, the second half is a stray positional, and the
  // read refuses. `parse izanami` still refuses it, as it must for any shell.
  it("walks a spaced header value as the one argument gh receives", () => {
    const line = 'gh api repos/o/r -H "Accept: application/vnd.github+json" --jq ".[] | .name"';
    const verdict = classifyWatchCommand(line, "linux");
    expect(verdict.classification.classification).toBe("read-only");
    expect(verdict.argv).toEqual(["gh", "api", "repos/o/r", "-H", "Accept: application/vnd.github+json", "--jq", ".[] | .name"]);
    expect(classifyCommand(line).classification).toBe("unknown");
  });

  it("counts an EMPTY argument as the positional pflag makes it", () => {
    expect(classifyGhApiArgv(["gh", "api", "repos/o/r", ""]).classification).toBe("unknown");
  });

  it("refuses an argv whose second element is not exactly 'api'", () => {
    expect(classifyGhApiArgv(["gh", "apix", "repos/o/r"]).classification).toBe("unknown");
    expect(classifyWatchCommand("gh api'x' repos/o/r", "linux").classification.classification).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// QA-18 -- the adversarial table, against an INDEPENDENT oracle.
//
// pflag's own argument loop, transcribed from spf13/pflag's flag.go
// (parseArgs, parseLongArg, parseSingleShortArg) -- NOT from izanami.ts's walk
// -- over gh 2.100.0's `gh api` flag set, plus gh's own two request rules (an
// explicit method wins; otherwise any field or --input makes it POST) and its
// ExactArgs(1). It answers what gh would SEND for an argument vector, so a
// verdict is checked against the request rather than against a second copy of
// the classifier's reasoning. Its rules were confirmed against the real gh
// with GH_DEBUG=api while settling SEC-7 (`-q -H -XDELETE` -> DELETE, `-q=
// -XDELETE` -> DELETE, `-X= GET` -> "accepts 1 arg(s), received 2").
// ---------------------------------------------------------------------------

type OracleKind = "bool" | "string" | "method" | "field";

const ORACLE_LONG: Readonly<Record<string, OracleKind>> = {
  "allow-escape-sequences": "bool",
  cache: "string",
  field: "field",
  header: "string",
  help: "bool",
  hostname: "string",
  include: "bool",
  input: "field",
  jq: "string",
  method: "method",
  paginate: "bool",
  preview: "string",
  "raw-field": "field",
  silent: "bool",
  slurp: "bool",
  template: "string",
  verbose: "bool",
};

const ORACLE_SHORT: Readonly<Record<string, string>> = {
  F: "field",
  H: "header",
  X: "method",
  f: "raw-field",
  i: "include",
  p: "preview",
  q: "jq",
  t: "template",
};

type OracleRequest = { readonly sent: false } | { readonly sent: true; readonly method: string; readonly endpoint: string };

function oracleRequest(args: readonly string[]): OracleRequest {
  let method: string | undefined;
  let fields = false;
  const positionals: string[] = [];
  const apply = (name: string, value: string): void => {
    const kind = ORACLE_LONG[name];
    if (kind === "method") method = value;
    if (kind === "field") fields = true;
  };
  let at = 0;
  while (at < args.length) {
    const arg = args[at] ?? "";
    at += 1;
    if (arg.length === 0 || !arg.startsWith("-") || arg.length === 1) {
      positionals.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      if (arg.length === 2) {
        positionals.push(...args.slice(at));
        break;
      }
      const body = arg.slice(2);
      if (body.startsWith("-") || body.startsWith("=")) return { sent: false };
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      const kind = ORACLE_LONG[name];
      if (kind === undefined) return { sent: false };
      let value: string;
      if (eq !== -1) value = body.slice(eq + 1);
      else if (kind === "bool") value = "true";
      else if (at < args.length) {
        value = args[at] ?? "";
        at += 1;
      } else return { sent: false };
      apply(name, value);
      continue;
    }
    let shorthands = arg.slice(1);
    while (shorthands.length > 0) {
      if (shorthands.startsWith("test.")) break;
      const name = ORACLE_SHORT[shorthands.charAt(0)];
      if (name === undefined) return { sent: false };
      const kind = ORACLE_LONG[name];
      let value: string;
      if (shorthands.length > 2 && shorthands.charAt(1) === "=") {
        value = shorthands.slice(2);
        shorthands = "";
      } else if (kind === "bool") {
        value = "true";
        shorthands = shorthands.slice(1);
      } else if (shorthands.length > 1) {
        value = shorthands.slice(1);
        shorthands = "";
      } else if (at < args.length) {
        value = args[at] ?? "";
        at += 1;
        shorthands = "";
      } else return { sent: false };
      apply(name, value);
    }
  }
  if (positionals.length !== 1) return { sent: false };
  return { sent: true, method: method ?? (fields ? "POST" : "GET"), endpoint: positionals[0] ?? "" };
}

/** Whether gh would write nothing: no request at all, or a GET that is not graphql. */
function oracleSaysRead(args: readonly string[]): boolean {
  const request = oracleRequest(args);
  return !request.sent || (request.method.toUpperCase() === "GET" && !/\bgraphql\b/i.test(request.endpoint));
}

const SHORT_VALUE_FLAGS = ["-q", "-H", "-p", "-t", "-X", "-f", "-F"] as const;
const LONG_VALUE_FLAGS = [
  "--jq",
  "--header",
  "--preview",
  "--template",
  "--hostname",
  "--cache",
  "--method",
  "--input",
  "--field",
  "--raw-field",
] as const;

// Every spelling pflag distinguishes: EMPTY attached (quoted either way), a
// BARE `=`, an `=`-attached empty, a separate empty argument, a separate
// value, NOTHING (so the next argument is consumed), and attached values.
const SHORT_FORMS = (flag: string): readonly string[] => [
  `${flag}''`,
  `${flag}""`,
  `${flag}=`,
  `${flag}=''`,
  `${flag} ''`,
  `${flag}`,
  `${flag}x`,
  `${flag}=x`,
  `${flag} x`,
  `${flag}'x'`,
  `-i${flag.slice(1)}`,
  `-i${flag.slice(1)}''`,
  `-i${flag.slice(1)}=`,
];

const LONG_FORMS = (flag: string): readonly string[] => [
  `${flag}=`,
  `${flag}=''`,
  `${flag} ''`,
  `${flag}`,
  `${flag}=x`,
  `${flag} x`,
  `${flag}'x'`,
  `${flag} 'x y'`,
];

// What follows the value: every way to smuggle a write past a value flag that
// takes one argument too many or too few, and nothing at all.
const TAILS: readonly string[] = [
  "",
  "-XDELETE",
  "-X DELETE",
  "--method=DELETE",
  "--method DELETE",
  "-ftitle=x",
  "-F title=x",
  "--input=/etc/hosts",
  "--raw-field t=x",
  "-H -XDELETE",
  "-p -ftitle=x",
  "--jq -XDELETE",
  "--paginate",
];

const CORPUS: readonly string[] = [
  ...SHORT_VALUE_FLAGS.flatMap(SHORT_FORMS),
  ...LONG_VALUE_FLAGS.flatMap(LONG_FORMS),
].flatMap((form): readonly string[] =>
  TAILS.map((tail): string => `gh api repos/o/r/issues/1 ${form}${tail === "" ? "" : ` ${tail}`}`),
);

describe("QA-18 -- every value spelling of every gh api value flag, against gh's own parser", () => {
  it("builds a corpus that actually exercises writes", () => {
    const writes = CORPUS.filter((line): boolean => {
      const tokens = tokenizeCommandLine(line);
      return tokens.ok && !oracleSaysRead(tokens.argv.slice(2));
    });
    // A table whose every line is a read proves nothing about refusing writes.
    expect(CORPUS.length).toBeGreaterThan(1000);
    expect(writes.length).toBeGreaterThan(500);
  });

  it("never lets the WATCH call a line read-only that gh would send as a write", () => {
    for (const line of CORPUS) {
      for (const platform of ["linux", "win32"] as const) {
        const verdict = classifyWatchCommand(line, platform);
        if (verdict.argv === undefined) continue;
        expect(oracleSaysRead(verdict.argv.slice(2)), `${platform}: ${line}`).toBe(true);
      }
    }
  });

  it("gives the SAME verdict when the gh api check is run over the returned argv", () => {
    for (const line of CORPUS) {
      const verdict = classifyWatchCommand(line, "linux");
      if (verdict.argv === undefined) continue;
      expect(classifyGhApiArgv(verdict.argv), line).toEqual(verdict.classification);
    }
  });

  // `parse izanami` answers for any shell; for this corpus -- no expansion, no
  // glob -- a POSIX shell builds exactly the tokeniser's argv (pinned against a
  // real sh in ./command-line.test.ts), so that argv is the request to check.
  it("never lets PARSE IZANAMI call a line read-only that gh would send as a write", () => {
    for (const line of CORPUS) {
      if (classifyCommand(line).classification !== "read-only") continue;
      const tokens = tokenizeCommandLine(line);
      expect(tokens.ok, line).toBe(true);
      if (tokens.ok) expect(oracleSaysRead(tokens.argv.slice(2)), line).toBe(true);
    }
  });

  it("still reads the plain forms -- the table refuses writes, not reads", () => {
    const reads = CORPUS.filter((line): boolean => classifyWatchCommand(line, "linux").argv !== undefined);
    expect(reads).toContain("gh api repos/o/r/issues/1 -q x");
    expect(reads).toContain("gh api repos/o/r/issues/1 --jq 'x y' --paginate");
    expect(reads).toContain("gh api repos/o/r/issues/1 -q= --paginate");
  });
});

// ---------------------------------------------------------------------------
// The other row that SKIPS a value: nen's own pre-verb `--repo`. izanami skips
// exactly one token after it, as ../cli/args.ts's value flag consumes exactly
// one -- and where the two could diverge (a dashed "value", which pflag would
// take and args.ts will not), args.ts REFUSES the whole invocation, so the
// verb izanami named is never reached by any other. Proven through the real
// ../index.ts `run`, whose stage-one spec this test does not restate.
// ---------------------------------------------------------------------------

describe("nen's --repo value skip cannot be turned into a different verb", () => {
  const silent: Io = { out: (): void => {}, err: (): void => {} };

  it("refuses a dashed --repo value before any verb runs, whatever izanami read after it", async () => {
    for (const argv of [
      ["--repo", "-x", "pr", "ready", "1"],
      ["--repo", "--run", "pr", "ready", "1"],
      ["--repo", "-XDELETE", "pr", "ready", "1"],
    ]) {
      const seams = new ScriptedSeams([], { platform: "linux" });
      expect(await run(argv, silent, seams), argv.join(" ")).toBe(2);
      expect(seams.calls, argv.join(" ")).toEqual([]);
    }
  });

  it("refuses an EMPTY or quoted --repo value on the watch path -- it sits in the verb path", () => {
    for (const line of ["nen --repo '' pr ready 1", 'nen --repo "" pr ready 1', "nen --repo 'a b' pr ready 1"]) {
      expect(classifyWatchCommand(line, "linux").classification.classification, line).toBe("unknown");
    }
  });
});
