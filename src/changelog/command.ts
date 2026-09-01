// src/changelog/command.ts -- `nen changelog fragment-required`, `nen
// changelog collate` and `nen changelog completeness`.

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  emit,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { changedFiles, changedFilesUsage, CHANGED_FILE_FLAGS, readTextFile, splitList } from "../cli/inputs.js";
import { collateIntoChangelog, sortFragments, type Fragment } from "./collate.js";
import { checkCompleteness, extractChangelogRefs, extractFragmentRefs, extractMergedPrNumbers } from "./completeness.js";
import {
  fragmentRequired,
  firstDatedEntryCount,
  firstDatedVersion,
  unreleasedEntryCount,
  type FragmentInputs,
} from "./fragment.js";
import { resolveRepoRoot } from "../repo/root.js";
import { GIT, must, normalizeEol } from "../seam/exec.js";

const USAGE = `nen changelog fragment-required --spec-paths <a,b> --fragment-dir <dir> (--files ... | --files-from ... | --range ...) [--body-from <path>] [--base-changelog <path>] --head-changelog <path> [--base-repos <path>] [--head-repos <path>]
nen changelog collate --version <vX.Y.Z> --theme <text> --changelog <path> --fragment-dir <dir> [--write]
nen changelog completeness --range <vPrev>..<vNew> --changelog <path> --owner-repo <owner/name> [--fragment-dir <dir>]

fragment-required:
  CON-33(a): does this change owe a changelog.d/ fragment? See ./fragment.ts.
  ${changedFilesUsage()}

collate:
  CON-33(b): collate every fragment in --fragment-dir into a new dated section
  of --changelog. Without --write, reports the rendered result without
  touching disk or deleting fragments.

completeness:
  CON-33(c): every PR merged in --range has a CHANGELOG entry or an
  (un)collated fragment. --owner-repo scopes changelog link matching to THIS
  repository, so a foreign-repo link sharing a PR number never counts.`;

function readIfGiven(path: string | undefined, cwd: string): string {
  return path === undefined ? "" : readTextFile(path, cwd);
}

function fragmentRequiredCmd(context: CommandContext): number {
  const specPaths = splitList(requireValue(context.args, "spec-paths", "The spec/canon path patterns CON-33(a) covers."));
  const fragmentDir = requireValue(context.args, "fragment-dir", "The fragment directory, relative to the repo root.");
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const changed = changedFiles(context, root);

  const bodyPath = context.args.values["body-from"];
  const body = bodyPath === undefined ? null : readTextFile(bodyPath, root);

  const baseChangelogPath = context.args.values["base-changelog"];
  const headChangelogPath = requireValue(context.args, "head-changelog", "The changelog at HEAD.");
  const baseChangelog = readIfGiven(baseChangelogPath, root);
  const headChangelog = readTextFile(headChangelogPath, root);

  const baseReposPath = context.args.values["base-repos"];
  const headReposPath = context.args.values["head-repos"];
  const baseLatest = latestOf(baseReposPath, root);
  const headLatest = latestOf(headReposPath, root);

  const present = new Set(changed.filter((path): boolean => existsSync(resolvePath(root, path))));

  const inputs: FragmentInputs = {
    specPaths,
    fragmentDir,
    changed,
    body,
    present,
    baseUnreleased: unreleasedEntryCount(baseChangelog),
    headUnreleased: unreleasedEntryCount(headChangelog),
    baseVersion: firstDatedVersion(baseChangelog),
    headVersion: firstDatedVersion(headChangelog),
    headSectionEntries: firstDatedEntryCount(headChangelog),
    baseLatest,
    headLatest,
  };

  const report = fragmentRequired(inputs);
  const lines = [report.verdict, report.detail];
  emit(context.io, context.json, report, lines);
  return report.required ? 1 : 0;
}

