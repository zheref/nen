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
// TERMINATES. Measured before the guard landed:
//
//   new RegExp("(a+)+$", "i").test("a".repeat(38) + "!")   ~305ms
//
// BE PRECISE ABOUT WHAT THAT NUMBER IS, because an earlier draft of this header
// was not. It said "2**39 steps: not slow, unbounded", which is what the SHAPE
// implies but not what was measured -- and the correction turns out to matter
// more than the original claim did, because THE ANSWER DEPENDS ON THE ENGINE.
// The same expression, the same machine, the two runtimes this repository
// actually uses:
//
//   subject length      bun 1.4 (JSC)      node 24 (V8)
//   -----------------------------------------------------
//   21 characters             7ms                43ms
//   26 characters           206ms               304ms
//   29 characters             --               4,318ms
//   31 characters           314ms            10,259ms
//   33 characters             --              41,906ms
//   39 characters           306ms        ~45 min, EXTRAPOLATED (see below)
//   46 characters           305ms                 --
//
// Every figure above was measured except the last, which is 41.9s doubled the
// six times the six extra characters call for. It is marked because this file
// spent a round being wrong about an unmeasured extrapolation and is not going
// to do it twice: the measured points stop at 33 characters because 39 is the
// length at which waiting for the answer stops being practical, which is
// itself the finding.
//
// bun's JSC CAPS its own backtracking: the call ANSWERS -- `false` -- in about
// 305ms and PLATEAUS there, however long the subject gets. V8 does not cap it,
// and goes where the arithmetic says. So:
//
//   * IN THE SHIPPED BINARY (bun --compile, every `build:*` script) this is not
//     a hang. It is hundreds of milliseconds PER `.test`, and these patterns
//     are not tested once -- the readiness gate runs them against every review
//     author's login, every requested reviewer's login and every check name in
//     a rollup, so one such pattern turns a single pull request's evaluation
//     into tens of seconds of wall clock for a verdict meant to be instant.
//   * IN THIS REPOSITORY'S OWN TEST HARNESS (vitest, which is node) the SAME
//     pattern against a 39-character login does not finish. That is not a
//     hypothetical second runtime; it is the other half of this repo.
//   * SO THE CAP IS AN IMPLEMENTATION DETAIL, and treating it as a guarantee is
//     the actual error. It is JSC's, it is in no specification, it is not a
//     documented bun promise, and it can change in a version bump. A gate whose
//     termination is a property of somebody else's backtracking budget has no
//     stated behaviour of its own, and this repository does not ship one.
//
// A readiness gate that stalls is a readiness gate that reports nothing, and the
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
// So the guard is a REFUSAL AT LOAD, at the seams where a data-sourced pattern
// is COMPILED -- and there are three of them, not one (an earlier draft of this
// header said "the single seam", which was wrong; the list is below under WHERE
// THIS IS APPLIED). It is loud, it is actionable, it names the field, and --
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
// be a guard the second walks past. For the same reason a LARGE FINITE
// repetition counts as unbounded (`REPEAT_CEILING`, below): `(a+){1,40}` and
// `(a|a){1,100}` carry no `*`, `+` or `{n,}` anywhere, so the first version of
// this guard loaded all four of them -- and each cost 300-620ms per `.test` at
// login length, which is the whole defect wearing a different quantifier.
//
// It is a SHAPE test, not a proof: it is
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
// completeness claim, and the residue is named rather than left to be
// rediscovered:
//
//   `.+`   matches every non-empty subject and still loads, because refusing it
//          would require guessing at intent rather than reading a property.
//   `\b`   likewise. Unanchored, it is the constant TRUE for any subject holding
//          a word character -- which every GitHub login does -- so `\b` in a
//          `login_pattern` means "everyone" exactly as `.*` does. It survives
//          this guard because the empty-match probe answers `false` for it (a
//          word boundary is a zero-width ASSERTION, and `""` has none), and
//          catching it would need the analyser to reason about assertions
//          rather than about shape. Stated here, not fixed here.
//
// The header of `./gates.ts` carries the `.*`-hazard note for all five fields
// for exactly that residue.
//
// ── WHERE THIS IS APPLIED, AND WHERE IT IS NOT ──────────────────────────────
//
// The line is: a pattern that comes from DATA and is tested against a GitHub
// LOGIN or CHECK NAME goes through here. There are THREE compile sites, and
// they do NOT share one contract -- the differences are deliberate, so each is
// stated rather than left to be inferred from whichever one a reader opens
// first:
//
//   1. `./gates.ts`'s `readPattern`, for the five gates-file fields.
//      SHAPE + EMPTY-MATCH, and it THROWS a path-and-pointer `SchemaError`.
//      A file is a thing an operator can fix; refusing to load it names the
//      field and the fragment and stops before any pull request is judged.
//
//   2. `safePattern` in THIS file, shared by `../verbs/pr_ready.ts`'s
//      `identitiesFromFlags` (a `--reviewers` name the operator typed) and
//      `../gates/predicates.ts`'s `reviewerLoginPattern` and its two siblings
//      (the same name, on the path taken when a gates file EXISTS but does not
//      declare that reviewer).
//      SHAPE ONLY, and it does NOT throw -- it returns `/(?!)/`. That is this
//      layer's own long-standing contract, from the shell's `test($name; "i")`
//      onward: a name it cannot use matches NOTHING, which leaves the reviewer
//      still owed a round. Conservative in the direction that holds the gate
//      shut. The empty-match half is not applied here because these two callers
//      are the fallback path for a name with no identity, where `/(?!)/` and a
//      refusal would mean the same thing anyway.
//
//      ONE implementation, deliberately. `predicates.ts` and `pr_ready.ts` each
//      carried their own byte-identical copy, and only `pr_ready.ts`'s was
//      guarded -- which put the UNGUARDED copy on the steady-state path, since
//      `identitiesFromFlags` is never called at all once a gates file exists.
//      A duplicated guard is a guard that is half-applied; there is now one.
//
//   3. `../wake/command.ts`'s `--author-pattern`.
//      SHAPE ONLY, and it THROWS a `VerbUsageError`. Shape only because `.*` is
//      a LEGITIMATE value there -- "sweep every author" is a thing an operator
//      can mean for a wake sweep, unlike for a reviewer identity. Throwing
//      rather than degrading to `/(?!)/` because a flag the operator typed on
//      this invocation is something they can retype; silently sweeping nothing
//      would look like "no pull requests need waking".
//
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
  /**
   * `*`, `+`, `{n,}` -- or a FINITE repeat large enough to be one in practice;
   * see `REPEAT_CEILING`.
   */
  readonly unbounded: boolean;
  /** Anything that can consume its body a varying number of times. */
  readonly variable: boolean;
}

