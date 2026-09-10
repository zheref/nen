import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { loopCommand } from "./command.js";
import { noPortProbe } from "../seam/scripted.js";

async function capture(
  argv: readonly string[],
  options: { repoFlag?: string | null; json?: boolean } = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const seams: Seams = {
    run: (): CommandResult => {
      throw new Error("loop slots makes no subprocess call");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("this verb has no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("this verb has no watched form");
    },
    platform: "linux",
  };
  const code = await runFamily(
    loopCommand,
    argv,
    options.repoFlag ?? null,
    options.json ?? false,
    io,
    seams,
  );
  return { code, out, err };
}

describe("nen loop slots -- CLI wiring", () => {
  it("exits 1 when a budget is fully occupied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([
      { id: "a", plane: "ci", prOpen: false },
      { id: "b", plane: "ci", prOpen: false },
    ]));
    const result = await capture(["loop", "slots", "--efforts", path, "--local-cap", "2"]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/BINDING/);
  });

  it("exits 0 with free slots on both planes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([]));
    const result = await capture(["loop", "slots", "--efforts", path, "--local-cap", "2"]);
    expect(result.code).toBe(0);
  });

  it("reports a schema error from the efforts file loudly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([{ id: "a" }]));
    const result = await capture(["loop", "slots", "--efforts", path, "--local-cap", "2"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/must be "ci" or "local"/);
  });

  it("requires --efforts", async () => {
    expect((await capture(["loop", "slots"])).code).toBe(2);
  });
});

// Issue #52: --local-cap used to default to 7 -- more than three times looser
// than every real caller's own policy of 2, and loose-by-default is the wrong
// direction for a safety cap. The flag is now required, and the refusal follows
// the required-flag convention (exit 2, actionable message).
describe("nen loop slots -- --local-cap is required (issue #52)", () => {
  it("refuses an omitted --local-cap with exit 2 and an actionable message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([]));
    const result = await capture(["loop", "slots", "--efforts", path]);
    expect(result.code).toBe(2);
    const message = result.err.join("\n");
    // The refusal must name the flag, say the old default was removed, and say
    // why -- a guard is chosen, not inherited -- so a caller knows the next step.
    expect(message).toMatch(/--local-cap is required/);
    expect(message).toMatch(/default of 7 was removed/);
    expect(message).toMatch(/chosen, not inherited/);
  });

  it("refuses before reading the efforts file -- a wrong invocation is not masked by file content", async () => {
    const result = await capture(["loop", "slots", "--efforts", "does-not-exist.json"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--local-cap is required/);
  });

  it("honors an explicit --local-cap end-to-end, in the report and the exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([
      { id: "local-1", plane: "local", prOpen: false },
      { id: "local-2", plane: "local", prOpen: false },
    ]));
    // Under the old default of 7 these two efforts left 5 free and exit 0;
    // under the caller's actual policy of 2 the budget is BINDING and exit 1.
    const bound = await capture(["loop", "slots", "--efforts", path, "--local-cap", "2", "--json"]);
    expect(bound.code).toBe(1);
    const report = JSON.parse(bound.out.join("\n")) as { local: { cap: number; binding: boolean } };
    expect(report.local).toMatchObject({ cap: 2, occupied: 2, free: 0, binding: true });

    const roomy = await capture(["loop", "slots", "--efforts", path, "--local-cap", "3"]);
    expect(roomy.code).toBe(0);
  });

  it("still defaults --ci-cap to 2 -- the omission errs tight, not loose", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([]));
    const result = await capture(["loop", "slots", "--efforts", path, "--local-cap", "2", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as { ci: { cap: number } };
    expect(report.ci.cap).toBe(2);
  });
});

