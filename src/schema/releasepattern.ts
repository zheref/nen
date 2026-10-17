// The release-line language is deliberately smaller than JavaScript RegExp.
// Compile once to a bounded Thompson NFA; never backtrack on PR blob text.
// No native regular expression in this module consumes a subject string.
//
// At each UTF-16 input boundary, one shared visited set closes ALL incoming
// epsilon edges. Each state is visited at most once at that boundary, including
// nullable cycles. For L code units, M states and R class intervals, matching
// costs O((L + 1) M (1 + log R)) and O(M) auxiliary memory. Explicit work limits
// refuse larger computations; they are not wall-clock timing promises.

export const RELEASE_PATTERN_LIMITS = {
  source: 4096,
  nesting: 64,
  states: 1024,
  classIntervals: 256,
  patterns: 64,
  entryStates: 16_384,
  lineLength: 65_536,
  lineWork: 1_000_000,
  fileWork: 8_000_000,
} as const;

type Range = readonly [number, number];
interface CharacterSet { readonly ranges: readonly Range[]; readonly negated: boolean }
type Node =
  | { readonly kind: "set"; readonly set: CharacterSet; readonly cost: number }
  | { readonly kind: "sequence" | "alternative"; readonly children: readonly Node[]; readonly cost: number }
  | { readonly kind: "repeat"; readonly child: Node; readonly min: number; readonly max: number | null; readonly cost: number };

function refuse(reason: string): never { throw new Error(reason); }
function checked(node: Node): Node {
  // Reserve one state for accept. This is checked BEFORE repeat expansion.
  if (node.cost >= RELEASE_PATTERN_LIMITS.states) refuse(`compiled state limit (${RELEASE_PATTERN_LIMITS.states}) exceeded`);
  return node;
}
function sequence(children: readonly Node[]): Node {
  return checked({ kind: "sequence", children, cost: Math.max(1, children.reduce((sum, child): number => sum + child.cost, 0)) });
}
function alternative(children: readonly Node[]): Node {
  return children.length === 1 ? children[0] as Node : checked({ kind: "alternative", children, cost: children.reduce((sum, child): number => sum + child.cost, 0) + children.length - 1 });
}
function repetition(child: Node, min: number, max: number | null): Node {
  const copies = max ?? Math.max(1, min);
  const cost = copies === 0 ? 1 : copies * child.cost + (max === null ? 1 : max - min);
  return checked({ kind: "repeat", child, min, max, cost });
}

const DIGITS: readonly Range[] = [[48, 57]];
const WORD: readonly Range[] = [[48, 57], [65, 90], [95, 95], [97, 122]];
const DOT_EXCLUSIONS: readonly Range[] = [[10, 10], [13, 13], [0x2028, 0x2029]];

function normalized(ranges: readonly Range[]): readonly Range[] {
  if (ranges.length > RELEASE_PATTERN_LIMITS.classIntervals) refuse(`character-class interval limit (${RELEASE_PATTERN_LIMITS.classIntervals}) exceeded`);
  const sorted = ranges.slice().sort((a, b): number => a[0] - b[0]);
  const result: [number, number][] = [];
  for (const [low, high] of sorted) {
    const last = result[result.length - 1];
    if (last !== undefined && low <= last[1] + 1) last[1] = Math.max(last[1], high);
    else result.push([low, high]);
  }
  return result;
}
function complement(ranges: readonly Range[]): readonly Range[] {
  const result: Range[] = [];
  let low = 0;
  for (const [start, end] of ranges) {
    if (low < start) result.push([low, start - 1]);
    low = end + 1;
  }
  if (low <= 0xffff) result.push([low, 0xffff]);
  return result;
}

