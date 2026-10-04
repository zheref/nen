// src/shu/coverage/capture.test.ts -- the provenance rule, without a
// filesystem or a subprocess (zheref/nen#250).

import { describe, expect, it } from "vitest";
import {
  CAPTURE_CONTRACT,
  captureRefusal,
  excludedFromFingerprint,
  fingerprintOf,
  judgeCapture,
  parseSidecar,
  sidecarPath,
  type CaptureSidecar,
} from "./capture.js";

const SIDECAR: CaptureSidecar = {
  contract: CAPTURE_CONTRACT,
  lane: "web",
  verb: "coverage",
  head: "a".repeat(40),
  startedAt: "2026-10-04T00:00:00.000Z",
  fingerprint: "f1",
  artifacts: [
    { path: "coverage/lcov.info", sha256: "l1" },
    { path: "coverage/coverage-summary.json", sha256: "s1" },
  ],
};

const NOW = {
  lane: "web",
  head: "a".repeat(40),
  fingerprint: "f1",
  artifacts: [
    { path: "coverage/lcov.info", sha256: "l1" },
    { path: "coverage/coverage-summary.json", sha256: "s1" },
  ],
};

describe("judgeCapture", () => {
  it("proves a capture whose fingerprint, lane and every report hash match", () => {
    expect(judgeCapture(SIDECAR, NOW)).toEqual([]);
  });

  it("refuses when ONE of two reports changed, naming that one only", () => {
    const now = { ...NOW, artifacts: [NOW.artifacts[0]!, { path: "coverage/coverage-summary.json", sha256: "s2" }] };
    expect(judgeCapture(SIDECAR, now)).toEqual([{ reason: "artifact-changed", path: "coverage/coverage-summary.json" }]);
  });

  it("refuses a missing report, a different tree, a different lane and a changed declaration together", () => {
    const problems = judgeCapture(SIDECAR, {
      lane: "app",
      head: "b".repeat(40),
      fingerprint: "f2",
      artifacts: [{ path: "coverage/lcov.info", sha256: null }],
    });
    expect(problems.map((problem): string => problem.reason)).toEqual(["lane", "artifacts", "tree", "artifact-missing"]);
  });
});

describe("fingerprintOf", () => {
  const base = { head: "h", diff: "d", untracked: [{ path: "x", sha256: "1" }] };
  it("is stable under the untracked list's order", () => {
    expect(fingerprintOf({ ...base, untracked: [{ path: "y", sha256: "2" }, ...base.untracked] })).toBe(
      fingerprintOf({ ...base, untracked: [...base.untracked, { path: "y", sha256: "2" }] }),
    );
  });
  it("moves with HEAD, the diff, an untracked path and an untracked file's content", () => {
    const at = fingerprintOf(base);
    expect(fingerprintOf({ ...base, head: "h2" })).not.toBe(at);
    expect(fingerprintOf({ ...base, diff: "d2" })).not.toBe(at);
    expect(fingerprintOf({ ...base, untracked: [{ path: "z", sha256: "1" }] })).not.toBe(at);
    expect(fingerprintOf({ ...base, untracked: [{ path: "x", sha256: "9" }] })).not.toBe(at);
  });
  it("cannot be forged across a field boundary", () => {
    expect(fingerprintOf({ head: "ab", diff: "c", untracked: [] })).not.toBe(
      fingerprintOf({ head: "a", diff: "bc", untracked: [] }),
    );
  });
});

describe("the sidecar", () => {
  it("lives under .nen/coverage-capture, one file per lane, the name encoded", () => {
    expect(sidecarPath("web")).toBe(".nen/coverage-capture/web.json");
    expect(sidecarPath("a/b")).toBe(".nen/coverage-capture/a%2Fb.json");
  });
  it("leaves the reports and the sidecar directory out of the fingerprint, nothing else", () => {
    expect(excludedFromFingerprint("coverage/lcov.info", ["coverage/lcov.info"])).toBe(true);
    expect(excludedFromFingerprint(".nen/coverage-capture/web.json", [])).toBe(true);
    expect(excludedFromFingerprint(".nen/coverage-captured", [])).toBe(false);
    expect(excludedFromFingerprint("src/a.ts", ["coverage/lcov.info"])).toBe(false);
  });
  it("reads back what was written, and refuses anything else by reason", () => {
    expect(parseSidecar(JSON.stringify(SIDECAR))).toEqual(SIDECAR);
    expect(parseSidecar("{")).toBe("it is not JSON");
    expect(parseSidecar("[]")).toBe("it is not an object");
    expect(parseSidecar(JSON.stringify({ ...SIDECAR, contract: "x" }))).toMatch(/contract/);
    expect(parseSidecar(JSON.stringify({ ...SIDECAR, head: 1 }))).toMatch(/'head'/);
    expect(parseSidecar(JSON.stringify({ ...SIDECAR, artifacts: [{ path: "x" }] }))).toMatch(/artifacts/);
  });
});

describe("captureRefusal", () => {
  it("names every reason and the way out", () => {
    const said = captureRefusal([
      { reason: "no-sidecar", sidecar: ".nen/coverage-capture/web.json" },
      { reason: "tree", recordedHead: "a".repeat(40), head: "b".repeat(40) },
      { reason: "tree", recordedHead: "a".repeat(40), head: "a".repeat(40) },
      { reason: "artifact-changed", path: "c.json" },
      { reason: "artifact-missing", path: "l.info" },
      { reason: "lane", recorded: "a", lane: "b" },
      { reason: "artifacts", recorded: ["x"], declared: ["y"] },
      { reason: "unreadable-sidecar", sidecar: "s", why: "it is not JSON" },
    ]);
    expect(said).toContain("no provenance sidecar at '.nen/coverage-capture/web.json'");
    expect(said).toContain("refused by design");
    expect(said).toContain("HEAD was aaaaaaaaaaaa and is now bbbbbbbbbbbb");
    expect(said).toContain("HEAD is the same");
    expect(said).toContain("'c.json' is not the file the run recorded");
    expect(said).toContain("'l.info' is not on disk");
    expect(said).toContain("records lane 'a', not 'b'");
    expect(said).toContain("[x] and the lane now declares [y]");
    expect(said).toContain("cannot be read: it is not JSON");
    expect(said).toContain("without --from-capture");
  });
});
