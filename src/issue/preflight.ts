// src/issue/preflight.ts -- `issue file` / `idea file --requirements-from`:
// the body-shape check, run before the create (zheref/nen#476 scope).
//
// WHY. `issue body-check` reads a body against the caller's section
// catalogue; a filing that skipped it could still land a body missing a
// required section. With `--requirements-from <catalogue> [--kind <kind>]`
// on either filing verb, the same check (`checkIssueBody`, the one function
// `issue body-check` calls) runs on the very bytes about to be sent, and any
// miss refuses the filing before anything is read from or written to GitHub.
// Advisories (vague and technology words) are printed by `body-check` and
// never block a filing, exactly as they never fail `body-check`.

import { readJsonFile, resolveAgainstRepo } from "../cli/inputs.js";
import { VerbUsageError } from "../cli/command.js";
import { checkIssueBody, IssueShapeError, parseCatalogue, selectKind } from "./shape.js";

/** The flag values the pre-create check reads. */
export interface ShapePreflightFlags {
  readonly requirementsFrom: string | undefined;
  readonly kind: string | undefined;
}

/**
 * The refusal reasons for `body`, or `[]` when it carries every required
 * section in shape -- and `null` when no catalogue was named (nothing checked).
 * A `--kind` without `--requirements-from`, an unreadable or malformed
 * catalogue and an undeclared kind are usage refusals (exit 2).
 */
export function shapePreflight(root: string, flags: ShapePreflightFlags, body: string, verb: string): readonly string[] | null {
  if (flags.requirementsFrom === undefined) {
    if (flags.kind !== undefined) throw new VerbUsageError(`--kind is read by '${verb}' only with --requirements-from, which names the catalogue it selects a kind of.`);
    return null;
  }
  if (flags.requirementsFrom === "") throw new VerbUsageError("--requirements-from names the issue-sections catalogue; it cannot be empty.");
  let kind: string;
  let report;
  try {
    const catalogue = parseCatalogue(
      readJsonFile<unknown>(resolveAgainstRepo(root, flags.requirementsFrom), process.cwd(), `--requirements-from is the catalogue '${verb}' checks the body against before it files.`),
    );
    kind = selectKind(catalogue, flags.kind);
    report = checkIssueBody(body.replace(/\r\n?/g, "\n"), catalogue, kind);
  } catch (error) {
    if (error instanceof IssueShapeError) throw new VerbUsageError(`'${flags.requirementsFrom}': ${error.message}`);
    throw error;
  }
  return report.misses.map(
    (miss): string => `body-check (kind '${kind}'): ${miss.kind}${miss.line === null ? "" : ` line ${miss.line}`}: ${miss.detail}; nothing was filed`,
  );
}
