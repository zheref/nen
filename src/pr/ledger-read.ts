import { effortIdProblem, effortIdRefusal } from "../ledger/effort.js";
// One read authority for the CLI and report rows. No local ledger reads or writes.
import type { Target } from "../github/target.js";
import type { Seams } from "../seam/exec.js";
import { assembleLedger, isMarkedFor, isOwn, LedgerReadError, listComments, parseComment, PR_LEDGER_CONTRACT, readLogin, readPrHead, type LedgerSlice } from "./ledger.js";

export interface LedgerEvidence {
  readonly state: "valid" | "none" | "refused" | "not-read";
  readonly url: string | null;
  readonly verdict: "ok" | "stale" | "could-not-read";
  readonly reason: string | null;
  readonly line: string;
}
type ReadResult = {
  readonly evidence: LedgerEvidence;
  readonly report: Record<string, unknown>;
} & ({ readonly ok: false } | { readonly ok: true; readonly slice: LedgerSlice; readonly login: string; readonly foreign: number; readonly url: string; readonly verdict: "ok" | "stale" });

export function unreadLedger(reason: string): LedgerEvidence {
  return { state: "not-read", url: null, verdict: "could-not-read", reason, line: `could-not-read: ${reason}` };
}

export function readLedgerSlice(seams: Seams, target: Target, pr: number, effort: string, loginFor: () => string = (): string => readLogin(seams)): ReadResult {
  const refuse = (state: LedgerEvidence["state"], reason: string, extra: Record<string, unknown> = {}): ReadResult => ({
    ok: false,
    evidence: { state, url: typeof extra["url"] === "string" ? extra["url"] : null, verdict: "could-not-read", reason, line: `could-not-read: ${reason}` },
    report: { contract: PR_LEDGER_CONTRACT, verdict: "could-not-read", reason, ...extra },
  });
  const problem = effortIdProblem(effort);
  if (problem !== null) return refuse("not-read", effortIdRefusal(effort, problem));
  let head: string;
  let login: string;
  let allComments;
  try {
    head = readPrHead(seams, target, pr);
    login = loginFor();
    allComments = listComments(seams, target, pr);
  } catch (error) {
    if (!(error instanceof LedgerReadError)) throw error;
    return refuse("not-read", error.message);
  }
  const marked = allComments.filter((comment): boolean => isMarkedFor(comment.body, effort));
  const mine = marked.filter((comment): boolean => isOwn(comment, login));
  const foreign = marked.length - mine.length;
  if (mine.length === 0) return refuse(foreign === 0 ? "none" : "refused", `${target.slug}#${pr} carries no ledger comment for effort '${effort}' by ${login}${foreign === 0 ? "" : ` (${foreign} by another login, not read)`}.`, { login, foreign });
  if (mine.length > 1) return refuse("refused", `${target.slug}#${pr} carries ${mine.length} ledger comments for effort '${effort}' by ${login}; nen will not choose which is the record.`, { login, foreign });
  const comment = mine[0]!;
  let assembled: string;
  try { assembled = assembleLedger(comment.body, effort, allComments, login); }
  catch (error) { if (!(error instanceof LedgerReadError)) throw error; return refuse("refused", error.message); }
  const parsed = parseComment(assembled, effort, target.slug, pr);
  if (!parsed.ok) return refuse("refused", `${comment.url}: ${parsed.reason}.`, { login, foreign, url: comment.url });
  const verdict = parsed.slice.head.toLowerCase() === head.toLowerCase() ? "ok" : "stale";
  const line = `${verdict}: ${comment.url} by ${login} -- effort '${effort}', ${parsed.slice.phases.length} phase entr${parsed.slice.phases.length === 1 ? "y" : "ies"}, recorded at head ${parsed.slice.head.slice(0, 12)}${verdict === "stale" ? `, the PR is now at ${head.slice(0, 12)}` : ""}; foreign: ${foreign}`;
  return { ok: true, slice: parsed.slice, login, foreign, url: comment.url, verdict,
    report: { contract: PR_LEDGER_CONTRACT, verdict, login, foreign, url: comment.url, slice: parsed.slice },
    evidence: { state: verdict === "ok" ? "valid" : "refused", url: comment.url, verdict, reason: verdict === "ok" ? null : line, line },
  };
}
