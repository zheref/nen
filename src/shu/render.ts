// src/shu/render.ts -- turn a DECLARATION into the exact steps a verb would
// run. Pure: no seam, no filesystem, no clock, no network.
//
// THIS FILE CONTAINS NO TOOLCHAIN NAME, AND THAT IS THE POINT. Every executable
// nen spawns for this family comes out of the target repository's own
// `nen/contract.json`; nothing here knows what a package manager, a build
// system or a test runner is called. The rule has a test of its own
// (./purity.test.ts) because a rule of this shape holds for three commits and
// then quietly stops the first time a literal is convenient.
//
// `renderInvocation` TAKES A DECLARATION AND NOTHING ELSE. Not the reference
// profiles pack, not a per-stack default table, not a fallback. That is the
// (d1) invariant from zheref/nen#91's design: the pack is a CATALOGUE `nen shu
// detect` reads to write a proposal a human then edits into their repository,
// and an execution path that could reach it would make "the pack is not an
// authority" a sentence in a header rather than a property of the program. The
// signature is the enforcement: there is no parameter to pass a pack through.
//
// WHY THE REFUSAL ORDER IS FIXED, AND WHY IT IS THIS ORDER:
//   1. the lane must exist                        -> 2 (you named a lane the file does not declare)
//   2. the lane must declare the verb             -> 4 (this lane has no such verb, on ANY host)
//   3. the host must be allowed                   -> 3 (real verb, wrong computer)
//   4. no placeholder may be left unsubstituted   -> 2
// Two and three are the pair worth stating: a verb the declaration marks
// `unsupported` is unsupported everywhere, so answering "wrong host" first would
// send a developer to a different machine to be told the same no.

import { VerbUsageError } from "../cli/command.js";
import { EXIT_UNSUPPORTED_HOST, EXIT_UNSUPPORTED_VERB, ShuRefusal } from "./exit.js";
import type { Invocation, ProjectBlock } from "../schema/contract.js";

/**
 * The precondition kinds this release can assert. Everything else refuses.
 *
 * IT LIVES IN THE PURE MODULE, NOT IN THE ONE THAT SPAWNS. Two files say these
 * two words: ./run.ts asserts them, and ./detect.ts names them in a note about
 * a precondition it will NOT propose -- and a hand-typed "'path' or 'env'" over
 * there is a sentence that goes stale the day a third kind lands here,
 * silently, with no test able to notice. Sharing the constant is the fix; where
 * it is shared FROM is the part that matters. Exported from ./run.ts, it gave
 * `detect` -- a verb that spawns nothing and legitimately reads the reference
 * pack -- an import edge to the module every `nen shu` subprocess comes out of,
 * and ../profiles/inertness.test.ts reads that edge (correctly) as "this module
 * can spawn". This module renders a plan and runs nothing, so the same sharing
 * costs no edge at all.
 */
export const ASSERTABLE_KINDS: readonly string[] = ["path", "env"];

/**
 * The verbs that send something SOMEWHERE, and therefore require `--target`.
 *
 * HERE FOR THE REASON ABOVE, WORD FOR WORD. Two files say this list: ./run.ts
 * resolves a destination for exactly these verbs, and ./detect.ts names them in
 * the note that travels with the empty `targets` block it proposes -- so a
 * `"deploy"` literal in `detect` would be a sentence that goes stale the day a
 * second verb with a destination lands, and importing the list from ./run.ts
 * would give `detect` the import edge ../profiles/inertness.test.ts reads as
 * "this module can spawn".
 *
 * It is a LIST for the reason `INTERACTIVE_VERBS` is one: a second such verb is
 * a line here rather than a new branch, and a reader looking for "which verbs
 * take a target" finds a list rather than an `=== "deploy"` inside a condition.
 * ./command.ts's flag table is the other half -- `--target` is refused outright
 * on every verb that is not in it.
 */
export const TARGETED_VERBS: readonly string[] = ["deploy"];

/** One command, as it will be spawned: exe apart from argv, never a string. */
export interface RenderedStep {
  readonly exe: string;
  readonly argv: readonly string[];
}

