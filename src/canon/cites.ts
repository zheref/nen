// Read-only clause citation closure. Binding vocabulary belongs to the caller.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ClauseWiringError, scanClauses } from "./clause.js";

export const CLAUSE_CITES_CONTRACT = "nen.canon.clause-cites/v0.1";
export interface StatusVocabulary {
  readonly whole: readonly string[];
  readonly none: readonly string[];
  readonly displacement: readonly string[];
  /** Explicit status for homes whose definitions have no status annotation. */
  readonly unannotated: Readonly<Record<string, string>>;
}
export interface CitedClause {
  readonly id: string;
  readonly resolution: "defined" | "dangling";
  readonly file: string | null;
  readonly line: number | null;
  readonly status: string | null;
  readonly binding: "whole" | "part" | "none" | "unknown";
  readonly displacedBy: readonly string[];
  readonly via: readonly string[];
}
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const read = (path: string): string => {
  try { return readFileSync(path, "utf8"); }
  catch (error) { throw new ClauseWiringError(`cannot read '${path}': ${error instanceof Error ? error.message : String(error)}`); }
};
const order = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

function parenthesis(text: string): string | null {
  const start = /^\s*\(/.exec(text);
  if (start === null) return null;
  const open = start[0].length - 1;
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === "(") depth += 1;
    if (text[at] === ")" && --depth === 0) return text.slice(open + 1, at).trim();
  }
  throw new ClauseWiringError("unclosed clause status parenthesis");
}

function statusOf(line: string, prefix: string, statusColumn: number): string | null {
  const anchored = new RegExp(`<a id="${escape(prefix.toLowerCase())}-\\d+"></a>\\*\\*${escape(prefix)}-\\d+\\*\\*`).exec(line);
  if (anchored === null) return null;
  const annotated = parenthesis(line.slice(anchored.index + anchored[0].length));
  const column = line.startsWith("|") && statusColumn >= 0 ? line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim())[statusColumn] : undefined;
  if (annotated !== null && column !== undefined && annotated !== column) throw new ClauseWiringError("conflicting parenthesis and Status-column values");
  return column ?? annotated;
}

export function clauseCites(options: { root: string; text: string; homes: Readonly<Record<string, string>>; vocabulary: StatusVocabulary | null; include?: readonly string[] }): { contract: string; clauses: readonly CitedClause[]; readSet: readonly string[]; dangling: readonly string[]; exit: 0 | 1 } {
  if (Object.keys(options.homes).length === 0) throw new ClauseWiringError("--home needs at least one PREFIX=file");
  const rows = new Map<string, Omit<CitedClause, "via">>();
  for (const [prefix, home] of Object.entries(options.homes)) {
    if (!/^[A-Z][A-Z0-9]{0,7}$/.test(prefix)) throw new ClauseWiringError(`invalid home prefix '${prefix}'`);
    const file = resolve(options.root, home);
    const body = read(file);
    const scan = scanClauses(body, prefix, false);
    if (scan.definitions.length === 0 || scan.duplicates.length > 0 || scan.mismatches.length > 0) throw new ClauseWiringError(`${file}: ${prefix} has no definitions or ambiguous definitions`);
    if (new Set(scan.definitions.map((definition) => definition.line)).size !== scan.definitions.length) throw new ClauseWiringError(`${file}: multiple definitions on one line are ambiguous for status reading`);
    const lines = body.replace(/\r\n?/g, "\n").split("\n");
    const columns = new Map<number, number>();
    let column = -1;
    let inTable = false;
    lines.forEach((line, index) => {
      const row = line.startsWith("|");
      if (row && !inTable) column = line.split(/(?<!\\)\|/).slice(1, -1).findIndex((cell) => /^status$/i.test(cell.trim()));
      inTable = row;
      columns.set(index + 1, column);
    });
    for (const definition of scan.definitions) {
      const id = `${prefix}-${definition.id}`;
      const status = statusOf(lines[definition.line - 1] ?? "", prefix, columns.get(definition.line) ?? -1) ?? options.vocabulary?.unannotated[prefix] ?? "unrecorded";
      let binding: CitedClause["binding"] = "unknown";
      let displacedBy: string[] = [];
      if (options.vocabulary !== null) {
        if (options.vocabulary.whole.includes(status)) binding = "whole";
        else if (options.vocabulary.none.includes(status)) binding = "none";
        else {
          const verb = options.vocabulary.displacement.find((candidate) => status.startsWith(`${candidate} `));
          if (verb !== undefined) {
            const tail = status.slice(verb.length + 1);
            const match = /^([A-Z][A-Z0-9]*-\d+(?:, [A-Z][A-Z0-9]*-\d+)*)( \(.+\))?$/.exec(tail);
            if (match === null) throw new ClauseWiringError(`${file}:${definition.line}: invalid displacement status '${status}'`);
            displacedBy = (match[1] as string).split(", ");
            binding = match[2] === undefined ? "none" : "part";
          } else throw new ClauseWiringError(`${file}:${definition.line}: status '${status}' is outside the declared vocabulary`);
        }
      }
      rows.set(id, { id, resolution: "defined", file, line: definition.line, status, binding, displacedBy });
    }
  }
  const request = read(resolve(options.root, options.text));
  const prefixes = Object.keys(options.homes).map(escape).join("|");
  const cited = [...request.matchAll(new RegExp(`(?<![A-Za-z0-9_-])(${prefixes})-(\\d{1,15})(?![A-Za-z0-9_-])`, "g"))].map((match) => `${match[1]}-${Number(match[2])}`);
  const result = new Map<string, CitedClause>();
  const visit = (id: string, via: string): void => {
    const previous = result.get(id);
    if (previous !== undefined) { if (!previous.via.includes(via)) result.set(id, { ...previous, via: [...previous.via, via] }); return; }
    const row = rows.get(id);
    if (row === undefined) { result.set(id, { id, resolution: "dangling", file: null, line: null, status: null, binding: "unknown", displacedBy: [], via: [via] }); return; }
    result.set(id, { ...row, via: [via] });
    for (const next of row.displacedBy) visit(next, `follows ${id}`);
  };
  for (const id of options.include ?? []) {
    if (!/^[A-Z][A-Z0-9]{0,7}-\d{1,15}$/.test(id)) throw new ClauseWiringError(`invalid included clause id '${id}'`);
    visit(id, "included");
  }
  for (const id of cited) visit(id, "cited");
  const clauses = [...result.values()].sort((a, b) => order(a.id, b.id));
  const dangling = clauses.filter((clause) => clause.resolution === "dangling").map((clause) => clause.id);
  return { contract: CLAUSE_CITES_CONTRACT, clauses, readSet: clauses.filter((clause) => clause.binding === "whole" || clause.binding === "part").map((clause) => `${clause.id}${clause.binding === "part" ? "(part)" : ""}`), dangling, exit: dangling.length > 0 ? 1 : 0 };
}
