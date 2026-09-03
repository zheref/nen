// src/grammar/command.ts -- `nen parse <skill>`, and (verbs/4-remainders,
// zheref/nen#4) three concrete skills' own grammars: futon, izanagi, izanami.
//
// THE SKILL NAME IS AN ARGUMENT, NOT A SWITCH -- for every skill EXCEPT these
// three. Nen carries no other skill's grammar: the template arrives with the
// invocation (`--grammar`), which is what lets the same engine serve seven
// skills without learning any of their names.
//
// FUTON/IZANAGI/IZANAMI ARE A DELIBERATE EXCEPTION, NOT A LEFTOVER DUPLICATE
// OF THE ENGINE BELOW. Each does strictly more than "parse a line against a
// template and echo it": futon RESOLVES its repo token against the target
// repository's schemas/repos.json registry and refuses a terminal clause
// against a repo that is not the caller's own; izanami CLASSIFIES every
// parsed command against its read-only allow/refuse table; izanagi enforces
// that 'up to <N>' is present, never defaulted. None of that domain logic
// exists in ./engine.ts, so these three keep their own parsers
// (../parse/futon.ts, ../parse/izanagi.ts, ../parse/izanami.ts) rather than
// being force-fit through parseTemplate()/parseInvocation(). Any OTHER skill
// name falls through to the generic --grammar/--line engine below, exactly
// as before this merge.

