// src/shu/proof.test.ts -- the build proof, from both ends: `nen shu build`
// writes it and removes it, and the file it leaves is the one `nen commit
// check` reads (../commit/check.test.ts drives the other half).
//
// EVERY GIT CALL IS SCRIPTED. The tree hash comes through the seam, so these
// tests state what git answered instead of standing in a real repository --
// which is what makes "the proof records THIS tree" provable without one, and
// on every CI lane.

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { shuCommand } from "./command.js";
import { PROOF_CONTRACT, proofRelativePath } from "./proof.js";

/** The three calls a tree hash takes, in the order ../repo/tree.ts makes them. */
const ADD = "git add -A -- .";
const DROP = "git rm -r -f --cached --quiet --ignore-unmatch -- .nen";
const WRITE_TREE = "git write-tree";
const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const hashes = (tree = TREE): readonly ScriptedCall[] => [
  { match: ADD, result: { code: 0 } },
  { match: DROP, result: { code: 0 } },
  { match: WRITE_TREE, result: { code: 0, stdout: `${tree}\n` } },
];

interface Ran {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly root: string;
  readonly seams: ScriptedSeams;
}

/**
 * One `nen shu` run against a throwaway repository, with the directory left in
 * place for the caller to look at.
 *
 * THE DIRECTORY IS THE SUBJECT HERE, unlike ./run.test.ts's own helper, which
 * removes it: what this file asserts is what is ON DISK afterwards.
 */
async function inRepo(
  argv: readonly string[],
  options: { script?: readonly ScriptedCall[]; before?: (root: string) => void } = {},
): Promise<Ran> {
  const root = mkdtempSync(join(tmpdir(), "nen-proof-"));
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  mkdirSync(join(root, "nen"));
  writeFileSync(
    join(root, "nen", "contract.json"),
    JSON.stringify({
      $schema: "nen.contract/v0.1",
      project: {
        lanes: { web: { stack: "placeholder-stack", cwd: "." } },
        defaultLane: "web",
        verbs: {
          web: {
            build: { exe: "placeholder-tool", argv: ["build"] },
            test: { exe: "placeholder-tool", argv: ["test"] },
          },
        },
      },
    }),
  );
  options.before?.(root);
  const seams = new ScriptedSeams(options.script ?? [], {
    platform: "linux",
    now: (): Date => new Date("2026-03-04T05:06:07.000Z"),
  });
  const code = await runFamily(shuCommand, ["shu", ...argv], root, false, io, seams);
  return { code, out, err, root, seams };
}

const proofOf = (root: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, proofRelativePath("web")), "utf8")) as Record<string, unknown>;

const written = (root: string): boolean => existsSync(join(root, proofRelativePath("web")));

