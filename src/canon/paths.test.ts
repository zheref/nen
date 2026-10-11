// src/canon/paths.test.ts -- the win32 branch of the canon family's path
// compares, driven on any host through an injected realpath (zheref/nen#294,
// the Windows CI failure: an 8.3 short name on one side, git's long,
// forward-slashed, differently-cased toplevel on the other).

import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedSeams } from "../seam/scripted.js";
import { comparable, containedOn, samePath, type PathSeam } from "./paths.js";
import { VERIFICATION_CONFIG, verifyCanonCheckout } from "./checkout.js";

/** A Windows host as the OS would answer: the short name expands, the case is the disk's. */
const LONG = "C:\\Users\\LordZheref\\AppData\\Local\\Temp\\it\\machine-a\\src\\handbooks";
const windows: PathSeam = {
  realpath: (path: string): string => {
    const key = path.replace(/\//g, "\\").toLowerCase();
    if (key.startsWith("c:\\users\\lordzh~1\\") || key.startsWith("c:\\users\\lordzheref\\")) {
      return LONG.slice(0, "C:\\Users\\LordZheref".length) + path.replace(/\//g, "\\").slice(path.toLowerCase().replace(/\//g, "\\").indexOf("\\appdata"));
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
  isDirectory: (): boolean => true,
};
const SHORT = "C:\\Users\\LORDZH~1\\AppData\\Local\\Temp\\it\\machine-a\\src\\handbooks";
const GIT_TOP = "C:/Users/lordzheref/AppData/Local/Temp/it/machine-a/src/handbooks";

describe("canon path compares -- the win32 branch, on any host", () => {
  it("a short name and git's long, forward-slashed, lower-cased toplevel are one directory", () => {
    expect(samePath(SHORT, GIT_TOP, "win32", windows)).toBe(true);
    expect(comparable(SHORT, "win32", windows)).toBe(LONG.toLowerCase());
  });

  it("is still exact where the platform is not win32: no case folding, no separator rewriting", () => {
    const unresolvable: PathSeam = { realpath: (): never => { throw new Error("ENOENT"); }, isDirectory: (): boolean => true };
    expect(samePath("/Repo/Canon", "/repo/canon", "linux", unresolvable)).toBe(false);
    expect(samePath("C:\\x", "C:/x", "linux", unresolvable)).toBe(false);
    expect(samePath("C:\\X", "c:/x", "win32", unresolvable)).toBe(true);
  });

  it("spells a missing tail through its nearest existing ancestor, so the two sides never mix", () => {
    expect(comparable(`${SHORT}\\handbooks\\new`, "win32", windows)).toBe(`${LONG}\\handbooks\\new`.toLowerCase());
  });

  it("contains across the two spellings on win32, and refuses a sibling and a parent", () => {
    expect(containedOn(SHORT, `${GIT_TOP}/handbooks/stacks/x/rules`, "win32", windows)).toBe(true);
    expect(containedOn(GIT_TOP, SHORT, "win32", windows)).toBe(true);
    expect(containedOn(SHORT, "C:/Users/lordzheref/AppData/Local/Temp/it/machine-a/src/other", "win32", windows)).toBe(false);
    expect(containedOn(SHORT, "C:/Users/lordzheref/AppData", "win32", windows)).toBe(false);
    expect(containedOn(SHORT, "D:/elsewhere", "win32", windows)).toBe(false);
  });

  it("keeps a path that does not resolve in its lexical form, normalised", () => {
    expect(comparable("D:/missing/./x/", "win32", windows)).toBe("d:\\missing\\x");
    expect(comparable("/missing/./x/", "linux", windows)).toBe("/missing/x");
  });

  it("verifyCanonCheckout accepts a short-name checkout whose git toplevel is the long name (the Windows CI failure)", () => {
    const CONSUMER = "C:\\consumer";
    const real = windows.realpath(SHORT);
    const prefix = `git ${VERIFICATION_CONFIG.join(" ")} -C`;
    const tag = "a".repeat(40);
    const answers: Record<string, { code?: number; stdout?: string }> = {
      "rev-parse --show-toplevel": { stdout: `${GIT_TOP}\n` },
      "remote get-url origin": { stdout: "https://github.com/owner/handbooks.git\n" },
      "rev-parse --verify --quiet refs/tags/v1.2.0^{commit}": { stdout: `${tag}\n` },
      "rev-parse --verify --quiet HEAD^{commit}": { stdout: `${tag}\n` },
      "--no-optional-locks status --porcelain=v1 --untracked-files=all --ignored=matching --ignore-submodules=none": { stdout: "" },
      "ls-files -v": { stdout: "" },
      [`ls-tree -r -z --full-tree ${tag}`]: { stdout: "" },
    };
    const seams = new ScriptedSeams(
      [
        ...Object.entries(answers).map(([args, result]) => ({ match: `${prefix} ${real} ${args}`, result })),
        { match: `${prefix} ${CONSUMER} remote get-url origin`, result: { stdout: "git@github.com:owner/consumer.git\n" } },
      ],
      { platform: "win32" },
    );
    const result = verifyCanonCheckout(seams, SHORT, "owner/handbooks", "v1.2.0", CONSUMER, windows);
    expect("verified" in result, JSON.stringify(result)).toBe(true);
    expect(result.path).toBe(real);
  });

  it("the host's own realpath agrees with the posix compare on a real directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-canon-paths-"));
    expect(samePath(dir, realpathSync(dir), process.platform)).toBe(true);
    expect(containedOn(dir, join(dir, "a", "b"), process.platform)).toBe(true);
  });
});
