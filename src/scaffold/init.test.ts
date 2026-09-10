import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderCanonValuesTemplate, scaffoldInit } from "./init.js";

const HOOK = { agentTrailer: "X-Agent", runTrailer: "X-Run", markerEnvVar: "X_AUTOMATED" };

// A STACK IS NOW REQUIRED, AND THE TAXONOMY LAYER IS UNCHANGED BY IT. Every
// assertion in this describe block is v0.2.0's, verbatim; the only edit is the
// flag the verb now refuses to run without. ./stack.test.ts is where the layer
// this flag switches on is tested, and its first case is the byte-parity one:
// with a stack named, the directories, the hook and the canon-values template
// come out exactly as they did before this change.
const STACK = "nextjs";

// A lane id the proposal ends up declaring for this stack, so the policy's
// `iteration.lane` can be asserted against something real.

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "nen-scaffold-"));
}

describe("scaffoldInit", () => {
  it("creates every requested directory that does not exist", () => {
    const root = tempRoot();
    const result = scaffoldInit({ root, platform: "linux", directories: ["src", "tests"], hook: HOOK, stack: STACK });
    expect(existsSync(join(root, "src"))).toBe(true);
    expect(existsSync(join(root, "tests"))).toBe(true);
    expect(result.createdDirectories.length).toBeGreaterThanOrEqual(2);
  });

  it("is idempotent -- a second run creates nothing new for existing directories", () => {
    const root = tempRoot();
    scaffoldInit({ root, platform: "linux", directories: ["src"], hook: HOOK, stack: STACK });
    const second = scaffoldInit({ root, platform: "linux", directories: ["src"], hook: HOOK, stack: STACK });
    expect(second.createdDirectories).toEqual([]);
  });

  it("writes the commit-msg hook at the default path", () => {
    const root = tempRoot();
    const result = scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    expect(result.hookWritten).toBe(join(root, ".git", "hooks", "commit-msg"));
    expect(result.hookOutcome).toBe("installed");
    expect(readFileSync(result.hookWritten, "utf8")).toContain("X-Agent");
  });

  it("is idempotent for the hook -- a second run with the same spec reports 'unchanged', not 'installed'", () => {
    const root = tempRoot();
    scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    const second = scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    expect(second.hookOutcome).toBe("unchanged");
  });

  // Review finding #5: scaffoldInit used to clobber an existing hook
  // unconditionally, with no guard, no backup and no record.
  it("REFUSES to clobber a pre-existing, DIFFERENT commit-msg hook (MAJOR #5)", () => {
    const root = tempRoot();
    const hookPath = join(root, ".git", "hooks", "commit-msg");
    mkdirSync(dirname(hookPath), { recursive: true });
    const projectsOwnHook = "#!/bin/sh\n# THE PROJECT OWNS THIS HOOK - do not clobber\nexit 0\n";
    writeFileSync(hookPath, projectsOwnHook);

    const result = scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });

    expect(result.hookOutcome).toBe("refused");
    expect(result.hookError).toMatch(/already exists/);
    expect(result.hookError).toMatch(/--force/);
    // The project's hook must survive untouched.
    expect(readFileSync(hookPath, "utf8")).toBe(projectsOwnHook);
    expect(existsSync(`${hookPath}.bak`)).toBe(false);
  });

  it("--force replaces a differing hook, but backs up the original first", () => {
    const root = tempRoot();
    const hookPath = join(root, ".git", "hooks", "commit-msg");
    mkdirSync(dirname(hookPath), { recursive: true });
    const projectsOwnHook = "#!/bin/sh\n# THE PROJECT OWNS THIS HOOK\nexit 0\n";
    writeFileSync(hookPath, projectsOwnHook);

    const result = scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK, force: true });

    expect(result.hookOutcome).toBe("installed");
    expect(readFileSync(hookPath, "utf8")).toContain("X-Agent");
    expect(readFileSync(`${hookPath}.bak`, "utf8")).toBe(projectsOwnHook);
  });

  it("takes a caller-supplied hook path", () => {
    const root = tempRoot();
    const result = scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK, hookPath: "custom/hooks/commit-msg" });
    expect(result.hookWritten).toBe(join(root, "custom", "hooks", "commit-msg"));
  });

  it("writes a canon-values template only when a path is given, and never overwrites an existing one", () => {
    const root = tempRoot();
    const withoutPath = scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    expect(withoutPath.canonValuesWritten).toBeNull();

    const result = scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK, canonValuesPath: "canon-values.yml", scenario: "scenario-x" });
    expect(result.canonValuesWritten).not.toBeNull();
    const content = readFileSync(result.canonValuesWritten as string, "utf8");
    expect(content).toContain("scenario: scenario-x");

    // Hand-edit it, then re-init: the file must not be clobbered.
    const path = result.canonValuesWritten as string;
    writeFileSync(path, "hand edited");
    scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK, canonValuesPath: "canon-values.yml", scenario: "scenario-x" });
    expect(readFileSync(path, "utf8")).toBe("hand edited");
  });

  it("chmods the hook file (best-effort) so it is executable where the platform supports it", () => {
    const root = tempRoot();
    const result = scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    // Just confirms the file exists and is readable -- the mode bit itself is
    // platform-dependent (Windows filesystems do not model it the same way),
    // which is exactly why scaffoldInit treats chmod as best-effort.
    expect(statSync(result.hookWritten).isFile()).toBe(true);
  });
});

