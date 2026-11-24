// src/pr/version_collision.test.ts -- the live plugin-version collision gate
// (zheref/nen#663), one group per acceptance criterion, driven through the
// PRODUCTION paths: `nen pr ready` (prReady / readReady) and `nen pr
// version-collision` (prVersionCollision), both over the scripted repository
// in ./version_collision.testkit.ts. The pure pieces -- the pointer read, the
// SemVer comparison, the schema reader -- are pinned beside them.

import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { GATES_FILE, schemaPath } from "../schema/source.js";
import { makeTempDir } from "../testing/tempdir.js";
import { prReady, readReady, type Io, type PrReadyDeps, type PrReadyInput, type ReadyReport } from "../verbs/pr_ready.js";
import { prVersionCollision, VERSION_COLLISION_CONTRACT, type VersionCollisionReport } from "../verbs/pr_version_collision.js";
import { parseGateIdentities, parseVersionCollision } from "../schema/gates.js";
import { SchemaError } from "../schema/errors.js";
import type { PrStateSource } from "../github/pr_state.js";
import {
  decideVersionCollision,
  rawDeclaresOptIn,
  sameVersion,
  versionFromManifest,
  type VersionCollisionEvidence,
  type VersionCollisionResult,
} from "./version_collision.js";
import { foldVersionCollision, type RowResult } from "../gates/ready.js";
import { createWatchCommand } from "../watch/command.js";
import { runFamily } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { runReadyGate } from "./mergeunit.js";
import {
  addPeer,
  baseline as kitBaseline,
  MAIN,
  MAIN_OLD,
  NO_OPT_IN,
  OPT_IN,
  sha,
  SLUG,
  SUBJECT_HEAD,
  VERSION_FILE,
  withOptIn,
  worldSource,
  type CollisionWorld,
  type ReadOptions,
} from "./version_collision.testkit.js";

// The fixture identities: its two approvers approve whatever head is judged.
const FIXTURE = readFileSync(schemaPath(BANKAI_REPO, GATES_FILE), "utf8");
const APPROVERS = (JSON.parse(FIXTURE) as { default_approvers: string[] }).default_approvers;
const approvedAt = (head: string): unknown[] =>
  APPROVERS.map((login): unknown => ({ user: { login }, state: "APPROVED", commit_id: head, submitted_at: "2025-01-01T00:00:00Z" }));
const gatesText = (versionCollision: unknown = OPT_IN): string => withOptIn(FIXTURE, versionCollision);
const baseline = (): CollisionWorld => kitBaseline(FIXTURE, approvedAt);

// ── the two surfaces, run the way the CLI runs them ─────────────────────────

/** A root outside this checkout carrying the OPTED-IN gates file: the verb's local copy and pr ready's --gates. */
const ROOT = makeTempDir("nen-663-");
mkdirSync(join(ROOT, "nen"), { recursive: true });
writeFileSync(join(ROOT, "nen", "gates.json"), gatesText());
const OPTED_GATES = join(makeTempDir("nen-663-gates-"), "gates.json");
writeFileSync(OPTED_GATES, gatesText());
const PLAIN_ROOT = makeTempDir("nen-663-plain-");
const PLAIN_GATES = join(makeTempDir("nen-663-plain-gates-"), "gates.json");
writeFileSync(PLAIN_GATES, gatesText(NO_OPT_IN));

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line): void => void out.push(line), err: (line): void => void err.push(line) }, out, err };
}

function deps(source: PrStateSource | null): PrReadyDeps {
  return {
    now: (): string => "2025-01-01T00:00:00Z",
    executable: (): string => "/opt/nen/nen",
    openSource: (): ReturnType<PrReadyDeps["openSource"]> =>
      source === null ? { ok: false, message: "GH_TOKEN is not set" } : { ok: true, source },
    localCheckout: (): null => null,
  };
}

function readyInput(subject: number, gates = OPTED_GATES, booleans: readonly string[] = ["json"]): PrReadyInput {
  return { positionals: ["pr", "ready", String(subject)], values: { "gh-repo": SLUG, gates }, booleans: new Set(booleans), repoFlag: PLAIN_ROOT };
}

async function ready(
  world: CollisionWorld,
  subject = 42,
  options: ReadOptions = {},
  gates = OPTED_GATES,
): Promise<{ code: number; report: ReadyReport; calls: string[] }> {
  const source = worldSource(world, subject, options);
  const { io, out } = capture();
  const code = await prReady(readyInput(subject, gates), io, deps(source));
  return { code, report: JSON.parse(out.join("\n")) as ReadyReport, calls: source.calls };
}

async function verb(
  world: CollisionWorld,
  subject = 42,
  options: ReadOptions = {},
  root = ROOT,
  extra: readonly string[] = ["json"],
): Promise<{ code: number; report: VersionCollisionReport; out: string[]; calls: string[] }> {
  const source = worldSource(world, subject, options);
  const { io, out } = capture();
  const code = await prVersionCollision(
    { positionals: ["pr", "version-collision", String(subject)], values: { "gh-repo": SLUG }, booleans: new Set(extra), repoFlag: root },
    io,
    deps(source),
  );
  return { code, report: (extra.includes("json") ? JSON.parse(out.join("\n")) : null) as VersionCollisionReport, out, calls: source.calls };
}

const checksRow = (report: ReadyReport): ReadyReport["conjuncts"][number] | undefined =>
  report.conjuncts.find((row): boolean => row.id === "checks-green");

/** The evaluator outcome both surfaces must agree on. */
function outcomeOf(result: Pick<VersionCollisionResult, "status" | "line" | "proposedVersion" | "collisions" | "missing">): unknown {
  return { status: result.status, line: result.line, proposedVersion: result.proposedVersion, collisions: result.collisions, missing: result.missing };
}

// ── the pure pieces ─────────────────────────────────────────────────────────

describe("the version read and the comparison (zheref/nen#663)", () => {
  it("reads an RFC 6901 pointer, ~0 and ~1 unescaped, and refuses everything that is not one printable string", () => {
    expect(versionFromManifest('{"version":"1.2.3"}', "/version")).toEqual({ kind: "value", version: "1.2.3" });
    expect(versionFromManifest('{"a/b":{"~x":["0.9.0"]}}', "/a~1b/~0x/0")).toEqual({ kind: "value", version: "0.9.0" });
    expect(versionFromManifest('{"version":1}', "/version").kind).toBe("unparseable");
    expect(versionFromManifest('{"other":"1"}', "/version").kind).toBe("unparseable");
    expect(versionFromManifest("not json", "/version").kind).toBe("unparseable");
    expect(versionFromManifest('{"version":"1.0.0","version":"2.0.0"}', "/version")).toMatchObject({ kind: "unparseable", why: expect.stringContaining("repeated key") });
    expect(versionFromManifest('{"version":"1.0.0\\u001b[2J"}', "/version").kind).toBe("unparseable");
  });

  it("compares SemVer ignoring build metadata, and anything else as an exact string", () => {
    expect(sameVersion("1.4.0", "1.4.0+build.7")).toBe(true);
    expect(sameVersion("1.4.0-rc.1", "1.4.0-rc.1+x")).toBe(true);
    expect(sameVersion("1.4.0-rc.1", "1.4.0")).toBe(false);
    expect(sameVersion("1.4.0", "1.4.1")).toBe(false);
    expect(sameVersion("v1.4", "v1.4")).toBe(true);
    expect(sameVersion("v1.4", "v1.4+x")).toBe(false);
    expect(sameVersion("01.4.0", "1.4.0")).toBe(false);
  });

  it("decides not-applicable without a policy, and never reads evidence for it", () => {
    expect(decideVersionCollision(null, null).status).toBe("not-applicable");
  });
});

// ── the decision table and the fold, cell by cell (review round 1, D) ──────

