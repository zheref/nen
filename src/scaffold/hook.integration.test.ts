// src/scaffold/hook.integration.test.ts -- the two generated git hooks, RUN,
// by a real `git commit` in a real temporary repository.
//
// WHY THIS EXISTS BESIDE ./hook.test.ts. That suite proves the renderer emits
// the script its author meant to emit, which is the half a string assertion can
// prove. It cannot prove the script MEANS what its author thought -- and the
// defect that produced this file is exactly that gap: an over-escaped `\$` in
// the TypeScript template emitted `"\$msg_file"`, which a shell reads as the
// literal filename `$msg_file`. Every `grep` failed with "No such file or
// directory", every `if` was therefore false, and the attribution guard
// silently refused NOTHING while `git commit` reported success. Every string
// assertion in ./hook.test.ts passed: the pattern was right, the message was
// right, the order was right, and the hook did nothing.
//
// That is the worst available failure for a guard -- it does not fail loudly,
// it stops being a guard -- and only running it can see it. So both hooks are
// generated, installed and driven by a real commit here: the refusal fires, the
// case-insensitive spelling fires, the allow-list lets its key through, the
// trunk guard refuses on the trunk and lets a branch through, and a detached
// HEAD is not mistaken for the trunk.
//
// IT SKIPS RATHER THAN FAILS WHERE `git` IS NOT ON PATH, and where the platform
// does not run a POSIX `sh` hook -- ../shu/warmup.integration.test.ts's own
// rule: a machine without git is not a machine this rule was broken on. The
// skip is loud in the reporter rather than silent.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCommitMsgHook, renderPreCommitHook, type HookSpec } from "./hook.js";

const SPEC: HookSpec = { agentTrailer: "X-Agent", runTrailer: "X-Run", markerEnvVar: "X_AUTOMATED" };

/** The identity every commit below is made with. Nobody's, and never read back. */
const WHO = [
  "-c",
  "user.name=nen test",
  "-c",
  "user.email=nen@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const HAVE_GIT = gitAvailable();

interface Run {
  readonly status: number;
  readonly stderr: string;
}

function git(cwd: string, args: readonly string[]): Run {
  const result = spawnSync("git", [...WHO, ...args], { cwd, encoding: "utf8" });
  return { status: result.status ?? -1, stderr: `${result.stderr ?? ""}${result.stdout ?? ""}` };
}

/**
 * A repository with both generated hooks installed and one commit on the trunk.
 *
 * THE FIRST COMMIT IS MADE WITH `--no-verify`, deliberately: the trunk guard is
 * about to refuse every commit on this branch, and a fixture that cannot get
 * its first commit in cannot test anything. That is the one place this file
 * bypasses a hook, and it is the setup rather than a case.
 */
function repoWith(refusedTrailers: readonly string[], base = "main"): string {
  const root = mkdtempSync(join(tmpdir(), "nen-hook-int-"));
  expect(git(root, ["init", "-q", "-b", base]).status).toBe(0);
  const hooks = join(root, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const [name, body] of [
    ["commit-msg", renderCommitMsgHook(SPEC, refusedTrailers)],
    ["pre-commit", renderPreCommitHook(base)],
  ] as const) {
    const path = join(hooks, name);
    writeFileSync(path, body, "utf8");
    chmodSync(path, 0o755);
  }
  expect(git(root, ["commit", "-q", "--no-verify", "--allow-empty", "-m", "chore: init"]).status).toBe(0);
  return root;
}

/** Commit on a fresh branch, so the trunk guard is not the thing under test. */
function commitOffTrunk(root: string, branch: string, message: string): Run {
  expect(git(root, ["switch", "-q", "-c", branch]).status).toBe(0);
  return git(root, ["commit", "--allow-empty", "-m", message]);
}

describe.skipIf(!HAVE_GIT)("the generated commit-msg hook, run by a real git commit", () => {
  it("REFUSES a refused attribution trailer -- the guard actually fires", () => {
    // The regression this file exists for: every string assertion passed while
    // this commit succeeded.
    const root = repoWith(["Co-Authored-By"]);
    const result = commitOffTrunk(root, "work", "feat: a thing\n\nCo-Authored-By: A <a@b>");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Co-Authored-By");
    expect(result.stderr).toContain("commits.allowedAttributionTrailers");
    // ...and never because the script could not find the message file.
    expect(result.stderr).not.toContain("No such file or directory");
  });

  it("refuses it in ANY case, because every reader of the commit ignores case", () => {
    const root = repoWith(["Co-Authored-By"]);
    const result = commitOffTrunk(root, "work", "feat: a thing\n\nco-authored-by: A <a@b>");
    expect(result.status).not.toBe(0);
  });

  it("lets a message with no such trailer through", () => {
    const root = repoWith(["Co-Authored-By"]);
    expect(commitOffTrunk(root, "work", "feat: a thing").status).toBe(0);
  });

  it("lets an ordinary trailer through -- 'Closes' is not attribution-shaped", () => {
    const root = repoWith(["Co-Authored-By"]);
    expect(commitOffTrunk(root, "work", "feat: a thing\n\nCloses: #4").status).toBe(0);
  });

  it("refuses on a HUMAN commit too: the marker env var gates the PAIR, not this", () => {
    // A trailer nobody wants in the history is unwanted whoever typed it, and a
    // guard that only fires when a marker is set is one any agent evades by not
    // setting it. Nothing below sets X_AUTOMATED.
    const root = repoWith(["Claude-Session"]);
    expect(commitOffTrunk(root, "work", "chore: x\n\nClaude-Session: 1").status).not.toBe(0);
  });

  it("still enforces the trailer PAIR only on an automated commit", () => {
    const root = repoWith([]);
    expect(commitOffTrunk(root, "work", "feat: no trailers at all").status).toBe(0);
    const automated = spawnSync("git", [...WHO, "commit", "--allow-empty", "-m", "feat: automated"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, X_AUTOMATED: "1" },
    });
    expect(automated.status).not.toBe(0);
    expect(`${automated.stderr ?? ""}`).toContain("X-Agent");
  });

  it("refuses nothing at all when the policy admits everything", () => {
    const root = repoWith([]);
    expect(commitOffTrunk(root, "work", "feat: a thing\n\nCo-Authored-By: A <a@b>").status).toBe(0);
  });
});

describe.skipIf(!HAVE_GIT)("the generated pre-commit hook, run by a real git commit", () => {
  it("REFUSES a commit made on the trunk it was generated for", () => {
    const root = repoWith([]);
    const result = git(root, ["commit", "--allow-empty", "-m", "feat: on the trunk"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing a commit on 'main'");
    expect(result.stderr).toContain("git switch -c");
  });

  it("lets a commit on any other branch through", () => {
    const root = repoWith([]);
    expect(commitOffTrunk(root, "work", "feat: off the trunk").status).toBe(0);
  });

  it("names the trunk the POLICY states, not one baked in", () => {
    const root = repoWith([], "trunk");
    const result = git(root, ["commit", "--allow-empty", "-m", "feat: on the trunk"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing a commit on 'trunk'");
  });

  it("lets a DETACHED HEAD through: an empty branch name is not the trunk", () => {
    // A rebase, a bisect or a `git commit` inside a detached checkout reports
    // no branch at all, and refusing those would make this hook the reason a
    // rebase cannot finish.
    const root = repoWith([]);
    expect(git(root, ["checkout", "-q", "--detach", "HEAD"]).status).toBe(0);
    expect(git(root, ["commit", "--allow-empty", "-m", "feat: detached"]).status).toBe(0);
  });
});
