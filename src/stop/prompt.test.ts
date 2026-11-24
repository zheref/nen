import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { defaultSeams } from "../seam/exec.js";
import { runFamily } from "../index.js";
import { stopCommand } from "./command.js";
import { readPrompt, recordPrompt } from "./prompt.js";
import { markerForBranch, effortsFromRun } from "../loop/fromrun.js";

import { RUN_CONTRACT } from "../run/manifest.js";
import { computeSlots } from "../loop/slots.js";

describe("durable explicit prompt receipts", () => {
  it("survives attention-marker consumption and refuses foreign identities and edited evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-prompt-"));
    const seams = defaultSeams();
    const identity = { effort: "effort", pr: 7, head: "a".repeat(40), gate: "G4" };
    try {
      execFileSync("git", ["-C", root, "init", "-q"]);
      const io = { out: (): void => {}, err: (): void => {} };
      expect(await runFamily(stopCommand, ["stop", "--who", "tester", "--gate", "G4", "--effort", "effort", "--mark"], root, false, io, seams)).toBe(0);
      expect(readPrompt(seams, root, identity).ok).toBe(false);
      expect(await runFamily(stopCommand, ["stop", "--prompt-shown", "--effort", "effort", "--pr", "7", "--head", identity.head, "--gate", "G4"], root, false, io, seams)).toBe(0);
      const path = recordPrompt(seams, root, identity);
      const receipt = JSON.parse(readFileSync(path, "utf8"));
      expect(receipt.contract).toBe("nen.stop.prompt/v0.1");
      expect(await runFamily(stopCommand, ["stop", "clear", "--gate", "G4", "--effort", "effort"], root, false, io, seams)).toBe(0);
      const built = await effortsFromRun({ contract: RUN_CONTRACT, id: "run", repo: "owner/repo", startedAt: new Date().toISOString(), idleAnswers: null, parked: [], prs: [{ issue: "NN#1", pr: 7, base: "main", branch: "branch", kind: "delivery", head: identity.head, effort: identity.effort, recordedAt: new Date().toISOString() }] }, {
        promptGate: "G4", readPr: () => ({ ok: true, pr: { state: "open", base: "main", headRef: "branch", head: identity.head, createdAt: null } }), readiness: async () => ({ ok: true, ready: true }), marker: (branch, proof) => markerForBranch(seams, root, branch, proof),
      });
      expect(built.efforts[0]?.prompted).toBe(true);
      expect(computeSlots(built.efforts, { local: 2, ci: 2 }).local.occupied).toBe(0);
      expect(markerForBranch(seams, root, "branch", identity)).toMatchObject({ ok: true, present: true });
      for (const changed of [{ effort: "foreign" }, { pr: 8 }, { head: "b".repeat(40) }, { gate: "G2" }]) expect(readPrompt(seams, root, { ...identity, ...changed }).ok).toBe(false);
      for (const contract of [undefined, "nen.stop.prompt/v0.9"]) {
        writeFileSync(path, JSON.stringify({ ...receipt, contract }));
        expect(readPrompt(seams, root, identity)).toMatchObject({ ok: false, reason: expect.stringContaining("malformed") });
      }
      rmSync(path); symlinkSync(join(root, "missing"), path);
      expect(readPrompt(seams, root, identity)).toMatchObject({ ok: false, reason: expect.stringContaining("redirected") });
      rmSync(path); writeFileSync(path, "{}"); expect(readPrompt(seams, root, identity).ok).toBe(false);
      expect(() => recordPrompt(seams, root, identity)).toThrow(/malformed/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("reads and records receipts in the selected repository despite foreign Git environment", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-prompt-target-"));
    const foreign = mkdtempSync(join(tmpdir(), "nen-prompt-foreign-"));
    const seams = defaultSeams();
    const identity = { effort: "effort", pr: 7, head: "a".repeat(40), gate: "G4" };
    try {
      for (const repo of [root, foreign]) execFileSync("git", ["-C", repo, "init", "-q"]);
      vi.stubEnv("GIT_DIR", join(foreign, ".git"));
      vi.stubEnv("GIT_COMMON_DIR", join(foreign, ".git"));
      vi.stubEnv("GIT_WORK_TREE", foreign);
      const path = recordPrompt(seams, root, identity);
      expect(path).toBe(join(root, ".git", ".nen", "prompts", "effort", "7-" + identity.head + "-G4.json"));
      expect(readPrompt(seams, root, identity)).toMatchObject({ ok: true, where: path });
      expect(readPrompt(seams, foreign, identity)).toMatchObject({ ok: false });
    } finally {
      vi.unstubAllEnvs();
      for (const repo of [root, foreign]) rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each([["0", "a".repeat(40), "G4"], ["7", "abcdef1", "G4"], ["7", "a".repeat(40), "G3"]])(
    "returns a usage error for invalid prompt identity %s %s %s",
    async (pr, head, gate) => {
      const root = mkdtempSync(join(tmpdir(), "nen-prompt-identity-"));
      try {
        const io = { out: (): void => {}, err: (): void => {} };
        const args = ["stop", "--prompt-shown", "--effort", "effort", "--pr", pr, "--head", head, "--gate", gate];
        expect(await runFamily(stopCommand, args, root, false, io, defaultSeams())).toBe(2);
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it.each([{ extra: ["clear"] }, { extra: ["--mark"] }, { extra: ["--all"] }, { extra: ["--who", "ignored"] }])("refuses conflicting public form $extra without writing", async ({ extra }) => {
    const root = mkdtempSync(join(tmpdir(), "nen-prompt-refuse-"));
    try {
      execFileSync("git", ["-C", root, "init", "-q"]);
      const code = await runFamily(stopCommand, ["stop", "--prompt-shown", "--effort", "effort", "--pr", "7", "--head", "a".repeat(40), "--gate", "G4", ...extra], root, false, { out: () => {}, err: () => {} }, defaultSeams());
      expect(code).toBe(2);
      expect(readPrompt(defaultSeams(), root, { effort: "effort", pr: 7, head: "a".repeat(40), gate: "G4" }).ok).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

});
