// src/warmup/sweep.ts -- `nen warmup`'s two pure checks: stale-pin detection
// (including per-caller pin fields) and the handbook-question sweep.
//
// STALE-PIN DETECTION reads ../schema/repos.ts's own `ConsumerEntry` shape:
// each consumer's `pinned` field, PLUS every per-caller override
// (`callerPins`, e.g. `db_migrate_pinned`) -- the issue's own "incl.
// per-caller fields" clause. A consumer can be current on its DEFAULT pin and
// still stale on one caller's override; reporting only the default field
// would miss exactly that. A consumer with NO pin recorded -- a missing key or
// an empty string, the two spellings of the same absence -- is its own finding
// kind rather than a skip; see PinFinding below.
//
// A plugin-shipped `latest` read at warm-up is what
// flags a cached plugin reporting consumers current while they sit a tag
// behind (getsuga SKILL.md §3's own reason to bump it) -- so `current` is
// always the caller's own parameter, never inferred from the registry it is
// being checked against.
//
// THE HANDBOOK-QUESTION SWEEP is deliberately generic: which questions a
// consumer must be able to answer, and what "answered" means, is this
// repository's own onboarding convention and not a vocabulary nen carries.
// So a question is an opaque id/text pair and an answer set is "the ids this
// consumer has answered", both caller-supplied; the sweep's own job is only
// to report every unanswered question per consumer, never the first.

import type { ConsumerEntry } from "../schema/repos.js";

/**
 * A finding carries its KIND (zheref/nen#10 item 4). Two different facts were
 * previously reported as one absence: a consumer whose pin is behind `current`
 * was a finding, and a consumer with NO pin recorded was skipped entirely --
 * so a registry gap rendered byte-identically to a consumer confirmed current.
 * That is the vacuous truth this module's own header warns about one paragraph
 * up: `current` is always the caller's parameter precisely so a stale answer
 * cannot be inferred from the file being checked, and reading a missing field
 * as agreement inferred exactly that.
 *
 * The discriminator lives in the SAME array rather than a second one so a
 * `--json` caller that already fails on `pinFindings.length > 0` starts failing
 * on a registry gap too -- the fail-closed direction. A second key would have
 * left that caller reading "clean" for a check that was never performed.
 */
export interface PinFinding {
  /**
   * 'stale': a recorded pin behind `current`. 'unpinned': no pin recorded at
   * all -- a missing/null field OR an empty string, which record the same
   * absence.
   */
  readonly kind: "stale" | "unpinned";
  readonly repo: string;
  /** 'pinned', or a caller-pin field name (e.g. 'db_migrate_pinned'). */
  readonly field: string;
  /** The recorded pin, or null for 'unpinned' -- there was nothing to record. */
  readonly pinned: string | null;
  readonly current: string;
}

export function detectStalePins(
  consumers: readonly ConsumerEntry[],
  current: string,
): PinFinding[] {
  const findings: PinFinding[] = [];
  for (const consumer of consumers) {
    if (consumer.pinned === null || consumer.pinned === "") {
      // NOT SKIPPED. "The registry records no pin" is a finding about the
      // registry, not evidence the consumer is current.
      //
      // `""` COUNTS AS NO PIN, not as a pin that happens to be stale. A
      // registry written as `"pinned": ""` records the same absence as a
      // missing key -- both are "nobody has said which tag this consumer is
      // on" -- and the two spellings are indistinguishable to anyone reading
      // the file. Falling through to the stale branch made them differ
      // anyway: the finding rendered with a blank left-hand side (`pinned:
      // -- behind v1.1.0`) and told the operator to bump a pin from nothing,
      // which is not the fix. The `pinned` field is normalized to `null` in
      // the finding for the same reason -- one shape for one fact.
      findings.push({ kind: "unpinned", repo: consumer.repo, field: "pinned", pinned: null, current });
    } else if (consumer.pinned !== current) {
      findings.push({ kind: "stale", repo: consumer.repo, field: "pinned", pinned: consumer.pinned, current });
    }
    // A per-caller override is only ever PRESENT (../schema/repos.ts keeps the
    // raw fields), so an absent one is not a gap the way a missing default pin
    // is -- there is no field to have been left blank.
    for (const [field, value] of Object.entries(consumer.callerPins)) {
      if (value !== current) {
        findings.push({ kind: "stale", repo: consumer.repo, field, pinned: value, current });
      }
    }
  }
  return findings;
}

export interface Question {
  readonly id: string;
  readonly text: string;
}

export interface QuestionGap {
  readonly repo: string;
  readonly questionId: string;
  readonly text: string;
}

/** `answers`: repo -> the set of question ids that repo has answered. */
export function sweepHandbookQuestions(
  repos: readonly string[],
  questions: readonly Question[],
  answers: ReadonlyMap<string, ReadonlySet<string>>,
): QuestionGap[] {
  const gaps: QuestionGap[] = [];
  for (const repo of repos) {
    const answered = answers.get(repo) ?? new Set<string>();
    for (const question of questions) {
      if (!answered.has(question.id)) {
        gaps.push({ repo, questionId: question.id, text: question.text });
      }
    }
  }
  return gaps;
}
