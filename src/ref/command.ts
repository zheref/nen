// src/ref/command.ts -- `nen ref format` and `nen ref parse`.
//
// THE CODE IS CHECKED AGAINST THE REGISTRY, not against a list here. The
// convention's own rule is "add a code there before naming a new consumer or
// support repo", so a `format` that emitted a code the registry does not carry
// would manufacture a reference nobody can follow.

import {
  emit,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { openTaxonomy } from "../schema/taxonomy.js";
import { formatRef, KNOWN_STATES, parseRef, type ObjectKind } from "./notation.js";

const USAGE = `nen ref format --code <CODE> --kind <IS|PR> --number <N> [--state <s>] [--url <u>] [--no-glyphs]
nen ref parse <token>

The object notation <CODE>-<IS|PR>-#<N>, formatted and parsed.

format:
  --code <CODE>    Two or three uppercase letters. Checked against the target
                   repository's schemas/repos.json -- a code the registry does
                   not carry is refused, not emitted.
  --kind <IS|PR>   IS for an issue, PR for a pull request.
  --number <N>     The object's number.
  --state <s>      ${KNOWN_STATES.join(" | ")}. 'open' renders no mark, by design.
  --url <u>        Wraps the WHOLE token as a markdown link.
  --no-glyphs      Emit the bare notation without the kind glyph and state mark.

parse:
  <token>          A token in object notation. Refused, never guessed at.`;

export const refCommand: Command = {
  name: "ref",
  summary: "Format or parse the <CODE>-<IS|PR>-#<N> object notation.",
  usage: USAGE,
  flags: {
    values: ["code", "kind", "number", "state", "url"],
    booleans: ["no-glyphs"],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("ref", context.args, ["format", "parse"]);
    if (subcommand === "parse") {
      const token = context.args.positionals[2];
      if (token === undefined) {
        throw new VerbUsageError("'ref parse' needs a token, e.g. 'ref parse XX-PR-#12'.");
      }
      const parsed = parseRef(token);
      emit(context.io, context.json, parsed, [
        `ref:    ${parsed.ref}`,
        `code:   ${parsed.code}`,
        `kind:   ${parsed.kind}`,
        `number: ${parsed.number}`,
        `glyph:  ${parsed.glyph}`,
      ]);
      return 0;
    }

    const code = requireValue(context.args, "code", "It is the product code from schemas/repos.json.");
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
