// src/schema/pattern.ts -- the ONE guard on a regular expression that arrives as
// DATA and is then run against a string that arrives off the NETWORK.
//
// WHY THIS FILE EXISTS (zheref/nen#8 item 3, and zheref/nen#6 item 2 -- the SAME
// code path, filed twice from two different reviews).
//
// `../schema/gates.ts` compiles five patterns out of the target repository's
// `schemas/gates.json` (`login_pattern`, `review_check_pattern`,
// `round_check_pattern`, `enrolment_check_pattern`, `delivery.author_pattern`)
// and the readiness gate then runs them against strings GitHub hands back:
// a pull request author's login, a reviewer's login, a check-run name. The
// loader validated that a pattern COMPILES. It never validated that it
// TERMINATES. Measured in this runtime before the guard landed:
//
//   new RegExp("(a+)+$", "i").test("a".repeat(30) + "!")   ~300ms
//
// -- exponential in the subject's length, so a 39-character login (GitHub's own
// documented maximum for a username) is 2**39 steps: not slow, unbounded. A
// readiness gate that hangs is a readiness gate that reports nothing, and the
// one string in that list a stranger chooses for themselves is their own login.
//
// ── WHY A LENGTH CAP IS NOT THE GUARD ───────────────────────────────────────
//
// The obvious alternative -- cap the length of the string being tested -- was
// considered and REJECTED, on arithmetic. The cap would have to sit at or above
// the longest legitimate subject (39 characters for a login; a check-run name is
// longer still), and 2**39 is not a bound any operator would wait out. A cap
// tight enough to actually bound an exponential matcher would have to be around
// 20 characters, which is shorter than real logins and real check names, so it
// would change verdicts on ordinary input. A cap also has to be applied at every
// call site that runs a pattern -- five fields across three modules today
// (`../gates/predicates.ts`, `../gates/ready.ts`, `../github/pr_state.ts`) --
// and the next call site somebody adds is the one that forgets it.
//
// So the guard is a REFUSAL AT LOAD, at the single seam where a data-sourced
// pattern is compiled. It is loud, it is actionable, it names the field, and --
// the property that matters most for a gate -- it changes NO verdict: a pattern
// either loads and behaves exactly as it always did, or the file is refused
// before any pull request is judged. A guard that could silently answer "no
// match" where the pattern would have said "match" is a guard that can OPEN a
// readiness gate, and this repository does not ship one of those.
//
// ── WHAT IS REFUSED, AND WHAT THAT DOES NOT CLAIM ───────────────────────────
//
// `catastrophicShape` refuses an UNBOUNDED quantifier (`*`, `+`, `{n,}`) applied
// to a GROUP whose body can itself match one string in more than one way -- that
// is, a body containing an alternation or any variable repetition. That is the
// classic exponential family and it covers both spellings the literature names:
//
//   (a+)+$        nested quantifier
//   (a|a)+$       quantified alternation with overlapping branches
//
// It is deliberately BROADER than "nested quantifier" alone, because `(a|a)+` is
// exactly as exponential and a guard that caught only the first spelling would
// be a guard the second walks past. It is a SHAPE test, not a proof: it is
// conservative in the safe direction (it can refuse a pattern that would in fact
// have run in linear time, e.g. `(a|b)+`, whose branches do not overlap), and it
// makes no claim to catch every pathological regular expression that exists.
// What it does claim is that the shapes an operator writes by accident, and the
// two shapes the two filings name by example, do not load.
//
// A refused pattern is always rewritable, and the message says how: the
// character class `[ab]+` for `(a|b)+`, the single quantifier `a+` for `(a+)+`.
//
// ── AND A PATTERN THAT MATCHES THE EMPTY STRING IS REFUSED TOO ──────────────
//
// zheref/nen#6 item 2 asks the question and this is the answer: YES, refused.
// Every one of these five patterns is applied with an UNANCHORED `.test(...)`,
// so a pattern that matches the empty string matches EVERY subject -- there is
// always an empty match at offset 0. `".*"`, `"a*"` and `"x?"` are therefore not
// broad patterns, they are the constant `true`, and the constant `true` in any
// of the five fields is a silent widening:
//
//   login_pattern            every review counts as that reviewer's, so any
//                            login on earth can satisfy their round and join
//                            the approval set.
//   review_check_pattern     every check is that reviewer's review job, so a
//                            delivery-PR abstain is satisfied by an unrelated
//                            green check.
//   round_check_pattern      every check clears the round, so a round nobody
//                            posted reads as owed-to-nobody.
//   enrolment_check_pattern  every pull request enrols the reviewer.
//   delivery.author_pattern  every pull request is a delivery PR, so the CON-40
//                            carve-out is always available.
//
// Four of those five open the gate. "Matches everything" can never be what a
// reviewer IDENTITY means -- an identity that identifies everyone identifies
// nobody -- so it is refused rather than documented. This is a FLOOR, not a
// completeness claim: `".+"` still matches every non-empty subject and still
// loads, because refusing it would require guessing at intent rather than
// reading a property. The header of `./gates.ts` carries the `.*`-hazard note
// for all five fields for exactly that residue.
//
// ── WHERE THIS IS APPLIED, AND WHERE IT IS NOT ──────────────────────────────
//
// The line is: a pattern that comes from DATA and is tested against a GitHub
// LOGIN or CHECK NAME goes through here. That is `./gates.ts`'s five fields,
// `../verbs/pr_ready.ts`'s `safePattern` (which compiles a `--reviewers` name and
// tests it against review authors), and `../wake/command.ts`'s
// `--author-pattern` (compiled from a flag, tested against `pr.user.login`).
// The other data-sourced `new RegExp` sites in this tree -- `../pr/bodycheck.ts`,
// `../watch/command.ts`, `../canon/command.ts`, `../gate/derive.ts`,
// `../changelog/fragment.ts` -- test against file paths and text read from local
// files, which is the same operator supplying both halves, and they are left
// alone rather than swept up: widening this guard's blast radius on a hardening
// change is how a hardening change acquires a regression.

