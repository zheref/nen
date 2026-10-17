// A bounded Myers line diff over COMPLETE base/head text. GitHub's files
// `patch` can be absent or truncated, so it is never evidence of content
// staying inside a release bound. Exhausted work is a refusal, never a pass.

export interface ChangedLine {
  readonly side: "removed" | "added";
  /** One-based line number at the corresponding commit. */
  readonly line: number;
  /** Excludes LF; preserves CR and every other byte decoded from UTF-8. */
  readonly text: string;
}

interface Edit {
  readonly change: ChangedLine;
  readonly previous: Edit | null;
}

interface State {
  readonly x: number;
  readonly edits: Edit | null;
}

const MAX_LINES = 100_000;
const MAX_WORK = 1_000_000;
const MAX_EDITS = 2048;

/** Keep LF in line identity, so changing the final newline is an edit too. */
function splitLines(text: string): readonly string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function change(side: ChangedLine["side"], index: number, text: string, previous: Edit | null): Edit {
  return { change: { side, line: index + 1, text: text.endsWith("\n") ? text.slice(0, -1) : text }, previous };
}

/** `null` means the complete diff could not be proved within the work bound. */
export function changedLines(base: string, head: string): readonly ChangedLine[] | null {
  const before = splitLines(base);
  const after = splitLines(head);
  if (before.length > MAX_LINES || after.length > MAX_LINES) return null;
  let frontier = new Map<number, State>([[1, { x: 0, edits: null }]]);
  let work = 0;
  for (let distance = 0; distance <= Math.min(before.length + after.length, MAX_EDITS); distance++) {
    const next = new Map<number, State>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++work > MAX_WORK) return null;
      const down = frontier.get(diagonal + 1);
      const right = frontier.get(diagonal - 1);
      const insert = diagonal === -distance || (diagonal !== distance && (right?.x ?? -1) < (down?.x ?? -1));
      const prior = insert ? down : right;
      if (prior === undefined) continue;
      let x = prior.x + (insert ? 0 : 1);
      let y = x - diagonal;
      if (x > before.length || y > after.length || x < 0 || y < 0) continue;
      let edits = prior.edits;
      if (distance > 0) {
        edits = insert
          ? change("added", y - 1, after[y - 1] as string, edits)
          : change("removed", x - 1, before[x - 1] as string, edits);
      }
      while (x < before.length && y < after.length && before[x] === after[y]) {
        if (++work > MAX_WORK) return null;
        x++;
        y++;
      }
      if (x === before.length && y === after.length) {
        const out: ChangedLine[] = [];
        for (let edit = edits; edit !== null; edit = edit.previous) out.push(edit.change);
        return out.reverse();
      }
      next.set(diagonal, { x, edits });
    }
    frontier = next;
  }
  return null;
}
