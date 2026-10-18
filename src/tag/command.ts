// src/tag/command.ts -- `nen tag cut --at <sha>`.

import { assertRepoRoot } from "../repo/root.js";
import { requireRepoFlag, requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { runAnnounce } from "./announce.js";
import { cutTag } from "./cut.js";

const USAGE = `nen tag announce --repo <path> [--json]
  Read nen/workflow.json tags.identity.nameFrom, without Git/network writes.
  Plain success prints the first two file lines (identity, archive SHA), CR
  stripped; extra lines ignored. No tag-name/SHA validation or tag is made.
  The path must be repo-relative without '..', regular and free of symlinks
  in every component. Reads are bounded: workflow 1 MiB; first two identity
  lines 64 KiB. Nonblocking descriptor validation refuses FIFOs/swapped files.
  Exit 0 announced; 3 no tags/identity (including null); 1 declaration/read
  fault; 2 wiring. JSON: nen.tag.announce/v0.1, status, identity, archiveSha,
  nameFrom, error, exitCode; undeclared/invalid identity and archiveSha null.

nen tag cut -- cut a tag pinned at a given SHA, getsuga §4.

usage:
  nen tag cut --repo <path> --name <vX.Y.Z> --at <sha>
             [--message <text>] [--trunk main] [--push]

  --at      REQUIRED, and never defaulted to HEAD. 'Cut from main' is not an
            instruction a script can follow -- pin the exact reconciled
            commit explicitly.
  --push    without it, the tag is created LOCALLY ONLY. A tag is NEVER
            auto-pushed outside this explicit flag -- the same --dry-run-by-
            default discipline every other mutating verb here applies.

Refuses if the name already exists locally or on origin (never re-tagged),
if --at is not an ancestor of origin/--trunk (never tags off-trunk), or if
either existence check itself fails to run (never cut on an unverified name).
The tag is always ANNOTATED (git tag -a) -- --message becomes the tag's
message when given, and defaults to the tag name otherwise.`;

export const tagCommand: Command = {
  name: "tag",
  subcommands: ["announce", "cut"],
  summary: "Announce an archive identity, or cut a tag at an explicit SHA.",
  usage: USAGE,
  flags: { values: ["name", "at", "message", "trunk"], booleans: ["push"] },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("tag", context.args, ["announce", "cut"]);
    if (subcommand === "announce") return runAnnounce(context);
    const name = context.args.values["name"];
    const at = context.args.values["at"];
    if (name === undefined || at === undefined) {
      throw new VerbUsageError("tag cut takes --name <vX.Y.Z> and --at <sha>.");
    }
    // Usage lists --repo unbracketed: omitting it is refused by name at exit 2
    // -- a tag verb that defaulted to the cwd would run its existence checks
    // (and, with --push, the push) against whatever repository the process was
    // standing in (zheref/nen#28).
    const root = assertRepoRoot({
      repoFlag: requireRepoFlag(context, "It is the repository the tag is cut in."),
    });
    const result = cutTag(context.seams, root, {
      name,
      at,
      message: context.args.values["message"],
      trunk: context.args.values["trunk"],
      push: context.args.booleans.has("push"),
    });
    if (context.json) {
      context.io.out(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    for (const line of result.log) context.io.out(line);
    if (result.error !== null) {
      context.io.err(`nen: ${result.error}`);
      return 1;
    }
    return 0;
  },
};
