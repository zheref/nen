// src/backlog/filter.ts -- the label and severity filter `nen backlog fetch` and
// `nen report data` share (zheref/nen#410).
//
// WHY IT IS A VERB'S AND NOT A SKILL'S. Hatsu's backlog-state and backlog-board
// gained selectors that narrow the board by label (`#model/gpt&lang/typescript`)
// and by severity band (`@high+`). Matching label names against a row is string
// equality; doing it in skill prose is the model comparing strings by eye, which
// D10 forbids for a deterministic step. One module, two callers, one answer.
//
// THE UNIT IS THE EFFORT. An issue and the pull requests that serve it are one
// row (./fetch.ts, rule 3), so a row's label set is the UNION of the issue's
// labels and every one of its pull requests' labels. A PR that carries
// `lang/typescript` for an issue that does not still puts the effort in scope:
// the board shows efforts, and the effort carries the label.
//
// AND, NEVER OR. Every `--label` must be in that union; a severity band is one
// more condition on top. "Filter out issues further" is the maintainer's words,
// and a second label that WIDENED the board would read the opposite of what it
// was typed to mean.
//
// AN UNDECLARED LABEL IS REFUSED, NEVER MATCHED AGAINST NOTHING. A typo'd
// `--label lang/typscript` that silently returned zero rows would read as "no
// such work" -- the exact "could not look" vs "found nothing" confusion this CLI
// refuses everywhere else. A filter that matches nothing on DECLARED labels is a
// real, explicit zero.
//
// LABELS CONTAINING '&' ARE UNSUPPORTED IN SELECTORS (the maintainer's ruling
// of 2026-10-17). Hatsu's selector splits `#a&b` at every '&', so such a label
// arrives here in pieces. When an undeclared value is a piece of a declared
// label containing '&', the refusal says THAT, naming the label -- never a
// plain "unknown label" that would send the caller hunting for a typo.
//
// THE SEVERITY VOCABULARY IS THE CALLER'S. This binary carries no label name
// (src/taxonomy-purity.test.ts): the family is named by `--severity-family
// <ns>:<family>` and its priority order by `--severity-order`, the same
// spelling `nen backlog order` already takes.

import { VerbUsageError, type CommandContext } from "../cli/command.js";
import { splitList } from "../cli/inputs.js";
import { resolveRepoRoot } from "../repo/root.js";
import { loadLabelTaxonomy, type LabelTaxonomy } from "../schema/labels.js";

export interface SeverityBand {
  /** The severity the caller named, in the order's own spelling. */
  readonly name: string;
  /** True for `<name>+`: that band and every band above it. */
  readonly orHigher: boolean;
  /** The full label names the band selects, highest first. */
  readonly labels: readonly string[];
}

export interface EffortFilter {
  /** Every one must be carried by the effort. */
  readonly labels: readonly string[];
  readonly severity: SeverityBand | null;
}

/** The flags the filter reads, for each caller's FlagSpec. */
export const FILTER_VALUE_FLAGS: readonly string[] = ["severity", "severity-family", "severity-order"];
export const FILTER_LIST_FLAGS: readonly string[] = ["label"];

/**
 * Read and VALIDATE the filter, or return null when none was asked for.
 *
 * THE TAXONOMY IS --repo's, AND --repo MUST BE THE TARGET'S CHECKOUT. It is
 * not cross-checked against --repo-slug/--target, on the precedent of
 * `nen issue file` and `nen label apply`, which also take the taxonomy from
 * --repo and the GitHub side from a separate flag: a consumer may keep its
 * declaration in a checkout whose origin is a fork or a mirror, and a refusal
 * keyed on the origin URL would refuse that legitimate case.
 *
 * The taxonomy is loaded from --repo's checkout ONLY when a filter is given, so
 * an unfiltered fetch stays exactly what it always was: network-only, with no
 * checkout required.
 */
export function readEffortFilter(context: CommandContext): EffortFilter | null {
  const labelValues = context.args.lists["label"] ?? [];
  const severityRaw = context.args.values["severity"];
  const familyRaw = context.args.values["severity-family"];
  const orderRaw = context.args.values["severity-order"];

  if (severityRaw === undefined && (familyRaw !== undefined || orderRaw !== undefined)) {
    throw new VerbUsageError(
      "--severity-family and --severity-order describe the band --severity selects, and no --severity was given. Pass --severity <name>[+], or drop them.",
    );
  }
  if (labelValues.length === 0 && severityRaw === undefined) return null;

  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const taxonomy = loadLabelTaxonomy(root);
  const labels = validateLabels(labelValues, taxonomy);
  const severity = severityRaw === undefined ? null : readSeverity(severityRaw, familyRaw, orderRaw, taxonomy);
  return { labels, severity };
}

