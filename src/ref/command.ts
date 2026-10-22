// src/ref/command.ts -- `nen ref format` and `nen ref parse`.
//
// THE CODE IS CHECKED AGAINST THE REGISTRY, not against a list here. The
// convention's own rule is "add a code there before naming a new consumer or
// support repo", so a `format` that emitted a code the registry does not carry
// would manufacture a reference nobody can follow.

import {
  emit,
  parseCallerToken,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { refuseExtraPositionals } from "../cli/command.js";
import { resolveRepoRoot } from "../repo/root.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { REPOS_FILE, resolveSchemaFile } from "../schema/source.js";
import { githubRefCode, parseGithubRef } from "./github.js";
import { openTaxonomy } from "../schema/taxonomy.js";
import { formatRef, KNOWN_STATES, parseRef, RefError, type ObjectKind } from "./notation.js";
import { resolve as resolvePath } from "node:path";
import { assertRepoRoot } from "../repo/root.js";
import { CitationSyntaxError, resolveCitation, renderResolve, ResolveWiringError } from "./resolve.js";

const USAGE = `nen ref format --code <CODE> --kind <IS|PR> --number <N> [--state <s>] [--url <u>] [--no-glyphs]
nen ref parse <token>
nen ref resolve --citation '<path> § N | <path> § *Title* | <path>#anchor | <path> | HR-n | CON-n'
                --root <checkout> [--from <file>] [--in <file>] [--json]

The object notation <CODE>-<IS|PR>-#<N>, formatted and parsed; and where one
canon citation lands.

format:
  --code <CODE>    Two or three uppercase letters. Checked against the target
                   repository's nen/repos.json -- a code the registry does
                   not carry is refused, not emitted.
  --kind <IS|PR>   IS for an issue, PR for a pull request.
  --number <N>     The object's number.
  --state <s>      ${KNOWN_STATES.join(" | ")}. 'open' renders no mark, by design.
  --url <u>        Wraps the WHOLE token as a markdown link.
  --no-glyphs      Emit the bare notation without the kind glyph and state mark.

parse:
  <token>          Object notation, owner/name#N, or an exact github.com
                   https issue/pull URL. Short refs have kind null; URLs
                   have IS/PR. code is included only for an exact registered slug
                   (case-insensitive), including consumer-only codes.

resolve:
  --citation <c>   '<path> § N' (a heading or bold paragraph lead whose text
                   opens with N: 'N.', 'N ·', '§ N'), '<path> § *Title*' (a
                   heading or lead whose normalised text equals the title or
                   starts with it), '<path>#anchor' (GitHub's heading slugs,
                   duplicates suffixed, and explicit <a id> anchors), '<path>'
                   (the file exists), or a clause id 'P-N' (a definition as
                   'nen canon clause check' counts one; P-2 never matches
                   P-20). The path may be written as a Markdown link,
                   '[x](path) § N', or '[x](<path with spaces>) § N'. Fenced blocks and frontmatter carry no
                   heading; CRLF reads as LF.
  --root <checkout> The canon checkout (or --repo; one directory, named once).
  --from <file>    The citing file, relative to the root: a relative target
                   resolves from its directory (default: the root). A target
                   that leaves the root is unresolved by name.
  --in <file>      Where a clause id is defined. Else --root's
                   nen/contract.json clauseHomes ({ "<PREFIX>": "<file>" }),
                   else the documented defaults HR -> docs/ROSTER.md,
                   CON -> CONSTITUTION.md; any other prefix needs one.
  Exit 0 resolved (every match listed: a number two headings share is two
  matches, never a pick); 1 unresolved, with candidates (the target's headings
  and leads, or the five clause ids defined nearest) and the reason -- the
  verb never re-aims a citation; 2 a usage error or a target that could not be
  read (unreadable, not UTF-8).
  --json: { contract: "nen.ref.resolve/v0.1", citation, kind, root, target,
            resolved, matches, reason, candidates }; each match and candidate
            { line, text, anchor, via: heading|lead|anchor|definition|file }.

  --repo <path>    The checkout whose nen/repos.json --code is checked
                   against. Defaults to the current directory, so a call
                   made from anywhere else needs it: the taxonomy-missing
                   refusal you would otherwise meet is this flag's
                   absence, not a missing file.`;

const RESOLVE_FLAGS = ["citation", "root", "from", "in"] as const;
const FORMAT_FLAGS = ["code", "kind", "number", "state", "url"] as const;

function refuseFlags(context: CommandContext, verb: string, flags: readonly string[], booleans: readonly string[] = []): void {
  for (const flag of flags) {
    if (context.args.values[flag] !== undefined) throw new VerbUsageError(`--${flag} is not read by 'ref ${verb}'. A flag accepted and ignored is worse than one refused.`);
  }
  for (const flag of booleans) {
    if (context.args.booleans.has(flag)) throw new VerbUsageError(`--${flag} is not read by 'ref ${verb}'. A flag accepted and ignored is worse than one refused.`);
  }
}

function resolveVerb(context: CommandContext): number {
  refuseExtraPositionals(context.args, 2);
  refuseFlags(context, "resolve", FORMAT_FLAGS, ["no-glyphs"]);
  const citation = requireValue(context.args, "citation", "It is the citation to resolve, e.g. 'claude/skills/breath/SKILL.md § 2a' or 'HR-2'.");
  const rootFlag = context.args.values["root"];
  if (rootFlag !== undefined && rootFlag.trim() === "") throw new VerbUsageError("--root was given an empty value.");
  if (rootFlag !== undefined && context.repoFlag !== null && resolvePath(rootFlag) !== resolvePath(context.repoFlag)) {
    throw new VerbUsageError(`--root '${rootFlag}' and --repo '${context.repoFlag}' name different directories; give one.`);
  }
  const root = assertRepoRoot({ repoFlag: rootFlag ?? context.repoFlag });
  const from = context.args.values["from"] ?? null;
  const within = context.args.values["in"] ?? null;
  for (const [flag, value] of [["from", from], ["in", within]] as const) {
    if (value !== null && value.trim() === "") throw new VerbUsageError(`--${flag} was given an empty value.`);
  }
  let report;
  try {
    report = resolveCitation({ root, citation, from, in: within });
  } catch (error) {
    if (error instanceof CitationSyntaxError) throw new VerbUsageError(error.message);
    if (error instanceof ResolveWiringError) {
      context.io.err(`nen ref resolve: ${error.message} -- not resolved, and not unresolved either: the target could not be read.`);
      return 2;
    }
    throw error;
  }
  emit(context.io, context.json, report, renderResolve(report));
  return report.resolved ? 0 : 1;
}

export const refCommand: Command = {
  name: "ref",
  subcommands: ["format", "parse", "resolve"],
  summary: "Format or parse the <CODE>-<IS|PR>-#<N> object notation, or resolve a canon citation.",
  usage: USAGE,
  flags: {
    values: [...FORMAT_FLAGS, ...RESOLVE_FLAGS],
    booleans: ["no-glyphs"],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("ref", context.args, ["format", "parse", "resolve"]);
    if (subcommand === "resolve") return resolveVerb(context);
    refuseFlags(context, subcommand, RESOLVE_FLAGS);
    if (subcommand === "parse") {
      const token = context.args.positionals[2];
      if (token === undefined) {
        throw new VerbUsageError("'ref parse' needs a token, e.g. 'ref parse XX-PR-#12'.");
      }
      refuseExtraPositionals(context.args, 3);
      if (token.includes("/") || token.includes("://")) {
        const parsed = parseCallerToken(() => parseGithubRef(token), (error) => error instanceof RefError);
        const root = resolveRepoRoot({ repoFlag: context.repoFlag });
        const registry = resolveSchemaFile(root, REPOS_FILE).canonical.present ? loadRepoRegistry(root) : null;
        const code = registry === null ? null : githubRefCode(registry, parsed.slug);
        const result = code === null ? parsed : { ...parsed, code };
        emit(context.io, context.json, result, [`slug:   ${parsed.slug}`, `code:   ${code ?? "(unrecorded)"}`, `kind:   ${parsed.kind ?? "(unknown)"}`, `number: ${parsed.number}`]);
        return 0;
      }
      // Same boundary rule as ../label/command.ts: a token that is not object
      // notation is a typo, exit 2, not a run that failed. The `RefError` is
      // ./notation.ts's, NOT the unrelated class of the same name in
      // ../verbs/pr_ready.ts -- a wrong import type-checks and merely stops
      // the predicate ever matching, which puts this verb back at exit 1.
      const parsed = parseCallerToken(
        (): ReturnType<typeof parseRef> => parseRef(token),
        (error): boolean => error instanceof RefError,
      );
      emit(context.io, context.json, parsed, [
        `ref:    ${parsed.ref}`,
        `code:   ${parsed.code}`,
        `kind:   ${parsed.kind}`,
        `number: ${parsed.number}`,
        `glyph:  ${parsed.glyph}`,
      ]);
      return 0;
    }

    const code = requireValue(context.args, "code", "It is the product code from nen/repos.json.");
    const kindRaw = requireValue(context.args, "kind", "IS for an issue, PR for a pull request.");
    if (kindRaw !== "IS" && kindRaw !== "PR") {
      throw new VerbUsageError(`--kind must be IS or PR, got '${kindRaw}'.`);
    }
    const numberRaw = requireValue(context.args, "number", "The issue or pull-request number.");
    if (!/^\d+$/.test(numberRaw)) {
      throw new VerbUsageError(`--number takes a whole number, got '${numberRaw}'.`);
    }

    const registry = openTaxonomy({ repoFlag: context.repoFlag }).repos();
    const declared = new Set(Object.keys(registry.productCodes));
    for (const entry of registry.consumers) {
      if (entry.code !== null) declared.add(entry.code);
    }
    if (!declared.has(code)) {
      throw new VerbUsageError(
        `'${code}' is not a product code in ${registry.path}. The convention is to add a code to the registry BEFORE naming a repository with it, so a reference nobody can resolve is never emitted. Declared: ${[...declared].sort().join(", ") || "(none)"}.`,
      );
    }

    const formatted = formatRef({
      code,
      kind: kindRaw as ObjectKind,
      number: Number.parseInt(numberRaw, 10),
      state: context.args.values["state"] ?? null,
      url: context.args.values["url"] ?? null,
      glyphs: !context.args.booleans.has("no-glyphs"),
    });
    const lines = [formatted.token];
    if (formatted.unknownState !== null) {
      context.io.err(
        `nen ref: state '${formatted.unknownState}' is not one of ${KNOWN_STATES.join("/")} -- no state mark emitted. An unreadable lifecycle must not render identically to a confirmed-open one.`,
      );
    }
    emit(context.io, context.json, formatted, lines);
    return formatted.unknownState === null ? 0 : 1;
  },
};
