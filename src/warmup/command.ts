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
import { detectStalePins, sweepHandbookQuestions, type Question } from "./sweep.js";

const USAGE = `nen warmup --current <vX.Y.Z> [--questions-from <path>] [--answers-from <path>]

Stale-pin detection over the target repository's schemas/repos.json (every
consumer's default pin AND every per-caller pin override), plus an optional
handbook-question sweep.

  --current <vX.Y.Z>       This repository's actual latest -- a plugin-shipped
                           registry.latest can itself be stale, so it is
                           stated explicitly rather than read from the file
                           being checked.
  --questions-from <path>  A JSON array of { id, text }.
  --answers-from <path>    A JSON object: { "<repo>": ["<question-id>", ...] }.`;

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

    let gaps: ReturnType<typeof sweepHandbookQuestions> = [];
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
      gaps = sweepHandbookQuestions(repos, questions, answers);

      lines.push(gaps.length === 0 ? "no unanswered handbook questions" : `${gaps.length} unanswered handbook question(s):`);
      for (const gap of gaps) lines.push(`  ${gap.repo}: ${gap.questionId} -- ${gap.text}`);
    }

    emit(context.io, context.json, { current, pinFindings, questionGaps: gaps }, lines);
    return pinFindings.length === 0 && gaps.length === 0 ? 0 : 1;
  },
};