/** A precondition as the declaration states it, before anything asserts it. */
export interface RenderedPrecondition {
  readonly kind: string;
  readonly value: string | readonly string[];
  readonly why: string | null;
  /**
   * Where the ASSERTED VALUE lives in the declaration, e.g.
   * `project.preconditions.web[1].value` or
   * `project.targets.staging.requiresEnv[0]`.
   *
   * ALWAYS THE LEAF, never the row that carries it -- the two examples above
   * look different only because the two rows ARE shaped differently in the
   * file (a lane precondition is `{ kind, value, why }`; a target's
   * `requiresEnv` entry is the string itself), and a caller asserting the
   * value reads this pointer as-is, with nothing appended.
   *
   * IT IS CARRIED RATHER THAN RECOMPUTED because two blocks now contribute
   * rows to one list. ./run.ts's assertion refuses a `path` that escapes the
   * repository BY POINTER, and it used to build that pointer from the row's
   * index into the merged list -- so every row a TARGET contributed was
   * reported as `project.preconditions.<lane>[<i>]`, an address that does not
   * exist in the file. A refusal naming a place a reader cannot find is a
   * refusal they cannot act on. A later revision then had ./run.ts append
   * `.value` to this field to fix that -- correct for a lane row, but it made
   * the SAME mistake for a target row, whose pointer was already the leaf:
   * `project.targets.staging.requiresEnv[0].value` names nothing. The fix is
   * this field being the leaf itself, always, so nothing downstream appends.
   */
  readonly pointer: string;
}

export interface HostVerdict {
  /** The platform this invocation is running on, from the seam. */
  readonly platform: string;
  readonly supported: boolean;
  /** The allowlist that applied, or null when the declaration constrains none. */
  readonly declared: readonly string[] | null;
}

/**
 * The destination a `deploy` resolved to, as the report prints it.
 *
 * NAMES ONLY, ALWAYS. `requiresEnv` is a list of variable NAMES nen asserts are
 * set; no value of one is read, compared or rendered anywhere -- the same rule
 * `RenderedInvocation.env` follows one field up, for the same reason.
 */
export interface ResolvedTarget {
  readonly name: string;
  /** What this destination appended to the lane's declared argv, in order. */
  readonly args: readonly string[];
  /**
   * Variable NAMES this destination requires, byte-ordered and DE-DUPLICATED.
   * Never values.
   *
   * IT IS THE WHOLE LIST, including a variable the lane's own preconditions
   * already declare -- this is what the DESTINATION requires, which is a fact
   * about the destination whoever else also happens to require it. The
   * assertion is what de-overlaps: `resolveTarget` appends only the names the
   * lane does not already state, so one variable is one row in the table and
   * "2 preconditions are not satisfied" never means one variable counted twice.
   */
  readonly requiresEnv: readonly string[];
}

export interface RenderedInvocation {
  readonly lane: string;
  readonly stack: string;
  readonly verb: string;
  /** The destination, on a verb that takes one. Null on every other verb. */
  readonly target: ResolvedTarget | null;
  /** Repo-relative, forward-slashed -- the lane's own `cwd`. */
  readonly cwdRelative: string;
  readonly steps: readonly RenderedStep[];
  /**
   * Environment the declaration adds for this verb: NAME -> value.
   *
   * The VALUES live here and are never rendered anywhere. Every report reads
   * `Object.keys(...)`; ./run.test.ts pins that a declared value appears in no
   * line of text output, no `--json` field and no refusal.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly host: HostVerdict;
  readonly preconditions: readonly RenderedPrecondition[];
  /** Repo-relative outputs the declaration names, if it names any. */
  readonly artifacts: readonly string[];
  /** The declaration's own reason for this shape of the verb. Never nen's. */
  readonly why: string | null;
}

export interface RenderRequest {
  readonly lane: string | null;
  readonly verb: string;
  readonly platform: string;
}

// Matched braces only, and a candidate rather than a verdict: what comes out of
// this is checked against the closed set below. `{` with no `}` is a literal
// brace some tool wanted -- ../profiles/pack.ts's own scanner draws the same
// line, for the same reason.
const BRACED = /\{[^{}]*\}/g;

