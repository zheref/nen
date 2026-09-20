// src/commit/write.test.ts -- `nen commit write`, through the real dispatch
// and the fake seam: every refusal before the write, then the one write.

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { PROOF_CONTRACT, proofRelativePath } from "../shu/proof.js";
import { commitCommand } from "./command.js";
import { COMMIT_MESSAGE_PATH, composeMessage, WRITE_CONTRACT } from "./write.js";

const ADD = "git add -A -- .";
const DROP = "git rm -r -f --cached --quiet --ignore-unmatch -- .nen";
const WRITE_TREE = "git write-tree";
const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const STAGED = { match: "git diff --cached --quiet", result: { code: 1 } };
const NOTHING_STAGED = { match: "git diff --cached --quiet", result: { code: 0 } };
const COMMITTED = { match: `git commit -F ${COMMIT_MESSAGE_PATH}`, result: { code: 0 } };
const HEAD = { match: "git rev-parse HEAD", result: { stdout: "newsha00\n" } };

interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly seams: ScriptedSeams;
}

/** A temp repo root holding `message.txt` and, optionally, a policy and a proof. */
function repo(options: { message: string; policy?: unknown; proof?: { lane: string; tree: string } } ): string {
  const root = mkdtempSync(join(tmpdir(), "nen-commit-write-"));
  writeFileSync(join(root, "message.txt"), options.message, "utf8");
  if (options.policy !== undefined) {
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify(options.policy));
  }
  if (options.proof !== undefined) {
    const path = join(root, ...proofRelativePath(options.proof.lane).split("/"));
    mkdirSync(join(root, ".nen", "proof"), { recursive: true });
    writeFileSync(path, JSON.stringify({ contract: PROOF_CONTRACT, lane: options.proof.lane, verb: "build", treeHash: options.proof.tree, at: "2026-01-01T00:00:00Z", exitCode: 0 }));
  }
  return root;
}

async function capture(root: string | null, argv: readonly string[], script: readonly ScriptedCall[] = [], json = false): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const seams = new ScriptedSeams(script);
  const code = await runFamily(commitCommand, ["commit", "write", ...argv], root, json, io, seams);
  return { code, out, err, seams };
}

const gitCalls = (seams: ScriptedSeams): readonly string[] => seams.calls.map((call): string => [call.command, ...call.args].join(" "));

describe("composeMessage", () => {
  it("appends trailers as a new paragraph when the file has none, and onto the block when it does", () => {
    expect(composeMessage("feat: x\n\nbody\n", [{ key: "A", value: "1" }])).toBe("feat: x\n\nbody\n\nA: 1\n");
    expect(composeMessage("feat: x\n\nA: 1\n", [{ key: "B", value: "2" }])).toBe("feat: x\n\nA: 1\nB: 2\n");
    expect(composeMessage("feat: x\r\n\r\n\r\n", [])).toBe("feat: x\n");
  });
});

