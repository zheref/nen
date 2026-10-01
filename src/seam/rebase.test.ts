import { describe, expect, it } from "vitest";
import { REBASE_IN_PROGRESS_ARGV, rebaseState } from "./rebase.js";

describe("rebaseState (#307)", () => {
  it("asks git rebase --show-current-patch, never REBASE_HEAD", () => {
    expect(REBASE_IN_PROGRESS_ARGV).toEqual(["rebase", "--show-current-patch"]);
  });

  it("reads the exit code alone", () => {
    expect(rebaseState(0)).toBe("on-patch");
    expect(rebaseState(1)).toBe("paused");
    expect(rebaseState(128)).toBe("none");
  });

  it("reads anything else, a signal included, as unanswered -- never as 'no'", () => {
    expect(rebaseState(null)).toBe("unknown");
    expect(rebaseState(129)).toBe("unknown");
    expect(rebaseState(2)).toBe("unknown");
  });
});
