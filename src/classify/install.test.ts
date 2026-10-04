import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createArgv, editArgv } from "../labels/sync.js";
import type { Target } from "../github/target.js";
import { compareDeclaration } from "./install.js";
import { loadClassifyTaxonomy } from "./taxonomy.js";
import { loadLabelTaxonomy } from "../schema/labels.js";
import {
  capture,
  copyPartialRepo,
  EXPECTED_AFTER_WRITE,
  gh,
  landedRepo,
  MINI,
  MINI_LABELS,
  PARTIAL_REPO,
  readJson,
  SLUG,
  tmpRepo,
} from "./fixtures/harness.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: SLUG };
const install = (repo: string, ...rest: string[]): string[] => ["classify", "install", "--taxonomy", MINI, "--repo", repo, ...rest];

describe("compareDeclaration -- present, drift, absent, foreign", () => {
  it("classifies each taxonomy label and lists foreign keys, never judging unrelated labels", () => {
    const report = compareDeclaration(loadClassifyTaxonomy("/", MINI), loadLabelTaxonomy(PARTIAL_REPO));
    expect(report.entries).toEqual([
      { name: "lang/alpha", status: "present" },
      { name: "lang/beta", status: "absent" },
      { name: "job/build", status: "drift" },
      { name: "job/test", status: "absent" },
    ]);
    expect(report.foreign).toEqual(["lang/zeta"]);
  });

  it("reads a colour case-insensitively, and a description exactly", () => {
    const repo = tmpRepo({
      labels: [
        { name: "lang/alpha", color: "1D76DB", description: "Needs alpha" },
        { name: "lang/beta", color: "1d76db", description: "needs beta" },
      ],
    });
    const report = compareDeclaration(loadClassifyTaxonomy("/", MINI), loadLabelTaxonomy(repo));
    expect(report.entries.slice(0, 2)).toEqual([
      { name: "lang/alpha", status: "present" },
      { name: "lang/beta", status: "drift" },
    ]);
  });
});

describe("nen classify install -- report", () => {
  it("exits 1 naming every absent and drifted label, and changes nothing", async () => {
    const repo = copyPartialRepo();
    const before = readFileSync(join(repo, "nen", "labels.json"), "utf8");
    const result = await capture(install(repo));
    expect(result.code).toBe(1);
    expect(result.out).toEqual([
      "present  lang/alpha",
      "absent   lang/beta",
      "drift    job/build  (colour #ffffff -> #5319e7)",
      "absent   job/test",
      "foreign  lang/zeta  (declared, not in the taxonomy; left alone)",
    ]);
    expect(result.err.join("\n")).toMatch(/3 of 4 label\(s\) not installed \(2 absent, 1 drift\)/);
    expect(readFileSync(join(repo, "nen", "labels.json"), "utf8")).toBe(before);
    expect(result.seams.calls).toEqual([]);
  });

  it("exits 0 once every label is present", async () => {
    const result = await capture(install(landedRepo()));
    expect(result.code).toBe(0);
    expect(result.out.at(-1)).toMatch(/installed: all 4 label\(s\)/);
  });

  it("--dry-run alone is the same report", async () => {
    expect((await capture(install(copyPartialRepo(), "--dry-run"))).code).toBe(1);
  });

  it("--json: contract, mode, entries, foreign, nothing written, nothing synced", async () => {
    const result = await capture(install(copyPartialRepo(), "--json"));
    expect(result.code).toBe(1);
    const json = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(json["contract"]).toBe("nen.classify.install/v0.1");
    expect(json["mode"]).toBe("report");
    expect(json["labelsFile"]).toMatch(/nen[\\/]labels\.json$/);
    expect(json["entries"]).toEqual([
      { name: "lang/alpha", status: "present" },
      { name: "lang/beta", status: "absent" },
      { name: "job/build", status: "drift" },
      { name: "job/test", status: "absent" },
    ]);
    expect(json["foreign"]).toEqual(["lang/zeta"]);
    expect(json["written"]).toBeNull();
    expect(json["sync"]).toBeNull();
  });

  it("requires --repo and --taxonomy at exit 2", async () => {
    expect((await capture(["classify", "install", "--taxonomy", MINI])).code).toBe(2);
    expect((await capture(["classify", "install", "--repo", "."])).code).toBe(2);
  });

  it("exits 1 when the consumer has no nen/labels.json", async () => {
    const result = await capture(install("/tmp"));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/no such file/);
  });
});

