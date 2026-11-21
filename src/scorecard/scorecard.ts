// src/scorecard/scorecard.ts -- the pure half of `nen scorecard` (zheref/hatsu#619).
//
// CALLER-OWNED VOCABULARY. No aspect name lives here. The aspects, and their
// order, are the `aspects` array of the catalogue the caller hands over at run
// time -- Hatsu's contracts/pr-sections.json -- so nen takes no build-time
// dependency on that contract (Fuegoleon's ruling of 2026-11-21, OQ-1) and a
// fourteenth aspect is a data change in Hatsu, never a nen release.
//
// WHAT NEN DOES OWN is the grammar of one row: a markdown table row whose
// first cell is an aspect and whose second is a delta glyph (⬆ improves, ➖
// unchanged, ⬇ regresses), the shape Hatsu's templates/pr-body/improves.md
// renders. Reading that grammar is parsing, the same way `issue criteria`
// owns the '- AC-{n}:' row grammar while the issue's sections stay the
// caller's.
//
// NO I/O HERE. ./command.ts fetches and writes; everything below is driven
// directly by ./scorecard.test.ts.

import { createHash } from "node:crypto";
import { requireArray, requireRecord, requireString, SchemaError } from "../schema/errors.js";

export const SCORECARD_TREND_CONTRACT = "nen.scorecard.trend/v0.1";
export const SCORECARD_SNAPSHOT_CONTRACT = "nen.scorecard.snapshot/v0.1";

export type Delta = "improves" | "unchanged" | "regresses";
/** What one merged PR said about one aspect. */
export type AspectReading = Delta | "unreadable" | "absent";

export interface AspectCatalogue {
  readonly aspects: readonly string[];
  /** The catalogue's own `contract` field, echoed; null when it carries none. */
  readonly contract: string | null;
  /** sha256 of the catalogue file's bytes, so a snapshot names what it was scored against. */
  readonly sha256: string;
}

/** The `aspects` array of a section catalogue, in its declared order. */
export function parseAspectCatalogue(path: string, bytes: Buffer): AspectCatalogue {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new SchemaError(path, "$", `not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const root = requireRecord(path, "$", raw);
  const aspects = requireArray(path, "aspects", root.aspects).map((value, index): string => requireString(path, `aspects[${index}]`, value).trim());
  if (aspects.length === 0) throw new SchemaError(path, "aspects", "expected at least one aspect");
  if (aspects.some((name): boolean => name.length === 0 || name.includes("|"))) throw new SchemaError(path, "aspects", "an aspect must be nonempty and carry no '|'");
  const folded = aspects.map((name): string => name.toLowerCase());
  if (new Set(folded).size !== folded.length) throw new SchemaError(path, "aspects", "duplicate aspect (compared case-insensitively)");
  return {
    aspects,
    contract: typeof root.contract === "string" ? root.contract : null,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** One delta cell, read. Variation selectors and emphasis are ignored. */
export function readDelta(cell: string): Delta | null {
  const text = cell.replace(/[︎️*_`]/g, "").trim().toLowerCase();
  if (/^(?:⬆|↑|🔼|improves?)(?:\s|$)/u.test(text)) return "improves";
  if (/^(?:➖|—|–|-|unchanged)(?:\s|$)/u.test(text)) return "unchanged";
  if (/^(?:⬇|↓|🔽|regress(?:es)?)(?:\s|$)/u.test(text)) return "regresses";
  return null;
}

function cells(line: string): string[] | null {
  const match = /^\s*\|(.*)\|\s*$/.exec(line);
  if (match === null) return null;
  return (match[1] as string).split("|").map((cell): string => cell.trim());
}

/**
 * Every catalogue aspect's reading in one PR body, in catalogue order.
 *
 * The FIRST table row naming an aspect wins; a later row naming it again is
 * ignored, so a quoted older table further down cannot overwrite the PR's own.
 * Rows inside fenced code and HTML comments are not rows. A row naming an
 * aspect whose delta cell is no glyph reads `unreadable`; an aspect with no row
 * reads `absent`.
 */
