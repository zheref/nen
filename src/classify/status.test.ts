import { describe, expect, it } from "vitest";
import type { ScriptedCall } from "../seam/scripted.js";
import { classifyLabels, summarize } from "./status.js";
import { loadClassifyTaxonomy } from "./taxonomy.js";
import { capture, gh, issueCall, landedRepo, MINI, MINI_LABELS, SLUG, tmpRepo } from "./fixtures/harness.js";

const status = (repo: string, ...rest: string[]): string[] => [
  "classify", "status", "--taxonomy", MINI, "--repo", repo, "--target", SLUG, ...rest,
];

const labelList = (names: readonly string[]): ScriptedCall => ({
  match: gh("label", "list", "--repo", SLUG, "--limit", "500", "--json", "name,color,description"),
  result: { stdout: JSON.stringify(names.map((name): { name: string } => ({ name }))) },
});
const ALL_ON_GITHUB = labelList(MINI_LABELS.map((label): string => label.name));

const openPage = (page: number, items: readonly unknown[]): ScriptedCall => ({
  match: gh("api", "--method", "GET", `repos/${SLUG}/issues?state=open&per_page=100&page=${page}`),
  result: { stdout: JSON.stringify(items) },
});
const rawIssue = (number: number, labels: readonly string[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  number,
  title: `Issue ${number}`,
  labels: labels.map((name): { name: string } => ({ name })),
  ...extra,
});

describe("classifyLabels -- sorts labels by axis", () => {
  const taxonomy = loadClassifyTaxonomy("/", MINI);

  it("keys per axis, unknown for an axis prefix the taxonomy lacks, missing for an empty axis", () => {
    expect(classifyLabels(taxonomy, 1, "t", ["bug", "lang/alpha", "lang/beta", "job/gone"])).toEqual({
      number: 1,
      title: "t",
      labels: ["bug", "lang/alpha", "lang/beta", "job/gone"],
      lang: ["alpha", "beta"],
      job: [],
      unknown: ["job/gone"],
      missing: ["job"],
      classified: false,
    });
  });

  it("is classified only with both axes populated", () => {
    expect(classifyLabels(taxonomy, 1, "t", ["lang/alpha", "job/build"]).classified).toBe(true);
    expect(classifyLabels(taxonomy, 1, "t", []).missing).toEqual(["lang", "job"]);
  });

  it("summarises totals and per-axis gaps", () => {
    const issues = [
      classifyLabels(taxonomy, 1, "", ["lang/alpha", "job/build"]),
      classifyLabels(taxonomy, 2, "", ["lang/alpha"]),
      classifyLabels(taxonomy, 3, "", ["job/test"]),
      classifyLabels(taxonomy, 4, "", []),
    ];
    expect(summarize(issues)).toEqual({ total: 4, classified: 1, missingLang: 2, missingJob: 2, missingBoth: 1 });
  });
});

describe("nen classify status --issue", () => {
  it("prints one row per issue, then the summary and the two install lines", async () => {
    const result = await capture(
      status(landedRepo(), "--issue", "12,13,14"),
      [
        issueCall(12, ["bug", "lang/alpha", "lang/beta", "job/build"]),
        issueCall(13, ["lang/alpha", "job/retired"]),
        issueCall(14, []),
        ALL_ON_GITHUB,
      ],
    );
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "#12  lang: alpha,beta  job: build  missing: -",
      "#13  lang: alpha  job: -  missing: job  unknown: job/retired",
      "#14  lang: -  job: -  missing: lang,job",
      "3 issue(s): 1 classified, missing lang: 1, missing job: 2, missing both: 1",
      "declared: ok",
      "github: ok",
    ]);
  });

  it("--json carries the contract, rows, summary, and both verdicts", async () => {
    const result = await capture(
      status(landedRepo(), "--issue", "12", "--json"),
      [issueCall(12, ["lang/alpha", "job/build"]), ALL_ON_GITHUB],
    );
    expect(result.code).toBe(0);
    const json = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(json).toEqual({
      contract: "nen.classify.status/v0.1",
      target: SLUG,
      truncated: false,
      issues: [
        {
          number: 12,
          title: "Issue 12",
          labels: ["lang/alpha", "job/build"],
          lang: ["alpha"],
          job: ["build"],
          unknown: [],
          missing: [],
          classified: true,
        },
      ],
      summary: { total: 1, classified: 1, missingLang: 0, missingJob: 0, missingBoth: 0 },
      declared: { status: "ok", missing: [] },
      github: { status: "ok", missing: [], truncated: false },
    });
  });

  it("reports declared 'missing <n>' when the declaration lacks labels, and github 'missing <n>' naming them", async () => {
    const result = await capture(
      status(tmpRepo({ labels: MINI_LABELS.slice(0, 3) }), "--issue", "12"),
      [issueCall(12, []), labelList(["lang/alpha", "job/build"])],
    );
    expect(result.code).toBe(0);
    expect(result.out.slice(-2)).toEqual([
      "declared: missing 1 (job/test)",
      "github: missing 2 (lang/beta, job/test)",
    ]);
  });

  it("exits 0 for a status that finds everything unclassified -- it is an answer", async () => {
    const result = await capture(status(landedRepo(), "--issue", "12"), [issueCall(12, []), labelList([])]);
    expect(result.code).toBe(0);
  });

  it("refuses a number that names a pull request, at exit 1", async () => {
    const result = await capture(
      status(landedRepo(), "--issue", "12,13"),
      [issueCall(12, []), issueCall(13, [], { pull_request: { url: "https://example.test/pr/13" } })],
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/#13 names a pull request/);
    expect(result.out).toEqual([]);
  });

  it("exits 1 when gh fails reading an issue, and when it fails listing labels", async () => {
    const read = await capture(status(landedRepo(), "--issue", "12"), [
      { match: gh("api", `repos/${SLUG}/issues/12`), result: { code: 1, stderr: "HTTP 404" } },
    ]);
    expect(read.code).toBe(1);
    expect(read.err.join("\n")).toMatch(/could not read zheref\/nen#12/);

    const list = await capture(status(landedRepo(), "--issue", "12"), [
      issueCall(12, []),
      { match: gh("label", "list", "--repo", SLUG, "--limit", "500", "--json", "name,color,description"), result: { code: 1, stderr: "rate limited" } },
    ]);
    expect(list.code).toBe(1);
  });

  it("refuses a malformed list at exit 2", async () => {
    for (const bad of ["abc", "0", "1,,x", ","]) {
      expect((await capture(status(landedRepo(), "--issue", bad))).code, bad).toBe(2);
    }
  });
});