const BRACE = /^\{(\d+)(,(\d*))?\}/;

/**
 * The repetition count above which a FINITE `{n}` / `{n,m}` over an ambiguous
 * body is treated as unbounded.
 *
 * WHY A NUMBER AT ALL, rather than "finite is safe". The first version of this
 * scanner read `unbounded` as `comma && upper === ""` -- literally "there is no
 * upper bound" -- and so loaded all four of these:
 *
 *   (a|a){1,100}$   ~319ms      (a+){1,40}$      ~303ms
 *   (a+){40}$       ~301ms      ((a|a){1,10}){1,10}$  ~362ms
 *
 * measured against a 39-character subject under bun -- and, under node, not
 * finishing at all, for the reason the engine table in this file's header
 * gives. A finite bound is
 * only a bound in the limit; what decides whether a pattern is affordable is
 * how the count compares to the SUBJECT, and this guard knows the subject
 * exactly. GitHub logins are at most 39 characters, so a repetition count of
 * 40 over an ambiguous body is not "bounded" in any sense an operator would
 * notice -- the matcher exhausts every ambiguous split of a real login before
 * the bound ever bites.
 *
 * WHY 8. It has to sit below the shortest interesting subject and above the
 * counts that appear in patterns people actually write. Real identity patterns
 * repeat single characters or short literals a handful of times (`\\d{1,3}`,
 * `(ab){2}`), and 2**8 = 256 ambiguous splits is work no one measures. Anything
 * larger over an ambiguous body is a shape, not a length. The test is applied
 * ONLY when the body is ambiguous, so `a{1,999}` -- a literal repeated, one way
 * to match it -- is untouched.
 */
const REPEAT_CEILING = 8;

