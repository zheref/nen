import { describe, expect, it } from "vitest";
import { parseArgs, type FlagSpec } from "../cli/args.js";
import { mergeFlags } from "../cli/command.js";
import { COMMANDS, findCommand } from "../cli/registry.js";
import { devLintArgv } from "../dev/lint.js";
import { devTestArgv } from "../dev/test.js";
import { reviewsArgv } from "../pr/fetch.js";
import { EXECUTING_VERBS, SHU_SUBCOMMANDS } from "../shu/command.js";
import {
  classifyCommand,
  classifyInvocation,
  isScanFaithfulLine,
  isScanFaithfulToken,
  NEN_PRE_REGISTRY_TABLE,
  NEN_VERB_TABLE,
  parseIzanamiInvocation,
} from "./izanami.js";

describe("parseIzanamiInvocation -- no cap, and two forms", () => {
  it("parses the single-line 'task until condition' form", () => {
    const result = parseIzanamiInvocation("gh pr checks 42 until it is all green");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ commands: ["gh pr checks 42"], condition: "it is all green" });
    }
  });

  it("parses the multi-line 'until condition' + one command per line form", () => {
    const result = parseIzanamiInvocation("until it is merged\ngh pr view 42 --json state\ngit fetch origin");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        commands: ["gh pr view 42 --json state", "git fetch origin"],
        condition: "it is merged",
      });
    }
  });

  it("refuses a missing 'until'", () => {
    expect(parseIzanamiInvocation("gh pr checks 42").ok).toBe(false);
  });

  it("refuses an empty condition", () => {
    expect(parseIzanamiInvocation("gh pr checks 42 until").ok).toBe(false);
  });

  it("refuses empty input", () => {
    expect(parseIzanamiInvocation("").ok).toBe(false);
  });
});

describe("classifyCommand -- an allowlist, an explicit refusal list, and unknown blocks too", () => {
  it("allows the documented read-only gh/git commands", () => {
    expect(classifyCommand("gh pr view 42").classification).toBe("read-only");
    expect(classifyCommand("gh pr checks 42").classification).toBe("read-only");
    expect(classifyCommand("gh issue list --state open").classification).toBe("read-only");
    expect(classifyCommand("gh run list").classification).toBe("read-only");
    expect(classifyCommand("git fetch origin").classification).toBe("read-only");
    expect(classifyCommand("git log -1").classification).toBe("read-only");
    expect(classifyCommand("git status").classification).toBe("read-only");
  });

  it("gh api is read-only only for GET (the default)", () => {
    expect(classifyCommand("gh api repos/o/r/pulls/1").classification).toBe("read-only");
    expect(classifyCommand("gh api -X GET repos/o/r").classification).toBe("read-only");
    expect(classifyCommand("gh api -X POST repos/o/r/issues").classification).toBe("mutating");
  });

  it("refuses the documented mutating commands by name", () => {
    expect(classifyCommand("git push origin main").classification).toBe("mutating");
    expect(classifyCommand("git commit -m x").classification).toBe("mutating");
    expect(classifyCommand("git merge main").classification).toBe("mutating");
    expect(classifyCommand("git tag v1").classification).toBe("mutating");
    expect(classifyCommand("git checkout -b feature/x").classification).toBe("mutating");
    expect(classifyCommand("gh pr create --title x").classification).toBe("mutating");
    expect(classifyCommand("gh issue close 42").classification).toBe("mutating");
  });

  it("a sibling skill invocation matches no gh/git read shape, so it blocks as unknown -- never assumed safe", () => {
    // The skill's own table refuses these by name; this port does not carry
    // the literal system/skill names into shipped code (taxonomy purity, §3),
    // so the same commands are refused via "unknown" instead of a named
    // "mutating" reason -- see this file's header.
    expect(classifyCommand("run drive on BC#42 to G4").classification).toBe("unknown");
  });

  it("treats an unrecognized command as unknown, never as safe", () => {
    expect(classifyCommand("curl https://example.com").classification).toBe("unknown");
  });

  // Review finding #1: git branch/remote were matched on subcommand name
  // only, so their mutating flag forms classified read-only.
  it("refuses mutating flag forms of git branch even though 'branch' is read-only bare", () => {
    expect(classifyCommand("git branch -D probe-victim").classification).toBe("mutating");
    expect(classifyCommand("git branch -d probe-victim").classification).toBe("mutating");
    expect(classifyCommand("git branch -m old new").classification).toBe("mutating");
    expect(classifyCommand("git branch -M old new").classification).toBe("mutating");
    expect(classifyCommand("git branch --delete probe-victim").classification).toBe("mutating");
    expect(classifyCommand("git branch --move old new").classification).toBe("mutating");
  });

  it("still allows the listing forms of git branch", () => {
    expect(classifyCommand("git branch").classification).toBe("read-only");
    expect(classifyCommand("git branch -l").classification).toBe("read-only");
    expect(classifyCommand("git branch --list").classification).toBe("read-only");
    expect(classifyCommand("git branch -a").classification).toBe("read-only");
    expect(classifyCommand("git branch -r").classification).toBe("read-only");
    expect(classifyCommand("git branch -v").classification).toBe("read-only");
    expect(classifyCommand("git branch --show-current").classification).toBe("read-only");
  });

  it("refuses mutating forms of git remote even though 'remote' is read-only bare", () => {
    expect(classifyCommand("git remote add evil https://example.com").classification).toBe("mutating");
    expect(classifyCommand("git remote remove origin").classification).toBe("mutating");
    expect(classifyCommand("git remote rm origin").classification).toBe("mutating");
    expect(classifyCommand("git remote set-url origin https://example.com").classification).toBe("mutating");
    expect(classifyCommand("git remote rename origin upstream").classification).toBe("mutating");
  });

  it("still allows the listing forms of git remote", () => {
    expect(classifyCommand("git remote").classification).toBe("read-only");
    expect(classifyCommand("git remote -v").classification).toBe("read-only");
    expect(classifyCommand("git remote show origin").classification).toBe("read-only");
    expect(classifyCommand("git remote get-url origin").classification).toBe("read-only");
  });

  // Review finding #2: gh api's write-method detection missed --method=POST,
  // -XPOST, the implicit POST from -f/-F field flags, and graphql.
  it("refuses gh api forms that are writes without a whitespace-separated -X POST", () => {
    expect(classifyCommand("gh api --method=POST /repos/o/r/issues").classification).toBe("mutating");
    expect(classifyCommand("gh api -XPOST /repos/o/r/issues").classification).toBe("mutating");
    expect(classifyCommand("gh api /repos/o/r/issues -f title=pwned").classification).toBe("mutating");
    expect(classifyCommand("gh api graphql -f query=mutation").classification).toBe("mutating");
    expect(classifyCommand("gh api graphql -f query={viewer{login}}").classification).toBe("mutating");
  });
});

// zheref/nen#31: the allowlist missed plain file reads (cat/type/test -f) and
// every `nen <verb>` invocation. The issue's exact repros first, then the
// guard rails the extension must NOT have loosened.
describe("classifyCommand -- plain file reads (#31)", () => {
  it("accepts the issue's exact repros: cat, type, test -f", () => {
    expect(classifyCommand("cat somefile.txt").classification).toBe("read-only");
    expect(classifyCommand("type somefile.txt").classification).toBe("read-only");
    expect(classifyCommand("test -f somefile.txt").classification).toBe("read-only");
  });

  it("accepts the rest of the 'reading a file' row: head, tail, wc, stat", () => {
    expect(classifyCommand("head -n 5 CHANGELOG.md").classification).toBe("read-only");
    expect(classifyCommand("tail -n 20 build.log").classification).toBe("read-only");
    expect(classifyCommand("wc -l somefile.txt").classification).toBe("read-only");
    expect(classifyCommand("stat somefile.txt").classification).toBe("read-only");
  });

  it("accepts test/[ only with a recognized read-only predicate, negated included", () => {
    expect(classifyCommand("test -e somefile.txt").classification).toBe("read-only");
    expect(classifyCommand("test -d somedir").classification).toBe("read-only");
    expect(classifyCommand("test ! -f somefile.txt").classification).toBe("read-only");
    expect(classifyCommand("test -s somefile.txt").classification).toBe("read-only");
    expect(classifyCommand("[ -f somefile.txt ]").classification).toBe("read-only");
    // An unrecognized predicate shape falls through to unknown, never guessed.
    expect(classifyCommand("test somefile.txt = other.txt").classification).toBe("unknown");
    expect(classifyCommand("[ -f somefile.txt").classification).toBe("unknown");
  });

  // `cat > file` is how a shell WRITES a file: the utility is a pure read,
  // the metacharacter around it is where the write hides. Every such line
  // stays unclassified rather than riding in on the head token.
  it("refuses a plain read carrying a shell metacharacter", () => {
    expect(classifyCommand("cat > somefile.txt").classification).toBe("unknown");
    expect(classifyCommand("cat a.txt >> b.txt").classification).toBe("unknown");
    expect(classifyCommand("cat a.txt | tee b.txt").classification).toBe("unknown");
    expect(classifyCommand("cat a.txt; git push").classification).toBe("unknown");
    expect(classifyCommand("cat $(dangerous)").classification).toBe("unknown");
    expect(classifyCommand("test -f a && git push").classification).toBe("unknown");
  });

  // zheref/nen#76's review: shellMetacharRefusal wraps the caller's own line
  // in single quotes to quote it back in the reason, but rendered a literal
  // single quote already in that line unescaped -- so it closed the
  // refusal's OWN wrapping quote early, e.g. "...so 'cat 'a.txt' | tee
  // b.txt' is no longer..." reads as three quoted spans, not the caller's
  // one line. Escaped to \' now, the same way \r and \n already are.
  it("escapes a single quote already in the line, so the metacharacter refusal's own quoting stays unambiguous", () => {
    const result = classifyCommand("cat 'a.txt' | tee b.txt");
    expect(result.classification).toBe("unknown");
    // The escaped, unambiguous form: one wrapping quote, and the caller's own
    // quotes escaped inside it.
    expect(result.reason).toContain("'cat \\'a.txt\\' | tee b.txt'");
    // NOT the malformed form the defect produced, where the caller's own
    // quotes read as closing the wrapper.
    expect(result.reason).not.toContain("'cat 'a.txt' | tee b.txt'");
  });

  // zheref/nen#98's adversarial review of #76's fix: escaping the quote but
  // not a literal backslash already in the line left a backslash-then-quote
  // input ambiguous -- a Windows path with a trailing backslash inside
  // quotes, `cat 'C:\foo\' > log.txt`, rendered its own `\` sitting right
  // next to this function's inserted escape as `\\'`, indistinguishable from
  // an escaped backslash followed by a bare quote. Doubling every backslash
  // FIRST keeps `\\` (one literal backslash) and `\'` (one literal quote) as
  // distinct two-character groups no matter what precedes a quote.
  it("escapes a backslash already in the line before escaping a quote, so a backslash-then-quote input stays unambiguous", () => {
    const result = classifyCommand("cat 'C:\\foo\\' > log.txt");
    expect(result.classification).toBe("unknown");
    // The escaped, unambiguous form: every literal backslash doubled, and
    // the caller's own quotes escaped, each group distinct from the other.
    expect(result.reason).toContain("'cat \\'C:\\\\foo\\\\\\' > log.txt'");
    // NOT a malformed form where a lone backslash sits next to the escaped
    // quote, indistinguishable from a doubled (escaped) backslash.
    expect(result.reason).not.toContain("'cat \\'C:\\foo\\\\' > log.txt'");
  });

  // #31 review: an embedded newline or CR is the shell's own command
  // separator -- "cat a.txt\ngit push" is TWO commands, and the head-token
  // match would only ever see the first. Unreachable as an execution vector
  // through this binary (`parse izanami` splits on newlines before
  // classifying; `watch until` spawns without a shell), but the
  // classification is also consumed by the skill side, which may hand the
  // string to a real shell -- so the separator class refuses too.
  it("refuses an embedded newline or CR -- a line separator is a second command", () => {
    expect(classifyCommand("cat a.txt\ngit push").classification).toBe("unknown");
    expect(classifyCommand("cat a.txt\rgit push").classification).toBe("unknown");
    expect(classifyCommand("nen wc classify\ngit push").classification).toBe("unknown");
  });
});

