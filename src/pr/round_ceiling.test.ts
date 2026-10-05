// Tests for ./round_ceiling.ts (zheref/nen#240): the timeline read, the count
// and the refusal text. The verb's wiring is ./command.test.ts's.

import { describe, expect, it } from "vitest";
import {
  botRounds,
  ceilingRefusal,
  parseRequestEvents,
  readRequestEvents,
  requestTimelineArgv,
  requestsOf,
  RoundCeilingError,
} from "./round_ceiling.js";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

describe("requestTimelineArgv", () => {
  it("states GET explicitly and paginates to completion as one document", () => {
    expect(requestTimelineArgv(TARGET, 9)).toEqual([
      "api",
      "--method",
      "GET",
      "--paginate",
      "--slurp",
      "repos/zheref/nen/issues/9/timeline",
      "-F",
      "per_page=100",
    ]);
  });
});

describe("parseRequestEvents", () => {
  it("reads review_requested events across pages, skipping team requests and other events", () => {
    const pages = [
      [
        { event: "review_requested", requested_reviewer: { login: "Copilot", node_id: "BOT_1" } },
        { event: "commented" },
        { event: "review_requested", requested_team: { slug: "acme" } },
      ],
      [{ event: "review_requested", requested_reviewer: { login: "sasuke" } }],
    ];
    expect(parseRequestEvents(JSON.stringify(pages), "x")).toEqual([
      { login: "Copilot", nodeId: "BOT_1", type: null },
      { login: "sasuke", nodeId: null, type: null },
    ]);
  });

  it("refuses output that is not JSON, or not a list of pages", () => {
    expect(() => parseRequestEvents("nope", "x")).toThrow(RoundCeilingError);
    expect(() => parseRequestEvents(JSON.stringify({ event: "review_requested" }), "x")).toThrow(/list of pages/);
    expect(() => parseRequestEvents(JSON.stringify([{ event: "x" }]), "x")).toThrow(/list of pages/);
  });

  it("a gh failure is a RoundCeilingError naming the stderr", () => {
    const seams = new ScriptedSeams([
      { match: `gh ${requestTimelineArgv(TARGET, 9).join(" ")}`, result: { code: 1, stderr: "HTTP 502" } },
    ]);
    expect(() => readRequestEvents(seams, TARGET, 9)).toThrow(/could not read zheref\/nen#9's timeline: HTTP 502/);
  });

  it("F7: a token in gh's stderr never reaches the message", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const seams = new ScriptedSeams([
      {
        match: `gh ${requestTimelineArgv(TARGET, 9).join(" ")}`,
        result: { code: 1, stderr: `HTTP 401 for https://x:${token}@api.github.com and ${token}` },
      },
    ]);
    let message = "";
    try {
      readRequestEvents(seams, TARGET, 9);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("could not read zheref/nen#9's timeline");
    expect(message).not.toContain(token);
  });
});

describe("requestsOf / botRounds", () => {
  const events = [
    { login: "Copilot", nodeId: "BOT_1", type: "Bot" },
    { login: "copilot", nodeId: null, type: null },
    { login: "other", nodeId: "BOT_2", type: "Bot" },
    { login: "Copilot", nodeId: "BOT_1", type: "Bot" },
    { login: "copilot", nodeId: "U_1", type: "User" },
  ];

  it("counts by node id, and by the canonical login on any non-User event, whatever its id (N5)", () => {
    expect(requestsOf(events, "BOT_1", null)).toBe(2);
    expect(requestsOf(events, "BOT_1", "copilot")).toBe(3);
    expect(requestsOf(events, "BOT_9", "copilot")).toBe(3); // an id nen never resolved still counts by login
    expect(requestsOf(events, "BOT_2", "other")).toBe(1);
    expect(requestsOf(events, "BOT_3", null)).toBe(0);
  });

  it("refuses the request that would pass the ceiling, and only that one", () => {
    const rounds = botRounds(events.slice(0, 4), [{ id: "BOT_1", login: null }, { id: "BOT_2", login: null }], 2);
    expect(rounds).toEqual([
      { id: "BOT_1", login: null, requested: 2, next: 3, maxRounds: 2, refused: true },
      { id: "BOT_2", login: null, requested: 1, next: 2, maxRounds: 2, refused: false },
    ]);
  });

  it("maxRounds 0 refuses even the first request", () => {
    expect(botRounds([], [{ id: "BOT_1", login: null }], 0)[0]?.refused).toBe(true);
  });

  it("the refusal names the bot, its count, the request it would be, the ceiling and its source", () => {
    const refused = botRounds(events, [{ id: "BOT_1", login: "copilot" }], 3).filter((round) => round.refused);
    expect(ceilingRefusal("zheref/nen#9", refused, "zheref/nen@b:nen/gates.json")).toBe(
      "refused: copilot (BOT_1) has been requested 3 times, so this would be request 4 of 3 on zheref/nen#9, past the round_policy.maxRounds ceiling declared in zheref/nen@b:nen/gates.json. Nothing was requested. A further round is the maintainer's to grant (a pull request raising maxRounds), never this verb's (zheref/nen#240).",
    );
  });
});
