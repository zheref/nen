import type { Conjunct } from "./ready.js";
// Trusted workflow policy: a pull request cannot waive its own review obligations.
import type { PrStateSource, PrRef } from "../github/pr_state.js";
import { parseGateIdentities, parseGatesText, type GateIdentities, type ReviewerIdentity } from "../schema/gates.js";
import type { BaseGatesRead } from "./base_exclusions.js";

export type AiReviewersPolicy = "required" | "optional" | "off";
export interface AiPolicySource {
  readonly sha: string | null;
  readonly policy: AiReviewersPolicy;
  readonly fallback: string | null;
}
export interface AiReviewersReading {
  readonly effective: AiReviewersPolicy;
  readonly base: AiPolicySource;
  readonly defaultTip: AiPolicySource;
}
export async function readAiReviewers(source: PrStateSource, ref: PrRef, baseSha: string, defaultSha: string): Promise<AiReviewersReading> {
  const cache = new Map<string, Promise<AiPolicySource>>();
  function read(sha: string): Promise<AiPolicySource> {
    const known = cache.get(sha);
    if (known !== undefined) return known;
    const pending = (async (): Promise<AiPolicySource> => {
      const fallback = (reason: string): AiPolicySource => ({ sha: sha || null, policy: "required", fallback: reason });
      if (sha === "") return fallback("commit unavailable");
      if (source.fileAtRef === undefined) return fallback("transport cannot read files at a commit");
      try {
        const text = await source.fileAtRef(ref, "nen/workflow.json", sha);
        if (text === null) return fallback("workflow file absent");
        const raw = parseGatesText("nen/workflow.json", text);
        const value = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>)["aiReviewers"] : undefined;
        if (value !== "required" && value !== "optional" && value !== "off") return fallback("aiReviewers absent or invalid");
        return { sha, policy: value, fallback: null };
      } catch (error) { return fallback(`workflow unreadable: ${error instanceof Error ? error.message : String(error)}`); }
    })();
    cache.set(sha, pending);
    return pending;
  }
  const base = await read(baseSha);
  const defaultTip = await read(defaultSha);
  const effective = base.policy === "required" || defaultTip.policy === "required" ? "required" :
    base.policy === "optional" || defaultTip.policy === "optional" ? "optional" : "off";
  return { effective, base, defaultTip };
}

/** Both declarations must positively identify the same bot; regex shape proves nothing. */
export function trustedBotReviewers(base: BaseGatesRead | undefined, defaultTip: BaseGatesRead | undefined, applied: GateIdentities): readonly string[] {
  function parse(read: BaseGatesRead | undefined): GateIdentities | null {
    if (read?.kind !== "read") return null;
    try { return parseGateIdentities("nen/gates.json", parseGatesText("nen/gates.json", read.text)); } catch { return null; }
  }
  const left = parse(base);
  const right = parse(defaultTip);
  if (left === null || right === null) return [];
  const signature = (identity: ReviewerIdentity): string => JSON.stringify(identity, (_key, value: unknown): unknown => value instanceof RegExp ? value.toString() : value);
  return applied.reviewers.filter((identity): boolean => {
    const a = left.reviewer(identity.name);
    const b = right.reviewer(identity.name);
    return identity.kind === "bot" && a?.kind === "bot" && b?.kind === "bot" &&
      signature(identity) === signature(a) && signature(a) === signature(b);
  }).map((identity): string => identity.name);
}
/** The same policy provenance/waivers in ready's human output and merge's transcript. */
export function aiReviewersNotices(reading: AiReviewersReading | undefined, conjuncts: readonly Conjunct[] = []): string[] {
  if (reading === undefined) return [];
  const describe = (source: AiPolicySource): string => `${source.sha ?? "(unknown)"}: ${source.policy}${source.fallback === null ? "" : ` (${source.fallback})`}`;
  const lines = [`aiReviewers ${reading.effective}; base ${describe(reading.base)}; default tip ${describe(reading.defaultTip)}`];
  for (const row of conjuncts) {
    for (const entry of row.owedRounds ?? []) {
      if (entry.waivedByAiPolicy !== undefined) {
        lines.push(`waived bot round: ${entry.reviewer} (${entry.reason}; aiReviewers ${entry.waivedByAiPolicy})`);
      }
    }
    const quorum = row.aiPolicyQuorum;
    if (quorum !== undefined) {
      lines.push(`aiReviewers quorum waivers: ${quorum.waivedReviewers.join(", ") || "(none)"}; binding ${quorum.bindingCount}/${quorum.bindingMinimum}; raw quorum unchanged`);
    }
  }
  return lines;
}
