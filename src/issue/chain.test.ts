import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import type { IssueSummary } from "./subissue.js";
import { chainPosition, classifyChainPosition, classifyTerminus, parseRoleMap, terminus } from "./chain.js";

function issue(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return { number: 1, id: 1, title: "t", state: "open", labels: [], isPullRequest: false, ...overrides };
}

describe("parseRoleMap", () => {
  it("parses role=label pairs, accumulating repeats of the same role", () => {
    const { map, errors } = parseRoleMap(["idea=mode:idea", "building=mode:build", "building=mode:review"]);
    expect(map.get("idea")).toEqual(["mode:idea"]);
    expect(map.get("building")).toEqual(["mode:build", "mode:review"]);
    expect(errors).toEqual([]);
  });

  // Review finding #8 (part 2): a malformed entry used to be dropped
  // silently -- indistinguishable from the flag never being passed.
  it("reports a malformed entry (no '=') as an error instead of dropping it", () => {
    const { map, errors } = parseRoleMap(["nonsense"]);
    expect(map.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/no '='/);
  });

  it("reports an unknown role name as an error instead of dropping it -- e.g. a 'building' typo", () => {
    const { map, errors } = parseRoleMap(["buildng=stage/building"]);
    expect(map.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/unknown role 'buildng'/);
  });

  it("reports an empty label as an error", () => {
    const { errors } = parseRoleMap(["idea="]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/empty label/);
  });
});

describe("classifyChainPosition -- order is load-bearing", () => {
  const { map } = parseRoleMap([
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
    const result = classifyChainPosition(issue({ labels: [] }), parseRoleMap([]).map);
    expect(result.position).toBe("undecidable");
  });

  // Review finding #8 (part 1): the undecidable guard used to fire only when
  // ALL EIGHT roles were unmapped, so a caller who mapped seven and omitted
  // 'building' got a confident 'routable' for an issue that was, in truth,
  // building.
  it("is undecidable -- NOT confidently 'routable' -- when 'building' specifically was never mapped, even with every other role mapped", () => {
    const { map: partial } = parseRoleMap([
      "in-review=mode:review",
      "idea=mode:idea",
      "epic=type:epic",
      "approved-team=mode:team",
      "approved-direct=mode:direct",
      "researched=mode:researched",
    ]);
    const result = classifyChainPosition(issue({ state: "OPEN", labels: ["stage/building"] }), partial);
    expect(result.position).toBe("undecidable");
    expect(result.evidence.join(" ")).toMatch(/building/);
  });

  it("is undecidable when 'idea' alone was never mapped", () => {
    const { map: partial } = parseRoleMap([
      "building=mode:build",
      "in-review=mode:review",
      "epic=type:epic",
      "approved-team=mode:team",
      "approved-direct=mode:direct",
    ]);
    expect(classifyChainPosition(issue({ labels: [] }), partial).position).toBe("undecidable");
  });

  it("is still 'routable' when all four critical roles ARE mapped and none matches", () => {
    expect(classifyChainPosition(issue({ labels: [] }), map).position).toBe("routable");
  });
});

describe("classifyTerminus", () => {
  const { map } = parseRoleMap([
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

// Issue #25: GitHub numbers issues and PRs in one sequence and issues/{n}
// serves both, so `--issue 925` naming a PR used to answer a plausible,
// silently wrong classification ('routable' / 'own-pr', exit 0). The guard
// lives at the fetch, in BOTH verb wrappers, keyed on the payload's non-null
// `pull_request` -- the one discriminator that exists (`gh issue view --json
// pull_request` errors on every object).
describe("chainPosition / terminus -- refuse a pull request outright (issue #25)", () => {
  const TARGET: Target = { owner: "o", repo: "n", slug: "o/n" };
  const { map } = parseRoleMap([
    "building=mode:build",
    "in-review=mode:review",
    "idea=mode:idea",
    "epic=type:epic",
  ]);

  function prPayload(): { stdout: string } {
    return {
      stdout: JSON.stringify({
        number: 925,
        id: 90925,
        title: "some pull request",
        state: "open",
        labels: [],
        pull_request: { url: "https://api.github.com/repos/o/n/pulls/925" },
      }),
    };
  }

  it("chain-position refuses a PR-shaped payload with the actionable message, never a classification", () => {
    const seams = new ScriptedSeams([{ match: "gh api repos/o/n/issues/925", result: prPayload() }]);
    expect((): unknown => chainPosition(seams, TARGET, 925, map)).toThrow(
      /#925 names a pull request, not an issue; a delivery-chain position is defined only for issues/,
    );
  });

  it("terminus refuses the same PR-shaped payload -- both verbs carry the guard", () => {
    const seams = new ScriptedSeams([{ match: "gh api repos/o/n/issues/925", result: prPayload() }]);
    expect((): unknown => terminus(seams, TARGET, 925, map)).toThrow(/names a pull request, not an issue/);
  });

  it("the refusal points at the right family for a PR", () => {
    const seams = new ScriptedSeams([{ match: "gh api repos/o/n/issues/925", result: prPayload() }]);
    expect((): unknown => chainPosition(seams, TARGET, 925, map)).toThrow(/'nen pr' family/);
  });

  it("a genuine issue payload (no pull_request key) classifies exactly as before", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh api repos/o/n/issues/17",
        result: {
          stdout: JSON.stringify({ number: 17, id: 90017, title: "a real issue", state: "open", labels: [] }),
        },
      },
    ]);
    expect(chainPosition(seams, TARGET, 17, map).position).toBe("routable");
  });

  it("a genuine issue payload's terminus is likewise unchanged", () => {
    const { map: terminusMap } = parseRoleMap(["chore=type:chore", "epic=type:epic"]);
    const seams = new ScriptedSeams([
      {
        match: "gh api repos/o/n/issues/17",
        result: {
          stdout: JSON.stringify({ number: 17, id: 90017, title: "a real issue", state: "open", labels: [] }),
        },
      },
    ]);
    expect(terminus(seams, TARGET, 17, terminusMap).kind).toBe("own-pr");
  });
});
