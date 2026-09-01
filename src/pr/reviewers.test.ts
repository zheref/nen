import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import type { Target } from "../github/target.js";
import { requestReviews, requestReviewsArgv } from "./reviewers.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

describe("requestReviewsArgv", () => {
  it("adds one --add-reviewer per name, in order", () => {
    expect(requestReviewsArgv(TARGET, 9, ["copilot", "sasuke"])).toEqual([
      "pr",
      "edit",
      "9",
      "--repo",
      "zheref/nen",
      "--add-reviewer",
      "copilot",
      "--add-reviewer",
      "sasuke",
    ]);
  });
});

describe("requestReviews", () => {
  it("refuses when no reviewers are named", () => {
    const result = requestReviews(new ScriptedRunner([]), TARGET, 9, []);
    expect(result.ok).toBe(false);
  });

  it("reports success reading gh's own exit code", () => {
    const runner = new ScriptedRunner([
      { match: `gh ${requestReviewsArgv(TARGET, 9, ["copilot"]).join(" ")}`, result: {} },
    ]);
    expect(requestReviews(runner, TARGET, 9, ["copilot"]).ok).toBe(true);
  });

  it("carries gh's failure through", () => {
    const runner = new ScriptedRunner([
      { match: `gh ${requestReviewsArgv(TARGET, 9, ["copilot"]).join(" ")}`, result: { code: 1, stderr: "no such user" } },
    ]);
    const result = requestReviews(runner, TARGET, 9, ["copilot"]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no such user/);
  });
});
