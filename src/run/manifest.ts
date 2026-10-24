// src/run/manifest.ts -- the run manifest (`nen.run/v0.1`): one batch run's
// identity, its launch-time idle answers, and every pull request it opened,
// whatever the base (Hatsu ruling HR-5; SDD plan findings D5, D4).
//
// WHY A FILE AND NOT A MEMORY. A futon or kazaana run's identity, its authored
// PR set and its `then` gate used to live in the conversation that ran it. The
// stacked-delivery ownership record exists only for non-main PRs, so a
// re-invoked run could not compute "every PR this run authored" -- the set its
// `then` gate and its final register both depend on. The manifest is that set,
// written as each PR opens, and read back live by `nen run verify`.
//
// WHERE IT LIVES. `<git-common-dir>/.nen/runs/<run-id>.json`: the git COMMON
// dir, so every worktree of one project reads and writes the same manifest,
// and a cleanup that removes an effort worktree cannot take the run's record
// with it (the loss SDD finding autonomy-loop#1 names for `.nen/loop/`). It is
// never under the work tree, so no `git add` can stage it. `.nen/` is nen's one
// root for its own records there (../ledger/roots.json), beside `.nen/loop/`
// and `.nen/stops/`; `hatsu/` stays the consumer's. A manifest an earlier build
// of this change wrote at `<git-common-dir>/hatsu/runs/` is moved once.
//
// FIELD MEANINGS MATCH HATSU'S RUN RECORD (hatsu.futon.run/v0.2) where both
// carry one: `head` is the head COMMIT and `branch` the head BRANCH name (Hatsu
// keeps the branch under `head`; nen names both), `issue` is the
// `<CODE>#<N>` string (the number is what follows `#`) and null for an
// integration or release PR, `repo` is the `owner/name` every PR lives in, and
// `parked[]` `{ issue, row, at }` is HR-5's park state. Which file Hatsu's
// `then` gate reads is Hatsu's to say. `nen run import` (./import.ts, NN#486
// AC-5) reads Hatsu's v0.2 manifest into this one, so one manifest owns the
// run and Hatsu's recorder can retire.
//
// NEN RECORDS AND READS; IT NEVER DECIDES. Nothing here chooses which PR a run
// may open, whether a gate passes, or what an idle answer means: start writes
// the launch answers it was handed, append records the PR it was told about,
// and the readers report.

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { withLedgerLock, writeLedgerAtomically } from "../ledger/lock.js";
import { RUNS_COMMON_SEGMENTS, RUNS_LEGACY_SEGMENTS } from "../ledger/roots.js";
import { loopIdSegment } from "../loop/ledger.js";
import { IDLE_RESOLUTIONS, type IdleResolution } from "../schema/workflow.js";

export const RUN_CONTRACT = "nen.run/v0.1";
/** Below the git common dir, forward-slashed; the segments are ../ledger/roots.json's data. */
export const RUN_MANIFEST_DIR: string = RUNS_COMMON_SEGMENTS.join("/");

