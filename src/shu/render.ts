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
}

export interface HostVerdict {
  /** The platform this invocation is running on, from the seam. */
  readonly platform: string;
  readonly supported: boolean;
  /** The allowlist that applied, or null when the declaration constrains none. */
  readonly declared: readonly string[] | null;
}

export interface RenderedInvocation {
  readonly lane: string;
  readonly stack: string;
  readonly verb: string;
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

function refuseUnsubstituted(steps: readonly RenderedStep[], lane: string, verb: string): void {
  const found: string[] = [];
  for (const step of steps) {
    for (const token of [step.exe, ...step.argv]) {
      for (const match of token.matchAll(BRACED)) {
        if (REFUSED.has(match[0])) found.push(match[0]);
      }
    }
  }
  if (found.length === 0) return;
  const unique = [...new Set(found)];
  throw new VerbUsageError(
    `'${verb}' on lane '${lane}' names ${unique.length === 1 ? "a placeholder" : "placeholders"} nen cannot substitute: ${unique.join(", ")}. Placeholder substitution is not in this release (zheref/nen#91): write the literal argv this lane runs, or run the verb on a lane whose declaration carries none. Nen will not guess what a placeholder stands for -- a guessed argument is a different command. (Only the reference pack's own tokens are refused -- ${REFUSED_PLACEHOLDERS.join(", ")}; every other braced argument is passed to the child exactly as written.)`,
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
    cwdRelative: declaredLane.cwd,
    steps,
    env: envOf(invocation.raw, pointer),
    host: { platform: request.platform, supported: true, declared: declaredHosts },
    preconditions: (project.preconditions[lane] ?? []).map(
      (entry): RenderedPrecondition => ({ kind: entry.kind, value: entry.value, why: entry.why }),
    ),
    artifacts: artifactsOf(invocation.raw, pointer),
    why: invocation.why,
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
