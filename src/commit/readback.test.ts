// src/commit/readback.test.ts -- the comparison zheref/nen#273 rests on, with
// no git in it, and the read-back's own failure: "not checked" is never [].

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedSeams } from "../seam/scripted.js";
import { loadWorkflow, type LoadedWorkflow } from "../schema/workflow.js";
import { addedNote, compareTrailers, injectedMessage, parseTrailerLines, readBack, readBackArgs } from "./readback.js";

function policy(commits: unknown | null): LoadedWorkflow {
  const root = mkdtempSync(join(tmpdir(), "nen-readback-"));
  if (commits !== null) {
    mkdirSync(join(root, "nen"));
    writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ commits }));
  }
  return loadWorkflow(root);
}

const ADMITS_HATSU = policy({ allowedAttributionTrailers: ["Hatsu-Agent"], forbiddenTrailers: ["X-Banned"] });
const t = (key: string, value = "v"): { key: string; value: string } => ({ key, value });

describe("parseTrailerLines", () => {
  it("splits each 'Key: value' line at its first colon and skips blanks and colon-less lines", () => {
    expect(parseTrailerLines("Closes: #4\nCo-authored-by: A <a@b.c>\n\nnot a trailer\n")).toEqual([
      { key: "Closes", value: "#4" },
      { key: "Co-authored-by", value: "A <a@b.c>" },
    ]);
  });
});

describe("compareTrailers", () => {
  it("a commit carrying exactly what was sent: nothing added, nothing injected", () => {
    const sent = [t("Closes", "#4"), t("Hatsu-Agent", "kurapika")];
    expect(compareTrailers(sent, sent, ADMITS_HATSU)).toEqual({ written: sent, added: [], injected: [] });
  });

  it("names a refused key a hook added, case-insensitively against the policy, as git spelled it", () => {
    const back = compareTrailers([t("Hatsu-Agent"), t("co-authored-BY")], [t("Hatsu-Agent")], ADMITS_HATSU);
    expect(back.added).toEqual(["co-authored-BY"]);
    expect(back.injected).toEqual(["co-authored-BY"]);
  });

  it("an added key the policy admits, or never restricts, is added but NOT injected", () => {
    const back = compareTrailers([t("hatsu-agent"), t("Change-Id")], [], ADMITS_HATSU);
    expect(back.added).toEqual(["hatsu-agent", "Change-Id"]);
    expect(back.injected).toEqual([]);
  });

  it("a forbiddenTrailers key is injected too, not only nen's attribution list", () => {
    expect(compareTrailers([t("X-Banned")], [], ADMITS_HATSU).injected).toEqual(["X-Banned"]);
  });

  it("is a multiset: a SECOND copy of a key the message carried once is added; a key added twice is named once", () => {
    const back = compareTrailers([t("Closes", "#4"), t("Closes", "#5"), t("Signed-off-by"), t("signed-off-by")], [t("Closes", "#4")], ADMITS_HATSU);
    expect(back.added).toEqual(["Closes", "Signed-off-by"]);
    expect(back.injected).toEqual(["Signed-off-by"]);
  });

  it("a key the message carried that the commit lost is not a finding of this check", () => {
    expect(compareTrailers([], [t("Hatsu-Agent")], ADMITS_HATSU)).toEqual({ written: [], added: [], injected: [] });
  });

  it("with NO nen/workflow.json nothing is refused -- as nothing is refused before the write -- though the addition is still named", () => {
    const back = compareTrailers([t("Co-authored-by")], [], policy(null));
    expect(back.added).toEqual(["Co-authored-by"]);
    expect(back.injected).toEqual([]);
  });
});

describe("readBack", () => {
  it("asks git's own trailer parser about the written sha, in --repo", () => {
    const seams = new ScriptedSeams([{ match: `git ${readBackArgs("abc123").join(" ")}`, result: { stdout: "Co-authored-by: Cursor <c@x>\n" } }]);
    expect(readBack(seams, "/repo", "abc123", [], ADMITS_HATSU).injected).toEqual(["Co-authored-by"]);
    expect(seams.calls[0]?.cwd).toBe("/repo");
  });

  it("THROWS when git cannot answer: the commit exists, and the check was NOT performed", () => {
    const seams = new ScriptedSeams([{ match: `git ${readBackArgs("abc123").join(" ")}`, result: { code: 128, stderr: "fatal: bad object" } }]);
    expect((): unknown => readBack(seams, "/repo", "abc123", [], ADMITS_HATSU)).toThrow(/committed abc123.*fatal: bad object.*NOT checked/);
  });
});

describe("the two lines", () => {
  it("the refusal names the policy file, every key, the recovery, and that nen never amends", () => {
    const line = injectedMessage("abc", ["Co-authored-by", "Signed-off-by"], "/r/nen/workflow.json", "'git reset --soft HEAD~1'");
    expect(line).toContain("'/r/nen/workflow.json' refuses: 'Co-authored-by', 'Signed-off-by'");
    expect(line).toContain("nen never amends it");
    expect(line).toContain("git reset --soft HEAD~1");
    expect(injectedMessage("abc", ["A"], "p", "u")).toMatch(/carries a trailer .* added it\./);
  });

  it("the note names what was added and says the exit is unchanged", () => {
    expect(addedNote("abc", ["Change-Id"])).toMatch(/also carries 'Change-Id'.*does not refuse it, so the exit is unchanged/);
    expect(addedNote("abc", ["A", "B"])).toMatch(/does not refuse them/);
  });
});
