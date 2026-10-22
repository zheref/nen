// src/ref/resolve.ts -- `nen ref resolve --citation`: say where one canon
// citation lands, or that it lands nowhere and what is there instead
// (zheref/nen#482).
//
// ONE READING WITH THE LINT. A `§ N` or `§ *Title*` citation resolves exactly
// as `nen canon lint`'s citation rule resolves it (../canon/markdown.ts and
// ../canon/lint.ts's hasNumbered/hasTitled), and a clause id resolves to the
// definition `nen canon clause check` counts (../canon/clause.ts), so the
// resolver, the lint and the id guard cannot disagree about a citation.
//
// IT NEVER RE-AIMS A CITATION. `unresolved` comes with candidates -- the
// target's headings and leads, or the clause ids defined nearest -- and the
// choice among them is the caller's.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { scanClauses } from "../canon/clause.js";
import { headingNumber, parseDoc, titleMatches, type Doc } from "../canon/markdown.js";

export const REF_RESOLVE_CONTRACT = "nen.ref.resolve/v0.1";

/** The files a clause prefix lives in when --in does not say. */
export const CLAUSE_HOMES: Readonly<Record<string, string>> = { HR: "docs/ROSTER.md", CON: "CONSTITUTION.md" };

export class ResolveWiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveWiringError";
  }
}
export class CitationSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CitationSyntaxError";
  }
}

export type Citation =
  | { readonly kind: "clause"; readonly prefix: string; readonly id: number }
  | { readonly kind: "section"; readonly path: string; readonly number: string }
  | { readonly kind: "title"; readonly path: string; readonly title: string }
  | { readonly kind: "anchor"; readonly path: string; readonly anchor: string }
  | { readonly kind: "file"; readonly path: string };

/**
 * `<path> § N`, `<path> § *Title*`, `<path>#anchor`, `<path>`, `P-N`; the path
 * may be written as a Markdown link (`[x](path) § N`), as prose carries it.
 */
export function parseCitation(raw: string): Citation {
  const text = raw.trim();
  const clause = /^([A-Z][A-Z0-9]{0,7})-(\d+)$/.exec(text);
  if (clause !== null) return { kind: "clause", prefix: clause[1] ?? "", id: Number(clause[2]) };
  const link = /^\[[^\]]*\]\(([^)\s]+)\)(.*)$/.exec(text);
  const target = link !== null ? (link[1] ?? "") : (/^([^\s§]+)/.exec(text)?.[1] ?? "");
  const rest = link !== null ? (link[2] ?? "") : text.slice(target.length);
  if (target === "") throw new CitationSyntaxError(`'${raw}' names no path; expected '<path> § N', '<path> § *Title*', '<path>#anchor', '<path>' or a clause id like HR-2`);
  const tail = rest.trim();
  if (tail === "") {
    const hash = target.indexOf("#");
    if (hash >= 0) return { kind: "anchor", path: target.slice(0, hash), anchor: target.slice(hash + 1) };
    return { kind: "file", path: target };
  }
  if (target.includes("#")) throw new CitationSyntaxError(`'${raw}' carries both a #anchor and a § citation; give one`);
  const section = /^(?:'s)?\s*§§?\s*(?:(\d+[a-z]?(?:\.\d+)*)|\*([^*]+)\*)$/.exec(tail);
  if (section === null) throw new CitationSyntaxError(`'${raw}': after the path expected '§ N' or '§ *Title*', got '${tail}'`);
  if (section[1] !== undefined) return { kind: "section", path: target, number: section[1] };
  return { kind: "title", path: target, title: section[2] ?? "" };
}

export interface Match {
  readonly line: number;
  readonly text: string;
  readonly anchor: string | null;
  readonly via: "heading" | "lead" | "anchor" | "definition" | "file";
}

export interface ResolveReport {
  readonly contract: typeof REF_RESOLVE_CONTRACT;
  readonly citation: string;
  readonly kind: Citation["kind"];
  readonly root: string;
  readonly target: string | null;
  readonly resolved: boolean;
  readonly matches: readonly Match[];
  readonly reason: string | null;
  readonly candidates: readonly Match[];
}

