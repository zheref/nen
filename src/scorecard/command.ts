// src/scorecard/command.ts -- the `scorecard` family (zheref/hatsu#619):
// `nen scorecard trend` and `nen scorecard snapshot`.
//
// READ-ONLY ON GITHUB. The only call either verb makes is `gh pr list --state
// merged`: the merged pull requests it scores are read, never commented on,
// labelled or edited (zheref/nen#669/AC-1). `snapshot`'s one write is a local file under
// --out, which the caller's scheduled workflow commits.
//
// THE ASPECT CATALOGUE IS READ AT RUN TIME from the file --catalogue names
// (Hatsu's contracts/pr-sections.json). Nothing about it is compiled in, so
// nen carries no build-time dependency on the Hatsu contract (zheref/nen#669/AC-3).

import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { emit, parseCallerToken, readInteger, refuseExtraPositionals, requireSubcommand, requireValue, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { commaList } from "../cli/comma.js";
import { resolveAgainstRepo } from "../cli/inputs.js";
import { plainLine } from "../cli/plain.js";
import { parseTarget, TargetError, type Target } from "../github/target.js";
import { resolveRepoRoot } from "../repo/root.js";
import { realContainment } from "../repo/contain.js";
import { SchemaError } from "../schema/errors.js";
import type { Seams } from "../seam/exec.js";
import {
  buildTrend,
  currentWeek,
  lastCompletedWeek,
  parseAspectCatalogue,
  parseWeek,
  renderTrend,
  renderTrendMarkdown,
  repoTrend,
  SCORECARD_SNAPSHOT_CONTRACT,
  SCORECARD_TREND_CONTRACT,
  snapshotOf,
  weeksThrough,
  type AspectCatalogue,
  type MergedPull,
  type Week,
} from "./scorecard.js";

const SUBCOMMANDS = ["trend", "snapshot"] as const;
/** gh pr list's page ceiling: a week that fills it is refused, never silently cut. */
export const PULL_LIMIT = 1000;

const USAGE = `nen scorecard trend --catalogue <pr-sections.json> --target <owner/name>[,<owner/name>...]
                    [--weeks <n>] [--through <YYYY-Www> | --through current]
                    [--markdown] [--repo <path>] [--json]
nen scorecard snapshot --catalogue <pr-sections.json> --target <owner/name>
                       --out <dir> [--through <YYYY-Www>] [--repo <path>] [--json]

Read-only over GitHub. Scores each repository's MERGED pull requests on the
improvement aspects a section catalogue declares, per ISO week (Monday 00:00
UTC to the next Monday), in the catalogue's own order.

--catalogue names the catalogue file, read at run time; its top-level
'aspects' array is the list and the order.
No aspect is compiled into nen. A relative path resolves against --repo.

A pull request scores an aspect through the FIRST markdown table row whose
first cell is that aspect (case-insensitive) and whose second cell is a delta:
⬆ (or 'improves') +1, ➖ (or 'unchanged') 0, ⬇ (or 'regresses') -1. Rows in
fenced code or HTML comments are not rows. A named row with no glyph is
unreadable; an aspect with no row is absent; both count as 'unrecorded'.

Each cell carries improves, unchanged, regresses, unrecorded and net
(improves - regresses), net null when no merged PR of the week recorded the
aspect. Every catalogue aspect appears in every repository, recorded or not.

  trend      --weeks weeks (default 4) ending with --through (default: the
             last completed week; 'current' takes the running one, marked
             partial). One 'gh pr list' per --target. --markdown prints a
             review page, one table per repository, instead of the plain
             rendering.
  snapshot   one completed week for ONE --target, written to
             <out>/<YYYY-Www>.json (--out resolves against --repo and must
             stay inside it, symlinks resolved; the file is never written
             through a symlink, and is replaced by temp file and rename).
             The file carries no generation time: re-running over unchanged
             pull requests and an unchanged catalogue file (its sha256, CRLF
             read as LF, is recorded) writes the same bytes. A running week
             is refused.

The only GitHub call is 'gh pr list --repo <target> --state merged --search
"merged:<from>..<to>" --json number,title,url,mergedAt,body --limit ${PULL_LIMIT}';
no pull request is written to. A repository whose read fails, or whose window
fills the limit, is could-not-read with the reason, never an empty row.

Exits: 0 every repository read (snapshot: written or unchanged); 1 a
repository could not be read, or snapshot's file could not be read or
written, nothing written for it; 2 usage (a missing flag, a malformed week,
target or catalogue, a trend week not started yet, an --out outside --repo).

--json shapes (key order as listed):
  trend:    { contract: "${SCORECARD_TREND_CONTRACT}", catalogue: { path, contract,
              sha256, aspects }, weeks, repositories: [{ repository, unreadable,
              weeks: [{ week, start, end, partial, merged, scored, pulls }],
              aspects: [{ aspect, tallies: [{ improves, unchanged, regresses,
              unrecorded, net }] }] }] }
  snapshot: { path, written, reason, snapshot: { contract: "${SCORECARD_SNAPSHOT_CONTRACT}",
              repository, period: { week, start, end }, catalogue: { contract,
              sha256 }, merged, scored, pulls, aspects: [{ aspect, improves,
              unchanged, regresses, unrecorded, net }] } }
            written: created | updated | unchanged | null (could not read;
            snapshot null, reason says why)`;

function day(iso: string, offsetDays: number): string {
  return new Date(Date.parse(iso) + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** The gh argv that lists one repository's merged PRs over `weeks`, a day wider each side. */
export function mergedPullsArgv(target: string, weeks: readonly Week[]): string[] {
  const from = day((weeks[0] as Week).start, -1);
  const to = day((weeks[weeks.length - 1] as Week).end, 0);
  return ["pr", "list", "--repo", target, "--state", "merged", "--search", `merged:${from}..${to}`, "--json", "number,title,url,mergedAt,body", "--limit", String(PULL_LIMIT)];
}

function isPull(value: unknown): value is MergedPull {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.number) && typeof row.mergedAt === "string" && !Number.isNaN(Date.parse(row.mergedAt)) && (typeof row.body === "string" || row.body === null);
}

/** The first line of a tool's stderr, control characters stripped and capped, for a reason. */
function firstLine(text: string): string {
  const line = plainLine(text.trim().split("\n")[0] ?? "");
  return line.length > STDERR_CAP ? `${line.slice(0, STDERR_CAP)}…` : line;
}

const STDERR_CAP = 200;

/** One repository's merged PRs, or why they could not be read. */
export function fetchMergedPulls(seams: Seams, target: string, weeks: readonly Week[]): MergedPull[] | { reason: string } {
  const result = seams.run("gh", mergedPullsArgv(target, weeks));
  if (result.spawnFailed) {
    if (/ENOBUFS/.test(result.stderr)) return { reason: "gh pr list answered more than nen buffers; narrow --weeks" };
    return { reason: `'gh' could not be started (${firstLine(result.stderr) || "no reason given"}): install the GitHub CLI and run 'gh auth login'` };
  }
  if (result.code !== 0) return { reason: `gh pr list exited ${result.code}: ${firstLine(result.stderr) || "no output"}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { reason: "gh pr list answered something that is not JSON" };
  }
  if (!Array.isArray(parsed) || !parsed.every(isPull)) return { reason: "gh pr list answered rows without a number, a mergedAt time or a body" };
  if (parsed.length >= PULL_LIMIT) return { reason: `the window holds ${PULL_LIMIT} or more merged PRs, gh pr list's ceiling; narrow --weeks` };
  return parsed.map((row): MergedPull => ({ number: row.number, title: typeof row.title === "string" ? row.title : "", url: typeof row.url === "string" ? row.url : "", mergedAt: row.mergedAt, body: row.body ?? "" }));
}

function readCatalogue(root: string, path: string): AspectCatalogue {
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolveAgainstRepo(root, path));
  } catch (error) {
    throw new VerbUsageError(`--catalogue '${path}' could not be read (${(error as NodeJS.ErrnoException).code ?? String(error)}); it names the section catalogue whose 'aspects' are scored.`);
  }
  try {
    return parseAspectCatalogue(path, bytes);
  } catch (error) {
    if (error instanceof SchemaError) throw new VerbUsageError(plainLine(error.message));
    throw error;
  }
}

function targets(context: CommandContext): Target[] {
  const list = commaList(requireValue(context.args, "target", "It names the repositories whose merged pull requests are scored, as owner/name."));
  if (list.length === 0) throw new VerbUsageError("--target names no repository.");
  const parsed = list.map((value): Target => parseCallerToken((): Target => parseTarget(value), (error): boolean => error instanceof TargetError));
  const slugs = parsed.map((target): string => target.slug.toLowerCase());
  if (new Set(slugs).size !== slugs.length) throw new VerbUsageError("--target names a repository twice.");
  return parsed;
}

function throughWeek(context: CommandContext, allowCurrent: boolean): Week {
  const value = context.args.values["through"];
  const now = context.seams.now();
  if (value === undefined) return lastCompletedWeek(now);
  if (value === "current") {
    if (!allowCurrent) throw new VerbUsageError("scorecard snapshot records a completed week only; --through current is trend's.");
    return currentWeek(now);
  }
  const week = parseWeek(value);
  if (week === null) throw new VerbUsageError(`--through '${value}' is not an ISO week; write YYYY-Www (2026-W47)${allowCurrent ? " or 'current'" : ""}.`);
  if (!allowCurrent && Date.parse(week.end) > now.getTime()) throw new VerbUsageError(`--through ${value} has not ended yet; a snapshot records a completed week only.`);
  if (allowCurrent && Date.parse(week.start) > now.getTime()) throw new VerbUsageError(`--through ${value} has not started yet; name a week up to the running one, or 'current'.`);
  return week;
}

function runTrend(context: CommandContext): number {
  refuseExtraPositionals(context.args, 2);
  if (context.args.values["out"] !== undefined) throw new VerbUsageError("scorecard trend writes nothing; --out is snapshot's.");
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const path = requireValue(context.args, "catalogue", "It names the section catalogue whose 'aspects' are scored.");
  const catalogue = readCatalogue(root, path);
  const repos = targets(context);
  const count = readInteger(context.args, "weeks", 4);
  if (count < 1 || count > 52) throw new VerbUsageError(`--weeks takes 1 to 52, got ${count}.`);
  const weeks = weeksThrough(throughWeek(context, true), count);
  const now = context.seams.now();
  const trend = buildTrend(path, catalogue, weeks, repos.map((target) => repoTrend(target.slug, catalogue.aspects, weeks, now, fetchMergedPulls(context.seams, target.slug, weeks))));
  const lines = context.args.booleans.has("markdown") ? renderTrendMarkdown(trend) : renderTrend(trend);
  emit(context.io, context.json, trend, lines.map(plainLine));
  return trend.repositories.every((repo): boolean => repo.unreadable === null) ? 0 : 1;
}

/**
 * `<out>/<week>.json`, refused at exit 2 unless the path the kernel would write
 * stays inside --repo, symbolic links resolved (zheref/nen#669 review), and
 * unless the file itself is not a symbolic link.
 */
function snapshotPath(root: string, out: string, weekId: string): string {
  const lexical = join(resolveAgainstRepo(root, out), `${weekId}.json`);
  const containment = realContainment(root, lexical);
  if (!containment.contained) {
    const via = containment.link === null ? "" : ` '${containment.link}' is a symlink to '${containment.target ?? "somewhere else"}'.`;
    throw new VerbUsageError(`--out '${out}' resolves outside the repository at ${root}.${via} A snapshot is written inside the checkout the workflow commits; point --out under it.`);
  }
  let link = false;
  try {
    link = lstatSync(lexical).isSymbolicLink();
  } catch {
    // Absent: created below.
  }
  if (link) throw new VerbUsageError(`--out: '${lexical}' is a symbolic link; a snapshot is never written through one.`);
  return lexical;
}

/** Writes `text` to `file` by temp file and rename, unless the file already holds it (CRLF read as LF). */
function writeSnapshot(file: string, text: string): { written: "created" | "updated" | "unchanged" } | { reason: string } {
  const code = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? String(error);
  let previous: string | null = null;
  try {
    previous = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  } catch (error) {
    if (code(error) !== "ENOENT") return { reason: `the existing snapshot could not be read (${code(error)})` };
  }
  if (previous === text) return { written: "unchanged" };
  const temp = join(dirname(file), `.${basename(file)}.nen-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const fd = openSync(temp, "wx", 0o644);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    return { reason: `the snapshot could not be written (${code(error)})` };
  }
  return { written: previous === null ? "created" : "updated" };
}

function runSnapshot(context: CommandContext): number {
  refuseExtraPositionals(context.args, 2);
  for (const flag of ["weeks"]) if (context.args.values[flag] !== undefined) throw new VerbUsageError(`scorecard snapshot records one week; --${flag} is trend's.`);
  if (context.args.booleans.has("markdown")) throw new VerbUsageError("scorecard snapshot writes JSON; --markdown is trend's.");
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const path = requireValue(context.args, "catalogue", "It names the section catalogue whose 'aspects' are scored.");
  const catalogue = readCatalogue(root, path);
  const repos = targets(context);
  if (repos.length !== 1) throw new VerbUsageError("scorecard snapshot records ONE repository; give one --target (the repository the workflow commits into).");
  const out = requireValue(context.args, "out", "It names the directory the snapshot is written under, inside the consumer's checkout.");
  const week = throughWeek(context, false);
  const target = repos[0] as Target;
  const file = snapshotPath(root, out, week.id);
  const repo = repoTrend(target.slug, catalogue.aspects, [week], context.seams.now(), fetchMergedPulls(context.seams, target.slug, [week]));
  if (repo.unreadable !== null) {
    emit(context.io, context.json, { path: file, written: null, reason: repo.unreadable, snapshot: null }, [plainLine(`${target.slug} · could-not-read: ${repo.unreadable}; nothing written`)]);
    return 1;
  }
  const snapshot = snapshotOf(repo, catalogue);
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  const outcome = writeSnapshot(file, text);
  if ("reason" in outcome) {
    emit(context.io, context.json, { path: file, written: null, reason: outcome.reason, snapshot: null }, [plainLine(`${target.slug} · could-not-write: ${outcome.reason}; nothing written`)]);
    return 1;
  }
  const written = outcome.written;
  emit(context.io, context.json, { path: file, written, reason: null, snapshot }, [
    plainLine(`${target.slug} · ${week.id} · ${snapshot.merged} merged PR(s), ${snapshot.scored} scored · ${written}: ${file}`),
    ...snapshot.aspects.map((row): string => plainLine(`  ${row.aspect}: net ${row.net === null ? "·" : row.net} (⬆${row.improves} ➖${row.unchanged} ⬇${row.regresses}, ${row.unrecorded} unrecorded)`)),
  ]);
  return 0;
}

export const scorecardCommand: Command = {
  name: "scorecard",
  subcommands: SUBCOMMANDS,
  summary: "Score merged pull requests on a caller catalogue's improvement aspects, per repository per ISO week.",
  usage: USAGE,
  flags: {
    values: ["catalogue", "target", "weeks", "through", "out"],
    booleans: ["markdown"],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("scorecard", context.args, SUBCOMMANDS);
    if (subcommand === "trend") return runTrend(context);
    if (subcommand === "snapshot") return runSnapshot(context);
    throw new VerbUsageError(`'scorecard ${subcommand}' is not a verb. Try: scorecard trend, scorecard snapshot.`);
  },
};
