// src/canon/resolve.ts -- handbook-set resolution: always-load + EXACTLY ONE
// stack, per bankai-handbooks' own §"What to load".
//
// THE ALWAYS-LOAD SET IS CALLER DATA, not a literal list of handbook filenames
// baked in here. Which handbooks a repository always loads is that
// repository's own canon manifest (its `handbooks/INDEX.md` in the system this
// was ported from) -- hardcoding a specific set of filenames would be §3's
// prohibition arriving through a manifest instead of a label, and this binary
// serves more than one canon.
//
// THE STACK PATH IS DERIVED, NOT LOOKED UP IN A TABLE. "Exactly one stack
// handbook for the repo's scenario" resolves to `<stackDir>/<scenario>/<leaf>`
// directly -- the scenario name IS the directory name in the system this ports
// from, so there is no scenario->stack MAPPING to hard-code at all. "Never
// load another stack's folder" is therefore true by construction: there is
// only ever the one path this function can produce.

export interface CanonResolution {
  readonly scenario: string;
  readonly alwaysLoad: readonly string[];
  /** The single stack handbook path -- `<stackDir>/<scenario>/<leaf>`. */
  readonly stackHandbook: string;
}

export interface ResolveCanonOptions {
  readonly scenario: string;
  /** Repo-relative paths, e.g. ["handbooks/uzf-core.md", "handbooks/security-baseline.md"]. Caller data -- see header. REQUIRED and never defaulted to empty -- see ResolveCanonResult. */
  readonly alwaysLoad: readonly string[];
  readonly stackDir: string;
  /** Default 'architecture.md'; quality resolution wants a different leaf under the same directory. */
  readonly leaf?: string;
}

export type ResolveCanonResult =
  | { readonly ok: true; readonly value: CanonResolution }
  | { readonly ok: false; readonly reason: string };

// POSITIVE VALIDATION, DELIBERATELY -- an allowlist of what a scenario token
// MAY contain, not a denylist of what it may not. `scenario` is loaded as an
// unconstrained string from JSON (the target repository's own registry) and
// is spliced directly into a filesystem path ('<stackDir>/<scenario>/<leaf>')
// with no further sanitization; a denylist has to enumerate every way a
// string can escape a directory across every host this binary runs on --
// '/' on every platform, '\' on Windows (a first-class supported platform,
// per §10), and a bare '..' segment -- and it takes only one platform's
// separator being missed for `..\\..\\etc` to sail through. A single-segment
// token shape (letters/digits, plus '.', '_', '-' in the interior, never as
// the first or last character) makes every one of those impossible by
// construction: no '/' or '\' can appear at all, and a run of only '.'
// characters -- '.' or '..' -- can never satisfy "starts and ends with a
// letter or digit".
const SCENARIO_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function resolveCanon(options: ResolveCanonOptions): ResolveCanonResult {
  // ALWAYS-LOAD IS REQUIRED, NEVER DEFAULTED TO EMPTY. The module header
  // states the always-load set is what a repository loads unconditionally
  // (its security baseline among them) -- "the caller forgot the flag" and
  // "this repository loads nothing unconditionally" must not produce the
  // same confident answer, the same way --stack-dir is already required
  // rather than silently defaulted.
  if (options.alwaysLoad.length === 0) {
    return {
      ok: false,
      reason: "--always-load named no paths. Omitting it reads as 'this repository loads nothing unconditionally', which is never the actual intent -- pass the repository's own always-load set explicitly.",
    };
  }
  if (!SCENARIO_TOKEN.test(options.scenario)) {
    return {
      ok: false,
      reason: `scenario '${options.scenario}' is not a plain token (letters/digits, with '.', '_' or '-' only in the interior -- never as the first or last character, and never '/' or '\\') -- the stack handbook path is derived directly from it ('<stackDir>/<scenario>/<leaf>'), so anything else, including an empty value, '.', '..', or either path separator, could resolve outside --stack-dir instead of refusing.`,
    };
  }
  const leaf = options.leaf ?? "architecture.md";
  const stackDir = options.stackDir.replace(/\/+$/, "");
  return {
    ok: true,
    value: {
      scenario: options.scenario,
      alwaysLoad: options.alwaysLoad,
      stackHandbook: `${stackDir}/${options.scenario}/${leaf}`,
    },
  };
}