describe("decideVersionCollision -- every row of the decision, in its stated order", () => {
  const policy = { versionFile: VERSION_FILE, versionPointer: "/version", shippedPaths: ["claude/**"] };
  const T = sha("1b");
  const D = sha("2d");
  const value = (version: string): { kind: "value"; version: string } => ({ kind: "value", version });
  const evidence = (over: Partial<VersionCollisionEvidence> = {}): VersionCollisionEvidence => ({
    subject: { number: 42, headSha: SUBJECT_HEAD, baseRef: "main", defaultBranch: "main" },
    missing: [],
    moved: [],
    subjectFiles: ["claude/a.md"],
    head: value("1.4.0"),
    baseTip: { sha: T, version: value("1.3.0") },
    defaultTip: null,
    mergeBase: value("1.3.0"),
    peers: [],
    ...over,
  });
  const peer = { number: 10, headSha: sha("ae"), baseRef: "main", draft: false, touchesShipped: true, inherited: false };
  const stacked = { number: 42, headSha: SUBJECT_HEAD, baseRef: "feature/p", defaultBranch: "main" };
  const rows: readonly [string, Partial<VersionCollisionEvidence> | null, string, RegExp | string][] = [
    ["no policy", null, "not-applicable", "declares no version_collision"],
    ["the subject's files unread", { subjectFiles: null, missing: ["files X"] }, "unknown", "unknown: files X"],
    ["no shipped path changed", { subjectFiles: ["docs/a.md"] }, "not-applicable", "changes no shipped path (claude/**)"],
    ["no head version read", { head: null }, "unknown", "at the head was not read"],
    ["the head read failed", { head: { kind: "unread", why: "head X failed" } }, "unknown", "unknown: head X failed"],
    ["the head has no manifest", { head: { kind: "absent" } }, "unknown", "carries no .claude-plugin/plugin.json"],
    ["the head's manifest is unparseable", { head: { kind: "unparseable", why: "not JSON" } }, "unknown", "could not be parsed"],
    ["drift beats a collision", { baseTip: { sha: T, version: value("1.4.0") }, moved: ["#10 moved"] }, "unknown", "unknown: moved during inspection: #10 moved"],
    ["the base tip carries it", { baseTip: { sha: T, version: value("1.4.0+b") } }, "collision", "is already at the tip of 'main'"],
    ["the default tip carries it (stacked)", { subject: stacked, defaultTip: { sha: D, version: value("1.4.0") } }, "collision", "is already at the tip of the default branch 'main'"],
    ["unbumped while the base moved on", { head: value("1.3.0"), baseTip: { sha: T, version: value("1.3.5") } }, "collision", "is unchanged from the pull request's merge base"],
    ["a counted peer", { peers: [peer] }, "collision", "is also proposed by open pull request #10"],
    ["an inherited peer", { peers: [{ ...peer, inherited: true }] }, "clear", "clear: version 1.4.0"],
    ["a peer touching nothing shipped", { peers: [{ ...peer, touchesShipped: false }] }, "clear", "clear: version 1.4.0"],
    ["a collision with missing evidence stays a collision", { peers: [peer], missing: ["#11's files"] }, "collision", "; also not read: #11's files"],
    ["missing evidence alone", { missing: ["#11's files"] }, "unknown", "unknown: #11's files"],
    ["an unparseable base tip", { baseTip: { sha: T, version: { kind: "unparseable", why: "not JSON" } } }, "unknown", "the version at the tip of 'main'"],
    ["an unread base tip", { baseTip: { sha: T, version: { kind: "unread", why: "tip X failed" } } }, "unknown", "unknown: tip X failed"],
    ["a base tip with no manifest", { baseTip: { sha: T, version: { kind: "absent" } } }, "clear", "clear: version 1.4.0"],
    // Round 2, N5: an applicable input missing from the evidence is unknown on its own.
    ["no base tip in the evidence", { baseTip: null }, "unknown", "the live tip of the base branch 'main' and its version (not in the evidence)"],
    ["no merge base in the evidence", { mergeBase: null }, "unknown", "the version at the pull request's merge base with 'main' (not in the evidence)"],
    ["no default tip on a stacked base", { subject: stacked, defaultTip: null }, "unknown", "the live tip of the default branch 'main' and its version (not in the evidence)"],
    ["no default tip needed when the base IS the default", { defaultTip: null }, "clear", "clear: version 1.4.0"],
    ["a missing input does not hide a proven collision", { mergeBase: null, peers: [peer] }, "collision", "; also not read: the version at the pull request's merge base"],
    ["clear", {}, "clear", "clear: version 1.4.0 is on no target tip"],
  ];
  it.each(rows)("%s", (_name, over, status, line) => {
    const decision = decideVersionCollision(over === null ? null : policy, over === null ? null : evidence(over));
    expect(decision.status).toBe(status);
    expect(decision.line).toContain(line);
  });
  it("a collision keeps its missing list, and a tip with no manifest is a named warning", () => {
    const decided = decideVersionCollision(policy, evidence({ peers: [peer], missing: ["#11's files"] }));
    expect(decided.missing).toEqual(["#11's files"]);
    expect(decided.collisions.map((entry): string => entry.kind)).toEqual(["peer"]);
    const absent = decideVersionCollision(policy, evidence({ baseTip: { sha: T, version: { kind: "absent" } } }));
    expect(absent.warnings).toEqual([`version collision: the tip of 'main' (${T.slice(0, 7)}) carries no ${VERSION_FILE}, so it publishes no version to collide with`]);
  });
});

describe("foldVersionCollision -- 4 statuses x every CON-32(a) row state", () => {
  const result = (status: VersionCollisionResult["status"]): VersionCollisionResult => ({
    status,
    line: `${status}: L`,
    judgedHead: SUBJECT_HEAD,
    base: { ref: "main", sha: MAIN },
    default: { ref: "main", sha: MAIN },
    policySource: "s",
    policy: null,
    proposedVersion: "1.4.0",
    collisions: [],
    missing: status === "unknown" ? ["M"] : [],
    inventory: { pages: 0, inspected: 0, reads: 0, budget: 200 },
    warnings: [],
    notes: [],
  });
  const states: readonly [string, RowResult][] = [
    ["ready", { status: "ready", note: null }],
    ["ready with a note", { status: "ready", note: "excluded by declaration: X" }],
    ["failed", { status: "failed", reason: "not-ready: red" }],
    ["failed: no checks reported", { status: "failed", reason: "not-ready: NO checks reported at head (CON-32a)" }],
    ["unevaluated", { status: "unevaluated", missing: "readiness undetermined: P" }],
  ];
  const collision = "version collision (CON-32a, zheref/nen#663): collision: L";
  const unknown = "the version collision could not be judged (zheref/nen#663): M";
  const expected: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    "not-applicable": {},
    clear: {},
    collision: {
      ready: { status: "failed", reason: `not-ready: ${collision}` },
      "ready with a note": { status: "failed", reason: `not-ready: ${collision} — the checks themselves are green: excluded by declaration: X` },
      failed: { status: "failed", reason: `not-ready: red — and ${collision}` },
      "failed: no checks reported": { status: "failed", reason: `not-ready: NO checks reported at head (CON-32a) — and ${collision}` },
      unevaluated: { status: "failed", reason: `not-ready: ${collision} — and the checks could not be judged: readiness undetermined: P` },
    },
    unknown: {
      ready: { status: "unevaluated", missing: unknown },
      "ready with a note": { status: "unevaluated", missing: `${unknown} — the checks themselves are green: excluded by declaration: X` },
      failed: { status: "failed", reason: `not-ready: red — and ${unknown}` },
      "failed: no checks reported": { status: "failed", reason: `not-ready: NO checks reported at head (CON-32a) — and ${unknown}` },
      unevaluated: { status: "unevaluated", missing: `readiness undetermined: P; and ${unknown}` },
    },
  };
  for (const status of ["not-applicable", "clear", "collision", "unknown"] as const) {
    it.each(states)(`${status} on a %s row`, (state, row) => {
      const folded = foldVersionCollision(row, result(status));
      const cell = expected[status]?.[state];
      expect(folded).toEqual({
        ...(cell ?? row),
        versionCollision: { status, line: `${status}: L`, proposedVersion: "1.4.0", collisions: [], missing: status === "unknown" ? ["M"] : [] },
      });
    });
  }
  it("no limb (not opted in) returns the row untouched", () => {
    const row: RowResult = { status: "ready", note: null };
    expect(foldVersionCollision(row, undefined)).toBe(row);
  });
});

// ── AC-1 ────────────────────────────────────────────────────────────────────

