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
//     write to: the deepest ancestor that EXISTS is resolved through every
//     symlink first. A lexically contained `<root>/nen/contract.json` lands
//     outside the repository the moment `<root>/nen` is a symlink, and the
//     report would still have said `nen/contract.json`.
//
// NEITHER THROWS. The caller composes the refusal, because the two callers name
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
  } catch {
    // An EACCES on a parent is not an absence: treat it as present and let the
    // write itself report the real errno rather than walking further up.
    return true;
  }
}

/** `realpathSync`, falling back to the lexical path for a dangling link. */
function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
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
  const real = tail.length === 0 ? anchorReal : join(anchorReal, ...tail);
  const redirected = anchorReal !== anchor;
  return {
    real,
    contained: isContained(realRoot, real),
    link: redirected ? anchor : null,
    target: redirected ? anchorReal : null,
  };
}
