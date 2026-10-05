// src/canon/paths.ts -- path IDENTITY and CONTAINMENT for the canon family,
// with the platform a parameter rather than the host's `path`.
//
// WHY ITS OWN MODULE (zheref/nen#294, Windows CI). The checkout-root check
// compared `realpathSync(path)` with `git rev-parse --show-toplevel` as plain
// strings. On Windows the two spell one directory differently: node's
// JavaScript realpath keeps an 8.3 short name (`C:\Users\LORDZH~1\...`), while
// git answers with the long name, forward slashes and its own case
// (`C:/Users/lordzheref/...`). Every checkout failed as `not-checkout-root`.
//
// THE RULE: before any compare, both sides go through `realpathSync.native`
// -- the OS's own resolution, which expands short names on Windows -- and on
// win32 they are then normalised with `path.win32` (one separator, `.`/`..`
// folded) and compared case-insensitively, as NTFS does. On every other
// platform `path.posix` and an exact compare. The platform is passed in, never
// read from the host, so the win32 branch is provable on every CI lane.
//
// THERE IS NO dev+ino FALLBACK, and none is needed: identity is decided on
// the OS's canonical spelling, not on inode numbers (which Windows does not
// report reliably through node). A path that does not exist is spelled through
// its nearest existing ancestor (resolvedOrSelf), so a compare never mixes a
// resolved side with an unresolved one; the step that reads such a path
// refuses it by name.

import { realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/** The filesystem facts the compares need, injectable so a test can model another host's answers. */
export interface PathSeam {
  /** The OS's canonical spelling of an existing path; throws when it does not exist. */
  readonly realpath: (path: string) => string;
  /** True for an existing directory; throws when nothing is there. */
  readonly isDirectory: (path: string) => boolean;
}

export const nativePaths: PathSeam = {
  realpath: (path: string): string => realpathSync.native(path),
  isDirectory: (path: string): boolean => statSync(path).isDirectory(),
};

function flavour(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/**
 * `path` resolved by the OS where it exists; where it does not, its nearest
 * existing ancestor resolved and the missing tail appended lexically -- so a
 * path that does not exist yet is still spelled the way its existing parent
 * is (`/var/x/new` reads `/private/var/x/new` on macOS, `LORDZH~1\new` reads
 * its long name on Windows), and a compare never mixes a resolved side with an
 * unresolved one. `path` is expected absolute; the platform's separators are
 * both accepted.
 */
export function resolvedOrSelf(path: string, seam: PathSeam = nativePaths, platform: NodeJS.Platform = process.platform): string {
  const p = flavour(platform);
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      const resolved = seam.realpath(current);
      return tail.length === 0 ? resolved : p.join(resolved, ...tail.reverse());
    } catch {
      const parent = p.dirname(current);
      if (parent === current) return path;
      tail.push(p.basename(current));
      current = parent;
    }
  }
}

/** The form two paths are compared in: resolved, normalised for `platform`, case-folded on win32. */
export function comparable(path: string, platform: NodeJS.Platform, seam: PathSeam = nativePaths): string {
  const flat = flavour(platform).normalize(resolvedOrSelf(path, seam, platform));
  const trimmed = flat.length > 1 && /[\\/]$/.test(flat) && !/^[A-Za-z]:[\\/]$/.test(flat) ? flat.slice(0, -1) : flat;
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** Do `a` and `b` name the same directory on `platform`? */
export function samePath(a: string, b: string, platform: NodeJS.Platform, seam: PathSeam = nativePaths): boolean {
  return comparable(a, platform, seam) === comparable(b, platform, seam);
}

/** Is `file` the `root` itself or below it, on `platform`, after both are resolved? */
export function containedOn(root: string, file: string, platform: NodeJS.Platform, seam: PathSeam = nativePaths): boolean {
  const p = flavour(platform);
  const rel = p.relative(comparable(root, platform, seam), comparable(file, platform, seam));
  return !(rel === ".." || rel.startsWith(`..${p.sep}`) || rel.startsWith("../") || p.isAbsolute(rel));
}
