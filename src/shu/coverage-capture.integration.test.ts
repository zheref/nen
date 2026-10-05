// src/shu/coverage-capture.integration.test.ts -- `nen shu coverage --touched
// --from-capture` against the REAL git (zheref/nen#250, hanten round 1).
//
// WHY A REAL GIT. The provenance rule is a claim about what git prints: that
// `git diff HEAD --binary` moves on a rename, a deletion and an edit made while
// the suite runs; that `ls-files --others --exclude-standard` names a new file;
// that `core.quotePath=false` with `-z` hands back `src/café.ts` as itself. A
// scripted seam can prove nen sends the argv it means to; only git can prove
// the argv means what the rule needs. Every case the review reproduced against
// the earlier mtime rule is here, end to end.
//
// THE COVERAGE TOOL IS THIS PROCESS'S OWN RUNTIME (`process.execPath -e`),
// writing the declared report -- so a real child runs, with no toolchain
// assumed, on all three CI lanes. It SKIPS where git is not on PATH.

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { classifyCommand } from "../parse/izanami.js";
import { defaultSeams } from "../seam/exec.js";
import { shuCommand } from "./command.js";

const WHO = ["-c", "user.name=nen test", "-c", "user.email=nen@example.invalid", "-c", "commit.gpgsign=false"];
const CAFE = "src/café.ts";
const SUMMARY = "coverage/coverage-summary.json";
const LCOV = "coverage/lcov.info";

