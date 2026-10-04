// src/commit/readback.test.ts -- the comparison zheref/nen#273 rests on, with
// no git in it, and the read-back's own calls and failures: "not checked" is
// never [].

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedSeams } from "../seam/scripted.js";
import { loadWorkflow, type LoadedWorkflow } from "../schema/workflow.js";
import {
  addedNote,
  admittedAdditions,
  catFileArgs,
  commitMessageOf,
  compareTrailers,
  injectedMessage,
  isRootCommit,
  PARSE_TRAILERS_ARGS,
  parseTrailerLines,
  readBack,
  SEPARATORS_ARGS,
  sentTrailers,
} from "./readback.js";

function policy(commits: unknown | null): LoadedWorkflow {
  const root = mkdtempSync(join(tmpdir(), "nen-readback-"));
  if (commits !== null) {
    mkdirSync(join(root, "nen"));
    writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ commits }));
  }
  return loadWorkflow(root);
}

const ADMITS_HATSU = policy({ allowedAttributionTrailers: ["Hatsu-Agent"], forbiddenTrailers: ["X-Banned"] });
const NO_POLICY = policy(null);
const t = (key: string, value = "v"): { key: string; value: string } => ({ key, value });
const PARSE = `git ${PARSE_TRAILERS_ARGS.join(" ")}`;
const CAT = `git ${catFileArgs("abc123").join(" ")}`;
const CONFIG = `git ${SEPARATORS_ARGS.join(" ")}`;
const CONFIG_UNSET = { match: CONFIG, result: { code: 1 } };

describe("parseTrailerLines and commitMessageOf", () => {
  it("splits each 'Key: value' line at its first colon and skips blanks and colon-less lines", () => {
    expect(parseTrailerLines("Closes: #4\nCo-authored-by: A <a@b.c>\n\nnot a trailer\n")).toEqual([
      { key: "Closes", value: "#4" },
      { key: "Co-authored-by", value: "A <a@b.c>" },
    ]);
  });

  it("decodes with the separator git printed with -- '=' under trailer.separators '=:' (Copilot, NN-PR-#357)", () => {
    expect(parseTrailerLines("Co-authored-by= Cursor <c@x>\nCloses= #4\n", "=")).toEqual([
      { key: "Co-authored-by", value: "Cursor <c@x>" },
      { key: "Closes", value: "#4" },
    ]);
    // ...which the ':' default would have dropped whole: the fail-open.
    expect(parseTrailerLines("Co-authored-by= Cursor <c@x>\n")).toEqual([]);
  });

  it("isRootCommit: a commit with no 'parent' header is the root; a message line starting 'parent ' is not a header", () => {
    expect(isRootCommit("tree t\nauthor a\n\nfeat: x\n\nparent of nothing\n")).toBe(true);
    expect(isRootCommit("tree t\nparent p\nauthor a\n\nfeat: x\n")).toBe(false);
  });

  it("drops a raw commit's headers -- a signature's continuation lines included -- and keeps the message", () => {
    const raw = "tree t\nparent p\nauthor a\ncommitter c\ngpgsig -----BEGIN-----\n line\n -----END-----\n\nfeat: x\n\nCloses: #4\n";
    expect(commitMessageOf(raw)).toBe("feat: x\n\nCloses: #4\n");
    expect(commitMessageOf("tree t\n")).toBe("");
  });
});

