// src/run/manifest-modes.test.ts -- the run manifest's file modes and dry
// forms (zheref/nen#522): 0600 under 0700 on every write, a wider mode
// narrowed on rewrite, the legacy move's dry form, and a mode that could not
// be set SAID rather than claimed. Hermetic: every test owns a temp common dir,
// and a failing chmod is injected through ModeOps, never by running as another
// user.

import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  HOST_MODE_OPS,
  locateRunManifest,
  readRunManifest,
  planPark,
  planStart,
  renderModes,
  runManifestPath,
  withManifest,
  writeRunManifest,
  type ModeOps,
  type RunManifest,
} from "./manifest.js";

const NOW = "2026-10-26T00:00:00.000Z";
const POSIX = process.platform !== "win32";
const bits = (path: string): number => statSync(path).mode & 0o777;
const common = (): string => mkdtempSync(join(tmpdir(), "nen-run-modes-"));
const manifest = (): RunManifest => planStart(null, "r1", "zheref/nen", NOW, null).manifest;
const failingChmod: ModeOps = {
  platform: "linux",
  chmod: (): never => {
    throw Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" });
  },
};
const inertChmod: ModeOps = { platform: "linux", chmod: (): void => undefined };
const win32: ModeOps = { platform: "win32", chmod: (): never => { throw new Error("no chmod on win32 in this test"); } };

/** Seed `path` (and its directory) the way an earlier build left them: the umask's 0644 under 0755. */
function seedWide(path: string, document: unknown = manifest()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(document));
  chmodSync(dirname(path), 0o755);
  chmodSync(path, 0o644);
}

describe.runIf(POSIX)("writeRunManifest -- 0600 under 0700, read back (AC-1)", () => {
  it("creates the directory at 0700 and the file at 0600, and says so", () => {
    const path = runManifestPath(common(), "r1");
    const modes = writeRunManifest(path, manifest());
    expect(bits(dirname(path))).toBe(0o700);
    expect(bits(path)).toBe(0o600);
    expect(modes).toEqual({ verdict: "set", file: "0600", directory: "0700", repaired: [], reason: null });
    expect(Object.keys(modes)).toEqual(["verdict", "file", "directory", "repaired", "reason"]);
    expect(renderModes(modes)).toEqual(["mode: file 0600, directory 0700"]);
  });

  it("narrows a manifest an earlier build left at 0644 under 0755 on the next write, and names the repair", () => {
    const path = runManifestPath(common(), "r1");
    seedWide(path);
    const modes = writeRunManifest(path, manifest());
    expect(bits(dirname(path))).toBe(0o700);
    expect(bits(path)).toBe(0o600);
    expect(modes.verdict).toBe("set");
    expect(modes.repaired).toEqual(["directory 0755 -> 0700", "file 0644 -> 0600"]);
    expect(renderModes(modes)[0]).toBe("mode: file 0600, directory 0700 (narrowed: directory 0755 -> 0700, file 0644 -> 0600)");
  });

  it("repairs on every writing verb's path: withManifest narrows the modes of a park onto an old manifest", () => {
    const path = runManifestPath(common(), "r1");
    seedWide(path);
    const result = withManifest(path, (existing) => planPark(existing as RunManifest, "zheref/nen#1", "wrap-up", NOW), true);
    expect(result.outcome).toBe("parked");
    expect(result.modes?.verdict).toBe("set");
    expect(bits(path)).toBe(0o600);
    expect(bits(dirname(path))).toBe(0o700);
  });

  it("leaves the modes alone and reports none when nothing is written (unchanged, existing, conflict)", () => {
    const path = runManifestPath(common(), "r1");
    seedWide(path);
    const result = withManifest(path, (existing) => planStart(existing, "r1", "zheref/nen", NOW, null), true);
    expect(result.outcome).toBe("existing");
    expect(result.modes).toBeNull();
    expect(renderModes(result.modes)).toEqual([]);
    expect(bits(path)).toBe(0o644);
  });
});

describe("a dry form writes nothing -- no file, no directory, no mode (AC-2)", () => {
  it("withManifest without write creates no directory and reports the modes it would set", () => {
    const root = common();
    const path = runManifestPath(root, "r1");
    const result = withManifest(path, (existing) => planStart(existing, "r1", "zheref/nen", NOW, null), false, { ops: { ...HOST_MODE_OPS, platform: "linux" } });
    expect(result.outcome).toBe("started");
    expect(existsSync(join(root, ".nen"))).toBe(false);
    expect(result.modes).toEqual({ verdict: "would-set", file: "0600", directory: "0700", repaired: [], reason: null });
    expect(renderModes(result.modes)).toEqual(["mode: would set file 0600, directory 0700 -- dry run, nothing written"]);
  });

  it.runIf(POSIX)("a dry write over a wide manifest names the narrowing it would make and changes nothing", () => {
    const path = runManifestPath(common(), "r1");
    seedWide(path);
    const result = withManifest(path, (existing) => planPark(existing as RunManifest, "zheref/nen#1", "wrap-up", NOW), false);
    expect(result.modes?.repaired).toEqual(["directory 0755 -> 0700", "file 0644 -> 0600"]);
    expect(bits(path)).toBe(0o644);
    expect(bits(dirname(path))).toBe(0o755);
    expect(JSON.parse(readFileSync(path, "utf8")).parked).toEqual([]);
  });

  it("locateRunManifest's dry form leaves a legacy manifest where it is and reads it in place", () => {
    const root = common();
    const legacy = join(root, "hatsu", "runs", "r1.json");
    seedWide(legacy);
    const located = locateRunManifest(root, "r1", { dryRun: true, ops: { ...HOST_MODE_OPS, platform: "linux" } });
    expect(located).toMatchObject({ path: runManifestPath(root, "r1"), readPath: legacy, migratedFrom: legacy, moved: false });
    expect(located.modes?.verdict).toBe("would-set");
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(join(root, ".nen"))).toBe(false);
  });

  it.runIf(POSIX)("the real legacy move lands the file at 0600 under 0700 and names the narrowing", () => {
    const root = common();
    const legacy = join(root, "hatsu", "runs", "r1.json");
    seedWide(legacy);
    const located = locateRunManifest(root, "r1");
    expect(located.moved).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(bits(located.path)).toBe(0o600);
    expect(bits(dirname(located.path))).toBe(0o700);
    expect(located.modes).toEqual({ verdict: "set", file: "0600", directory: "0700", repaired: ["file 0644 -> 0600"], reason: null });
  });
});

