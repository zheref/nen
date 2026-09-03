import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { repoCommand } from "./command.js";

async function capture(
  argv: readonly string[],
  run: Seams["run"] = (): CommandResult => {
    throw new Error("this test's invocation should make no subprocess call");
  },
  // `null` is a real case here, not a default-filler: it is the invocation
  // that never typed --repo at all (zheref/nen#28's subject).
  repoFlag: string | null = BANKAI_REPO,
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
  const code = await runFamily(repoCommand, argv, repoFlag, false, io, seams);
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

  // zheref/nen#28: the usage line lists --repo unbracketed, and honoring that
  // at the parser is the fix -- omission used to default silently to the cwd
  // and surface as that directory's missing-or-unrelated registry.
  it("scenario refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["repo", "scenario", "--target", "zheref/KroApple"], undefined, null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  // The three downstream causes the one old refusal conflated (zheref/nen#28),
  // one test each. Cause 1: the --repo path carries no schemas/repos.json.
  it("scenario names a --repo path with no schemas/repos.json as exactly that (exit 1)", async () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-no-registry-"));
    const result = await capture(["repo", "scenario", "--target", "zheref/KroApple"], undefined, empty);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/schemas[/\\]repos\.json: no such file/);
  });

  // Cause 2: the registry knows nothing about the target, anywhere.
  it("scenario exits 1 with a 'not recorded anywhere' reason when the repo is unrecorded", async () => {
    const result = await capture(["repo", "scenario", "--target", "zheref/nonexistent"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/is not recorded anywhere/);
  });

  // Cause 3: the registry plainly records the repo (here under
  // pending_onboarding -- #27's widened resolution), just not with a scenario.
  it("scenario tells a recorded non-consumer apart from an unknown repo (exit 1)", async () => {
    const result = await capture(["repo", "scenario", "--target", "zheref/KroCloud"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/is recorded in .*under 'pending_onboarding'/);
    expect(result.err.join("\n")).toMatch(/only a consumers\[\] entry carries a 'scenario'/);
  });

  // zheref/nen#28's second finding: this is a NAME-HALF match against a bare
  // product-code value (no owner recorded anywhere), not a registry hit on
  // the full 'zheref/bankai-core' slug -- so the refusal must not claim the
  // slug itself "is recorded".
  it("scenario names the product code recording the registry's OWN repo, not 'unknown' -- and does not overclaim the slug is recorded", async () => {
    const result = await capture(["repo", "scenario", "--target", "zheref/bankai-core"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/bare product code 'BC' \('bankai-core'\), which names no owner/);
    expect(result.err.join("\n")).toMatch(/is not itself recorded in/);
    expect(result.err.join("\n")).not.toMatch(/'zheref\/bankai-core' is recorded in/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["repo", "bogus"])).code).toBe(2);
  });
});