describe("nen classify status --open", () => {
  it("pages to the end, filters out pull requests, and says nothing was truncated", async () => {
    const first = Array.from({ length: 100 }, (_, index): Record<string, unknown> =>
      index === 5
        ? rawIssue(1000 + index, ["lang/alpha"], { pull_request: { url: "x" } })
        : rawIssue(1000 + index, index === 0 ? ["lang/alpha", "job/build"] : []),
    );
    const second = [rawIssue(2000, ["job/test"]), rawIssue(2001, [], { pull_request: null })];
    const result = await capture(status(landedRepo(), "--open", "--json"), [openPage(1, first), openPage(2, second), ALL_ON_GITHUB]);
    expect(result.code).toBe(0);
    const json = JSON.parse(result.out.join("\n")) as { issues: { number: number }[]; summary: Record<string, number>; truncated: boolean };
    expect(json.issues).toHaveLength(101);
    expect(json.issues.map((issue): number => issue.number)).not.toContain(1005);
    expect(json.summary).toEqual({ total: 101, classified: 1, missingLang: 100, missingJob: 99, missingBoth: 99 });
    expect(json.truncated).toBe(false);
    expect(result.seams.calls.filter((call): boolean => call.args[0] === "api")).toHaveLength(2);
  });

  it("says so, loudly, when the page ceiling truncated the list", async () => {
    const full = Array.from({ length: 100 }, (_, index): Record<string, unknown> => rawIssue(index + 1, []));
    // The same scripted page answers every request, so the walk reaches its ceiling.
    const result = await capture(status(landedRepo(), "--open"), [
      { match: gh("api", "--method", "GET", `repos/${SLUG}/issues?state=open&per_page=100&page=1`), result: { stdout: JSON.stringify(full) } },
      ...Array.from({ length: 199 }, (_, index): ScriptedCall => openPage(index + 2, full)),
      ALL_ON_GITHUB,
    ]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/TRUNCATED at a defensive page ceiling/);
  });

  it("flags a label list that came back at its limit", async () => {
    const names = Array.from({ length: 500 }, (_, index): string => `l${index}`);
    const result = await capture(status(landedRepo(), "--open"), [openPage(1, []), labelList(names)]);
    expect(result.out.at(-1)).toMatch(/hit its 500 limit and may be incomplete/);
  });

  it("human output: a row for a labelled-and-unlabelled mix, using the open list's own label objects", async () => {
    const result = await capture(status(landedRepo(), "--open"), [
      openPage(1, [rawIssue(7, ["lang/beta", "job/test"]), rawIssue(8, ["bug"])]),
      ALL_ON_GITHUB,
    ]);
    expect(result.out.slice(0, 2)).toEqual([
      "#7  lang: beta  job: test  missing: -",
      "#8  lang: -  job: -  missing: lang,job",
    ]);
  });
});

