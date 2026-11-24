// src/commit/strip.integration.test.ts -- commits.stripInjected (zheref/nen#594)
// against the REAL git, with the REAL nen-generated commit-msg hook and a REAL
// harness-style prepare-commit-msg hook in the same hooks directory.
//
// THIS IS THE DEFECT, REPRODUCED. Cursor's cloud agents append
// `Co-authored-by: <someone>` in their own prepare-commit-msg; the commit-msg
// hook `nen scaffold init` writes refuses it; `nen commit write` and `nen wc
// squash` then exit 1 with nothing committed. The harness hook here is the
// model ./readback.integration.test.ts already uses (`git interpret-trailers
// --in-place --trailer 'Co-authored-by: Cursor <cursoragent@cursor.com>'`),
// and the commit-msg hook is rendered by ../scaffold/hook.ts from the
// repository's own nen/workflow.json exactly as `scaffold init` renders it.
//
// THE FIXTURE IS ./readback.integration.test.ts's SHAPE: a repo-local
// identity, a pinned `core.hooksPath` under `.git/` (so a host's global hooks
// neither hide these nor add their own, and `git status` never sees them), the
// root commit made BEFORE either hook is installed (so no setup commit needs
// `--no-verify`), and a SKIP where git is missing or older than 2.28 -- that
// file's only guard; it does not skip on Windows, and neither does this one.
// The cases that drive the hook directly also need a POSIX `sh` on PATH, and
// skip where there is none.

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { wcCommand } from "../wc/command.js";
import type { Command } from "../cli/command.js";
import { renderCommitMsgHook } from "../scaffold/hook.js";
import { parseWorkflow, refusedTrailerKeys, trailerAdmitted } from "../schema/workflow.js";
import { makeTempDir } from "../testing/tempdir.js";
import { commitCommand } from "./command.js";

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function mustGit(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} exited ${result.code}: ${result.stderr}`);
  return result.stdout.trim();
}

function usableGit(): boolean {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) return false;
  const version = /(\d+)\.(\d+)/.exec(probe.stdout ?? "");
  if (version === null) return false;
  const major = Number(version[1]);
  const minor = Number(version[2]);
  return major > 2 || (major === 2 && minor >= 28);
}

const HAVE_GIT = usableGit();
const HAVE_SH = ((): boolean => {
  const probe = spawnSync("sh", ["-c", "exit 0"], { encoding: "utf8" });
  return probe.error === undefined && probe.status === 0;
})();

const CURSOR = "Co-authored-by: Cursor <cursoragent@cursor.com>";
const ADMITS = ["Hatsu-Agent"];
const OPT_IN = { commits: { allowedAttributionTrailers: ADMITS, stripInjected: ["Co-authored-by"] } };
const NO_OPT_IN = { commits: { allowedAttributionTrailers: ADMITS } };

/** The environment a plain `git commit` at a keyboard has: no nen variable at all. */
function plainEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["NEN_COMPOSED_TRAILER_KEYS"];
  delete env["NEN_STRIP_RUN"];
  return env;
}

let root = "";
let counter = 0;

// makeTempDir() removes it after this file's tests (zheref/nen#635).
beforeAll(() => {
  root = makeTempDir("nen-commit-strip-");
});

function hooksDir(repo: string): string {
  return join(repo, ".git", "nen-test-hooks");
}

/** The commit-msg hook `nen scaffold init` would write for `policy`. */
function installCommitMsgHook(repo: string, policy: unknown): string {
  const commits = parseWorkflow("<test>", policy).commits;
  const body = renderCommitMsgHook(
    { agentTrailer: "Hatsu-Agent", runTrailer: null, markerEnvVar: "NEN_TEST_AUTOMATED" },
    refusedTrailerKeys(commits),
    trailerAdmitted(commits, "Hatsu-Agent"),
    commits.stripInjected,
  );
  const path = join(hooksDir(repo), "commit-msg");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

/** The harness: a prepare-commit-msg appending `trailer` through git's own trailer writer. */
function installHarness(repo: string, trailer: string = CURSOR): void {
  const hook = join(hooksDir(repo), "prepare-commit-msg");
  writeFileSync(hook, `#!/bin/sh\ngit interpret-trailers --in-place --trailer '${trailer}' "$1"\n`);
  chmodSync(hook, 0o755);
}

