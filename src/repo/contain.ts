// src/repo/contain.ts -- "does this path stay inside the tree --repo pointed at?",
// asked once for the whole CLI.
//
// WHY IT IS ITS OWN MODULE. Two families ask the question and neither may
// import the other. ../shu/run.ts asks it of a path a DECLARATION states
// (`project.lanes.<lane>.cwd`, a precondition) and is the module every spawn in
// this repository goes through; ../scaffold/init.ts asks it of a path a FLAG
// states (`--hook-path`, `--canon-values-path`) and of the two files it creates
// itself, and ../profiles/inertness.test.ts exists to keep the scaffold family
// away from the spawn seam. A rule copied into both would be the rule that
// drifts in exactly one direction: the copy that is not the one somebody
// hardens.
//
// TWO QUESTIONS, NOT ONE, AND THE DIFFERENCE IS THE FILESYSTEM.
//
//   * `containedPath` is LEXICAL. It resolves the value and asks whether the
//     result is the root or below it. It touches no disk, so it answers for a
//     path that does not exist yet and for a caller that only needs to compute
//     one.
//   * `realContainment` asks the same of the path the kernel would actually
//     reach: the deepest ancestor that EXISTS is resolved through every symlink
//     first. A lexically contained `<root>/nen/contract.json` lands outside the
//     repository the moment `<root>/nen` is a symlink, and the report would
//     still have said `nen/contract.json`.
//
// THE LEXICAL ONE IS NEVER THE WHOLE ANSWER FOR A PATH THAT IS ABOUT TO BE USED.
// That was the shape of zheref/nen#157: `../shu/run.ts`'s `insideRepo` asked
// `containedPath` alone, so a symlinked `cwd`, precondition, artifact, launch
// artifact or `stdoutTo` walked out of the tree while every line nen printed
// said otherwise. It asks both now. The lexical half alone stays right for a
// caller that only COMPUTES a path rather than reaching one: `../shu/proof.ts`
// deciding where a proof would be written, `../report/data.ts` where one would
// be read, `../surface/command.ts` asking whether one flag-stated directory
// sits under another.
//
// NEITHER THROWS. The caller composes the refusal, because the callers name
// different things in it -- a declaration pointer, or the flag the value came
// from -- and a shared message would name neither well.

import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Is `absolute` the root itself, or below it?
 *
 * The escape check is `rel === ".."`, `rel` starting with `..` FOLLOWED BY A
 * SEPARATOR, or `isAbsolute` -- never a bare `rel.startsWith("..")`, which also
 * matches a root entry that merely happens to be NAMED starting with `..`
 * (`..something`), rejecting a legitimate path that never left the tree. Both
 * separators are checked -- `path.sep` for the platform `relative` actually
 * used, and the literal `/` alongside it because a caller may state a
 * POSIX-style path even when nen runs on Windows. `isAbsolute` covers the
 * Windows case where the two paths are on different drives and `relative`
 * cannot express the step at all -- a platform-conditional hole this
 * repository's CI matrix exists to catch.
 */
export function isContained(root: string, absolute: string): boolean {
  const rel = relative(root, absolute);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || isAbsolute(rel));
}

/**
 * `value` resolved against `root`, or null when it resolves outside it.
 *
 * An ABSOLUTE `value` re-roots safely (`resolve` returns it unchanged, and the
 * containment test then answers for it); only a `..` escapes. Both are checked
 * the same way, because "it happened to be spelled absolutely" is not a reason
 * to skip the question.
 */
export function containedPath(root: string, value: string): string | null {
  const absolute = resolve(root, value);
  return isContained(root, absolute) ? absolute : null;
}

/** What the filesystem says a write to a lexically contained path would hit. */
export interface RealContainment {
  /** The path the kernel would actually write to, symlinks resolved. */
  readonly real: string;
  /** True when `real` is the real root or below it. */
  readonly contained: boolean;
  /**
   * The deepest EXISTING ancestor whose real path differs from its lexical
   * one -- the link that redirected the write -- or null when nothing did.
   */
  readonly link: string | null;
  /** Where that link points, or null when there is no link. */
  readonly target: string | null;
}

