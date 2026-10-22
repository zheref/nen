// src/canon/clause.ts -- `nen canon clause check`: a clause id space (Hatsu's
// HR-{n} in docs/ROSTER.md, Akatsuki's CON-{n} in CONSTITUTION.md) held
// unique, and a changed clause held to the files that cite it.
//
// PORTED FROM TWO GUARDS, AND THEIR RULES ARE CARRIED, NOT REWORDED:
// zheref/hatsu's scripts/clause_id_guard.mts (HR-2) and zheref/akatsuki-ai's
// ninjutsu/src/ports/clause_id_guard.ts + clause_leaf_guard.ts.
//
//   1. DEFINITIONS ARE COUNTED, CITATIONS NEVER ARE. A definition is the
//      anchor `<a id="p-N"></a>**P-N**` (Hatsu's form, any number per line)
//      or the column-0 bullet `- **P-N.` (Akatsuki's form). `[P-N](#p-N)`, a
//      bare `P-N` and `reversed by P-N` are citations.
//   2. A DUPLICATE ID EXITS 1: two efforts minting one id merge cleanly at
//      different offsets and leave every citation of it ambiguous. An anchor
//      whose `p-N` and `**P-M**` disagree is refused the same way.
//   3. GAPS ARE REPORTED, NEVER FAILED: a missing id is a retired clause.
//   4. ORDER IS NOT ASSERTED.
//   5. A TOOLING FAILURE IS NOT A FINDING: an unreadable file or base, a file
//      with no definitions at all, a git read that failed -- exit 2, so "could
//      not look" never reads as "looked and found".
//   6. IDS ARE WHOLE NUMBERS: P-2 never matches P-20, in a definition or in a
//      leaf's citation.
//
// THE LEAF OBLIGATION (CON-48's, applied to whichever prefix is asked). With
// `--base <ref>:<path>` the clause blocks are compared with the base's; every
// clause whose block changed (edited, minted or removed) must be matched by a
// change in every --leaves file that cites it, or the PR body (`--body-from`)
// must carry a `no-leaf-change: <reason>` line. Nen reports which leaves are
// stale; whether the opt-out's reason is good enough is the reviewer's.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { GIT, type Seams } from "../seam/exec.js";
import { globToRegex } from "./markdown.js";

export const CLAUSE_CHECK_CONTRACT = "nen.canon.clause-check/v0.1";

/** A tooling failure: the check could not look. Exit 2. */
export class ClauseWiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClauseWiringError";
  }
}
const wiring = (message: string): never => {
  throw new ClauseWiringError(message);
};

export interface Definition {
  readonly id: number;
  readonly line: number;
}

