// src/spec/tree.ts -- one member checkout, read at ONE commit through git.
//
// EVERY INVENTORY READ GOES THROUGH THE COMMIT, NEVER THE WORK TREE. A row
// carries the sha it was read at, and a sha is only true of the bytes git holds
// for it: a dirty or half-checked-out work tree would put bytes under a sha
// they never belonged to. So the file list is `git ls-tree -r -z <sha>` and each
// read is `git cat-file blob <sha>:<path>`, both through the seam.

import { GIT, outputLines, type Seams } from "../seam/exec.js";

export class TreeReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreeReadError";
  }
}

export interface MemberTree {
  readonly root: string;
  /** The full commit sha the tree was read at. */
  readonly sha: string;
  /** Every blob path at the sha, repository-relative and `/`-separated, sorted. */
  readonly files: readonly string[];
  has(path: string): boolean;
  /** The blob's text, or null when the path is not a blob at the sha. */
  read(path: string): string | null;
}

/** The checkout's commit for `ref` and its blob list; throws TreeReadError when git cannot answer. */
export function readTree(seams: Seams, root: string, ref: string): MemberTree {
  const rev = seams.run(GIT, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root });
  const sha = outputLines(rev.stdout)[0];
  if (rev.code !== 0 || sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) throw new TreeReadError(`${ref} is not a commit in ${root}${rev.stderr.trim() === "" ? "" : `: ${rev.stderr.trim()}`}`);
  const list = seams.run(GIT, ["ls-tree", "-r", "-z", "--full-tree", sha], { cwd: root });
  if (list.code !== 0) throw new TreeReadError(`git ls-tree could not list ${sha} in ${root}: ${list.stderr.trim()}`);
  const files: string[] = [];
  for (const entry of list.stdout.split("\0")) {
    if (entry === "") continue;
    const tab = entry.indexOf("\t");
    const meta = entry.slice(0, tab).split(" ");
    if (tab === -1 || meta[1] !== "blob") continue;
    files.push(entry.slice(tab + 1));
  }
  files.sort();
  const set = new Set(files);
  const cache = new Map<string, string | null>();
  return {
    root,
    sha,
    files,
    has: (path): boolean => set.has(path),
    read(path): string | null {
      if (!set.has(path)) return null;
      const known = cache.get(path);
      if (known !== undefined) return known;
      const blob = seams.run(GIT, ["cat-file", "blob", `${sha}:${path}`], { cwd: root });
      const text = blob.code === 0 ? blob.stdout : null;
      cache.set(path, text);
      return text;
    },
  };
}

/** Number of lines in a text, a trailing newline closing the last one rather than opening another. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** `a/b/../c` style joins are never built: a caller path is joined only after `checkRelativePath`. */
export function joinPath(...parts: readonly string[]): string {
  return parts.filter((part): boolean => part !== "" && part !== ".").join("/").replace(/\/+/g, "/");
}

/** `dir/` prefix test that treats `""` as the root. */
export function under(dir: string, path: string): boolean {
  return dir === "" || path === dir || path.startsWith(`${dir}/`);
}

/** A path normalised through `.` and `..` segments, or null when it climbs out of the root. */
export function normalise(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/**
 * A build system's own glob (tsconfig `include`, an Xcode exception path) as a
 * matcher: `**` any run of segments, `*` any run within one segment, `?` one
 * character. It is the BUILD SYSTEM's pattern, read from its file -- never one
 * nen chose (SP-14).
 */
export function globMatcher(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === "*" && pattern[index + 1] === "*") {
      const slash = pattern[index + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
