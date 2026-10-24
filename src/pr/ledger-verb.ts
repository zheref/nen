// src/pr/ledger-verb.ts -- `nen pr ledger post|read` (zheref/nen#510), the verb
// half of ./ledger.ts.
//
// post: assemble the slice from the effort's DURABLE ledgers (the phase and
// usage ledgers at `<git-common-dir>/.nen/`, ../ledger/home.ts), the caller's
// findings file validated against the caller's schema (../schema/jsonschema.ts;
// a failure is exit 1 naming the JSON pointer, nothing posted), and each
// --proof file's sha256 and size; render it; run the private-name guard; then
// post it, or edit this login's one marked comment in place, or say
// `unchanged` when the bytes are already there. Too large for a GitHub comment
// is exit 1 naming both sizes -- never truncated.
//
// read: this login's one marked comment for the effort, parsed and checked:
// `ok` when its head is the PR's head, `stale` when the PR moved on,
// `could-not-read` when there is no such comment, or it was edited, or it does
// not parse -- distinct from a slice whose phases are empty. Marked comments
// by any other login are counted as `foreign` and never read. --restore writes
// the slice's phases as the effort's phase ledger when there is none; a local
// ledger that disagrees is refused naming both.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { emit, VerbUsageError, type CommandContext } from "../cli/command.js";
import { readTextFile, resolveAgainstRepo } from "../cli/inputs.js";
import type { Target } from "../github/target.js";
import { blockingExit, blocksWrite } from "../issue/privacy.js";
import { guardPrivateNames, PRIVATE_NAME_FLAGS, readIgnoreFlag } from "../issue/privacyguard.js";
import { assertEffortId } from "../ledger/effort.js";
import { legacyLine, locateEffortLedger, resolveEffortHome } from "../ledger/home.js";
import { PHASE_CONTRACT, readLedger, withLedgerLock, writeLedger, type PhaseEntry } from "../phase/ledger.js";
import { scanContentSecrets } from "../security/secrets.js";
import { resolveRepoRoot } from "../repo/root.js";
import { UnsupportedSchemaError, validateJsonSchema } from "../schema/jsonschema.js";
import { totalsOf } from "../usage/command.js";
import { readUsageLedger } from "../usage/ledger.js";
import {
  GITHUB_COMMENT_LIMIT,
  isMarkedFor,
  isOwn,
  LedgerReadError,
  listComments,
  parseComment,
  PR_LEDGER_CONTRACT,
  readLogin,
  readPrHead,
  renderComment,
  sha256Hex,
  writeArgv,
  writeComment,
  type LedgerSlice,
  type ProofEntry,
} from "./ledger.js";

export const LEDGER_ACTIONS = ["post", "read"] as const;
/** The flags each action reads beyond --target, --pr and --effort. */
export const LEDGER_ACTION_FLAGS: Readonly<Record<(typeof LEDGER_ACTIONS)[number], { values: readonly string[]; booleans: readonly string[]; lists: readonly string[] }>> = {
  post: { values: ["findings", "findings-schema", "login", ...PRIVATE_NAME_FLAGS.values], booleans: ["dry-run", ...PRIVATE_NAME_FLAGS.booleans], lists: ["proof"] },
  read: { values: ["login"], booleans: ["restore"], lists: [] },
};

export type ReadVerdict = "ok" | "stale" | "could-not-read";

/** --login when given (a token that cannot read `user`), else the authenticated login. */
function loginFor(context: CommandContext): string {
  const flag = context.args.values["login"];
  if (flag !== undefined) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(flag)) throw new VerbUsageError(`--login '${flag}' is not a GitHub login.`);
    return flag;
  }
  return readLogin(context.seams);
}

