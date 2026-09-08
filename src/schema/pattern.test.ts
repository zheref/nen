// Tests for ./pattern.ts -- the guard on a regular expression that arrives as
// DATA and is then run against a string that arrives off the network
// (zheref/nen#8 item 3, zheref/nen#6 item 2).
//
// The suite is in three parts and each part is load-bearing:
//   1. the catastrophic shapes the two filings name BY EXAMPLE are refused;
//   2. the ordinary patterns both shipped fixtures actually contain are NOT --
//      a guard that refused real reviewer identities would be a worse defect
//      than the one it closes;
//   3. the timing claim itself, measured rather than asserted: the issue's own
//      `(a+)+$` against a 30+ character subject.

import { describe, expect, it } from "vitest";
import { catastrophicShape, patternHazard, safePattern } from "./pattern.js";

function hazardOf(source: string, flags = "i"): string | null {
  return patternHazard(source, new RegExp(source, flags))?.why ?? null;
}

describe("catastrophicShape -- the exponential-backtracking families", () => {
  it("refuses the nested quantifier the issue names: (a+)+", () => {
    const hazard = catastrophicShape("(a+)+$");
    expect(hazard).not.toBeNull();
    // The FRAGMENT is quoted back, not just "this pattern is bad": the author
    // has to be able to find the sub-expression in a long pattern.
    expect(hazard?.fragment).toBe("(a+)+");
    expect(hazard?.why).toMatch(/exponential-backtracking/);
  });

  it("refuses every spelling of the same shape", () => {
    for (const source of [
      "(a*)*",
      "(a+)*",
      "(a*)+",
      "(a+){2,}",
      "(?:a+)+", // non-capturing: the same shape wearing a different prefix
      "(?<run>a+)+", // named: likewise
      "([a-z]+)+",
      "(\\w*)+",
      "^x((y+)z)+$", // the quantified group is nested two deep
    ]) {
      expect(catastrophicShape(source), source).not.toBeNull();
    }
  });

  it("refuses the OTHER classic family too -- a quantified overlapping alternation", () => {
    // `(a|a)+$` is exactly as exponential as `(a+)+$`, and a guard that caught
    // only "nested quantifier" would be a guard this walks straight past.
    expect(catastrophicShape("(a|a)+$")).not.toBeNull();
    expect(catastrophicShape("(a|ab)+$")).not.toBeNull();
  });

  it("is conservative in the SAFE direction: it may refuse a linear pattern", () => {
    // `(a|b)+` has disjoint branches and runs in linear time. It is refused all
    // the same, because deciding branch overlap in general is not a thing a
    // loader can do, and the rewrite (`[ab]+`) is mechanical. Asserted so the
    // false-positive class is a stated property rather than a surprise.
    expect(catastrophicShape("(a|b)+")).not.toBeNull();
    expect(catastrophicShape("[ab]+")).toBeNull();
  });
});

