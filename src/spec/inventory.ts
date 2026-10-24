// src/spec/inventory.ts -- `nen spec inventory`: a member checkout's owned
// file facts as rows, at one commit (zheref/nen#493 AC-1, SP-14).
//
// ROWS, NEVER PROSE. A row is {id, kind, path, lines, sha, excerptSha256,
// tier, ruleId}: where a fact lives and the hash of its bytes, never the bytes
// themselves (Hatsu docs/config/spec-repo.md: "excerpt hashes, never
// excerpts"). The excerpt is lines l1..l2 each ending in "\n" -- the same
// bytes `spec cite-check --verify-excerpt` hashes, so a citation of exactly a
// row's range verifies against the row.
//
// THE DENOMINATOR IS THE BUILD SYSTEM'S. The file set is ./membership.ts's,
// read from the build system's own declarations; the suffix -> kind table is
// the scenario's stack handbook appendix (./readers.json, data). A kind the
// table counts per declaration (`test`: one row per test case) says `case`; a
// kind counted per file says `file`; a kind no suffix yields says `unknown` with
// a null total -- reported, never omitted (SP-14).
//
// TIERS. A test-case row is `declared` (a test assertion, SP-2); every other
// row is `observed` (read from the code). Nothing here is `inferred`.

import readersData from "./readers.json";
import { sha256 } from "./check.js";
import { excerptOf } from "./citecheck.js";
import { readMembership, type Membership, type MembershipSource, type Unread } from "./membership.js";
import { globMatcher, lineCount, type GlobMatcher, type MemberTree } from "./tree.js";

export const SPEC_INVENTORY_CONTRACT = "nen.spec.inventory/v0.1";

export type InventoryVerdict = "read" | "partial" | "could-not-read";
export type CaseDetector = "swift-test" | "junit" | "js-test";

interface SuffixRule {
  readonly suffix: string;
  readonly kind: string | null;
  readonly ruleId: string | null;
  readonly cases?: CaseDetector;
}

interface ScenarioReader {
  readonly membership: MembershipSource;
  readonly handbook: string;
  readonly suffixes: readonly SuffixRule[];
}

const READERS = readersData as unknown as { readonly kinds: readonly string[]; readonly scenarios: Readonly<Record<string, ScenarioReader>> };
export const ROW_KINDS: readonly string[] = READERS.kinds;
export const GOVERNED_SCENARIOS: readonly string[] = Object.keys(READERS.scenarios).sort();

export function scenarioReader(id: string): ScenarioReader | null {
  return Object.hasOwn(READERS.scenarios, id) ? (READERS.scenarios[id] as ScenarioReader) : null;
}

export interface InventoryRow {
  readonly id: string;
  readonly kind: string;
  readonly path: string;
  readonly lines: readonly [number, number];
  readonly sha: string;
  readonly excerptSha256: string;
  readonly tier: "declared" | "observed";
  readonly ruleId: string | null;
}

