// src/cli/dry-run-table.test.ts -- docs/USAGE.md's `--dry-run` discipline
// table, held to the registry (Hatsu SDD plan N6, finding D6).
//
// WHY THIS FILE EXISTS. USAGE says "every mutating verb can be asked to show
// what it would do and do nothing", and until N6 its own table carried a row
// whose flag column was "—": `pr retarget`, `pr cascade-main` and `run
// rerun-failed` had no preview at all. A promise kept in prose and broken in
// a table row is a promise nobody can tell is broken, so this reads the table
// and the registry (./registry.ts) and fails when they disagree:
//
//   * every row names its flag -- a "—" (no preview form) is a failure;
//   * every verb a row names is a family in COMMANDS, and its subcommand one
//     the family declares -- or `schema set`, the one pre-registry verb with a
//     preview (../index.ts dispatches it by hand), held to its own flag spec;
//   * the flag the row names is one the family's parser accepts -- and for
//     `pr`, whose flags are declared PER SUBCOMMAND (../pr/command.ts's
//     PR_SUBCOMMAND_FLAGS, #351), one THAT subcommand reads.
//
// WHAT IT CANNOT DO, said plainly. It holds the verbs the table names; it does
// not discover a mutating verb the table forgot (izanami's table classifies
// mutating rows that carry no preview by design, e.g. `phase begin`, `commit
// write`). And it checks that the flag is ACCEPTED, not what the dry form does
// -- each verb's own tests pin that it spawns nothing; the three N6 rows are
// run here too, with a seam that throws on any spawn.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, findCommand } from "./registry.js";
import { PR_SUBCOMMAND_FLAGS } from "../pr/command.js";
import { SCHEMA_SET_FLAGS } from "../schema/set.js";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";

const USAGE = readFileSync(join(process.cwd(), "docs", "USAGE.md"), "utf8").replace(/\r\n/g, "\n");

interface Row {
  readonly verbs: readonly string[];
  readonly flag: string;
  readonly line: string;
}

function tableRows(): readonly Row[] {
  const start = USAGE.indexOf("### `--dry-run` discipline");
  expect(start).toBeGreaterThan(-1);
  const after = USAGE.slice(start).split("\n");
  const rows: Row[] = [];
  let inTable = false;
  for (const line of after.slice(1)) {
    if (line.startsWith("| Verb |")) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith("|")) break;
    if (line.startsWith("|---")) continue;
    const cells = line.split(" | ");
    const verbs = [...(cells[0] ?? "").matchAll(/\[`([^`]+)`\]/g)].map((match): string => (match[1] as string).split(" --")[0] as string);
    rows.push({ verbs, flag: (cells[2] ?? "").trim(), line });
  }
  return rows;
}

describe("USAGE's --dry-run discipline table, held to the registry (N6)", () => {
  const rows = tableRows();

  it("is read whole", () => {
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) expect(row.verbs.length, row.line).toBeGreaterThan(0);
  });

  it("names a preview flag on every row -- no verb is left without one", () => {
    for (const row of rows) expect(row.flag, row.line).toMatch(/^`--[a-z-]+`$/);
  });

  it("names only registered verbs, and each accepts the flag its row names", () => {
    for (const row of rows) {
      const flag = row.flag.replace(/`/g, "").slice(2);
      for (const verb of row.verbs) {
        const [family, subcommand] = verb.split(" ");
        if (verb === "schema set") {
          expect([...SCHEMA_SET_FLAGS.booleans] as string[], `${verb}: does not read --${flag}`).toContain(flag);
          continue;
        }
        const command = findCommand(family as string);
        expect(command, `${verb}: no family '${family}' in COMMANDS`).toBeDefined();
        if (command === undefined) continue;
        // A family whose first positional is not always a subcommand (`stop`,
        // whose bare form takes a file) declares none; its parser is the check.
        if (subcommand !== undefined && command.subcommands !== undefined) expect(command.subcommands, `${verb}: '${family}' declares no '${subcommand}'`).toContain(subcommand);
        const spec = command.flags;
        const accepted = [...(spec.values ?? []), ...(spec.booleans ?? []), ...(spec.lists ?? [])];
        expect(accepted, `${verb}: '${family}' accepts no --${flag}`).toContain(flag);
        if (family === "pr" && subcommand !== undefined) {
          const own = PR_SUBCOMMAND_FLAGS[subcommand];
          const reads = [...(own?.values ?? []), ...(own?.booleans ?? []), ...(own?.lists ?? [])];
          expect(reads, `${verb}: 'pr ${subcommand}' does not read --${flag}`).toContain(flag);
        }
      }
    }
    expect(COMMANDS.length).toBeGreaterThan(0);
  });

  it("the three N6 rows preview without spawning anything", async () => {
    const cases: readonly (readonly string[])[] = [
      ["pr", "retarget", "--target", "o/n", "--pr", "3", "--base", "main", "--dry-run"],
      ["pr", "cascade-main", "--repo", process.cwd(), "--dry-run"],
      ["run", "rerun-failed", "--target", "o/n", "--run-id", "9", "--dry-run"],
    ];
    for (const argv of cases) {
      const out: string[] = [];
      const err: string[] = [];
      const io: Io = { out: (line): void => { out.push(line); }, err: (line): void => { err.push(line); } };
      const seams = new ScriptedSeams([]);
      const command = findCommand(argv[0] as string);
      if (command === undefined) throw new Error(`no ${argv[0]}`);
      const code = await runFamily(command, argv, process.cwd(), false, io, seams);
      expect(code, `${argv.join(" ")}: ${err.join(" ")}`).toBe(0);
      expect(seams.calls, argv.join(" ")).toEqual([]);
      expect(out.join("\n")).toMatch(/^would run: /m);
    }
  });
});
