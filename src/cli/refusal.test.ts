// src/cli/refusal.test.ts -- under --json a refusal is a document (Hatsu SDD
// plan N5, finding B3). Each of the four verbs that used to print prose even
// under --json is driven through the real CLI, on a refusal it reaches before
// any GitHub read, and its stdout parsed: the envelope, the exit it names, and
// nothing on stderr. Without --json the prose is unchanged.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { canonCommand } from "../canon/command.js";
import { commitCommand } from "../commit/command.js";
import { ideaCommand } from "../idea/command.js";
import { issueCommand } from "../issue/command.js";
import { REFUSAL_CONTRACT, refusalEnvelope, type RefusalEnvelope } from "./refusal.js";
import type { Command } from "./command.js";

const FIXTURE = join(process.cwd(), "src", "schema", "fixtures", "bankai-repo");

async function drive(command: Command, argv: readonly string[], json: boolean): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => { out.push(line); }, err: (line): void => { err.push(line); } };
  const code = await runFamily(command, argv, null, json, io, new ScriptedSeams([]));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function body(): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-refusal-"));
  const path = join(dir, "body.md");
  writeFileSync(path, "a body\n");
  return path;
}

const CASES: readonly (readonly [string, Command, readonly string[], number])[] = [
  ["idea file, missing --target (usage)", ideaCommand, ["idea", "file", "--repo", FIXTURE], 2],
  ["idea file, a label the taxonomy lacks (content)", ideaCommand, ["idea", "file", "--target", "a/b", "--repo", FIXTURE, "--title", "x", "--label", "nope:none"], 1],
  ["issue file, an unknown flag (parse)", issueCommand, ["issue", "file", "--bogus"], 2],
  ["issue file, a label the taxonomy lacks (content)", issueCommand, ["issue", "file", "--target", "a/b", "--repo", FIXTURE, "--title", "x", "--label", "nope:none"], 1],
  ["canon resolve, a malformed --target (usage)", canonCommand, ["canon", "resolve", "--repo", ".", "--target", "not-a-slug"], 2],
  ["canon resolve, an unrecorded target (content)", canonCommand, ["canon", "resolve", "--repo", FIXTURE, "--target", "nobody/nothing", "--stack-dir", "s", "--always-load", "a"], 1],
  ["commit format, missing --subject (usage)", commitCommand, ["commit", "format", "--type", "feat"], 2],
  ["commit format, a subject ending in punctuation (shape)", commitCommand, ["commit", "format", "--type", "feat", "--subject", "add a thing."], 2],
];

describe("the four verbs refuse in an envelope under --json", () => {
  for (const [name, command, argv, code] of CASES) {
    it(`${name}: exit ${String(code)}, the envelope on stdout, no prose`, async () => {
      const withBody = argv.includes("--title") ? [...argv, "--body-file", body()] : argv;
      const result = await drive(command, withBody, true);
      expect(result.code, result.err).toBe(code);
      expect(result.err).toBe("");
      const envelope = JSON.parse(result.out) as RefusalEnvelope;
      expect(envelope.contract).toBe(REFUSAL_CONTRACT);
      expect(envelope.ok).toBe(false);
      expect(envelope.verb).toBe(`${String(argv[0])} ${String(argv[1])}`);
      expect(envelope.code).toBe(code);
      expect(envelope.refused.length).toBeGreaterThan(0);
      expect(Object.keys(envelope)).toEqual(["contract", "ok", "verb", "code", "refused"]);
    });

    it(`${name}: without --json, prose on stderr and nothing on stdout`, async () => {
      const withBody = argv.includes("--title") ? [...argv, "--body-file", body()] : argv;
      const result = await drive(command, withBody, false);
      expect(result.code).toBe(code);
      expect(result.out).toBe("");
      expect(result.err).toMatch(/^nen/);
    });
  }

  it("leaves a verb that did not opt in on prose under --json", async () => {
    const result = await drive(commitCommand, ["commit", "check", "--bogus"], true);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/unknown option/);
  });

  it("never emits an empty reason list", () => {
    expect(refusalEnvelope("x y", 1, []).refused).toEqual(["refused"]);
  });
});