function latestOf(path: string | undefined, cwd: string): string | null {
  if (path === undefined) return null;
  const text = readTextFile(path, cwd);
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "latest" in parsed) {
      const value = (parsed as { latest?: unknown }).latest;
      return typeof value === "string" ? value : null;
    }
    return null;
  } catch (error) {
    throw new VerbUsageError(`'${path}' is not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
}

function collateCmd(context: CommandContext): number {
  const version = requireValue(context.args, "version", "The new release version.");
  const theme = requireValue(context.args, "theme", "The release's one-line theme.");
  const changelogPath = requireValue(context.args, "changelog", "The CHANGELOG.md to rewrite.");
  const fragmentDir = requireValue(context.args, "fragment-dir", "The fragment directory.");
  const write = context.args.booleans.has("write");

  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const changelogFull = isAbsolute(changelogPath) ? changelogPath : resolvePath(root, changelogPath);
  const fragmentDirFull = isAbsolute(fragmentDir) ? fragmentDir : resolvePath(root, fragmentDir);

  const changelogText = normalizeEol(readFileSync(changelogFull, "utf8"));
  const names = existsSync(fragmentDirFull) ? readdirSync(fragmentDirFull).filter((name): boolean => name.endsWith(".md")) : [];
  const fragments: Fragment[] = names.map((name): Fragment => ({
    name,
    content: normalizeEol(readFileSync(resolvePath(fragmentDirFull, name), "utf8")),
  }));

  const rewritten = collateIntoChangelog(changelogText, version, theme, sortFragments(fragments));

  if (write) {
    writeFileSync(changelogFull, rewritten, "utf8");
    for (const name of names) unlinkSync(resolvePath(fragmentDirFull, name));
  }

  const lines = [
    `${write ? "collated" : "(no --write) would collate"} ${fragments.length} fragment(s) into ${changelogPath} ### v${version.replace(/^v/, "")} — ${theme}`,
    ...names.map((name): string => `  ${name}`),
  ];
  emit(context.io, context.json, { version, theme, fragments: names, written: write }, lines);
  return 0;
}

function completenessCmd(context: CommandContext): number {
  const range = requireValue(context.args, "range", "The <vPrev>..<vNew> range, as 'git log --merges' understands it.");
  const changelogPath = requireValue(context.args, "changelog", "The CHANGELOG.md to reconcile against.");
  const ownerRepo = requireValue(context.args, "owner-repo", "Scopes changelog link matching to THIS repository.");
  const fragmentDir = context.args.values["fragment-dir"];

  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const changelog = readTextFile(changelogPath, root);

  const result = must(context.seams, GIT, ["log", range, "--merges", "--format=%s"], { cwd: root });
  const subjects = normalizeEol(result.stdout).split("\n").filter((line): boolean => line !== "");
  const mergedPrNumbers = extractMergedPrNumbers(subjects);
  const changelogRefs = extractChangelogRefs(changelog, ownerRepo);

  let fragmentRefs: number[] = [];
  if (fragmentDir !== undefined) {
    const fragmentDirFull = isAbsolute(fragmentDir) ? fragmentDir : resolvePath(root, fragmentDir);
    const names = existsSync(fragmentDirFull) ? readdirSync(fragmentDirFull).filter((name): boolean => name.endsWith(".md")) : [];
    fragmentRefs = extractFragmentRefs(names);
  }

  const report = checkCompleteness({ mergedPrNumbers, changelogRefs, fragmentRefs });
  const lines = report.ok
    ? [`every PR merged in ${range} has a CHANGELOG entry or fragment.`]
    : [`missing CHANGELOG entry or fragment for:`, ...report.missing.map((n): string => `  #${n}`)];
  emit(context.io, context.json, report, lines);
  return report.ok ? 0 : 1;
}

export const changelogCommand: Command = {
  name: "changelog",
  summary: "CON-33's per-PR fragment rule, release collation, and completeness.",
  usage: USAGE,
  flags: {
    values: [
      "spec-paths",
      "fragment-dir",
      CHANGED_FILE_FLAGS.files,
      CHANGED_FILE_FLAGS.filesFrom,
      CHANGED_FILE_FLAGS.range,
      "body-from",
      "base-changelog",
      "head-changelog",
      "base-repos",
      "head-repos",
      "version",
      "theme",
      "changelog",
      "owner-repo",
    ],
    booleans: ["write"],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("changelog", context.args, ["fragment-required", "collate", "completeness"]);
    if (subcommand === "fragment-required") return fragmentRequiredCmd(context);
    if (subcommand === "collate") return collateCmd(context);
    return completenessCmd(context);
  },
};
