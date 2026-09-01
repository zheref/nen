import { describe, expect, it } from "vitest";
import { ALT_REPO, BANKAI_REPO } from "./fixtures/paths.js";
import { loadRepoRegistry, parseRepoRegistry } from "./repos.js";

describe("loadRepoRegistry -- reads the TARGET repository", () => {
  it("reads whichever registry the target repo carries", () => {
    const bankai = loadRepoRegistry(BANKAI_REPO);
    const alt = loadRepoRegistry(ALT_REPO);
    expect(bankai.latest).toBe("v0.11.2");
    expect(alt.latest).toBe("v2.0.0");
    expect(bankai.byRepo("zheref/KroApple")?.code).toBe("KP");
    expect(alt.byRepo("example/alpha")?.code).toBe("AL");
    expect(bankai.byRepo("example/alpha")).toBeUndefined();
  });

  it("resolves product codes from the file, including which codes exist", () => {
    const bankai = loadRepoRegistry(BANKAI_REPO);
    const alt = loadRepoRegistry(ALT_REPO);
    expect(bankai.productCodes["KP"]).toBe("KroApple");
    expect(bankai.byCode("KN")?.repo).toBe("zheref/KroAndroid");
    // The alt registry has no KP at all; nothing in the shipped tree assumes one.
    expect(alt.byCode("KP")).toBeUndefined();
    expect(alt.byCode("AL")?.repo).toBe("example/alpha");
  });

  it("computes the affected set by intersecting `consumes`", () => {
    const bankai = loadRepoRegistry(BANKAI_REPO);
    expect(bankai.affectedBy(["db-migrate.yml"]).map((c): string => c.repo)).toEqual([
      "zheref/KroApple",
    ]);
    expect(bankai.affectedBy(["sasuke-review.yml"]).map((c): string => c.repo)).toEqual([
      "zheref/KroApple",
      "zheref/KroAndroid",
      "zheref/bankai-scaffold",
    ]);
    expect(bankai.affectedBy(["nothing-consumes-this.yml"])).toEqual([]);

    const alt = loadRepoRegistry(ALT_REPO);
    expect(alt.affectedBy(["build.yml"]).map((c): string => c.repo)).toEqual([
      "example/alpha",
      "example/beta",
    ]);
  });

  it("keeps per-caller pin overrides raw, without enumerating caller names", () => {
    const scaffold = loadRepoRegistry(BANKAI_REPO).byRepo("zheref/bankai-scaffold");
    expect(scaffold?.pinned).toBe("v0.10.0");
    expect(scaffold?.callerPins).toEqual({ db_migrate_pinned: "v0.9.7" });
    // The baseline pin is NOT folded into the override map -- a caller reading
    // `callerPins` must see only divergences.
    expect(Object.keys(scaffold?.callerPins ?? {})).not.toContain("pinned");
  });

  it("treats absent optional fields as absent, not as empty strings", () => {
    const beta = loadRepoRegistry(ALT_REPO).byRepo("example/beta");
    expect(beta?.scenario).toBeNull();
    expect(beta?.auth).toBeNull();
    expect(beta?.notes).toBeNull();
    expect(beta?.phases).toEqual([]);
  });

  it("errors loudly when the file is absent", () => {
    expect(() => loadRepoRegistry("/definitely/not/a/repo")).toThrow(/no such file/);
  });
});

describe("parseRepoRegistry -- validation", () => {
  const at = "/fake/schemas/repos.json";

  it("requires `consumers` to be an array", () => {
    expect(() => parseRepoRegistry(at, { consumers: {} })).toThrow(/expected an array/);
  });

  it("requires a repo to be an owner/name slug", () => {
    expect(() => parseRepoRegistry(at, { consumers: [{ repo: "bare", consumes: [] }] })).toThrow(
      /owner\/name/,
    );
  });

  it("requires `consumes`, because an entry without it is invisible to a fan-out", () => {
    expect(() => parseRepoRegistry(at, { consumers: [{ repo: "a/b" }] })).toThrow(
      /consumers\[0\]\.consumes/,
    );
  });

  it("refuses a duplicate repo", () => {
    expect(() =>
      parseRepoRegistry(at, {
        consumers: [
          { repo: "a/b", consumes: [] },
          { repo: "a/b", consumes: [] },
        ],
      }),
    ).toThrow(/duplicates consumers\[0\]\.repo/);
  });

  it("refuses a product code claimed by two repositories", () => {
    expect(() =>
      parseRepoRegistry(at, {
        consumers: [
          { repo: "a/b", consumes: [], code: "XX" },
          { repo: "c/d", consumes: [], code: "XX" },
        ],
      }),
    ).toThrow(/claimed by both/);
  });

  it("accepts a registry with no product_codes block at all", () => {
    const registry = parseRepoRegistry(at, { consumers: [{ repo: "a/b", consumes: [] }] });
    expect(registry.productCodes).toEqual({});
    expect(registry.latest).toBeNull();
  });
});
