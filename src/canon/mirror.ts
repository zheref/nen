// ============================================================================
// PORTED FROM bankai-core `scripts/sync_canon.py` (zheref/nen#4, Akatsuki
// migration P1).
//
// The header below this block is drawn from the ORIGINAL's own docstring,
// carried behaviourally intact. It is not decoration: every WHY in it names
// the reason a branch exists, and a port that arrives without it is a port
// whose next maintainer "simplifies" it back into the bug (the BC-IS-#737
// discipline). Only the LANGUAGE changed -- Python's os/re calls become
// node:fs and RegExp, argparse becomes ./verb.ts's CLI wiring -- and the
// prefix in the generated-file header and the not-mirrored filename set,
// which are the target repository's own conventions and are now caller data
// (see below) rather than literals baked into this module.
// ============================================================================
// src/canon/mirror.ts -- canon-mirror generation + drift check, CON-13's own
// mechanism: a target-repo's `.claude/rules/`-shaped mirror of a stack's
// canonical rule files, token-substituted and traceable to the ref it was
// generated from.
//
// Pure logic (no network, no git) -- given a stack rules directory, a
// canon-values file (a `{{TOKEN}}` -> literal-value binding), it substitutes
// every token in each canonical rule file and prepends a generated-file
// header carrying the ref the mirror was generated from.
//
// `generate` writes only files whose content actually changed, and deletes an
// ORPHANED mirror file -- one in the canon-managed filename universe with no
// corresponding canon source any more (removed/renamed upstream) -- so the
// mirror stays an exact, self-healing image of canon rather than one that
// only ever grows.
//
// `check` regenerates from the same inputs and diffs against the committed
// mirror without writing anything, classifying every file as MISSING, EXTRA,
// STALE (header ref lags the pinned ref), HAND_EDITED (content differs from a
// fresh generation) or OK. Drift is non-zero exit -- MISSING/EXTRA/STALE/
// HAND_EDITED is CI's fail signal.
//
// THE HEADER PATTERN AND THE NOT-MIRRORED FILENAME SET ARE CALLER DATA. The
// original hard-codes `handbooks/stacks/<scenario>/rules/` into its header
// text and `{'README.md', 'placeholders.md'}` as the meta files never
// mirrored -- both are specific to the system this ports from, and hardcoding
// them here would be exactly the §3 violation the whole migration exists to
// remove. The caller supplies the header TEMPLATE (with `{ref}`, `{scenario}`,
// `{file}` placeholders) and the not-mirrored set.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g;

export class MissingTokenError extends Error {
  readonly filename: string;
  readonly token: string;
  constructor(filename: string, token: string) {
    super(`${filename}: {{${token}}} has no canon-values binding`);
    this.name = "MissingTokenError";
    this.filename = filename;
    this.token = token;
  }
}

export interface CanonValues {
  readonly scenario: string | null;
  readonly values: Readonly<Record<string, string>>;
}

// A minimal, dependency-free reader for the canon-values schema: an optional
// top-level `scenario:` key, then a `values:` block of flat, one-per-line
// `TOKEN: literal value` pairs indented under `values:`. No lists/nesting.
export function parseCanonValues(text: string): CanonValues {
  const values: Record<string, string> = {};
  let scenario: string | null = null;
  let inValues = false;

  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.split(" #")[0]?.replace(/\s+$/, "") ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const trimmed = line.trim().replace(/:$/, "");
      inValues = trimmed === "values";
      const scenarioMatch = /^scenario:\s*(\S+)\s*$/.exec(line);
      if (scenarioMatch !== null && scenarioMatch[1] !== undefined) scenario = scenarioMatch[1];
      continue;
    }
    if (!inValues) continue;
    const match = /^\s*([A-Z0-9_]+):\s*(.*)$/.exec(line);
    if (match === null || match[1] === undefined) continue;
    let value = (match[2] ?? "").trim();
    if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return { scenario, values };
}

function substitute(text: string, filename: string, values: Readonly<Record<string, string>>): string {
  return text.replace(TOKEN_RE, (_whole, token: string): string => {
    const bound = values[token];
    if (bound === undefined) throw new MissingTokenError(filename, token);
    return bound;
  });
}

export interface HeaderTemplate {
  /** e.g. "<!-- GENERATED from {ref}/handbooks/stacks/{scenario}/rules/{file} -- DO NOT EDIT. -->\n" */
  readonly template: string;
  /** The same shape, as a RegExp with named groups `ref`, `scenario`, `file`, matching a line the template could have produced. */
  readonly pattern: RegExp;
}