export function ledgerVerb(context: CommandContext, target: Target, pr: number): number {
  const action = context.args.positionals[2];
  if (action !== "post" && action !== "read") {
    throw new VerbUsageError(`'pr ledger' needs an action: ${LEDGER_ACTIONS.join(", ")}. Try 'nen pr ledger read --target <owner/name> --pr <n> --effort <id>'.`);
  }
  const own = LEDGER_ACTION_FLAGS[action];
  const other = LEDGER_ACTION_FLAGS[action === "post" ? "read" : "post"];
  for (const flag of [...other.values, ...other.lists, ...other.booleans]) {
    if (own.values.includes(flag) || own.booleans.includes(flag) || own.lists.includes(flag)) continue;
    const given = context.args.values[flag] !== undefined || (context.args.lists[flag] ?? []).length > 0 || context.args.booleans.has(flag);
    if (given) throw new VerbUsageError(`--${flag} is not read by 'pr ledger ${action}'; it is 'pr ledger ${action === "post" ? "read" : "post"}''s.`);
  }
  const effortRaw = context.args.values["effort"];
  if (effortRaw === undefined || effortRaw.trim() === "") throw new VerbUsageError("--effort <id> is required: the effort whose ledger slice this is.");
  const effort = assertEffortId(effortRaw);
  return action === "post" ? post(context, target, pr, effort) : read(context, target, pr, effort);
}

function readFindings(context: CommandContext, root: string): LedgerSlice["findings"] {
  const findingsFlag = context.args.values["findings"];
  const schemaFlag = context.args.values["findings-schema"];
  if (findingsFlag === undefined && schemaFlag === undefined) return null;
  if (findingsFlag === undefined || schemaFlag === undefined) {
    throw new VerbUsageError("--findings and --findings-schema go together: nen carries no consumer's findings contract, so a findings file is posted only once the caller's own schema has checked it.");
  }
  const parse = (flag: string, path: string): { text: string; value: unknown } => {
    const text = readTextFile(path, root, `--${flag} names a file this verb validates and posts; an unreadable one is refused rather than posted as nothing.`, true);
    try {
      return { text, value: JSON.parse(text) as unknown };
    } catch (error) {
      throw new VerbUsageError(`--${flag} '${path}' is not JSON (${error instanceof Error ? error.message : String(error)}).`);
    }
  };
  const schema = parse("findings-schema", schemaFlag);
  const findings = parse("findings", findingsFlag);
  let violations;
  try {
    violations = validateJsonSchema(schema.value, findings.value);
  } catch (error) {
    if (error instanceof UnsupportedSchemaError) throw new VerbUsageError(`--findings-schema '${schemaFlag}': ${error.message}`);
    throw error;
  }
  if (violations.length > 0) {
    const first = violations[0]!;
    throw new FindingsInvalid(`--findings '${findingsFlag}' fails --findings-schema at ${first.pointer === "" ? "/" : first.pointer}: ${first.message} (schema ${first.schemaPointer || "/"}). ${violations.length} violation(s) in all; nothing was posted.`, violations.length);
  }
  const id = (schema.value as { $id?: unknown } | null)?.$id;
  return { schema: { id: typeof id === "string" ? id : null, sha256: sha256Hex(schema.text) }, document: findings.value };
}

class FindingsInvalid extends Error {
  constructor(message: string, readonly count: number) {
    super(message);
  }
}

function readProof(context: CommandContext, root: string): readonly ProofEntry[] {
  return (context.args.lists["proof"] ?? []).map((given): ProofEntry => {
    const full = resolveAgainstRepo(root, given);
    // REPO-RELATIVE ONLY (Feitan on #518, SEC-8): an absolute path names the
    // machine's layout (the home directory's user) on a PR anyone may read.
    const path = relative(root, full).split(sep).join("/");
    if (path === "" || path.startsWith("..") || isAbsolute(path)) throw new VerbUsageError(`--proof '${given}' is outside --repo; a proof index names files in the repository, as repository-relative paths.`);
    let bytes: Buffer;
    try {
      bytes = readFileSync(full);
    } catch (error) {
      throw new VerbUsageError(`--proof '${given}' could not be read (${(error as NodeJS.ErrnoException).code ?? String(error)}); a proof index names files that exist.`);
    }
    return { path, sha256: sha256Hex(bytes), bytes: bytes.length };
  });
}

/**
 * Every CALLER-SUPPLIED text in the slice, by field: the effort id, each phase's
 * name, surface, model, dial, note and step verb and argv, each usage total's
 * surface and model, the findings schema's `$id`, the findings document and the
 * proof paths. The marker, the summary
 * line and the contract keys are nen's own words and are never in this list
 * (Bugbot on #518): the private-name guard and the secret scan judge what the
 * caller wrote, so nen's boilerplate can neither trip nor hide a hit.
 */
