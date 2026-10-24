// src/spec/citecheck.ts -- `nen spec cite-check`: every [src:] range in a
// spec folder resolves, at its own sha, in the member checkout the checkouts
// file names (SDD plan piece N10, Hatsu ruling HR-12).
//
// THE CHAIN, AND WHO DECLARES EACH LINK. A citation names a product CODE; the
// spec repository's own nen/repos.json turns the code into `owner/name`
// through the same lookup every `<CODE>#<n>` ref uses; the checkouts file
// (Hatsu docs/config/ports.md, tab-separated `<owner>/<name>\t<path>`) turns
// that slug into a directory; and that directory's `origin` must read back as
// the same slug before a single git read runs in it. Any link that does not
// hold leaves the citation `unresolved-member`, with the reason -- never a
// guess at another checkout, never a clone.
//
// THE EXCERPT. Lines l1..l2 of the file at the sha, each ending in "\n", is
// the excerpt; its sha256 is what a sidecar inventory row
// (`capture/<CODE>/inventory.json`) records. With --verify-excerpt a row that
// carries a hash is compared; a citation with no row, or a row with no hash,
// is reported as such and is not a failure. With --at, the same range is read
// at that ref too, and a differing excerpt is a [STALE] candidate: reported,
// never rewritten, and the decision to recapture stays the caller's.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { targetFromRemote } from "../github/target.js";
import { loadRepoRegistry, type RepoRegistry } from "../schema/repos.js";
import { resolveProductCode } from "../verbs/pr_ready.js";
import { looksLikeOwnerSlug } from "../repo/root.js";
import { VerbUsageError } from "../cli/command.js";
import { citationsIn, proseLines, type Tier } from "./lines.js";
import { sha256 } from "./check.js";

export const SPEC_CITE_CHECK_CONTRACT = "nen.spec.cite-check/v0.1";

export type CitationVerdict = "resolves" | "malformed" | "unresolved-member" | "missing-commit" | "missing-path" | "out-of-range";
export type ExcerptVerdict = "match" | "mismatch" | "no-row" | "no-hash" | "not-checked";

export interface CheckedCitation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly code: string | null;
  readonly member: string | null;
  readonly path: string | null;
  readonly lines: readonly [number, number] | null;
  readonly sha: string | null;
  readonly tier: Tier | null;
  readonly verdict: CitationVerdict;
  readonly reason: string | null;
  readonly excerpt: ExcerptVerdict;
  /** With --at: true when the range reads differently there (a [STALE] candidate); null when not asked or not resolvable. */
  readonly stale: boolean | null;
}

export interface MemberCheckout {
  readonly code: string;
  readonly repo: string | null;
  readonly path: string | null;
  readonly verdict: "verified" | "unresolved";
  readonly reason: string | null;
  /** The --at ref resolved in this checkout, when asked; null with a reason when it does not resolve. */
  readonly at: string | null;
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface CiteCheckReport {
  readonly contract: string;
  readonly repo: string;
  readonly folder: string;
  readonly checkouts: string;
  readonly at: string | null;
  readonly verifyExcerpt: boolean;
  readonly members: readonly MemberCheckout[];
  readonly citations: readonly CheckedCitation[];
  readonly counts: {
    readonly total: number;
    readonly resolves: number;
    readonly failing: number;
    readonly excerptMismatch: number;
    readonly stale: number;
  };
}

export const CHECKOUT_SLUG = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** The checkouts file, refused by line when a line is not `<owner>/<name>\t<absolute path>`. */
export function parseCheckouts(text: string, file: string): Map<string, string> {
  const map = new Map<string, string>();
  text.replace(/\r\n/g, "\n").split("\n").forEach((raw, index): void => {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) return;
    const tab = raw.indexOf("\t");
    const slug = tab === -1 ? raw : raw.slice(0, tab);
    const path = tab === -1 ? "" : raw.slice(tab + 1);
    const where = `${file}:${index + 1}`;
    if (tab === -1 || path === "") throw new VerbUsageError(`${where} is not '<owner>/<name><TAB><absolute path>'.`);
    if (!CHECKOUT_SLUG.test(slug) || slug.split("/").some((part): boolean => part === "." || part === "..")) throw new VerbUsageError(`${where}: '${slug}' does not match ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$.`);
    if (!isAbsolute(path)) throw new VerbUsageError(`${where}: '${path}' is not an absolute path.`);
    if (map.has(slug)) throw new VerbUsageError(`${where}: '${slug}' is listed twice; which line holds is not nen's to pick.`);
    map.set(slug, path);
  });
  return map;
}

/** Lines l1..l2, each ending in "\n", or null when the range is past the end. */
export function excerptOf(content: string, l1: number, l2: number): string | null {
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  if (l1 < 1 || l2 < l1 || l2 > lines.length) return null;
  return `${lines.slice(l1 - 1, l2).join("\n")}\n`;
}

interface InventoryRow {
  readonly path: string;
  readonly lines: string;
  readonly sha: string;
  readonly excerptSha256: string | null;
}

