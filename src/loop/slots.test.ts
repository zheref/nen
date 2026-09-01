import { describe, expect, it } from "vitest";
import { computeSlots, DEFAULT_CAPS, occupancy, parseEfforts, type Effort } from "./slots.js";

describe("occupancy -- the two planes free their slot at different moments", () => {
  it("a CI effort frees at PR-open, regardless of readiness", () => {
    const effort: Effort = { id: "a", plane: "ci", prOpen: true, ready: false, prompted: false };
    expect(occupancy(effort).occupied).toBe(false);
  });

  it("a CI effort with no PR yet still occupies its slot", () => {
    const effort: Effort = { id: "a", plane: "ci", prOpen: false, ready: false, prompted: false };
    expect(occupancy(effort).occupied).toBe(true);
  });

  it("a local effort with no PR occupies its slot", () => {
    const effort: Effort = { id: "a", plane: "local", prOpen: false, ready: false, prompted: false };
    expect(occupancy(effort).occupied).toBe(true);
  });

  it("a local effort with an open, not-ready PR still occupies its slot", () => {
    const effort: Effort = { id: "a", plane: "local", prOpen: true, ready: false, prompted: false };
    expect(occupancy(effort).occupied).toBe(true);
  });

  it("a local effort that is ready but not yet prompted still occupies its slot", () => {
    const effort: Effort = { id: "a", plane: "local", prOpen: true, ready: true, prompted: false };
    expect(occupancy(effort).occupied).toBe(true);
  });

  it("a local effort frees only once ready AND prompted", () => {
    const effort: Effort = { id: "a", plane: "local", prOpen: true, ready: true, prompted: true };
    expect(occupancy(effort).occupied).toBe(false);
  });
});

describe("computeSlots -- the two budgets, counted and never traded", () => {
  it("counts ci and local independently against DEFAULT_CAPS", () => {
    const efforts: Effort[] = [
      { id: "ci-1", plane: "ci", prOpen: false, ready: false, prompted: false },
      { id: "ci-2", plane: "ci", prOpen: false, ready: false, prompted: false },
      { id: "local-1", plane: "local", prOpen: false, ready: false, prompted: false },
    ];
    const report = computeSlots(efforts, DEFAULT_CAPS);
    expect(report.ci).toMatchObject({ cap: 2, occupied: 2, free: 0, binding: true });
    expect(report.local).toMatchObject({ cap: 7, occupied: 1, free: 6, binding: false });
  });

  it("lists a freed effort under done, on its own plane's rule", () => {
    const efforts: Effort[] = [
      { id: "ci-1", plane: "ci", prOpen: true, ready: false, prompted: false },
    ];
    const report = computeSlots(efforts);
    expect(report.done).toEqual(["ci-1"]);
  });

  it("never lets one plane's occupancy affect the other's free count", () => {
    const efforts: Effort[] = Array.from({ length: 5 }, (_, i): Effort => ({
      id: `ci-${i}`,
      plane: "ci",
      prOpen: false,
      ready: false,
      prompted: false,
    }));
    const report = computeSlots(efforts, { ci: 2, local: 7 });
    expect(report.local.occupied).toBe(0);
    expect(report.local.free).toBe(7);
  });
});

describe("parseEfforts -- validated, not cast", () => {
  it("parses a well-formed array", () => {
    const parsed = parseEfforts(JSON.stringify([{ id: "a", plane: "ci", prOpen: true }]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.efforts[0]).toMatchObject({ id: "a", plane: "ci", prOpen: true, ready: false });
  });

  it("errors on a missing or invalid plane -- never defaults into a budget", () => {
    const parsed = parseEfforts(JSON.stringify([{ id: "a" }]));
    expect(parsed.efforts).toEqual([]);
    expect(parsed.errors[0]).toMatch(/must be "ci" or "local"/);
  });

  it("errors when the top level is not an array", () => {
    expect(parseEfforts("{}").errors[0]).toMatch(/expected a JSON array/);
  });
});