describe("catastrophicShape -- what it must NOT refuse", () => {
  it("passes the patterns the two shipped fixtures actually declare", () => {
    // Copied from src/schema/fixtures/{bankai,alt}-repo/nen/gates.json. If
    // this list ever goes red the guard has started refusing real reviewer
    // identities, which is a worse defect than the one it closes.
    for (const source of [
      "sasuke",
      "^sasuke / audit$",
      "^tenma / review$",
      "copilot",
      "^bisky / review$",
      "cursor|bugbot",
      "bugbot",
      "(^|/)roy-bankai(\\[bot\\])?$",
      "scribe-reviewer",
      "sentry|watchtower",
      "^sentry / sweep$",
      "(^|/)train-bot(\\[bot\\])?$",
    ]) {
      expect(catastrophicShape(source), source).toBeNull();
    }
  });

  it("does not mistake an escaped metacharacter for structure", () => {
    // `\(`, `\+` and `\*` are literals. Reading them as a group or a quantifier
    // would refuse patterns that match a literal bracket -- which is exactly
    // what both fixtures' `(\[bot\])?` arm contains.
    expect(catastrophicShape("a\\+\\+")).toBeNull();
    expect(catastrophicShape("\\(a\\+\\)\\+")).toBeNull();
  });

  it("does not mistake a character class's contents for structure", () => {
    // Inside `[...]` every metacharacter is a literal, including `]` when it is
    // escaped and `+`, `*`, `|`, `(`.
    expect(catastrophicShape("([+*|(]x)")).toBeNull();
    expect(catastrophicShape("[a\\]b]+")).toBeNull();
  });

  it("leaves a SMALL bounded outer quantifier alone", () => {
    // `?` and `{2}` cannot iterate enough times to compound into an
    // exponential at login length. `(\[bot\])?` is the fixture case this
    // protects.
    expect(catastrophicShape("(a+)?")).toBeNull();
    expect(catastrophicShape("(a|b)?")).toBeNull();
    expect(catastrophicShape("(a{2})+")).toBeNull();
    expect(catastrophicShape("a{1,3}")).toBeNull();
    expect(catastrophicShape("(ab){2}")).toBeNull();
    // Right AT the ceiling, so the boundary is pinned rather than assumed.
    expect(catastrophicShape("(a|b){1,8}")).toBeNull();
    // A large repeat over an UNAMBIGUOUS body is still fine: one way to match
    // a literal is one way however many times it repeats.
    expect(catastrophicShape("a{1,999}")).toBeNull();
    expect(catastrophicShape("(ab){40}")).toBeNull();
  });

  it("refuses a LARGE FINITE repeat over an ambiguous body", () => {
    // zheref/nen#8 review, minor 1. The first version of this scanner read
    // "unbounded" literally -- `{n,}` with no upper bound -- so all four of
    // these LOADED, and each costs 300-620ms per `.test` at login length. A
    // finite bound above the longest subject is not a bound.
    for (const source of [
      "(a|a){1,100}$",
      "(a+){1,40}$",
      "(a+){40}$",
      "((a|a){1,10}){1,10}$",
    ]) {
      const hazard = catastrophicShape(source);
      expect(hazard, source).not.toBeNull();
      expect(hazard?.why, source).toMatch(/exponential-backtracking/);
    }
    // THE MEASUREMENT IS DELIBERATELY NOT RUN HERE. `new RegExp("(a+){1,40}$",
    // "i").test("a".repeat(39) + "!")` costs ~310ms under bun and DOES NOT
    // FINISH under node, which is the runtime vitest uses -- an earlier draft of
    // this case asserted it live and took 79 seconds. The figures, and the
    // engine table they come from, are in ./pattern.ts's header where they can
    // be read without being paid for; what belongs in a test is the refusal.
  });

  it("refuses one quantifier past the ceiling, and not one below it", () => {
    // The constant is a decision, so it is pinned from both sides rather than
    // left as whatever the implementation happens to do.
    expect(catastrophicShape("(a|a){1,8}")).toBeNull();
    expect(catastrophicShape("(a|a){1,9}")).not.toBeNull();
    expect(catastrophicShape("(a|a){8}")).toBeNull();
    expect(catastrophicShape("(a|a){9}")).not.toBeNull();
  });

  it("does not crash on a malformed source -- the compile refuses that first", () => {
    // Every call site compiles BEFORE asking this, so a malformed source never
    // reaches it in production. It must still terminate rather than throw.
    expect(() => catastrophicShape("a(")).not.toThrow();
    expect(() => catastrophicShape(")+")).not.toThrow();
    expect(() => catastrophicShape("[a")).not.toThrow();
    expect(() => catastrophicShape("\\")).not.toThrow();
  });
});