describe("compareTrailers", () => {
  it("a commit carrying exactly what was sent: nothing added, nothing injected", () => {
    const sent = [t("Closes", "#4"), t("Hatsu-Agent", "kurapika")];
    expect(compareTrailers(sent, sent, ADMITS_HATSU)).toEqual({ written: sent, added: [], injected: [], findings: [] });
  });

  it("names a refused key a hook added, case-insensitively against the policy, as git spelled it", () => {
    const back = compareTrailers([t("Hatsu-Agent"), t("co-authored-BY")], [t("Hatsu-Agent")], ADMITS_HATSU);
    expect(back.added).toEqual(["co-authored-BY"]);
    expect(back.injected).toEqual(["co-authored-BY"]);
    expect(back.findings).toEqual([{ key: "co-authored-BY", source: "hook", rule: "policy" }]);
  });

  it("an added key the policy admits, or that is not -by/-with shaped, is added but NOT injected", () => {
    const back = compareTrailers([t("hatsu-agent"), t("Change-Id")], [], ADMITS_HATSU);
    expect(back.added).toEqual(["hatsu-agent", "Change-Id"]);
    expect(back.injected).toEqual([]);
    expect(admittedAdditions(back)).toEqual(["hatsu-agent", "Change-Id"]);
  });

  it("a forbiddenTrailers key is injected too, not only nen's attribution list", () => {
    expect(compareTrailers([t("X-Banned")], [], ADMITS_HATSU).injected).toEqual(["X-Banned"]);
  });

  it("an added key ending -by or -with that the allow-list does not admit is injected by Hatsu's rule (hanten N1)", () => {
    const back = compareTrailers([t("Made-with", "Cursor"), t("Paired-WITH", "x"), t("Hatsu-Agent")], [], ADMITS_HATSU);
    expect(back.findings).toEqual([
      { key: "Made-with", source: "hook", rule: "by-with" },
      { key: "Paired-WITH", source: "hook", rule: "by-with" },
    ]);
    // ...and an admitted -by key is not.
    const admits = policy({ allowedAttributionTrailers: ["Made-with"] });
    expect(compareTrailers([t("made-WITH")], [], admits).injected).toEqual([]);
  });

  it("is a multiset: a SECOND copy of a key the message carried once is added; a key added twice is named once", () => {
    const back = compareTrailers([t("Closes", "#4"), t("Closes", "#5"), t("Signed-off-by"), t("signed-off-by")], [t("Closes", "#4")], ADMITS_HATSU);
    expect(back.added).toEqual(["Closes", "Signed-off-by"]);
    expect(back.injected).toEqual(["Signed-off-by"]);
  });

  it("a refused key the MESSAGE carried (git's parse of a 'Key:value' line) is named as the message's, never a hook's (hanten N2)", () => {
    const sent = parseTrailerLines("Co-authored-by: x\n"); // what `interpret-trailers --parse` makes of 'Co-authored-by:x'
    const back = compareTrailers([t("Co-authored-by", "x")], sent, ADMITS_HATSU);
    expect(back.added).toEqual([]);
    expect(back.findings).toEqual([{ key: "Co-authored-by", source: "message", rule: "policy" }]);
  });

  it("a key the message carried that the commit lost is not a finding of this check", () => {
    expect(compareTrailers([], [t("Hatsu-Agent")], ADMITS_HATSU)).toEqual({ written: [], added: [], injected: [], findings: [] });
  });

  it("with NO nen/workflow.json only the -by/-with rule binds, and only on an ADDED key (the round's ruling)", () => {
    const back = compareTrailers([t("Co-authored-by"), t("X-Banned"), t("Signed-off-by")], [t("Signed-off-by")], NO_POLICY);
    expect(back.added).toEqual(["Co-authored-by", "X-Banned"]);
    expect(back.findings).toEqual([{ key: "Co-authored-by", source: "hook", rule: "by-with" }]);
  });
});

