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

// A path-shaped ("."/".."/empty) segment; used to refuse a scenario the
// derived stack path would otherwise silently traverse out of --stackDir with.
const TRAVERSAL_OR_EMPTY = /^$|^\.\.?$|\//;

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
  if (TRAVERSAL_OR_EMPTY.test(options.scenario)) {
    return {
      ok: false,
      reason: `scenario '${options.scenario}' is empty or path-shaped ('.', '..', or contains '/') -- the stack handbook path is derived directly from it ('<stackDir>/<scenario>/<leaf>'), so an empty or traversal-shaped scenario would resolve outside --stack-dir instead of refusing.`,
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
