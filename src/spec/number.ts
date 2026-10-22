// src/spec/number.ts -- `nen spec number`: the next free `{nnn}` in a spec
// repository, across `origin/<base>` and every open pull request's folders.
//
// THE NUMBER IS COMPUTED, THE FOLDER IS NOT CHOSEN. Two captures in flight at
// once would both read `origin/<base>`, both see `003` as the highest, and both
// open `004` -- so an open PR's folder RESERVES its number. The next number is
// the highest one taken anywhere plus one (Spec Kit's own rule: a gap left by a
// closed PR is not reused, because a reader may still cite it). nen picks no
// slug and opens no folder.
//
// IT READS WHAT THE CHECKOUT LAST FETCHED. `origin/<base>` is read as the
// caller left it, and its sha is reported, so a stale fetch is visible rather
// than silently trusted; fetching is the caller's. A base that cannot be read,
// or a PR list gh could not produce, is exit 1 -- never "no folders".

import { GH, GIT, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import { matchFolder, type SpecLayout } from "./layout.js";

export const SPEC_NUMBER_CONTRACT = "nen.spec.number/v0.1";

export interface TakenFolder {
  readonly nnn: string;
  readonly slug: string;
  readonly folder: string;
  /** `base` when the folder is on origin/<base>, else the open PR that adds it. */
  readonly source: "base" | "pr";
  readonly pr: number | null;
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface SpecNumberReport {
  readonly contract: string;
  readonly repo: string;
  readonly target: string;
  readonly layout: string;
  readonly base: string;
  readonly baseSource: string;
  readonly baseSha: string;
  readonly openPrs: number;
  readonly taken: readonly TakenFolder[];
  /** `{nnn}` values two or more different folders claim. */
  readonly collisions: readonly string[];
  readonly next: string | null;
  readonly reason: string | null;
}

export class SpecNumberReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecNumberReadError";
  }
}

const OPEN_PR_LIMIT = 500;
/** The most files `gh pr list --json files` returns for one PR. */
export const PR_FILES_PAGE = 100;

export function prListArgv(target: Target): readonly string[] {
  return ["pr", "list", "--repo", target.slug, "--state", "open", "--limit", String(OPEN_PR_LIMIT), "--json", "number,files"];
}

/** The folder a path sits in under this layout, or null. */
function folderOfPath(layout: SpecLayout, path: string): { name: string; nnn: string; slug: string } | null {
  const prefix = `${layout.root}/`;
  if (!path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length).split("/")[0] ?? "";
  const parsed = matchFolder(layout, name);
  return parsed === null ? null : { name, ...parsed };
}

export function readBaseFolders(seams: Seams, repo: string, layout: SpecLayout, base: string): { sha: string; folders: TakenFolder[] } {
  const ref = `origin/${base}`;
  const resolved = seams.run(GIT, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: repo });
  const sha = outputLines(resolved.stdout)[0];
  if (resolved.spawnFailed) throw new SpecNumberReadError("git could not be started");
  if (resolved.code !== 0 || sha === undefined) throw new SpecNumberReadError(`${ref} does not resolve in ${repo}; fetch it first (nen reads what the checkout last fetched and fetches nothing)`);
  const listed = seams.run(GIT, ["ls-tree", "-d", "--name-only", sha, "--", `${layout.root}/`], { cwd: repo });
  if (listed.code !== 0) throw new SpecNumberReadError(`git ls-tree could not list ${layout.root}/ at ${ref}: ${outputLines(listed.stderr).join(" ") || `exit ${listed.code}`}`);
  const folders: TakenFolder[] = [];
  for (const path of outputLines(listed.stdout)) {
    const folder = folderOfPath(layout, path);
    if (folder !== null) folders.push({ nnn: folder.nnn, slug: folder.slug, folder: `${layout.root}/${folder.name}`, source: "base", pr: null });
  }
  return { sha, folders };
}

export function readPrFolders(seams: Seams, target: Target, layout: SpecLayout): { count: number; folders: TakenFolder[] } {
  const result = seams.run(GH, [...prListArgv(target)]);
  if (result.spawnFailed) throw new SpecNumberReadError("gh could not be started");
  if (result.code !== 0) throw new SpecNumberReadError(`gh pr list failed for ${target.slug}: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}`);
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    throw new SpecNumberReadError("gh pr list answered with text that is not JSON");
  }
  if (!Array.isArray(raw)) throw new SpecNumberReadError("gh pr list did not answer with a list");
  if (raw.length >= OPEN_PR_LIMIT) throw new SpecNumberReadError(`gh pr list returned ${raw.length} open PRs, the limit nen asked for; some may be unread, so no number is computed`);
  const folders: TakenFolder[] = [];
  for (const entry of raw as { number?: unknown; files?: unknown }[]) {
    if (typeof entry?.number !== "number" || !Array.isArray(entry.files)) throw new SpecNumberReadError("an open PR in gh's answer carries no number or no files list");
    // gh reads at most PR_FILES_PAGE files per PR in this listing; a PR at
    // that count may hold a folder past it, so it is unread, not empty.
    if (entry.files.length >= PR_FILES_PAGE) throw new SpecNumberReadError(`PR #${entry.number} lists ${entry.files.length} files, the most gh pr list returns; a folder past them would be unread, so no number is computed`);
    const names = new Set<string>();
    for (const file of entry.files as { path?: unknown }[]) {
      if (typeof file?.path !== "string") throw new SpecNumberReadError(`a file of PR #${entry.number} carries no path`);
      const folder = folderOfPath(layout, file.path);
      if (folder !== null && !names.has(folder.name)) {
        names.add(folder.name);
        folders.push({ nnn: folder.nnn, slug: folder.slug, folder: `${layout.root}/${folder.name}`, source: "pr", pr: entry.number });
      }
    }
  }
  return { count: raw.length, folders };
}

export function computeNext(taken: readonly TakenFolder[]): { next: string | null; collisions: string[]; reason: string | null } {
  const byNumber = new Map<string, Set<string>>();
  for (const folder of taken) {
    const set = byNumber.get(folder.nnn) ?? new Set<string>();
    set.add(folder.folder);
    byNumber.set(folder.nnn, set);
  }
  const collisions = [...byNumber.entries()].filter(([, set]): boolean => set.size > 1).map(([nnn]): string => nnn).sort();
  const highest = taken.reduce((max, folder): number => Math.max(max, Number(folder.nnn)), 0);
  if (highest >= 999) return { next: null, collisions, reason: "999 is taken; a three-digit {nnn} has no next value" };
  return { next: String(highest + 1).padStart(3, "0"), collisions, reason: null };
}

export function renderSpecNumber(report: SpecNumberReport): string[] {
  return [
    `next: ${report.next ?? `none -- ${report.reason ?? ""}`}`,
    `layout ${report.layout} · base origin/${report.base} (${report.baseSource}) at ${report.baseSha.slice(0, 12)} · ${report.openPrs} open PR(s) on ${report.target}`,
    ...report.taken.map((folder): string => `  ${folder.nnn} ${folder.folder} ${folder.source === "base" ? "on base" : `reserved by #${folder.pr ?? "?"}`}`),
    ...(report.collisions.length === 0 ? [] : [`collision: ${report.collisions.join(", ")} claimed by more than one folder; which keeps it is not nen's to pick`]),
  ];
}
