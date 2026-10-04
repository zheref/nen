// src/shu/capture-provenance.test.ts -- the fingerprint's refusals and the
// argv it sends, against a scripted seam (zheref/nen#250, hanten round 2).
// ./coverage-capture.integration.test.ts proves the same against a real git;
// this file pins the cases a host's filesystem may not let that one create.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { takeFingerprint } from "./capture-provenance.js";
import { CAPTURE_LIMITS } from "./coverage/capture.js";
import { shuCommand } from "./command.js";

const HEAD: ScriptedCall = { match: "git rev-parse --verify --quiet HEAD^{commit}", result: { code: 0, stdout: `${"a".repeat(40)}\n` } };
const DIFF =
  "git -c core.quotePath=false diff HEAD --binary --no-color --no-ext-diff --no-textconv --submodule=diff --ignore-submodules=none -- . :(exclude,literal)coverage/lcov.info :(exclude,literal).nen/coverage-capture";
const OTHERS = "git -c core.quotePath=false ls-files -z --others --exclude-standard";
const TAGGED = "git -c core.quotePath=false ls-files -v -z";

function seams(others: string, tagged = "", extra: readonly ScriptedCall[] = []): ScriptedSeams {
  return new ScriptedSeams([
    HEAD,
    { match: DIFF, result: { code: 0, stdout: "" } },
    { match: OTHERS, result: { code: 0, stdout: others } },
    { match: TAGGED, result: { code: 0, stdout: tagged } },
    ...extra,
  ]);
}

describe("takeFingerprint", () => {
  it("refuses a path whose RAW bytes are not UTF-8 -- never a marker standing in for it", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-fp-"));
    try {
      const bytes = new Uint8Array([...new TextEncoder().encode("src/x"), 0xff, ...new TextEncoder().encode(".ts"), 0]);
      const result = takeFingerprint(
        new ScriptedSeams([
          HEAD,
          { match: DIFF, result: { code: 0, stdout: "" } },
          { match: OTHERS, result: { code: 0, stdoutBytes: bytes } },
          { match: TAGGED, result: { code: 0, stdout: "" } },
        ]),
        dir,
        ["coverage/lcov.info"],
      );
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.why).toMatch(/'src\/x\uFFFD\.ts' is not valid UTF-8/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("RECORDS a real filename that contains U+FFFD -- only undecodable bytes refuse (Copilot round 2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-fp-"));
    try {
      writeFileSync(join(dir, "x\uFFFD.ts"), "1");
      const result = takeFingerprint(seams("x\uFFFD.ts\0"), dir, ["coverage/lcov.info"]);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries git's spawn failure as an operational error, never only a sentence", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-fp-"));
    try {
      const result = takeFingerprint(
        new ScriptedSeams([{ match: HEAD.match, result: { code: -1, spawnFailed: true, stderr: "ENOENT" } }]),
        dir,
        [],
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error !== undefined).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an untracked file it cannot read, naming it", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-fp-"));
    try {
      const result = takeFingerprint(seams("gone.ts\0"), dir, ["coverage/lcov.info"]);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.why).toMatch(/untracked file 'gone\.ts' could not be read \(ENOENT\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("folds in assume-unchanged (h) and skip-worktree (S) files by hash-object --no-filters, and moves when one changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-fp-"));
    try {
      writeFileSync(join(dir, "b.ts"), "1");
      const tagged = "H a.ts\0h b.ts\0S gone.ts\0";
      const hash = (object: string): ScriptedCall => ({
        match: "git -c core.quotePath=false hash-object --no-filters -- b.ts",
        result: { code: 0, stdout: `${object}\n` },
      });
      const first = takeFingerprint(seams("", tagged, [hash("1".repeat(40))]), dir, ["coverage/lcov.info"]);
      const same = takeFingerprint(seams("", tagged, [hash("1".repeat(40))]), dir, ["coverage/lcov.info"]);
      const moved = takeFingerprint(seams("", tagged, [hash("2".repeat(40))]), dir, ["coverage/lcov.info"]);
      expect(first.ok && same.ok && moved.ok).toBe(true);
      if (!first.ok || !same.ok || !moved.ok) return;
      expect(same.fingerprint).toBe(first.fingerprint);
      expect(moved.fingerprint).not.toBe(first.fingerprint);
      // An ordinary 'H' file is git diff's business and is never hashed here.
      const plain = takeFingerprint(seams("", "H a.ts\0"), dir, ["coverage/lcov.info"]);
      expect(plain.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the stated limits", () => {
  it("are the SAME sentence in --help and in docs/USAGE.md", () => {
    const flat = (text: string): string => text.replace(/\s+/g, " ");
    expect(flat(shuCommand.usage)).toContain(CAPTURE_LIMITS);
    const docs = readFileSync(join(__dirname, "..", "..", "docs", "USAGE.md"), "utf8");
    expect(flat(docs)).toContain(CAPTURE_LIMITS);
  });
});