/**
 * THE CLOSED SET OF PLACEHOLDER TOKENS -- the ONLY braced strings this family
 * refuses. Everything else in an argv is an argument.
 *
 * WHY A SET AND NOT `\{[^}]*\}`. The first draft refused ANY braced token, and
 * that is a rule about somebody else's command line rather than about nen: a
 * declaration stating `--define={"NODE_ENV":"test"}`, a JSON body, a Gradle
 * `-P` value, a `find -exec ... {} \;` -- all of them are ordinary arguments
 * that mean exactly themselves, and refusing them told a repository its own
 * verb was un-runnable for a reason it could do nothing about. What must be
 * refused is a token that was meant to be SUBSTITUTED and was not, and that set
 * is closed and published: ../profiles/pack.ts's `PLACEHOLDERS`, which the
 * catalogue's own loader refuses an unknown member of.
 *
 * WHY IT IS RESTATED HERE RATHER THAN IMPORTED. This module is on the execution
 * path -- ./run.ts spawns what it renders -- and ../profiles/inertness.test.ts
 * fails the build when anything that can spawn reaches the pack, at any depth.
 * That guard is the reason "the pack is a catalogue, not an authority" is a
 * property of the program rather than a sentence in a header, and importing a
 * const through it to save six lines would be trading the property for the
 * lines. ./purity.test.ts pins this list against `PLACEHOLDERS` in both
 * directions instead, so the two cannot drift: a token added to the pack and
 * not to this list fails there, loudly, rather than reaching a spawn.
 */
export const REFUSED_PLACEHOLDERS: readonly string[] = [
  "{app}",
  "{archiveScript}",
  "{browserPath}",
  "{destination}",
  "{gw}",
  "{name}",
  "{packageManager}",
  "{package}",
  "{platform}",
  "{pm}",
  "{project}",
  "{resultBundle}",
  "{scheme}",
  "{simUdid}",
  "{testTarget}",
  "{unitTestTask}",
  "{workload}",
];

const REFUSED: ReadonlySet<string> = new Set(REFUSED_PLACEHOLDERS);

/**
 * The lane to run in: `--lane` if given, else the declaration's `defaultLane`.
 *
 * A DECLARATION MAY DECLINE TO HAVE A DEFAULT. `defaultLane: null` is legal and
 * means "--lane is required" -- a repository with three unrelated builds in one
 * tree is stating that picking one for the caller would be a guess. So the
 * refusal names every lane rather than choosing the only one, even when there
 * IS only one: a second lane arriving later must not silently change what a
 * scripted `nen shu build` builds.
 */
export function resolveLane(project: ProjectBlock, requested: string | null): string {
  const declared = Object.keys(project.lanes);
  if (requested !== null) {
    if (!Object.prototype.hasOwnProperty.call(project.lanes, requested)) {
      throw new VerbUsageError(
        `--lane '${requested}' is not a lane this repository declares. Declared: ${declared.join(", ")}.`,
      );
    }
    return requested;
  }
  if (project.defaultLane !== null) return project.defaultLane;
  throw new VerbUsageError(
    `--lane is required: this repository's project block declares no defaultLane, so nen will not pick one for you. Declared lanes: ${declared.join(", ")}.`,
  );
}

/**
 * The platform allowlist that applies to one verb, or null for none.
 *
 * EXPORTED FOR `shu tools`, which checks the host BEFORE it spawns its first
 * probe and does not otherwise go through `renderInvocation` -- its rows come
 * from `project.toolchain`, not from `project.verbs`. One resolver, so the two
 * paths cannot disagree about whether an exact key beats the wildcard.
 */
export function declaredHostsFor(project: ProjectBlock, verb: string): readonly string[] | null {
  // The exact verb wins over the wildcard, and neither is a default: a
  // declaration with no `hosts` block constrains nothing, because a repository
  // that said nothing about platforms has not said "darwin".
  const exact = project.hosts[verb];
  if (exact !== undefined) return exact;
  const wildcard = project.hosts["*"];
  return wildcard ?? null;
}

function stepsOf(invocation: Invocation): readonly RenderedStep[] {
  if (invocation.kind === "command") {
    return [{ exe: invocation.exe, argv: invocation.argv }];
  }
  if (invocation.kind === "steps") {
    return invocation.steps.map((step): RenderedStep => ({ exe: step.exe, argv: step.argv }));
  }
  /* c8 ignore next -- the `unsupported` arm is refused before it reaches here */
  return [];
}

/**
 * The environment map a verb declares, validated.
 *
 * `env` is an UNKNOWN key to ../schema/contract.ts, preserved verbatim in
 * `raw` -- exactly as `artifacts` is -- because closing the invocation shape
 * would make this file nen's rather than the repository's. Unknown does not
 * mean unchecked: a shape nen would act on is refused here by name rather than
 * silently ignored, which is the failure a caller could not see.
 */
