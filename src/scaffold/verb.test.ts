import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(out.join("\n")).toMatch(/hook written/);
  });

  it("requires --agent-trailer, --run-trailer and --marker-env", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-scaffold-verb-"));
    expect(scaffoldVerb.run(makeContext({ args: ["init"], repoFlag: root }).context)).toBe(2);
  });

  it("refuses an unknown subcommand", () => {
    expect(scaffoldVerb.run(makeContext({ args: ["bogus"] }).context)).toBe(2);
  });
});
