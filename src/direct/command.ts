// src/direct/command.ts -- `nen direct registry|resolve`.
//
// The deterministic half of model direction. Hatsu's ruling of 2026-10-04: STABLE
// ALIASES, REPLACEABLE VERSIONS. Given an issue's classification (languages and
// jobs, the classify family's two axes), decide which model should do the work, on
// which surface, at which effort -- as an ALIAS the consumer's own
// nen/workflow.json spells per surface. The registry carries no version and nen
// stores none; the actionable surfaces are Hatsu's four, the ones the registry
// declares; effort is a RULE (a banded score), not a table; and a mismatch with the
// session that is running is REPORTED here and asked about ONCE in the skill -- it
// never blocks. The judgement (reading an issue, looking up the live version of a
// family on a provider's page) is a skill's prose. Everything around it is here,
// and every vocabulary word it uses is read from the files --registry and
// --taxonomy name, never written into this binary.
//
// Two verbs, one family, so a skill's whole mechanical loop is one noun:
//   registry  validate the registry file, print what it says;
//   resolve   resolve a classification to a recommendation, report any mismatch
//             with the session, optionally record it.
// Each lives in its own module beside this one (./registry-verb.ts and
// ./resolve-verb.ts, over ./registry.ts and ./resolve.ts); this file is the
// family's registration, its usage text and its dispatch.
//
// EXIT CODES (docs/USAGE.md, "Exit codes"): 0 an answer (a mismatch is an
// answer), 1 a failure (an invalid file, an unreadable workflow), 2 a usage error.

import { requireSubcommand, type Command, type CommandContext } from "../cli/command.js";
import { runRegistry } from "./registry-verb.js";
import { runResolve } from "./resolve-verb.js";

const USAGE = `nen direct -- the mechanical half of choosing a model for an issue's classification.

usage:
  nen direct registry --registry <path> [--repo <path>] [--json]
  nen direct resolve  --registry <path> --taxonomy <path> --repo <path>
                      --lang <a,b> --job <c,d> --kind <product|process|library|unknown>
                      [--role <canon|consumer|unregistered>] [--issue-kind <bug|enhancement|none>]
                      [--surface <s>] [--tier <alias>] [--effort <level>] [--record <effort-branch>] [--json]

The registry file (--registry) names ALIASES (roles such as the frontier author or
the execution model), the surfaces they run on, a routing table per (job, domain,
language), the effort rule and a dated snapshot of what each alias meant. It carries
no version and this binary stores none: a recommendation is an alias, spelled for
a surface by the consumer's nen/workflow.json (models.<key>.<tier>). The taxonomy
file (--taxonomy) supplies the languages, the jobs and their weights, and the domain
rules. This binary carries none of it. A relative --registry, --taxonomy or --record
resolves against --repo's root.

  nen direct registry
      Validates the registry file and prints: the snapshot date, one line per alias
      (provider, family, surface/tier, the snapshot quote), the surfaces table and the
      live-lookup sources per provider. Exit 0 valid, 1 invalid (the refusal names the
      pointer: an alias or surface a routing cell names that is not declared, bands
      that do not partition the scores, a precedence that does not rank every alias,
      a snapshot date that is not a date).

  nen direct resolve
      Resolves one classification, step by step, each step reported:
        domain     the taxonomy's five ordered rules, decided on --kind, --role and
                   --issue-kind and on the jobs' phases (the rows' prose is reported,
                   never parsed);
        cells      for every (job, language) pair the registry's cell, the language's
                   own or the shared one; a job with no phase in the domain is routed
                   on the first domain it lists, in the taxonomy's fallback order, and
                   the substitution is named;
        aggregate  the alias that wins the most pairs (a tie goes to the registry's
                   precedence); the runner-up is the next most frequent alias, else
                   the winning pairs' most frequent runner-up. A reviewer alias is
                   never the winner: its cell's stand-in is used, or the pair is
                   skipped and the skip is reported;
        resolve    the winner's surface (the cell's wins over the alias's default),
                   the model alias nen/workflow.json spells for that surface and tier
                   ('unspelled' when it does not), the restart line, the effort
                   control, the interactive tools, the dated snapshot quote and the
                   live-lookup sources;
        effort     score = the highest job weight + 1 for each add the registry's rule
                   states that holds (many jobs, many CODE languages -- a language
                   counts only when its taxonomy entry's code flag is not false -- and
                   the derived domain a rule names), banded into a level and mapped to
                   the winner surface's own control;
        mismatch   only when --surface, --tier or --effort is given: each given value
                   is compared with the winner's surface, surface alias and level.
      A mismatch is an ANSWER and exits 0; it never blocks (the skill asks once).
      --record <effort-branch> writes the whole result plus recordedAt to
      .nen/direct/<effort-branch>.json under --repo (never under nen/); a name that is
      absolute, has a backslash, or an empty, '.' or '..' segment is refused at exit 2.
      Exit 0 every resolution, 1 an invalid registry or taxonomy, an unreadable workflow
      or a registry that cannot route what the taxonomy names, 2 a missing flag, an
      unknown language or job key, kind, role, issue kind, surface or level (each names
      the valid set), or a refused --record.

  --registry <path>    The model-direction registry file. Required.
  --taxonomy <path>    The classification taxonomy file. Required by resolve.
  --repo <path>        The checkout whose nen/workflow.json spells the aliases.
                       Required by resolve; optional on registry, where it only
                       anchors a relative --registry (default: the current directory).
  --lang <a,b>         The language keys the issue carries (comma list).
  --job <c,d>          The job keys the issue carries (comma list).
  --kind <k>           The repository kind, as 'nen repo classify' reports it.
  --role <r>           The repository role, as 'nen repo classify' reports it.
  --issue-kind <k>     The issue's kind: bug, enhancement or none (default none).
  --surface <s>        The surface the running session is on.
  --tier <alias>       The model alias the running session is on.
  --effort <level>     The effort level the running session is at.
  --record <name>      File the result under .nen/direct/<name>.json.
  --json               Every verb prints one document with a
                       "contract": "nen.direct.<verb>/v0.1" key.`;

export const directCommand: Command = {
  name: "direct",
  subcommands: ["registry", "resolve"],
  summary: "Choose the model, surface and effort for an issue's classification: validate the registry, resolve a recommendation.",
  usage: USAGE,
  flags: {
    values: ["registry", "taxonomy", "lang", "job", "kind", "role", "issue-kind", "surface", "tier", "effort", "record"],
    booleans: [],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("direct", context.args, ["registry", "resolve"]);
    return subcommand === "registry" ? runRegistry(context) : runResolve(context);
  },
};