describe("AC-1: a head carrying its target tip's version is refused, naming the version", () => {
  it("equal to the base tip's: collision on both surfaces, row 2 failed, exit 1", async () => {
    const world = baseline();
    world.versions[MAIN] = "1.4.0+build.9";
    const { code, report } = await ready(world);
    expect(code).toBe(1);
    expect(report.verdict).toBe("not-ready");
    expect(report.gateLine).toBe(
      `not-ready: version collision (CON-32a, zheref/nen#663): collision: version 1.4.0 is already at the tip of 'main' (${MAIN.slice(0, 7)})`,
    );
    expect(checksRow(report)?.status).toBe("failed");
    expect(checksRow(report)?.versionCollision?.collisions).toEqual([
      { kind: "base", version: "1.4.0", pr: null, head: MAIN, baseRef: "main", draft: null },
    ]);
    expect(report.meta.versionCollision?.policySource).toBe(`${SLUG}@${MAIN}:nen/gates.json`);
    const cli = await verb(world);
    expect(cli.code).toBe(1);
    expect(cli.report.contract).toBe(VERSION_COLLISION_CONTRACT);
    expect(cli.report.status).toBe("collision");
    expect(cli.report.proposedVersion).toBe("1.4.0");
  });

  it("on a stacked base, equal to the DEFAULT tip's: collision naming the default branch", async () => {
    const world = baseline();
    const parent = sha("5d");
    world.branches["feature/parent"] = parent;
    world.versions[parent] = "1.3.0";
    world.versions[MAIN] = "1.4.0";
    const subject = world.prs[0];
    if (subject === undefined) throw new Error("no subject");
    subject.base = "feature/parent";
    world.mergeBases[`feature/parent...${SUBJECT_HEAD}`] = MAIN_OLD;
    const { report } = await ready(world);
    expect(report.gateLine).toContain("collision: version 1.4.0 is already at the tip of the default branch 'main'");
    expect(report.meta.versionCollision?.base).toEqual({ ref: "feature/parent", sha: parent });
    expect(report.meta.versionCollision?.default).toEqual({ ref: "main", sha: MAIN });
    expect((await verb(world)).report.collisions).toEqual([{ kind: "base", version: "1.4.0", pr: null, head: MAIN, baseRef: "main", draft: null }]);
  });

  it("a head that leaves the version as its merge base had it, after the base moved on, would ship a published number: collision", async () => {
    const world = baseline();
    world.versions[SUBJECT_HEAD] = "1.3.0";
    world.versions[MAIN] = "1.3.5";
    const { report } = await ready(world);
    expect(report.gateLine).toContain("is unchanged from the pull request's merge base, so merged it would ship under 'main''s 1.3.5");
    // Its own kind, so a consumer tells it from an AC-1 tip hit (`base`).
    expect(checksRow(report)?.versionCollision?.collisions).toEqual([
      { kind: "unbumped", version: "1.3.5", pr: null, head: MAIN, baseRef: "main", draft: null },
    ]);
    expect((await verb(world)).report.collisions.map((entry): string => entry.kind)).toEqual(["unbumped"]);
  });

  it("a tip with NO version file publishes no version: a named warning, and the other evidence is still compared", async () => {
    const world = baseline();
    world.versions[MAIN] = null;
    const clear = await ready(world);
    expect(clear.code).toBe(0);
    expect(checksRow(clear.report)?.versionCollision?.status).toBe("clear");
    const warning = `version collision: the tip of 'main' (${MAIN.slice(0, 7)}) carries no ${VERSION_FILE}, so it publishes no version to collide with`;
    expect(clear.report.meta.warnings).toContain(warning);
    expect((await verb(world)).report.warnings).toContain(warning);
    // Symmetric on a stacked base: the default tip has no file, the base tip still collides.
    const stacked = baseline();
    const parent = sha("5d");
    stacked.branches["feature/parent"] = parent;
    stacked.versions[parent] = "1.4.0";
    stacked.versions[MAIN] = null;
    stacked.prs[0]!.base = "feature/parent";
    stacked.mergeBases[`feature/parent...${SUBJECT_HEAD}`] = MAIN_OLD;
    const hit = await ready(stacked);
    expect(hit.report.meta.warnings.join("\n")).toContain(`the tip of 'main' (${MAIN.slice(0, 7)}) carries no`);
    expect(hit.report.meta.versionCollision?.collisions).toEqual([{ kind: "base", version: "1.4.0", pr: null, head: parent, baseRef: "feature/parent", draft: null }]);
  });

  it("a pull request changing no shipped path is not applicable: ready, exit 0, and no inventory read", async () => {
    const world = baseline();
    world.versions[MAIN] = "1.4.0";
    const subject = world.prs[0];
    if (subject === undefined) throw new Error("no subject");
    subject.files = ["docs/USAGE.md"];
    const { code, report, calls } = await ready(world);
    expect(code).toBe(0);
    expect(report.verdict).toBe("ready");
    expect(checksRow(report)?.versionCollision?.status).toBe("not-applicable");
    expect(calls.filter((key): boolean => key.startsWith("pulls:"))).toEqual([]);
    const cli = await verb(world);
    expect(cli.code).toBe(0);
    expect(cli.report.line).toBe("not-applicable: the pull request changes no shipped path (claude/**, .claude-plugin/**)");
  });
});

// ── AC-2 ────────────────────────────────────────────────────────────────────

