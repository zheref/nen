import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { VerbContext } from "../cli/verb.js";
import { scaffoldVerb } from "./verb.js";

function makeContext(overrides: Partial<VerbContext> = {}): { context: VerbContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const context: VerbContext = {
    args: [],
    values: {},
    booleans: new Set(),
    passthrough: [],
    repoFlag: null,
    json: false,
    io: { out: (l): void => void out.push(l), err: (l): void => void err.push(l) },
    ...overrides,
  };
  return { context, out, err };
}

describe("nen scaffold init -- CLI wiring", () => {
  it("creates directories and installs the hook", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-scaffold-verb-"));
    const { context, out } = makeContext({
      args: ["init"],
      repoFlag: root,
      values: { directories: "src,tests", "agent-trailer": "X-Agent", "run-trailer": "X-Run", "marker-env": "X_CI" },
    });
    expect(scaffoldVerb.run(context)).toBe(0);
    expect(existsSync(join(root, "src"))).toBe(true);
    expect(existsSync(join(root, ".git", "hooks", "commit-msg"))).toBe(true);
    expect(out.join("\n")).toMatch(/hook: installed/);
  });

  it("requires --agent-trailer, --run-trailer and --marker-env", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-scaffold-verb-"));
    expect(scaffoldVerb.run(makeContext({ args: ["init"], repoFlag: root }).context)).toBe(2);
  });

  it("refuses an unknown subcommand", () => {
    expect(scaffoldVerb.run(makeContext({ args: ["bogus"] }).context)).toBe(2);
  });

  // Review finding #5: the verb must surface and exit non-zero on a refused hook install.
  it("exits 1 and never clobbers a pre-existing, different commit-msg hook", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-scaffold-verb-"));
    const hookPath = join(root, ".git", "hooks", "commit-msg");
    mkdirSync(dirname(hookPath), { recursive: true });
    const projectsOwnHook = "#!/bin/sh\n# owned by the project\nexit 0\n";
    writeFileSync(hookPath, projectsOwnHook);

    const { context, err } = makeContext({
      args: ["init"],
      repoFlag: root,
      values: { "agent-trailer": "X-Agent", "run-trailer": "X-Run", "marker-env": "X_CI" },
    });
    expect(scaffoldVerb.run(context)).toBe(1);
    expect(readFileSync(hookPath, "utf8")).toBe(projectsOwnHook);
    expect(err.join("\n")).toMatch(/already exists/);
  });

  // Review finding #11: a trailer key or marker env var outside its legal
  // charset is interpolated raw into the generated shell hook.
  it("refuses an --agent-trailer that would inject into the generated shell hook", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-scaffold-verb-"));
    const { context } = makeContext({
      args: ["init"],
      repoFlag: root,
      values: { "agent-trailer": "A'; echo PWNED >&2; #", "run-trailer": "X-Run", "marker-env": "X_CI" },
    });
    expect(scaffoldVerb.run(context)).toBe(2);
    expect(existsSync(join(root, ".git", "hooks", "commit-msg"))).toBe(false);
  });

  it("refuses a --marker-env that is not a legal shell identifier", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-scaffold-verb-"));
    const { context } = makeContext({
      args: ["init"],
      repoFlag: root,
      values: { "agent-trailer": "X-Agent", "run-trailer": "X-Run", "marker-env": "1; rm -rf /" },
    });
    expect(scaffoldVerb.run(context)).toBe(2);
  });
});