// zheref/nen#47. `parse izanagi` refuses an invocation with no cap and then
// never sees iteration 2; `watch until --max-iterations` is a different bound on
// izanami's read-only loop. This is the backstop, and these cases drive it the
// way a caller does -- once per iteration, through a real ledger on disk.
describe("nen loop iterate -- izanagi's cap, enforced across a loop", () => {
  const LINE = "address the backlog until it is empty up to 3";

  function repo(): string {
    return mkdtempSync(join(tmpdir(), "nen-loop-"));
  }

  it("counts each claim and REFUSES the one past the cap, at exit 1", async () => {
    const root = repo();
    for (const expected of [1, 2, 3]) {
      const result = await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], {
        repoFlag: root,
      });
      expect(result.code, `iteration ${expected}`).toBe(0);
      expect(result.out[0]).toBe(`iteration ${expected}/3 -- address the backlog until it is empty`);
    }
    const past = await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], { repoFlag: root });
    // EXIT 1, NOT 2: the invocation was well-formed and nen did exactly what it
    // was asked, which was to stop here. That is an answer, not a complaint.
    expect(past.code).toBe(1);
    expect(past.err.join("\n")).toContain("all 3 iteration(s)");
  });

  it("refuses a claim that re-types the line with a bigger cap", async () => {
    const root = repo();
    await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], { repoFlag: root });
    const raised = await capture(
      ["loop", "iterate", "--id", "sweep", "--line", "address the backlog until it is empty up to 30"],
      { repoFlag: root },
    );
    expect(raised.code).toBe(2);
    expect(raised.err.join("\n")).toContain("is not a cap");
  });

  it("releases a loop, and refuses a claim after it", async () => {
    const root = repo();
    await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], { repoFlag: root });
    const released = await capture(
      ["loop", "iterate", "--id", "sweep", "--line", LINE, "--release", "the condition became true"],
      { repoFlag: root },
    );
    expect(released.code).toBe(0);
    expect(released.out[0]).toContain("released sweep after 1/3");
    const after = await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], { repoFlag: root });
    expect(after.code).toBe(2);
    expect(after.err.join("\n")).toContain("begin a new one under its own --id");
  });

  it("refuses a line the izanagi grammar does not accept", async () => {
    const result = await capture(
      ["loop", "iterate", "--id", "sweep", "--line", "address the backlog until it is empty"],
      { repoFlag: repo() },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("required grammar");
  });

  it("refuses an --id that is not one path segment", async () => {
    const result = await capture(["loop", "iterate", "--id", "../etc", "--line", LINE], {
      repoFlag: repo(),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("REFUSED rather than sanitised");
  });

  it("keeps two ids on two separate ledgers, with two separate caps", async () => {
    const root = repo();
    const other = "do the other thing until it is done up to 1";
    await capture(["loop", "iterate", "--id", "a", "--line", LINE], { repoFlag: root });
    const b = await capture(["loop", "iterate", "--id", "b", "--line", other], { repoFlag: root });
    expect(b.code).toBe(0);
    expect(b.out[0]).toBe("iteration 1/1 -- do the other thing until it is done");
    // b is at its cap; a is not.
    expect((await capture(["loop", "iterate", "--id", "b", "--line", other], { repoFlag: root })).code).toBe(1);
    expect((await capture(["loop", "iterate", "--id", "a", "--line", LINE], { repoFlag: root })).code).toBe(0);
  });

  it("reports the claim as one --json document", async () => {
    const result = await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], {
      repoFlag: repo(),
      json: true,
    });
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(document["contract"]).toBe("nen.loop.iterate/v0.1");
    expect(document["claimed"]).toBe(true);
    expect(document["capReached"]).toBe(false);
    expect(document["iterations"]).toBe(1);
    expect(document["remaining"]).toBe(2);
  });

  it("says capReached under --json when the cap refuses a claim", async () => {
    const root = repo();
    const one = "act until done up to 1";
    await capture(["loop", "iterate", "--id", "x", "--line", one], { repoFlag: root });
    const past = await capture(["loop", "iterate", "--id", "x", "--line", one], {
      repoFlag: root,
      json: true,
    });
    expect(past.code).toBe(1);
    const document = JSON.parse(past.out.join("\n")) as Record<string, unknown>;
    expect(document["capReached"]).toBe(true);
    expect(document["claimed"]).toBe(false);
  });

  it("refuses rather than starting again when the ledger cannot be read", async () => {
    // A loop whose count nen cannot read has an unknown number of writes behind
    // it, and beginning at 1 would hand out a whole cap's worth more.
    const root = repo();
    await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], { repoFlag: root });
    writeFileSync(join(root, ".nen", "loop", "sweep.json"), "{ not json", "utf8");
    const result = await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], {
      repoFlag: root,
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("Refusing rather than starting the count again");
  });

  it("refuses an UNREADABLE ledger rather than reading it as a loop that never began", async () => {
    // Copilot, PR #185. A blanket catch read EACCES/EPERM/EISDIR as "no ledger",
    // which restarts the count -- handing out a whole fresh cap on exactly the
    // machine that cannot tell how much of the old one was spent. Only "it is
    // not there" means "no ledger". Driven with a DIRECTORY at the ledger's own
    // path, which reproduces the class (EISDIR) without needing chmod, and so
    // behaves the same on every CI lane including the one running as root.
    const root = repo();
    mkdirSync(join(root, ".nen", "loop", "sweep.json"), { recursive: true });
    const result = await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], {
      repoFlag: root,
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("could not be read");
    expect(result.err.join("\n")).toContain("a whole cap's worth of iterations");
  });

  it("refuses a ledger whose numbers are not meaningful", async () => {
    const root = repo();
    await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], { repoFlag: root });
    const at = join(root, ".nen", "loop", "sweep.json");
    const stored = JSON.parse(readFileSync(at, "utf8")) as Record<string, unknown>;
    writeFileSync(at, JSON.stringify({ ...stored, iterations: 99 }), "utf8");
    const result = await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], {
      repoFlag: root,
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("is not a 'nen.loop.iterate/v0.1' ledger");
  });
});