function envOf(raw: Readonly<Record<string, unknown>>, pointer: string): Record<string, string> {
  const declared = raw["env"];
  if (declared === undefined || declared === null) return {};
  if (typeof declared !== "object" || Array.isArray(declared)) {
    throw new VerbUsageError(
      `${pointer}.env is not an object. It maps a variable NAME to the value this verb needs it to have; nen passes the pair to the child and reports only the name.`,
    );
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(declared as Record<string, unknown>)) {
    if (name.startsWith("$")) continue;
    if (typeof value !== "string") {
      throw new VerbUsageError(
        `${pointer}.env.${name} is not a string. An environment value is text; nen never coerces one, because a number silently becoming "1" is a different variable than the declaration meant.`,
      );
    }
    out[name] = value;
  }
  return out;
}

/**
 * Repo-relative outputs the declaration names, if any.
 *
 * ABSENT IS AN EMPTY LIST, NOT AN INFERENCE. nen never guesses where a build
 * put its artifact: knowing that would mean knowing the toolchain, which is the
 * one thing this file must not.
 */
function artifactsOf(raw: Readonly<Record<string, unknown>>, pointer: string): readonly string[] {
  const declared = raw["artifacts"];
  if (declared === undefined || declared === null) return [];
  if (!Array.isArray(declared)) {
    throw new VerbUsageError(
      `${pointer}.artifacts is not an array. It lists the repo-relative paths this verb produces, which nen reports and never creates.`,
    );
  }
  return declared.map((entry, index): string => {
    if (typeof entry !== "string") {
      throw new VerbUsageError(
        `${pointer}.artifacts[${index}] is not a string. Each entry is one repo-relative path.`,
      );
    }
    return entry;
  });
}

/**
 * Every refused placeholder token in a set of steps, de-duplicated, in order.
 *
 * SPLIT OUT FROM THE REFUSAL BELOW because two callers ask the same question of
 * two different sources and owe a caller two different pointers: the lane's own
 * argv (`renderInvocation`) and the argv a TARGET composed onto it
 * (`resolveTarget`). One scanner, two sentences.
 */
function unsubstituted(steps: readonly RenderedStep[]): readonly string[] {
  const found: string[] = [];
  for (const step of steps) {
    for (const token of [step.exe, ...step.argv]) {
      for (const match of token.matchAll(BRACED)) {
        if (REFUSED.has(match[0])) found.push(match[0]);
      }
    }
  }
  return [...new Set(found)];
}

/** The half of the sentence both refusals end with: what is refused, and why. */
function placeholderRule(unique: readonly string[]): string {
  return `${unique.join(", ")}. Placeholder substitution is not in this release (zheref/nen#91). Nen will not guess what a placeholder stands for -- a guessed argument is a different command. (Only the reference pack's own tokens are refused -- ${REFUSED_PLACEHOLDERS.join(", ")}; every other braced argument is passed to the child exactly as written.)`;
}

function refuseUnsubstituted(steps: readonly RenderedStep[], lane: string, verb: string): void {
  const unique = unsubstituted(steps);
  if (unique.length === 0) return;
  throw new VerbUsageError(
    `'${verb}' on lane '${lane}' names ${unique.length === 1 ? "a placeholder" : "placeholders"} nen cannot substitute: ${placeholderRule(unique)} Write the literal argv this lane runs under project.verbs.${lane}.${verb}, or run the verb on a lane whose declaration carries none.`,
  );
}

/**
 * The steps, cwd, environment, host verdict and preconditions for one lane's
 * one verb. Refuses -- with this family's own codes -- rather than returning a
 * shape a caller has to inspect for emptiness.
 */