describe("AC-2: independent proposals of one version refuse each other, every number named", () => {
  function threeProposals(): CollisionWorld {
    const world = baseline();
    addPeer(world, 10, "1.4.0", { mergeBaseVersion: "1.2.0" });
    addPeer(world, 11, "1.4.0", { draft: true });
    addPeer(world, 12, "1.4.0+meta", { mergeBaseVersion: "1.3.1" });
    return world;
  }

  it.each([42, 10, 11, 12])("run from #%i, every other proposal is a collision", async (subject) => {
    const world = threeProposals();
    // Named in inventory order (oldest first): the subject #42 was opened first.
    const others = [42, 10, 11, 12].filter((number): boolean => number !== subject);
    const { report } = await ready(world, subject);
    expect(report.verdict).toBe("not-ready");
    const peers = checksRow(report)?.versionCollision?.collisions.map((entry): number | null => entry.pr);
    expect(peers).toEqual(others);
    for (const number of others) expect(report.gateLine).toContain(`#${number}`);
    const cli = await verb(world, subject);
    expect(cli.code).toBe(1);
    expect(cli.report.collisions.map((entry): number | null => entry.pr)).toEqual(others);
    expect(cli.report.collisions.find((entry): boolean => entry.pr === 11)?.draft ?? (subject === 11 ? true : undefined)).toBe(true);
  });

  it("a child that inherited the version from its own base reserves nothing; retargeted to the trunk, it does", async () => {
    const world = baseline();
    const parent = addPeer(world, 10, "1.4.0");
    world.branches["feature/10"] = parent.head;
    // #20 is stacked on #10 and carries #10's 1.4.0: its merge base IS #10's head.
    const child = addPeer(world, 20, "1.4.0", { base: "feature/10" });
    world.mergeBases[`feature/10...${child.head}`] = parent.head;
    const stacked = await verb(world);
    expect(stacked.report.collisions.map((entry): number | null => entry.pr)).toEqual([10]);
    child.base = "main";
    world.mergeBases[`main...${child.head}`] = MAIN_OLD;
    const retargeted = await verb(world);
    expect(retargeted.report.collisions.map((entry): number | null => entry.pr)).toEqual([10, 20]);
    expect((await ready(world)).report.meta.versionCollision?.collisions.map((entry): number | null => entry.pr)).toEqual([10, 20]);
  });

  it("a peer that changes no shipped path reserves nothing", async () => {
    const world = baseline();
    addPeer(world, 30, "1.4.0", { files: ["docs/USAGE.md"] });
    const { code, report } = await ready(world);
    expect(code).toBe(0);
    expect(checksRow(report)?.versionCollision?.status).toBe("clear");
  });

  it("a FORK head never blocks: named in a warning, and none of its content is read", async () => {
    const world = baseline();
    const fork = addPeer(world, 31, "1.4.0", { fork: true });
    const { code, report, calls } = await ready(world);
    expect(code).toBe(0);
    expect(report.meta.warnings.join("\n")).toMatch(/open pull request #31 has a head in another repository \(a fork\); a fork head never blocks/);
    expect(calls.some((key): boolean => key.includes(fork.head) || key === "files:#31")).toBe(false);
    expect((await verb(world)).report.warnings.join("\n")).toContain("#31");
  });

  /** The testkit's source with every inventory node rewritten by `edit`. */
  function rewritten(world: CollisionWorld, edit: (node: Record<string, unknown>) => Record<string, unknown>): PrStateSource {
    const source = worldSource(world, 42);
    const listed = source.openPullRequestsPage;
    if (listed === undefined) throw new Error("no inventory");
    return {
      ...source,
      openPullRequestsPage: async (repo, cursor): Promise<unknown> => {
        const page = (await listed.call(source, repo, cursor)) as { pageInfo: unknown; nodes: Record<string, unknown>[] };
        return { ...page, nodes: page.nodes.map(edit) };
      },
    };
  }
  async function readyOver(source: PrStateSource): Promise<{ code: number; report: ReadyReport }> {
    const { io, out } = capture();
    const code = await prReady(readyInput(42), io, deps(source));
    return { code, report: JSON.parse(out.join("\n")) as ReadyReport };
  }

  it("`isCrossRepository` is the fork flag: a same-repository row under another repository name (a rename) still blocks", async () => {
    const world = baseline();
    addPeer(world, 10, "1.4.0");
    const { code, report } = await readyOver(rewritten(world, (node) => ({ ...node, headRepository: { nameWithOwner: "acme/widget-renamed" } })));
    expect(code).toBe(1);
    expect(report.meta.versionCollision?.collisions.map((entry): number | null => entry.pr)).toEqual([10]);
  });

  it("a deleted fork (cross-repository, no head repository) is still a fork; a same-repository row without one is malformed", async () => {
    const world = baseline();
    addPeer(world, 31, "1.4.0", { fork: true });
    const deleted = await readyOver(rewritten(world, (node) => (node["isCrossRepository"] === true ? { ...node, headRepository: null } : node)));
    expect(deleted.code).toBe(0);
    expect(deleted.report.meta.warnings.join("\n")).toContain("#31");
    const malformed = await readyOver(rewritten(baseline(), (node) => ({ ...node, headRepository: null })));
    expect(malformed.code).toBe(1);
    expect(checksRow(malformed.report)?.missing).toMatch(/entry 0 carried no number, head SHA, base branch, fork flag or \(same-repository\) head repository/);
  });

  it("an inventory node with no fork flag is malformed -- unknown, never read as a fork", async () => {
    const world = baseline();
    addPeer(world, 10, "1.4.0");
    const { code, report } = await readyOver(
      rewritten(world, (node) => {
        const copy = { ...node };
        delete copy["isCrossRepository"];
        return copy;
      }),
    );
    expect(code).toBe(1);
    expect(checksRow(report)?.missing).toMatch(/carried no number, head SHA, base branch, fork flag/);
  });

  it("round 2, N1: rows closed and reopened between page reads cannot hide a same-repository peer -- cursors, not offsets", async () => {
    // 99 forks after the subject, then the same-repo peer #10 first on page 2.
    // Fork #100 is closed after the first page-1 read, reopened after the
    // page-2 read and closed again after the second pass's page-1 read: an
    // offset walk never lists #10 in either pass, and fork churn is not drift.
    const make = (): { world: CollisionWorld; options: ReadOptions } => {
      const world = baseline();
      for (let number = 100; number < 199; number += 1) {
        world.prs.push({ number, head: sha(`${number.toString(16)}c`), base: "main", files: ["claude/x.md"], fork: true });
      }
      addPeer(world, 10, "1.4.0");
      const fork100 = world.prs.find((entry): boolean => entry.number === 100);
      if (fork100 === undefined) throw new Error("no #100");
      const close = (): void => void world.prs.splice(world.prs.indexOf(fork100), 1);
      const reopen = (): void => void world.prs.splice(1, 0, fork100);
      const after = (key: string, n: number): void => {
        if (key === "pulls:1" && n === 1) close();
        if (key === "pulls:2" && n === 1) reopen();
        if (key === "pulls:1" && n === 2) close();
      };
      return { world, options: { after } };
    };
    const first = make();
    const { code, report } = await ready(first.world, 42, first.options);
    expect(code).toBe(1);
    expect(report.meta.versionCollision?.status).toBe("collision");
    expect(report.meta.versionCollision?.collisions.map((entry): number | null => entry.pr)).toEqual([10]);
    const second = make();
    const cli = await verb(second.world, 42, second.options);
    expect(cli.code).toBe(1);
    expect(cli.report.collisions.map((entry): number | null => entry.pr)).toEqual([10]);
  });

  it("a peer whose manifest cannot be parsed reserves nothing, with a note", async () => {
    const world = baseline();
    const peer = addPeer(world, 13, "1.4.0");
    world.manifests[peer.head] = "{ not json";
    const { code, report } = await ready(world);
    expect(code).toBe(0);
    expect(report.meta.notes.join("\n")).toMatch(/#13's \.claude-plugin\/plugin\.json could not be parsed .* reserves no version/);
  });
});

// ── AC-3 ────────────────────────────────────────────────────────────────────

describe("AC-3: a base that later takes the proposed version turns a green head not-ready", () => {
  it("read ready, flip ONLY the live base tip, read again: not ready naming the collision, head and checks unchanged", async () => {
    const world = baseline();
    // The snapshot's oids are frozen: only the live branch read can see the move.
    world.snapshot = { base: MAIN, default: MAIN };
    const input = readyInput(42);
    const first = await readReady("42", input, deps(worldSource(world, 42)));
    if (first.kind !== "verdict") throw new Error(first.kind);
    expect(first.report.verdict).toBe("ready");
    const moved = sha("6e");
    world.branches["main"] = moved;
    world.versions[moved] = "1.4.0";
    const second = await readReady("42", input, deps(worldSource(world, 42)));
    if (second.kind !== "verdict") throw new Error(second.kind);
    expect(second.report.verdict).toBe("not-ready");
    expect(second.report.gateLine).toContain(`collision: version 1.4.0 is already at the tip of 'main' (${moved.slice(0, 7)})`);
    expect(second.report.judgedHead).toBe(first.report.judgedHead);
    // Every other row is exactly what it was; only row 2 carries the limb.
    const others = (report: ReadyReport): unknown => report.conjuncts.filter((row): boolean => row.id !== "checks-green");
    expect(others(second.report)).toEqual(others(first.report));
    expect(second.settlement).toEqual(first.settlement);
  });

  it("through `watch until --pr --until ready`: the collision holds the watch, the bump releases it", async () => {
    const world = baseline();
    world.versions[MAIN] = "1.4.0";
    const readyDeps: PrReadyDeps = { ...deps(null), openSource: () => ({ ok: true, source: worldSource(world, 42) }) };
    const out: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (): void => undefined };
    const sleep = (): void => {
      // Between observations the author bumps to a free version.
      const bumped = sha("7f");
      world.versions[bumped] = "1.5.0";
      world.mergeBases[`main...${bumped}`] = MAIN_OLD;
      const subject = world.prs[0];
      if (subject !== undefined) subject.head = bumped;
    };
    const command = createWatchCommand({ prReady: readyDeps, sleep });
    const argv = ["watch", "until", "--pr", "42", "--gh-repo", SLUG, "--repo", PLAIN_ROOT, "--gates", OPTED_GATES, "--until", "ready", "--interval-ms", "30000"];
    const code = await runFamily(command, argv, null, false, io, new ScriptedSeams([]));
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^\[1\] ready is not yet true -- .*version collision/);
    expect(out.at(-1)).toBe("condition became true after 2 observation(s)");
  });

  it("through `pr merge`'s in-process readiness gate (shared by --release-unit and --delivery): refused, naming the collision", async () => {
    const world = baseline();
    const options = { target: { owner: "acme", repo: "widget", slug: SLUG }, prNumber: 42, repoFlag: ROOT, ghRepoFlag: SLUG, seams: new ScriptedSeams([]) };
    const green = await runReadyGate({ ...options, deps: deps(worldSource(world, 42)) } as Parameters<typeof runReadyGate>[0]);
    expect(green.ok).toBe(true);
    world.versions[MAIN] = "1.4.0";
    const refused = await runReadyGate({ ...options, deps: deps(worldSource(world, 42)) } as Parameters<typeof runReadyGate>[0]);
    expect(refused.ok).toBe(false);
    expect(refused.lines.join("\n")).toContain("pr ready: not-ready: version collision (CON-32a, zheref/nen#663): collision: version 1.4.0");
  });

  it("through `loop slots --from-run`'s readiness read path (readReady with --require-head): not ready", async () => {
    const world = baseline();
    world.versions[MAIN] = "1.4.0";
    const read = await readReady(
      "42",
      { positionals: ["pr", "ready", "42"], values: { "gh-repo": SLUG, "require-head": SUBJECT_HEAD }, booleans: new Set(), repoFlag: ROOT },
      deps(worldSource(world, 42)),
    );
    if (read.kind !== "verdict") throw new Error(read.kind);
    expect(read.report.verdict).toBe("not-ready");
    expect(read.report.meta.identities.read).toBe("base");
    expect(read.report.gateLine).toContain("version collision");
  });
});

// ── AC-4 ────────────────────────────────────────────────────────────────────