export interface ClauseScan {
  readonly definitions: readonly Definition[];
  readonly duplicates: readonly { readonly id: number; readonly count: number; readonly lines: readonly number[] }[];
  readonly mismatches: readonly { readonly line: number; readonly anchor: number; readonly label: number }[];
  readonly gaps: readonly number[];
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function anchorRe(prefix: string): RegExp {
  return new RegExp(`<a id="${escape(prefix.toLowerCase())}-(\\d+)"></a>\\*\\*${escape(prefix)}-(\\d+)\\*\\*`, "g");
}
function bulletRe(prefix: string): RegExp {
  return new RegExp(`^- \\*\\*${escape(prefix)}-(\\d+)\\.`);
}

const splitLines = (text: string): string[] => text.replace(/\r\n?/g, "\n").split("\n");

/** Every definition in document order, with repeats -- the repeats are the signal. */
export function scanClauses(text: string, prefix: string): ClauseScan {
  const definitions: Definition[] = [];
  const mismatches: { line: number; anchor: number; label: number }[] = [];
  splitLines(text).forEach((line, index): void => {
    let anchored = false;
    for (const match of line.matchAll(anchorRe(prefix))) {
      anchored = true;
      const anchor = Number(match[1]);
      const label = Number(match[2]);
      if (anchor !== label) mismatches.push({ line: index + 1, anchor, label });
      definitions.push({ id: anchor, line: index + 1 });
    }
    if (anchored) return;
    const bullet = bulletRe(prefix).exec(line);
    if (bullet !== null) definitions.push({ id: Number(bullet[1]), line: index + 1 });
  });
  const lines = new Map<number, number[]>();
  for (const definition of definitions) lines.set(definition.id, [...(lines.get(definition.id) ?? []), definition.line]);
  const duplicates = [...lines]
    .filter(([, at]): boolean => at.length > 1)
    .map(([id, at]): { id: number; count: number; lines: number[] } => ({ id, count: at.length, lines: at }))
    .sort((a, b): number => a.id - b.id);
  const max = definitions.length === 0 ? 0 : Math.max(...definitions.map((d): number => d.id));
  const gaps: number[] = [];
  for (let id = 1; id <= max; id++) if (!lines.has(id)) gaps.push(id);
  return { definitions, duplicates, mismatches, gaps };
}

/**
 * The text of clause `id`'s block: its definition line through everything
 * under it, stopping before the next definition or an `#`/`##` heading. A
 * definition that is a table row is that row alone. Trailing blank lines are
 * dropped, so a block that only gained blank lines is not a changed block.
 * A repeated id's blocks are joined in order.
 */
export function clauseBlock(text: string, prefix: string, id: number): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of splitLines(text)) {
    const ids = [...line.matchAll(anchorRe(prefix))].map((m): number => Number(m[1]));
    const bullet = ids.length === 0 ? bulletRe(prefix).exec(line) : null;
    if (bullet !== null) ids.push(Number(bullet[1]));
    if (ids.length > 0) {
      inBlock = ids.includes(id);
      if (inBlock) {
        out.push(line);
        if (/^\s*\|/.test(line)) inBlock = false;
      }
      continue;
    }
    if (inBlock && /^#{1,2}\s/.test(line)) inBlock = false;
    if (inBlock) out.push(line);
  }
  return out.join("\n").replace(/\s+$/, "");
}

/** Ids whose block differs between base and head (edited, minted or removed), ascending. */
export function changedClauses(base: string, head: string, prefix: string): { minted: number[]; removed: number[]; edited: number[] } {
  const baseIds = new Set(scanClauses(base, prefix).definitions.map((d): number => d.id));
  const headIds = new Set(scanClauses(head, prefix).definitions.map((d): number => d.id));
  const minted = [...headIds].filter((id): boolean => !baseIds.has(id)).sort((a, b): number => a - b);
  const removed = [...baseIds].filter((id): boolean => !headIds.has(id)).sort((a, b): number => a - b);
  const edited = [...headIds].filter((id): boolean => baseIds.has(id) && clauseBlock(base, prefix, id) !== clauseBlock(head, prefix, id)).sort((a, b): number => a - b);
  return { minted, removed, edited };
}

/** Whether a text cites `P-id` as a whole token (P-2 never matches P-20). */
export function cites(text: string, prefix: string, id: number): boolean {
  return new RegExp(`(?<![A-Za-z0-9-])${escape(prefix)}-${id}(?!\\d)`).test(text);
}

/** `no-leaf-change: <reason>` on one line of the body; the reason, or null. */
export function leafOptOut(body: string): string | null {
  for (const line of splitLines(body)) {
    const match = /no-leaf-change:[ \t]*(\S.*)$/i.exec(line);
    if (match !== null) return (match[1] ?? "").trim();
  }
  return null;
}

export interface ClauseCheckOptions {
  readonly repo: string;
  readonly file: string;
  readonly prefix: string;
  readonly base: string | null;
  readonly leaves: readonly string[] | null;
  readonly bodyFrom: string | null;
}

export interface LeafObligation {
  readonly id: string;
  readonly citing: readonly string[];
  readonly stale: readonly string[];
}

