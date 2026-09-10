// src/surface/rules.test.ts -- the table is data, so the things a row must be
// true about are checked HERE rather than trusted at every read site.

import { describe, expect, it } from "vitest";
import { findSurface, invocationFor, SURFACES, surfaceNames, type SurfaceRow } from "./rules.js";

describe("the surface table", () => {
  it("names every surface exactly once", () => {
    expect(new Set(surfaceNames()).size).toBe(SURFACES.length);
    expect(SURFACES.length).toBeGreaterThan(1);
  });

  it("carries the documentation URL every fact in the row was read from", () => {
    // A row is a claim about somebody else's product. The claim is only
    // maintainable if the next reader can go and re-check it.
    for (const row of SURFACES) {
      expect(row.source, `${row.surface} has no source URL`).toMatch(/^https:\/\//);
      expect(row.agentSource, `${row.surface} has no agent source URL`).toMatch(/^https:\/\//);
      expect(row.caveat.length, `${row.surface} has an empty caveat`).toBeGreaterThan(0);
    }
  });

  it("requires only keys it also reads", () => {
    // A surface that REQUIRED a key it then dropped would refuse a source for
    // the sake of a line it was never going to write out.
    for (const row of SURFACES) {
      for (const key of row.skillRequired) {
        expect(row.skillKeys, `${row.surface} requires '${key}' but does not keep it`).toContain(key);
      }
      for (const key of row.agents.required) {
        expect(row.agents.keys, `${row.surface}'s agents require '${key}' but do not keep it`).toContain(key);
      }
    }
  });

  it("spells an invocation with a {name} slot, or documents none at all", () => {
    for (const row of SURFACES) {
      if (row.invocation === null) continue;
      expect(row.invocation, `${row.surface}'s invocation has no {name}`).toContain("{name}");
    }
  });

  it("names an appendix file, or a per-persona directory, never neither", () => {
    for (const row of SURFACES) {
      if (row.agents.kind === "appendix") {
        expect(row.agents.file).not.toBe("");
        expect(row.agents.headingLevel).toBeGreaterThan(0);
      } else {
        expect(row.agents.dir).not.toBe("");
        expect(row.agents.extension.startsWith(".")).toBe(true);
      }
    }
  });

  it("keeps every surface's skills path a <name>/SKILL.md shape", () => {
    for (const row of SURFACES) expect(row.skillsPath.endsWith("<name>/SKILL.md")).toBe(true);
  });
});

describe("the two rows this release ships", () => {
  const row = (name: string): SurfaceRow => {
    const found = findSurface(name);
    if (found === undefined) throw new Error(`no row for ${name}`);
    return found;
  };

  it("keeps only name and description for the surface that documents only those two", () => {
    expect(row("codex").skillKeys).toEqual(["name", "description"]);
    expect(row("codex").skillRequired).toEqual(["name", "description"]);
  });

  it("keeps the whole documented key table for the surface that documents seven", () => {
    const cursor = row("cursor");
    expect(cursor.skillKeys).toContain("disable-model-invocation");
    expect(cursor.skillKeys).toContain("metadata");
    // The legacy alias is carried alongside the current spelling; dropping it
    // would silently unscope a skill written the older way.
    expect(cursor.skillKeys).toContain("paths");
    expect(cursor.skillKeys).toContain("globs");
  });

  it("spells the two documented invocations", () => {
    expect(invocationFor(row("cursor"), "alpha")).toBe("/alpha");
    expect(invocationFor(row("codex"), "alpha")).toBe("$alpha");
  });

  it("gives one surface per-persona files and the other one prose document", () => {
    expect(row("cursor").agents.kind).toBe("files");
    expect(row("codex").agents.kind).toBe("appendix");
  });

  it("returns null for a surface that documents no invocation spelling", () => {
    // No shipped row is in this state, and the field exists so that the first
    // one that is does not need a branch in ./mirror.ts.
    const silent: SurfaceRow = { ...row("codex"), invocation: null };
    expect(invocationFor(silent, "alpha")).toBeNull();
  });

  it("does not resolve a surface it has no row for", () => {
    expect(findSurface("nothing-like-this")).toBeUndefined();
  });
});