/** Present on disk, a DANGLING symlink included -- `lstat`, never `exists`. */
function present(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch (error) {
    // ENOTDIR is an ABSENCE, not a presence: it says an ancestor is a file, so
    // this path is not there and the walk must keep going up until it finds
    // the ancestor that is. ENOENT the same. Anything else -- EACCES on a
    // parent, most likely -- is not an absence, and the write itself will
    // report the real errno better than another step up would.
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOTDIR" && code !== "ENOENT";
  }
}

/** `realpathSync`, or null when the path cannot be resolved at all. */
function realOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * The same containment question, asked of the REAL path.
 *
 * IT WALKS UP TO THE DEEPEST EXISTING ANCESTOR, because the path being written
 * does not exist yet -- that is the point of writing it -- and `realpathSync`
 * on a path with a missing tail throws rather than answering. The ancestor is
 * resolved through every symlink, the missing tail is rejoined to it, and the
 * result is compared against the REAL root: a `<root>/nen` symlinked to
 * `/tmp/elsewhere` makes `<root>/nen/contract.json` land at
 * `/tmp/elsewhere/contract.json`, which is not under the root however the
 * report spells it.
 *
 * A CASE-INSENSITIVE ROOT IS NOT A REDIRECT, and that is the win32 half of this
 * function -- shared, as it happens, with the macOS default filesystem. Both ends
 * go through the SAME `realpath`, which preserves the spelling the caller gave
 * for a component it did not have to resolve, so a `--repo C:\Repo` whose
 * declaration is read from `c:\repo` produces `realRoot` and `anchorReal` with
 * the same case and `redirected` stays false; and `isContained`'s `relative`
 * then compares them the way the PLATFORM does -- case-insensitively on win32,
 * case-sensitively on POSIX -- rather than the way a hand-rolled `startsWith`
 * would. Comparing normalised case here instead would call every path on a
 * case-sensitive host contained the moment its spelling merely matched. Pinned
 * end to end in ../shu/run.test.ts § the repository boundary.
 */
export function realContainment(root: string, absolute: string): RealContainment {
  const realRoot = realOf(resolve(root));
  const tail: string[] = [];
  let anchor = absolute;
  while (!present(anchor)) {
    const parent = dirname(anchor);
    if (parent === anchor) break;
    tail.unshift(anchor.slice(parent.length).replace(/^[\\/]+/, ""));
    anchor = parent;
  }
  const anchorReal = realOf(anchor);
  if (anchorReal === null || realRoot === null) {
    // NEITHER END COULD BE RESOLVED, so nothing here is PROVEN to leave the
    // tree -- and a containment check that refused on "could not tell" would
    // refuse a dangling symlink, a racing delete and a permission-shadowed
    // parent alike. The write is allowed to proceed and to fail with its own
    // errno, which the caller records: that is a fact rather than a guess.
    return { real: absolute, contained: true, link: null, target: null };
  }
  const real = tail.length === 0 ? anchorReal : join(anchorReal, ...tail);
  // A LINK ONLY WHERE THE PATH ITSELF WAS REDIRECTED. `realpath` also
  // normalises the ancestors a caller never wrote (`/var` -> `/private/var` on
  // macOS), so comparing whole paths would call every temporary directory a
  // symlink. The comparison is against the anchor with the ROOT's own
  // resolution already applied.
  const lexical = isContained(resolve(root), anchor) ? join(realRoot, relative(resolve(root), anchor)) : anchor;
  const redirected = anchorReal !== lexical;
  return {
    real,
    contained: isContained(realRoot, real),
    link: redirected ? anchor : null,
    target: redirected ? anchorReal : null,
  };
}
