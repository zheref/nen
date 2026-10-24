// src/spec/parity.ts -- `nen spec parity`: one row per requirement and member,
// read from each folder's parity.md and held to what its state must carry
// (zheref/nen#493 AC-8; bankai-handbooks SP-6, SP-7).
//
// THE TABLE'S SHAPE -- nen's proposal until Hatsu's spec-repo.md states one
// (it names "FR x member" and the states, not the header). parity.md holds a Markdown table whose first header cell
// names the requirement column (`FR`, `Requirement` or `Id`) and whose other
// header cells are product codes, one column per member. Each body row starts
// with an `FR-###`; each cell starts with the state and carries what SP-6 says
// that state must carry:
//
//   present · mirror   the member's citation
//   map                the member's citation and the UX-13 category it adapts under
//   drop-with-note     a CL-nnn ruling, or a `<from>--<to> PT-<n>` port ruling
//   target-only        the member's citation and the CL-nnn that made it intentional
//   differs            both citations
//   absent             the files the reader searched (anything non-empty); never
//                      "not needed" without a CL-nnn (SP-7)
//   open               nothing: an empty cell, or the word, is the gap
//
// The first five settle the row when their evidence is there; open, absent and
// differs never do. A requirement spec.md defines with no row, or a member the
// family declares with no column, is an open row with the reason.
//
// THE LIVE STATE IS READ, NEVER INFERRED. With --target, each row's issues and
// pull requests are the ones whose body carries the qualified id
// (`F<nnn>-FR-###`), read with gh in every named repository; a list at its
// limit is reported unread rather than taken as complete.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GH, type Seams } from "../seam/exec.js";
import { assertInsideRepo } from "./check.js";
import { matchFolder, type SpecLayout } from "./layout.js";
import { citationsIn, proseLines, qualifiedId, requirementOf } from "./lines.js";

export const SPEC_PARITY_CONTRACT = "nen.spec.parity/v0.1";

export const PARITY_STATES = ["present", "mirror", "map", "drop-with-note", "target-only", "differs", "absent", "open"] as const;
export type ParityState = (typeof PARITY_STATES)[number];
const HANDLINGS: ReadonlySet<ParityState> = new Set(["present", "mirror", "map", "drop-with-note", "target-only"]);
export type ParityVerdict = "handled" | "gaps" | "could-not-read";

export interface LiveObject {
  readonly repo: string;
  readonly number: number;
  readonly state: string;
}

export interface ParityRow {
  readonly folder: string;
  readonly id: string;
  readonly qualified: string;
  readonly code: string;
  readonly state: ParityState | null;
  readonly citations: readonly string[];
  readonly rulings: readonly string[];
  readonly handled: boolean;
  /** What the row lacks for its state, or why it is open; null when it carries what SP-6 asks. */
  readonly finding: string | null;
  readonly issues: readonly LiveObject[] | null;
  readonly prs: readonly LiveObject[] | null;
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface ParityReport {
  readonly contract: string;
  readonly verdict: ParityVerdict;
  readonly repo: string;
  readonly scope: { readonly folder: string | null; readonly family: string | null };
  readonly members: readonly string[];
  readonly folders: readonly string[];
  readonly rows: readonly ParityRow[];
  readonly counts: Readonly<Record<ParityState | "malformed", number>>;
  readonly live: { readonly targets: readonly string[]; readonly unread: readonly { readonly repo: string; readonly reason: string }[] } | null;
  readonly reason: string | null;
}

const CODE = /^[A-Z][A-Z0-9]{1,7}$/;
const RULING = /\bCL-\d+\b/g;
const PORT_RULING = /\b[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+(?:-[a-z0-9]+)* PT-\d+\b/g;
const NOT_NEEDED = /\b(?:not needed|not applicable|n\/a|intentional(?:ly)?)\b/i;

const cellsOf = (line: string): string[] | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] as string;
    if (char === "\\" && inner[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
};

interface ParsedParity {
  readonly codes: readonly string[];
  readonly cells: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly problems: readonly string[];
}

/** parity.md's FR x member table, or the problems that kept it from being one. */
export function parseParity(text: string): ParsedParity {
  const lines = proseLines(text);
  const problems: string[] = [];
  const cells = new Map<string, Map<string, string>>();
  let codes: string[] = [];
  let index = lines.findIndex((line): boolean => {
    const row = cellsOf(line.text);
    return row !== null && /^(?:FR|Requirement|Id)$/i.test(row[0] ?? "") && row.slice(1).some((cell): boolean => CODE.test(cell.split(/\s/)[0] ?? ""));
  });
  if (index === -1) return { codes: [], cells, problems: ["no table whose first header cell is FR, Requirement or Id and whose other header cells are product codes"] };
  codes = (cellsOf((lines[index] as { text: string }).text) as string[]).slice(1).map((cell): string => cell.split(/\s/)[0] ?? "");
  const bad = codes.filter((code): boolean => !CODE.test(code));
  if (bad.length > 0) problems.push(`header cell(s) ${bad.map((code): string => JSON.stringify(code)).join(", ")} are not product codes`);
  index += 1;
  if (/^\|?\s*:?-{3,}/.test((lines[index]?.text ?? "").trim())) index += 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index] as { number: number; text: string };
    const row = cellsOf(line.text);
    if (row === null) break;
    const id = /^(?:\*\*)?(FR-\d+)(?:\*\*)?$/.exec(row[0] ?? "")?.[1];
    if (id === undefined) {
      problems.push(`line ${line.number}: '${row[0] ?? ""}' is not an FR id`);
      continue;
    }
    if (cells.has(id)) problems.push(`line ${line.number}: ${id} has a second row`);
    const byCode = new Map<string, string>();
    codes.forEach((code, column): void => {
      byCode.set(code, row[column + 1] ?? "");
    });
    cells.set(id, byCode);
  }
  return { codes, cells, problems };
}

