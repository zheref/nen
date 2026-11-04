import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runFamily } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { performSquash } from "./squash.js";
import { renderCommand } from "./mechanical.js";
import { wcCommand } from "./command.js";

const git = (root: string, ...argv: string[]): string => execFileSync("git", ["-C", root, ...argv], { encoding: "utf8" });
describe("wc deletion staging and single-commit reword", () => {
  it("stages tracked deletion and other changes despite an absent untracked directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-wc-stage-"));
    try {
      git(root, "init", "-b", "main"); git(root, "config", "user.name", "Tester"); git(root, "config", "user.email", "test@example.test");
      mkdirSync(join(root, "deleted")); writeFileSync(join(root, "deleted/file"), "old"); git(root, "add", "-A"); git(root, "commit", "-m", "test: initial");
      rmSync(join(root, "deleted"), { recursive: true }); writeFileSync(join(root, "other"), "new");
      writeFileSync(join(root, "line\nbreak"), "raw"); writeFileSync(join(root, "linebreak"), "lookalike");
      const out: string[] = [];
      const code = await runFamily(wcCommand, ["wc", "stage", "--", "deleted", "vanished", "other", "line\nbreak"], root, true, { out: line => out.push(line), err: () => {} }, defaultSeams());
      expect(code).toBe(0);
      expect(JSON.parse(out.join(""))).toMatchObject({ paths: ["deleted", "other", "line\nbreak"], skipped: ["vanished"] });
      expect(git(root, "diff", "--cached", "--name-status")).toContain("D\tdeleted/file");
      expect(git(root, "diff", "--cached", "--name-status")).toContain("A\tother");
      expect(git(root, "diff", "--cached", "--name-only", "-z").split("\0")).toContain("line\nbreak");
      expect(git(root, "diff", "--cached", "--name-only", "-z").split("\0")).not.toContain("linebreak");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rewrites a single unpublished commit and refuses it once published", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-wc-reword-"));
    const messages = mkdtempSync(join(tmpdir(), "nen-wc-message-"));
    try {
      git(root, "init", "-b", "main"); git(root, "config", "user.name", "Tester"); git(root, "config", "user.email", "test@example.test");
      writeFileSync(join(root, "file"), "base"); git(root, "add", "-A"); git(root, "commit", "-m", "test: base");
      git(root, "switch", "-c", "effort"); writeFileSync(join(root, "file"), "change"); git(root, "add", "-A"); git(root, "commit", "-m", "test: old message");
      const file = join(messages, "message"); writeFileSync(file, "test: corrected message\n\nHatsu-Agent: tester\n");
      const invoke = async (): Promise<number> => runFamily(wcCommand, ["wc", "squash", "--onto", "main", "--message-file", file], root, false, { out: () => {}, err: () => {} }, defaultSeams());
      expect(await invoke()).toBe(0);
      expect(git(root, "log", "-1", "--format=%B")).toContain("test: corrected message");
      expect(git(root, "rev-list", "--count", "main..HEAD").trim()).toBe("1");
      git(root, "remote", "add", "origin", root); git(root, "push", "-u", "origin", "effort");
      const before = git(root, "rev-parse", "HEAD");
      expect(await invoke()).toBe(2);
      expect(git(root, "rev-parse", "HEAD")).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(messages, { recursive: true, force: true }); }
  });
  it("failed squash recovery restores commits without changing later working edits", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-wc-recover-"));
    try {
      git(root, "init", "-b", "main"); git(root, "config", "user.name", "Tester"); git(root, "config", "user.email", "test@example.test");
      writeFileSync(join(root, "file"), "base"); git(root, "add", "-A"); git(root, "commit", "-m", "test: base");
      const base = git(root, "rev-parse", "HEAD").trim();
      writeFileSync(join(root, "file"), "change"); git(root, "add", "-A"); git(root, "commit", "-m", "test: change");
      const before = git(root, "rev-parse", "HEAD");
      expect(() => performSquash(defaultSeams(), root, base, join(root, "missing-message"))).toThrow(renderCommand(["git", "-C", root, "reset", "--soft", "ORIG_HEAD"]));
      writeFileSync(join(root, "file"), "later uncommitted edit");
      git(root, "reset", "--soft", "ORIG_HEAD");
      expect(git(root, "rev-parse", "HEAD")).toBe(before);
      expect(git(root, "diff")).toContain("later uncommitted edit");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

});
