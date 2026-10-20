// Tests for ./base_identities.ts (zheref/nen#372): every nen/gates.json input
// but checks.excluded, as the pull request's BASE declares it, with the local
// file as a loud fallback.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { identitiesAtBase } from "./base_identities.js";
import { ALT_REPO, BANKAI_REPO } from "../schema/fixtures/paths.js";
import { loadGateIdentities } from "../schema/gates.js";

const WHERE = "o/n@base123:nen/gates.json";
const local = loadGateIdentities(ALT_REPO);
const bankaiText = readFileSync(join(BANKAI_REPO, "nen", "gates.json"), "utf8");

describe("identitiesAtBase", () => {
  it("a base file that parses is the one applied, named by its base location, with no warning", () => {
    const resolved = identitiesAtBase({ kind: "read", text: bankaiText }, WHERE, local);
    if (resolved.kind !== "applied") throw new Error(`expected applied, got ${resolved.kind}`);
    expect(resolved.origin).toBe("base");
    expect(resolved.path).toBe(WHERE);
    expect(resolved.identities.path).toBe(WHERE);
    expect(resolved.identities.baseReviewers).toEqual(loadGateIdentities(BANKAI_REPO).baseReviewers);
    expect(resolved.identities.baseReviewers).not.toEqual(local.baseReviewers);
    expect(resolved.warnings).toEqual([]);
  });

  it("a base that could not be READ falls back to the local identities, and warns naming both files and the reason", () => {
    const resolved = identitiesAtBase({ kind: "failed", message: "HTTP 403" }, WHERE, local);
    if (resolved.kind !== "applied") throw new Error(`expected applied, got ${resolved.kind}`);
    expect(resolved.origin).toBe("local-fallback");
    expect(resolved.identities).toBe(local);
    expect(resolved.path).toBe(local.path);
    expect(resolved.warnings).toEqual([
      `gate inputs read from the LOCAL ${local.path}, NOT the pull request's base (${WHERE}): the base could not be read (HTTP 403). In a worktree the local file is the pull request's own head, so the reviewers, rounds, quorum, approvals and carve-outs this verdict applied may be ones the base has not merged; 'pr merge' and 'watch until --until ready' refuse a verdict that rests on them.`,
    ]);
  });

  it("a base with no nen/gates.json NEVER falls back: absent, naming why (hanten round 1, Feitan 1)", () => {
    const resolved = identitiesAtBase({ kind: "absent" }, WHERE, local);
    expect(resolved.kind).toBe("absent");
    if (resolved.kind !== "absent") return;
    expect(resolved.reason).toContain(`base (${WHERE}) declares no nen/gates.json`);
    expect(resolved.reason).toContain("never applied in its place");
  });

  it("a base file this build REFUSES never falls back: refused, quoting the refusal against the base location (Feitan 2)", () => {
    const fixture = JSON.parse(bankaiText) as Record<string, unknown>;
    const cases: readonly [string, string, RegExp][] = [
      ["invalid JSON", "{ not json", /^o\/n@base123:nen\/gates\.json: is not valid JSON/],
      ["duplicate key", '{"version":1,"version":1}', /^o\/n@base123:nen\/gates\.json: at \$, carries the key 'version' twice/],
      ["unsupported version", JSON.stringify({ ...fixture, version: 2 }), /^o\/n@base123:nen\/gates\.json: at version, is number \(2\)/],
      ["unread key", JSON.stringify({ ...fixture, future_stricter_rule: {} }), /^o\/n@base123:nen\/gates\.json: at \$, carries 'future_stricter_rule'/],
    ];
    for (const [label, text, pattern] of cases) {
      const resolved = identitiesAtBase({ kind: "read", text }, WHERE, local);
      expect(resolved.kind, label).toBe("refused");
      if (resolved.kind !== "refused") continue;
      expect(resolved.message, label).toMatch(pattern);
      expect(resolved.reason, label).toMatch(/^this nen cannot read the gate the pull request's base declares/);
    }
  });
});
