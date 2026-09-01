// src/epic/command.ts -- `nen epic next-wave`.
//
// A FILE IN, A FILE OUT, AND A SUMMARY ON STDOUT -- the same shape the
// coordinator this ports had, because the caller around it is a workflow that
// reads the summary and commits the file. Changing the shape would have been a
// gratuitous break in the one place a port is most likely to be dropped into an
// existing pipeline.
//
// `--out` IS OPTIONAL HERE and was required there. A caller that only wants the
// wave -- "what would be released if I flipped this child?" -- must be able to
// ask without writing a body to disk, and a verb that forced an output path
// would have callers writing to a temporary file they then delete.

import { readFileSync, writeFileSync } from "node:fs";
import { requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { coordinate, DuplicateChildIdError } from "./waves.js";

const USAGE = `nen epic next-wave -- flip a completed child, redraw progress, compute the next wave.

usage:
  nen epic next-wave --body-file <path> --citation <rule-id>
                     [--completed <n>] [--inflight 1,2] [--cap <n>] [--out <path>]

  --body-file   the parent issue's body, as markdown.
  --citation    the rule id the progress footer cites. REQUIRED and never
                defaulted: a clause id belongs to a repository's canon, not to
                this binary.
  --completed   the child whose delivery just merged. Flipping is idempotent.
  --inflight    children already released -- they occupy cap slots while they
                are still unchecked, and stop occupying them once they are not.
  --cap         how many children may be in flight at once. Default 3.
  --out         write the rewritten body here. Omit to compute without writing.

Prints {"total","done","release"} on stdout with --json, or a short report
otherwise. A child is released only when EVERY declared blocker is a known,
checked child of this parent -- an unknown id never clears the gate. Exits 1
(never writing --out) when the same child id appears more than once in the
checklist -- a duplicate is an authoring error this coordinator refuses to
guess past rather than silently pick a tie-break for.`;

export const epicCommand: Command = {
  name: "epic",
  summary: "Compute an epic's next wave from its child checklist.",
  usage: USAGE,
  flags: {
    values: ["body-file", "completed", "inflight", "cap", "out", "citation"],
    booleans: [],
  },
  run(context: CommandContext): number {
    requireSubcommand("epic", context.args, ["next-wave"]);
    const bodyFile = context.args.values["body-file"];
    if (bodyFile === undefined) throw new VerbUsageError("--body-file <path> is required.");
    const citation = context.args.values["citation"];
    if (citation === undefined || citation.trim() === "") {
      throw new VerbUsageError(
        "--citation <rule-id> is required. The progress footer names the rule the coordinator acts under, and that name is the target repository's, never this binary's.",
      );
    }

    let body: string;
    try {
      // CRLF is normalized on the way IN, because the checklist regexes are
      // anchored at end-of-line and a stray carriage return would put one
      // inside the `rest` group -- where it would then be written back out into
      // the middle of a rewritten line.
      body = readFileSync(bodyFile, "utf8").replace(/\r\n/g, "\n");
    } catch (error) {
      context.io.err(`nen: could not read --body-file '${bodyFile}': ${String(error)}`);
      return 1;
    }

    const completedRaw = context.args.values["completed"];
    const completed =
      completedRaw === undefined ? null : Number(completedRaw.replace(/^#/, ""));
    if (completed !== null && !Number.isInteger(completed)) {
      throw new VerbUsageError(`--completed '${completedRaw ?? ""}' is not an issue number.`);
    }
    const inflight = new Set(
      [...(context.args.values["inflight"] ?? "").matchAll(/\d+/g)].map((m): number => Number(m[0])),
    );
    const capRaw = context.args.values["cap"];
    const cap = capRaw === undefined ? 3 : Number(capRaw);
    if (!Number.isInteger(cap) || cap < 0) {
      throw new VerbUsageError(`--cap '${capRaw ?? ""}' must be a non-negative integer.`);
    }

    let result;
    try {
      result = coordinate(body, completed, inflight, cap, citation);
    } catch (error) {
      if (error instanceof DuplicateChildIdError) {
        context.io.err(`nen: ${error.message}`);
        return 1;
      }
      throw error;
    }
    const out = context.args.values["out"];
    if (out !== undefined) {
      writeFileSync(out, result.body, "utf8");
    }

    if (context.json) {
      context.io.out(JSON.stringify(result.summary));
      return 0;
    }
    context.io.out(`children: ${result.summary.done}/${result.summary.total} done`);
    if (result.summary.release.length === 0) {
      context.io.out("next wave: nothing releasable -- every unchecked child is blocked, in flight, or the cap is full");
    }
    for (const entry of result.summary.release) {
      context.io.out(`next wave: #${entry.child}${entry.owner === null ? "" : ` -> ${entry.owner}`}`);
    }
    if (out !== undefined) context.io.out(`wrote ${out}`);
    return 0;
  },
};
