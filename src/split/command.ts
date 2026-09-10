// src/split/command.ts -- `nen split verify`: the jujisho completeness proof.


import { resolveRepoRoot } from "../repo/root.js";
import { readTextFile, resolveAgainstRepo } from "../cli/inputs.js";
import { requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { verifySplit } from "./verify.js";

const USAGE = `nen split verify -- prove the union of the branches' diffs equals the original.

usage:
  nen split verify --original <path> --branches <path,path,...>

  --original   a unified diff of the ORIGINAL working copy (e.g. from
               'git diff main > original.diff' before any branch was cut).
  --branches   one unified diff per axis branch, comma-separated paths (e.g.
               from 'git diff main...<axis-branch>').

Every hunk in --original must land in EXACTLY ONE of --branches, with the
SAME body -- identity is the hunk's exact text, not just its '@@ ... @@'
header. A hunk in none of them is jujisho's 'leftover hunk' -- invisible in
every PR, and a silent bug by the skill's own words. A hunk in more than one
is reported too: a hunk shared between two axes goes on the LOWER one in the
stack, never duplicated. A hunk whose header lands in exactly one branch but
whose BODY was altered along the way is reported ALTERED, separately from a
clean match. --original naming no hunks at all is refused outright -- an
empty diff is not a proof of completeness. Exits 1 on any missing, duplicated,
altered or extra hunk.

  --repo <path>    The checkout that --original and --branches resolve
                   against. Defaults to the current directory, so a call
                   made from anywhere else needs it: since zheref/nen#100
                   every path flag on this verb resolves against this
                   root, never against the process's own directory.`;

export const splitCommand: Command = {
  name: "split",
  summary: "Prove the union of split branches' diffs equals the original.",
  usage: USAGE,
  flags: { values: ["original", "branches"], booleans: [] },
  run(context: CommandContext): number {
    requireSubcommand("split", context.args, ["verify"]);

    const originalPath = context.args.values["original"];
    const branchesRaw = context.args.values["branches"];
    if (originalPath === undefined || branchesRaw === undefined) {
      throw new VerbUsageError("split verify takes --original <path> and --branches <path,path,...>.");
    }
    const branchPaths = branchesRaw
      .split(",")
      .map((item): string => item.trim())
      .filter((item): boolean => item !== "");
    if (branchPaths.length === 0) {
      throw new VerbUsageError("--branches named no paths.");
    }

    // Resolved against --repo's root, one base for every path flag
    // (zheref/nen#100), and resolved BEFORE the read so a malformed --repo
    // stays the usage error it is rather than becoming "could not read
    // --original".
    const root = resolveRepoRoot({ repoFlag: context.repoFlag });
    // READ THROUGH THE SHARED READER, so an unreadable diff is the named exit-2
    // refusal every other path flag gives rather than exit 1 (zheref/nen#101).
    // A mistyped `--original` is "you typed it wrong", and this verb's whole
    // answer is a comparison between files: one of them being absent is not a
    // verdict about a split, it is a question that was never asked.
    //
    // `raw: true` -- this verb decides by comparing hunk TEXT for identity, so
    // the bytes must be the file's own. Normalising `\r\n` to `\n` on one side
    // of a comparison and not the other reports every hunk of a CRLF branch as
    // `altered`; normalising both sides would hide a real line-ending change
    // between them. Either way the answer would be about a rewriting this
    // process did rather than about the split. (Copilot, PR #198: an earlier
    // version of this note said hunk headers "count bytes" -- they count LINES.
    // The reason to read raw is identity of the text, not arithmetic in the
    // header.)
    const original = readTextFile(
      resolveAgainstRepo(root, originalPath),
      root,
      "--original names the diff every branch is compared against, so an unreadable one is refused rather than compared against nothing.",
      true,
    );
    const branches = branchPaths.map((path): string =>
      readTextFile(
        resolveAgainstRepo(root, path),
        root,
        `--branches listed '${path}', and it could not be read -- a branch missing from the comparison would read as a hunk nobody carried.`,
        true,
      ),
    );

    const result = verifySplit(original, branches);
    if (context.json) {
      context.io.out(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }

    if (result.error !== null) {
      context.io.err(`nen: ${result.error}`);
      return 1;
    }

    context.io.out(`files: ${result.filesInOriginal} in original, ${result.filesInBranches} across branches`);
    if (result.ok) {
      context.io.out("OK -- every hunk in the original lands in exactly one branch, unaltered, and nothing extra was found.");
      return 0;
    }
    for (const entry of result.missing) {
      context.io.out(`MISSING (in original, in no branch): ${entry.path}  ${entry.header}`);
    }
    for (const entry of result.duplicated) {
      context.io.out(
        `DUPLICATED (in branches ${entry.branches.map((n): string => String(n + 1)).join(", ")}): ${entry.path}  ${entry.header}`,
      );
    }
    for (const entry of result.altered) {
      context.io.out(`ALTERED (in branch ${entry.branch + 1}, header matches but the body does not): ${entry.path}  ${entry.header}`);
      context.io.out(entry.diff);
    }
    for (const entry of result.extra) {
      context.io.out(`EXTRA (in a branch, not in original): ${entry.path}  ${entry.header}`);
    }
    context.io.err("nen: the split is incomplete -- see the missing/duplicated/altered/extra hunks above.");
    return 1;
  },
};