import { targetFromRemote } from "../github/target.js";
import { assertRepoRoot } from "../repo/root.js";
import { loadRepoRegistry } from "../schema/repos.js";
import {
  emit,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { GrammarError, parseInvocation, parseTemplate } from "./engine.js";
import { FutonResolveError, parseFutonInvocation, resolveFutonRepo } from "../parse/futon.js";
import { parseIzanagiInvocation } from "../parse/izanagi.js";
import { classifyInvocation, parseIzanamiInvocation } from "../parse/izanami.js";

const SKILL_GRAMMARS = new Set(["futon", "izanagi", "izanami"]);

const USAGE = `nen parse <skill> --grammar <template> --line <invocation>
nen parse futon --repo <path> "<repo>@<severity>[+] [then <terminal>]" [--self <owner/name>]
nen parse izanagi "<task> until <condition> up to <N>"
nen parse izanami "<task> until <condition>"

Parse a skill invocation against the grammar that skill publishes, echo the
parse, and refuse an unparseable line with the corrected line ready to paste.

  <skill>            The skill name, used only to build the corrected line --
                     UNLESS it is 'futon', 'izanagi' or 'izanami', each of
                     which carries its own grammar and additional domain
                     logic (see this file's header) and takes no --grammar.
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
and the corrected line is printed on stderr so a caller can paste it.

futon:
  Parses the futon invocation grammar and resolves its repo token against
  --repo's schemas/repos.json registry. '+' means this severity band OR
  HIGHER; a bare severity is that band alone. 'then tag' / 'then tag+fanout'
  is read from the LAST whole-word 'then'. The terminal is refused unless
  the resolved repo IS the one you are standing in (or --self names it) --
  a consumer's release is a different job than the registry owner's.
  Exits 2 on an unparseable or unresolvable invocation, with a corrected
  line where one can be offered.

izanagi:
  Parses the MUTATING loop's grammar. 'up to <N>' is REQUIRED, never
  defaulted -- an invocation without it is refused, with a corrected line.

izanami:
  Parses the READ-ONLY loop's grammar (no cap; izanami needs none) and
  classifies the task command(s) against izanami's own allow/refuse table.
  Exits 1 when any command classifies as mutating or unknown -- 'refuse
  the WHOLE run, not the offending step'.`;

export const parseCommand: Command = {
  name: "parse",
  summary: "Parse a skill invocation against its published grammar (or futon/izanagi/izanami's own).",
  usage: USAGE,
  flags: { values: ["grammar", "line", "self"] },
  run(context: CommandContext): number {
    const skill = context.args.positionals[1];
    if (skill === undefined) {
      throw new VerbUsageError(
        "'parse' needs the skill whose grammar is being applied, e.g. 'parse my-skill --grammar ... --line ...' (or 'parse futon|izanagi|izanami ...').",
      );
    }

    if (SKILL_GRAMMARS.has(skill)) {
      // These three take the REST of positionals[2..] (space- or
      // newline-joined) as their own invocation string, not --line -- exactly
      // as they did before this merge (verbs/4-remainders' own parse/verb.ts).
      const rest = context.args.positionals.slice(2);
      if (skill === "futon") return futon(context, rest.join(" "));
      if (skill === "izanagi") return izanagi(context, rest.join(" "));
      return izanami(context, rest.join("\n"));
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

    // A REFUSED TEMPLATE IS A USAGE ERROR (2), not a failure (1): `--grammar`
    // is caller-typed input, and a template the engine cannot split
    // unambiguously is refused loudly (zheref/nen#30) with the rewrite in the
    // message -- the same contract a refused --line already has.
    let grammar;
    try {
      grammar = parseTemplate(template);
    } catch (error) {
      if (error instanceof GrammarError) throw new VerbUsageError(error.message);
      throw error;
    }
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

function izanagi(context: CommandContext, raw: string): number {
  if (raw.trim() === "") {
    throw new VerbUsageError("parse izanagi takes the invocation string, e.g. 'retry the build until it is green up to 3'.");
  }
  const parsed = parseIzanagiInvocation(raw);
  if (!parsed.ok) {
    if (context.json) {
      context.io.out(JSON.stringify({ ok: false, error: parsed.error }, null, 2));
      return 2;
    }
    context.io.err(`nen: ${parsed.error.message}`);
    if (parsed.error.correctedLine !== null) context.io.err(`  try: ${parsed.error.correctedLine}`);
    return 2;
  }
  if (context.json) {
    context.io.out(JSON.stringify(parsed.value, null, 2));
    return 0;
  }
  context.io.out(`task: ${parsed.value.task}`);
  context.io.out(`until: ${parsed.value.condition}`);
  context.io.out(`cap: ${parsed.value.cap}`);
  return 0;
}

function izanami(context: CommandContext, raw: string): number {
  if (raw.trim() === "") {
    throw new VerbUsageError("parse izanami takes the invocation string, e.g. 'gh pr checks 42 until it is green'.");
  }
  const parsed = parseIzanamiInvocation(raw);
  if (!parsed.ok) {
    context.io.err(`nen: ${parsed.error.message}`);
    return 2;
  }
  const classified = classifyInvocation(parsed.value);
  if (context.json) {
    context.io.out(JSON.stringify(classified, null, 2));
    return classified.ok ? 0 : 1;
  }
  context.io.out(`until: ${classified.condition}`);
  for (const entry of classified.commands) {
    context.io.out(`  [${entry.classification.classification}] ${entry.command}`);
  }
  if (!classified.ok) {
    context.io.err(
      "nen: at least one command does not classify as read-only -- the WHOLE run is refused. Use 'nen parse izanagi <task> until <condition> up to <N>' for a loop that must act.",
    );
    return 1;
  }
  return 0;
}

function futon(context: CommandContext, raw: string): number {
  if (raw.trim() === "") {
    throw new VerbUsageError("parse futon takes the invocation string as its argument, e.g. 'BC@high+ then tag'.");
  }
  const parsed = parseFutonInvocation(raw);
  if (!parsed.ok) {
    if (context.json) {
      context.io.out(JSON.stringify({ ok: false, error: parsed.error }, null, 2));
      return 2;
    }
    context.io.err(`nen: ${parsed.error.message}`);
    if (parsed.error.correctedLine !== null) {
      context.io.err(`  try: ${parsed.error.correctedLine}`);
    }
    return 2;
  }

  let root: string;
  try {
    root = assertRepoRoot({ repoFlag: context.repoFlag });
  } catch (error) {
    context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const registry = loadRepoRegistry(root);
  const currentSlug = context.args.values["self"] ?? targetFromRemote(context.seams, root).slug;

  let resolved;
  try {
    resolved = resolveFutonRepo(registry, parsed.value.repoToken, currentSlug);
  } catch (error) {
    if (error instanceof FutonResolveError) {
      context.io.err(`nen: ${error.message}`);
      return 2;
    }
    throw error;
  }

  if (parsed.value.terminal !== null && !resolved.isSelf) {
    context.io.err(
      `nen: 'then ${parsed.value.terminal}' is refused against '${resolved.slug}' -- the terminal is that repository's own release machinery, and it is not the one you are standing in (${currentSlug}). Try the corrected build-only line:`,
    );
    context.io.err(`  try: ${parsed.value.repoToken ?? resolved.slug}@${parsed.value.band.severity}${parsed.value.band.plus ? "+" : ""}`);
    return 2;
  }

  const result = {
    repo: resolved.slug,
    code: resolved.code,
    isSelf: resolved.isSelf,
    band: parsed.value.band,
    terminal: parsed.value.terminal,
  };
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return 0;
  }
  context.io.out(`repo: ${result.repo}${result.code === null ? "" : ` (${result.code})`}`);
  context.io.out(`band: ${result.band.severity}${result.band.plus ? "+" : ""} -> ${result.band.severities.join(", ")}`);
  context.io.out(`terminal: ${result.terminal ?? "(none -- build-only)"}`);
  return 0;
}
