import { describe, expect, it } from "vitest";
import { changedLines } from "./linediff.js";

describe("complete line diff for a security bound", () => {
  it("keeps both sides, their line numbers and whitespace, without treating context as a change", () => {
    expect(changedLines("context\nold \nend\n", "context\nnew\t\nend\n")).toEqual([
      { side: "removed", line: 2, text: "old " },
      { side: "added", line: 2, text: "new\t" },
    ]);
  });

  it("does not normalize CRLF, an empty line, or a missing final newline", () => {
    expect(changedLines("a\r\n\n", "a\n")).toEqual([
      { side: "removed", line: 1, text: "a\r" },
      { side: "removed", line: 2, text: "" },
      { side: "added", line: 1, text: "a" },
    ]);
    expect(changedLines("a\n", "a")).toEqual([
      { side: "removed", line: 1, text: "a" },
      { side: "added", line: 1, text: "a" },
    ]);
  });

  it("refuses excessive files and expensive rewrites instead of returning a partial diff", () => {
    expect(changedLines("a\n".repeat(100_001), "")).toBeNull();
    expect(changedLines("a\n".repeat(1500), "b\n".repeat(1500))).toBeNull();
  });

  it("agrees with an independent LCS oracle on repeated lines, insertions, deletions and moves", () => {
    const words: string[][] = [[]];
    for (let length = 1; length <= 4; length++) {
      for (let mask = 0; mask < 2 ** length; mask++) words.push(Array.from({ length }, (_, index): string => (mask & (1 << index)) === 0 ? "a" : "b"));
    }
    for (const base of words) for (const head of words) {
      const lcs: number[][] = Array.from({ length: base.length + 1 }, (): number[] => Array<number>(head.length + 1).fill(0));
      for (let x = 1; x <= base.length; x++) for (let y = 1; y <= head.length; y++) {
        (lcs[x] as number[])[y] = base[x - 1] === head[y - 1]
          ? (lcs[x - 1]?.[y - 1] ?? 0) + 1
          : Math.max(lcs[x - 1]?.[y] ?? 0, lcs[x]?.[y - 1] ?? 0);
      }
      const diff = changedLines(base.map((line): string => line + "\n").join(""), head.map((line): string => line + "\n").join(""));
      expect(diff).not.toBeNull();
      expect(diff?.length).toBe(base.length + head.length - 2 * (lcs[base.length]?.[head.length] ?? 0));
      const removed = new Set(diff?.filter((line): boolean => line.side === "removed").map((line): number => line.line));
      const added = new Set(diff?.filter((line): boolean => line.side === "added").map((line): number => line.line));
      expect(base.filter((_, index): boolean => !removed.has(index + 1))).toEqual(head.filter((_, index): boolean => !added.has(index + 1)));
      for (const line of diff ?? []) expect(line.text).toBe((line.side === "removed" ? base : head)[line.line - 1]);
    }
  });
});
