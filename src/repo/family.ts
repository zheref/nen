// Family resolution reads only the validated registry. A bare product-code
// value needs one recorded owner; neither the specification's owner nor the
// first of several matching rows is authority for a member's repository.
import { plainLine } from "../cli/plain.js";
import type { RepoRegistry } from "../schema/repos.js";
import { nameHalf, RepoResolutionError } from "./resolve.js";

export class FamilySelectionError extends Error {}

export interface FamilyResolution {
  readonly family: string;
  readonly spec: { readonly repo: string; readonly code: string | null; readonly role: "spec"; readonly gate: "G2" };
  readonly members: readonly { readonly code: string; readonly repo: string; readonly platform: string }[];
}

export function resolveFamily(registry: RepoRegistry, name: string): FamilyResolution {
  const families = registry.families ?? [];
  const index = families.findIndex((row): boolean => row.name.toLowerCase() === name.toLowerCase());
  const family = families[index];
  if (family === undefined) {
    throw new FamilySelectionError(`unknown family ${JSON.stringify(name)}. Declared families: ${families.map((row): string => JSON.stringify(row.name)).join(", ") || "(none declared)"}.`);
  }
  const recorded = [...registry.consumers.map((row): string => row.repo), ...registry.maintainedTools, ...registry.pendingOnboarding];
  const members = family.members.map((member, memberIndex): FamilyResolution["members"][number] => {
    const value = registry.productCodes[member.code] as string;
    let repo = value;
    if (!value.includes("/")) {
      const matches = new Map<string, string>();
      for (const slug of recorded) {
        if (nameHalf(slug).toLowerCase() === value.toLowerCase()) matches.set(slug.toLowerCase(), slug);
      }
      if (matches.size !== 1) {
        throw new RepoResolutionError(`${registry.path}: at families[${index}].members[${memberIndex}].code, product_codes.${JSON.stringify(member.code)} records ${JSON.stringify(value)} with ${matches.size} matching owner/name repositories. Record the full owner/name in product_codes; no owner is guessed.`);
      }
      repo = [...matches.values()][0] as string;
    }
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo) || plainLine(repo) !== repo) {
      throw new RepoResolutionError(`${registry.path}: at families[${index}].members[${memberIndex}].code, product_codes.${JSON.stringify(member.code)} must resolve to an owner/name without control or invisible characters.`);
    }
    return { code: member.code, repo, platform: member.platform };
  });
  const specCodes = Object.entries(registry.productCodes).filter(([, value]): boolean => value.toLowerCase() === family.spec.repo.toLowerCase());
  return { family: family.name, spec: { ...family.spec, code: specCodes.length === 1 ? specCodes[0]?.[0] ?? null : null }, members };
}

export function renderFamily(result: FamilyResolution): string[] {
  return [
    plainLine(`${result.spec.code ?? "-"} ${result.spec.repo} spec`),
    ...result.members.map((member): string => plainLine(`${member.code} ${member.repo} ${member.platform}`)),
  ];
}