describe("patternHazard -- the empty-string refusal", () => {
  it("refuses a pattern that matches the empty string, because it matches EVERYTHING", () => {
    // Every one of these patterns is applied with an unanchored `.test(...)`,
    // so an empty match at offset 0 means every login and every check name
    // matches. That is the constant `true`, not an identity.
    for (const source of [".*", "a*", "x?", "(foo)?", "^"]) {
      expect(hazardOf(source), source).toMatch(/EMPTY string/);
    }
  });

  it("does NOT refuse `.+`, and says so out loud", () => {
    // The floor is a PROPERTY the loader can read, not a guess at intent.
    // `.+` matches every non-empty subject and still loads; the `.*`-hazard
    // note in ./gates.ts's header is what covers that residue.
    expect(hazardOf(".+")).toBeNull();
  });

  it("reports the catastrophic shape BEFORE the empty match when a pattern has both", () => {
    // `(a*)*` matches the empty string and is exponential. The shape is the
    // more urgent of the two and is the one named.
    expect(hazardOf("(a*)*")).toMatch(/exponential-backtracking/);
  });

  it("passes an ordinary anchored identity pattern", () => {
    expect(hazardOf("^sasuke / audit$")).toBeNull();
    expect(hazardOf("cursor|bugbot")).toBeNull();
  });

  it("is not fooled by a STALE lastIndex on the regex it was handed", () => {
    // zheref/nen#8 review, minor 7 -- and the half of it that turned out to
    // matter. The probe is `.test("")`, and a `g`/`y` pattern starts from its
    // own `lastIndex`, so one arriving non-zero begins PAST THE END of the
    // empty subject and reports no match however broad it is. Measured before
    // the fix: `a*` with `lastIndex = 3` answered `false`, i.e. the guard's
    // most consequential verdict -- "this pattern matches everyone" -- silently
    // inverted by a field on the caller's object.
    const global = new RegExp("a*", "g");
    global.lastIndex = 3;
    expect(patternHazard("a*", global)?.why).toMatch(/EMPTY string/);

    // And the postcondition: the guard hands the regex back as it found it,
    // never with a cursor left mid-string that would shift the first REAL
    // match. No call site compiles with `g`/`y` today; this is the pin that
    // makes adding one safe.
    expect(global.lastIndex).toBe(0);
    const sticky = new RegExp("a+", "gy");
    sticky.lastIndex = 3;
    expect(patternHazard("a+", sticky)).toBeNull();
    expect(sticky.lastIndex).toBe(0);
  });
});

describe("safePattern -- the ONE implementation, shared by both compile sites", () => {
  it("compiles an ordinary reviewer name case-insensitively", () => {
    const pattern = safePattern("alpha");
    expect(pattern.source).toBe("alpha");
    expect(pattern.flags).toBe("i");
    expect(pattern.test("ALPHA")).toBe(true);
  });

  it("yields the match-nothing pattern for an unparseable name", () => {
    // The shell's own reading, preserved: `jq -e` errors, the `if` takes the
    // non-zero exit as "no match", and the reviewer is still owed a round.
    expect(safePattern("(unclosed").source).toBe("(?!)");
  });

  it("yields the match-nothing pattern for a catastrophic name", () => {
    expect(safePattern("(a+)+$").source).toBe("(?!)");
    expect(safePattern("(a|a)+$").source).toBe("(?!)");
    expect(safePattern("(a+){1,40}$").source).toBe("(?!)");
  });

  it("does NOT refuse a name that merely matches everything", () => {
    // SHAPE ONLY here, unlike ./gates.ts's `readPattern`: `--reviewers .*` is
    // an operator saying something about their own invocation, and this
    // function's contract has always been "a name I cannot use matches
    // nothing", never "a name I disapprove of". The three contracts are
    // written out in ./pattern.ts's header.
    expect(safePattern(".*").source).toBe(".*");
  });
});

describe("the timing claim the issue makes, measured rather than asserted", () => {
  it("(a+)$ over a 40-character subject is fast -- the shape is the problem, not the length", () => {
    const subject = `${"a".repeat(40)}!`;
    const started = performance.now();
    expect(new RegExp("(a+)$", "i").test(subject)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("the issue's own (a+)+$ never runs, because it is refused at load", () => {
    // The issue measured `new RegExp("(a+)+$","i").test("a".repeat(30)+"!")` at
    // ~300ms in this runtime. BE EXACT ABOUT WHAT THAT IS: bun's JSC caps its
    // own backtracking, so the call ANSWERS `false` in a few hundred
    // milliseconds and plateaus rather than doubling -- it is not a hang here.
    // What it is, is hundreds of milliseconds PER `.test`, multiplied by every
    // login and every check name in a rollup, resting on an engine
    // implementation detail no specification promises. ./pattern.ts's header
    // carries the full statement. The guard's claim is that the pattern is
    // refused BEFORE any subject is tested, so the assertion is on the refusal
    // and the clock measures the refusal, not the match.
    const started = performance.now();
    const hazard = catastrophicShape("(a+)+$");
    const elapsed = performance.now() - started;
    expect(hazard).not.toBeNull();
    // A source SCAN, so it is linear in the pattern's length and independent of
    // any subject -- there is no input a caller can supply that makes the guard
    // itself the hang.
    expect(elapsed).toBeLessThan(50);
  });

  it("scans a long hostile source quickly -- the guard is not its own denial of service", () => {
    const started = performance.now();
    expect(catastrophicShape(`${"(a+)".repeat(2000)}b`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
  });
});
