// src/cli/self-description.test.ts -- what nen says about itself, held to what
// is true (Hatsu SDD plan N5, findings D16 and B10).
//
// WHY. The parts of the self-description outside a test's reach had drifted:
// docs/USAGE.md's headline claimed "the v0.13.0 line" at a 0.25 build; USAGE §
// `nen pr ready` and the verb's own header said it "holds no readiness
// authority" and deferred to a shell gate, from a repository that is not canon
// and no longer carries it, while every caller quotes this verb's verdict as
// the readiness truth; and README cited a CHANGELOG heading the file did not
// carry. Each was a sentence a reader -- or an agent -- acts on.
//
// WHAT THE NAME SWEEP COVERS, AND WHAT IT DELIBERATELY DOES NOT. `bankai-core`
// and `pr_ready_gate` may appear nowhere a caller reads: docs/ and README.md,
// and every executable line of shipped src/. They may still appear in three
// places, each for a reason ../taxonomy-purity.test.ts already states:
//   * a COMMENT in src/ -- the ported predicates cite the incident each branch
//     exists for (the BC-IS-#737 discipline); stripping the citation is how the
//     next maintainer simplifies a predicate back into the bug.
//   * docs/evidence/ -- dated records of runs; rewriting a record falsifies it.
//   * src/shadow/, `*.test.ts` and `fixtures/` -- the port's comparison harness,
//     whose oracle IS that gate, and the vocabulary the tests are about.
// The authority sentences themselves are banned everywhere, comments included.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...walk(path));
    else out.push(path.split(sep).join("/"));
  }
  return out;
}

const NAMES = ["bankai-core", "pr_ready_gate"] as const;

/** The sentences that made the shell gate the authority. */
const AUTHORITY_CLAIMS = [
  /holds no readiness \*?authority/i,
  /the shell gate still does/i,
  /shell gate remains\s+(?:\/\/\s*)?CON-32's authority/i,
  /AUTHORITY, TODAY\. None/,
] as const;

const isTest = (path: string): boolean => /\.test\.ts$|\.testkit\.ts$/.test(path) || path.includes("/fixtures/");
const DOCS = [...walk("docs").filter((path): boolean => !path.startsWith("docs/evidence/") && /\.(md|json|txt)$/.test(path)), "README.md"];
const SHIPPED = walk("src").filter((path): boolean => !isTest(path) && !path.startsWith("src/shadow/") && /\.(ts|json)$/.test(path));

/** A line that is a comment -- `//`, a block comment's `*` line, or its opening `/*`. */
const isCommentLine = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);

describe("nen names no retired gate where a caller reads", () => {
  it("sweeps a non-trivial number of files on both sides", () => {
    expect(DOCS.length).toBeGreaterThan(3);
    expect(SHIPPED.length).toBeGreaterThan(200);
  });

  it("keeps docs/ (outside docs/evidence/) and README.md free of both names", () => {
    const hits: string[] = [];
    for (const path of DOCS) {
      read(path).split("\n").forEach((line, index): void => {
        for (const name of NAMES) if (line.includes(name)) hits.push(`${path}:${String(index + 1)} ${name}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("keeps every executable line of shipped src/ free of both names", () => {
    const hits: string[] = [];
    for (const path of SHIPPED) {
      read(path).split("\n").forEach((line, index): void => {
        if (path.endsWith(".ts") && isCommentLine(line)) return;
        for (const name of NAMES) if (line.includes(name)) hits.push(`${path}:${String(index + 1)} ${name}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("states the shell gate's authority nowhere, comments included", () => {
    const hits: string[] = [];
    for (const path of [...DOCS, ...SHIPPED]) {
      const text = read(path);
      for (const claim of AUTHORITY_CLAIMS) if (claim.test(text)) hits.push(`${path}: ${String(claim)}`);
    }
    expect(hits).toEqual([]);
  });

  it("says nen pr ready is the one producer of the verdict, in USAGE and in the verb", () => {
    expect(read("docs/USAGE.md").replace(/\s+/g, " ")).toContain("It is the one producer of the CON-32 readiness verdict");
    expect(read("src/verbs/pr_ready.ts").replace(/\/\/ ?/g, "").replace(/\s+/g, " ")).toContain("This verb is the one producer of the CON-32 readiness verdict");
  });
});

describe("the headline and the changelog citation are true", () => {
  it("names no release line other than package.json's", () => {
    const version = (JSON.parse(read("package.json")) as { version: string }).version;
    for (const document of ["docs/USAGE.md", "README.md"]) {
      for (const match of read(document).matchAll(/\*\*v(\d+\.\d+\.\d+) line\*\*/g)) {
        expect(match[1], `${document} claims the v${String(match[1])} line`).toBe(version);
      }
    }
  });

  it("cites a CHANGELOG heading the CHANGELOG carries, in its newest version", () => {
    const readme = read("README.md").replace(/\s+/g, " ");
    const cited = /under each version's "([^"]+)"/.exec(readme)?.[1];
    expect(cited, "README cites a per-version CHANGELOG heading").toBeDefined();
    const changelog = read("CHANGELOG.md");
    const newest = changelog.slice(changelog.indexOf("\n## "), changelog.indexOf("\n## ", changelog.indexOf("\n## ") + 1));
    expect(newest).toContain(`\n### ${String(cited)}\n`);
  });
});