export interface ClauseCheckReport {
  readonly contract: typeof CLAUSE_CHECK_CONTRACT;
  readonly repo: string;
  readonly file: string;
  readonly prefix: string;
  readonly definitions: number;
  readonly duplicates: readonly { readonly id: string; readonly count: number; readonly lines: readonly number[] }[];
  readonly mismatches: readonly { readonly line: number; readonly anchor: string; readonly label: string }[];
  readonly gaps: readonly string[];
  readonly base: { readonly from: string; readonly kind: "file" | "ref"; readonly minted: readonly string[]; readonly removed: readonly string[]; readonly edited: readonly string[] } | null;
  readonly leaves: { readonly patterns: readonly string[]; readonly ref: string; readonly optOut: string | null; readonly obligations: readonly LeafObligation[]; readonly stale: number } | null;
  readonly exit: 0 | 1;
}

function readFileText(abs: string, shown: string, what: string): string {
  try {
    if (!statSync(abs).isFile()) return wiring(`cannot read ${what} '${shown}': not a file`);
    return readFileSync(abs, "utf8");
  } catch (error) {
    if (error instanceof ClauseWiringError) throw error;
    return wiring(`cannot read ${what} '${shown}': ${(error as Error).message}`);
  }
}

function git(seams: Seams, repo: string, args: readonly string[], why: string): string {
  const result = seams.run(GIT, ["-C", repo, ...args]);
  if (result.spawnFailed) return wiring(`git could not be started (${why})`);
  if (result.code !== 0) return wiring(`git ${args.join(" ")} failed (${why}): ${(result.stderr.split("\n")[0] ?? "").trim()}`);
  return result.stdout;
}

/** `--base`: a file on disk, else `<ref>:<path>` read through git. */
function readBase(seams: Seams, repo: string, spec: string): { text: string; kind: "file" | "ref"; ref: string | null } {
  const abs = isAbsolute(spec) ? spec : resolve(repo, spec);
  if (existsSync(abs)) return { text: readFileText(abs, spec, "base file"), kind: "file", ref: null };
  const colon = spec.indexOf(":");
  if (colon <= 0 || colon === spec.length - 1) return wiring(`cannot read base '${spec}': no such file, and not a <ref>:<path> git object`);
  const ref = spec.slice(0, colon);
  const path = spec.slice(colon + 1);
  if (ref.startsWith("-")) return wiring(`base ref '${ref}' starts with '-'; nen will not put it on a git command line`);
  return { text: git(seams, repo, ["show", `${ref}:${path.startsWith("./") ? path : `./${path}`}`], `reading the base ${spec}`), kind: "ref", ref };
}

const label = (prefix: string, id: number): string => `${prefix}-${id}`;

