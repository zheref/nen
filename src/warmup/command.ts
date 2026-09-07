// src/warmup/command.ts -- `nen warmup`: stale-pin detection plus the
// handbook-question sweep.

import {
  emit,
  requireValue,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { readJsonFile } from "../cli/inputs.js";
import { resolveRepoRoot } from "../repo/root.js";
import { openTaxonomy } from "../schema/taxonomy.js";
import { detectStalePins, sweepHandbookQuestions, type Question, type QuestionGap } from "./sweep.js";

const USAGE = `nen warmup --current <vX.Y.Z> [--questions-from <path>] [--answers-from <path>]

Stale-pin detection over the target repository's schemas/repos.json (every
consumer's default pin AND every per-caller pin override), plus an optional
handbook-question sweep.

A consumer with NO pin recorded is reported as an 'unpinned' finding and
FAILS the run, exactly as a stale pin does: the check could not be performed,
and an unperformed check must never render as a clean one.

  --current <vX.Y.Z>       This repository's actual latest -- a plugin-shipped
                           registry.latest can itself be stale, so it is
                           stated explicitly rather than read from the file
                           being checked.
  --questions-from <path>  A JSON array of { id, text }. Omitting it skips the
                           sweep -- reported as an explicit NOT CHECKED, both
                           in the human output and as { "checked": false } in
                           --json, never as a silent "no gaps" (review
                           finding: "not checked" must never render as clean).
  --answers-from <path>    A JSON object: { "<repo>": ["<question-id>", ...] }.`;

/**
 * "Not run" and "run and found nothing" are different verdicts (review
 * finding) -- the same distinction ../release/command.ts's `Supplied<T>`
 * and ../fanout/command.ts's explicit per-consumer 'n/a' row already make.
 * An automated caller reading --json must be able to tell "no unanswered
 * handbook questions" apart from "the sweep never ran" without also having
 * to notice a flag was missing from the invocation.
 */
export type QuestionSweepResult =
  | { readonly checked: false }
  | { readonly checked: true; readonly gaps: readonly QuestionGap[] };

export const warmupCommand: Command = {
  name: "warmup",
  summary: "Detect stale pins (incl. per-caller) and sweep handbook questions.",
  usage: USAGE,
  flags: { values: ["current", "questions-from", "answers-from"] },
  run(context: CommandContext): number {
    const current = requireValue(context.args, "current", "This repository's actual latest.");
    const registry = openTaxonomy({ repoFlag: context.repoFlag }).repos();
    const pinFindings = detectStalePins(registry.consumers, current);

    // TWO VERDICTS, EACH ALWAYS PRINTED (zheref/nen#10 item 4), on the same
    // "silence is not a verdict" rule the question sweep below already
    // follows. An unpinned consumer used to be skipped outright, so a registry
    // gap and a consumer confirmed current rendered as the same "no stale
    // pins" line. Splitting the two counts also keeps the stale half's wording
    // byte-identical for every registry that has no gap.
    const stale = pinFindings.filter((finding): boolean => finding.kind === "stale");
    const unpinned = pinFindings.filter((finding): boolean => finding.kind === "unpinned");

    const lines: string[] = [];
    lines.push(stale.length === 0 ? "no stale pins" : `${stale.length} stale pin(s):`);
    for (const finding of stale) {
      lines.push(`  ${finding.repo} ${finding.field}: ${finding.pinned} -> ${current}`);
    }
    lines.push(
      unpinned.length === 0 ? "no unpinned consumers" : `${unpinned.length} unpinned consumer(s):`,
    );
    for (const finding of unpinned) {
      lines.push(
        `  ${finding.repo} ${finding.field}: NOT PINNED -- the registry records no pin, so it could not be checked against ${current}`,
      );
    }

    let questionSweep: QuestionSweepResult = { checked: false };
    const questionsPath = context.args.values["questions-from"];
    if (questionsPath !== undefined) {
      const answersPath = requireValue(
        context.args,
        "answers-from",
        "The handbook-question sweep needs both a question list and an answer set.",
      );
      const root = resolveRepoRoot({ repoFlag: context.repoFlag });
      const questions = readJsonFile<readonly Question[]>(questionsPath, root);
      const answersRaw = readJsonFile<Readonly<Record<string, readonly string[]>>>(answersPath, root);
      const answers = new Map(
        Object.entries(answersRaw).map(([repo, ids]): [string, ReadonlySet<string>] => [repo, new Set(ids)]),
      );
      const repos = registry.consumers.map((entry): string => entry.repo);
      const gaps = sweepHandbookQuestions(repos, questions, answers);
      questionSweep = { checked: true, gaps };

      lines.push(gaps.length === 0 ? "no unanswered handbook questions" : `${gaps.length} unanswered handbook question(s):`);
      for (const gap of gaps) lines.push(`  ${gap.repo}: ${gap.questionId} -- ${gap.text}`);
    } else {
      // SILENCE IS NOT A VERDICT (review finding): the same rule the release
      // preflight table and the fan-out verb's explicit per-consumer 'n/a'
      // row already honour. A missing key or an empty gap list here would be
      // indistinguishable from "swept, and clean" to a --json caller.
      lines.push("handbook-question sweep: NOT CHECKED (--questions-from was not supplied)");
    }

    emit(context.io, context.json, { current, pinFindings, questionSweep }, lines);
    const questionsFailed = questionSweep.checked && questionSweep.gaps.length > 0;
    // AN UNPINNED CONSUMER FAILS THE RUN, the same as a stale one, because
    // `pinFindings` carries both kinds. The fail-closed reading: the pin check
    // could not be performed for that consumer, and exiting 0 would assert it
    // passed. Unlike the question sweep -- whose NOT CHECKED is the caller's
    // own choice not to supply the input, and so is not a failure -- this gap
    // is in the registry the caller pointed nen at.
    return pinFindings.length === 0 && !questionsFailed ? 0 : 1;
  },
};