/** One cell read against SP-6. */
export function readCell(cell: string, code: string): { state: ParityState | null; citations: string[]; rulings: string[]; finding: string | null } {
  const text = cell.trim().replace(/^`([a-z-]+)`/, "$1");
  const lower = text.toLowerCase();
  const word = /^[a-z-]*/.exec(lower)?.[0] ?? "";
  const state: ParityState | undefined = text === "" ? "open" : PARITY_STATES.find((candidate): boolean => word === candidate);
  const citations = citationsIn(text).map((entry): string => entry.text);
  const own = citationsIn(text).filter((entry): boolean => entry.citation !== null && entry.citation.code === code).length;
  const rulings = [...new Set([...text.matchAll(RULING), ...text.matchAll(PORT_RULING)].map((match): string => match[0]))];
  if (state === undefined) return { state: null, citations, rulings, finding: `'${word}' is not a parity state (${PARITY_STATES.join(", ")})` };
  const rest = text.slice(state.length).replace(/^[\s·:—–-]+/, "").trim();
  const hasCl = rulings.some((ruling): boolean => ruling.startsWith("CL-"));
  let finding: string | null = null;
  switch (state) {
    case "present":
    case "mirror":
      if (own === 0) finding = `${state} carries no ${code} citation (SP-6)`;
      break;
    case "map":
      if (own === 0 || !/\bUX-13\b/.test(text)) finding = `map carries ${own === 0 ? `no ${code} citation` : ""}${own === 0 && !/\bUX-13\b/.test(text) ? " and " : ""}${/\bUX-13\b/.test(text) ? "" : "no UX-13 category"} (SP-6)`;
      break;
    case "drop-with-note":
      if (rulings.length === 0) finding = "drop-with-note carries no CL-nnn ruling and no <from>--<to> PT-<n> port ruling (SP-6)";
      break;
    case "target-only":
      // SP-6 asks for "the ruling that made it intentional": a CL-nnn, or for a technology-level reason a PT-n.
      if (own === 0 || rulings.length === 0) finding = `target-only carries ${own === 0 ? `no ${code} citation` : "no CL-nnn or <from>--<to> PT-<n> ruling"} (SP-6)`;
      break;
    case "differs":
      if (citations.length < 2) finding = `differs carries ${citations.length} citation(s); it carries both (SP-6)`;
      break;
    case "absent":
      if (rest === "") finding = "absent carries no list of the files searched (SP-6)";
      else if (NOT_NEEDED.test(rest) && !hasCl) finding = "absent is read as intent without a CL-nnn ruling (SP-7)";
      break;
    case "open":
      break;
  }
  return { state, citations, rulings, finding };
}

interface FolderSource {
  readonly folder: string;
  readonly nnn: string;
  readonly spec: string;
  readonly parity: string | null;
}