/** What a refused pattern is refused FOR, with the fragment that did it. */
export interface PatternHazard {
  /** The offending sub-expression, quoted back so the author can find it. */
  readonly fragment: string;
  /** One clause, appended to the loader's own message. */
  readonly why: string;
}

interface Quantifier {
  /** Index one past the quantifier (including a trailing lazy `?`). */
  readonly end: number;
  /** `*`, `+`, `{n,}` -- can iterate without limit. */
  readonly unbounded: boolean;
  /** Anything that can consume its body a varying number of times. */
  readonly variable: boolean;
}

const BRACE = /^\{(\d+)(,(\d*))?\}/;

/**
 * The quantifier starting at `index`, or `null` when there is none there.
 *
 * `{2}` is a quantifier but NOT a variable one: it consumes its body exactly
 * twice, which multiplies the work by a constant and cannot compound.
 */
function quantifierAt(source: string, index: number): Quantifier | null {
  const char = source[index];
  if (char === undefined) return null;
  const lazy = (end: number): number => (source[end] === "?" ? end + 1 : end);
  if (char === "*" || char === "+") {
    return { end: lazy(index + 1), unbounded: true, variable: true };
  }
  if (char === "?") {
    return { end: lazy(index + 1), unbounded: false, variable: true };
  }
  if (char !== "{") return null;
  const match = BRACE.exec(source.slice(index));
  if (match === null) return null;
  const comma = match[2] !== undefined;
  const upper = match[3] ?? "";
  return {
    end: lazy(index + match[0].length),
    unbounded: comma && upper === "",
    variable: comma,
  };
}

/** One open `(` while the scanner walks the source. */
interface Frame {
  /** Index of this group's `(`, so a refusal can quote the whole thing. */
  readonly start: number;
  /**
   * The body contains an alternation or a variable repetition -- i.e. it can
   * match one string in more than one way, which is the half of a catastrophic
   * shape that lives INSIDE the quantified group.
   */
  ambiguous: boolean;
}

/**
 * The catastrophic sub-expression in `source`, or `null` when there is none.
 *
 * A pure SOURCE scan: it never compiles and never runs anything, so calling it on
 * a hostile string costs the string's length and nothing else. Escapes (`\+`)
 * and character classes (`[+*]`) are tracked, because a `+` inside either is a
 * literal and flagging it would refuse ordinary patterns.
 */
