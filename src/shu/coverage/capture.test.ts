// src/shu/coverage/capture.test.ts -- the "is this capture current?" rule,
// without a filesystem (zheref/nen#250).

import { describe, expect, it } from "vitest";
import { captureRefusal, judgeCapture } from "./capture.js";

describe("judgeCapture", () => {
  it("is current when written at or after every watched file", () => {
    expect(
      judgeCapture(
        [{ path: "c.json", mtimeMs: 100 }],
        [
          { path: "a.ts", mtimeMs: 50 },
          { path: "b.ts", mtimeMs: 100 },
        ],
      ),
    ).toEqual([]);
  });

  it("names every file written after the capture, in order", () => {
    expect(
      judgeCapture(
        [{ path: "c.json", mtimeMs: 100 }],
        [
          { path: "a.ts", mtimeMs: 101 },
          { path: "b.ts", mtimeMs: 99 },
          { path: "d.ts", mtimeMs: 200 },
        ],
      ),
    ).toEqual([{ path: "c.json", reason: "stale", newer: ["a.ts", "d.ts"] }]);
  });

  it("judges EVERY declared report, and a missing one is its own reason", () => {
    expect(
      judgeCapture(
        [
          { path: "one.json", mtimeMs: 100 },
          { path: "two.info", mtimeMs: null },
        ],
        [{ path: "a.ts", mtimeMs: 10 }],
      ),
    ).toEqual([{ path: "two.info", reason: "missing" }]);
  });

  it("with nothing to compare, an existing capture is current", () => {
    expect(judgeCapture([{ path: "c.json", mtimeMs: 1 }], [])).toEqual([]);
  });
});

describe("captureRefusal", () => {
  it("names each report, caps the newer list at three, and says the way out", () => {
    const said = captureRefusal(
      [
        { path: "c.json", reason: "stale", newer: ["a", "b", "c", "d", "e"] },
        { path: "l.info", reason: "missing" },
      ],
      7,
    );
    expect(said).toContain("'c.json' is STALE -- written before 5 of the 7 files");
    expect(said).toContain("'a', 'b', 'c' and 2 more");
    expect(said).toContain("'l.info' is not on disk");
    expect(said).toContain("without --from-capture");
  });

  it("speaks in the singular for one file", () => {
    expect(captureRefusal([{ path: "c.json", reason: "stale", newer: ["a"] }], 1)).toContain("of the 1 file it");
  });
});
