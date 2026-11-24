// src/commit/strip.test.ts -- the nen half of commits.stripInjected
// (zheref/nen#594): the environment, the sidecar's lifecycle, the cross-check
// and the exit precedence, with no git in them.

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../testing/tempdir.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { HOOK_COMPOSED_KEYS_ENV, HOOK_STRIP_RUN_ENV, STRIP_SIDECAR_FILE } from "../scaffold/hook.js";
import { parseWorkflow, type LoadedWorkflow } from "../schema/workflow.js";
import {
  collectStripSidecar,
  COMPOSED_KEYS_ENV,
  composedKeysEnv,
  confirmStripped,
  discardStripSidecar,
  newStripRunId,
  prepareStripSidecar,
  STRIP_RUN_ENV,
  STRIP_SIDECAR,
  stripFailureHint,
  STRIPPED_EXIT,
  writtenExit,
} from "./strip.js";

function loaded(document: unknown): LoadedWorkflow {
  return { present: true, path: "/r/nen/workflow.json", location: "nen", workflow: parseWorkflow("/r/nen/workflow.json", document), raw: {} };
}

describe("the names the hook and the verbs share", () => {
  it("are ONE name each, the hook's", () => {
    expect(COMPOSED_KEYS_ENV).toBe(HOOK_COMPOSED_KEYS_ENV);
    expect(COMPOSED_KEYS_ENV).toBe("NEN_COMPOSED_TRAILER_KEYS");
    expect(STRIP_SIDECAR).toBe(STRIP_SIDECAR_FILE);
    expect(STRIP_RUN_ENV).toBe(HOOK_STRIP_RUN_ENV);
    expect(STRIP_RUN_ENV).toBe("NEN_STRIP_RUN");
  });
});

const RUN = { runId: "abc123", path: "/unused" };

describe("composedKeysEnv", () => {
  it("lower-cases and comma-joins the composed keys, first-seen unique, and is SET even when empty", () => {
    expect(composedKeysEnv([{ key: "Hatsu-Agent", value: "k" }, { key: "Closes", value: "#1" }, { key: "closes", value: "#2" }], RUN)).toEqual({
      NEN_COMPOSED_TRAILER_KEYS: "hatsu-agent,closes",
      NEN_STRIP_RUN: "abc123",
    });
    expect(composedKeysEnv([], RUN)).toEqual({ NEN_COMPOSED_TRAILER_KEYS: "", NEN_STRIP_RUN: "abc123" });
  });
});