export function renderInvocation(
  project: ProjectBlock,
  request: RenderRequest,
): RenderedInvocation {
  const lane = resolveLane(project, request.lane);
  const declaredLane = project.lanes[lane];
  /* c8 ignore next -- resolveLane already refused an undeclared lane */
  if (declaredLane === undefined) throw new VerbUsageError(`lane '${lane}' is not declared.`);

  const perLane = project.verbs[lane];
  const declaredVerbs = perLane === undefined ? [] : Object.keys(perLane).sort();
  const invocation = perLane?.[request.verb];
  if (invocation === undefined) {
    throw new ShuRefusal(
      EXIT_UNSUPPORTED_VERB,
      `lane '${lane}' (${declaredLane.stack}) declares no '${request.verb}'. ${
        declaredVerbs.length === 0
          ? "It declares no verbs at all."
          : `It declares: ${declaredVerbs.join(", ")}.`
      } A verb this repository has is a verb this repository states, in nen/contract.json under project.verbs.${lane} -- nen never substitutes a plausible command for a declared one.`,
    );
  }
  if (invocation.kind === "unsupported") {
    throw new ShuRefusal(
      EXIT_UNSUPPORTED_VERB,
      `'${request.verb}' is unsupported on lane '${lane}' (${declaredLane.stack}). The declaration's own reason: ${invocation.reason}`,
    );
  }

  const declaredHosts = declaredHostsFor(project, request.verb);
  const supported = declaredHosts === null || declaredHosts.includes(request.platform);
  if (!supported) {
    throw new ShuRefusal(
      EXIT_UNSUPPORTED_HOST,
      `'${request.verb}' on lane '${lane}' (${declaredLane.stack}) is declared for ${declaredHosts.join(", ")}; this host is ${request.platform}. nen/contract.json states the platforms under project.hosts. Run it on a host it names, or on the CI job that does.`,
    );
  }

  const pointer = `project.verbs.${lane}.${request.verb}`;
  const steps = stepsOf(invocation);
  refuseUnsubstituted(steps, lane, request.verb);

  return {
    lane,
    stack: declaredLane.stack,
    verb: request.verb,
    // A PLAN IS TARGETLESS UNTIL A TARGET IS RESOLVED ONTO IT (`resolveTarget`
    // below). Rendering the lane's verb and choosing the destination are two
    // decisions, and the second one is refused in more ways than the first.
    target: null,
    cwdRelative: declaredLane.cwd,
    steps,
    env: envOf(invocation.raw, pointer),
    host: { platform: request.platform, supported: true, declared: declaredHosts },
    preconditions: lanePreconditions(project, lane),
    artifacts: artifactsOf(invocation.raw, pointer),
    why: invocation.why,
  };
}

/**
 * The lane's own preconditions, each carrying the address it came from.
 *
 * Split out only so the pointer is built beside the index it is built from --
 * ./run.ts used to build it from the index into the MERGED list, which is the
 * defect `RenderedPrecondition.pointer` exists to close.
 *
 * THE POINTER NAMES THE VALUE, `.value` AND ALL -- `project.preconditions.
 * <lane>[<i>].value`, not the row that carries it -- because that is the leaf
 * ./run.ts's `assertPreconditions` asserts, and a target-contributed row
 * (`project.targets.<name>.requiresEnv[<i>]`, built in `resolveTarget` below)
 * already points at its own leaf directly. One field, one meaning: whatever a
 * `RenderedPrecondition.pointer` says IS where the asserted value lives, and a
 * caller never appends anything to find it.
 */
function lanePreconditions(
  project: ProjectBlock,
  lane: string,
): readonly RenderedPrecondition[] {
  return (project.preconditions[lane] ?? []).map(
    (entry, index): RenderedPrecondition => ({
      kind: entry.kind,
      value: entry.value,
      why: entry.why,
      pointer: `project.preconditions.${lane}[${index}].value`,
    }),
  );
}

/**
 * The block a repository with no destinations pastes, and then edits.
 *
 * IT IS PART OF THE REFUSAL, not documentation the refusal points at. "declare
 * a target" is advice a reader has to go and look up the shape of; the shape
 * itself is four keys long and fits on the line that refused.
 */
const TARGETS_STUB =
  '"targets": { "<name>": { "args": ["<argument appended to the deploy argv>"], "requiresEnv": ["<VARIABLE_NAME>"], "why": "<what this destination is>" } }';

