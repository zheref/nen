// src/spec/command.ts -- the `nen spec` family: number, check, cite-check,
// index (the first slice), then inventory, diff, converge and coverage
// (zheref/nen#493 waves A and C). The verbs Hatsu's capture skill
// (`dowsing-chain`, ruling HR-12) owes to nen: read-only, but for `index
// --write`, `converge --write` (each behind --dry-run) and `inventory --out`.
//
// EVERY VERB REPORTS AND NONE DECIDES. `number` computes the next free
// `{nnn}` and names collisions without picking a winner; `check` lists
// findings and ranks open questions in a stated, stable order without choosing
// which to ask; `cite-check` says which ranges resolve and which read
// differently now, and rewrites none; `index` regenerates a file and refuses
// over a hand edit. "Could not read" is exit 1 on every one of them, never a
// clean report.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { emit, parseCallerToken, refuseExtraPositionals, requireRepoFlag, requireSubcommand, requireValue, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { parseTarget, targetFromRemote, TargetError, type Target } from "../github/target.js";
import { resolveRepoRoot } from "../repo/root.js";
import { loadWorkflow } from "../schema/workflow.js";
import { checkRelativePath, parseLayout } from "./layout.js";
import { checkSpec, CONSTITUTION_PATH, parseVocabulary, renderSpecCheck, SpecContainmentError, SpecReadError } from "./check.js";
import { citeCheck, parseCheckouts, renderCiteCheck } from "./citecheck.js";
import { computeNext, readBaseFolders, readPrFolders, renderSpecNumber, SPEC_NUMBER_CONTRACT, type SpecNumberReport } from "./number.js";
import { renderSpecIndex, specIndex } from "./specindex.js";
import { loadRepoRegistry, type RepoRegistry } from "../schema/repos.js";
import { parseContract } from "../schema/contract.js";
import { couldNotRead, GOVERNED_SCENARIOS, inventory, renderInventory, scenarioReader, type InventoryReport } from "./inventory.js";
import { diffInventories, InventoryReadError, loadInventory, renderDiff, unreadableDiff, type SpecDiffReport } from "./diff.js";
import { converge, renderConverge } from "./converge.js";
import { captureCoverage, deliveryCoverage, readReport, renderCaptureCoverage, renderDeliveryCoverage, unreadableDelivery } from "./coverage.js";
import { readTree, TreeReadError } from "./tree.js";

