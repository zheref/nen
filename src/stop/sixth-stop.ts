import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import type { QuorumMember } from "../gates/predicates.js";
import { assertEffortId, encodeEffortId } from "../ledger/effort.js";
import { withLedgerLock, writeLedgerAtomically } from "../ledger/lock.js";
import { realContainment } from "../repo/contain.js";
import { gitCommonDir } from "../run/manifest.js";
import { isRecord } from "../schema/errors.js";
import { loadWorkflow } from "../schema/workflow.js";
import type { Seams } from "../seam/exec.js";
import type { ReadyReport } from "../verbs/pr_ready.js";
import { readPrompt, type PromptIdentity } from "./prompt.js";

const CONTRACT = "nen.stop.sixth-stop/v0.1";
const MAX_RECORD_BYTES = 256 * 1024;
const TERMINAL_CHECKS = new Set(["NEUTRAL", "CANCELLED", "SKIPPED", "FAILURE"]);

type RecordKind = "handoff" | "repair-hold";

interface Evidence {
  readonly unrecorded: ReadonlyMap<string, string>;
  readonly noCheckAfterWindows: ReadonlySet<string>;
}

export type SixthStopRead =
  | { readonly status: "missing" | "repair-hold" }
  | { readonly status: "verified"; readonly evidence: Evidence }
  | { readonly status: "unread"; readonly reason: string };

export interface SixthStopReadiness extends Pick<ReadyReport, "verdict" | "failing" | "judgedHead"> {
  readonly meta: Pick<ReadyReport["meta"], "repo" | "pr" | "evaluatedAt" | "requiredHead"> & {
    readonly identities: Pick<ReadyReport["meta"]["identities"], "read">;
    readonly aiReviewers?: Pick<NonNullable<ReadyReport["meta"]["aiReviewers"]>, "effective">;
  };
  readonly conjuncts: readonly (Pick<ReadyReport["conjuncts"][number], "id" | "status" | "roundQuorum"> & {
    readonly owedRounds?: readonly { readonly reviewer: string }[];
  })[];
}

type QuorumCheck =
  | { readonly ok: true; readonly members: readonly QuorumMember[] }
  | { readonly ok: false; readonly reason: string; readonly unread?: true };

export function sixthStopQuorum(report: SixthStopReadiness): QuorumCheck {
  const unread = report.conjuncts.find((row) => row.status === "unevaluated");
  if (unread !== undefined) return { ok: false, unread: true, reason: "readiness row unread: " + unread.id };
  if (report.verdict !== "not-ready" || report.failing.length !== 1 || report.failing[0] !== "rounds-owed") {
    return { ok: false, reason: `sixth stop requires rounds-owed alone (failing: ${report.failing.join(", ") || "none"})` };
  }
  if (report.meta.identities.read !== "base" || report.meta.aiReviewers?.effective !== "required") {
    return { ok: false, reason: "sixth stop requires the base gate and required AI reviewers" };
  }
  const row = report.conjuncts.find((item) => item.id === "rounds-owed");
  const quorum = row?.roundQuorum;
  if (quorum === undefined || quorum.met || quorum.anyOf.length === 0) return { ok: false, reason: "sixth stop requires an unmet review quorum" };
  if (row?.owedRounds === undefined || row.owedRounds.some(({ reviewer }) => !quorum.anyOf.includes(reviewer))) {
    return { ok: false, reason: "sixth stop requires an owed-reviewer list confined to the quorum" };
  }
  if (quorum.members.length !== quorum.anyOf.length || quorum.anyOf.some(
    (reviewer) => quorum.members.filter((member) => member.reviewer === reviewer).length !== 1,
  )) return { ok: false, reason: "sixth stop requires a live read for every quorum member" };
  return { ok: true, members: quorum.members };
}

function noCheckAtHead(member: QuorumMember): boolean {
  return member.round === null && !member.requested && member.eventRun?.state !== "in-flight"
    && member.roundCheck?.state === "absent" && member.roundCheck.name === null;
}

// The watch keeps a structured observation for each poll, including its base
// judgement and exact head, so the reader never interprets terminal prose.
export function sixthStopObservation(report: SixthStopReadiness): Record<string, unknown> | null {
  const quorum = sixthStopQuorum(report);
  if (!quorum.ok || report.judgedHead === null || !/^[0-9a-f]{40}$/.test(report.judgedHead) || report.meta.requiredHead !== report.judgedHead) return null;
  return {
    repo: report.meta.repo,
    pr: report.meta.pr,
    head: report.judgedHead,
    at: report.meta.evaluatedAt,
    absentReviewers: quorum.members.filter(noCheckAtHead).map(({ reviewer }) => reviewer),
  };
}