describe("a mode that cannot be set is said, never claimed (AC-3)", () => {
  it.runIf(POSIX)("a chmod that fails: the write stands and the verdict is not-set, naming the failure", () => {
    const path = runManifestPath(common(), "r1");
    seedWide(path);
    const modes = writeRunManifest(path, { ...manifest(), parked: [{ issue: "zheref/nen#1", row: "wrap-up", at: NOW }] }, failingChmod);
    expect(JSON.parse(readFileSync(path, "utf8")).parked).toHaveLength(1);
    expect(modes.verdict).toBe("not-set");
    expect(modes.reason).toMatch(/chmod 0700 .* failed: EPERM/);
    expect(modes.directory).toBe("0755");
    expect(renderModes(modes)[0]).toMatch(/^mode: not set \(chmod 0700 .*EPERM/);
  });

  it.runIf(POSIX)("a chmod that silently does nothing is caught by the read-back", () => {
    const path = runManifestPath(common(), "r1");
    seedWide(path);
    const modes = writeRunManifest(path, manifest(), inertChmod);
    expect(modes.verdict).toBe("not-set");
    expect(modes.reason).toMatch(/directory .* reads 0755, not 0700/);
  });

  it.runIf(POSIX)("a failed chmod on a legacy move is said too", () => {
    const root = common();
    const legacy = join(root, "hatsu", "runs", "r1.json");
    seedWide(legacy);
    const located = locateRunManifest(root, "r1", { ops: failingChmod });
    expect(located.moved).toBe(true);
    expect(located.modes?.verdict).toBe("not-set");
    expect(located.modes?.reason).toMatch(/chmod 0600 on the moved manifest failed/);
  });

  it("a win32 host: the write stands and the verb says no mode was set, and its dry form says the same", () => {
    const path = runManifestPath(common(), "r1");
    const modes = writeRunManifest(path, manifest(), win32);
    expect(existsSync(path)).toBe(true);
    expect(modes).toMatchObject({ verdict: "not-set", file: null, directory: null });
    expect(renderModes(modes)[0]).toMatch(/^mode: not set \(this host \(win32\) has no POSIX file modes/);
    const dry = withManifest(runManifestPath(common(), "r2"), (existing) => planStart(existing, "r2", "zheref/nen", NOW, null), false, { ops: win32 });
    expect(dry.modes?.verdict).toBe("not-set");
    expect(dry.modes?.reason).toMatch(/win32.*dry run, nothing written/);
  });
});

describe.runIf(POSIX)("a manifest path that is not a regular file is refused, never followed (N1, N2 on #522)", () => {
  function victim(): string {
    const path = join(mkdtempSync(join(tmpdir(), "nen-run-victim-")), "victim.txt");
    writeFileSync(path, JSON.stringify(manifest()));
    chmodSync(path, 0o644);
    return path;
  }

  it("a symlinked legacy manifest is refused: nothing moved, the link's target keeps its mode", () => {
    const root = common();
    const target = victim();
    const link = join(root, "hatsu", "runs", "r1.json");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);
    for (const dryRun of [false, true]) {
      expect(() => locateRunManifest(root, "r1", { dryRun })).toThrow(/is a symbolic link; nen reads, moves and writes a run manifest only as a regular file/);
    }
    expect(bits(target)).toBe(0o644);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(runManifestPath(root, "r1"))).toBe(false);
  });

  it("a dangling legacy link is still something there, and refused", () => {
    const root = common();
    const link = join(root, "hatsu", "runs", "r1.json");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(root, "nowhere.json"), link);
    expect(() => locateRunManifest(root, "r1")).toThrow(/is a symbolic link/);
  });

  it("a symlinked manifest path is refused for a read and a write; no repair is claimed for the link's target", () => {
    const root = common();
    const target = victim();
    const path = runManifestPath(root, "r1");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    symlinkSync(target, path);
    expect(() => readRunManifest(path)).toThrow(/is a symbolic link/);
    expect(() => writeRunManifest(path, manifest())).toThrow(/is a symbolic link/);
    expect(() => withManifest(path, (existing) => planStart(existing, "r1", "zheref/nen", NOW, null), false)).toThrow(/is a symbolic link/);
    expect(bits(target)).toBe(0o644);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it("a runs directory that is a link is refused: its mode would be another directory's", () => {
    const root = common();
    const elsewhere = mkdtempSync(join(tmpdir(), "nen-run-elsewhere-"));
    chmodSync(elsewhere, 0o755);
    mkdirSync(join(root, ".nen"), { recursive: true });
    symlinkSync(elsewhere, join(root, ".nen", "runs"));
    expect(() => writeRunManifest(runManifestPath(root, "r1"), manifest())).toThrow(/is a symbolic link; nen keeps run manifests only in a real directory/);
    expect(bits(elsewhere)).toBe(0o755);
  });
});
