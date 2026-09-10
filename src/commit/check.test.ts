// src/commit/check.test.ts -- the other end of the build proof: given a file
// `nen shu build` wrote (../shu/proof.test.ts writes it), does this working copy
// still answer to it?
//
// THE THREE DIFFERENCES ARE THE SUBJECT. "There is no proof", "it is another
// lane's" and "the tree has moved" are three different things to do next, and a
// verb that answered all of them with one number would be a verb whose output
// nobody could act on.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { PROOF_CONTRACT, proofRelativePath } from "../shu/proof.js";
import { commitCommand } from "./command.js";
import { CHECK_CONTRACT } from "./check.js";

const ADD = "git add -A -- .";
const DROP = "git rm -r -f --cached --quiet --ignore-unmatch -- .nen";
const WRITE_TREE = "git write-tree";
const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const OTHER = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

const hashes = (tree = TREE): readonly ScriptedCall[] => [
  { match: ADD, result: { code: 0 } },
  { match: DROP, result: { code: 0 } },
  { match: WRITE_TREE, result: { code: 0, stdout: `${tree}\n` } },
];

interface Ran {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly seams: ScriptedSeams;
}

interface Proof {
  readonly lane?: string;
  readonly treeHash?: unknown;
  readonly exitCode?: unknown;
  readonly contract?: unknown;
}

