// src/scorecard/command.test.ts -- `nen scorecard trend|snapshot` end to end
// over scripted `gh` answers and a catalogue on disk (zheref/hatsu#619).
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { mergedPullsArgv, PULL_LIMIT, scorecardCommand } from "./command.js";
import { parseWeek, weeksThrough } from "./scorecard.js";

const scratch = mkdtempSync(join(tmpdir(), "nen-scorecard-"));
afterAll((): void => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

const NOW = new Date("2026-11-21T12:00:00Z"); // a Saturday in 2026-W47
const ASPECTS = ["Observability", "Security", "Traceability"];

function repo(aspects: readonly string[] = ASPECTS): string {
  const root = join(scratch, `r-${++n}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "pr-sections.json"), JSON.stringify({ contract: "hatsu.pr-sections/v1", aspects }));
  return root;
}

const body = (rows: Readonly<Record<string, string>>): string => ["| Aspect | Delta | Why it moves |", "|---|---|---|", ...Object.entries(rows).map(([a, d]) => `| ${a} | ${d} | |`)].join("\n");
const pulls = (rows: readonly { number: number; mergedAt: string; body: string | null }[]): string => JSON.stringify(rows.map((row) => ({ title: `t${row.number}`, url: `u${row.number}`, ...row })));
const call = (target: string, weeks: readonly string[], stdout: string, code = 0, stderr = ""): ScriptedCall => ({
  match: `gh ${mergedPullsArgv(target, weeks.map((id) => parseWeek(id)!)).join(" ")}`,
  result: { stdout, code, stderr },
});

async function run(root: string, argv: readonly string[], script: readonly ScriptedCall[], json = false): Promise<{ code: number; out: string; err: string; seams: ScriptedSeams }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l): void => void out.push(l), err: (l): void => void err.push(l) };
  const seams = new ScriptedSeams(script, { now: (): Date => NOW });
  const code = await runFamily(scorecardCommand, ["scorecard", ...argv], root, json, io, seams);
  return { code, out: out.join("\n"), err: err.join("\n"), seams };
}

const W46 = ["2026-W46"];
const W45_46 = ["2026-W45", "2026-W46"];

describe("nen scorecard trend", () => {
  it("reads every repository's merged PRs with gh pr list only, and writes nothing (zheref/hatsu#619/AC-1)", async () => {
    const root = repo();
    const result = await run(root, ["trend", "--catalogue", "pr-sections.json", "--target", "o/a,o/b", "--weeks", "2"], [
      call("o/a", W45_46, pulls([{ number: 1, mergedAt: "2026-11-10T00:00:00Z", body: body({ Observability: "⬆", Security: "⬇" }) }])),
      call("o/b", W45_46, pulls([{ number: 4, mergedAt: "2026-11-03T00:00:00Z", body: null }])),
    ], true);
    expect(result.code).toBe(0);
    expect(result.seams.calls).toHaveLength(2);
    for (const recorded of result.seams.calls) expect(recorded.args.slice(0, 4)).toEqual(["pr", "list", "--repo", recorded.args[3]]);
    expect(result.seams.calls.every((recorded) => recorded.command === "gh" && recorded.args.includes("merged"))).toBe(true);
    const trend = JSON.parse(result.out) as { contract: string; weeks: string[]; repositories: { repository: string; aspects: { aspect: string; tallies: { net: number | null }[] }[] }[] };
    expect(Object.keys(trend)).toEqual(["contract", "catalogue", "weeks", "repositories"]);
    expect(trend.contract).toBe("nen.scorecard.trend/v0.1");
    expect(trend.weeks).toEqual(W45_46);
    expect(trend.repositories[0]!.aspects.map((row) => [row.aspect, row.tallies.map((t) => t.net)])).toEqual([
      ["Observability", [null, 1]],
      ["Security", [null, -1]],
      ["Traceability", [null, null]],
    ]);
    expect(trend.repositories[1]!.aspects.every((row) => row.tallies.every((t) => t.net === null))).toBe(true);
  });

  it("takes the aspects and their order from the catalogue file at run time (zheref/hatsu#619/AC-3)", async () => {
    const root = repo(["Traceability", "Cost"]);
    const result = await run(root, ["trend", "--catalogue", "pr-sections.json", "--target", "o/a", "--weeks", "1"], [
      call("o/a", W46, pulls([{ number: 2, mergedAt: "2026-11-18T00:00:00Z", body: "" }, { number: 1, mergedAt: "2026-11-11T00:00:00Z", body: body({ Cost: "⬇", Traceability: "⬆", Observability: "⬆" }) }])),
    ]);
    expect(result.code).toBe(0);
    const rows = result.out.split("\n").filter((line) => /^(Traceability|Cost|Observability)\b/.test(line));
    expect(rows).toEqual(["Traceability  +1", "Cost          -1"]);
  });

  it("prints a review page with every aspect for every repository, the running week marked (zheref/hatsu#619/AC-2)", async () => {
    const root = repo();
    const result = await run(root, ["trend", "--catalogue", "pr-sections.json", "--target", "o/a", "--weeks", "2", "--through", "current", "--markdown"], [
      call("o/a", ["2026-W46", "2026-W47"], pulls([{ number: 7, mergedAt: "2026-11-20T21:00:00Z", body: body({ Security: "⬆" }) }])),
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("## o/a");
    expect(result.out).toContain("| Aspect | 2026-W46 | 2026-W47 (running) |");
    for (const aspect of ASPECTS) expect(result.out).toMatch(new RegExp(`^\\| ${aspect} \\|`, "m"));
    expect(result.out).toContain("| Security | · | **+1** (1/0/0) |");
  });

  it("exits 1 naming a repository gh could not read, and still reports the others", async () => {
    const root = repo();
    const result = await run(root, ["trend", "--catalogue", "pr-sections.json", "--target", "o/a,o/gone", "--weeks", "1"], [
      call("o/a", W46, "[]"),
      call("o/gone", W46, "", 1, "GraphQL: Could not resolve to a Repository"),
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("o/a · 0 merged PR(s), 0 scored");
    expect(result.out).toContain("o/gone · could-not-read: gh pr list exited 1: GraphQL: Could not resolve to a Repository");
  });

  it.each([
    ["not JSON", "nope", "not JSON"],
    ["rows without mergedAt", JSON.stringify([{ number: 1, body: "" }]), "without a number"],
    ["a full page", JSON.stringify(Array.from({ length: PULL_LIMIT }, (_, i) => ({ number: i + 1, mergedAt: "2026-11-10T00:00:00Z", body: "" }))), "ceiling"],
  ])("reads %s as could-not-read, never an empty row", async (_, stdout, reason) => {
    const root = repo();
    const result = await run(root, ["trend", "--catalogue", "pr-sections.json", "--target", "o/a", "--weeks", "1"], [call("o/a", W46, stdout)]);
    expect(result.code).toBe(1);
    expect(result.out).toContain(reason);
  });

  it("names gh missing as could-not-read", async () => {
    const root = repo();
    const result = await run(root, ["trend", "--catalogue", "pr-sections.json", "--target", "o/a", "--weeks", "1"], [{ match: `gh ${mergedPullsArgv("o/a", [parseWeek("2026-W46")!]).join(" ")}`, result: { spawnFailed: true } }]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("'gh' could not be started");
  });

  it.each([
    [["trend", "--target", "o/a"], "--catalogue"],
    [["trend", "--catalogue", "missing.json", "--target", "o/a"], "could not be read"],
    [["trend", "--catalogue", "pr-sections.json"], "--target"],
    [["trend", "--catalogue", "pr-sections.json", "--target", "nope"], "nope"],
    [["trend", "--catalogue", "pr-sections.json", "--target", "o/a,O/A"], "twice"],
    [["trend", "--catalogue", "pr-sections.json", "--target", "o/a", "--weeks", "0"], "1 to 52"],
    [["trend", "--catalogue", "pr-sections.json", "--target", "o/a", "--through", "2026-11"], "ISO week"],
    [["trend", "--catalogue", "pr-sections.json", "--target", "o/a", "--out", "x"], "writes nothing"],
    [["snapshot", "--catalogue", "pr-sections.json", "--target", "o/a,o/b", "--out", "s"], "ONE repository"],
    [["snapshot", "--catalogue", "pr-sections.json", "--target", "o/a", "--out", "s", "--through", "current"], "completed week"],
    [["snapshot", "--catalogue", "pr-sections.json", "--target", "o/a", "--out", "s", "--through", "2026-W47"], "has not ended"],
    [["snapshot", "--catalogue", "pr-sections.json", "--target", "o/a", "--out", "s", "--weeks", "2"], "trend's"],
    [["snapshot", "--catalogue", "pr-sections.json", "--target", "o/a"], "--out"],
    [["tally"], "tally"],
  ])("refuses %j at exit 2", async (argv, message) => {
    const root = repo();
    const result = await run(root, argv, []);
    expect(result.code).toBe(2);
    expect(result.err).toContain(message);
  });

  it("refuses a catalogue with no aspects at exit 2", async () => {
    const root = repo([]);
    const result = await run(root, ["trend", "--catalogue", "pr-sections.json", "--target", "o/a"], []);
    expect(result.code).toBe(2);
    expect(result.err).toContain("aspects");
  });
});

describe("nen scorecard snapshot", () => {
  const script = (): ScriptedCall[] => [call("o/a", W46, pulls([{ number: 5, mergedAt: "2026-11-12T00:00:00Z", body: body({ Observability: "⬆", Traceability: "➖" }) }]))];

  it("writes the last completed week once, then reads unchanged on a rerun (zheref/hatsu#619/AC-2)", async () => {
    const root = repo();
    const first = await run(root, ["snapshot", "--catalogue", "pr-sections.json", "--target", "o/a", "--out", "scorecard"], script(), true);
    expect(first.code).toBe(0);
    const report = JSON.parse(first.out) as { path: string; written: string; reason: null; snapshot: { aspects: { aspect: string; net: number | null }[] } };
    expect(Object.keys(report)).toEqual(["path", "written", "reason", "snapshot"]);
    expect(report.written).toBe("created");
    expect(report.path).toBe(join(root, "scorecard", "2026-W46.json"));
    const saved = JSON.parse(readFileSync(report.path, "utf8")) as { repository: string; period: { week: string }; aspects: { aspect: string; net: number | null }[] };
    expect(saved.repository).toBe("o/a");
    expect(saved.period.week).toBe("2026-W46");
    expect(saved.aspects.map((row) => [row.aspect, row.net])).toEqual([["Observability", 1], ["Security", null], ["Traceability", 0]]);
    const again = await run(root, ["snapshot", "--catalogue", "pr-sections.json", "--target", "o/a", "--out", "scorecard"], script());
    expect(again.code).toBe(0);
    expect(again.out).toContain("unchanged:");
    expect(again.out).toContain("  Observability: net 1 (⬆1 ➖0 ⬇0, 0 unrecorded)");
  });

  it("updates a snapshot whose pull requests changed", async () => {
    const root = repo();
    mkdirSync(join(root, "scorecard"));
    writeFileSync(join(root, "scorecard", "2026-W45.json"), "{}\n");
    const result = await run(root, ["snapshot", "--catalogue", "pr-sections.json", "--target", "o/a", "--out", "scorecard", "--through", "2026-W45"], [call("o/a", ["2026-W45"], "[]")]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("updated:");
  });

  it("writes nothing and exits 1 when the repository cannot be read", async () => {
    const root = repo();
    const result = await run(root, ["snapshot", "--catalogue", "pr-sections.json", "--target", "o/a", "--out", "scorecard"], [call("o/a", W46, "", 1, "HTTP 401")], true);
    expect(result.code).toBe(1);
    expect((JSON.parse(result.out) as { written: null; reason: string }).reason).toContain("HTTP 401");
    expect(existsSync(join(root, "scorecard"))).toBe(false);
  });
});

describe("mergedPullsArgv", () => {
  it("widens the search a day each side and leaves exact bucketing to the trend", () => {
    expect(mergedPullsArgv("o/a", weeksThrough(parseWeek("2026-W46")!, 1))).toEqual(["pr", "list", "--repo", "o/a", "--state", "merged", "--search", "merged:2026-11-08..2026-11-16", "--json", "number,title,url,mergedAt,body", "--limit", "1000"]);
  });
});
