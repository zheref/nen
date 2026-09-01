import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { VerbContext } from "../cli/verb.js";
import { runRepo } from "./verb.js";

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

describe("nen repo -- CLI wiring", () => {
  it("requires --target (a runtime refusal, matching issueVerb's own requireTarget)", () => {
    expect(runRepo(makeContext({ args: ["inventory"] }).context, new ScriptedRunner([]))).toBe(1);
  });

  it("inventory requires --epic-label once --target is given", () => {
    expect(
      runRepo(makeContext({ args: ["inventory"], values: { target: "o/n" } }).context, new ScriptedRunner([])),
    ).toBe(2);
  });

  it("inventory requires --integration-prefix once --epic-label is given too -- no default naming convention", () => {
    const { context, err } = makeContext({
      args: ["inventory"],
      values: { target: "o/n", "epic-label": "type:epic" },
    });
    expect(runRepo(context, new ScriptedRunner([]))).toBe(2);
    expect(err.join("\n")).toMatch(/--integration-prefix <prefix> is required/);
  });

  it("scenario reads the target repo's registry entry and exits 0", () => {
    const { context, out } = makeContext({ args: ["scenario"], values: { target: "zheref/KroApple" } });
    expect(runRepo(context, new ScriptedRunner([]))).toBe(0);
    expect(out).toEqual(["swiftui-tca-uzf-v2"]);
  });

  it("scenario exits 1 with a reason when the repo is unrecorded", () => {
    const { context, err } = makeContext({ args: ["scenario"], values: { target: "zheref/nonexistent" } });
    expect(runRepo(context, new ScriptedRunner([]))).toBe(1);
    expect(err.join("\n")).toMatch(/is not a consumer/);
  });

  it("refuses an unknown subcommand", () => {
    expect(runRepo(makeContext({ args: ["bogus"] }).context, new ScriptedRunner([]))).toBe(2);
  });
});
