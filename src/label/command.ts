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

import { closeSync, writeSync } from "node:fs";
import { readTextFile, resolveAgainstRepo } from "../cli/inputs.js";
import { plainLine } from "../cli/plain.js";
import { isRecord } from "../schema/errors.js";
import {
  emit,
  parseCallerToken,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { labelLedgerPath, openLabelLedger, ledgerLine, type LedgerEntry } from "./ledger.js";
import { parseRef, RefError } from "../ref/notation.js";
import { resolveRepoRoot } from "../repo/root.js";
import { GH, ToolError } from "../seam/exec.js";
import { openTaxonomy } from "../schema/taxonomy.js";

const USAGE = `nen label apply <object-ref> --label <name> --repo-slug <owner/name> [--reason <text>] [--ledger <path>] [--run]
nen label apply --batch <file> --repo-slug <owner/name> [--reason <text>] [--ledger <path>] [--run]

Apply one label, or a JSON array of {"ref":"<CODE>-IS-#1","label":"<name>","reason":"optional"}
from --batch <file> (relative to --repo). Batch input replaces the positional
ref and --label. All pairs are validated and the ledger opened before any
mutation; a failed pair is logged and reported while later pairs continue.
--json emits one results array; human output prints one result per pair.

  <object-ref>       <CODE>-<IS|PR>-#<N>. Only the number is used against
                     --repo-slug's own numbering; the code is not re-resolved.
  --label <name>      Checked against the target repository's
                     nen/labels.json before anything is attempted.
  --repo-slug <o/n>   The owner/name the mutation runs against.
  --reason <text>      Recorded in the ledger; not sent to GitHub.
  --ledger <path>      Defaults to .nen/label-ledger.jsonl under --repo. The
                     default .nen directory is created; explicit parents
                     must exist. An unappendable ledger refuses before gh.
  --run                Without it, nothing is written to GitHub -- the ledger
                     still records the decision, with outcome:"dry-run"
                     (CON-38's dry-run-first convention,
                     scripts/sync-labels.sh). With --run, the ledger records
                     "applied" or "failed" -- whichever GitHub actually did,
                     written AFTER the call resolves.

  --repo <path>    The checkout whose nen/labels.json the label is checked
                   against, and the root --ledger defaults under. NOT
                   --repo-slug, which is the owner/name the mutation runs
                   against. Defaults to the current directory, so a call
                   made from anywhere else needs it: the taxonomy-missing
                   refusal you would otherwise meet is this flag's
                   absence, not a missing file.`;

export { DEFAULT_LEDGER } from "./ledger.js";

export const labelCommand: Command = {
  name: "label",
  subcommands: ["apply"],
  summary: "Apply a label to an object, logged (object * label * time * run).",
  usage: USAGE,
  flags: { values: ["label", "repo-slug", "reason", "ledger", "batch"], booleans: ["run"] },
  run(context: CommandContext): number {
    requireSubcommand("label", context.args, ["apply"]);
    const repoSlug = requireValue(context.args, "repo-slug", "The owner/name the mutation runs against.");
    const run = context.args.booleans.has("run");
    const root = resolveRepoRoot({ repoFlag: context.repoFlag });
    const batch = context.args.values["batch"];
    const refToken = context.args.positionals[2];
    if (context.args.positionals.length > 3) throw new VerbUsageError("label apply accepts one ref, or --batch <file>.");
    if (batch !== undefined && (refToken !== undefined || context.args.values["label"] !== undefined)) throw new VerbUsageError("--batch cannot be combined with an object ref or --label.");
    let pairs: { ref: ReturnType<typeof parseRef>; label: string; reason: string | null }[];
    const parse = (token: string): ReturnType<typeof parseRef> => parseCallerToken(() => parseRef(token), (error) => error instanceof RefError);
    const reason = context.args.values["reason"] ?? null;
    if (batch === undefined) {
      if (refToken === undefined) throw new VerbUsageError("'label apply' needs an object ref or --batch <file>.");
      pairs = [{ ref: parse(refToken), label: requireValue(context.args, "label", "The label to apply."), reason }];
    } else {
      const file = resolveAgainstRepo(root, batch);
      let value: unknown;
      try { value = JSON.parse(readTextFile(file, root, "--batch must name a readable JSON array of ref/label pairs.")) as unknown; }
      catch (error) { if (error instanceof VerbUsageError) throw error; throw new VerbUsageError(`--batch '${file}' is not valid JSON.`); }
      if (!Array.isArray(value) || value.length === 0) throw new VerbUsageError("--batch must contain a non-empty JSON array of ref/label pairs.");
      pairs = value.map((row: unknown, index) => {
        if (!isRecord(row) || Object.keys(row).some((key) => !["ref", "label", "reason"].includes(key)) || typeof row["ref"] !== "string" || typeof row["label"] !== "string" || row["label"] === "" || (row["reason"] !== undefined && typeof row["reason"] !== "string")) throw new VerbUsageError(`--batch [${index}] needs ref and label strings, and an optional reason string.`);
        return { ref: parse(row["ref"]), label: row["label"], reason: typeof row["reason"] === "string" ? row["reason"] : reason };
      });
    }
    const labels = openTaxonomy({ repoFlag: context.repoFlag }).labels();
    for (const pair of pairs) {
      if (!labels.has(pair.label)) throw new VerbUsageError(`'${pair.label}' is not in ${labels.path}. Declared labels: ${labels.names().join(", ") || "(none)"}.`);
    }
    // Validate the entire batch and open the ledger BEFORE the first mutation.
    const ledgerPath = labelLedgerPath(root, context.args.values["ledger"]);
    const fd = openLabelLedger(ledgerPath);
    const results: { entry: LedgerEntry; error: string | null }[] = [];
    let singleError: ToolError | null = null;
    try {
      const now = context.seams.now().toISOString();
      for (const pair of pairs) {
        let outcome: LedgerEntry["outcome"] = "dry-run";
        let error: ToolError | null = null;
        if (run) {
          const argv = [pair.ref.kind === "PR" ? "pr" : "issue", "edit", String(pair.ref.number), "--repo", repoSlug, "--add-label", pair.label];
          const result = context.seams.run(GH, argv);
          if (result.spawnFailed || result.code !== 0) { outcome = "failed"; error = new ToolError(GH, argv, result); }
          else outcome = "applied";
        }
        const entry: LedgerEntry = { object: pair.ref.ref, label: pair.label, time: now, outcome, reason: pair.reason };
        writeSync(fd, ledgerLine(entry) + "\n");
        results.push({ entry, error: error?.message ?? null });
        if (batch === undefined) singleError = error;
        if (batch !== undefined && !context.json) context.io.out(plainLine(`${results.length}/${pairs.length} ${entry.outcome}: '${entry.label}' on ${entry.object}${error === null ? "" : ` -- ${error.message}`}`));
      }
    } finally { closeSync(fd); }
    if (singleError !== null) throw singleError;
    if (batch !== undefined) {
      if (context.json) context.io.out(JSON.stringify({ results, ledgerPath }, null, 2));
      else context.io.out(`ledger: ${ledgerPath}`);
      return results.some(({ entry }) => entry.outcome === "failed") ? 1 : 0;
    }
    const entry = results[0]!.entry;
    emit(context.io, context.json, { entry, ledgerPath }, [plainLine(`${run ? "applied" : "(dry run) would apply"} '${entry.label}' to ${entry.object}`), `ledger: ${ledgerPath}`]);
    return 0;
  },
};
