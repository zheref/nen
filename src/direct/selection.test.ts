import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadClassifyTaxonomy } from "../classify/taxonomy.js";
import { loadDirectRegistry, parseDirectRegistry } from "./registry.js";
import { resolveDirection } from "./resolve.js";
import { capture, consumerRepo, miniFiles, miniRegistryJson, side, type Json } from "./fixtures/harness.js";

// Registry vocabulary and thresholds are fixture data, not built into the resolver.
function policy(v: Json): void {
  v.picks = {
    fallbackRule: "actionable fallback provider differs from primary, or its surface does",
    recommended: { when: { anyOf: [{ maxJobWeight: 4 }, { effortLevel: "max" }] }, then: "aliases.<primary>.escalation", else: "primary" },
  };
  for (const row of Object.values(v.aliases) as Json[]) {
    row.line = row.reviewer ? null : "fixture-line";
    row.escalation = null;
  }
  v.aliases.A_TOP.escalation = "A_MAX";
  for (const domains of Object.values(v.routing) as Json[]) {
    for (const entry of Object.values(domains) as Json[]) {
      for (const cell of Object.values(entry.cells) as Json[]) cell.runnerUp = side("A_EXEC", "s2");
    }
  }
  v.companions = { role: { heavy: "reviewer", "port-only": "worker" } };
}

function direct(jobs: string[], edit: (v: Json) => void = (): void => {}, taxEdit: (v: Json) => void = (): void => {}, session = { surface: null as string | null, model: null as string | null, effort: null as string | null }): Json {
  const files = miniFiles((v): void => { policy(v); edit(v); }, taxEdit);
  const result = resolveDirection({ registry: loadDirectRegistry("/", files.registryPath), taxonomy: loadClassifyTaxonomy("/", files.taxonomyPath), models: { k1: { deep: "top", frontier: "maxx", fast: "fast" }, k2: { deep: "exec" } } }, { jobs, langs: ["alpha"], kind: "product", role: null, labels: [] }, session);
  return JSON.parse(JSON.stringify(result)) as Json;
}

function companion(v: Json): void {
  for (const job of v.axes.job.keys as Json[]) if (["heavy", "port-only"].includes(job.key)) job.companion = true;
}

function registry(edit: (v: Json) => void): void {
  const v = miniRegistryJson(); policy(v); edit(v); parseDirectRegistry("/fixture/registry.json", v);
}

