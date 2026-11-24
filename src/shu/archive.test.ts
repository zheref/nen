import { describe, expect, it } from "vitest";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runFamily } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import type { CommandResult } from "../seam/exec.js";
import { makeTempDir } from "../testing/tempdir.js";
import { shuCommand } from "./command.js";

const START = Date.parse("2026-01-01T00:00:00Z");

async function archive(options: { before?: (root: string) => void; during?: (root: string) => void; artifacts?: string[]; extra?: string[]; json?: boolean; exit?: number } = {}): Promise<{ code: number; out: string[]; err: string[]; root: string; report: () => { artifacts: Record<string, unknown>[] } }> {
  const root = makeTempDir("nen-archive-");
  mkdirSync(join(root, "nen"));
  writeFileSync(join(root, "nen", "contract.json"), JSON.stringify({ $schema: "nen.contract/v0.1", project: {
    lanes: { unit: { stack: "placeholder-stack", cwd: "." } }, defaultLane: "unit",
    verbs: { unit: { archive: { exe: "placeholder-tool", argv: ["package"], artifacts: options.artifacts ?? ["artifact.bin"] } } },
  } }));
  options.before?.(root);
  let time = START;
  const seams = new ScriptedSeams([{ match: "placeholder-tool package", result: { code: options.exit ?? 0 } }], { now: (): Date => new Date(time) });
  const scripted = seams.run;
  seams.run = (exe, args, opts): CommandResult => {
    const result = scripted(exe, args, opts);
    options.during?.(root);
    time += 2000;
    return result;
  };
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFamily(shuCommand, ["shu", "archive", "--heartbeat", "0", ...(options.json === false ? [] : ["--json"]), ...(options.extra ?? [])], root, false,
    { out: (s): void => { out.push(s); }, err: (s): void => { err.push(s); } }, seams);
  return { code, out, err, root, report: (): { artifacts: Record<string, unknown>[] } => JSON.parse(out.join("\n")) as { artifacts: Record<string, unknown>[] } };
}

describe("archive artifact facts", () => {
  it("AC-1 reports bytes, modification time and sha256 for this run's file", async () => {
    const result = await archive({ during: (root): void => {
      writeFileSync(join(root, "artifact.bin"), "abc");
      utimesSync(join(root, "artifact.bin"), START / 1000 + 1, START / 1000 + 1);
    } });
    expect(result.code).toBe(0);
    expect(result.report().artifacts[0]).toMatchObject({ exists: true, archive: {
      status: "file", bytes: 3, modifiedAt: "2026-01-01T00:00:01.000Z", producedThisRun: true,
      digest: { algorithm: "sha256", value: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    } });
  });

  it("AC-2 never marks an artifact older than the run start as produced this run", async () => {
    const result = await archive({ before: (root): void => {
      writeFileSync(join(root, "artifact.bin"), "leftover");
      utimesSync(join(root, "artifact.bin"), START / 1000 - 1, START / 1000 - 1);
    } });
    expect(result.report().artifacts[0]).toMatchObject({ exists: true, archive: { status: "file", producedThisRun: false, freshness: "older-than-run" } });
  });

  it("AC-3 distinguishes a directory from a missing artifact without hashing it", async () => {
    const result = await archive({ artifacts: ["bundle", "missing"], before: (root): void => { mkdirSync(join(root, "bundle")); } });
    expect(result.report().artifacts).toMatchObject([
      { exists: true, archive: { status: "directory", bytes: null, digest: null, producedThisRun: null } },
      { exists: false, archive: { status: "missing", bytes: null, digest: null, producedThisRun: null } },
    ]);
  });

  it("never claims that a dry run produced an existing file", async () => {
    const result = await archive({ extra: ["--dry-run"], before: (root): void => { writeFileSync(join(root, "artifact.bin"), "old"); } });
    expect(result.code).toBe(0);
    expect(result.report().artifacts[0]).toMatchObject({ exists: true, archive: {
      status: "not-inspected", freshness: "not-run", producedThisRun: null, digest: null, runStartedAt: null,
    } });
  });

  it("never marks a future-dated artifact as produced this run", async () => {
    const result = await archive({ before: (root): void => {
      writeFileSync(join(root, "artifact.bin"), "future");
      utimesSync(join(root, "artifact.bin"), START / 1000 + 60, START / 1000 + 60);
    } });
    expect(result.report().artifacts[0]).toMatchObject({ archive: { producedThisRun: false, freshness: "after-run" } });
  });

  it("prints per-artifact facts and keeps the tool's failure exit", async () => {
    const result = await archive({ json: false, exit: 9, during: (root): void => {
      writeFileSync(join(root, "artifact.bin"), "abc");
      utimesSync(join(root, "artifact.bin"), START / 1000 + 1, START / 1000 + 1);
    } });
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toContain("artifact.bin: file; bytes=3");
    expect(result.out.join("\n")).toContain("produced this run=true (during-run)");
    expect(result.out.join("\n")).toContain("sha256=ba7816bf");
  });
});
