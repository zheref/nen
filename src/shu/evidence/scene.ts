// src/shu/evidence/scene.ts -- KroApple's `scene_of()` (ci_scripts/
// pr_screenshots.sh's own function), generalised for `nen shu evidence`.
//
// THE ORIGINAL RULE, restated so the generalisation below is legible against
// it: `suite="$(basename "$(dirname "$1")")"; suite="${suite%SnapshotTests}"`
// reads the file's IMMEDIATE parent directory and strips a trailing
// `SnapshotTests`; `b="$(basename "$1" .png")"; b="${b%.1}"; b="${b#test_snapshot_}";
// b="${b#test_}"` strips the `.png` extension, a trailing `.<n>` a runner adds
// when two cases share a name, and then two prefixes a generated case name
// carries. Both rules are true of KroApple's own layout --
// `<Suite>SnapshotTests/__Snapshots__/<Suite>SnapshotTests/<file>.png` -- where
// the immediate parent IS the suite directory.
//
// GENERALISED IN ONE PLACE EACH, per the brief:
//   * suite: walk every ANCESTOR directory, nearest first, rather than only
//     the immediate parent -- so a layout one level deeper than KroApple's
//     still finds its suite. A path with no ancestor ending in the suffix at
//     all (Paparazzi's flat `.../snapshots/images/<name>.png`, which names no
//     per-suite directory) falls back to the immediate parent's own name,
//     unstripped -- there is no suffix to remove from a directory that was
//     never named after a suite.
//   * scene: the extension strip is widened from a hard-coded `.png` to
//     WHATEVER extension the file carries, since an evidence glob is not
//     limited to PNGs. The `.<n>` and prefix strips are unchanged.
//
// PURE. No filesystem, no seam -- a caller hands this a path string it already
// has (from ./diff.ts) and gets back the two names it derives.

export interface SuiteAndScene {
  readonly suite: string;
  readonly scene: string;
}

/**
 * The suite one changed path belongs to.
 *
 * Walks the path's directories from NEAREST to FARTHEST; the first one whose
 * name ends with `suiteSuffix` names the suite, with the suffix stripped. No
 * ancestor qualifies -> the immediate parent directory's own name, in full. A
 * file with no directory at all (an evidence glob matching a repository-root
 * file) has no parent to fall back to either, and reports the empty string --
 * `nen shu evidence`'s grouping still works over an empty-string key, and a
 * glob this loose is the repository's own choice.
 */
export function deriveSuite(path: string, suiteSuffix: string): string {
  const directories = path.split("/").slice(0, -1);
  if (suiteSuffix !== "") {
    for (let index = directories.length - 1; index >= 0; index -= 1) {
      const name = directories[index];
      if (name !== undefined && name.endsWith(suiteSuffix)) {
        return name.slice(0, name.length - suiteSuffix.length);
      }
    }
  }
  return directories[directories.length - 1] ?? "";
}

/** The LAST `.something` on a basename -- generalised from KroApple's fixed `.png`. */
const TRAILING_EXTENSION = /\.[A-Za-z0-9]+$/;

/** A runner's own disambiguating suffix: `disabled.1.png`, `disabled.2.png`. */
const TRAILING_INDEX = /\.\d+$/;

/**
 * The scene one changed path represents, from its basename alone.
 *
 * THE SAME FOUR STRIPS, IN THE SAME ORDER `scene_of()` APPLIES THEM: the file
 * extension, a trailing `.<n>` index, the `test_snapshot_` prefix, then the
 * `test_` prefix -- the last two applied UNCONDITIONALLY, one after the other,
 * exactly as the bash `${b#...}` pair does, rather than as an either/or: a
 * name that only ever carried `test_` (never `test_snapshot_`) is untouched by
 * the first strip and then caught by the second. A basename this rule does
 * not recognise (Paparazzi's own package-qualified names carry neither
 * prefix) is returned with only its extension and index removed -- the honest
 * answer for a layout this generalisation was not written to parse.
 */
export function deriveScene(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base
    .replace(TRAILING_EXTENSION, "")
    .replace(TRAILING_INDEX, "")
    .replace(/^test_snapshot_/, "")
    .replace(/^test_/, "");
}

export function deriveSuiteAndScene(path: string, suiteSuffix: string): SuiteAndScene {
  return { suite: deriveSuite(path, suiteSuffix), scene: deriveScene(path) };
}
