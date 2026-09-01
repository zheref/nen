import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  assertRepoRoot,
  looksLikeOwnerSlug,
  RepoRootError,
  resolveRepoRoot,
} from "./root.js";

describe("resolveRepoRoot", () => {
  it("defaults to the call site's cwd", () => {
    expect(resolveRepoRoot({ cwd: "/tmp/example" })).toBe(resolve("/tmp/example"));
  });

  it("reads process.cwd() when no cwd is supplied", () => {
    expect(resolveRepoRoot()).toBe(resolve(process.cwd()));
  });

  it("resolves a relative --repo against the call site's cwd, not the process's", () => {
    const root = resolveRepoRoot({ cwd: resolve("/tmp/a"), repoFlag: "../b" });
    expect(root).toBe(resolve("/tmp/b"));
  });

  it("honors an absolute --repo unchanged", () => {
    const absolute = resolve(tmpdir(), "some-checkout");
    expect(resolveRepoRoot({ cwd: "/elsewhere", repoFlag: absolute })).toBe(absolute);
  });

  it("always returns an absolute path", () => {
    expect(isAbsolute(resolveRepoRoot({ cwd: process.cwd(), repoFlag: "." }))).toBe(true);
  });

  it("refuses an owner/name slug and names the flag that takes one", () => {
    expect(() => resolveRepoRoot({ repoFlag: "zheref/bankai-core" })).toThrow(
      RepoRootError,
    );
    expect(() => resolveRepoRoot({ repoFlag: "zheref/bankai-core" })).toThrow(
      /--source/,
    );
  });

  it("refuses an empty --repo rather than silently meaning cwd", () => {
    expect(() => resolveRepoRoot({ repoFlag: "" })).toThrow(RepoRootError);
    expect(() => resolveRepoRoot({ repoFlag: "   " })).toThrow(RepoRootError);
  });

  it("does not treat a path with a leading ./ or an extra segment as a slug", () => {
    // The three shapes closest to the slug that must stay paths.
    for (const path of ["./zheref/nen", "a/b/c", "/zheref/nen"]) {
      expect(() => resolveRepoRoot({ cwd: resolve(sep), repoFlag: path })).not.toThrow();
    }
  });
});

describe("looksLikeOwnerSlug", () => {
  it("accepts exactly the owner/name shape", () => {
    expect(looksLikeOwnerSlug("zheref/nen")).toBe(true);
    expect(looksLikeOwnerSlug("zheref/bankai-core")).toBe(true);
    expect(looksLikeOwnerSlug("a1/b_2.c")).toBe(true);
  });

  it("rejects anything path-shaped", () => {
    for (const value of ["nen", "./nen", "../nen", "a/b/c", "/a/b", "a\\b", "/", ""]) {
      expect(looksLikeOwnerSlug(value)).toBe(false);
    }
  });
});

describe("assertRepoRoot", () => {
  it("returns the root when it is an existing directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-root-"));
    expect(assertRepoRoot({ cwd: dir })).toBe(resolve(dir));
    expect(assertRepoRoot({ cwd: tmpdir(), repoFlag: dir })).toBe(resolve(dir));
  });

  it("refuses a path that does not exist, naming the resolved path", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-root-"));
    const missing = join(dir, "nope");
    expect(() => assertRepoRoot({ cwd: dir, repoFlag: "nope" })).toThrow(
      RepoRootError,
    );
    expect(() => assertRepoRoot({ cwd: dir, repoFlag: "nope" })).toThrow(
      new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it("refuses a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-root-"));
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    expect(() => assertRepoRoot({ cwd: dir, repoFlag: "a-file" })).toThrow(
      /is a file, not a directory/,
    );
  });

  it("does not require a .git directory", () => {
    // A tarball extraction, a container mount and a test fixture are all
    // legitimate targets; the loud error a caller needs is about schemas/.
    const dir = mkdtempSync(join(tmpdir(), "nen-root-"));
    expect(() => assertRepoRoot({ cwd: dir })).not.toThrow();
  });
});
