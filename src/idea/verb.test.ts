import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedRunner } from "../exec/seam.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { VerbContext } from "../cli/verb.js";
import { runIdea } from "./verb.js";

function makeContext(overrides: Partial<VerbContext> = {}): { context: VerbContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const context: VerbContext = {
    args: [],
    values: {},
    booleans: new Set(),
    passthrough: [],
    repoFlag: BANKAI_REPO,
    json: false,
    io: { out: (l): void => void out.push(l), err: (l): void => void err.push(l) },
    ...overrides,
  };
  return { context, out, err };
}

describe("nen idea file -- CLI wiring", () => {
  it("requires --target", () => {
    const { context, err } = makeContext({ args: ["file"] });
    expect(runIdea(context, new ScriptedRunner([]))).toBe(2);
    expect(err.join("\n")).toMatch(/--target/);
  });

  it("requires --body-file", () => {
    const { context } = makeContext({ args: ["file"], values: { target: "o/n" } });
    expect(runIdea(context, new ScriptedRunner([]))).toBe(2);
  });

  it("exits 0 and reports OK on a clean read-back round trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-idea-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "the body");
    const { context, out } = makeContext({
      args: ["file"],
      values: { target: "zheref/nen", title: "t", "body-file": bodyFile, label: "bankai:severity/high", assignee: "me" },
    });
    const runner = new ScriptedRunner([
      {
        match: `gh issue create --repo zheref/nen --title t --body-file ${bodyFile} --assignee me --label bankai:severity/high`,
        result: { stdout: "https://github.com/zheref/nen/issues/5\n" },
      },
      {
        match: "gh issue view 5 --repo zheref/nen --json title,body,labels",
        result: { stdout: JSON.stringify({ title: "t", body: "the body", labels: [{ name: "bankai:severity/high" }] }) },
      },
    ]);
    expect(runIdea(context, runner)).toBe(0);
    expect(out.join("\n")).toMatch(/read-back OK/);
  });

  it("refuses an unknown subcommand", () => {
    expect(runIdea(makeContext({ args: ["bogus"] }).context, new ScriptedRunner([]))).toBe(2);
  });
});
