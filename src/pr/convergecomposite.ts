// src/pr/convergecomposite.ts -- `nen pr converge --composite`: the whole
// readiness conjunct of one pull request at ONE pinned head (zheref/nen#483
// AC-1; Hatsu HR-11, Akatsuki CON-17(c) and CON-32).
//
// FOUR CONJUNCTS, ONE HEAD. `pr ready`'s verdict (in-process, `--require-head`
// passed through -- the same `runReadyGate` `pr merge` calls), the body check
// against the caller's `{ name, pattern }` requirements, the closing-issue
// links (./converge.ts `closingLinksConjunct`) and the criteria coverage
// (`criteriaConjunct`). The pull request is read once (its body and closing
// list), every closing issue is read, `pr ready` reads its own state, and then
// the head is read once more: every read must be at the pin, or no verdict is
// reported (AC-6). The bounded delivery merge composes the same conjunct
// functions over its own one fetch (./mergedelivery.ts), so the report a
// caller quotes and the merge's refusal rest on the same facts.
//
// NEN REPORTS; IT DECIDES NOTHING ELSE. The verdict is the conjunction: each
// conjunct says why it holds or does not, and `ready` is true only when all
// four hold. A read that did not finish is `ConvergeReadError` -- exit 3 with
// stdout empty at the adapter (`EXIT_COMPOSITE_UNREAD`), never a verdict (AC-7).

import { checkBody, type BodyRequirement } from "./bodycheck.js";
import { assertPinnedHead, closingLinksConjunct, ConvergeReadError, criteriaConjunct, readConvergeInput, type ConvergeConjunct, type ConvergeInput } from "./converge.js";
import { runReadyGate } from "./mergeunit.js";
import { DEFAULT_COVERAGE_POLICY, type CoveragePolicy } from "../issue/criteria.js";
import type { IssueSectionsCatalogue } from "../issue/shape.js";
import type { Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import type { PrReadyDeps } from "../verbs/pr_ready.js";

export interface CompositeOptions {
  readonly seams: Seams;
  readonly target: Target;
  readonly prNumber: number;
  /** The full commit every read must be at. Required: a composite verdict is about one named head. */
  readonly requireHead: string;
  readonly requirements: readonly BodyRequirement[];
  readonly catalogue: IssueSectionsCatalogue | null;
  readonly policy?: CoveragePolicy;
  /** `pr ready`'s checkout (its gates fallback), as `--repo` names it; null reads the base's only. */
  readonly repoFlag: string | null;
  readonly deps?: PrReadyDeps;
}

export interface CompositeVerdict {
  readonly input: ConvergeInput;
  /** True only when all four conjuncts hold at the pinned head. */
  readonly ready: boolean;
  readonly conjuncts: readonly ConvergeConjunct[];
  readonly blocking: readonly string[];
}

/** Read and judge the four conjuncts at one head, or throw `ConvergeReadError`. */
export async function convergeComposite(options: CompositeOptions): Promise<CompositeVerdict> {
  const input = readConvergeInput(options.seams, options.target, options.prNumber, options.catalogue);
  const pin = options.requireHead.toLowerCase();
  if (input.headSha.toLowerCase() !== pin) {
    throw new ConvergeReadError(`${options.target.slug}#${options.prNumber}'s head is ${input.headSha === "" ? "(unread)" : input.headSha}, not the pinned ${options.requireHead}; no verdict is reported for a head other than the one pinned.`);
  }
  const readyGate = await runReadyGate({
    target: options.target,
    prNumber: options.prNumber,
    repoFlag: options.repoFlag,
    ghRepoFlag: options.target.slug,
    seams: options.seams,
    requireHead: options.requireHead,
    ...(options.deps === undefined ? {} : { deps: options.deps }),
  });
  // `pr ready` refuses a head other than the pin and then judges none: a
  // verdict with no judged head, or another one, is a read at the wrong head.
  if (readyGate.judgedHead !== null && readyGate.judgedHead.toLowerCase() !== pin) {
    throw new ConvergeReadError(`'pr ready' judged ${readyGate.judgedHead}, not the pinned ${options.requireHead}; refusing to mix two heads in one verdict.`);
  }
  const body = checkBody(input.body, options.requirements);
  const satisfied = body.results.filter((result): boolean => result.satisfied).length;
  const bodyConjunct: ConvergeConjunct = {
    name: "pr body-check",
    ok: body.ok,
    lines: [`pr body-check: ${satisfied}/${body.results.length} requirement(s) satisfied`, ...body.results.map((result): string => `  ${result.satisfied ? "ok" : "MISSING"}  ${result.name}`)],
  };
  const links = closingLinksConjunct(input, options.target);
  const criteria = criteriaConjunct(input, options.policy ?? DEFAULT_COVERAGE_POLICY);
  // The closing re-read: every read above must still be at the pin (AC-6).
  assertPinnedHead(options.seams, options.target, options.prNumber, input, options.requireHead);
  const readiness: ConvergeConjunct = {
    name: "pr ready",
    ok: readyGate.ok && readyGate.judgedHead !== null,
    lines: readyGate.judgedHead === null ? [...readyGate.lines, "pr ready: judged no head -- not ready."] : readyGate.lines,
  };
  const conjuncts: ConvergeConjunct[] = [readiness, bodyConjunct, links, { name: criteria.name, ok: criteria.ok, lines: criteria.lines }];
  const blocking = [
    ...(readiness.ok ? [] : ["pr ready: not ready"]),
    ...body.results.filter((result): boolean => !result.satisfied).map((result): string => `pr body-check: requirement '${result.name}' not satisfied`),
    ...(links.ok ? [] : links.lines),
    ...criteria.blocking,
  ];
  return { input, ready: conjuncts.every((conjunct): boolean => conjunct.ok), conjuncts, blocking };
}