describe("AC-4: distinct proposals both pass; no opt-in, no change", () => {
  it("two pull requests proposing distinct new versions are both clear, from either side", async () => {
    const world = baseline();
    addPeer(world, 10, "1.5.0");
    for (const subject of [42, 10]) {
      const { code, report } = await ready(world, subject);
      expect(code).toBe(0);
      expect(report.verdict).toBe("ready");
      expect(checksRow(report)?.versionCollision?.status).toBe("clear");
      const cli = await verb(world, subject);
      expect(cli.code).toBe(0);
      expect(cli.report.status).toBe("clear");
    }
  });

  it("without the opt-in the report is byte-identical to a build with no limb, and no inventory call is made", async () => {
    const world = baseline();
    world.gatesAt = (): string => gatesText(NO_OPT_IN);
    world.versions[MAIN] = "1.4.0"; // a "collision" nobody opted in to
    const source = worldSource(world, 42);
    const { io, out } = capture();
    const code = await prReady(readyInput(42, PLAIN_GATES), io, deps(source));
    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(JSON.stringify(report)).not.toContain("versionCollision");
    expect(report.meta.notes).toEqual([]);
    expect(report.meta.warnings).toEqual([]);
    // Only the reads pr ready already made: the gates file at the base/default tip.
    expect(source.calls).toEqual([`file:nen/gates.json@${MAIN}`, `file:nen/workflow.json@${MAIN}`]);
    // A source that offers none of the new methods changes nothing either.
    const bare = worldSource(world, 42, { omit: ["openPullRequestsPage", "branchTip", "mergeBase", "pullRequestFiles"] });
    const again = capture();
    expect(await prReady(readyInput(42, PLAIN_GATES), again.io, deps(bare))).toBe(0);
    expect(again.out.join("\n")).toBe(out.join("\n"));
    const cli = await verb(world, 42, {}, PLAIN_ROOT);
    expect(cli.code).toBe(0);
    expect(cli.report.status).toBe("not-applicable");
    expect(cli.calls.some((key): boolean => key.startsWith("pulls:"))).toBe(false);
  });

  it("a head that adds the opt-in to its own copy does not opt the repository in: readiness unchanged, the verb warns", async () => {
    const world = baseline();
    world.gatesAt = (): string => gatesText(NO_OPT_IN);
    const { code, report } = await ready(world, 42, {}, OPTED_GATES);
    expect(code).toBe(0);
    expect(report.meta.versionCollision).toBeUndefined();
    // Not opted in: `pr ready` adds nothing, not even the difference warning.
    expect(report.meta.warnings).toEqual([]);
    const cli = await verb(world, 42);
    expect(cli.code).toBe(0);
    expect(cli.report.status).toBe("not-applicable");
    expect(cli.report.warnings.join("\n")).toMatch(/the checkout's .* declares version_collision .* but the default-branch tip .* declares no version_collision; only the default tip's copy applies/);
  });

  describe("the schema, accepted and refused by pointer", () => {
    const root = (block: unknown): unknown => JSON.parse(gatesText(block)) as unknown;
    it("accepts the documented block, and null or absent as no opt-in", () => {
      expect(parseVersionCollision("g.json", root(OPT_IN))).toEqual({
        versionFile: VERSION_FILE,
        versionPointer: "/version",
        shippedPaths: ["claude/**", ".claude-plugin/**"],
      });
      expect(parseVersionCollision("g.json", root(null))).toBeNull();
      expect(parseVersionCollision("g.json", root(NO_OPT_IN))).toBeNull();
      expect(parseGateIdentities("g.json", root(OPT_IN)).versionCollision?.versionPointer).toBe("/version");
      expect("versionCollision" in parseGateIdentities("g.json", root(NO_OPT_IN))).toBe(false);
      expect(parseVersionCollision("g.json", root({ ...OPT_IN, version_pointer: "/a~1b/~0c/0", shipped_paths: ["src/**/*.ts", "x?.md"] }))).not.toBeNull();
      // Four '**' segments is the bound, accepted; a fifth is refused below.
      expect(parseVersionCollision("g.json", root({ ...OPT_IN, shipped_paths: ["**/a/**/b/**/c/**"] }))).not.toBeNull();
    });
    it.each([
      ["version_collision", "a string"],
      ["version_collision.version_file", { version_file: "" }],
      ["version_collision.version_file", { version_file: "plugins/*.json" }],
      ["version_collision.version_file", { version_file: "../plugin.json" }],
      ["version_collision.version_file", { version_file: "a/./plugin.json" }],
      ["version_collision.version_file", { version_file: "a\\plugin.json" }],
      ["version_collision.version_file", { version_file: "/abs/plugin.json" }],
      ["version_collision.version_file", { version_file: "a//plugin.json" }],
      ["version_collision.version_file", { version_file: "plugin\u0007.json" }],
      ["version_collision.version_pointer", { version_pointer: "version" }],
      ["version_collision.version_pointer", { version_pointer: "/a~2" }],
      ["version_collision.version_pointer", { version_pointer: 7 }],
      ["version_collision.shipped_paths", { shipped_paths: [] }],
      ["version_collision.shipped_paths", { shipped_paths: "claude/**" }],
      ["version_collision.shipped_paths[1]", { shipped_paths: ["claude/**", "claude/**"] }],
      ["version_collision.shipped_paths[0]", { shipped_paths: ["claude/{a,b}/**"] }],
      ["version_collision.shipped_paths[0]", { shipped_paths: ["claude/[ab]"] }],
      ["version_collision.shipped_paths[0]", { shipped_paths: ["claude/a**"] }],
      ["version_collision.shipped_paths[0]", { shipped_paths: ["../claude/**"] }],
      ["version_collision.shipped_paths[0]", { shipped_paths: ["**/a/**/b/**/c/**/d/**"] }],
    ])("refuses %s: %j", (pointer, override) => {
      const block = typeof override === "string" ? override : { ...OPT_IN, ...override };
      let caught: unknown;
      try {
        parseVersionCollision("g.json", root(block));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SchemaError);
      expect((caught as SchemaError).pointer).toBe(pointer);
    });
    it("refuses a key the block does not define, as every gates key is (zheref/nen#310)", () => {
      expect(() => parseVersionCollision("g.json", root({ ...OPT_IN, version_regex: ".*" }))).toThrow(/version_regex/);
    });
  });
});

// ── AC-5 / SC-1 ─────────────────────────────────────────────────────────────

/** Every read the baseline-plus-one-matching-peer world makes, by key. */
function readKeysOf(world: CollisionWorld): string[] {
  const peer = world.prs.find((entry): boolean => entry.number === 10);
  if (peer === undefined) throw new Error("no peer");
  return [
    `file:nen/gates.json@${MAIN}`,
    "files:#42",
    `file:${VERSION_FILE}@${SUBJECT_HEAD}`,
    "tip:main",
    `file:${VERSION_FILE}@${MAIN}`,
    `compare:main...${SUBJECT_HEAD}`,
    `file:${VERSION_FILE}@${MAIN_OLD}`,
    "pulls:1",
    `file:${VERSION_FILE}@${peer.head}`,
    "files:#10",
    `compare:main...${peer.head}`,
    `file:${VERSION_FILE}@${world.mergeBases[`main...${peer.head}`] ?? ""}`,
  ];
}

/** The baseline plus #10 proposing the subject's version from a base that already carried it: inherited, so clear when complete. */
function oneInheritingPeer(): CollisionWorld {
  const world = baseline();
  addPeer(world, 10, "1.4.0", { mergeBaseVersion: "1.4.0" });
  return world;
}

/**
 * Both surfaces, each on a FRESH world from `make` (a hook that moves the
 * repository must move it under each surface's own two passes), are unknown
 * naming `why`, and agree on the evaluator's status, version and collisions.
 */
async function expectUnknownEverywhere(make: () => { world: CollisionWorld; options: ReadOptions }, why: RegExp): Promise<void> {
  const first = make();
  const { code, report } = await ready(first.world, 42, first.options);
  expect(code, "pr ready exit").toBe(1);
  expect(report.verdict).not.toBe("ready");
  const row = checksRow(report);
  expect(row?.status, "row 2").toBe("unevaluated");
  expect(row?.missing ?? "").toMatch(why);
  expect(row?.versionCollision?.status).toBe("unknown");
  const second = make();
  const cli = await verb(second.world, 42, second.options);
  expect(cli.code, "verb exit").toBe(1);
  expect(cli.report.status).toBe("unknown");
  expect(cli.report.missing.join("\n")).toMatch(why);
  // The missing text may name which diagnostic copy declares the block (--gates
  // here, the checkout there); the evaluator's decision is the same.
  const decided = (result: VersionCollisionResult | undefined): unknown =>
    result === undefined ? undefined : { status: result.status, proposedVersion: result.proposedVersion, collisions: result.collisions };
  expect(decided(cli.report)).toEqual(decided(report.meta.versionCollision));
}