export function unprovenReviewer(
  members: readonly QuorumMember[],
  evidence: Evidence,
  head: string,
  reviewerMatches?: (reviewer: string, login: string) => boolean,
): string | undefined {
  return members.find((member) => {
    if (member.round !== null || member.requested || member.eventRun?.state === "in-flight" || member.roundCheck?.state === "pending") return true;
    const check = member.roundCheck;
    if (check?.from === "head" && check.sha === head && check.conclusion !== null && TERMINAL_CHECKS.has(check.conclusion)) return false;
    const login = evidence.unrecorded.get(member.reviewer);
    if (login !== undefined && reviewerMatches?.(member.reviewer, login) === true) return false;
    return !(noCheckAtHead(member) && evidence.noCheckAfterWindows.has(member.reviewer));
  })?.reviewer;
}

interface WatchEvidence {
  readonly first: number;
  readonly last: number;
  readonly absent: readonly string[];
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

interface EvidenceContext {
  readonly intervalMs: number;
  readonly latestAt: number;
  readonly repo?: string;
}

function readWindow(value: unknown, identity: PromptIdentity, context: EvidenceContext): WatchEvidence {
  if (!isRecord(value) || value["outcome"] !== "max-iterations" || value["until"] !== "ready"
    || typeof value["intervalMs"] !== "number" || !Number.isSafeInteger(value["intervalMs"]) || value["intervalMs"] < context.intervalMs
    || !Array.isArray(value["iterations"]) || value["iterations"].length !== 2
    || !value["iterations"].every((row) => isRecord(row) && row["errored"] === false && row["conditionTrue"] === false)
    || !Array.isArray(value["sixthStopObservations"]) || value["sixthStopObservations"].length !== 2) {
    throw new Error("sixth-stop evidence needs two successful polls in each bounded watch window");
  }
  const observations = value["sixthStopObservations"].map((row: unknown) => {
    if (!isRecord(row) || row["head"] !== identity.head || row["pr"] !== identity.pr || !isName(row["repo"])
      || (context.repo !== undefined && row["repo"].toLowerCase() !== context.repo.toLowerCase())
      || typeof row["at"] !== "string" || !Number.isFinite(Date.parse(row["at"]))
      || !Array.isArray(row["absentReviewers"]) || !row["absentReviewers"].every(isName)) {
      throw new Error("sixth-stop watch observation is unreadable or judged another delivery");
    }
    return { at: Date.parse(row["at"]), repo: row["repo"].toLowerCase(), absent: row["absentReviewers"] as string[] };
  });
  const first = observations[0]!;
  const last = observations[1]!;
  if (last.repo !== first.repo || last.at > context.latestAt || last.at - first.at < value["intervalMs"]) {
    throw new Error("sixth-stop watch did not prove a paced window on one delivery");
  }
  return { first: first.at, last: last.at, absent: first.absent.filter((reviewer) => last.absent.includes(reviewer)) };
}

function parseEvidence(value: unknown, identity: PromptIdentity, context: EvidenceContext): Evidence {
  if (!isRecord(value) || !Array.isArray(value["requests"]) || !Array.isArray(value["windows"])) {
    throw new Error("sixth-stop evidence needs requests and windows arrays");
  }
  const unrecorded = new Map<string, string>();
  const botIds = new Set<string>();
  for (const request of value["requests"] as unknown[]) {
    if (!isRecord(request) || !isName(request["reviewer"]) || request["head"] !== identity.head || request["exitCode"] !== 9) {
      throw new Error("sixth-stop request evidence needs an exit-9 request at the judged head");
    }
    const result = request["result"];
    if (!isRecord(result) || result["ok"] !== false || result["requestHead"] !== identity.head || result["pr"] !== identity.pr
      || !isName(result["repo"]) || (context.repo !== undefined && result["repo"].toLowerCase() !== context.repo.toLowerCase())
      || !Array.isArray(result["unrecordedBots"]) || result["unrecordedBots"].length !== 1) {
      throw new Error("sixth-stop request evidence needs one unrecorded bot on the exact delivery");
    }
    const bot: unknown = result["unrecordedBots"][0];
    if (!isRecord(bot) || !isName(bot["id"]) || botIds.has(bot["id"]) || unrecorded.has(request["reviewer"])) {
      throw new Error("sixth-stop request evidence has an unreadable or duplicate reviewer or bot");
    }
    const routes: unknown[] = Array.isArray(result["routing"]) ? result["routing"] : [];
    const route = routes.find((candidate) => isRecord(candidate) && candidate["route"] === "bot" && candidate["id"] === bot["id"]);
    if (!isRecord(route)) throw new Error("sixth-stop request evidence does not name the unrecorded bot route");
    const login = isName(bot["login"]) ? bot["login"] : route["name"];
    if (!isName(login) || login === bot["id"]) throw new Error("sixth-stop request evidence has no resolved bot login");
    botIds.add(bot["id"]);
    unrecorded.set(request["reviewer"], login);
  }
  const windows = value["windows"] as unknown[];
  if (windows.length === 0) return { unrecorded, noCheckAfterWindows: new Set() };
  if (windows.length !== 2) throw new Error("sixth-stop window evidence needs exactly two completed windows");
  const first = readWindow(windows[0], identity, context);
  const second = readWindow(windows[1], identity, context);
  if (first.last > second.first) throw new Error("sixth-stop watch windows overlap or are out of order");
  return { unrecorded, noCheckAfterWindows: new Set(first.absent.filter((reviewer) => second.absent.includes(reviewer))) };
}

function location(common: string, identity: PromptIdentity, repo: string, kind: RecordKind): string {
  const path = join(common, ".nen", "sixth-stops", encodeURIComponent(repo.toLowerCase()), encodeEffortId(identity.effort),
    `${identity.pr}-${identity.head}-${identity.gate}-${kind}.json`);
  const containment = realContainment(common, path);
  if (!containment.contained || containment.link !== null) throw new Error(`sixth-stop record redirected: ${path}`);
  return path;
}

function readRecord(path: string, identity: PromptIdentity, repo: string, kind: RecordKind): Record<string, unknown> | null {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw new Error(`sixth-stop record is not a small regular file: ${path}`);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value) || value["contract"] !== CONTRACT || value["kind"] !== kind || value["repo"] !== repo.toLowerCase() || value["effort"] !== identity.effort
    || value["pr"] !== identity.pr || value["head"] !== identity.head || value["gate"] !== identity.gate
    || typeof value["at"] !== "string" || !Number.isFinite(Date.parse(value["at"]))) {
    throw new Error(`sixth-stop record malformed or mismatched: ${path}`);
  }
  return value;
}

