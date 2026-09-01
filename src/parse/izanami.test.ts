import { describe, expect, it } from "vitest";
import { classifyCommand, classifyInvocation, parseIzanamiInvocation } from "./izanami.js";

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
