import { describe, expect, it } from "vitest";
import { conjoin } from "./prose.js";

// The behaviour two families' refusals now depend on (../issue/command.ts's
// foreign-flag guard and ../issue/subissue.ts's object-class refusal), pinned
// where it lives rather than only through each caller's message assertions.
describe("conjoin -- a real conjunction, not a join(' and ')", () => {
  it("renders nothing for an empty list", () => {
    expect(conjoin([])).toBe("");
  });

  it("renders one item as itself, with no conjunction", () => {
    expect(conjoin(["a"])).toBe("a");
  });

  it("joins two items with 'and' and no comma", () => {
    expect(conjoin(["a", "b"])).toBe("a and b");
  });

  it("commas the head and conjoins the tail", () => {
    expect(conjoin(["a", "b", "c"])).toBe("a, b and c");
    expect(conjoin(["a", "b", "c", "d"])).toBe("a, b, c and d");
  });
});
