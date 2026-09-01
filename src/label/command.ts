// src/label/command.ts -- `nen label apply --run`.
//
// PORTED CONVENTIONS FROM scripts/sync-labels.sh (CON-38): a label that would
// fail to apply is reported by name rather than aborting silently, and --run
// is required before anything is written -- the same dry-run-first discipline
// the source uses ("would sync: ..." vs the real `gh label` call), applied
// here to a single object · label mutation instead of a whole taxonomy.
//
// THE LABEL IS CHECKED AGAINST THE TARGET REPOSITORY'S TAXONOMY before
// anything is attempted, exactly as ../ref/command.ts checks a product code
// against the registry: applying a label GitHub has never heard of either
// creates an unintended one-off or fails opaquely, and either way the ledger
// would record a mutation that never reflects what the taxonomy says this
// repository's labels are.
//
// EVERY CALL WRITES A LEDGER LINE, dry run or not -- see ../label/ledger.ts.
// THE LINE IS APPENDED AFTER THE MUTATION RESOLVES, never before (review
// finding): the ledger's own header calls itself "the after-the-fact record",
// and writing `run: true` before `gh` had even answered made that record
// wrong in exactly the case an audit trail exists for -- a 404, a 403, a
// rate limit, or a PR closed since would exit 1 while the ledger kept a
// permanent claim that the label was applied.

import { appendFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  emit,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { ledgerLine, type LedgerEntry } from "./ledger.js";
import { parseRef } from "../ref/notation.js";
import { resolveRepoRoot } from "../repo/root.js";
import { GH, ToolError } from "../seam/exec.js";
import { openTaxonomy } from "../schema/taxonomy.js";

const USAGE = `nen label apply <object-ref> --label <name> --repo-slug <owner/name> [--reason <text>] [--ledger <path>] [--run]

Apply a label to one object, logged.

  <object-ref>       <CODE>-<IS|PR>-#<N>. Only the number is used against
                     --repo-slug's own numbering; the code is not re-resolved.
  --label <name>      Checked against the target repository's
                     schemas/labels.json before anything is attempted.
  --repo-slug <o/n>   The owner/name the mutation runs against.
  --reason <text>      Recorded in the ledger; not sent to GitHub.
  --ledger <path>      Defaults to changelog.d/../label-ledger.jsonl under the
                     target repository's root -- state one explicitly for a
                     durable location.
  --run                Without it, nothing is written to GitHub -- the ledger
                     still records the decision, with outcome:"dry-run"
                     (CON-38's dry-run-first convention,
                     scripts/sync-labels.sh). With --run, the ledger records
                     "applied" or "failed" -- whichever GitHub actually did,
                     written AFTER the call resolves.`;

const DEFAULT_LEDGER = "label-ledger.jsonl";

export const labelCommand: Command = {
  name: "label",
  summary: "Apply a label to an object, logged (object * label * time * run).",
  usage: USAGE,
  flags: { values: ["label", "repo-slug", "reason", "ledger"], booleans: ["run"] },
  run(context: CommandContext): number {
    requireSubcommand("label", context.args, ["apply"]);
    const refToken = context.args.positionals[2];
    if (refToken === undefined) {
      throw new VerbUsageError("'label apply' needs an object ref, e.g. 'label apply XX-PR-#12 --label wake'.");
    }
    const ref = parseRef(refToken);

    const labelName = requireValue(context.args, "label", "The label to apply.");
    const repoSlug = requireValue(context.args, "repo-slug", "The owner/name the mutation runs against.");
    const reason = context.args.values["reason"] ?? null;
    const run = context.args.booleans.has("run");

    const taxonomy = openTaxonomy({ repoFlag: context.repoFlag });
    const labels = taxonomy.labels();
    if (!labels.has(labelName)) {
      throw new VerbUsageError(
        `'${labelName}' is not in ${labels.path}. Declared labels: ${labels.names().join(", ") || "(none)"}.`,
      );
    }

    const now = context.seams.now().toISOString();
    const ledgerPathRaw = context.args.values["ledger"] ?? DEFAULT_LEDGER;
    const root = resolveRepoRoot({ repoFlag: context.repoFlag });
    const ledgerPath = isAbsolute(ledgerPathRaw) ? ledgerPathRaw : resolvePath(root, ledgerPathRaw);

    // THE MUTATION IS ATTEMPTED BEFORE THE LEDGER IS WRITTEN (review finding:
    // the ledger used to record `run: true` before this call, so a 404/403/
    // rate-limit refusal from GitHub left a permanent, append-only record
    // asserting a label that was never actually applied). `outcome` is
    // computed from what GitHub actually answered, not from whether --run was
    // given.
    let outcome: LedgerEntry["outcome"] = "dry-run";
    let toolError: ToolError | null = null;
    if (run) {
      const kind = ref.kind === "PR" ? "pr" : "issue";
      const result = context.seams.run(GH, [kind, "edit", String(ref.number), "--repo", repoSlug, "--add-label", labelName]);
      if (result.spawnFailed || result.code !== 0) {
        outcome = "failed";
        toolError = new ToolError(GH, [kind, "edit", String(ref.number), "--repo", repoSlug, "--add-label", labelName], result);
      } else {
        outcome = "applied";
      }
    }

    const entry: LedgerEntry = { object: ref.ref, label: labelName, time: now, outcome, reason };
    appendFileSync(ledgerPath, ledgerLine(entry) + "\n", "utf8");

    if (toolError !== null) throw toolError;

    const lines = [
      `${run ? "applied" : "(dry run) would apply"} '${labelName}' to ${ref.ref}`,
      `ledger: ${ledgerPath}`,
    ];
    emit(context.io, context.json, { entry, ledgerPath }, lines);
    return 0;
  },
};