export const RUN_KINDS = ["delivery", "integration", "release"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** KEY ORDER IS THE CONTRACT; ./manifest.test.ts pins it. */
export interface RunPr {
  /** The issue the PR delivers, as `<CODE>#<N>` or `<owner/name>#<N>`; null for an integration or release PR. */
  readonly issue: string | null;
  readonly pr: number;
  /** The base the PR was opened (or last recorded) against, read live. */
  readonly base: string;
  /** The PR's head branch, read live. */
  readonly branch: string;
  readonly kind: RunKind;
  /** The head commit last recorded for the PR, read live. */
  readonly head: string;
  /** The effort id its usage ledger is keyed by, or null when none was named. */
  readonly effort: string | null;
  readonly recordedAt: string;
}

/** One effort parked on an unanswered ask-once row (HR-5). KEY ORDER IS THE CONTRACT. */
export interface RunParked {
  readonly issue: string;
  readonly row: string;
  readonly at: string;
}

/** KEY ORDER IS THE CONTRACT; ./manifest.test.ts pins it. */
export interface RunManifest {
  readonly contract: typeof RUN_CONTRACT;
  readonly id: string;
  /** The `owner/name` every recorded PR lives in; `run verify --target` must name it. */
  readonly repo: string;
  readonly startedAt: string;
  /** The launch-time answers per ask-once row id (HR-5), or null when the run was started without them. */
  readonly idleAnswers: Readonly<Record<string, IdleResolution>> | null;
  readonly prs: readonly RunPr[];
  readonly parked: readonly RunParked[];
}

export class RunManifestError extends Error {}

/** The run id, or null when it is not one path segment (the loop ledger's own alphabet). */
export function runIdSegment(id: string): string | null {
  return loopIdSegment(id);
}

/** `<CODE>#<N>` or `<owner/name>#<N>`; anything else is not an issue reference. */
export const ISSUE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)?#[1-9][0-9]*$/;
/** A commit id: 7 to 40 hex digits. */
export const HEAD_SHA = /^[0-9a-f]{7,40}$/i;
/** A branch name as `git check-ref-format --branch` would mostly take it; refused rather than repaired. */
export const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]+(?<![./])$/;

/** An `owner/name` repository slug. */
export const REPO_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
/** An ask-once row id, as nen/decisions.json spells one. */
export const ROW_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The project's git common dir, absolute, or a refusal. Read through the seam
 * so a test scripts it; a checkout git cannot answer for is not a place to
 * keep a run. git is asked in the C locale with an inherited GIT_DIR,
 * GIT_COMMON_DIR and GIT_WORK_TREE dropped, as ../loop/home.ts asks it, so a
 * hook's or a wrapper's environment cannot point the manifest at another
 * repository's common dir (Phinks, delivery round on zheref/nen#498).
 */
export function gitCommonDir(seams: Seams, root: string): string {
  const result = seams.run(GIT, ["-C", root, "rev-parse", "--git-common-dir"], {
    env: { LC_ALL: "C", LANGUAGE: undefined, GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined },
  });
  const lines = outputLines(result.stdout);
  if (result.spawnFailed || result.code !== 0 || lines.length !== 1 || lines[0] === "") {
    throw new RunManifestError(
      `could not read the git common dir of '${root}' (git rev-parse --git-common-dir: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}). A run manifest lives there; nen does not fall back to the work tree, where a cleanup or a 'git add' could reach it.`,
    );
  }
  const line = lines[0] as string;
  return isAbsolute(line) ? line : resolve(root, line);
}

export function runManifestPath(commonDir: string, id: string): string {
  return join(commonDir, ...RUNS_COMMON_SEGMENTS, `${id}.json`);
}

/**
 * The manifest path for `id`, after moving a manifest an earlier build left at
 * a legacy spelling (`<common>/hatsu/runs/<id>.json`) to it once. A manifest at
 * both paths is refused: nen does not choose which record is the run.
 */
export function locateRunManifest(commonDir: string, id: string): { readonly path: string; readonly migratedFrom: string | null } {
  const path = runManifestPath(commonDir, id);
  const legacy = RUNS_LEGACY_SEGMENTS.map((segments): string => join(commonDir, ...segments, `${id}.json`)).filter((candidate): boolean => existsSync(candidate));
  if (legacy.length === 0) return { path, migratedFrom: null };
  if (existsSync(path) || legacy.length > 1) {
    throw new RunManifestError(`run '${id}' has a manifest in more than one place (${[...(existsSync(path) ? [path] : []), ...legacy].join(", ")}); nen will not choose which is the run. Keep one and move the others aside.`);
  }
  const from = legacy[0] as string;
  return withLedgerLock(path, () => {
    if (existsSync(path)) throw new RunManifestError(`run '${id}' appeared at ${path} while ${from} was being moved there; nen will not choose which is the run.`);
    mkdirSync(dirname(path), { recursive: true });
    renameSync(from, path);
    return { path, migratedFrom: from };
  });
}

