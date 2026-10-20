import { describe, expect, it } from "vitest";
import { readAiReviewers, trustedBotReviewers, aiReviewersNotices } from "./ai_reviewers.js";
import type { PrStateSource } from "../github/pr_state.js";
import { parseGateIdentities } from "../schema/gates.js";

const ref = { owner: "owner", repo: "repo", number: 1 };
function source(read?: (ref: unknown, path: string, sha: string) => Promise<string | null>): PrStateSource {
  return (read === undefined ? {} : { fileAtRef: read }) as PrStateSource;
}
const policies = ["required", "optional", "off"] as const;
describe("trusted aiReviewers policy", () => {
  it.each(policies.flatMap((a) => policies.map((b) => [a, b] as const)))("takes the stricter %s/%s policy at pinned commits", async (a, b) => {
    const calls: string[] = [];
    const result = await readAiReviewers(source(async (_ref, path, sha) => {
      expect(path).toBe("nen/workflow.json"); calls.push(sha);
      return JSON.stringify({ aiReviewers: sha === "base" ? a : b });
    }), ref, "base", "default");
    expect(calls).toEqual(["base", "default"]);
    expect(result.effective).toBe(policies[Math.min(policies.indexOf(a), policies.indexOf(b))]);
    expect(result.base.sha).toBe("base"); expect(result.defaultTip.sha).toBe("default");
    expect(aiReviewersNotices(result).join()).toContain("base base");
  });
  it("deduplicates identical SHAs", async () => {
    let calls = 0;
    const reading = await readAiReviewers(source(async () => { calls++; return '{"aiReviewers":"off"}'; }), ref, "same", "same");
    expect(calls).toBe(1); expect(reading.effective).toBe("off");
  });
  it.each([null, "{", "{}", "[]", '{"aiReviewers":null}', '{"aiReviewers":"OPTIONAL"}', '{"aiReviewers":"required","aiReviewers":"off"}'])("reads absent/invalid workflow %s as required", async (text) => {
    const reading = await readAiReviewers(source(async () => text), ref, "base", "default");
    expect(reading.effective).toBe("required"); expect(reading.base.fallback).not.toBeNull();
  });
  it("fails closed for missing commits, transport, and thrown reads", async () => {
    for (const [src, base, tip] of [[source(), "base", "default"], [source(async () => { throw new Error("403"); }), "base", "default"], [source(async () => '{"aiReviewers":"off"}'), "", "default"], [source(async () => '{"aiReviewers":"off"}'), "base", ""]] as const) {
      expect((await readAiReviewers(src, ref, base, tip)).effective).toBe("required");
    }
  });
});

const gates = (kind: string | null = "bot", pattern = "^bot$"): Record<string, unknown> => ({
  version: 1,
  reviewers: [{ name: "bot", ...(kind === null ? {} : { kind }), login_pattern: { pattern, ignoreCase: false } }],
  base_reviewers: ["bot"], default_approvers: [], approval_policy: "review-round-only",
  delivery: { author_pattern: { pattern: "^delivery$", ignoreCase: false }, head_ref_prefixes: ["delivery/"] },
});
describe("bot identity requires both trusted declarations", () => {
  const read = (value: Record<string, unknown>): { kind: "read"; text: string } => ({ kind: "read" as const, text: JSON.stringify(value) });
  it("only accepts the same positive bot declaration, including applied identity", () => {
    const applied = parseGateIdentities("fixture", gates());
    expect(trustedBotReviewers(read(gates()), read(gates()), applied)).toEqual(["bot"]);
    for (const other of [gates(null), gates("human"), gates("bot", "^changed$"), gates(null, "^bot$")]) {
      expect(trustedBotReviewers(read(gates()), read(other), applied)).toEqual([]);
    }
    expect(trustedBotReviewers(read(gates()), read(gates()), parseGateIdentities("head", gates("bot", "^head$")))).toEqual([]);
    for (const other of [undefined, { kind: "absent" as const }, { kind: "failed" as const, message: "403" }, { kind: "read" as const, text: "{" }]) {
      expect(trustedBotReviewers(read(gates()), other, applied)).toEqual([]);
    }
  });
});
