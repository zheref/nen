import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { localEffortHome } from "../ledger/home.js";
import { encodeEffortId, EFFORT_ID, usageLedgerPath } from "../usage/ledger.js";
import { recordPath } from "./record.js";

describe("the direct ledger and the usage ledger share one grammar and one encoder (zheref/nen#509)", () => {
  const root = "/some/root";
  const home = localEffortHome(root, "direct");

  it("agree on the basename for every id the one grammar admits, '#' and ':' included", () => {
    for (const id of ["NN-IS-12", "a/b-1.2", "inline-2026-10-04T12-00-00Z", "NN-IS-#12", "inline-2026-10-04T12:00:00Z"]) {
      expect(EFFORT_ID.test(id), id).toBe(true);
      expect(basename(recordPath(home, id)), id).toBe(basename(usageLedgerPath(root, id)));
      expect(basename(recordPath(home, id)), id).toBe(`${encodeEffortId(id)}.json`);
    }
  });

  it.each(["HA 12", ".x", "a\\b", "../x", "a/../b", "", "/abs"])("refuses %j as the usage ledger does", (id) => {
    expect(() => recordPath(home, id)).toThrow(/is refused/);
  });

  it("encodes a slash so the file never leaves the directory", () => {
    expect(encodeEffortId("a/b")).toBe("a%2Fb");
    // The host spells the root (C:\some\root on Windows), so the expectation is built the same way.
    expect(recordPath(home, "a/b")).toBe(resolve(root, ".nen", "direct", "a%2Fb.json"));
  });
});