describe("renderCanonValuesTemplate", () => {
  it("includes the scenario field when given", () => {
    expect(renderCanonValuesTemplate("scenario-x")).toContain("scenario: scenario-x");
  });

  it("omits the scenario field when not given", () => {
    expect(renderCanonValuesTemplate(undefined)).not.toContain("scenario:");
  });
});

// ── the policy file and the two hooks made out of it ────────────────────────

describe("scaffoldInit -- nen/workflow.json", () => {
  function policyOf(root: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(root, "nen", "workflow.json"), "utf8")) as Record<
      string,
      unknown
    >;
  }

  it("writes the default policy into absence, with the scaffolded lane in it", () => {
    const root = tempRoot();
    scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    const policy = policyOf(root);
    expect((policy["iteration"] as Record<string, unknown>)["lane"]).toBe(STACK);
    expect((policy["coverage"] as Record<string, unknown>)["minimum"]).toBe(80);
  });

  it("admits exactly the one agent-trailer key the caller stated, and writes the run trailer separately", () => {
    // nen ships no trailer convention, so the allow-list can only be the
    // caller's own -- the same rule ./hook.ts's header states about the hook.
    // The run trailer is never itself an attribution trailer, so it goes into
    // its own `commits.runTrailer` key rather than the allow-list
    // (zheref/nen#167).
    const root = tempRoot();
    scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    const commits = policyOf(root)["commits"] as Record<string, unknown>;
    expect(commits["allowedAttributionTrailers"]).toEqual(["X-Agent"]);
    expect(commits["runTrailer"]).toBe("X-Run");
  });

  it("writes commits.runTrailer as null when --run-trailer named none", () => {
    const root = tempRoot();
    scaffoldInit({
      root,
      platform: "linux",
      directories: [],
      hook: { agentTrailer: "Akatsuki-Agent", runTrailer: null, markerEnvVar: "X_AUTOMATED" },
      stack: STACK,
    });
    const commits = policyOf(root)["commits"] as Record<string, unknown>;
    expect(commits["allowedAttributionTrailers"]).toEqual(["Akatsuki-Agent"]);
    expect(commits["runTrailer"]).toBeNull();
  });

  it("is idempotent: a second run reports 'skipped' and rewrites nothing", () => {
    const root = tempRoot();
    scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    const before = readFileSync(join(root, "nen", "workflow.json"), "utf8");
    const second = scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    expect(readFileSync(join(root, "nen", "workflow.json"), "utf8")).toBe(before);
    expect(
      second.writes.find((write): boolean => write.path === "nen/workflow.json")?.action,
    ).toBe("skipped");
  });

  it("NEVER overwrites a policy somebody wrote -- and generates the hooks FROM it", () => {
    const root = tempRoot();
    mkdirSync(join(root, "nen"), { recursive: true });
    const theirs = JSON.stringify({
      branch: { base: "trunk" },
      commits: { allowedAttributionTrailers: ["Signed-off-by"] },
    });
    writeFileSync(join(root, "nen", "workflow.json"), theirs);
    const result = scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    expect(readFileSync(join(root, "nen", "workflow.json"), "utf8")).toBe(theirs);
    // The trunk guard names THEIR trunk...
    expect(readFileSync(result.preCommitWritten, "utf8")).toContain('base="trunk"');
    // ...and the commit-msg guard admits THEIR trailer while refusing the rest.
    const hook = readFileSync(result.hookWritten, "utf8");
    expect(hook).not.toContain("^Signed-off-by:");
    expect(hook).toContain("^Co-Authored-By:");
    // THEIR policy does not admit HOOK.agentTrailer ('X-Agent') at all, so the
    // automated half refuses every automated commit rather than checking for a
    // trailer nobody could ever add (zheref/nen#167).
    expect(hook).not.toContain("grep -qE '^X-Agent: .+'");
    expect(hook).toContain("does not admit 'X-Agent'");
  });

  it("refuses every automated commit when the EXISTING policy does not admit --agent-trailer's key (zheref/nen#167)", () => {
    const root = tempRoot();
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(
      join(root, "nen", "workflow.json"),
      JSON.stringify({ commits: { allowedAttributionTrailers: ["Hatsu-Agent"] } }),
    );
    const result = scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    const hook = readFileSync(result.hookWritten, "utf8");
    expect(hook).toContain("does not admit 'X-Agent'");
    expect(hook).toContain("commits.allowedAttributionTrailers");
    expect(hook).not.toContain("grep -qE '^X-Agent: .+'");
  });

  it("regenerating from an UNCHANGED policy is byte-stable (zheref/nen#167)", () => {
    const root = tempRoot();
    const first = scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    const bytes = readFileSync(first.hookWritten, "utf8");
    const second = scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    expect(readFileSync(second.hookWritten, "utf8")).toBe(bytes);
    expect(second.hookOutcome).toBe("unchanged");
  });

  it("refuses the whole run, before the first write, on a MALFORMED policy", () => {
    // Both hooks are made out of that file; scaffolding around one nen cannot
    // read would install guards enforcing a policy nobody wrote.
    const root = tempRoot();
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "workflow.json"), '{"coverage":{"minimum":95,"ideal":10}}');
    expect((): unknown =>
      scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK }),
    ).toThrow(/could not be read/);
    // Nothing was written: not the hook, not the declaration.
    expect(existsSync(join(root, ".git", "hooks", "commit-msg"))).toBe(false);
    expect(existsSync(join(root, "nen", "contract.json"))).toBe(false);
  });
});