function checkedIdentity(identity: PromptIdentity): PromptIdentity {
  assertEffortId(identity.effort);
  if (!Number.isSafeInteger(identity.pr) || identity.pr <= 0 || !/^[0-9a-f]{40}$/i.test(identity.head)
    || !["G2", "G4"].includes(identity.gate)) throw new VerbUsageError("sixth-stop record needs a positive PR, full head and G2/G4 gate");
  return { ...identity, head: identity.head.toLowerCase() };
}

function policyInterval(root: string): number {
  return Math.max(30_000, loadWorkflow(root).workflow.monitor.pollSeconds * 1000);
}

export function readSixthStop(seams: Seams, root: string, identity: PromptIdentity, repo: string, repairOnly: boolean): SixthStopRead {
  try {
    identity = checkedIdentity(identity);
    const common = gitCommonDir(seams, root);
    if (readRecord(location(common, identity, repo, "repair-hold"), identity, repo, "repair-hold") !== null) return { status: "repair-hold" };
    if (repairOnly) return { status: "missing" };
    const record = readRecord(location(common, identity, repo, "handoff"), identity, repo, "handoff");
    if (record === null) return { status: "missing" };
    const context = { intervalMs: policyInterval(root), latestAt: Math.min(Date.parse(String(record["at"])), seams.now().getTime()), repo };
    return { status: "verified", evidence: parseEvidence(record["evidence"], identity, context) };
  } catch (error) {
    return { status: "unread", reason: String(error) };
  }
}

export function recordSixthStop(seams: Seams, root: string, identity: PromptIdentity, repo: string, kind: RecordKind, evidence?: unknown): string {
  identity = checkedIdentity(identity);
  if (kind === "handoff") {
    try {
      parseEvidence(evidence, identity, { intervalMs: policyInterval(root), latestAt: seams.now().getTime(), repo });
    } catch (error) {
      throw new VerbUsageError(String(error));
    }
    const prompt = readPrompt(seams, root, identity);
    if (!prompt.ok || !prompt.present) throw new Error(prompt.ok ? "sixth-stop prompt receipt is missing" : prompt.reason);
  }
  const common = gitCommonDir(seams, root);
  const path = location(common, identity, repo, kind);
  return withLedgerLock(path, () => {
    const existing = readRecord(path, identity, repo, kind);
    if (existing !== null) {
      if (kind === "handoff" && JSON.stringify(existing["evidence"]) !== JSON.stringify(evidence)) {
        throw new Error("different sixth-stop evidence is already recorded at this head");
      }
      return path;
    }
    const record = { contract: CONTRACT, kind, repo: repo.toLowerCase(), ...identity, at: seams.now().toISOString(), ...(kind === "handoff" ? { evidence } : {}) };
    if (Buffer.byteLength(JSON.stringify(record, null, 2) + "\n") > MAX_RECORD_BYTES) throw new VerbUsageError("sixth-stop record exceeds 256 KiB");
    writeLedgerAtomically(path, record, 0o600);
    return path;
  });
}
