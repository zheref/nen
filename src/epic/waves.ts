// ============================================================================
// PORTED FROM bankai-core `scripts/epic_coordinator.py` (zheref/nen#4,
// Akatsuki migration P1).
//
// The header below this block is the ORIGINAL's own module docstring, carried
// VERBATIM (the BC-IS-#737 discipline: every WHY in it names a reason a branch
// exists, and a port that drops it is a port whose next maintainer
// "simplifies" it back into the bug). Only file/flag references were adjusted
// where TypeScript's shape differs from the CLI wrapper's (the Python's own
// `--out`/`--citation` argparse flags live one layer up, in ./verb.ts); the
// algorithm and every edge case below are the original's, unchanged.
//
// TWO DELIBERATE DEVIATIONS FROM THE ORIGINAL, both because the original had a
// default this repository may not have -- named here rather than silently
// applied:
//
//   1. THE CITATION IS REQUIRED, NEVER DEFAULTED. The Python defaulted
//      `--citation` to a specific clause id and took an override for its one
//      other caller. A default here would be a clause id from one system
//      hard-coded into a binary that serves several (§3), so the caller names
//      it every time.
//   2. ROUNDING IS BANKER'S, EXPLICITLY (../epic/waves.ts's roundHalfEven).
//      Python's `round()` rounds halves to even; JavaScript's `Math.round`
//      rounds them up. Left alone, a parent at exactly 50% of an even child
//      count would render a different bar than the coordinator rendered
//      yesterday, and the diff would look like a content change rather than a
//      port artefact.
// ============================================================================
// epic_coordinator — CON-23's deterministic epic-progress + wave-release core.
//
// Also reused, unmodified in shape, by `.github/workflows/chore-coordinator.yml`
// for `CON-36`'s wave-release (bankai-core#807 leg 2): a chore issue's leg
// enumeration is the SAME checklist grammar an epic's child checklist already
// is (a parent issue whose body lists children by `- [ ] #<num>`, with optional
// `blocked by`/`blocks` edges), so this module is the one shared engine rather
// than a second parser. The `--citation` CLI flag (default `CON-23`) exists
// solely so the progress-bar footer cites the RIGHT rule for whichever issue
// shape it is rewriting — chore-coordinator.yml passes `CON-36`.
//
// Pure logic (no network) so it is unit-testable; the reusable workflow
// `.github/workflows/epic-coordinator.yml` wires it to `gh`. Given an epic body,
// the just-completed child, and the currently in-flight set, it:
//
//   1. flips the completed child's `- [ ]` -> `- [x]` (idempotent),
//   2. recomputes the `## Progress` bar + fraction, and
//   3. computes the next wave: unchecked children whose declared blockers are ALL
//      satisfied, not already in-flight, up to the in-flight CAP (default 3).
//
// CON-23: the canonical "child done" event is that child's completion PR merging
// into the epic's `integration/*` branch — the workflow passes that child here.
// The coordinator is the SINGLE releaser (Roy MODE B defers wave-release to it),
// so there is never a double wave.
//
// Dependency model — a child B is blocked by A when EITHER edge is declared:
//   * B's line says `blocked by #A`, OR
//   * A's line says `blocks #B`  (the inverse edge — the epic template documents
//     ordering this way, so both directions must be honored).
// A blocker is "satisfied" only if it is a KNOWN child of this epic AND checked;
// a blocker id absent from the checklist (typo / external ref) is treated as NOT
// satisfied, so an unknown id can never clear the gate.
//
// In-flight (for the cap) = children currently `bankai:stage/building` OR
// `bankai:stage/in-review` — both still occupy Roy's <=3 slots; counting only
// `building` would over-release once builders move children to review.
// ============================================================================

export const BAR_WIDTH = 12;
export const PROGRESS_HEADER = "## Progress";

