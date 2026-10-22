// src/stage/check.test.ts -- `nen stage check --exclusive`: at most one
// stage-family label on an issue, the family read from nen/labels.json.

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { parseTarget } from "../github/target.js";
import { loadLabelTaxonomy } from "../schema/labels.js";
import { stageCommand } from "./command.js";
import { checkExclusive, stageFamily } from "./check.js";

const BANKAI = join(process.cwd(), "src", "schema", "fixtures", "bankai-repo");
const target = parseTarget("o/r");

describe("checkExclusive", () => {
  const family = ["x:stage/idea", "x:stage/building"];

  it("is exclusive with one stage label, or none", () => {
    expect(checkExclusive(target, 7, family, { ok: true, labels: ["bug", "x:stage/idea"] }).verdict).toBe("exclusive");
    expect(checkExclusive(target, 7, family, { ok: true, labels: ["bug"] }).verdict).toBe("exclusive");
  });

  it("is a conflict with two, naming both and picking neither", () => {
    const report = checkExclusive(target, 7, family, { ok: true, labels: ["x:stage/idea", "x:stage/building"] });
    expect(report.verdict).toBe("conflict");
    expect(report.present).toEqual(["x:stage/idea", "x:stage/building"]);
    expect(report.reason).toMatch(/not nen's to pick/);
  });

  it("counts an undeclared stage-shaped label, so a retired stage cannot hide a second one", () => {
    const report = checkExclusive(target, 7, family, { ok: true, labels: ["x:stage/idea", "y:stage/old"] });
    expect(report.verdict).toBe("conflict");
    expect(report.undeclaredPresent).toEqual(["y:stage/old"]);
  });

  it("is undeclared when the taxonomy has no stage family, and unread when gh failed -- never exclusive", () => {
    expect(checkExclusive(target, 7, [], { ok: true, labels: [] }).verdict).toBe("undeclared");
    expect(checkExclusive(target, 7, family, { ok: false, reason: "gh exit 1" }).verdict).toBe("unread");
  });

  it("reads the family structurally from nen/labels.json, whatever the namespace", () => {
    const names = stageFamily(loadLabelTaxonomy(BANKAI));
    expect(names.length).toBeGreaterThan(1);
    expect(names.every((name): boolean => /^[^:]+:stage\/.+/.test(name))).toBe(true);
  });
});

describe("nen stage check (CLI)", () => {
  async function capture(argv: readonly string[], labels: readonly string[] | null, json = false, repo = BANKAI): Promise<{ code: number; out: string[]; err: string[]; calls: string[][] }> {
    const out: string[] = [];
    const err: string[] = [];
    const calls: string[][] = [];
    const io: Io = { out: (l): void => void out.push(l), err: (l): void => void err.push(l) };
    const seams: Seams = {
      run: (command, args): CommandResult => {
        calls.push([command, ...args]);
        if (labels === null) return { code: 1, stdout: "", stderr: "HTTP 404", spawnFailed: false };
        return { code: 0, stdout: JSON.stringify({ number: Number(args[2]), labels: labels.map((name) => ({ name })) }), stderr: "", spawnFailed: false };
      },
      now: (): Date => new Date("2026-10-22T00:00:00Z"),
      env: {},
      probePort: noPortProbe,
      runInteractive: (): never => {
        throw new Error("none");
      },
      runStreamed: (): never => {
        throw new Error("none");
      },
      platform: "linux",
    };
    const code = await runFamily(stageCommand, argv, repo, json, io, seams);
    return { code, out, err, calls };
  }

  it("exits 0 on one stage and 1 when two coexist, reading the issue's live labels", async () => {
    const one = await capture(["stage", "check", "--exclusive", "--target", "o/r", "--issue", "7"], ["bankai:stage/idea"]);
    expect(one.code).toBe(0);
    expect(one.out).toEqual(["o/r#7: exclusive", "stage: bankai:stage/idea"]);
    expect(one.calls).toEqual([["gh", "issue", "view", "7", "--repo", "o/r", "--json", "number,labels"]]);
    const two = await capture(["stage", "check", "--exclusive", "--target", "o/r", "--issue", "7"], ["bankai:stage/idea", "bankai:stage/building"], true);
    expect(two.code).toBe(1);
    const doc = JSON.parse(two.out.join("\n"));
    expect(Object.keys(doc)).toEqual(["target", "issue", "verdict", "family", "present", "undeclaredPresent", "reason"]);
    expect(doc.verdict).toBe("conflict");
  });

  it("exits 1 when the issue could not be read", async () => {
    const result = await capture(["stage", "check", "--exclusive", "--target", "o/r", "--issue", "7"], null);
    expect(result.code).toBe(1);
    expect(result.out[0]).toMatch(/^o\/r#7: unread -- HTTP 404/);
  });

  it("refuses without --exclusive, a malformed target or issue, and triage's flags, at exit 2", async () => {
    expect((await capture(["stage", "check", "--target", "o/r", "--issue", "7"], [])).code).toBe(2);
    expect((await capture(["stage", "check", "--exclusive", "--target", "nope", "--issue", "7"], [])).code).toBe(2);
    expect((await capture(["stage", "check", "--exclusive", "--target", "o/r", "--issue", "x"], [])).code).toBe(2);
    expect((await capture(["stage", "check", "--exclusive", "--target", "o/r", "--issue", "7", "--nul"], [])).code).toBe(2);
    expect((await capture(["stage", "triage", "--exclusive"], [])).code).toBe(2);
    expect((await capture(["stage", "list", "--issue", "7"], [])).code).toBe(2);
  });
});