describe("nen classify status --with-body", () => {
  const payloadFor = (number: number, extra: Record<string, unknown>): Record<string, unknown> =>
    rawIssue(number, ["lang/alpha"], extra);

  it("--issue: each issue carries body and commentCount from the issues/{n} read already made -- no extra call", async () => {
    const result = await capture(
      status(landedRepo(), "--issue", "12,13", "--with-body", "--json"),
      [issueCall(12, ["lang/alpha"], { body: "Fix the thing.", comments: 3 }), issueCall(13, [], { body: null }), ALL_ON_GITHUB],
    );
    expect(result.code).toBe(0);
    const json = JSON.parse(result.out.join("\n")) as { issues: Record<string, unknown>[] };
    expect(json.issues[0]).toMatchObject({ number: 12, body: "Fix the thing.", commentCount: 3 });
    expect(json.issues[1]).toMatchObject({ number: 13, body: "", commentCount: 0 });
    expect(Object.keys(json.issues[0] as object)).toEqual([
      "number", "title", "labels", "lang", "job", "unknown", "missing", "classified", "body", "commentCount",
    ]);
    // One read per issue plus the label list: nothing more.
    expect(result.seams.calls.map((call): string => call.args.join(" "))).toEqual([
      `api repos/${SLUG}/issues/12`,
      `api repos/${SLUG}/issues/13`,
      "label list --repo zheref/nen --limit 500 --json name,color,description",
    ]);
  });

  it("--open: body and commentCount come from the list payload", async () => {
    const result = await capture(status(landedRepo(), "--open", "--with-body", "--json"), [
      openPage(1, [payloadFor(7, { body: "Seven", comments: 2 }), payloadFor(8, { body: null }), payloadFor(9, {})]),
      ALL_ON_GITHUB,
    ]);
    const json = JSON.parse(result.out.join("\n")) as { issues: Record<string, unknown>[] };
    expect(json.issues.map((issue): unknown => [issue["body"], issue["commentCount"]])).toEqual([
      ["Seven", 2],
      ["", 0],
      ["", 0],
    ]);
  });

  it("without the flag the output is unchanged: no body or commentCount key, though the payload carries them", async () => {
    const withPayload = [issueCall(12, ["lang/alpha"], { body: "Fix the thing.", comments: 3 }), ALL_ON_GITHUB];
    const plain = await capture(status(landedRepo(), "--issue", "12", "--json"), withPayload);
    const issue = (JSON.parse(plain.out.join("\n")) as { issues: Record<string, unknown>[] }).issues[0] as Record<string, unknown>;
    expect("body" in issue).toBe(false);
    expect("commentCount" in issue).toBe(false);

    const open = await capture(status(landedRepo(), "--open", "--json"), [openPage(1, [payloadFor(7, { body: "x", comments: 1 })]), ALL_ON_GITHUB]);
    expect(open.out.join("\n")).not.toMatch(/"body"|"commentCount"/);
  });

  it("leaves the human rows exactly as they were", async () => {
    const withFlag = await capture(status(landedRepo(), "--issue", "12", "--with-body"), [issueCall(12, ["lang/alpha"], { body: "b", comments: 1 }), ALL_ON_GITHUB]);
    const without = await capture(status(landedRepo(), "--issue", "12"), [issueCall(12, ["lang/alpha"], { body: "b", comments: 1 }), ALL_ON_GITHUB]);
    expect(withFlag.out).toEqual(without.out);
  });

  it("still refuses a pull request under --with-body", async () => {
    const result = await capture(status(landedRepo(), "--issue", "13", "--with-body"), [issueCall(13, [], { pull_request: {} })]);
    expect(result.code).toBe(1);
  });
});

describe("nen classify status -- human output is plain text", () => {
  it("strips terminal control bytes from a label name GitHub holds, and keeps them raw in --json", async () => {
    const ESC = String.fromCharCode(0x1b);
    const hostile = `job/gone${ESC}[2K`;
    const script = [issueCall(12, ["lang/alpha", hostile]), ALL_ON_GITHUB];
    const human = await capture(status(landedRepo(), "--issue", "12"), script);
    expect(human.out.join("\n")).toContain("unknown: job/gone[2K");
    expect(human.out.join("\n")).not.toContain(ESC);
    const json = await capture(status(landedRepo(), "--issue", "12", "--json"), script);
    expect((JSON.parse(json.out.join("\n")) as { issues: { unknown: string[] }[] }).issues[0]?.unknown).toEqual([hostile]);
  });

  it("strips them from gh's diagnostic when an issue cannot be read", async () => {
    const ESC = String.fromCharCode(0x1b);
    const result = await capture(status(landedRepo(), "--issue", "12"), [
      { match: gh("api", `repos/${SLUG}/issues/12`), result: { code: 1, stderr: `HTTP 404${ESC}[2K` } },
    ]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).not.toContain(ESC);
  });
});

describe("nen classify status -- usage", () => {
  it("needs exactly one of --issue and --open, a --target and a --repo", async () => {
    const repo = landedRepo();
    expect((await capture(status(repo))).code).toBe(2);
    expect((await capture(status(repo, "--issue", "1", "--open"))).code).toBe(2);
    expect((await capture(["classify", "status", "--taxonomy", MINI, "--repo", repo, "--open"])).code).toBe(2);
    expect((await capture(["classify", "status", "--taxonomy", MINI, "--target", SLUG, "--open"])).code).toBe(2);
  });
});
