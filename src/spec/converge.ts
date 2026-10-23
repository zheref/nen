// src/spec/converge.ts -- `nen spec converge`: a merged folder held against a
// newer inventory of one member, its gaps classified, and -- under --write --
// only ever APPENDED to (zheref/nen#493 AC-6, SP-9, SP-10).
//
// FOUR GAP CLASSES, EACH A FACT ABOUT BYTES, NONE A JUDGEMENT:
//
//   missing      every range the requirement cites in this member is gone at
//                the newer commit (the file no longer exists there).
//   partial      some cited ranges moved or vanished, and none reads changed.
//   contradicts  a cited range's bytes read differently at the newer commit
//                and are found nowhere else in the file: the code under the
//                requirement changed. A CANDIDATE for Hatsu's spec-conflict
//                gate -- whether the change contradicts the sentence is the
//                maintainer's to rule, never nen's.
//   unrequested  a row the newer inventory has and the folder's last capture
//                (`capture/<CODE>/inventory.json`) did not, in a directory the
//                folder cites: behaviour no line requests yet.
//
// COMPLETION CLAIMS ARE NOT EVIDENCE. A ticked task (`- [x]`) citing a
// requirement with a gap is listed under `claims` and closes nothing: the gap
// is read from the code, and a tick is somebody's statement about it.
//
// WHAT --write APPENDS, and nothing else: a `[STALE @ <cited sha>]` companion
// right after each cited range that moved, vanished or changed (the sentence
// and its citation stay, byte for byte), and one `## Phase N: Convergence
// <date> @ <sha12>` section at the end of tasks.md, one open task per gap.
// It never renumbers, never deletes, never writes a `supersedes` line (a
// reversal needs a new id with new words, which are the author's). A second
// run on the same inputs finds its companions and its phase already written
// and changes zero bytes (SC-3).

import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { loadRepoRegistry, type RepoRegistry } from "../schema/repos.js";
import { assertInsideRepo } from "./check.js";
import { excerptOf, resolveMember, type MemberCheckout } from "./citecheck.js";
import { diffInventories, InventoryReadError, loadInventory, type LoadedInventory } from "./diff.js";
import type { InventoryRow } from "./inventory.js";
import { citationsIn, proseLines, requirementOf, trailingAnnotation } from "./lines.js";
import { readTree, TreeReadError, type MemberTree } from "./tree.js";

export const SPEC_CONVERGE_CONTRACT = "nen.spec.converge/v0.1";

export type ConvergeVerdict = "converged" | "gaps" | "could-not-read";
export type GapClass = "missing" | "partial" | "contradicts" | "unrequested";
export const GAP_CLASSES: readonly GapClass[] = ["missing", "partial", "contradicts", "unrequested"];
export type RangeState = "current" | "moved" | "changed" | "vanished" | "unreadable";

export interface ConvergedCitation {
  readonly line: number;
  readonly id: string;
  readonly text: string;
  readonly path: string;
  readonly lines: readonly [number, number];
  readonly sha: string;
  readonly state: RangeState;
  /** Where the cited bytes are now, when they moved; else null. */
  readonly now: readonly [number, number] | null;
  /** True when the line already carries this citation's `[STALE @ <sha>]` companion. */
  readonly marked: boolean;
  readonly reason: string | null;
}

export interface Gap {
  readonly class: GapClass;
  /** The requirement id (`FR-003`) or, for `unrequested`, the inventory row id. */
  readonly id: string;
  readonly line: number | null;
  readonly detail: string;
}

export interface Claim {
  readonly line: number;
  readonly text: string;
  readonly ids: readonly string[];
}

