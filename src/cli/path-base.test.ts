// src/cli/path-base.test.ts -- one base for every path flag, driven from a
// directory that is NOT the repository (zheref/nen#100).
//
// WHY IT HAS TO CHDIR. The whole defect was invisible from the repository root,
// because there the two bases are the same path. Every case below stands the
// process somewhere else and puts a DECOY at the same relative name in that
// directory -- the file the old resolution would have read. A test that did not
// move would pass under either rule and prove nothing about which one is in
// force.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { effortCommand } from "../effort/command.js";
import { loopCommand } from "../loop/command.js";
import { qualityCommand } from "../quality/command.js";
import type { Command } from "./command.js";

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Run `argv` with the process standing in `cwd` and `--repo` at `repo`. */
async function fromElsewhere(command: Command, argv: readonly string[], cwd: string, repo: string): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => { out.push(line); },
    err: (line): void => { err.push(line); },
  };
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    const code = await runFamily(command, argv, repo, true, io, new ScriptedSeams([]));
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    process.chdir(previous);
  }
}

/** A cwd and a repo, each holding a DIFFERENT file at the same relative name. */
function twoTrees(name: string, decoy: string, wanted: string): { cwd: string; repo: string } {
  const cwd = mkdtempSync(join(tmpdir(), "nen-base-cwd-"));
  const repo = mkdtempSync(join(tmpdir(), "nen-base-repo-"));
  writeFileSync(join(cwd, name), decoy, "utf8");
  writeFileSync(join(repo, name), wanted, "utf8");
  return { cwd, repo };
}

describe("a relative path flag resolves against --repo, not the process's directory", () => {
  it("effort classify --input", async () => {
    const rows = (label: string): string =>
      JSON.stringify([
        { kind: "child", issueState: "open", stageLabels: [label], modeLabelPresent: false, hasPr: false, prOpen: false, prIsDelivery: false, integrationBranchAlive: false },
      ]);
    const { cwd, repo } = twoTrees("rows.json", rows("decoy:stage"), rows("wanted:stage"));
    const result = await fromElsewhere(effortCommand, ["effort", "classify", "--input", "rows.json"], cwd, repo);
    expect(result.code).toBe(0);
    expect(result.out).toContain("wanted:stage");
    expect(result.out).not.toContain("decoy:stage");
  });

  it("loop slots --efforts", async () => {
    const efforts = (id: string): string =>
      JSON.stringify([{ id, plane: "local", prOpen: false, ready: false, prompted: false }]);
    const { cwd, repo } = twoTrees("efforts.json", efforts("DECOY-1"), efforts("WANTED-1"));
    const result = await fromElsewhere(
      loopCommand,
      ["loop", "slots", "--efforts", "efforts.json", "--local-cap", "2"],
      cwd,
      repo,
    );
    expect(result.out).toContain("WANTED-1");
    expect(result.out).not.toContain("DECOY-1");
  });

  it("quality method-check --input", async () => {
    const block = (tool: string): string =>
      JSON.stringify({ metric: "P1", tool, device: "d", build: "b", scenario: "s", samples: 5, discarded: 0, statistic: "median" });
    const { cwd, repo } = twoTrees("method.json", block("decoy-tool"), block("wanted-tool"));
    const result = await fromElsewhere(
      qualityCommand,
      ["quality", "method-check", "--input", "method.json"],
      cwd,
      repo,
    );
    // Whichever verdict it reaches, it must have reached it about the file
    // under --repo. The decoy differs only in the field the report echoes.
    expect(`${result.out}${result.err}`).not.toContain("decoy-tool");
  });

  it("still takes an ABSOLUTE path as-is, from either directory", async () => {
    const rows = JSON.stringify([
      { kind: "child", issueState: "open", stageLabels: ["absolute:stage"], modeLabelPresent: false, hasPr: false, prOpen: false, prIsDelivery: false, integrationBranchAlive: false },
    ]);
    const cwd = mkdtempSync(join(tmpdir(), "nen-base-cwd-"));
    const repo = mkdtempSync(join(tmpdir(), "nen-base-repo-"));
    const absolute = join(cwd, "rows.json");
    writeFileSync(absolute, rows, "utf8");
    const result = await fromElsewhere(effortCommand, ["effort", "classify", "--input", absolute], cwd, repo);
    expect(result.code).toBe(0);
    expect(result.out).toContain("absolute:stage");
  });
});

describe("a malformed --repo stays the usage error it is", () => {
  it("is not swallowed by the read's own catch (Copilot, PR #197)", async () => {
    // `resolveRepoRoot` used to be called INSIDE the try guarding the file
    // read, so a `--repo` that is an owner/name slug rather than a path came
    // back as exit 1 under "could not read --input" -- about a file nobody had
    // a path to yet. Wrong code and wrong sentence at once.
    const cwd = mkdtempSync(join(tmpdir(), "nen-base-cwd-"));
    const result = await fromElsewhere(
      effortCommand,
      ["effort", "classify", "--input", "rows.json"],
      cwd,
      "owner/name",
    );
    expect(result.code).toBe(2);
    expect(`${result.out}${result.err}`).not.toContain("could not read --input");
  });
});
