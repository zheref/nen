// src/repo/family.ts -- `nen repo family <name>`: one product family's
// specification repository and members, resolved (zheref/nen#453, HR-16).
//
// THE REGISTRY DECLARES, THIS RESOLVES, NOTHING DECIDES. `families[]` is
// validated by ../schema/repos.ts at load (every member code an exact key of
// product_codes); this file turns each code into the `owner/name` it names
// through ../verbs/pr_ready.ts's `resolveProductCode` -- the ONE lookup every
// `<CODE>#<n>` reference already goes through, so a member and a ref with the
// same code can never name two different repositories.
//
// AN UNKNOWN FAMILY IS A USAGE REFUSAL (exit 2) listing the declared names --
// never a guess, never a near match picked. A member whose code the registry
// cannot turn into a slug (a bare name and consumers that disagree on the
// owner) is the registry's own data failing, so it is exit 1 with the reason,
// never a member silently dropped from the list.

import { VerbUsageError } from "../cli/command.js";
import type { ProductFamily, RepoRegistry } from "../schema/repos.js";
import { resolveProductCode } from "../verbs/pr_ready.js";
import type { GateId } from "../schema/decisions.js";

export const FAMILY_CONTRACT = "nen.repo.family/v0.1";

export interface ResolvedMember {
  readonly code: string;
  /** `owner/name`, resolved through product_codes. */
  readonly repo: string;
  readonly platform: string | null;
}

export interface FamilyResolution {
  readonly contract: string;
  readonly family: string;
  readonly spec: { readonly repo: string; readonly role: "spec"; readonly gate: GateId };
  readonly members: readonly ResolvedMember[];
  /** Where the family was read, by pointer. */
  readonly source: string;
}

export class FamilyResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FamilyResolutionError";
  }
}

export function resolveFamily(registry: RepoRegistry, name: string): FamilyResolution {
  const families = registry.families ?? [];
  if (families.length === 0) {
    throw new VerbUsageError(`${registry.path} declares no families[]; there is no family '${name}' to resolve.`);
  }
  const wanted = name.toLowerCase();
  const family: ProductFamily | undefined = families.find((entry): boolean => entry.name.toLowerCase() === wanted);
  if (family === undefined) {
    throw new VerbUsageError(
      `'${name}' is not a family in ${registry.path}. Declared families: ${families.map((entry): string => entry.name).join(", ")}.`,
    );
  }
  const members = family.members.map((member): ResolvedMember => {
    try {
      const slug = resolveProductCode(member.code, registry, {
        explicitForm: (bare): string => `a full 'owner/${bare}' slug as the product_codes value`,
      });
      return { code: member.code, repo: `${slug.owner}/${slug.repo}`, platform: member.platform };
    } catch (error) {
      throw new FamilyResolutionError(
        `families[${family.index}] ('${family.name}') member '${member.code}' could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  return {
    contract: FAMILY_CONTRACT,
    family: family.name,
    spec: { repo: family.spec.repo, role: family.spec.role, gate: family.spec.gate },
    members,
    source: `${registry.path}: families[${family.index}]`,
  };
}

export function renderFamily(resolution: FamilyResolution): string[] {
  return [
    `family ${resolution.family}: spec ${resolution.spec.repo} · role ${resolution.spec.role} · gate ${resolution.spec.gate}`,
    ...resolution.members.map((member): string => `  ${member.code} ${member.repo} ${member.platform ?? "(no platform)"}`),
  ];
}