function renderHeader(header: HeaderTemplate, ref: string, scenario: string, filename: string): string {
  return header.template.replace("{ref}", ref).replace("{scenario}", scenario).replace("{file}", filename);
}

export function canonFilenames(rulesDir: string, notMirrored: ReadonlySet<string>): readonly string[] {
  return readdirSync(rulesDir)
    .filter((name): boolean => name.endsWith(".md") && !notMirrored.has(name))
    .sort();
}

export function generateMirror(
  rulesDir: string,
  values: Readonly<Record<string, string>>,
  ref: string,
  scenario: string,
  header: HeaderTemplate,
  notMirrored: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const filename of canonFilenames(rulesDir, notMirrored)) {
    const body = readFileSync(join(rulesDir, filename), "utf8");
    out.set(filename, renderHeader(header, ref, scenario, filename) + substitute(body, filename, values));
  }
  return out;
}

export interface WriteMirrorResult {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly deleted: readonly string[];
}

export function writeMirror(
  outDir: string,
  generated: ReadonlyMap<string, string>,
  notMirrored: ReadonlySet<string>,
): WriteMirrorResult {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const unchanged: string[] = [];
  const deleted: string[] = [];

  for (const [filename, content] of generated) {
    const path = join(outDir, filename);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (existing === content) {
      unchanged.push(filename);
      continue;
    }
    writeFileSync(path, content, "utf8");
    written.push(filename);
  }

  const candidates = new Set(
    readdirSync(outDir).filter(
      (name): boolean => name.endsWith(".md") && !notMirrored.has(name) && statSync(join(outDir, name)).isFile(),
    ),
  );
  for (const filename of [...candidates].filter((name): boolean => !generated.has(name)).sort()) {
    rmSync(join(outDir, filename));
    deleted.push(filename);
  }

  return { written: written.sort(), unchanged: unchanged.sort(), deleted: deleted.sort() };
}

export type MirrorIssue = "missing" | "extra" | "stale" | "handEdited";

export interface MirrorReport {
  readonly ok: readonly string[];
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly stale: readonly string[];
  readonly handEdited: readonly string[];
}

export function checkMirror(
  rulesDir: string,
  values: Readonly<Record<string, string>>,
  mirrorDir: string,
  ref: string,
  scenario: string,
  header: HeaderTemplate,
  notMirrored: ReadonlySet<string>,
): MirrorReport {
  const generated = generateMirror(rulesDir, values, ref, scenario, header, notMirrored);
  const mirrorFiles = existsSync(mirrorDir) ? new Set(readdirSync(mirrorDir)) : new Set<string>();

  const ok: string[] = [];
  const missing: string[] = [];
  const stale: string[] = [];
  const handEdited: string[] = [];

  for (const [filename, fresh] of generated) {
    if (!mirrorFiles.has(filename)) {
      missing.push(filename);
      continue;
    }
    const existing = readFileSync(join(mirrorDir, filename), "utf8");
    const match = header.pattern.exec(existing);
    if (match === null) {
      handEdited.push(filename);
    } else if (match.groups?.["ref"] !== ref) {
      stale.push(filename);
    } else if (existing !== fresh) {
      handEdited.push(filename);
    } else {
      ok.push(filename);
    }
  }

  const extra = [...mirrorFiles].filter((filename): boolean => !generated.has(filename)).sort();

  return { ok: ok.sort(), missing: missing.sort(), extra, stale: stale.sort(), handEdited: handEdited.sort() };
}

export function mirrorReportOk(report: MirrorReport): boolean {
  return report.missing.length === 0 && report.extra.length === 0 && report.stale.length === 0 && report.handEdited.length === 0;
}

const ISSUE_LABELS: Readonly<Record<MirrorIssue, string>> = {
  handEdited: "hand-edited (differs from a fresh generation)",
  stale: "stale (generated-header ref lags the pinned ref)",
  missing: "missing from the mirror",
  extra: "orphaned in the mirror (no canon source)",
};

export function renderReportMarkdown(report: MirrorReport): string {
  const rows: string[] = [];
  for (const key of ["handEdited", "stale", "missing", "extra"] as const) {
    for (const file of report[key]) rows.push(`| \`${file}\` | ${ISSUE_LABELS[key]} |`);
  }
  if (rows.length === 0) return "No drift -- every mirror file matches a fresh generation.\n";
  return `| File | Issue |\n|---|---|\n${rows.join("\n")}\n`;
}
