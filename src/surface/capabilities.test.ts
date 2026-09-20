import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { CAPABILITIES } from "./capabilities.js";
import { surfaceCommand } from "./command.js";

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