describe("classifyCommand -- nen's own verbs (#31)", () => {
  it("accepts the issue's exact repro: nen pr ready", () => {
    const result = classifyCommand("nen pr ready 925 --gh-repo owner/repo");
    expect(result.classification).toBe("read-only");
  });

  it("refuses the issue's exact repro: nen label apply --run", () => {
    const result = classifyCommand("nen label apply XX-PR-#1 --label wake --repo-slug o/r --run");
    expect(result.classification).toBe("mutating");
  });

  // Even the dry-run form of label apply appends a ledger line on every call
  // (src/label/command.ts: "every call writes a ledger line, dry run or not"),
  // so NO form of it is a pure read.
  it("refuses nen label apply even without --run -- the ledger line is a write", () => {
    expect(classifyCommand("nen label apply XX-PR-#1 --label wake --repo-slug o/r").classification).toBe("mutating");
  });

  // #31 review's surviving mutant: weakening label apply's policy from MUT
  // to dry-run-gated passed the whole suite, because only the bare and --run
  // forms were pinned -- and dry-run-gated answers "mutating" for both of
  // those. This is the ONE form where the two policies disagree, so it is
  // the assertion that kills the mutant. (Behaviorally inert today -- label
  // apply declares no --dry-run boolean, so ../cli/args.ts usage-errors
  // before the ledger append -- but this table classifies the LINE, and
  // "mutating in EVERY form" must mean every form.)
  it("refuses nen label apply --dry-run too -- no token makes the ledger append a read", () => {
    expect(classifyCommand("nen label apply XX-PR-#1 --label wake --repo-slug o/r --dry-run").classification).toBe(
      "mutating",
    );
  });

  it("accepts read-only verbs across the surface", () => {
    expect(classifyCommand("nen pr fetch --target o/r --pr 1").classification).toBe("read-only");
    expect(classifyCommand("nen pr next-blocker --target o/r --pr 1 --repo .").classification).toBe("read-only");
    expect(classifyCommand("nen backlog fetch --target o/r").classification).toBe("read-only");
    expect(classifyCommand("nen wc classify").classification).toBe("read-only");
    expect(classifyCommand("nen loop slots --report r.json").classification).toBe("read-only");
    expect(classifyCommand("nen stop --gate G4").classification).toBe("read-only");
    expect(classifyCommand("nen schema check").classification).toBe("read-only");
    expect(classifyCommand("nen version").classification).toBe("read-only");
    expect(classifyCommand("nen --version").classification).toBe("read-only");
  });

  it("refuses the always-mutating verbs by name", () => {
    expect(classifyCommand("nen pr cascade-main --repo .").classification).toBe("mutating");
    expect(classifyCommand("nen pr retarget --target o/r --pr 1 --base main").classification).toBe("mutating");
    expect(classifyCommand("nen pr request-reviews --target o/r --pr 1 --add-reviewers a").classification).toBe("mutating");
    expect(classifyCommand("nen tag cut --name v1.0.0 --at abc123").classification).toBe("mutating");
    expect(classifyCommand("nen run rerun-failed --target o/r --run-id 9").classification).toBe("mutating");
    expect(classifyCommand("nen idea file --target o/r --title x --body-file b.md").classification).toBe("mutating");
    expect(classifyCommand("nen scaffold init").classification).toBe("mutating");
    expect(classifyCommand("nen fanout record --range v1..v2").classification).toBe("mutating");
    expect(classifyCommand("nen bootstrap --ref v0.1.0").classification).toBe("mutating");
  });

  // zheref/nen#74's review: the passthrough `--` guard used to run BEFORE the
  // policy switch, so a verb that is mutating in every form lost its own
  // classification and reason to the guard's generic "unknown" the moment a
  // `--` appeared on the line -- even though nothing behind a `--` could ever
  // make an already-mutating verb less mutating. `evaluateNenPolicy` now
  // answers "mutating" for these verbs before it ever looks at `--`. The
  // refusal is identical either way (neither is "read-only"); only the label
  // and reason improve.
  it("an always-mutating verb answers 'mutating', not 'unknown', even with a passthrough '--' on the line", () => {
    expect(classifyCommand("nen tag cut --name x --at y -- z").classification).toBe("mutating");
    expect(classifyCommand("nen idea file --target o/r --title x --body-file b.md -- z").classification).toBe("mutating");
  });

  // BOTH `scaffold` VERBS, PINNED IN BOTH DIRECTIONS. The rows moved from
  // `mutating` to `dry-run-gated` when `--dry-run` arrived, and a seeded mutant
  // that flipped `scaffold new` back the other way -- to read-only in every
  // form -- passed the whole suite, because nothing asserted the bare form. A
  // classifier that certifies a tree-writing verb as read-only is the one
  // failure mode this table exists to prevent, so each spelling is pinned:
  // bare writes, `--dry-run` does not, and a `--dry-run` the scan cannot
  // distinguish from a quoted value is refused rather than trusted.
  it("scaffold new is dry-run-gated: the bare form WRITES A TREE", () => {
    expect(
      classifyCommand("nen scaffold new --stack nextjs --name x --dir ./x").classification,
    ).toBe("mutating");
    expect(
      classifyCommand("nen scaffold new --stack nextjs --name x --dir ./x --dry-run").classification,
    ).toBe("read-only");
  });

  it("scaffold init is dry-run-gated, and --install-tools is never read-only", () => {
    expect(classifyCommand("nen scaffold init --repo . --stack nextjs").classification).toBe("mutating");
    expect(classifyCommand("nen scaffold init --repo . --stack nextjs --dry-run").classification).toBe(
      "read-only",
    );
    // --install-tools changes the HOST, and the two flags are refused together
    // by the verb itself -- so no invocation carrying it is ever read-only.
    expect(
      classifyCommand("nen scaffold init --repo . --stack nextjs --install-tools").classification,
    ).not.toBe("read-only");
  });

  it("refuses a scaffold --dry-run the scan cannot tell from a quoted value", () => {
    // The token is inside a value, so a real shell never passes `--dry-run` to
    // nen at all. The classifier cannot see quoting, so it refuses rather than
    // certifying a run that would write.
    expect(
      classifyCommand('nen scaffold new --stack nextjs --name "x --dry-run" --dir ./x').classification,
    ).not.toBe("read-only");
    expect(
      classifyCommand('nen scaffold init --repo . --scenario "a --dry-run b"').classification,
    ).not.toBe("read-only");
  });

  // Verbs that WRITE BY DEFAULT are read-only only in their explicit
  // --dry-run form -- absence of the write is never inferred.
  it("dry-run-gated verbs: read-only ONLY with an explicit --dry-run", () => {
    expect(classifyCommand("nen labels sync --target o/r").classification).toBe("mutating");
    expect(classifyCommand("nen labels sync --target o/r --dry-run").classification).toBe("read-only");
    expect(classifyCommand("nen labels rename --target o/r --map a=b").classification).toBe("mutating");
    expect(classifyCommand("nen labels rename --target o/r --map a=b --dry-run").classification).toBe("read-only");
    expect(classifyCommand("nen issue file --target o/r --title x --body-file b.md").classification).toBe("mutating");
    expect(classifyCommand("nen issue file --target o/r --title x --body-file b.md --dry-run").classification).toBe("read-only");
    expect(classifyCommand("nen issue consolidate-close --target o/r --parent 1 --children 2").classification).toBe("mutating");
    expect(classifyCommand("nen issue attach-sub --target o/r --parent 1 --children 2 --dry-run").classification).toBe("read-only");
  });

  // zheref/nen#29's new verb. It POSTS to a public timeline, so it is gated
  // exactly like its issue-family siblings -- read-only only in the explicit
  // --dry-run form, never inferred from "it only comments".
  it("issue comment is dry-run-gated, like every other writing verb in its family", () => {
    expect(classifyCommand("nen issue comment --target o/r --issue 1 --body x").classification).toBe(
      "mutating",
    );
    expect(
      classifyCommand("nen issue comment --target o/r --issue 1 --body x --dry-run").classification,
    ).toBe("read-only");
    expect(
      classifyCommand("nen issue comment --target o/r --issue 1 --body-file b.md --dry-run").classification,
    ).toBe("read-only");
    // And the gate is no weaker than the family's: a --dry-run the scan cannot
    // prove is an argument of its own does not open it. `--body` takes free
    // prose, which makes this verb the likeliest place in the binary for a
    // quoted --dry-run to appear inside a value.
    expect(
      classifyCommand('nen issue comment --target o/r --issue 1 --body "ship it --dry-run"').classification,
    ).toBe("mutating");
  });

  // Verbs that READ BY DEFAULT flip to mutating the moment their write flag
  // appears -- --flag=value forms included.
  it("write-flag-gated verbs: mutating the moment the write flag appears", () => {
    expect(classifyCommand("nen changelog collate --version v1 --theme t --changelog C.md --fragment-dir d").classification).toBe("read-only");
    expect(classifyCommand("nen changelog collate --version v1 --theme t --changelog C.md --fragment-dir d --write").classification).toBe("mutating");
    expect(classifyCommand("nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake").classification).toBe("read-only");
    expect(classifyCommand("nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake --run").classification).toBe("mutating");
    expect(classifyCommand("nen wake verify --repo-slug o/r --now 2026-01-01T00:00:00Z --author-pattern x --run").classification).toBe("mutating");
    expect(classifyCommand("nen canon mirror check --rules-dir r --canon-values v --mirror-dir m --ref x --header-template h --header-pattern p --not-mirrored a").classification).toBe("read-only");
    expect(classifyCommand("nen canon mirror check --rules-dir r --markdown-out report.md").classification).toBe("mutating");
    expect(classifyCommand("nen canon mirror generate --rules-dir r --out-dir o").classification).toBe("mutating");
    expect(classifyCommand("nen epic next-wave --body-file b.md --out rewritten.md").classification).toBe("mutating");
    expect(classifyCommand("nen epic next-wave --body-file b.md").classification).toBe("read-only");
  });

  it("classifies through the pre-verb global flags", () => {
    expect(classifyCommand("nen --repo ../elsewhere wc classify").classification).toBe("read-only");
    expect(classifyCommand("nen --json pr ready 925 --gh-repo owner/repo").classification).toBe("read-only");
  });

  // "When in doubt -> NOT read-only": every unprovable form stays refused.
  it("refuses the unprovable forms as unknown, never assumed safe", () => {
    expect(classifyCommand("nen").classification).toBe("unknown");
    expect(classifyCommand("nen frobnicate everything").classification).toBe("unknown");
    // A subcommand the table has not classified -- the fail-closed drift
    // path for a future subcommand landing without a table row.
    expect(classifyCommand("nen pr merge --target o/r --pr 1").classification).toBe("unknown");
    // A passthrough hands vitest its own flags -- `-- -u` would rewrite
    // snapshot files under a verb this table calls a checker.
    expect(classifyCommand("nen dev test -- -u").classification).toBe("unknown");
    // A metacharacter puts a second command or a redirection on the line.
    expect(classifyCommand("nen pr ready 925 --gh-repo o/r; git push").classification).toBe("unknown");
    expect(classifyCommand("nen wc classify > out.txt").classification).toBe("unknown");
  });

  it("dev's checker verbs are read-only in their bare form", () => {
    expect(classifyCommand("nen dev test").classification).toBe("read-only");
    expect(classifyCommand("nen dev lint").classification).toBe("read-only");
    expect(classifyCommand("nen dev replay").classification).toBe("read-only");
  });

  it("nen watch until is itself watchable -- the inner --command re-classifies", () => {
    expect(classifyCommand('nen watch until --command "gh pr checks 1"').classification).toBe("read-only");
  });
});