function readUtf8(abs: string, rel: string): string {
  let buffer: Buffer;
  try {
    buffer = readFileSync(abs);
  } catch (error) {
    throw new ResolveWiringError(`cannot read ${rel}: ${(error as Error).message}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ResolveWiringError(`${rel} is not valid UTF-8`);
  }
}

const CANDIDATE_CAP = 60;

function outline(doc: Doc): Match[] {
  const items: Match[] = [
    ...doc.headings.map((h): Match => ({ line: h.line, text: h.text, anchor: h.anchor, via: "heading" })),
    ...doc.leads.map((l): Match => ({ line: l.line, text: l.text, anchor: null, via: "lead" })),
  ];
  return items.sort((a, b): number => a.line - b.line).slice(0, CANDIDATE_CAP);
}

export interface ResolveOptions {
  readonly root: string;
  readonly citation: string;
  /** The citing file, relative to root; relative targets resolve from its directory. */
  readonly from: string | null;
  /** The file a clause id is defined in; defaults by prefix (CLAUSE_HOMES). */
  readonly in: string | null;
}

export function resolveCitation(options: ResolveOptions): ResolveReport {
  const root = resolve(options.root);
  const citation = parseCitation(options.citation);
  const base = { contract: REF_RESOLVE_CONTRACT, citation: options.citation, kind: citation.kind, root } as const;
  const unresolved = (target: string | null, reason: string, candidates: Match[] = []): ResolveReport => ({ ...base, target, resolved: false, matches: [], reason, candidates });
  const done = (target: string, matches: Match[], reason: string, candidates: () => Match[]): ResolveReport =>
    matches.length > 0 ? { ...base, target, resolved: true, matches, reason: null, candidates: [] } : unresolved(target, reason, candidates());

  // The file the citation points into, kept inside the root.
  let rel: string;
  if (citation.kind === "clause") {
    const home = options.in ?? CLAUSE_HOMES[citation.prefix];
    if (home === undefined) throw new CitationSyntaxError(`no default file for ${citation.prefix} clauses; name it with --in <file>`);
    rel = home;
  } else {
    if (citation.path === "" && options.from === null) throw new CitationSyntaxError(`'${options.citation}' is a same-file anchor; name the citing file with --from`);
    const fromDir = options.from === null ? "" : options.from.split("/").slice(0, -1).join("/");
    let path = citation.path === "" ? (options.from ?? "").split("/").pop() ?? "" : citation.path;
    try {
      path = decodeURIComponent(path);
    } catch {
      // a literal % is a path character; keep it
    }
    const abs = resolve(root, fromDir, path);
    if (abs !== root && !abs.startsWith(root + sep)) return unresolved(null, "leaves the root");
    rel = relative(root, abs).split(sep).join("/");
  }
  const abs = isAbsolute(rel) ? rel : resolve(root, rel);
  if (!existsSync(abs)) return unresolved(rel, "no such file");
  if (citation.kind === "file") return { ...base, target: rel, resolved: true, matches: [{ line: 1, text: rel, anchor: null, via: "file" }], reason: null, candidates: [] };
  if (!statSync(abs).isFile()) return unresolved(rel, "not a file");
  const text = readUtf8(abs, rel);

  if (citation.kind === "clause") {
    const scan = scanClauses(text, citation.prefix);
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const at = (line: number): string => (lines[line - 1] ?? "").trim().slice(0, 200);
    const matches = scan.definitions.filter((d): boolean => d.id === citation.id).map((d): Match => ({ line: d.line, text: at(d.line), anchor: `${citation.prefix.toLowerCase()}-${d.id}`, via: "definition" }));
    return done(rel, matches, `${citation.prefix}-${citation.id} is not defined in ${rel}`, (): Match[] =>
      [...scan.definitions]
        .sort((a, b): number => Math.abs(a.id - citation.id) - Math.abs(b.id - citation.id) || a.id - b.id)
        .slice(0, 5)
        .map((d): Match => ({ line: d.line, text: `${citation.prefix}-${d.id}: ${at(d.line)}`, anchor: `${citation.prefix.toLowerCase()}-${d.id}`, via: "definition" })),
    );
  }

  const doc = parseDoc(rel, text);
  if (citation.kind === "anchor") {
    let anchor = citation.anchor;
    try {
      anchor = decodeURIComponent(anchor);
    } catch {
      // keep it literal
    }
    const heading = doc.headings.find((h): boolean => h.anchor === anchor);
    const matches: Match[] = heading !== undefined ? [{ line: heading.line, text: heading.text, anchor, via: "heading" }] : doc.anchors.has(anchor) ? [{ line: doc.lines.findIndex((l): boolean => l.includes(`"${anchor}"`)) + 1, text: anchor, anchor, via: "anchor" }] : [];
    return done(rel, matches, `no anchor #${anchor} in ${rel}`, (): Match[] => outline(doc).filter((m): boolean => m.via === "heading"));
  }
  if (citation.kind === "section") {
    const matches = [
      ...doc.headings.filter((h): boolean => headingNumber(h.text) === citation.number).map((h): Match => ({ line: h.line, text: h.text, anchor: h.anchor, via: "heading" })),
      ...doc.leads.filter((l): boolean => headingNumber(l.text) === citation.number).map((l): Match => ({ line: l.line, text: l.text, anchor: null, via: "lead" })),
    ].sort((a, b): number => a.line - b.line);
    return done(rel, matches, `no heading or bold lead numbered ${citation.number} in ${rel}`, (): Match[] => outline(doc));
  }
  const matches = [
    ...doc.headings.filter((h): boolean => titleMatches(h.text, citation.title)).map((h): Match => ({ line: h.line, text: h.text, anchor: h.anchor, via: "heading" })),
    ...doc.leads.filter((l): boolean => titleMatches(l.text, citation.title)).map((l): Match => ({ line: l.line, text: l.text, anchor: null, via: "lead" })),
  ].sort((a, b): number => a.line - b.line);
  return done(rel, matches, `no heading or bold lead titled '${citation.title}' in ${rel}`, (): Match[] => outline(doc));
}

export function renderResolve(report: ResolveReport): string[] {
  if (report.resolved) return report.matches.map((m): string => `resolved · ${report.target ?? ""}:${m.line} · ${m.via} · ${m.text}${m.anchor === null ? "" : ` · #${m.anchor}`}`);
  return [`unresolved · ${report.citation} · ${report.reason ?? ""}`, ...report.candidates.map((m): string => `  candidate · ${report.target ?? ""}:${m.line} · ${m.via} · ${m.text}`)];
}
