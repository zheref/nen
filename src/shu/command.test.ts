// src/shu/command.test.ts -- the family's surface: which verbs exist, which
// flags each one reads, and what the help promises.

import { describe, expect, it } from "vitest";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { findCommand } from "../cli/registry.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { SHU_EVIDENCE_REPO, SHU_REPO } from "../schema/fixtures/paths.js";
import { EXECUTING_VERBS, SHU_SUBCOMMAND_FLAGS, SHU_SUBCOMMANDS, shuCommand } from "./command.js";

async function capture(argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push(line),
  };
  const seams = new ScriptedSeams([], { platform: "linux", env: { PLACEHOLDER_LANE_TOKEN: "x" } });
  const code = await runFamily(shuCommand, ["shu", ...argv], SHU_REPO, false, io, seams);
  return { code, out, err };
}

/** Like `capture`, but against a caller-named repo and a caller-scripted seam. */
async function captureAgainst(
  repo: string,
  script: readonly ScriptedCall[],
  argv: readonly string[],
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push(line),
  };
  const seams = new ScriptedSeams(script, { platform: "linux" });
  const code = await runFamily(shuCommand, ["shu", ...argv], repo, false, io, seams);
  return { code, out, err };
}

describe("the family's registration", () => {
  it("is in the registry under its own name", () => {
    expect(findCommand("shu")).toBe(shuCommand);
  });

  it("carries all fourteen verbs, in the order the design lists them", () => {
    expect(SHU_SUBCOMMANDS).toEqual([
      "detect",
      "build",
      "test",
      "ui-test",
      "lint",
      "archive",
      "release",
      "dev",
      "run",
      "deploy",
      "coverage",
      "evidence",
      "tools",
      "warmup",
    ]);
  });

  it("declares a flag spec for every verb, and no verb the spec does not name", () => {
    expect(Object.keys(SHU_SUBCOMMAND_FLAGS).sort()).toEqual([...SHU_SUBCOMMANDS].sort());
  });

  it("splits the fourteen into the ten that execute a lane's invocation, and four that do not", () => {
    // `detect` reads markers, `tools` probes the host, `warmup` mutates git
    // state and then DELEGATES to the ten, and `evidence` reads git and this
    // repository's own project.evidence block. None of the four goes through
    // ./run.ts's runVerb directly, which is what EXECUTING_VERBS names.
    expect([...EXECUTING_VERBS, "detect", "evidence", "tools", "warmup"].sort()).toEqual(
      [...SHU_SUBCOMMANDS].sort(),
    );
  });

  it("refuses an unknown verb at 2, listing the ones it has", async () => {
    const result = await capture(["compile"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/unknown 'shu' subcommand 'compile'/);
    expect(result.err.join("\n")).toMatch(/Known: detect, build, test/);
  });

  it("refuses a bare 'nen shu' at 2 rather than guessing a verb", async () => {
    const result = await capture([]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/needs a subcommand/);
  });
});

describe("each verb owns its flags", () => {
  it("refuses --write on an executing verb rather than ignoring it", async () => {
    const result = await capture(["build", "--write"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--write is not read by 'shu build'/);
    expect(result.err.join("\n")).toMatch(/accepted and ignored is worse/);
  });

  it("refuses --dry-run on detect, whose write gate is a different flag", async () => {
    const result = await capture(["detect", "--dry-run"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--dry-run is not read by 'shu detect'/);
  });

  it("refuses --target on a verb that is not deploy", async () => {
    const result = await capture(["build", "--target", "x"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--target is not read by 'shu build'/);
  });

  it("names every foreign flag at once, not one round trip at a time", async () => {
    const result = await capture(["build", "--write", "--install"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--install, --write are not read/);
  });

  it("never treats a GLOBAL flag as foreign", async () => {
    const result = await capture(["build", "--dry-run", "--json"]);
    expect(result.code).toBe(0);
  });

  it("still refuses a flag no verb in the family declares", async () => {
    const result = await capture(["build", "--nonsense"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/unknown option/);
  });
});

describe("the help text", () => {
  it("documents all thirteen verbs", async () => {
    const result = await capture(["--help"]);
    expect(result.code).toBe(0);
    const help = result.out.join("\n");
    for (const verb of SHU_SUBCOMMANDS) {
      expect(help, `'${verb}' is undocumented`).toMatch(new RegExp(`^ {2}${verb}\\s`, "m"));
    }
  });

  it("names the declaration file and the block a verb reads", async () => {
    const help = (await capture(["--help"])).out.join("\n");
    expect(help).toMatch(/nen\/contract\.json/);
    expect(help).toMatch(/project\.lanes/);
    expect(help).toMatch(/project\.verbs/);
    expect(help).toMatch(/project\.preconditions/);
    expect(help).toMatch(/project\.hosts/);
  });

  it("states all six exit codes, including the three this family adds", async () => {
    const help = (await capture(["--help"])).out.join("\n");
    for (const [code, phrase] of [
      ["0", /succeeded/],
      ["1", /the tool ran and failed/],
      ["2", /usage/],
      ["3", /unsupported host/],
      ["4", /unsupported verb for THIS LANE/],
      ["5", /could not be started/],
    ] as const) {
      expect(help, `exit ${code}`).toMatch(phrase);
    }
  });

  it("says preconditions are asserted and never performed", async () => {
    const help = (await capture(["--help"])).out.join("\n");
    expect(help).toMatch(/ASSERTS\s+these and NEVER\s+performs them/);
  });

  it("says what --dry-run guarantees", async () => {
    const help = (await capture(["--help"])).out.join("\n");
    expect(help).toMatch(/run\s+nothing at all/);
    expect(help).toMatch(/the thing you approve is\s+the\s+thing that runs/);
  });
});

describe("nen shu evidence", () => {
  const DIFF = "git diff --name-status main...HEAD";

  it("refuses --lane -- project.evidence is project-level, not per-lane", async () => {
    const result = await captureAgainst(SHU_EVIDENCE_REPO, [], ["evidence", "--base", "main", "--lane", "web"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--lane is not read by 'shu evidence'/);
  });

  it("refuses --dry-run -- this verb spawns nothing a dry run would skip", async () => {
    const result = await captureAgainst(SHU_EVIDENCE_REPO, [], ["evidence", "--base", "main", "--dry-run"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--dry-run is not read by 'shu evidence'/);
  });

  it("requires --base, with no default", async () => {
    const result = await captureAgainst(SHU_EVIDENCE_REPO, [], ["evidence"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--base is required/);
  });

  it("refuses at 2, naming the missing block, on a repository with no project.evidence", async () => {
    const result = await captureAgainst(
      SHU_REPO,
      [{ match: DIFF, result: { stdout: "" } }],
      ["evidence", "--base", "main"],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/has no "project\.evidence" block/);
  });

  it("reports an empty set at exit 0 for no changed evidence -- never an error", async () => {
    const result = await captureAgainst(
      SHU_EVIDENCE_REPO,
      [{ match: DIFF, result: { stdout: "M\tsrc/main.ts\n" } }],
      ["evidence", "--base", "main"],
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/no changed file under project\.evidence\.globs/);
  });

  it("matches a changed evidence file, deriving suite and scene, and exits 0", async () => {
    const path =
      "Kro/Tests/DateTimeFieldSnapshotTests/__Snapshots__/DateTimeFieldSnapshotTests/test_snapshot_disabled.1.png";
    const result = await captureAgainst(
      SHU_EVIDENCE_REPO,
      [{ match: DIFF, result: { stdout: `A\t${path}\n` } }],
      ["evidence", "--base", "main"],
    );
    expect(result.code).toBe(0);
    const text = result.out.join("\n");
    expect(text).toMatch(/1 changed file across 1 suite \(public-mirror\)/);
    expect(text).toMatch(/suite: DateTimeField/);
    expect(text).toMatch(/added\s+disabled\s+.*test_snapshot_disabled\.1\.png/);
  });

  it("emits the published contract as one document under --json", async () => {
    const path = "__Snapshots__/DateTimeFieldSnapshotTests/test_snapshot_disabled.png";
    const result = await captureAgainst(
      SHU_EVIDENCE_REPO,
      [{ match: DIFF, result: { stdout: `A\t${path}\n` } }],
      ["evidence", "--base", "main", "--json"],
    );
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out.join("\n"));
    expect(document).toEqual({
      contract: "nen.shu.evidence/v0.1",
      base: "main",
      mechanism: "public-mirror",
      rows: [{ suite: "DateTimeField", scene: "disabled", path, status: "added" }],
      suites: [{ suite: "DateTimeField", scenes: ["disabled"] }],
    });
  });

  it("runs the diff against the exact base the caller named", async () => {
    const result = await captureAgainst(
      SHU_EVIDENCE_REPO,
      [{ match: "git diff --name-status v1.0.0...HEAD", result: { stdout: "" } }],
      ["evidence", "--base", "v1.0.0"],
    );
    expect(result.code).toBe(0);
  });
});
