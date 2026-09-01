import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { runIssue } from "./verb.js";
import type { VerbContext } from "../cli/verb.js";

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

describe("nen issue -- CLI wiring", () => {
  it("requires --target", () => {
    const { context, err } = makeContext({ args: ["search"], values: { subject: "x" } });
    const code = runIssue(context, new ScriptedRunner([]));
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/--target/);
  });

  it("refuses an unknown subcommand as a usage error", () => {
    const { context } = makeContext({ args: ["bogus"] });
    expect(runIssue(context, new ScriptedRunner([]))).toBe(2);
  });

  it("open-pr-check requires --issues", () => {
    const { context } = makeContext({ args: ["open-pr-check"], values: { target: "o/n" } });
    expect(runIssue(context, new ScriptedRunner([]))).toBe(2);
  });

  it("search emits the stable --json contract and a non-zero exit on a failed pass", () => {
    const { context, out } = makeContext({
      args: ["search"],
      values: { target: "o/n", subject: "x" },
      json: true,
    });
    const now = new Date("2026-08-31T00:00:00Z");
    const runner = new ScriptedRunner([
      {
        match: "gh issue list --repo o/n --state open --search x --limit 100 --json number,title,state,url,labels,updatedAt,closedAt",
        result: { code: 1, stderr: "down" },
      },
      {
        match: "gh issue list --repo o/n --state closed --search x closed:>=2026-06-02 --limit 100 --json number,title,state,url,labels,updatedAt,closedAt",
        result: { stdout: "[]" },
      },
    ]);
    const code = runIssue(context, runner, now);
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join("\n")) as { ok: boolean; passes: unknown[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.passes.length).toBe(4);
  });

  it("file requires --body-file", () => {
    const { context } = makeContext({
      args: ["file"],
      values: { target: "o/n", title: "t", label: "bug", assignee: "me" },
      repoFlag: BANKAI_REPO,
    });
    expect(runIssue(context, new ScriptedRunner([]))).toBe(2);
  });
});
