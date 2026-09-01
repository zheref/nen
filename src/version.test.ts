import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROGRAM, VERSION } from "./version.js";

// The drift guard the header of version.ts promises. It reads package.json
// through `process.cwd()` -- vitest runs from the repo root -- rather than from
// `import.meta.url`, so this test exercises the same root-resolution discipline
// the shipped code is held to (Akatsuki migration §3).
describe("VERSION", () => {
  it("matches package.json's version exactly", () => {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const pkg: unknown = JSON.parse(raw);
    expect(typeof pkg).toBe("object");
    const version = (pkg as { version?: unknown }).version;
    expect(version).toBe(VERSION);
  });

  it("is a semver-shaped string", () => {
    // The `-dev.N` pre-release suffix is gone as of the v0.1.0 release: this
    // is the exact string zheref/hatsu#1's D10 gate is meant to see. The
    // pre-release group stays optional (rather than dropped outright) so this
    // test does not need to change again for a future `-rc.N` or `-dev.N`
    // cycle ahead of v0.2.0.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it("names the program", () => {
    expect(PROGRAM).toBe("nen");
  });
});