const CHILD_LINE = /^(?<indent>[ \t]*)- \[(?<mark>[ xX])\] #(?<num>\d+)\b(?<rest>.*)$/;
const BLOCKED_BY = /blocked by\s+((?:#\d+[,\s]*)+)/i;
const BLOCKS = /\bblocks\s+((?:#\d+[,\s]*)+)/i;
const OWNER = /\*\*\[([A-Za-z0-9_-]+)\]\*\*/;

export interface Child {
  readonly num: number;
  readonly checked: boolean;
  readonly blockedBy: readonly number[];
  readonly blocks: readonly number[];
  readonly owner: string | null;
  readonly lineIndex: number;
}

function numbers(text: string): number[] {
  return [...text.matchAll(/#(\d+)/g)].map((match): number => Number(match[1]));
}

export function parseChildren(lines: readonly string[]): Child[] {
  const out: Child[] = [];
  lines.forEach((line, index): void => {
    const match = CHILD_LINE.exec(line);
    if (match === null || match.groups === undefined) return;
    const rest = match.groups["rest"] ?? "";
    const blockedBy = BLOCKED_BY.exec(rest);
    const blocks = BLOCKS.exec(rest);
    const owner = OWNER.exec(rest);
    out.push({
      num: Number(match.groups["num"]),
      checked: (match.groups["mark"] ?? " ").toLowerCase() === "x",
      blockedBy: blockedBy === null ? [] : numbers(blockedBy[1] ?? ""),
      blocks: blocks === null ? [] : numbers(blocks[1] ?? ""),
      owner: owner === null ? null : (owner[1] ?? "").toLowerCase(),
      lineIndex: index,
    });
  });
  return out;
}

// Half-to-even, the rule the original's language applies. See the header.
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function renderProgress(done: number, total: number, citation: string): string {
  const pct = total === 0 ? 0 : roundHalfEven((done * 100) / total);
  const filled = total === 0 ? 0 : roundHalfEven((done * BAR_WIDTH) / total);
  const bar = "▓".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  return (
    `${PROGRESS_HEADER}\n\n\`${bar}\` **${done}/${total}** · ${pct}%  \n` +
    `<sub>Auto-maintained by the ${citation} coordinator — do not hand-edit.</sub>`
  );
}

export interface WaveRelease {
  readonly child: number;
  readonly owner: string | null;
}

export interface WaveSummary {
  readonly total: number;
  readonly done: number;
  readonly release: readonly WaveRelease[];
}

export interface CoordinateResult {
  readonly body: string;
  readonly summary: WaveSummary;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function coordinate(
  body: string,
  completed: number | null,
  inflight: ReadonlySet<number>,
  cap: number,
  citation: string,
): CoordinateResult {
  const lines = body.split("\n");
  const children = parseChildren(lines);
  const byNum = new Map(children.map((child): [number, Child] => [child.num, child]));
  const checked = new Set(children.filter((child): boolean => child.checked).map((c): number => c.num));

  // 1. flip the completed child, idempotently.
  if (completed !== null && byNum.has(completed) && !checked.has(completed)) {
    const child = byNum.get(completed) as Child;
    const line = lines[child.lineIndex] ?? "";
    const match = CHILD_LINE.exec(line);
    if (match !== null && match.groups !== undefined) {
      const { indent = "", num = "", rest = "" } = match.groups;
      lines[child.lineIndex] = `${indent}- [x] #${num}${rest}`;
    }
    checked.add(completed);
  }

  const total = children.length;
  const done = children.filter((child): boolean => checked.has(child.num)).length;

  // 2. rewrite the progress block idempotently.
  const progress = renderProgress(done, total, citation);
  let joined = lines.join("\n");
  if (joined.includes(PROGRESS_HEADER)) {
    joined = joined.replace(
      new RegExp(`${escapeRegExp(PROGRESS_HEADER)}[\\s\\S]*?(?=\\n## |$)`),
      `${progress}\n`,
    );
  } else {
    joined = `${progress}\n\n${joined}`;
  }

  // 3. the full blocker set per child: its own `blocked by`, plus the inverse
  //    `blocks` edges other children declare.
  const blockers = new Map<number, Set<number>>();
  for (const child of children) blockers.set(child.num, new Set(child.blockedBy));
  for (const child of children) {
    for (const target of child.blocks) {
      const existing = blockers.get(target);
      if (existing === undefined) blockers.set(target, new Set([child.num]));
      else existing.add(child.num);
    }
  }

  const satisfied = (blocker: number): boolean => byNum.has(blocker) && checked.has(blocker);

  // 4. the next wave, in DECLARED order -- source order is the sequence the
  //    parent's author wrote, and releasing out of it would reorder work the
  //    checklist deliberately sequenced.
  const active = new Set(children.filter((child): boolean => !checked.has(child.num)).map((c): number => c.num));
  const occupied = [...inflight].filter((num): boolean => active.has(num)).length;
  let slots = Math.max(0, cap - occupied);
  const release: WaveRelease[] = [];
  for (const child of children) {
    if (slots <= 0) break;
    if (checked.has(child.num) || inflight.has(child.num)) continue;
    const set = blockers.get(child.num) ?? new Set<number>();
    if ([...set].every(satisfied)) {
      release.push({ child: child.num, owner: child.owner });
      slots -= 1;
    }
  }

  return { body: joined, summary: { total, done, release } };
}