/**
 * Parse `--idle-answers`: a JSON object from ask-once row id to one of the
 * HR-5 resolutions. Shape only -- whether each id names an ask-once row is
 * `nen schema check`'s `nen/workflow.json#idle` row's to say, against the
 * repository's own nen/decisions.json.
 */
export function parseIdleAnswers(text: string): Readonly<Record<string, IdleResolution>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RunManifestError(`--idle-answers is not JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RunManifestError("--idle-answers must be a JSON object from ask-once row id to default | hold | refuse.");
  }
  const answers: Record<string, IdleResolution> = {};
  for (const [row, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[a-z0-9-]+$/.test(row)) {
      throw new RunManifestError(`--idle-answers row id '${row}' is not [a-z0-9-]+, the spelling nen/decisions.json uses.`);
    }
    if (typeof value !== "string" || !(IDLE_RESOLUTIONS as readonly string[]).includes(value)) {
      throw new RunManifestError(`--idle-answers '${row}' is ${JSON.stringify(value)}; it must be one of ${IDLE_RESOLUTIONS.join(", ")} (HR-5).`);
    }
    answers[row] = value as IdleResolution;
  }
  return answers;
}

function fail(path: string, why: string): never {
  throw new RunManifestError(`'${path}' is not a ${RUN_CONTRACT} manifest: ${why}. A manifest nen cannot read is never rewritten over and never read as an empty run; move it aside.`);
}

/** Validate a stored manifest field by field; a document this build did not write is refused, never coerced. */
export function parseRunManifest(path: string, value: unknown): RunManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "not a JSON object");
  const record = value as Record<string, unknown>;
  if (record["contract"] !== RUN_CONTRACT) fail(path, `contract is ${JSON.stringify(record["contract"])}`);
  const id = record["id"];
  if (typeof id !== "string" || runIdSegment(id) === null) fail(path, "id is not a run id");
  const startedAt = record["startedAt"];
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) fail(path, "startedAt is not an ISO-8601 instant");
  let idleAnswers: Readonly<Record<string, IdleResolution>> | null = null;
  if (record["idleAnswers"] !== null) {
    try {
      idleAnswers = parseIdleAnswers(JSON.stringify(record["idleAnswers"] ?? "missing"));
    } catch (error) {
      fail(path, `idleAnswers: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const repo = record["repo"];
  if (typeof repo !== "string" || !REPO_SLUG.test(repo)) fail(path, "repo is not an owner/name slug");
  const prs = record["prs"];
  if (!Array.isArray(prs)) fail(path, "prs is not an array");
  const parsed: RunPr[] = prs.map((entry, index): RunPr => {
    if (typeof entry !== "object" || entry === null) fail(path, `prs[${index}] is not an object`);
    const pr = entry as Record<string, unknown>;
    const str = (key: string, pattern: RegExp): string => {
      const v = pr[key];
      if (typeof v !== "string" || !pattern.test(v)) fail(path, `prs[${index}].${key} is ${JSON.stringify(v)}`);
      return v;
    };
    const number = pr["pr"];
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) fail(path, `prs[${index}].pr is not a pull request number`);
    const kind = pr["kind"];
    if (typeof kind !== "string" || !(RUN_KINDS as readonly string[]).includes(kind)) fail(path, `prs[${index}].kind is ${JSON.stringify(kind)}`);
    const issue = pr["issue"];
    if (issue === null ? kind === "delivery" : typeof issue !== "string" || !ISSUE_REF.test(issue)) fail(path, `prs[${index}].issue is ${JSON.stringify(issue)}`);
    const effort = pr["effort"];
    if (effort !== null && typeof effort !== "string") fail(path, `prs[${index}].effort is neither a string nor null`);
    const recordedAt = pr["recordedAt"];
    if (typeof recordedAt !== "string" || Number.isNaN(Date.parse(recordedAt))) fail(path, `prs[${index}].recordedAt is not an ISO-8601 instant`);
    return {
      issue: issue as string | null,
      pr: number,
      base: str("base", BRANCH_NAME),
      branch: str("branch", BRANCH_NAME),
      kind: kind as RunKind,
      head: str("head", HEAD_SHA),
      effort: effort as string | null,
      recordedAt,
    };
  });
  const rawParked = record["parked"];
  if (!Array.isArray(rawParked)) fail(path, "parked is not an array");
  const parked: RunParked[] = rawParked.map((entry, index): RunParked => {
    if (typeof entry !== "object" || entry === null) fail(path, `parked[${index}] is not an object`);
    const row = entry as Record<string, unknown>;
    if (typeof row["issue"] !== "string" || !ISSUE_REF.test(row["issue"])) fail(path, `parked[${index}].issue is ${JSON.stringify(row["issue"])}`);
    if (typeof row["row"] !== "string" || !ROW_ID.test(row["row"])) fail(path, `parked[${index}].row is ${JSON.stringify(row["row"])}`);
    if (typeof row["at"] !== "string" || Number.isNaN(Date.parse(row["at"]))) fail(path, `parked[${index}].at is not an ISO-8601 instant`);
    return { issue: row["issue"], row: row["row"], at: row["at"] };
  });
  return { contract: RUN_CONTRACT, id: id as string, repo, startedAt: startedAt as string, idleAnswers, prs: parsed, parked };
}