export function readParityFolders(repo: string, layout: SpecLayout, only: string | null): FolderSource[] {
  const root = join(repo, layout.root);
  if (!existsSync(root)) throw new Error(`${layout.root}/ does not exist under --repo`);
  const out: FolderSource[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b): number => a.name.localeCompare(b.name))) {
    const name = matchFolder(layout, entry.name);
    const folder = `${layout.root}/${entry.name}`;
    if (!entry.isDirectory() || name === null || (only !== null && folder !== only)) continue;
    const read = (file: string): string | null => {
      const path = join(repo, folder, file);
      if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return null;
      assertInsideRepo(repo, path, `${folder}/${file}`);
      return readFileSync(path, "utf8");
    };
    const spec = read("spec.md");
    if (spec === null) throw new Error(`${folder}/spec.md does not exist; parity over a folder nen cannot read is not measured`);
    out.push({ folder, nnn: name.nnn, spec, parity: read("parity.md") });
  }
  if (only !== null && out.length === 0) throw new Error(`${only} is not a folder matching ${layout.pattern} under --repo`);
  return out;
}

interface LiveIndex {
  readonly issues: Map<string, LiveObject[]>;
  readonly prs: Map<string, LiveObject[]>;
  readonly unread: { repo: string; reason: string }[];
}

const LIVE_LIMIT = 500;

/** Every issue and PR in each target whose body names `F<nnn>-...` ids, keyed by qualified id. */
export function readLive(seams: Seams, targets: readonly string[], nnns: readonly string[]): LiveIndex {
  const index: LiveIndex = { issues: new Map(), prs: new Map(), unread: [] };
  for (const repo of targets) {
    for (const nnn of [...new Set(nnns)]) {
      for (const kind of ["issue", "pr"] as const) {
        const result = seams.run(GH, [kind, "list", "--repo", repo, "--state", "all", "--search", `F${nnn} in:body`, "--limit", String(LIVE_LIMIT), "--json", "number,state,body"]);
        if (result.code !== 0) {
          index.unread.push({ repo, reason: `gh ${kind} list failed: ${result.stderr.trim() || `exit ${result.code}`}` });
          continue;
        }
        let list: { number?: unknown; state?: unknown; body?: unknown }[];
        try {
          list = JSON.parse(result.stdout) as typeof list;
          if (!Array.isArray(list)) throw new Error("not a list");
        } catch (error) {
          index.unread.push({ repo, reason: `gh ${kind} list answered something unreadable: ${(error as Error).message}` });
          continue;
        }
        if (list.length >= LIVE_LIMIT) index.unread.push({ repo, reason: `gh ${kind} list reached its ${LIVE_LIMIT} limit for F${nnn}; the list may be incomplete` });
        for (const entry of list) {
          if (typeof entry.number !== "number" || typeof entry.state !== "string" || typeof entry.body !== "string") continue;
          for (const match of entry.body.matchAll(new RegExp(`\\bF${nnn}-(FR-\\d+)\\b`, "g"))) {
            const map = kind === "issue" ? index.issues : index.prs;
            const key = qualifiedId(nnn, match[1] as string);
            const known = map.get(key) ?? [];
            if (!known.some((object): boolean => object.repo === repo && object.number === entry.number)) known.push({ repo, number: entry.number, state: entry.state });
            map.set(key, known);
          }
        }
      }
    }
  }
  return index;
}

export interface ParityInput {
  readonly repo: string;
  readonly folder: string | null;
  readonly family: string | null;
  /** The family's member codes, when --family names one. */
  readonly familyMembers: readonly string[] | null;
  readonly targets: readonly string[];
}