// #31 re-review MAJOR: the flag scan splits on \s+ and is quote-blind, and
// for a dry-run-gated verb that blindness failed OPEN -- the quoted --title
// value below donates a `--dry-run` token to the scan, while a real shell
// passes the whole value as ONE argument: no dry-run gate, and the verb
// writes. The rule now: a flag-dependent policy claims read-only only on a
// QUOTE-FREE line (a quote means the scan's tokens are not the shell's
// tokens), enforced inside evaluateNenPolicy -- NOT via SHELL_METACHARS,
// because a quoted argument is legitimate shell and must not refuse verbs
// whose classification never consults a flag scan (the watch-until case
// above stays read-only, pinned again here from the quote angle).
describe("classifyCommand -- flag scans on quoted lines (#31 re-review)", () => {
  it("refuses the exact repro: --dry-run inside a quoted --title value is not a dry-run gate", () => {
    const result = classifyCommand('nen issue file --target o/r --title "add --dry-run support" --body-file b.md');
    expect(result.classification).toBe("mutating");
  });

  it("refuses even a genuine --dry-run when ANY quote is on the line -- only the quote-free form is provable", () => {
    // The single-quoted title is inert here, but the scan cannot know that
    // without a shell parse it deliberately does not have; unprovable on a
    // writes-by-default verb means the default: mutating.
    expect(classifyCommand("nen issue file --target o/r --title 'x' --body-file b.md --dry-run").classification).toBe(
      "mutating",
    );
  });

  // The quote-FREE --dry-run and write-flag forms staying read-only is
  // pinned by the "dry-run-gated verbs" and "write-flag-gated verbs" tests
  // above -- not repeated here.

  it("'--dry-run=false' is not the exact token and can never run as a dry run -- not read-only", () => {
    // ../cli/args.ts refuses inline values on boolean flags, so this shape
    // usage-errors under nen itself -- and under some OTHER tool a real
    // shell hands it to, `--dry-run=false` could mean the opposite. Exact
    // token only.
    expect(
      classifyCommand("nen issue file --target o/r --title x --body-file b.md --dry-run=false").classification,
    ).toBe("mutating");
  });

  it("refuses a write-flag-gated read-only claim on a quoted line -- quoting can splice a write flag out of sight", () => {
    // '--run' is not the token --run to the \s+ split, but IS --run to the
    // shell the skill side may hand this string to: the symmetric open
    // direction of the same scan, closed the same way.
    expect(classifyCommand("nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake '--run'").classification).toBe(
      "unknown",
    );
  });
});

// #31 ROUND THREE. Rounds one and two each shipped a guard aimed at the
// vectors the previous review had named, and the next review walked past it
// with one more character: round two's tripwire was QUOTES only, so a
// BACKSLASH defeated it in both directions, a quote-spliced '--' laundered
// the passthrough guard, and a non-breaking space donated a token \s+ splits
// on and no shell does. The guard is now the inverse shape -- an ALLOWLIST of
// characters that provably cannot change a shell's word boundaries -- applied
// in two halves: the VERB PATH must be faithful for every policy, and a
// verdict that also scans the ARGUMENTS needs the whole line faithful. So a
// character nobody has enumerated refuses by default.
//
// Every repro below is pinned by the exact line that was verified live.
describe("classifyCommand -- the scan-faithfulness invariant (#31 round three)", () => {
  // Two characters this suite needs to assert on but nobody can see in a
  // diff, so they are named rather than pasted. The em space is here as the
  // "not just nbsp" control: the guard is a safe SET, not a list of the
  // exotic spaces someone happened to think of.
  const NBSP = "\u00a0";
  const EM_SPACE = "\u2003";

  // MAJOR 1(a). Under a real shell `x\ --dry-run` is ONE argument: the verb
  // gets no --dry-run gate and CREATES the issue. The \s+ scan saw a bare
  // --dry-run token and no quote character, so round two called it read-only.
  it("refuses a backslash-glued value that donates a --dry-run token no shell produces", () => {
    const result = classifyCommand("nen issue file --target o/r --title x\\ --dry-run --body-file b.md");
    expect(result.classification).toBe("mutating");
    expect(result.classification).not.toBe("read-only");
  });

  // MAJOR 1(b). A real shell unquotes `\--run` to `--run` and wake fire
  // MUTATES; the scan's token `\--run` misses the exact match, so round two
  // certified the write as a read.
  it("refuses a backslash-escaped write flag that the scan's exact-token match misses", () => {
    const result = classifyCommand("nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake \\--run");
    expect(result.classification).toBe("unknown");
    expect(result.classification).not.toBe("read-only");
  });

  // MAJOR 2. The passthrough guard is `tokens.includes("--")` -- exact-token
  // and scan-blind -- and `nen dev test` FORWARDS everything behind the
  // separator to vitest, where -u REWRITES snapshot files. So this verb's
  // read-only claim hinges on the scan's negative result just as a flag scan
  // does, and the plain read-only branch's "the answer hinges on the VERB"
  // reasoning did not hold for it.
  it("refuses a quote-spliced '--' on a verb that forwards the passthrough", () => {
    expect(classifyCommand("nen dev test '--' -u").classification).toBe("unknown");
    expect(classifyCommand("nen dev test \\-- -u").classification).toBe("unknown");
    // The control the laundered forms were hiding behind: unquoted, it was
    // always refused.
    expect(classifyCommand("nen dev test -- -u").classification).toBe("unknown");
  });

  // MINOR, with its REASON corrected in #70 round two (the behaviour stands).
  // Round one wrote "JS's \s+ splits on U+00A0 where a real shell does not",
  // and that is true of bash and FALSE of PowerShell: verified here with a
  // program that prints its own argv, `A<U+00A0>--run` arrives as ONE argument
  // under bash and as TWO under PowerShell. So the refusal rests on the
  // READERS DISAGREEING, not on "no shell can run this" -- under bash the scan
  // is donated a --dry-run token the shell never produces, under PowerShell
  // that token is real, and neither reading is provable from here.
  it("refuses exotic whitespace the readers tokenize differently from each other", () => {
    expect(
      classifyCommand(`nen issue file --target o/r --title x${NBSP}--dry-run --body-file b.md`).classification,
    ).toBe("mutating");
    // The same shape with a DIFFERENT exotic space, to prove the guard is a
    // safe set and not a two-character blocklist.
    expect(
      classifyCommand(`nen labels sync --target o/r --map a=b${EM_SPACE}--dry-run`).classification,
    ).toBe("mutating");
    // And in the leading position, where String.trim() would otherwise strip
    // it out from under the guard: the nen branch ASCII-trims for exactly
    // this reason, so the character survives to be judged.
    expect(classifyCommand(`${NBSP}nen labels sync --target o/r --dry-run`).classification).toBe("unknown");
  });

  // ROUND THREE'S OWN FINDING #1, in the class the two rounds before kept
  // missing rather than in the vectors handed to it: the guard as first
  // written let the VERB PATH stay unproven. `--repo`'s value is skipped
  // WITHOUT being looked at, so the scan reads `nen --repo $FOO pr ready` as
  // the read-only `nen pr ready` while a shell expanding
  // FOO='x label apply --run XX-PR-#1 --label wake' runs `nen label apply
  // --run` -- a row this very table calls mutating. Word splitting AFTER
  // expansion adds words the scan never saw, which is what made the old
  // "identity cannot be laundered" rationale false.
  it("refuses an unprovable verb path, even for a verb-identity-only row", () => {
    expect(classifyCommand("nen --repo $FOO pr ready").classification).toBe("unknown");
    // A glob in the same slot: one word to the scan, N words to the shell.
    expect(classifyCommand("nen --repo * pr ready").classification).toBe("unknown");
    // A quoted value in the same slot -- provable to a human, not to this
    // scan, and this module errs refusing.
    expect(classifyCommand("nen --repo 'a' pr ready").classification).toBe("unknown");
    // Exotic whitespace welded into the family token itself.
    expect(classifyCommand(`nen${NBSP}pr ready`).classification).toBe("unknown");
    // The control: the same path spelled in the safe set still classifies.
    expect(classifyCommand("nen --repo ../elsewhere pr ready").classification).toBe("read-only");
  });

  // ROUND THREE'S OWN FINDING #2, and the reason the safe set is not just
  // "the characters that look like shell": `#` was INSIDE the prescribed set
  // (XX-PR-#1 needs it) but opens a COMMENT at the start of a word. Verified
  // against bash: `set -- nen labels sync --target o/r #x --dry-run` yields
  // argv `nen labels sync --target o/r`. So the shell runs the WRITING form
  // while the scan sees a --dry-run token -- the same fail-open as the quoted
  // and backslash repros, hiding in the allowlist itself.
  it("refuses a word-initial # that comments the gate away for a real shell", () => {
    expect(classifyCommand("nen labels sync --target o/r #x --dry-run").classification).toBe("mutating");
    expect(classifyCommand("nen dev test #x --").classification).toBe("unknown");
    // Mid-word `#` is untouched, because a shell keeps it: this is the ref
    // notation half the table's own examples use, and refusing it would make
    // the guard useless rather than strict.
    expect(classifyCommand("nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake").classification).toBe(
      "read-only",
    );
  });

  // THE SAFE SET ITSELF, asserted directly rather than only through the
  // repros above: WIDENING it -- admitting a backslash, a quote, a $, an
  // exotic space -- must go red here on its own terms, not merely wherever a
  // repro happens to be pinned today.
  it("isScanFaithfulLine admits only the boring argv characters", () => {
    expect(isScanFaithfulLine("nen issue file --target o/r --title x --body-file b.md --dry-run")).toBe(true);
    expect(isScanFaithfulLine("nen wake verify --repo-slug o/r --now 2026-01-01T00:00:00Z --author-pattern x")).toBe(true);
    expect(isScanFaithfulLine("nen --repo ../elsewhere fanout compute --range v1..v2 --ref XX-PR-#1 --map a=b,c=d~1+2")).toBe(true);
    expect(isScanFaithfulLine("nen\tlabels\tsync\t--dry-run")).toBe(true);
    expect(isScanFaithfulLine('nen issue file --title "x"')).toBe(false);
    expect(isScanFaithfulLine("nen issue file --title 'x'")).toBe(false);
    expect(isScanFaithfulLine("nen issue file --title x\\ --dry-run")).toBe(false);
    expect(isScanFaithfulLine(`nen issue file --title x${NBSP}--dry-run`)).toBe(false);
    expect(isScanFaithfulLine(`nen issue file --title x${EM_SPACE}--dry-run`)).toBe(false);
    expect(isScanFaithfulLine("nen issue file --title x*")).toBe(false);
    expect(isScanFaithfulLine("nen issue file --title $X")).toBe(false);
    // Chars are fine here; the WORD-BOUNDARY position is what makes these
    // unfaithful, so they can only pass through the token rule.
    expect(isScanFaithfulLine("nen labels sync --target o/r #x --dry-run")).toBe(false);
    expect(isScanFaithfulLine("nen labels sync --target o/r @a --dry-run")).toBe(false);
    expect(isScanFaithfulLine("nen labels sync --target o/r x, --dry-run")).toBe(false);
  });

  it("isScanFaithfulToken splits each boundary character's two jobs", () => {
    expect(isScanFaithfulToken("XX-PR-#1")).toBe(true);
    expect(isScanFaithfulToken("--dry-run")).toBe(true);
    expect(isScanFaithfulToken("../elsewhere")).toBe(true);
    expect(isScanFaithfulToken("#x")).toBe(false);
    expect(isScanFaithfulToken("#")).toBe(false);
    expect(isScanFaithfulToken("$FOO")).toBe(false);
    expect(isScanFaithfulToken("'--run'")).toBe(false);
    expect(isScanFaithfulToken("\\--run")).toBe(false);
    // #31 round four: PowerShell splats a word-INITIAL @ into several
    // arguments, and strips a comma at either END of a word. Mid-word both
    // are inert, and both are used by real nen tokens.
    expect(isScanFaithfulToken("BC@high+")).toBe(true);
    expect(isScanFaithfulToken("git@host:o/r")).toBe(true);
    expect(isScanFaithfulToken("@a")).toBe(false);
    expect(isScanFaithfulToken("@")).toBe(false);
    expect(isScanFaithfulToken("a=b,c=d")).toBe(true);
    expect(isScanFaithfulToken("2,3")).toBe(true);
    expect(isScanFaithfulToken("--run,")).toBe(false);
    expect(isScanFaithfulToken(",--run")).toBe(false);
    expect(isScanFaithfulToken(",")).toBe(false);
  });

  // THE GUARD IS NOT "REFUSE EVERYTHING WITH PUNCTUATION IN IT": the forms
  // the issue and the earlier rounds asked for still classify, so a
  // regression that simply widened the refusal would go red here.
  it("still admits the scan-faithful forms of every gated policy", () => {
    expect(classifyCommand("nen issue file --target o/r --title x --body-file b.md --dry-run").classification).toBe("read-only");
    expect(classifyCommand("nen labels sync --target o/r --dry-run").classification).toBe("read-only");
    expect(classifyCommand("nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake").classification).toBe("read-only");
    expect(classifyCommand("nen epic next-wave --body-file b.md").classification).toBe("read-only");
    expect(classifyCommand("nen dev test").classification).toBe("read-only");
    expect(classifyCommand("nen dev lint --repo ../elsewhere").classification).toBe("read-only");
  });

  // SCOPED PRECISELY, and this is the assertion that says so: once its PATH
  // is proven, a verb whose read-only verdict is verb-identity-only keeps its
  // behaviour however its ARGUMENTS are spelled. `nen watch until`
  // re-classifies its own --command against this very table before the first
  // observation and spawns it with no shell, so no spelling of that value can
  // make it write -- and `nen dev replay` forwards no passthrough
  // (../dev/command.ts reads only --slice-dir for it).
  it("leaves verb-identity-only verdicts untouched by unfaithful ARGUMENTS", () => {
    expect(classifyCommand('nen watch until --command "gh pr checks 1"').classification).toBe("read-only");
    expect(classifyCommand("nen dev replay --slice-dir 'a dir'").classification).toBe("read-only");
    expect(classifyCommand('nen pr ready 925 --gh-repo owner/repo --note "x y"').classification).toBe("read-only");
  });
});