export function clauseCheck(options: ClauseCheckOptions, seams: Seams): ClauseCheckReport {
  const { repo, prefix } = options;
  const fileAbs = isAbsolute(options.file) ? options.file : resolve(repo, options.file);
  if (!existsSync(fileAbs)) wiring(`cannot read '${options.file}': no such file`);
  const head = readFileText(fileAbs, options.file, "file");
  const scan = scanClauses(head, prefix);
  if (scan.definitions.length === 0) wiring(`no ${prefix} definitions in ${options.file}; refusing to read an empty id space as clean`);
  let base: ClauseCheckReport["base"] = null;
  let baseRef: string | null = null;
  let changed: number[] = [];
  if (options.base !== null) {
    const read = readBase(seams, repo, options.base);
    baseRef = read.ref;
    const delta = changedClauses(read.text, head, prefix);
    changed = [...new Set([...delta.minted, ...delta.removed, ...delta.edited])].sort((a, b): number => a - b);
    base = {
      from: options.base,
      kind: read.kind,
      minted: delta.minted.map((id): string => label(prefix, id)),
      removed: delta.removed.map((id): string => label(prefix, id)),
      edited: delta.edited.map((id): string => label(prefix, id)),
    };
  }
  let leaves: ClauseCheckReport["leaves"] = null;
  if (options.leaves !== null) {
    if (baseRef === null) wiring("--leaves needs --base <ref>:<path>: the leaf obligation compares each citing file with that ref");
    const ref = baseRef as string;
    const tracked = git(seams, repo, ["ls-files", "-z"], "listing tracked files").split("\0").filter((p): boolean => p !== "");
    const self = options.file.replace(/^\.\//, "");
    const matched = new Set<string>();
    for (const pattern of options.leaves) {
      const re = globToRegex(pattern.replace(/^\.\//, ""));
      const hits = tracked.filter((path): boolean => re.test(path));
      if (hits.length === 0) wiring(`--leaves pattern '${pattern}' matches no tracked file; a leaf set that names nothing would pass every obligation`);
      for (const hit of hits) if (hit !== self) matched.add(hit);
    }
    const diffed = new Set(git(seams, repo, ["diff", "--name-only", "--relative", ref, "--"], `comparing the leaves with ${ref}`).split("\n").filter((p): boolean => p !== ""));
    const optOut = options.bodyFrom === null ? null : leafOptOut(readFileText(isAbsolute(options.bodyFrom) ? options.bodyFrom : resolve(repo, options.bodyFrom), options.bodyFrom, "--body-from"));
    const texts = new Map<string, string>();
    for (const path of [...matched].sort()) texts.set(path, readFileText(resolve(repo, path), path, "leaf"));
    const obligations: LeafObligation[] = [];
    for (const id of changed) {
      const citing = [...texts].filter(([, text]): boolean => cites(text, prefix, id)).map(([path]): string => path);
      obligations.push({ id: label(prefix, id), citing, stale: citing.filter((path): boolean => !diffed.has(path)) });
    }
    leaves = { patterns: options.leaves, ref, optOut, obligations, stale: obligations.reduce((n, o): number => n + o.stale.length, 0) };
  }
  const failed = scan.duplicates.length > 0 || scan.mismatches.length > 0 || (leaves !== null && leaves.stale > 0 && leaves.optOut === null);
  return {
    contract: CLAUSE_CHECK_CONTRACT,
    repo,
    file: options.file,
    prefix,
    definitions: scan.definitions.length,
    duplicates: scan.duplicates.map((d): { id: string; count: number; lines: readonly number[] } => ({ id: label(prefix, d.id), count: d.count, lines: d.lines })),
    mismatches: scan.mismatches.map((m): { line: number; anchor: string; label: string } => ({ line: m.line, anchor: `${prefix.toLowerCase()}-${m.anchor}`, label: label(prefix, m.label) })),
    gaps: scan.gaps.map((id): string => label(prefix, id)),
    base,
    leaves,
    exit: failed ? 1 : 0,
  };
}

export function renderClauseCheck(report: ClauseCheckReport): string[] {
  const lines: string[] = [];
  for (const d of report.duplicates) lines.push(`duplicate · ${d.id} · defined ${d.count} times (lines ${d.lines.join(", ")}); an id is never reused`);
  for (const m of report.mismatches) lines.push(`mismatch · line ${m.line} · anchor ${m.anchor} labels ${m.label}; the two must agree`);
  if (report.gaps.length > 0) lines.push(`notice · gaps (reported, never failed): ${report.gaps.join(", ")}`);
  if (report.base !== null) {
    lines.push(`base · ${report.base.from} · minted ${report.base.minted.join(", ") || "none"} · removed ${report.base.removed.join(", ") || "none"} · edited ${report.base.edited.join(", ") || "none"}`);
  }
  if (report.leaves !== null) {
    for (const o of report.leaves.obligations) for (const path of o.stale) lines.push(`stale leaf · ${o.id} · ${path} cites it and has no change against ${report.leaves.ref}`);
    if (report.leaves.optOut !== null) lines.push(`opt-out · no-leaf-change: ${report.leaves.optOut}`);
  }
  lines.push(`canon clause check: ${report.definitions} ${report.prefix} definitions in ${report.file} · ${report.duplicates.length} duplicate · ${report.mismatches.length} mismatch${report.leaves === null ? "" : ` · ${report.leaves.stale} stale leaf`} · exit ${report.exit}`);
  return lines;
}
