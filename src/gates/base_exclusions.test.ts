import { describe, expect, it } from "vitest";
import { exclusionsAtBoth, type BaseGatesRead } from "./base_exclusions.js";
import { parseCheckExclusions } from "../schema/gates.js";

const RULING = { name: "ci / windows", reason: "no runner", ruled: "2026-01-01", until: "2026-12-31" };
const read = (entries: readonly unknown[]): BaseGatesRead => ({ kind: "read", text: JSON.stringify({ version: 1, checks: { excluded: entries } }) });
const local = parseCheckExclusions("local", { version: 1, checks: { excluded: [RULING] } });
const resolve = (base: BaseGatesRead, tip: BaseGatesRead): ReturnType<typeof exclusionsAtBoth> => exclusionsAtBoth(
  { read: base, source: "o/r@base:nen/gates.json" }, { read: tip, source: "o/r@default:nen/gates.json" }, local,
);

describe("checks.excluded's pinned intersection (#403)", () => {
  it("keeps complete shared declarations in base order, not default order", () => {
    const other = { ...RULING, name: "ci / linux" };
    expect(resolve(read([RULING, other]), read([other, RULING])).exclusions.map((entry) => entry.name)).toEqual([RULING.name, other.name]);
  });
  it.each(["base", "default"])("a %s-only ruling cannot widen the other side", (side) => {
    const result = resolve(read(side === "base" ? [RULING] : []), read(side === "default" ? [RULING] : []));
    expect(result.exclusions).toEqual([]);
    expect(result.warnings.join("\n")).toContain(side === "base" ? "default-branch tip (o/r@default" : "pull request's base (o/r@base");
  });
  it.each([
    { until: "2027-01-01" }, { until: { condition: "runner returns" } }, { ruled: "2026-02-01" },
    { reason: "different ruling" }, { match: "glob" },
  ])("does not combine selector-equal declarations with different metadata: %j", (changed) => {
    expect(resolve(read([RULING]), read([{ ...RULING, ...changed }])).exclusions).toEqual([]);
  });
  it("normalises implicit exact matching, with no metadata widening", () => {
    expect(resolve(read([RULING]), read([{ ...RULING, match: "exact" }])).exclusions).toHaveLength(1);
  });
  it.each<BaseGatesRead>([
    { kind: "absent" }, { kind: "failed", message: "missing immutable OID" },
    { kind: "read", text: "not JSON" }, { kind: "read", text: '{"version":1,"version":1}' },
    { kind: "read", text: '{"version":2}' }, { kind: "read", text: '{"version":1,"unknown":true}' },
  ])("fails closed on an absent or invalid source: %j", (bad) => {
    for (const result of [resolve(bad, read([RULING])), resolve(read([RULING]), bad)]) {
      expect(result.exclusions).toEqual([]);
      expect(result.warnings.join("\n")).toContain("NOT honoured");
    }
  });
  it("keeps an invisible source failure quiet while applying nothing", () => {
    const result = exclusionsAtBoth({ read: { kind: "absent" }, source: "base" }, { read: { kind: "failed", message: "403" }, source: "default" }, []);
    expect(result.warnings).toEqual([]);
    expect(result.notes.join("\n")).toContain("default-branch tip");
    expect(result.exclusions).toEqual([]);
  });
});