// #31 ROUND FOUR. Rounds two and three both asked "is this token list the one
// a SHELL would build". Round four's review found the surviving holes were
// not shell-vs-scan at all: they were SCAN-vs-../cli/args.ts. A verdict from
// this module is a claim about what nen's OWN argv reader will do with the
// tokens -- and on the `nen watch until --command "..."` path args.ts is the
// ONLY reader, because ../watch/command.ts splits and spawns with no shell
// anywhere. args.ts strips one OR two dashes, so it accepts spellings the
// scan never considered.
//
// Every line below was verified live against this binary before the fix, each
// printing `[read-only]` while the invocation writes.
describe("classifyCommand -- faithful to ../cli/args.ts's own acceptance (#31 round four)", () => {
  // THE BLOCKER. `-run` is `--run` to args.ts (`token.replace(/^--?/, "")`),
  // so every write flag in the table was one dash away from invisible.
  it("refuses the single-dash spelling of every write flag", () => {
    expect(classifyCommand("nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake -run").classification).toBe(
      "mutating",
    );
    expect(
      classifyCommand("nen wake verify --repo-slug o/r --now 2026-01-01T00:00:00Z --author-pattern x -run")
        .classification,
    ).toBe("mutating");
    expect(classifyCommand("nen changelog collate --version v1 --theme t -write").classification).toBe("mutating");
    expect(classifyCommand("nen epic next-wave --body-file b.md -out x.md").classification).toBe("mutating");
    expect(classifyCommand("nen canon mirror check --rules-dir r -markdown-out report.md").classification).toBe(
      "mutating",
    );
  });

  // The inline-value spellings on the same single dash. args.ts takes
  // `-out=x` as the value flag, and usage-errors on `-write=1` because
  // `write` is a boolean -- so the second of these refuses a line that could
  // never have run, which is the direction this module always accepts. Pinned
  // (round four minor (a)) precisely so it can never quietly go live again.
  it("refuses the single-dash inline-value spellings too", () => {
    expect(classifyCommand("nen epic next-wave --body-file b.md -out=x.md").classification).toBe("mutating");
    expect(classifyCommand("nen canon mirror check --rules-dir r -markdown-out=report.md").classification).toBe(
      "mutating",
    );
    expect(classifyCommand("nen changelog collate -write=1").classification).toBe("mutating");
    expect(classifyCommand("nen changelog collate --write=1").classification).toBe("mutating");
  });

  // THE WORST CASE THE REVIEW PROVED, in the shape it was proved in: a watch
  // that only ever accepts read-only commands, re-firing a labelled write on
  // every observation interval. `nen watch until` classifies its --command
  // against this very table (../watch/command.ts), so the inner line is the
  // one that has to refuse.
  it("refuses a single-dash write hidden inside a watch-until command", () => {
    const inner = "nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake -run";
    expect(classifyCommand(inner).classification).toBe("mutating");
    expect(classifyCommand(`nen watch until --command "${inner}"`).classification).toBe("read-only");
    // ...and that outer line stays read-only ONLY because watch re-classifies
    // the inner one before the first observation; the assertion that the
    // refusal actually reaches the verb lives in ../watch/command.test.ts.
  });

  // HOUSE RULE: an actionable refusal. Answering `-run` with "matches --run"
  // reads as the classifier having misread the line, and a refusal a caller
  // does not believe is one they route around -- so the message quotes the
  // spelling as typed and says why a spelling the table does not list still
  // counts.
  it("names the spelling the caller actually typed, and why it counts", () => {
    const typed = classifyCommand("nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake -run");
    expect(typed.classification).toBe("mutating");
    expect(typed.reason).toContain("-run");
    expect(typed.reason).toContain("--run");
    expect(typed.reason).toMatch(/one or two leading dashes/);
    // The canonical spelling needs no such explanation and does not get one.
    const canonical = classifyCommand("nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake --run");
    expect(canonical.classification).toBe("mutating");
    expect(canonical.reason).not.toMatch(/one or two leading dashes/);
  });

  // The control the fix must not have eaten: a line with no write flag in any
  // spelling still classifies read-only, and a MID-word dash is not a flag.
  it("still admits the gated verbs' read forms", () => {
    expect(classifyCommand("nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake").classification).toBe(
      "read-only",
    );
    expect(classifyCommand("nen epic next-wave --body-file b.md --citation UZF-1").classification).toBe("read-only");
    expect(classifyCommand("nen canon mirror check --rules-dir r --mirror-dir m").classification).toBe("read-only");
    // A VALUE that merely contains the flag's name is not the flag.
    expect(classifyCommand("nen epic next-wave --body-file out.md").classification).toBe("read-only");
    expect(classifyCommand("nen changelog collate --changelog write.md").classification).toBe("read-only");
  });
});

// THE COUPLING TEST (#31 round four's blocker, and the thing that actually
// closes the class). A hand-written list of spellings is what let `-run`
// through for four rounds: the list was written from the USAGE lines, and
// ../cli/args.ts accepts more than a usage line prints. So this test does not
// enumerate spellings and hope -- it drives candidate tokens through the REAL
// parseArgs with each family's REAL FlagSpec (exactly as ../index.ts's
// runFamily does: `parseArgs(argv, mergeFlags(family.flags))`), asks the
// parser which ones actually set the write flag, and requires the classifier
// to refuse every one of those.
//
// WHAT IT GUARANTEES, stated narrowly: for the spellings this generator
// produces, the classifier refuses whatever args.ts accepts. It does not
// prove the generator is exhaustive over every token args.ts could ever
// resolve; what it does do is make the two sides move together, so a change
// to args.ts's dash handling, a new alias on a gated family, or a new
// write-flag-gated row all go red here instead of shipping.
describe("write-flag-gated rows -- coupled to what ../cli/args.ts accepts (#31 round four)", () => {
  interface GatedRow {
    readonly key: string;
    readonly family: string;
    readonly writeFlags: readonly string[];
  }

  // One runnable base invocation per write-flag-gated row, keyed exactly as
  // NEN_VERB_TABLE keys it. A coverage assertion below requires this map to
  // name EVERY such row, so a future gated verb cannot land without its
  // spellings being driven through the real parser too.
  const GATED_BASE: Readonly<Record<string, string>> = {
    "canon mirror check": "nen canon mirror check --rules-dir r",
    "changelog collate": "nen changelog collate --version v1 --theme t --changelog C.md --fragment-dir d",
    "epic next-wave": "nen epic next-wave --body-file b.md",
    "shu detect": "nen shu detect",
    // The one `dry-run-only` row, so its base is the form that IS certified:
    // this row's bare invocation classifies `unknown` by design, and the
    // coupling below needs a base that classifies read-only before it appends
    // a write flag to it. What is proved is unchanged and is the thing that
    // matters -- every spelling of --install the real parser accepts is
    // refused, even sitting next to the gate.
    "shu tools": "nen shu tools --dry-run",
    "wake fire": "nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake",
    "wake verify": "nen wake verify --repo-slug o/r --now 2026-01-01T00:00:00Z --author-pattern x",
  };

  // BOTH KINDS THAT CARRY WRITE FLAGS, not just the one this suite was written
  // for. `dry-run-only` (zheref/nen#113) carries `--install`, the one flag in
  // this CLI whose blast radius is the developer's machine, and leaving it out
  // would have exempted the most dangerous row in the table from the spelling
  // coupling -- while the type system happily kept compiling.
  const gatedRows: GatedRow[] = [];
  for (const [family, entry] of Object.entries(NEN_VERB_TABLE)) {
    for (const [sub, policy] of Object.entries(entry.subcommands)) {
      if (policy.kind === "write-flag-gated" || policy.kind === "dry-run-only") {
        gatedRows.push({ key: `${family} ${sub}`, family, writeFlags: policy.writeFlags });
      }
    }
  }

  /**
   * Candidate token shapes for one flag name, INCLUDING the ones a usage line
   * never prints: both dash counts, inline values, an over-dashed form, the
   * wrong case, and every single-dash alias the family's merged spec maps to
   * this name. Which of them actually mean anything is the parser's answer,
   * not this generator's.
   */
  function candidateSpellings(name: string, spec: FlagSpec): readonly string[] {
    const aliasKeys = Object.entries(spec.aliases ?? {})
      .filter(([, target]): boolean => target === name)
      .map(([key]): string => key);
    const out: string[] = [];
    for (const base of [name, ...aliasKeys]) {
      for (const dashes of ["-", "--", "---"]) {
        out.push(`${dashes}${base}`, `${dashes}${base}=1`, `${dashes}${base}=`);
      }
      out.push(`--${base.toUpperCase()}`, `-${base.toUpperCase()}`);
    }
    return out;
  }

  /** What the REAL parser does with this argv, for this family's REAL spec. */
  function setsFlag(family: string, argv: readonly string[], name: string): boolean {
    const command = findCommand(family);
    if (command === undefined) throw new Error(`'${family}' is not a registered family`);
    try {
      const parsed = parseArgs(argv, mergeFlags(command.flags));
      return parsed.booleans.has(name) || parsed.values[name] !== undefined;
    } catch {
      // A UsageError means the invocation cannot run at all, so the
      // classifier's verdict for it cannot be a fail-open. Not asserted on.
      return false;
    }
  }

  it("names a base invocation for every write-flag-gated row in the table", () => {
    expect(gatedRows.length).toBeGreaterThan(0);
    expect(gatedRows.map((row): string => row.key).sort()).toEqual(Object.keys(GATED_BASE).sort());
  });

  it("refuses every candidate spelling the real parser resolves to a write flag", () => {
    for (const row of gatedRows) {
      const base = GATED_BASE[row.key];
      expect(base, `no base invocation for '${row.key}'`).toBeDefined();
      if (base === undefined) continue;
      const command = findCommand(row.family);
      expect(command, `'${row.family}' is not registered`).toBeDefined();
      if (command === undefined) continue;
      const spec = mergeFlags(command.flags);

      for (const flag of row.writeFlags) {
        const name = flag.replace(/^--/, "");
        const accepted: string[] = [];
        for (const spelling of candidateSpellings(name, spec)) {
          // A trailing value token: harmless to a boolean flag (it lands as a
          // positional), required by a value flag in its spaced form.
          const line = `${base} ${spelling} v`;
          if (!setsFlag(row.family, line.split(" ").slice(1), name)) continue;
          accepted.push(spelling);
          expect(classifyCommand(line).classification, `${row.key} ${spelling}`).not.toBe("read-only");
        }
        // The test is worthless if the generator produced nothing the parser
        // takes -- a broken base line would otherwise pass in silence. Both
        // dash counts must be in there, which is the blocker's own shape.
        expect(accepted, `${row.key} ${flag}`).toContain(`--${name}`);
        expect(accepted, `${row.key} ${flag}`).toContain(`-${name}`);
      }
    }
  });

  it("still admits each gated row's base invocation, so the coupling did not just refuse everything", () => {
    for (const row of gatedRows) {
      const base = GATED_BASE[row.key];
      expect(base).toBeDefined();
      if (base === undefined) continue;
      expect(classifyCommand(base).classification, row.key).toBe("read-only");
    }
  });
});

