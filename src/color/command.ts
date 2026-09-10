// src/color/command.ts -- `nen color status`.

import {
  emit,
  parseCallerToken,
  requireSubcommand,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { openTaxonomy } from "../schema/taxonomy.js";
import { ColorError, resolveStatus, type StatusResolution } from "./status.js";

const USAGE = `nen color status --present <a,b,c> [--category <name>]

Apply the target repository's nen/colors.yml precedence to the values that
are true of one row, and report the first match.

  --present <a,b,c>  The category values that apply to this row, comma-separated.
                     Order is irrelevant: the FILE's precedence decides.
  --category <name>  The colours category to resolve in. Defaults to the
                     subcommand's own name. A category the file does not
                     declare is a USAGE error (exit 2), naming the ones it
                     does -- a misspelt category is a typo, not a run that
                     failed.

There is no built-in colour table and no fallback. A set the precedence cannot
rank is reported as unresolved (exit 1) rather than picked from arbitrarily.

  --repo <path>    The checkout whose nen/colors.yml supplies the
                   vocabulary and the precedence order. Defaults to the
                   current directory, so a call made from anywhere else
                   needs it: the taxonomy-missing refusal you would
                   otherwise meet is this flag's absence, not a missing
                   file.`;

export const colorCommand: Command = {
  name: "color",
  summary: "Resolve a row's colour by the repository's own precedence.",
  usage: USAGE,
  flags: { values: ["present", "category"] },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("color", context.args, ["status"]);
    const colors = openTaxonomy({ repoFlag: context.repoFlag }).colors();
    const category = context.args.values["category"] ?? subcommand;
    const present = (context.args.values["present"] ?? "")
      .split(",")
      .map((item): string => item.trim())
      .filter((item): boolean => item !== "");

    // `--category <typo>` IS A TYPO, exit 2, the same as `label apply
    // not-a-ref` and `ref parse not-a-ref` (zheref/nen#10 item 3, minor 3).
    // ./status.ts's own refusal already ENUMERATES the categories the file
    // declares -- the canonical shape of a usage error, "here is what you
    // could have meant" -- and it exited 1 anyway, so a retry wrapper reading
    // the codes the way ../index.ts's header defines them would retry a
    // misspelt category forever against a file that will never grow it.
    // Note this is ./status.ts's ColorError, the only class of that name in
    // the tree; the predicate is what decides, so an import of some other
    // ColorError would silently stop converting.
    const resolution = parseCallerToken(
      (): StatusResolution => resolveStatus(colors, category, present),
      (error): boolean => error instanceof ColorError,
    );
    const lines: string[] = [];
    if (resolution.resolved === null) {
      lines.push(`unresolved: ${resolution.reason ?? "no first match"}`);
    } else {
      const value = resolution.resolved;
      lines.push(
        `${value.emoji ?? "(no glyph)"}  ${value.name}${value.label === null ? "" : `  ${value.label}`}`,
      );
      if (resolution.outranked.length > 0) {
        lines.push(`outranked: ${resolution.outranked.join(", ")}`);
      }
    }
    lines.push(`precedence: ${resolution.precedence.join(" > ") || "(none declared)"}`);
    if (resolution.unknown.length > 0) {
      lines.push(`not values of '${category}': ${resolution.unknown.join(", ")}`);
    }

    emit(context.io, context.json, resolution, lines);
    // Unresolved is a FAILURE, not a quiet zero: a caller rendering a board must
    // not carry on with an empty cell where a colour belongs.
    return resolution.resolved === null ? 1 : 0;
  },
};
