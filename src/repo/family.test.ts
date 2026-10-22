// src/repo/family.test.ts -- the `spec` role in `nen repo classify` and
// `nen repo family <name>` (zheref/nen#453, HR-16).

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { repoCommand } from "./command.js";

function seams(origin: string): Seams {
  return {
    run: (bin, args): CommandResult => {
      if (bin === "git" && args[0] === "remote") return { code: 0, stdout: `git@github.com:${origin}.git\n`, stderr: "", spawnFailed: false };
      throw new Error(`unexpected spawn: ${bin} ${args.join(" ")}`);
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("no watched form");
    },
    platform: "linux",
  };
}

function registry(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "nen-family-"));
  mkdirSync(join(root, "nen"));
  writeFileSync(join(root, "nen", "repos.json"), JSON.stringify(value));
  return root;
}

const FAMILY_REGISTRY = {
  consumers: [
    { repo: "acme/app-android", consumes: [], code: "RB" },
    { repo: "acme/app-spec", consumes: [] },
  ],
  product_codes: { RA: "acme/app-ios", RB: "app-android", RC: "app-web" },
  families: [
    {
      name: "app",
      spec: { repo: "acme/app-spec", role: "spec", gate: "G2" },
      members: [
        { code: "RA", platform: "ios" },
        { code: "RB", platform: "android" },
        { code: "RC" },
      ],
    },
  ],
};

async function capture(argv: readonly string[], repo: string, origin = "acme/elsewhere", json = false): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l): void => void out.push(l), err: (l): void => void err.push(l) };
  const code = await runFamily(repoCommand, argv, repo, json, io, seams(origin));
  return { code, out, err };
}

describe("nen repo classify -- role spec (zheref/nen#453)", () => {
  it("a family's spec.repo reads role spec at gate G2, and names the family as its source", async () => {
    const root = registry(FAMILY_REGISTRY);
    const result = await capture(["repo", "classify", "--target", "acme/app-spec"], root, "acme/elsewhere", true);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as { role: string; defaultGate: string; sources: { role: string }; notes: string[] };
    expect(doc.role).toBe("spec");
    expect(doc.defaultGate).toBe("G2");
    expect(doc.sources.role).toMatch(/families\[0\]\.spec\.repo \(family 'app'\)/);
    // Also under consumers: said in a note, never silently dropped.
    expect(doc.notes.join("\n")).toMatch(/also listed under consumers; families\[\]\.spec decides its role/);
  });

  it("the human line reads role spec · gate G2", async () => {
    const result = await capture(["repo", "classify", "--target", "acme/app-spec"], registry(FAMILY_REGISTRY));
    expect(result.out[0]).toMatch(/^acme\/app-spec: role spec · kind unknown · stack none · gate G2$/);
  });

  it("a member stays what its own listing says -- the family does not make it a spec", async () => {
    const result = await capture(["repo", "classify", "--target", "acme/app-android"], registry(FAMILY_REGISTRY), "acme/elsewhere", true);
    expect((JSON.parse(result.out.join("\n")) as { role: string }).role).toBe("consumer");
  });
});

describe("nen repo family <name>", () => {
  it("prints the spec and each member as <code> <owner/name> <platform>, codes resolved through the registry", async () => {
    const result = await capture(["repo", "family", "app"], registry(FAMILY_REGISTRY));
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "family app: spec acme/app-spec · role spec · gate G2",
      "  RA acme/app-ios ios",
      "  RB acme/app-android android",
      "  RC acme/app-web (no platform)",
    ]);
  });

  it("--json carries the contract, spec and members", async () => {
    const result = await capture(["repo", "family", "APP"], registry(FAMILY_REGISTRY), "acme/elsewhere", true);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc).toMatchObject({
      contract: "nen.repo.family/v0.1",
      family: "app",
      spec: { repo: "acme/app-spec", role: "spec", gate: "G2" },
      members: [
        { code: "RA", repo: "acme/app-ios", platform: "ios" },
        { code: "RB", repo: "acme/app-android", platform: "android" },
        { code: "RC", repo: "acme/app-web", platform: null },
      ],
    });
    expect(doc["source"]).toMatch(/families\[0\]$/);
  });

  it("an unknown family exits 2 listing the declared ones", async () => {
    const result = await capture(["repo", "family", "nope"], registry(FAMILY_REGISTRY));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/'nope' is not a family.*Declared families: app/);
  });

  it("a registry with no families exits 2", async () => {
    const result = await capture(["repo", "family", "app"], registry({ consumers: [] }));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/declares no families\[\]/);
  });

  it("a member whose bare name has no agreed owner exits 1, naming the member -- never dropped", async () => {
    const root = registry({
      ...FAMILY_REGISTRY,
      consumers: [
        { repo: "acme/one", consumes: [] },
        { repo: "other/two", consumes: [] },
      ],
    });
    const result = await capture(["repo", "family", "app"], root);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/member 'RB' could not be resolved/);
  });

  it("a typo'd member code fails the registry load, so the verb never resolves it", async () => {
    const root = registry({ ...FAMILY_REGISTRY, families: [{ ...FAMILY_REGISTRY.families[0], members: [{ code: "RZ" }] }] });
    const result = await capture(["repo", "family", "app"], root);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/families\[0\]\.members\[0\]\.code/);
  });

  it("refuses a missing name at exit 2", async () => {
    expect((await capture(["repo", "family"], registry(FAMILY_REGISTRY))).code).toBe(2);
  });
});