async function check(
  argv: readonly string[],
  options: { proof?: Proof | string | null; script?: readonly ScriptedCall[]; lane?: string } = {},
): Promise<Ran> {
  const root = mkdtempSync(join(tmpdir(), "nen-check-"));
  try {
    // THE DEFAULT IS A MATCHING PROOF, because that is the case every other
    // assertion is a deviation from; `proof: null` is how a test says there is
    // none.
    const proof = options.proof === undefined ? {} : options.proof;
    if (proof !== null) {
      mkdirSync(join(root, ".nen", "proof"), { recursive: true });
      writeFileSync(
        join(root, proofRelativePath(options.lane ?? "web")),
        typeof proof === "string"
          ? proof
          : JSON.stringify({
              contract: PROOF_CONTRACT,
              lane: "web",
              verb: "build",
              treeHash: TREE,
              at: "2026-03-04T05:06:07.000Z",
              exitCode: 0,
              ...proof,
            }),
      );
    }
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const seams = new ScriptedSeams(options.script ?? hashes(), { platform: "linux" });
    const code = await runFamily(commitCommand, ["commit", ...argv], root, argv.includes("--json"), io, seams);
    return { code, out, err, seams };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("nen commit check --require-proof", () => {
  it("exits 0 when the proof is this lane's and its tree is this tree", async () => {
    const run = await check(["check", "--require-proof", "web"]);
    expect(run.code).toBe(0);
    expect(run.out.join("\n")).toContain("OK -- this working copy is the one the build proved green");
    expect(run.err).toEqual([]);
  });

  it("publishes one document with a pinned key order", async () => {
    const run = await check(["check", "--require-proof", "web", "--json"]);
    const report = JSON.parse(run.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(report)).toEqual([
      "contract",
      "repo",
      "lane",
      "path",
      "proof",
      "treeHash",
      "ok",
      "difference",
      "exitCode",
    ]);
    expect(report["contract"]).toBe(CHECK_CONTRACT);
    expect(report["path"]).toBe(proofRelativePath("web"));
    expect(report["ok"]).toBe(true);
    expect(report["difference"]).toBeNull();
  });

  it("exits 1 naming the ABSENCE when no build has recorded one", async () => {
    const run = await check(["check", "--require-proof", "web"], { proof: null });
    expect(run.code).toBe(1);
    expect(run.err.join("\n")).toContain("there is no build proof for lane 'web'");
    // AND IT SAYS WHAT ELSE PRODUCES THIS. A red build removes the proof, so
    // "absent" and "the last build failed" look the same from here -- which is
    // a fact a reader needs, not one to hide.
    expect(run.err.join("\n")).toContain("a build that came out red removes it");
  });

  it("exits 1 naming the MOVE when the tree has changed since the build", async () => {
    const run = await check(["check", "--require-proof", "web"], { script: hashes(OTHER) });
    expect(run.code).toBe(1);
    expect(run.err.join("\n")).toContain("the tree has moved since the build");
    expect(run.err.join("\n")).toContain(TREE);
    expect(run.err.join("\n")).toContain(OTHER);
  });

  it("exits 1 naming the LANE when the proof answers for a different one", async () => {
    // Written under this lane's name, recording another lane's build: a proof
    // answers for the lane that built it and for no other.
    const run = await check(["check", "--require-proof", "web"], { proof: { lane: "admin" } });
    expect(run.code).toBe(1);
    expect(run.err.join("\n")).toContain("records lane 'admin'");
  });

  it("refuses a proof it cannot read rather than reporting it as absent", async () => {
    const damaged = await check(["check", "--require-proof", "web"], { proof: "{ not json" });
    expect(damaged.code).toBe(2);
    expect(damaged.err.join("\n")).toContain("is present and is not valid JSON");

    const wrongShape = await check(["check", "--require-proof", "web"], {
      proof: { treeHash: 17 } as Proof,
    });
    expect(wrongShape.code).toBe(1);
    expect(wrongShape.err.join("\n")).toContain("is not a build proof nen can read");
    expect(wrongShape.err.join("\n")).toContain("its 'treeHash' is not a string");
  });

  it("refuses a proof whose VALUES say it is not one, not only whose types are wrong", async () => {
    // A file that parses is not a file this release can answer from. Each of
    // these decides a verdict rather than describing one: another contract may
    // mean something else by the same fields, and `verb`/`exitCode` are the
    // file's own assertion that a GREEN BUILD produced it -- nen writes no
    // other pair, so any other reached the disk by hand.
    const other = await check(["check", "--require-proof", "web"], {
      proof: { contract: "nen.shu.proof/v9.9" } as Proof,
    });
    expect(other.code).toBe(1);
    expect(other.err.join("\n")).toContain("this release reads 'nen.shu.proof/v0.1'");

    const red = await check(["check", "--require-proof", "web"], { proof: { exitCode: 1 } as Proof });
    expect(red.code).toBe(1);
    expect(red.err.join("\n")).toContain("a build proof is only ever 'build' at exit 0");

    // An empty hash compares unequal to every real tree, so left alone it would
    // be reported as a moved tree forever -- a damaged file wearing a
    // legitimate difference's clothes.
    const empty = await check(["check", "--require-proof", "web"], { proof: { treeHash: "" } as Proof });
    expect(empty.code).toBe(1);
    expect(empty.err.join("\n")).toContain("its 'treeHash' is empty");
  });

  it("hashes the tree exactly as the build did -- same calls, same exclusion", async () => {
    const run = await check(["check", "--require-proof", "web"]);
    expect(run.seams.calls.map((call): string => [call.command, ...call.args].join(" "))).toEqual([
      ADD,
      DROP,
      WRITE_TREE,
    ]);
    for (const call of run.seams.calls) {
      expect(call.env?.["GIT_INDEX_FILE"]).toContain(".nen");
    }
  });

  it("refuses a missing --require-proof rather than picking a lane", async () => {
    const run = await check(["check"]);
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toContain("--require-proof <lane> is required");
  });

  it("refuses a missing --repo rather than answering about whatever directory this is", async () => {
    // THE ONLY READ-ONLY VERB IN THIS CLI THAT REQUIRES IT, and this is the
    // reason: a green verdict said of the wrong working copy is indistinguishable
    // in the output from a green verdict said of yours.
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const seams = new ScriptedSeams([], { platform: "linux" });
    const code = await runFamily(
      commitCommand,
      ["commit", "check", "--require-proof", "web"],
      null,
      false,
      io,
      seams,
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--repo <path> is required");
    expect(seams.calls).toEqual([]);
  });

  it("refuses a lane that would escape the tree", async () => {
    const run = await check(["check", "--require-proof", "../../../etc/passwd"]);
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toContain("resolves outside the repository");
  });

  it("refuses a flag this subcommand does not read", async () => {
    const run = await check(["check", "--require-proof", "web", "--type", "feat"]);
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toContain("not read by 'commit check'");
  });

  it("refuses --require-proof on 'format', which does not read it either", async () => {
    const run = await check(["format", "--type", "feat", "--subject", "x", "--require-proof", "web"]);
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toContain("not read by 'commit format'");
  });
});
