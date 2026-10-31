// src/shu/typecheck.test.ts -- `nen shu typecheck` (zheref/nen#588), driven
// through the REAL dispatch (../index.ts's runFamily), exactly as ./run.test.ts
// drives the other executing verbs.
//
// THE VERB OWNS NO BEHAVIOUR OF ITS OWN, and these tests pin that it needs
// none: a declared `typecheck` row runs through the same executor as `lint`,
// per lane, exiting with the declared command's status (AC-1), and a lane that
// declares none is refused at exit 4 naming the exact nen/contract.json pointer
// that would declare it (AC-2). No live toolchain: every subprocess is a
// ScriptedSeams entry, which throws on a call nobody scripted.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { EXECUTING_VERBS, SHU_SUBCOMMANDS, shuCommand } from "./command.js";
import { STALL_GUARDED_VERBS } from "./render.js";

interface Captured {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly spawned: readonly string[];
}

/** Two lanes, each with its own checker, plus one that declares none. */
const PROJECT = {
  lanes: {
    web: { stack: "nextjs", cwd: "apps/web" },
    admin: { stack: "nextjs", cwd: "apps/admin" },
    docs: { stack: "gatsby", cwd: "apps/docs" },
  },
  defaultLane: "web",
  verbs: {
    web: {
      build: { exe: "pnpm", argv: ["build"] },
      typecheck: { exe: "pnpm", argv: ["exec", "tsc", "--noEmit"], why: "the web lane's own check" },
    },
    admin: {
      typecheck: {
        steps: [
          { exe: "pnpm", argv: ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"] },
          { exe: "pnpm", argv: ["exec", "tsc", "--noEmit", "-p", "tsconfig.test.json"] },
        ],
      },
    },
    docs: {
      build: { exe: "gatsby", argv: ["build"] },
      lint: { unsupported: "no linter in this tree" },
    },
  },
};

async function run(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  project: unknown = PROJECT,
): Promise<Captured> {
  const dir = mkdtempSync(join(tmpdir(), "nen-shu-typecheck-"));
  try {
    mkdirSync(join(dir, "nen"));
    for (const cwd of ["apps/web", "apps/admin", "apps/docs"]) mkdirSync(join(dir, cwd), { recursive: true });
    writeFileSync(join(dir, "nen", "contract.json"), JSON.stringify({ $schema: "nen.contract/v0.1", project }));
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const seams = new ScriptedSeams(script, {
      env: {},
      platform: "linux",
      now: (): Date => new Date(Date.UTC(2026, 0, 1)),
    });
    const code = await runFamily(shuCommand, ["shu", ...argv], dir, false, io, seams);
    const spawned = seams.calls
      .filter((call): boolean => call.command !== "git")
      .map((call): string => [call.command, ...call.args].join(" "));
    return { code, out, err, spawned };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("nen shu typecheck -- registration", () => {
  it("is a verb of the family, right after lint, and one that executes a declared row", () => {
    expect(SHU_SUBCOMMANDS.indexOf("typecheck")).toBe(SHU_SUBCOMMANDS.indexOf("lint") + 1);
    expect(EXECUTING_VERBS).toContain("typecheck");
  });

  it("is stall-guardable, like every other verb whose output nen reads", () => {
    expect(STALL_GUARDED_VERBS).toContain("typecheck");
  });

  it("is named in the family's usage", () => {
    expect(shuCommand.usage).toMatch(/typecheck {3}Run the lane's static type check/);
  });
});

describe("nen shu typecheck -- AC-1: a declared row runs and its status is the exit", () => {
  it("runs the default lane's declared command and exits 0 when it passes", async () => {
    const result = await run(["typecheck"], [{ match: "pnpm exec tsc --noEmit", result: { code: 0 } }]);
    expect(result.code).toBe(0);
    expect(result.spawned).toEqual(["pnpm exec tsc --noEmit"]);
  });

  it("exits 1, naming the step, when the checker reports type errors", async () => {
    const result = await run(["typecheck"], [{ match: "pnpm exec tsc --noEmit", result: { code: 2 } }]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/step 1 of 1 failed: pnpm exec tsc --noEmit -- exited 2/);
  });

  it("runs per lane: --lane picks the lane's own row, multi-step form included", async () => {
    const result = await run(
      ["typecheck", "--lane", "admin"],
      [
        { match: "pnpm exec tsc --noEmit -p tsconfig.json", result: { code: 0 } },
        { match: "pnpm exec tsc --noEmit -p tsconfig.test.json", result: { code: 0 } },
      ],
    );
    expect(result.code).toBe(0);
    expect(result.spawned).toEqual([
      "pnpm exec tsc --noEmit -p tsconfig.json",
      "pnpm exec tsc --noEmit -p tsconfig.test.json",
    ]);
  });

  it("stops a multi-step row at the failing step", async () => {
    const result = await run(
      ["typecheck", "--lane", "admin"],
      [{ match: "pnpm exec tsc --noEmit -p tsconfig.json", result: { code: 1 } }],
    );
    expect(result.code).toBe(1);
    expect(result.spawned).toEqual(["pnpm exec tsc --noEmit -p tsconfig.json"]);
  });

  it("--dry-run prints the plan and spawns nothing", async () => {
    const result = await run(["typecheck", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.spawned).toEqual([]);
    expect(result.out.join("\n")).toMatch(/would run:\s+pnpm exec tsc --noEmit/);
  });

  it("--json carries the verb's own contract name", async () => {
    const result = await run(["typecheck", "--dry-run", "--json"]);
    const report = JSON.parse(result.out.join("\n")) as { contract: string; lane: string };
    expect(report.contract).toBe("nen.shu.typecheck/v0.1");
    expect(report.lane).toBe("web");
  });
});

describe("nen shu typecheck -- AC-2: no declaration is a refusal naming the missing pointer", () => {
  it("exits 4 on a lane with no typecheck row, naming project.verbs.<lane>.typecheck in nen/contract.json", async () => {
    const result = await run(["typecheck", "--lane", "docs"]);
    expect(result.code).toBe(4);
    const err = result.err.join("\n");
    expect(err).toMatch(/lane 'docs' \(gatsby\) declares no 'typecheck'/);
    expect(err).toContain("nen/contract.json at project.verbs.docs.typecheck");
    expect(result.spawned).toEqual([]);
  });

  it("refuses the same way under --dry-run, before any plan is printed", async () => {
    const result = await run(["typecheck", "--lane", "docs", "--dry-run"]);
    expect(result.code).toBe(4);
    expect(result.err.join("\n")).toContain("project.verbs.docs.typecheck");
  });

  it("exits 4 with the declaration's own reason on an unsupported seat", async () => {
    const project = {
      ...PROJECT,
      verbs: { ...PROJECT.verbs, docs: { typecheck: { unsupported: "plain JavaScript; there are no types to check" } } },
    };
    const result = await run(["typecheck", "--lane", "docs"], [], project);
    expect(result.code).toBe(4);
    expect(result.err.join("\n")).toMatch(/'typecheck' is unsupported on lane 'docs'.*plain JavaScript/);
  });
});
