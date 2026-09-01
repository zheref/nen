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