export interface KindTotal {
  readonly kind: string;
  readonly total: number | null;
  readonly unit: "file" | "case" | "unknown";
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface InventoryReport {
  readonly contract: string;
  readonly verdict: InventoryVerdict;
  readonly repo: string;
  readonly origin: string | null;
  readonly lane: string | null;
  readonly cwd: string;
  readonly scenario: string;
  readonly handbook: string;
  readonly sha: string | null;
  readonly membership: { readonly source: MembershipSource; readonly read: readonly string[]; readonly files: number; readonly classified: number; readonly joined: number; readonly unclassified: number };
  readonly excluded: readonly string[];
  readonly rows: readonly InventoryRow[];
  readonly totals: readonly KindTotal[];
  readonly unread: readonly Unread[];
  readonly reason: string | null;
}

/** Lines l1..l2 of a text, each ending in "\n" (CRLF read as LF): the bytes every spec verb hashes. */
export function excerptLines(text: string, l1: number, l2: number): string {
  return excerptOf(text, l1, l2) ?? "";
}

/** Each test case a file declares: its name and 1-based line. */
export function testCases(detector: CaseDetector, text: string): { name: string; line: number }[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const found: { name: string; line: number }[] = [];
  let annotated = false;
  lines.forEach((raw, index): void => {
    const line = raw.trim();
    if (detector === "js-test") {
      const match = /^(?:it|test)(?:\.only)?\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/.exec(line);
      if (match !== null) found.push({ name: match[2] as string, line: index + 1 });
      return;
    }
    if (line.startsWith("//") || line === "") return;
    const testAttribute = /^@Test\b/.test(line);
    const fn = detector === "swift-test" ? /\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line) : /\bfun\s+(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
    if (fn !== null) {
      const name = (fn[1] as string).replace(/^`|`$/g, "");
      if (annotated || testAttribute || (detector === "swift-test" && /^test/.test(name))) found.push({ name, line: index + 1 });
      annotated = false;
      return;
    }
    annotated = testAttribute || (annotated && /^@/.test(line));
  });
  return found;
}

export interface InventoryInput {
  readonly repo: string;
  readonly origin: string | null;
  readonly lane: string | null;
  readonly cwd: string;
  readonly scenario: string;
  readonly exclude: readonly string[];
}

export function couldNotRead(input: InventoryInput, reader: ScenarioReader, reason: string): InventoryReport {
  return {
    contract: SPEC_INVENTORY_CONTRACT,
    verdict: "could-not-read",
    repo: input.repo,
    origin: input.origin,
    lane: input.lane,
    cwd: input.cwd,
    scenario: input.scenario,
    handbook: reader.handbook,
    sha: null,
    membership: { source: reader.membership, read: [], files: 0, classified: 0, joined: 0, unclassified: 0 },
    excluded: [],
    rows: [],
    totals: ROW_KINDS.map((kind): KindTotal => ({ kind, total: null, unit: "unknown" })),
    unread: [],
    reason,
  };
}

export function inventory(tree: MemberTree, input: InventoryInput, reader: ScenarioReader): InventoryReport {
  const membership: Membership = readMembership(reader.membership, tree, input.cwd);
  const excluders = input.exclude.map((pattern): GlobMatcher => globMatcher(pattern));
  const excluded = membership.files.filter((file): boolean => excluders.some((matcher): boolean => matcher.test(file)));
  const files = membership.files.filter((file): boolean => !excluded.includes(file));
  const unread: Unread[] = [...membership.unread];
  const rows: InventoryRow[] = [];
  const units = new Map<string, "file" | "case">();
  let classified = 0;
  let joined = 0;
  for (const rule of reader.suffixes) if (rule.kind !== null) units.set(rule.kind, rule.cases === undefined ? "file" : "case");
  for (const path of files) {
    const base = path.split("/").pop() ?? path;
    const rule = reader.suffixes.find((entry): boolean => base.endsWith(entry.suffix));
    if (rule === undefined) continue;
    if (rule.kind === null) {
      joined += 1;
      continue;
    }
    const text = tree.read(path);
    if (text === null) {
      unread.push({ path, reason: "owned by the build system but could not be read at the sha" });
      continue;
    }
    classified += 1;
    if (rule.cases !== undefined) {
      const seen = new Map<string, number>();
      for (const testCase of testCases(rule.cases, text)) {
        const count = (seen.get(testCase.name) ?? 0) + 1;
        seen.set(testCase.name, count);
        rows.push({
          id: `${rule.kind}:${path}#${testCase.name}${count === 1 ? "" : `~${count}`}`,
          kind: rule.kind,
          path,
          lines: [testCase.line, testCase.line],
          sha: tree.sha,
          excerptSha256: sha256(excerptLines(text, testCase.line, testCase.line)),
          tier: "declared",
          ruleId: rule.ruleId,
        });
      }
      continue;
    }
    const last = Math.max(1, lineCount(text));
    rows.push({ id: `${rule.kind}:${path}`, kind: rule.kind, path, lines: [1, last], sha: tree.sha, excerptSha256: sha256(excerptLines(text, 1, last)), tier: "observed", ruleId: rule.ruleId });
  }
  rows.sort((a, b): number => a.id.localeCompare(b.id));
  const totals = ROW_KINDS.map((kind): KindTotal => {
    const unit = units.get(kind);
    return unit === undefined ? { kind, total: null, unit: "unknown" } : { kind, total: rows.filter((row): boolean => row.kind === kind).length, unit };
  });
  const empty = membership.files.length === 0;
  return {
    contract: SPEC_INVENTORY_CONTRACT,
    verdict: empty ? "could-not-read" : unread.length > 0 ? "partial" : "read",
    repo: input.repo,
    origin: input.origin,
    lane: input.lane,
    cwd: input.cwd,
    scenario: input.scenario,
    handbook: reader.handbook,
    sha: tree.sha,
    membership: { source: membership.source, read: membership.read, files: files.length, classified, joined, unclassified: files.length - classified - joined - unread.filter((entry): boolean => files.includes(entry.path)).length },
    excluded,
    rows,
    totals,
    unread,
    reason: empty ? `the ${membership.source} membership names no file${unread.length === 0 ? "" : `: ${unread.map((entry): string => entry.reason).join("; ")}`}` : null,
  };
}

export function renderInventory(report: InventoryReport): string[] {
  const lines = [
    `${report.verdict}: ${report.scenario} ${report.origin ?? report.repo}${report.sha === null ? "" : ` @ ${report.sha.slice(0, 12)}`} -- ${report.rows.length} row(s) from ${report.membership.files} owned file(s) (${report.membership.source}: ${report.membership.read.join(", ") || "nothing read"})`,
  ];
  if (report.reason !== null) lines.push(`  ${report.reason}`);
  lines.push(`  totals: ${report.totals.map((total): string => `${total.kind} ${total.total ?? "unknown"}${total.unit === "case" ? " (per case)" : ""}`).join(" · ")}`);
  lines.push(`  ${report.membership.classified} classified · ${report.membership.joined} joined to another row · ${report.membership.unclassified} unclassified · ${report.excluded.length} excluded by --exclude`);
  for (const entry of report.unread) lines.push(`  unread ${entry.path} -- ${entry.reason}`);
  return lines;
}
