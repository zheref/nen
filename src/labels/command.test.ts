import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { createArgv, listLabelsArgv } from "./sync.js";
import { showLabelsArgv } from "./source.js";
import { labelsCommand } from "./command.js";
import { listLabelNamesArgv, renameArgv } from "./rename.js";

async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  // `null` is a real case: the invocation that never typed --repo (zheref/nen#28).
  repoFlag: string | null = BANKAI_REPO,
): Promise<{ code: number; out: string[]; err: string[]; seams: ScriptedSeams }> {
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
  const scripted = new ScriptedSeams(script);
  const seams: Seams = scripted;
  const code = await runFamily(labelsCommand, argv, repoFlag, false, io, seams);
  return { code, out, err, seams: scripted };
}

describe("nen labels sync -- CLI wiring", () => {
  it("dry-run reads the remote labels and reports progress without mutations", async () => {
    const result = await capture(["labels", "sync", "--target", "zheref/nen", "--dry-run"], [{ match: `gh ${listLabelsArgv({ owner: "zheref", repo: "nen", slug: "zheref/nen" }).join(" ")}`, result: { stdout: "[[]]" } }]);
    expect(result.code).toBe(0);
    expect(result.out.length).toBeGreaterThan(0);
    expect(result.seams.calls).toHaveLength(1);
    expect(result.err[0]).toMatch(/\[0\//);
    expect(result.err.at(-1)).toMatch(/would-sync/);
  });

  it("keeps JSON stdout pure while emitting incremental counts to stderr", async () => {
    const result = await capture(["labels", "sync", "--target", "zheref/nen", "--dry-run", "--json"], [{ match: `gh ${listLabelsArgv({ owner: "zheref", repo: "nen", slug: "zheref/nen" }).join(" ")}`, result: { stdout: "[[]]" } }]);
    expect(result.code).toBe(0);
    expect(result.out).toHaveLength(1);
    const report = JSON.parse(result.out[0]!);
    expect(report.entries.length).toBeGreaterThan(0);
    expect(result.err).toHaveLength(report.entries.length + 1);
    expect(result.err.at(-1)).toContain(`[${report.entries.length}/${report.entries.length}]`);
    expect(result.seams.calls).toHaveLength(1);
  });

  // zheref/nen#93: EXIT 2, not 1. Four families each kept a private
  // `requireTarget` that threw a plain Error, so sixteen verbs answered a
  // forgotten flag with "the thing you asked for did not work" instead of "you
  // typed it wrong" -- and a retry wrapper honouring that distinction retries a
  // 1 forever. One shared `requireTargetFlag` now answers for all of them, the
  // way every OTHER required flag in these same families already did.
  it("requires --target, as a USAGE error", async () => {
    const result = await capture(["labels", "sync"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--target owner\/name is required/);
  });

  // zheref/nen#28: sync's usage line lists --repo unbracketed, so omitting it
  // is refused by name -- a sync that read the cwd's taxonomy would push THAT
  // repository's labels at --target.
  it("sync refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["labels", "sync", "--target", "zheref/nen"], [], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });
});

// zheref/nen#591: a labels PR could not prove its labels before it merged.
describe("nen labels sync --ref / --working-tree -- preview by default, --apply to sync", () => {
  const TARGET = { owner: "zheref", repo: "nen", slug: "zheref/nen" };
  const LABEL = { name: "from-branch", color: "abcdef", description: "declared on the branch only" };
  const readRemote: ScriptedCall = { match: `gh ${listLabelsArgv(TARGET).join(" ")}`, result: { stdout: "[[]]" } };
  const showRef = (ref: string, stdout: string, code = 0): ScriptedCall => ({
    match: `git ${showLabelsArgv(BANKAI_REPO, ref).join(" ")}`,
    result: { stdout, code, stderr: code === 0 ? "" : `fatal: invalid object name '${ref}'.` },
  });
  const branchFile = JSON.stringify({ labels: [LABEL] });

  it("--ref reads nen/labels.json at the ref and diffs it without mutating", async () => {
    const result = await capture(["labels", "sync", "--target", "zheref/nen", "--ref", "feature/labels"], [showRef("feature/labels", branchFile), readRemote]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["would create: from-branch (#abcdef) -- declared on the branch only"]);
    expect(result.err[0]).toBe("source: feature/labels:nen/labels.json (dry run; --apply syncs)");
    expect(result.seams.calls).toHaveLength(2);
  });

  it("--ref --apply syncs the ref's labels", async () => {
    const result = await capture(["labels", "sync", "--target", "zheref/nen", "--ref", "feature/labels", "--apply"], [
      showRef("feature/labels", branchFile), readRemote, { match: `gh ${createArgv(TARGET, LABEL).join(" ")}`, result: {} },
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["created: from-branch"]);
    expect(result.err[0]).toBe("source: feature/labels:nen/labels.json");
    expect(result.seams.calls).toHaveLength(3);
  });

  it("--working-tree reads the checkout's file and previews by default", async () => {
    const result = await capture(["labels", "sync", "--target", "zheref/nen", "--working-tree", "--json"], [readRemote]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out[0]!);
    expect(report.entries.length).toBeGreaterThan(0);
    expect(report.entries.every((entry: { status: string }): boolean => entry.status === "would-sync")).toBe(true);
    expect(result.err[0]).toMatch(/^source: .*nen\/labels\.json \(dry run; --apply syncs\)$/);
    expect(result.seams.calls).toHaveLength(1);
  });

  it("an unreadable ref refuses at exit 1 before reading GitHub", async () => {
    const result = await capture(["labels", "sync", "--target", "zheref/nen", "--ref", "nope"], [showRef("nope", "", 128)]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not read nope:nen\/labels\.json .*invalid object name 'nope'.*nothing was synced/);
    expect(result.seams.calls).toHaveLength(1);
  });

  it("a ref whose file is not a valid taxonomy refuses at exit 1", async () => {
    const notJson = await capture(["labels", "sync", "--target", "zheref/nen", "--ref", "main"], [showRef("main", "{")]);
    expect(notJson.code).toBe(1);
    expect(notJson.err.join("\n")).toMatch(/main:nen\/labels\.json is not valid JSON/);
    const bad = await capture(["labels", "sync", "--target", "zheref/nen", "--ref", "main"], [showRef("main", JSON.stringify({ labels: [{ name: "x" }] }))]);
    expect(bad.code).toBe(1);
    expect(bad.err.join("\n")).toMatch(/main:nen\/labels\.json/);
    expect(bad.seams.calls).toHaveLength(1);
  });

  it.each([
    [["--ref", "main", "--working-tree"], /give one/],
    [["--ref", "main", "--apply", "--dry-run"], /contradict/],
    [["--apply"], /only applies with --ref <ref> or --working-tree/],
    [["--ref=--upload-pack=x"], /not a ref nen will pass to git/],
    [["--ref", "main:other"], /not a ref nen will pass to git/],
    [["--ref", "a b"], /not a ref nen will pass to git/],
  ])("refuses %j as a usage error (exit 2) before any read", async (flags, message) => {
    const result = await capture(["labels", "sync", "--target", "zheref/nen", ...flags]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(message);
    expect(result.seams.calls).toHaveLength(0);
  });
});

describe("nen labels rename -- CLI wiring", () => {
  const TARGET = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

  it("renames per --map and exits 0 on success", async () => {
    const result = await capture(["labels", "rename", "--target", "zheref/nen", "--map", "old=new"], [
      { match: `gh ${listLabelNamesArgv(TARGET).join(" ")}`, result: { stdout: JSON.stringify([{ name: "old" }]) } },
      { match: `gh ${renameArgv(TARGET, { from: "old", to: "new" }).join(" ")}`, result: {} },
    ]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/renamed/);
  });

  it("requires --map", async () => {
    const result = await capture(["labels", "rename", "--target", "zheref/nen"]);
    expect(result.code).toBe(2);
  });

  it("exits 1 when a mapping fails", async () => {
    const result = await capture(["labels", "rename", "--target", "zheref/nen", "--map", "old=new"], [
      { match: `gh ${listLabelNamesArgv(TARGET).join(" ")}`, result: { stdout: "[]" } },
    ]);
    expect(result.code).toBe(1);
  });
});

describe("nen labels -- refuses an unknown subcommand", () => {
  it("exits 2", async () => {
    expect((await capture(["labels", "bogus"])).code).toBe(2);
  });
});
