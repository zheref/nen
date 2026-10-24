// src/idea/command.ts -- `nen idea file`.

import { readFileSync } from "node:fs";
import { assertRepoRoot } from "../repo/root.js";
import { resolveAgainstRepo } from "../cli/inputs.js";
import { loadLabelTaxonomy } from "../schema/labels.js";
import { commaList } from "../cli/comma.js";
import { parseTarget, TargetError, type Target } from "../github/target.js";
import {
  parseCallerToken,
  requireRepoFlag,
  requireSubcommand,
  requireTargetFlag,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { refuse } from "../cli/refusal.js";
import { createArgv, stdinLine, validateFiling, type FileRequest } from "../issue/file.js";
import { readTitleFile } from "../issue/title.js";
import { blockingExit, blocksWrite } from "../issue/privacy.js";
import { guardPrivateNames, PRIVATE_NAME_FLAGS, readIgnoreFlag } from "../issue/privacyguard.js";
import { shapePreflight } from "../issue/preflight.js";
import { fileIdea } from "./file.js";

const USAGE = `nen idea file -- file an idea issue, then READ IT BACK to verify GitHub stored it as sent.

usage:
  nen idea file --target <owner/name> --repo <path>
               (--title <t> | --title-file <path>)
               --body-file <path> --label a,b --assignee <user>
               [--forbid-family ns:family] [--dry-run]
               [--requirements-from <catalogue.json> [--kind <kind>]]
               [--skip-private-name-check]
               [--private-names-ignore-file <path> [--allow-all-ignored]]

  --title-file <path>
      The title, read from a file verbatim with ONE trailing newline stripped
      (zheref/nen#444), so the maintainer's words never pass through shell
      source. Resolves against --repo's root. Refused (exit 2) together with
      --title, when unreadable, and when the title still holds a line break.

  --dry-run
      Runs every check a real filing runs -- the filing's own refusals and the
      private-name guard, which still READS GitHub -- then prints the exact
      'gh issue create' argv and the stdin line, in 'nen issue file
      --dry-run's shape, and creates nothing. --json: '{ dryRun: true, argv,
      bodyFile, privateNameCheck }'.

  --forbid-family ns:family
      Label families this invocation declares off-limits, comma-separated.
      Works exactly as 'nen issue file's does -- it is forwarded into the same
      FileRequest -- and refuses (never creates) a label whose family the
      caller declared out of bounds, alongside the taxonomy check every label
      already gets. Caller data: nen carries no repository's own convention
      about which family means what.

  PRIVATE REPOSITORY NAMES (zheref/nen#363). Before the create, the title and
      the body are checked against the credential's live private repository
      list exactly as 'nen issue file' checks them -- the same matching, the
      same --skip-private-name-check opt-out, the same ignore file, the same
      'privateNameCheck' --json shape ('nen issue --help', PRIVATE REPOSITORY
      NAMES). A private repository named in a filing to a PUBLIC target exits
      4 and files nothing; a check that could not run (an unreadable
      visibility or list, a list that reads empty, a credential whose
      X-OAuth-Scopes lacks 'repo') exits 1, never a pass; a private target is
      not checked, an internal one is. The guard's lines go to
      stderr, each beginning 'nen idea file:', and never print the name.
      --json: the success report adds 'privateNameCheck'; a refusal prints
      '{ filed: false, privateNameCheck }'.

Reuses 'nen issue file's own choreography (labels and assignee IN the create
call), then reads the created issue back over the API and compares title,
body and label set against what was submitted. Exits 1 and names every
mismatch on a read-back disagreement -- the create call's own exit code only
confirms the REQUEST succeeded, not that the STORED record matches it.

The read-back also checks WHICH CLASS OF OBJECT answered. Issues and pull
requests share one number sequence and one issues/{n} endpoint, so a
read-back that comes back as a pull request has reached a different object
than the one just filed -- and a comparison against it would report either a
mismatch about a record nobody filed or a false 'read-back OK'. That fails
loudly (exit 1, the issue named), like any other read-back that could not
confirm what it read.`;

export const ideaCommand: Command = {
  jsonRefusals: ["file"],
  exits: [
    { verb: "idea file", code: 4, meaning: "a private repository named in text bound for a PUBLIC target; nothing written (the private-name guard)" },
  ],
  name: "idea",
  subcommands: ["file"],
  summary: "File an idea issue and verify it read back exactly as submitted.",
  usage: USAGE,
  flags: {
    values: ["target", "title", "title-file", "body-file", "label", "assignee", "forbid-family", "requirements-from", "kind", ...PRIVATE_NAME_FLAGS.values],
    booleans: ["dry-run", ...PRIVATE_NAME_FLAGS.booleans],
  },
  run(context: CommandContext): number {
    requireSubcommand("idea", context.args, ["file"]);

    // THE SAME REFUSAL THE OTHER FOUR FAMILIES GIVE (zheref/nen#93). This
    // family kept a fifth, differently-shaped copy: a missing --target threw a
    // VerbUsageError already, but a MALFORMED one printed and returned 1 --
    // "the thing you asked for did not work" for what is a typo in a flag. #93
    // settled that for `repo`, `labels`, `pr` and `issue` through
    // `requireTargetFlag` + `parseCallerToken`; leaving this one behind would
    // have made `nen idea file --target not-a-slug` the single verb answering
    // differently from every other verb that takes the flag.
    const target: Target = parseCallerToken(
      (): Target =>
        parseTarget(
          requireTargetFlag(
            context,
            "It is the GitHub side of the pair; --repo names a checkout on disk and is never used to address the API.",
          ),
        ),
      (error: unknown): boolean => error instanceof TargetError,
    );

    // Usage lists --repo unbracketed: omitting it is refused by name at exit 2,
    // never silently read as "validate against whatever taxonomy the cwd
    // happens to hold" (zheref/nen#28). Checked with the other required flags,
    // BEFORE the body file is read -- a flag refusal must not wait on I/O.
    const repoFlag = requireRepoFlag(
      context,
      "It is the checkout whose nen/labels.json validates every label in the filing.",
    );

    const bodyFile = context.args.values["body-file"];
    if (bodyFile === undefined) {
      throw new VerbUsageError("--body-file <path> is required; a body typed on the command line is a body nobody reviewed.");
    }
    // The ignore file is an input like any other: read, and refused when
    // unreadable (exit 2), before the first `gh` call (zheref/nen#363).
    const ignore = readIgnoreFlag(context);
    const root = assertRepoRoot({ repoFlag });
    // Read before the body, so a --title/--title-file refusal is a usage error
    // ahead of any other read (zheref/nen#444).
    const titleFromFile = readTitleFile(context, root);
    let submittedBody: string;
    try {
      // Resolved against --repo's root, one base for every path flag
      // (zheref/nen#100). Read RAW: the read-back compares bytes, so
      // normalising here would
      // make nen disagree with itself about what it sent.
      submittedBody = readFileSync(resolveAgainstRepo(root, bodyFile), "utf8");
    } catch (error) {
      return refuse(context.io, context.json, "idea file", 1, [`could not read --body-file '${bodyFile}': ${String(error)}`]);
    }

    const request: FileRequest = {
      title: titleFromFile ?? context.args.values["title"] ?? "",
      bodyFile,
      labels: commaList(context.args.values["label"]),
      assignee: context.args.values["assignee"] ?? "",
      forbiddenFamilies: commaList(context.args.values["forbid-family"]),
    };

    const taxonomy = loadLabelTaxonomy(root);
    // The filing's own refusals first, exactly as 'issue file' orders them:
    // a filing that is not valid is refused for that, before anything is read
    // from GitHub. fileIdea validates again; the two cannot disagree.
    const refusals = validateFiling(request, taxonomy);
    if (refusals.length > 0) {
      return refuse(context.io, context.json, "idea file", 1, refusals.map((refusal): string => refusal.reason));
    }
    // THE BODY SHAPE (zheref/nen#476), before anything reaches GitHub: the
    // check 'issue body-check' runs, on the bytes the create will send.
    const shape = shapePreflight(root, { requirementsFrom: context.args.values["requirements-from"], kind: context.args.values["kind"] }, submittedBody, "idea file");
    if (shape !== null && shape.length > 0) return refuse(context.io, context.json, "idea file", 1, shape);
    // THE PRIVATE-NAME GUARD (zheref/nen#363), before the create: the title and
    // the very bytes that travel to gh on stdin.
    const privateNameCheck = guardPrivateNames(
      context,
      target,
      [
        { field: "title", text: request.title },
        { field: "body", text: submittedBody },
      ],
      ignore,
      "nen idea file",
    );
    if (blocksWrite(privateNameCheck)) {
      if (context.json) context.io.out(JSON.stringify({ filed: false, privateNameCheck }, null, 2));
      return blockingExit(privateNameCheck);
    }
    // THE PLAN, NOT THE WRITE (zheref/nen#444): every check above has run, so
    // the verdict a dry run prints is the real run's; nothing is created and
    // nothing is read back. The shape is 'nen issue file --dry-run's.
    if (context.args.booleans.has("dry-run")) {
      const argv = createArgv(target, request);
      if (context.json) {
        context.io.out(JSON.stringify({ dryRun: true, argv, bodyFile: resolveAgainstRepo(root, bodyFile), privateNameCheck }, null, 2));
        return 0;
      }
      context.io.out(`would run: gh ${argv.join(" ")}`);
      context.io.out(stdinLine(resolveAgainstRepo(root, bodyFile), submittedBody));
      return 0;
    }
    const result = fileIdea(context.seams, target, request, submittedBody, taxonomy);

    if ("refusals" in result) {
      return refuse(context.io, context.json, "idea file", 1, result.refusals.map((refusal): string => refusal.reason));
    }

    if (context.json) {
      context.io.out(JSON.stringify({ ...result, privateNameCheck }, null, 2));
      return result.mismatches.length === 0 ? 0 : 1;
    }
    context.io.out(`filed #${result.filed.number} ${result.filed.url}`);
    if (result.mismatches.length === 0) {
      context.io.out("read-back OK -- title, body and labels match what was submitted.");
      return 0;
    }
    context.io.err(`nen: read-back found ${result.mismatches.length} mismatch(es):`);
    for (const mismatch of result.mismatches) {
      context.io.err(`  ${mismatch.field}: expected '${mismatch.expected}', got '${mismatch.actual}'`);
    }
    return 1;
  },
};
