import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALT_REPO, BANKAI_REPO } from "./fixtures/paths.js";
import { loadRepoRegistry, parseRepoRegistry } from "./repos.js";
import { checkTaxonomy, type SchemaCheck } from "./taxonomy.js";

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

  // zheref/nen#17: the bankai fixture's product_codes nests a `$comment` INSIDE
  // the object this loader walks key-by-key -- the same shape the live
  // bankai-core nen/repos.json carries. A loader that iterated every key
  // as a code would manufacture a bogus product code named '$comment' whose
  // "repository" is the comment's own prose.
  it("skips a $-prefixed key nested inside product_codes, rather than treating it as a code (zheref/nen#17)", () => {
    const bankai = loadRepoRegistry(BANKAI_REPO);
    expect(bankai.productCodes["$comment"]).toBeUndefined();
    expect(Object.keys(bankai.productCodes)).not.toContain("$comment");
    // The real codes are unaffected -- the skip removes exactly the metadata
    // key and nothing else.
    expect(Object.keys(bankai.productCodes).sort()).toEqual(["BC", "BS", "KC", "KN", "KP", "KW"]);
    expect(bankai.byCode("$comment")).toBeUndefined();
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

  it("reads the maintained_tools/pending_onboarding slugs, and tolerates their absence (zheref/nen#27)", () => {
    // The bankai fixture carries both sections (the live registry does); the
    // alt fixture carries neither. Absence is an empty list, never an error --
    // both sections are newer than many registries.
    const bankai = loadRepoRegistry(BANKAI_REPO);
    expect(bankai.maintainedTools).toEqual(["zheref/bankai-scaffold"]);
    expect(bankai.pendingOnboarding).toEqual(["zheref/KroCloud"]);
    const alt = loadRepoRegistry(ALT_REPO);
    expect(alt.maintainedTools).toEqual([]);
    expect(alt.pendingOnboarding).toEqual([]);
  });
});

describe("parseRepoRegistry -- validation", () => {
  const at = "/fake/nen/repos.json";

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

  // zheref/nen#17: a `$`-prefixed key inside `product_codes` is metadata, not
  // a code -- the same convention every `$comment` elsewhere in this schema
  // family already gets, just never applied to a key `product_codes` walks
  // one-by-one. The skip is by PREFIX, not a `$comment` special case: any
  // `$`-prefixed key nested here is metadata.
  it("skips every $-prefixed key inside product_codes, keeping only the real codes", () => {
    const registry = parseRepoRegistry(at, {
      consumers: [],
      product_codes: { $comment: "not a code", $schema: "also not a code", XX: "owner/repo" },
    });
    expect(registry.productCodes).toEqual({ XX: "owner/repo" });
  });

  // zheref/nen#17 (review minor): the caller-pin walk applies the SAME
  // `$`-prefix-is-metadata convention product_codes now gets -- a consumer
  // carrying `"$comment_pinned": "..."` would otherwise pass the
  // `_pinned`-suffix check and become a phantom per-caller pin, which
  // `nen warmup` would then report as a stale pin for a caller that does not
  // exist.
  it("skips a $-prefixed key inside a consumer even when it also ends in _pinned", () => {
    const registry = parseRepoRegistry(at, {
      consumers: [
        {
          repo: "a/b",
          consumes: [],
          pinned: "v1.0.0",
          $comment_pinned: "v0.1.0",
          db_migrate_pinned: "v0.9.0",
        },
      ],
    });
    expect(registry.byRepo("a/b")?.callerPins).toEqual({ db_migrate_pinned: "v0.9.0" });
    expect(Object.keys(registry.byRepo("a/b")?.callerPins ?? {})).not.toContain("$comment_pinned");
  });

  it("requires a maintained_tools/pending_onboarding entry to name an owner/name repo", () => {
    // These lists exist to record exactly the owner a bare product_codes value
    // omits, so an entry without one records nothing a resolution can use.
    expect(() =>
      parseRepoRegistry(at, { consumers: [], pending_onboarding: [{ repo: "bare" }] }),
    ).toThrow(/pending_onboarding\[0\]\.repo/);
    expect(() =>
      parseRepoRegistry(at, { consumers: [], maintained_tools: [{ role: "tool" }] }),
    ).toThrow(/maintained_tools\[0\]\.repo/);
  });
});

