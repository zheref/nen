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

/** A compiled glob: `test` answers whether a repository path matches. */
export interface GlobMatcher {
  test(path: string): boolean;
}

/** One segment against one pattern segment, `*` any run and `?` one character, by the linear two-pointer walk (no regex, no backtracking blow-up). */
function segmentMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      while (pattern[p] === "*") p += 1;
      star = p;
      mark = t;
    } else if (star !== -1) {
      p = star;
      mark += 1;
      t = mark;
    } else return false;
  }
  while (pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/**
 * A build system's own glob (tsconfig `include`, an Xcode exception path) as a
 * matcher: a `**` segment any run of segments, `*` any run within one segment,
 * `?` one character. It is the BUILD SYSTEM's pattern, read from its file --
 * never one nen chose (SP-14) -- and so UNTRUSTED bytes: it is matched segment
 * by segment, `**` through a memo over (pattern segment, path segment) and each
 * segment by a two-pointer walk, so no pattern can make a match take more than
 * O(pattern x path) steps (Feitan F1 on zheref/nen#517: the regex this replaced
 * took 78 s on a six-star pattern).
 */
export function globMatcher(pattern: string): GlobMatcher {
  const parts = pattern.split("/");
  return {
    test(path: string): boolean {
      const segments = path.split("/");
      const memo = new Map<number, boolean>();
      const walk = (i: number, j: number): boolean => {
        const key = i * (segments.length + 1) + j;
        const known = memo.get(key);
        if (known !== undefined) return known;
        let answer: boolean;
        if (i === parts.length) answer = j === segments.length;
        else if (parts[i] === "**") answer = walk(i + 1, j) || (j < segments.length && walk(i, j + 1));
        else answer = j < segments.length && segmentMatches(parts[i] as string, segments[j] as string) && walk(i + 1, j + 1);
        memo.set(key, answer);
        return answer;
      };
      return walk(0, 0);
    },
  };
}