const SUBCOMMANDS = ["number", "check", "cite-check", "index", "inventory", "diff", "converge", "coverage"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export const DEFAULT_SPEC_LAYOUT = "specs/{nnn}-{slug}";

const USAGE = `nen spec number --repo <spec-checkout> --layout <pattern> [--base <branch>] [--target <owner/name>] [--json]
nen spec check --repo <path> (--folder <dir> | --constitution) [--vocabulary <file>] [--markers [--rank [--max <n>]]] [--json]
nen spec cite-check --repo <spec> --folder <dir> --checkouts <file> [--at <sha>|HEAD] [--verify-excerpt] [--json]
nen spec index --repo <spec> [--layout <pattern>] [--write [--dry-run]] [--json]
nen spec inventory --repo <member> --scenario <id> [--lane <lane>] [--at <ref>] [--exclude <glob>[,<glob>...]] [--out <file>] [--json]
nen spec diff --from <inventory> --to <inventory> [--json]
nen spec converge --repo <spec> --folder <dir> --inventory <file> --code <CODE> --checkouts <file> [--date <YYYY-MM-DD>] [--write [--dry-run]] [--json]
nen spec coverage --repo <spec> --inventory <file>[,<file>...] [--layout <pattern>] [--json]
nen spec coverage --issue-body <file> --pr-body <file> [--test-report <file>] [--json]

Read-only verbs over a Spec Kit spec repository. Each
reports and refuses; none decides. A layout is '<dir>/<final>' whose final
segment holds {nnn} and {slug} once each (Spec Kit's own: '${DEFAULT_SPEC_LAYOUT}');
'..', an absolute path or a placeholder outside the final segment is refused.

number      The next free {nnn}: the highest taken on origin/<base> (as last
            fetched; nen fetches nothing) or by an open PR's files, plus one.
            --base defaults to nen/workflow.json branch.base, else main;
            --target to the checkout's origin. Exit 1 when the base or the
            PR list could not be read, or when two folders claim one {nnn}.
check       Every FR, SC and story line (User Story n or US-n; a
            constitution: every list item under a 'Product rules' heading)
            ends in
              [src: <CODE>:<path>:<l1>-<l2> @ <sha> · declared|observed|inferred]
            or exactly one of [NEEDS CLARIFICATION: …] · [NEEDS RULING] ·
            [UNVERIFIED], or the closing [ruled: CL-nnn]; a trailing
            [STALE @ <sha>] beside a citation is counted stale. Also: duplicate
            ids, placeholders, an inferred tier inside a MUST or an SC,
            FR<->task both ways when tasks.md exists, the caller's
            --vocabulary terms (one per line), a spec.md holding no line at
            all, and an unclosed fence. Fenced blocks are source data and
            never read. CRITICAL findings exit 1; a spec file that resolves
            outside --repo exits 2.
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

inventory   One row per owned file fact of a member checkout at --at (default
            HEAD), read through git, never the work tree: the file set is the
            build system's own (xcode: the project's target build phases and
            synchronized groups; gradle: settings' include list and each
            module's source sets; tsconfig: files/include/exclude, extends and
            references), the suffix -> kind -> rule id table the scenario's
            stack handbook appendix (${GOVERNED_SCENARIOS.join(", ")}).
            Rows {id, kind, path, lines, sha, excerptSha256, tier, ruleId}; no
            excerpts. --lane reads the lane's cwd from nen/contract.json at
            that commit. --out writes the same JSON document to a file.
            Exit 1 when partial (a declaration nen could not read) or nothing
            could be read.
diff        Added, removed and changed rows by stable id between two
            inventories of one member; a different sha alone is no change.
            Exit 0 identical or differing; 1 when an inventory could not be
            read; 2 when the two name different members.
converge    A folder's citations of one member (--code) re-read at the
            inventory's sha in the checkout the checkouts file names: gaps
            missing · partial · contradicts · unrequested (the last against
            capture/<CODE>/inventory.json). A ticked task is a claim, never
            evidence. --write APPENDS ONLY: [STALE @ <sha>] beside a moved,
            changed or vanished citation, and one '## Phase N: Convergence
            <date> @ <sha12>' to tasks.md; a second run changes nothing.
            Exit 1 on any gap or when the inputs could not be read.
coverage    Capture form: per member and row kind, covered/total (a row is
            covered when one of the member's citations overlaps it), plus
            requirement<->task/test traceability both ways, each with its
            denominator. Delivery form: every F<nnn>-SC-### of the issue body
            has one '## Spec' row in the PR body -- '— satisfied — test <id>'
            (in --test-report and passing, when given) or '— deferred —
            <reason> · <follow-up>'. Exit 1 on an unaccounted criterion, a
            missing or empty section, or an unreadable input; 2 when the PR
            names an id the issue does not carry.

--json shapes (key order as listed):
  number:     { contract: "nen.spec.number/v0.1", repo, target, layout, base, baseSource, baseSha, openPrs, taken, collisions, next, reason }
  check:      { contract: "nen.spec.check/v0.1", repo, mode, path, files, vocabulary, requirements, markers, open, ranked, tasks, findings, counts }
  cite-check: { contract: "nen.spec.cite-check/v0.1", repo, folder, checkouts, at, verifyExcerpt, members, citations, counts }
  index:      { contract: "nen.spec.index/v0.1", repo, layout, path, rows, ignored, state, action, reason }
  inventory:  { contract: "nen.spec.inventory/v0.1", verdict, repo, origin, lane, cwd, scenario, handbook, sha, membership, excluded, rows, totals, unread, reason }
  diff:       { contract: "nen.spec.diff/v0.1", verdict, from, to, origin, added, removed, changed, counts, reason }
  converge:   { contract: "nen.spec.converge/v0.1", verdict, repo, folder, inventory, member, citations, gaps, unrequested, unrequestedReason, claims, writes, action, counts, reason }
  coverage:   { contract: "nen.spec.coverage/v0.1", form: "capture", verdict, repo, layout, folders, members, markers, reason }
              { contract: "nen.spec.coverage/v0.1", form: "delivery", verdict, issueBody, prBody, testReport, section, criteria, outside, counts, reason }`;

const OWNED: Readonly<Record<string, readonly Subcommand[]>> = {
  layout: ["number", "index", "coverage"],
  base: ["number"],
  target: ["number"],
  folder: ["check", "cite-check", "converge"],
  vocabulary: ["check"],
  max: ["check"],
  checkouts: ["cite-check", "converge"],
  at: ["cite-check", "inventory"],
  scenario: ["inventory"],
  lane: ["inventory"],
  exclude: ["inventory"],
  out: ["inventory"],
  from: ["diff"],
  to: ["diff"],
  inventory: ["converge", "coverage"],
  code: ["converge"],
  date: ["converge"],
  "issue-body": ["coverage"],
  "pr-body": ["coverage"],
  "test-report": ["coverage"],
};
const OWNED_BOOLEANS: Readonly<Record<string, readonly Subcommand[]>> = {
  constitution: ["check"],
  markers: ["check"],
  rank: ["check"],
  "verify-excerpt": ["cite-check"],
  write: ["index", "converge"],
  "dry-run": ["index", "converge"],
};
/** The verbs that read no spec or member checkout, and so take no --repo. */
const REPOLESS: readonly Subcommand[] = ["diff"];

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
    if (error instanceof SpecContainmentError) throw new VerbUsageError(error.message);
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
  let report;
  try {
    report = specIndex(repo, layout, { write, dryRun });
  } catch (error) {
    if (error instanceof SpecContainmentError) throw new VerbUsageError(error.message);
    throw error;
  }
  emit(context.io, context.json, report, renderSpecIndex(report));
  if (report.rows.some((row): boolean => row.error !== null)) return 1;
  if (write) return report.action === "refused" ? 1 : 0;
  return report.state === "current" ? 0 : 1;
}