// zheref/nen#219: a registry's own tool repositories consume nothing, so a
// `scenario` that only a consumers[] entry could carry was one they could
// never have. Both non-consumer sections now carry it, validated as a
// consumer's is.
describe("parseRepoRegistry -- a scenario on maintained_tools[]/pending_onboarding[] rows (zheref/nen#219)", () => {
  const at = "/fake/nen/repos.json";

  it("reads the scenario each listed row states, keeping the slug lists exactly as they were", () => {
    const registry = parseRepoRegistry(at, {
      consumers: [],
      maintained_tools: [
        { repo: "zheref/hatsu", role: "Hatsu workflow and skill prose", scenario: "hatsu-plugin" },
        { repo: "zheref/nen", role: "Shared deterministic machinery" },
      ],
      pending_onboarding: [{ repo: "zheref/KroCloud", status: "not-a-consumer", scenario: null }],
    });
    expect(registry.listed).toEqual([
      { repo: "zheref/hatsu", section: "maintained_tools", index: 0, scenario: "hatsu-plugin" },
      { repo: "zheref/nen", section: "maintained_tools", index: 1, scenario: null },
      { repo: "zheref/KroCloud", section: "pending_onboarding", index: 0, scenario: null },
    ]);
    // Every reader that wants only the slugs gets precisely what it got before.
    expect(registry.maintainedTools).toEqual(["zheref/hatsu", "zheref/nen"]);
    expect(registry.pendingOnboarding).toEqual(["zheref/KroCloud"]);
  });

  it("sets `listed` on every registry the loader returns -- empty when neither section is present", () => {
    expect(parseRepoRegistry(at, { consumers: [] }).listed).toEqual([]);
    expect(loadRepoRegistry(BANKAI_REPO).listed).toEqual([
      { repo: "zheref/bankai-scaffold", section: "maintained_tools", index: 0, scenario: null },
      { repo: "zheref/KroCloud", section: "pending_onboarding", index: 0, scenario: null },
    ]);
  });

  // Validated EXACTLY as a consumer's scenario is: optional, a string when
  // present. The same refusal text, at the listed row's own pointer.
  it("refuses a non-string scenario on a listed row, by pointer, in the words a consumer's gets", () => {
    expect(() =>
      parseRepoRegistry(at, { consumers: [{ repo: "a/b", consumes: [], scenario: 7 }] }),
    ).toThrow(/at consumers\[0\]\.scenario, expected a string or nothing, got number \(7\)/);
    expect(() =>
      parseRepoRegistry(at, { consumers: [], maintained_tools: [{ repo: "a/b", scenario: 7 }] }),
    ).toThrow(/at maintained_tools\[0\]\.scenario, expected a string or nothing, got number \(7\)/);
    expect(() =>
      parseRepoRegistry(at, { consumers: [], pending_onboarding: [{ repo: "a/b", scenario: ["x"] }] }),
    ).toThrow(/at pending_onboarding\[0\]\.scenario, expected a string or nothing, got/);
  });
});

// A checkout carrying exactly `registry` as its nen/repos.json, and nothing
// else under nen/ -- the repos row is the only one this suite reads.
function checkoutWith(registry: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "nen-schema-repos-"));
  mkdirSync(join(root, "nen"), { recursive: true });
  writeFileSync(join(root, "nen", "repos.json"), JSON.stringify(registry));
  return root;
}

function reposRow(root: string): SchemaCheck | undefined {
  return checkTaxonomy({ repoFlag: root }).checks.find(
    (check): boolean => check.file === "nen/repos.json",
  );
}

// zheref/nen#219 criterion 4, through `nen schema check`'s own report.
describe("checkTaxonomy -- the nen/repos.json row with listed scenarios (zheref/nen#219)", () => {
  it("accepts maintained_tools[] rows that carry a scenario, and still reports the row", () => {
    const row = reposRow(
      checkoutWith({
        consumers: [],
        maintained_tools: [
          { repo: "zheref/hatsu", role: "Hatsu workflow and skill prose", scenario: "hatsu-plugin" },
          { repo: "zheref/nen", role: "Shared deterministic machinery", scenario: "bun-cli" },
        ],
        pending_onboarding: [{ repo: "zheref/KroCloud", scenario: "cloud-functions" }],
        product_codes: { HA: "zheref/hatsu", NN: "zheref/nen" },
      }),
    );
    expect(row?.ok).toBe(true);
    expect(row?.required).toBe(true);
    expect(row?.detail).toBe("0 consumers, 2 product codes, latest (unrecorded)");
  });

  it("fails the repos row on a malformed listed scenario, naming its pointer", () => {
    const row = reposRow(checkoutWith({ consumers: [], maintained_tools: [{ repo: "zheref/nen", scenario: 1 }] }));
    expect(row?.ok).toBe(false);
    expect(row?.detail).toMatch(/at maintained_tools\[0\]\.scenario, expected a string or nothing/);
  });
});

