// src/issue/privacyguard.test.ts -- the private-name guard as every verb runs
// it (zheref/nen#363): one list of guarded verbs, held to the docs, the flag
// specs and the help, and the shared adapter's own refusals.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, type FlagSpec } from "../cli/args.js";
import { VerbUsageError, type CommandContext } from "../cli/command.js";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { GUARDED_VERBS, privateNameLines, type PrivateNameCheck } from "./privacy.js";
import { guardPrivateNames, PRIVATE_NAME_FLAGS, readIgnoreFlag } from "./privacyguard.js";
import { privateListRow, visibilityRow } from "./privacy.testkit.js";
import { ISSUE_SUBCOMMAND_FLAGS, issueCommand } from "./command.js";
import { ideaCommand } from "../idea/command.js";
import { PR_SUBCOMMAND_FLAGS, prCommand } from "../pr/command.js";
import { wakeCommand } from "../wake/command.js";
import { parseArgs as parseReleaseArgs, USAGE as RELEASE_USAGE } from "../dev/release-publish.js";

const TARGET: Target = { owner: "o", repo: "pub", slug: "o/pub" };

/** docs/USAGE.md's guard section: its heading to the next `### `. */
function guardSection(): string {
  const doc = readFileSync(join(process.cwd(), "docs", "USAGE.md"), "utf8");
  const start = doc.indexOf("### The private-name guard");
  expect(start).toBeGreaterThan(-1);
  const end = doc.indexOf("\n### ", start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

function declares(spec: FlagSpec, flag: string): boolean {
  return (spec.values ?? []).includes(flag) || (spec.booleans ?? []).includes(flag);
}

const GUARD_FLAG_NAMES = [...PRIVATE_NAME_FLAGS.values, ...PRIVATE_NAME_FLAGS.booleans];

function context(argv: readonly string[], seams = new ScriptedSeams([]), repoFlag: string | null = null): { context: CommandContext; err: string[] } {
  const err: string[] = [];
  const spec: FlagSpec = { values: [...PRIVATE_NAME_FLAGS.values], booleans: [...PRIVATE_NAME_FLAGS.booleans] };
  return {
    err,
    context: {
      args: parseArgs(argv, spec),
      repoFlag,
      json: false,
      io: { out: (): void => undefined, err: (line: string): void => void err.push(line) },
      seams,
    } as unknown as CommandContext,
  };
}

describe("every guarded verb, named once (zheref/nen#363)", () => {
  it("docs/USAGE.md's guard section names every guarded verb", () => {
    const section = guardSection();
    for (const verb of GUARDED_VERBS) expect(section, verb).toContain(`\`${verb}\``);
  });

  it("the guard section no longer says any writer is unguarded", () => {
    expect(guardSection()).not.toMatch(/not guarded yet/);
  });

  it("each guarded Command's flag row declares the guard's three flags", () => {
    const rows: [string, FlagSpec | undefined][] = [
      ["issue file", ISSUE_SUBCOMMAND_FLAGS["file"]],
      ["issue comment", ISSUE_SUBCOMMAND_FLAGS["comment"]],
      ["issue edit-body", ISSUE_SUBCOMMAND_FLAGS["edit-body"]],
      ["issue consolidate-close", ISSUE_SUBCOMMAND_FLAGS["consolidate-close"]],
      ["idea file", ideaCommand.flags],
      ["pr open", PR_SUBCOMMAND_FLAGS["open"]],
      ["pr edit-body", PR_SUBCOMMAND_FLAGS["edit-body"]],
      ["pr threads", PR_SUBCOMMAND_FLAGS["threads"]],
      ["wake", wakeCommand.flags],
    ];
    for (const [verb, row] of rows) {
      expect(row, verb).toBeDefined();
      for (const flag of GUARD_FLAG_NAMES) expect(declares(row as FlagSpec, flag), `${verb} --${flag}`).toBe(true);
    }
  });

  it("each guarded family's --help names the opt-out and the ignore file", () => {
    for (const command of [issueCommand, ideaCommand, prCommand, wakeCommand]) {
      expect(command.usage, command.name).toContain("--skip-private-name-check");
      expect(command.usage, command.name).toContain("--private-names-ignore-file");
    }
    expect(RELEASE_USAGE).toContain("--skip-private-name-check");
    expect(RELEASE_USAGE).toContain("--private-names-ignore-file");
  });

  it("release-publish parses the guard's flags", () => {
    const options = parseReleaseArgs(["--skip-private-name-check", "--private-names-ignore-file", "ignore.txt", "--allow-all-ignored"]);
    expect(options).toMatchObject({ skipPrivateNameCheck: true, privateNamesIgnoreFile: "ignore.txt", allowAllIgnored: true });
  });
});

describe("privateNameLines -- the verb that refused, on every line", () => {
  const refused: PrivateNameCheck = {
    result: "refused",
    targetVisibility: "public",
    listSize: 2,
    owners: 1,
    hits: [
      { field: "body", line: 3, index: 2, normalised: false, ignored: false },
      { field: "title", line: 1, index: 1, normalised: false, ignored: true },
    ],
    error: null,
  };

  it("defaults to #329's 'nen issue' prefix", () => {
    for (const line of privateNameLines(refused, TARGET).filter((text): boolean => !text.startsWith("  "))) {
      expect(line.startsWith("nen issue: ")).toBe(true);
    }
  });

  it("carries the guarded verb's own name when one is given", () => {
    const lines = privateNameLines(refused, TARGET, "nen pr open");
    expect(lines).toContain("nen pr open: body:3: private repository #2");
    expect(lines).toContain("nen pr open: ignored: title:1: private repository #1 (ignore file)");
    expect(lines.some((line): boolean => line.startsWith("nen pr open: 1 mention(s)"))).toBe(true);
    expect(lines.join("\n")).not.toContain("nen issue");
  });
});

describe("the shared adapter", () => {
  it("readIgnoreFlag: absent reads nothing; --allow-all-ignored alone is a usage error", () => {
    expect(readIgnoreFlag(context([]).context)).toBeNull();
    expect(() => readIgnoreFlag(context(["--allow-all-ignored"]).context)).toThrow(VerbUsageError);
  });

  it("readIgnoreFlag: resolves the file against --repo, and a missing one is a usage error, never an empty list", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-guard-"));
    writeFileSync(join(root, "ignore.txt"), "# generic\nvault\nacme/thing\n");
    const list = readIgnoreFlag(context(["--private-names-ignore-file", "ignore.txt"], new ScriptedSeams([]), root).context);
    expect([...(list?.names ?? [])]).toEqual(["vault"]);
    expect([...(list?.slugs ?? [])]).toEqual(["acme/thing"]);
    expect(() => readIgnoreFlag(context(["--private-names-ignore-file", "nope.txt"], new ScriptedSeams([]), root).context)).toThrow(VerbUsageError);
  });

  it("guardPrivateNames: runs the check, prints its lines with the verb's prefix, and returns the verdict", () => {
    const seams = new ScriptedSeams([visibilityRow("o/pub", "public"), privateListRow(["acme/vault"])]);
    const { context: ctx, err } = context([], seams);
    const check = guardPrivateNames(ctx, TARGET, [{ field: "comment", text: "the vault" }], null, "nen wake fire");
    expect(check.result).toBe("refused");
    expect(err[0]).toBe("nen wake fire: comment:1: private repository #1");
    expect(err.join("\n")).not.toMatch(/vault/);
  });

  it("guardPrivateNames: --skip-private-name-check reads nothing and is named", () => {
    const seams = new ScriptedSeams([]);
    const { context: ctx, err } = context(["--skip-private-name-check"], seams);
    expect(guardPrivateNames(ctx, TARGET, [{ field: "body", text: "x" }], null, "nen idea file").result).toBe("skipped-by-flag");
    expect(seams.calls).toEqual([]);
    expect(err[0]).toMatch(/^nen idea file: private-name check SKIPPED by --skip-private-name-check/);
  });
});