/** `capture/<CODE>/inventory.json`'s rows; null when the file is absent; throws when it cannot be read as rows. */
export function readInventory(repo: string, code: string): InventoryRow[] | null {
  const relative = `capture/${code}/inventory.json`;
  const path = join(repo, relative);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${relative}: ${(error as Error).message}`);
  }
  const rows = (raw as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) throw new Error(`${relative} carries no rows[] list`);
  return rows.map((row, index): InventoryRow => {
    const value = row as Record<string, unknown> | null;
    const lines = value?.["lines"];
    const text = typeof lines === "string" ? lines : Array.isArray(lines) && lines.length === 2 ? `${String(lines[0])}-${String(lines[1])}` : null;
    if (typeof value?.["path"] !== "string" || text === null || typeof value["sha"] !== "string") throw new Error(`${relative} rows[${index}] needs path, lines and sha`);
    const hash = value["excerptSha256"];
    return { path: value["path"], lines: text, sha: value["sha"], excerptSha256: typeof hash === "string" ? hash : null };
  });
}

/** Every Markdown file under the folder, repository-relative, sorted. */
export function folderMarkdown(repo: string, folder: string): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(repo, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(child);
    }
  };
  walk(folder);
  return out.sort();
}

export interface CiteCheckInput {
  readonly repo: string;
  readonly folder: string;
  readonly checkoutsFile: string;
  readonly checkouts: ReadonlyMap<string, string>;
  readonly at: string | null;
  readonly verifyExcerpt: boolean;
}

export function resolveMember(seams: Seams, input: CiteCheckInput, registry: RepoRegistry | null, registryError: string | null, code: string): MemberCheckout {
  const unresolved = (repo: string | null, path: string | null, reason: string): MemberCheckout => ({ code, repo, path, verdict: "unresolved", reason, at: null });
  if (registry === null) return unresolved(null, null, registryError ?? "no registry");
  let repo: string;
  try {
    const slug = resolveProductCode(code, registry, { explicitForm: (bare): string => `a full 'owner/${bare}' slug as the product_codes value` });
    repo = `${slug.owner}/${slug.repo}`;
  } catch (error) {
    return unresolved(null, null, `code ${code} does not resolve through nen/repos.json: ${(error as Error).message}`);
  }
  if (!looksLikeOwnerSlug(repo)) return unresolved(repo, null, `'${repo}' is not an owner/name slug`);
  const path = input.checkouts.get(repo);
  if (path === undefined) return unresolved(repo, null, `${input.checkoutsFile} has no line for ${repo}`);
  if (!existsSync(path)) return unresolved(repo, path, `${path} does not exist`);
  let origin: string;
  try {
    origin = targetFromRemote(seams, path).slug;
  } catch (error) {
    return unresolved(repo, path, (error as Error).message);
  }
  if (origin !== repo) return unresolved(repo, path, `${path}'s origin reads ${origin}, not ${repo}`);
  if (input.at === null) return { code, repo, path, verdict: "verified", reason: null, at: null };
  const rev = seams.run(GIT, ["rev-parse", "--verify", "--quiet", `${input.at}^{commit}`], { cwd: path });
  const at = rev.code === 0 ? (outputLines(rev.stdout)[0] ?? null) : null;
  // The cited ranges still resolve at their own sha; only the staleness read is lost, and said.
  if (at === null) return { code, repo, path, verdict: "verified", reason: `--at ${input.at} does not resolve in ${path}, so no [STALE] reading was taken`, at: null };
  return { code, repo, path, verdict: "verified", reason: null, at };
}

