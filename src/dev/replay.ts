// src/dev/replay.ts -- `nen dev replay`: replays the imported dedupe corpus
// slice (tests/fixtures/dualrun-slice/) against nen's OWN equivalent logic.
//
// THE COMPARISON IS THE VERDICT, NEVER THE SHELL'S EXACT STDOUT. A fixture
// records what `dedupe_handbook_questions.sh` printed and which `gh` calls it
// made -- list, then (on a duplicate) close and comment. nen's absorbed logic
// (../issue/search.ts's normalizeTitle/findCanonical) only ever DETECTS; it
// never closes or comments an issue -- that stays a human/LLM decision
// (issue #4's own "stays with the LLM" list). So this module extracts the
// DECISION each fixture's recorded stdout encodes -- "#N is canonical" or "#N
// closed as a duplicate of #M" -- from its text, and compares that decision
// against `findCanonical`'s own answer over the fixture's recorded candidate
// list. Replaying the close/comment mechanics themselves would be comparing
// a script nen does not have against one it was never meant to be.
//
// THE CANDIDATE LIST COMES FROM THE FIXTURE'S RECORDED SUBPROCESS OUTPUT, not
// from a live `gh` call -- a replay must never reach the network, and the
// fixture already pins exactly what `gh issue list` answered when it was
// recorded. Only fixtures whose subprocess stdout is a well-formed TSV of
// `number\ttitle` rows (no embedded quirk the shell's own text-parsing
// depended on -- see tests/fixtures/dualrun-slice/MANIFEST.json for which
// fixtures that excludes and why) are in the imported slice at all.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findCanonical, type Candidate } from "../issue/search.js";

export interface DedupeFixture {
  readonly id: string;
  readonly newNumber: number;
  readonly newTitle: string;
  readonly candidates: readonly Candidate[];
  /** null: the fixture's recorded verdict was "canonical, no-op". A number: "closed as a duplicate of #<n>". */
  readonly expectedCanonicalOf: number | null;
}

export class ReplayFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayFixtureError";
  }
}

const DUPLICATE_OF = /closed as a duplicate of #\s*(\d+)\.\n?$/;
const CANONICAL = /is canonical \(no older open duplicate\) — no-op\.\n?$/;

// Raw `number\ttitle` lines, gh's own `-q '... | @tsv'` shape, exactly as
// recorded in the fixture's one `gh issue list` subprocess entry.
function parseTsvCandidates(tsv: string): readonly Candidate[] {
  return tsv
    .split("\n")
    .filter((line): boolean => line !== "")
    .map((line): Candidate => {
      const tab = line.indexOf("\t");
      if (tab === -1) throw new ReplayFixtureError(`malformed TSV row (no tab): '${line}'`);
      return { number: Number(line.slice(0, tab)), title: line.slice(tab + 1) };
    });
}

export function parseDedupeFixture(raw: unknown, id: string): DedupeFixture {
  const record = raw as Record<string, unknown>;
  const env = record["env"] as Record<string, unknown> | undefined;
  if (env === undefined) throw new ReplayFixtureError(`${id}: no 'env' field`);
  const newNumber = Number(env["NUMBER"]);
  const newTitle = String(env["TITLE"] ?? "");
  if (!Number.isInteger(newNumber)) throw new ReplayFixtureError(`${id}: env.NUMBER is not an integer`);

  const subprocess = record["subprocess"];
  if (!Array.isArray(subprocess) || subprocess.length === 0) {
    throw new ReplayFixtureError(`${id}: no subprocess calls recorded`);
  }
  const listing = subprocess[0] as Record<string, unknown>;
  const candidates = parseTsvCandidates(String(listing["stdout"] ?? ""));

  const recorded = record["recorded"] as Record<string, unknown> | undefined;
  const stdout = String(recorded?.["stdout"] ?? "");
  const duplicateMatch = DUPLICATE_OF.exec(stdout);
  const canonicalMatch = CANONICAL.exec(stdout);
  if (duplicateMatch?.[1] !== undefined) {
    return { id, newNumber, newTitle, candidates, expectedCanonicalOf: Number(duplicateMatch[1]) };
  }
  if (canonicalMatch !== null) {
    return { id, newNumber, newTitle, candidates, expectedCanonicalOf: null };
  }
  throw new ReplayFixtureError(`${id}: recorded stdout matches neither the canonical nor the duplicate-of pattern: '${stdout}'`);
}

export function loadDedupeFixtures(sliceDir: string): readonly DedupeFixture[] {
  let names: readonly string[];
  try {
    names = readdirSync(sliceDir);
  } catch (error) {
    // A MISSING DIRECTORY GETS A LOCATED, ACTIONABLE REFUSAL, not node's raw
    // ENOENT -- the same discipline ../dev/test.ts applies to "no
    // package.json here".
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ReplayFixtureError(
        `no such directory '${sliceDir}'. 'nen dev replay' replays the imported corpus slice against nen's own logic -- point --slice-dir at a real one (default: tests/fixtures/dualrun-slice/dedupe under the repo root).`,
      );
    }
    throw error;
  }
  return names
    .filter((name): boolean => name.endsWith(".json"))
    .sort()
    .map((name): DedupeFixture => {
      const id = name.replace(/\.json$/, "");
      const text = readFileSync(join(sliceDir, name), "utf8").replace(/\r\n/g, "\n");
      return parseDedupeFixture(JSON.parse(text), id);
    });
}

export interface ReplayOutcome {
  readonly id: string;
  readonly ok: boolean;
  readonly expected: number | null;
  readonly actual: number | null;
}

export function replayDedupeFixture(fixture: DedupeFixture): ReplayOutcome {
  const actual = findCanonical(fixture.newNumber, fixture.newTitle, fixture.candidates);
  return { id: fixture.id, ok: actual === fixture.expectedCanonicalOf, expected: fixture.expectedCanonicalOf, actual };
}

export interface ReplayReport {
  readonly total: number;
  readonly passed: readonly string[];
  readonly failed: readonly ReplayOutcome[];
  /** Set when the slice itself is unusable (empty) -- see below. Never set alongside a non-empty total. */
  readonly error: string | null;
}

export function replayDedupeSlice(sliceDir: string): ReplayReport {
  const fixtures = loadDedupeFixtures(sliceDir);
  if (fixtures.length === 0) {
    // A ZERO-FIXTURE SLICE IS NOT A GREEN REGRESSION RUN. An empty directory
    // (or one --slice-dir pointed at by mistake) reported "0 passed, 0
    // failed" with exit 0 before this guard -- satisfiable by exactly the
    // evidence this verb exists to produce, with none of it actually run.
    return {
      total: 0,
      passed: [],
      failed: [],
      error: `${sliceDir} contains no fixtures. A replay of nothing is not a green regression run -- check --slice-dir.`,
    };
  }
  const outcomes = fixtures.map(replayDedupeFixture);
  return {
    total: outcomes.length,
    passed: outcomes.filter((o): boolean => o.ok).map((o): string => o.id),
    failed: outcomes.filter((o): boolean => !o.ok),
    error: null,
  };
}
