// src/exits/exits.test.ts -- docs/USAGE.md's exit table IS `nen exits`, row for
// row (Hatsu SDD plan N5, finding B3).
//
// THE SHAPE OF ../cli/json-shape.test.ts: the document's own table is read
// rather than a second list kept here, and held to what the binary emits. A
// family that gains a code above 2 states it on its `Command` and adds the row
// to USAGE in the same change, or this fails naming the pair that is missing
// on one side.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { COMMANDS } from "../cli/registry.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { EXITS_CONTRACT, exitsCommand, exitTable, OUTSIDE_REGISTRY, type ExitsReport } from "./command.js";

const USAGE = readFileSync(join(process.cwd(), "docs", "USAGE.md"), "utf8").replace(/\r\n/g, "\n");

/** `verb code` pairs, the unit both sides are compared in. */
function pair(verb: string, code: number): string {
  return `${verb} ${String(code)}`;
}

/** The verbs one cell of the table's first column names. */
function cellVerbs(cell: string): string[] {
  const names = [...cell.matchAll(/`([^`]+)`/g)].map((match): string => match[1] as string);
  // "every [`shu`](#family-shu) verb" -- every verb of the family.
  if (/^\s*every\b/.test(cell)) return [`${names[0] ?? ""} *`];
  return names.map((name): string => {
    const words: string[] = [];
    for (const word of name.split(/\s+/)) {
      if (word.startsWith("-") || word.includes("|")) break;
      words.push(word);
    }
    return words.join(" ");
  });
}

/** The codes one cell of the table's second column names; `3`–`7` is a range. */
function cellCodes(cell: string): number[] {
  const range = /`(\d+)`\s*[–-]\s*`(\d+)`/.exec(cell);
  if (range !== null) {
    const codes: number[] = [];
    for (let code = Number(range[1]); code <= Number(range[2]); code += 1) codes.push(code);
    return codes;
  }
  return [...cell.matchAll(/`(\d+)`/g)].map((match): number => Number(match[1]));
}

function documentedPairs(): Set<string> {
  const begin = USAGE.indexOf("<!-- exits:begin -->");
  const end = USAGE.indexOf("<!-- exits:end -->");
  expect(begin, "USAGE carries the exits:begin marker").toBeGreaterThan(0);
  expect(end, "USAGE carries the exits:end marker").toBeGreaterThan(begin);
  const pairs = new Set<string>();
  const rows = USAGE.slice(begin, end).split("\n").filter((line): boolean => line.startsWith("| ") && !line.startsWith("| Verb") && !line.startsWith("|---"));
  for (const row of rows) {
    const cells = row.split(/(?<!\\)\|/).slice(1, -1);
    const verbs = cellVerbs(cells[0] ?? "");
    const codes = cellCodes(cells[1] ?? "");
    expect(verbs.length, `a row names no verb: ${row.slice(0, 80)}`).toBeGreaterThan(0);
    expect(codes.length, `a row names no code: ${row.slice(0, 80)}`).toBeGreaterThan(0);
    for (const verb of verbs) for (const code of codes) pairs.add(pair(verb, code));
  }
  return pairs;
}

async function run(argv: readonly string[], json: boolean): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => { out.push(line); }, err: (line): void => { err.push(line); } };
  const code = await runFamily(exitsCommand, ["exits", ...argv], null, json, io, new ScriptedSeams([]));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("USAGE's exit table is the registry's", () => {
  it("names exactly the verb/code pairs the binary states, no more and no fewer", () => {
    const documented = documentedPairs();
    const emitted = new Set(exitTable().map((row): string => pair(row.verb, row.code)));
    expect([...documented].filter((entry): boolean => !emitted.has(entry)), "in USAGE, not in any family's exits").toEqual([]);
    expect([...emitted].filter((entry): boolean => !documented.has(entry)), "in a family's exits, not in USAGE").toEqual([]);
    expect(documented.size).toBeGreaterThan(30);
  });

  it("parses the table's cell spellings", () => {
    expect(cellVerbs("every [`shu`](#family-shu) verb")).toEqual(["shu *"]);
    expect(cellVerbs("[`pr threads reply\\|settle`](#nen-pr-threads), `release-publish`")).toEqual(["pr threads", "release-publish"]);
    expect(cellVerbs("[`surface mirror check --plugin`](#x)")).toEqual(["surface mirror check"]);
    expect(cellCodes(" `3`–`7` ")).toEqual([3, 4, 5, 6, 7]);
    expect(cellCodes(" `3` / `5` ")).toEqual([3, 5]);
  });

  it("states only codes above the shared scheme, each on a verb this binary has", () => {
    for (const command of COMMANDS) {
      for (const row of command.exits ?? []) {
        expect(row.code, `${row.verb} restates a shared code`).toBeGreaterThan(2);
        expect(row.meaning.trim(), `${row.verb} ${String(row.code)} has no meaning`).not.toBe("");
        const [family, verb] = row.verb.split(" ");
        expect(family, `${row.verb} is stated by the '${command.name}' family`).toBe(command.name);
        if (verb !== "*" && command.subcommands !== undefined) {
          expect(command.subcommands, `${row.verb} names no subcommand of '${command.name}'`).toContain(verb);
        }
      }
    }
    for (const row of OUTSIDE_REGISTRY) expect(row.code).toBeGreaterThan(2);
  });
});

describe("nen exits", () => {
  it("prints the scheme and every row under --json", async () => {
    const result = await run([], true);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out) as ExitsReport;
    expect(report.contract).toBe(EXITS_CONTRACT);
    expect(report.filter).toBeNull();
    expect(report.scheme.map((row): number => row.code)).toEqual([0, 1, 2]);
    expect(report.verbs).toEqual(exitTable());
  });

  it("narrows to one verb, keeping the family's shared rows", async () => {
    const merge = JSON.parse((await run(["pr", "merge"], true)).out) as ExitsReport;
    expect(merge.filter).toBe("pr merge");
    expect(merge.verbs.map((row): number => row.code)).toEqual([5, 6, 7]);
    const coverage = JSON.parse((await run(["shu", "coverage"], true)).out) as ExitsReport;
    expect(coverage.verbs.map((row): string => pair(row.verb, row.code))).toEqual(["shu * 3", "shu * 4", "shu * 5", "shu coverage 6", "shu coverage 8"]);
    const mirror = JSON.parse((await run(["surface", "mirror"], true)).out) as ExitsReport;
    expect(mirror.verbs.map((row): number => row.code)).toEqual([3, 4, 5]);
  });

  it("says a verb with no row of its own returns only the scheme", async () => {
    const result = await run(["labels", "sync"], false);
    expect(result.code).toBe(0);
    expect(result.out).toContain("above 2: none");
  });

  it("refuses an unknown family and a third positional at exit 2", async () => {
    expect((await run(["bogus"], false)).code).toBe(2);
    expect((await run(["pr", "merge", "extra"], false)).code).toBe(2);
    expect((await run(["bootstrap"], true)).code).toBe(0);
  });
});
