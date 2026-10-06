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
// Three verbs, one family, so a skill's whole mechanical loop is one noun:
//   registry  validate the registry file, print what it says;
//   resolve   resolve a classification to a recommendation, report any mismatch
//             with the session, optionally record it;
//   answer    write the maintainer's picker answer into that record afterwards.
// Each lives in its own module beside this one (./registry-verb.ts and
// ./resolve-verb.ts, over ./registry.ts and ./resolve.ts); this file is the
// family's registration, its usage text and its dispatch.
//
// EXIT CODES (docs/USAGE.md, "Exit codes"): 0 an answer (a mismatch is an
// answer), 1 a failure (an invalid file, an unreadable workflow), 2 a usage error.

import { requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { runAnswer } from "./answer-verb.js";
import { runRegistry } from "./registry-verb.js";
import { runResolve } from "./resolve-verb.js";

const USAGE = `nen direct -- the mechanical half of choosing a model for an issue's classification.

usage:
  nen direct registry --registry <path> [--repo <path>] [--json]
  nen direct resolve  --registry <path> --taxonomy <path> --repo <path>
                      --kind <kind> [--role <role>] [--labels <a,b>] [--lang <a,b>] [--job <c,d>]
                      [--surface <s|unread>] [--model <alias|unread>] [--effort <level|unread>]
                      [--record <effort-id>] [--json]
  nen direct answer   --record <effort-id> --answer <continue|stop> --repo <path> [--json]

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
      pointer: an alias or surface a routing cell names that is not declared, a cell
      whose surface is not its alias's, bands that do not partition the scores, a
      precedence that does not rank every alias, a snapshot date that is not a date,
      an escalation that is not an alias). When the file declares picks.fallbackRule
      it also refuses an actionable alias with no line, and a cell whose actionable
      runner-up shares the winner's provider and surface.

  nen direct resolve
      Resolves one classification, step by step, each step reported:
        domain     the taxonomy's ordered rows, each a STRUCTURED predicate (otherwise,
                   anyOf, repoKind, repoRole, issueLabels with '*:name' matching any
                   namespace, jobs.anyKey, jobs.nonEmpty + everyListsOnly), evaluated in
                   order, the first match winning. The facts are the flags: --kind and
                   --role verbatim as 'nen repo classify --json' printed them (never
                   re-derived from --repo), --labels the issue's labels, --job the job
                   keys. An unknown predicate shape is refused when the taxonomy loads
                   (exit 1, by pointer);
        cells      for every (job, language) pair the registry's cell, the language's
                   own or the shared one; a job with no phase in the domain is routed
                   on the first domain it lists, in the order the taxonomy's fallback
                   sentence names them after its colon (the derived domain first), and
                   the substitution is named;
        aggregate  the alias that wins the most pairs (a tie goes to the registry's
                   precedence); the runner-up is the next most frequent alias, else
                   the winning pairs' most frequent runner-up. A reviewer alias is
                   never the winner: a pair it wins counts for its stand-in, or is
                   skipped and the skip is reported;
        resolve    the winner's surface (its alias's), the model alias nen/workflow.json
                   spells for that surface and tier ('unspelled' when it does not), the
                   restart line (<alias> from the workflow, <level> from the effort map),
                   the effort control, the interactive tools, the dated snapshot quote
                   and the live-lookup sources;
        effort     score = the highest job weight + 1 for each add the registry's rule
                   states that holds (many jobs, many CODE languages -- a language
                   counts only when its taxonomy entry's code flag is not false -- and
                   the derived domain a rule names), banded into a level and mapped to
                   the winner surface's own control. A job the taxonomy marks companion
                   is left out of this score, and of the tally, when any other job is
                   present; its pairs are still reported, with companion and the role
                   companions.role names. An issue of only companions is scored as it stands;
        recommended the cost-agnostic pick, beside the winner: alias, surface, tier,
                   surfaceAlias and restart, computed from picks.recommended (its when,
                   then and else) read from the registry. The primary's escalation when
                   a stated condition holds and that escalation names an alias; a null
                   escalation yields the primary. Absent picks.recommended, the
                   recommended pick is the primary;
        mismatch   only for the flags given: --surface by name, --model by alias against
                   the winner's spelled alias, --effort in DIAL space (both levels mapped
                   through the session surface's effort map, so a collapsed top equals
                   the dial below it). The literal 'unread' on a flag marks that compare
                   unread: reported, never a mismatch. match stays this compare against
                   the primary. within names the first of primary, recommended and
                   fallback (mismatch.within.set's order when the file states one) that
                   the session matches the same way; unread never decides, so an
                   all-unread session is within 'none'.
      An EMPTY --job (or none) is the answer 'undirectable: job axis empty' (winner,
      runner-up, effort and mismatch null; exit 0); an empty --lang reads the shared
      cell for every job. A mismatch is an ANSWER and exits 0; it never blocks.
      --record <effort-id> writes the whole result plus effortId and recordedAt to
      .nen/direct/<id>.json under --repo (never under nen/), the id percent-encoded as
      'nen usage record' encodes --effort; an id that is empty, absolute, has a
      backslash or a '..' segment is refused at exit 2.
      Exit 0 every resolution, 1 an invalid registry or taxonomy, an unreadable workflow
      or a registry that cannot route what the taxonomy names, 2 a missing flag, an
      unknown language or job key, a surface or level the registry lacks (each names the
      valid set), or a refused --record.

  nen direct answer
      Writes the maintainer's picker answer into the record 'resolve --record' filed, which
      exists before the picker runs: reads .nen/direct/<encoded id>.json under --repo (the
      same id, encoding and traversal refusals as --record), sets decision: { answer,
      answeredAt } (replacing an earlier one), and rewrites the file, every other field
      unchanged. A missing or unreadable record is exit 1, naming the path; an answer that
      is not continue or stop, a missing flag or a refused --record is exit 2.

  --registry <path>    The model-direction registry file. Required.
  --taxonomy <path>    The classification taxonomy file. Required by resolve.
  A flag that belongs to another verb of the family (--record on registry, --taxonomy
  on answer...) is a usage error, exit 2, naming the flag.

  --repo <path>        The checkout whose nen/workflow.json spells the aliases.
                       Required by resolve; optional on registry, where it only
                       anchors a relative --registry (default: the current directory).
  --kind <kind>        The repository kind, verbatim from 'nen repo classify --json'.
  --role <role>        The repository role, verbatim from 'nen repo classify --json'.
  --labels <a,b>       The issue's labels, as GitHub reports them.
  --lang <a,b>         The language keys the issue carries (comma list; may be empty).
  --job <c,d>          The job keys the issue carries (comma list; empty is undirectable).
  --surface <s>        The surface the running session is on, or unread.
  --model <alias>      The model alias the running session is on, or unread.
  --effort <level>     The effort level the running session is at, or unread.
  --record <id>        File the result under .nen/direct/<encoded id>.json (resolve),
                       or name the record to answer (answer).
  --answer <a>         The picker's answer: continue or stop. Required by answer.
  --json               Every verb prints one document with a
                       "contract": "nen.direct.<verb>/v0.1" key.`;

// WHICH FLAGS EACH VERB TAKES. The parser knows the family's flags as one set, so
// `registry --record x` parses -- and would be silently ignored, which is how a
// verb could look like it did something it did not. A flag that belongs to ANOTHER
// verb of the family is a typo of the same class, and exits 2 naming the flag, the
// verb it was given to and the verbs that own it (the same rule `nen classify`
// states). The global flags (--repo, --json, --help) are every verb's and are not
// listed.
const VERB_FLAGS: Readonly<Record<string, readonly string[]>> = {
  registry: ["registry"],
  resolve: ["registry", "taxonomy", "lang", "job", "kind", "role", "labels", "surface", "model", "effort", "record"],
  answer: ["record", "answer"],
};

function refuseForeignFlags(subcommand: string, context: CommandContext): void {
  const family = [...(directCommand.flags.values ?? []), ...(directCommand.flags.booleans ?? [])];
  const given = [...Object.keys(context.args.values), ...context.args.booleans];
  const own = VERB_FLAGS[subcommand] ?? [];
  for (const flag of given) {
    if (!family.includes(flag) || own.includes(flag)) continue;
    const owners = Object.entries(VERB_FLAGS)
      .filter(([, flags]): boolean => flags.includes(flag))
      .map(([verb]): string => `'direct ${verb}'`);
    throw new VerbUsageError(
      `--${flag} is not a flag of 'direct ${subcommand}'; it belongs to ${owners.join(", ")}. A flag another verb takes would be silently ignored here.`,
    );
  }
}

export const directCommand: Command = {
  name: "direct",
  subcommands: ["registry", "resolve", "answer"],
  summary: "Choose the model, surface and effort for an issue's classification: validate the registry, resolve a recommendation.",
  usage: USAGE,
  flags: {
    values: ["registry", "taxonomy", "lang", "job", "kind", "role", "labels", "surface", "model", "effort", "record", "answer"],
    booleans: [],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("direct", context.args, ["registry", "resolve", "answer"]);
    refuseForeignFlags(subcommand, context);
    if (subcommand === "registry") return runRegistry(context);
    return subcommand === "resolve" ? runResolve(context) : runAnswer(context);
  },
};