/**
 * The quantifier starting at `index`, or `null` when there is none there.
 *
 * `{2}` is a quantifier but NOT a variable one: it consumes its body exactly
 * twice, which multiplies the work by a constant and cannot compound. `{40}` is
 * still not variable -- but it IS unbounded for this guard's purposes, because
 * forty ambiguous repetitions over a 39-character login is the exponential the
 * guard exists for wearing a finite bound (see `REPEAT_CEILING`).
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
  // The count that decides affordability: the upper bound when there is one,
  // otherwise the exact count of a `{n}`. `{n,}` has neither and is unbounded
  // outright.
  const ceiling = comma ? upper : (match[1] ?? "");
  const openEnded = comma && upper === "";
  return {
    end: lazy(index + match[0].length),
    unbounded: openEnded || Number(ceiling) > REPEAT_CEILING,
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
          why: "a quantifier applied to a group whose body can match one string in more than one way, repeating either without limit or up to a bound higher than the longest subject it will ever see, which is a potentially exponential-backtracking shape",
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
  // `lastIndex` IS RESET ON BOTH SIDES OF THE PROBE, and the two halves are
  // there for different reasons (zheref/nen#8 review, minor 7).
  //
  // BEFORE, because a stale cursor makes the probe LIE. `.test` on a `g` or `y`
  // pattern starts from `lastIndex`, and the subject here is the empty string --
  // so a regex arriving with any non-zero `lastIndex` starts past the end and
  // answers `false` however broad it is. Measured: `a*` with `lastIndex = 3`
  // reports NO empty match. That is the guard's most consequential answer
  // ("this pattern means everyone") silently inverted by a field on the object
  // it was handed, and this function does not get to assume its caller's regex
  // is fresh.
  //
  // AFTER, because a guard must not alter the thing it certified. `.test("")`
  // happens to normalise `lastIndex` to 0 on its own for every flag combination
  // -- a match against `""` ends at 0, and a failure resets to 0 -- so this
  // assignment is belt-and-braces TODAY and no test can kill it. It is written
  // anyway, and its unkillability is stated rather than papered over: what it
  // actually guards is the day somebody probes with a non-empty subject, when
  // `.test`'s own normalisation stops applying and the postcondition below
  // becomes this line's responsibility alone.
  compiled.lastIndex = 0;
  const matchesEmpty = compiled.test("");
  compiled.lastIndex = 0;
  if (matchesEmpty) {
    return {
      fragment: source,
      why: "it matches the EMPTY string, and every one of these patterns is applied unanchored -- so it matches every login and every check name, which is not an identity but the constant true",
    };
  }
  return null;
}

/**
 * A case-insensitive regex built from a caller-supplied reviewer NAME, exactly
 * as jq's `test($name; "i")` builds one -- and the ONE implementation of it.
 *
 * An INVALID pattern (a name carrying unbalanced regex metacharacters) yields a
 * regex that matches NOTHING, which reproduces the shell's behaviour rather than
 * diverging from it: there, `jq -e` errors, the `if` reads the non-zero exit as
 * "no match", and the reviewer is therefore still owed a round. Conservative in
 * the same direction -- a malformed reviewer name can never SATISFY a round, only
 * fail to match one.
 *
 * A CATASTROPHIC name matches nothing for the same reason (zheref/nen#8 item 3).
 * The compiled result is run against review author logins, requested-reviewer
 * logins and check names that came off the network, which is the identical
 * exposure `./gates.ts`'s five pattern fields have -- so it goes through the same
 * shape guard. It does NOT throw: this function's whole contract is that a name
 * it cannot use matches nothing, and `/(?!)/` is the conservative direction here
 * exactly as it is for an unparseable name. That keeps the behaviour faithful to
 * the shell's own `test($name; "i")` for every name a person would actually
 * type, while refusing to hand an exponential matcher a stranger's login.
 *
 * IT LIVES HERE, not beside either of its two callers, because it had two
 * byte-identical bodies and only one of them was ever guarded -- see contract 2
 * in this file's header. `../gates/predicates.ts` is the copy on the STEADY-STATE
 * path (once a target repository ships a `schemas/gates.json`,
 * `../verbs/pr_ready.ts`'s `identitiesFromFlags` is not called at all), so the
 * unguarded twin was the one doing the compiling in production.
 */
export function safePattern(source: string): RegExp {
  let compiled: RegExp;
  try {
    compiled = new RegExp(source, "i");
  } catch {
    return /(?!)/;
  }
  return catastrophicShape(source) === null ? compiled : /(?!)/;
}