// THE DRY-RUN GATE'S OWN COUPLING TEST (zheref/nen#120 thread 2). The suite
// above drives write-flag spellings through the real parser; `dry-run-only`
// carries a second flag-shaped claim -- its READ gate -- and that one used to
// be a hand-picked exact-token check (`tokens.includes("--dry-run")`) rather
// than anything coupled to ../cli/args.ts. That is exactly the shape #31
// round four closed for write flags: `-dry-run` is `--dry-run` to args.ts
// (`token.replace(/^--?/, "")` strips one dash or two alike), so `nen shu
// tools -dry-run` -- a real dry run that spawns nothing, ../shu/tools.test.ts
// pins it from both sides -- classified `unknown`. Fixed in evaluateNenPolicy
// to use findFlagToken, the same matcher the write-flag side uses; this suite
// is the structural guarantee that a future change to args.ts's dash
// handling, or to `shu tools`'s own flag declaration, goes red here instead
// of shipping a silent re-narrowing (or re-widening) of the gate.
//
// `dry-run-only` has exactly one row today (`shu tools`), asserted below so a
// second row cannot land without its dry-run spellings being driven through
// the real parser too.
describe("dry-run-only rows -- the READ gate itself coupled to what ../cli/args.ts accepts (#120 thread 2)", () => {
  const dryRunOnlyRows: string[] = [];
  for (const [family, entry] of Object.entries(NEN_VERB_TABLE)) {
    for (const [sub, policy] of Object.entries(entry.subcommands)) {
      if (policy.kind === "dry-run-only") dryRunOnlyRows.push(`${family} ${sub}`);
    }
  }

  it("has exactly one dry-run-only row today, so this suite's one base line stays exhaustive", () => {
    expect(dryRunOnlyRows).toEqual(["shu tools"]);
  });

  it("classifies read-only for every spelling the real parser sets 'dry-run' true from, and never otherwise", () => {
    const command = findCommand("shu");
    expect(command).toBeDefined();
    if (command === undefined) return;
    const spec = mergeFlags(command.flags);
    const base = "nen shu tools";

    // Both dash counts, inline values (empty and non-empty), an over-dashed
    // form, and the wrong case -- the same shapes ../cli/args.ts is exercised
    // against for write flags, driven here through the boolean 'dry-run'.
    const spellings: string[] = [];
    for (const dashes of ["-", "--", "---"]) {
      spellings.push(`${dashes}dry-run`, `${dashes}dry-run=1`, `${dashes}dry-run=`, `${dashes}DRY-RUN`);
    }

    const trueSpellings: string[] = [];
    const otherSpellings: string[] = [];
    for (const spelling of spellings) {
      const line = `${base} ${spelling}`;
      const argv = line.split(" ").slice(1);
      let setsTrue = false;
      try {
        setsTrue = parseArgs(argv, spec).booleans.has("dry-run");
      } catch {
        // A UsageError means the invocation cannot run at all -- never a dry
        // run -- so the classifier's verdict for it must not be read-only
        // either. Asserted below, alongside the "parses but false" case.
      }
      const verdict = classifyCommand(line).classification;
      if (setsTrue) {
        trueSpellings.push(spelling);
        expect(verdict, line).toBe("read-only");
      } else {
        otherSpellings.push(spelling);
        expect(verdict, line).not.toBe("read-only");
      }
    }
    // Both dash counts must be in the accepted set -- the exact shape of the
    // bug this suite exists to close.
    expect(trueSpellings).toContain("--dry-run");
    expect(trueSpellings).toContain("-dry-run");
    // The inline-value spellings are refused by args.ts on this boolean flag,
    // so they must land among the rejected ones, never the accepted ones.
    expect(otherSpellings).toContain("--dry-run=1");
    expect(otherSpellings).toContain("-dry-run=1");
  });
});

// #31 ROUND FOUR, the PowerShell half. The safe set was reasoned about
// against bash, and two of its characters do something at a WORD BOUNDARY
// that bash does not do. Both were verified in this repository's own
// environment (Windows PowerShell 5.1, calling a native command):
//
//   $a = @('--run','extra'); cmd /c echo hi @a   ->  hi --run extra
//   cmd /c echo P --run, x                       ->  P --run x
//   cmd /c echo R x ,--run                       ->  R x --run
//
// So `@a` is ONE scanned token and TWO arguments, and a comma at either end
// of a word is STRIPPED -- either way a write flag reaches nen that the
// exact-token scan never saw. Closed in the same shape as round three's
// word-initial `#` guard: refused at the boundary, untouched mid-word, where
// both characters are inert and both are used by real nen tokens.
describe("classifyCommand -- PowerShell word-boundary characters inside the safe set (#31 round four)", () => {
  it("refuses a word-initial @ -- PowerShell splats it into several arguments", () => {
    expect(classifyCommand("nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake @a").classification).toBe(
      "unknown",
    );
    expect(classifyCommand("nen labels sync --target o/r @a").classification).toBe("mutating");
    expect(classifyCommand("nen dev test @a").classification).toBe("unknown");
    // In the VERB PATH it refuses for every policy, read-only rows included.
    expect(classifyCommand("nen --repo @a pr ready").classification).toBe("unknown");
  });

  it("keeps mid-word @ working -- it is inert to PowerShell and real nen tokens use it", () => {
    expect(classifyCommand("nen parse futon BC@high+").classification).toBe("read-only");
    expect(classifyCommand("nen repo resolve BC@G4").classification).toBe("read-only");
    expect(classifyCommand("nen wake fire --repo-slug git@host:o/r --ref XX-PR-#1 --label wake").classification).toBe(
      "read-only",
    );
  });

  it("refuses a comma at a word edge -- PowerShell strips it and hands nen the bare flag", () => {
    expect(classifyCommand("nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake ,--run").classification).toBe(
      "unknown",
    );
    // `--run,` is not the token --run to this scan (which is the whole
    // defect), so the write-flag HIT does not fire and the refusal comes from
    // the boundary rule instead: unknown, the write-flag-gated policy's own
    // refusing direction for "the flags' absence is not provable".
    expect(classifyCommand("nen wake fire --repo-slug o/r --ref XX-PR-#1 --label wake --run, x").classification).toBe(
      "unknown",
    );
    expect(classifyCommand("nen epic next-wave --body-file b.md ,-out x.md").classification).toBe("unknown");
    expect(classifyCommand("nen labels sync --target o/r , --dry-run").classification).toBe("mutating");
  });

  it("keeps mid-word commas working -- nen's own flags take comma lists", () => {
    expect(classifyCommand("nen labels rename --target o/r --map a=b,c=d --dry-run").classification).toBe("read-only");
    expect(classifyCommand("nen issue attach-sub --target o/r --parent 1 --children 2,3 --dry-run").classification).toBe(
      "read-only",
    );
  });
});

// zheref/nen#70. #31 bolted its metacharacter guard onto the two row families
// IT added and left the pre-existing gh/git rows as they were -- so `git log >
// out.txt` classified [read-only], and handed to a skill-side shell that
// verdict CERTIFIES a write. The guard now runs ONCE at classifyCommand's
// seam, ahead of every branch that can answer read-only, so a row cannot be
// added without it.
//
// Every line in this block was verified live against this binary BEFORE the
// fix. All of them printed `[read-only]`, and `nen parse izanami` exited 0 on
// the whole set.
describe("classifyCommand -- the metacharacter seam binds every read-only row (#70)", () => {
  it("refuses the issue's exact repro: git log > out.txt", () => {
    const result = classifyCommand("git log > out.txt");
    expect(result.classification).toBe("unknown");
    expect(result.classification).not.toBe("read-only");
    // ...and the WHOLE run goes with it, not just the offending step.
    expect(classifyInvocation({ commands: ["git log > out.txt"], condition: "it settles" }).ok).toBe(false);
  });

  // ONE LINE PER METACHARACTER CLASS the issue names, on a git row AND on a gh
  // row -- the two families that carried no guard -- plus the `<` that #31's
  // rounds had already widened the set by. A table rather than prose so a
  // class added to SHELL_METACHARS has one obvious place to be pinned.
  const METACHAR_ROWS: readonly { readonly klass: string; readonly git: string; readonly gh: string }[] = [
    { klass: ">", git: "git log > out.txt", gh: "gh pr view 42 > out.txt" },
    { klass: ">>", git: "git log >> out.txt", gh: "gh issue list >> out.txt" },
    { klass: "|", git: "git status | tee leak.txt", gh: "gh pr view 42 | tee leak.txt" },
    { klass: ";", git: "git status; git push", gh: "gh pr checks 42; git push" },
    { klass: "&", git: "git diff && git push", gh: "gh issue list && git push" },
    { klass: "backtick", git: "git diff `git push`", gh: "gh run list `git push`" },
    { klass: "$(", git: "git log $(git push)", gh: "gh run list $(git push)" },
    { klass: "newline", git: "git log\ngit push", gh: "gh pr view 42\ngit push" },
    { klass: "CR", git: "git log\rgit push", gh: "gh pr view 42\rgit push" },
    { klass: "<", git: "git log < in.txt", gh: "gh repo view < in.txt" },
  ];

  it("refuses every metacharacter class on a git row and on a gh row", () => {
    for (const row of METACHAR_ROWS) {
      expect(classifyCommand(row.git).classification, `git row, ${row.klass}`).toBe("unknown");
      expect(classifyCommand(row.gh).classification, `gh row, ${row.klass}`).toBe("unknown");
    }
  });

  // THE MUTATION-WORTHY ASSERTION, and the one that says "one mechanism, not
  // six". The mutant this kills is precisely the state the issue found the
  // module in: the guard present on SOME read-only path and absent from
  // another. Moving it out of classifyCommand's seam and back beside any
  // single row family -- gh/git, gh api, the plain reads, the nen verbs --
  // turns this red for the families left behind.
  it("no row family certifies a metacharacter line, whichever family it is", () => {
    const READS: readonly string[] = [
      "git log -1", // gh/git row, identity hinge
      "git branch --show-current", // gh/git row, line-scan hinge
      "git remote get-url origin", // gh/git row, line-scan hinge
      "gh pr checks 42", // gh row, identity hinge
      "gh issue list", // gh row, identity hinge
      "gh api repos/o/r/pulls/1", // the verified-GET gh api row
      "cat somefile.txt", // #31's plain-read row
      "nen pr ready 925 --gh-repo o/r", // #31's nen-verb row
    ];
    const METACHARS: readonly string[] = [">", ">>", "|", ";", "&", "`", "$(", "\n", "\r", "<"];
    for (const read of READS) {
      // The control first: clean, each of these is exactly what izanami is
      // for, so a guard that simply refused more would go red here too.
      expect(classifyCommand(read).classification, read).toBe("read-only");
      for (const meta of METACHARS) {
        const line = `${read} ${meta} git push`;
        expect(classifyCommand(line).classification, line).not.toBe("read-only");
      }
    }
  });

  it("leaves the genuinely clean gh/git reads exactly where they were", () => {
    const clean: readonly string[] = [
      "git log -1",
      "git fetch origin",
      "git status",
      "gh pr checks 42",
      "gh pr view 42 --json state",
      "gh issue list --state open",
      "gh api repos/o/r/pulls/1",
      "gh api -X GET repos/o/r",
    ];
    for (const line of clean) {
      expect(classifyCommand(line).classification, line).toBe("read-only");
    }
    expect(classifyInvocation({ commands: clean, condition: "it settles" }).ok).toBe(true);
  });

  it("keeps the NAMED mutating refusals named -- the seam sits after them", () => {
    // The seam intercepts read-only CERTIFICATIONS, not the head-anchored
    // refusals: when a line STARTS with a write, that rule holds whatever else
    // rides along, and naming the rule is the more actionable answer than a
    // generic "there is a metacharacter here". Nothing that was refused before
    // is refused less firmly now.
    expect(classifyCommand("git push origin main > out.txt").classification).toBe("mutating");
    expect(classifyCommand("gh pr create --title x | tee log").classification).toBe("mutating");
    expect(classifyCommand("git branch -D victim; echo done").classification).toBe("mutating");
  });

  it("names the rule and what to do instead -- an actionable refusal", () => {
    const reason = classifyCommand("git log > out.txt").reason;
    expect(reason).toMatch(/metacharacter/);
    expect(reason).toMatch(/git log > out\.txt/);
    expect(reason).toMatch(/yourself/);
  });
});

