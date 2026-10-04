// src/classify/apply.ts -- `nen classify apply`.
//
// Applies a classification PLAN -- the judgement a skill already made -- as
// GitHub labels. The plan is a JSON array of rows
//   { "issue": 12, "lang": ["..."], "job": ["...", "..."],
//     "confidence": "high"|"medium"|"low" (default high), "reason": "..." }
// whose axis fields are exactly the taxonomy's axes. Everything deterministic
// around the judgement is here; none of the judgement is.
//
// THE WHOLE PLAN IS VALIDATED BEFORE ANYTHING IS READ FROM GITHUB OR WRITTEN.
// Positive integer issues, no duplicate issue, every key in its axis, every
// resulting label declared in the consumer's nen/labels.json (the check
// `label apply` makes, through the same loader), a confidence the taxonomy
// names. One invalid row refuses the plan WHOLE at exit 2, every refusal named:
// a half-applied classification is the state a sweep cannot reason about.
//
// ONLY THEN ARE THE ISSUES READ, all of them, before the first write: every
// number must be an issue (a pull request is refused at exit 1, naming it,
// exactly as `issue edit-body` certifies), and each issue's current labels
// decide `already` -- a label an issue carries is reported, never re-applied.
//
// CONFIDENCE IS THE TAXONOMY'S, never this file's. Rows at a `listed` level
// (low) are reported `listed` and NOT applied unless --include-low: the ruling
// is that a sweep applies high and medium after one confirmation and lists low
// for a human to pick. The ledger spellings of those levels are read from the
// taxonomy, so a taxonomy that moved a level moves the behaviour with no edit
// here.
//
// THE LEDGER (../label/ledger.ts, shared with `label apply`) gets one line per
// APPLICATION, dry run or not, written AFTER the mutation resolves -- the
// ledger is the after-the-fact record, and a line written before gh answered
// would assert a label a 403 never applied. `listed` and `already` are not
// applications and write none. The object is spelled `<owner/name>#<N>`.

