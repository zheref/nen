// src/cli/json-shape.test.ts -- "a verb that emits --json says what shape",
// enforced (zheref/nen#79).
//
// WHY THIS FILE EXISTS. README.md promises "a stable `--json` contract from the
// first release". Twenty-two shapes carry a `contract` field and are versioned;
// the rest are `JSON.stringify` of whatever internal interface the verb happens
// to hold, so the public shape is an accident of the implementation and a
// refactor changes it silently. The FIRST thing #79 asks for is the cheap half
// of the answer: every family's `--json` object documented in its own USAGE
// body, top-level keys and their meaning. This is that, made a build failure
// rather than a good intention.
//
// WHAT IT CANNOT DO, said plainly. It does not run the verbs and diff their
// output against a golden document -- that would need a fixture, a seam and a
// green path for ninety-two verbs, several of which spawn a declared argv from
// a target repository's own file. What it checks is that the DOCUMENT makes a
// claim at all, which is the property that was actually missing: seventeen
// verbs marked `yes` in the index said nothing whatever about their shape.
//
// HOW IT DECIDES WHICH VERBS OWE ONE. docs/USAGE.md's own verb index carries a
// JSON column, `yes` or `no`, per verb. That column is the document's own claim
// about itself, so this reads it rather than keeping a second list -- and the
// row and the section are then held to agreeing.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const USAGE = readFileSync(join(process.cwd(), "docs", "USAGE.md"), "utf8").replace(/\r\n/g, "\n");

/** `| [`family`](#family-x) | [`nen verb`](#…) | … | reads | yes\|no |` */
const INDEX_ROW =
  /^\| \[`([a-z-]+)`\]\(#family-[a-z-]+\) \| \[`nen ([^`]+)`\]\([^)]*\) \|.*?\| (yes|no)[^|]*\|\s*$/gm;

interface IndexRow {
  readonly family: string;
  readonly verb: string;
  readonly json: boolean;
}

const ROWS: readonly IndexRow[] = [...USAGE.matchAll(INDEX_ROW)].map((match): IndexRow => ({
  family: match[1] as string,
  verb: match[2] as string,
  json: match[3] === "yes",
}));

/** Each `### \`nen <verb>\`` section body, by verb. */
const SECTIONS = new Map<string, string>(
  USAGE.split(/^### `nen /m)
    .slice(1)
    .map((section): [string, string] => [section.split("`")[0]?.trim() ?? "", section]),
);

/**
 * Whether a section says what its `--json` document looks like.
 *
 * DELIBERATELY SHAPE-AGNOSTIC about the prose. This file's business is that a
 * claim EXISTS, not that it is phrased one way: the sections that already
 * carried one spell it half a dozen ways ("top-level keys:", "the full
 * `VerifyResult` -- `{ ... }`", "an ARRAY of ...", a fenced block), every one of
 * them a real answer to the reader's question. A rule that demanded one house
 * spelling would be a rule about formatting wearing this one's clothes, and the
 * churn would land on ninety-two sections that are not wrong.
 *
 * What all of them do have within a few hundred characters of the word
 * `--json` is a key listing, a named result type, a pointer to a shared shape,
 * or the word "document". That is the union below.
 */
const CLAIMS_A_SHAPE =
  /`--json`[^\n]{0,400}?(top-level|`\{|:\s*`|shape|the full |document|shared run report|an ARRAY)/s;

describe("every verb that emits --json says what shape it emits", () => {
  it("reads a verb index that is actually there", () => {
    // A sweep whose parser silently matched nothing would pass forever, which
    // is the failure mode this whole file exists to prevent one level down.
    expect(ROWS.length).toBeGreaterThan(80);
    expect(ROWS.filter((row): boolean => row.json).length).toBeGreaterThan(80);
    expect(SECTIONS.size).toBe(ROWS.length);
  });

  it("has a section for every indexed verb, and indexes every section", () => {
    const indexed = ROWS.map((row): string => row.verb).sort();
    const documented = [...SECTIONS.keys()].sort();
    expect(documented).toEqual(indexed);
  });

  it("documents the shape of every verb the index marks `yes`", () => {
    const offences: string[] = [];
    for (const row of ROWS) {
      if (!row.json) continue;
      const section = SECTIONS.get(row.verb) ?? "";
      if (CLAIMS_A_SHAPE.test(section)) continue;
      offences.push(
        `nen ${row.verb}: the verb index says it emits --json, and its section never says what that document contains`,
      );
    }
    expect(offences).toEqual([]);
  });

  it("claims no shape for a verb the index marks `no`", () => {
    // The other direction, and it is not symmetry for its own sake: the three
    // `no` rows are the verbs that hand their stdout to a child or to a
    // subprocess's own stdio, and a documented `--json` shape on one of those
    // would be a promise nen cannot keep.
    const wrong = ROWS.filter(
      (row): boolean => !row.json && /`--json` top-level keys/.test(SECTIONS.get(row.verb) ?? ""),
    );
    expect(wrong.map((row): string => row.verb)).toEqual([]);
  });
});