describe("the sidecar's lifecycle", () => {
  it("prepare draws a hex run id and resolves a RELATIVE git dir against the root, naming the run's own file", () => {
    const root = makeTempDir("nen-strip-");
    const seams = new ScriptedSeams([{ match: "git rev-parse --git-dir", result: { stdout: "gitdir\n" } }]);
    const run = prepareStripSidecar(seams, root);
    expect(run.runId).toMatch(/^[0-9a-f]{16}$/);
    expect(run.path).toBe(join(root, "gitdir", `${STRIP_SIDECAR}.${run.runId}`));
    expect(newStripRunId()).not.toBe(newStripRunId());
  });

  it("refuses a run id the hook would not accept", () => {
    const seams = new ScriptedSeams([]);
    expect((): unknown => prepareStripSidecar(seams, "/r", "ABC")).toThrow(/lower-case hex/);
    expect((): unknown => prepareStripSidecar(seams, "/r", "")).toThrow(/lower-case hex/);
  });

  it("two INTERLEAVED runs in one git dir never see each other's sidecar (hanten round 1, E)", () => {
    const root = makeTempDir("nen-strip-");
    const gitDir = join(root, ".git");
    mkdirSync(gitDir);
    const answer = { match: "git rev-parse --git-dir", result: { stdout: ".git\n" } };
    const first = prepareStripSidecar(new ScriptedSeams([answer]), root, "aaaa");
    const second = prepareStripSidecar(new ScriptedSeams([answer]), root, "bbbb");
    // The hook, inside the FIRST run's commit, records under the first run's id only.
    writeFileSync(join(gitDir, `${STRIP_SIDECAR}.aaaa`), "Co-authored-by\n");
    expect(collectStripSidecar(second.path)).toEqual([]);
    expect(existsSync(first.path)).toBe(true);
    // And preparing a THIRD run does not sweep the first run's file out from under it.
    prepareStripSidecar(new ScriptedSeams([answer]), root, "cccc");
    expect(collectStripSidecar(first.path)).toEqual(["Co-authored-by"]);
    expect(existsSync(first.path)).toBe(false);
  });

  it("prepare throws, naming git's reason, when the git dir cannot be resolved", () => {
    const seams = new ScriptedSeams([{ match: "git rev-parse --git-dir", result: { code: 128, stderr: "fatal: nope" } }]);
    expect((): unknown => prepareStripSidecar(seams, "/r")).toThrow(/could not resolve the git dir.*fatal: nope/);
  });

  it("collect reads every key once (case-insensitively), ignores blank lines, and deletes the file", () => {
    const dir = makeTempDir("nen-strip-");
    const path = join(dir, STRIP_SIDECAR);
    writeFileSync(path, "Co-authored-by\r\n\nco-authored-by\nMade-with\n");
    expect(collectStripSidecar(path)).toEqual(["Co-authored-by", "Made-with"]);
    expect(existsSync(path)).toBe(false);
    expect(collectStripSidecar(path)).toEqual([]);
  });

  it("discard removes it, and tolerates null and an absent file", () => {
    const dir = makeTempDir("nen-strip-");
    const path = join(dir, STRIP_SIDECAR);
    writeFileSync(path, "x\n");
    discardStripSidecar(path);
    expect(existsSync(path)).toBe(false);
    expect((): void => discardStripSidecar(path)).not.toThrow();
    expect((): void => discardStripSidecar(null)).not.toThrow();
  });
});

describe("confirmStripped -- only a key the written commit really lacks", () => {
  it("drops a reported key the commit still carries, in any case", () => {
    expect(confirmStripped(["Co-authored-by", "Made-with"], [{ key: "made-with", value: "Cursor" }])).toEqual(["Co-authored-by"]);
    expect(confirmStripped([], [])).toEqual([]);
  });
});

describe("writtenExit -- 3 wins over 4, 4 over 0", () => {
  it.each([
    [0, 0, 0],
    [0, 1, STRIPPED_EXIT],
    [1, 0, 3],
    [2, 3, 3],
  ])("injected %i, stripped %i -> exit %i", (injected, stripped, exit) => {
    expect(writtenExit(injected, stripped)).toBe(exit);
  });
});

describe("stripFailureHint -- only for the hook's refusal of a LISTED key (hanten round 1, B)", () => {
  const REFUSED = "commit-msg: this message carries a 'Co-Authored-By:' trailer, which this repository's nen/workflow.json does not list under commits.allowedAttributionTrailers.";

  it("is empty with no policy, an absent policy, or an empty list, whatever git said", () => {
    expect(stripFailureHint(null, REFUSED)).toBe("");
    expect(stripFailureHint({ ...loaded({}), present: false }, REFUSED)).toBe("");
    expect(stripFailureHint(loaded({ commits: { stripInjected: [] } }), REFUSED)).toBe("");
  });

  it("names the key and the regeneration, as a POSSIBILITY, when the hook refused a listed key (any case)", () => {
    const hint = stripFailureHint(loaded({ commits: { stripInjected: ["Co-authored-by"] } }), REFUSED);
    expect(hint).toMatch(/^ The commit-msg hook refused 'Co-authored-by', which \/r\/nen\/workflow\.json lists under commits\.stripInjected: the hook may predate commits\.stripInjected; regenerate it with 'nen scaffold init \.\.\. --force'/);
  });

  it("is empty when the commit failed for another reason, or the hook refused a key the list does not name", () => {
    const policy = loaded({ commits: { stripInjected: ["Co-authored-by"] } });
    expect(stripFailureHint(policy, "pre-commit: refusing a commit on 'main'")).toBe("");
    expect(stripFailureHint(policy, "commit-msg: this message carries a 'Claude-Session:' trailer, which ...")).toBe("");
    expect(stripFailureHint(policy, "")).toBe("");
  });
});