// zheref/nen#70, the half the issue did not ask for and #31's invariant did:
// a verdict that HINGES on a token scan is only worth anything on a line whose
// tokens are provably the ones its readers build. Two gh/git rows and the gh
// api row rest on exactly such a scan, and all three were live fail-opens --
// each line below printed `[read-only]` against this binary before the fix.
describe("classifyCommand -- the gh/git rows' own scan-dependence (#70)", () => {
  it("refuses a laundered flag on the $-anchored git rows", () => {
    // `git branch '-D'`: a real shell unquotes it and DELETES the branch.
    // MUTATING_PATTERNS misses it (it wants `(?:\s|^)-d`, and the quote is
    // neither), and the allowlist row's trailing `(\s+[^-\s]\S*)?$` then took
    // `'-D'` for an ordinary branch NAME.
    expect(classifyCommand("git branch '-D'").classification).toBe("unknown");
    expect(classifyCommand("git branch \\-D").classification).toBe("unknown");
    // `git remote 'prune'`: a real shell prunes the remote-tracking refs.
    expect(classifyCommand("git remote 'prune'").classification).toBe("unknown");
    expect(classifyCommand("git remote \\prune").classification).toBe("unknown");
  });

  it("refuses a laundered method on gh api -- a DELETE was certified as a GET", () => {
    // Round one's `([A-Za-z]+)` method capture could not match past the quote
    // a real shell strips, so the scan found NO method at all and fell through
    // to "GET by default". These stay "unknown" rather than "mutating" under
    // round two's walk too, and deliberately: `'DELETE'` is not a bare method
    // the walk can RESOLVE, and a refusal that named a method it did not read
    // would be a guess dressed as a fact.
    expect(classifyCommand("gh api repos/o/r/issues -X 'DELETE'").classification).toBe("unknown");
    expect(classifyCommand("gh api repos/o/r --method 'POST'").classification).toBe("unknown");
    expect(classifyCommand("gh api repos/o/r -X \\DELETE").classification).toBe("unknown");
    // The MUTATING answers stay ahead of the gate and unconditional -- that
    // direction only ever over-refuses.
    expect(classifyCommand("gh api -X POST repos/o/r/issues").classification).toBe("mutating");
    expect(classifyCommand("gh api graphql -f query=mutation").classification).toBe("mutating");
  });

  it("leaves the IDENTITY rows free to carry a quoted argument", () => {
    // These rows pin their subcommand with LITERAL words at LITERAL positions
    // AND the subcommand has no writing argument form at all (swept against gh
    // 2.92.0: no flag on any of them writes a file), so the verdict is the
    // subcommand's identity and no argument spelling can flip it. Gating them
    // would refuse plain reads for nothing -- the same reasoning that keeps
    // `nen watch until --command "gh pr checks 1"` read-only, and the
    // assertion that says this fix widened the refusal precisely, not bluntly.
    expect(classifyCommand('gh pr list --search "is:open"').classification).toBe("read-only");
    expect(classifyCommand("gh pr view 42 --jq '.state'").classification).toBe("read-only");
    expect(classifyCommand('gh issue list --search "is:open label:wake"').classification).toBe("read-only");
    expect(classifyCommand('git status --porcelain "C:/Program Files/x"').classification).toBe("read-only");
  });

  // ROUND TWO CORRECTED THIS TEST'S SUBJECT, not just its expectations. Round
  // one filed `git log`/`diff`/`show` under the identity hinge on the strength
  // of "no argument spelling changes WHICH subcommand runs" -- true, and
  // beside the point: all three WRITE on `--output`, verified against git
  // 2.53.0 (`git log --output=f` created f), and through a real shell the
  // LAUNDERED spelling writes too (`git log '--output' f` created f). So the
  // three rows are line-scan now, and the quoted forms round one pinned as
  // read-only are the deliberate cost of that -- pinned here so a future
  // widening argues with a test rather than with a comment.
  it("charges the quoted-argument cost on git log/diff/show, and admits the unquoted forms", () => {
    expect(classifyCommand('git log --grep "fix: thing"').classification).toBe("unknown");
    expect(classifyCommand('git diff --stat "C:/Program Files/x"').classification).toBe("unknown");
    // The caller's way out, and the control that says the refusal is about the
    // quote and not about the flag.
    expect(classifyCommand("git log --grep fix").classification).toBe("read-only");
    expect(classifyCommand("git diff --stat HEAD~1").classification).toBe("read-only");
    expect(classifyCommand("git show --stat HEAD").classification).toBe("read-only");
  });

  // zheref/nen#76's own review: this is the load-bearing hinge for GIT_FETCH_PLAIN
  // that had no direct pin. The allowlist regex itself, read on its own, would
  // admit `git fetch '--prune'` -- a quoted flag's leading '-' is hidden behind
  // the quote, so GIT_FETCH_PLAIN's `[^-+\s:][^\s:]*` positional arm matches the
  // WHOLE token `'--prune'` as if it were a bare ref. Only the "line-scan" hinge
  // (which re-checks isScanFaithfulLine and refuses on any quote) stops that from
  // reading read-only, exactly as it does for git log/diff/show and git branch
  // above. A real shell unquotes '--prune' into the bare flag that deletes a
  // remote-tracking ref, so this must NEVER classify read-only.
  it("GIT_FETCH_PLAIN stays gated by the line-scan hinge: a quoted '--prune' never classifies read-only", () => {
    expect(classifyCommand("git fetch '--prune'").classification).not.toBe("read-only");
    expect(classifyCommand("git fetch '--prune'").classification).toBe("unknown");
  });

  it("leaves the line-scan rows' clean listing forms untouched", () => {
    const listings: readonly string[] = [
      "git branch",
      "git branch -a",
      "git branch -l",
      "git branch --list",
      "git branch --show-current",
      "git branch --contains HEAD~1",
      // The two forms round one's trailing optional positional was actually
      // FOR -- a pattern for --list, a ref for --contains. They stay read-only;
      // the bare positional that rode in beside them does not (below).
      "git branch --list feature/x",
      "git branch -l feat",
      "git remote",
      "git remote -v",
      "git remote show origin",
      "git remote get-url origin",
      "git fetch",
      "git fetch origin",
      "git fetch --all",
    ];
    for (const line of listings) {
      expect(classifyCommand(line).classification, line).toBe("read-only");
    }
  });

  // A DELIBERATE COST, stated rather than discovered later: gating gh api on
  // scan-faithfulness refuses a --jq/--template read whose expression is
  // quoted, which IS a plain GET. That is the refusing direction, it is the
  // same trade #31 made for every flag-dependent nen verb, and the caller's
  // way out is the unquoted form below -- pinned so the cost stays visible and
  // a future widening has to argue with a test rather than with a comment.
  it("over-refuses a quoted gh api --jq, and admits the unquoted form", () => {
    expect(classifyCommand("gh api repos/o/r --jq '.name'").classification).toBe("unknown");
    expect(classifyCommand("gh api repos/o/r --jq .name").classification).toBe("read-only");
  });
});

