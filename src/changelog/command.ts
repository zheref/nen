// src/changelog/command.ts -- `nen changelog fragment-required`, `nen
// changelog collate` and `nen changelog completeness`.

import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  emit,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { changedFiles, changedFilesUsage, CHANGED_FILE_FLAGS, optionalDirectoryFlag, readTextFile, splitList } from "../cli/inputs.js";
import { collateIntoChangelog, sortFragments, type Fragment } from "./collate.js";
import { DEFAULT_FRAGMENT_DIR, describeReleasePrAllowance } from "./completeness.js";
import {
  fragmentRequired,
  firstDatedEntryCount,
  firstDatedVersion,
  unreleasedEntryCount,
  type FragmentInputs,
} from "./fragment.js";
import { reconcileChangelog } from "./reconcile.js";
import { resolveRepoRoot } from "../repo/root.js";

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
  repository, so a foreign-repo link sharing a PR number never counts.
  --fragment-dir defaults to '${DEFAULT_FRAGMENT_DIR}', matching 'nen release
  preflight' -- the two verbs reconcile the same range against the same
  evidence, so they must not disagree about where fragments live. Omit the
  flag to use the default; an EMPTY value is refused (it would resolve to the
  repository root), and so is a path that is not a directory. A directory
  that does not exist contributes no fragments rather than refusing: a
  repository that has collated everything has none at the cut point.

  THE RELEASE-PR ALLOWANCE (zheref/nen#229): the terminal PR whose merge
  introduced the dated section need not cite itself -- the release proposal,
  which is written before its own number exists. When the range ends at a
  'Merge pull request #N' merge, #N is uncited, and that merge INTRODUCED the
  DATED section --changelog opens with (the dated section opens the CHANGELOG
  at the merge, is absent at its first parent, and no other merge on its
  branch -- a PR merge or a local one -- introduced it), #N is reconciled and
  named on its own line. Only that one PR, only at the range's end: every
  other uncited PR still fails, and so does a PR that merely CARRIED the
  dated section to the trunk. A heading whose trailing text is 'unreleased'
  is NOT dated: a --changelog opening with one cuts no dated section, and
  the PR that DATES it is the one that introduced the dated section. The
  history cannot tell a release proposal from a DELIVERY PR that opens the
  dated section itself; that PR is excused the same way. A git read that
  fails declines the allowance; it never grants it. --json's
  'releasePrAllowance' records the decision and its verdict either way (null
  when every merged PR was already cited).

  --range is refused at exit 2, before git runs, when any revision in it
  begins with '-': git would read it as an option.

  --repo <path>    The checkout that --changelog and --fragment-dir
                   resolve against. Defaults to the current directory, so
                   a call made from anywhere else needs it: the
                   taxonomy-missing refusal you would otherwise meet is
                   this flag's absence, not a missing file.`;

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

  // READ THROUGH THE SHARED READER, so an unreadable --changelog is the named
  // exit-2 refusal every other path flag gives (zheref/nen#101). A bare
  // `readFileSync` here let the ENOENT escape as
  // `nen changelog: ENOENT: no such file or directory, open '<path>'` at exit
  // 1 -- "the thing you asked for did not work" for what is a mistyped path,
  // and a raw errno where the sibling verb one function down (`completeness`,
  // which already used this reader) says what the file was for. The
  // `--fragment-dir` half of this same verb was fixed the same way in #83.
  const changelogText = readTextFile(
    changelogFull,
    root,
    "--changelog names the file this verb REWRITES, so an unreadable one is refused rather than collated into nothing.",
  );
  const names = existsSync(fragmentDirFull) ? readdirSync(fragmentDirFull).filter((name): boolean => name.endsWith(".md")) : [];
  const fragments: Fragment[] = names.map((name): Fragment => ({
    name,
    content: readTextFile(
      resolvePath(fragmentDirFull, name),
      root,
      `--fragment-dir listed '${name}', and it could not be read -- collating a fragment set with one of them silently missing would put a release note nowhere.`,
    ),
  }));

  // ONE ORDER, AND THE MANIFEST IS READ OFF IT (zheref/nen#34).
  //
  // The section was rendered from `sortFragments(fragments)` -- newest-first by
  // the leading `<n>-` prefix, this project's own convention -- while the
  // manifest was printed from `names`, which is `readdirSync` order. Two
  // orderings of one set, by construction: at any fragment count, the manifest
  // listed `10-a.md, 20-b.md, 30-c.md` about a section that reads FRAG-30,
  // FRAG-20, FRAG-10. Nothing was ever dropped or misattributed -- the written
  // content was always right -- but the manifest is the record a caller
  // cross-checks the section against, and a record in a different order from
  // the thing it records is worse than no record: `getsuga` relays it to the
  // maintainer as the answer to "did my fragment land where I expected".
  //
  // `collateIntoChangelog` SORTS AGAIN, and that is left alone deliberately
  // rather than removed as a redundancy (Copilot, PR #184). It is an exported
  // function whose contract is that the section it renders is newest-first
  // whatever order it was handed; taking the sort out would move that guarantee
  // into its callers, where the next one to forget it produces a wrong
  // CHANGELOG rather than a wrong log line. `sortFragments` is idempotent, so
  // the second application costs one comparison pass and changes nothing --
  // what the line below establishes is not that the sort happens once, but that
  // the ORDER is decided in one place and everything this verb reports is read
  // off that one decision.
  const ordered = sortFragments(fragments);
  const rewritten = collateIntoChangelog(changelogText, version, theme, ordered);

  if (write) {
    writeFileSync(changelogFull, rewritten, "utf8");
    for (const name of names) unlinkSync(resolvePath(fragmentDirFull, name));
  }

  const collated = ordered.map((fragment): string => fragment.name);
  const lines = [
    `${write ? "collated" : "(no --write) would collate"} ${fragments.length} fragment(s) into ${changelogPath} ### v${version.replace(/^v/, "")} — ${theme}`,
    ...collated.map((name): string => `  ${name}`),
  ];
  // `--json`'s `fragments[]` moves with it. It is the same claim in machine
  // form -- "these, in this order, are what was written" -- so leaving it in
  // readdir order while the text was corrected would be keeping the defect for
  // the consumer least able to notice it.
  emit(context.io, context.json, { version, theme, fragments: collated, written: write }, lines);
  return 0;
}

