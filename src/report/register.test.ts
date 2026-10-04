// src/report/register.test.ts -- `nen report data --register <desk>`: the
// backlog-board § 3 register document, assembled by the verb (zheref/nen#276).
//
// THE END-TO-END HALF RUNS BOTH VERBS, data then render, through the real
// `runFamily` dispatcher against a fixture that is the body of Hatsu's own
// templates/rikugan.html -- so "a register document renders without a
// builder" is proved by a render that would refuse on any token the document
// has not got, rather than by a list of keys somebody remembered.
//
// NO NETWORK. The register is fed through `--objects-from`, and the
// ScriptedSeams throws on any call nobody scripted, so a gh read growing into
// this path is a red test.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { reportCommand } from "./command.js";
import { checkRunsArgv, type ReportObject } from "./objects.js";
import { viewArgv } from "../pr/fetch.js";
import { listArgv } from "../pr/threads.js";
import { parseTarget } from "../github/target.js";
import type { ReportPhase, ReportUsage } from "./data.js";
import {
  assembleRegister,
  formatDuration,
  parseDesk,
  quotedVerdict,
  spendEffort,
  tallies,
  type NotationSource,
} from "./register.js";

const FIELD = "\u001f";
const LOG_FORMAT = `%H${FIELD}%s${FIELD}%an${FIELD}%aI`;
const NOW = new Date("2026-10-04T12:00:00.000Z");
const FIXTURES = join(process.cwd(), "src", "report", "fixtures");

function script(): ScriptedCall[] {
  return [
    { match: "git rev-parse --verify --quiet main^{commit}", result: { code: 0, stdout: "0123456789abcdef\n" } },
    { match: "git symbolic-ref --short HEAD", result: { code: 0, stdout: "feat/register\n" } },
    { match: `git log main..HEAD --format=${LOG_FORMAT}`, result: { code: 0, stdout: "" } },
    { match: "git diff --name-status main...HEAD", result: { code: 0, stdout: "" } },
  ];
}

interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly seams: ScriptedSeams;
}

async function capture(argv: readonly string[], repoFlag: string | null = null, calls: ScriptedCall[] = script()): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push(line),
  };
  const seams = new ScriptedSeams(calls, { now: (): Date => NOW, platform: "linux" });
  const code = await runFamily(reportCommand, argv, repoFlag, false, io, seams);
  return { code, out, err, seams };
}

const PR_READY = {
  kind: "pr",
  number: 87,
  title: "feat(report): the register",
  url: "https://github.com/zheref/hatsu/pull/87",
  state: "OPEN",
  labels: ["hatsu:severity/high", "hatsu:type/feature"],
  head: "2a6539c0000000000000000000000000000000aa",
  mergeStateStatus: "CLEAN",
  checks: { total: 4, green: 4, red: 0, pending: 0 },
  threads: { total: 7, unresolved: 0 },
  reviewRequests: [],
  linked: [85],
  readiness: { verdict: "ready", reason: "ready: CON-32 holds on 2a6539c0 -- 4/4 checks green, 0 unresolved threads", source: "computed" },
  notes: [],
};

const PR_BLOCKED = {
  ...PR_READY,
  number: 90,
  title: "fix: a conflict",
  url: "https://github.com/zheref/hatsu/pull/90",
  mergeStateStatus: "DIRTY",
  checks: { total: 4, green: 3, red: 1, pending: 0 },
  threads: { total: 2, unresolved: 1 },
  linked: [],
  readiness: { verdict: "not-ready", reason: "not-ready: 1 required check red (lint)", source: "check" },
};

const PR_UNREAD = {
  ...PR_READY,
  number: 91,
  title: "chore: pending",
  url: "https://github.com/zheref/hatsu/pull/91",
  checks: { total: 2, green: 1, red: 0, pending: 1 },
  threads: { total: 0, unresolved: 0 },
  linked: [],
  readiness: null,
  notes: ["readiness could not be evaluated: GH_TOKEN is unset"],
};

const ISSUE = {
  kind: "issue",
  number: 85,
  title: "The report register",
  url: "https://github.com/zheref/hatsu/issues/85",
  state: "OPEN",
  labels: [],
  linked: [87],
  readiness: null,
  notes: [],
};

const DESK = {
  variant: "register",
  title: "hatsu@bug -- the register",
  scope: "zheref/hatsu · 4 objects",
  gate: "G2",
  generatedAtLocal: "Sun 4 Oct 2026 · 07:00 America/Bogota (UTC-05:00)",
  footerNote: "Rendered by verbs only.",
  gates: [
    {
      gate: "G2",
      label: "merge",
      asks: [
        {
          kind: "DECIDE",
          rank: 2,
          title: "Rebase or close #90",
          why: "It conflicts with main.",
          options: [
            { letter: "A", label: "Rebase", command: "nen wc squash", consequence: "one more round", star: true },
            { letter: "B", label: "Close", command: "gh pr close 90", consequence: "the fix is lost" },
          ],
        },
        {
          kind: "MERGE",
          rank: 1,
          title: "Merge #87",
          why: "It is Ready.",
          pr: 87,
          options: [{ letter: "A", label: "Merge", command: "gh pr merge 87 --merge", consequence: "lands", star: true }],
          objects: [{ label: "HA-PR-#87", url: "https://github.com/zheref/hatsu/pull/87" }],
        },
      ],
    },
    { gate: "G3", label: "release", cleared: "Nothing is owed at G3 this run.", asks: [] },
  ],
  rows: {
    "pr#87": { marks: "★", gate: "G2", gateClass: "g2", needs: "your merge", session: "kurapika", lane: "enhancement", thought: "clean" },
  },
  legendRows: [{ mark: "★", meaning: "starred by the run" }],
};

