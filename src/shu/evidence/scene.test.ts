import { describe, expect, it } from "vitest";
import { deriveScene, deriveSuite, deriveSuiteAndScene } from "./scene.js";

const DEFAULT_SUFFIX = "SnapshotTests";

describe("deriveSuite -- KroApple-shaped paths", () => {
  it("strips the suite suffix off the immediate parent directory", () => {
    // KroApple's own scene_of(): basename(dirname(path)) minus 'SnapshotTests'.
    const path =
      "Kro/Tests/DateTimeFieldSnapshotTests/__Snapshots__/DateTimeFieldSnapshotTests/test_snapshot_disabled.1.png";
    expect(deriveSuite(path, DEFAULT_SUFFIX)).toBe("DateTimeField");
  });

  it("walks past a nested directory to the nearest ancestor ending in the suffix", () => {
    // Generalised over the original rule: one level deeper than KroApple's own
    // layout, the immediate parent is NOT the suite directory, but an ancestor
    // still is.
    const path =
      "__Snapshots__/DurationFieldSnapshotTests/variants/en/test_snapshot_zero.png";
    expect(deriveSuite(path, DEFAULT_SUFFIX)).toBe("DurationField");
  });

  it("falls back to the immediate parent directory when no ancestor ends in the suffix", () => {
    const path = "__Snapshots__/images/disabled.png";
    expect(deriveSuite(path, DEFAULT_SUFFIX)).toBe("images");
  });

  it("reports the empty string for a file with no directory at all", () => {
    expect(deriveSuite("disabled.png", DEFAULT_SUFFIX)).toBe("");
  });

  it("honours a configured suiteSuffix over the default", () => {
    const path = "Views/DateTimeFieldSnapshots/test_snapshot_disabled.png";
    expect(deriveSuite(path, "Snapshots")).toBe("DateTimeField");
    // The default suffix does not apply once a repository states its own.
    expect(deriveSuite(path, DEFAULT_SUFFIX)).toBe("DateTimeFieldSnapshots");
  });
});

describe("deriveSuite -- a Paparazzi-shaped path", () => {
  it("finds no suite-suffixed ancestor at all, and falls back to the parent directory", () => {
    // Paparazzi's own convention (app.cash.paparazzi) writes a flat directory
    // of package-and-class-qualified filenames -- no per-suite directory is
    // ever created, so no ancestor ends in 'SnapshotTests'.
    const path = "app/src/test/snapshots/images/com.example.app.LoginScreenTest_disabled.png";
    expect(deriveSuite(path, DEFAULT_SUFFIX)).toBe("images");
  });
});

describe("deriveScene", () => {
  it("strips the extension, a trailing '.<n>', and the 'test_snapshot_' prefix", () => {
    expect(deriveScene("test_snapshot_disabled.1.png")).toBe("disabled");
    expect(deriveScene("dir/test_snapshot_disabled.2.png")).toBe("disabled");
  });

  it("strips the 'test_' prefix on its own when 'test_snapshot_' was never there", () => {
    expect(deriveScene("test_disabled.png")).toBe("disabled");
  });

  it("strips a non-png extension too -- not hard-coded to KroApple's own", () => {
    expect(deriveScene("test_snapshot_disabled.jpg")).toBe("disabled");
  });

  it("leaves a basename with neither prefix untouched but for its extension and index", () => {
    // The Paparazzi-shaped name: no 'test_' or 'test_snapshot_' prefix at all.
    expect(deriveScene("com.example.app.LoginScreenTest_disabled.png")).toBe(
      "com.example.app.LoginScreenTest_disabled",
    );
  });

  it("passes a basename with no extension through unchanged", () => {
    expect(deriveScene("disabled")).toBe("disabled");
  });
});

describe("deriveSuiteAndScene -- both together", () => {
  it("matches the KroApple worked example from the brief", () => {
    const path =
      "Kro/Tests/DateTimeFieldSnapshotTests/__Snapshots__/DateTimeFieldSnapshotTests/test_snapshot_disabled.1.png";
    expect(deriveSuiteAndScene(path, DEFAULT_SUFFIX)).toEqual({
      suite: "DateTimeField",
      scene: "disabled",
    });
  });

  it("matches the Paparazzi-shaped example", () => {
    const path = "app/src/test/snapshots/images/com.example.app.LoginScreenTest_disabled.png";
    expect(deriveSuiteAndScene(path, DEFAULT_SUFFIX)).toEqual({
      suite: "images",
      scene: "com.example.app.LoginScreenTest_disabled",
    });
  });
});