/** The manifest on disk, or null when there is none. Unreadable is a refusal, never null. */
export function readRunManifest(path: string): RunManifest | null {
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(path, `not readable JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return parseRunManifest(path, value);
}

/** No answers and an empty answer map say the same thing; key order never matters. */
const answerKey = (a: RunManifest["idleAnswers"]): string => JSON.stringify(Object.entries(a ?? {}).sort());
const sameAnswers = (a: RunManifest["idleAnswers"], b: RunManifest["idleAnswers"]): boolean => answerKey(a) === answerKey(b);

export type StartOutcome =
  | { readonly outcome: "started" | "existing"; readonly manifest: RunManifest }
  | { readonly outcome: "conflict"; readonly manifest: RunManifest; readonly reason: string };

/**
 * What `run start` does to what is on disk -- pure, so the branches are data.
 *
 * A RE-START WITH THE SAME ANSWERS IS THE RESUME, and is `existing` at exit 0:
 * a re-invoked batch must be able to call start again without knowing whether
 * its first session got that far. A re-start with DIFFERENT answers is a
 * conflict: HR-5 records the batch resolution at launch, and an answer a later
 * session could rewrite would not be a launch answer.
 */
export function planStart(existing: RunManifest | null, id: string, repo: string, now: string, idleAnswers: RunManifest["idleAnswers"]): StartOutcome {
  if (existing === null) {
    return { outcome: "started", manifest: { contract: RUN_CONTRACT, id, repo, startedAt: now, idleAnswers, prs: [], parked: [] } };
  }
  if (existing.repo.toLowerCase() !== repo.toLowerCase()) {
    return { outcome: "conflict", manifest: existing, reason: `run '${id}' was started for ${existing.repo}, not ${repo}; one run lives in one repository.` };
  }
  if (sameAnswers(existing.idleAnswers, idleAnswers)) return { outcome: "existing", manifest: existing };
  return {
    outcome: "conflict",
    manifest: existing,
    reason: `run '${id}' was started at ${existing.startedAt} with other idle answers (${JSON.stringify(existing.idleAnswers)}); launch answers are fixed at start (HR-5) -- start a new run id to answer differently.`,
  };
}

export interface AppendInput {
  readonly issue: string | null;
  readonly pr: number;
  readonly base: string;
  readonly branch: string;
  readonly kind: RunKind;
  readonly head: string;
  readonly effort: string | null;
  readonly now: string;
}

export type AppendOutcome =
  | { readonly outcome: "appended" | "unchanged"; readonly manifest: RunManifest; readonly entry: RunPr }
  | { readonly outcome: "updated"; readonly manifest: RunManifest; readonly entry: RunPr; readonly previous: RunPr }
  | { readonly outcome: "conflict"; readonly manifest: RunManifest; readonly previous: RunPr; readonly reason: string };

/**
 * What `run append` does to a manifest -- pure.
 *
 * ONE ROW PER PULL REQUEST. Recording the same PR again is how a retry after a
 * partial failure stays safe: the same facts are `unchanged`; a moved head or
 * a retargeted base (catch-up, a stack collapsing onto its integration branch)
 * is `updated`, the previous row kept in the report. A different ISSUE or
 * KIND for a PR already recorded is a conflict -- one of the two callers is
 * wrong about which PR it opened, and nen cannot tell which. A changed effort
 * id is a conflict for the same reason, unless the row had none.
 */
export function planAppend(manifest: RunManifest, input: AppendInput): AppendOutcome {
  const previous = manifest.prs.find((entry): boolean => entry.pr === input.pr);
  if (previous === undefined) {
    const entry: RunPr = { issue: input.issue, pr: input.pr, base: input.base, branch: input.branch, kind: input.kind, head: input.head, effort: input.effort, recordedAt: input.now };
    return { outcome: "appended", manifest: { ...manifest, prs: [...manifest.prs, entry] }, entry };
  }
  const clashes: string[] = [];
  if (previous.issue !== input.issue) clashes.push(`issue ${previous.issue ?? "none"} -> ${input.issue ?? "none"}`);
  if (previous.kind !== input.kind) clashes.push(`kind ${previous.kind} -> ${input.kind}`);
  if (previous.effort !== null && input.effort !== null && previous.effort !== input.effort) clashes.push(`effort ${previous.effort} -> ${input.effort}`);
  if (clashes.length > 0) {
    return {
      outcome: "conflict",
      manifest,
      previous,
      reason: `PR #${input.pr} is already recorded in run '${manifest.id}' with other facts (${clashes.join("; ")}). A PR delivers one issue as one kind; nen will not pick which record is right.`,
    };
  }
  const effort = input.effort ?? previous.effort;
  if (previous.head.toLowerCase() === input.head.toLowerCase() && previous.base === input.base && previous.branch === input.branch && previous.effort === effort) {
    return { outcome: "unchanged", manifest, entry: previous };
  }
  const entry: RunPr = { ...previous, base: input.base, branch: input.branch, head: input.head, effort, recordedAt: input.now };
  return {
    outcome: "updated",
    manifest: { ...manifest, prs: manifest.prs.map((row): RunPr => (row.pr === input.pr ? entry : row)) },
    entry,
    previous,
  };
}

