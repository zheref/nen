import { describe, expect, it } from "vitest";
import { describeValue, rowLabel } from "./shape.js";

describe("describeValue", () => {
  it("names a missing field distinctly from an explicit null", () => {
    expect(describeValue(undefined)).toBe("nothing (the field is missing)");
    expect(describeValue(null)).toBe("null");
  });

  it("names an array as 'an array', never conflating it with a plain object", () => {
    expect(describeValue([1, 2])).toBe("an array");
  });

  it("quotes a string value", () => {
    expect(describeValue("XY-IS-#1")).toBe("the string 'XY-IS-#1'");
  });

  it("names a plain object 'an object' -- the one typeof that starts with a vowel", () => {
    expect(describeValue({ a: 1 })).toBe("an object");
  });

  it("falls back to 'a <typeof>' for numbers and booleans", () => {
    expect(describeValue(5)).toBe("a number");
    expect(describeValue(true)).toBe("a boolean");
  });
});

describe("rowLabel", () => {
  it("names the row by its own id when it is a usable string", () => {
    expect(rowLabel({ id: "XY-IS-#1" }, 3)).toBe("row 'XY-IS-#1'");
  });

  it("falls back to the index when id is missing, empty, or not a string", () => {
    expect(rowLabel({}, 0)).toBe("row at index 0");
    expect(rowLabel({ id: "" }, 1)).toBe("row at index 1");
    expect(rowLabel({ id: 42 }, 2)).toBe("row at index 2");
  });
});
