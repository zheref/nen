// src/classify/status.ts -- `nen classify status`.
//
// "Which issues still need classifying, and is the machinery in place to do it?"
// -- one read-only answer. For each issue it reads the labels already on it and
// sorts them by axis prefix into the keys the taxonomy knows, the ones it does
// not (`unknown`: an axis-prefixed label whose key the taxonomy lacks -- a
// retired key, a typo), and the axes with nothing on them (`missing`). An issue
// is `classified` only when EVERY axis has a label: an axis with no confident
// answer stays empty by ruling (undecidable), and a sweep picks it up again.
//
// ALSO REPORTED, because a classification sweep is pointless before them:
//   declared  whether the consumer's nen/labels.json carries every taxonomy
//             label (the declaration PR landed);
//   github    whether every taxonomy label exists on the repository (the sync
//             ran). Existence only -- drift is `install`'s question.
//
// `--with-body` ADDS `body` and `comments` TO EACH ISSUE so a classifying skill
// needs no second read per issue (an N+1 a reviewer flagged): both ride the
// payload this verb already fetches -- the `issues/{n}` read for --issue, the
// list page for --open -- so the flag costs no extra call. Without it the
// output is byte for byte what it was.
//
// A STATUS IS AN ANSWER, so the exit is 0 whatever the state; it is 1 only when
// gh itself failed. A number that names a PULL REQUEST is refused rather than
// reported as an unlabelled issue: it is not an issue and a sweep must not try.
//
// NO SILENT TRUNCATION. `--open` pages through GitHub to the end (../backlog/
// fetch.ts, the same reader `backlog fetch` uses) and says so when it stopped
// at the defensive page ceiling; the label list is read at GitHub's `--limit`
// and says so when it came back full.

import {
  splitIntegerList,
  VerbUsageError,
  type CommandContext,
} from "../cli/command.js";
import { splitList } from "../cli/inputs.js";
import { fetchPaginated } from "../backlog/fetch.js";
import type { Target } from "../github/target.js";
import { loadLabelTaxonomy } from "../schema/labels.js";
import { GH, mustJson, outputLines, type Seams } from "../seam/exec.js";
import { loadRequiringRepo, requireTarget } from "./common.js";
import { compareDeclaration, notLanded } from "./install.js";
import { AXES, axisOfLabel, taxonomyLabels, type AxisName, type ClassifyTaxonomy } from "./taxonomy.js";

/** GitHub's own ceiling on one `gh label list` call, passed as `--limit`. */
export const LABEL_LIST_LIMIT = 500;

export type IssueStatus = Record<AxisName, string[]> & {
  number: number;
  title: string;
  labels: string[];
  unknown: string[];
  missing: AxisName[];
  classified: boolean;
  /** Only with --with-body: the issue body as GitHub returns it, "" when null. */
  body?: string;
  /** Only with --with-body: the issue's `comments` count from the same read. */
  comments?: number;
};

/** What `--with-body` reads off the payload. */
export interface BodyFields {
  readonly body: string;
  readonly comments: number;
}

export type Summary = Record<string, number> & { total: number; classified: number; missingBoth: number };

export interface Verdict {
  /** `ok`, or `missing <n>`. */
  readonly status: string;
  readonly missing: readonly string[];
}

export function labelListArgv(target: Target): readonly string[] {
  return ["label", "list", "--repo", target.slug, "--limit", String(LABEL_LIST_LIMIT), "--json", "name,color,description"];
}

export function classifyLabels(
  taxonomy: ClassifyTaxonomy,
  number: number,
  title: string,
  labels: readonly string[],
  extra: BodyFields | null = null,
): IssueStatus {
  const keys = Object.fromEntries(AXES.map((name): [AxisName, string[]] => [name, []])) as Record<AxisName, string[]>;
  const unknown: string[] = [];
  for (const name of labels) {
    const found = axisOfLabel(taxonomy, name);
    if (found === null) continue;
    if (taxonomy.axes[found.axis].keys.some((entry): boolean => entry.key === found.key)) keys[found.axis].push(found.key);
    else unknown.push(name);
  }
  const missing = AXES.filter((name): boolean => keys[name].length === 0);
  const base: IssueStatus = { number, title, labels: [...labels], ...keys, unknown, missing, classified: missing.length === 0 };
  return extra === null ? base : { ...base, body: extra.body, comments: extra.comments };
}

/** `missing` + the axis name with its first letter raised: `missingLang`. */
export function missingField(axis: AxisName): string {
  return `missing${axis.charAt(0).toUpperCase()}${axis.slice(1)}`;
}

export function summarize(issues: readonly IssueStatus[]): Summary {
  const summary: Summary = {
    total: issues.length,
    classified: issues.filter((issue): boolean => issue.classified).length,
  } as Summary;
  for (const name of AXES) {
    summary[missingField(name)] = issues.filter((issue): boolean => issue.missing.includes(name)).length;
  }
  summary.missingBoth = issues.filter((issue): boolean => issue.missing.length === AXES.length).length;
  return summary;
}

function parseIssueList(raw: string): number[] {
  const entries = splitList(raw);
  if (entries.length === 0) throw new VerbUsageError("--issue names no issue. It takes a comma-separated list of positive whole numbers.");
  const numbers = splitIntegerList(entries, "issue");
  if (numbers.some((n): boolean => n <= 0)) {
    throw new VerbUsageError(`--issue takes positive whole numbers, got '${raw}'.`);
  }
  return [...new Set(numbers)];
}

interface RawOpenIssue {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly ({ readonly name: string } | string)[];
  readonly pull_request?: unknown;
  readonly body?: string | null;
  readonly comments?: number;
}