function validateLabels(values: readonly string[], taxonomy: LabelTaxonomy): readonly string[] {
  const complaints: string[] = [];
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const value of values) {
    if (value.trim() === "") {
      complaints.push("an empty --label names no label");
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    if (taxonomy.has(value)) {
      kept.push(value);
      continue;
    }
    const ampersand = taxonomy
      .names()
      .filter((name): boolean => name.includes("&") && name.split("&").some((piece): boolean => piece === value));
    if (ampersand.length > 0) {
      complaints.push(
        `'${value}' is a piece of ${ampersand.map((name): string => `'${name}'`).join(", ")}: labels containing '&' are not supported in selectors, which split at every '&'`,
      );
      continue;
    }
    complaints.push(`'${value}' is not declared in ${taxonomy.path}`);
  }
  if (complaints.length > 0) {
    throw new VerbUsageError(
      `--label refused: ${complaints.join("; ")}. A filter on a label nobody declared would match nothing and read as "no such work", so it is refused instead.`,
    );
  }
  return kept;
}

function readSeverity(
  raw: string,
  familyRaw: string | undefined,
  orderRaw: string | undefined,
  taxonomy: LabelTaxonomy,
): SeverityBand {
  if (familyRaw === undefined || orderRaw === undefined) {
    throw new VerbUsageError(
      `--severity needs --severity-family <ns>:<family> (which labels ARE severities) and --severity-order <a,b,...> (highest first). nen carries no severity vocabulary of its own; it is the target repository's.`,
    );
  }
  const family = /^([^:/\s]+):([^:/\s]+)$/.exec(familyRaw);
  if (family === null) {
    throw new VerbUsageError(`--severity-family takes '<namespace>:<family>', e.g. 'acme:severity', got '${familyRaw}'.`);
  }
  const namespace = family[1] as string;
  const familyName = family[2] as string;
  const declared = taxonomy.inFamily(namespace, familyName);
  if (declared.length === 0) {
    throw new VerbUsageError(
      `${taxonomy.path} declares no '${namespace}:${familyName}/*' labels, so there is no severity family to select a band from. Declare the family, or drop --severity.`,
    );
  }
  const order = splitList(orderRaw);
  if (order.length === 0) throw new VerbUsageError("--severity-order names no severity.");
  const undeclared = order.filter((leaf): boolean => !taxonomy.has(`${namespace}:${familyName}/${leaf}`));
  if (undeclared.length > 0) {
    throw new VerbUsageError(
      `--severity-order names ${undeclared.map((leaf): string => `'${leaf}'`).join(", ")}, which ${taxonomy.path} does not declare as '${namespace}:${familyName}/<leaf>'.`,
    );
  }

  const orHigher = raw.endsWith("+");
  const name = orHigher ? raw.slice(0, -1) : raw;
  if (name.includes("+")) {
    throw new VerbUsageError(
      `--severity takes ONE severity with at most one trailing '+' (that band and higher), got '${raw}'.`,
    );
  }
  const index = order.findIndex((leaf): boolean => leaf.toLowerCase() === name.toLowerCase());
  if (index === -1) {
    throw new VerbUsageError(`--severity '${name}' is none of --severity-order's ${order.join(" | ")}.`);
  }
  const leaves = orHigher ? order.slice(0, index + 1) : [order[index] as string];
  return {
    name: order[index] as string,
    orHigher,
    labels: leaves.map((leaf): string => `${namespace}:${familyName}/${leaf}`),
  };
}

/** Does an effort carrying `labels` (the issue's and its PRs', unioned) pass? */
export function effortPasses(filter: EffortFilter, labels: Iterable<string>): boolean {
  const carried = new Set(labels);
  if (!filter.labels.every((label): boolean => carried.has(label))) return false;
  if (filter.severity !== null && !filter.severity.labels.some((label): boolean => carried.has(label))) return false;
  return true;
}

/** One human line restating the filter, for the echo. */
export function describeFilter(filter: EffortFilter): string {
  const parts: string[] = [];
  if (filter.labels.length > 0) parts.push(`label ${filter.labels.join(" AND ")}`);
  if (filter.severity !== null) {
    parts.push(`severity ${filter.severity.name}${filter.severity.orHigher ? "+" : ""} (${filter.severity.labels.join(" | ")})`);
  }
  return `filter: ${parts.join(" AND ")}`;
}