const LANE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function runInventory(context: CommandContext, repo: string): number {
  const scenario = requireValue(context.args, "scenario", `It names the member's governed scenario: ${GOVERNED_SCENARIOS.join(", ")}.`);
  const reader = scenarioReader(scenario);
  if (reader === null) throw new VerbUsageError(`--scenario '${scenario}' has no capture reader; the governed scenarios are ${GOVERNED_SCENARIOS.join(", ")} (each stack handbook's capture-reader appendix).`);
  const lane = context.args.values["lane"] ?? null;
  if (lane !== null && !LANE_NAME.test(lane)) throw new VerbUsageError(`--lane '${lane}' is not a lane name.`);
  const at = context.args.values["at"] ?? "HEAD";
  if (at !== "HEAD" && !/^[0-9a-f]{7,40}$/.test(at)) throw new VerbUsageError(`--at '${at}' is neither HEAD nor a 7-40 character hex sha.`);
  const exclude = (context.args.values["exclude"] ?? "").split(",").map((entry): string => entry.trim()).filter((entry): boolean => entry !== "");
  for (const pattern of exclude) checkRelativePath("exclude", pattern.replace(/\*/g, "x"));
  const out = context.args.values["out"] ?? null;
  let origin: string | null = null;
  try {
    origin = targetFromRemote(context.seams, repo).slug;
  } catch {
    origin = null;
  }
  const finish = (report: InventoryReport): number => {
    if (out !== null && report.verdict !== "could-not-read") writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
    emit(context.io, context.json, report, [...renderInventory(report), ...(out !== null && report.verdict !== "could-not-read" ? [`  wrote ${out}`] : [])]);
    return report.verdict === "read" ? 0 : 1;
  };
  const input = { repo, origin, lane, cwd: "", scenario, exclude };
  let tree;
  try {
    tree = readTree(context.seams, repo, at);
  } catch (error) {
    if (error instanceof TreeReadError) return finish(couldNotRead(input, reader, error.message));
    throw error;
  }
  let cwd = "";
  if (lane !== null) {
    const text = tree.read("nen/contract.json");
    if (text === null) return finish(couldNotRead(input, reader, `--lane ${lane}: nen/contract.json is not in the tree at ${tree.sha.slice(0, 12)}`));
    try {
      const contract = parseContract("nen/contract.json", "nen", JSON.parse(text) as unknown);
      const declared = contract.project?.lanes[lane];
      if (declared === undefined) return finish(couldNotRead(input, reader, `--lane ${lane} is not a lane of nen/contract.json's project block at ${tree.sha.slice(0, 12)} (declared: ${Object.keys(contract.project?.lanes ?? {}).join(", ") || "none"})`));
      cwd = declared.cwd === "." ? "" : declared.cwd.replace(/^\.\//, "").replace(/\/+$/, "");
    } catch (error) {
      return finish(couldNotRead(input, reader, `nen/contract.json at ${tree.sha.slice(0, 12)} could not be read: ${(error as Error).message}`));
    }
  }
  return finish(inventory(tree, { ...input, cwd }, reader));
}

function runDiff(context: CommandContext): number {
  const from = requireValue(context.args, "from", "It names the earlier inventory file.");
  const to = requireValue(context.args, "to", "It names the later inventory file.");
  let report: SpecDiffReport;
  try {
    const before = loadInventory(from);
    const after = loadInventory(to);
    if (before.origin !== null && after.origin !== null && before.origin !== after.origin) throw new VerbUsageError(`--from is an inventory of ${before.origin} and --to of ${after.origin}; a diff compares two inventories of one member.`);
    report = diffInventories(before, after);
  } catch (error) {
    if (!(error instanceof InventoryReadError)) throw error;
    report = unreadableDiff(from, to, error.message);
  }
  emit(context.io, context.json, report, renderDiff(report));
  return report.verdict === "could-not-read" ? 1 : 0;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function runConverge(context: CommandContext, repo: string): number {
  const folder = checkRelativePath("folder", requireValue(context.args, "folder", "It names the merged spec folder to converge."));
  const inventoryFile = requireValue(context.args, "inventory", "It names the newer inventory of one member (nen spec inventory --out).");
  const code = requireValue(context.args, "code", "It names the member's product code, as the folder's citations spell it.");
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(code)) throw new VerbUsageError(`--code '${code}' is not a product code ([A-Z][A-Z0-9]{1,7}).`);
  const checkoutsFile = requireValue(context.args, "checkouts", "It maps the member's owner/name to its checkout, one tab-separated line each.");
  const write = context.args.booleans.has("write");
  const dryRun = context.args.booleans.has("dry-run");
  if (dryRun && !write) throw new VerbUsageError("--dry-run qualifies --write; without --write nothing is written anyway.");
  const date = context.args.values["date"] ?? context.seams.now().toISOString().slice(0, 10);
  if (!DATE.test(date)) throw new VerbUsageError(`--date '${date}' is not YYYY-MM-DD.`);
  const checkouts = parseCheckouts(readCallerFile("checkouts", checkoutsFile), checkoutsFile);
  let report;
  try {
    report = converge(context.seams, { repo, folder, inventoryFile, code, checkoutsFile, checkouts, date, write, dryRun });
  } catch (error) {
    if (error instanceof SpecContainmentError) throw new VerbUsageError(error.message);
    throw error;
  }
  emit(context.io, context.json, report, renderConverge(report));
  return report.verdict === "converged" ? 0 : 1;
}

function runCoverage(context: CommandContext): number {
  const issueBody = context.args.values["issue-body"];
  const prBody = context.args.values["pr-body"];
  const testReport = context.args.values["test-report"] ?? null;
  const inventories = context.args.values["inventory"];
  const delivery = issueBody !== undefined || prBody !== undefined || testReport !== null;
  if (delivery) {
    if (inventories !== undefined || context.args.values["layout"] !== undefined || context.repoFlag !== null) throw new VerbUsageError("give the capture form (--repo, --inventory, --layout) or the delivery form (--issue-body, --pr-body, --test-report), never both.");
    if (issueBody === undefined || prBody === undefined) throw new VerbUsageError("the delivery form needs both --issue-body <file> and --pr-body <file>.");
    const names = { issueBodyFile: issueBody, prBodyFile: prBody, testReportFile: testReport };
    const read = (path: string): string | null => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    };
    const issueText = read(issueBody);
    const prText = read(prBody);
    let report;
    if (issueText === null || prText === null) report = unreadableDelivery(names, `${issueText === null ? issueBody : prBody} could not be read`);
    else {
      const parsed = testReport === null ? { report: null, reason: null } : readReport(resolve(testReport), testReport);
      report = parsed.reason !== null ? unreadableDelivery(names, parsed.reason) : deliveryCoverage({ ...names, issueBody: issueText, prBody: prText, testReport: parsed.report });
    }
    emit(context.io, context.json, report, renderDeliveryCoverage(report));
    if (report.outside.length > 0) return 2;
    return report.verdict === "accounted" ? 0 : 1;
  }
  const repo = resolveRepoRoot({ repoFlag: requireRepoFlag(context, "It names the spec repository's checkout (or give the delivery form's --issue-body and --pr-body).") });
  const list = requireValue(context.args, "inventory", "It names one inventory file per member, comma-separated.").split(",").map((entry): string => entry.trim()).filter((entry): boolean => entry !== "");
  if (list.length === 0) throw new VerbUsageError("--inventory names no file.");
  const layout = parseLayout(context.args.values["layout"] ?? DEFAULT_SPEC_LAYOUT);
  let registry: RepoRegistry | null = null;
  let registryError: string | null = null;
  try {
    registry = loadRepoRegistry(repo);
  } catch (error) {
    registryError = `the spec repository's nen/repos.json could not be read: ${(error as Error).message}`;
  }
  let report;
  try {
    report = captureCoverage(repo, layout, registry, registryError, list);
  } catch (error) {
    if (error instanceof SpecContainmentError) throw new VerbUsageError(error.message);
    throw error;
  }
  emit(context.io, context.json, report, renderCaptureCoverage(report));
  return report.verdict === "measured" ? 0 : 1;
}