// zheref/nen#70, ROUND TWO. Round one's three new guards each held in the
// spelling they were written against and failed one spelling over, and the
// review verified every line below against the real binaries -- gh 2.92.0 with
// GH_DEBUG=api printing the request gh actually built, git 2.53.0 in a
// throwaway repository, and PowerShell/cmd.exe/bash in this environment. Each
// `EXPECTED` line here classified [read-only] before this commit.
describe("classifyCommand -- #70 round two: the spellings the round-one guards missed", () => {
  // BLOCKER 1. `-X=DELETE` sent `DELETE /repos/o/r/issues` (verified), and
  // round one's method regex had an `=` arm for `--method` and none for `-X`
  // -- so it found NO method and fell through to "GET by default". The repair
  // is not the missing arm: pflag also takes the ATTACHED value (`-XDELETE`)
  // and GROUPS shorthands (`-iX DELETE`, also verified as a DELETE), so the
  // row walks the argv under pflag's rules and refuses anything it cannot
  // positively resolve to GET.
  const NON_GET_SPELLINGS: readonly string[] = [
    "gh api repos/o/r/issues -X=DELETE",
    "gh api repos/o/r/issues -XDELETE",
    "gh api repos/o/r/issues -X DELETE",
    "gh api repos/o/r/issues --method=DELETE",
    "gh api repos/o/r/issues --method DELETE",
    "gh api repos/o/r/issues -iX DELETE",
    "gh api repos/o/r/issues -iXDELETE",
    "gh api repos/o/r/issues -iX=DELETE",
    "gh api repos/o/r -H x:y -X DELETE",
  ];

  it("refuses every -X/--method spelling pflag accepts, not just the two round one knew", () => {
    for (const line of NON_GET_SPELLINGS) {
      const result = classifyCommand(line);
      expect(result.classification, line).toBe("mutating");
      expect(result.reason, line).toMatch(/non-GET method/);
    }
  });

  it("still admits every spelling that positively resolves to GET", () => {
    const gets: readonly string[] = [
      "gh api repos/o/r/issues",
      "gh api repos/o/r/issues -X GET",
      "gh api repos/o/r/issues -XGET",
      "gh api repos/o/r/issues -X=GET",
      "gh api repos/o/r/issues --method GET",
      "gh api repos/o/r/issues --method=GET",
      "gh api repos/o/r/issues -H Accept:application/json",
      "gh api repos/o/r/issues -i --paginate",
    ];
    for (const line of gets) {
      expect(classifyCommand(line).classification, line).toBe("read-only");
    }
  });

  // "GET by default" is the one answer this table may never reach by NOT
  // finding something. A method value the walk cannot resolve refuses rather
  // than falling through -- which is also what keeps the quote-laundering
  // repro above ("-X 'DELETE'") an "unknown" instead of a guess.
  it("refuses a method value it cannot positively resolve, rather than defaulting to GET", () => {
    for (const line of ["gh api repos/o/r -X", "gh api repos/o/r --method", "gh api repos/o/r --method="]) {
      expect(classifyCommand(line).classification, line).not.toBe("read-only");
    }
  });

  // BLOCKER 2. `-ftitle=pwned` sent `POST /repos/o/r/issues` (verified -- gh's
  // own 404 body names the create-an-issue endpoint), because round one's
  // field-flag regex demanded a word boundary after `-f` and pflag's attached
  // spelling gives it none. Reachable IN-BINARY through `watch until`'s direct
  // spawn, since gh parses the argv the same way with or without a shell.
  it("refuses every -f/-F/--field/--raw-field/--input spelling, attached ones included", () => {
    const posts: readonly string[] = [
      "gh api repos/o/r/issues -ftitle=pwned",
      "gh api repos/o/r/issues -Ftitle=pwned",
      "gh api repos/o/r/issues -f title=pwned",
      "gh api repos/o/r/issues -F title=pwned",
      "gh api repos/o/r/issues -if title=pwned",
      "gh api repos/o/r/issues --field title=pwned",
      "gh api repos/o/r/issues --field=title=pwned",
      "gh api repos/o/r/issues --raw-field=title=pwned",
      "gh api repos/o/r/issues --input=body.json",
    ];
    for (const line of posts) {
      const result = classifyCommand(line);
      expect(result.classification, line).toBe("mutating");
      expect(result.reason, line).toMatch(/POST once any parameter is given/);
    }
  });

  // The walk is an ALLOWLIST, which is what makes it survive gh's next
  // release: a flag that is not in the table is not assumed inert.
  it("refuses a gh api flag the table does not classify, rather than ignoring it", () => {
    expect(classifyCommand("gh api repos/o/r --frobnicate").classification).toBe("unknown");
    expect(classifyCommand("gh api repos/o/r -Z").classification).toBe("unknown");
    expect(classifyCommand("gh api repos/o/r -- extra").classification).toBe("unknown");
    expect(classifyCommand("gh api repos/o/r extra-endpoint").classification).toBe("unknown");
  });

  // BLOCKER 3, and the one the reviewer proved by running it: `nen watch
  // until --command "git branch nen70-probe"` classified read-only and
  // ACTUALLY CREATED the branch, in-binary, with no shell anywhere. Round
  // one's trailing optional positional was added for `--list <pat>` and
  // `--contains <ref>` and admitted the bare CREATE form with them -- and its
  // own test pinned `git branch feature/x` as correctly read-only.
  it("refuses the bare create forms of git branch, which round one pinned as read-only", () => {
    for (const line of ["git branch nen70-probe", "git branch feature/x", "git branch topic main"]) {
      const result = classifyCommand(line);
      expect(result.classification, line).toBe("mutating");
      expect(result.classification, line).not.toBe("read-only");
      expect(classifyInvocation({ commands: [line], condition: "it settles" }).ok, line).toBe(false);
    }
  });

  // Verified against git 2.53.0, and it decides which listing flags may carry
  // a positional at all: `-l zzz` and `--list zzz` LIST by pattern, `-a zzz`
  // is a usage error git refuses outright -- and `git branch -v zzz-v`
  // CREATED the branch zzz-v. That last one matched round one's row too.
  it("refuses a positional beside a listing flag that does not take one", () => {
    for (const line of ["git branch -v zzz-v", "git branch -a zzz", "git branch -r zzz", "git branch --show-current zzz"]) {
      expect(classifyCommand(line).classification, line).not.toBe("read-only");
    }
  });

  // THE SIBLING SWEEP the blocker asked for, each verified: `git remote
  // update` fetched and created refs/remotes/origin/late; `git fetch --prune`
  // deleted refs/remotes/origin/doomed; `git fetch origin main:local` created
  // the LOCAL branch refs/heads/local; `git log|diff|show --output f` created
  // f in both spellings.
  it("refuses the write-capable forms of the sibling git rows", () => {
    const writes: readonly string[] = [
      "git remote update",
      "git remote set-branches origin main",
      "git fetch --prune",
      "git fetch -p",
      "git fetch --prune-tags",
      "git fetch --force origin main",
      "git fetch origin main:local",
      "git fetch origin +refs/heads/main:refs/heads/main",
      "git log --output=out.txt",
      "git log --output out.txt",
      "git diff --output=out.txt HEAD",
      "git show --output=out.txt",
    ];
    for (const line of writes) {
      expect(classifyCommand(line).classification, line).not.toBe("read-only");
      expect(classifyInvocation({ commands: [line], condition: "it settles" }).ok, line).toBe(false);
    }
  });

  // THE ROWS, NOT THE NAMED LIST, ARE THE GUARD -- and this is the assertion
  // that says so. Every line above is ALSO caught by a MUTATING_PATTERNS arm,
  // so reverting `git remote`'s or `git fetch`'s row to round one's
  // free-positional shape left the suite green: the named list was carrying
  // them, and a named list has to win every round. A word or a flag NOBODY has
  // enumerated must refuse on the row's own terms, which is what makes the
  // next `git remote <verb>` fail closed instead of waiting for a review.
  it("refuses an UNNAMED word or flag on the git remote and git fetch rows", () => {
    for (const line of [
      "git remote gc",
      "git remote nosuchsubcommand",
      "git remote nosuchsubcommand origin",
      "git fetch --recurse-submodules",
      "git fetch --unshallow",
      "git fetch --depth 1 origin",
      "git fetch --nosuchflag origin",
    ]) {
      expect(classifyCommand(line).classification, line).not.toBe("read-only");
    }
  });

  // A named refusal is not load-bearing for SAFETY, but the laundered spelling
  // must still refuse -- which is the whole reason log/diff/show became
  // line-scan rows instead of merely acquiring a `--output` refusal. Through a
  // real shell, `git log '--output' f` created f.
  it("refuses a laundered --output that the named refusal alone would miss", () => {
    expect(classifyCommand("git log '--output' out.txt").classification).toBe("unknown");
    expect(classifyCommand("git log \\--output out.txt").classification).toBe("unknown");
    expect(classifyCommand("git show '--output' out.txt").classification).toBe("unknown");
  });

  // MAJOR. Round one's SHELL_METACHARS comment claimed every second-command
  // construct in bash, PowerShell OR cmd.exe passed through the guarded set.
  // False twice, both verified in this environment: `cmd /c echo (whoami)`
  // printed this machine's user name (PowerShell runs a parenthesised
  // subexpression in ARGUMENT position), and `cmd /c "echo start %X%"` with X
  // set to `&& whoami` printed `start` and then RAN whoami (cmd expands %VAR%
  // BEFORE it parses for special characters). Both classified [read-only].
  it("refuses PowerShell's parenthesised subexpression and cmd.exe's %VAR% expansion", () => {
    const lines: readonly string[] = [
      "git log (git push)",
      "gh pr view 42 (git push)",
      "cat (git push)",
      "git diff %X%",
      "git log %CD%",
      "gh issue list %X%",
      "nen pr ready 925 --gh-repo o/r %X%",
    ];
    for (const line of lines) {
      const result = classifyCommand(line);
      expect(result.classification, line).not.toBe("read-only");
      expect(result.reason, line).toMatch(/metacharacter/);
    }
  });

  // MINOR. Round one hard-coded `git log > out.txt` as the example in every
  // metacharacter refusal, so a caller who typed something else was answered
  // about a line they never wrote -- and a refusal a caller does not believe
  // is a refusal they route around.
  it("quotes the caller's OWN line in the metacharacter refusal", () => {
    expect(classifyCommand("git diff %X%").reason).toMatch(/'git diff %X%'/);
    expect(classifyCommand("gh pr view 42 | tee leak.txt").reason).toMatch(/'gh pr view 42 \| tee leak\.txt'/);
    // The CR and LF that are themselves in the set are rendered, not pasted,
    // so the reason stays one readable line.
    expect(classifyCommand("git log\ngit push").reason).toMatch(/'git log\\ngit push'/);
  });

  // MINOR, and the mutant that survived round one's whole suite. The seam
  // tests SHELL_METACHARS against the RAW command rather than `trimmed`,
  // because String.trim() strips the newline and CR that are themselves in the
  // set -- a guard whose own input can be laundered by the call in front of it
  // is not a guard. Round one argued that in prose and pinned nothing, so
  // swapping `command` for `trimmed` at the seam stayed green. It does not
  // now: a trailing separator is the only shape where the two differ.
  it("kills the trimmed-seam mutant: a TRAILING newline or CR still refuses", () => {
    for (const line of ["git log\n", "git log\r", "git log \n", "gh pr checks 42\r\n", "\ncat somefile.txt"]) {
      const result = classifyCommand(line);
      expect(result.classification, JSON.stringify(line)).toBe("unknown");
      expect(result.reason, JSON.stringify(line)).toMatch(/metacharacter/);
    }
    // The control the mutant hid behind: without the separator these are the
    // reads the seam must not touch.
    expect(classifyCommand("git log").classification).toBe("read-only");
    expect(classifyCommand("  git log  ").classification).toBe("read-only");
  });

  // MINOR. The seam sits after MUTATING_PATTERNS so a head-anchored refusal
  // keeps its name -- and round one left gh api's THREE named refusals on the
  // far side of it, so `gh api ... -X POST | tee x` came back as a generic
  // "there is a metacharacter here". gh api's mutating half is read before the
  // seam now; its read-only half still is not, which is the ordering that
  // matters.
  it("keeps gh api's named mutating refusals named behind a metacharacter", () => {
    expect(classifyCommand("gh api repos/o/r -X POST | tee x").reason).toMatch(/non-GET method \(POST\)/);
    expect(classifyCommand("gh api repos/o/r -f title=pwned > out.txt").reason).toMatch(/POST once any parameter/);
    expect(classifyCommand("gh api graphql; git push").reason).toMatch(/graphql/);
    // ...and the read-only half stays BEHIND the seam, which is the half the
    // seam exists for: a metacharacter line is never certified.
    expect(classifyCommand("gh api repos/o/r/pulls/1 | tee leak.txt").classification).toBe("unknown");
    expect(classifyCommand("gh api repos/o/r/pulls/1 | tee leak.txt").reason).toMatch(/metacharacter/);
  });
});

// THE FORWARDING ROWS ARE COUPLED TO REALITY (#31 round three), the same way
// the pr-fetch rows are coupled to reviewsArgv's pinned method below: the
// table's claim is "these two subcommands, and only these two, hand post-`--`
// argv to another program". If a future verb starts forwarding a passthrough
// while keeping a plain "read-only" row, its `--` guard becomes load-bearing
// again with no scan-faithfulness behind it -- so both halves are pinned.
describe("NEN_VERB_TABLE -- the forwarding rows match who actually forwards", () => {
  it("dev test/lint really splice the passthrough back behind a '--'", () => {
    expect(devTestArgv(["-u"])).toEqual(["run", "test", "--", "-u"]);
    expect(devLintArgv(["--fix"])).toEqual(["run", "lint", "--", "--fix"]);
  });

  it("marks exactly dev test and dev lint as read-only-forwarding", () => {
    const forwarding: string[] = [];
    for (const [family, entry] of Object.entries(NEN_VERB_TABLE)) {
      for (const [sub, policy] of Object.entries(entry.subcommands)) {
        if (policy.kind === "read-only-forwarding") forwarding.push(`${family} ${sub}`);
      }
    }
    expect(forwarding.sort()).toEqual(["dev lint", "dev test"]);
    // replay takes --slice-dir and forwards nothing, so its verdict is verb
    // identity alone -- the row that proves the distinction is real and not
    // just "the dev family is special".
    expect(NEN_VERB_TABLE["dev"]?.subcommands["replay"]?.kind).toBe("read-only");
  });
});

