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
// <date>` section (SP-9's heading; the body's first line `Inventory: <CODE> @
// <sha12>` is the key a rerun finds) at the end of tasks.md, one open task per
// gap tagged with its story and the member's platform. When a requirement's
// gap class differs from the last finding recorded for it, the new row ends
// `· supersedes T<nnn>` -- computed, so no author words are needed. It never
// renumbers and never deletes. A second run on the same inputs finds its
// companions and its phase already written and changes zero bytes (SC-3).

import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { loadRepoRegistry, type RepoRegistry } from "../schema/repos.js";
import { assertInsideRepo } from "./check.js";
import { excerptOf, resolveMember, type MemberCheckout } from "./citecheck.js";
import { diffInventories, InventoryReadError, loadInventory, type LoadedInventory } from "./diff.js";
import type { InventoryRow } from "./inventory.js";
import { acceptanceScenarioOf, citationsIn, proseLines, requirementOf } from "./lines.js";
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

export type ConvergeCounts = Record<GapClass, number> & {
  /** Scenario definition lines outside fenced source data, including uncited lines. */
  scenariosRead: number;
  /** Scenario lines with at least one valid citation of the selected member. */
  scenariosCited: number;
};

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
  readonly counts: Readonly<ConvergeCounts>;
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

const zeroCounts = (): ConvergeCounts => ({ missing: 0, partial: 0, contradicts: 0, unrequested: 0, scenariosRead: 0, scenariosCited: 0 });

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

  // 1. Every citation of this member on a requirement or scenario line, and what its bytes do now.
  const counts = zeroCounts();
  const citations: ConvergedCitation[] = [];
  const pendingStale: { line: number; end: number; text: string }[] = [];
  const byRequirement = new Map<string, { line: number; states: RangeState[] }>();
  const citedDirs = new Set<string>();
  for (const line of proseLines(specText)) {
    const scenario = acceptanceScenarioOf(line.text);
    if (scenario !== null) counts.scenariosRead += 1;
    const requirement = scenario ?? requirementOf(line.text);
    if (requirement === null) continue;
    let scenarioCited = false;
    let afterCitation = 0;
    for (const { text, citation } of citationsIn(line.text)) {
      const end = line.text.indexOf(text, afterCitation) + text.length;
      afterCitation = end;
      if (citation === null || citation.code !== input.code) continue;
      // AC rows use cite-check's numeric-range validity; existing requirement handling is unchanged.
      if (scenario !== null && (citation.l1 < 1 || citation.l2 < citation.l1)) continue;
      if (scenario !== null && !scenarioCited) {
        counts.scenariosCited += 1;
        scenarioCited = true;
      }
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
      const companion = `[STALE @ ${citation.sha}]`;
      const marked = line.text.slice(end).trimStart().startsWith(companion);
      citations.push({ line: line.number, id: requirement.id, text, path: citation.path, lines: [citation.l1, citation.l2], sha: citation.sha, state, now, marked, reason });
      if (state !== "current" && state !== "unreadable" && !marked) pendingStale.push({ line: line.number, end, text: companion });
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
      const ids = [...new Set([...line.text.matchAll(/\b(?:FR|SC|AC)-\d+\b/g)].map((match): string => match[0]))].filter((id): boolean => gapIds.has(id));
      if (ids.length > 0) claims.push({ line: line.number, text: line.text.trim(), ids });
    }
  }

  // 5. The appends.
  const writes: Write[] = [];
  const specLines = specText.split("\n");
  for (const stale of pendingStale) writes.push({ file: specFile, kind: "stale", line: stale.line, text: stale.text });
  // Insert from right to left so repeated citations retain their own original offsets.
  for (const stale of [...pendingStale].reverse()) {
    const index = stale.line - 1;
    const original = specLines[index] as string;
    specLines[index] = `${original.slice(0, stale.end)} ${stale.text}${original.slice(stale.end)}`;
  }
  const sha12 = tree.sha.slice(0, 12);
  // SP-9's heading is `## Phase N: Convergence <date>`; the commit read goes in the body, and is the key a rerun finds.
  const phaseKey = `Inventory: ${input.code} @ ${sha12}`;
  const tasks = tasksText ?? "";
  const taskLines = proseLines(tasks);
  const phaseWritten = taskLines.some((line): boolean => line.text.trim() === phaseKey);
  // Older Nen versions may already have recorded this inventory, before AC gaps were visible.
  const recordedScenarios = new Set<string>();
  let inventorySection: string | null = null;
  for (const line of taskLines) {
    if (/^#{1,2}\s/.test(line.text)) inventorySection = null;
    if (line.text.trim().startsWith("Inventory: ")) inventorySection = line.text.trim();
    if (inventorySection !== phaseKey) continue;
    const scenario = /^\s*-\s+\[[ xX]\]\s+T\d{3,}\b[^\n]*?\[(?:missing|partial|contradicts)\] (AC-\d+) —/.exec(line.text);
    if (scenario !== null) recordedScenarios.add(scenario[1] as string);
  }
  const unwrittenGaps = phaseWritten ? gaps.filter((gap): boolean => /^AC-\d+$/.test(gap.id) && !recordedScenarios.has(gap.id)) : gaps;
  // Each row carries its story (from a task already naming the requirement) and the member's platform, so
  // `spec tasks groups` files it in a story group; a class that changed since the last recorded finding
  // for the same id supersedes that row (SP-10: a reversal is a supersedes line, never an edit).
  const platform = (registry?.families ?? []).flatMap((family) => family.members).find((member): boolean => member.code === input.code)?.platform ?? input.code;
  const storyOf = (id: string): string | null => {
    for (const line of tasks.split("\n")) {
      if (!new RegExp(`\\b${id}\\b`).test(line)) continue;
      const story = /\[US-?(\d+)\]/.exec(line);
      if (story !== null) return `US${story[1] as string}`;
    }
    return null;
  };
  const lastFinding = (id: string): { task: string; class: string } | null => {
    let found: { task: string; class: string } | null = null;
    for (const match of tasks.matchAll(new RegExp(`^\\s*-\\s+\\[[ xX]\\]\\s+(T\\d{3,})\\b[^\\n]*?\\[(missing|partial|contradicts|unrequested)\\] ${id.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")} —`, "gm"))) found = { task: match[1] as string, class: match[2] as string };
    return found;
  };
  let phaseText: string | null = null;
  if (unwrittenGaps.length > 0) {
    const phases = [...tasks.matchAll(/^##\s+Phase\s+(\d+)\b/gm)].map((match): number => Number(match[1]));
    const next = (phases.length === 0 ? 0 : Math.max(...phases)) + 1;
    let task = Math.max(0, ...[...tasks.matchAll(/\bT(\d{3,})\b/g)].map((match): number => Number(match[1])));
    const rows = unwrittenGaps.map((gap): string => {
      task += 1;
      const story = gap.class === "unrequested" ? null : storyOf(gap.id);
      const previous = lastFinding(gap.id);
      const supersedes = previous !== null && previous.class !== gap.class ? ` · supersedes ${previous.task}` : "";
      return `- [ ] T${String(task).padStart(3, "0")}${story === null ? "" : ` [${story}]`} [platform:${platform}] [${gap.class}] ${gap.id} — ${gap.detail}${supersedes}`;
    });
    const heading = `## Phase ${next}: Convergence ${input.date}`;
    const separator = tasks === "" ? "" : tasks.endsWith("\n\n") ? "" : tasks.endsWith("\n") ? "\n" : "\n\n";
    phaseText = `${separator}${heading}\n\n${phaseKey}\n\n${rows.join("\n")}\n`;
    writes.push({ file: tasksFile, kind: "phase", line: null, text: heading });
  }

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
    `  scenarios: ${report.counts.scenariosRead} scenario line(s) read · ${report.counts.scenariosCited} citing ${report.member.code}`,
  ];
  for (const gap of report.gaps) lines.push(`  ${gap.class} ${gap.id}${gap.line === null ? "" : ` (spec.md:${gap.line})`} -- ${gap.detail}`);
  if (report.unrequestedReason !== null) lines.push(`  unrequested: not computed -- ${report.unrequestedReason}`);
  for (const claim of report.claims) lines.push(`  claim tasks.md:${claim.line} ticks ${claim.ids.join(", ")} -- a tick is not evidence; the gap stands`);
  for (const write of report.writes) lines.push(`  ${report.action === "written" ? "wrote" : report.action === "would-write" ? "would write" : "owed"} ${write.file}${write.line === null ? "" : `:${write.line}`} ${write.text}`);
  return lines;
}