export function parity(seams: Seams, input: ParityInput, folders: readonly FolderSource[]): ParityReport {
  const rows: ParityRow[] = [];
  const members = new Set<string>(input.familyMembers ?? []);
  const problems: string[] = [];
  const live = input.targets.length === 0 ? null : readLive(seams, input.targets, folders.map((folder): string => folder.nnn));
  for (const folder of folders) {
    const ids = proseLines(folder.spec).map((line): string | null => {
      const requirement = requirementOf(line.text);
      return requirement?.kind === "FR" ? requirement.id : null;
    }).filter((id): id is string => id !== null);
    const parsed = folder.parity === null ? null : parseParity(folder.parity);
    for (const problem of parsed?.problems ?? []) problems.push(`${folder.folder}/parity.md: ${problem}`);
    // Without a family, the members are the table's columns and every code the folder's requirements cite.
    const cited = input.familyMembers !== null ? [] : proseLines(folder.spec).filter((line): boolean => requirementOf(line.text)?.kind === "FR").flatMap((line): string[] => citationsIn(line.text).map((entry): string | null => entry.citation?.code ?? null).filter((code): code is string => code !== null));
    const codes = [...new Set([...(input.familyMembers ?? []), ...(parsed?.codes ?? []), ...cited])].sort();
    for (const code of codes) members.add(code);
    for (const id of [...new Set([...ids, ...(parsed === null ? [] : [...parsed.cells.keys()])])]) {
      const qualified = qualifiedId(folder.nnn, id);
      for (const code of codes) {
        const issues = live === null ? null : (live.issues.get(qualified) ?? []);
        const prs = live === null ? null : (live.prs.get(qualified) ?? []);
        const base = { folder: folder.folder, id, qualified, code, issues, prs };
        const cell = parsed?.cells.get(id)?.get(code);
        if (!ids.includes(id)) {
          rows.push({ ...base, state: null, citations: [], rulings: [], handled: false, finding: `parity.md has a row for ${id}, which spec.md does not define` });
          continue;
        }
        if (parsed === null || cell === undefined) {
          const why = parsed === null ? `${folder.folder} has no parity.md` : !parsed.codes.includes(code) ? `parity.md has no ${code} column` : `parity.md has no row for ${id}`;
          rows.push({ ...base, state: "open", citations: [], rulings: [], handled: false, finding: why });
          continue;
        }
        const read = readCell(cell, code);
        rows.push({ ...base, state: read.state, citations: read.citations, rulings: read.rulings, handled: read.state !== null && HANDLINGS.has(read.state) && read.finding === null, finding: read.finding ?? (read.state === "open" ? "no state recorded yet" : null) });
      }
    }
  }
  const counts = Object.fromEntries([...PARITY_STATES, "malformed"].map((state): [string, number] => [state, 0])) as Record<ParityState | "malformed", number>;
  for (const row of rows) counts[row.state ?? "malformed"] += 1;
  return {
    contract: SPEC_PARITY_CONTRACT,
    verdict: rows.length > 0 && rows.every((row): boolean => row.handled) && problems.length === 0 && (live?.unread.length ?? 0) === 0 ? "handled" : "gaps",
    repo: input.repo,
    scope: { folder: input.folder, family: input.family },
    members: [...members].sort(),
    folders: folders.map((folder): string => folder.folder),
    rows,
    counts,
    live: live === null ? null : { targets: input.targets, unread: live.unread },
    reason: problems.length === 0 ? (rows.length === 0 ? "no requirement and member to hold to parity" : null) : problems.join("; "),
  };
}

export function unreadableParity(input: ParityInput, reason: string): ParityReport {
  return { contract: SPEC_PARITY_CONTRACT, verdict: "could-not-read", repo: input.repo, scope: { folder: input.folder, family: input.family }, members: [], folders: [], rows: [], counts: Object.fromEntries([...PARITY_STATES, "malformed"].map((state): [string, number] => [state, 0])) as Record<ParityState | "malformed", number>, live: null, reason };
}

export function renderParity(report: ParityReport): string[] {
  if (report.verdict === "could-not-read") return [`could-not-read: ${report.reason ?? ""}`];
  const handled = report.rows.filter((row): boolean => row.handled).length;
  const lines = [`${report.verdict}: ${handled}/${report.rows.length} requirement x member row(s) handled across ${report.folders.length} folder(s), members ${report.members.join(", ") || "none"}`];
  lines.push(`  ${[...PARITY_STATES, "malformed"].map((state): string => `${report.counts[state as ParityState]} ${state}`).join(" · ")}`);
  if (report.reason !== null) lines.push(`  ${report.reason}`);
  for (const row of report.rows) {
    const liveText = row.issues === null ? "" : ` · issues ${row.issues.map((object): string => `${object.repo}#${object.number} ${object.state}`).join(", ") || "none"} · PRs ${(row.prs ?? []).map((object): string => `${object.repo}#${object.number} ${object.state}`).join(", ") || "none"}`;
    lines.push(`  ${row.qualified} ${row.code} ${row.state ?? "malformed"}${row.handled ? "" : ` -- ${row.finding ?? "not a handling"}`}${liveText}`);
  }
  for (const entry of report.live?.unread ?? []) lines.push(`  unread ${entry.repo} -- ${entry.reason}`);
  return lines;
}
