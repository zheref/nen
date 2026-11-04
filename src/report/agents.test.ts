import { runFamily } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { reportCommand } from "./command.js";
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentSpecs } from "./agents.js";
describe("declared agent spec metadata", () => {
  it("refuses an explicitly empty directory through the public command", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-agent-empty-"));
    try { expect(await runFamily(reportCommand, ["report", "data", "--base", "HEAD", "--agents-dir", ""], root, false, { out: () => {}, err: () => {} }, defaultSeams())).toBe(2); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("reads the selected nested directory, never a legacy sibling, and refuses links", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-agents-"));
    try {
      mkdirSync(join(root, "claude/agents"), { recursive: true }); mkdirSync(join(root, "agents"));
      writeFileSync(join(root, "claude/agents/actor.md"), "declared spec"); writeFileSync(join(root, "agents/legacy.md"), "wrong");
      expect(readAgentSpecs(root, "claude/agents")).toEqual([{ name: "actor", path: "claude/agents/actor.md", bytes: 13, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
      symlinkSync(join(root, "agents/legacy.md"), join(root, "claude/agents/linked.md"));
      expect(() => readAgentSpecs(root, "claude/agents")).toThrow(/redirected/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
