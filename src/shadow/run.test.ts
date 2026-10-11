// Tests for ./run.ts's comparison (N3 of hanten round 1 on #310+#240): the
// rounds-owed row's pending-request suffix -- ../gates/ready.ts's divergence
// (11) -- is nen's alone, and is stripped before nen's line meets the shell's.

import { describe, expect, it } from "vitest";
import { reasonAgrees, stripNenOnlyReadings } from "./run.js";

const SHELL = "not-ready: a configured reviewer's round is still owed at the current head (CON-32b): copilot (review requested, not yet posted)";
const oracle = (verdictLine: string): { verdictLine: string; exitCode: number; stderr: string } => ({
  verdictLine,
  exitCode: 1,
  stderr: "",
});

describe("shadow comparison -- divergence (11)", () => {
  it("strips the pending-only and own-request suffix", () => {
    const nen = `${SHELL} — pending request only: no owed reviewer lacks a round at any head; each is owed because a review request for it is still pending (zheref/nen#240); own-request: every pending request was made by zheref, the identity running this gate`;
    expect(stripNenOnlyReadings(nen)).toBe(SHELL);
    expect(reasonAgrees(oracle(SHELL), { verdict: "not-ready", gateLine: nen }, "")).toBe(true);
  });

  it("strips the no-round-yet reading", () => {
    const nen = `${SHELL} — no round at any head yet: copilot; a review request for each is pending (zheref/nen#240)`;
    expect(reasonAgrees(oracle(SHELL), { verdict: "not-ready", gateLine: nen }, "")).toBe(true);
  });

  it("still disagrees on any other difference", () => {
    expect(reasonAgrees(oracle(SHELL), { verdict: "not-ready", gateLine: `${SHELL};tenma (no round at head)` }, "")).toBe(false);
    expect(stripNenOnlyReadings(`${SHELL} — and round quorum not met (0 of 2)`)).toBe(`${SHELL} — and round quorum not met (0 of 2)`);
  });
});
