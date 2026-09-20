// src/report/patterns.ts -- the ONE path-pattern grammar this binary reads a
// caller's path table with: `--tiers`' tier table (./data.ts) and
// `review.scopes`' path lists (../review/scopes.ts).
//
// IT LIVES IN ITS OWN FILE BECAUSE IT NOW HAS TWO READERS. The matcher grew up
// inside ./data.ts answering one question -- "which tier is this changed file
// in" -- and `nen review scopes` asks the identical question of a different
// table ("which reviewer scopes does this changed file raise"). A second
// implementation would be a second grammar the day either widened, and the two
// would disagree about the one thing a caller writes once and expects to mean
// the same in both files: `hooks/**` either claims `hooks/a/b.sh` in both
// places or the tables are not the same language. So the grammar moved here
// whole, unchanged, and ./data.ts re-exports it for every caller that already
// spells it `from "./data.js"`.

/**
 * A PREFIX OR A GLOB, decided by whether the pattern has a metacharacter in it.
 *
 * A pattern with no `*` or `?` is a PATH PREFIX, matched on SEGMENT BOUNDARIES:
 * `src/report` claims `src/report/data.ts` and does not claim `src/reporting.ts`
 * -- a bare `startsWith` would claim both, and a table that silently over-claims
 * is worse than one that misses, because the over-claim is invisible in the
 * report it produces.
 *
 * A pattern WITH one is a glob, in the narrow shell reading: `?` is one
 * character other than `/`, `*` is any run of characters other than `/`, and
 * `**` crosses separators. This is deliberately not a globbing LIBRARY -- no
 * brace expansion, no character classes, no extglob -- because these tables are
 * a handful of directory patterns and every construct beyond these is one more
 * thing a report's tier column, or a review's scope list, can be wrong about.
 */
export function matchesPattern(path: string, pattern: string): boolean {
  if (pattern === "") return false;
  if (!/[*?]/.test(pattern)) {
    const prefix = pattern.replace(/\/+$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return globToRegExp(pattern).test(path);
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
        // `a/**/b` must also match `a/b`: the separator after `**` is optional.
        if (pattern[index + 1] === "/") index += 1;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