function completenessCmd(context: CommandContext): number {
  const range = requireValue(context.args, "range", "The <vPrev>..<vNew> range, as 'git log --merges' understands it.");
  const changelogPath = requireValue(context.args, "changelog", "The CHANGELOG.md to reconcile against.");
  const ownerRepo = requireValue(context.args, "owner-repo", "Scopes changelog link matching to THIS repository.");
  // DEFAULTED, not left undefined (zheref/nen#10 item 5). Omitting the flag
  // used to contribute NO fragment references at all, so an uncollated
  // fragment's PR was reported as missing a changelog entry it demonstrably
  // has -- while `nen release preflight`, reconciling the same range against
  // the same evidence, counted it. The porting source's own CLI defaults the
  // same directory (changelog_release_completeness_check.sh:117).
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const changelog = readTextFile(changelogPath, root);

  // THE SAME SEAM ../release/command.ts USES, not a second hand-spelling of
  // it: a directory that is not there is "no fragments" rather than a
  // refusal, an explicitly empty `--fragment-dir` is a usage error rather
  // than the repository root, and a path that is a FILE is refused by name
  // rather than surfacing as a raw ENOTDIR. See ../cli/inputs.ts.
  const fragmentDirFull = optionalDirectoryFlag(context.args, "fragment-dir", DEFAULT_FRAGMENT_DIR, root);
  const names = fragmentDirFull === null ? [] : readdirSync(fragmentDirFull).filter((name): boolean => name.endsWith(".md"));

  // THE SHARED RECONCILIATION (./reconcile.ts), release-PR allowance
  // included: the merge-log read, the citation check and the allowance live
  // there once, so this verb and `nen release preflight` cannot answer the
  // same range two ways (zheref/nen#229).
  const report = reconcileChangelog(context.seams, root, {
    range,
    changelogPath,
    changelogText: changelog,
    ownerRepo,
    fragmentNames: names,
  });
  // The allowance is NAMED, never silently folded into a pass: an auditor
  // reading "every PR ... has an entry" must be able to see that one of them
  // did not, and which rule let it through. A clean range with no allowance
  // prints exactly the line it always printed.
  const allowance = describeReleasePrAllowance(report.releasePrAllowance);
  const lines = report.ok
    ? allowance === null
      ? [`every PR merged in ${range} has a CHANGELOG entry or fragment.`]
      : [`every PR merged in ${range} has a CHANGELOG entry or fragment, but one, excused by the release-PR allowance:`, `  ${allowance}`]
    : [
        `missing CHANGELOG entry or fragment for:`,
        ...report.missing.map((n): string => `  #${n}`),
        ...(allowance === null ? [] : [allowance]),
      ];
  emit(context.io, context.json, report, lines);
  return report.ok ? 0 : 1;
}

export const changelogCommand: Command = {
  name: "changelog",
  subcommands: ["fragment-required", "collate", "completeness"],
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
