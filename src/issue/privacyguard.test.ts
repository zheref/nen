// src/issue/privacyguard.test.ts -- the private-name guard as every verb runs
// it (zheref/nen#363): one list of guarded verbs, held to the docs, the flag
// specs and the help, and the shared adapter's own refusals.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, type FlagSpec } from "../cli/args.js";
import { VerbUsageError, type CommandContext } from "../cli/command.js";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { GUARDED_VERBS, privateNameLines, type PrivateNameCheck } from "./privacy.js";
import { guardPrivateNames, PRIVATE_NAME_FLAGS, readIgnoreFlag, readNamedList } from "./privacyguard.js";
import { resolveRepoRoot } from "../repo/root.js";
import { FULL_REACH_ROW, privateListRow, visibilityRow } from "./privacy.testkit.js";
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
  // The table's first column, both ways (Nobunaga N4): a verb guarded and not
  // in the table fails, and so does a table row naming a verb nobody guards.
  // Mentions elsewhere in the section (the ruled-out paragraph) never count.
  it("docs/USAGE.md's guard table lists exactly GUARDED_VERBS", () => {
    const rows = guardSection()
      .split("\n")
      .filter((line): boolean => line.startsWith("| ") && !line.startsWith("| Guarded verb") && !/^\|[-| ]+\|$/.test(line));
    const listed = rows.map((row): string => {
      const first = row.split(" | ")[0] ?? "";
      const named = /`([^`]+)`/.exec(first);
      expect(named, row).not.toBeNull();
      return (named as RegExpExecArray)[1] as string;
    });
    expect(new Set(listed)).toEqual(new Set(GUARDED_VERBS));
    expect(listed).toHaveLength(GUARDED_VERBS.length);
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
      { field: "body", line: 3, index: 2, normalised: false, ignored: false, ignoredBy: null },
      { field: "title", line: 1, index: 1, normalised: false, ignored: true, ignoredBy: "ignore-file" },
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

  it("readIgnoreFlag: refuses (exit 2) an ignore file whose REAL path is inside the --repo working tree (Feitan F8)", () => {
    const tree = mkdtempSync(join(tmpdir(), "nen-guard-tree-"));
    mkdirSync(join(tree, ".git"));
    mkdirSync(join(tree, "sub"));
    writeFileSync(join(tree, "ignore.txt"), "vault\n");
    expect(() => readIgnoreFlag(context(["--private-names-ignore-file", "../ignore.txt"], new ScriptedSeams([]), join(tree, "sub")).context)).toThrow(
      /inside the working tree/,
    );
    // A link from outside that resolves into the tree is the same file.
    const outside = mkdtempSync(join(tmpdir(), "nen-guard-out-"));
    symlinkSync(join(tree, "ignore.txt"), join(outside, "link.txt"));
    expect(() => readIgnoreFlag(context(["--private-names-ignore-file", join(outside, "link.txt")], new ScriptedSeams([]), tree).context)).toThrow(
      /inside the working tree/,
    );
    // A real file outside the tree is read.
    writeFileSync(join(outside, "real.txt"), "vault\n");
    expect(readIgnoreFlag(context(["--private-names-ignore-file", join(outside, "real.txt")], new ScriptedSeams([]), tree).context)).not.toBeNull();
  });

  it("guardPrivateNames: runs the check, prints its lines with the verb's prefix, and returns the verdict", () => {
    const seams = new ScriptedSeams([visibilityRow("o/pub", "public"), FULL_REACH_ROW, privateListRow(["acme/vault"])]);
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

describe("the committed named list, read by every guarded verb (zheref/nen#441)", () => {
  /** A `--repo` root with the given `nen/workflow.json` text, or none. */
  function repo(workflow: string | null): { dir: string; root: string } {
    const dir = mkdtempSync(join(tmpdir(), "nen-named-"));
    if (workflow !== null) {
      mkdirSync(join(dir, "nen"));
      writeFileSync(join(dir, "nen", "workflow.json"), workflow);
    }
    return { dir, root: resolveRepoRoot({ repoFlag: dir }) };
  }
  const DECLARED = '{"privateNames":{"namedFile":"scripts/named.txt"}}';
  const show = (root: string, base = "main"): string => `git -C ${root} show refs/remotes/origin/${base}:scripts/named.txt`;

  it("reads nothing, and runs no git, where the checkout declares no named list", () => {
    const { dir } = repo(null);
    const seams = new ScriptedSeams([]);
    const { context: ctx, err } = context([], seams, dir);
    expect(readNamedList(ctx, "nen issue")).toBeNull();
    expect(seams.calls).toEqual([]);
    expect(err).toEqual([]);
  });

  it("reads the declared file at refs/remotes/origin/<branch.base>, never from the checkout", () => {
    const { dir, root } = repo('{"branch":{"base":"develop"},"privateNames":{"namedFile":"scripts/named.txt"}}');
    // The checkout's own copy says something else: it is never read.
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "named.txt"), "evil/other\n");
    const seams = new ScriptedSeams([{ match: show(root, "develop"), result: { stdout: "# ruled\nAcme/Thing\n" } }]);
    const list = readNamedList(context([], seams, dir).context, "nen issue");
    expect([...(list?.slugs ?? [])]).toEqual(["acme/thing"]);
    expect(seams.calls.map((call): string => [call.command, ...call.args].join(" "))).toEqual([show(root, "develop")]);
  });

  it("a declared file not at the base tip names nothing, and says so with the verb's prefix", () => {
    const { dir, root } = repo(DECLARED);
    const seams = new ScriptedSeams([{ match: show(root), result: { code: 128, stderr: "fatal: path 'scripts/named.txt' does not exist" } }]);
    const { context: ctx, err } = context([], seams, dir);
    expect(readNamedList(ctx, "nen pr open")).toBeNull();
    expect(err).toEqual([
      "nen pr open: named list 'scripts/named.txt' is not at refs/remotes/origin/main (it is read at the base tip, never from the checkout), so it names nothing in this run.",
    ]);
  });

  it("a bare name on the list is a usage error (exit 2) naming the line, never the entry", () => {
    const { dir, root } = repo(DECLARED);
    const seams = new ScriptedSeams([{ match: show(root), result: { stdout: "acme/thing\nvault\n" } }]);
    let thrown: unknown;
    try {
      readNamedList(context([], seams, dir).context, "nen issue");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VerbUsageError);
    expect((thrown as Error).message).toMatch(/named list 'scripts\/named.txt' at refs\/remotes\/origin\/main: line 2 is not an exact owner\/name/);
    expect((thrown as Error).message).not.toContain("vault");
  });

  it("a nen/workflow.json nen cannot read names nothing, said -- never a silent default and never a refusal of the write", () => {
    const { dir } = repo('{"coverage":{"minimun":90}}');
    const seams = new ScriptedSeams([]);
    const { context: ctx, err } = context([], seams, dir);
    expect(readNamedList(ctx, "nen issue")).toBeNull();
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^nen issue: named list not read -- .*coverage\.minimun/);
    expect(seams.calls).toEqual([]);
  });

  it("guardPrivateNames hands the named list to the check, and skips the read under the opt-out", () => {
    const { dir, root } = repo(DECLARED);
    const seams = new ScriptedSeams([
      { match: show(root), result: { stdout: "o/thing\n" } },
      visibilityRow(TARGET.slug, "public"),
      FULL_REACH_ROW,
      privateListRow(["o/thing", "o/vault"]),
    ]);
    const { context: ctx, err } = context([], seams, dir);
    const check = guardPrivateNames(ctx, TARGET, [{ field: "body", text: "thing" }], null, "nen issue");
    expect(check.result).toBe("clean");
    expect(check.hits).toEqual([{ field: "body", line: 1, index: 1, normalised: false, ignored: true, ignoredBy: "named-list" }]);
    expect(err).toEqual(["nen issue: ignored: body:1: private repository #1 (named list)"]);
    const skipped = new ScriptedSeams([]);
    const skippedCheck = guardPrivateNames(context(["--skip-private-name-check"], skipped, dir).context, TARGET, [{ field: "body", text: "thing" }], null, "nen issue");
    expect(skippedCheck.result).toBe("skipped-by-flag");
    expect(skipped.calls).toEqual([]);
  });
});
