import { describe, expect, it } from "vitest";
import { orderBacklog, type OrderableRow } from "./order.js";

function row(overrides: Partial<OrderableRow>): OrderableRow {
  return {
    id: "x",
    severity: null,
    blocksOther: false,
    affectsConsumers: false,
    createdAt: "2026-01-01T00:00:00Z",
    number: 1,
    ...overrides,
  };
}

describe("orderBacklog", () => {
  const SEVERITIES = ["critical", "high", "medium", "low"];

  it("orders by severity first, in the given priority order", () => {
    const rows = [row({ id: "low", severity: "low" }), row({ id: "critical", severity: "critical" })];
    const ordered = orderBacklog(rows, SEVERITIES);
    expect(ordered.map((r): string => r.id)).toEqual(["critical", "low"]);
  });

  it("ranks an unrecognised/untriaged severity LAST, never interleaved", () => {
    const rows = [row({ id: "untriaged", severity: null }), row({ id: "low", severity: "low" })];
    const ordered = orderBacklog(rows, SEVERITIES);
    expect(ordered.map((r): string => r.id)).toEqual(["low", "untriaged"]);
  });

  it("within a severity: blocks-another-issue outranks not", () => {
    const rows = [
      row({ id: "a", severity: "high", blocksOther: false }),
      row({ id: "b", severity: "high", blocksOther: true }),
    ];
    expect(orderBacklog(rows, SEVERITIES).map((r): string => r.id)).toEqual(["b", "a"]);
  });

  it("then affects-consumers outranks not", () => {
    const rows = [
      row({ id: "a", severity: "high", affectsConsumers: false }),
      row({ id: "b", severity: "high", affectsConsumers: true }),
    ];
    expect(orderBacklog(rows, SEVERITIES).map((r): string => r.id)).toEqual(["b", "a"]);
  });

  it("then age, OLDEST first", () => {
    const rows = [
      row({ id: "newer", severity: "high", createdAt: "2026-02-01T00:00:00Z" }),
      row({ id: "older", severity: "high", createdAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(orderBacklog(rows, SEVERITIES).map((r): string => r.id)).toEqual(["older", "newer"]);
  });

  it("finally breaks a full tie by issue number", () => {
    const rows = [
      row({ id: "b", severity: "high", number: 20 }),
      row({ id: "a", severity: "high", number: 5 }),
    ];
    expect(orderBacklog(rows, SEVERITIES).map((r): string => r.id)).toEqual(["a", "b"]);
  });

  it("critical pre-empts everything else regardless of the tie-break chain", () => {
    const rows = [
      row({ id: "high-blocks", severity: "high", blocksOther: true, createdAt: "2025-01-01T00:00:00Z" }),
      row({ id: "critical-plain", severity: "critical", createdAt: "2026-06-01T00:00:00Z" }),
    ];
    expect(orderBacklog(rows, SEVERITIES).map((r): string => r.id)).toEqual(["critical-plain", "high-blocks"]);
  });
});
