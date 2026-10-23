// src/run/import.ts -- `nen run import`: the consumer plane's futon run
// manifest (the contracts ./imports.json lists) read into nen's own run
// manifest (`nen.run/v0.1`), so ONE manifest owns a batch run (zheref/nen#486
// AC-5) and the consumer can retire its second one.
//
// WHERE IT READS. `<git-common-dir>/<imports.dir>/<imports.file>` -- the file
// the consumer's run recorder writes, named in ./imports.json because a
// consumer's name is data here -- or the file `--from` names. It READS that
// file and never writes, moves or deletes it: that directory is the consumer
// plane's namespace (../ledger/roots.json), and which record the consumer's
// `then` gate reads is the consumer's to switch.
//
// WHAT IT WRITES. `<git-common-dir>/.nen/runs/<id>.json`, through the same
// plans `run start`, `run append` and `run park` use, so an import is exactly
// the start, appends and parks the run would have recorded:
//   * `repo`, `startedAt` copied; `idleAnswers` from `idle.decisions[]`
//     (`{ row, resolution }` -> `{ row: resolution }`), null when the run had
//     no idle profile;
//   * every `prs[]` row `{ issue, pr, base, kind, head }` READ LIVE, as append
//     reads it: the consumer keeps the head BRANCH under `head` and no commit, so the
//     commit, branch and base recorded are GitHub's; the issue NUMBER becomes
//     `<owner/name>#<N>` (null for an integration or release PR); `effort` is
//     null (the consumer's manifest names none);
//   * every `parked[]` row `{ issue, row, at }`, the issue spelled the same way.
// A PR gh cannot read, one created before the run started, or a fact that
// disagrees with a row nen already holds, refuses the WHOLE import at exit 1
// and writes nothing: a manifest half-imported is a run whose PR set is wrong.
// Importing again is idempotent: the same facts are `unchanged`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Seams } from "../seam/exec.js";
import { IDLE_RESOLUTIONS, type IdleResolution } from "../schema/workflow.js";
import {
  planAppend,
  planPark,
  planStart,
  REPO_SLUG,
  ROW_ID,
  RUN_KINDS,
  RunManifestError,
  type RunKind,
  type RunManifest,
} from "./manifest.js";
import { readLivePr } from "./verify.js";
import { normaliseManifest } from "./issue.js";
import imports from "./imports.json";

/** The contracts a consumer run manifest may carry (./imports.json). */
export const CONSUMER_RUN_CONTRACTS: readonly string[] = imports.contracts;
/** The one of them that carries `prs[]` and `parked[]`. */
const MANIFEST_CONTRACT: string = imports.manifestContract;
const CONSUMER_ID = new RegExp(imports.idPattern);

/** Where the consumer's recorder keeps a run, below the git common dir. Read only. */
export function consumerRunPath(commonDir: string, id: string): string {
  return join(commonDir, ...imports.dir, imports.file.replace("{id}", id));
}

/** The consumer directory's display form, for a help text. */
export const CONSUMER_RUN_DISPLAY = `<git-common-dir>/${imports.dir.join("/")}/${imports.file.replace("{id}", "<id>")}`;

export interface ConsumerRun {
  readonly contract: string;
  readonly id: string;
  readonly repo: string;
  readonly startedAt: string;
  readonly idleAnswers: Readonly<Record<string, IdleResolution>> | null;
  readonly prs: readonly { readonly issue: number | null; readonly pr: number; readonly base: string; readonly kind: RunKind; readonly branch: string }[];
  readonly parked: readonly { readonly issue: number; readonly row: string; readonly at: string }[];
}

/** Validate a Hatsu run document field by field; anything this reader does not know is refused, never coerced. */
export function parseConsumerRun(path: string, value: unknown): ConsumerRun {
  const fail = (why: string): never => {
    throw new RunManifestError(`'${path}' is not a consumer run manifest nen can import: ${why}. Nothing was written.`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("not a JSON object");
  const run = value as Record<string, unknown>;
  const contract = run["contract"];
  if (typeof contract !== "string" || !CONSUMER_RUN_CONTRACTS.includes(contract)) return fail(`contract is ${JSON.stringify(contract)}, not ${CONSUMER_RUN_CONTRACTS.join(" or ")}`);
  const id = run["id"];
  if (typeof id !== "string" || !CONSUMER_ID.test(id)) return fail(`id is not a run id (${imports.idPattern})`);
  const repo = run["repo"];
  if (typeof repo !== "string" || !REPO_SLUG.test(repo)) return fail("repo is not an owner/name slug");
  const startedAt = run["startedAt"];
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return fail("startedAt is not an ISO-8601 instant");
  const v2 = contract === MANIFEST_CONTRACT;
  let idleAnswers: Record<string, IdleResolution> | null = null;
  const idle = run["idle"];
  if (v2 && idle !== null && idle !== undefined) {
    const decisions = (idle as { decisions?: unknown }).decisions;
    if (typeof idle !== "object" || !Array.isArray(decisions)) return fail("idle.decisions is not an array");
    idleAnswers = {};
    for (const [index, entry] of (decisions as unknown[]).entries()) {
      const row = (entry as { row?: unknown } | null)?.row;
      const resolution = (entry as { resolution?: unknown } | null)?.resolution;
      if (typeof row !== "string" || !ROW_ID.test(row)) return fail(`idle.decisions[${index}].row is ${JSON.stringify(row)}`);
      if (typeof resolution !== "string" || !(IDLE_RESOLUTIONS as readonly string[]).includes(resolution)) return fail(`idle.decisions[${index}].resolution is ${JSON.stringify(resolution)}`);
      idleAnswers[row] = resolution as IdleResolution;
    }
  }
  const rawPrs = v2 ? run["prs"] : [];
  if (!Array.isArray(rawPrs)) return fail("prs is not an array");
  const prs = rawPrs.map((entry: unknown, index: number): ConsumerRun["prs"][number] => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const pr = row["pr"];
    if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1) return fail(`prs[${index}].pr is not a pull request number`);
    const kind = row["kind"];
    if (typeof kind !== "string" || !(RUN_KINDS as readonly string[]).includes(kind)) return fail(`prs[${index}].kind is ${JSON.stringify(kind)}`);
    const issue = row["issue"];
    if (issue === null ? kind === "delivery" : typeof issue !== "number" || !Number.isSafeInteger(issue) || issue < 1) return fail(`prs[${index}].issue is ${JSON.stringify(issue)}`);
    const base = row["base"];
    const branch = row["head"];
    if (typeof base !== "string" || base === "") return fail(`prs[${index}].base is ${JSON.stringify(base)}`);
    if (typeof branch !== "string" || branch === "") return fail(`prs[${index}].head is ${JSON.stringify(branch)}`);
    return { issue: issue as number | null, pr, base, kind: kind as RunKind, branch };
  });
  const rawParked = v2 ? run["parked"] : [];
  if (!Array.isArray(rawParked)) return fail("parked is not an array");
  const parked = rawParked.map((entry: unknown, index: number): ConsumerRun["parked"][number] => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const issue = row["issue"];
    if (typeof issue !== "number" || !Number.isSafeInteger(issue) || issue < 1) return fail(`parked[${index}].issue is ${JSON.stringify(issue)}`);
    if (typeof row["row"] !== "string" || !ROW_ID.test(row["row"])) return fail(`parked[${index}].row is ${JSON.stringify(row["row"])}`);
    if (typeof row["at"] !== "string" || Number.isNaN(Date.parse(row["at"]))) return fail(`parked[${index}].at is not an ISO-8601 instant`);
    return { issue, row: row["row"], at: row["at"] };
  });
  return { contract, id, repo, startedAt, idleAnswers, prs, parked };
}