export interface Write {
  readonly file: string;
  readonly kind: "stale" | "phase";
  readonly line: number | null;
  readonly text: string;
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface ConvergeReport {
  readonly contract: string;
  readonly verdict: ConvergeVerdict;
  readonly repo: string;
  readonly folder: string;
  readonly inventory: { readonly file: string; readonly sha: string | null; readonly origin: string | null };
  readonly member: { readonly code: string; readonly repo: string | null; readonly path: string | null };
  readonly citations: readonly ConvergedCitation[];
  readonly gaps: readonly Gap[];
  /** Null with `unrequestedReason` when there is no prior capture inventory to diff against. */
  readonly unrequested: readonly InventoryRow[] | null;
  readonly unrequestedReason: string | null;
  readonly claims: readonly Claim[];
  readonly writes: readonly Write[];
  readonly action: "none" | "written" | "would-write" | "refused";
  readonly counts: Readonly<Record<GapClass, number>>;
  readonly reason: string | null;
}

export interface ConvergeInput {
  readonly repo: string;
  readonly folder: string;
  readonly inventoryFile: string;
  readonly code: string;
  readonly checkoutsFile: string;
  readonly checkouts: ReadonlyMap<string, string>;
  readonly date: string;
  readonly write: boolean;
  readonly dryRun: boolean;
}

const zeroCounts = (): Record<GapClass, number> => ({ missing: 0, partial: 0, contradicts: 0, unrequested: 0 });

function unreadable(input: ConvergeInput, inventory: LoadedInventory | null, member: MemberCheckout | null, reason: string): ConvergeReport {
  return {
    contract: SPEC_CONVERGE_CONTRACT,
    verdict: "could-not-read",
    repo: input.repo,
    folder: input.folder,
    inventory: { file: input.inventoryFile, sha: inventory?.sha ?? null, origin: inventory?.origin ?? null },
    member: { code: input.code, repo: member?.repo ?? null, path: member?.path ?? null },
    citations: [],
    gaps: [],
    unrequested: null,
    unrequestedReason: null,
    claims: [],
    writes: [],
    action: input.write ? "refused" : "none",
    counts: zeroCounts(),
    reason,
  };
}

/** Where `needle` (whole lines) sits in `hay`, as a 1-based range, or null. */
function findLines(hay: string, needle: string): [number, number] | null {
  const want = needle.replace(/\n$/, "").split("\n");
  const lines = hay.replace(/\r\n/g, "\n").split("\n");
  if (hay.endsWith("\n")) lines.pop();
  for (let start = 0; start + want.length <= lines.length; start += 1) {
    if (want.every((line, offset): boolean => lines[start + offset] === line)) return [start + 1, start + want.length];
  }
  return null;
}

function readAt(seams: Seams, checkout: string, sha: string, path: string): string | null {
  const rev = seams.run(GIT, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { cwd: checkout });
  const full = outputLines(rev.stdout)[0];
  if (rev.code !== 0 || full === undefined) return null;
  const blob = seams.run(GIT, ["cat-file", "blob", `${full}:${path}`], { cwd: checkout });
  return blob.code === 0 ? blob.stdout : null;
}

function readFolderFile(repo: string, relative: string): string | null {
  const absolute = join(repo, relative);
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  if (!stat.isFile()) throw new Error(`${relative} is not a regular file; nen reads and writes no spec file through a link or a directory`);
  assertInsideRepo(repo, absolute, relative);
  return readFileSync(absolute, "utf8");
}

export function converge(seams: Seams, input: ConvergeInput): ConvergeReport {
  let inventory: LoadedInventory;
  try {
    inventory = loadInventory(input.inventoryFile);
  } catch (error) {
    if (error instanceof InventoryReadError) return unreadable(input, null, null, error.message);
    throw error;
  }
  if (inventory.sha === null || inventory.origin === null) return unreadable(input, inventory, null, `${input.inventoryFile} names no sha or no origin; a convergence is read at the inventory's commit in the inventory's member`);
  let registry: RepoRegistry | null = null;
  let registryError: string | null = null;
  try {
    registry = loadRepoRegistry(input.repo);
  } catch (error) {
    registryError = `the spec repository's nen/repos.json could not be read: ${(error as Error).message}`;
  }
  const member = resolveMember(seams, { repo: input.repo, folder: input.folder, checkoutsFile: input.checkoutsFile, checkouts: input.checkouts, at: null, verifyExcerpt: false }, registry, registryError, input.code);
  if (member.verdict !== "verified" || member.path === null) return unreadable(input, inventory, member, member.reason ?? "the member checkout did not verify");
  if (member.repo !== inventory.origin) return unreadable(input, inventory, member, `--code ${input.code} names ${member.repo ?? "nothing"}, but ${input.inventoryFile} is an inventory of ${inventory.origin}`);
  let tree: MemberTree;
  try {
    tree = readTree(seams, member.path, inventory.sha);
  } catch (error) {
    if (error instanceof TreeReadError) return unreadable(input, inventory, member, error.message);
    throw error;
  }
  const specFile = `${input.folder}/spec.md`;
  const tasksFile = `${input.folder}/tasks.md`;
  const specText = readFolderFile(input.repo, specFile);
  if (specText === null) return unreadable(input, inventory, member, `${specFile} does not exist; a folder with no spec.md has nothing to converge, which is not the same as converged`);
  const tasksText = readFolderFile(input.repo, tasksFile);

  // 1. Every citation of this member on a requirement line, and what its bytes do now.
  const citations: ConvergedCitation[] = [];
  const byRequirement = new Map<string, { line: number; states: RangeState[] }>();
  const citedDirs = new Set<string>();
  for (const line of proseLines(specText)) {
    const requirement = requirementOf(line.text);
    if (requirement === null) continue;
    const companions = new Set(trailingAnnotation(line.text).stale);
    for (const { text, citation } of citationsIn(line.text)) {
      if (citation === null || citation.code !== input.code) continue;
      citedDirs.add(citation.path.includes("/") ? citation.path.slice(0, citation.path.lastIndexOf("/")) : "");
      const old = readAt(seams, member.path, citation.sha, citation.path);
      const oldExcerpt = old === null ? null : excerptOf(old, citation.l1, citation.l2);
      const nowText = tree.read(citation.path);
      let state: RangeState;
      let now: [number, number] | null = null;
      let reason: string | null = null;
      if (oldExcerpt === null) {
        state = "unreadable";
        reason = old === null ? `${citation.path} could not be read at ${citation.sha} in ${member.path}` : `${citation.path} at ${citation.sha} has fewer than ${citation.l2} lines`;
      } else if (nowText === null) state = "vanished";
      else if (excerptOf(nowText, citation.l1, citation.l2) === oldExcerpt) state = "current";
      else {
        now = findLines(nowText, oldExcerpt);
        state = now === null ? "changed" : "moved";
      }
      citations.push({ line: line.number, id: requirement.id, text, path: citation.path, lines: [citation.l1, citation.l2], sha: citation.sha, state, now, marked: companions.has(`[STALE @ ${citation.sha}]`), reason });
      const entry = byRequirement.get(requirement.id) ?? { line: line.number, states: [] };
      entry.states.push(state);
      byRequirement.set(requirement.id, entry);
    }
  }

  // 2. The gap per requirement.
  const gaps: Gap[] = [];
  for (const [id, { line, states }] of byRequirement) {
    if (states.includes("unreadable")) {
      gaps.push({ class: "partial", id, line, detail: `${states.filter((state): boolean => state === "unreadable").length} cited range(s) could not be read at their own sha, so the rest of the requirement's evidence is all that was compared` });
      continue;
    }
    if (states.every((state): boolean => state === "current")) continue;
    const count = (state: RangeState): number => states.filter((entry): boolean => entry === state).length;
    const tally = (["current", "moved", "changed", "vanished"] as const).filter((state): boolean => count(state) > 0).map((state): string => `${count(state)} ${state}`).join(", ");
    if (count("changed") > 0) gaps.push({ class: "contradicts", id, line, detail: `${tally} at ${tree.sha.slice(0, 12)}; the cited bytes read differently and are found nowhere else in the file -- a candidate for the spec-conflict ruling, never decided here` });
    else if (count("vanished") === states.length) gaps.push({ class: "missing", id, line, detail: `${tally} at ${tree.sha.slice(0, 12)}; every cited file is gone` });
    else gaps.push({ class: "partial", id, line, detail: `${tally} at ${tree.sha.slice(0, 12)}` });
  }

  // 3. Rows new since the folder's last capture, in a directory the folder cites.
  let unrequested: InventoryRow[] | null = null;
  let unrequestedReason: string | null = null;
  const captureFile = `capture/${input.code}/inventory.json`;
  if (!existsSync(join(input.repo, captureFile))) unrequestedReason = `${captureFile} does not exist, so there is no earlier capture to tell new rows from old ones`;
  else {
    try {
      assertInsideRepo(input.repo, join(input.repo, captureFile), captureFile);
      const previous = loadInventory(join(input.repo, captureFile));
      const diff = diffInventories(previous, inventory);
      unrequested = diff.added.filter((row): boolean => citedDirs.has(row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : ""));
      for (const row of unrequested) gaps.push({ class: "unrequested", id: row.id, line: null, detail: `new in ${input.code} at ${tree.sha.slice(0, 12)}, in a directory this folder cites, and cited by no line` });
    } catch (error) {
      if (!(error instanceof InventoryReadError)) throw error;
      return unreadable(input, inventory, member, `${captureFile}: ${error.message}`);
    }
  }

  // 4. Ticked tasks citing a requirement with a gap: claims, never evidence.
  const gapIds = new Set(gaps.map((gap): string => gap.id));
  const claims: Claim[] = [];
  if (tasksText !== null) {
    for (const line of proseLines(tasksText)) {
      if (!/^\s*[-*]\s+\[[xX]\]/.test(line.text)) continue;
      const ids = [...new Set([...line.text.matchAll(/\b(?:FR|SC)-\d+\b/g)].map((match): string => match[0]))].filter((id): boolean => gapIds.has(id));
      if (ids.length > 0) claims.push({ line: line.number, text: line.text.trim(), ids });
    }
  }

  // 5. The appends.
  const writes: Write[] = [];
  const specLines = specText.split("\n");
  for (const citation of citations) {
    if (citation.state === "current" || citation.state === "unreadable" || citation.marked) continue;
    const index = citation.line - 1;
    const original = specLines[index] as string;
    const companion = `[STALE @ ${citation.sha}]`;
    if (original.includes(`${citation.text} ${companion}`)) continue;
    specLines[index] = original.replace(citation.text, `${citation.text} ${companion}`);
    writes.push({ file: specFile, kind: "stale", line: citation.line, text: companion });
  }
  const sha12 = tree.sha.slice(0, 12);
  const phaseKey = `@ ${sha12}`;
  const tasks = tasksText ?? "";
  const phaseWritten = proseLines(tasks).some((line): boolean => /^##\s+Phase\s+\d+:\s+Convergence\b/.test(line.text) && line.text.trimEnd().endsWith(phaseKey));
  let phaseText: string | null = null;
  if (gaps.length > 0 && !phaseWritten) {
    const phases = [...tasks.matchAll(/^##\s+Phase\s+(\d+)\b/gm)].map((match): number => Number(match[1]));
    const next = (phases.length === 0 ? 0 : Math.max(...phases)) + 1;
    let task = Math.max(0, ...[...tasks.matchAll(/\bT(\d{3,})\b/g)].map((match): number => Number(match[1])));
    const rows = gaps.map((gap): string => {
      task += 1;
      return `- [ ] T${String(task).padStart(3, "0")} [${gap.class}] ${gap.id} — ${gap.detail}`;
    });
    const heading = `## Phase ${next}: Convergence ${input.date} ${phaseKey}`;
    const separator = tasks === "" ? "" : tasks.endsWith("\n\n") ? "" : tasks.endsWith("\n") ? "\n" : "\n\n";
    phaseText = `${separator}${heading}\n\n${rows.join("\n")}\n`;
    writes.push({ file: tasksFile, kind: "phase", line: null, text: heading });
  }

  const counts = zeroCounts();
  for (const gap of gaps) counts[gap.class] += 1;
  let action: ConvergeReport["action"] = "none";
  if (input.write && writes.length > 0) {
    if (input.dryRun) action = "would-write";
    else {
      if (writes.some((write): boolean => write.kind === "stale")) writeFileSync(join(input.repo, specFile), specLines.join("\n"));
      if (phaseText !== null) writeFileSync(join(input.repo, tasksFile), `${tasks}${phaseText}`);
      action = "written";
    }
  }
  return {
    contract: SPEC_CONVERGE_CONTRACT,
    verdict: gaps.length === 0 ? "converged" : "gaps",
    repo: input.repo,
    folder: input.folder,
    inventory: { file: input.inventoryFile, sha: inventory.sha, origin: inventory.origin },
    member: { code: input.code, repo: member.repo, path: member.path },
    citations,
    gaps,
    unrequested,
    unrequestedReason,
    claims,
    writes,
    action,
    counts,
    reason: null,
  };
}

export function renderConverge(report: ConvergeReport): string[] {
  if (report.verdict === "could-not-read") return [`could-not-read: ${report.folder} -- ${report.reason ?? ""}`];
  const lines = [
    `${report.verdict}: ${report.folder} against ${report.member.code} ${report.member.repo ?? ""} @ ${report.inventory.sha?.slice(0, 12) ?? "?"} -- ${GAP_CLASSES.map((name): string => `${report.counts[name]} ${name}`).join(" · ")} · action ${report.action}`,
  ];
  for (const gap of report.gaps) lines.push(`  ${gap.class} ${gap.id}${gap.line === null ? "" : ` (spec.md:${gap.line})`} -- ${gap.detail}`);
  if (report.unrequestedReason !== null) lines.push(`  unrequested: not computed -- ${report.unrequestedReason}`);
  for (const claim of report.claims) lines.push(`  claim tasks.md:${claim.line} ticks ${claim.ids.join(", ")} -- a tick is not evidence; the gap stands`);
  for (const write of report.writes) lines.push(`  ${report.action === "written" ? "wrote" : report.action === "would-write" ? "would write" : "owed"} ${write.file}${write.line === null ? "" : `:${write.line}`} ${write.text}`);
  return lines;
}
