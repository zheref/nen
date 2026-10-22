// src/spec/command.ts -- the `nen spec` family: number, check, cite-check,
// index. The first slice of the spec verbs Hatsu's capture skill
// (`dowsing-chain`, ruling HR-12) owes to nen: text-only and read-only, but for
// `index --write`, which writes one generated file and takes --dry-run.
//
// EVERY VERB REPORTS AND NONE DECIDES. `number` computes the next free
// `{nnn}` and names collisions without picking a winner; `check` lists
// findings and ranks open questions in a stated, stable order without choosing
// which to ask; `cite-check` says which ranges resolve and which read
// differently now, and rewrites none; `index` regenerates a file and refuses
// over a hand edit. "Could not read" is exit 1 on every one of them, never a
// clean report.

import { readFileSync } from "node:fs";
import { emit, parseCallerToken, refuseExtraPositionals, requireRepoFlag, requireSubcommand, requireValue, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { parseTarget, targetFromRemote, TargetError, type Target } from "../github/target.js";
import { resolveRepoRoot } from "../repo/root.js";
import { loadWorkflow } from "../schema/workflow.js";
import { checkRelativePath, parseLayout } from "./layout.js";
import { checkSpec, CONSTITUTION_PATH, parseVocabulary, renderSpecCheck, SpecReadError } from "./check.js";
import { citeCheck, parseCheckouts, renderCiteCheck } from "./citecheck.js";
import { computeNext, readBaseFolders, readPrFolders, renderSpecNumber, SPEC_NUMBER_CONTRACT, type SpecNumberReport } from "./number.js";
import { renderSpecIndex, specIndex } from "./specindex.js";

const SUBCOMMANDS = ["number", "check", "cite-check", "index"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export const DEFAULT_SPEC_LAYOUT = "specs/{nnn}-{slug}";

const USAGE = `nen spec number --repo <spec-checkout> --layout <pattern> [--base <branch>] [--target <owner/name>] [--json]
nen spec check --repo <path> (--folder <dir> | --constitution) [--vocabulary <file>] [--markers [--rank [--max <n>]]] [--json]
nen spec cite-check --repo <spec> --folder <dir> --checkouts <file> [--at <sha>|HEAD] [--verify-excerpt] [--json]
nen spec index --repo <spec> [--layout <pattern>] [--write [--dry-run]] [--json]

Read-only verbs over a Spec Kit spec repository. Each
reports and refuses; none decides. A layout is '<dir>/<final>' whose final
segment holds {nnn} and {slug} once each (Spec Kit's own: '${DEFAULT_SPEC_LAYOUT}');
'..', an absolute path or a placeholder outside the final segment is refused.

number      The next free {nnn}: the highest taken on origin/<base> (as last
            fetched; nen fetches nothing) or by an open PR's files, plus one.
            --base defaults to nen/workflow.json branch.base, else main;
            --target to the checkout's origin. Exit 1 when the base or the
            PR list could not be read, or when two folders claim one {nnn}.
check       Every FR, SC and User Story line (a constitution: every list item
            under a 'Product rules' heading) ends in
              [src: <CODE>:<path>:<l1>-<l2> @ <sha> · declared|observed|inferred]
            or exactly one of [NEEDS CLARIFICATION: …] · [NEEDS RULING] ·
            [UNVERIFIED]. Also: duplicate ids, placeholders, an inferred tier
            inside a MUST or an SC, FR<->task both ways when tasks.md exists,
            and the caller's --vocabulary terms (one per line). Fenced
            blocks are source data and never read. CRITICAL findings exit 1.
  --markers   List every open marker; --rank orders the clarifications by
              Spec Kit clarify's taxonomy (category from the section heading,
              then line); --max <n> caps the ranked list.
cite-check  Every [src:] range in the folder's .md files resolves at its own
            sha in the member checkout: CODE -> owner/name through the spec
            repository's nen/repos.json, owner/name -> path through the
            checkouts file ('<owner>/<name><TAB><absolute path>' lines), the
            path's origin read back as that slug. --verify-excerpt compares
            sha256 of lines l1..l2 (each ending in a newline) with
            capture/<CODE>/inventory.json's row when it carries one; --at
            reads the range there too and reports a differing one as a
            [STALE] candidate. Exit 1 when any citation fails to resolve or
            an excerpt hash mismatches.
index       <root>/INDEX.md from each folder's spec.md header (title, Status,
            Created, open markers). Without --write: exit 0 only when the
            file is current. --write regenerates an absent or stale file and
            refuses (exit 1) a hand-edited one; --dry-run writes nothing.

--json shapes (key order as listed):
  number:     { contract: "nen.spec.number/v0.1", repo, target, layout, base, baseSource, baseSha, openPrs, taken, collisions, next, reason }
  check:      { contract: "nen.spec.check/v0.1", repo, mode, path, files, vocabulary, requirements, markers, open, ranked, tasks, findings, counts }
  cite-check: { contract: "nen.spec.cite-check/v0.1", repo, folder, checkouts, at, verifyExcerpt, members, citations, counts }
  index:      { contract: "nen.spec.index/v0.1", repo, layout, path, rows, ignored, state, action, reason }`;

const OWNED: Readonly<Record<string, readonly Subcommand[]>> = {
  layout: ["number", "index"],
  base: ["number"],
  target: ["number"],
  folder: ["check", "cite-check"],
  vocabulary: ["check"],
  max: ["check"],
  checkouts: ["cite-check"],
  at: ["cite-check"],
};
const OWNED_BOOLEANS: Readonly<Record<string, readonly Subcommand[]>> = {
  constitution: ["check"],
  markers: ["check"],
  rank: ["check"],
  "verify-excerpt": ["cite-check"],
  write: ["index"],
  "dry-run": ["index"],
};

function refuseForeignFlags(context: CommandContext, subcommand: Subcommand): void {
  const refuse = (flag: string, owners: readonly Subcommand[]): never => {
    throw new VerbUsageError(`--${flag} is not read by 'spec ${subcommand}' (it belongs to ${owners.map((owner): string => `'spec ${owner}'`).join(", ")}). A flag accepted and ignored is worse than one refused.`);
  };
  for (const [flag, owners] of Object.entries(OWNED)) {
    if (context.args.values[flag] !== undefined && !owners.includes(subcommand)) refuse(flag, owners);
  }
  for (const [flag, owners] of Object.entries(OWNED_BOOLEANS)) {
    if (context.args.booleans.has(flag) && !owners.includes(subcommand)) refuse(flag, owners);
  }
}

function readCallerFile(flag: string, path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new VerbUsageError(`--${flag} '${path}' could not be read: ${(error as Error).message}`);
  }
}

function runNumber(context: CommandContext, repo: string): number {
  const layout = parseLayout(requireValue(context.args, "layout", "It names where feature folders live, e.g. 'specs/{nnn}-{slug}'."));
  let base = context.args.values["base"];
  let baseSource = "--base";
  if (base === undefined) {
    const workflow = loadWorkflow(repo);
    base = workflow.present ? workflow.workflow.branch.base : "main";
    baseSource = workflow.present ? "nen/workflow.json branch.base" : "default: no nen/workflow.json";
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(base) || base.startsWith("-") || base.includes("..")) throw new VerbUsageError(`--base '${base}' is not a branch name nen will put in a ref.`);
  const raw = context.args.values["target"];
  const target: Target =
    raw === undefined
      ? parseCallerToken((): Target => targetFromRemote(context.seams, repo), (error): boolean => error instanceof TargetError)
      : parseCallerToken((): Target => parseTarget(raw), (error): boolean => error instanceof TargetError);
  const onBase = readBaseFolders(context.seams, repo, layout, base);
  const onPrs = readPrFolders(context.seams, target, layout);
  const taken = [...onBase.folders, ...onPrs.folders].sort((a, b): number => a.nnn.localeCompare(b.nnn) || a.folder.localeCompare(b.folder) || (a.pr ?? 0) - (b.pr ?? 0));
  const { next, collisions, reason } = computeNext(taken);
  const report: SpecNumberReport = { contract: SPEC_NUMBER_CONTRACT, repo, target: target.slug, layout: layout.pattern, base, baseSource, baseSha: onBase.sha, openPrs: onPrs.count, taken, collisions, next, reason };
  emit(context.io, context.json, report, renderSpecNumber(report));
  return next === null || collisions.length > 0 ? 1 : 0;
}

function runCheck(context: CommandContext, repo: string): number {
  const folder = context.args.values["folder"];
  const constitution = context.args.booleans.has("constitution");
  if ((folder === undefined) === !constitution) throw new VerbUsageError("give exactly one of --folder <dir> or --constitution.");
  const markers = context.args.booleans.has("markers");
  const rank = context.args.booleans.has("rank");
  const maxRaw = context.args.values["max"];
  if (rank && !markers) throw new VerbUsageError("--rank orders the open markers, so it needs --markers.");
  if (maxRaw !== undefined && !rank) throw new VerbUsageError("--max caps the ranked list, so it needs --rank.");
  if (maxRaw !== undefined && !/^[1-9][0-9]{0,5}$/.test(maxRaw)) throw new VerbUsageError(`--max '${maxRaw}' is not a positive whole number.`);
  const vocabularyPath = context.args.values["vocabulary"];
  const vocabulary = vocabularyPath === undefined ? null : { path: vocabularyPath, terms: parseVocabulary(readCallerFile("vocabulary", vocabularyPath)) };
  try {
    const report = checkSpec({
      repo,
      mode: folder === undefined ? "constitution" : "folder",
      path: folder === undefined ? CONSTITUTION_PATH : checkRelativePath("folder", folder),
      vocabulary,
      markers,
      rank,
      max: maxRaw === undefined ? null : Number(maxRaw),
    });
    emit(context.io, context.json, report, renderSpecCheck(report));
    return report.counts.CRITICAL > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof SpecReadError) throw new Error(error.message);
    throw error;
  }
}

