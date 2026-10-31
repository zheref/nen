// src/run/manifest.test.ts -- the run manifest's pure half: what start and
// append do to what is on disk, and what a stored manifest must look like.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseIdleAnswers,
  parseRunManifest,
  planAppend,
  planPark,
  planStart,
  readClaims,
  readRunManifest,
  RunManifestError,
  RUN_CONTRACT,
  type AppendInput,
  type RunManifest,
} from "./manifest.js";

const NOW = "2026-10-22T00:00:00.000Z";
const empty = (): RunManifest => ({ contract: RUN_CONTRACT, id: "r1", repo: "o/n", startedAt: NOW, idleAnswers: null, prs: [], parked: [] });
const input = (over: Partial<AppendInput> = {}): AppendInput => ({
  issue: "NN#12",
  pr: 480,
  base: "integration/x",
  branch: "opus/kurapika/x",
  kind: "delivery",
  head: "abcdef1",
  effort: "opus/kurapika/x",
  now: NOW,
  ...over,
});

describe("planStart", () => {
  it("starts a run with the manifest's keys in contract order", () => {
    const result = planStart(null, "r1", "o/n", NOW, { "direct-mismatch": "default" });
    expect(result.outcome).toBe("started");
    expect(Object.keys(result.manifest)).toEqual(["contract", "id", "repo", "startedAt", "idleAnswers", "prs", "parked"]);
    expect(result.manifest.prs).toEqual([]);
    expect(result.manifest.parked).toEqual([]);
  });

  it("refuses a re-start for another repository", () => {
    const existing = planStart(null, "r1", "o/n", NOW, null).manifest;
    expect(planStart(existing, "r1", "o/other", NOW, null).outcome).toBe("conflict");
  });

  it("is the resume when the answers are the same, in any key order", () => {
    const existing = planStart(null, "r1", "o/n", NOW, { a: "hold", b: "default" }).manifest;
    expect(planStart(existing, "r1", "o/n", "2026-10-23T00:00:00.000Z", { b: "default", a: "hold" }).outcome).toBe("existing");
    expect(planStart(empty(), "r1", "o/n", NOW, null).outcome).toBe("existing");
    expect(planStart(empty(), "r1", "o/n", NOW, {}).outcome).toBe("existing");
  });

  it("refuses other answers: launch answers are fixed at start (HR-5)", () => {
    const existing = planStart(null, "r1", "o/n", NOW, { a: "hold" }).manifest;
    const result = planStart(existing, "r1", "o/n", NOW, { a: "refuse" });
    expect(result.outcome).toBe("conflict");
    expect(result.outcome === "conflict" ? result.reason : "").toMatch(/fixed at start/);
    expect(planStart(existing, "r1", "o/n", NOW, null).outcome).toBe("conflict");
    expect(planStart(existing, "r1", "o/n", NOW, {}).outcome).toBe("conflict");
  });
});

describe("planAppend", () => {
  it("appends a PR whatever its base, keys in contract order", () => {
    const result = planAppend(empty(), input({ base: "main" }));
    expect(result.outcome).toBe("appended");
    expect(result.manifest.prs).toHaveLength(1);
    expect(Object.keys(result.manifest.prs[0] as object)).toEqual(["issue", "pr", "base", "branch", "kind", "head", "effort", "recordedAt"]);
  });

  it("is unchanged on the same facts, the retry after a partial failure", () => {
    const once = planAppend(empty(), input()).manifest;
    const again = planAppend(once, input({ now: "2026-10-23T00:00:00.000Z", effort: null }));
    expect(again.outcome).toBe("unchanged");
    expect(again.manifest).toBe(once);
  });

  it("updates a moved head or a retargeted base and keeps the previous row in the report", () => {
    const once = planAppend(empty(), input()).manifest;
    const moved = planAppend(once, input({ head: "1234567", base: "main" }));
    expect(moved.outcome).toBe("updated");
    if (moved.outcome !== "updated") return;
    expect(moved.previous.head).toBe("abcdef1");
    expect(moved.entry).toMatchObject({ head: "1234567", base: "main", effort: "opus/kurapika/x" });
    expect(moved.manifest.prs).toHaveLength(1);
  });

  it("fills an effort a row did not have", () => {
    const once = planAppend(empty(), input({ effort: null })).manifest;
    const filled = planAppend(once, input());
    expect(filled.outcome).toBe("updated");
  });

  it("refuses another issue, kind or effort for a recorded PR", () => {
    const once = planAppend(empty(), input()).manifest;
    for (const over of [{ issue: "NN#13" }, { kind: "release" as const }, { effort: "other" }]) {
      const result = planAppend(once, input(over));
      expect(result.outcome).toBe("conflict");
      expect(result.manifest).toBe(once);
    }
  });
});

