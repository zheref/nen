// src/classify/command.ts -- `nen classify labels|install|status|apply`.
//
// The deterministic half of issue classification. Hatsu's ruling of 2026-10-04:
// two axes, lang/<key> and job/<key>, applied as GitHub labels; the declaration
// PR lands first and the GitHub sync follows; an axis with no confident answer
// stays empty (undecidable); low-confidence rows are listed, never applied.
// The judgement -- reading an issue and deciding its languages and jobs -- is a
// skill's prose. Everything around it is here, and every vocabulary word it
// uses (prefixes, keys, colours, descriptions, confidence levels) is read from
// the taxonomy file `--taxonomy` names, never written into this binary.
//
// Four verbs, one family, so a skill's whole mechanical loop is one noun:
//   labels   validate the taxonomy file, print the label set it defines;
//   install  compare/write the consumer's nen/labels.json, or sync GitHub;
//   status   which issues are classified, and is the machinery in place;
//   apply    apply a validated plan as labels, with a ledger line per label.
// Each lives in its own module beside this one; this file is the family's
// registration, its usage text and its dispatch.
//
// EXIT CODES (docs/USAGE.md, "Exit codes"): 0 an answer, 1 a failure, 2 a
// usage error. Usage includes a plan that does not validate: the caller typed
// the plan, and "you typed it wrong" must stay distinguishable from "gh
// refused".

import { requireSubcommand, type Command, type CommandContext } from "../cli/command.js";
import { runApply } from "./apply.js";
import { runInstall } from "./install.js";
import { runLabels } from "./labels.js";
import { runStatus } from "./status.js";

const USAGE = `nen classify -- the mechanical half of issue classification on two axes.

usage:
  nen classify labels  --taxonomy <path> [--repo <path>] [--json]
  nen classify install --taxonomy <path> --repo <path> [--write | --sync --target <owner/name>] [--dry-run] [--json]
  nen classify status  --taxonomy <path> --repo <path> --target <owner/name> (--issue <n>[,<n>...] | --open) [--json]
  nen classify apply   --taxonomy <path> --repo <path> --target <owner/name> --plan <path.json> [--run] [--include-low] [--reason <text>] [--ledger <path>] [--json]

The taxonomy file (--taxonomy) is the single source of the vocabulary: each
axis declares a label prefix, a colour and its keys, and the label set an axis
defines is prefix + key with the key's description. This binary carries none of
it. A relative --taxonomy, --plan or --ledger resolves against --repo's root.

  nen classify labels
      Validates the taxonomy file and prints the label set it defines, one line
      per label. Exit 0 valid, 1 invalid (the refusal names the pointer).

  nen classify install
      Compares the taxonomy's labels with the consumer's nen/labels.json: each
      is present, drift (colour or description differs) or absent; labels that
      wear an axis prefix but whose key the taxonomy lacks are listed as
      foreign and never touched.
        (no flag, or --dry-run)  report only. Exit 0 when every label is
                                  present, 1 otherwise.
        --write                   rewrite nen/labels.json so every taxonomy
                                  label is present: absent ones appended in
                                  taxonomy order, drifted ones updated in
                                  place, every other entry and key kept.
                                  With --dry-run, prints what would change.
        --sync --target <o/n>     create-or-update the taxonomy's labels on
                                  GitHub, and ONLY those. Refuses at exit 1
                                  while the declaration is not landed: land
                                  --write through its pull request first.
      --write and --sync together are a usage error (exit 2).

  nen classify status
      One row per issue: the keys on each axis, any label with an axis prefix
      whose key the taxonomy lacks (unknown), and the axes with no label
      (missing). Then the summary, whether nen/labels.json declares every
      taxonomy label, and whether every one exists on the repository. Exactly
      one of --issue (a comma list of positive numbers) or --open (every open
      issue; pull requests are skipped). Exit 0 whatever the state; 1 when gh
      failed or a number names a pull request.

  nen classify apply
      Applies --plan, a JSON array of rows:
        {"issue":<n>, "<axis>":["<key>",...] per axis,
         "confidence":"<level>" (optional; the taxonomy's first level),
         "reason":"<text>" (optional)}
      The WHOLE plan is validated first: positive unique issues, every key in
      its axis, every label declared in nen/labels.json, a confidence the
      taxonomy names. Any invalid row refuses the plan whole (exit 2, every
      refusal named). Rows at a confidence level the taxonomy lists as
      not-applied are reported 'listed' and skipped unless --include-low.
      Each issue is read first: a pull request number is refused (exit 1,
      nothing written) and a label the issue already carries is 'already'.
      Without --run nothing is written to GitHub (a dry run); with it each
      label is added through 'gh issue edit --add-label'. EVERY application
      writes a ledger line AFTER the mutation resolves, dry run or not, in
      the same format and default file as 'nen label apply' (--ledger
      overrides; --reason is recorded after the row's own reason).
      Exit 0 when nothing failed, 1 when any application failed.

  --taxonomy <path>   The classification taxonomy file. Required.
  --repo <path>       The checkout whose nen/labels.json is the consumer's
                      declaration. Required by install, status and apply;
                      optional on labels, where it only anchors a relative
                      --taxonomy (default: the current directory).
  --target <o/n>      The GitHub repository (never a checkout path).
  --json              Every verb prints one document with a
                      "contract": "nen.classify.<verb>/v0.1" key.`;

export const classifyCommand: Command = {
  name: "classify",
  subcommands: ["labels", "install", "status", "apply"],
  summary: "Classify issues on two axes: validate the taxonomy, install its labels, report status, apply a plan.",
  usage: USAGE,
  flags: {
    values: ["taxonomy", "target", "issue", "plan", "reason", "ledger"],
    booleans: ["write", "sync", "dry-run", "open", "run", "include-low"],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("classify", context.args, ["labels", "install", "status", "apply"]);
    switch (subcommand) {
      case "labels":
        return runLabels(context);
      case "install":
        return runInstall(context);
      case "status":
        return runStatus(context);
      default:
        return runApply(context);
    }
  },
};