function bodyFields(item: { readonly body?: unknown; readonly comments?: unknown }): BodyFields {
  return {
    body: typeof item.body === "string" ? item.body : "",
    comments: typeof item.comments === "number" ? item.comments : 0,
  };
}

/** One `issues/{n}` read: the labels, whether it is a pull request, and the body fields. */
function readOne(seams: Seams, target: Target, number: number): { fields: BodyFields; raw: Partial<RawOpenIssue> } {
  const result = seams.run(GH, ["api", `repos/${target.slug}/issues/${number}`]);
  if (result.spawnFailed || result.code !== 0) {
    throw new Error(`could not read ${target.slug}#${number}: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}`);
  }
  const raw = JSON.parse(result.stdout) as Partial<RawOpenIssue>;
  return { fields: bodyFields(raw), raw };
}

interface Gathered {
  readonly issues: IssueStatus[];
  readonly truncated: boolean;
}

function gather(seams: Seams, target: Target, taxonomy: ClassifyTaxonomy, issueFlag: string | undefined, withBody: boolean): Gathered {
  if (issueFlag !== undefined) {
    const numbers = parseIssueList(issueFlag);
    const read = numbers.map((number) => ({ number, ...readOne(seams, target, number) }));
    const prs = read.filter((entry): boolean => entry.raw.pull_request !== undefined && entry.raw.pull_request !== null);
    if (prs.length > 0) {
      throw new Error(
        `${prs.map((entry): string => `#${entry.number}`).join(", ")} name${prs.length === 1 ? "s" : ""} a pull request in ${target.slug}, not an issue. Nothing was reported.`,
      );
    }
    return {
      issues: read.map((entry): IssueStatus =>
        classifyLabels(
          taxonomy,
          entry.raw.number ?? entry.number,
          entry.raw.title ?? "",
          (entry.raw.labels ?? []).map((label): string => (typeof label === "string" ? label : label.name)),
          withBody ? entry.fields : null,
        ),
      ),
      truncated: false,
    };
  }
  // `issues?state=open` answers issues AND pull requests; a PR is not an issue.
  const fetched = fetchPaginated<RawOpenIssue>(seams, `repos/${target.slug}/issues?state=open`, null);
  const issues = fetched.items
    .filter((item): boolean => item.pull_request === undefined || item.pull_request === null)
    .map((item): IssueStatus =>
      classifyLabels(
        taxonomy,
        item.number,
        item.title,
        item.labels.map((label): string => (typeof label === "string" ? label : label.name)),
        withBody ? bodyFields(item) : null,
      ),
    );
  return { issues, truncated: fetched.truncated };
}

function row(issue: IssueStatus): string {
  const axes = AXES.map((name): string => `${name}: ${issue[name].join(",") || "-"}`).join("  ");
  const unknown = issue.unknown.length === 0 ? "" : `  unknown: ${issue.unknown.join(",")}`;
  return `#${issue.number}  ${axes}  missing: ${issue.missing.join(",") || "-"}${unknown}`;
}

export function runStatus(context: CommandContext): number {
  const issueFlag = context.args.values["issue"];
  const open = context.args.booleans.has("open");
  const withBody = context.args.booleans.has("with-body");
  if ((issueFlag === undefined) === !open) {
    throw new VerbUsageError(
      issueFlag === undefined
        ? "classify status needs exactly one of --issue <n>[,<n>...] or --open."
        : "--issue and --open are mutually exclusive: name the issues, or take every open one.",
    );
  }
  const target = requireTarget(context);
  const { root, taxonomy } = loadRequiringRepo(context);

  const declaredReport = compareDeclaration(taxonomy, loadLabelTaxonomy(root));
  const absent = notLanded(declaredReport);
  const declared: Verdict = {
    status: absent.length === 0 ? "ok" : `missing ${absent.length}`,
    missing: absent.map((entry): string => entry.name),
  };

  const { issues, truncated } = gather(context.seams, target, taxonomy, issueFlag, withBody);
  const summary = summarize(issues);

  const onGithub = mustJson<readonly { readonly name: string }[]>(context.seams, GH, labelListArgv(target));
  const present = new Set(onGithub.map((label): string => label.name));
  const lacking = taxonomyLabels(taxonomy).filter((label): boolean => !present.has(label.name)).map((label): string => label.name);
  const labelListTruncated = onGithub.length >= LABEL_LIST_LIMIT;
  const github: Verdict & { truncated: boolean } = {
    status: lacking.length === 0 ? "ok" : `missing ${lacking.length}`,
    missing: lacking,
    truncated: labelListTruncated,
  };

  if (context.json) {
    context.io.out(
      JSON.stringify(
        { contract: "nen.classify.status/v0.1", target: target.slug, truncated, issues, summary, declared, github },
        null,
        2,
      ),
    );
    return 0;
  }

  for (const issue of issues) context.io.out(row(issue));
  if (truncated) {
    context.io.out("TRUNCATED at a defensive page ceiling: the open-issue list may not be complete.");
  }
  const missingCounts = AXES.map((name): string => `missing ${name}: ${summary[missingField(name)]}`).join(", ");
  context.io.out(
    `${summary.total} issue(s): ${summary.classified} classified, ${missingCounts}, missing both: ${summary.missingBoth}`,
  );
  context.io.out(`declared: ${declared.status}${declared.missing.length === 0 ? "" : ` (${declared.missing.join(", ")})`}`);
  context.io.out(
    `github: ${github.status}${github.missing.length === 0 ? "" : ` (${github.missing.join(", ")})`}${labelListTruncated ? ` -- the label list hit its ${LABEL_LIST_LIMIT} limit and may be incomplete` : ""}`,
  );
  return 0;
}