/** The consumer run on disk, or a refusal. Missing is a refusal too: an import of nothing imports nothing. */
export function readConsumerRun(path: string): ConsumerRun {
  if (!existsSync(path)) throw new RunManifestError(`no consumer run manifest at ${path}. Nothing was written.`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new RunManifestError(`'${path}' is not readable JSON (${error instanceof Error ? error.message : String(error)}). Nothing was written.`);
  }
  return parseConsumerRun(path, value);
}

export interface ImportOutcome {
  readonly outcome: "imported" | "unchanged" | "conflict";
  readonly manifest: RunManifest;
  readonly reason: string | null;
  /** Per PR: what the append plan did. */
  readonly prs: readonly { readonly pr: number; readonly outcome: string }[];
  readonly parked: readonly { readonly issue: string; readonly outcome: string }[];
}

/**
 * Plan the import against what nen holds -- every PR read live first, so a
 * refusal happens before anything is planned, let alone written.
 */
export function planImport(seams: Seams, existing: RunManifest | null, run: ConsumerRun, id: string, now: string, root: string): ImportOutcome {
  // ONE SPELLING (Bugbot on #516): rows nen already holds in a `<CODE>#<N>`
  // spelling are normalised first, so the import's `<owner/name>#<N>` rows
  // match them rather than parking or appending the same issue twice.
  const normalised = existing === null ? null : normaliseManifest(root, existing);
  const [owner, name] = run.repo.split("/") as [string, string];
  const target = { owner, repo: name, slug: run.repo };
  const ref = (issue: number): string => `${run.repo}#${issue}`;
  const start = planStart(normalised === null ? null : normalised.manifest, id, run.repo, run.startedAt, run.idleAnswers);
  if (start.outcome === "conflict") return { outcome: "conflict", manifest: start.manifest, reason: start.reason, prs: [], parked: [] };
  let manifest = start.manifest;
  let changed = start.outcome === "started" || normalised?.changed === true;
  const prs: { pr: number; outcome: string }[] = [];
  for (const row of run.prs) {
    const live = readLivePr(seams, target, row.pr);
    if (!live.ok) throw new RunManifestError(`could not read ${run.repo}#${row.pr}: ${live.reason}. A PR nen could not read is never recorded; nothing was written.`);
    if (live.pr.createdAt === null) throw new RunManifestError(`${run.repo}#${row.pr}: gh did not say when it was created; nothing was written.`);
    if (Date.parse(live.pr.createdAt) < Date.parse(run.startedAt)) {
      throw new RunManifestError(`${run.repo}#${row.pr} was created at ${live.pr.createdAt}, before run '${id}' started at ${run.startedAt}; nothing was written.`);
    }
    const planned = planAppend(manifest, { issue: row.issue === null ? null : ref(row.issue), pr: row.pr, base: live.pr.base, branch: live.pr.headRef, kind: row.kind, head: live.pr.head, effort: null, now });
    if (planned.outcome === "conflict") return { outcome: "conflict", manifest, reason: planned.reason, prs, parked: [] };
    manifest = planned.manifest;
    changed ||= planned.outcome !== "unchanged";
    prs.push({ pr: row.pr, outcome: planned.outcome });
  }
  const parked: { issue: string; outcome: string }[] = [];
  for (const row of run.parked) {
    const planned = planPark(manifest, ref(row.issue), row.row, row.at);
    manifest = planned.manifest;
    changed ||= planned.outcome !== "unchanged";
    parked.push({ issue: ref(row.issue), outcome: planned.outcome });
  }
  return { outcome: changed ? "imported" : "unchanged", manifest, reason: null, prs, parked };
}
