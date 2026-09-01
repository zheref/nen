// src/parse/verb.ts -- `nen parse …`: invocation grammars that resolve or
// refuse, never guess.

import { defaultRunner, type Runner } from "../exec/seam.js";
import { targetFromRemote } from "../github/target.js";
import { assertRepoRoot } from "../repo/root.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
import { FutonResolveError, parseFutonInvocation, resolveFutonRepo } from "./futon.js";
import { parseIzanagiInvocation } from "./izanagi.js";
import { classifyInvocation, parseIzanamiInvocation } from "./izanami.js";

const USAGE = `nen parse -- invocation grammars that resolve or refuse, never guess.

usage:
  nen parse futon --repo <path> "<repo>@<severity>[+] [then <terminal>]" [--self <owner/name>]
      Parses the futon invocation grammar and resolves its repo token against
      --repo's schemas/repos.json registry. '+' means this severity band OR
      HIGHER; a bare severity is that band alone. 'then tag' / 'then tag+fanout'
      is read from the LAST whole-word 'then'. The terminal is refused unless
      the resolved repo IS the one you are standing in (or --self names it) --
      a consumer's release is a different job than the registry owner's.
      Exits 2 on an unparseable or unresolvable invocation, with a corrected
      line where one can be offered.

  nen parse izanagi "<task> until <condition> up to <N>"
      Parses the MUTATING loop's grammar. 'up to <N>' is REQUIRED, never
      defaulted -- an invocation without it is refused, with a corrected line.

  nen parse izanami "<task> until <condition>"
      Parses the READ-ONLY loop's grammar (no cap; izanami needs none) and
      classifies the task command(s) against izanami's own allow/refuse table.
      Exits 1 when any command classifies as mutating or unknown -- 'refuse
      the WHOLE run, not the offending step'.`;

export const parseVerb: Verb = {
  name: "parse",
  summary: "Invocation grammars that resolve or refuse, never guess.",
  usage: USAGE,
  flags: { values: ["self"], booleans: [] },
  run(context: VerbContext): number {
    return runParse(context, defaultRunner);
  },
};

export function runParse(context: VerbContext, runner: Runner): number {
  const [subcommand, ...rest] = context.args;
  switch (subcommand) {
    case "futon":
      return futon(context, runner, rest.join(" "));
    case "izanagi":
      return izanagi(context, rest.join(" "));
    case "izanami":
      return izanami(context, rest.join("\n"));
    default:
      return usage(context.io, `unknown 'parse' subcommand '${subcommand ?? "(none)"}'. Run 'nen parse --help'.`);
  }
}

function izanagi(context: VerbContext, raw: string): number {
  if (raw.trim() === "") {
    return usage(context.io, "parse izanagi takes the invocation string, e.g. 'retry the build until it is green up to 3'.");
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

function izanami(context: VerbContext, raw: string): number {
  if (raw.trim() === "") {
    return usage(context.io, "parse izanami takes the invocation string, e.g. 'gh pr checks 42 until it is green'.");
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

function futon(context: VerbContext, runner: Runner, raw: string): number {
  if (raw.trim() === "") {
    return usage(context.io, "parse futon takes the invocation string as its argument, e.g. 'BC@high+ then tag'.");
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
  const currentSlug = context.values["self"] ?? targetFromRemote(runner, root).slug;

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
