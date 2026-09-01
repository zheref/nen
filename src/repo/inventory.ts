// src/repo/inventory.ts -- senkei §2's enumeration: open epics and their
// children, live integration branches with ahead/behind, and open PRs.
//
// FETCHED LIVE, ALWAYS. The skill's own instruction -- "never work from a
// cached list; labels, checks and reviews change under you" -- is why this
// module takes no cache and no snapshot argument; every call it makes goes
// through the Runner and reads the current state.
//
// THE EPIC LABEL AND THE INTEGRATION-BRANCH PREFIX ARE CALLER DATA, never a
// literal. Which label marks an epic, and what prefix names a live integration
// branch, are the target repository's own taxonomy (§3) -- the same
// discipline ../issue/chain.ts's role map already applies to the chain-state
// labels.

import { lines, type Runner } from "../exec/seam.js";
import type { Target } from "../github/target.js";
import { parseIssueList, type FoundIssue } from "../issue/search.js";

export interface EpicEntry {
  readonly epic: FoundIssue;
  readonly children: readonly FoundIssue[];
}

export interface IntegrationBranch {
  readonly name: string;
  readonly aheadOfTrunk: number;
  readonly behindTrunk: number;
}

export interface OpenPrSummary {
  readonly number: number;
  readonly title: string;
  readonly baseRefName: string;
  readonly url: string;
  readonly isDraft: boolean;
}

export interface RepoInventory {
  readonly epics: readonly EpicEntry[];
  readonly integrationBranches: readonly IntegrationBranch[];
  readonly openPrs: readonly OpenPrSummary[];
}

const ISSUE_FIELDS = "number,title,state,url,labels,updatedAt,closedAt";

function runOrThrow(runner: Runner, args: readonly string[], what: string): string {
  const result = runner.run({ bin: "gh", args: [...args] });
  if (result.code !== 0) {
    throw new Error(`could not fetch ${what}: ${(result.spawnError ?? lines(result.stderr).join(" ")) || `exit ${result.code}`}`);
  }
  return result.stdout;
}

export function listEpics(runner: Runner, target: Target, epicLabel: string): readonly FoundIssue[] {
  const raw = runOrThrow(
    runner,
    ["issue", "list", "--repo", target.slug, "--state", "open", "--label", epicLabel, "--limit", "100", "--json", ISSUE_FIELDS],
    `${target.slug}'s open epics`,
  );
  return parseIssueList(raw.trim());
}

// Sub-issues, resolved by the SAME REST endpoint ../issue/subissue.ts already
// reads an id through -- gh's issue-list JSON carries no parent/child edge.
export function listChildren(runner: Runner, target: Target, epicNumber: number): readonly FoundIssue[] {
  const raw = runOrThrow(
    runner,
    ["api", `repos/${target.slug}/issues/${epicNumber}/sub_issues`],
    `${target.slug}#${epicNumber}'s sub-issues`,
  );
  const parsed: unknown = JSON.parse(raw === "" ? "[]" : raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry): FoundIssue => {
    const record = entry as Record<string, unknown>;
    const rawLabels = record["labels"];
    const labels = Array.isArray(rawLabels)
      ? rawLabels
          .map((label): string => String((label as Record<string, unknown>)["name"] ?? ""))
          .filter((name): boolean => name !== "")
      : [];
    return {
      number: Number(record["number"] ?? 0),
      title: String(record["title"] ?? ""),
      state: String(record["state"] ?? ""),
      url: String(record["html_url"] ?? record["url"] ?? ""),
      labels,
      updatedAt: record["updated_at"] === undefined ? null : String(record["updated_at"]),
      closedAt: record["closed_at"] === undefined || record["closed_at"] === null ? null : String(record["closed_at"]),
    };
  });
}

export function listIntegrationBranches(
  runner: Runner,
  target: Target,
  prefix: string,
  trunk: string,
): readonly IntegrationBranch[] {
  const raw = runOrThrow(
    runner,
    ["api", `repos/${target.slug}/branches`, "--paginate", "-q", ".[].name"],
    `${target.slug}'s branches`,
  );
  const names = lines(raw).filter((name): boolean => name.startsWith(prefix));
  return names.map((name): IntegrationBranch => {
    const compareRaw = runOrThrow(
      runner,
      ["api", `repos/${target.slug}/compare/${trunk}...${name}`],
      `${target.slug}'s ${name} vs ${trunk}`,
    );
    const compare = JSON.parse(compareRaw) as Record<string, unknown>;
    return {
      name,
      aheadOfTrunk: Number(compare["ahead_by"] ?? 0),
      behindTrunk: Number(compare["behind_by"] ?? 0),
    };
  });
}

const PR_FIELDS = "number,title,baseRefName,url,isDraft";

export function listOpenPrs(runner: Runner, target: Target): readonly OpenPrSummary[] {
  const raw = runOrThrow(
    runner,
    ["pr", "list", "--repo", target.slug, "--state", "open", "--limit", "100", "--json", PR_FIELDS],
    `${target.slug}'s open PRs`,
  );
  const parsed: unknown = JSON.parse(raw.trim() === "" ? "[]" : raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry): OpenPrSummary => {
    const record = entry as Record<string, unknown>;
    return {
      number: Number(record["number"] ?? 0),
      title: String(record["title"] ?? ""),
      baseRefName: String(record["baseRefName"] ?? ""),
      url: String(record["url"] ?? ""),
      isDraft: record["isDraft"] === true,
    };
  });
}

export function inventoryRepo(
  runner: Runner,
  target: Target,
  epicLabel: string,
  integrationPrefix: string,
  trunk: string,
): RepoInventory {
  const epics = listEpics(runner, target, epicLabel).map((epic): EpicEntry => ({
    epic,
    children: listChildren(runner, target, epic.number),
  }));
  return {
    epics,
    integrationBranches: listIntegrationBranches(runner, target, integrationPrefix, trunk),
    openPrs: listOpenPrs(runner, target),
  };
}
