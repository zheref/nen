import { createHash } from "node:crypto";

export type FixedKind = "issues-closed" | "prs-closed" | "prs-merged";
export type Condition = { kind: FixedKind; numbers: number[] } | { kind: "query-count"; query: string; op: "==" | "<=" | "<"; value: number };
export interface Spec { contract: "nen.goal/v1"; target: string; conditions: Condition[]; all: true }
export interface Item { number: number; kind: "issue" | "pr"; state: "OPEN" | "CLOSED" | "MERGED"; url: string; closedAt: string | null }
export interface Frozen { contract: "nen.goal-frozen/v1"; specHash: string; target: string; frozenAt: string; sessionId: string; conditions: Item[][] }
export interface Evidence { kind: Condition["kind"]; met: boolean; items: Item[]; count: number; unmet: number[] }
export interface Verdict { contract: "nen.goal-check/v1"; verdict: "met" | "not-met"; target: string; scope: "fixed" | "live" | "frozen"; readAt: string; frozenAt: string | null; conditions: Evidence[]; fingerprint: string }
export interface Tracker { items(numbers: number[]): Item[]; query(query: string): Item[] }

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function keys(row: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(row).some((key) => !allowed.includes(key))) throw new Error("Unknown goal field");
}
function numbers(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((n) => !Number.isSafeInteger(n) || n <= 0) || new Set(value).size !== value.length) throw new Error("Expected unique positive issue numbers");
  return value as number[];
}
export function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function parseSpec(raw: unknown): Spec {
  const row = object(raw);
  keys(row, ["contract", "target", "conditions", "all"]);
  if (row.contract !== "nen.goal/v1" || row.all !== true || typeof row.target !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.target) || !Array.isArray(row.conditions) || row.conditions.length === 0) throw new Error("Expected nen.goal/v1, target owner/name, all:true and nonempty conditions");
  const conditions = row.conditions.map((rawCondition): Condition => {
    const c = object(rawCondition);
    if (c.kind === "issues-closed" || c.kind === "prs-closed" || c.kind === "prs-merged") {
      keys(c, ["kind", "numbers"]);
      return { kind: c.kind, numbers: numbers(c.numbers) };
    }
    keys(c, ["kind", "query", "op", "value"]);
    if (c.kind !== "query-count" || typeof c.query !== "string" || !c.query.trim() || (c.op !== "==" && c.op !== "<=" && c.op !== "<") || !Number.isSafeInteger(c.value) || (c.value as number) < 0) throw new Error("Invalid query-count condition");
    // The target is supplied separately. Refuse extra scopes/OR rather than
    // accidentally counting a different repository or a second search branch.
    if (/(?:^|\s)(?:repo:|org:|user:|OR\b)/i.test(c.query)) throw new Error("Query must not override repository scope or use OR");
    return { kind: c.kind, query: c.query, op: c.op as "==" | "<=" | "<", value: c.value as number };
  });
  return { contract: "nen.goal/v1", target: row.target, all: true, conditions };
}
export function parseItem(raw: unknown): Item {
  const r = object(raw);
  if (!Number.isSafeInteger(r.number) || (r.number as number) <= 0 || (r.__typename !== "Issue" && r.__typename !== "PullRequest") || (r.state !== "OPEN" && r.state !== "CLOSED" && r.state !== "MERGED") || typeof r.url !== "string" || (r.closedAt !== null && typeof r.closedAt !== "string") || (r.__typename === "Issue" && r.state === "MERGED")) throw new Error("Tracker returned an unreadable item");
  return { number: r.number as number, kind: r.__typename === "Issue" ? "issue" : "pr", state: r.state as Item["state"], url: r.url, closedAt: r.closedAt as string | null };
}
export function parseFrozen(raw: unknown, spec: Spec): Frozen {
  const r = object(raw);
  if (r.contract !== "nen.goal-frozen/v1" || r.specHash !== hash(spec) || r.target !== spec.target || typeof r.frozenAt !== "string" || !Number.isFinite(Date.parse(r.frozenAt)) || typeof r.sessionId !== "string" || !r.sessionId || !Array.isArray(r.conditions) || r.conditions.length !== spec.conditions.length) throw new Error("Frozen scope does not match this goal definition");
  const conditions = r.conditions.map((items, index): Item[] => {
    if (!Array.isArray(items)) throw new Error("Unreadable frozen condition");
    const parsed = items.map((item): Item => {
      const row = object(item);
      return parseItem({ ...row, __typename: row.kind === "issue" ? "Issue" : row.kind === "pr" ? "PullRequest" : null });
    });
    numbers(parsed.map((i) => i.number));
    const c = spec.conditions[index]!;
    if (c.kind !== "query-count" && JSON.stringify(parsed.map((i) => i.number).sort((a,b) => a-b)) !== JSON.stringify([...c.numbers].sort((a,b) => a-b))) throw new Error("Frozen fixed scope changed");
    return parsed;
  });
  return { contract: "nen.goal-frozen/v1", target: spec.target, specHash: hash(spec), frozenAt: r.frozenAt, sessionId: r.sessionId, conditions };
}
export function freeze(spec: Spec, tracker: Tracker, at: string, sessionId: string): Frozen {
  if (!sessionId.trim()) throw new Error("A session id is required to freeze scope");
  const conditions = spec.conditions.map((c) => c.kind === "query-count" ? tracker.query(c.query) : tracker.items(c.numbers));
  return { contract: "nen.goal-frozen/v1", specHash: hash(spec), target: spec.target, frozenAt: at, sessionId, conditions };
}
export function evaluate(spec: Spec, tracker: Tracker, at: string, frozen?: Frozen): Verdict {
  const fixedNumbers = [...new Set(spec.conditions.flatMap((c, i) => frozen ? frozen.conditions[i]!.map((item) => item.number) : c.kind === "query-count" ? [] : c.numbers))];
  const observed = new Map(tracker.items(fixedNumbers).map((item) => [item.number, item]));
  const conditions = spec.conditions.map((c, index): Evidence => {
    const scope = frozen?.conditions[index];
    const ids = scope ? scope.map((i) => i.number) : c.kind === "query-count" ? null : c.numbers;
    const items = ids === null ? tracker.query((c as Extract<Condition, {kind:"query-count"}>).query) : ids.map((n) => {
      const item = observed.get(n);
      if (!item) throw new Error(`Tracker did not return #${n}`);
      const before = scope?.find((i) => i.number === n);
      if (before && before.kind !== item.kind) throw new Error(`Frozen item #${n} changed type`);
      return item;
    });
    items.sort((a,b) => a.number-b.number);
    const unmet = items.filter((item) => {
      if (c.kind === "issues-closed" && item.kind !== "issue" || (c.kind === "prs-closed" || c.kind === "prs-merged") && item.kind !== "pr") throw new Error(`Wrong item type for #${item.number}`);
      return c.kind === "prs-merged" ? item.state !== "MERGED" : item.state === "OPEN";
    }).map((i) => i.number);
    const met = c.kind === "query-count" && !frozen ? (c.op === "==" ? items.length === c.value : c.op === "<=" ? items.length <= c.value : items.length < c.value) : unmet.length === 0;
    return { kind: c.kind, met, items, count: items.length, unmet: c.kind === "query-count" && !frozen ? met ? [] : items.map((i) => i.number) : unmet };
  });
  const scope = frozen ? "frozen" : spec.conditions.some((c) => c.kind === "query-count") ? "live" : "fixed";
  return { contract: "nen.goal-check/v1", verdict: conditions.every((c) => c.met) ? "met" : "not-met", target: spec.target, scope, readAt: at, frozenAt: frozen?.frozenAt ?? null, conditions, fingerprint: hash({ spec, scope, frozenAt: frozen?.frozenAt, conditions }) };
}
