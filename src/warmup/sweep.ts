// src/warmup/sweep.ts -- `nen warmup`'s two pure checks: stale-pin detection
// (including per-caller pin fields) and the handbook-question sweep.
//
// STALE-PIN DETECTION reads ../schema/repos.ts's own `ConsumerEntry` shape:
// each consumer's `pinned` field, PLUS every per-caller override
// (`callerPins`, e.g. `db_migrate_pinned`) -- the issue's own "incl.
// per-caller fields" clause. A consumer can be current on its DEFAULT pin and
// still stale on one caller's override; reporting only the default field
// would miss exactly that. A plugin-shipped `latest` read at warm-up is what
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

export interface PinFinding {
  readonly repo: string;
  /** 'pinned', or a caller-pin field name (e.g. 'db_migrate_pinned'). */
  readonly field: string;
  readonly pinned: string;
  readonly current: string;
}

export function detectStalePins(
  consumers: readonly ConsumerEntry[],
  current: string,
): PinFinding[] {
  const findings: PinFinding[] = [];
  for (const consumer of consumers) {
    if (consumer.pinned !== null && consumer.pinned !== current) {
      findings.push({ repo: consumer.repo, field: "pinned", pinned: consumer.pinned, current });
    }
    for (const [field, value] of Object.entries(consumer.callerPins)) {
      if (value !== current) {
        findings.push({ repo: consumer.repo, field, pinned: value, current });
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