describe("a green build records the tree it proved", () => {
  it("writes the document, key order and all, and creates .nen/proof/", async () => {
    const run = await inRepo(["build"], {
      script: [{ match: "placeholder-tool build", result: { code: 0 } }, ...hashes()],
    });
    try {
      expect(run.code).toBe(0);
      const proof = proofOf(run.root);
      expect(Object.keys(proof)).toEqual(["contract", "lane", "verb", "treeHash", "at", "exitCode"]);
      expect(proof).toEqual({
        contract: PROOF_CONTRACT,
        lane: "web",
        verb: "build",
        treeHash: TREE,
        // THE SEAM'S CLOCK, not the wall's: a proof written from a replayed run
        // is reproducible, which is the property ../seam/exec.ts's `now` exists
        // for.
        at: "2026-03-04T05:06:07.000Z",
        exitCode: 0,
      });
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });

  it("hashes the WORKING COPY through a scratch index, never the repository's own", async () => {
    const run = await inRepo(["build"], {
      script: [{ match: "placeholder-tool build", result: { code: 0 } }, ...hashes()],
    });
    try {
      const git = run.seams.calls.filter((call): boolean => call.command === "git");
      expect(git.map((call): string => [call.command, ...call.args].join(" "))).toEqual([
        ADD,
        DROP,
        WRITE_TREE,
      ]);
      // GIT_INDEX_FILE ON ALL THREE, pointing inside `.nen/` -- which the middle
      // call drops back out of the index, so the scratch file cannot alter the
      // number it is being used to compute.
      for (const call of git) {
        expect(call.cwd).toBe(run.root);
        expect(call.env?.["GIT_INDEX_FILE"]).toContain(".nen");
      }
      // AND IT DOES NOT SURVIVE THE CALL.
      expect(existsSync(join(run.root, ".nen", "write-tree.index"))).toBe(false);
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });

  it("names the proof in the report, in text and in --json", async () => {
    const run = await inRepo(["build", "--json"], {
      script: [{ match: "placeholder-tool build", result: { code: 0 } }, ...hashes()],
    });
    try {
      const report = JSON.parse(run.out.join("\n")) as { proof: { treeHash: string } | null };
      expect(report.proof).toMatchObject({ treeHash: TREE, lane: "web" });
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
    const text = await inRepo(["build"], {
      script: [{ match: "placeholder-tool build", result: { code: 0 } }, ...hashes()],
    });
    try {
      expect(text.out.join("\n")).toContain(`proof:         ${proofRelativePath("web")}  tree ${TREE}`);
    } finally {
      rmSync(text.root, { recursive: true, force: true });
    }
  });

  it("writes NOTHING on a dry run -- it ran no build, so it learned nothing", async () => {
    const run = await inRepo(["build", "--dry-run"]);
    try {
      expect(run.code).toBe(0);
      expect(written(run.root)).toBe(false);
      expect(run.seams.calls).toEqual([]);
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });

  it("writes nothing for a verb that is not 'build'", async () => {
    const run = await inRepo(["test"], {
      script: [{ match: "placeholder-tool test", result: { code: 0 } }],
    });
    try {
      expect(run.code).toBe(0);
      expect(written(run.root)).toBe(false);
      // AND ASKS GIT NOTHING. A test run is not a build proof and does not pay
      // for one.
      expect(run.seams.calls.filter((call): boolean => call.command === "git")).toEqual([]);
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });

  it("keeps the build green when the proof cannot be written, and says so", async () => {
    const run = await inRepo(["build"], {
      // `git write-tree` refused. `must` raises, `greenBuild` reports it, and
      // the BUILD -- which really was green -- stays green: a marker file may
      // not fail a compile.
      script: [
        { match: "placeholder-tool build", result: { code: 0 } },
        { match: ADD, result: { code: 0 } },
        { match: DROP, result: { code: 0 } },
        { match: WRITE_TREE, result: { code: 128, stderr: "not a git repository" } },
      ],
    });
    try {
      expect(run.code).toBe(0);
      expect(written(run.root)).toBe(false);
      expect(run.err.join("\n")).toContain("its proof could not be written");
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });
});

describe("a red build removes the proof, so it never outlives the tree it proved", () => {
  const stale = (root: string): void => {
    mkdirSync(join(root, ".nen", "proof"), { recursive: true });
    writeFileSync(
      join(root, proofRelativePath("web")),
      JSON.stringify({ contract: PROOF_CONTRACT, lane: "web", verb: "build", treeHash: "old", at: "then", exitCode: 0 }),
    );
  };

  it("removes it when a step exits non-zero", async () => {
    const run = await inRepo(["build"], {
      before: stale,
      script: [{ match: "placeholder-tool build", result: { code: 2 } }],
    });
    try {
      expect(run.code).toBe(1);
      expect(written(run.root)).toBe(false);
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });

  it("removes it when the declared program could not be started at all", async () => {
    const run = await inRepo(["build"], {
      before: stale,
      script: [{ match: "placeholder-tool build", result: { spawnFailed: true, stderr: "no such tool" } }],
    });
    try {
      expect(run.code).toBe(5);
      expect(written(run.root)).toBe(false);
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });

  it("LEAVES it when nothing ran: a dry run has learned nothing either way", async () => {
    const run = await inRepo(["build", "--dry-run"], { before: stale });
    try {
      expect(run.code).toBe(0);
      expect(proofOf(run.root)["treeHash"]).toBe("old");
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });
});
