// Shared effort filtering: evaluate each issue and its direct PRs, never a
// transitive component (a shared PR must not mix two issues' labels).
import { VerbUsageError, requireRepoFlag, type CommandContext } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import { assertRepoRoot } from "../repo/root.js";
import { decomposeLabelName, loadLabelTaxonomy, type LabelTaxonomy } from "../schema/labels.js";

export interface EffortFilter {
  readonly labels: readonly string[];
  readonly severity: string | null;
  readonly severityLabels: readonly string[];
}
export interface EffortObject {
  readonly kind: "issue" | "pr";
  readonly number: number;
  readonly labels: readonly string[];
  readonly linked: readonly number[];
}
export const objectKey = (object: Pick<EffortObject, "kind" | "number">): string => `${object.kind}:${object.number}`;

export function validateFilter(taxonomy: LabelTaxonomy, labels: readonly string[], severity?: string, order?: string): EffortFilter {
  for (const name of labels) {
    if (name.trim() === "") throw new VerbUsageError("--label requires a nonempty declared label name.");
    const amp = taxonomy.names().find((declared) => declared.includes("&") && (declared === name || declared.split("&").some((part) => part.trim() === name)));
    if (name.includes("&") || (!taxonomy.has(name) && amp !== undefined)) {
      throw new VerbUsageError(`labels containing '&' are not supported in selectors${amp === undefined ? `: '${name}'` : `: '${amp}'`}.`);
    }
    if (!taxonomy.has(name)) throw new VerbUsageError(`--label '${name}' is not declared in ${taxonomy.path}.`);
  }
  if (severity === undefined) {
    if (order !== undefined) throw new VerbUsageError("--severity-order on a filtered fetch requires --severity.");
    return { labels: [...new Set(labels)], severity: null, severityLabels: [] };
  }
  const declared = taxonomy.names().filter((name) => decomposeLabelName(name).family === "severity");
  if (declared.length === 0) throw new VerbUsageError(`--severity requires declared severity-family labels (<namespace>:severity/<band>) in ${taxonomy.path}; none are declared.`);
  if (order === undefined || order.trim() === "") throw new VerbUsageError("--severity requires --severity-order listing every declared severity label, highest to lowest; no order is inferred.");
  const resolve = (token: string): string => {
    const matches = declared.filter((name) => name === token || decomposeLabelName(name).leaf?.toLowerCase() === token.toLowerCase());
    if (matches.length !== 1) throw new VerbUsageError(`severity '${token}' has ${matches.length === 0 ? "no" : "an ambiguous"} declared severity-label mapping in ${taxonomy.path}; use an exact declared label name.`);
    return matches[0]!;
  };
  const tokens = order.split(",").map((token) => token.trim());
  if (tokens.some((token) => token === "")) throw new VerbUsageError("--severity-order contains an empty band.");
  const ranked = tokens.map(resolve);
  if (new Set(ranked).size !== ranked.length || declared.some((name) => !ranked.includes(name))) throw new VerbUsageError("--severity-order must list every declared severity label exactly once, highest to lowest.");
  const plus = severity.endsWith("+");
  const token = plus ? severity.slice(0, -1) : severity;
  if (token === "" || token.includes("+")) throw new VerbUsageError("--severity takes one band with at most one trailing '+'.");
  const selected = resolve(token);
  return { labels: [...new Set(labels)], severity: `${selected}${plus ? "+" : ""}`, severityLabels: plus ? ranked.slice(0, ranked.indexOf(selected) + 1) : [selected] };
}

export function readEffortFilter(context: CommandContext): EffortFilter | null {
  const labels = context.args.lists["label"] ?? [];
  const severity = context.args.values["severity"];
  const order = context.args.values["severity-order"];
  if (labels.length === 0 && severity === undefined && order === undefined) return null;
  const root = assertRepoRoot({ repoFlag: requireRepoFlag(context, "Filtered remote objects require the target's declared nen/labels.json in this checkout; supply the matching target taxonomy.") });
  return validateFilter(loadLabelTaxonomy(root), labels, severity, order);
}

export function matchesEffort(filter: EffortFilter, members: readonly Pick<EffortObject, "labels">[]): boolean {
  const labels = new Set(members.flatMap((member) => member.labels));
  return filter.labels.every((name) => labels.has(name)) && (filter.severityLabels.length === 0 || filter.severityLabels.some((name) => labels.has(name)));
}

export function filterObjects<T extends EffortObject>(objects: readonly T[], filter: EffortFilter): T[] {
  const issues = objects.filter((object) => object.kind === "issue");
  const prs = objects.filter((object) => object.kind === "pr");
  const linkedPrs = new Set<number>();
  const keep = new Set<string>();
  for (const issue of issues) {
    const direct = prs.filter((pr) => issue.linked.includes(pr.number) || pr.linked.includes(issue.number));
    for (const pr of direct) linkedPrs.add(pr.number);
    const effort = [issue, ...direct];
    if (matchesEffort(filter, effort)) for (const object of effort) keep.add(objectKey(object));
  }
  for (const pr of prs) if (!linkedPrs.has(pr.number) && matchesEffort(filter, [pr])) keep.add(objectKey(pr));
  return objects.filter((object) => keep.has(objectKey(object)));
}

export function renderFilter(filter: EffortFilter): string {
  return plainLine(`filter: labels=${filter.labels.length === 0 ? "(none)" : filter.labels.join(" AND ")}; severity=${filter.severity ?? "(none)"}`);
}