describe("toolPins -- the canon pin is data on the maintained_tools entry (CON-13)", () => {
  const at = "nen/repos.json";

  it("reads a maintained tool's pinned tag, keyed by its slug, and leaves unpinned tools out", () => {
    const registry = parseRepoRegistry(at, {
      consumers: [],
      maintained_tools: [
        { repo: "owner/handbooks", role: "canonical handbooks", pinned: "v0.6.0" },
        { repo: "owner/tool", role: "a tool" },
      ],
    });
    expect(registry.toolPins).toEqual({ "owner/handbooks": "v0.6.0" });
    // The slug list is unchanged by the pin: both tools are still recorded.
    expect(registry.maintainedTools).toEqual(["owner/handbooks", "owner/tool"]);
  });

  it("is empty when no maintained tool is pinned, or the list is absent", () => {
    expect(parseRepoRegistry(at, { consumers: [], maintained_tools: [{ repo: "owner/tool" }] }).toolPins).toEqual({});
    expect(parseRepoRegistry(at, { consumers: [] }).toolPins).toEqual({});
    expect(loadRepoRegistry(BANKAI_REPO).toolPins).toEqual({});
  });

  it("refuses a pinned that is not a string, by pointer", () => {
    expect(() =>
      parseRepoRegistry(at, { consumers: [], maintained_tools: [{ repo: "owner/handbooks", pinned: 6 }] }),
    ).toThrow(/maintained_tools\[0\]\.pinned/);
  });
});

describe("toolCheckouts -- where a maintained tool's checkout is found is declared, never a literal in nen (zheref/nen#294)", () => {
  const at = "nen/repos.json";

  it("reads checkout_env and checkout off a maintained_tools entry, with its index, and leaves undeclared tools out", () => {
    const registry = parseRepoRegistry(at, {
      consumers: [],
      maintained_tools: [
        { repo: "owner/tool", role: "a tool" },
        { repo: "owner/handbooks", pinned: "v0.6.0", checkout_env: "MY_CANON", checkout: "${HOME}/c" },
        { repo: "owner/env-only", checkout_env: "ONLY_ENV" },
      ],
    });
    expect(registry.toolCheckouts).toEqual({
      "owner/handbooks": { index: 1, checkoutEnv: "MY_CANON", checkout: "${HOME}/c" },
      "owner/env-only": { index: 2, checkoutEnv: "ONLY_ENV", checkout: null },
    });
    expect(parseRepoRegistry(at, { consumers: [] }).toolCheckouts).toEqual({});
  });

  it("refuses, by pointer, a checkout_env that is not a variable name and an empty checkout -- never read as undeclared", () => {
    expect(() => parseRepoRegistry(at, { consumers: [], maintained_tools: [{ repo: "o/h", checkout_env: "/abs/path" }] })).toThrow(
      /maintained_tools\[0\]\.checkout_env.*environment variable NAME/,
    );
    expect(() => parseRepoRegistry(at, { consumers: [], maintained_tools: [{ repo: "o/h", checkout_env: 3 }] })).toThrow(/maintained_tools\[0\]\.checkout_env/);
    expect(() => parseRepoRegistry(at, { consumers: [], maintained_tools: [{ repo: "o/h", checkout: "  " }] })).toThrow(/maintained_tools\[0\]\.checkout.*empty string/);
  });
});

describe("toolPins + toolCheckouts -- one row answers for a tool (Nobunaga N8)", () => {
  it("takes the pin and the checkout from the LAST row; a last row with no checkout means none, whatever an earlier row said", () => {
    const registry = parseRepoRegistry("nen/repos.json", {
      consumers: [],
      maintained_tools: [
        { repo: "owner/handbooks", pinned: "v0.5.0", checkout_env: "OLD_CANON", checkout: "/old" },
        { repo: "owner/handbooks", pinned: "v0.6.0" },
        { repo: "owner/other", pinned: "v1.0.0", checkout: "/first" },
        { repo: "owner/other", pinned: "v2.0.0", checkout: "/second" },
      ],
    });
    expect(registry.toolPins).toEqual({ "owner/handbooks": "v0.6.0", "owner/other": "v2.0.0" });
    expect(registry.toolCheckouts).toEqual({ "owner/other": { index: 3, checkoutEnv: null, checkout: "/second" } });
  });
});

describe("toolPins -- a later row erases an earlier pin (Nobunaga R4)", () => {
  it("records no pin when the last row naming the tool is unpinned, though an earlier row pinned it", () => {
    const registry = parseRepoRegistry("nen/repos.json", {
      consumers: [],
      maintained_tools: [
        { repo: "owner/handbooks", pinned: "v0.6.0", checkout: "/c" },
        { repo: "owner/handbooks", role: "re-listed, unpinned" },
      ],
    });
    expect(registry.toolPins).toEqual({});
    expect(registry.toolCheckouts).toEqual({});
  });
});