/** Byte order, the same order every listing in this family is printed in. */
function byteOrder(names: readonly string[]): readonly string[] {
  return [...names].sort((a, b): number => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The lane's declared argv with the destination's arguments on the end.
 *
 * NEN DOES NOT GUESS WHICH STEP REACHES THE DESTINATION. Appending to the LAST
 * step of a multi-step row would be an inference about somebody else's command
 * line -- the publishing step is usually the last one, and "usually" is exactly
 * the word this family refuses -- so a target that appends onto a multi-step
 * verb is refused with both facts and the two ways out.
 */
function appendArgs(
  plan: RenderedInvocation,
  args: readonly string[],
  target: string,
): readonly RenderedStep[] {
  if (args.length === 0) return plan.steps;
  const first = plan.steps[0];
  /* c8 ignore next -- `stepsOf` never returns an empty list for a runnable row */
  if (plan.steps.length !== 1 || first === undefined) {
    throw new VerbUsageError(
      `target '${target}' appends ${args.length} argument${args.length === 1 ? "" : "s"} (${args.join(
        " ",
      )}), and '${plan.verb}' on lane '${plan.lane}' declares ${plan.steps.length} steps. nen will not guess which of them reaches the destination: write the destination's arguments into the step that does, under project.verbs.${plan.lane}.${plan.verb}, and drop this target's 'args' -- or declare a single-step ${plan.verb} row.`,
    );
  }
  return [{ exe: first.exe, argv: [...first.argv, ...args] }];
}

/**
 * Resolve `--target` onto a rendered plan, or refuse.
 *
 * WHY THIS RUNS AFTER `renderInvocation` AND NOT BEFORE IT. The order used to
 * be the other way round -- `--target` was a usage gate checked before the lane
 * and the verb were read -- and the consequence was that a lane whose `deploy`
 * is an `unsupported` SEAT could never say so: `nen shu deploy --lane app` on a
 * lane that will never deploy answered "no targets declared" (exit 2), which
 * sends a maintainer to write a `targets` block that cannot make the row
 * runnable. Two facts were competing and the WEAKER one was winning:
 *
 *   * the seat is TERMINAL. "This lane has no deploy, in the repository's own
 *     words" is true whatever the command line says, and acting on the other
 *     refusal's advice does not change it.
 *   * a missing or unknown `--target` is a fact about the COMMAND LINE, which
 *     the caller fixes by typing something else.
 *
 * A refusal that sends someone to do work that cannot help is worse than one
 * that costs them a retype, so the terminal fact goes first -- and every
 * refusal `renderInvocation` makes (an undeclared lane, a seat, a host, an
 * unsubstituted placeholder) is a fact about the repository or the machine.
 * Once a plan EXISTS, the destination is the last thing decided before the
 * preconditions are asserted, and nothing has spawned either way.
 *
 * THE ONE THING THIS ORDER COSTS is that `--target typo` on a lane whose deploy
 * is a seat is answered with the seat rather than with the typo. That is the
 * right trade: the typo is invisible to a repository that will never deploy
 * that lane at all.
 */
export function resolveTarget(
  project: ProjectBlock,
  plan: RenderedInvocation,
  requested: string | null,
): RenderedInvocation {
  const declared = byteOrder(Object.keys(project.targets));
  if (requested === null) {
    throw new VerbUsageError(
      `'${plan.verb}' on lane '${plan.lane}' (${plan.stack}) needs --target, and there is no default -- not even when exactly one target is declared. nen never chooses where a build goes. ${
        declared.length === 0
          ? `This repository declares no targets at all, so there is nothing --target could name yet: add one to nen/contract.json under project.targets -- ${TARGETS_STUB} -- where 'args' and 'requiresEnv' are both optional and 'requiresEnv' names variables nen asserts are SET and never reads the value of.`
          : `Declared under project.targets: ${declared.join(", ")}.`
      }`,
    );
  }
  const target = Object.prototype.hasOwnProperty.call(project.targets, requested)
    ? project.targets[requested]
    : undefined;
  if (target === undefined) {
    // A TARGET THAT IS NOT DECLARED IS NOT A TARGET. Accepting the flag's mere
    // presence would make `--target` a formality a caller satisfies with any
    // word, which is the same as having no requirement -- and the requirement
    // exists because nen must never choose where a build goes.
    throw new VerbUsageError(
      `--target '${requested}' is not declared under project.targets. ${
        declared.length === 0
          ? `This repository declares no targets at all; add one before asking nen to deploy to it -- ${TARGETS_STUB}.`
          : `Declared: ${declared.join(", ")}.`
      }`,
    );
  }
  if (target.unsupported !== null) {
    // THE OTHER TERMINAL FACT, and it is the destination's rather than the
    // lane's: a hosting provider's git integration and a CI action are both
    // real deploys with NO COMMAND LINE for nen to run. Exit 4 with the
    // repository's own sentence, exactly as an unsupported verb row answers.
    throw new ShuRefusal(
      EXIT_UNSUPPORTED_VERB,
      `target '${requested}' has no command line at all, so there is nothing for nen to run on lane '${plan.lane}' (${plan.stack}). The declaration's own reason: ${target.unsupported}`,
    );
  }
  const steps = appendArgs(plan, target.args, requested);
  // THE SAME GUARD THE LANE'S OWN ARGV GETS, over the CONCATENATION. The lane's
  // half was checked in `renderInvocation`, before this target existed; a
  // target's `args` had never been checked at all, so `"args": ["-destination",
  // "{destination}"]` composed cleanly and handed the seam a literal
  // `{destination}` -- exit 0, and a token the pack publishes as a placeholder
  // reaching a real command line. The whole concatenation is re-scanned rather
  // than just `target.args`, because what must not carry an unsubstituted token
  // is the argv that spawns, and re-scanning tokens already proven clean costs
  // one pass over a list nen just built.
  const composed = unsubstituted(steps);
  if (composed.length > 0) {
    throw new VerbUsageError(
      `target '${requested}' composes ${composed.length === 1 ? "a placeholder" : "placeholders"} nen cannot substitute onto '${plan.verb}' on lane '${plan.lane}': ${placeholderRule(composed)} Write the literal argument this destination needs under project.targets.${requested}.args -- a destination is a fact this repository states, and nen substitutes nothing into it.`,
    );
  }
  // DE-DUPLICATED FIRST, AND THE REPORT CARRIES THE DE-DUPLICATED LIST. A
  // declaration repeating a name -- by hand, or by a generator -- printed the
  // row once per occurrence and counted each in "N preconditions are not
  // satisfied", so one unset variable was reported as three problems.
  const required = byteOrder([...new Set(target.requiresEnv)]);
  // AND A VARIABLE THE LANE ALREADY DECLARES IS ASSERTED ONCE. The two blocks
  // are different statements about the same fact -- the lane says "this build
  // needs it", the target says "this destination needs it" -- and both are
  // true, so `target.requiresEnv` above still lists it. What must not happen is
  // the ASSERTION running twice: two identical `FAIL env X` rows, in a table
  // whose only distinguishing column is the one the report does not print, is a
  // reader wondering which of the two Xs they failed to set.
  const laneEnv = new Set(
    plan.preconditions.flatMap((entry): readonly string[] =>
      entry.kind === "env" && typeof entry.value === "string" ? [entry.value] : [],
    ),
  );
  return {
    ...plan,
    target: {
      name: requested,
      args: target.args,
      requiresEnv: required,
    },
    steps,
    // ASSERTED THROUGH THE MACHINERY THAT ALREADY EXISTS. A destination's
    // required variables are preconditions of kind `env` -- ./run.ts asserts
    // that kind by checking the name is SET and never reading the value -- so
    // they are appended to the lane's own list rather than given a second
    // assertion path that would have to make the same promise twice. They come
    // AFTER the lane's, byte-ordered, each carrying its own pointer, and the
    // report's `target.requiresEnv` says which variables arrived this way.
    preconditions: [
      ...plan.preconditions,
      ...required
        .filter((name): boolean => !laneEnv.has(name))
        .map(
          (name): RenderedPrecondition => ({
            kind: "env",
            value: name,
            why: `required by the deploy target '${requested}'. nen asserts the variable is SET and never reads, compares or prints its value.`,
            // The index into what the FILE says, not into the sorted list a
            // reader never saw: a pointer is an address somebody opens.
            pointer: `project.targets.${requested}.requiresEnv[${target.requiresEnv.indexOf(name)}]`,
          }),
        ),
    ],
  };
}

/**
 * One argv rendered for a human, with any element containing whitespace quoted.
 *
 * THE QUOTING IS INFORMATION, NOT DECORATION. `-destination 'platform=iOS
 * Simulator,name=iPhone 17 Pro'` is ONE argv element; a reader who re-splits the
 * printed line on spaces gets a different command. The quotes say where the
 * element boundaries are, and the usage text says so.
 */
export function renderArgv(step: RenderedStep): string {
  return [step.exe, ...step.argv]
    .map((token): string => (/[\s'"]/.test(token) ? `'${token.replace(/'/g, "'\\''")}'` : token))
    .join(" ");
}