import { closeSync, openSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { requireValue, VerbUsageError, type CommandContext } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import { readTextFile, resolveAgainstRepo } from "../cli/inputs.js";
import type { Target } from "../github/target.js";
import { readIssue } from "../issue/subissue.js";
import { DEFAULT_LEDGER } from "../label/command.js";
import { ledgerLine, type LedgerEntry } from "../label/ledger.js";
import { isRecord } from "../schema/errors.js";
import { loadLabelTaxonomy, type LabelTaxonomy } from "../schema/labels.js";
import { GH, outputLines } from "../seam/exec.js";
import { loadRequiringRepo, requireTarget } from "./common.js";
import { AXES, type ClassifyTaxonomy } from "./taxonomy.js";

export interface PlanRow {
  readonly issue: number;
  /** The label names this row applies, axis by axis in taxonomy order. */
  readonly labels: readonly string[];
  readonly confidence: string;
  readonly reason: string | null;
}

export interface PlanValidation {
  readonly rows: readonly PlanRow[];
  /** Every refusal, each naming its pointer into the plan. */
  readonly refusals: readonly string[];
}

export function validatePlan(
  taxonomy: ClassifyTaxonomy,
  declared: LabelTaxonomy,
  planPath: string,
  value: unknown,
): PlanValidation {
  const refusals: string[] = [];
  const refuse = (pointer: string, message: string): void => {
    refusals.push(`${planPath}: at ${pointer}, ${message}`);
  };
  if (!Array.isArray(value)) {
    refuse("$", "expected a JSON array of plan rows.");
    return { rows: [], refusals };
  }
  const known = new Set<string>(["issue", "confidence", "reason", ...AXES]);
  const seen = new Map<number, number>();
  const rows: PlanRow[] = [];

  value.forEach((entry: unknown, index: number): void => {
    const at = `[${index}]`;
    if (!isRecord(entry)) {
      refuse(at, "expected an object.");
      return;
    }
    for (const field of Object.keys(entry)) {
      if (!known.has(field)) {
        refuse(`${at}.${field}`, `is not a plan field (expected: ${[...known].join(", ")}). A misspelt axis would silently apply nothing.`);
      }
    }

    const rawIssue = entry["issue"];
    let issue = 0;
    if (typeof rawIssue !== "number" || !Number.isInteger(rawIssue) || rawIssue <= 0) {
      refuse(`${at}.issue`, `expected a positive whole number, got ${JSON.stringify(rawIssue) ?? "nothing"}.`);
    } else {
      issue = rawIssue;
      const previous = seen.get(issue);
      if (previous !== undefined) refuse(`${at}.issue`, `duplicates [${previous}].issue (#${issue}). One issue, one row.`);
      else seen.set(issue, index);
    }

    const labels: string[] = [];
    for (const name of AXES) {
      const axis = taxonomy.axes[name];
      const raw = entry[name];
      if (raw === undefined) continue;
      if (!Array.isArray(raw)) {
        refuse(`${at}.${name}`, "expected an array of keys.");
        continue;
      }
      const listed = new Set<string>();
      raw.forEach((key: unknown, position: number): void => {
        const pointer = `${at}.${name}[${position}]`;
        if (typeof key !== "string" || key === "") {
          refuse(pointer, `expected a key name, got ${JSON.stringify(key) ?? "nothing"}.`);
          return;
        }
        if (!axis.keys.some((candidate): boolean => candidate.key === key)) {
          refuse(pointer, `'${key}' is not a key of the ${name} axis in ${taxonomy.path}.`);
          return;
        }
        if (listed.has(key)) {
          refuse(pointer, `'${key}' is listed twice.`);
          return;
        }
        listed.add(key);
        const label = axis.prefix + key;
        if (!declared.has(label)) {
          refuse(pointer, `'${label}' is not declared in ${declared.path}. Land the declaration first ('nen classify install --write').`);
          return;
        }
        labels.push(label);
      });
    }

    const rawConfidence = entry["confidence"];
    // The default is the taxonomy's FIRST level: its levels are ordered most-confident first.
    let confidence = taxonomy.confidence.levels[0] as string;
    if (rawConfidence !== undefined) {
      if (typeof rawConfidence !== "string" || !taxonomy.confidence.levels.includes(rawConfidence)) {
        refuse(`${at}.confidence`, `expected one of [${taxonomy.confidence.levels.join(", ")}], got ${JSON.stringify(rawConfidence)}.`);
      } else {
        confidence = rawConfidence;
      }
    }

    const rawReason = entry["reason"];
    if (rawReason !== undefined && typeof rawReason !== "string") refuse(`${at}.reason`, "expected a string.");

    rows.push({ issue, labels, confidence, reason: typeof rawReason === "string" && rawReason !== "" ? rawReason : null });
  });

  return { rows: refusals.length === 0 ? rows : [], refusals };
}

export function addLabelArgv(target: Target, issue: number, label: string): readonly string[] {
  return ["issue", "edit", String(issue), "--repo", target.slug, "--add-label", label];
}

export interface IssueOutcome {
  readonly number: number;
  readonly applied: string[];
  readonly wouldApply: string[];
  readonly already: string[];
  readonly failed: string[];
  readonly listed: string[];
}

const BUCKETS = ["applied", "wouldApply", "already", "failed", "listed"] as const;

export function runApply(context: CommandContext): number {
  const target = requireTarget(context);
  const { root, taxonomy } = loadRequiringRepo(context);
  const planFlag = requireValue(
    context.args,
    "plan",
    "It is the JSON array of classification rows to apply (relative paths resolve against --repo).",
  );
  const run = context.args.booleans.has("run");
  const includeLow = context.args.booleans.has("include-low");
  const flagReason = context.args.values["reason"] ?? null;

  const planPath = resolveAgainstRepo(root, planFlag);
  const text = readTextFile(
    planPath,
    root,
    "--plan names the classification to apply, so an unreadable one is refused rather than read as an empty plan.",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    context.io.err(`nen: ${planPath}: is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    return 2;
  }
  const declared = loadLabelTaxonomy(root);
  const { rows, refusals } = validatePlan(taxonomy, declared, planPath, parsed);
  if (refusals.length > 0) {
    for (const refusal of refusals) context.io.err(plainLine(`nen: ${refusal}`));
    context.io.err(`nen: the plan was refused whole (${refusals.length} refusal(s)); nothing was read from GitHub and nothing was written.`);
    return 2;
  }

  // The ledger's directory is checked BEFORE the first mutation: a line that
  // cannot be written after gh has answered is a mutation with no record.
  const ledgerPath = resolveAgainstRepo(root, context.args.values["ledger"] ?? DEFAULT_LEDGER);
  const ledgerDir = dirname(ledgerPath);
  if (statSync(ledgerDir, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new VerbUsageError(`--ledger '${ledgerPath}' cannot be written: '${ledgerDir}' is not a directory.`);
  }

  // Every number is certified an ISSUE, and its labels read, before any write.
  const current = rows.map((row) => ({ row, issue: readIssue(context.seams, target, row.issue) }));
  const prs = current.filter((entry): boolean => entry.issue.isPullRequest);
  if (prs.length > 0) {
    context.io.err(
      `nen: ${prs.map((entry): string => `#${entry.row.issue}`).join(", ")} name${prs.length === 1 ? "s" : ""} a pull request in ${target.slug}, not an issue; labels are applied to issues only. Nothing was written.`,
    );
    return 1;
  }

  // THE LEDGER IS OPENED FOR APPEND BEFORE THE FIRST MUTATION, and that one
  // descriptor serves every entry. A parent-directory check proves nothing about
  // the file: a directory named as the ledger, or an unwritable file, would pass
  // it and then fail AFTER the first edit -- a label applied with no ledger line
  // and the plan aborted half way. Opening it here refuses both at exit 2 while
  // nothing has changed. It is opened only when some row will be recorded, so a
  // refused or listed-only plan still leaves no ledger behind.
  const recorded = current.some(
    ({ row, issue }): boolean =>
      (!taxonomy.confidence.listed.includes(row.confidence) || includeLow) &&
      row.labels.some((label): boolean => !issue.labels.includes(label)),
  );
  let ledgerFd: number | null = null;
  if (recorded) {
    try {
      ledgerFd = openSync(ledgerPath, "a");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new VerbUsageError(
        `--ledger '${ledgerPath}' cannot be appended to${code === undefined ? "" : ` (${code})`}: a label applied with no ledger line is the one outcome this verb refuses, so nothing was written to GitHub.`,
      );
    }
  }

  try {
    return finishApply();
  } finally {
    if (ledgerFd !== null) closeSync(ledgerFd);
  }

  function finishApply(): number {
  const now = context.seams.now().toISOString();
  const object = (issue: number): string => `${target.slug}#${issue}`;
  const reasonFor = (row: PlanRow): string | null => {
    const parts = [row.reason, flagReason].filter((part): part is string => part !== null);
    return parts.length === 0 ? null : parts.join("; ");
  };
  const failures: string[] = [];
  // Every HUMAN line passes plainLine (gh's diagnostics are text nen did not
  // write); the --json document carries the raw data.
  const out = (line: string): void => context.io.out(plainLine(line));
  const err = (line: string): void => context.io.err(plainLine(line));

  const outcomes = current.map(({ row, issue }): IssueOutcome => {
    const outcome: IssueOutcome = { number: row.issue, applied: [], wouldApply: [], already: [], failed: [], listed: [] };
    if (taxonomy.confidence.listed.includes(row.confidence) && !includeLow) {
      outcome.listed.push(...row.labels);
      return outcome;
    }
    for (const label of row.labels) {
      if (issue.labels.includes(label)) {
        outcome.already.push(label);
        continue;
      }
      let result: LedgerEntry["outcome"] = "dry-run";
      if (run) {
        const argv = addLabelArgv(target, row.issue, label);
        const answered = context.seams.run(GH, [...argv]);
        if (answered.spawnFailed || answered.code !== 0) {
          result = "failed";
          failures.push(`${label} on #${row.issue}: ${outputLines(answered.stderr).at(-1) ?? `exit ${answered.code}`}`);
        } else {
          result = "applied";
        }
      }
      // AFTER the mutation resolves, never before: see the header.
      if (ledgerFd === null) throw new Error("unreachable: an application with no ledger descriptor");
      writeSync(
        ledgerFd,
        `${ledgerLine({ object: object(row.issue), label, time: now, outcome: result, reason: reasonFor(row) })}\n`,
      );
      if (result === "applied") outcome.applied.push(label);
      else if (result === "failed") outcome.failed.push(label);
      else outcome.wouldApply.push(label);
    }
    return outcome;
  });

  const totals = {
    issues: outcomes.length,
    applied: 0,
    wouldApply: 0,
    already: 0,
    failed: 0,
    listed: 0,
  };
  for (const outcome of outcomes) for (const bucket of BUCKETS) totals[bucket] += outcome[bucket].length;
  const exit = totals.failed === 0 ? 0 : 1;

  if (context.json) {
    context.io.out(
      JSON.stringify(
        { contract: "nen.classify.apply/v0.1", target: target.slug, run, ledger: ledgerPath, issues: outcomes, totals },
        null,
        2,
      ),
    );
    return exit;
  }

  if (!run) out("(dry run) nothing was written to GitHub; pass --run to apply.");
  const heading: Record<(typeof BUCKETS)[number], string> = {
    applied: "applied",
    wouldApply: "would apply",
    already: "already",
    failed: "failed",
    listed: "listed",
  };
  for (const outcome of outcomes) {
    const parts = BUCKETS.filter((bucket): boolean => outcome[bucket].length > 0).map(
      (bucket): string => `${heading[bucket]}: ${outcome[bucket].join(", ")}`,
    );
    out(`#${outcome.number}  ${parts.join("  ") || "nothing to apply"}`);
  }
  out(
    `${totals.issues} issue(s): ${totals.applied} applied, ${totals.wouldApply} would apply, ${totals.already} already, ${totals.failed} failed, ${totals.listed} listed`,
  );
  out(`ledger: ${ledgerPath}`);
  if (totals.failed > 0) {
    for (const failure of failures) err(`nen: could not apply ${failure}`);
    err(`nen: ${totals.failed} application(s) failed; the ledger records each as "failed".`);
  }
  return exit;
  }
}
