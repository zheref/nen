import { describe, expect, it } from "vitest";
import type { IssueSummary } from "./subissue.js";
import { classifyChainPosition, classifyTerminus, parseRoleMap } from "./chain.js";

function issue(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return { number: 1, id: 1, title: "t", state: "open", labels: [], ...overrides };
}

describe("parseRoleMap", () => {
  it("parses role=label pairs, accumulating repeats of the same role", () => {
    const map = parseRoleMap(["idea=mode:idea", "building=mode:build", "building=mode:review"]);
    expect(map.get("idea")).toEqual(["mode:idea"]);
    expect(map.get("building")).toEqual(["mode:build", "mode:review"]);
  });

  it("ignores a malformed entry", () => {
    expect(parseRoleMap(["nonsense"]).size).toBe(0);
  });
});

describe("classifyChainPosition -- order is load-bearing", () => {
  const map = parseRoleMap([
    "building=mode:build",
    "in-review=mode:review",
    "idea=mode:idea",
    "epic=type:epic",
    "approved-team=mode:team",
    "approved-direct=mode:direct",
    "researched=mode:researched",
  ]);

  it("closed wins over everything else", () => {
    const result = classifyChainPosition(issue({ state: "closed", labels: ["mode:idea"] }), map);
    expect(result.position).toBe("closed");
  });

  it("building wins over epic -- an already-building epic child is not re-routed", () => {
    const result = classifyChainPosition(issue({ labels: ["type:epic", "mode:build"] }), map);
    expect(result.position).toBe("building");
  });

  it("in-review reads as building too", () => {
    expect(classifyChainPosition(issue({ labels: ["mode:review"] }), map).position).toBe("building");
  });

  it("idea, when not building", () => {
    expect(classifyChainPosition(issue({ labels: ["mode:idea"] }), map).position).toBe("idea");
  });

  it("epic with an approved mode label is epic-approved", () => {
    expect(classifyChainPosition(issue({ labels: ["type:epic", "mode:team"] }), map).position).toBe(
      "epic-approved",
    );
  });

  it("epic with no mode label is epic-awaiting-approval -- the mode label is a human gate", () => {
    expect(classifyChainPosition(issue({ labels: ["type:epic"] }), map).position).toBe(
      "epic-awaiting-approval",
    );
  });

  it("no matching label is routable", () => {
    expect(classifyChainPosition(issue({ labels: [] }), map).position).toBe("routable");
  });

  it("undecidable when no roles were mapped at all -- refuses to guess", () => {
    const result = classifyChainPosition(issue({ labels: [] }), parseRoleMap([]));
    expect(result.position).toBe("undecidable");
  });
});

describe("classifyTerminus", () => {
  const map = parseRoleMap([
    "chore=type:chore",
    "epic=type:epic",
    "approved-team=mode:team",
    "approved-direct=mode:direct",
  ]);

  it("a closed issue's run already ended", () => {
    expect(classifyTerminus(issue({ state: "closed" }), map, "chore/", "main").kind).toBe(
      "run-already-ended",
    );
  });

  it("a team-mode epic (or chore) needs --integration-prefix or is undecidable", () => {
    const result = classifyTerminus(issue({ labels: ["type:epic", "mode:team"] }), map, null, "main");
    expect(result.kind).toBe("undecidable");
  });

  it("a team-mode epic with a prefix is the integration delivery PR", () => {
    const result = classifyTerminus(issue({ labels: ["type:epic", "mode:team"] }), map, "chore/", "main");
    expect(result.kind).toBe("integration-delivery-pr");
    expect(result.expectedHeadPrefix).toBe("chore/");
    expect(result.expectedBase).toBe("main");
  });

  it("a chore is also an integration delivery, regardless of mode label", () => {
    expect(classifyTerminus(issue({ labels: ["type:chore"] }), map, "chore/", "main").kind).toBe(
      "integration-delivery-pr",
    );
  });

  it("a direct-mode epic is each-child-pr", () => {
    expect(
      classifyTerminus(issue({ labels: ["type:epic", "mode:direct"] }), map, null, "main").kind,
    ).toBe("each-child-pr");
  });

  it("an epic with no mode label is undecidable -- a human gate", () => {
    expect(classifyTerminus(issue({ labels: ["type:epic"] }), map, null, "main").kind).toBe(
      "undecidable",
    );
  });

  it("no epic or chore label -- own-pr into trunk", () => {
    expect(classifyTerminus(issue({ labels: [] }), map, null, "main").kind).toBe("own-pr");
  });
});