/** An iterative parser; group depth and all emitted-state costs are bounded. */
function parse(source: string): Node {
  if (source.length > RELEASE_PATTERN_LIMITS.source) refuse(`source length limit (${RELEASE_PATTERN_LIMITS.source} UTF-16 code units) exceeded`);
  if (source.length === 0) refuse("empty source; write '^$' for an empty line");
  let index = 0;
  const literal = (code: number): CharacterSet => ({ ranges: [[code, code]], negated: false });
  const hex = (count: number): number => {
    let value = 0;
    for (let n = 0; n < count; n++) {
      const digit = "0123456789abcdef".indexOf((source[index++] ?? "").toLowerCase());
      if (digit < 0 || source[index - 1] === undefined) refuse("hexadecimal escape needs exactly the declared number of digits");
      value = value * 16 + digit;
    }
    return value;
  };
  const escape = (): CharacterSet => {
    const char = source[index++];
    if (char === undefined) return refuse("unfinished escape");
    if ("^$\\.*+?()[]{}|/-".includes(char)) return literal(char.charCodeAt(0));
    const controls: Readonly<Record<string, number>> = { t: 9, n: 10, r: 13, f: 12, v: 11 };
    const control = controls[char];
    if (control !== undefined) return literal(control);
    if (char === "x") return literal(hex(2));
    if (char === "u") return literal(hex(4));
    if (char === "d" || char === "D") return { ranges: DIGITS, negated: char === "D" };
    if (char === "w" || char === "W") return { ranges: WORD, negated: char === "W" };
    return refuse(`unsupported escape '\\${char}' (no backreferences, assertions, property or identity escapes)`);
  };
  const classTerm = (): CharacterSet => {
    const char = source[index++];
    if (char === undefined) return refuse("unfinished character class");
    if (char === "\\") return escape();
    if (char === "[") return refuse("escape '[' inside a character class");
    return literal(char.charCodeAt(0));
  };
  const single = (set: CharacterSet): number | null => {
    const range = set.ranges[0];
    return !set.negated && set.ranges.length === 1 && range !== undefined && range[0] === range[1] ? range[0] : null;
  };
  const characterClass = (): CharacterSet => {
    const negated = source[index] === "^";
    if (negated) index++;
    const ranges: Range[] = [];
    while (index < source.length && source[index] !== "]") {
      const left = classTerm();
      if (source[index] === "-" && source[index + 1] !== "]" && source[index + 1] !== undefined) {
        index++;
        const right = classTerm();
        const low = single(left);
        const high = single(right);
        if (low === null || high === null || low > high) refuse("a class range needs two ordered literal endpoints");
        ranges.push([low, high]);
      } else ranges.push(...(left.negated ? complement(left.ranges) : left.ranges));
      if (ranges.length > RELEASE_PATTERN_LIMITS.classIntervals) refuse(`character-class interval limit (${RELEASE_PATTERN_LIMITS.classIntervals}) exceeded`);
    }
    if (source[index++] !== "]") refuse("unfinished character class");
    if (ranges.length === 0) refuse("empty character classes are not supported");
    return { ranges: normalized(ranges), negated };
  };
  const integer = (): number => {
    const start = index;
    let value = 0;
    while (index < source.length) {
      const digit = source.charCodeAt(index) - 48;
      if (digit < 0 || digit > 9) break;
      value = value * 10 + digit;
      if (value > RELEASE_PATTERN_LIMITS.states) refuse(`repeat bound exceeds the compiled state limit (${RELEASE_PATTERN_LIMITS.states})`);
      index++;
    }
    if (index === start) refuse("a repeat bound needs decimal digits");
    return value;
  };
  interface Atom { node: Node; repeated: boolean }
  interface Frame { branches: Node[]; atoms: Atom[] }
  const frames: Frame[] = [{ branches: [], atoms: [] }];
  const current = (): Frame => frames[frames.length - 1] as Frame;
  const branch = (frame: Frame): Node => sequence(frame.atoms.map((atom): Node => atom.node));
  const push = (node: Node): void => { current().atoms.push({ node, repeated: false }); };
  while (index < source.length) {
    const at = index;
    const char = source[index++] as string;
    if (char === "^") {
      if (at !== 0) refuse("'^' is supported only at the start of the whole pattern");
      continue;
    }
    if (char === "$") {
      if (index !== source.length || frames.length !== 1) refuse("'$' is supported only at the end of the whole pattern");
      continue;
    }
    if (char === "(") {
      if (source[index] === "?") {
        if (source[index + 1] !== ":") refuse("only ordinary and '(?:...)' groups are supported; no lookaround, named groups or inline flags");
        index += 2;
      }
      if (frames.length > RELEASE_PATTERN_LIMITS.nesting) refuse(`group nesting limit (${RELEASE_PATTERN_LIMITS.nesting}) exceeded`);
      frames.push({ branches: [], atoms: [] });
      continue;
    }
    if (char === ")") {
      if (frames.length === 1) refuse("unmatched ')'");
      const frame = frames.pop() as Frame;
      push(alternative([...frame.branches, branch(frame)]));
      continue;
    }
    if (char === "|") {
      const frame = current();
      frame.branches.push(branch(frame));
      frame.atoms = [];
      continue;
    }
    if (char === "?" || char === "*" || char === "+" || char === "{") {
      const atom = current().atoms[current().atoms.length - 1];
      if (atom === undefined || atom.repeated) refuse("a quantifier needs one unquantified atom; lazy or repeated quantifiers are not supported");
      let min = char === "+" ? 1 : 0;
      let max: number | null = char === "?" ? 1 : null;
      if (char === "{") {
        min = integer();
        max = min;
        if (source[index] === ",") {
          index++;
          max = source[index] === "}" ? null : integer();
        }
        if (source[index++] !== "}" || (max !== null && min > max)) refuse("invalid counted repetition");
      }
      atom.node = repetition(atom.node, min, max);
      atom.repeated = true;
      continue;
    }
    if (char === "]" || char === "}") refuse(`escape literal '${char}'`);
    const set = char === "\\" ? escape() : char === "[" ? characterClass() : char === "." ? { ranges: DOT_EXCLUSIONS, negated: true } : literal(char.charCodeAt(0));
    push({ kind: "set", set, cost: 1 });
  }
  if (frames.length !== 1) refuse("unfinished group");
  const frame = current();
  return alternative([...frame.branches, branch(frame)]);
}

