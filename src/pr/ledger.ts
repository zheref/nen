// src/pr/ledger.ts -- an effort's ledger slice as ONE pull request comment
// (zheref/nen#510, with #512 folded in): the shape, the comment it renders to,
// the parse that reads it back, and the gh calls that find, post and edit it.
//
// WHY. Every record of how an effort was delivered -- its phases, its spend,
// its review findings, its evidence -- lived only on the machine that ran it.
// A morning reviewer, a second machine or a fresh clone resuming a parked
// effort had nothing durable to read. The slice puts that record on the PR,
// where the PR's own access rules hold it.
//
// THE SHAPE, `nen.pr.ledger/v0.1`. { contract, effort, repo, pr, head, phases[]
// (the phase ledger's entries, verbatim), usage { entries, totals[] } (the
// usage ledger's totals per surface and model), findings { schema { id,
// sha256 }, document } | null (the caller's findings file, validated against
// the caller's schema before anything is posted), proof[] { path, sha256,
// bytes } }. No posting instant: two posts of the same facts are the same
// bytes, so the second is `unchanged` (AC-3).
//
// THE COMMENT. Line 1 is the marker `<!-- nen:ledger effort=<encoded id>
// sha256=<digest> -->`; the digest is of the fenced JSON text, so a comment
// edited by hand after it was posted reads as `could-not-read` (edited), by
// name. A one-line summary follows, then the document in a ```json fence.
//
// WHOSE COMMENT IS READ (SEC-15). Only one the AUTHENTICATED login wrote: a
// marked comment by anyone else is counted (`foreign`) and never parsed as the
// record (AC-7). Read-back text is data -- it is parsed as JSON and checked
// against the contract, never executed or rendered.