/** A temp repository: the objects file, the desk, and optionally a registry and a policy. */
function repo(options: { desk?: unknown; objects?: unknown; registry?: boolean; workflow?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "nen-register-"));
  writeFileSync(join(root, "objects.json"), JSON.stringify(options.objects ?? [ISSUE, PR_READY, PR_BLOCKED, PR_UNREAD]));
  writeFileSync(join(root, "desk.json"), JSON.stringify(options.desk ?? DESK));
  mkdirSync(join(root, "nen"), { recursive: true });
  if (options.registry !== false) {
    writeFileSync(
      join(root, "nen", "repos.json"),
      JSON.stringify({ consumers: [], product_codes: { HA: "zheref/hatsu", NN: "zheref/nen" } }),
    );
  }
  if (options.workflow === true) {
    writeFileSync(
      join(root, "nen", "workflow.json"),
      JSON.stringify({
        reports: {
          sections: {
            final: { template: "rikugan", blocks: ["masthead", "tally", "desk", "register", "spend", "legend"] },
            register: { template: "rikugan", blocks: ["masthead", "tally", "desk", "register", "spend", "legend"] },
          },
        },
      }),
    );
  }
  return root;
}

async function registerDocument(root: string): Promise<{ captured: Captured; document: Record<string, unknown> }> {
  const captured = await capture([
    "report", "data", "--repo", root, "--base", "main",
    "--objects-from", join(root, "objects.json"),
    "--register", join(root, "desk.json"),
    "--json",
  ]);
  const document = captured.code === 0 ? (JSON.parse(captured.out.join("\n")) as Record<string, unknown>) : {};
  return { captured, document };
}

