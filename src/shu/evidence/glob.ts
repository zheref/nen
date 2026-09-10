// src/shu/evidence/glob.ts -- a small, dependency-free glob matcher for
// `project.evidence.globs`: `*` (any run of characters within one path
// segment), `**` (any run of characters, segments included -- the "globstar"),
// and `?` (exactly one character within a segment). No `[...]` classes, no
// brace expansion: the schema's own header names only these three, and a
// matcher that quietly accepted more would be a surface nobody declared.
//
// PURE, AND NOTHING ELSE ON ITS IMPORT PATH. This module reads two strings and
// returns a boolean; it never opens a file, never spawns a process, and never
// reads `project.evidence` itself -- that join lives in ./report.ts, so this
// file stays trivially unit-testable and reusable if a second verb ever wants
// the same matcher.
//
// COMPILED TO A REGEXP, NOT WALKED CHARACTER BY CHARACTER AT MATCH TIME. A
// hand-rolled backtracking matcher is exactly the shape that grows an
// exponential blowup on a pathological pattern; delegating to the platform's
// own regex engine is both simpler and safer. The translation is careful
// about ONE thing a naive "replace `**` with `.*`" gets wrong: a bare `**`
// segment is meant to also match ZERO directories, so `**/foo` matches a
// root-level `foo` and `a/**/b` matches `a/b`, not only `a/x/b`. See
// `globToRegExp`'s per-segment cases for how each position earns that "or
// nothing" behaviour.
//
// COMPILED ONCE PER PATTERN, CACHED, NOT ONCE PER CALL. `nen shu evidence`
// matches every changed path against every declared glob, so `matchesGlob`
// and `matchesAnyGlob` -- the two entry points a caller actually uses --
// compile a pattern through `compiledGlob` below, which memoizes by the
// pattern STRING. `globToRegExp` itself stays a plain, uncached function:
// it is what the cache calls, and what a test compiles directly to inspect
// the regex a pattern produces without going through the memo table.
const compiledCache = new Map<string, RegExp>();

/** Escape one character that is a JS regex metacharacter outside our wildcards. */
function escapeLiteral(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** One path SEGMENT (no `/` in it) translated to a regex source fragment. */
function segmentSource(segment: string): string {
  let out = "";
  for (const char of segment) {
    if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += escapeLiteral(char);
  }
  return out;
}

/**
 * Compile one glob pattern to an anchored `RegExp` over a `/`-separated,
 * repo-relative path (never a leading `/`, never a `\`).
 */
export function globToRegExp(pattern: string): RegExp {
  // The whole pattern is one globstar: matches anything, any depth, and the
  // per-segment cases below cannot express "both leading and trailing" in one
  // segment, so this is its own case rather than a fold of the other two.
  if (pattern === "**") return /^.*$/;

  const segments = pattern.split("/");
  const pieces: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    /* c8 ignore next -- pattern.split("/") always yields a defined element per index */
    if (segment === undefined) continue;
    if (segment === "**") {
      const atEnd = index === segments.length - 1;
      if (atEnd) {
        // Trailing: "a/**" matches "a" itself, or "a/" plus anything nested.
        // The group's own "/.*" already carries the separator, optionally,
        // so nothing is pushed ahead of it.
        pieces.push("(?:/.*)?");
        continue;
      }
      // Leading or middle: "**/x" matches root-level "x"; "a/**/b" matches
      // "a/b" with zero directories between, and "a/x/y/b" with several. The
      // group itself ("(?:.*/)?") only ever contributes a TRAILING "/", so a
      // globstar following a LITERAL segment still needs its own leading "/"
      // pushed explicitly -- without it, "a/**/b" and "a/**" would collapse
      // into the same "no separator required at all" shape, and a pattern
      // like "dir/**/*.png" would then match "dirGARBAGE.png": the mandatory
      // slash right after a literal directory name is not itself optional,
      // only how many MORE segments follow it is.
      if (index > 0 && segments[index - 1] !== "**") pieces.push("/");
      pieces.push("(?:.*/)?");
      continue;
    }
    // A literal segment needs an explicit "/" before it UNLESS the immediately
    // preceding token was a globstar -- that piece already ends in an optional
    // "/", and adding a second, non-optional one would demand a directory the
    // globstar was there to make optional.
    if (index > 0 && segments[index - 1] !== "**") pieces.push("/");
    pieces.push(segmentSource(segment));
  }
  return new RegExp(`^${pieces.join("")}$`);
}

/**
 * `globToRegExp(pattern)`, memoized by the pattern string -- exported so a
 * caller matching many paths against the same glob set (../report.ts's whole
 * job) can compile once up front, and so a test can assert the SAME `RegExp`
 * instance comes back for a repeated pattern rather than inferring it from
 * timing.
 */
export function compileGlob(pattern: string): RegExp {
  const cached = compiledCache.get(pattern);
  if (cached !== undefined) return cached;
  const compiled = globToRegExp(pattern);
  compiledCache.set(pattern, compiled);
  return compiled;
}

/** One changed path against one glob pattern. */
export function matchesGlob(path: string, pattern: string): boolean {
  return compileGlob(pattern).test(path);
}

/** One changed path against a LIST of globs -- true the moment any one hits. */
export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern): boolean => matchesGlob(path, pattern));
}