function git(cwd: string, args: readonly string[]): string {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" };
  const result = spawnSync("git", ["-c", "core.autocrlf=false", ...WHO, ...args], { cwd, encoding: "utf8", env });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

const HAVE_GIT = ((): boolean => {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();

/** A script for `process.execPath -e` that writes the declared reports. */
function writer(declared: readonly string[], extra = "", before = ""): string {
  const summary = JSON.stringify({
    total: { lines: { total: 12, covered: 9 } },
    "src/a.ts": { lines: { total: 4, covered: 4 } },
    "src/b.ts": { lines: { total: 4, covered: 2 } },
    [CAFE]: { lines: { total: 4, covered: 3 } },
  });
  const lcov = `SF:src/a.ts\\nLF:4\\nLH:4\\nend_of_record\\nSF:${CAFE}\\nLF:4\\nLH:3\\nend_of_record\\n`;
  return [
    `const fs = require("fs");`,
    before,
    `fs.mkdirSync("coverage", { recursive: true });`,
    `fs.writeFileSync(${JSON.stringify(SUMMARY)}, ${JSON.stringify(summary)});`,
    declared.includes(LCOV) ? `fs.writeFileSync(${JSON.stringify(LCOV)}, "${lcov}");` : "",
    extra,
  ].join("\n");
}

interface RepoOptions {
  /** Extra JS the coverage tool runs after writing its reports. */
  readonly during?: string;
  /** JS the coverage tool runs BEFORE writing -- it may exit, or skip the write. */
  readonly before?: string;
  /** The reports the coverage row declares. */
  readonly artifacts?: readonly string[];
  /** A `test` row, if any, and the artifacts it declares. */
  readonly testArtifacts?: readonly string[] | null;
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * `main` holds src/a.ts and src/b.ts; `feature` edits src/a.ts and adds
 * src/café.ts -- so `main...HEAD` touches those two, and src/b.ts is a file
 * the change does not touch.
 */
function repo(options: RepoOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-capture-"));
  made.push(dir);
  git(dir, ["-c", "init.defaultBranch=main", "init", "-q"]);
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "nen"));
  const artifacts = options.artifacts ?? [SUMMARY];
  const verbs: Record<string, unknown> = {
    coverage: { exe: process.execPath, argv: ["-e", writer(artifacts, options.during, options.before)], artifacts },
  };
  if (options.testArtifacts !== undefined && options.testArtifacts !== null) {
    // The test row's tool writes what the COVERAGE row declares -- the shape
    // of a test command that also produces the coverage capture.
    verbs["test"] = { exe: process.execPath, argv: ["-e", writer(artifacts)], artifacts: options.testArtifacts };
  }
  writeFileSync(
    join(dir, "nen", "contract.json"),
    JSON.stringify({
      $schema: "nen.contract/v0.1",
      project: { lanes: { only: { stack: "nextjs", cwd: "." } }, defaultLane: "only", verbs: { only: verbs } },
    }),
  );
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
  writeFileSync(join(dir, CAFE), "export const c = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "feature"]);
  return dir;
}

async function nen(dir: string, argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(shuCommand, ["shu", ...argv], dir, false, io, defaultSeams());
  return { code, out, err };
}

const MEASURE = ["coverage", "--touched", "--base", "main", "--json"];
const REUSE = [...MEASURE, "--from-capture"];

describe.skipIf(!HAVE_GIT)("--from-capture, against the real git", () => {
  it("capture, nothing changed: reused, the SAME document the run printed, café.ts matched (N1)", async () => {
    const dir = repo();
    const ran = await nen(dir, MEASURE);
    expect(ran.code, ran.err.join("\n")).toBe(0);
    const sidecar = JSON.parse(readFileSync(join(dir, ".nen/coverage-capture/only.json"), "utf8")) as Record<string, unknown>;
    expect(sidecar["contract"]).toBe("nen.shu.coverage-capture/v0.1");
    expect(sidecar["lane"]).toBe("only");
    expect(sidecar["verb"]).toBe("coverage");
    expect(sidecar["head"]).toBe(git(dir, ["rev-parse", "HEAD"]).trim());
    const reused = await nen(dir, REUSE);
    expect(reused.code, reused.err.join("\n")).toBe(0);
    expect(JSON.parse(reused.out.join("\n"))).toEqual(JSON.parse(ran.out.join("\n")));
    const touched = (JSON.parse(reused.out.join("\n")) as { touched: { matched: string[] } }).touched;
    expect(touched.matched).toEqual(["src/a.ts", CAFE]);
  });

  it("capture, then edit a touched file: refused at 8, no document", async () => {
    const dir = repo();
    expect((await nen(dir, MEASURE)).code).toBe(0);
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 3;\n");
    const reused = await nen(dir, REUSE);
    expect(reused.code).toBe(8);
    expect(reused.out).toEqual([]);
    expect(reused.err.join("\n")).toMatch(/working tree is not the one the capture's run started on: HEAD is the same/);
  });

  it("an edit made WHILE the suite ran is refused -- the fingerprint is taken at the start (N2)", async () => {
    const dir = repo({ during: `fs.appendFileSync("src/a.ts", "// edited mid-run\\n");` });
    expect((await nen(dir, MEASURE)).code).toBe(0);
    expect((await nen(dir, REUSE)).code).toBe(8);
  });

  it("a merge that changes only a file the diff does not touch is refused (N3)", async () => {
    const dir = repo();
    expect((await nen(dir, MEASURE)).code).toBe(0);
    git(dir, ["checkout", "-q", "main"]);
    writeFileSync(join(dir, "src", "b.ts"), "export const b = 2;\n");
    git(dir, ["commit", "-q", "-am", "b moves on main"]);
    git(dir, ["checkout", "-q", "feature"]);
    git(dir, ["merge", "-q", "--no-edit", "main"]);
    // src/b.ts is not in main...HEAD any more -- the merge base moved with it.
    expect(git(dir, ["diff", "--name-only", "main...HEAD"])).not.toContain("src/b.ts");
    const reused = await nen(dir, REUSE);
    expect(reused.code).toBe(8);
    expect(reused.err.join("\n")).toMatch(/HEAD was [0-9a-f]{12} and is now [0-9a-f]{12}/);
  });

  it("a rename after the capture is refused (N4)", async () => {
    const dir = repo();
    expect((await nen(dir, MEASURE)).code).toBe(0);
    git(dir, ["mv", "src/b.ts", "src/c.ts"]);
    expect((await nen(dir, REUSE)).code).toBe(8);
  });

  it("a deletion after the capture is refused (N4)", async () => {
    const dir = repo();
    expect((await nen(dir, MEASURE)).code).toBe(0);
    rmSync(join(dir, "src", "b.ts"));
    expect((await nen(dir, REUSE)).code).toBe(8);
  });

  it("a new untracked file after the capture is refused", async () => {
    const dir = repo();
    expect((await nen(dir, MEASURE)).code).toBe(0);
    writeFileSync(join(dir, "src", "d.ts"), "export const d = 1;\n");
    expect((await nen(dir, REUSE)).code).toBe(8);
  });

  it("two reports, ONE rewritten after the capture: refused naming that one only (N10)", async () => {
    const dir = repo({ artifacts: [SUMMARY, LCOV] });
    expect((await nen(dir, MEASURE)).code).toBe(0);
    writeFileSync(join(dir, LCOV), "SF:src/a.ts\nLF:4\nLH:0\nend_of_record\n");
    const reused = await nen(dir, REUSE);
    expect(reused.code).toBe(8);
    const said = reused.err.join("\n");
    expect(said).toContain(`'${LCOV}' is not the file the run recorded`);
    expect(said).not.toContain(`'${SUMMARY}' is not the file`);
    expect(said).not.toMatch(/working tree is not/);
  });

  it("a run that leaves an UNDECLARED, unignored output beside its report cannot vouch for itself -- the stated limit", async () => {
    // The fingerprint leaves out only the DECLARED reports and the sidecar
    // directory. A second file the tool writes and nobody ignores is a new
    // untracked file to the fingerprint, so the capture is refused: fail
    // closed. The fix is the repository's -- ignore it, or declare it.
    const dir = repo({ during: `fs.writeFileSync("coverage/extra.html", "<p/>");` });
    expect((await nen(dir, MEASURE)).code).toBe(0);
    expect((await nen(dir, REUSE)).code).toBe(8);
    writeFileSync(join(dir, ".gitignore"), "coverage/extra.html\n");
    git(dir, ["add", ".gitignore"]);
    git(dir, ["commit", "-q", "-m", "ignore the extra output"]);
    expect((await nen(dir, MEASURE)).code).toBe(0);
    expect((await nen(dir, REUSE)).code).toBe(0);
  });

  it("a capture produced OUTSIDE nen (no sidecar) is refused by design", async () => {
    const dir = repo();
    mkdirSync(join(dir, "coverage"));
    writeFileSync(join(dir, SUMMARY), JSON.stringify({ total: { lines: { total: 1, covered: 1 } } }));
    const reused = await nen(dir, REUSE);
    expect(reused.code).toBe(8);
    expect(reused.err.join("\n")).toMatch(/no provenance sidecar at '\.nen\/coverage-capture\/only\.json'.*refused by design/);
  });

  it("'shu test' records the capture when its row declares the lane's coverage reports", async () => {
    const dir = repo({ testArtifacts: [SUMMARY] });
    const tested = await nen(dir, ["test"]);
    expect(tested.code, tested.err.join("\n")).toBe(0);
    const sidecar = JSON.parse(readFileSync(join(dir, ".nen/coverage-capture/only.json"), "utf8")) as Record<string, unknown>;
    expect(sidecar["verb"]).toBe("test");
    expect((await nen(dir, REUSE)).code).toBe(0);
  });

  it("'shu test' records nothing when its row declares no coverage report", async () => {
    const dir = repo({ testArtifacts: [] });
    expect((await nen(dir, ["test"])).code).toBe(0);
    expect(existsSync(join(dir, ".nen/coverage-capture/only.json"))).toBe(false);
    expect((await nen(dir, REUSE)).code).toBe(8);
  });

  it("the run form matches a NON-ASCII touched path too -- git's paths arrive unquoted (N1)", async () => {
    const dir = repo();
    const ran = await nen(dir, MEASURE);
    expect(ran.code).toBe(0);
    const doc = JSON.parse(ran.out.join("\n")) as { touched: { files: string[]; unmatched: string[] } };
    expect(doc.touched.files).toContain(CAFE);
    expect(doc.touched.unmatched).toEqual([]);
  });

  it("--base=--output=<p> is refused at 2 and writes nothing (N5)", async () => {
    const dir = repo();
    const result = await nen(dir, ["coverage", "--touched", "--base=--output=leak.txt", "--from-capture"]);
    expect(result.code).toBe(2);
    expect(existsSync(join(dir, "leak.txt"))).toBe(false);
    // izanami still certifies the well-formed reuse line, and only because
    // the malformed one can never reach git.
    expect(classifyCommand("nen shu coverage --touched --base main --from-capture").classification).toBe("read-only");
  });

  // ── hanten round 2 (zheref/nen#250) ──────────────────────────────────────

  it("a run that exits 0 WITHOUT rewriting the report records nothing, and the old sidecar fails (N1)", async () => {
    const dir = repo({ before: `if (fs.existsSync(${JSON.stringify(SUMMARY)})) process.exit(0);` });
    expect((await nen(dir, MEASURE)).code).toBe(0);
    const sidecar = readFileSync(join(dir, ".nen/coverage-capture/only.json"), "utf8");
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 'T2';\n");
    const second = await nen(dir, MEASURE);
    expect(second.code).toBe(0);
    expect(second.err.join("\n")).toContain(`the run did not write '${SUMMARY}'; no provenance recorded`);
    expect(readFileSync(join(dir, ".nen/coverage-capture/only.json"), "utf8")).toBe(sidecar);
    const reused = await nen(dir, REUSE);
    expect(reused.code).toBe(8);
    expect(reused.err.join("\n")).toMatch(/working tree is not the one the capture's run started on/);
  });

  it("a failed run writes no sidecar", async () => {
    const dir = repo({ before: "process.exit(1);" });
    expect((await nen(dir, MEASURE)).code).toBe(1);
    expect(existsSync(join(dir, ".nen/coverage-capture"))).toBe(false);
  });

  it("--dry-run writes no sidecar", async () => {
    const dir = repo();
    expect((await nen(dir, [...MEASURE, "--dry-run"])).code).toBe(0);
    expect(existsSync(join(dir, ".nen/coverage-capture"))).toBe(false);
  });

  it("a tree that cannot be fingerprinted (no .git) records nothing, and says so", async () => {
    const dir = repo();
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    const ran = await nen(dir, ["coverage", "--json"]);
    expect(ran.code).toBe(0);
    expect(ran.err.join("\n")).toMatch(/recorded no coverage-capture provenance for lane 'only': HEAD does not name a commit/);
    expect(existsSync(join(dir, ".nen/coverage-capture"))).toBe(false);
  });

  it("exit 0 with a declared report missing records nothing, and says so", async () => {
    const dir = repo({ before: "process.exit(0);" });
    const ran = await nen(dir, MEASURE);
    expect(ran.code).toBe(1);
    expect(ran.err.join("\n")).toContain(`did not leave '${SUMMARY}' on disk`);
    expect(existsSync(join(dir, ".nen/coverage-capture"))).toBe(false);
  });

  it("'shu test-report' records the producing verb as 'test-report'", async () => {
    const dir = repo({ testArtifacts: [SUMMARY] });
    await nen(dir, ["test-report"]);
    const sidecar = JSON.parse(readFileSync(join(dir, ".nen/coverage-capture/only.json"), "utf8")) as Record<string, unknown>;
    expect(sidecar["verb"]).toBe("test-report");
  });

  it("a test row declaring only SOME of the coverage reports records nothing", async () => {
    const dir = repo({ artifacts: [SUMMARY, LCOV], testArtifacts: [SUMMARY] });
    expect((await nen(dir, ["test"])).code).toBe(0);
    expect(existsSync(join(dir, ".nen/coverage-capture"))).toBe(false);
  });

  it("a sidecar left behind a later FAILED run that rewrote the report is refused as artifact-changed", async () => {
    const dir = repo({
      before: `if (fs.existsSync(".git/nen-fail")) { fs.writeFileSync(${JSON.stringify(SUMMARY)}, '{"total":{"lines":{"total":2,"covered":1}}}'); process.exit(1); }`,
    });
    expect((await nen(dir, MEASURE)).code).toBe(0);
    writeFileSync(join(dir, ".git", "nen-fail"), "");
    expect((await nen(dir, MEASURE)).code).toBe(1);
    const reused = await nen(dir, REUSE);
    expect(reused.code).toBe(8);
    const said = reused.err.join("\n");
    expect(said).toContain(`'${SUMMARY}' is not the file the run recorded`);
    // .git/ is not in the tree: the fingerprint still matches, so this is
    // the REPORT's hash alone refusing it.
    expect(said).not.toMatch(/working tree is not/);
  });

  it("an edit to an ASSUME-UNCHANGED file -- invisible to git diff -- is refused (N2)", async () => {
    const dir = repo();
    git(dir, ["update-index", "--assume-unchanged", "src/b.ts"]);
    expect((await nen(dir, MEASURE)).code).toBe(0);
    writeFileSync(join(dir, "src", "b.ts"), "export const b = 'hidden';\n");
    expect(git(dir, ["status", "--porcelain", "--", "src"])).toBe("");
    expect((await nen(dir, REUSE)).code).toBe(8);
  });

  it("an edit to a SKIP-WORKTREE file is refused too (N2)", async () => {
    const dir = repo();
    git(dir, ["update-index", "--skip-worktree", "src/b.ts"]);
    expect((await nen(dir, MEASURE)).code).toBe(0);
    writeFileSync(join(dir, "src", "b.ts"), "export const b = 'hidden';\n");
    expect((await nen(dir, REUSE)).code).toBe(8);
  });

  it("an untracked path that is not UTF-8 makes the run record nothing, saying why -- never a marker (N2)", async () => {
    const dir = repo();
    const name = Buffer.concat([Buffer.from(join(dir, "src") + "/x"), Buffer.from([0xff]), Buffer.from(".ts")]);
    try {
      writeFileSync(name, "x");
    } catch {
      return; // a filesystem that only stores UTF-8 names (APFS) cannot hold one: nothing to prove here
    }
    const ran = await nen(dir, MEASURE);
    expect(ran.code).toBe(0);
    expect(ran.err.join("\n")).toMatch(/is not valid UTF-8/);
    expect(existsSync(join(dir, ".nen/coverage-capture"))).toBe(false);
  });

  // ── Copilot round 2 on zheref/nen#369 ────────────────────────────────────

  it("a real filename containing U+FFFD is recorded and reused -- only undecodable bytes refuse", async () => {
    const dir = repo();
    writeFileSync(join(dir, "src", "odd\uFFFD.ts"), "export {};\n");
    const ran = await nen(dir, MEASURE);
    expect(ran.code, ran.err.join("\n")).toBe(0);
    expect(existsSync(join(dir, ".nen/coverage-capture/only.json"))).toBe(true);
    expect((await nen(dir, REUSE)).code).toBe(0);
  });

  it("a symlinked .nen OUT of the tree is never written through", async () => {
    const dir = repo();
    const outside = mkdtempSync(join(tmpdir(), "nen-outside-"));
    made.push(outside);
    symlinkSync(outside, join(dir, ".nen"), "junction");
    const ran = await nen(dir, MEASURE);
    expect(ran.code).toBe(0);
    expect(ran.err.join("\n")).toMatch(/recorded no coverage-capture provenance for lane 'only': the capture sidecar names .*outside the repository/);
    expect(existsSync(join(outside, "coverage-capture"))).toBe(false);
  });
});