describe("planPark", () => {
  it("records an effort parked on a row once, keys in contract order, and is unchanged on the retry", () => {
    const parked = planPark(empty(), "NN#12", "direct-mismatch", NOW);
    expect(parked.outcome).toBe("parked");
    expect(Object.keys(parked.entry)).toEqual(["issue", "row", "at"]);
    const again = planPark(parked.manifest, "NN#12", "direct-mismatch", "2026-10-23T00:00:00.000Z");
    expect(again.outcome).toBe("unchanged");
    expect(again.manifest.parked).toHaveLength(1);
  });
});

describe("integration and release PRs carry no issue", () => {
  it("records issue null for an integration PR, and refuses null on a delivery row when read back", () => {
    const appended = planAppend(empty(), input({ issue: null, kind: "integration" })).manifest;
    expect(parseRunManifest("m.json", JSON.parse(JSON.stringify(appended))).prs[0]?.issue).toBeNull();
    const bad = { ...appended, prs: [{ ...appended.prs[0], kind: "delivery" }] };
    expect(() => parseRunManifest("m.json", bad)).toThrow(/issue is null/);
  });
});

describe("parseIdleAnswers", () => {
  it("reads a row map to the three HR-5 resolutions", () => {
    expect(parseIdleAnswers('{"direct-mismatch":"default","port-drift":"hold","wrap-up":"refuse"}')).toEqual({
      "direct-mismatch": "default",
      "port-drift": "hold",
      "wrap-up": "refuse",
    });
  });

  it("refuses text that is not JSON, not an object, a bad row id or a resolution out of the set", () => {
    for (const text of ["{", "[]", '"x"', '{"Bad_Row":"hold"}', '{"row":"maybe"}', '{"row":1}']) {
      expect(() => parseIdleAnswers(text)).toThrow(RunManifestError);
    }
  });
});

describe("parseRunManifest / readRunManifest", () => {
  const good = planAppend(planStart(null, "r1", "o/n", NOW, { a: "hold" }).manifest, input()).manifest;

  it("round-trips what start and append wrote", () => {
    expect(parseRunManifest("m.json", JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it("refuses a document this build did not write, field by field, and never reads it as empty", () => {
    const bad: unknown[] = [
      null,
      [],
      { ...good, contract: "nen.run/v9" },
      { ...good, id: "../x" },
      { ...good, startedAt: "yesterday" },
      { ...good, idleAnswers: { a: "maybe" } },
      { ...good, prs: "none" },
      { ...good, prs: [{ ...good.prs[0], pr: 0 }] },
      { ...good, prs: [{ ...good.prs[0], kind: "hotfix" }] },
      { ...good, prs: [{ ...good.prs[0], head: "zzz" }] },
      { ...good, prs: [{ ...good.prs[0], issue: "twelve" }] },
      { ...good, prs: [{ ...good.prs[0], base: "-x" }] },
      { ...good, prs: [{ ...good.prs[0], effort: 3 }] },
      { ...good, prs: [{ ...good.prs[0], branch: 7 }] },
      { ...good, repo: "nope" },
      { ...good, parked: "none" },
      { ...good, parked: [{ issue: "NN#1", row: "Bad Row", at: NOW }] },
      { ...good, parked: [{ issue: "NN#1", row: "r", at: "1" }] },
    ];
    for (const value of bad) expect(() => parseRunManifest("m.json", value)).toThrow(/is not a nen.run\/v0.1 manifest/);
  });

  it("carries a claims value verbatim, readable or not, so a rewrite never drops it (zheref/nen#521)", () => {
    expect(Object.keys(parseRunManifest("m.json", good))).not.toContain("claims");
    for (const claims of [[{ issue: "NN#1", branch: null, at: NOW }], "torn"]) {
      const parsed = parseRunManifest("m.json", { ...good, claims });
      expect(parsed.claims).toEqual(claims);
      expect(Object.keys(planPark(parsed, "NN#2", "r", NOW).manifest)).toEqual(["contract", "id", "repo", "startedAt", "idleAnswers", "prs", "parked", "claims"]);
    }
    expect(readClaims(parseRunManifest("m.json", { ...good, claims: [{ issue: "NN#1", at: NOW }] }))).toEqual({ ok: true, recorded: true, claims: [{ issue: "NN#1", branch: null, at: NOW }] });
    expect(readClaims(parseRunManifest("m.json", good))).toEqual({ ok: true, recorded: false, claims: [] });
    expect(readClaims(parseRunManifest("m.json", { ...good, claims: "torn" })).ok).toBe(false);
    // Date.parse reads "1" as 2001-01-01; the shape check refuses it first.
    expect(readClaims(parseRunManifest("m.json", { ...good, claims: [{ issue: "NN#1", at: "1" }] }))).toEqual({ ok: false, reason: "claims[0].at is not an ISO-8601 instant" });
  });

  it("reads a missing file as no run, and an unreadable one as a refusal", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-run-"));
    expect(readRunManifest(join(dir, "none.json"))).toBeNull();
    writeFileSync(join(dir, "torn.json"), "{");
    expect(() => readRunManifest(join(dir, "torn.json"))).toThrow(/not readable JSON/);
  });
});