// THE EXHAUSTIVENESS TEST (#31): the table is worthless the day a verb family
// lands without a row, because that family would silently classify "unknown"
// forever -- correct in the fail-closed direction, but exactly the "every nen
// verb refuses" defect this issue is about, re-introduced one verb at a time.
// So the table's keys must equal the REAL registry's names, both directions:
// a registered family missing here goes RED, and a stale key naming no
// registered family goes RED too.
describe("NEN_VERB_TABLE -- exhaustive over the real verb registry", () => {
  it("classifies every registered verb family, and nothing else", () => {
    const registered = COMMANDS.map((command): string => command.name).sort();
    const tabled = Object.keys(NEN_VERB_TABLE).sort();
    expect(tabled).toEqual(registered);
  });

  it("keeps the pre-registry commands separate from the registry's names", () => {
    // Folding bootstrap/schema/version into the main table would let a stale
    // registry row hide behind a pre-registry name; the two key sets must
    // never intersect.
    const registered = new Set(COMMANDS.map((command): string => command.name));
    for (const name of Object.keys(NEN_PRE_REGISTRY_TABLE)) {
      expect(registered.has(name)).toBe(false);
    }
    expect(Object.keys(NEN_PRE_REGISTRY_TABLE).sort()).toEqual(["bootstrap", "schema", "version"]);
  });

  it("every table policy is one of the six closed kinds", () => {
    // Five since #31 round three added read-only-forwarding; six since
    // zheref/nen#113 added dry-run-only for the one verb with THREE answers
    // rather than two. This set is spelled out rather than derived from the
    // union so that ADDING a policy kind cannot land without a reviewer also
    // stating, here, that its scan-dependence was thought about (see
    // evaluateNenPolicy's switch).
    const kinds = new Set([
      "read-only",
      "read-only-forwarding",
      "mutating",
      "dry-run-gated",
      "write-flag-gated",
      "dry-run-only",
    ]);
    for (const entry of Object.values(NEN_VERB_TABLE)) {
      const keys = Object.keys(entry.subcommands);
      expect(keys.length).toBeGreaterThan(0);
      for (const policy of Object.values(entry.subcommands)) {
        expect(kinds.has(policy.kind)).toBe(true);
        if (policy.kind === "write-flag-gated" || policy.kind === "dry-run-only") {
          expect(policy.writeFlags.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("uses dry-run-only for exactly one row, the one verb that acts on the HOST", () => {
    // The narrowest kind in the table, and it should stay that way: a second
    // row appearing here is a reviewer's conversation, not a silent widening.
    const rows: string[] = [];
    for (const [family, entry] of Object.entries(NEN_VERB_TABLE)) {
      for (const [sub, policy] of Object.entries(entry.subcommands)) {
        if (policy.kind === "dry-run-only") rows.push(`${family} ${sub}`);
      }
    }
    expect(rows).toEqual(["shu tools"]);
  });
});

// THE EXHAUSTIVENESS TEST ABOVE IS REGISTRY-KEYED, NOT SUBCOMMAND-KEYED, and
// that asymmetry is the reason this block exists. A new FAMILY missing from the
// table goes red; a new SUBCOMMAND on an existing family falls through to
// `unknown` and refuses -- fail-closed, but INVISIBLE. So `shu`'s thirteen are
// enumerated here with the policy each one carries, and the reason the
// executing ten carry `dry-run-gated` rather than `read-only`: the argv they
// run comes out of a file in the TARGET repository, and a read-only row would
// certify it sight unseen.
//
// AN EARLIER DRAFT LEFT FOUR OF THEM OUT, so that `shu test`, `ui-test`, `lint`
// and `coverage` classified `unknown`. That was fail-closed and also wrong:
// `unknown` refuses in EVERY form, so `nen shu lint --dry-run` was refused too,
// while the docs (and this file) said `--dry-run` was the form a watcher could
// use. `dry-run-gated` says the true thing -- the bare form is not certified,
// the dry run is -- and the dry run's read-only-ness is a property of nen
// rather than a claim about somebody's argv.
describe("NEN_VERB_TABLE -- the shu family, every verb classified", () => {
  const shu = NEN_VERB_TABLE["shu"];

  it("classifies exactly the thirteen subcommands the family has, and no others", () => {
    expect(Object.keys(shu?.subcommands ?? {}).sort()).toEqual([...SHU_SUBCOMMANDS].sort());
  });

  it("gives every EXECUTING verb the dry-run gate, and no other kind", () => {
    for (const verb of EXECUTING_VERBS) {
      expect(shu?.subcommands[verb]?.kind, verb).toBe("dry-run-gated");
      expect(classifyCommand(`nen shu ${verb}`).classification, verb).toBe("mutating");
      expect(classifyCommand(`nen shu ${verb} --dry-run`).classification, verb).toBe("read-only");
    }
  });

  it("keeps 'deploy' MUTATING in every real form, and read-only only under --dry-run", () => {
    // THE ONE VERB IN THIS FAMILY WHOSE BLAST RADIUS IS OTHER PEOPLE'S USERS,
    // pinned with the flags a real line carries: `--target` is mandatory on it,
    // so a table that classified the bare `nen shu deploy` correctly and lost
    // the classification the moment a caller typed the flag it REQUIRES would
    // be right about a command nobody runs.
    expect(shu?.subcommands["deploy"]?.kind).toBe("dry-run-gated");
    for (const line of [
      "nen shu deploy",
      "nen shu deploy --target production",
      "nen shu deploy --repo /tmp/x --lane web --target production",
    ]) {
      expect(classifyCommand(line).classification, line).toBe("mutating");
    }
    for (const line of [
      "nen shu deploy --dry-run --target production",
      "nen shu deploy --target production --dry-run",
      "nen shu deploy --repo /tmp/x --lane web --target production --dry-run --json",
    ]) {
      expect(classifyCommand(line).classification, line).toBe("read-only");
    }
  });

  it("so the four that used to be unclassified are now watchable with --dry-run", () => {
    // The regression this row exists for, stated in the terms the review found
    // it in: these four were absent, so BOTH forms refused.
    for (const verb of ["test", "ui-test", "lint", "coverage"]) {
      expect(classifyCommand(`nen shu ${verb}`).classification, verb).toBe("mutating");
      expect(classifyCommand(`nen shu ${verb} --dry-run`).classification, verb).toBe("read-only");
    }
  });

  it("gates detect on --write", () => {
    expect(classifyCommand("nen shu detect").classification).toBe("read-only");
    expect(classifyCommand("nen shu detect --write").classification).toBe("mutating");
  });

  // `shu tools` HAS THREE ANSWERS, and this is the PR-4 resolution of the TODO
  // the row carried since the family shipped (zheref/nen#113). It used to be
  // `write-flag-gated`, which certified the BARE form read-only on the strength
  // of a verb nobody had written yet. Built, the check form spawns the `probe`
  // argv out of the TARGET repository's `project.toolchain` -- the same
  // provenance that makes every executing row `dry-run-gated` rather than
  // read-only. A `--version` query is a convention, not a proof.
  describe("tools -- unknown bare, mutating with --install, read-only with --dry-run", () => {
    it("does not certify the bare form: nen did not choose the program it runs", () => {
      const bare = classifyCommand("nen shu tools");
      expect(bare.classification).toBe("unknown");
      // UNKNOWN, NOT MUTATING, and the distinction is the point: a declared
      // version probe is not evidence of a write. Both refuse; this one is
      // true, and the reason a caller reads says which.
      expect(bare.reason).toContain("TARGET repository");
    });

    it("classifies --install mutating, in every spelling the real parser takes", () => {
      expect(classifyCommand("nen shu tools --install").classification).toBe("mutating");
      expect(classifyCommand("nen shu tools -install").classification).toBe("mutating");
    });

    it("certifies --dry-run: on this verb a dry run spawns nothing, probes included", () => {
      const dry = classifyCommand("nen shu tools --dry-run");
      expect(dry.classification).toBe("read-only");
      expect(dry.reason).toContain("probes included");
      expect(classifyCommand("nen shu tools --repo /tmp/x --lane web --dry-run").classification).toBe(
        "read-only",
      );
    });

    // #120 THREAD 2. `../cli/args.ts` strips one leading dash or two alike
    // (`token.replace(/^--?/, "")`), so `-dry-run` sets the very same boolean
    // `--dry-run` does -- `nen shu tools -dry-run` is a real dry run that
    // spawns nothing, and the classifier used to answer `unknown` for it
    // because the gate matched only the exact `--dry-run` token. Fixed to use
    // findFlagToken, the same spelling-aware matcher the write-flag side (and
    // `--install` just above) already used.
    it("certifies -dry-run too -- the same flag to ../cli/args.ts as --dry-run", () => {
      const dry = classifyCommand("nen shu tools -dry-run");
      expect(dry.classification).toBe("read-only");
      expect(dry.reason).toContain("probes included");
      expect(classifyCommand("nen shu tools --repo /tmp/x --lane web -dry-run").classification).toBe(
        "read-only",
      );
    });

    it("refuses --install --dry-run anyway -- the write flag is decisive", () => {
      // A DELIBERATE OVER-REFUSAL of a line that provably runs nothing (nen
      // checks the dry run before the install). `--install` is the one flag in
      // this CLI whose blast radius is the developer's machine, and a
      // read-only claim that depends on an adjacent token still being present
      // is the exact shape the write-flag rule exists for.
      expect(classifyCommand("nen shu tools --install --dry-run").classification).toBe("mutating");
      expect(classifyCommand("nen shu tools --dry-run --install").classification).toBe("mutating");
      // ...and the same holds for the single-dash spellings of both.
      expect(classifyCommand("nen shu tools -install -dry-run").classification).toBe("mutating");
      expect(classifyCommand("nen shu tools -dry-run -install").classification).toBe("mutating");
    });

    it("refuses the dry-run form on a line whose tokens are not provably arguments", () => {
      // The one ADMITTING branch of this policy, held to the same
      // scan-faithfulness bar every other admitting branch is.
      expect(classifyCommand(`nen shu tools --repo "a b" --dry-run`).classification).toBe("unknown");
      expect(classifyCommand(`nen shu tools --repo "a b" -dry-run`).classification).toBe("unknown");
    });

    // THE DECISION ON `--dry-run=<x>` (#120 thread 2). `dry-run` is declared a
    // BOOLEAN flag on `shu tools` (../shu/command.ts's SHU_SUBCOMMAND_FLAGS),
    // and ../cli/args.ts refuses an inline value on a boolean outright --
    // `--dry-run=true` never reaches shu's own code at all, it is a usage
    // error. So this spelling is not read as the gate: certifying it
    // read-only would be certifying a line that cannot run as a dry run (it
    // cannot run at all), and could mean the opposite to a different tool a
    // shell handed it to. It stays `unknown`, with a reason that says why,
    // rather than silently falling through to the generic bare-form message.
    it("refuses --dry-run=<x> and -dry-run=<x> -- args.ts refuses an inline value on this boolean", () => {
      for (const line of [
        "nen shu tools --dry-run=true",
        "nen shu tools -dry-run=true",
        "nen shu tools --dry-run=false",
      ]) {
        const result = classifyCommand(line);
        expect(result.classification, line).toBe("unknown");
        expect(result.reason, line).toContain("boolean flag");
      }
      // ...and a bare --dry-run elsewhere on the same line does not rescue it:
      // args.ts throws on the inline-value token regardless of where it falls.
      expect(classifyCommand("nen shu tools --dry-run --dry-run=true").classification).toBe("unknown");
    });
  });

  it("refuses `shu warmup` in EVERY form, dry run included", () => {
    expect(classifyCommand("nen shu warmup").classification).toBe("mutating");
    expect(classifyCommand("nen shu warmup --dry-run").classification).toBe("mutating");
  });

  it("still refuses a subcommand this family does not have", () => {
    // The fail-closed floor is unchanged: only the thirteen are classified, and
    // a fourteenth arriving without a row here classifies `unknown`.
    expect(classifyCommand("nen shu invented").classification).toBe("unknown");
  });

  // NenFamilyEntry's own doc comment reserves "*" for a family whose flags
  // select the behaviour or whose every subcommand shares one policy. Three of
  // these thirteen are not `dry-run-gated`, so a "*" row would certify them.
  it("carries no wildcard row", () => {
    expect(Object.keys(shu?.subcommands ?? {})).not.toContain("*");
  });
});

// TABLE-VS-REALITY (#31's review blocker, fixed module-wide by zheref/nen#19):
// the table's read-only rows for `pr fetch`/`pr next-blocker` certify
// ../pr/fetch.ts's REST reviews call, and that call is a GET only while
// reviewsArgv pins `--method GET` -- gh's documented default flips to POST
// the moment any -f/-F parameter is given (the exact rule the gh api walk
// encodes), and a POST to /pulls/<n>/reviews CREATES a pending review.
// fetch.test.ts's #19 sweep holds the method invariant over every argv
// builder in that module; this test pins the COUPLING from the classifier's
// side, so whichever module a refactor touches first, the certification
// cannot silently go false: either the method stays pinned, or these rows
// must stop claiming read-only. (Deliberately position-agnostic about WHERE
// --method sits in the argv -- the invariant is the pair's presence, not its
// slot.)
describe("NEN_VERB_TABLE -- the pr fetch rows certify a pinned-GET reviews call", () => {
  it("reviewsArgv carries an explicit --method GET next to its -F parameter", () => {
    const argv = reviewsArgv({ owner: "o", repo: "r", slug: "o/r" }, 1);
    const methodAt = argv.indexOf("--method");
    expect(methodAt).toBeGreaterThanOrEqual(0);
    expect(argv[methodAt + 1]).toBe("GET");
    // And the classifier itself still refuses the UNPINNED raw form -- the
    // very laundering the review proved: dropping the method pair from the
    // argv reconstructs a line this table calls mutating.
    const unpinned = argv.filter((token, index): boolean => index !== methodAt && index !== methodAt + 1);
    expect(classifyCommand(`gh ${unpinned.join(" ")}`).classification).toBe("mutating");
  });
});

describe("classifyInvocation -- refuse the WHOLE run, not the offending step", () => {
  it("is ok only when every command is read-only", () => {
    const result = classifyInvocation({ commands: ["gh pr view 1", "git fetch origin"], condition: "x" });
    expect(result.ok).toBe(true);
  });

  it("is refused entirely when even one command is not read-only", () => {
    const result = classifyInvocation({ commands: ["gh pr view 1", "git push"], condition: "x" });
    expect(result.ok).toBe(false);
    expect(result.commands.map((c): string => c.classification.classification)).toEqual([
      "read-only",
      "mutating",
    ]);
  });
});
