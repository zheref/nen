// src/taxonomy-purity.test.ts -- the §3 invariant, enforced rather than asserted.
//
// "No binary may hard-code a persona, label, check name, or colour; they are
// read from the target repo's schemas" (Akatsuki migration §3). A rule of that
// shape is worth nothing as prose: it is exactly the kind of discipline that
// holds for three commits and then quietly stops, because the violation is one
// convenient literal in a file nobody re-reads. So it is a TEST, and it fails
// the build.
//
// IT SWEEPS CODE, NOT COMMENTS, and that distinction is the whole design of this
// file. The seeded modules' comments are FULL of the names -- deliberately, and
// review-blockingly so: each one records the production incident its branch
// exists for, and stripping them to satisfy a grep would destroy the thing that
// makes the port safe (the BC-IS-#737 discipline). The prohibition is on a name
// a binary DECIDES with, not on a name a maintainer READS. So comments and the
// contents of string/template literals inside comments are removed first, and
// what remains -- executable code, including its string and regex literals -- is
// what is searched.
//
// WHAT IS EXCLUDED, and why each is legitimate:
//   * `**/*.test.ts` -- a test must be able to name what it is testing, and the
//     ported predicate suite in particular is the regression proof precisely
//     because it uses the original's own names.
//   * `**/fixtures/**` -- fixture repositories exist to state concrete
//     vocabularies. Two of them, with nothing in common; that pair is what
//     makes "the names are data" a proved claim (src/gates/predicates.test.ts).
// Nothing else is excluded, and adding an exclusion is a review finding.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(process.cwd(), "src");

// Read a shipped source with its line endings NORMALIZED.
//
// The tree is `* text=auto`, so a Windows checkout carries CRLF. Today that
// would only put a stray carriage return on the end of every line this sweep
// reports; what makes it worth fixing is the NEXT rule somebody adds, anchored
// with a multiline end-of-line, which would then match on two of the three CI
// lanes and not the third. This file is the guard for a rule that fails the
// build, so it must not itself be platform-conditional -- the same hazard that
// took pipeline.test.ts's upload assertion red on windows-latest and green
// everywhere else.
function readSource(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function shippedFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "fixtures") continue;
      shippedFiles(path, found);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    found.push(path);
  }
  return found;
}