describe("scaffoldInit -- the pre-commit trunk guard", () => {
  it("installs it beside the commit-msg hook, in that hook's own directory", () => {
    const root = tempRoot();
    const result = scaffoldInit({
      root,
      platform: "linux",
      directories: [],
      hook: HOOK,
      stack: STACK,
      hookPath: "custom/hooks/commit-msg",
    });
    expect(result.preCommitWritten).toBe(join(root, "custom", "hooks", "pre-commit"));
    expect(result.preCommitOutcome).toBe("installed");
    expect(readFileSync(result.preCommitWritten, "utf8")).toContain('base="main"');
  });

  it("is idempotent, and reports 'unchanged' rather than 'installed' on a second run", () => {
    const root = tempRoot();
    scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    const second = scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    expect(second.preCommitOutcome).toBe("unchanged");
  });

  it("REFUSES to clobber a different pre-commit hook, and --force backs it up first", () => {
    const root = tempRoot();
    const path = join(root, ".git", "hooks", "pre-commit");
    mkdirSync(dirname(path), { recursive: true });
    const theirs = "#!/bin/sh\n# THE PROJECT OWNS THIS HOOK\nexit 0\n";
    writeFileSync(path, theirs);

    const refused = scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    expect(refused.preCommitOutcome).toBe("refused");
    expect(refused.preCommitError).toMatch(/--force/);
    expect(refused.exitCode).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(theirs);

    const forced = scaffoldInit({
      root,
      platform: "linux",
      directories: [],
      hook: HOOK,
      stack: STACK,
      force: true,
    });
    expect(forced.preCommitOutcome).toBe("installed");
    expect(readFileSync(`${path}.bak`, "utf8")).toBe(theirs);
  });

  it("writes neither hook on a dry run, and says 'would-install' for both", () => {
    const root = tempRoot();
    const result = scaffoldInit({
      root,
      platform: "linux",
      directories: [],
      hook: HOOK,
      stack: STACK,
      dryRun: true,
    });
    expect(result.hookOutcome).toBe("would-install");
    expect(result.preCommitOutcome).toBe("would-install");
    expect(existsSync(result.preCommitWritten)).toBe(false);
    expect(existsSync(join(root, "nen", "workflow.json"))).toBe(false);
    expect(
      result.writes.find((write): boolean => write.path === "nen/workflow.json")?.action,
    ).toBe("would-create");
  });
});

describe("scaffoldInit -- .gitignore carries the reports directory too", () => {
  it("appends the policy's reports.dir beside '.nen/'", () => {
    const root = tempRoot();
    scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    const ignored = readFileSync(join(root, ".gitignore"), "utf8");
    expect(ignored).toContain(".nen/");
    expect(ignored).toContain("Reports/");
  });

  it("reads the DIRECTORY out of an existing policy rather than assuming one", () => {
    const root = tempRoot();
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ reports: { dir: "out/reports" } }));
    scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    const ignored = readFileSync(join(root, ".gitignore"), "utf8");
    expect(ignored).toContain("out/reports/");
    expect(ignored).not.toContain("\nReports/");
  });

  it("adds only the entry that is MISSING when the file already carries the other", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".gitignore"), "dist\n.nen/\n", "utf8");
    scaffoldInit({ root, platform: "linux", directories: [], hook: HOOK, stack: STACK });
    const ignored = readFileSync(join(root, ".gitignore"), "utf8");
    expect(ignored.startsWith("dist\n.nen/\n")).toBe(true);
    expect(ignored).toContain("Reports/");
    // ...and it did not append a second `.nen/`.
    expect(ignored.split("\n").filter((line): boolean => line === ".nen/")).toHaveLength(1);
  });
});