describe("NN#389 registry-owned selection", () => {
  it("AC-1 escalates on the declared weight and spells the recommended pick through workflow", () => {
    expect(direct(["heavy"]).recommended).toMatchObject({ alias: "A_MAX", surface: "s1", tier: "frontier", surfaceAlias: "maxx", restart: "s1 --model maxx" });
    expect(direct(["plain"]).recommended.alias).toBe("A_TOP");
  });
  it("AC-1 reads changed weight/level predicates, never hard-codes 4 or max", () => {
    const changed = (v: Json): void => { v.picks.recommended.when.anyOf = [{ maxJobWeight: 2 }]; };
    expect(direct(["plain"], changed).recommended.alias).toBe("A_MAX");
    expect(direct(["heavy"], changed).recommended.alias).toBe("A_TOP");
    expect(direct(["mid"], (v): void => { v.picks.recommended.when.anyOf = [{ effortLevel: "medium" }]; }).recommended.alias).toBe("A_MAX");
  });
  it("AC-1 null escalation returns the primary; empty jobs return no recommended pick", () => {
    expect(direct(["heavy"], (v): void => { v.aliases.A_TOP.escalation = null; }).recommended.alias).toBe("A_TOP");
    expect(direct([]).recommended).toBeNull();
  });
  it.each([[["plain"], "s1", "top", "primary", true], [["plain"], "s2", "exec", "fallback", false], [["heavy"], "s1", "maxx", "recommended", false], [["plain"], "s1", "other", "none", false]] as const)("AC-2 compares each pick but preserves primary match: %j %s %s", (jobs, surface, model, within, match) => {
    const result = direct([...jobs], undefined, undefined, { surface, model, effort: null });
    expect(result.mismatch).toMatchObject({ within, match });
    expect(result.mismatch.compares[1]).toMatchObject({ primary: "top", recommended: "top" });
  });
  it("AC-2 a wrong effort rejects a fallback model, and absent session stays null", () => {
    expect(direct(["plain"], undefined, undefined, { surface: "s2", model: "exec", effort: "max" }).mismatch.within).toBe("none");
    expect(direct(["plain"]).mismatch).toBeNull();
  });
  it("AC-1 exposes recommended through JSON and the durable record, including an empty job axis", async () => {
    const files = miniFiles((v): void => { policy(v); v.surfaces.s1.modelsKey = "claude"; });
    const repo = consumerRepo({ claude: { deep: "top", frontier: "maxx" } });
    const args = ["direct", "resolve", "--registry", files.registryPath, "--taxonomy", files.taxonomyPath, "--repo", repo, "--kind", "product", "--lang", "alpha", "--json"];
    const result = await capture([...args, "--job", "heavy", "--record", "NN-389"]);
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out.join("\n")) as Json;
    expect(document.recommended).toMatchObject({ alias: "A_MAX", surfaceAlias: "maxx" });
    expect(JSON.parse(readFileSync(document.record, "utf8")).recommended).toEqual(document.recommended);
    const empty = await capture(args);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.out.join("\n")).recommended).toBeNull();
  });
  it("AC-2 recommended wins a coinciding fallback, following the declared set order", () => {
    const edit = (v: Json): void => { v.aliases.A_TOP.escalation = "A_EXEC"; v.mismatch.within = { set: ["primary", "recommended", "fallback"] }; };
    expect(direct(["heavy"], edit, undefined, { surface: "s2", model: "exec", effort: null }).mismatch.within).toBe("recommended");
    expect(direct(["heavy"], (v): void => { edit(v); v.mismatch.within.set = ["primary", "fallback", "recommended"]; }, undefined, { surface: "s2", model: "exec", effort: null }).mismatch.within).toBe("fallback");
  });
  it("AC-2 all-unread retains legacy match without claiming membership", () => {
    expect(direct(["plain"], undefined, undefined, { surface: "unread", model: "unread", effort: "unread" }).mismatch).toMatchObject({ match: true, within: "none", readable: false });
  });
  it("refuses a duplicate or incomplete within-set order", () => {
    expect((): void => registry((v): void => { v.mismatch.within = { set: ["primary", "primary", "fallback"] }; })).toThrow(/mismatch.within.set/);
  });
  it("AC-3 companion rows remain visible but cannot change domain, effort, tally or picks", () => {
    const mixed = direct(["plain", "heavy", "port-only"], undefined, companion);
    const main = direct(["plain"], undefined, companion);
    for (const field of ["domain", "effort", "aggregate", "winner", "runnerUp", "recommended"]) {
      if (field === "domain") expect(mixed.domain.domain).toBe(main.domain.domain);
      else expect(mixed[field]).toEqual(main[field]);
    }
    expect(mixed.pairs).toHaveLength(3);
    expect(mixed.pairs.find((p: Json): boolean => p.job === "heavy")).toMatchObject({ companion: true, role: "reviewer" });
    expect(mixed.pairs.find((p: Json): boolean => p.job === "port-only")).toMatchObject({ companion: true, role: "worker" });
  });
  it("AC-3 companion-only issues still determine their own effort and pick", () => {
    expect(direct(["heavy"], undefined, companion).effort.weight).toBe(4);
    expect(direct(["heavy"], undefined, companion).recommended.alias).toBe("A_MAX");
  });
  it("aggregate fallback leaves the primary pool using registry precedence", () => {
    const result = direct(["plain", "light"], (v): void => { v.routing.light.dev.cells["*"].winner = side("A_FAST", "s1"); });
    expect(result.winner.alias).toBe("A_TOP");
    expect(result.runnerUp.alias).toBe("A_EXEC");
  });
  it("AC-4 rejects same-pool fallback, including reviewer substitutes", () => {
    expect((): void => registry((v): void => { v.routing.plain.dev.cells["*"].runnerUp = side("A_FAST", "s1"); })).toThrow(/routing.plain.dev.cells.\*.runnerUp/);
    expect((): void => registry((v): void => { v.routing.plain.dev.cells["*"].runnerUp = side("R_BOT", null, { also: "A_FAST" }); })).toThrow(/routing.plain.dev.cells.\*.runnerUp/);
  });
  it("AC-4 accepts a different provider OR a different surface", () => {
    expect((): void => registry((v): void => { v.aliases.A_EXEC.provider = "p1"; })).not.toThrow();
    expect((): void => registry((v): void => { v.aliases.A_FAST.provider = "other"; v.routing.plain.dev.cells["*"].runnerUp = side("A_FAST", "s1"); })).not.toThrow();
  });
  it("AC-4 refuses absent lines, unknown escalations and reviewer escalations", () => {
    expect((): void => registry((v): void => { delete v.aliases.A_TOP.line; })).toThrow(/aliases.A_TOP.line/);
    expect((): void => registry((v): void => { delete v.picks; v.aliases.A_TOP.line = null; })).toThrow(/aliases.A_TOP.line/);
    expect((): void => registry((v): void => { v.aliases.A_TOP.escalation = "missing"; })).toThrow(/aliases.A_TOP.escalation/);
    expect((): void => registry((v): void => { v.aliases.A_TOP.escalation = "R_BOT"; })).toThrow(/aliases.A_TOP.escalation/);
  });
  it.each([{ anyOf: [] }, { anyOf: [{ unknown: true }] }, { anyOf: [{ maxJobWeight: 0 }] }, { anyOf: [{ effortLevel: "unknown" }] }, { anyOf: [{ maxJobWeight: 4, effortLevel: "max" }] }])("refuses malformed recommendation predicates: %j", (when) => {
    expect((): void => registry((v): void => { v.picks.recommended.when = when; })).toThrow(/picks.recommended.when/);
  });
});
