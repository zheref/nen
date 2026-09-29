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
    expect(existsSync(join(root, ".nen", "commit"))).toBe(false);
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
    expect(existsSync(join(root, ".nen", "commit"))).toBe(false);
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
    expect(existsSync(join(root, ".nen", "commit"))).toBe(false);
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

describe("nen commit write -- the repository's commitlint subject-case rule, through the check 'commit format' runs (zheref/nen#263)", () => {
  /** A checkout root (it has a `.git` entry) holding message.txt and these commitlint files. */
  function commitlintRepo(message: string, files: Record<string, string>): string {
    const root = repo({ message });
    mkdirSync(join(root, ".git"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text, "utf8");
    return root;
  }
  const CONVENTIONAL = { ".commitlintrc.json": JSON.stringify({ extends: ["@commitlint/config-conventional"] }) };

  it("refuses a level-2 break at exit 2 as a shape reason, before any git call", async () => {
    const root = commitlintRepo("fix(ui): Escape key closes the modal\n", CONVENTIONAL);
    const result = await capture(root, ["--message-file", "message.txt"], [STAGED, COMMITTED, HEAD]);
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/the message does not have the shape 'nen commit format' enforces/);
    expect(err).toContain("subject 'Escape key closes the modal' breaks this repository's commitlint rule 'subject-case'");
    expect(result.seams.calls).toEqual([]);
  });

  it("gives the same verdict 'commit format' gives -- one check, not two", async () => {
    const root = commitlintRepo("fix: Start the timer\n", CONVENTIONAL);
    const written = await capture(root, ["--message-file", "message.txt"]);
    const err: string[] = [];
    const io: Io = { out: (): void => {}, err: (line): void => void err.push(line) };
    const formatted = await runFamily(commitCommand, ["commit", "format", "--type", "fix", "--subject", "Start the timer"], root, false, io, new ScriptedSeams([]));
    expect(written.code).toBe(2);
    expect(formatted).toBe(2);
    const reason = err.join("\n").replace(/^nen: /, "");
    expect(written.err.join("\n")).toContain(reason);
  });

  it("names a subject-case break together with a shape violation", async () => {
    const root = commitlintRepo(`bogus: Start the timer\n`, CONVENTIONAL);
    const result = await capture(root, ["--message-file", "message.txt"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/not one of/);
    expect(result.err.join("\n")).toContain("subject must not be sentence-case");
  });

  it("commits a lower-case subject as before, and says nothing extra", async () => {
    const root = commitlintRepo("fix: start the timer\n", CONVENTIONAL);
    const result = await capture(root, ["--message-file", "message.txt"], [STAGED, COMMITTED, HEAD]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["committed newsha00: fix: start the timer"]);
    expect(result.err).toEqual([]);
  });

  it("prints a level-1 break as a warning and still commits", async () => {
    const root = commitlintRepo("fix: Start the timer\n", { ".commitlintrc.json": JSON.stringify({ rules: { "subject-case": [1, "always", "lower-case"] } }) });
    const result = await capture(root, ["--message-file", "message.txt", "--dry-run"], [STAGED]);
    expect(result.code).toBe(0);
    expect(result.err).toEqual([expect.stringMatching(/^nen: warning: subject 'Start the timer' breaks .*level 1/)]);
    expect(result.out[0]).toBe(`would run: git commit -F ${COMMIT_MESSAGE_PATH}`);
  });

  it("prints the 'NOT checked' warning for a JavaScript config even when the repository's own hook then refuses the commit", async () => {
    const root = commitlintRepo("fix: Start the timer\n", { "commitlint.config.js": "module.exports = { extends: ['@commitlint/config-conventional'] }\n" });
    const result = await capture(root, ["--message-file", "message.txt"], [STAGED, { match: `git commit -F ${COMMIT_MESSAGE_PATH}`, result: { code: 1, stderr: "subject must not be sentence-case [subject-case]" } }]);
    expect(result.code).toBe(1);
    const err = result.err.join("\n");
    expect(err).toMatch(/nen: warning: subject-case NOT checked: .*commitlint\.config\.js/);
    expect(err).toMatch(/For reference only/);
    expect(err).toMatch(/subject-case\]/);
  });

  it("exits 1 on a .commitlintrc it cannot read, naming the file, and commits nothing", async () => {
    const root = commitlintRepo("fix: start the timer\n", { ".commitlintrc.yaml": "rules: [unclosed\n" });
    const result = await capture(root, ["--message-file", "message.txt"], [STAGED, COMMITTED, HEAD]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain(join(root, ".commitlintrc.yaml"));
    expect(result.seams.calls).toEqual([]);
  });

  it("is not stopped by a package manifest in a repository with no commitlint -- the commit lands, and nothing is said", async () => {
    const manifests: readonly Record<string, string>[] = [{ "package.json": '{ "name": "x", ' }, { "package.yaml": "defaults: &d\n  node: 20\nengines: *d\n" }];
    for (const files of manifests) {
      const root = commitlintRepo("fix: Start the timer\n", files);
      const result = await capture(root, ["--message-file", "message.txt"], [STAGED, COMMITTED, HEAD]);
      expect(result.code).toBe(0);
      expect(result.out).toEqual(["committed newsha00: fix: Start the timer"]);
      expect(result.err).toEqual([]);
    }
  });

  it("judges the header the file carries, as commitlint's parser splits it", async () => {
    // Greedy scope: commitlint's subject here is 'bar', which is lower-case.
    const greedy = commitlintRepo("fix(a): Foo (b): bar\n", CONVENTIONAL);
    expect((await capture(greedy, ["--message-file", "message.txt"], [STAGED, COMMITTED, HEAD])).code).toBe(0);
    // A '!' header under a rules-only config: commitlint's default parser gives it no verdict.
    const bang = commitlintRepo("feat!: Foo bar\n", { ".commitlintrc.json": JSON.stringify({ rules: { "subject-case": [2, "never", ["sentence-case"]] } }) });
    const result = await capture(bang, ["--message-file", "message.txt", "--dry-run"], [STAGED]);
    expect(result.code).toBe(0);
    expect(result.err).toEqual([expect.stringMatching(/^nen: warning: subject-case NOT checked: .*default parser/)]);
  });
});

describe("nen commit write -- commits.subjectCase in nen/workflow.json, agreeing with 'commit format' (zheref/nen#263)", () => {
  const KRO_PWA = "module.exports = { extends: ['@commitlint/config-conventional'] }\n";
  /** A checkout root holding message.txt, a code commitlint config, and the given commits block. */
  function declaredRepo(message: string, commits: unknown, files: Record<string, string> = { "commitlint.config.cjs": KRO_PWA }): string {
    const root = repo({ message, policy: { commits } });
    mkdirSync(join(root, ".git"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text, "utf8");
    return root;
  }

  it("refuses 'Escape closes it' at exit 2 before any git call, naming nen/workflow.json -- the same verdict 'commit format' gives", async () => {
    const root = declaredRepo("fix: Escape closes it\n", { subjectCase: "config-conventional" });
    const written = await capture(root, ["--message-file", "message.txt"], [STAGED, COMMITTED, HEAD]);
    expect(written.code).toBe(2);
    expect(written.seams.calls).toEqual([]);
    expect(written.err.join("\n")).toMatch(/subject 'Escape closes it' breaks the subject-case rule this repository declares \(commits\.subjectCase in .*nen\/workflow\.json/);
    const err: string[] = [];
    const io: Io = { out: (): void => {}, err: (line): void => void err.push(line) };
    const formatted = await runFamily(commitCommand, ["commit", "format", "--type", "fix", "--subject", "Escape closes it"], root, false, io, new ScriptedSeams([]));
    expect(formatted).toBe(2);
    expect(written.err.join("\n")).toContain(err.join("\n").replace(/^nen: /, ""));
  });

  it("commits a subject the declared rule passes, with the note saying where the rule came from", async () => {
    const root = declaredRepo("fix: escape closes it\n", { subjectCase: [2, "always", "lower-case"] });
    const result = await capture(root, ["--message-file", "message.txt"], [STAGED, COMMITTED, HEAD]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["committed newsha00: fix: escape closes it"]);
    expect(result.err).toEqual([expect.stringMatching(/^nen: note: subject-case checked against commits\.subjectCase in .*the rule \[2,"always",\["lower-case"\]\]/)]);
  });

  it("lets a readable data commitlint config win, noting the declaration was not applied", async () => {
    const root = declaredRepo("fix: start the timer\n", { subjectCase: [2, "always", "upper-case"] }, { ".commitlintrc.json": JSON.stringify({ extends: ["@commitlint/config-conventional"] }) });
    const result = await capture(root, ["--message-file", "message.txt", "--dry-run"], [STAGED]);
    expect(result.code).toBe(0);
    expect(result.err).toEqual([expect.stringMatching(/^nen: note: commits\.subjectCase in .* is not applied/)]);
  });

  it("refuses a malformed commits.subjectCase at exit 1 by pointer, even with no --trailer, and commits nothing", async () => {
    const root = declaredRepo("fix: start the timer\n", { subjectCase: [2, "sometimes", "lower-case"] });
    const result = await capture(root, ["--message-file", "message.txt"], [STAGED, COMMITTED, HEAD]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("commits.subjectCase[1]");
    expect(result.err.join("\n")).toMatch(/nen will not commit under a policy it could not read/);
    expect(result.seams.calls).toEqual([]);
  });
});

describe("nen commit write -- a broken config is reported first and whole, as 'commit format' reports it (zheref/nen#263)", () => {
  /** A checkout root holding message.txt and exactly these files (a `nen/` path creates the directory). */
  function brokenRepo(message: string, files: Record<string, string>): string {
    const root = repo({ message });
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "nen"), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, ...name.split("/")), text, "utf8");
    return root;
  }

  it("names a malformed nen/workflow.json AND the message's own shape fault, policy first, at exit 1, before any git call", async () => {
    const root = brokenRepo(`bogus: ${"x".repeat(80)}\n`, { "nen/workflow.json": "{ not json" });
    const result = await capture(root, ["--message-file", "message.txt"], [STAGED, COMMITTED, HEAD]);
    expect(result.code).toBe(1);
    expect(result.seams.calls).toEqual([]);
    expect(result.err[0]).toMatch(/nen\/workflow\.json.*nen will not commit under a policy it could not read/);
    expect(result.err.slice(1).join("\n")).toMatch(/not one of/);
    expect(result.err.slice(1).join("\n")).toMatch(/72-character/);
  });

  it("names BOTH a malformed nen/workflow.json and a malformed .commitlintrc -- one does not hide the other", async () => {
    const root = brokenRepo("fix: start the timer\n", { "nen/workflow.json": "{ not json", ".commitlintrc.json": "{ nope" });
    const result = await capture(root, ["--message-file", "message.txt"], [STAGED, COMMITTED, HEAD]);
    expect(result.code).toBe(1);
    expect(result.seams.calls).toEqual([]);
    expect(result.err).toEqual([
      expect.stringMatching(/nen\/workflow\.json.*nen will not commit under a policy it could not read/),
      expect.stringMatching(/\.commitlintrc\.json could not be read for its commitlint 'subject-case' rule/),
    ]);
  });

  it("agrees with 'commit format' on the same two broken files: the same lines, the same exit", async () => {
    const root = brokenRepo("fix: start the timer\n", { "nen/workflow.json": "{ not json", ".commitlintrc.json": "{ nope" });
    const written = await capture(root, ["--message-file", "message.txt"]);
    const err: string[] = [];
    const io: Io = { out: (): void => {}, err: (line): void => void err.push(line) };
    const formatted = await runFamily(commitCommand, ["commit", "format", "--type", "fix", "--subject", "start the timer"], root, false, io, new ScriptedSeams([]));
    expect(formatted).toBe(written.code);
    expect(err.map((line): string => line.replace("shape a message", "commit"))).toEqual(written.err);
  });
});

describe("nen commit write -- declared-rule outcomes at the verb: exit code, line prefix, and whether git ran (zheref/nen#263)", () => {
  const KRO_PWA = "module.exports = { extends: ['@commitlint/config-conventional'] }\n";
  it.each([
    ["no commitlint config + 'config-conventional'", {}, "config-conventional", 2, /^nen commit: the message does not have the shape[\s\S]*subject 'Start the timer' breaks the subject-case rule this repository declares.*because no commitlint config was found/, false],
    ["an unresolved preset + 'config-conventional'", { ".commitlintrc.json": JSON.stringify({ extends: ["@acme/commitlint-config"] }) }, "config-conventional", 2, /^nen commit: the message does not have the shape[\s\S]*extends '@acme\/commitlint-config', which nen cannot resolve/, false],
    ["a code config + a level-1 declaration", { "commitlint.config.cjs": KRO_PWA }, [1, "never", ["sentence-case"]], 0, /^nen: warning: subject 'Start the timer' breaks the subject-case rule this repository declares.*declared at level 1, so nen only warns/, true],
    ["a code config + a level-0 declaration", { "commitlint.config.cjs": KRO_PWA }, [0], 0, /^nen: note: subject-case is off: commits\.subjectCase in .*the rule \[0\] disables it/, true],
  ] as const)("%s", async (_name, files, subjectCase, code, line, gitRan) => {
    const root = repo({ message: "fix: Start the timer\n", policy: { commits: { subjectCase } } });
    mkdirSync(join(root, ".git"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text as string, "utf8");
    const result = await capture(root, ["--message-file", "message.txt"], [STAGED, COMMITTED, HEAD]);
    expect(result.code).toBe(code);
    expect(result.err.join("\n")).toMatch(line);
    expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git commit"))).toBe(gitRan);
    if (gitRan) expect(result.out).toEqual(["committed newsha00: fix: Start the timer"]);
  });
});