describe("nen classify install --write", () => {
  it("rewrites nen/labels.json byte for byte as the fixture says: appended in taxonomy order, drift in place, $comment kept", async () => {
    const repo = copyPartialRepo();
    const result = await capture(install(repo, "--write"));
    expect(result.code).toBe(0);
    expect(readFileSync(join(repo, "nen", "labels.json"), "utf8")).toBe(readFileSync(EXPECTED_AFTER_WRITE, "utf8"));
    expect(result.out).toEqual([
      "add  lang/beta",
      "update  job/build",
      "add  job/test",
      "foreign  lang/zeta  (declared, not in the taxonomy; left alone)",
      "written: 2 added, 1 updated",
    ]);
  });

  it("leaves a landed declaration untouched -- not even re-serialised -- and a second run is a no-op", async () => {
    const odd = '{"labels":[{"name":"lang/alpha","color":"1d76db","description":"Needs alpha"},{"name":"lang/beta","color":"1d76db","description":"Needs beta"},{"name":"job/build","color":"5319e7","description":"Building the thing"},{"name":"job/test","color":"5319e7","description":"Testing the thing"}]}';
    const repo = tmpRepo(odd);
    const result = await capture(install(repo, "--write"));
    expect(result.code).toBe(0);
    expect(result.out.at(-1)).toBe("written: 0 added, 0 updated");
    expect(readFileSync(join(repo, "nen", "labels.json"), "utf8")).toBe(odd);

    const partial = copyPartialRepo();
    await capture(install(partial, "--write"));
    const once = readFileSync(join(partial, "nen", "labels.json"), "utf8");
    const again = await capture(install(partial, "--write"));
    expect(again.out.at(-1)).toBe("written: 0 added, 0 updated");
    expect(readFileSync(join(partial, "nen", "labels.json"), "utf8")).toBe(once);
  });

  it("keeps unknown top-level keys and entry fields, and the entry key order, for appended labels", async () => {
    const repo = tmpRepo({
      $comment: "keep me",
      version: 3,
      labels: [
        { description: "d", name: "bug", color: "d73a4a" },
        { description: "e", name: "other", color: "ffffff", url: "https://example.test" },
      ],
    });
    await capture(install(repo, "--write"));
    const written = readJson(join(repo, "nen", "labels.json"));
    expect(Object.keys(written)).toEqual(["$comment", "version", "labels"]);
    expect(written["labels"][1]).toEqual({ description: "e", name: "other", color: "ffffff", url: "https://example.test" });
    expect(Object.keys(written["labels"][2])).toEqual(["description", "name", "color"]);
    expect(written["labels"]).toHaveLength(6);
    expect(readFileSync(join(repo, "nen", "labels.json"), "utf8").endsWith("}\n")).toBe(true);
  });

  it("re-validates through the loader: the written file reports installed", async () => {
    const repo = copyPartialRepo();
    await capture(install(repo, "--write"));
    expect((await capture(install(repo))).code).toBe(0);
  });

  it("--write --dry-run prints what would change and writes nothing", async () => {
    const repo = copyPartialRepo();
    const before = readFileSync(join(repo, "nen", "labels.json"), "utf8");
    const result = await capture(install(repo, "--write", "--dry-run"));
    expect(result.code).toBe(0);
    expect(result.out).toContain("would add  lang/beta");
    expect(result.out).toContain("would update  job/build");
    expect(result.out.at(-1)).toBe("would write: 2 added, 1 updated (nothing was written)");
    expect(readFileSync(join(repo, "nen", "labels.json"), "utf8")).toBe(before);
  });

  it("--json reports the counts and the pre-write entries", async () => {
    const result = await capture(install(copyPartialRepo(), "--write", "--json"));
    expect(result.code).toBe(0);
    const json = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(json["mode"]).toBe("write");
    expect(json["written"]).toEqual({ added: 2, updated: 1 });
    expect(json["dryRun"]).toBe(false);
    expect((json["entries"] as { status: string }[]).map((entry): string => entry.status)).toEqual(["present", "absent", "drift", "absent"]);
  });
});