export type ParkOutcome =
  | { readonly outcome: "parked" | "unchanged"; readonly manifest: RunManifest; readonly entry: RunParked };

/**
 * What `run park` does to a manifest -- pure. An effort parked on a row is
 * recorded once; parking it on the same row again is `unchanged` (the retry).
 */
export function planPark(manifest: RunManifest, issue: string, row: string, now: string): ParkOutcome {
  const previous = manifest.parked.find((entry): boolean => entry.issue === issue && entry.row === row);
  if (previous !== undefined) return { outcome: "unchanged", manifest, entry: previous };
  const entry: RunParked = { issue, row, at: now };
  return { outcome: "parked", manifest: { ...manifest, parked: [...manifest.parked, entry] }, entry };
}

/** Read-plan-write under the shared ledger lock, so two appends at once never drop a row. */
export function withManifest<T extends { readonly manifest: RunManifest; readonly outcome: string }>(
  path: string,
  plan: (existing: RunManifest | null) => T,
  write: boolean,
): T {
  const body = (): T => {
    const outcome = plan(readRunManifest(path));
    if (write && outcome.outcome !== "conflict" && outcome.outcome !== "existing" && outcome.outcome !== "unchanged") {
      writeLedgerAtomically(path, outcome.manifest);
    }
    return outcome;
  };
  return write ? withLedgerLock(path, body) : body();
}