export function readAspects(body: string, aspects: readonly string[]): Record<string, AspectReading> {
  const index = new Map(aspects.map((name): [string, string] => [name.toLowerCase(), name]));
  const found = new Map<string, AspectReading>();
  const text = body.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (opener !== null) {
      const marker = opener[1] as string;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const row = cells(line);
    if (row === null || row.length < 2) continue;
    const name = index.get((row[0] as string).replace(/[*_`]/g, "").trim().toLowerCase());
    if (name === undefined || found.has(name)) continue;
    found.set(name, readDelta(row[1] as string) ?? "unreadable");
  }
  return Object.fromEntries(aspects.map((name): [string, AspectReading] => [name, found.get(name) ?? "absent"]));
}

// ---------------------------------------------------------------- weeks (UTC)

/** An ISO-8601 week: Monday 00:00 UTC (inclusive) to the next Monday (exclusive). */
export interface Week {
  readonly id: string;
  readonly start: string;
  readonly end: string;
}

const DAY = 86_400_000;

function mondayOf(date: Date): number {
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return midnight - ((new Date(midnight).getUTCDay() + 6) % 7) * DAY;
}

function weekOf(monday: number): Week {
  const thursday = new Date(monday + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const number = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY)) + 1;
  return { id: `${year}-W${String(number).padStart(2, "0")}`, start: new Date(monday).toISOString(), end: new Date(monday + 7 * DAY).toISOString() };
}

/** The ISO week a `YYYY-Www` names, or null when it names none. */
export function parseWeek(id: string): Week | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(id);
  if (match === null) return null;
  const year = Number(match[1]);
  const number = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = weekOf(mondayOf(jan4) + (number - 1) * 7 * DAY);
  return number >= 1 && week.id === id ? week : null;
}

/** The week containing `now`. */
export function currentWeek(now: Date): Week {
  return weekOf(mondayOf(now));
}

/** The last week that ended at or before `now`. */
export function lastCompletedWeek(now: Date): Week {
  return weekOf(mondayOf(now) - 7 * DAY);
}

/** `count` consecutive weeks ending with `through`, oldest first. */
export function weeksThrough(through: Week, count: number): Week[] {
  const last = Date.parse(through.start);
  return Array.from({ length: count }, (_, index): Week => weekOf(last - (count - 1 - index) * 7 * DAY));
}

// ---------------------------------------------------------------- the trend

/** One merged pull request, as GitHub answered for it. */
export interface MergedPull {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly mergedAt: string;
  readonly body: string;
}

export interface Tally {
  readonly improves: number;
  readonly unchanged: number;
  readonly regresses: number;
  /** Merged PRs in the week whose body carried no readable row for the aspect. */
  readonly unrecorded: number;
  /** improves - regresses; null when no PR in the week recorded the aspect. */
  readonly net: number | null;
}

export interface WeekColumn {
  readonly week: string;
  readonly start: string;
  readonly end: string;
  /** True for the week still running at `now`: its numbers can still move. */
  readonly partial: boolean;
  readonly merged: number;
  /** Merged PRs carrying at least one readable aspect row. */
  readonly scored: number;
  readonly pulls: readonly number[];
}

export interface RepoTrend {
  readonly repository: string;
  /** Null when the repository was read; the reason it could not be, otherwise. */
  readonly unreadable: string | null;
  readonly weeks: readonly WeekColumn[];
  /** One row per catalogue aspect, in catalogue order; one tally per week, in week order. */
  readonly aspects: readonly { readonly aspect: string; readonly tallies: readonly Tally[] }[];
}

export interface Trend {
  readonly contract: typeof SCORECARD_TREND_CONTRACT;
  readonly catalogue: { readonly path: string; readonly contract: string | null; readonly sha256: string; readonly aspects: readonly string[] };
  readonly weeks: readonly string[];
  readonly repositories: readonly RepoTrend[];
}

function tally(readings: readonly AspectReading[]): Tally {
  const count = (delta: AspectReading): number => readings.filter((reading): boolean => reading === delta).length;
  const improves = count("improves");
  const unchanged = count("unchanged");
  const regresses = count("regresses");
  return { improves, unchanged, regresses, unrecorded: readings.length - improves - unchanged - regresses, net: improves + unchanged + regresses === 0 ? null : improves - regresses };
}

/** One repository's trend over `weeks`, from the merged PRs read for it. */
export function repoTrend(repository: string, aspects: readonly string[], weeks: readonly Week[], now: Date, pulls: readonly MergedPull[] | { reason: string }): RepoTrend {
  if (!Array.isArray(pulls)) {
    const reason = (pulls as { reason: string }).reason;
    return { repository, unreadable: reason, weeks: [], aspects: aspects.map((aspect) => ({ aspect, tallies: [] })) };
  }
  const buckets = weeks.map((week): { week: Week; rows: { number: number; readings: Record<string, AspectReading> }[] } => ({ week, rows: [] }));
  for (const pull of [...(pulls as readonly MergedPull[])].sort((a, b): number => a.number - b.number)) {
    const at = Date.parse(pull.mergedAt);
    const bucket = buckets.find(({ week }): boolean => at >= Date.parse(week.start) && at < Date.parse(week.end));
    if (bucket !== undefined) bucket.rows.push({ number: pull.number, readings: readAspects(pull.body, aspects) });
  }
  const recorded = (reading: AspectReading): boolean => reading !== "absent" && reading !== "unreadable";
  return {
    repository,
    unreadable: null,
    weeks: buckets.map(({ week, rows }): WeekColumn => ({
      week: week.id,
      start: week.start,
      end: week.end,
      partial: now.getTime() < Date.parse(week.end),
      merged: rows.length,
      scored: rows.filter((row): boolean => Object.values(row.readings).some(recorded)).length,
      pulls: rows.map((row): number => row.number),
    })),
    aspects: aspects.map((aspect) => ({ aspect, tallies: buckets.map(({ rows }): Tally => tally(rows.map((row): AspectReading => row.readings[aspect] as AspectReading))) })),
  };
}

export function buildTrend(path: string, catalogue: AspectCatalogue, weeks: readonly Week[], repositories: readonly RepoTrend[]): Trend {
  return {
    contract: SCORECARD_TREND_CONTRACT,
    catalogue: { path, contract: catalogue.contract, sha256: catalogue.sha256, aspects: catalogue.aspects },
    weeks: weeks.map((week): string => week.id),
    repositories,
  };
}

// ---------------------------------------------------------------- rendering

function signed(net: number | null): string {
  if (net === null) return "·";
  return net > 0 ? `+${net}` : String(net);
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - [...text].length));
}

/** The plain-text rendering: per repository, aspects down, weeks across, net per cell. */
export function renderTrend(trend: Trend): string[] {
  const lines = [`scorecard: ${trend.repositories.length} repositor${trend.repositories.length === 1 ? "y" : "ies"} · ${trend.catalogue.aspects.length} aspects · ${trend.weeks[0]}..${trend.weeks[trend.weeks.length - 1]}`];
  const width = Math.max(6, ...trend.catalogue.aspects.map((name): number => [...name].length)) + 2;
  for (const repo of trend.repositories) {
    lines.push("");
    if (repo.unreadable !== null) {
      lines.push(`${repo.repository} · could-not-read: ${repo.unreadable}`);
      continue;
    }
    const merged = repo.weeks.reduce((sum, week): number => sum + week.merged, 0);
    const scored = repo.weeks.reduce((sum, week): number => sum + week.scored, 0);
    lines.push(`${repo.repository} · ${merged} merged PR(s), ${scored} scored`);
    lines.push(pad("aspect", width) + repo.weeks.map((week): string => pad(week.partial ? `${week.week}*` : week.week, 10)).join("").trimEnd());
    for (const row of repo.aspects) lines.push((pad(row.aspect, width) + row.tallies.map((cell): string => pad(signed(cell.net), 10)).join("")).trimEnd());
  }
  lines.push("", "net = improves - regresses among merged PRs that recorded the aspect; · = none recorded; * = week still running");
  return lines;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** The markdown rendering for a review page: one table per repository. */
export function renderTrendMarkdown(trend: Trend): string[] {
  const lines = [`# Improvement-aspect scorecard · ${trend.weeks[0]}..${trend.weeks[trend.weeks.length - 1]}`, "", `Catalogue: \`${escapeCell(trend.catalogue.path)}\` (sha256 \`${trend.catalogue.sha256.slice(0, 12)}\`), ${trend.catalogue.aspects.length} aspects in catalogue order. Each cell is improves − regresses among the week's merged pull requests that recorded the aspect, with ⬆/➖/⬇ counts; · means none recorded it.`];
  for (const repo of trend.repositories) {
    lines.push("", `## ${repo.repository}`, "");
    if (repo.unreadable !== null) {
      lines.push(`Could not read: ${escapeCell(repo.unreadable)}`);
      continue;
    }
    lines.push(`| Aspect | ${repo.weeks.map((week): string => (week.partial ? `${week.week} (running)` : week.week)).join(" | ")} |`);
    lines.push(`|---|${repo.weeks.map((): string => "---:").join("|")}|`);
    lines.push(`| *merged / scored* | ${repo.weeks.map((week): string => `${week.merged} / ${week.scored}`).join(" | ")} |`);
    for (const row of repo.aspects) {
      lines.push(`| ${escapeCell(row.aspect)} | ${row.tallies.map((cell): string => (cell.net === null ? "·" : `**${signed(cell.net)}** (${cell.improves}/${cell.unchanged}/${cell.regresses})`)).join(" | ")} |`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------- snapshot

export interface Snapshot {
  readonly contract: typeof SCORECARD_SNAPSHOT_CONTRACT;
  readonly repository: string;
  readonly period: { readonly week: string; readonly start: string; readonly end: string };
  readonly catalogue: { readonly contract: string | null; readonly sha256: string };
  readonly merged: number;
  readonly scored: number;
  readonly pulls: readonly number[];
  /** Every catalogue aspect, in catalogue order: the recorded value is `net`. */
  readonly aspects: readonly ({ readonly aspect: string } & Tally)[];
}

/**
 * One repository's one-week score snapshot, the record the scheduled workflow
 * commits. It carries no generation time, so re-running it over the same
 * merged PRs writes the same bytes and the commit step has nothing to commit.
 */
export function snapshotOf(repo: RepoTrend, catalogue: AspectCatalogue): Snapshot {
  const week = repo.weeks[0] as WeekColumn;
  return {
    contract: SCORECARD_SNAPSHOT_CONTRACT,
    repository: repo.repository,
    period: { week: week.week, start: week.start, end: week.end },
    catalogue: { contract: catalogue.contract, sha256: catalogue.sha256 },
    merged: week.merged,
    scored: week.scored,
    pulls: week.pulls,
    aspects: repo.aspects.map((row) => ({ aspect: row.aspect, ...(row.tallies[0] as Tally) })),
  };
}