/** A harness with a body of its own, for the shapes `git interpret-trailers` would not write. */
function installRawHarness(repo: string, body: string): void {
  const hook = join(hooksDir(repo), "prepare-commit-msg");
  writeFileSync(hook, `#!/bin/sh\n${body}\n`);
  chmodSync(hook, 0o755);
}

/** A repository with one root commit and the policy committed -- and, once that commit exists, both hooks. */
function repository(policy: unknown, extraCommits: readonly string[] = []): string {
  counter += 1;
  const repo = join(root, `repo-${counter}`);
  mkdirSync(repo);
  mustGit(repo, ["init", "--quiet", "--initial-branch=main"]);
  mustGit(repo, ["config", "core.autocrlf", "false"]);
  mustGit(repo, ["config", "user.name", "nen test"]);
  mustGit(repo, ["config", "user.email", "nen@example.invalid"]);
  mustGit(repo, ["config", "commit.gpgsign", "false"]);
  mkdirSync(hooksDir(repo));
  mustGit(repo, ["config", "core.hooksPath", hooksDir(repo)]);
  mkdirSync(join(repo, "nen"));
  writeFileSync(join(repo, "nen", "workflow.json"), `${JSON.stringify(policy)}\n`);
  writeFileSync(join(repo, "README.md"), "root\n");
  mustGit(repo, ["add", "-A"]);
  mustGit(repo, ["commit", "--quiet", "-m", "chore: root"]);
  if (extraCommits.length > 0) {
    mustGit(repo, ["switch", "--quiet", "-c", "work"]);
    for (const name of extraCommits) {
      writeFileSync(join(repo, `${name}.txt`), `${name}\n`);
      mustGit(repo, ["add", `${name}.txt`]);
      mustGit(repo, ["commit", "--quiet", "-m", `feat: add ${name}`]);
    }
  }
  installCommitMsgHook(repo, policy);
  return repo;
}

async function run(command: Command, argv: readonly string[], repo: string): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(command, [...argv, "--repo", repo], null, true, io, defaultSeams());
  return { code, out, err };
}

/** Stage one new file and write the message outside the index (under .git, so the tree stays clean). */
function stage(repo: string, name: string, message: string): string {
  writeFileSync(join(repo, name), `${name}\n`);
  mustGit(repo, ["add", name]);
  const path = join(repo, ".git", `msg-${name}.txt`);
  writeFileSync(path, message);
  return path;
}

/** The written commit's message, raw: plumbing, headers dropped. */
function headMessage(repo: string): string {
  const raw = mustGit(repo, ["cat-file", "commit", "HEAD"]);
  return raw.slice(raw.indexOf("\n\n") + 2);
}

/** The run id the directly-driven hook is given, as a verb would give one: lower-case hex. */
const RUN_ID = "0123abcd";

/**
 * The generated hook, driven directly on a message file in `repo`, with
 * `composed` as NEN_COMPOSED_TRAILER_KEYS and `run` as NEN_STRIP_RUN (null:
 * unset) -- exactly the two variables a verb sets on its child `git commit`.
 */
