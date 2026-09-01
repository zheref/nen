import { describe, expect, it } from "vitest";
import { rawLines } from "./lines.js";

describe("rawLines -- unlike outputLines, never trims", () => {
  it("splits on \\n, drops empty lines, keeps leading/trailing spaces intact", () => {
    expect(rawLines(" M file.txt\n?? other.txt\n\n")).toEqual([" M file.txt", "?? other.txt"]);
  });

  it("normalizes CRLF the same way outputLines does", () => {
    expect(rawLines(" M a.txt\r\n?? b.txt\r\n")).toEqual([" M a.txt", "?? b.txt"]);
  });

  it("returns an empty array for empty input", () => {
    expect(rawLines("")).toEqual([]);
  });
});