describe("sentTrailers and readBack -- git's own parser, no git log", () => {
  it("parses the sent message on stdin, in --repo, before any write", () => {
    const seams = new ScriptedSeams([CONFIG_UNSET, { match: PARSE, result: { stdout: "Closes: #4\n" } }]);
    expect(sentTrailers(seams, "/repo", "feat: x\n\nCloses:#4\n")).toEqual([{ key: "Closes", value: "#4" }]);
    expect(seams.calls[0]?.cwd).toBe("/repo");
  });

  it("reads trailer.separators and decodes with its FIRST character; a config read that fails is a failure, never ':' guessed", () => {
    const seams = new ScriptedSeams([{ match: CONFIG, result: { stdout: "=:\n" } }, { match: PARSE, result: { stdout: "Co-authored-by= Cursor\n" } }]);
    expect(sentTrailers(seams, "/repo", "feat: x\n\nCo-authored-by: Cursor\n")).toEqual([{ key: "Co-authored-by", value: "Cursor" }]);
    const broken = new ScriptedSeams([{ match: CONFIG, result: { code: 3, stderr: "bad config" } }]);
    expect((): unknown => sentTrailers(broken, "/repo", "feat: x\n")).toThrow(/config --get trailer.separators.*bad config/);
  });

  it("asks the parser with --no-divider, so a '---' line in the body never hides the trailers below it", () => {
    expect(PARSE_TRAILERS_ARGS).toContain("--no-divider");
  });

  it("refuses when git cannot parse the sent message, saying nothing was committed", () => {
    const seams = new ScriptedSeams([CONFIG_UNSET, { match: PARSE, result: { code: 129, stderr: "usage" } }]);
    expect((): unknown => sentTrailers(seams, "/repo", "feat: x\n")).toThrow(/Nothing was committed/);
  });

  it("reads the commit with cat-file and hands only its MESSAGE to interpret-trailers", () => {
    const seams = new ScriptedSeams([
      CONFIG_UNSET,
      { match: CAT, result: { stdout: "tree t\nauthor a\n\nfeat: x\n\nCo-authored-by: Cursor <c@x>\n" } },
      { match: PARSE, result: { stdout: "Co-authored-by: Cursor <c@x>\n" } },
    ]);
    expect(readBack(seams, "/repo", "abc123", [], ADMITS_HATSU).injected).toEqual(["Co-authored-by"]);
    expect(seams.calls.map((call): string => [call.command, ...call.args].join(" "))).toEqual([CAT, CONFIG, PARSE]);
    expect(seams.calls.some((call): boolean => call.args.includes("log"))).toBe(false);
  });

  it("THROWS when git cannot answer: the commit exists, and the check was NOT performed", () => {
    const failCat = new ScriptedSeams([{ match: CAT, result: { code: 128, stderr: "fatal: bad object" } }]);
    expect((): unknown => readBack(failCat, "/repo", "abc123", [], ADMITS_HATSU)).toThrow(/committed abc123.*fatal: bad object.*NOT checked/);
    const failParse = new ScriptedSeams([
      CONFIG_UNSET,
      { match: CAT, result: { stdout: "tree t\n\nfeat: x\n" } },
      { match: PARSE, result: { code: 1, stderr: "boom" } },
    ]);
    expect((): unknown => readBack(failParse, "/repo", "abc123", [], ADMITS_HATSU)).toThrow(/interpret-trailers.*boom.*NOT checked/);
  });
});

describe("the two lines", () => {
  it("the refusal names every key with its source and rule, the policy file, the recovery, and that nen never amends", () => {
    const line = injectedMessage(
      "abc",
      [
        { key: "Co-authored-by", source: "hook", rule: "policy" },
        { key: "Made-with", source: "hook", rule: "by-with" },
        { key: "Signed-off-by", source: "message", rule: "policy" },
      ],
      ADMITS_HATSU,
      "'git reset --soft HEAD~1'",
    );
    expect(line).toContain("carries trailers this repository refuses: 'Co-authored-by' (added by a hook");
    expect(line).toContain(`refused by '${ADMITS_HATSU.path}'`);
    expect(line).toContain(`'Made-with' (added by a hook inside 'git commit' (prepare-commit-msg, commit-msg, or a harness's own); an attribution-shaped '-by'/'-with' key that commits.allowedAttributionTrailers does not admit in '${ADMITS_HATSU.path}')`);
    expect(line).toContain("'Signed-off-by' (carried by the message nen wrote");
    expect(line).toContain("nen never amends it");
    expect(line).toContain("git reset --soft HEAD~1");
    expect(injectedMessage("abc", [{ key: "Made-with", source: "hook", rule: "by-with" }], NO_POLICY, "u")).toMatch(/carries a trailer .*there is no '.*workflow.json', so it admits none/);
  });

  it("the note names what was added and says the exit is unchanged", () => {
    expect(addedNote("abc", ["Change-Id"])).toMatch(/also carries 'Change-Id'.*Nothing refuses it, so the exit is unchanged/);
    expect(addedNote("abc", ["A", "B"])).toMatch(/Nothing refuses them/);
  });
});
