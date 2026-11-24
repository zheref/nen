// src/commit/strip.test.ts -- the nen half of commits.stripInjected
// (zheref/nen#594): the environment, the sidecar's lifecycle, the cross-check
// and the exit precedence, with no git in them.

import { describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../testing/tempdir.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { HOOK_COMPOSED_KEYS_ENV, STRIP_SIDECAR_FILE } from "../scaffold/hook.js";
import { parseWorkflow, type LoadedWorkflow } from "../schema/workflow.js";
import {
  collectStripSidecar,
  COMPOSED_KEYS_ENV,
  composedKeysEnv,
  confirmStripped,
  discardStripSidecar,
  prepareStripSidecar,
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
  });
});

describe("composedKeysEnv", () => {
  it("lower-cases and comma-joins the composed keys, first-seen unique, and is SET even when empty", () => {
    expect(composedKeysEnv([{ key: "Hatsu-Agent", value: "k" }, { key: "Closes", value: "#1" }, { key: "closes", value: "#2" }])).toEqual({
      NEN_COMPOSED_TRAILER_KEYS: "hatsu-agent,closes",
    });
    expect(composedKeysEnv([])).toEqual({ NEN_COMPOSED_TRAILER_KEYS: "" });
  });
});

describe("the sidecar's lifecycle", () => {
  it("prepare resolves a RELATIVE git dir against the root and deletes a stale file", () => {
    const root = makeTempDir("nen-strip-");
    const seams = new ScriptedSeams([{ match: "git rev-parse --git-dir", result: { stdout: "gitdir\n" } }]);
    const path = prepareStripSidecar(seams, root);
    expect(path).toBe(join(root, "gitdir", STRIP_SIDECAR));
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

describe("stripFailureHint", () => {
  it("is empty with no policy, an absent policy, or an empty list", () => {
    expect(stripFailureHint(null)).toBe("");
    expect(stripFailureHint({ ...loaded({}), present: false })).toBe("");
    expect(stripFailureHint(loaded({ commits: { stripInjected: [] } }))).toBe("");
  });

  it("names the list and the regeneration when the list is non-empty", () => {
    const hint = stripFailureHint(loaded({ commits: { stripInjected: ["Co-authored-by"] } }));
    expect(hint).toMatch(/^ \/r\/nen\/workflow\.json lists commits\.stripInjected \('Co-authored-by'\)/);
    expect(hint).toContain("nen scaffold init ... --force");
  });
});
