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
// THREE DELIBERATE DEVIATIONS FROM THE ORIGINAL, each named here rather than
// silently applied:
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
//   3. THE CHECKLIST GRAMMAR IS WIDER THAN THE ORIGINAL'S, AND UNREADABLE
//      CHECKBOXES ARE SURFACED (zheref/nen#51). The Python recognized only the
//      literal `- [ ] #<num> ...` line; real, historical epic bodies in the
//      repositories this convention was ported FROM put the reference at the
//      end of the line or inside a markdown link, and every such body read as
//      `{total:0, done:0}` with no error. Here any `- [ ]`/`- [x]` line is a
//      checkbox; its FIRST child reference (bare `#N`, `[#N](url)`, or an
//      `/issues/N` link) identifies the child; a checkbox with NO resolvable
//      reference is counted into `unparsed` and reported, and a body that is
//      ALL unresolvable checkboxes is refused outright.
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

// CHECKBOX_LINE recognizes the checkbox SHAPE only -- `- [ ]` / `- [x]`, any
// indent -- and leaves finding the child reference to firstChildRef below.
// This is the zheref/nen#51 fix: the port's original regex demanded the bare
// `#<num>` IMMEDIATELY after the checkbox, so every real-world variant --
// `- [ ] Phase 0a — #101` (trailing reference), `- [ ] **Child 1** [#570](url)`
// (markdown link) -- was not merely unparsed but INVISIBLE, and a two-child
// checklist read as `{total:0, done:0}` with no error: the silent-wrong-result
// shape triage weighs highest. Splitting "is this a checkbox line?" from "which
// child does it name?" is what lets a checkbox with NO resolvable reference be
// COUNTED and surfaced (`unparsed`) instead of skipped.
//
// `rest` deliberately captures the separator with the remainder so a flip can
// reassemble `${indent}- [x]${rest}` and reproduce the author's line VERBATIM
// -- the old flip re-serialized `#${num}${rest}`, which only round-trips for
// the one line shape it parsed.
const CHECKBOX_LINE = /^(?<indent>[ \t]*)- \[(?<mark>[ xX])\](?<rest>(?:[ \t].*)?)$/;
const BLOCKED_BY = /blocked by\s+((?:#\d+[,\s]*)+)/i;
const BLOCKS = /\bblocks\s+((?:#\d+[,\s]*)+)/i;
const OWNER = /\*\*\[([A-Za-z0-9_-]+)\]\*\*/;

// A bare `#123`. The `(?<!&)` guard exists because HTML entities are legal in
// issue bodies -- `&#8212;` is an em-dash -- and without it an entity's numeric
// payload would parse as a child id, which is exactly the class of silent
// misread #51 is about. `\b` after the digits keeps `#12abc` from reading as 12.
const BARE_REF = /(?<!&)#(\d+)\b/g;
// A markdown link `[text](url)`. Adjacency of `](` is required, so an owner
// tag `**[alice]**` followed by a parenthetical never reads as a link.
const MARKDOWN_LINK = /\[(?<text>[^\]]*)\]\((?<url>[^)]*)\)/g;
// An issue URL's number. The lookahead stops `/issues/570#issuecomment-1` and
// `/issues/570?foo` from bleeding extra characters, while `/issues/5701` still
// reads whole. `/pull/` is deliberately NOT accepted: a child is an issue, and
// a PR link on the line is commentary, not identity.
const ISSUE_URL = /\/issues\/(\d+)(?=$|[^0-9])/;

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

// The FIRST child reference on a checkbox line's remainder, or null when the
// line carries none. "First" is by POSITION, because a checklist line names its
// own issue before it says anything else about it -- and three shapes count:
//
//   * a bare `#123` anywhere (`Phase 0a — #101` trails its reference),
//   * a markdown link whose TEXT names the issue (`[#570](any-url)`),
//   * a markdown link whose URL is an `/issues/123` path even when the link
//     text says something else entirely (`[the auth leg](.../issues/571)`).
//
// Two exclusions keep "first" from lying:
//
//   * a bare ref INSIDE a link's span never competes on its own -- the link
//     resolves (or refuses) as a unit, so `[note](https://x.com/a#123)` does
//     not smuggle 123 in as a child id via its fragment;
//   * a ref inside a `blocked by #N` / `blocks #N` clause is an EDGE, not the
//     line's identity -- `- [ ] mystery blocked by #1` must surface as
//     unparsed rather than claim to BE child #1, or the dependency graph
//     would gain a phantom node that shadows the real #1.
function firstChildRef(rest: string): number | null {
  const candidates: { index: number; num: number }[] = [];
  const spans: [number, number][] = [];

  for (const link of rest.matchAll(MARKDOWN_LINK)) {
    const start = link.index ?? 0;
    spans.push([start, start + link[0].length]);
    const text = link.groups?.["text"] ?? "";
    const url = link.groups?.["url"] ?? "";
    const textRef = /(?<!&)#(\d+)\b/.exec(text);
    if (textRef !== null) {
      candidates.push({ index: start, num: Number(textRef[1]) });
      continue;
    }
    const urlRef = ISSUE_URL.exec(url);
    if (urlRef !== null) candidates.push({ index: start, num: Number(urlRef[1]) });
  }

  const blockedBy = BLOCKED_BY.exec(rest);
  if (blockedBy !== null) spans.push([blockedBy.index, blockedBy.index + blockedBy[0].length]);
  const blocks = BLOCKS.exec(rest);
  if (blocks !== null) spans.push([blocks.index, blocks.index + blocks[0].length]);

  for (const bare of rest.matchAll(BARE_REF)) {
    const index = bare.index ?? 0;
    if (spans.some(([from, to]): boolean => index >= from && index < to)) continue;
    candidates.push({ index, num: Number(bare[1]) });
  }

  const first = candidates.sort((a, b): number => a.index - b.index)[0];
  return first === undefined ? null : first.num;
}

// A checkbox line whose remainder resolved to NO child reference. Surfaced --
// never silently skipped -- because `{total:0, done:0}` from a body full of
// checkboxes the parser could not read is indistinguishable from a genuinely
// empty checklist, and a caller acting on the empty reading would conclude
// "nothing is ready" when the truth is "I could not see the children" (#51).
// `line` is 1-BASED: it names a line in the file a human will open.
export interface UnparsedCheckbox {
  readonly line: number;
  readonly text: string;
}

export interface ChecklistParse {
  readonly children: readonly Child[];
  readonly unparsed: readonly UnparsedCheckbox[];
}

export function parseChildren(lines: readonly string[]): ChecklistParse {
  const children: Child[] = [];
  const unparsed: UnparsedCheckbox[] = [];
  lines.forEach((line, index): void => {
    const match = CHECKBOX_LINE.exec(line);
    if (match === null || match.groups === undefined) return;
    const rest = match.groups["rest"] ?? "";
    const num = firstChildRef(rest);
    if (num === null) {
      unparsed.push({ line: index + 1, text: line.trim() });
      return;
    }
    const blockedBy = BLOCKED_BY.exec(rest);
    const blocks = BLOCKS.exec(rest);
    const owner = OWNER.exec(rest);
    children.push({
      num,
      checked: (match.groups["mark"] ?? " ").toLowerCase() === "x",
      blockedBy: blockedBy === null ? [] : numbers(blockedBy[1] ?? ""),
      blocks: blocks === null ? [] : numbers(blocks[1] ?? ""),
      owner: owner === null ? null : (owner[1] ?? "").toLowerCase(),
      lineIndex: index,
    });
  });
  return { children, unparsed };
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
  // Checkbox lines that resolved to no child reference. ALWAYS present in the
  // summary -- an empty array is itself the attestation "nothing was skipped",
  // which is what makes a genuine `{total:0, done:0}` trustworthy (#51).
  readonly unparsed: readonly UnparsedCheckbox[];
}

export interface CoordinateResult {
  readonly body: string;
  readonly summary: WaveSummary;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A checklist ID that appears MORE THAN ONCE in the body -- `- [x] #5` and
// `- [ ] #5` both present -- is an ordinary hand-editing typo, and it is a
// DEVIATION from the original: the Python tracks `checked` per Child OBJECT
// (`by_num[b].checked`, last-wins over duplicates by dict-comprehension
// order), while a union-of-numbers Set (the natural TS translation) makes
// EITHER duplicate checking mark the id done -- so the two implementations
// would compute a different `done` count and a different `satisfied()`
// verdict for the exact same body, without either one being wrong on its
// own terms. Rather than pick a silent tie-break, a duplicate is refused: a
// wave computed against an ambiguous checklist could release a child whose
// blocker is not actually done.
// A body whose checkbox lines are ALL unresolvable is refused outright rather
// than summarized as `{total:0, done:0}`. The distinction from the mixed case
// (some children parse, some checkboxes do not -- reported as a warning, exit
// 0) is deliberate: one resolvable child means the checklist speaks this
// verb's convention and the leftovers are plausibly ordinary task items
// ("- [ ] write the docs"); ZERO resolvable children over one-or-more
// checkboxes means the whole body is authored in a convention the parser does
// not read, and a 0/0 progress bar or an empty wave computed from it -- let
// alone WRITTEN back over the body via --out -- would be the silent wrong
// result #51 triages highest.
export class UnparsableChecklistError extends Error {
  readonly unparsed: readonly UnparsedCheckbox[];
  constructor(unparsed: readonly UnparsedCheckbox[]) {
    super(
      `the body has ${unparsed.length} checkbox line(s) but none carries a resolvable child reference -- refusing to report an empty checklist for a body this verb cannot read. A child line must name its issue as a bare '#123' anywhere on the line, a '[#123](...)' markdown link, or a link to an '/issues/123' URL (first reference wins). Fix the checklist -- or, if these truly are not children, remove their checkboxes. Unreadable line(s): ${unparsed
        .map((entry): string => `${entry.line}: ${entry.text}`)
        .join("; ")}`,
    );
    this.name = "UnparsableChecklistError";
    this.unparsed = unparsed;
  }
}

export class DuplicateChildIdError extends Error {
  readonly duplicates: readonly number[];
  constructor(duplicates: readonly number[]) {
    super(
      `duplicate child checklist id(s): ${duplicates.map((n): string => `#${n}`).join(", ")} -- each child must appear in the checklist exactly once. A duplicated id is an authoring error this coordinator refuses to guess past, because which line is authoritative changes both the done-count and which blockers read as satisfied.`,
    );
    this.name = "DuplicateChildIdError";
    this.duplicates = duplicates;
  }
}

export function coordinate(
  body: string,
  completed: number | null,
  inflight: ReadonlySet<number>,
  cap: number,
  citation: string,
): CoordinateResult {
  const lines = body.split("\n");
  const { children, unparsed } = parseChildren(lines);
  if (children.length === 0 && unparsed.length > 0) throw new UnparsableChecklistError(unparsed);

  const counts = new Map<number, number>();
  for (const child of children) counts.set(child.num, (counts.get(child.num) ?? 0) + 1);
  const duplicates = [...counts.entries()]
    .filter(([, count]): boolean => count > 1)
    .map(([num]): number => num)
    .sort((a, b): number => a - b);
  if (duplicates.length > 0) throw new DuplicateChildIdError(duplicates);

  const byNum = new Map(children.map((child): [number, Child] => [child.num, child]));
  const checked = new Set(children.filter((child): boolean => child.checked).map((c): number => c.num));

  // 1. flip the completed child, idempotently. Only the mark changes:
  //    `${indent}- [x]${rest}` reassembles the author's remainder VERBATIM,
  //    which is what keeps a trailing-reference or markdown-link line intact
  //    through a flip -- re-serializing `#${num}` here (the old shape) would
  //    have rewritten `- [ ] **Child 1** [#570](url)` as `- [x] #570...`.
  if (completed !== null && byNum.has(completed) && !checked.has(completed)) {
    const child = byNum.get(completed) as Child;
    const line = lines[child.lineIndex] ?? "";
    const match = CHECKBOX_LINE.exec(line);
    if (match !== null && match.groups !== undefined) {
      const { indent = "", rest = "" } = match.groups;
      lines[child.lineIndex] = `${indent}- [x]${rest}`;
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

  return { body: joined, summary: { total, done, release, unparsed } };
}