function callerFields(slice: LedgerSlice): readonly { field: string; text: string }[] {
  const fields: { field: string; text: string }[] = [{ field: "effort", text: slice.effort }];
  slice.phases.forEach((phase, index): void => {
    const at = `phases[${index}]`;
    fields.push({ field: `${at}.phase`, text: phase.phase });
    for (const key of ["surface", "model", "dial", "note"] as const) {
      const value = phase[key];
      if (typeof value === "string") fields.push({ field: `${at}.${key}`, text: value });
    }
    (phase.steps ?? []).forEach((step, stepAt): void => {
      fields.push({ field: `${at}.steps[${stepAt}].verb`, text: step.verb });
      fields.push({ field: `${at}.steps[${stepAt}].argv`, text: step.argv });
    });
  });
  slice.usage.totals.forEach((total, index): void => {
    fields.push({ field: `usage.totals[${index}].surface`, text: total.surface });
    if (total.model !== null) fields.push({ field: `usage.totals[${index}].model`, text: total.model });
  });
  if (slice.findings !== null) {
    // The caller schema's `$id` is printed twice -- in the summary line and in
    // the fence -- so it is the caller's text too (Nobunaga delta on #518).
    if (slice.findings.schema.id !== null) fields.push({ field: "findings.schema.id", text: slice.findings.schema.id });
    fields.push({ field: "findings.document", text: JSON.stringify(slice.findings.document, null, 2) });
  }
  slice.proof.forEach((entry, index): void => { fields.push({ field: `proof[${index}].path`, text: entry.path }); });
  return fields;
}

/** Every credential shape in the caller's text, by field (../security/secrets.ts's scanner). */
function secretHits(slice: LedgerSlice): readonly { field: string; shapes: readonly string[] }[] {
  return callerFields(slice).map(({ field, text }) => ({ field, shapes: scanContentSecrets(text) })).filter((hit): boolean => hit.shapes.length > 0);
}

/** Step argv and notes with the repository root spelt `.` (SEC-8): the comment names no machine's layout. */
function relativisePhases(phases: readonly PhaseEntry[], root: string): readonly PhaseEntry[] {
  const roots = [root];
  try {
    const real = realpathSync(root);
    if (real !== root) roots.push(real);
  } catch {
    // the root that was resolved is the only spelling there is
  }
  const strip = (text: string): string => roots.reduce((out, prefix): string => out.split(prefix).join("."), text);
  return phases.map((phase): PhaseEntry => ({
    ...phase,
    note: phase.note === null ? null : strip(phase.note),
    ...(phase.steps === undefined ? {} : { steps: phase.steps.map((step) => ({ ...step, argv: strip(step.argv) })) }),
  }));
}