describe("nen commit write -- refusals before the write", () => {
  it("refuses an omitted --repo and --message-file at exit 2", async () => {
    expect((await capture(null, ["--message-file", "message.txt"])).code).toBe(2);
    expect((await capture(repo({ message: "feat: x\n" }), [])).code).toBe(2);
  });

  it("refuses a message that fails the shape 'commit format' enforces, every reason named, at exit 2, before any git call", async () => {
    const root = repo({ message: `bogus: ${"x".repeat(80)}\n` });
    const result = await capture(root, ["--message-file", "message.txt"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/not one of/);
    expect(result.err.join("\n")).toMatch(/72-character/);
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses a --trailer that is not 'Key: value', at exit 2", async () => {
    const root = repo({ message: "feat: x\n" });
    for (const bad of ["NoColon", "key:novalue", "Key:  two spaces", "bad key: v"]) {
      const result = await capture(root, ["--message-file", "message.txt", "--trailer", bad]);
      expect(result.code, bad).toBe(2);
      expect(result.err.join("\n")).toContain("is not 'Key: value'");
    }
  });

  it("refuses an attribution trailer the repository's policy does not admit -- the same policy 'commit format' reads", async () => {
    const root = repo({ message: "feat: x\n", policy: { commits: { allowedAttributionTrailers: ["Hatsu-Agent"] } } });
    const result = await capture(root, ["--message-file", "message.txt", "--trailer", "Co-Authored-By: Somebody <s@example.com>"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/Co-Authored-By/);
    const admitted = await capture(root, ["--message-file", "message.txt", "--trailer", "Hatsu-Agent: kurapika", "--dry-run"], [STAGED]);
    expect(admitted.code).toBe(0);
  });

  it("a malformed policy is exit 1, naming the pointer", async () => {
    const root = repo({ message: "feat: x\n", policy: { commits: { allowedAttributionTrailers: "not-a-list" } } });
    const result = await capture(root, ["--message-file", "message.txt", "--trailer", "Hatsu-Agent: kurapika"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/commits.allowedAttributionTrailers/);
  });

  it("--require-proof refuses at exit 1 when the proof is absent, for another lane, or for a moved tree; commits nothing", async () => {
    const hashes = (tree: string): ScriptedCall[] => [
      { match: ADD, result: { code: 0 } },
      { match: DROP, result: { code: 0 } },
      { match: WRITE_TREE, result: { stdout: `${tree}\n` } },
    ];
    const absent = await capture(repo({ message: "feat: x\n" }), ["--message-file", "message.txt", "--require-proof", "web"], hashes(TREE));
    expect(absent.code).toBe(1);
    expect(absent.err.join("\n")).toMatch(/there is no build proof for lane 'web'/);
    const other = await capture(repo({ message: "feat: x\n", proof: { lane: "api", tree: TREE } }), ["--message-file", "message.txt", "--require-proof", "web"], hashes(TREE));
    expect(other.code).toBe(1);
    expect(other.err.join("\n")).toMatch(/no build proof for lane 'web'/);
    const moved = await capture(repo({ message: "feat: x\n", proof: { lane: "web", tree: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" } }), ["--message-file", "message.txt", "--require-proof", "web"], hashes(TREE));
    expect(moved.code).toBe(1);
    expect(moved.err.join("\n")).toMatch(/the tree has moved since the build/);
    for (const result of [absent, other, moved]) {
      expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git commit"))).toBe(false);
    }
  });

  it("refuses an empty index at exit 1: 'nothing staged'", async () => {
    const result = await capture(repo({ message: "feat: x\n" }), ["--message-file", "message.txt"], [NOTHING_STAGED]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/nothing staged/);
    expect(gitCalls(result.seams)).toEqual(["git diff --cached --quiet"]);
  });
});

describe("nen commit write -- the write", () => {
  it("--dry-run prints the git line and the composed message, and writes nothing", async () => {
    const root = repo({ message: "feat(x): add a thing\n\nWhy it changed.\n" });
    const result = await capture(root, ["--message-file", "message.txt", "--trailer", "Hatsu-Agent: kurapika", "--trailer", "Closes: #4", "--dry-run"], [STAGED]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      `would run: git commit -F ${COMMIT_MESSAGE_PATH}`,
      "message:",
      "  feat(x): add a thing",
      "  ",
      "  Why it changed.",
      "  ",
      "  Hatsu-Agent: kurapika",
      "  Closes: #4",
    ]);
    expect(existsSync(join(root, ".nen", "commit", "message.txt"))).toBe(false);
    expect(gitCalls(result.seams)).toEqual(["git diff --cached --quiet"]);
  });

  it("commits with git commit -F on the composed file, removes it, and reports nen.commit.write/v0.1", async () => {
    const root = repo({ message: "feat(x): add a thing\n\nWhy.\n\nCloses: #4\n" });
    const result = await capture(root, ["--message-file", "message.txt", "--trailer", "Hatsu-Agent: kurapika"], [STAGED, COMMITTED, HEAD], true);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["contract", "sha", "subject", "trailers", "dryRun"]);
    expect(doc).toEqual({
      contract: WRITE_CONTRACT,
      sha: "newsha00",
      subject: "feat(x): add a thing",
      trailers: [{ key: "Closes", value: "#4" }, { key: "Hatsu-Agent", value: "kurapika" }],
      dryRun: false,
    });
    expect(gitCalls(result.seams)).toEqual(["git diff --cached --quiet", `git commit -F ${COMMIT_MESSAGE_PATH}`, "git rev-parse HEAD"]);
    expect(existsSync(join(root, ".nen", "commit", "message.txt"))).toBe(false);
    const text = await capture(root, ["--message-file", "message.txt"], [STAGED, COMMITTED, HEAD]);
    expect(text.out).toEqual(["committed newsha00: feat(x): add a thing"]);
  });

  it("commits after a green --require-proof", async () => {
    const root = repo({ message: "feat: x\n", proof: { lane: "web", tree: TREE } });
    const result = await capture(root, ["--message-file", "message.txt", "--require-proof", "web"], [
      { match: ADD, result: { code: 0 } },
      { match: DROP, result: { code: 0 } },
      { match: WRITE_TREE, result: { stdout: `${TREE}\n` } },
      STAGED,
      COMMITTED,
      HEAD,
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["committed newsha00: feat: x"]);
  });

  it("a failed git commit is exit 1 with git's reason, and the message file is still removed", async () => {
    const root = repo({ message: "feat: x\n" });
    const result = await capture(root, ["--message-file", "message.txt"], [STAGED, { match: `git commit -F ${COMMIT_MESSAGE_PATH}`, result: { code: 1, stderr: "hook refused" } }]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/hook refused/);
    expect(existsSync(join(root, ".nen", "commit", "message.txt"))).toBe(false);
  });

  it("refuses the flags the other subcommands own, and 'format' still takes its comma-joined --trailer", async () => {
    const root = repo({ message: "feat: x\n" });
    const foreign = await capture(root, ["--message-file", "message.txt", "--type", "feat"]);
    expect(foreign.code).toBe(2);
    expect(foreign.err.join("\n")).toMatch(/--type is not read by 'commit write'/);
    const out: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (): void => {} };
    const code = await runFamily(commitCommand, ["commit", "format", "--type", "feat", "--subject", "x", "--trailer", "A=1,B=2", "--trailer", "C=3"], null, false, io, new ScriptedSeams([]));
    expect(code).toBe(0);
    expect(out.join("\n")).toBe("feat: x\n\nA: 1\nB: 2\nC: 3");
  });
});