function driveHook(repo: string, message: string, composed: string | null, run: string | null = RUN_ID, locale: string | null = null): { code: number; stderr: string; message: string } {
  const path = join(repo, ".git", `drive-${counter}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(path, message);
  const env = plainEnv();
  if (composed !== null) env["NEN_COMPOSED_TRAILER_KEYS"] = composed;
  if (run !== null) env["NEN_STRIP_RUN"] = run;
  if (locale !== null) {
    env["LC_ALL"] = locale;
    env["LANG"] = locale;
  }
  const result = spawnSync("sh", [join(hooksDir(repo), "commit-msg"), path], { cwd: repo, encoding: "utf8", env });
  return { code: result.status ?? 1, stderr: result.stderr ?? "", message: readFileSync(path, "utf8") };
}

/** The directly-driven hook's sidecar: this test run's id. */
const sidecar = (repo: string): string => join(repo, ".git", `nen-stripped-trailers.${RUN_ID}`);

/** Every strip sidecar under the repository's git dir, whatever run wrote it. */
const sidecars = (repo: string): string[] => readdirSync(join(repo, ".git")).filter((name): boolean => name.startsWith("nen-stripped-trailers"));

describe.skipIf(!HAVE_GIT)("commits.stripInjected through the real hooks (zheref/nen#594)", () => {
  it("(a) opt-in + nen commit write: the commit lands WITHOUT the injected key, the composed trailers intact, exit 4 (AC-1)", async () => {
    const repo = repository(OPT_IN);
    installHarness(repo);
    const before = mustGit(repo, ["rev-parse", "HEAD"]);
    const message = stage(repo, "a.txt", "feat: add a\n");
    const result = await run(commitCommand, ["commit", "write", "--message-file", message, "--trailer", "Hatsu-Agent: kurapika"], repo);
    expect(result.code).toBe(4);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc["stripped"]).toEqual(["Co-authored-by"]);
    expect(doc["injected"]).toEqual([]);
    expect(doc["trailers"]).toEqual([{ key: "Hatsu-Agent", value: "kurapika" }]);
    expect(Object.keys(doc).at(-1)).toBe("stripped");
    const head = mustGit(repo, ["rev-parse", "HEAD"]);
    expect(doc["sha"]).toBe(head);
    expect(mustGit(repo, ["rev-parse", "HEAD~1"])).toBe(before);
    const written = headMessage(repo);
    expect(written).not.toMatch(/co-authored-by/i);
    expect(written).toContain("Hatsu-Agent: kurapika");
    expect(result.err.join("\n")).toMatch(/^nen commit write: the written commit [0-9a-f]+ does not carry 'Co-authored-by': the repository's commit-msg hook stripped that key/m);
    expect(sidecars(repo)).toEqual([]);
  });

  it("(b) NO opt-in: exit 1, nothing committed, today's refusal line -- the default is unchanged", async () => {
    const repo = repository(NO_OPT_IN);
    installHarness(repo);
    const before = mustGit(repo, ["rev-parse", "HEAD"]);
    const message = stage(repo, "b.txt", "feat: add b\n");
    const result = await run(commitCommand, ["commit", "write", "--message-file", message, "--trailer", "Hatsu-Agent: kurapika"], repo);
    expect(result.code).toBe(1);
    expect(mustGit(repo, ["rev-parse", "HEAD"])).toBe(before);
    const err = result.err.join("\n");
    expect(err).toMatch(/commit-msg: this message carries a 'Co-Authored-By:' trailer, which this repository's nen\/workflow\.json does not list under commits\.allowedAttributionTrailers\./);
    expect(err).not.toMatch(/stripInjected/);
    expect(readFileSync(join(hooksDir(repo), "commit-msg"), "utf8")).not.toContain("NEN_COMPOSED_TRAILER_KEYS");
  });

  it("(c) opt-in, but the composed message itself carries the key: refused before git at exit 2, nothing stripped (AC-2)", async () => {
    const repo = repository(OPT_IN);
    installHarness(repo);
    const before = mustGit(repo, ["rev-parse", "HEAD"]);
    const message = stage(repo, "c.txt", "feat: add c\n");
    const result = await run(commitCommand, ["commit", "write", "--message-file", message, "--trailer", "Hatsu-Agent: kurapika", "--trailer", "Co-authored-by: Somebody <s@example.invalid>"], repo);
    expect(result.code).toBe(2);
    expect(mustGit(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(sidecars(repo)).toEqual([]);
  });

  it.skipIf(!HAVE_SH)("(c) the hook itself, told the composed message carried the key, REFUSES rather than strips (AC-2)", () => {
    const repo = repository(OPT_IN);
    const text = `feat: add c\n\nHatsu-Agent: kurapika\n${CURSOR}\n`;
    const driven = driveHook(repo, text, "hatsu-agent,co-authored-by");
    expect(driven.code).toBe(1);
    expect(driven.stderr).toMatch(/carries a 'Co-Authored-By:' trailer/);
    expect(driven.stderr).not.toMatch(/stripped/);
    expect(driven.message).toBe(text);
    expect(sidecars(repo)).toEqual([]);
    // ...and with the composed keys naming only Hatsu-Agent, the same message IS stripped and passes.
    const stripped = driveHook(repo, text, "hatsu-agent");
    expect(stripped.code).toBe(0);
    expect(stripped.stderr).toContain("commit-msg: stripped the hook-injected 'Co-authored-by:' trailer (commits.stripInjected)");
    expect(stripped.message).toBe("feat: add c\n\nHatsu-Agent: kurapika\n");
    expect(readFileSync(sidecar(repo), "utf8")).toBe("Co-authored-by\n");
  });

  it("(d) opt-in + a plain 'git commit' with the variable UNSET: refused exactly as today", () => {
    const repo = repository(OPT_IN);
    installHarness(repo);
    const before = mustGit(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "d.txt"), "d\n");
    mustGit(repo, ["add", "d.txt"]);
    const result = git(repo, ["commit", "-m", "feat: add d\n\nHatsu-Agent: kurapika"], plainEnv());
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/carries a 'Co-Authored-By:' trailer/);
    expect(result.stderr).not.toMatch(/stripped/);
    expect(mustGit(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(sidecars(repo)).toEqual([]);
  });

  it.skipIf(!HAVE_SH)("(e) a body PROSE line that starts with the key is never touched -- only the trailer block is edited", () => {
    const repo = repository(OPT_IN);
    const text = `feat: add e\n\nCo-authored-by: is the line Cursor adds, quoted here as prose\nand this paragraph is the body.\n\nHatsu-Agent: kurapika\n${CURSOR}\n`;
    const driven = driveHook(repo, text, "hatsu-agent");
    // The trailer went; the prose stayed -- and the refusal then still fires on it, as it always did.
    expect(driven.message).toBe("feat: add e\n\nCo-authored-by: is the line Cursor adds, quoted here as prose\nand this paragraph is the body.\n\nHatsu-Agent: kurapika\n");
    expect(driven.code).toBe(1);
    expect(driven.stderr).toMatch(/carries a 'Co-Authored-By:' trailer/);
    // A last paragraph that is prose, not a trailer block, is left whole -- nothing stripped, nothing recorded.
    const prose = `feat: add e\n\nCo-authored-by: Cursor <c@c> wrote this line\nwhich is body text, not a trailer block.\n`;
    expect(rmSidecarThen(repo, (): ReturnType<typeof driveHook> => driveHook(repo, prose, "hatsu-agent")).message).toBe(prose);
    expect(sidecars(repo)).toEqual([]);
    // And the subject is never a trailer block, whatever it starts with.
    const subject = "Co-authored-by: a subject\n";
    expect(driveHook(repo, subject, "").message).toBe(subject);
    expect(sidecars(repo)).toEqual([]);
  });

  // hanten round 1, C: the strip's promised edge cases, each pinned against the real hook.
  // K (zheref/nen#682's Windows runner): line endings are the platform awk's --
  // Git for Windows' writes LF -- and git's cleanup strips a trailing CR anyway,
  // so the kept lines are compared with CRLF normalised, on every platform.
  it.skipIf(!HAVE_SH)("(C) a CRLF message is HANDLED: the key's line goes, every other line is kept (line endings left to awk and git's cleanup)", () => {
    const repo = repository(OPT_IN);
    const driven = driveHook(repo, `feat: crlf\r\n\r\nHatsu-Agent: kurapika\r\n${CURSOR}\r\n`, "hatsu-agent");
    expect(driven.code).toBe(0);
    expect(driven.message.replace(/\r\n/g, "\n")).toBe("feat: crlf\n\nHatsu-Agent: kurapika\n");
    expect(readFileSync(sidecar(repo), "utf8")).toBe("Co-authored-by\n");
  });

  it.skipIf(!HAVE_SH)("(C) NO trailing newline: the key on the last line is still removed", () => {
    const repo = repository(OPT_IN);
    const driven = driveHook(repo, `feat: no newline\n\nHatsu-Agent: kurapika\n${CURSOR}`, "hatsu-agent");
    expect(driven.code).toBe(0);
    expect(driven.message).toBe("feat: no newline\n\nHatsu-Agent: kurapika\n");
  });

  it.skipIf(!HAVE_SH)("(C) 'Co-authored-by-bot:' is ANOTHER key: kept, while 'Co-authored-by:' beside it goes", () => {
    const repo = repository(OPT_IN);
    const driven = driveHook(repo, `feat: bot\n\nHatsu-Agent: kurapika\nCo-authored-by-bot: Robot <r@example.invalid>\n${CURSOR}\n`, "hatsu-agent");
    expect(driven.code).toBe(0);
    expect(driven.message).toBe("feat: bot\n\nHatsu-Agent: kurapika\nCo-authored-by-bot: Robot <r@example.invalid>\n");
  });

  it.skipIf(!HAVE_SH)("(C) a key BELOW a scissors line is never stripped, and the refusal then fires (fail closed)", () => {
    const repo = repository(OPT_IN);
    const text = `feat: scissors\n\nHatsu-Agent: kurapika\n# ------------------------ >8 ------------------------\n${CURSOR}\n`;
    const driven = driveHook(repo, text, "hatsu-agent");
    expect(driven.message).toBe(text);
    expect(driven.code).toBe(1);
    expect(driven.stderr).toMatch(/carries a 'Co-Authored-By:' trailer/);
    expect(sidecars(repo)).toEqual([]);
  });

  it.skipIf(!HAVE_SH)("(C) two spellings of the key in different case: BOTH removed, ONE sidecar line", () => {
    const repo = repository(OPT_IN);
    const driven = driveHook(repo, `feat: twice\n\nHatsu-Agent: kurapika\nCo-authored-by: A <a@example.invalid>\nCO-AUTHORED-BY: B <b@example.invalid>\n`, "hatsu-agent");
    expect(driven.code).toBe(0);
    expect(driven.message).toBe("feat: twice\n\nHatsu-Agent: kurapika\n");
    expect(readFileSync(sidecar(repo), "utf8")).toBe("Co-authored-by\n");
  });

  it.skipIf(!HAVE_SH)("(C/D) the SPACED form 'Key : value', which git parses as the same trailer, is stripped too", () => {
    const repo = repository(OPT_IN);
    const driven = driveHook(repo, "feat: spaced\n\nHatsu-Agent: kurapika\nCo-authored-by \t: Cursor <c@example.invalid>\n", "hatsu-agent");
    expect(driven.code).toBe(0);
    expect(driven.message).toBe("feat: spaced\n\nHatsu-Agent: kurapika\n");
    expect(readFileSync(sidecar(repo), "utf8")).toBe("Co-authored-by\n");
  });

  it.skipIf(!HAVE_SH)("(E) a LEAKED composed-keys variable -- no run id, or a malformed one -- still strips, says it leaked, and writes no sidecar", () => {
    const repo = repository(OPT_IN);
    const text = `feat: leaked\n\nHatsu-Agent: kurapika\n${CURSOR}\n`;
    for (const run of [null, "", "NOT-HEX", "0123ABCD"]) {
      const driven = driveHook(repo, text, "hatsu-agent", run);
      expect(driven.code, String(run)).toBe(0);
      expect(driven.message).toBe("feat: leaked\n\nHatsu-Agent: kurapika\n");
      expect(driven.stderr).toContain("but NEN_COMPOSED_TRAILER_KEYS was found without a nen run id (NEN_STRIP_RUN missing or malformed): it was exported or leaked rather than set by a nen verb, so no sidecar was written");
      expect(sidecars(repo)).toEqual([]);
    }
  });

  // J (zheref/nen#682's macOS runner): bash 3.2 as /bin/sh under en_US.UTF-8
  // read [!0-9a-f] as accepting 'A'-'E', so an upper-case run id passed as
  // well-formed. Every locale below must give the same answers as C.
  it.skipIf(!HAVE_SH)("(J) under a UTF-8 locale the run-id check, the case-folding and the trailer-block test answer exactly as under C", () => {
    const repo = repository(OPT_IN);
    const text = `feat: locale\n\nHatsu-Agent: kurapika\n${CURSOR}\n`;
    for (const locale of ["en_US.UTF-8", "C.UTF-8", "C"]) {
      for (const run of ["0123ABCD", "ABC", "abcdeF", "NOT-HEX", "0123abcg"]) {
        const leaked = driveHook(repo, text, "hatsu-agent", run, locale);
        expect(leaked.code, `${locale} ${run}`).toBe(0);
        expect(leaked.stderr, `${locale} ${run}`).toContain("was found without a nen run id");
        expect(sidecars(repo), `${locale} ${run}`).toEqual([]);
      }
      // A well-formed id records; an upper-case composed key still counts as composed (ASCII folding).
      const ok = driveHook(repo, text, "Hatsu-Agent", RUN_ID, locale);
      expect(ok.code, locale).toBe(0);
      expect(ok.message, locale).toBe("feat: locale\n\nHatsu-Agent: kurapika\n");
      expect(readFileSync(sidecar(repo), "utf8"), locale).toBe("Co-authored-by\n");
      rmSync(sidecar(repo), { force: true });
      const composed = driveHook(repo, text, "HATSU-AGENT,CO-AUTHORED-BY", RUN_ID, locale);
      expect(composed.code, locale).toBe(1);
      expect(composed.message, locale).toBe(text);
      // A trailer-block line with a non-ASCII key is not trailer-shaped under any locale: the paragraph is prose, nothing stripped.
      const prose = `feat: locale\n\nHatsu-Agent: kurapika\nÄrger: nicht-ascii\n${CURSOR}\n`;
      expect(driveHook(repo, prose, "hatsu-agent", RUN_ID, locale).message, locale).toBe(prose);
      expect(sidecars(repo), locale).toEqual([]);
    }
  });

  // L: a key refused ONLY by its -by/-with shape has no grep in the hook, and
  // below a scissors line it is no trailer to git's own parser either -- so the
  // read-back does not see it. Pinned, so the docs' sentence stays true.
  it("(L) a shape-only listed key BELOW a scissors line is neither stripped nor seen by the read-back: exit 0, the line kept as text", async () => {
    const repo = repository({ commits: { allowedAttributionTrailers: ADMITS, stripInjected: ["Made-with"] } });
    installRawHarness(repo, `printf '# ------------------------ >8 ------------------------\\nMade-with: Cursor\\n' >> "$1"`);
    const message = stage(repo, "l.txt", "feat: add l\n");
    const result = await run(commitCommand, ["commit", "write", "--message-file", message, "--trailer", "Hatsu-Agent: kurapika"], repo);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc["stripped"]).toEqual([]);
    expect(doc["injected"]).toEqual([]);
    expect(doc["trailers"]).toEqual([{ key: "Hatsu-Agent", value: "kurapika" }]);
    expect(headMessage(repo)).toContain(">8 ------------------------\nMade-with: Cursor");
    expect(sidecars(repo)).toEqual([]);
  });

  it("(f) a FOLDED (multi-line) injected trailer is removed whole: exit 4, no fragment left", async () => {
    const repo = repository(OPT_IN);
    installRawHarness(repo, `printf 'Co-authored-by: Cursor\\n  <cursoragent@cursor.com>\\n' >> "$1"`);
    const message = stage(repo, "f.txt", "feat: add f\n");
    const result = await run(commitCommand, ["commit", "write", "--message-file", message, "--trailer", "Hatsu-Agent: kurapika"], repo);
    expect(result.code).toBe(4);
    const written = headMessage(repo);
    expect(written).not.toMatch(/co-authored-by/i);
    expect(written).not.toContain("cursoragent");
    expect(written).toContain("Hatsu-Agent: kurapika");
    expect((JSON.parse(result.out.join("\n")) as Record<string, unknown>)["stripped"]).toEqual(["Co-authored-by"]);
  });

  it("(g) nen wc squash under the same harness: the fold lands without the key, exit 4, stripped reported", async () => {
    const repo = repository(OPT_IN, ["one", "two"]);
    installHarness(repo);
    const message = join(repo, ".git", "squash-msg.txt");
    writeFileSync(message, "feat: add one and two\n\nHatsu-Agent: kurapika\n");
    const result = await run(wcCommand, ["wc", "squash", "--onto", "main", "--message-file", message], repo);
    expect(result.code).toBe(4);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc["stripped"]).toEqual(["Co-authored-by"]);
    expect(doc["injected"]).toEqual([]);
    expect(Object.keys(doc).at(-1)).toBe("stripped");
    expect(doc["newSha"]).toBe(mustGit(repo, ["rev-parse", "HEAD"]));
    expect(mustGit(repo, ["rev-parse", "HEAD~1"])).toBe(mustGit(repo, ["rev-parse", "main"]));
    expect(headMessage(repo)).not.toMatch(/co-authored-by/i);
    expect(result.err.join("\n")).toMatch(/^nen wc: the written commit [0-9a-f]+ does not carry 'Co-authored-by'/m);
    expect(sidecars(repo)).toEqual([]);
  });
});

/** Run `drive` with no sidecar beforehand, so a case reads only what it wrote. */
function rmSidecarThen<T>(repo: string, drive: () => T): T {
  rmSync(sidecar(repo), { force: true });
  return drive();
}
