// Complete immutable blobs, not GitHub's potentially truncated patch field.
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { GH, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import { changedLines } from "../release/linediff.js";
import type { ReleaseLineMatcher } from "../schema/releasepattern.js";
export const ADDED_LINES_CONTRACT = "nen.pr.added-lines/v0.1";
export const NEXT_ID_CONTRACT = "nen.pr.next-id/v0.1";
const MAX_BLOB = 8 * 1024 * 1024;
const MAX_ROWS = 100_000;
const SHA = /^[a-f0-9]{40}$/i;
function object(raw: unknown, what: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${what}: expected a JSON object`);
  return raw as Record<string, unknown>;
}
export function readJson(seams: Seams, endpoint: string): unknown {
  const result = seams.run(GH, ["api", "--method", "GET", endpoint]);
  if (result.code !== 0) throw new Error(`${endpoint}: ${result.stderr.trim() || `gh exited ${result.code}`}`);
  try { return JSON.parse(result.stdout); } catch { throw new Error(`${endpoint}: unreadable JSON`); }
}
export function validateReadPath(path: string): void {
  if (path === "" || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..") || /[\0\r\n]/.test(path)) throw new Error("--path must name one repository-relative file");
}
interface Pull { readonly number: number; readonly headRef: string; readonly head: string; readonly base: string }
export class ImmutableFiles {
  private bytesRead = 0;
  private treeEntries = 0;
  private readonly trees = new Map<string, readonly Record<string, unknown>[]>();
  private readonly blobs = new Map<string, string>();
  constructor(private readonly seams: Seams, private readonly target: Target) {}
  read(path: string, sha: string): string | null {
    if (!SHA.test(sha)) throw new Error(`invalid immutable commit '${sha}'`);
    let entries = this.trees.get(sha);
    if (entries === undefined) {
      const commit = object(readJson(this.seams, `repos/${this.target.slug}/git/commits/${sha}`), `commit ${sha}`);
      if (commit["sha"] !== sha) throw new Error(`commit ${sha}: identity mismatch`);
      const tree = object(commit["tree"], "commit tree")["sha"];
      if (typeof tree !== "string" || !SHA.test(tree)) throw new Error(`commit ${sha}: no tree identity`);
      const response = object(readJson(this.seams, `repos/${this.target.slug}/git/trees/${tree}?recursive=1`), "tree");
      if (response["sha"] !== tree || response["truncated"] !== false || !Array.isArray(response["tree"])) throw new Error(`commit ${sha}: incomplete tree read`);
      if (response["tree"].length + this.treeEntries > 200_000) throw new Error("tree-entry read budget exceeded");
      this.treeEntries += response["tree"].length;
      const paths = new Set<string>();
      entries = response["tree"].map((entry) => {
        const row = object(entry, "tree entry");
        const path = row["path"]; const kind = row["type"]; const mode = row["mode"]; const id = row["sha"];
        if (typeof path !== "string" || path === "" || paths.has(path) || !["blob", "tree", "commit"].includes(String(kind)) || typeof id !== "string" || !SHA.test(id) || !(kind === "blob" && ["100644", "100755", "120000"].includes(String(mode)) || kind === "tree" && mode === "040000" || kind === "commit" && mode === "160000")) throw new Error(`commit ${sha}: malformed or duplicate tree entry`);
        paths.add(path); return row;
      });
      this.trees.set(sha, entries);
    }
    const matches = entries.filter((entry) => entry["path"] === path);
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw new Error(`ambiguous tree path '${path}'`);
    const entry = matches[0] as Record<string, unknown>;
    const blobSha = entry["sha"];
    if (entry["type"] !== "blob" || !["100644", "100755"].includes(String(entry["mode"])) || typeof blobSha !== "string" || !SHA.test(blobSha)) throw new Error(`'${path}' is not a regular text blob`);
    const cached = this.blobs.get(blobSha); if (cached !== undefined) return cached;
    const blob = object(readJson(this.seams, `repos/${this.target.slug}/git/blobs/${blobSha}`), "blob");
    if (blob["sha"] !== blobSha || blob["encoding"] !== "base64" || typeof blob["content"] !== "string" || typeof blob["size"] !== "number") throw new Error(`blob ${blobSha}: incomplete content/identity`);
    if (!Number.isSafeInteger(blob["size"]) || blob["size"] < 0 || blob["size"] > MAX_BLOB || blob["content"].length > MAX_BLOB * 2) throw new Error(`blob ${blobSha}: read-size budget exceeded`);
    const encoded = blob["content"].replace(/\s/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error(`blob ${blobSha}: malformed base64`);
    const bytes = Buffer.from(encoded, "base64");
    const digest = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (bytes.length !== blob["size"] || digest !== blobSha.toLowerCase() || !isUtf8(bytes) || bytes.includes(0)) throw new Error(`blob ${blobSha}: size, digest or UTF-8 verification failed`);
    if (this.bytesRead + bytes.length > 32 * 1024 * 1024) throw new Error("cumulative blob read budget exceeded");
    this.bytesRead += bytes.length;
    const text = bytes.toString("utf8"); this.blobs.set(blobSha, text); return text;
  }
}
function openPulls(seams: Seams, target: Target): Pull[] {
  const pulls: Pull[] = []; const seen = new Set<number>();
  for (let page = 1; page <= 100; page += 1) {
    const raw = readJson(seams, `repos/${target.slug}/pulls?state=open&per_page=100&page=${page}`);
    if (!Array.isArray(raw)) throw new Error("open PR list is not an array");
    for (const entry of raw) {
      const row = object(entry, "open PR"); const head = object(row["head"], "PR head"); const base = object(row["base"], "PR base");
      const number = row["number"]; const ref = head["ref"]; const headSha = head["sha"]; const baseSha = base["sha"];
      if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0 || seen.has(number) || typeof ref !== "string" || typeof headSha !== "string" || !SHA.test(headSha) || typeof baseSha !== "string" || !SHA.test(baseSha)) throw new Error("open PR list has incomplete or duplicate identity");
      seen.add(number); pulls.push({ number, headRef: ref, head: headSha, base: baseSha });
    }
    if (pulls.length > 256) throw new Error("open PR read budget exceeded (256 PRs); refusing a partial result");
    if (raw.length < 100) return pulls;
  }
  throw new Error("open PR list exceeds 100 pages; refusing a partial read");
}
export interface AddedLine { readonly pr: number; readonly headRef: string; readonly headSha: string; readonly baseSha: string; readonly line: number; readonly text: string }
export function addedLines(seams: Seams, target: Target, path: string, pattern: ReleaseLineMatcher | null = null): { contract: string; complete: boolean; path: string; lines: readonly AddedLine[]; pulls: readonly { pr: number; headRef: string; error: string | null }[] } {
  validateReadPath(path);
  const pulls = openPulls(seams, target); const files = new ImmutableFiles(seams, target);
  let patternWork = 0;
  const lines: AddedLine[] = []; const results: { pr: number; headRef: string; error: string | null }[] = [];
  for (const pull of pulls) {
    try {
      const comparison = object(readJson(seams, `repos/${target.slug}/compare/${pull.base}...${pull.head}`), `PR #${pull.number} merge base`);
      const base = object(comparison["merge_base_commit"], "merge base")["sha"];
      if (typeof base !== "string" || !SHA.test(base)) throw new Error("no immutable merge-base SHA");
      const before = files.read(path, base) ?? ""; const after = files.read(path, pull.head) ?? "";
      const changes = changedLines(before, after);
      if (changes === null) throw new Error("complete line diff exceeds bounded work limits");
      const selected = changes.filter((change) => change.side === "added" && (pattern === null || ((): boolean => { const result = pattern.match(change.text, 8_000_000 - patternWork); patternWork += result.work; if (result.kind === "exhausted") throw new Error(`pattern work limit: ${result.reason}`); return result.kind === "match"; })()));
      const current = object(readJson(seams, `repos/${target.slug}/pulls/${pull.number}`), "PR reread");
      if (object(current["head"], "PR head")["sha"] !== pull.head || object(current["base"], "PR base")["sha"] !== pull.base || current["state"] !== "open") throw new Error("PR head/base/state moved during the read; refetch before reserving an id");
      if (lines.length + selected.length > MAX_ROWS) throw new Error("added-line row budget exceeded");
      lines.push(...selected.map((change) => ({ pr: pull.number, headRef: pull.headRef, headSha: pull.head, baseSha: base, line: change.line, text: change.text })));
      results.push({ pr: pull.number, headRef: pull.headRef, error: null });
    } catch (error) { results.push({ pr: pull.number, headRef: pull.headRef, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { contract: ADDED_LINES_CONTRACT, complete: results.every((pull) => pull.error === null), path, lines, pulls: results };
}
export function nextId(seams: Seams, target: Target, path: string, prefix: string, baseRef: string | null): { contract: string; complete: boolean; baseSha: string; nextId: number | null; ids: readonly { id: number; source: string; line: number }[]; collisions: readonly number[]; errors: readonly string[] } {
  validateReadPath(path);
  if (!/^[A-Z][A-Z0-9]{0,15}$/.test(prefix)) throw new Error("--prefix must be an uppercase stable-id prefix");
  const ref = baseRef ?? object(readJson(seams, `repos/${target.slug}`), "repository")["default_branch"];
  if (typeof ref !== "string" || ref === "") throw new Error("no default branch/ref was read");
  const commit = object(readJson(seams, `repos/${target.slug}/commits/${encodeURIComponent(ref)}`), "base ref")["sha"];
  if (typeof commit !== "string" || !SHA.test(commit)) throw new Error("base ref did not resolve to an immutable commit");
  const text = new ImmutableFiles(seams, target).read(path, commit);
  if (text === null) throw new Error(`'${path}' is absent at base ${commit}; no id space was read`);
  const added = addedLines(seams, target, path);
  const ids: { id: number; source: string; line: number }[] = [];
  const parse = (text: string, source: string, line: number): void => {
    const match = new RegExp(`^\\| ${prefix}-([0-9]+)(?![0-9])`).exec(text); if (match === null) return;
    const id = Number(match[1]); if (!Number.isSafeInteger(id) || id < 0) throw new Error(`unsafe ${prefix} id at ${source}:${line}`);
    ids.push({ id, source, line });
  };
  if (text.split("\n").length > MAX_ROWS) throw new Error("base row budget exceeded");
  text.split("\n").forEach((line, index) => parse(line, `base ${commit}`, index + 1));
  for (const line of added.lines) parse(line.text, `PR #${line.pr} (${line.headRef}@${line.headSha})`, line.line);
  const counts = new Map<number, number>(); let maximum = 0;
  for (const entry of ids) { counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1); maximum = Math.max(maximum, entry.id); }
  const collisions = [...counts].filter(([, count]) => count > 1).map(([id]) => id).sort((a, b) => a - b);
  if (!Number.isSafeInteger(maximum + 1)) throw new Error("next id exceeds safe integer range");
  const errors = added.pulls.flatMap((pull) => pull.error === null ? [] : [`PR #${pull.pr}: ${pull.error}`]);
  return { contract: NEXT_ID_CONTRACT, complete: added.complete && collisions.length === 0, baseSha: commit, nextId: added.complete && collisions.length === 0 ? maximum + 1 : null, ids, collisions, errors };
}
