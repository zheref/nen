// src/dev/sign.test.ts -- the post-build signer (zheref/nen#233): signs then
// verifies through codesign, is a said-so no-op where the tool is absent, and
// never turns a failing codesign into a green build.
import { describe, expect, it } from "vitest";
import { signDarwinBinary, signMain, type SignSpawn, type SignSpawnResult } from "./sign.js";

const scripted = (answers: readonly SignSpawnResult[]): { spawn: SignSpawn; calls: string[] } => {
  const calls: string[] = [];
  const queue = [...answers];
  const spawn: SignSpawn = (exe, args) => {
    calls.push([exe, ...args].join(" "));
    const next = queue.shift();
    if (next === undefined) throw new Error(`unscripted spawn: ${exe} ${args.join(" ")}`);
    return next;
  };
  return { spawn, calls };
};

describe("signDarwinBinary", () => {
  it("re-signs ad hoc with --force, then verifies, in that order and with the path last", () => {
    const { spawn, calls } = scripted([{ status: 0, stderr: "replacing existing signature\n" }, { status: 0, stderr: "" }]);
    const outcome = signDarwinBinary("dist/nen-darwin-arm64", spawn);
    expect(calls).toEqual(["codesign -s - --force dist/nen-darwin-arm64", "codesign -v dist/nen-darwin-arm64"]);
    expect(outcome.kind).toBe("signed");
    expect(outcome.line).toMatch(/ad-hoc-signed and verified/);
  });

  it("is a no-op that SAYS SO where codesign is not on PATH (a Linux or Windows host), and touches nothing else", () => {
    const enoent = Object.assign(new Error("spawnSync codesign ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException;
    const { spawn, calls } = scripted([{ status: null, error: enoent, stderr: "" }]);
    const outcome = signDarwinBinary("dist/nen-darwin-arm64", spawn);
    expect(outcome.kind).toBe("no-codesign");
    expect(outcome.line).toMatch(/codesign is not on PATH.*left as bun built it.*the release lane does/);
    expect(calls).toEqual(["codesign -s - --force dist/nen-darwin-arm64"]);
  });

  it("a codesign that is present and fails -- signing or verifying -- is an error, never a green build", () => {
    const signFails = scripted([{ status: 1, stderr: "dist/nen-darwin-arm64: cannot sign\n" }]);
    expect(() => signDarwinBinary("dist/nen-darwin-arm64", signFails.spawn)).toThrow(/'codesign -s - --force dist\/nen-darwin-arm64' exited 1: dist\/nen-darwin-arm64: cannot sign/);
    const verifyFails = scripted([{ status: 0, stderr: "" }, { status: 1, stderr: "invalid signature\n" }]);
    expect(() => signDarwinBinary("dist/nen-darwin-arm64", verifyFails.spawn)).toThrow(/was signed and still does not verify.*invalid signature.*Nothing to ship/);
    const other = Object.assign(new Error("EACCES"), { code: "EACCES" }) as NodeJS.ErrnoException;
    expect(() => signDarwinBinary("x", scripted([{ status: null, error: other, stderr: "" }]).spawn)).toThrow(/could not run codesign: EACCES/);
  });
});

describe("signMain", () => {
  it("exits 0 on signed and on no-codesign, 1 on a failure, 2 on a bad argv -- the line on stderr each time", () => {
    const lines: string[] = [];
    const err = (line: string): void => { lines.push(line); };
    expect(signMain(["dist/x"], scripted([{ status: 0, stderr: "" }, { status: 0, stderr: "" }]).spawn, err)).toBe(0);
    expect(lines.at(-1)).toMatch(/signed and verified/);
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException;
    expect(signMain(["dist/x"], scripted([{ status: null, error: enoent, stderr: "" }]).spawn, err)).toBe(0);
    expect(lines.at(-1)).toMatch(/not on PATH/);
    expect(signMain(["dist/x"], scripted([{ status: 1, stderr: "no\n" }]).spawn, err)).toBe(1);
    expect(lines.at(-1)).toMatch(/exited 1: no/);
    expect(signMain([], scripted([]).spawn, err)).toBe(2);
    expect(signMain(["a", "b"], scripted([]).spawn, err)).toBe(2);
    expect(lines.at(-1)).toMatch(/^usage: bun src\/dev\/sign\.ts/);
  });
});
