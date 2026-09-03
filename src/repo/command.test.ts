import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { repoCommand } from "./command.js";

async function capture(
  argv: readonly string[],
  run: Seams["run"] = (): CommandResult => {
    throw new Error("this test's invocation should make no subprocess call");
  },
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const seams: Seams = { run, now: (): Date => new Date("2026-01-01T00:00:00Z"), env: {} };
  const code = await runFamily(repoCommand, argv, BANKAI_REPO, false, io, seams);
  return { code, out, err };
}

describe("nen repo resolve -- dispatches through the union registry", () => {
  it("resolves a known token without a subprocess call (main's own family)", async () => {
    const result = await capture(["repo", "resolve", "KP"]);
    expect(result.code).toBe(0);
  });

  it("resolves a code to the pending_onboarding slug the registry records (zheref/nen#27)", async () => {
    // The bankai fixture's KC names 'KroCloud', a bare value whose owner is
    // recorded only under pending_onboarding -- the exact case the issue's
    // live reproduction hit.
    const result = await capture(["repo", "resolve", "KC"]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["zheref/KroCloud  (KC)  via code"]);
  });

  it("no-token form resolves the registry's OWN origin via product_codes (zheref/nen#27)", async () => {
    const result = await capture(["repo", "resolve"], (): CommandResult => ({
      code: 0,
      stdout: "https://github.com/zheref/bankai-core.git\n",
      stderr: "",
      spawnFailed: false,
    }));
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "origin: https://github.com/zheref/bankai-core.git",
      "zheref/bankai-core  (BC)  via origin",
    ]);
  });

  it("refuses --from next to a token, naming --repo, instead of silently ignoring it (zheref/nen#27)", async () => {
    const result = await capture(["repo", "resolve", "KP", "--from", "/somewhere"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--from applies only to the no-token form/);
    expect(result.err.join("\n")).toMatch(/--repo <path>/);
  });
});

describe("nen repo inventory|scenario -- CLI wiring (verbs/4-remainders, merged into this family)", () => {
  it("requires --target (a runtime refusal, matching issueCommand's own requireTarget)", async () => {
    expect((await capture(["repo", "inventory"])).code).toBe(1);
  });

  it("inventory requires --epic-label once --target is given", async () => {
    expect((await capture(["repo", "inventory", "--target", "o/n"])).code).toBe(2);
  });

  it("inventory requires --integration-prefix once --epic-label is given too -- no default naming convention", async () => {
    const result = await capture(["repo", "inventory", "--target", "o/n", "--epic-label", "type:epic"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--integration-prefix <prefix> is required/);
  });

  it("scenario reads the target repo's registry entry and exits 0", async () => {
    const result = await capture(["repo", "scenario", "--target", "zheref/KroApple"]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["swiftui-tca-uzf-v2"]);
  });

  it("scenario exits 1 with a reason when the repo is unrecorded", async () => {
    const result = await capture(["repo", "scenario", "--target", "zheref/nonexistent"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/is not a consumer/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["repo", "bogus"])).code).toBe(2);
  });
});