// Replace every comment with an equal number of newlines, so reported line
// numbers still point at the real line.
//
// It tracks single-quoted, double-quoted and template strings, because a `//`
// inside a string is not a comment. It does NOT track regex literals: a `//`
// inside one would be an empty regex, which is not valid in any of these
// sources, and a `/` that opens a regex is only mistaken for a comment when the
// next character is also `/`.
export function stripComments(source: string): string {
  let out = "";
  let index = 0;
  let quote: string | null = null;

  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (quote !== null) {
      out += char;
      if (char === "\\") {
        out += next;
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") out += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }

    out += char;
    index += 1;
  }
  return out;
}

interface Forbidden {
  readonly what: string;
  readonly pattern: RegExp;
}

// Each entry names a CLASS of value §3 forbids, with the reason a violation
// matters. The lists are the live system's vocabulary plus the fixture
// vocabulary, because a leak of either would be the same defect.
const FORBIDDEN: readonly Forbidden[] = [
  {
    what: "a persona / reviewer / bot name",
    // Word-ish boundaries, so an ordinary identifier that merely contains one of
    // these as a substring is not a false positive. `cursor` is deliberately
    // ABSENT from this list: it is a legitimate identifier (GraphQL pagination,
    // this file's own scanner) and the reviewer it could name is covered by
    // `bugbot`.
    pattern:
      /(?<![A-Za-z0-9_])(sasuke|tenma|bisky|bugbot|copilot|kisuke|naruto|yamamoto|ichigo|okkotsu|rukia|natsu|kurapika|tanjiro|neferpitou|itachi|kisame|roy-bankai|train-bot)(?![A-Za-z0-9_])/i,
  },
  {
    what: "a label namespace",
    pattern: /(?<![A-Za-z0-9_])(bankai|akatsuki|shikai)\s*:/i,
  },
  {
    what: "the name of a system nen serves",
    // BROADER than the label-namespace rule above, and it caught something the
    // narrower one waved through: an example repository name inside an ERROR
    // MESSAGE (`e.g. --repo ../bankai-core`). Not a value the binary decides
    // with, but a system's name shipped in a string all the same -- and error
    // messages are exactly where such a name survives a value-level sweep.
    pattern: /(?<![A-Za-z0-9_])(bankai|akatsuki|shikai|hatsu|ninjutsu)(?![A-Za-z0-9_])/i,
  },
  {
    what: "a check-name fragment",
    // `<caller job> / <called job>` is the rollup's shape; a literal naming a
    // specific reviewer job is a check name written into the binary.
    pattern: /["'`][^"'`]*\/\s(audit|review|probe|sweep|inspect)\b/i,
  },
  {
    what: "a concrete colour",
    // A six-digit hex after a `#`. The character-class SHAPES the loaders
    // validate against (`/^#[0-9a-fA-F]{6}$/`) are not matched: the character
    // after their `#` is `[`, not a hex digit.
    pattern: /#[0-9a-fA-F]{6}(?![0-9a-fA-F])/,
  },
  {
    what: "a delivery branch-naming convention",
    pattern: /["'`](integration|train|epic)\//i,
  },
];

describe("§3: names are data", () => {
  const files = shippedFiles(SRC);

  it("sweeps a non-trivial number of shipped files", () => {
    // A sweep that silently matched nothing would pass forever. This asserts the
    // walker is actually finding the tree, and that the seeded modules -- the
    // ones the prohibition is aimed at -- are in it.
    expect(files.length).toBeGreaterThan(10);
    const names = files.map((file): string => relative(SRC, file).split(sep).join("/"));
    expect(names).toContain("gates/predicates.ts");
    expect(names).toContain("github/client.ts");
    expect(names).toContain("schema/labels.ts");
  });

  for (const { what, pattern } of FORBIDDEN) {
    it(`finds no hard-coded ${what} in shipped code`, () => {
      const offences: string[] = [];
      for (const file of files) {
        const code = stripComments(readSource(file));
        code.split("\n").forEach((line, index): void => {
          const match = pattern.exec(line);
          if (match === null) return;
          offences.push(
            `${relative(SRC, file).split(sep).join("/")}:${index + 1}: ${match[0]} -- in: ${line.trim()}`,
          );
        });
      }
      expect(offences).toEqual([]);
    });
  }

  it("derives no repository root from import.meta.url", () => {
    // A compiled bun binary's `import.meta.url` is `/$bunfs/...`, which is not a
    // path on any filesystem. The five constants this repo replaced were all
    // computed that way (Akatsuki migration §3); the root now comes from
    // process.cwd() at the call site plus an explicit --repo override.
    const offences: string[] = [];
    for (const file of files) {
      const code = stripComments(readSource(file));
      if (code.includes("import.meta.url")) {
        offences.push(relative(SRC, file).split(sep).join("/"));
      }
    }
    expect(offences).toEqual([]);
  });

  it("spawns no forbidden tool from shipped code (D16)", () => {
    // "no make, no bats/pytest, no runtime python3, no jq/yq anywhere in an
    // executed path". A binary plus git and gh is the whole requirement.
    const pattern = /["'`](make|bats|pytest|python3?|jq|yq)["'`]/;
    const offences: string[] = [];
    for (const file of files) {
      const code = stripComments(readSource(file));
      code.split("\n").forEach((line, index): void => {
        const match = pattern.exec(line);
        if (match !== null) {
          offences.push(`${relative(SRC, file).split(sep).join("/")}:${index + 1}: ${match[0]}`);
        }
      });
    }
    expect(offences).toEqual([]);
  });
});

describe("stripComments", () => {
  // The sweep is only as trustworthy as its scanner, so the scanner has its own
  // cases -- including the two that would make a violation invisible.
  it("removes line and block comments", () => {
    expect(stripComments('const a = 1; // sasuke\n')).toBe("const a = 1; \n");
    expect(stripComments("/* sasuke */const a = 1;")).toBe("const a = 1;");
  });

  it("does NOT remove a `//` inside a string -- that would hide a violation", () => {
    expect(stripComments('const a = "https://x";')).toBe('const a = "https://x";');
    expect(stripComments("const a = `a//b`;")).toBe("const a = `a//b`;");
  });

  it("keeps string contents, which is where a hard-coded name would live", () => {
    expect(stripComments('const a = "sasuke"; // ok')).toBe('const a = "sasuke"; ');
  });

  it("preserves line numbering across a multi-line block comment", () => {
    expect(stripComments("a\n/* x\ny\n*/\nb").split("\n").length).toBe(5);
  });
});
