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
  /** Repo-relative paths, e.g. ["handbooks/uzf-core.md", "handbooks/security-baseline.md"]. Caller data -- see header. */
  readonly alwaysLoad: readonly string[];
  readonly stackDir: string;
  /** Default 'architecture.md'; quality resolution wants a different leaf under the same directory. */
  readonly leaf?: string;
}

export function resolveCanon(options: ResolveCanonOptions): CanonResolution {
  const leaf = options.leaf ?? "architecture.md";
  const stackDir = options.stackDir.replace(/\/+$/, "");
  return {
    scenario: options.scenario,
    alwaysLoad: options.alwaysLoad,
    stackHandbook: `${stackDir}/${options.scenario}/${leaf}`,
  };
}