type State =
  | { kind: "consume"; set: CharacterSet; out: number }
  | { kind: "jump"; out: number }
  | { kind: "split"; out: number; other: number }
  | { kind: "accept" };
interface Patch { readonly state: number; readonly edge: "out" | "other" }
interface Fragment { readonly start: number; readonly outs: readonly Patch[] }

function compile(node: Node): { states: readonly State[]; start: number } {
  const states: State[] = [];
  const emit = (state: State): number => {
    if (states.length >= RELEASE_PATTERN_LIMITS.states) refuse(`compiled state limit (${RELEASE_PATTERN_LIMITS.states}) exceeded`);
    states.push(state);
    return states.length - 1;
  };
  const patch = (outs: readonly Patch[], destination: number): void => {
    for (const { state, edge } of outs) {
      const item = states[state] as State;
      if (edge === "other" && item.kind === "split") item.other = destination;
      else if (edge === "out" && item.kind !== "accept") item.out = destination;
      else refuse("invalid compiled edge");
    }
  };
  const empty = (): Fragment => {
    const start = emit({ kind: "jump", out: -1 });
    return { start, outs: [{ state: start, edge: "out" }] };
  };
  const join = (parts: readonly Fragment[]): Fragment => {
    if (parts.length === 0) return empty();
    let result = parts[0] as Fragment;
    for (const part of parts.slice(1)) {
      patch(result.outs, part.start);
      result = { start: result.start, outs: part.outs };
    }
    return result;
  };
  const optional = (part: Fragment): Fragment => {
    const start = emit({ kind: "split", out: part.start, other: -1 });
    return { start, outs: [...part.outs, { state: start, edge: "other" }] };
  };
  const loop = (part: Fragment, min: number): Fragment => {
    const split = emit({ kind: "split", out: part.start, other: -1 });
    patch(part.outs, split);
    return { start: min === 0 ? split : part.start, outs: [{ state: split, edge: "other" }] };
  };
  type Task = { kind: "node"; node: Node } | { kind: "combine"; node: Exclude<Node, { kind: "set" }>; count: number };
  const tasks: Task[] = [{ kind: "node", node }];
  const results: Fragment[] = [];
  while (tasks.length > 0) {
    const task = tasks.pop() as Task;
    const item = task.node;
    if (task.kind === "node") {
      if (item.kind === "set") {
        const start = emit({ kind: "consume", set: item.set, out: -1 });
        results.push({ start, outs: [{ state: start, edge: "out" }] });
      } else {
        const children = item.kind === "repeat" ? Array<Node>(item.max ?? Math.max(1, item.min)).fill(item.child) : item.children;
        tasks.push({ kind: "combine", node: item, count: children.length });
        for (let i = children.length - 1; i >= 0; i--) tasks.push({ kind: "node", node: children[i] as Node });
      }
      continue;
    }
    const parts = results.splice(results.length - task.count, task.count);
    if (item.kind === "sequence") results.push(join(parts));
    else if (item.kind === "alternative") {
      let result = parts[0] as Fragment;
      for (const part of parts.slice(1)) result = { start: emit({ kind: "split", out: result.start, other: part.start }), outs: [...result.outs, ...part.outs] };
      results.push(result);
    } else if (item.kind === "repeat") {
      if (item.max === null) {
        const last = parts[parts.length - 1] as Fragment;
        results.push(join([...parts.slice(0, -1), loop(last, item.min === 0 ? 0 : 1)]));
      } else results.push(join(parts.map((part, index): Fragment => index < item.min ? part : optional(part))));
    }
  }
  const result = results[0] as Fragment;
  patch(result.outs, emit({ kind: "accept" }));
  return { states, start: result.start };
}

