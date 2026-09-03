import { describe, expect, it } from "vitest";
import { allRepos, ownerNameFromRemote, RepoResolutionError, resolve, resolveToken } from "./resolve.js";
import type { RepoRegistry } from "../schema/repos.js";

function registry(overrides: Partial<RepoRegistry> = {}): RepoRegistry {
  const consumers = overrides.consumers ?? [
    { repo: "zheref/KroApple", pinned: "v1", consumes: [], scenario: null, phases: [], auth: null, notes: null, code: "KP", callerPins: {} },
    { repo: "zheref/KroAndroid", pinned: "v1", consumes: [], scenario: null, phases: [], auth: null, notes: null, code: "KN", callerPins: {} },
  ];
  const productCodes = overrides.productCodes ?? { KP: "zheref/KroApple", KN: "zheref/KroAndroid", BC: "zheref/bankai-core" };
  return {
    path: "schemas/repos.json",
    latest: null,
    consumers,
    productCodes,
    maintainedTools: [],
    pendingOnboarding: [],
    byRepo: (repo): (typeof consumers)[number] | undefined => consumers.find((c): boolean => c.repo === repo),
    byCode: (code): (typeof consumers)[number] | undefined => consumers.find((c): boolean => c.code === code),
    affectedBy: (): readonly [] => [],
    ...overrides,
  };
}

describe("resolveToken", () => {
  it("resolves a product code case-insensitively", () => {
    const result = resolveToken(registry(), "kp");
    expect(result[0]).toMatchObject({ repo: "zheref/KroApple", kind: "code" });
  });

  it("resolves an owner/name slug exactly", () => {
    const result = resolveToken(registry(), "zheref/KroApple");
    expect(result[0]?.kind).toBe("slug");
  });

  it("resolves a repository's short name, but NEVER as a prefix", () => {
    expect(resolveToken(registry(), "KroApple")[0]?.kind).toBe("name");
    expect(() => resolveToken(registry(), "Kro")).toThrow(RepoResolutionError);
  });

  it("refuses an unknown token, listing the registry's codes", () => {
    expect(() => resolveToken(registry(), "nope")).toThrow(/Codes: KP/);
  });

  it("resolves 'all' only after every registry lookup has failed", () => {
    const result = resolveToken(registry(), "all");
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((item): boolean => item.kind === "all")).toBe(true);
  });

  it("lets a registry that names a repository 'all' keep it -- keyword loses to the registry", () => {
    const reg = registry({
      consumers: [{ repo: "zheref/all", pinned: null, consumes: [], scenario: null, phases: [], auth: null, notes: null, code: null, callerPins: {} }],
    });
    const result = resolveToken(reg, "all");
    // Matched by rule 3 (the short name) before rule 4 (the 'all' keyword) is
    // even reached -- the registry's own repository named 'all' wins without
    // the keyword branch ever firing.
    expect(result).toEqual([{ repo: "zheref/all", code: null, kind: "name", entry: reg.consumers[0] }]);
  });
});

// zheref/nen#27, rule 5: a token resolves from EVERYTHING the file records --
// product_codes values (slug or bare) and the maintained_tools/
// pending_onboarding lists -- not just consumers[]. Every match below is still
// exact; the last case pins that a genuine miss stays an error.
describe("resolveToken -- rule 5: everything the file records (zheref/nen#27)", () => {
  it("resolves a full slug recorded only as a product_codes VALUE -- the registry's own repo", () => {
    const result = resolveToken(registry(), "zheref/bankai-core");
    expect(result).toEqual([{ repo: "zheref/bankai-core", code: "BC", kind: "slug", entry: null }]);
  });

  it("resolves a full slug against a BARE product_codes value by name half, keeping the token's owner", () => {
    // The registry records no owner for 'bankai-core', so the token's own
    // owner is the only one on offer -- carrying it through is not a guess.
    const reg = registry({ productCodes: { BC: "bankai-core" } });
    const result = resolveToken(reg, "zheref/bankai-core");
    expect(result).toEqual([{ repo: "zheref/bankai-core", code: "BC", kind: "name", entry: null }]);
  });

  it("still refuses a slug whose name the file claims under a DIFFERENT owner", () => {
    // 'KroApple' has a recorded owner (the zheref/KroApple consumer), so a
    // token naming another owner contradicts the file rather than matching it.
    const reg = registry({ productCodes: { KP: "KroApple" } });
    expect(() => resolveToken(reg, "someone-else/KroApple")).toThrow(RepoResolutionError);
  });

  it("resolves a pending_onboarding repo by slug, short name, and its code's bare value", () => {
    const reg = registry({
      productCodes: { KC: "KroCloud" },
      pendingOnboarding: ["zheref/KroCloud"],
    });
    expect(resolveToken(reg, "zheref/KroCloud")).toEqual([
      { repo: "zheref/KroCloud", code: "KC", kind: "slug", entry: null },
    ]);
    expect(resolveToken(reg, "krocloud")).toEqual([
      { repo: "zheref/KroCloud", code: "KC", kind: "name", entry: null },
    ]);
    // The code path reports the owner the file records instead of the bare half.
    expect(resolveToken(reg, "kc")).toEqual([
      { repo: "zheref/KroCloud", code: "KC", kind: "code", entry: null },
    ]);
  });

  it("resolves a maintained_tools repo that is not a consumer, with no code when none names it", () => {
    const reg = registry({ maintainedTools: ["zheref/some-tool"] });
    expect(resolveToken(reg, "zheref/some-tool")).toEqual([
      { repo: "zheref/some-tool", code: null, kind: "slug", entry: null },
    ]);
    expect(resolveToken(reg, "some-tool")[0]?.kind).toBe("name");
  });

  it("an unknown token is STILL an error that now also lists the listed repos", () => {
    const reg = registry({ pendingOnboarding: ["zheref/KroCloud"] });
    expect(() => resolveToken(reg, "KroClo")).toThrow(RepoResolutionError);
    expect(() => resolveToken(reg, "nope")).toThrow(/zheref\/KroCloud/);
  });
});