describe("nen classify install --sync", () => {
  it("refuses at exit 1 while the declaration lacks a label, calling gh not at all", async () => {
    const result = await capture(install(copyPartialRepo(), "--sync", "--target", SLUG));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain(
      "the declaration is not landed: run `nen classify install --write`, land it through its PR, then sync",
    );
    expect(result.err.join("\n")).toMatch(/lang\/beta, job\/build, job\/test/);
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses on a drifted declaration alone", async () => {
    const repo = tmpRepo({ labels: [...MINI_LABELS.slice(0, 3), { name: "job/test", color: "000000", description: "Testing the thing" }] });
    const result = await capture(install(repo, "--sync", "--target", SLUG));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/not landed/);
  });

  it("--json on a refusal still prints the document, with sync null", async () => {
    const result = await capture(install(copyPartialRepo(), "--sync", "--target", SLUG, "--json"));
    expect(result.code).toBe(1);
    const json = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(json["mode"]).toBe("sync");
    expect(json["sync"]).toBeNull();
  });

  it("syncs ONLY the taxonomy's labels -- never the rest of the declaration, foreign included", async () => {
    const repo = landedRepo([
      { name: "bug", color: "d73a4a", description: "Something isn't working" },
      { name: "lang/zeta", color: "1d76db", description: "retired" },
    ]);
    const script = MINI_LABELS.map((label) => ({
      match: gh(...createArgv(TARGET, label)),
      result: {},
    }));
    const result = await capture(install(repo, "--sync", "--target", SLUG), script);
    expect(result.code).toBe(0);
    expect(result.seams.calls.map((call): string => call.args[2] ?? "")).toEqual(["lang/alpha", "lang/beta", "job/build", "job/test"]);
    expect(result.out).toEqual(["created: lang/alpha", "created: lang/beta", "created: job/build", "created: job/test"]);
  });

  it("falls back to update when create fails, and names a failing label at exit 1", async () => {
    const repo = landedRepo();
    const [alpha, beta, build, test] = MINI_LABELS;
    const script = [
      { match: gh(...createArgv(TARGET, alpha!)), result: { code: 1, stderr: "already exists" } },
      { match: gh(...editArgv(TARGET, alpha!)), result: {} },
      { match: gh(...createArgv(TARGET, beta!)), result: {} },
      { match: gh(...createArgv(TARGET, build!)), result: { code: 1, stderr: "bad" } },
      { match: gh(...editArgv(TARGET, build!)), result: { code: 1, stderr: "still bad" } },
      { match: gh(...createArgv(TARGET, test!)), result: {} },
    ];
    const result = await capture(install(repo, "--sync", "--target", SLUG, "--json"), script);
    expect(result.code).toBe(1);
    const json = JSON.parse(result.out.join("\n")) as { sync: { entries: { status: string }[]; failed: string[] } };
    expect(json.sync.entries.map((entry): string => entry.status)).toEqual(["updated", "created", "failed", "created"]);
    expect(json.sync.failed).toEqual(["job/build"]);

    const human = await capture(install(repo, "--sync", "--target", SLUG), script);
    expect(human.code).toBe(1);
    expect(human.err.join("\n")).toMatch(/1 label\(s\) failed to sync: job\/build/);
  });

  it("--dry-run reports would-sync and never calls gh", async () => {
    const result = await capture(install(landedRepo(), "--sync", "--target", SLUG, "--dry-run"));
    expect(result.code).toBe(0);
    expect(result.out).toHaveLength(4);
    expect(result.out[0]).toBe("would sync: lang/alpha (#1d76db) -- Needs alpha");
    expect(result.seams.calls).toEqual([]);
  });

  it("requires --target (exit 2), and rejects a malformed one (exit 2)", async () => {
    const missing = await capture(install(landedRepo(), "--sync"));
    expect(missing.code).toBe(2);
    expect(missing.err.join("\n")).toMatch(/--target owner\/name is required/);
    expect((await capture(install(landedRepo(), "--sync", "--target", "not-a-slug"))).code).toBe(2);
  });
});

describe("nen classify install -- flag combinations", () => {
  it("--write together with --sync is a usage error, exit 2, and nothing is touched", async () => {
    const repo = copyPartialRepo();
    const before = readFileSync(join(repo, "nen", "labels.json"), "utf8");
    const result = await capture(install(repo, "--write", "--sync", "--target", SLUG));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/two landings/);
    expect(readFileSync(join(repo, "nen", "labels.json"), "utf8")).toBe(before);
    expect(result.seams.calls).toEqual([]);
  });

  it("--target without --sync is a usage error rather than a silently ignored flag", async () => {
    const result = await capture(install(landedRepo(), "--target", SLUG));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--target only applies with --sync/);
  });
});
