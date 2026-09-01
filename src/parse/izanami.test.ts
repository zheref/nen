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
