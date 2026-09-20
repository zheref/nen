// src/cli/subcommands.test.ts -- every family that dispatches through
// requireSubcommand declares `subcommands`, and the declaration matches the
// list it dispatches on. Without this, `nen <family> bogus --help` exits 0 for
// a subcommand that does not exist, and a presence probe by --help passes for
// a verb nobody shipped (Copilot review on zheref/nen#217).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "./registry.js";
import { runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";

const SEAMS: Seams = {
  run: (): never => { throw new Error("must not be called"); },
  now: (): Date => new Date("2026-01-01T00:00:00Z"),
  env: {},
  probePort: noPortProbe,
  runInteractive: (): never => { throw new Error("no interactive form"); },
  runStreamed: (): never => { throw new Error("no watched form"); },
  platform: "linux",
};

/** Families whose first positional is a file or a token, not a subcommand. */
const POSITIONAL_FAMILIES = new Set(["stop"]);

describe("every dispatching family declares its subcommands", () => {
  for (const command of COMMANDS) {
    const source = readFileSync(join(process.cwd(), "src", command.name === "parse" ? "grammar" : command.name, "command.ts"), "utf8");
    const dispatches = new RegExp(`requireSubcommand\\("${command.name}", context\\.args, (\\[[^\\]]*\\]|[A-Z_]+)\\)`, "s").exec(source);
    if (dispatches === null) continue;
    it(`nen ${command.name} declares the list it dispatches on`, () => {
      expect(command.subcommands, `${command.name} calls requireSubcommand but declares no subcommands`).toBeDefined();
      const list = dispatches[1] as string;
      if (list.startsWith("[")) {
        const literal = [...list.matchAll(/"([^"]+)"/g)].map((m): string => m[1] as string);
        expect([...(command.subcommands as readonly string[])]).toEqual(literal);
      } else {
        expect((command.subcommands as readonly string[]).length).toBeGreaterThan(0);
      }
    });
    it(`nen ${command.name} definitely-bogus --help exits 2`, async () => {
      const err: string[] = [];
      const io: Io = { out: (): void => {}, err: (l): void => { err.push(l); } };
      const code = await runFamily(command, [command.name, "definitely-bogus", "--help"], null, false, io, SEAMS);
      expect(code, err.join("\n")).toBe(2);
    });
  }
  it("the positional families are the only ones without a declaration", () => {
    for (const command of COMMANDS) {
      if (command.subcommands === undefined) expect(POSITIONAL_FAMILIES.has(command.name) || !/requireSubcommand\(/.test(readFileSync(join(process.cwd(), "src", command.name === "parse" ? "grammar" : command.name, "command.ts"), "utf8")), `${command.name} has no subcommands declaration`).toBe(true);
    }
  });
});