export type ReleaseLineMatch =
  | { readonly kind: "match" | "no-match"; readonly work: number }
  | { readonly kind: "exhausted"; readonly work: number; readonly reason: "line-length" | "work" };
export interface ReleaseLineMatcher {
  readonly stateCount: number;
  match(subject: string, maxWork?: number): ReleaseLineMatch;
}

export function compileReleaseLinePattern(source: string): ReleaseLineMatcher {
  const { states, start } = compile(parse(source));
  return {
    stateCount: states.length,
    match(subject, maxWork = RELEASE_PATTERN_LIMITS.lineWork): ReleaseLineMatch {
      if (subject.length > RELEASE_PATTERN_LIMITS.lineLength) return { kind: "exhausted", work: 0, reason: "line-length" };
      const limit = Number.isFinite(maxWork) ? Math.min(RELEASE_PATTERN_LIMITS.lineWork, Math.max(0, Math.floor(maxWork))) : 0;
      let work = 0;
      const tick = (): boolean => {
        if (work >= limit) return false;
        work++;
        return true;
      };
      const exhausted = (): ReleaseLineMatch => ({ kind: "exhausted", work, reason: "work" });
      // Fresh arrays per match; none of this mutable state survives a call.
      const seen = new Uint32Array(states.length);
      let generation = 0;
      const closure = (seeds: readonly number[]): number[] | null => {
        generation++;
        const pending: number[] = [];
        const active: number[] = [];
        const add = (id: number): boolean => {
          if (!tick()) return false;
          if (seen[id] !== generation) { seen[id] = generation; pending.push(id); }
          return true;
        };
        for (const id of seeds) if (!add(id)) return null;
        while (pending.length > 0) {
          if (!tick()) return null;
          const id = pending.pop() as number;
          const state = states[id] as State;
          if (state.kind === "jump") { if (!add(state.out)) return null; }
          else if (state.kind === "split") { if (!add(state.out) || !add(state.other)) return null; }
          else active.push(id);
        }
        return active;
      };
      let active = closure([start]);
      if (active === null) return exhausted();
      for (let index = 0; index < subject.length; index++) {
        if (!tick()) return exhausted();
        const code = subject.charCodeAt(index);
        const seeds: number[] = [];
        for (const id of active) {
          if (!tick()) return exhausted();
          const state = states[id] as State;
          if (state.kind !== "consume") continue;
          let low = 0;
          let high = state.set.ranges.length - 1;
          let included = false;
          while (low <= high) {
            if (!tick()) return exhausted();
            const middle = Math.floor((low + high) / 2);
            const range = state.set.ranges[middle] as Range;
            if (code < range[0]) high = middle - 1;
            else if (code > range[1]) low = middle + 1;
            else { included = true; break; }
          }
          if (included !== state.set.negated) seeds.push(state.out);
        }
        if (seeds.length === 0) return { kind: "no-match", work };
        active = closure(seeds);
        if (active === null) return exhausted();
      }
      for (const id of active) {
        if (!tick()) return exhausted();
        if (states[id]?.kind === "accept") return { kind: "match", work };
      }
      return { kind: "no-match", work };
    },
  };
}