function runCiteCheck(context: CommandContext, repo: string): number {
  const folder = checkRelativePath("folder", requireValue(context.args, "folder", "It names the spec folder whose citations are resolved."));
  const checkoutsFile = requireValue(context.args, "checkouts", "It maps each member's owner/name to its checkout, one tab-separated line each.");
  const at = context.args.values["at"] ?? null;
  if (at !== null && at !== "HEAD" && !/^[0-9a-f]{7,40}$/.test(at)) throw new VerbUsageError(`--at '${at}' is neither HEAD nor a 7-40 character hex sha.`);
  const checkouts = parseCheckouts(readCallerFile("checkouts", checkoutsFile), checkoutsFile);
  const report = citeCheck(context.seams, { repo, folder, checkoutsFile, checkouts, at, verifyExcerpt: context.args.booleans.has("verify-excerpt") });
  emit(context.io, context.json, report, renderCiteCheck(report));
  const memberGap = at !== null && report.members.some((member): boolean => member.reason !== null);
  return report.counts.failing > 0 || report.counts.excerptMismatch > 0 || memberGap ? 1 : 0;
}

function runIndex(context: CommandContext, repo: string): number {
  const layout = parseLayout(context.args.values["layout"] ?? DEFAULT_SPEC_LAYOUT);
  const write = context.args.booleans.has("write");
  const dryRun = context.args.booleans.has("dry-run");
  if (dryRun && !write) throw new VerbUsageError("--dry-run qualifies --write; without --write nothing is written anyway.");
  const report = specIndex(repo, layout, { write, dryRun });
  emit(context.io, context.json, report, renderSpecIndex(report));
  if (report.rows.some((row): boolean => row.error !== null)) return 1;
  if (write) return report.action === "refused" ? 1 : 0;
  return report.state === "current" ? 0 : 1;
}

export const specCommand: Command = {
  name: "spec",
  summary: "Number, check, cite-check and index a Spec Kit spec repository's folders (read-only).",
  usage: USAGE,
  subcommands: [...SUBCOMMANDS],
  flags: {
    values: ["layout", "base", "target", "folder", "vocabulary", "max", "checkouts", "at"],
    booleans: ["constitution", "markers", "rank", "verify-excerpt", "write", "dry-run"],
  },
  run(context): number {
    const subcommand = requireSubcommand("spec", context.args, SUBCOMMANDS) as Subcommand;
    refuseExtraPositionals(context.args, 2);
    refuseForeignFlags(context, subcommand);
    const repo = resolveRepoRoot({ repoFlag: requireRepoFlag(context, "It names the spec repository's checkout.") });
    switch (subcommand) {
      case "number":
        return runNumber(context, repo);
      case "check":
        return runCheck(context, repo);
      case "cite-check":
        return runCiteCheck(context, repo);
      case "index":
        return runIndex(context, repo);
    }
  },
};