function post(context: CommandContext, target: Target, pr: number, effort: string): number {
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const ignore = readIgnoreFlag(context);
  const dryRun = context.args.booleans.has("dry-run");
  let findings: LedgerSlice["findings"];
  try {
    findings = readFindings(context, root);
  } catch (error) {
    if (!(error instanceof FindingsInvalid)) throw error;
    context.io.err(`nen pr ledger post: ${error.message}`);
    emit(context.io, context.json, { contract: PR_LEDGER_CONTRACT, verdict: "findings-invalid", posted: false, violations: error.count }, []);
    return 1;
  }
  const proof = readProof(context, root);
  const phaseLocated = locateEffortLedger(resolveEffortHome(root, "phases", context.seams), effort, "read");
  const usageLocated = locateEffortLedger(resolveEffortHome(root, "usage", context.seams), effort, "read");
  for (const located of [phaseLocated, usageLocated]) {
    const line = legacyLine(located);
    if (line !== null) context.io.err(`nen pr ledger post: ${line}`);
  }
  const phases = relativisePhases(readLedger(phaseLocated.path, effort).phases, root);
  const usage = readUsageLedger(usageLocated.path, effort);
  let head: string;
  let login: string;
  let existing: { id: number; body: string; url: string } | null;
  try {
    head = readPrHead(context.seams, target, pr);
    login = loginFor(context);
    const mine = listComments(context.seams, target, pr).filter((comment): boolean => isMarkedFor(comment.body, effort) && comment.login === login);
    const tampered = mine.filter((comment): boolean => !isOwn(comment, login));
    if (tampered.length > 0) {
      throw new LedgerReadError(`${tampered.map((c): string => c.url).join(", ")}: this login's ledger comment for effort '${effort}' was last edited by ${tampered.map((c): string => c.editor ?? "?").join(", ")}; nen will not edit over another login's edit. Delete it and post again.`);
    }
    if (mine.length > 1) {
      throw new LedgerReadError(`${target.slug}#${pr} carries ${mine.length} ledger comments for effort '${effort}' by ${login} (${mine.map((c): string => c.url).join(", ")}); nen will not choose which is the record. Delete all but one and post again.`);
    }
    existing = mine[0] ?? null;
  } catch (error) {
    if (!(error instanceof LedgerReadError)) throw error;
    context.io.err(`nen pr ledger post: ${error.message}`);
    return 1;
  }
  const slice: LedgerSlice = {
    contract: PR_LEDGER_CONTRACT,
    effort,
    repo: target.slug,
    pr,
    head,
    phases,
    usage: { entries: usage.entries.length, totals: totalsOf(usage) },
    findings,
    proof,
  };
  const body = renderComment(slice);
  const size = body.length;
  if (size > GITHUB_COMMENT_LIMIT) {
    context.io.err(`nen pr ledger post: the slice renders to ${size} characters, over GitHub's ${GITHUB_COMMENT_LIMIT}-character comment limit; it is never truncated, so nothing was posted. Post fewer --proof files or a smaller findings file.`);
    emit(context.io, context.json, { contract: PR_LEDGER_CONTRACT, verdict: "too-large", posted: false, size, limit: GITHUB_COMMENT_LIMIT }, []);
    return 1;
  }
  // NO CREDENTIAL'S SHAPE REACHES THE PR (Feitan on #518, SEC-1): the findings,
  // every phase note and step argv, and the proof paths are scanned, and a hit
  // refuses the post naming the shape and the field -- never the value.
  const secrets = secretHits(slice);
  if (secrets.length > 0) {
    context.io.err(`nen pr ledger post: the slice carries a credential's shape (${secrets.map((hit): string => `${hit.field}: ${hit.shapes.join(", ")}`).join("; ")}; values redacted); it would be posted to the PR, so nothing was posted.`);
    emit(context.io, context.json, { contract: PR_LEDGER_CONTRACT, verdict: "secret-shape", posted: false, secrets }, []);
    return 1;
  }
  const guard = guardPrivateNames(context, target, callerFields(slice), ignore, "nen pr ledger post");
  if (blocksWrite(guard)) {
    emit(context.io, context.json, { contract: PR_LEDGER_CONTRACT, verdict: "refused", posted: false, privateNameCheck: guard }, []);
    return blockingExit(guard);
  }
  // UNCHANGED BY DIGEST, not by raw bytes: GitHub may normalise a body's line
  // endings or trailing whitespace, and the marker's sha256 is of the document
  // itself -- the same marker line, on a comment that still parses, is the same slice.
  const unchanged = existing !== null && existing.body.replace(/\r\n/g, "\n").split("\n", 1)[0] === body.split("\n", 1)[0] && parseComment(existing.body, effort, target.slug, pr).ok;
  const argv = writeArgv(target, pr, existing?.id ?? null);
  if (unchanged || dryRun) {
    const verdict = unchanged ? "unchanged" : "dry-run";
    const lines = unchanged
      ? [`unchanged: ${existing?.url ?? ""} already holds effort '${effort}''s slice at head ${head.slice(0, 12)}.`]
      : [`would run: gh ${argv.join(" ")}  (body on stdin, ${size} characters, ${existing === null ? "a new comment" : `editing ${existing.url}`})`, body];
    emit(context.io, context.json, { contract: PR_LEDGER_CONTRACT, verdict, posted: false, url: existing?.url ?? null, size, slice, privateNameCheck: guard }, lines);
    return 0;
  }
  let url: string;
  try {
    url = writeComment(context.seams, target, pr, existing?.id ?? null, body);
  } catch (error) {
    if (!(error instanceof LedgerReadError)) throw error;
    context.io.err(`nen pr ledger post: ${error.message}`);
    return 1;
  }
  const verdict = existing === null ? "posted" : "updated";
  emit(context.io, context.json, { contract: PR_LEDGER_CONTRACT, verdict, posted: true, url, size, slice, privateNameCheck: guard }, [`${verdict}: ${url} -- effort '${effort}', head ${head.slice(0, 12)}, ${phases.length} phase entr${phases.length === 1 ? "y" : "ies"}, ${proof.length} proof file(s)`]);
  return 0;
}

