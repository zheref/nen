import { describe, expect, it } from "vitest";
import { commaList } from "./comma.js";

describe("commaList", () => {
  it("splits, trims, and drops empty entries", () => {
    expect(commaList("a, b ,,c")).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array for undefined", () => {
    expect(commaList(undefined)).toEqual([]);
  });
});
