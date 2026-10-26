// src/run/command.ts -- the `run` family: `nen run rerun-failed` (a workflow
// run's failed jobs), and the run manifest of a batch run -- `start`, `append`,
// `verify`, `budget`, `park` (Hatsu ruling HR-5; SDD plan piece N7).
//
// Two meanings of "run" share the family name because the registry has one
// slot for it: an Actions run (`rerun-failed`, which takes --run-id) and a
// Hatsu batch run (the manifest verbs, which take --id). Every flag below is
// refused on the subcommands that do not read it, so the two never blur.

import { resolve } from "node:path";
import { parseTarget, type Target } from "../github/target.js";
import {
  emit,
  refuseExtraPositionals,
  requireRepoFlag,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { splitList } from "../cli/inputs.js";
import { resolveRepoRoot } from "../repo/root.js";
import { loadWorkflow } from "../schema/workflow.js";
import { effortIdProblem, effortIdRefusal } from "../ledger/effort.js";
import { resolveEffortHome } from "../ledger/home.js";
import { rerunFailed } from "./rerun.js";
import {
  BRANCH_NAME,
  gitCommonDir,
  HEAD_SHA,
  ISSUE_REF,
  locateRunManifest,
  parseIdleAnswers,
  planAppend,
  planPark,
  planStart,
  combineModes,
  readRunManifest,
  renderModes,
  ROW_ID,
  RUN_CONTRACT,
  RUN_KINDS,
  RUN_MANIFEST_DIR,
  runIdSegment,
  RunManifestError,
  withManifest,
  type LocatedManifest,
  type ModeOps,
  type RunKind,
  type RunManifest,
} from "./manifest.js";
import { readLivePr, renderVerify, verifyRun } from "./verify.js";
import { normaliseIssue } from "./issue.js";
import { CONSUMER_RUN_CONTRACTS, CONSUMER_RUN_DISPLAY, consumerRunPath, planImport, readConsumerRun } from "./import.js";
import { computeBudget, renderBudget, runEfforts, type BudgetCeiling } from "./budget.js";
import { chmodSync, readFileSync } from "node:fs";
import { readRecord, RECORD_SCHEMAS, recordSchema, renderRecord, runIdMatches, unreadableRecord, writeRecord } from "./record.js";

const SUBCOMMANDS = ["rerun-failed", "start", "append", "verify", "budget", "park", "record", "import"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const USAGE = `nen run rerun-failed -- re-run a workflow run's failed jobs, senkei's dead-reviewer recovery.
nen run start|append|park|verify|budget|import -- a batch run's manifest (${RUN_CONTRACT}, HR-5).

usage:
  nen run rerun-failed --target <owner/name> --run-id <n> [--dry-run] [--json]
  nen run start  --id <run-id> --target <owner/name> --repo <path> [--idle-answers <json>]
                 [--dry-run] [--json]
  nen run append --id <run-id> --pr <N> --kind delivery|integration|release
                 [--issue <ref>] [--base <branch>] [--head <sha>] [--effort <id>]
                 [--repo <path>] [--dry-run] [--json]
  nen run park   --id <run-id> --issue <ref> --row <decisions-row-id> [--repo <path>]
                 [--dry-run] [--json]
  nen run verify --id <run-id> --target <owner/name> [--repo <path>] [--dry-run]
                 [--json]
  nen run budget --id <run-id> [--claim] [--max-minutes <n>] [--max-tokens <n>]
                 [--effort <id,...>] [--repo <path>] [--dry-run] [--json]
  nen run record read  --schema <id> --id <run-id> [--json]
  nen run record write --schema <id> --id <run-id> --from <file> [--dry-run] [--json]
  nen run import --id <run-id> [--from <file>] [--repo <path>] [--dry-run] [--json]

rerun-failed: 'gh run rerun <n> --failed', exactly. senkei's own instruction:
re-run the failed job when a reviewer job dies mid-run, NEVER re-label to force
a re-vote -- this verb only ever runs the rerun. --dry-run prints 'would run:'
and that line, and calls nothing; --json: { ok, message, dryRun, command }.

The manifest lives at '<git-common-dir>/${RUN_MANIFEST_DIR}/<run-id>.json' -- the git
common dir, so every worktree of the project shares it and no effort cleanup
removes it; one an earlier build wrote under the legacy spelling is
moved there once, by the first run verb that reads it without --dry-run. git is asked with an
inherited GIT_DIR, GIT_COMMON_DIR and GIT_WORK_TREE dropped. nen records and
reads; it decides nothing.

MODES (zheref/nen#522). Every write -- start, append, park, import and the
legacy move -- lands the manifest at 0600 in a 0700 directory: the directory
is created at 0700, the file is written to a temp file at 0600 and renamed
over, and a wider mode an earlier build left (0644 under 0755) is narrowed on
the next write. The modes are READ BACK and printed as 'mode: file 0600,
directory 0700' (with '(narrowed: file 0644 -> 0600, ...)' when a write
narrowed one); --json carries 'mode': { verdict, file, directory, repaired,
reason } -- the legacy move's narrowing included, null when neither the
plan nor a legacy move writes. A manifest, legacy manifest or runs directory (or any component of
it below the git common dir, such as .nen) that is a symbolic link (or not a
regular file) is refused at exit 1: nen never chmods or writes
through a link. Where a mode cannot be set -- a win32
host, a chmod that fails, a read-back that is not 0600/0700 -- the write
stands and the verb says 'mode: not set (<reason>)', verdict not-set; it never
claims the mode.

DRY FORMS. Every verb that can write the manifest takes --dry-run, and a
dry run writes nothing: no file, no directory, no mode change, no move. The
legacy move counts as a write, so verify and budget, which move a legacy
manifest when they read it, take --dry-run too: it prints 'would move run
manifest ... (dry run: nothing moved; read where it is)' on stderr and reads
the file in place. start, append, park and import print 'mode: would set file
0600, directory 0700' for the write they would make. 'nen loop slots
--from-run' never moves a manifest; it reads a legacy one in place.

  start   Write the manifest: id, repo (--target), startedAt, idleAnswers (a
          JSON object from ask-once row id to default | hold | refuse, HR-5),
          prs: [], parked: []. A re-start with the same answers is the
          resume: 'existing', exit 0. A re-start with other answers or
          another --target is refused, exit 1: launch answers are fixed at
          start.
  append  Record one PR the run opened, WHATEVER ITS BASE (main, an
          integration branch, a stack). The PR is READ LIVE in the run's
          repo: its base, head branch and head commit are recorded as read;
          --base and --head, when given, must match what is read. A PR
          created before the run's startedAt is refused, exit 1: the run did
          not open it. --issue is required for a delivery PR and optional
          (null) for an integration or release PR; it is recorded as
          '<owner/name>#<N>' (a code is resolved through --repo's
          nen/repos.json, exit 2 when it does not resolve), as park and
          import record it. The same facts again:
          'unchanged'; a moved head or a retargeted base: 'updated'; another
          issue, kind or effort for a recorded PR: refused, exit 1. No
          manifest, or a PR that could not be read: exit 1.
  park    Record that an effort is parked on an unanswered ask-once row
          (HR-5): parked[] { issue, row, at }. The same issue and row again:
          'unchanged'. No manifest: exit 1.
  verify  Read every recorded PR live (gh pr view) and report open, merged
          and closed-unmerged, with the unmerged list. --target must name the
          run's repo (exit 2 otherwise). Exit 0 when every PR was read, 1
          when any could not be -- an unread PR is never counted, and the
          unmerged list is then 'unknown (<n> unread)', null in --json.
          --dry-run: the legacy move printed, not made (see DRY FORMS).
  budget  Minutes are WALL-CLOCK since the manifest's startedAt
          (idle.budget.minutes as its catalogue row defines it); the
          efforts' own minutes are printed as effortMinutes, never compared.
          Tokens are the usage ledgers' (<git-common-dir>/.nen/usage/
          <effort>.json, as 'nen usage show' reads them) input + output + cache read + cache write, for the efforts
          the PRs name plus --effort. Ceilings: --max-minutes and
          --max-tokens, default --repo's nen/workflow.json idle.budget. The
          token sum is UNREAD -- 'unevaluated', a claim refused, exit 1 --
          when an entry was recorded --not-reported, a delivery PR names no
          effort, a delivery PR's or an --effort's effort has no ledger, or a
          ledger will not read. With --claim: exit 1 once either ceiling is reached -- an
          answer, not a failure, the loop cap's shape. Nothing is written
          but the one-time legacy move, which --dry-run prints and skips.
  import  Read the consumer plane's futon run manifest
          (${CONSUMER_RUN_CONTRACTS.join(" or ")}, at
          '${CONSUMER_RUN_DISPLAY}', or --from <file>)
          into this manifest, so one manifest owns the run (NN#486 AC-5): the
          start, every PR (READ LIVE, as append reads it: the consumer keeps
          the head branch and no commit; its issue number becomes
          '<owner/name>#<N>') and every parked row, through the same plans
          start, append and park use. The source file is READ ONLY -- never
          written, moved or deleted. 'imported', or 'unchanged' on a
          re-import; a PR gh cannot read, one created before the run started,
          or a fact that contradicts what nen holds refuses the WHOLE import
          at exit 1 and writes nothing. A missing or malformed source is exit 1.

  record  A caller's resumable run record (zheref/nen#493), validated against
          a schema nen ships as data (${RECORD_SCHEMAS.join(", ")}) and kept at
          \${XDG_STATE_HOME:-$HOME/.local/state}/<schema dir>/<run-id>.json.
          The run id is matched WHOLE against the schema's pattern before any
          path is built; the record's schema, caller and runId are checked
          before its fields. 'write' reads the document from --from and writes
          it whole (a temp file at 0600 in a 0700 directory, then a rename);
          --dry-run validates and writes nothing. 'read' validates the stored
          record. Verdicts valid, written, would-write, absent, invalid,
          could-not-read; exit 0 for the first three, 1 otherwise.

Exit 2 for a malformed flag or a flag another subcommand owns.`;

const OWNED: Readonly<Record<string, readonly Subcommand[]>> = {
  "run-id": ["rerun-failed"],
  target: ["rerun-failed", "start", "verify"],
  id: ["start", "append", "verify", "budget", "park", "record", "import"],
  schema: ["record"],
  from: ["record", "import"],
  "idle-answers": ["start"],
  issue: ["append", "park"],
  pr: ["append"],
  base: ["append"],
  kind: ["append"],
  head: ["append"],
  row: ["park"],
  effort: ["append", "budget"],
  "max-minutes": ["budget"],
  "max-tokens": ["budget"],
};
const OWNED_BOOLEANS: Readonly<Record<string, readonly Subcommand[]>> = {
  "dry-run": ["rerun-failed", "start", "append", "park", "record", "import", "verify", "budget"],
  claim: ["budget"],
};

function refuseForeignFlags(context: CommandContext, subcommand: Subcommand): void {
  const refuse = (flag: string, owners: readonly Subcommand[]): never => {
    throw new VerbUsageError(
      `--${flag} is not read by 'run ${subcommand}' (it belongs to ${owners.map((o): string => `'run ${o}'`).join(", ")}). A flag accepted and ignored is worse than one refused.`,
    );
  };
  for (const [flag, owners] of Object.entries(OWNED)) {
    if (context.args.values[flag] !== undefined && !owners.includes(subcommand)) refuse(flag, owners);
  }
  for (const [flag, owners] of Object.entries(OWNED_BOOLEANS)) {
    if (context.args.booleans.has(flag) && !owners.includes(subcommand)) refuse(flag, owners);
  }
}

export const runCommand: Command = {
  name: "run",
  subcommands: [...SUBCOMMANDS],
  summary: "Re-run a workflow run's failed jobs; keep and read a batch run's manifest and a caller's run record.",
  usage: USAGE,
  flags: {
    values: ["target", "run-id", "id", "idle-answers", "issue", "pr", "base", "kind", "head", "row", "effort", "max-minutes", "max-tokens", "schema", "from"],
    booleans: ["dry-run", "claim"],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("run", context.args, SUBCOMMANDS) as Subcommand;
    refuseForeignFlags(context, subcommand);
    if (subcommand === "rerun-failed") return doRerun(context);
    if (subcommand === "start") return doStart(context);
    if (subcommand === "append") return doAppend(context);
    if (subcommand === "verify") return doVerify(context);
    if (subcommand === "park") return doPark(context);
    if (subcommand === "record") return doRecord(context);
    if (subcommand === "import") return doImport(context);
    return doBudget(context);
  },
};

function doRecord(context: CommandContext): number {
  const action = context.args.positionals[2];
  if (action !== "read" && action !== "write") throw new VerbUsageError(`'run record' needs its action: 'run record read' or 'run record write'${action === undefined ? "" : ` (got '${action}')`}.`);
  refuseExtraPositionals(context.args, 3);
  if (context.repoFlag !== null) throw new VerbUsageError("'run record' keeps the record under the caller's XDG state directory and reads no checkout, so it takes no --repo.");
  const schemaId = requireValue(context.args, "schema", `It names the record's schema: ${RECORD_SCHEMAS.join(", ")}.`);
  const schema = recordSchema(schemaId);
  if (schema === null) throw new VerbUsageError(`--schema '${schemaId}' is not a schema nen keeps records for (${RECORD_SCHEMAS.join(", ")}).`);
  const id = requireValue(context.args, "id", "It names the run, and the record's file name.");
  if (!runIdMatches(schema, id)) throw new VerbUsageError(`--id '${id.replace(/[\r\n]/g, "\\n")}' does not match ${schema.schema}'s run id pattern ${schema.runId} whole; no path is built from it.`);
  const input = { schema, id, env: context.seams.env };
  let report;
  if (action === "read") {
    if (context.args.values["from"] !== undefined || context.args.booleans.has("dry-run")) throw new VerbUsageError("--from and --dry-run belong to 'run record write'.");
    report = readRecord(input);
  } else {
    const from = requireValue(context.args, "from", "It names the file holding the whole record to write.");
    let value: unknown;
    let unread: string | null = null;
    try {
      value = JSON.parse(readFileSync(from, "utf8"));
    } catch (error) {
      unread = `--from '${from}' could not be read as JSON: ${(error as Error).message}; nothing was written`;
    }
    // An unreadable input is the record's could-not-read, with its report, never a usage error (Nobunaga F14).
    report = unread === null ? writeRecord(input, value, context.args.booleans.has("dry-run")) : unreadableRecord(input, unread);
  }
  emit(context.io, context.json, report, renderRecord(report));
  return report.verdict === "valid" || report.verdict === "written" || report.verdict === "would-write" ? 0 : 1;
}

function doRerun(context: CommandContext): number {
  const targetRaw = context.args.values["target"];
  if (targetRaw === undefined) throw new VerbUsageError("--target owner/name is required.");
  const runIdRaw = context.args.values["run-id"];
  const runIdValue = Number(runIdRaw ?? "");
  if (runIdRaw === undefined || !Number.isInteger(runIdValue) || runIdValue <= 0) {
    throw new VerbUsageError("--run-id <n> is required.");
  }

  // A malformed --target is the same typo as a missing one: exit 2, as on
  // every other verb that takes the flag (Hatsu SDD plan N5). It was exit 1.
  let target: Target;
  try {
    target = parseTarget(targetRaw);
  } catch (error) {
    throw new VerbUsageError(error instanceof Error ? error.message : String(error));
  }
  const result = rerunFailed(context.seams, target, runIdValue, context.args.booleans.has("dry-run"));
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  context.io.out(result.message);
  return result.ok ? 0 : 1;
}

function runId(context: CommandContext): string {
  const id = requireValue(context.args, "id", "It names the run, and the manifest file that carries it between sessions.");
  if (runIdSegment(id) === null) {
    throw new VerbUsageError(
      `--id '${id}' is not usable as a manifest name. It must be 1-100 characters of [A-Za-z0-9._-], start with a letter or digit, and contain no '..'. Refused rather than sanitised: two ids mangled to one name would silently share a run.`,
    );
  }
  return id;
}

/** How this invocation sets the manifest's modes: the host's platform, through the seam, and its chmod. */
function modeOps(context: CommandContext): ModeOps {
  return { platform: context.seams.platform, chmod: chmodSync };
}

/**
 * The manifest for --id under the checkout's git common dir, or null with the
 * reason printed. A manifest at a legacy path is moved there once -- a WRITE,
 * so under --dry-run it is printed as 'would move' and left where it is, and
 * the verb reads it in place (zheref/nen#522 AC-2). Either way the move, and
 * the modes it set or would set, go to stderr.
 */
function locateManifest(context: CommandContext, root: string, id: string, dryRun: boolean): LocatedManifest | null {
  try {
    const located = locateRunManifest(gitCommonDir(context.seams, root), id, { dryRun, ops: modeOps(context) });
    if (located.migratedFrom !== null) {
      context.io.err(
        located.moved
          ? `nen: moved run manifest '${id}' from ${located.migratedFrom} to ${located.path} (nen's common-dir root; this happens once).`
          : `nen: would move run manifest '${id}' from ${located.migratedFrom} to ${located.path} (dry run: nothing moved; read where it is).`,
      );
      // The move's modes are part of the verb's `mode`: alone when the plan writes nothing (N5), combined when it writes too (N9).
      for (const line of renderModes(located.modes)) context.io.err(`nen: ${line}`);
    }
    return located;
  } catch (error) {
    context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function targetFlag(context: CommandContext, why: string): Target {
  const raw = requireValue(context.args, "target", why);
  try {
    return parseTarget(raw);
  } catch (error) {
    throw new VerbUsageError(error instanceof Error ? error.message : String(error));
  }
}

function doStart(context: CommandContext): number {
  const id = runId(context);
  const target = targetFlag(context, "It is the owner/name every PR of the run lives in; append reads each PR there and verify refuses another.");
  const root = resolveRepoRoot({ repoFlag: requireRepoFlag(context, "It names the checkout whose git common dir keeps the manifest.") });
  const answersRaw = context.args.values["idle-answers"];
  let answers: RunManifest["idleAnswers"] = null;
  if (answersRaw !== undefined) {
    try {
      answers = parseIdleAnswers(answersRaw);
    } catch (error) {
      throw new VerbUsageError(error instanceof Error ? error.message : String(error));
    }
  }
  const dryRun = context.args.booleans.has("dry-run");
  const located = locateManifest(context, root, id, dryRun);
  if (located === null) return 1;
  const path = located.path;
  let result;
  try {
    result = withManifest(path, (existing) => planStart(existing, id, target.slug, context.seams.now().toISOString(), answers), !dryRun, { readPath: located.readPath, ops: modeOps(context) });
  } catch (error) {
    context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const outcome = dryRun && result.outcome === "started" ? "dry-run" : result.outcome;
  const reason = result.outcome === "conflict" ? result.reason : null;
  emit(context.io, context.json, { outcome, path, reason, manifest: result.manifest, mode: combineModes(located.modes, result.modes) }, [
    reason === null ? `${outcome}: run ${id} -- ${path}` : `refused: ${reason}`,
    ...renderModes(combineModes(located.modes, result.modes)),
  ]);
  return result.outcome === "conflict" ? 1 : 0;
}

function doAppend(context: CommandContext): number {
  const id = runId(context);
  const kind = requireValue(context.args, "kind", `It is one of ${RUN_KINDS.join(", ")}.`);
  if (!(RUN_KINDS as readonly string[]).includes(kind)) throw new VerbUsageError(`--kind '${kind}' must be one of ${RUN_KINDS.join(", ")}.`);
  const issueRaw = context.args.values["issue"];
  if (issueRaw === undefined && kind === "delivery") throw new VerbUsageError("--issue <CODE>#<N> is required for a delivery PR: it is the issue the PR delivers. An integration or release PR may omit it (recorded null).");
  if (issueRaw !== undefined && !ISSUE_REF.test(issueRaw)) throw new VerbUsageError(`--issue '${issueRaw}' is not <CODE>#<N> or <owner/name>#<N>.`);
  const prRaw = requireValue(context.args, "pr", "It is the pull request number the run opened.");
  const pr = Number(prRaw);
  if (!/^[1-9][0-9]*$/.test(prRaw) || !Number.isSafeInteger(pr)) throw new VerbUsageError(`--pr '${prRaw}' is not a pull request number.`);
  const baseFlag = context.args.values["base"];
  if (baseFlag !== undefined && !BRANCH_NAME.test(baseFlag)) throw new VerbUsageError(`--base '${baseFlag}' is not a branch name.`);
  const headFlag = context.args.values["head"];
  if (headFlag !== undefined && !HEAD_SHA.test(headFlag)) throw new VerbUsageError(`--head '${headFlag}' is not a commit id of 7 to 40 hex digits.`);
  const effort = context.args.values["effort"] ?? null;
  const effortProblem = effort === null ? null : effortIdProblem(effort);
  if (effort !== null && effortProblem !== null) throw new VerbUsageError(`--effort: ${effortIdRefusal(effort, effortProblem)}`);

  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const issue = issueRaw === undefined ? null : normaliseIssue(root, issueRaw);
  const dryRun = context.args.booleans.has("dry-run");
  const located = locateManifest(context, root, id, dryRun);
  if (located === null) return 1;
  const path = located.path;
  const now = context.seams.now().toISOString();
  let result;
  try {
    const started = readRunManifest(located.readPath);
    if (started === null) {
      throw new RunManifestError(`no run '${id}' at ${path} -- 'nen run start --id ${id}' first. A PR recorded into a run nobody started would be a run with no launch answers.`);
    }
    // THE PR IS READ LIVE, never taken from the caller's word: its base, head
    // branch and head commit are what GitHub says, and a PR opened before the
    // run started is not one this run opened (NN#486 AC-2).
    const [owner, name] = started.repo.split("/") as [string, string];
    const live = readLivePr(context.seams, { owner, repo: name, slug: started.repo }, pr);
    if (!live.ok) throw new RunManifestError(`could not read ${started.repo}#${pr}: ${live.reason}. A PR nen could not read is never recorded.`);
    if (live.pr.createdAt === null) throw new RunManifestError(`${started.repo}#${pr}: gh did not say when it was created, so nen cannot tell whether this run opened it.`);
    if (Date.parse(live.pr.createdAt) < Date.parse(started.startedAt)) {
      throw new RunManifestError(`${started.repo}#${pr} was created at ${live.pr.createdAt}, before run '${id}' started at ${started.startedAt}: this run did not open it, and nen will not record it as the run's.`);
    }
    if (baseFlag !== undefined && baseFlag !== live.pr.base) throw new RunManifestError(`--base '${baseFlag}' is not ${started.repo}#${pr}'s base '${live.pr.base}'.`);
    if (headFlag !== undefined && !live.pr.head.toLowerCase().startsWith(headFlag.toLowerCase())) {
      throw new RunManifestError(`--head '${headFlag}' is not ${started.repo}#${pr}'s head ${live.pr.head}; it moved, or the caller named another commit.`);
    }
    result = withManifest(
      path,
      (existing) => {
        if (existing === null) throw new RunManifestError(`run '${id}' at ${path} vanished while #${pr} was being recorded.`);
        return planAppend(existing, { issue, pr, base: live.pr.base, branch: live.pr.headRef, kind: kind as RunKind, head: live.pr.head, effort, now });
      },
      !dryRun,
      { readPath: located.readPath, ops: modeOps(context) },
    );
  } catch (error) {
    context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const writes = result.outcome === "appended" || result.outcome === "updated";
  const outcome = dryRun && writes ? "dry-run" : result.outcome;
  const entry = result.outcome === "conflict" ? null : result.entry;
  const previous = result.outcome === "updated" || result.outcome === "conflict" ? result.previous : null;
  const reason = result.outcome === "conflict" ? result.reason : null;
  const would = dryRun && writes ? ` (would be ${result.outcome})` : "";
  emit(context.io, context.json, { outcome, path, reason, entry, previous, mode: combineModes(located.modes, result.modes) }, [
    reason === null
      ? `${outcome}${would}: #${pr} ${issue ?? "(no issue)"} [${kind}] ${entry?.branch ?? ""} -> ${entry?.base ?? ""} @ ${(entry?.head ?? "").slice(0, 12)} in run ${id}`
      : `refused: ${reason}`,
    ...renderModes(combineModes(located.modes, result.modes)),
  ]);
  return result.outcome === "conflict" ? 1 : 0;
}

function doPark(context: CommandContext): number {
  const id = runId(context);
  const issueRaw = requireValue(context.args, "issue", "It is the issue whose effort is parked, as <CODE>#<N> or <owner/name>#<N>.");
  if (!ISSUE_REF.test(issueRaw)) throw new VerbUsageError(`--issue '${issueRaw}' is not <CODE>#<N> or <owner/name>#<N>.`);
  const row = requireValue(context.args, "row", "It is the ask-once decisions row the effort is parked on (HR-5).");
  if (!ROW_ID.test(row)) throw new VerbUsageError(`--row '${row}' is not [a-z0-9-]+, the spelling nen/decisions.json uses.`);
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const issue = normaliseIssue(root, issueRaw);
  const dryRun = context.args.booleans.has("dry-run");
  const located = locateManifest(context, root, id, dryRun);
  if (located === null) return 1;
  const path = located.path;
  let result;
  try {
    result = withManifest(
      path,
      (existing) => {
        if (existing === null) throw new RunManifestError(`no run '${id}' at ${path} -- 'nen run start --id ${id}' first.`);
        return planPark(existing, issue, row, context.seams.now().toISOString());
      },
      !dryRun,
      { readPath: located.readPath, ops: modeOps(context) },
    );
  } catch (error) {
    context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const outcome = dryRun && result.outcome === "parked" ? "dry-run" : result.outcome;
  emit(context.io, context.json, { outcome, path, entry: result.entry, mode: combineModes(located.modes, result.modes) }, [
    `${outcome}: ${issue} parked on row ${row} in run ${id} (since ${result.entry.at})`,
    ...renderModes(combineModes(located.modes, result.modes)),
  ]);
  return 0;
}

/** The manifest a reading verb reads; under --dry-run a legacy-path one is read in place, never moved (AC-2). */
function loadManifest(context: CommandContext, id: string): RunManifest | null {
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const located = locateManifest(context, root, id, context.args.booleans.has("dry-run"));
  if (located === null) return null;
  try {
    const manifest = readRunManifest(located.readPath);
    if (manifest === null) {
      context.io.err(`nen: no run '${id}' at ${located.path}. A run that was never started has no PRs to read, which is not the same as a run whose PRs are all merged.`);
      return null;
    }
    return manifest;
  } catch (error) {
    context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function doVerify(context: CommandContext): number {
  const id = runId(context);
  const target = targetFlag(context, "It is the repository whose PRs the run recorded.");
  const manifest = loadManifest(context, id);
  if (manifest === null) return 1;
  if (manifest.repo.toLowerCase() !== target.slug.toLowerCase()) {
    throw new VerbUsageError(`--target ${target.slug} is not run '${id}''s repository ${manifest.repo}; its PR numbers name PRs there, and reading them in another repository would read other PRs.`);
  }
  const report = verifyRun(manifest, target, (pr) => readLivePr(context.seams, target, pr));
  emit(context.io, context.json, report, renderVerify(report));
  return report.counts.unread > 0 ? 1 : 0;
}

function positive(raw: string, flag: string): number {
  const value = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value)) throw new VerbUsageError(`--${flag} '${raw}' is not a positive integer.`);
  return value;
}

function doBudget(context: CommandContext): number {
  const id = runId(context);
  const extra = splitList(context.args.values["effort"]);
  for (const effort of extra) {
    const problem = effortIdProblem(effort);
    if (problem !== null) throw new VerbUsageError(`--effort: ${effortIdRefusal(effort, problem)}`);
  }
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const minutesFlag = context.args.values["max-minutes"];
  const tokensFlag = context.args.values["max-tokens"];
  let declared: { minutes: number | null; tokens: number | null; path: string } = { minutes: null, tokens: null, path: "nen/workflow.json" };
  if (minutesFlag === undefined || tokensFlag === undefined) {
    try {
      const loaded = loadWorkflow(root);
      declared = { minutes: loaded.workflow.idle?.budget.minutes ?? null, tokens: loaded.workflow.idle?.budget.tokens ?? null, path: loaded.path };
    } catch (error) {
      context.io.err(`nen: could not read nen/workflow.json for idle.budget: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  const pick = (flag: string | undefined, name: "minutes" | "tokens"): { value: number; source: string } => {
    if (flag !== undefined) return { value: positive(flag, `max-${name}`), source: `--max-${name}` };
    const value = declared[name];
    if (value === null) {
      throw new VerbUsageError(`--max-${name} is required: --repo's nen/workflow.json declares no idle.budget.${name}. A spend ceiling must be stated, never inherited from nothing.`);
    }
    return { value, source: `${declared.path}: idle.budget.${name}` };
  };
  const minutes = pick(minutesFlag, "minutes");
  const tokens = pick(tokensFlag, "tokens");
  const ceiling: BudgetCeiling = { minutes: minutes.value, tokens: tokens.value, source: { minutes: minutes.source, tokens: tokens.source } };

  const manifest = loadManifest(context, id);
  if (manifest === null) return 1;
  const claim = context.args.booleans.has("claim");
  const report = computeBudget(manifest, resolveEffortHome(root, "usage", context.seams), runEfforts(manifest, extra), ceiling, claim, context.seams.now());
  emit(context.io, context.json, report, renderBudget(report));
  if (report.verdict === "unevaluated") return 1;
  return claim && report.verdict === "reached" ? 1 : 0;
}

/**
 * `nen run import` -- the consumer's futon run manifest read into nen's (NN#486
 * AC-5; ./import.ts). The source file is read, never written; nen's is written under
 * the ledger lock only when every PR read live and nothing conflicted.
 */
function doImport(context: CommandContext): number {
  const id = runId(context);
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const dryRun = context.args.booleans.has("dry-run");
  const fromFlag = context.args.values["from"];
  let common: string;
  try {
    common = gitCommonDir(context.seams, root);
  } catch (error) {
    context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const from = fromFlag === undefined ? consumerRunPath(common, id) : resolve(root, fromFlag);
  const located = locateManifest(context, root, id, dryRun);
  if (located === null) return 1;
  const path = located.path;
  const now = context.seams.now().toISOString();
  let result;
  try {
    const run = readConsumerRun(from);
    if (run.id !== id) throw new RunManifestError(`'${from}' records run '${run.id}', not '${id}'. Nothing was written.`);
    result = withManifest(path, (existing) => planImport(context.seams, existing, run, id, now, root), !dryRun, { readPath: located.readPath, ops: modeOps(context) });
  } catch (error) {
    context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const outcome = dryRun && result.outcome === "imported" ? "dry-run" : result.outcome;
  emit(context.io, context.json, { outcome, from, path, reason: result.reason, prs: result.prs, parked: result.parked, manifest: result.manifest, mode: combineModes(located.modes, result.modes) }, [
    result.reason === null
      ? `${outcome}: run ${id} from ${from} -- ${result.prs.length} PR(s), ${result.parked.length} parked -- ${path}`
      : `refused: ${result.reason}`,
    ...result.prs.map((row): string => `  #${row.pr}: ${row.outcome}`),
    ...renderModes(combineModes(located.modes, result.modes)),
  ]);
  return result.outcome === "conflict" ? 1 : 0;
}
