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

    const lines: string[] = [];
    lines.push(pinFindings.length === 0 ? "no stale pins" : `${pinFindings.length} stale pin(s):`);
    for (const finding of pinFindings) {
      lines.push(`  ${finding.repo} ${finding.field}: ${finding.pinned} -> ${current}`);
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
    return pinFindings.length === 0 && !questionsFailed ? 0 : 1;
  },
};
