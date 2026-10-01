import { describe, expect, it } from "vitest";
import { REBASE_IN_PROGRESS_ARGV, rebaseState, REPO_ANSWERS_ARGV } from "./rebase.js";

describe("rebaseState (#307)", () => {
  it("asks git rebase --show-current-patch, never REBASE_HEAD", () => {
    expect(REBASE_IN_PROGRESS_ARGV).toEqual(["rebase", "--show-current-patch"]);
  });

  it("reads the exit code alone", () => {
    expect(rebaseState(0, null, true)).toBe("on-patch");
    expect(rebaseState(1, null, true)).toBe("paused");
    expect(rebaseState(128, null, true)).toBe("none");
  });

  it("reads a signal-killed probe as unanswered, never as the 'paused' its code 1 would mean", () => {
    expect(rebaseState(1, "SIGTERM", true)).toBe("unknown");
    expect(rebaseState(0, "SIGKILL", true)).toBe("unknown");
    expect(rebaseState(1, null, true)).toBe("paused");
  });

  it("reads 128 as 'no rebase' only where git has shown it can answer in this repository", () => {
    expect(rebaseState(128, null, true)).toBe("none");
    expect(rebaseState(128, null, false)).toBe("unknown");
    expect(REPO_ANSWERS_ARGV).toEqual(["rev-parse", "--git-dir"]);
  });

  it("reads anything else, a signal included, as unanswered -- never as 'no'", () => {
    expect(rebaseState(null, null, true)).toBe("unknown");
    expect(rebaseState(129, null, true)).toBe("unknown");
    expect(rebaseState(2, null, true)).toBe("unknown");
  });
});