export const specCommand: Command = {
  name: "spec",
  summary: "Inventory, number, check, cite-check, diff, converge, cover and index a product family's Spec Kit spec repository.",
  usage: USAGE,
  subcommands: [...SUBCOMMANDS],
  flags: {
    values: ["layout", "base", "target", "folder", "vocabulary", "max", "checkouts", "at", "scenario", "lane", "exclude", "out", "from", "to", "inventory", "code", "date", "issue-body", "pr-body", "test-report"],
    booleans: ["constitution", "markers", "rank", "verify-excerpt", "write", "dry-run"],
  },
  run(context): number {
    const subcommand = requireSubcommand("spec", context.args, SUBCOMMANDS) as Subcommand;
    refuseExtraPositionals(context.args, 2);
    refuseForeignFlags(context, subcommand);
    if (REPOLESS.includes(subcommand)) {
      if (context.repoFlag !== null) throw new VerbUsageError(`'spec ${subcommand}' reads no checkout, so it takes no --repo.`);
      return runDiff(context);
    }
    if (subcommand === "coverage") return runCoverage(context);
    const repo = resolveRepoRoot({ repoFlag: requireRepoFlag(context, subcommand === "inventory" ? "It names the member's checkout." : "It names the spec repository's checkout.") });
    switch (subcommand) {
      case "number":
        return runNumber(context, repo);
      case "check":
        return runCheck(context, repo);
      case "cite-check":
        return runCiteCheck(context, repo);
      case "index":
        return runIndex(context, repo);
      case "inventory":
        return runInventory(context, repo);
      case "converge":
        return runConverge(context, repo);
    }
    throw new VerbUsageError(`'spec ${subcommand}' is not dispatched here.`);
  },
};
