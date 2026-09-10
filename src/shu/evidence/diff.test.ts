import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../../seam/scripted.js";
import { readChangedFiles } from "./diff.js";

describe("readChangedFiles -- git diff --name-status through the seam", () => {
  it("runs the merge-base (three-dot) diff, in the given cwd", () => {
    const seams = new ScriptedSeams([
      { match: "git diff --name-status main...HEAD", result: { stdout: "" } },
    ]);
    readChangedFiles(seams, "/repo", "main");
    expect(seams.calls).toEqual([
      { command: "git", args: ["diff", "--name-status", "main...HEAD"], interactive: false, cwd: "/repo", env: null },
    ]);
  });

  it("normalizes A/M/D to added/modified/deleted", () => {
    const seams = new ScriptedSeams([
      {
        match: "git diff --name-status main...HEAD",
        result: { stdout: "A\tnew.png\nM\tchanged.png\nD\tgone.png\n" },
      },
    ]);
    expect(readChangedFiles(seams, "/repo", "main")).toEqual([
      { path: "new.png", status: "added" },
      { path: "changed.png", status: "modified" },
      { path: "gone.png", status: "deleted" },
    ]);
  });

  it("reports a rename at its NEW path, whatever the similarity percentage", () => {
    const seams = new ScriptedSeams([
      {
        match: "git diff --name-status main...HEAD",
        result: { stdout: "R100\told/a.png\tnew/a.png\n" },
      },
    ]);
    expect(readChangedFiles(seams, "/repo", "main")).toEqual([
      { path: "new/a.png", status: "renamed" },
    ]);
  });

  it("reports a copy as added -- 'copied' is not one of the four this family reports", () => {
    const seams = new ScriptedSeams([
      {
        match: "git diff --name-status main...HEAD",
        result: { stdout: "C75\tsource.png\tcopy.png\n" },
      },
    ]);
    expect(readChangedFiles(seams, "/repo", "main")).toEqual([
      { path: "copy.png", status: "added" },
    ]);
  });

  it("falls back to modified for a code this family does not otherwise recognise", () => {
    const seams = new ScriptedSeams([
      { match: "git diff --name-status main...HEAD", result: { stdout: "T\ta-symlink.png\n" } },
    ]);
    expect(readChangedFiles(seams, "/repo", "main")).toEqual([
      { path: "a-symlink.png", status: "modified" },
    ]);
  });

  it("reports an empty set for no changed files -- exit 0, never an error", () => {
    const seams = new ScriptedSeams([
      { match: "git diff --name-status main...HEAD", result: { stdout: "" } },
    ]);
    expect(readChangedFiles(seams, "/repo", "main")).toEqual([]);
  });

  it("propagates a git failure rather than reading it as 'nothing changed'", () => {
    const seams = new ScriptedSeams([
      {
        match: "git diff --name-status bad-ref...HEAD",
        result: { code: 128, stderr: "unknown revision or path not in the working tree." },
      },
    ]);
    expect(() => readChangedFiles(seams, "/repo", "bad-ref")).toThrow();
  });
});
