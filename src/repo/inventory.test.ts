import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { inventoryRepo, listChildren, listEpics, listIntegrationBranches, listOpenPrs } from "./inventory.js";

const TARGET: Target = { owner: "zheref", repo: "KroApple", slug: "zheref/KroApple" };

describe("listEpics", () => {
  it("lists open issues carrying the caller-named epic label", () => {
    const seams = new ScriptedSeams([
      {
        match:
          "gh issue list --repo zheref/KroApple --state open --label type:epic --limit 100 --json number,title,state,url,labels,updatedAt,closedAt",
        result: { stdout: JSON.stringify([{ number: 1, title: "epic 1", state: "OPEN", labels: [] }]) },
      },
    ]);
    expect(listEpics(seams, TARGET, "type:epic")).toEqual([
      { number: 1, title: "epic 1", state: "OPEN", url: "", labels: [], updatedAt: null, closedAt: null },
    ]);
  });
});

describe("listChildren", () => {
  it("reads sub-issues over REST, translating snake_case fields", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh api repos/zheref/KroApple/issues/1/sub_issues",
        result: {
          stdout: JSON.stringify([
            { number: 2, title: "child", state: "open", html_url: "https://x/2", labels: [{ name: "bankai:stage/building" }] },
          ]),
        },
      },
    ]);
    expect(listChildren(seams, TARGET, 1)).toEqual([
      { number: 2, title: "child", state: "open", url: "https://x/2", labels: ["bankai:stage/building"], updatedAt: null, closedAt: null },
    ]);
  });
});

describe("listIntegrationBranches", () => {
  it("filters branches by prefix and reads ahead/behind via compare", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh api repos/zheref/KroApple/branches --paginate -q .[].name",
        result: { stdout: "main\nintegration/epic-1\nfeature/x\n" },
      },
      {
        match: "gh api repos/zheref/KroApple/compare/main...integration/epic-1",
        result: { stdout: JSON.stringify({ ahead_by: 3, behind_by: 1 }) },
      },
    ]);
    expect(listIntegrationBranches(seams, TARGET, "integration/", "main")).toEqual([
      { name: "integration/epic-1", aheadOfTrunk: 3, behindTrunk: 1 },
    ]);
  });
});

describe("listOpenPrs", () => {
  it("parses the open PR list", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh pr list --repo zheref/KroApple --state open --limit 100 --json number,title,baseRefName,url,isDraft",
        result: { stdout: JSON.stringify([{ number: 9, title: "t", baseRefName: "main", url: "https://x/9", isDraft: false }]) },
      },
    ]);
    expect(listOpenPrs(seams, TARGET)).toEqual([
      { number: 9, title: "t", baseRefName: "main", url: "https://x/9", isDraft: false },
    ]);
  });
});

describe("inventoryRepo -- the whole enumeration, live", () => {
  it("composes epics+children, branches and open PRs into one report", () => {
    const seams = new ScriptedSeams([
      {
        match:
          "gh issue list --repo zheref/KroApple --state open --label type:epic --limit 100 --json number,title,state,url,labels,updatedAt,closedAt",
        result: { stdout: JSON.stringify([{ number: 1, title: "epic", state: "OPEN", labels: [] }]) },
      },
      { match: "gh api repos/zheref/KroApple/issues/1/sub_issues", result: { stdout: "[]" } },
      { match: "gh api repos/zheref/KroApple/branches --paginate -q .[].name", result: { stdout: "" } },
      {
        match: "gh pr list --repo zheref/KroApple --state open --limit 100 --json number,title,baseRefName,url,isDraft",
        result: { stdout: "[]" },
      },
    ]);
    const result = inventoryRepo(seams, TARGET, "type:epic", "integration/", "main");
    expect(result.epics.length).toBe(1);
    expect(result.epics[0]?.children).toEqual([]);
    expect(result.integrationBranches).toEqual([]);
    expect(result.openPrs).toEqual([]);
  });
});
