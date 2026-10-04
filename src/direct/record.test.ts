import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeEffortId, EFFORT_ID, usageLedgerPath } from "../usage/ledger.js";
import { recordPath } from "./record.js";

describe("the direct ledger and the usage ledger name an effort's file with one encoder", () => {
  const root = "/some/root";

  it("agree on the basename for an id in the usage alphabet", () => {
    for (const id of ["NN-IS-12", "a/b-1.2", "inline-2026-10-04T12-00-00Z"]) {
      expect(EFFORT_ID.test(id), id).toBe(true);
      expect(basename(recordPath(root, id)), id).toBe(basename(usageLedgerPath(root, id)));
    }
  });

  it("agree on the basename for an id only the direct ledger admits (the alphabets differ: '#' and ':')", () => {
    for (const id of ["NN-IS-#12", "inline-2026-10-04T12:00:00Z"]) {
      expect(EFFORT_ID.test(id), id).toBe(false);
      // the encoder is the shared part; the usage verb's own alphabet check is its own
      expect(basename(recordPath(root, id)), id).toBe(`${encodeEffortId(id)}.json`);
      expect(basename(usageLedgerPath(root, id)), id).toBe(`${encodeEffortId(id)}.json`);
    }
  });

  it("encodes a slash so the file never leaves the directory", () => {
    expect(encodeEffortId("a/b")).toBe("a%2Fb");
    expect(recordPath(root, "a/b")).toBe("/some/root/.nen/direct/a%2Fb.json");
  });
});
