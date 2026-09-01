// src/gate/command.ts -- `nen gate derive`.

import {
  emit,
  requireSubcommand,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { changedFiles, changedFilesUsage, CHANGED_FILE_FLAGS, splitList } from "../cli/inputs.js";
import { resolveRepoRoot } from "../repo/root.js";
import { derive } from "./derive.js";

const USAGE = `nen gate derive --policy-paths <a,b> --process-paths <c,d> (--files ... | --files-from ... | --range ...) [--asserted <G2|G4>]

Derive the gate a pull request's DIFF sits at: the changed-file set against two
path sets.

${changedFilesUsage()}
  --policy-paths <a,b>   Policy/spec paths. A hit derives G4: only the human
                         merges policy.
  --process-paths <c,d>  Process-surface paths. A hit derives G4 too, for a
                         different reason: in a repository whose product is its
                         process, a process change IS a policy change.
  --asserted <G2|G4>     The gate the caller believes this is. When it disagrees
                         with the derivation, the disagreement is reported and
                         the DERIVED gate stands: the gate is a property of the
                         diff, not of the request.

A pattern is an exact path, a directory prefix ending '/', or a glob whose '*'
CROSSES '/' -- the shell spelling the sources use, where 'handbooks/*' covers any
depth beneath it rather than one level.

There are no built-in path sets. They are the target repository's canon, and a
binary carrying one repository's sets would derive that repository's gates
everywhere it was pointed.

This derives the DIFF's half only. A pull request that is not ready has no gate.`;

export const gateCommand: Command = {
  name: "gate",
  summary: "Derive G2/G4 from a changed-file set and two path sets.",
  usage: USAGE,
  flags: {
    values: [
      CHANGED_FILE_FLAGS.files,
      CHANGED_FILE_FLAGS.filesFrom,
      CHANGED_FILE_FLAGS.range,
      "policy-paths",
      "process-paths",
      "asserted",
    ],
  },
  run(context: CommandContext): number {
    requireSubcommand("gate", context.args, ["derive"]);
    const root = resolveRepoRoot({ repoFlag: context.repoFlag });
    const changed = changedFiles(context, root);
    // BOTH FLAGS MUST BE PRESENT (review finding, blocker-adjacent): an
    // ABSENT flag and an explicitly-empty one must not read the same. Forget
    // --process-paths and its set silently contributes no hits -- a diff that
    // touches only the process surface then derives G2 (agent-mergeable)
    // instead of G4, and the basis line went on to claim "the diff touches
    // neither path set", an affirmative statement that both were consulted
    // when one never was. `--policy-paths ""` / `--process-paths ""` stay
    // legal: that is a caller's explicit assertion that the set is empty, not
    // an omission.
    const policyPathsRaw = context.args.values["policy-paths"];
    const processPathsRaw = context.args.values["process-paths"];
    if (policyPathsRaw === undefined) {
      throw new VerbUsageError(
        "--policy-paths is required. An absent flag would silently contribute zero hits and could derive G2 for a policy change nen never checked; pass --policy-paths '' to explicitly assert this repository has none.",
      );
    }
    if (processPathsRaw === undefined) {
      throw new VerbUsageError(
        "--process-paths is required. Same reasoning as --policy-paths: an absent flag must never derive G2 by silently checking nothing; pass --process-paths '' to explicitly assert this repository has none.",
      );
    }
    const policy = splitList(policyPathsRaw);
    const process = splitList(processPathsRaw);
    const asserted = context.args.values["asserted"] ?? null;
    if (asserted !== null && asserted !== "G2" && asserted !== "G4") {
      throw new VerbUsageError(`--asserted takes G2 or G4, got '${asserted}'.`);
    }

    const derivation = derive(changed, { policy, process }, asserted);
    const lines = [derivation.gate, derivation.basis];
    if (derivation.corrected) {
      lines.push(
        `correction: the invocation asserted ${String(derivation.asserted)}; the diff derives ${derivation.gate}, and the derived gate stands.`,
      );
    }
    lines.push(derivation.readinessNote);
    emit(context.io, context.json, derivation, lines);
    return 0;
  },
};
