// src/grammar/command.ts -- `nen parse <skill>`.
//
// THE SKILL NAME IS AN ARGUMENT, NOT A SWITCH. Nen carries no skill's grammar:
// the template arrives with the invocation (`--grammar`), which is what lets the
// same engine serve seven skills without learning any of their names -- and what
// lets zheref/nen#4 register the per-skill templates without touching this file.

import {
  emit,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { parseInvocation, parseTemplate } from "./engine.js";

const USAGE = `nen parse <skill> --grammar <template> --line <invocation>

Parse a skill invocation against the grammar that skill publishes, echo the
parse, and refuse an unparseable line with the corrected line ready to paste.

  <skill>            The skill name, used only to build the corrected line.
  --grammar <t>      The template, written the way the skill documents it:
                       <name>            a slot
                       <name:a|b|c>      a slot with an enumerated value set
                       word(s) <slot>    the words introduce the slot, matched
                                         as the LAST whole-word occurrence
                       @<slot> #<slot>   a symbol separator, last occurrence
                       [ ... ]           an optional trailing clause
                       [+]               an optional literal suffix on the
                                         slot just declared
  --line <text>      The invocation to parse.

Exit 0 when the line parses, 2 when it does not -- a refusal is a usage error,
and the corrected line is printed on stderr so a caller can paste it.`;

export const parseCommand: Command = {
  name: "parse",
  summary: "Parse a skill invocation against its published grammar.",
  usage: USAGE,
  flags: { values: ["grammar", "line"] },
  run(context: CommandContext): number {
    const skill = context.args.positionals[1];
    if (skill === undefined) {
      throw new VerbUsageError(
        "'parse' needs the skill whose grammar is being applied, e.g. 'parse my-skill --grammar ... --line ...'.",
      );
    }
    const template = requireValue(
      context.args,
      "grammar",
      "Nen carries no skill's grammar: the template comes from the skill that publishes it.",
    );
    const line = context.args.values["line"];
    if (line === undefined) {
      throw new VerbUsageError("--line is required. It is the invocation to parse.");
    }

    const grammar = parseTemplate(template);
    const result = parseInvocation(skill, grammar, line);

    if (context.json) {
      context.io.out(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 2;
    }

    if (result.ok) {
      // THE ECHO. Every skill that carries this grammar also carries the rule
      // that the parse is restated before anything happens, because the whole
      // failure mode is a split nobody noticed.
      emit(context.io, false, result, result.echo);
      return 0;
    }

    for (const problem of result.problems) context.io.err(`nen parse: ${problem}`);
    context.io.err("");
    context.io.err("Corrected line:");
    context.io.err(`  ${result.corrected}`);
    return 2;
  },
};
