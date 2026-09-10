import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
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
    const result = requestReviews(new ScriptedSeams([]), TARGET, 9, []);
    expect(result.ok).toBe(false);
  });

  // zheref/nen#95: the refusal used to name --reviewers, which belongs to
  // `pr ready`/`pr next-blocker` -- this verb's own flag is --add-reviewers.
  it("names this verb's OWN flag, --add-reviewers, not --reviewers (zheref/nen#95)", () => {
    const result = requestReviews(new ScriptedSeams([]), TARGET, 9, []);
    expect(result.message).toMatch(/--add-reviewers/);
    expect(result.message).not.toMatch(/--reviewers\b/);
  });

  it("reports success reading gh's own exit code", () => {
    const seams = new ScriptedSeams([
      { match: `gh ${requestReviewsArgv(TARGET, 9, ["copilot"]).join(" ")}`, result: {} },
    ]);
    expect(requestReviews(seams, TARGET, 9, ["copilot"]).ok).toBe(true);
  });

  it("carries gh's failure through", () => {
    const seams = new ScriptedSeams([
      { match: `gh ${requestReviewsArgv(TARGET, 9, ["copilot"]).join(" ")}`, result: { code: 1, stderr: "no such user" } },
    ]);
    const result = requestReviews(seams, TARGET, 9, ["copilot"]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no such user/);
  });
});