function read(context: CommandContext, target: Target, pr: number, effort: string): number {
  const restore = context.args.booleans.has("restore");
  const refuse = (reason: string, extra: Record<string, unknown> = {}): number => {
    emit(context.io, context.json, { contract: PR_LEDGER_CONTRACT, verdict: "could-not-read" satisfies ReadVerdict, reason, ...extra }, [`could-not-read: ${reason}`]);
    return 1;
  };
  let head: string;
  let login: string;
  let marked;
  try {
    head = readPrHead(context.seams, target, pr);
    login = loginFor(context);
    marked = listComments(context.seams, target, pr).filter((comment): boolean => isMarkedFor(comment.body, effort));
  } catch (error) {
    if (!(error instanceof LedgerReadError)) throw error;
    return refuse(error.message);
  }
  const mine = marked.filter((comment): boolean => isOwn(comment, login));
  const foreign = marked.length - mine.length;
  if (mine.length === 0) return refuse(`${target.slug}#${pr} carries no ledger comment for effort '${effort}' by ${login}${foreign === 0 ? "" : ` (${foreign} by another login, not read)`}.`, { login, foreign });
  if (mine.length > 1) return refuse(`${target.slug}#${pr} carries ${mine.length} ledger comments for effort '${effort}' by ${login}; nen will not choose which is the record.`, { login, foreign });
  const comment = mine[0]!;
  const parsed = parseComment(comment.body, effort, target.slug, pr);
  if (!parsed.ok) return refuse(`${comment.url}: ${parsed.reason}.`, { login, foreign, url: comment.url });
  const verdict: ReadVerdict = parsed.slice.head.toLowerCase() === head.toLowerCase() ? "ok" : "stale";
  const lines = [
    `${verdict}: ${comment.url} by ${login} -- effort '${effort}', ${parsed.slice.phases.length} phase entr${parsed.slice.phases.length === 1 ? "y" : "ies"}, recorded at head ${parsed.slice.head.slice(0, 12)}${verdict === "stale" ? `, the PR is now at ${head.slice(0, 12)}` : ""}; foreign: ${foreign}`,
  ];
  let restored: { path: string; outcome: "restored" | "unchanged" } | null = null;
  if (restore) {
    const root = resolveRepoRoot({ repoFlag: context.repoFlag });
    const home = resolveEffortHome(root, "phases", context.seams);
    const located = locateEffortLedger(home, effort, "write");
    const moved = legacyLine(located);
    if (moved !== null) context.io.err(`nen pr ledger read: ${moved}`);
    const outcome = withLedgerLock(located.path, (): "restored" | "unchanged" | string => {
      if (!existsSync(located.path)) {
        writeLedger(located.path, { contract: PHASE_CONTRACT, effort, phases: parsed.slice.phases });
        return "restored";
      }
      const local = readLedger(located.path, effort);
      return JSON.stringify(local.phases) === JSON.stringify(parsed.slice.phases) ? "unchanged" : `the local phase ledger ${located.path} (${local.phases.length} entr${local.phases.length === 1 ? "y" : "ies"}) disagrees with the slice at ${comment.url} (${parsed.slice.phases.length}); nothing was overwritten. Reconcile them by hand, or move the local ledger aside to restore.`;
    });
    if (outcome !== "restored" && outcome !== "unchanged") {
      context.io.err(`nen pr ledger read: ${outcome}`);
      emit(context.io, context.json, { contract: PR_LEDGER_CONTRACT, verdict, login, foreign, url: comment.url, slice: parsed.slice, restored: null }, lines);
      return 1;
    }
    restored = { path: located.path, outcome };
    lines.push(`${outcome}: ${located.path}${verdict === "stale" ? " (from a STALE slice: the phases were restored, and the exit is 1 because the PR moved on since they were posted)" : ""}`);
  }
  emit(context.io, context.json, { contract: PR_LEDGER_CONTRACT, verdict, login, foreign, url: comment.url, slice: parsed.slice, restored }, lines);
  return verdict === "ok" ? 0 : 1;
}