import { createHash } from "node:crypto";
import { GH, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import { encodeEffortId } from "../ledger/effort.js";
import type { PhaseEntry } from "../phase/ledger.js";
import type { UsageTotal } from "../usage/command.js";

export const PR_LEDGER_CONTRACT = "nen.pr.ledger/v0.1";
/** GitHub's limit on an issue or pull request comment body, in characters. */
export const GITHUB_COMMENT_LIMIT = 65_536;
const SHA256 = /^[0-9a-f]{64}$/;
const HEAD = /^[0-9a-f]{40}$/i;

export interface ProofEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** KEY ORDER IS THE CONTRACT. */
export interface LedgerSlice {
  readonly contract: typeof PR_LEDGER_CONTRACT;
  readonly effort: string;
  readonly repo: string;
  readonly pr: number;
  readonly head: string;
  readonly phases: readonly PhaseEntry[];
  readonly usage: { readonly entries: number; readonly totals: readonly UsageTotal[] };
  readonly findings: { readonly schema: { readonly id: string | null; readonly sha256: string }; readonly document: unknown } | null;
  readonly proof: readonly ProofEntry[];
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The marker's prefix for one effort; the digest follows it. */
export function markerPrefix(effort: string): string {
  return `<!-- nen:ledger effort=${encodeEffortId(effort)} `;
}

/** Any nen ledger marker, of any effort. */
const ANY_MARKER = /^<!-- nen:ledger effort=(\S+) sha256=([0-9a-f]{64}) -->$/;

/** The whole comment body for `slice`. */
export function renderComment(slice: LedgerSlice): string {
  const json = JSON.stringify(slice, null, 2);
  const findings = slice.findings === null ? "no findings recorded" : `findings validated against ${slice.findings.schema.id ?? "the caller's schema"}`;
  return [
    `${markerPrefix(slice.effort)}sha256=${sha256Hex(json)} -->`,
    `**nen ledger** · effort \`${slice.effort}\` · head \`${slice.head.slice(0, 12)}\` · ${slice.phases.length} phase entr${slice.phases.length === 1 ? "y" : "ies"} · ${findings} · ${slice.proof.length} proof file(s)`,
    "",
    "```json",
    json,
    "```",
    "",
  ].join("\n");
}

export type ParsedComment = { readonly ok: true; readonly slice: LedgerSlice } | { readonly ok: false; readonly reason: string };

/** True when `body` carries a ledger marker for `effort` on its first line. */
export function isMarkedFor(body: string, effort: string): boolean {
  return (body.split("\n", 1)[0] ?? "").startsWith(markerPrefix(effort));
}

/** Parse a marked comment back into its slice, or name why it is not one. */
export function parseComment(body: string, effort: string, repo: string, pr: number): ParsedComment {
  const text = body.replace(/\r\n/g, "\n");
  const first = text.split("\n", 1)[0] ?? "";
  const marker = ANY_MARKER.exec(first);
  if (marker === null) return { ok: false, reason: "the marker line is malformed" };
  if (marker[1] !== encodeEffortId(effort)) return { ok: false, reason: `the marker names effort '${marker[1]}'` };
  const open = text.indexOf("\n```json\n");
  const close = text.lastIndexOf("\n```");
  if (open === -1 || close <= open) return { ok: false, reason: "no ```json fence holds the document" };
  const json = text.slice(open + "\n```json\n".length, close);
  if (sha256Hex(json) !== marker[2]) return { ok: false, reason: "edited: the document's sha256 is not the one the marker recorded" };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return { ok: false, reason: `the document is not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const problem = sliceProblem(value, effort, repo, pr);
  return problem === null ? { ok: true, slice: value as LedgerSlice } : { ok: false, reason: problem };
}

/** Why `value` is not this effort's `nen.pr.ledger/v0.1` slice on this PR, or null. */
export function sliceProblem(value: unknown, effort: string, repo: string, pr: number): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "the document is not a JSON object";
  const doc = value as Record<string, unknown>;
  if (doc["contract"] !== PR_LEDGER_CONTRACT) return `contract is ${JSON.stringify(doc["contract"])}, not ${PR_LEDGER_CONTRACT}`;
  if (doc["effort"] !== effort) return `effort is ${JSON.stringify(doc["effort"])}, not '${effort}'`;
  if (typeof doc["repo"] !== "string" || doc["repo"].toLowerCase() !== repo.toLowerCase()) return `repo is ${JSON.stringify(doc["repo"])}, not ${repo}`;
  if (doc["pr"] !== pr) return `pr is ${JSON.stringify(doc["pr"])}, not ${pr}`;
  if (typeof doc["head"] !== "string" || !HEAD.test(doc["head"])) return "head is not a 40-hex commit";
  const phases = doc["phases"];
  if (!Array.isArray(phases)) return "phases is not an array";
  for (const [index, entry] of phases.entries()) {
    const row = entry as Record<string, unknown> | null;
    if (typeof row !== "object" || row === null) return `phases[${index}] is not an object`;
    if (typeof row["phase"] !== "string" || row["phase"] === "") return `phases[${index}].phase is not a phase name`;
    if (typeof row["startedAt"] !== "string" || Number.isNaN(Date.parse(row["startedAt"]))) return `phases[${index}].startedAt is not an instant`;
    if (row["endedAt"] !== null && (typeof row["endedAt"] !== "string" || Number.isNaN(Date.parse(row["endedAt"])))) return `phases[${index}].endedAt is neither an instant nor null`;
  }
  const usage = doc["usage"] as Record<string, unknown> | null;
  if (typeof usage !== "object" || usage === null || typeof usage["entries"] !== "number" || !Array.isArray(usage["totals"])) return "usage is not { entries, totals[] }";
  const findings = doc["findings"] as Record<string, unknown> | null;
  if (findings !== null) {
    const schema = (typeof findings === "object" ? findings["schema"] : undefined) as Record<string, unknown> | undefined;
    if (typeof findings !== "object" || typeof schema !== "object" || schema === null || typeof schema["sha256"] !== "string" || !SHA256.test(schema["sha256"]) || !Object.hasOwn(findings, "document")) {
      return "findings is neither null nor { schema { id, sha256 }, document }";
    }
  }
  const proof = doc["proof"];
  if (!Array.isArray(proof)) return "proof is not an array";
  for (const [index, entry] of proof.entries()) {
    const row = entry as Record<string, unknown> | null;
    if (typeof row !== "object" || row === null || typeof row["path"] !== "string" || typeof row["sha256"] !== "string" || !SHA256.test(row["sha256"]) || typeof row["bytes"] !== "number") {
      return `proof[${index}] is not { path, sha256, bytes }`;
    }
  }
  return null;
}

// ── GitHub ──────────────────────────────────────────────────────────────────

export class LedgerReadError extends Error {}

function ghJson(seams: Seams, args: readonly string[], what: string): unknown {
  const result = seams.run(GH, [...args]);
  if (result.spawnFailed) throw new LedgerReadError(`gh could not be started to read ${what}.`);
  if (result.code !== 0) throw new LedgerReadError(`could not read ${what}: ${outputLines(result.stderr).join(" ") || `gh exit ${result.code}`}.`);
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new LedgerReadError(`could not read ${what}: gh answered with text that is not JSON.`);
  }
}

/** The authenticated login -- the only author whose marked comment is the record. */
export function readLogin(seams: Seams): string {
  const user = ghJson(seams, ["api", "user"], "the authenticated login") as { login?: unknown } | null;
  if (typeof user?.login !== "string" || user.login === "") throw new LedgerReadError("could not read the authenticated login: gh's answer names none.");
  return user.login;
}

/** The PR's current head commit; a number that is not a pull request is a read error. */
export function readPrHead(seams: Seams, target: Target, pr: number): string {
  const raw = ghJson(seams, ["api", `repos/${target.slug}/pulls/${pr}`], `${target.slug}#${pr}`) as { number?: unknown; head?: { sha?: unknown } } | null;
  if (raw?.number !== pr || typeof raw.head?.sha !== "string" || !HEAD.test(raw.head.sha)) throw new LedgerReadError(`could not read ${target.slug}#${pr}: the answer is not that pull request's head.`);
  return raw.head.sha;
}

export interface PrComment {
  readonly id: number;
  readonly login: string;
  readonly body: string;
  readonly url: string;
}

/** Every conversation comment on the PR, page by page to the end. A short page ends it; a failed page is a read error. */
export function listComments(seams: Seams, target: Target, pr: number, maxPages = 100): readonly PrComment[] {
  const comments: PrComment[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const raw = ghJson(seams, ["api", `repos/${target.slug}/issues/${pr}/comments?per_page=100&page=${page}`], `${target.slug}#${pr}'s comments (page ${page})`);
    if (!Array.isArray(raw)) throw new LedgerReadError(`could not read ${target.slug}#${pr}'s comments: page ${page} is not a list.`);
    for (const entry of raw as Record<string, unknown>[]) {
      const login = (entry["user"] as { login?: unknown } | null)?.login;
      if (typeof entry["id"] !== "number" || typeof entry["body"] !== "string" || typeof login !== "string") continue;
      comments.push({ id: entry["id"], login, body: entry["body"], url: typeof entry["html_url"] === "string" ? entry["html_url"] : "" });
    }
    if (raw.length < 100) return comments;
  }
  throw new LedgerReadError(`${target.slug}#${pr} has more than ${maxPages * 100} comments; nen stopped rather than read a partial list as the whole.`);
}

/** The argv of a post (new comment) or an edit (the existing one); the body travels on stdin as `{ "body": ... }`. */
export function writeArgv(target: Target, pr: number, existing: number | null): readonly string[] {
  return existing === null
    ? ["api", "-X", "POST", `repos/${target.slug}/issues/${pr}/comments`, "--input", "-"]
    : ["api", "-X", "PATCH", `repos/${target.slug}/issues/comments/${existing}`, "--input", "-"];
}

/** Post or edit; the comment's URL. A refused write is a LedgerReadError carrying gh's words. */
export function writeComment(seams: Seams, target: Target, pr: number, existing: number | null, body: string): string {
  const result = seams.run(GH, [...writeArgv(target, pr, existing)], { stdin: JSON.stringify({ body }) });
  if (result.spawnFailed) throw new LedgerReadError("gh could not be started to write the ledger comment; nothing was written.");
  if (result.code !== 0) throw new LedgerReadError(`gh refused the ledger comment: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}.`);
  try {
    const url = (JSON.parse(result.stdout) as { html_url?: unknown }).html_url;
    return typeof url === "string" ? url : "";
  } catch {
    return "";
  }
}
