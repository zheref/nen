import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { CAPABILITIES } from "./capabilities.js";
import { surfaceCommand } from "./command.js";
import { SURFACES } from "./rules.js";

const SEAMS: Seams = {
  run: (): never => {
    throw new Error("must not be called");
  },
  now: (): Date => new Date("2026-01-01T00:00:00Z"),
  env: {},
  probePort: noPortProbe,
  runInteractive: (): never => {
    throw new Error("no interactive form");
  },
  runStreamed: (): never => {
    throw new Error("no watched form");
  },
  platform: "linux",
};

async function capture(argv: readonly string[], json = false): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l): void => { out.push(l); }, err: (l): void => { err.push(l); } };
  const code = await runFamily(surfaceCommand, argv, null, json, io, SEAMS);
  return { code, out, err };
}

describe("nen surface capabilities (zheref/nen#216)", () => {
  it("answers one surface as data with a citation", async () => {
    const result = await capture(["surface", "capabilities", "--surface", "codex"], true);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as { surface: string; hooks: { stop: string }; ask: string; permissionsFile: string; source: string };
    expect(doc.surface).toBe("codex");
    expect(doc.hooks.stop).toBe("Stop");
    expect(doc.ask).toBe("request_user_input");
    expect(doc.permissionsFile).toMatch(/config\.toml/);
    expect(doc.source).toMatch(/^https:/);
  });

  it("every row names a source and both mirrored surfaces have a Stop hook", () => {
    for (const row of CAPABILITIES) expect(row.source).toMatch(/^https:\/\//);
    expect(CAPABILITIES.find((r): boolean => r.surface === "cursor")?.hooks.stop).toBe("stop");
    expect(CAPABILITIES.map((r): string => r.surface)).toEqual(["claude-code", "codex", "cursor", "antigravity"]);
  });

  it("carries the five facts the mirror rows enforce, and agrees with them (zheref/nen#227)", async () => {
    const result = await capture(["surface", "capabilities", "--surface", "antigravity"], true);
    const doc = JSON.parse(result.out.join("\n")) as {
      hookEvents: string[]; rulesFile: string | null; rulesLimit: number | null; descriptionBudget: number | null; permissionsShape: string | null;
    };
    expect(doc.hookEvents).toEqual(["PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"]);
    expect(doc.rulesFile).toBe(".agents/rules/<name>.md");
    expect(doc.rulesLimit).toBe(12_000);
    expect(doc.permissionsShape).toBeNull();
    for (const row of SURFACES) {
      const facts = CAPABILITIES.find((c): boolean => c.surface === row.surface);
      expect(facts, `no capabilities row for ${row.surface}`).toBeDefined();
      if (facts === undefined) continue;
      expect(facts.permissionsShape).toBe(row.permissions?.shape ?? null);
      expect(facts.rulesLimit).toBe(row.rules?.limit ?? null);
      if (row.hooks !== null) expect(facts.hookEvents).toEqual(row.hooks.known);
      if (row.descriptionBudget !== null) expect(facts.descriptionBudget).toBe(row.descriptionBudget);
    }
    const text = await capture(["surface", "capabilities", "--surface", "cursor"]);
    expect(text.out).toContain("  rules file:       .cursor/rules/<name>.mdc");
    expect(text.out).toContain("  description budget: 30 chars (measured 2026-09-19, not documented (hardening audit))");
    expect(text.out).toContain("  hook events:      sessionStart, sessionEnd, preToolUse, postToolUse, beforeShellExecution, afterShellExecution, afterFileEdit, stop");
  });

  it("lists every surface with no --surface, and refuses an unknown one at 2", async () => {
    const all = await capture(["surface", "capabilities"]);
    expect(all.code).toBe(0);
    expect(all.out.join("\n")).toMatch(/surface: claude-code/);
    expect(all.out.join("\n")).toMatch(/surface: antigravity/);
    const bogus = await capture(["surface", "capabilities", "--surface", "bogus"]);
    expect(bogus.code).toBe(2);
    expect(bogus.err.join("\n")).toMatch(/unknown surface 'bogus'.*claude-code, codex, cursor, antigravity/);
  });
});
