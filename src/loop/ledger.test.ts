// Tests for ./ledger.ts -- the DECISION half of `nen loop iterate`, with no
// filesystem in it. Every branch below is one a caller can reach, and two of
// them are the ones that must never be reachable by accident: raising a cap
// mid-loop, and re-entering a released loop.

import { describe, expect, it } from "vitest";
import {
  claimIteration,
  loopIdSegment,
  parseLedger,
  LOOP_LEDGER_CONTRACT,
  type LoopLedger,
} from "./ledger.js";

const LINE = "address the backlog until it is empty up to 3";
const NOW = "2025-06-01T12:00:00Z";

function input(overrides: Partial<Parameters<typeof claimIteration>[1]> = {}): Parameters<typeof claimIteration>[1] {
  return {
    id: "sweep",
    line: LINE,
    task: "address the backlog",
    condition: "it is empty",
    cap: 3,
    now: NOW,
    release: null,
    ...overrides,
  };
}

function ledger(overrides: Partial<LoopLedger> = {}): LoopLedger {
  return {
    contract: LOOP_LEDGER_CONTRACT,
    id: "sweep",
    line: LINE,
    task: "address the backlog",
    condition: "it is empty",
    cap: 3,
    iterations: 1,
    startedAt: NOW,
    lastAt: NOW,
    released: false,
    releaseReason: null,
    ...overrides,
  };
}

describe("claimIteration -- the cap, enforced across a loop", () => {
  it("begins a loop on the first claim, at iteration 1", () => {
    const result = claimIteration(null, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ledger.iterations).toBe(1);
    expect(result.ledger.cap).toBe(3);
    expect(result.released).toBe(false);
  });

  it("counts each further claim, and never past the cap", () => {
    let current: LoopLedger | null = null;
    for (const expected of [1, 2, 3]) {
      const result = claimIteration(current, input());
      expect(result.ok, `iteration ${expected}`).toBe(true);
      if (!result.ok) return;
      expect(result.ledger.iterations).toBe(expected);
      current = result.ledger;
    }
    // The claim AFTER the last one is the refusal: a loop capped at 3 performs
    // 3 iterations, never a fourth that discovers the bound.
    const past = claimIteration(current, input());
    expect(past.ok).toBe(false);
    if (past.ok) return;
    expect(past.error.kind).toBe("cap");
    expect(past.error.message).toContain("all 3 iteration(s)");
    // It says what to do next, and what NOT to do.
    expect(past.error.message).toContain("--release");
    expect(past.error.message).toContain("never a bound to raise and re-run");
  });

  it("REFUSES a claim whose line differs -- the cap cannot be raised mid-loop", () => {
    // The property the whole module exists for. Without it, a caller that
    // reached the cap could re-type the invocation with a bigger N and carry on,
    // which makes the cap a suggestion with extra steps.
    const raised = claimIteration(
      ledger({ iterations: 3 }),
      input({ line: "address the backlog until it is empty up to 30", cap: 30 }),
    );
    expect(raised.ok).toBe(false);
    if (raised.ok) return;
    expect(raised.error.kind).toBe("usage");
    expect(raised.error.message).toContain("running:  address the backlog until it is empty up to 3");
    expect(raised.error.message).toContain("claimed:  address the backlog until it is empty up to 30");
  });

  it("refuses a DIFFERENT task under the same id, by the same rule", () => {
    // The honest version of the same mistake: a second loop reusing an id that
    // already belongs to something else. One rule catches both.
    const other = claimIteration(ledger(), input({ line: "do something else until done up to 3" }));
    expect(other.ok).toBe(false);
  });

  it("releases a running loop, recording why", () => {
    const result = claimIteration(ledger({ iterations: 2 }), input({ release: "the condition became true" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.released).toBe(true);
    expect(result.ledger.released).toBe(true);
    expect(result.ledger.releaseReason).toBe("the condition became true");
    // A release is not an iteration.
    expect(result.ledger.iterations).toBe(2);
  });

  it("releases a loop that is already AT its cap -- the way out is never blocked", () => {
    const result = claimIteration(ledger({ iterations: 3 }), input({ release: "cap reached" }));
    expect(result.ok).toBe(true);
  });

  it("refuses a claim after a release, and accepts a second release", () => {
    const released = ledger({ iterations: 2, released: true, releaseReason: "done" });
    const again = claimIteration(released, input());
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.kind).toBe("usage");
    expect(again.error.message).toContain("begin a new one under its own --id");

    // Releasing twice is the caller saying the same true thing again: nothing
    // changes and nothing is wrong.
    const twice = claimIteration(released, input({ release: "done" }));
    expect(twice.ok).toBe(true);
  });

  it("refuses a release of a loop that was never begun", () => {
    const result = claimIteration(null, input({ release: "done" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("nothing to release");
  });
});

describe("loopIdSegment -- refused, never sanitised", () => {
  it("accepts an ordinary label", () => {
    expect(loopIdSegment("sweep")).toBe("sweep");
    expect(loopIdSegment("backlog-sweep.2")).toBe("backlog-sweep.2");
  });

  it("refuses everything that is not one path segment", () => {
    // A cache slot may be sanitised -- a mangled one costs a re-download. A loop
    // id may not: two ids mangled to one segment would silently share a cap
    // between two loops, which is the failure this module exists to prevent.
    for (const bad of ["", "a/b", "../etc", "a..b", ".hidden", "-leading", "a b", "x".repeat(101)]) {
      expect(loopIdSegment(bad), bad).toBeNull();
    }
  });
});

describe("parseLedger -- an unrecognised file is not a fresh start", () => {
  it("reads a ledger this build wrote", () => {
    expect(parseLedger(JSON.parse(JSON.stringify(ledger())))).toEqual(ledger());
  });

  it("answers null for anything else, so the caller can refuse rather than overwrite", () => {
    for (const bad of [null, 3, "x", [], {}, { contract: "something.else/v1" }, { ...ledger(), cap: "3" }]) {
      expect(parseLedger(bad)).toBeNull();
    }
  });

  it("refuses a well-TYPED ledger whose numbers are not meaningful", () => {
    // Copilot, PR #185. `cap` and `iterations` are the two numbers the whole
    // enforcement is computed from, and an integer is not the same as a
    // meaningful one: a cap below 1 is a loop nothing could claim, an
    // `iterations` below 1 contradicts a ledger that exists only because a claim
    // was made, and `iterations > cap` is a state the claim rule cannot produce
    // (it refuses at `>=`). Each would reach the caller as nonsense -- a
    // negative `remaining`, a cap that never fires -- rather than as a refusal.
    for (const bad of [
      { cap: 0 },
      { cap: -1 },
      { iterations: 0 },
      { iterations: -2 },
      { cap: 3, iterations: 4 },
    ]) {
      expect(parseLedger({ ...ledger(), ...bad }), JSON.stringify(bad)).toBeNull();
    }
    // The boundary that IS legitimate: a loop sitting exactly at its cap.
    expect(parseLedger({ ...ledger(), cap: 3, iterations: 3 })).not.toBeNull();
  });
});