describe("allRepos", () => {
  it("includes a product code whose repo is not itself a listed consumer", () => {
    const repos = allRepos(registry());
    expect(repos.some((item): boolean => item.repo === "zheref/bankai-core")).toBe(true);
  });
});

describe("ownerNameFromRemote", () => {
  it("parses both an https and an ssh remote", () => {
    expect(ownerNameFromRemote("https://github.com/zheref/nen.git")).toBe("zheref/nen");
    expect(ownerNameFromRemote("git@github.com:zheref/nen.git")).toBe("zheref/nen");
  });

  it("returns null for something that is not owner/name", () => {
    expect(ownerNameFromRemote("not-a-url")).toBeNull();
    expect(ownerNameFromRemote("")).toBeNull();
  });
});

describe("resolve", () => {
  it("resolves the token when one is given, without touching git", () => {
    const result = resolve({
      registry: registry(),
      seams: { run: (): never => { throw new Error("must not be called"); }, now: (): Date => new Date(), env: {} },
      token: "KP",
      cwd: "/anywhere",
    });
    expect(result.token).toBe("KP");
    expect(result.origin).toBeNull();
  });

  it("falls back to the cwd's origin remote when no token is given, never widening to 'all'", () => {
    const result = resolve({
      registry: registry(),
      seams: {
        run: (): { code: number; stdout: string; stderr: string; spawnFailed: boolean } => ({
          code: 0,
          stdout: "https://github.com/zheref/KroApple.git\n",
          stderr: "",
          spawnFailed: false,
        }),
        now: (): Date => new Date(),
        env: {},
      },
      token: null,
      cwd: "/somewhere",
    });
    expect(result.origin).toContain("KroApple");
    expect(result.repos[0]?.kind).toBe("origin");
  });

  it("resolves the registry's OWN origin via product_codes -- zheref/nen#27's headline case", () => {
    // The registry's own source repo is recorded ONLY as a product_codes
    // value, so the no-token form run from its own checkout used to refuse it.
    const result = resolve({
      registry: registry(),
      seams: {
        run: (): { code: number; stdout: string; stderr: string; spawnFailed: boolean } => ({
          code: 0,
          stdout: "https://github.com/zheref/bankai-core.git\n",
          stderr: "",
          spawnFailed: false,
        }),
        now: (): Date => new Date(),
        env: {},
      },
      token: null,
      cwd: "/the-registrys-own-checkout",
    });
    expect(result.repos).toEqual([
      { repo: "zheref/bankai-core", code: "BC", kind: "origin", entry: null },
    ]);
  });

  it("resolves a pending_onboarding repo's origin the same way", () => {
    const result = resolve({
      registry: registry({ pendingOnboarding: ["zheref/KroCloud"] }),
      seams: {
        run: (): { code: number; stdout: string; stderr: string; spawnFailed: boolean } => ({
          code: 0,
          stdout: "git@github.com:zheref/KroCloud.git\n",
          stderr: "",
          spawnFailed: false,
        }),
        now: (): Date => new Date(),
        env: {},
      },
      token: null,
      cwd: "/a-pending-consumers-checkout",
    });
    expect(result.repos).toEqual([{ repo: "zheref/KroCloud", code: null, kind: "origin", entry: null }]);
  });

  it("refuses -- rather than widening to 'all' -- when the origin resolves to nothing in the registry", () => {
    expect(() =>
      resolve({
        registry: registry(),
        seams: {
          run: (): { code: number; stdout: string; stderr: string; spawnFailed: boolean } => ({
            code: 0,
            stdout: "https://github.com/other/thing.git\n",
            stderr: "",
            spawnFailed: false,
          }),
          now: (): Date => new Date(),
          env: {},
        },
        token: null,
        cwd: "/somewhere",
      }),
    ).toThrow(RepoResolutionError);
  });
});
