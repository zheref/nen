import { describe, expect, it } from "vitest";
import { compileGlob, matchesAnyGlob, matchesGlob } from "./glob.js";

describe("matchesGlob -- '*' stays inside one segment", () => {
  it("matches any run of characters, but never crosses a '/'", () => {
    expect(matchesGlob("a.png", "*.png")).toBe(true);
    expect(matchesGlob("dir/a.png", "*.png")).toBe(false);
    expect(matchesGlob("dir/a.png", "dir/*.png")).toBe(true);
    expect(matchesGlob("dir/sub/a.png", "dir/*.png")).toBe(false);
  });

  it("matches an empty run too -- '*' is zero or more", () => {
    expect(matchesGlob(".png", "*.png")).toBe(true);
  });
});

describe("matchesGlob -- '?' is exactly one character, never a '/'", () => {
  it("matches one character", () => {
    expect(matchesGlob("a.png", "?.png")).toBe(true);
    expect(matchesGlob("ab.png", "?.png")).toBe(false);
    expect(matchesGlob("a.png", "??.png")).toBe(false);
  });

  it("does not stand in for a directory separator", () => {
    expect(matchesGlob("a/b.png", "a?b.png")).toBe(false);
  });
});

describe("matchesGlob -- '**' crosses directories, including zero of them", () => {
  it("as the whole pattern, matches anything at any depth", () => {
    expect(matchesGlob("a.png", "**")).toBe(true);
    expect(matchesGlob("a/b/c.png", "**")).toBe(true);
  });

  it("leading, matches a root-level file as well as a nested one", () => {
    expect(matchesGlob("a.png", "**/*.png")).toBe(true);
    expect(matchesGlob("a/b/c.png", "**/*.png")).toBe(true);
  });

  it("in the middle, matches zero directories between as well as several", () => {
    expect(matchesGlob("a/b.png", "a/**/*.png")).toBe(true);
    expect(matchesGlob("a/x/b.png", "a/**/*.png")).toBe(true);
    expect(matchesGlob("a/x/y/b.png", "a/**/*.png")).toBe(true);
    expect(matchesGlob("z/b.png", "a/**/*.png")).toBe(false);
  });

  it("trailing, matches the directory itself as well as anything nested under it", () => {
    expect(matchesGlob("logs", "logs/**")).toBe(true);
    expect(matchesGlob("logs/a.png", "logs/**")).toBe(true);
    expect(matchesGlob("logs/a/b.png", "logs/**")).toBe(true);
    expect(matchesGlob("other/a.png", "logs/**")).toBe(false);
  });

  it("reproduces the brief's own KroApple-shaped glob end to end", () => {
    const pattern = "**/__Snapshots__/**/*.png";
    expect(
      matchesGlob(
        "Kro/Tests/DateTimeFieldSnapshotTests/__Snapshots__/DateTimeFieldSnapshotTests/test_snapshot_disabled.1.png",
        pattern,
      ),
    ).toBe(true);
    // one level nested inside the suite directory, still under **
    expect(
      matchesGlob("__Snapshots__/Suite/nested/a.png", pattern),
    ).toBe(true);
    expect(matchesGlob("__Snapshots__.png", pattern)).toBe(false);
    expect(matchesGlob("src/main.swift", pattern)).toBe(false);
  });
});

describe("matchesAnyGlob", () => {
  it("is true the moment any one pattern matches", () => {
    expect(matchesAnyGlob("a.png", ["*.jpg", "*.png"])).toBe(true);
  });

  it("is false when the list is empty or every pattern misses", () => {
    expect(matchesAnyGlob("a.png", [])).toBe(false);
    expect(matchesAnyGlob("a.png", ["*.jpg"])).toBe(false);
  });
});

describe("compileGlob -- built once per pattern, not once per call", () => {
  it("returns the SAME RegExp instance for a repeated pattern string", () => {
    // The finding this proves: matchesGlob/matchesAnyGlob call compileGlob on
    // every path, and a pattern repeated across many changed files (the
    // ordinary case -- one glob, many pngs) must not recompile each time.
    const first = compileGlob("**/__Snapshots__/**/*.png");
    const second = compileGlob("**/__Snapshots__/**/*.png");
    expect(second).toBe(first);
  });

  it("still compiles a DIFFERENT pattern into its own regex", () => {
    expect(compileGlob("*.png")).not.toBe(compileGlob("*.jpg"));
  });
});

describe("escaping -- a regex metacharacter in a pattern is literal", () => {
  it("treats '.', '(', ')' and the rest as themselves, not as regex", () => {
    expect(matchesGlob("a.b.png", "a.b.png")).toBe(true);
    expect(matchesGlob("aXb.png", "a.b.png")).toBe(false);
    expect(matchesGlob("a(1).png", "a(1).png")).toBe(true);
  });
});