export function citeCheck(seams: Seams, input: CiteCheckInput): CiteCheckReport {
  if (!statSync(join(input.repo, input.folder), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${input.folder} is not a folder under --repo; there is nothing to check, which is not the same as nothing found`);
  }
  let registry: RepoRegistry | null = null;
  let registryError: string | null = null;
  try {
    registry = loadRepoRegistry(input.repo);
  } catch (error) {
    registryError = `the spec repository's nen/repos.json could not be read: ${(error as Error).message}`;
  }
  const members = new Map<string, MemberCheckout>();
  const member = (code: string): MemberCheckout => {
    const known = members.get(code);
    if (known !== undefined) return known;
    const resolved = resolveMember(seams, input, registry, registryError, code);
    members.set(code, resolved);
    return resolved;
  };

  const blobs = new Map<string, { ok: true; content: string } | { ok: false; verdict: CitationVerdict; reason: string }>();
  const readBlob = (path: string, rev: string, file: string): { ok: true; content: string } | { ok: false; verdict: CitationVerdict; reason: string } => {
    const key = `${path}\0${rev}\0${file}`;
    const cached = blobs.get(key);
    if (cached !== undefined) return cached;
    let answer: { ok: true; content: string } | { ok: false; verdict: CitationVerdict; reason: string };
    const commit = seams.run(GIT, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd: path });
    const full = outputLines(commit.stdout)[0];
    if (commit.code !== 0 || full === undefined) answer = { ok: false, verdict: "missing-commit", reason: `${rev} is not a commit in ${path}` };
    else {
      const blob = seams.run(GIT, ["cat-file", "blob", `${full}:${file}`], { cwd: path });
      answer = blob.code === 0 ? { ok: true, content: blob.stdout } : { ok: false, verdict: "missing-path", reason: `${file} does not exist at ${rev}` };
    }
    blobs.set(key, answer);
    return answer;
  };

  const inventories = new Map<string, InventoryRow[] | null>();
  const citations: CheckedCitation[] = [];
  for (const file of folderMarkdown(input.repo, input.folder)) {
    for (const line of proseLines(readFileSync(join(input.repo, file), "utf8"))) {
      for (const { text, citation } of citationsIn(line.text)) {
        const base = { file, line: line.number, text };
        if (citation === null || citation.l1 < 1 || citation.l2 < citation.l1) {
          citations.push({ ...base, code: null, member: null, path: null, lines: null, sha: null, tier: null, verdict: "malformed", reason: "not '[src: <CODE>:<path>:<l1>-<l2> @ <sha> · declared|observed|inferred]'", excerpt: "not-checked", stale: null });
          continue;
        }
        const fields = { code: citation.code, path: citation.path, lines: [citation.l1, citation.l2] as const, sha: citation.sha, tier: citation.tier };
        const owner = member(citation.code);
        if (owner.verdict !== "verified" || owner.path === null) {
          citations.push({ ...base, ...fields, member: owner.repo, verdict: "unresolved-member", reason: owner.reason, excerpt: "not-checked", stale: null });
          continue;
        }
        const blob = readBlob(owner.path, citation.sha, citation.path);
        if (!blob.ok) {
          citations.push({ ...base, ...fields, member: owner.repo, verdict: blob.verdict, reason: blob.reason, excerpt: "not-checked", stale: null });
          continue;
        }
        const excerpt = excerptOf(blob.content, citation.l1, citation.l2);
        if (excerpt === null) {
          citations.push({ ...base, ...fields, member: owner.repo, verdict: "out-of-range", reason: `${citation.path} at ${citation.sha} has fewer than ${citation.l2} lines`, excerpt: "not-checked", stale: null });
          continue;
        }
        let excerptVerdict: ExcerptVerdict = "not-checked";
        if (input.verifyExcerpt) {
          if (!inventories.has(citation.code)) inventories.set(citation.code, readInventory(input.repo, citation.code));
          const rows = inventories.get(citation.code) ?? null;
          const row = rows?.find((entry): boolean => entry.path === citation.path && entry.lines === `${citation.l1}-${citation.l2}` && (entry.sha.startsWith(citation.sha) || citation.sha.startsWith(entry.sha)));
          excerptVerdict = row === undefined ? "no-row" : row.excerptSha256 === null ? "no-hash" : row.excerptSha256 === sha256(excerpt) ? "match" : "mismatch";
        }
        let stale: boolean | null = null;
        if (owner.at !== null) {
          const now = readBlob(owner.path, owner.at, citation.path);
          stale = !now.ok || excerptOf(now.content, citation.l1, citation.l2) !== excerpt;
        }
        citations.push({ ...base, ...fields, member: owner.repo, verdict: "resolves", reason: null, excerpt: excerptVerdict, stale });
      }
    }
  }
  const resolves = citations.filter((entry): boolean => entry.verdict === "resolves").length;
  return {
    contract: SPEC_CITE_CHECK_CONTRACT,
    repo: input.repo,
    folder: input.folder,
    checkouts: input.checkoutsFile,
    at: input.at,
    verifyExcerpt: input.verifyExcerpt,
    members: [...members.values()].sort((a, b): number => a.code.localeCompare(b.code)),
    citations,
    counts: {
      total: citations.length,
      resolves,
      failing: citations.length - resolves,
      excerptMismatch: citations.filter((entry): boolean => entry.excerpt === "mismatch").length,
      stale: citations.filter((entry): boolean => entry.stale === true).length,
    },
  };
}

export function renderCiteCheck(report: CiteCheckReport): string[] {
  const lines = [
    `${report.folder}: ${report.counts.total} citation(s) -- ${report.counts.resolves} resolve, ${report.counts.failing} failing, ${report.counts.excerptMismatch} excerpt mismatch${report.at === null ? "" : `, ${report.counts.stale} [STALE] candidate(s) at ${report.at}`}`,
    ...report.members.map((member): string => `  member ${member.code} ${member.repo ?? "(unresolved)"} ${member.verdict}${member.reason === null ? "" : ` -- ${member.reason}`}`),
  ];
  for (const citation of report.citations) {
    if (citation.verdict === "resolves" && citation.excerpt !== "mismatch" && citation.stale !== true) continue;
    const what = citation.verdict !== "resolves" ? `${citation.verdict}${citation.reason === null ? "" : ` -- ${citation.reason}`}` : citation.excerpt === "mismatch" ? "excerpt hash mismatch" : "[STALE] candidate";
    lines.push(`  ${citation.file}:${citation.line} ${citation.text} ${what}`);
  }
  return lines;
}
