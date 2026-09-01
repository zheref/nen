// src/labels/rename.ts -- rename-in-place migration, §5's own requirement:
// idempotent, logged, dry-run first, every issue association preserved.
//
// `gh label edit <old> --name <new>` IS THE WHOLE MECHANISM, and the reason
// it preserves associations is that it is one API call against the label's
// existing id -- GitHub does not delete-and-recreate on a rename, so every
// issue (open and closed) that carried the old name keeps the SAME label
// object under its new name. This module's whole job is making the call
// idempotent and reporting per-mapping, never re-deriving that guarantee.
//
// IDEMPOTENT MEANS A SECOND RUN IS A NO-OP, NOT A FAILURE. Once a mapping has
// been applied, the OLD name no longer exists -- so re-running the same
// invocation would otherwise fail every entry with "label not found". This
// module reads the live label set FIRST and classifies each mapping against
// it: the new name already present and the old name gone is "already done",
// reported as success, not retried.

import { GH, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";

export interface RenameEntry {
  readonly from: string;
  readonly to: string;
}

// `from=to,from2=to2`. Order preserved -- a rename map that lists a chain
// (a->b, b->c) must apply in the order the caller wrote it.
export function parseRenameMap(value: string): readonly RenameEntry[] {
  return value
    .split(",")
    .map((entry): string => entry.trim())
    .filter((entry): boolean => entry !== "")
    .map((entry): RenameEntry => {
      const index = entry.indexOf("=");
      if (index === -1) {
        throw new Error(`'${entry}' is not a 'from=to' pair.`);
      }
      return { from: entry.slice(0, index).trim(), to: entry.slice(index + 1).trim() };
    });
}

export function renameArgv(target: Target, entry: RenameEntry): readonly string[] {
  return ["label", "edit", entry.from, "--repo", target.slug, "--name", entry.to];
}

export function listLabelNamesArgv(target: Target): readonly string[] {
  return ["label", "list", "--repo", target.slug, "--limit", "1000", "--json", "name"];
}

export type RenameStatus = "renamed" | "already-done" | "would-rename" | "failed";

export interface RenameResult {
  readonly from: string;
  readonly to: string;
  readonly status: RenameStatus;
  readonly message: string;
}

export function listLabelNames(seams: Seams, target: Target): ReadonlySet<string> {
  const result = seams.run(GH, [...listLabelNamesArgv(target)]);
  if (result.code !== 0) {
    throw new Error(`could not list labels on ${target.slug}: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}`);
  }
  const parsed: unknown = JSON.parse(result.stdout.trim() === "" ? "[]" : result.stdout);
  if (!Array.isArray(parsed)) return new Set();
  return new Set(
    parsed.map((entry): string => String((entry as Record<string, unknown>)["name"] ?? "")).filter((name): boolean => name !== ""),
  );
}

export function renameLabels(
  seams: Seams,
  target: Target,
  entries: readonly RenameEntry[],
  dryRun: boolean,
): readonly RenameResult[] {
  const existing = new Set(listLabelNames(seams, target));
  const results: RenameResult[] = [];

  for (const entry of entries) {
    const fromExists = existing.has(entry.from);
    const toExists = existing.has(entry.to);

    if (!fromExists && toExists) {
      results.push({ from: entry.from, to: entry.to, status: "already-done", message: `'${entry.to}' already exists and '${entry.from}' is gone -- nothing to do` });
      continue;
    }
    if (!fromExists && !toExists) {
      results.push({ from: entry.from, to: entry.to, status: "failed", message: `neither '${entry.from}' nor '${entry.to}' exists on ${target.slug}` });
      continue;
    }

    if (dryRun) {
      results.push({
        from: entry.from,
        to: entry.to,
        status: "would-rename",
        message: `would run: gh ${renameArgv(target, entry).join(" ")}`,
      });
      continue;
    }

    const result = seams.run(GH, [...renameArgv(target, entry)]);
    if (result.code !== 0) {
      results.push({
        from: entry.from,
        to: entry.to,
        status: "failed",
        message: outputLines(result.stderr).at(-1) ?? `exit ${result.code}`,
      });
      continue;
    }
    results.push({ from: entry.from, to: entry.to, status: "renamed", message: `renamed '${entry.from}' -> '${entry.to}', associations preserved` });
    // Keep the live-name snapshot consistent within THIS run, so a chained
    // mapping (a->b, then b->c in the same invocation) sees b as present.
    existing.delete(entry.from);
    existing.add(entry.to);
  }

  return results;
}
