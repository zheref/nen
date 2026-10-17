// zheref/nen#410: `nen report data --label/--severity`, and `filterEfforts`.
import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { reportCommand } from "./command.js";
import { filterEfforts, type IssueObject, type PrObject, type ReportObject } from "./objects.js";

const FIELD = "\u001f";
const LOG_FORMAT = `%H${FIELD}%s${FIELD}%an${FIELD}%aI`;
const FIXTURE = join(process.cwd(), "src", "schema", "fixtures", "shu-coverage-repo");

function script(): ScriptedCall[] {
  return [
    { match: "git rev-parse --verify --quiet main^{commit}", result: { code: 0, stdout: "0123456789abcdef\n" } },
    { match: "git symbolic-ref --short HEAD", result: { code: 0, stdout: "feat/register\n" } },
    { match: `git log main..HEAD --format=${LOG_FORMAT}`, result: { code: 0, stdout: "" } },
    { match: "git diff --name-status main...HEAD", result: { code: 0, stdout: "" } },
    { match: "git remote get-url origin", result: { code: 0, stdout: "https://github.com/zheref/nen.git\n" } },
    { match: "git rev-parse --path-format=absolute --git-dir --git-common-dir --show-toplevel", result: { code: 0, stdout: "/w/.git\n/w/.git\n/w\n" } },
    { match: "git rev-parse --verify --quiet refs/remotes/origin/feat/register", result: { code: 1, stdout: "" } },
    { match: "git rev-parse --verify --quiet HEAD", result: { code: 0, stdout: "0000000000000000000000000000000000000000\n" } },
  ];
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-report-filter-"));
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(
    join(dir, "nen", "labels.json"),
    JSON.stringify({
      labels: ["lang/typescript", "model/gpt", "A&B", "acme:sev/high", "acme:sev/low"].map((name): unknown => ({
        name,
        color: "ededed",
        description: `the ${name} label`,
      })),
    }),
  );
  return dir;
}

const issue = (number: number, labels: string[], linked: number[] = []): IssueObject => ({
  kind: "issue", number, title: `issue ${number}`, url: `https://github.com/o/r/issues/${number}`, state: "OPEN", labels, linked, readiness: null, notes: [],
});
const pr = (number: number, labels: string[], linked: number[] = []): PrObject => ({
  kind: "pr", number, title: `pr ${number}`, url: `https://github.com/o/r/pull/${number}`, state: "OPEN", labels,
  head: "a".repeat(40), mergeStateStatus: "CLEAN", checks: { total: 0, green: 0, red: 0, pending: 0 },
  threads: { total: 0, unresolved: 0 }, reviewRequests: [], linked, readiness: null, notes: [],
});

const OBJECTS: readonly ReportObject[] = [
  issue(1, ["lang/typescript"], [5]),
  issue(2, ["lang/typescript", "acme:sev/high"]),
  issue(3, ["acme:sev/low"]),
  pr(5, ["model/gpt"], [1]),
  pr(9, ["model/gpt"]),
];
const numbers = (objects: readonly ReportObject[]): number[] => objects.map((object): number => object.number);
const every = (wanted: string[]) => (labels: readonly string[]): boolean => wanted.every((label): boolean => labels.includes(label));

describe("filterEfforts", () => {
  it("keeps every object of a kept effort, over the members' labels unioned", () => {
    expect(numbers(filterEfforts(OBJECTS, every(["lang/typescript", "model/gpt"])))).toEqual([1, 5]);
  });

  it("a lone PR is its own effort", () => {
    expect(numbers(filterEfforts(OBJECTS, every(["model/gpt"])))).toEqual([1, 5, 9]);
  });

  it("drops a PR whose only effort was dropped", () => {
    expect(numbers(filterEfforts(OBJECTS, every(["acme:sev/high"])))).toEqual([2]);
  });

  it("keeps a PR linked to two issues when either effort is kept, and reads a link from either side", () => {
    const objects = [issue(1, ["model/gpt"]), issue(2, []), pr(7, [], [1, 2]), issue(3, [], [8]), pr(8, ["model/gpt"])];
    expect(numbers(filterEfforts(objects, every(["model/gpt"])))).toEqual([1, 7, 3, 8]);
  });
});

async function data(extra: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const dir = repo();
  const objectsPath = join(dir, "objects.json");
  writeFileSync(objectsPath, JSON.stringify(OBJECTS.map((row): unknown => Object.fromEntries(Object.entries(row).filter(([key]): boolean => key !== "notes")))));
  const argv = ["report", "data", "--repo", dir, "--base", "main", ...extra.map((part): string => (part === "@objects" ? objectsPath : part))];
  const seams = new ScriptedSeams(script(), { now: (): Date => new Date("2026-09-20T12:00:00.000Z"), platform: "linux" });
  const code = await runFamily(reportCommand, argv, null, false, io, seams);
  return { code, out, err };
}

describe("nen report data --label / --severity", () => {
  it("filters the register by effort and appends objectsFilter at the end", async () => {
    const result = await data(["--objects-from", "@objects", "--label", "lang/typescript", "--label", "model/gpt", "--json"]);
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(numbers(document["objects"] as ReportObject[])).toEqual([1, 5]);
    const keys = Object.keys(document);
    expect(keys[keys.length - 1]).toBe("objectsFilter");
    expect(document["objectsFilter"]).toMatchObject({ labels: ["lang/typescript", "model/gpt"], severity: null, kept: 2, of: 5 });
    expect(result.err.join("\n")).toMatch(/filter: label lang\/typescript AND model\/gpt -- kept 2 of 5 object\(s\)/);
  });

  it("selects a severity band with '+'", async () => {
    const result = await data(["--objects-from", "@objects", "--severity", "low+", "--severity-family", "acme:sev", "--severity-order", "high,low", "--json"]);
    expect(numbers((JSON.parse(result.out.join("\n")) as { objects: ReportObject[] }).objects)).toEqual([2, 3]);
  });

  it("names the filter in the human output", async () => {
    const result = await data(["--objects-from", "@objects", "--label", "model/gpt"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/filter: label model\/gpt -- kept 3 of 5 object\(s\)/);
  });

  it("refuses a filter with no objects to filter", async () => {
    const result = await data(["--label", "model/gpt"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/none of --target\/--prs\/--issues\/--backlog\/--objects-from names any/);
  });

  it("refuses an undeclared label, and a piece of an '&' label by name", async () => {
    expect((await data(["--objects-from", "@objects", "--label", "nope"])).err.join("\n")).toMatch(/'nope' is not declared/);
    const piece = await data(["--objects-from", "@objects", "--label", "B"]);
    expect(piece.code).toBe(2);
    expect(piece.err.join("\n")).toMatch(/labels containing '&' are not supported in selectors/);
  });

  it("refuses --label on 'report render'", async () => {
    const result = await data(["--label", "model/gpt"].map((part): string => part));
    expect(result.code).toBe(2);
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const seams = new ScriptedSeams([], { now: (): Date => new Date(0), platform: "linux" });
    const code = await runFamily(reportCommand, ["report", "render", "--label", "x", "--template", "t", "--data", "d", "--out", "o"], null, false, io, seams);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--label is not read by 'report render'/);
  });
});
