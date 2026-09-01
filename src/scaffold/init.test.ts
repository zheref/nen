import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderCanonValuesTemplate, scaffoldInit } from "./init.js";

const HOOK = { agentTrailer: "X-Agent", runTrailer: "X-Run", markerEnvVar: "X_AUTOMATED" };

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "nen-scaffold-"));
}

describe("scaffoldInit", () => {
  it("creates every requested directory that does not exist", () => {
    const root = tempRoot();
    const result = scaffoldInit({ root, directories: ["src", "tests"], hook: HOOK });
    expect(existsSync(join(root, "src"))).toBe(true);
    expect(existsSync(join(root, "tests"))).toBe(true);
    expect(result.createdDirectories.length).toBeGreaterThanOrEqual(2);
  });

  it("is idempotent -- a second run creates nothing new for existing directories", () => {
    const root = tempRoot();
    scaffoldInit({ root, directories: ["src"], hook: HOOK });
    const second = scaffoldInit({ root, directories: ["src"], hook: HOOK });
    expect(second.createdDirectories).toEqual([]);
  });

  it("writes the commit-msg hook at the default path", () => {
    const root = tempRoot();
    const result = scaffoldInit({ root, directories: [], hook: HOOK });
    expect(result.hookWritten).toBe(join(root, ".git", "hooks", "commit-msg"));
    expect(result.hookOutcome).toBe("installed");
    expect(readFileSync(result.hookWritten, "utf8")).toContain("X-Agent");
  });

  it("is idempotent for the hook -- a second run with the same spec reports 'unchanged', not 'installed'", () => {
    const root = tempRoot();
    scaffoldInit({ root, directories: [], hook: HOOK });
    const second = scaffoldInit({ root, directories: [], hook: HOOK });
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

    const result = scaffoldInit({ root, directories: [], hook: HOOK });

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

    const result = scaffoldInit({ root, directories: [], hook: HOOK, force: true });

    expect(result.hookOutcome).toBe("installed");
    expect(readFileSync(hookPath, "utf8")).toContain("X-Agent");
    expect(readFileSync(`${hookPath}.bak`, "utf8")).toBe(projectsOwnHook);
  });

  it("takes a caller-supplied hook path", () => {
    const root = tempRoot();
    const result = scaffoldInit({ root, directories: [], hook: HOOK, hookPath: "custom/hooks/commit-msg" });
    expect(result.hookWritten).toBe(join(root, "custom", "hooks", "commit-msg"));
  });

  it("writes a canon-values template only when a path is given, and never overwrites an existing one", () => {
    const root = tempRoot();
    const withoutPath = scaffoldInit({ root, directories: [], hook: HOOK });
    expect(withoutPath.canonValuesWritten).toBeNull();

    const result = scaffoldInit({ root, directories: [], hook: HOOK, canonValuesPath: "canon-values.yml", scenario: "scenario-x" });
    expect(result.canonValuesWritten).not.toBeNull();
    const content = readFileSync(result.canonValuesWritten as string, "utf8");
    expect(content).toContain("scenario: scenario-x");

    // Hand-edit it, then re-init: the file must not be clobbered.
    const path = result.canonValuesWritten as string;
    writeFileSync(path, "hand edited");
    scaffoldInit({ root, directories: [], hook: HOOK, canonValuesPath: "canon-values.yml", scenario: "scenario-x" });
    expect(readFileSync(path, "utf8")).toBe("hand edited");
  });

  it("chmods the hook file (best-effort) so it is executable where the platform supports it", () => {
    const root = tempRoot();
    const result = scaffoldInit({ root, directories: [], hook: HOOK });
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
