import { describe, expect, it } from "vitest";
import { compileReleaseLinePattern, RELEASE_PATTERN_LIMITS as LIMITS } from "./releasepattern.js";
import { releaseLinePattern, releaseLinePatterns } from "./pattern.js";
import { loadWorkflow } from "./workflow.js";

describe("bounded release-line compiler", () => {
  it.each([
    "(a)\\1", "(?<run>a)\\k<run>", "(?=a)a", "(?!b)a", "(?<=a)b", "(?<!a)b", "(?i:a)",
    "\\p{Letter}", "\\s", "\\b", "\\q", "\\0", "a+?", "a**", "a^b", "a$b", "[", "[]", "[^]", "[z-a]", "[\\d-a]", "a{3,2}", "a{no}", "\\x0", "\\u00xx", "\\", "(", ")",
  ])("refuses unsupported or malformed source %j, never falling back to native RegExp", (source) => {
    expect(() => compileReleaseLinePattern(source)).toThrow();
  });

  it("preserves existing release shape refusals without changing the legacy guard", () => {
    expect(() => releaseLinePattern("(a+)+$")).toThrow(/unsafe line pattern/);
    expect(releaseLinePattern("a+")).not.toBeInstanceOf(RegExp);
  });

  it("bounds source, nesting, classes, repeat expansion and compiled states", () => {
    expect(() => compileReleaseLinePattern("a".repeat(LIMITS.source + 1))).toThrow(/source length limit/);
    expect(compileReleaseLinePattern("(".repeat(LIMITS.nesting) + "a" + ")".repeat(LIMITS.nesting)).match("a").kind).toBe("match");
    expect(() => compileReleaseLinePattern("(".repeat(LIMITS.nesting + 1) + "a" + ")".repeat(LIMITS.nesting + 1))).toThrow(/nesting limit/);
    expect(() => compileReleaseLinePattern("[" + "a".repeat(LIMITS.classIntervals + 1) + "]")).toThrow(/interval limit/);
    expect(compileReleaseLinePattern(`a{${LIMITS.states - 1}}`).stateCount).toBe(LIMITS.states);
    expect(() => compileReleaseLinePattern(`a{${LIMITS.states}}`)).toThrow(/state limit/);
    expect(() => compileReleaseLinePattern("a{999999999999999999999999}")).toThrow(/repeat bound/);
    expect(() => compileReleaseLinePattern("(a{1000}){1000}")).toThrow(/state limit/);
    expect(() => compileReleaseLinePattern("a".repeat(LIMITS.states))).toThrow(/state limit/);
  });

  it("bounds pattern lists and aggregate emitted states as well as each pattern", () => {
    expect(releaseLinePatterns(Array<string>(64).fill("a".repeat(255))).reduce((sum, pattern): number => sum + pattern.stateCount, 0)).toBe(LIMITS.entryStates);
    expect(() => releaseLinePatterns(Array<string>(64).fill("a".repeat(256)))).toThrow(/total compiled state limit/);
    expect(() => releaseLinePatterns(Array<string>(65).fill("a"))).toThrow(/pattern count limit/);
  });

  it("agrees with an independent native small-input oracle for the supported language", () => {
    const sources = [
      "^$", "a", "a|b", "a|", "(?:ab|ba)?", "(a|b)*", "a+a+", "a*b?", "(?:a?)*", "(?:a?b?)*", "a{0}", "a{0,2}", "a{2}", "a{2,}", "(?:ab){1,3}",
      ".", ".*", "[a-c]+", "[^a-c]*", "[a\\-z]", "[-az]", "[\\dA-F]+", "[\\D]", "[\\w]+", "[\\W]", "[\\x41-\\u0043]", "\\t|\\n|\\r|\\f|\\v", "\\.\\+\\$\\(\\)\\[\\]\\{\\}\\|\\/\\-\\\\", "^a|b$", "a|a\\r", "a|a\\n", "😀", "[😀]",
    ];
    const words = ["", "\r", "\n", "a\r", "a\n", "\t", "\f", "\v", "\ufeff", "A", "B", "C", "9", "_", "!", "\u2028", "\u2029", "😀", "\ud83d", ".+$()[]{}|/-\\"];
    for (let bits = 0; bits < 64; bits++) words.push(bits.toString(2).replaceAll("0", "a").replaceAll("1", "b"));
    for (const source of sources) {
      // A true input-end assertion, not '$': otherwise the native engine can
      // pick a shorter alternative before a final CR/LF and hide a full match.
      const native = new RegExp(`^(?:${source})(?![\\s\\S])`);
      const compiled = compileReleaseLinePattern(source);
      for (const word of words) {
        const match = native.exec(word);
        const expected = match !== null && match[0].length === word.length;
        expect(compiled.match(word).kind, JSON.stringify({ source, word })).toBe(expected ? "match" : "no-match");
      }
    }
  });

  it("matches ambiguous repetitions in bounded state work, rather than enumerating splits", () => {
    // Feitan SEC-7: the old guard accepted this, then JSC backtracked for ~1s
    // on just 40 a's + '!'. Work counts, not timing, prove the new contract.
    const compiled = releaseLinePattern("a+".repeat(10));
    for (const length of [40, 400, 4000]) {
      const result = compiled.match("a".repeat(length) + "!");
      expect(result.kind).toBe("no-match");
      expect(result.work).toBeLessThanOrEqual(12 * compiled.stateCount * (length + 2));
    }
    expect(compiled.match("a".repeat(20_000)).kind).toBe("exhausted");
  });

  it("closes nullable epsilon cycles once per boundary and keeps calls independent", () => {
    const compiled = compileReleaseLinePattern("(?:(?:a?)*)*");
    expect(compiled.match("").kind).toBe("match");
    expect(compiled.match("a".repeat(1000)).kind).toBe("match");
    expect(compiled.match("a".repeat(1000) + "!").kind).toBe("no-match");
    expect(compiled.match("").kind).toBe("match");
  });

  it("distinguishes work and length exhaustion from an actual no-match", () => {
    const compiled = compileReleaseLinePattern("a+");
    expect(compiled.match("b").kind).toBe("no-match");
    expect(compiled.match("a", 0)).toEqual({ kind: "exhausted", work: 0, reason: "work" });
    expect(compiled.match("a", 3)).toEqual({ kind: "exhausted", work: 3, reason: "work" });
    expect(compiled.match("a", Number.NaN).kind).toBe("exhausted");
    expect(compiled.match("a", Number.POSITIVE_INFINITY).kind).toBe("exhausted");
    expect(compiled.match("a".repeat(LIMITS.lineLength + 1))).toEqual({ kind: "exhausted", work: 0, reason: "line-length" });
  });

  it("consumes CR, BOM and UTF-16 units exactly, case-sensitively", () => {
    expect(compileReleaseLinePattern("a$").match("a\r").kind).toBe("no-match");
    expect(compileReleaseLinePattern("a\\r$").match("a\r").kind).toBe("match");
    expect(compileReleaseLinePattern("a").match("\ufeffa").kind).toBe("no-match");
    expect(compileReleaseLinePattern("a").match("A").kind).toBe("no-match");
    expect(compileReleaseLinePattern(".").match("😀").kind).toBe("no-match");
    expect(compileReleaseLinePattern("..").match("😀").kind).toBe("match");
  });

  it("accepts witnesses for EVERY one of Nen's thirteen actual policy patterns", () => {
    const curl = "curl -fsSL https://raw.githubusercontent.com/zheref/nen/v0.21.0/bootstrap/nen.sh -o nen-bootstrap.sh";
    const bash = "bash nen-bootstrap.sh --ref v0.21.0";
    const assign = 'nen="$(bash nen-bootstrap.sh --ref v0.21.0)"';
    const bootstrap = "nen bootstrap --ref v0.21.0 --source zheref/nen";
    const script = " --script ./nen-bootstrap.sh";
    const witnesses: Readonly<Record<string, readonly (readonly string[])[]>> = {
      "src/version.ts": [['export const VERSION = "0.21.0";'], ['export const COMPATIBLE_MINOR_FLOOR = "0.21";']],
      "README.md": [[curl], [bash], [assign, assign + ' && "$nen" --version'], [bootstrap + script], ["Once the `v0.21.0` release and its assets are published, the first prints"], ["`0.21.0`. Before the tag exists, a fresh install's `curl` command in"]],
      "docs/USAGE.md": [[curl], [bash], [assign], [bootstrap, bootstrap + script], ["/home/me/.cache/nen/zheref_nen/v0.21.0/nen-linux-x64"]],
    };
    let count = 0;
    for (const entry of loadWorkflow(process.cwd()).workflow.release.unitPaths ?? []) {
      if (typeof entry === "string" || !("lines" in entry)) continue;
      const samples = witnesses[entry.path];
      expect(samples).toHaveLength(entry.lines.length);
      entry.lines.forEach((source, index): void => {
        const compiled = releaseLinePattern(source);
        for (const sample of samples?.[index] ?? []) {
          expect(compiled.match(sample).kind, source).toBe("match");
          expect(compiled.match(sample + "!").kind, source).toBe("no-match");
        }
        count++;
      });
    }
    expect(count).toBe(13);
  });
});
