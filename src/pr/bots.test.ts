import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import {
  BotResolutionError,
  collaboratorArgv,
  fetchPrAndKnownBots,
  isCollaborator,
  parseIsCollaborator,
  parsePrAndKnownBots,
  prAndKnownBotsArgv,
  requestBotReviews,
  requestBotReviewsArgv,
} from "./bots.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

describe("prAndKnownBotsArgv / parsePrAndKnownBots", () => {
  it("builds one GraphQL query call, explicit --method POST (zheref/nen#19's rule)", () => {
    const argv = prAndKnownBotsArgv(TARGET, 158);
    expect(argv[0]).toBe("api");
    expect(argv.slice(1, 4)).toEqual(["--method", "POST", "graphql"]);
    expect(argv).toContain("owner=zheref");
    expect(argv).toContain("name=nen");
    expect(argv).toContain("pr=158");
  });

  it("folds a bot from reviewRequests and a DIFFERENT bot from timelineItems into one list", () => {
    const raw = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            id: "PR_1",
            reviewRequests: {
              nodes: [{ requestedReviewer: { __typename: "Bot", login: "owed-bot", id: "BOT_owed" } }],
            },
            timelineItems: {
              nodes: [{ author: { __typename: "Bot", login: "copilot-pull-request-reviewer", id: "BOT_kgDOCnlnWA" } }],
            },
          },
        },
      },
    });
    const result = parsePrAndKnownBots(raw, "zheref/nen#158");
    expect(result.pullRequestId).toBe("PR_1");
    expect([...result.bots].sort((a, b): number => a.login.localeCompare(b.login))).toEqual([
      { login: "copilot-pull-request-reviewer", id: "BOT_kgDOCnlnWA" },
      { login: "owed-bot", id: "BOT_owed" },
    ]);
  });

  it("dedupes the SAME bot id seen in both reviewRequests and timelineItems to one entry", () => {
    const raw = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            id: "PR_1",
            reviewRequests: {
              nodes: [{ requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer", id: "BOT_1" } }],
            },
            timelineItems: {
              nodes: [{ author: { __typename: "Bot", login: "copilot-pull-request-reviewer", id: "BOT_1" } }],
            },
          },
        },
      },
    });
    expect(parsePrAndKnownBots(raw, "what").bots).toHaveLength(1);
  });

  // A User or a Team requestedReviewer/author -- the __typename this pull
  // request most commonly carries -- must be SKIPPED, not crash the whole
  // read: this is a best-effort name-to-id lookup, never a readiness gate.
  it("skips a requestedReviewer/author that is a User or a Team, and keeps reading", () => {
    const raw = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            id: "PR_1",
            reviewRequests: {
              nodes: [
                { requestedReviewer: { __typename: "User", login: "sasuke" } },
                { requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer", id: "BOT_1" } },
              ],
            },
            timelineItems: { nodes: [] },
          },
        },
      },
    });
    const result = parsePrAndKnownBots(raw, "what");
    expect(result.bots).toEqual([{ login: "copilot-pull-request-reviewer", id: "BOT_1" }]);
  });

  it("throws BotResolutionError when the pull request node itself did not read (no pullRequestId to mutate against)", () => {
    const raw = JSON.stringify({ data: { repository: { pullRequest: null } } });
    expect(() => parsePrAndKnownBots(raw, "zheref/nen#158")).toThrow(BotResolutionError);
    expect(() => parsePrAndKnownBots(raw, "zheref/nen#158")).toThrow(/zheref\/nen#158/);
  });

  it("throws BotResolutionError on unparseable JSON", () => {
    expect(() => parsePrAndKnownBots("not json", "what")).toThrow(BotResolutionError);
  });

  it("fetchPrAndKnownBots runs the call through Seams and parses it", () => {
    const seams = new ScriptedSeams([
      {
        match: `gh ${prAndKnownBotsArgv(TARGET, 158).join(" ")}`,
        result: {
          stdout: JSON.stringify({
            data: { repository: { pullRequest: { id: "PR_1", reviewRequests: { nodes: [] }, timelineItems: { nodes: [] } } } },
          }),
        },
      },
    ]);
    expect(fetchPrAndKnownBots(seams, TARGET, 158)).toEqual({ pullRequestId: "PR_1", bots: [] });
  });

  it("fetchPrAndKnownBots throws (never returns a partial result) when gh itself fails", () => {
    const seams = new ScriptedSeams([
      { match: `gh ${prAndKnownBotsArgv(TARGET, 158).join(" ")}`, result: { code: 1, stderr: "rate limited" } },
    ]);
    expect(() => fetchPrAndKnownBots(seams, TARGET, 158)).toThrow(/rate limited/);
  });
});

