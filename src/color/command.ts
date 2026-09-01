// src/color/command.ts -- `nen color status`.

import { emit, requireSubcommand, type Command, type CommandContext } from "../cli/command.js";
import { openTaxonomy } from "../schema/taxonomy.js";
import { resolveStatus } from "./status.js";

const USAGE = `nen color status --present <a,b,c> [--category <name>]

Apply the target repository's schemas/colors.yml precedence to the values that
are true of one row, and report the first match.

  --present <a,b,c>  The category values that apply to this row, comma-separated.
                     Order is irrelevant: the FILE's precedence decides.
  --category <name>  The colours category to resolve in. Defaults to the
                     subcommand's own name.

There is no built-in colour table and no fallback. A category the file does not
declare is an error naming the categories it does; a set the precedence cannot
rank is reported as unresolved rather than picked from arbitrarily.`;

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

    const resolution = resolveStatus(colors, category, present);
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