describe("nen report data --register", () => {
  it("appends the register keys AFTER objects, leaving the v0.13 key order untouched", async () => {
    const { captured, document } = await registerDocument(repo());
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const keys = Object.keys(document);
    expect(keys.slice(0, keys.indexOf("objects") + 1)).toEqual([
      "contract", "repo", "branch", "base", "generatedAt", "commits", "files", "evidence",
      "coverage", "proof", "phases", "lastStop", "usage", "objects",
    ]);
    expect(keys.slice(keys.indexOf("objects") + 1)).toEqual([
      "variant", "title", "scope", "gate", "generatedAtLocal", "footerNote", "footerCount",
      "tallyScope", "tallyNeedsYou", "tallyBlockers", "tallyReady", "tallyInFlight",
      "gates", "architectureCaption", "graphJson", "graphMermaid", "graphNodes", "graphEdges",
      "spendEfforts", "legendRows",
    ]);
    // The offline path stays offline.
    expect(captured.seams.calls.every((call): boolean => call.command === "git")).toBe(true);
  });

  it("QUOTES every verdict from the row's readiness, and never invents one", async () => {
    const { document } = await registerDocument(repo());
    const rows = document["objects"] as Record<string, unknown>[];
    const byNumber = new Map(rows.map((row): [number, Record<string, unknown>] => [row["number"] as number, row]));
    expect(byNumber.get(87)?.["verdict"]).toBe(PR_READY.readiness.reason);
    expect(byNumber.get(90)?.["verdict"]).toBe(PR_BLOCKED.readiness.reason);
    // No authority answered: the empty verdict, and the row's note says why.
    expect(byNumber.get(91)?.["verdict"]).toBe("");
    expect(byNumber.get(91)?.["notes"]).toEqual(PR_UNREAD.notes);
    // An issue has no readiness; CON-32 is about pull requests.
    expect(byNumber.get(85)?.["verdict"]).toBe("");
    // The ask that names `pr: 87` quotes that row's verdict; the other is empty.
    const gates = document["gates"] as { asks: { title: string; verdict: string }[] }[];
    const asks = gates[0]?.asks ?? [];
    expect(asks.map((ask): string => ask.title)).toEqual(["Merge #87", "Rebase or close #90"]);
    expect(asks[0]?.verdict).toBe(PR_READY.readiness.reason);
    expect(asks[1]?.verdict).toBe("");
  });

  it("fills every fact column from the row, and the judgement columns from the desk", async () => {
    const { document } = await registerDocument(repo());
    const rows = document["objects"] as Record<string, unknown>[];
    const pr = rows.find((row): boolean => row["number"] === 87) as Record<string, unknown>;
    expect(pr).toMatchObject({
      notation: "HA-PR-#87",
      marks: "★",
      gate: "G2",
      gateClass: "g2",
      needs: "your merge",
      session: "kurapika",
      lane: "enhancement",
      thought: "clean",
      labelsLine: "hatsu:severity/high, hatsu:type/feature",
      checksLine: "4/4 green · 0 red · 0 pending",
      threadsLine: "0/7 unresolved",
      linkedLine: "HA-IS-#85",
      head: PR_READY.head,
      // The offline path says where its verdict came from, on the row.
      notes: ["verdict read from objects.json, not from GitHub"],
    });
    const issue = rows.find((row): boolean => row["number"] === 85) as Record<string, unknown>;
    expect(issue).toMatchObject({
      notation: "HA-IS-#85",
      marks: "",
      gate: "",
      checksLine: "",
      threadsLine: "",
      linkedLine: "HA-PR-#87",
      head: "",
      notes: [],
    });
  });

  it("counts the tallies from facts: ready, blocked, in flight, asks", async () => {
    const { document } = await registerDocument(repo());
    expect(document).toMatchObject({
      tallyScope: 4,
      tallyNeedsYou: 2,
      tallyBlockers: 1,
      tallyReady: 1,
      tallyInFlight: 1,
      footerCount: "4 objects in scope · 2 asks on the desk",
      generatedAtLocal: DESK.generatedAtLocal,
    });
  });

  it("renders stars as the label and class the page expects, and a cleared gate cleared", async () => {
    const { document } = await registerDocument(repo());
    const gates = document["gates"] as { gate: string; cleared: string; asks: { options: { star: string; starredClass: string }[]; objects: unknown[] }[] }[];
    const rebase = gates[0]?.asks[1];
    expect(rebase?.options.map((option): string => option.star)).toEqual(["recommended", ""]);
    expect(rebase?.options.map((option): string => option.starredClass)).toEqual(["starred", ""]);
    // An ask with no objects still CARRIES the list -- or the template's
    // `{{#each objects}}` would reach out to the register's rows.
    expect(rebase?.objects).toEqual([]);
    expect(gates[1]).toMatchObject({ gate: "G3", cleared: "Nothing is owed at G3 this run.", asks: [] });
  });

  it("falls back to <owner>/<name>#<n> with no registry, and says so in footerNote", async () => {
    const { captured, document } = await registerDocument(repo({ registry: false }));
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const rows = document["objects"] as Record<string, unknown>[];
    expect(rows.map((row): unknown => row["notation"])).toEqual([
      "zheref/hatsu#85", "zheref/hatsu#87", "zheref/hatsu#90", "zheref/hatsu#91",
    ]);
    expect(document["footerNote"]).toBe(
      "Rendered by verbs only. Verdicts read from objects.json, not from GitHub. Object notation unresolved for zheref/hatsu (no readable nen/repos.json in --repo); those rows read <owner>/<name>#<n>.",
    );
    // The page never carries the path the registry was looked for at; stderr
    // carries the real reason for the operator.
    expect(String(document["footerNote"])).not.toContain(tmpdir());
    expect(captured.err.join("\n")).toMatch(/register: object notation falls back to <owner>\/<name>#<n>: /);
  });

  it("prints a human register summary without --json", async () => {
    const root = repo();
    const captured = await capture([
      "report", "data", "--repo", root, "--base", "main",
      "--objects-from", join(root, "objects.json"), "--register", join(root, "desk.json"),
    ]);
    expect(captured.code).toBe(0);
    const text = captured.out.join("\n");
    expect(text).toContain("register: register -- hatsu@bug -- the register");
    expect(text).toContain("tally: 4 in scope, 2 need you, 1 blocker(s), 1 ready, 1 in flight");
    expect(text).toContain("G3 release: cleared -- Nothing is owed at G3 this run.");
    expect(text).toContain(`1. MERGE Merge #87  [${PR_READY.readiness.reason}]`);
    expect(text).toContain("HA-PR-#91  (no verdict)");
  });
});

describe("the desk is judgement only -- refusals at exit 2", () => {
  async function refused(desk: unknown): Promise<string> {
    const { captured } = await registerDocument(repo({ desk }));
    expect(captured.code).toBe(2);
    expect(captured.out).toEqual([]);
    return captured.err.join("\n");
  }

  it("refuses a verdict written anywhere in the desk", async () => {
    expect(await refused({ ...DESK, rows: { "pr#87": { verdict: "ready" } } })).toMatch(/rows\['pr#87'\] carries a 'verdict'.*QUOTED/);
    const ask = { ...DESK.gates[0]?.asks[1], verdict: "ready" };
    expect(await refused({ ...DESK, gates: [{ gate: "G2", label: "merge", asks: [ask] }] })).toMatch(/asks\[0\] carries a 'verdict'/);
    expect(await refused({ ...DESK, verdict: "ready" })).toMatch(/the document carries a 'verdict'/);
  });

  it("refuses an ask quoting a pull request the register did not read", async () => {
    const ask = { ...DESK.gates[0]?.asks[1], pr: 400 };
    expect(await refused({ ...DESK, gates: [{ gate: "G2", label: "merge", asks: [ask] }] })).toMatch(/ask 'Merge #87' names 400, which is not in this register's objects/);
  });

  it("refuses a row about an object not in scope", async () => {
    expect(await refused({ ...DESK, rows: { "pr#88": { needs: "x" } } })).toMatch(/row 'pr#88' names 'pr#88', which is not in this register's objects/);
  });

  it("refuses a row key, or a row column, the desk does not write", async () => {
    expect(await refused({ ...DESK, rows: { "x88": {} } })).toMatch(/is not keyed by an object reference/);
    expect(await refused({ ...DESK, rows: { "pr#87": { checksLine: "all green" } } })).toMatch(/names 'checksLine', which the desk does not write/);
  });

  it("refuses two stars, a repeated letter, and an unknown ask kind", async () => {
    const option = { letter: "A", label: "x", command: "y", consequence: "z", star: true };
    const ask = { kind: "DO", rank: 1, title: "t", why: "w", options: [option, { ...option, letter: "B" }] };
    expect(await refused({ ...DESK, gates: [{ gate: "G2", label: "m", asks: [ask] }] })).toMatch(/stars 2 options/);
    const twice = { ...ask, options: [option, { ...option, star: false }] };
    expect(await refused({ ...DESK, gates: [{ gate: "G2", label: "m", asks: [twice] }] })).toMatch(/letters two options 'A'/);
    expect(await refused({ ...DESK, gates: [{ gate: "G2", label: "m", asks: [{ ...ask, kind: "ASK" }] }] })).toMatch(/opens DECIDE, DO, MERGE/);
  });

  it("refuses a gate with nothing owed and nothing said, and a cleared gate with asks", async () => {
    expect(await refused({ ...DESK, gates: [{ gate: "G4", label: "policy", asks: [] }] })).toMatch(/no asks and no 'cleared' line/);
    expect(await refused({ ...DESK, gates: [{ ...DESK.gates[0], cleared: "done" }] })).toMatch(/has asks AND a 'cleared' line/);
  });

  it("refuses a link that is not http(s), mailto, # or /", async () => {
    const ask = { ...DESK.gates[0]?.asks[1], objects: [{ label: "x", url: "javascript:alert(1)" }] };
    expect(await refused({ ...DESK, gates: [{ gate: "G2", label: "merge", asks: [ask] }] })).toMatch(/'javascript:alert\(1\)'/);
  });

  it("refuses a desk that is not an object, and one missing its title", async () => {
    expect(await refused([])).toMatch(/the document is a list, not an object/);
    const untitled: Record<string, unknown> = { ...DESK };
    delete untitled["title"];
    expect(await refused(untitled)).toMatch(/has 'title' of nothing, not a string/);
  });

  it("refuses an empty --register value", async () => {
    const root = repo();
    const captured = await capture([
      "report", "data", "--repo", root, "--base", "main", "--objects-from", join(root, "objects.json"), "--register", " ",
    ]);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--register was given an empty value/);
  });

  it("is refused on 'report render', where it is not read", async () => {
    const captured = await capture(["report", "render", "--register", "desk.json"]);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--register is not read by 'report render'/);
  });
});

describe("render, without a builder (AC 2)", () => {
  for (const variant of ["register", "final"]) {
    it(`fills Hatsu's rikugan body at --variant ${variant} from the verb's document alone`, async () => {
      const root = repo({ workflow: true, desk: { ...DESK, variant } });
      const { captured, document } = await registerDocument(root);
      expect(captured.code, captured.err.join("\n")).toBe(0);
      writeFileSync(join(root, "data.json"), JSON.stringify(document));
      const rendered = await capture(
        [
          "report", "render", "--variant", variant,
          "--template", join(FIXTURES, "rikugan.html"),
          "--data", "data.json", "--out", "Reports/current.html",
        ],
        root,
        [],
      );
      expect(rendered.code, rendered.err.join("\n")).toBe(0);
      const page = readFileSync(join(root, "Reports", "current.html"), "utf8");
      expect(page).toContain(`rikugan &middot; ${variant}`);
      expect(page).toContain("&ldquo;ready: CON-32 holds on 2a6539c0 -- 4/4 checks green, 0 unresolved threads&rdquo;");
      expect(page).toContain('<span class="no">HA-PR-#87</span>');
      expect(page).toContain('<li class="starred">');
      expect(page).toContain("Nothing is owed at G3 this run.");
      expect(page).toContain("<b>4</b><span>in scope</span>");
      // No graph was supplied: the block does not render, and nothing refused.
      expect(page).not.toContain('id="graph-canvas"');
    });
  }
});

// ── the pure halves ─────────────────────────────────────────────────────────

const NO_CODES: NotationSource = { codeFor: (): null => null, slugFor: (): null => null, unavailable: null };

describe("assembleRegister", () => {
  it("resolves notation through the seam, and reads a slug off the URL on the offline path", () => {
    const desk = parseDesk({ ...DESK, rows: {} }, "desk.json");
    const objects = [ISSUE, PR_READY] as unknown as ReportObject[];
    const codes: NotationSource = { codeFor: (slug): string | null => (slug === "zheref/hatsu" ? "HA" : null), slugFor: (): null => null, unavailable: null };
    const register = assembleRegister({ ...desk, gates: [] }, { generatedAt: NOW.toISOString(), objects, phases: [], usage: [], target: null, codes, verdictFile: null });
    expect(register.objects.map((row): string => row.notation)).toEqual(["HA-IS-#85", "HA-PR-#87"]);
    const fallback = assembleRegister({ ...desk, gates: [], footerNote: "" }, { generatedAt: NOW.toISOString(), objects, phases: [], usage: [], target: null, codes: NO_CODES, verdictFile: null });
    expect(fallback.footerNote).toBe("Object notation unresolved for zheref/hatsu (no product code in nen/repos.json); those rows read <owner>/<name>#<n>.");
  });

  it("defaults generatedAtLocal to generatedAt, and blanks a URL that is not a link, naming it", () => {
    const desk = parseDesk({ ...DESK, rows: {}, generatedAtLocal: undefined }, "desk.json");
    const bad = { ...PR_READY, url: "javascript:alert(1)" } as unknown as ReportObject;
    const register = assembleRegister({ ...desk, gates: [] }, { generatedAt: NOW.toISOString(), objects: [bad], phases: [], usage: [], target: "zheref/hatsu", codes: NO_CODES, verdictFile: null });
    expect(register.generatedAtLocal).toBe(NOW.toISOString());
    expect(register.objects[0]?.url).toBe("");
    expect(register.objects[0]?.notes.at(-1)).toMatch(/is not an http\(s\), mailto, # or \/ link/);
  });

  it("uses #<n> when neither a target nor the URL names a repository", () => {
    const desk = parseDesk({ ...DESK, rows: {}, gates: [] }, "desk.json");
    const odd = { ...ISSUE, url: "/local/85" } as unknown as ReportObject;
    const register = assembleRegister(desk, { generatedAt: NOW.toISOString(), objects: [odd], phases: [], usage: [], target: null, codes: NO_CODES, verdictFile: null });
    expect(register.objects[0]?.notation).toBe("#85");
    expect(register.footerNote).toMatch(/unresolved for #85/);
  });
});

describe("quotedVerdict", () => {
  it("is the reason verbatim, the verdict word when the source gave no reason, and '' with no readiness", () => {
    expect(quotedVerdict(PR_READY as unknown as ReportObject)).toBe(PR_READY.readiness.reason);
    expect(quotedVerdict({ ...PR_READY, readiness: { verdict: "ready", reason: "", source: "check" } } as unknown as ReportObject)).toBe("ready");
    expect(quotedVerdict(ISSUE as unknown as ReportObject)).toBe("");
  });
});

describe("tallies", () => {
  it("counts only OPEN pull requests toward ready, blocked and in flight", () => {
    const merged = { ...PR_READY, number: 70, state: "MERGED" };
    const counts = tallies([ISSUE, PR_READY, PR_BLOCKED, PR_UNREAD, merged] as unknown as ReportObject[], []);
    expect(counts).toEqual({ tallyScope: 5, tallyNeedsYou: 0, tallyBlockers: 1, tallyReady: 1, tallyInFlight: 1 });
  });
});

describe("spend", () => {
  it("formats a duration in seconds under a minute and m/ss from one", () => {
    expect(formatDuration(12_340)).toBe("12.3 s");
    expect(formatDuration(245_000)).toBe("4 m 05 s");
  });

  const PHASES: ReportPhase[] = [
    { effort: "e1", phase: "build", startedAt: "", endedAt: "", durationMs: 200_000, exitCode: 0, surface: null, model: null, note: null, steps: [{ verb: "build", argv: "", exitCode: 0, durationMs: 41_200, stalled: false }, { verb: "lint", argv: "", exitCode: 0, durationMs: null, stalled: false }] },
    { effort: "e1", phase: "review", startedAt: "", endedAt: null, durationMs: 50_000, exitCode: null, surface: null, model: null, note: null, steps: [] },
    { effort: "e1", phase: "open", startedAt: "", endedAt: null, durationMs: null, exitCode: null, surface: null, model: null, note: null, steps: [] },
  ];
  const usage = (over: Partial<ReportUsage>): ReportUsage => ({
    effort: "e1", recordedAt: "", surface: "claude-code", model: "opus", input: null, output: null, cacheRead: null, cacheWrite: null, minutes: null, source: null, note: null, notReported: false, ...over,
  });

  it("bars each phase against the longest, and groups usage by surface and model", () => {
    const effort = spendEffort("e1", PHASES, [
      usage({ input: 10, output: 5, source: "/cost" }),
      usage({ input: 1, output: 2, cacheRead: 3, source: "/cost" }),
      usage({ surface: "actions", model: null, minutes: 7, source: "gh actions timing" }),
      usage({ surface: "cursor", model: null, notReported: true }),
      usage({ effort: "other", input: 999 }),
    ], "a note");
    expect(effort.spendPhases).toEqual([
      { lane: "build", percent: "100", amount: "3 m 20 s", steps: "build 41.2 s · lint not timed" },
      { lane: "review", percent: "25", amount: "50.0 s", steps: "" },
      { lane: "open", percent: "0", amount: "not ended", steps: "" },
    ]);
    expect(effort.spendUsage).toEqual([
      { surface: "claude-code", model: "opus", input: 11, output: 7, cacheRead: 3, cacheWrite: null, minutes: null, source: "/cost", notReported: false, reported: true },
      { surface: "actions", model: null, input: null, output: null, cacheRead: null, cacheWrite: null, minutes: 7, source: "gh actions timing", notReported: false, reported: true },
      { surface: "cursor", model: null, input: null, output: null, cacheRead: null, cacheWrite: null, minutes: null, source: null, notReported: true, reported: false },
    ]);
    expect(effort.actionsMinutes).toBe(7);
    expect(effort).toMatchObject({ name: "e1", spendNote: "a note", hasSpendPhases: true, noSpendPhases: false });
  });

  it("says 'not read' for minutes and flags an empty phase ledger", () => {
    const effort = spendEffort("none", PHASES, [], "");
    expect(effort).toMatchObject({ actionsMinutes: "not read", hasSpendPhases: false, noSpendPhases: true, spendPhases: [], spendUsage: [] });
  });

  it("shows the desk's efforts in its order, or every recorded effort without one", () => {
    const desk = parseDesk({ ...DESK, rows: {}, gates: [], efforts: ["e2", "e1"], spendNotes: { e1: "kept" } }, "desk.json");
    const input = { generatedAt: NOW.toISOString(), objects: [], phases: PHASES, usage: [usage({ effort: "e3" })], target: null, codes: NO_CODES, verdictFile: null };
    expect(assembleRegister(desk, input).spendEfforts.map((effort): string => effort.name)).toEqual(["e2", "e1"]);
    expect(assembleRegister(desk, input).spendEfforts[1]?.spendNote).toBe("kept");
    const all = parseDesk({ ...DESK, rows: {}, gates: [] }, "desk.json");
    expect(assembleRegister(all, input).spendEfforts.map((effort): string => effort.name)).toEqual(["e1", "e3"]);
  });
});

describe("parseDesk's remaining refusals", () => {
  const refuse = (desk: unknown): (() => unknown) => (): unknown => parseDesk(desk, "desk.json");

  it("names the field it could not read", () => {
    expect(refuse({ ...DESK, variant: "" })).toThrow(/empty 'variant'/);
    expect(refuse({ ...DESK, generatedAtLocal: 7 })).toThrow(/'generatedAtLocal' of a number/);
    expect(refuse({ ...DESK, efforts: [1] })).toThrow(/'efforts' is not a list of effort names/);
    expect(refuse({ ...DESK, spendNotes: [] })).toThrow(/'spendNotes' is a list/);
    expect(refuse({ ...DESK, spendNotes: { e1: 3 } })).toThrow(/spendNotes\['e1'\] is a number/);
    expect(refuse({ ...DESK, legendRows: [3] })).toThrow(/legendRows\[0\] is a number/);
    expect(refuse({ ...DESK, rows: [] })).toThrow(/'rows' is a list/);
    expect(refuse({ ...DESK, rows: { "pr#1": 3 } })).toThrow(/rows\['pr#1'\] is a number/);
    expect(refuse({ ...DESK, gates: [3] })).toThrow(/gates\[0\] is a number/);
    expect(refuse({ ...DESK, gates: [{ gate: " ", label: "x", cleared: "c", asks: [] }] })).toThrow(/empty 'gate'/);
    expect(refuse({ ...DESK, gates: "x" })).toThrow(/'gates' of 'x', not a list/);
  });

  it("names an ask's and an option's malformed fields", () => {
    const option = { letter: "A", label: "x", command: "y", consequence: "z" };
    const ask = { kind: "DO", rank: 1, title: "t", why: "w", options: [{ ...option, star: true }] };
    const gate = (a: unknown): unknown => ({ ...DESK, gates: [{ gate: "G2", label: "m", asks: [a] }] });
    expect(refuse(gate(3))).toThrow(/asks\[0\] is a number/);
    expect(refuse(gate({ ...ask, rank: 0 }))).toThrow(/'rank' of a number, not a positive whole number/);
    expect(refuse(gate({ ...ask, pr: true }))).toThrow(/'pr' of a boolean, not a pull-request reference/);
    expect(refuse(gate({ ...ask, options: [3] }))).toThrow(/options\[0\] is a number/);
    expect(refuse(gate({ ...ask, options: [{ ...option, star: "yes" }] }))).toThrow(/'star' of 'yes'/);
    expect(refuse(gate({ ...ask, options: [{ ...option, letter: "", star: true }] }))).toThrow(/empty 'letter'/);
    expect(refuse(gate({ ...ask, objects: [3] }))).toThrow(/objects\[0\] is a number/);
    expect(parseDesk(gate({ ...ask, pr: null }), "desk.json").gates[0]?.asks[0]?.pr).toBeNull();
  });
});

// ── hanten round 1 (Nobunaga N1-N14) ─────────────────────────────────────────

const NEN_87 = {
  ...PR_READY,
  url: "https://github.com/zheref/nen/pull/87",
  title: "nen's own #87",
  linked: [],
  readiness: { verdict: "not-ready", reason: "not-ready: 2 unresolved threads", source: "computed" },
};

describe("references across repositories (N1)", () => {
  const objects = [ISSUE, PR_READY, NEN_87];

  async function run(desk: unknown): Promise<{ captured: Captured; document: Record<string, unknown> }> {
    return registerDocument(repo({ objects, desk }));
  }

  it("refuses a bare reference two repositories answer to, naming both candidates", async () => {
    for (const desk of [
      { ...DESK, rows: { "pr#87": { needs: "x" } }, gates: [DESK.gates[1]] },
      { ...DESK, rows: {}, gates: [{ gate: "G2", label: "m", asks: [{ ...DESK.gates[0]?.asks[1], pr: 87 }] }] },
    ]) {
      const { captured } = await run(desk);
      expect(captured.code).toBe(2);
      expect(captured.err.join("\n")).toMatch(/is ambiguous in this register: HA-PR-#87, NN-PR-#87/);
    }
  });

  it("resolves notation and owner/name#n to the one object they name", async () => {
    const { captured, document } = await run({
      ...DESK,
      rows: { "HA-PR-#87": { needs: "hatsu's" }, "zheref/nen#87": { needs: "nen's" } },
      gates: [{ gate: "G2", label: "m", asks: [{ ...DESK.gates[0]?.asks[1], pr: "NN-PR-#87" }] }],
    });
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const rows = document["objects"] as Record<string, unknown>[];
    expect(rows.map((row): unknown => [row["notation"], row["needs"]])).toEqual([
      ["HA-IS-#85", ""],
      ["HA-PR-#87", "hatsu's"],
      ["NN-PR-#87", "nen's"],
    ]);
    const gates = document["gates"] as { asks: { verdict: string }[] }[];
    expect(gates[0]?.asks[0]?.verdict).toBe("not-ready: 2 unresolved threads");
  });

  it("accepts a bare reference that only one object answers to", async () => {
    const { captured, document } = await run({ ...DESK, rows: { "85": { needs: "triage" } }, gates: [DESK.gates[1]] });
    expect(captured.code, captured.err.join("\n")).toBe(0);
    expect((document["objects"] as Record<string, unknown>[])[0]?.["needs"]).toBe("triage");
  });

  it("refuses notation whose kind is wrong, a code the registry lacks, two rows for one object, and an ask quoting an issue", async () => {
    const cases: [unknown, RegExp][] = [
      [{ ...DESK, rows: { "HA-IS-#87": {} }, gates: [DESK.gates[1]] }, /names 'HA-IS-#87', but HA-PR-#87 is a pull request/],
      [{ ...DESK, rows: { "ZZ-PR-#87": {} }, gates: [DESK.gates[1]] }, /'ZZ' is not a product code in nen\/repos.json/],
      [{ ...DESK, rows: { "HA-PR-#87": {}, "zheref/hatsu#87": {} }, gates: [DESK.gates[1]] }, /two rows for HA-PR-#87/],
      [{ ...DESK, rows: {}, gates: [{ gate: "G2", label: "m", asks: [{ ...DESK.gates[0]?.asks[1], pr: "HA-IS-#85" }] }] }, /names HA-IS-#85, which is an issue/],
    ];
    for (const [desk, message] of cases) {
      const { captured } = await run(desk);
      expect(captured.code).toBe(2);
      expect(captured.err.join("\n")).toMatch(message);
    }
  });
});

describe("linkedLine takes each number's kind from scope (N4)", () => {
  it("writes an in-scope issue and PR in notation, and an unknown number kind-free", async () => {
    const linking = { ...PR_READY, linked: [12, 85, 90] };
    const { document } = await registerDocument(repo({ objects: [ISSUE, linking, PR_BLOCKED], desk: { ...DESK, rows: {} } }));
    const row = (document["objects"] as Record<string, unknown>[]).find((r): boolean => r["number"] === 87);
    expect(row?.["linkedLine"]).toBe("HA#12, HA-IS-#85, HA-PR-#90");
  });
});

describe("every level of the desk refuses a key it does not read (N5/N13)", () => {
  async function refused(desk: unknown): Promise<string> {
    const { captured } = await registerDocument(repo({ desk }));
    expect(captured.code).toBe(2);
    return captured.err.join("\n");
  }

  it("refuses a verdict on a gate, an option and a legend row", async () => {
    expect(await refused({ ...DESK, gates: [{ ...DESK.gates[1], verdict: "ready" }] })).toMatch(/gates\[0\] carries a 'verdict'/);
    const ask = DESK.gates[0]?.asks[1] as { options: Record<string, unknown>[] };
    const starred = { ...ask, options: [{ ...ask.options[0], verdict: "ready" }] };
    expect(await refused({ ...DESK, gates: [{ gate: "G2", label: "m", asks: [starred] }] })).toMatch(/options\[0\] carries a 'verdict'/);
    expect(await refused({ ...DESK, legendRows: [{ mark: "x", meaning: "y", verdict: "ready" }] })).toMatch(/legendRows\[0\] carries a 'verdict'/);
  });

  it("refuses any other unknown key, naming what that level reads", async () => {
    expect(await refused({ ...DESK, colour: "red" })).toMatch(/the document names 'colour', which the desk does not write there -- it reads variant, title/);
    expect(await refused({ ...DESK, gates: [{ ...DESK.gates[1], note: "x" }] })).toMatch(/gates\[0\] names 'note'.*it reads gate, label, cleared, asks/);
    const ask = { ...DESK.gates[0]?.asks[1], objects: [{ label: "x", url: "/x", title: "t" }] };
    expect(await refused({ ...DESK, gates: [{ gate: "G2", label: "m", asks: [ask] }] })).toMatch(/objects\[0\] names 'title'/);
  });

  it("refuses an ask that stars no option (N6)", async () => {
    const ask = DESK.gates[0]?.asks[1] as { options: Record<string, unknown>[] };
    const unstarred = { ...ask, options: [{ ...ask.options[0], star: false }] };
    expect(await refused({ ...DESK, gates: [{ gate: "G2", label: "m", asks: [unstarred] }] })).toMatch(/stars 0 options; an ask recommends exactly one/);
  });
});

describe("a blank verdict is explained on the page (N7)", () => {
  it("notes a pull request with no readiness when the row arrived saying nothing", async () => {
    const silent = { ...PR_UNREAD, notes: [] };
    const { document } = await registerDocument(repo({ objects: [silent], desk: { ...DESK, rows: {}, gates: [DESK.gates[1]] } }));
    const row = (document["objects"] as Record<string, unknown>[])[0];
    expect(row?.["verdict"]).toBe("");
    expect(row?.["notes"]).toEqual(["no readiness authority answered for this pull request, so its verdict is blank"]);
  });
});

describe("render with the effort's ledgers (N8)", () => {
  it("fills the spend block from .nen/phases and .nen/usage, null counters blank", async () => {
    const root = repo({ workflow: true });
    mkdirSync(join(root, ".nen", "phases"), { recursive: true });
    mkdirSync(join(root, ".nen", "usage"), { recursive: true });
    writeFileSync(
      join(root, ".nen", "phases", "e1.json"),
      JSON.stringify({
        contract: "nen.phase.ledger/v0.1",
        effort: "e1",
        phases: [
          { phase: "build", startedAt: "2026-10-04T10:00:00Z", endedAt: "2026-10-04T10:04:00Z", durationMs: 240_000, steps: [{ verb: "build", argv: "bun x", exitCode: 0, durationMs: 41_200 }] },
          { phase: "review", startedAt: "2026-10-04T10:04:00Z", endedAt: null, durationMs: null, steps: [] },
        ],
      }),
    );
    writeFileSync(
      join(root, ".nen", "usage", "e1.json"),
      JSON.stringify({
        contract: "nen.usage.ledger/v0.1",
        effort: "e1",
        entries: [
          { recordedAt: "2026-10-04T10:05:00Z", surface: "claude-code", model: "opus", input: 1200, output: 300, source: "/cost" },
          { recordedAt: "2026-10-04T10:06:00Z", surface: "cursor", notReported: true },
          { recordedAt: "2026-10-04T10:07:00Z", surface: "cursor", input: 5 },
        ],
      }),
    );
    const { captured, document } = await registerDocument(root);
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const spend = document["spendEfforts"] as { spendUsage: { surface: string; notReported: boolean; cacheRead: number | null }[] }[];
    // ANY not-reported entry marks its group (N10).
    expect(spend[0]?.spendUsage.map((row): unknown => [row.surface, row.notReported, row.cacheRead])).toEqual([
      ["claude-code", false, null],
      ["cursor", true, null],
    ]);
    writeFileSync(join(root, "data.json"), JSON.stringify(document));
    const rendered = await capture(
      ["report", "render", "--variant", "register", "--template", join(FIXTURES, "rikugan.html"), "--data", "data.json", "--out", "out.html"],
      root,
      [],
    );
    expect(rendered.code, rendered.err.join("\n")).toBe(0);
    const page = readFileSync(join(root, "out.html"), "utf8");
    expect(page).toContain("<h3>e1</h3>");
    expect(page).toContain('<span class="lane">build</span><span class="track"><i style="--pct:100"></i></span><span class="amt">4 m 00 s</span><span class="steps">build 41.2 s</span>');
    expect(page).toContain('<span class="amt">not ended</span>');
    expect(page).toContain('<td class="n">1200</td><td class="n">300</td><td class="n"></td><td class="n"></td>');
    expect(page).toContain('<td class="muted" colspan="6">not reported</td>');
    expect(page).toContain("Actions minutes: not read");
  });
});

describe("the live path, scripted (N8)", () => {
  const TARGET = parseTarget("zheref/nen");
  const HEAD = "7db8de509dfb8623125e9d523220c69d3c8dbad1";
  const VIEW = {
    number: 217,
    headRefOid: HEAD,
    labels: [{ name: "nen:lane/cli" }],
    mergeStateStatus: "CLEAN",
    body: "Closes #215 and refs #220.",
    url: "https://github.com/zheref/nen/pull/217",
    title: "feat(pr): review threads",
    state: "OPEN",
    statusCheckRollup: [],
    reviewRequests: [],
  };
  const calls = (checkRuns: ScriptedCall["result"]): ScriptedCall[] => [
    ...script(),
    { match: `gh ${viewArgv(TARGET, 217).join(" ")}`, result: { code: 0, stdout: JSON.stringify(VIEW) } },
    { match: `gh ${checkRunsArgv(TARGET, HEAD).join(" ")}`, result: checkRuns },
    {
      match: `gh ${listArgv(TARGET, 217).join(" ")}`,
      result: { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: HEAD, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }) },
    },
  ];
  const argv = (root: string): string[] => [
    "report", "data", "--repo", root, "--base", "main", "--target", "zheref/nen", "--prs", "217",
    "--register", join(root, "desk.json"), "--json",
  ];
  const desk = { ...DESK, rows: { "NN-PR-#217": { needs: "your merge" } }, gates: [{ gate: "G2", label: "m", asks: [{ ...DESK.gates[0]?.asks[1], pr: "NN-PR-#217" }] }] };

  it("quotes the check run's verdict line, with no offline provenance", async () => {
    const run = { name: "readiness", status: "completed", conclusion: "SUCCESS", started_at: "2026-10-04T10:00:00Z", output: { title: "x", summary: "ready", text: null } };
    const captured = await capture(argv(repo({ desk })), null, calls({ code: 0, stdout: JSON.stringify({ check_runs: [run] }) }));
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const document = JSON.parse(captured.out.join("\n")) as Record<string, unknown>;
    const row = (document["objects"] as Record<string, unknown>[])[0];
    expect(row).toMatchObject({ notation: "NN-PR-#217", verdict: "ready", needs: "your merge", linkedLine: "NN#215, NN#220", notes: [] });
    expect((document["gates"] as { asks: { verdict: string }[] }[])[0]?.asks[0]?.verdict).toBe("ready");
    expect(document["footerNote"]).toBe("Rendered by verbs only.");
  });

  it("puts the reason for a null readiness into the row's notes, not only stderr (N7)", async () => {
    const captured = await capture(argv(repo({ desk })), null, calls({ code: 1, stdout: "", stderr: "HTTP 403\n" }));
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const row = (JSON.parse(captured.out.join("\n")) as { objects: Record<string, unknown>[] }).objects[0];
    expect(row?.["verdict"]).toBe("");
    expect((row?.["notes"] as string[]).join("\n")).toMatch(/^the readiness gate /m);
    expect(captured.err.join("\n")).toMatch(/objects: the readiness gate/);
  });
});

// ── Copilot round 1 on NN-PR-#365 ────────────────────────────────────────────

describe("product codes canonicalised to the recorded repository (Copilot #365)", () => {
  const BANKAI_REPO = join(process.cwd(), "src", "schema", "fixtures", "bankai-repo");

  it("writes and resolves KP-/BC- notation for bare product-code values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-register-bankai-"));
    const kroPr = { ...PR_READY, number: 5, url: "https://github.com/zheref/KroApple/pull/5", linked: [3] };
    const coreIssue = { ...ISSUE, number: 3, url: "https://github.com/zheref/bankai-core/issues/3", linked: [] };
    writeFileSync(join(dir, "objects.json"), JSON.stringify([coreIssue, kroPr]));
    writeFileSync(
      join(dir, "desk.json"),
      JSON.stringify({
        ...DESK,
        rows: { "KP-PR-#5": { needs: "kro's merge" }, "BC-IS-#3": { needs: "core triage" } },
        gates: [{ gate: "G2", label: "m", asks: [{ ...DESK.gates[0]?.asks[1], pr: "KP-PR-#5" }] }],
      }),
    );
    const captured = await capture([
      "report", "data", "--repo", BANKAI_REPO, "--base", "main",
      "--objects-from", join(dir, "objects.json"), "--register", join(dir, "desk.json"), "--json",
    ]);
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const document = JSON.parse(captured.out.join("\n")) as Record<string, unknown>;
    const rows = document["objects"] as Record<string, unknown>[];
    expect(rows.map((row): unknown => [row["notation"], row["needs"]])).toEqual([
      ["BC-IS-#3", "core triage"],
      ["KP-PR-#5", "kro's merge"],
    ]);
    // A linked number in ANOTHER repository is not this one's #3.
    expect(rows[1]?.["linkedLine"]).toBe("KP#3");
    expect((document["gates"] as { asks: { verdict: string }[] }[])[0]?.asks[0]?.verdict).toBe(PR_READY.readiness.reason);
    expect(document["footerNote"]).not.toMatch(/unresolved/);
  });
});

describe("one identity, one row (Copilot #365)", () => {
  it("refuses an objects file carrying the same repository and number twice", async () => {
    const { captured } = await registerDocument(repo({ objects: [PR_READY, { ...PR_READY, title: "again" }], desk: { ...DESK, rows: {}, gates: [DESK.gates[1]] } }));
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/the register carries HA-PR-#87 twice/);
  });
});

describe("a spend note nobody will show is refused (Copilot #365)", () => {
  it("names a spendNotes key outside the computed effort list", async () => {
    const { captured } = await registerDocument(repo({ desk: { ...DESK, efforts: ["e1"], spendNotes: { e1: "kept", el: "typo" } } }));
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/spendNotes name 'el', which is not among the efforts this page shows \('e1'\)/);
  });
});