describe("collaboratorArgv / parseIsCollaborator / isCollaborator", () => {
  it("filters collaborators by an EXACT login, not a search", () => {
    const argv = collaboratorArgv(TARGET, "sasuke");
    expect(argv).toContain("login=sasuke");
  });

  it("true when the login answers back a node; false when the connection is empty", () => {
    expect(
      parseIsCollaborator(JSON.stringify({ data: { repository: { collaborators: { nodes: [{ login: "sasuke", id: "U_1" }] } } } }), "what"),
    ).toBe(true);
    expect(parseIsCollaborator(JSON.stringify({ data: { repository: { collaborators: { nodes: [] } } } }), "what")).toBe(false);
  });

  it("throws BotResolutionError on unparseable JSON", () => {
    expect(() => parseIsCollaborator("not json", "what")).toThrow(BotResolutionError);
  });

  it("isCollaborator throws (never answers false) when gh itself fails", () => {
    const seams = new ScriptedSeams([
      { match: `gh ${collaboratorArgv(TARGET, "sasuke").join(" ")}`, result: { code: 1, stderr: "no network" } },
    ]);
    expect(() => isCollaborator(seams, TARGET, "sasuke")).toThrow(/no network/);
  });
});

describe("requestBotReviewsArgv / requestBotReviews", () => {
  it("carries every botId as its own repeated botIds[]=<id> field, explicit --method POST", () => {
    const argv = requestBotReviewsArgv("PR_1", ["BOT_1", "BOT_2"]);
    expect(argv.slice(0, 3)).toEqual(["api", "--method", "POST"]);
    expect(argv).toContain("prId=PR_1");
    expect(argv.filter((token): boolean => token === "botIds[]=BOT_1" || token === "botIds[]=BOT_2")).toEqual([
      "botIds[]=BOT_1",
      "botIds[]=BOT_2",
    ]);
  });

  it("reports success from the MUTATION'S OWN reviewRequests, not from the ids this call sent", () => {
    const seams = new ScriptedSeams([
      {
        match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_1"]).join(" ")}`,
        result: {
          stdout: JSON.stringify({
            data: {
              requestReviews: {
                pullRequest: {
                  reviewRequests: {
                    nodes: [{ requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer", id: "BOT_1" } }],
                  },
                },
              },
            },
          }),
        },
      },
    ]);
    const result = requestBotReviews(seams, TARGET, 9, "PR_1", ["BOT_1"]);
    expect(result.ok).toBe(true);
    expect(result.pendingBotLogins).toEqual(["copilot-pull-request-reviewer"]);
    expect(result.message).toMatch(/copilot-pull-request-reviewer/);
  });

  // Verified live the day this landed: the identical call answered NOT_FOUND
  // for a botId under one token and succeeded under another -- a
  // permission-scoped difference in what a token can resolve, not a flake.
  // `gh api graphql` turns a GraphQL `errors` entry into a non-zero exit, and
  // this module's failure branch relays that stderr VERBATIM, exactly like
  // ../pr/reviewers.ts's and ../pr/retarget.ts's own failure branches.
  it("relays gh's own stderr verbatim on failure, rather than claiming success", () => {
    const seams = new ScriptedSeams([
      {
        match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_1"]).join(" ")}`,
        result: { code: 1, stderr: "Could not resolve to a node with the global id of 'BOT_1'" },
      },
    ]);
    const result = requestBotReviews(seams, TARGET, 9, "PR_1", ["BOT_1"]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Could not resolve to a node with the global id of 'BOT_1'/);
    expect(result.pendingBotLogins).toEqual([]);
  });

  // AN EXIT-0 CALL IS NOT, BY ITSELF, A PROMISE that every botId sent was
  // actually added: this is the exact shape the module header describes --
  // never echo the request back as the report; read what the mutation's own
  // response says landed.
  it("never claims a bot was requested when the mutation's own response does not say so, even at exit 0", () => {
    const seams = new ScriptedSeams([
      {
        match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_1"]).join(" ")}`,
        result: {
          stdout: JSON.stringify({ data: { requestReviews: { pullRequest: { reviewRequests: { nodes: [] } } } } }),
        },
      },
    ]);
    const result = requestBotReviews(seams, TARGET, 9, "PR_1", ["BOT_1"]);
    expect(result.ok).toBe(true);
    expect(result.pendingBotLogins).toEqual([]);
    expect(result.message).toMatch(/none reported back/);
  });

  it("fails rather than crashing when gh exits 0 but answers something that is not JSON", () => {
    const seams = new ScriptedSeams([
      { match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_1"]).join(" ")}`, result: { stdout: "not json" } },
    ]);
    const result = requestBotReviews(seams, TARGET, 9, "PR_1", ["BOT_1"]);
    expect(result.ok).toBe(false);
    expect(result.pendingBotLogins).toEqual([]);
  });
});