export function catastrophicShape(source: string): PatternHazard | null {
  // Index 0 is the top level, which is never quantified -- it exists so the
  // scanner always has a frame to mark and never has to special-case depth 0.
  const stack: Frame[] = [{ start: 0, ambiguous: false }];
  const current = (): Frame => stack[stack.length - 1] as Frame;
  let index = 0;

  while (index < source.length) {
    const char = source[index] ?? "";

    // A backslash always consumes the next character, whatever it is. Checked
    // FIRST so `\(`, `\[` and `\+` can never be read as structure.
    if (char === "\\") {
      index += 2;
      continue;
    }

    // Inside a character class every metacharacter is a literal.
    if (char === "[") {
      index += 1;
      while (index < source.length && source[index] !== "]") {
        index += source[index] === "\\" ? 2 : 1;
      }
      index += 1;
      continue;
    }

    if (char === "(") {
      stack.push({ start: index, ambiguous: false });
      // The group PREFIX is skipped rather than scanned: the `?` of `(?:`,
      // `(?=` or `(?<name>` is punctuation, and reading it as a quantifier
      // would mark every non-capturing group ambiguous.
      index = afterGroupPrefix(source, index);
      continue;
    }

    if (char === ")") {
      // A `)` with nothing open is a malformed SOURCE, which `new RegExp`
      // refuses with its own message at every call site here (the compile always
      // happens first). This scan therefore only has to not crash on it: the
      // root frame is never popped.
      const frame = stack.length > 1 ? (stack.pop() as Frame) : current();
      const quantifier = quantifierAt(source, index + 1);
      if (quantifier !== null && quantifier.unbounded && frame.ambiguous) {
        return {
          fragment: source.slice(frame.start, quantifier.end),
          why: "an unbounded quantifier applied to a group whose body can match one string in more than one way, which is the classic exponential-backtracking shape",
        };
      }
      // A quantified group is itself a variable repetition as far as its PARENT
      // is concerned, and an ambiguous body stays ambiguous when it is nested
      // one level deeper -- so both facts bubble up rather than being forgotten
      // at the closing paren.
      if (frame.ambiguous || quantifier !== null) current().ambiguous = true;
      index = quantifier === null ? index + 1 : quantifier.end;
      continue;
    }

    if (char === "|") {
      current().ambiguous = true;
      index += 1;
      continue;
    }

    const quantifier = quantifierAt(source, index);
    if (quantifier !== null) {
      if (quantifier.variable) current().ambiguous = true;
      index = quantifier.end;
      continue;
    }

    index += 1;
  }
  return null;
}

/** Index one past `(`, `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` or `(?<name>`. */
function afterGroupPrefix(source: string, open: number): number {
  if (source[open + 1] !== "?") return open + 1;
  const third = source[open + 2];
  if (third === ":" || third === "=" || third === "!") return open + 3;
  if (third === "<") {
    const fourth = source[open + 3];
    if (fourth === "=" || fourth === "!") return open + 4;
    const close = source.indexOf(">", open + 3);
    return close === -1 ? open + 3 : close + 1;
  }
  return open + 2;
}

/**
 * `null` when `compiled` is safe to run against network-sourced strings, or the
 * hazard that makes it unsafe.
 *
 * Takes the COMPILED pattern rather than the source so the empty-string test is
 * run against the real thing (flags included) rather than against a second
 * compilation that could differ.
 */
export function patternHazard(source: string, compiled: RegExp): PatternHazard | null {
  const shape = catastrophicShape(source);
  if (shape !== null) return shape;
  // Safe to run: `catastrophicShape` has already cleared the source, so this
  // `.test` cannot be the hang it is guarding against. The subject is the empty
  // string, which is the cheapest input there is.
  if (compiled.test("")) {
    return {
      fragment: source,
      why: "it matches the EMPTY string, and every one of these patterns is applied unanchored -- so it matches every login and every check name, which is not an identity but the constant true",
    };
  }
  return null;
}