/** A fixed world and options, as `expectUnknownEverywhere`'s factory. */
const fixed = (make: () => CollisionWorld, options: ReadOptions = {}): (() => { world: CollisionWorld; options: ReadOptions }) =>
  (): { world: CollisionWorld; options: ReadOptions } => ({ world: make(), options });

describe("AC-5 / SC-1: unreadable, incomplete or moving evidence is unknown on both surfaces, never ready", () => {
  it("the complete fixture is clear (the control every case below perturbs)", async () => {
    const world = oneInheritingPeer();
    const { code, calls } = await ready(world);
    expect(code).toBe(0);
    for (const key of readKeysOf(world)) expect(calls, key).toContain(key);
  });

  it.each(readKeysOf(oneInheritingPeer()).map((key): [string] => [key]))("failing %s is unknown", async (key) => {
    await expectUnknownEverywhere(fixed(oneInheritingPeer, { fail: new Set([key]) }), /could not be read|HTTP 502/);
  });

  it.each(["fileAtRef", "pullRequestFiles", "openPullRequestsPage", "branchTip", "mergeBase"] as const)(
    "a transport without %s is unknown, naming it",
    async (method) => {
      await expectUnknownEverywhere(fixed(oneInheritingPeer, { omit: [method] }), new RegExp(method === "fileAtRef" ? "files at a commit" : method));
    },
  );

  it("hasNextPage after the tenth page is a capped inventory: unknown (forks count toward the cap)", async () => {
    const crowded = (): CollisionWorld => {
      const world = baseline();
      for (let number = 100; number < 1100; number += 1) {
        world.prs.push({ number, head: sha(`${number.toString(16)}a`), base: "main", files: [], fork: true });
      }
      return world;
    };
    await expectUnknownEverywhere(fixed(crowded), /inventory is capped: all 10 pages of 100 were read and GitHub still answered hasNextPage/);
  });

  it("a changed-file list at the 3000-file cap is unknown -- the subject's and a matching peer's", async () => {
    const bigSubject = (): CollisionWorld => {
      const world = baseline();
      world.prs[0]!.files = Array.from({ length: 3000 }, (_, index): string => `claude/f${index}.md`);
      return world;
    };
    await expectUnknownEverywhere(fixed(bigSubject), /#42\) changed files reached the 3000-file cap/);
    const bigPeer = (): CollisionWorld => {
      const world = oneInheritingPeer();
      world.prs.find((entry): boolean => entry.number === 10)!.files = Array.from({ length: 3000 }, (_, index): string => `claude/p${index}.md`);
      return world;
    };
    await expectUnknownEverywhere(fixed(bigPeer), /#10's changed files reached the 3000-file cap/);
  });

  it("an exhausted request budget is unknown", async () => {
    const busy = (): CollisionWorld => {
      const world = baseline();
      for (let number = 100; number < 160; number += 1) addPeer(world, number, "1.4.0", { mergeBaseVersion: "1.4.0" });
      return world;
    };
    await expectUnknownEverywhere(fixed(busy), /request budget \(200 requests\) would be exceeded by reading/);
  });

  const moves: readonly [string, (world: CollisionWorld) => ReadOptions][] = [
    ["a peer's head", (world): ReadOptions => ({ after: (key, n): void => void (key === "pulls:1" && n === 1 && (world.prs[1]!.head = sha("9a"))) })],
    ["a peer's base", (world): ReadOptions => ({ after: (key, n): void => void (key === "pulls:1" && n === 1 && (world.prs[1]!.base = "release")) })],
    ["a pull request opening", (world): ReadOptions => ({ after: (key, n): void => void (key === "pulls:1" && n === 1 && world.prs.push({ number: 77, head: sha("77"), base: "main", files: [] })) })],
    ["a pull request closing", (world): ReadOptions => ({ after: (key, n): void => void (key === "pulls:1" && n === 1 && world.prs.splice(1, 1)) })],
    ["the subject's own head", (world): ReadOptions => ({ after: (key, n): void => void (key === "files:#42" && n === 1 && (world.prs[0]!.head = sha("8b"))) })],
    ["the base tip", (world): ReadOptions => ({ after: (key, n): void => void (key === "tip:main" && n === 1 && (world.branches["main"] = sha("6f"))) })],
  ];
  it.each(moves)("%s moving between the two passes is unknown: moved during inspection", async (_what, mutate) => {
    await expectUnknownEverywhere((): { world: CollisionWorld; options: ReadOptions } => {
      const world = oneInheritingPeer();
      return { world, options: mutate(world) };
    }, /moved during inspection/);
  });

  it("FORK churn between the two passes is not drift; same-repository churn still is", async () => {
    const withFork = (): CollisionWorld => {
      const world = oneInheritingPeer();
      addPeer(world, 31, "1.4.0", { fork: true });
      return world;
    };
    const forkChurn: readonly ((world: CollisionWorld) => void)[] = [
      (world): void => void (world.prs.find((entry): boolean => entry.number === 31)!.head = sha("3a")),
      (world): void => void world.prs.splice(world.prs.findIndex((entry): boolean => entry.number === 31), 1),
      (world): void => void world.prs.push({ number: 88, head: sha("88"), base: "main", files: ["claude/x.md"], fork: true }),
    ];
    for (const churn of forkChurn) {
      const world = withFork();
      const options: ReadOptions = { after: (key, n): void => void (key === "pulls:1" && n === 1 && churn(world)) };
      const { code, report } = await ready(world, 42, options);
      expect(code).toBe(0);
      expect(checksRow(report)?.versionCollision?.status).toBe("clear");
      const again = withFork();
      expect((await verb(again, 42, { after: (key, n): void => void (key === "pulls:1" && n === 1 && churn(again)) })).code).toBe(0);
    }
    await expectUnknownEverywhere((): { world: CollisionWorld; options: ReadOptions } => {
      const world = withFork();
      return { world, options: { after: (key, n): void => void (key === "pulls:1" && n === 1 && (world.prs[1]!.head = sha("9a"))) } };
    }, /moved during inspection: #10's head moved/);
  });

  it("the default tip moving under a stacked base is unknown too", async () => {
    await expectUnknownEverywhere((): { world: CollisionWorld; options: ReadOptions } => {
      const world = baseline();
      const parent = sha("5d");
      world.branches["feature/parent"] = parent;
      world.versions[parent] = "1.3.0";
      world.prs[0]!.base = "feature/parent";
      world.mergeBases[`feature/parent...${SUBJECT_HEAD}`] = MAIN_OLD;
      return { world, options: { after: (key, n): void => void (key === "tip:main" && n === 1 && (world.branches["main"] = sha("6f"))) } };
    }, /tip of 'main' moved/);
  });

  it("an unreadable default-tip policy, with a copy showing the opt-in, is unknown", async () => {
    const unreadable = (): CollisionWorld => {
      const world = baseline();
      world.gatesAt = (ref): string | null => {
        if (ref === MAIN) throw new Error("HTTP 403: Resource not accessible by integration");
        return gatesText();
      };
      return world;
    };
    await expectUnknownEverywhere(fixed(unreadable), /default-branch tip's nen\/gates\.json \(acme\/widget@1b1b1b1:?.*could not be read \(HTTP 403/);
  });

  it("a head with no usable version is unknown", async () => {
    await expectUnknownEverywhere(fixed((): CollisionWorld => {
      const world = baseline();
      world.versions[SUBJECT_HEAD] = null;
      return world;
    }), /carries no \.claude-plugin\/plugin\.json/);
    await expectUnknownEverywhere(fixed((): CollisionWorld => {
      const world = baseline();
      world.manifests[SUBJECT_HEAD] = '{"version": 2}';
      return world;
    }), /could not be parsed/);
  });

  it("checks that already fail keep their reason first, the unknown limb appended", async () => {
    const world = oneInheritingPeer();
    const base = worldSource(world, 42, { fail: new Set(["pulls:1"]) });
    const red: PrStateSource = {
      ...base,
      pullRequestSnapshot: async (repo, n) => {
        const snapshot = await base.pullRequestSnapshot(repo, n);
        return { ...snapshot, checkRollup: [{ name: "ci / build", status: "COMPLETED", conclusion: "FAILURE" }] };
      },
    };
    const { io, out } = capture();
    expect(await prReady(readyInput(42), io, deps(red))).toBe(1);
    const report = JSON.parse(out.join("\n")) as ReadyReport;
    expect(report.gateLine).toMatch(/^not-ready: required checks reported but are not all green \(CON-32a\) — failing: .* — and the version collision could not be judged/);
  });
});

describe("SC-1: one evaluator -- both surfaces agree on every fixture", () => {
  const edited = (edit: (world: CollisionWorld) => void): (() => CollisionWorld) => (): CollisionWorld => {
    const world = baseline();
    edit(world);
    return world;
  };
  /** The pull request's base, pinned at a commit of its own (the default tip stays MAIN). */
  const BASE_COMMIT = sha("aa");
  /**
   * A baseline whose DEFAULT tip carries `text` as its nen/gates.json (or
   * whose read throws). `base`, when given, pins the pull request's base at
   * BASE_COMMIT carrying that text; otherwise the base IS the default tip.
   */
  const defaultTipGates = (text: string | Error, base?: string): (() => CollisionWorld) =>
    edited((world): void => {
      if (base !== undefined) world.snapshot = { base: BASE_COMMIT, default: MAIN };
      world.gatesAt = (ref): string | null => {
        if (ref === BASE_COMMIT && base !== undefined) return base;
        if (ref !== MAIN) return gatesText();
        if (text instanceof Error) throw text;
        return text;
      };
    });
  const UPSTREAM = new Error("HTTP 502: upstream");
  const MALFORMED = "{ not json";
  const plainText = gatesText(NO_OPT_IN);
  const unknownTopKey = (block: unknown): string => JSON.stringify({ ...(JSON.parse(gatesText(block)) as object), future_gate: { on: true } });
  /** The default tip's raw block is present, but the block does not validate here. */
  const invalidBlock = gatesText({ ...OPT_IN, shipped_paths: [] });
  /** The two surfaces read different LOCAL copies by design (--gates there, the checkout here): one name for both. */
  const sameLocal = (text: string): string => text.replaceAll(`--gates ${OPTED_GATES}`, "<local copy>").replaceAll(`the checkout's ${join(ROOT, "nen", "gates.json")}`, "<local copy>");
  type Expected = "clear" | "collision" | "not-applicable" | "unknown" | "absent" | "absent-undecided";
  /** [name, world, subject (-1: #42 with an unreadable inventory), the LOCAL copy the caller holds, expected]. */
  const fixtures: readonly [string, () => CollisionWorld, number, "opted" | "plain", Expected][] = [
    ["clear", baseline, 42, "opted", "clear"],
    ["base collision", edited((world): void => void (world.versions[MAIN] = "1.4.0")), 42, "opted", "collision"],
    ["unbumped collision", edited((world): void => void ((world.versions[SUBJECT_HEAD] = "1.3.0"), (world.versions[MAIN] = "1.3.5"))), 42, "opted", "collision"],
    ["peer collision", edited((world): void => void addPeer(world, 10, "1.4.0")), 42, "opted", "collision"],
    ["peer collision, run from the peer", edited((world): void => void addPeer(world, 10, "1.4.0")), 10, "opted", "collision"],
    ["inherited peer", oneInheritingPeer, 42, "opted", "clear"],
    ["not shipped", edited((world): void => void (world.prs[0]!.files = ["README.md"])), 42, "opted", "not-applicable"],
    ["unreadable inventory", baseline, -1, "opted", "unknown"],
    // 1. A readable, valid default tip decides ALONE: copies never opt in, never opt out.
    ["not opted in", defaultTipGates(plainText), 42, "plain", "absent"],
    ["not opted in, every copy declaring the block", defaultTipGates(plainText, gatesText()), 42, "opted", "absent"],
    ["no gates file at the default tip (a clean 404)", edited((world): void => void (world.gatesAt = (ref): string | null => (ref === MAIN ? null : gatesText()))), 42, "opted", "absent"],
    ["opted in, every copy WITHOUT the block", defaultTipGates(gatesText(), plainText), 42, "plain", "clear"],
    // 2a. The default tip cannot decide, and its own raw JSON shows the opt-in.
    ["2a: default tip: shipped_paths []", defaultTipGates(invalidBlock), 42, "plain", "unknown"],
    ["2a: default tip: an unknown version_regex key in the block", defaultTipGates(gatesText({ ...OPT_IN, version_regex: ".*" })), 42, "plain", "unknown"],
    ["2a: default tip: a newer version", defaultTipGates(JSON.stringify({ ...(JSON.parse(gatesText()) as object), version: 2 })), 42, "plain", "unknown"],
    ["2a: default tip: an unknown top-level key beside the block", defaultTipGates(unknownTopKey(OPT_IN)), 42, "plain", "unknown"],
    // 2b. The default tip cannot decide; ONE diagnostic copy shows the opt-in.
    ["2b base: default tip unreadable, the base declares", defaultTipGates(UPSTREAM, gatesText()), 42, "plain", "unknown"],
    ["2b base: default tip malformed, the base declares", defaultTipGates(MALFORMED, gatesText()), 42, "plain", "unknown"],
    ["2b base raw: default tip unreadable, the base's block does not validate", defaultTipGates(UPSTREAM, invalidBlock), 42, "plain", "unknown"],
    ["2b local: default tip unreadable, the checkout / --gates declares", defaultTipGates(UPSTREAM), 42, "opted", "unknown"],
    ["2b local: default tip malformed, the checkout / --gates declares", defaultTipGates(MALFORMED), 42, "opted", "unknown"],
    // The mirrors: the default tip cannot decide and NO copy shows the opt-in.
    ["no evidence: default tip unreadable, base at the same commit", defaultTipGates(UPSTREAM), 42, "plain", "absent-undecided"],
    ["no evidence: default tip unreadable, base readable without the block", defaultTipGates(UPSTREAM, plainText), 42, "plain", "absent-undecided"],
    ["no evidence: default tip malformed", defaultTipGates(MALFORMED, plainText), 42, "plain", "absent-undecided"],
    ["no evidence: default tip carries an unknown key and no block", defaultTipGates(unknownTopKey(NO_OPT_IN), plainText), 42, "plain", "absent-undecided"],
    ["no evidence: default tip: a newer version, version_collision null", defaultTipGates(JSON.stringify({ ...(JSON.parse(gatesText(null)) as object), version: 2 }), plainText), 42, "plain", "absent-undecided"],
  ];
  it.each(fixtures)("%s", async (_name, make, which, copies, expected) => {
    // -1: the subject #42 with an unreadable inventory -- SC-1's "0 successful verdicts".
    const subject = which === -1 ? 42 : which;
    const options: ReadOptions = which === -1 ? { fail: new Set(["pulls:1"]) } : {};
    const readiness = await ready(make(), subject, options, copies === "plain" ? PLAIN_GATES : OPTED_GATES);
    const cli = await verb(make(), subject, options, copies === "plain" ? PLAIN_ROOT : ROOT);
    const fromReady = readiness.report.meta.versionCollision;
    if (expected === "absent" || expected === "absent-undecided") {
      // Not opted in: no limb anywhere, nothing added to readiness' report.
      expect(fromReady).toBeUndefined();
      expect(JSON.stringify(readiness.report)).not.toContain("versionCollision");
      expect(JSON.stringify(readiness.report)).not.toMatch(/version collision|zheref\/nen#663/i);
      expect(readiness.calls.some((key): boolean => key.startsWith("pulls:") || key.startsWith("tip:") || key.startsWith("files:"))).toBe(false);
      expect(cli.report.status).toBe("not-applicable");
      expect(cli.code).toBe(0);
      const undecided = cli.report.warnings.filter((line): boolean => line.includes("no copy of nen/gates.json read here declares version_collision"));
      expect(undecided).toHaveLength(expected === "absent-undecided" ? 1 : 0);
      if (expected === "absent-undecided") expect(undecided[0]).toMatch(/default-branch tip's nen\/gates\.json .*(could not be read|refused by this build).*treated as not opted in for this read/);
    } else {
      expect(fromReady?.status).toBe(expected);
      expect(cli.report.status).toBe(expected);
      const outcome = (result: VersionCollisionResult): unknown => JSON.parse(sameLocal(JSON.stringify(outcomeOf(result)))) as unknown;
      expect(outcome(cli.report)).toEqual(outcome(fromReady ?? cli.report));
      expect(checksRow(readiness.report)?.versionCollision).toEqual(outcomeOf(fromReady ?? cli.report));
    }
    if (expected === "unknown" || expected === "collision") {
      expect(readiness.report.verdict).not.toBe("ready");
      expect(cli.code).toBe(1);
    }
    if (expected === "unknown" && _name.startsWith("2")) {
      // Names what could not be read or validated, and where the opt-in showed.
      const missing = cli.report.missing.join("\n");
      expect(missing).toMatch(/default-branch tip's nen\/gates\.json .*(could not be read|refused by this build)/);
      expect(missing).toMatch(
        _name.startsWith("2a") ? /that file's own JSON carries a non-null version_collision key/ : _name.startsWith("2b base") ? /the pull request's base \(.*\) declares version_collision/ : /the checkout's .* declares version_collision/,
      );
    }
    expect(cli.code === 0).toBe(readiness.report.verdict === "ready");
  });

  it("2b local raw (the verb): the checkout's copy does not validate but carries the key -- unknown, naming the checkout", async () => {
    const root = makeTempDir("nen-663-raw-root-");
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "gates.json"), invalidBlock);
    const cli = await verb(defaultTipGates(UPSTREAM)(), 42, {}, root);
    expect(cli.code).toBe(1);
    expect(cli.report.status).toBe("unknown");
    expect(cli.report.missing.join("\n")).toContain(`could not be read (HTTP 502: upstream), and the checkout's ${join(root, "nen", "gates.json")} declares version_collision`);
  });

  it("raw evidence is a parsed JSON object whose root carries a non-null version_collision, nothing else", () => {
    expect(rawDeclaresOptIn(invalidBlock)).toBe(true);
    expect(rawDeclaresOptIn(JSON.stringify({ version_collision: false }))).toBe(true);
    expect(rawDeclaresOptIn(JSON.stringify({ version_collision: null }))).toBe(false);
    expect(rawDeclaresOptIn(plainText)).toBe(false);
    expect(rawDeclaresOptIn(MALFORMED)).toBe(false);
    expect(rawDeclaresOptIn(JSON.stringify([{ version_collision: OPT_IN }]))).toBe(false);
    expect(rawDeclaresOptIn(JSON.stringify({ checks: { version_collision: OPT_IN } }))).toBe(false);
  });

  it("a refused default tip names the pointer it refused", async () => {
    const cli = await verb(defaultTipGates(gatesText({ ...OPT_IN, shipped_paths: [] }))());
    expect(cli.report.missing.join("\n")).toMatch(/refused by this build .*at version_collision\.shipped_paths, is empty/);
    const unknownKey = await verb(defaultTipGates(gatesText({ ...OPT_IN, version_regex: ".*" }))());
    expect(unknownKey.report.missing.join("\n")).toMatch(/version_regex/);
  });

  it("`pr ready --gates <a file WITH the block>` with the default tip unreadable is unknown, naming --gates", async () => {
    const world = defaultTipGates(new Error("HTTP 403: Resource not accessible by integration"))();
    const { code, report } = await ready(world, 42, {}, OPTED_GATES);
    expect(code).toBe(1);
    expect(checksRow(report)?.status).toBe("unevaluated");
    expect(report.meta.versionCollision?.status).toBe("unknown");
    expect(report.gateLine).toContain("could not be read (HTTP 403: Resource not accessible by integration)");
    expect(report.gateLine).toContain(`--gates ${OPTED_GATES} declares version_collision`);
  });

  it("`pr ready --gates <a file without the block>` with the default tip unreadable and no copy declaring keeps the verdict it had: no limb", async () => {
    const world = defaultTipGates(new Error("HTTP 403: Resource not accessible by integration"))();
    const { code, report } = await ready(world, 42, {}, PLAIN_GATES);
    expect(code).toBe(0);
    expect(report.verdict).toBe("ready");
    expect(checksRow(report)?.versionCollision).toBeUndefined();
    expect(report.meta.versionCollision).toBeUndefined();
  });

  it("a repository that has NOT opted in, whose default-tip read fails, reads exactly as before #663: no limb, no note, no warning of its own", async () => {
    // The base is readable at ANOTHER commit, declares no opt-in and supplies
    // the identities; only the default tip's read fails.
    const world = defaultTipGates(UPSTREAM, plainText)();
    const { code, report, calls } = await ready(world, 42, {}, PLAIN_GATES);
    expect(code).toBe(0);
    expect(report.meta.versionCollision).toBeUndefined();
    expect(report.meta.notes.join("\n")).not.toMatch(/version.collision/i);
    expect(report.meta.warnings).toEqual([]);
    expect(calls).toEqual([`file:nen/gates.json@${BASE_COMMIT}`, `file:nen/gates.json@${MAIN}`, `file:nen/workflow.json@${BASE_COMMIT}`, `file:nen/workflow.json@${MAIN}`]);
    const cli = await verb(defaultTipGates(UPSTREAM, plainText)(), 42, {}, PLAIN_ROOT, []);
    expect(cli.code).toBe(0);
    expect(cli.out[0]).toBe(`${SLUG}#42: version collision not-applicable: the default-branch tip's nen/gates.json could not be read or validated, and no copy declares version_collision`);
    expect(cli.out).toContain(
      `  warning: version collision: the default-branch tip's nen/gates.json (${SLUG}@${MAIN}:nen/gates.json) could not be read (HTTP 502: upstream), and no copy of nen/gates.json read here declares version_collision, so the repository is treated as not opted in for this read (zheref/nen#663).`,
    );
  });

  it("--explain names the limb, its policy source and its read counts on both surfaces", async () => {
    const world = baseline();
    const { io, out } = capture();
    await prReady(readyInput(42, OPTED_GATES, ["explain"]), io, deps(worldSource(world, 42)));
    const text = out.join("\n");
    expect(text).toContain("└ version collision: clear: version 1.4.0 is on no target tip and proposed by no other open pull request");
    expect(text).toContain(`└ version collision policy: ${SLUG}@${MAIN}:nen/gates.json · ${VERSION_FILE} /version · shipped claude/**, .claude-plugin/**`);
    expect(text).toMatch(/└ version collision reads: \d+ of 200 requests · 2 inventory page\(s\) · 0 open pull request\(s\) inspected/);
    const cli = await verb(world, 42, {}, ROOT, ["explain"]);
    expect(cli.code).toBe(0);
    expect(cli.out[0]).toBe(`${SLUG}#42: version collision clear: version 1.4.0 is on no target tip and proposed by no other open pull request`);
    expect(cli.out.join("\n")).toContain("version collision reads:");
  });

  it("the verb's --explain gives each collision kind its own line, naming version, branch and commit (round 2, N4)", async () => {
    const tip = await verb(edited((world): void => void (world.versions[MAIN] = "1.4.0"))(), 42, {}, ROOT, ["explain"]);
    expect(tip.out).toContain(`  collision (base): 1.4.0 is already at the tip of 'main' (${MAIN})`);
    const unbumped = await verb(edited((world): void => void ((world.versions[SUBJECT_HEAD] = "1.3.0"), (world.versions[MAIN] = "1.3.5")))(), 42, {}, ROOT, ["explain"]);
    expect(unbumped.out).toContain(`  collision (unbumped): the head keeps its merge base's 1.3.0, and 'main' moved on to 1.3.5 at ${MAIN} -- merged, it would ship under 1.3.5`);
    expect(unbumped.out.join("\n")).not.toContain("proposed by #");
    const peerWorld = baseline();
    const peer = addPeer(peerWorld, 11, "1.4.0", { draft: true });
    const onePeer = await verb(peerWorld, 42, {}, ROOT, ["explain"]);
    expect(onePeer.out).toContain(`  collision (peer): 1.4.0 is also proposed by #11 (head ${peer.head}, base 'main', draft)`);
  });

  it("the verb: usage is exit 2, a head mismatch exit 8, no token unknown (exit 1)", async () => {
    const world = baseline();
    const run = async (values: Record<string, string>, source: PrStateSource | null = worldSource(world, 42)): Promise<{ code: number; out: string[]; err: string[] }> => {
      const { io, out, err } = capture();
      const code = await prVersionCollision({ positionals: ["pr", "version-collision", "42"], values, booleans: new Set(["json"]), repoFlag: ROOT }, io, deps(source));
      return { code, out, err };
    };
    expect((await run({})).code).toBe(2);
    expect((await run({ "gh-repo": SLUG, "require-head": "xyz" })).code).toBe(2);
    const mismatch = await run({ "gh-repo": SLUG, "require-head": "abcdef1" });
    expect(mismatch.code).toBe(8);
    expect(JSON.parse(mismatch.out.join("\n"))).toMatchObject({ contract: "nen.pr.ready.head-mismatch/v0.1", githubHead: SUBJECT_HEAD });
    expect((await run({ "gh-repo": SLUG, "require-head": SUBJECT_HEAD.slice(0, 7) })).code).toBe(0);
    const noToken = await run({ "gh-repo": SLUG }, null);
    expect(noToken.code).toBe(1);
    expect(JSON.parse(noToken.out.join("\n"))).toMatchObject({ status: "unknown" });
  });
});
