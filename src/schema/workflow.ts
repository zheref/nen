// src/schema/workflow.ts -- `nen/workflow.json`: the POLICY a repository's
// delivery loop runs under, as data.
//
// WHAT SEPARATES IT FROM `nen/contract.json`, AND WHY IT IS A SECOND FILE. The
// contract says what nen EXECUTES -- lanes, per-lane verbs, argv, toolchain
// pins, deploy destinations. This file says what the loop's PARAMETERS are:
// which checks an iteration must prove, how a branch is named, where the
// coverage ladder's rungs sit, which attribution trailers a commit may carry,
// how long a monitor may run. Nothing here is ever spawned; nothing here names
// a program. Two files because they have two audiences and two lifetimes: a
// declaration changes when the build changes, a policy changes when the team's
// rules change, and merging them would make every policy edit a diff against
// the file every executing verb reads.
//
// EVERY KEY IS OPTIONAL AND EVERY DEFAULT IS STATED HERE, ONCE. An absent file
// is not an error and never has been -- `loadWorkflow` answers `present: false`
// with the defaults below, and `nen schema check` reports that as an `ok` row.
// That is deliberately UNLIKE ../schema/errors.ts's "no fallback" rule, and the
// difference is what the two kinds of file MEAN: a taxonomy fallback would make
// nen report label names this repository does not have, inventing somebody
// else's vocabulary. A policy default invents nobody's vocabulary -- 80/85/90
// is a number, `main` is a branch name the file can override in one line, and
// the alternative is refusing every repository that has not yet written a
// policy file for a verb that only wanted to know how many cycles to poll for.
// So: defaults for the SHAPE, never for a NAME. `models`, `launch.default` and
// `iteration.lane` have no default at all -- they would each be nen inventing a
// name -- and come back empty or null.
//
// UNKNOWN KEYS ARE PRESERVED, NEVER REJECTED, exactly as ../schema/contract.ts
// preserves them: this file is the repository's, and a policy key a later
// release (or a consumer's own tooling) reads must survive a round trip through
// a nen that has never heard of it. Every block therefore carries its `raw`
// record, exactly as the file states it.
//
// ...WITH ONE EXCEPTION, AND IT IS THE SAME EXCEPTION `project.targets` MAKES.
// A key that is ONE EDIT from a key nen reads is refused by pointer, naming the
// key it was one letter from. `{"minimun": 90}` is a perfectly-shaped number
// under a key nothing reads: it is preserved, the ladder keeps its default of
// 80, and a repository that believed it had raised its own bar has silently
// lowered it. Preservation is what makes that possible, so preservation is
// exactly why a near-miss cannot be preserved. The predicate is imported from
// ./contract.ts rather than copied -- one rule, one implementation.
//
// THE NEAR-MISS RULE APPLIES ONLY WHERE THE KEY SET IS CLOSED. `models` is an
// open map (a surface is whatever the ecosystem calls it, a tier likewise), the
// way `project.verbs` is open, so no key inside it is refused for resembling
// another -- there is nothing there for it to silently fail to be.
//
// A `$`-PREFIXED KEY IS METADATA (`$schema`, `$comment`), read by nobody and
// preserved by `raw` -- the same convention every loader in this family follows.

import {
  describeValue,
  optionalString,
  requireArray,
  requireRecord,
  requireString,
  SchemaError,
} from "./errors.js";
import { requireEnum, withinOneEdit } from "./contract.js";
import { readSchemaJson, resolveSchemaFile, type SchemaLocation } from "./source.js";

/** Where the policy file lives inside the target repository. */
export const WORKFLOW_FILE = "nen/workflow.json";

/**
 * The shape a trailer KEY may take, and the one place the rule lives.
 *
 * IT IS A GIT TRAILER KEY'S OWN CHARSET, held to a positive allowlist because
 * these names do not stay in this file: `nen scaffold init` interpolates every
 * one of them into a generated `commit-msg` hook -- as an ERE inside a
 * single-quoted shell string, and inside a double-quoted `echo` -- and
 * `nen commit format` compares a caller-typed `--trailer` key against them.
 * Anything outside the charset either changes what the hook MATCHES (a regex
 * metacharacter) or breaks out of the quoting (a quote character), and a key
 * that has to be escaped before it can be written was never a trailer key.
 *
 * ../scaffold/command.ts asks the same question of the keys a FLAG states and
 * imports this rather than restating it, exactly as it imports `ENV_VAR_NAME`
 * from ./contract.ts: a second copy is a second rule the day either is widened.
 */
export const TRAILER_KEY = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * The shape `branch.base` may take.
 *
 * IT LEAVES THIS FILE TOO. `nen scaffold init` writes a generated `pre-commit`
 * hook that compares `git branch --show-current` against this value inside a
 * double-quoted shell string, so a value carrying a `"`, a `$` or a backtick
 * would stop being a comparison and start being an expansion. The allowlist is
 * the intersection of "a name git accepts for a branch" and "a word no shell
 * reads twice": letters, digits, `.`, `_`, `/` and `-`, not starting with `-`.
 */
export const BRANCH_BASE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * The shape a path this policy states may take: repo-relative, and inert.
 *
 * `reports.dir` IS APPENDED TO A `.gitignore` AND `reports.captures` IS WRITTEN
 * UNDER IT. An absolute value ignores a path outside the repository; a `..`
 * segment names one; a newline turns one `.gitignore` line into two, the second
 * of which nobody wrote. Held to the same positive allowlist
 * ../scaffold/templates.ts holds a template's own paths to, and for the same
 * reason: the value is DATA that becomes a path, and a bad one must be refused
 * where it is read rather than where it is written.
 */
const REPO_RELATIVE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * The trailer keys nen itself considers ATTRIBUTION-shaped, in one place.
 *
 * WHY A FIXED LIST RATHER THAN A PATTERN. "Looks like an attribution trailer"
 * is not a shape a regex can decide -- `Closes`, `Refs` and `Reviewed-by` are
 * all `Word-word` -- so it is an enumeration, and an enumeration is a thing a
 * reader can audit. These are the keys that name WHO OR WHAT produced a commit;
 * a repository that wants one of them says so in
 * `commits.allowedAttributionTrailers`, and one that wants a key nen has never
 * heard of refused adds it to `commits.forbiddenTrailers`.
 *
 * IT IS NOT A PERSONA LIST AND CARRIES NO CONVENTION OF ANYBODY'S. Which key a
 * particular system stamps its own agent with is that system's data, stated in
 * its own `allowedAttributionTrailers`; nothing here names one.
 *
 * MATCHING IS CASE-INSENSITIVE, and both directions of it. `git
 * interpret-trailers` reads a trailer key without regard to case, so
 * `co-authored-by:` is the same trailer as `Co-Authored-By:` to every tool that
 * will ever read the commit -- a guard one capital letter defeats is not a
 * guard. The same insensitivity applies to the ALLOW list, so a repository
 * cannot admit a key in one spelling and be surprised by another.
 */
export const ATTRIBUTION_TRAILERS: readonly string[] = [
  "Assisted-by",
  "Claude-Session",
  "Co-Authored-By",
  "Co-authored-by",
  "Generated-by",
  "Generated-with",
  "Reviewed-by",
  "Signed-off-by",
];

// ── the blocks ──────────────────────────────────────────────────────────────

export interface BranchPolicy {
  /** The branch-name template. Must carry `{descriptor}`. */
  readonly template: string;
  /** The trunk a branch is cut from and a commit is refused on. */
  readonly base: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface IterationPolicy {
  /** Verb names, run through the declaration, that every iteration proves. */
  readonly checks: readonly string[];
  /** The lane those checks run in. `null` means "whatever `--lane` says". */
  readonly lane: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface TestsPolicy {
  readonly required: readonly string[];
  readonly extra: readonly string[];
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface CoveragePolicy {
  /** The stop rung: below this, the loop stops and asks. */
  readonly minimum: number;
  readonly recommended: number;
  readonly ideal: number;
  /** What the ladder is measured over -- the repository's own word. */
  readonly scope: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface LaunchPolicy {
  /** The `project.launch` target name a bare launch uses. No default ever. */
  readonly default: string | null;
  readonly fallback: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface ReportsPolicy {
  readonly dir: string;
  readonly retain: string;
  readonly template: string;
  readonly captures: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface NotificationsPolicy {
  readonly rungs: readonly string[];
  readonly sound: string;
  /**
   * How loud an ORDINARY turn is -- one with no gate. `"rung1"` rings only
   * the first rung `rungs` lists; `"all"` rings every rung `rungs` lists, on
   * every turn. A gate always rings everything `rungs` lists regardless of
   * this value, and `turn` can only WITHHOLD an escalation `rungs` already
   * grants -- it can never conjure a rung `rungs` does not list. nen fires
   * none of the three rungs itself; this is policy data for whichever host
   * hook rings them.
   */
  readonly turn: "rung1" | "all";
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface CommitsPolicy {
  /** Attribution trailer keys this repository ADMITS. Everything else is refused. */
  readonly allowedAttributionTrailers: readonly string[];
  /** Extra keys this repository refuses, on top of `ATTRIBUTION_TRAILERS`. */
  readonly forbiddenTrailers: readonly string[];
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface MonitorPolicy {
  readonly maxCycles: number;
  readonly pollSeconds: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface ModelsPolicy {
  /** The repository's own sentence about how a model is chosen. Never nen's. */
  readonly rule: string | null;
  /** surface -> tier -> the alias. BOTH levels are an open key space. */
  readonly surfaces: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** role -> tier name. */
  readonly roles: Readonly<Record<string, string>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface Workflow {
  readonly schema: string | null;
  readonly branch: BranchPolicy;
  readonly iteration: IterationPolicy;
  readonly tests: TestsPolicy;
  readonly coverage: CoveragePolicy;
  readonly launch: LaunchPolicy;
  readonly reports: ReportsPolicy;
  readonly notifications: NotificationsPolicy;
  readonly commits: CommitsPolicy;
  readonly monitor: MonitorPolicy;
  readonly models: ModelsPolicy;
  /** The document exactly as the file states it, every key preserved. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface LoadedWorkflow {
  /**
   * The absolute path this policy came from, or WOULD come from when absent --
   * always the canonical `nen/workflow.json`, so a message about an absent
   * policy names the path to create rather than nothing at all.
   */
  readonly path: string;
  readonly present: boolean;
  /** Which directory answered. Always `nen`: this file has no legacy location. */
  readonly location: SchemaLocation;
  readonly workflow: Workflow;
  /** The document as stated, or `{}` when the file is absent. */
  readonly raw: Readonly<Record<string, unknown>>;
}

// ── the defaults, in one place ──────────────────────────────────────────────

/** The branch template every default carries, and the token it must contain. */
export const DESCRIPTOR_TOKEN = "{descriptor}";

export const DEFAULT_BRANCH_TEMPLATE = "{model}/{persona}/{descriptor}";
export const DEFAULT_BASE = "main";
export const DEFAULT_CHECKS: readonly string[] = ["build"];
export const DEFAULT_REQUIRED_TESTS: readonly string[] = ["test"];
export const DEFAULT_MINIMUM = 80;
export const DEFAULT_RECOMMENDED = 85;
export const DEFAULT_IDEAL = 90;
export const DEFAULT_SCOPE = "touched";
export const DEFAULT_REPORTS_DIR = "Reports";
export const DEFAULT_RETAIN = "final-only";
export const DEFAULT_REPORT_TEMPLATE = "rikugan";
export const DEFAULT_CAPTURES = "Reports/captures";
export const DEFAULT_RUNGS: readonly string[] = ["push", "os", "sound"];
export const DEFAULT_SOUND = "Glass";
/** The two values `notifications.turn` may take, in one place. */
export const TURN_VALUES = ["rung1", "all"] as const;
export const DEFAULT_TURN: (typeof TURN_VALUES)[number] = "rung1";
export const DEFAULT_MAX_CYCLES = 20;
export const DEFAULT_POLL_SECONDS = 300;

/**
 * The policy a repository that states none runs under.
 *
 * NOTHING HERE IS A NAME THIS REPOSITORY DID NOT ALREADY HAVE. `main` is the
 * only string that even resembles one, and it is the one value every git
 * repository starts with; a repository whose trunk is called something else
 * says so in one line. The two blocks that WOULD require nen to invent a name
 * -- `launch.default` and `models` -- have no default and come back null/empty.
 */
export function defaultWorkflow(): Workflow {
  const empty: Readonly<Record<string, unknown>> = {};
  return {
    schema: null,
    branch: { template: DEFAULT_BRANCH_TEMPLATE, base: DEFAULT_BASE, raw: empty },
    iteration: { checks: DEFAULT_CHECKS, lane: null, raw: empty },
    tests: { required: DEFAULT_REQUIRED_TESTS, extra: [], raw: empty },
    coverage: {
      minimum: DEFAULT_MINIMUM,
      recommended: DEFAULT_RECOMMENDED,
      ideal: DEFAULT_IDEAL,
      scope: DEFAULT_SCOPE,
      raw: empty,
    },
    launch: { default: null, fallback: null, raw: empty },
    reports: {
      dir: DEFAULT_REPORTS_DIR,
      retain: DEFAULT_RETAIN,
      template: DEFAULT_REPORT_TEMPLATE,
      captures: DEFAULT_CAPTURES,
      raw: empty,
    },
    notifications: { rungs: DEFAULT_RUNGS, sound: DEFAULT_SOUND, turn: DEFAULT_TURN, raw: empty },
    commits: { allowedAttributionTrailers: [], forbiddenTrailers: [], raw: empty },
    monitor: { maxCycles: DEFAULT_MAX_CYCLES, pollSeconds: DEFAULT_POLL_SECONDS, raw: empty },
    models: { rule: null, surfaces: {}, roles: {}, raw: empty },
    raw: empty,
  };
}

// ── readers ─────────────────────────────────────────────────────────────────

/** The blocks this loader reads. Everything else at the root is preserved. */
const ROOT_KEYS: readonly string[] = [
  "branch",
  "iteration",
  "tests",
  "coverage",
  "launch",
  "reports",
  "notifications",
  "commits",
  "monitor",
  "models",
];

const BRANCH_KEYS: readonly string[] = ["template", "base"];
const ITERATION_KEYS: readonly string[] = ["checks", "lane"];
const TESTS_KEYS: readonly string[] = ["required", "extra"];
const COVERAGE_KEYS: readonly string[] = ["minimum", "recommended", "ideal", "scope"];
const LAUNCH_KEYS: readonly string[] = ["default", "fallback"];
const REPORTS_KEYS: readonly string[] = ["dir", "retain", "template", "captures"];
const NOTIFICATIONS_KEYS: readonly string[] = ["rungs", "sound", "turn"];
const COMMITS_KEYS: readonly string[] = ["allowedAttributionTrailers", "forbiddenTrailers"];
const MONITOR_KEYS: readonly string[] = ["maxCycles", "pollSeconds"];

/**
 * A key one typo away from a key nen reads, refused by the name it meant.
 *
 * ../schema/contract.ts's `project.targets` states the whole argument; this is
 * the same rule applied to a file where the stakes are the same shape. A
 * `{"recommeded": 95}` is preserved verbatim, read by nobody, and the ladder
 * quietly keeps the default the repository was trying to change.
 */
function refuseNearMissKey(
  path: string,
  pointer: string,
  raw: Readonly<Record<string, unknown>>,
  known: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(raw)) {
    if (key.startsWith("$") || known.includes(key)) continue;
    const meant = known.find((candidate): boolean => withinOneEdit(key, candidate));
    if (meant === undefined) continue;
    throw new SchemaError(
      path,
      pointer === "" ? key : `${pointer}.${key}`,
      `is one letter away from '${meant}', which is a key nen reads, and is not a key nen reads. ${what} ${known.join(
        ", ",
      )}; every OTHER key is preserved verbatim for a later release, and that is exactly why this one cannot be: '${key}' would be kept, read by nobody, and '${meant}' would silently keep its default. Fix the spelling, or rename the key to something that is not a near-miss of one nen reads`,
    );
  }
}

/** One block: an object, or `{}` when the key is absent. */
function block(
  path: string,
  pointer: string,
  value: unknown,
  known: readonly string[],
  what: string,
): Readonly<Record<string, unknown>> {
  if (value === undefined || value === null) return {};
  const raw = requireRecord(path, pointer, value);
  refuseNearMissKey(path, pointer, raw, known, what);
  return raw;
}

/** A string, or the stated default when the key is absent. */
function stringOr(path: string, pointer: string, value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  return requireString(path, pointer, value);
}

/** A list of non-empty strings, or the stated default when the key is absent. */
function stringsOr(
  path: string,
  pointer: string,
  value: unknown,
  fallback: readonly string[],
): readonly string[] {
  if (value === undefined || value === null) return fallback;
  return requireArray(path, pointer, value).map((item, index): string =>
    requireString(path, `${pointer}[${index}]`, item),
  );
}

/**
 * A whole number inside a stated range, or the default when the key is absent.
 *
 * NON-INTEGER AND OUT-OF-RANGE ARE REFUSED SEPARATELY, because they are
 * different mistakes with different fixes: `0.85` is a ladder written as a
 * fraction (the rung is a PERCENTAGE here), and `120` is a bar no run can ever
 * clear -- a check that could only ever report FAIL, which is ../schema/
 * contract.ts's own reason for refusing an unsettable environment name at load.
 */
function numberOr(
  path: string,
  pointer: string,
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SchemaError(path, pointer, `expected a number, got ${describeValue(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new SchemaError(
      path,
      pointer,
      `expected a whole number between ${min} and ${max}, got ${value}. The rungs of this ladder are PERCENTAGES, not fractions: 85 rather than 0.85`,
    );
  }
  if (value < min || value > max) {
    throw new SchemaError(
      path,
      pointer,
      `expected a whole number between ${min} and ${max}, got ${value}. A bar outside that range is one no run can ever report honestly about`,
    );
  }
  return value;
}

function parseBranch(path: string, value: unknown): BranchPolicy {
  const raw = block(
    path,
    "branch",
    value,
    BRANCH_KEYS,
    "A branch policy's two keys are",
  );
  const template = stringOr(path, "branch.template", raw["template"], DEFAULT_BRANCH_TEMPLATE);
  if (!template.includes(DESCRIPTOR_TOKEN)) {
    // THE ONE TOKEN THAT MAKES A TEMPLATE A TEMPLATE. Every other token is
    // optional -- a repository whose branches are `<persona>/<thing>` or plain
    // `feature/<thing>` is stating a real convention -- but a template with no
    // `{descriptor}` renders the SAME branch name for every effort, so the
    // second warm-up under it either collides with the first or silently
    // reuses somebody else's branch. Refused by name at load, where it costs a
    // one-line fix, rather than at the checkout that finds the branch taken.
    throw new SchemaError(
      path,
      "branch.template",
      `'${template}' carries no '${DESCRIPTOR_TOKEN}'. Every other token in a branch template is optional; this one is what makes two branches cut under the same policy different names, so a template without it renders one branch name for every effort this repository ever runs`,
    );
  }
  const base = stringOr(path, "branch.base", raw["base"], DEFAULT_BASE);
  if (!BRANCH_BASE.test(base) || base.includes("..")) {
    throw new SchemaError(
      path,
      "branch.base",
      `'${base}' is not a name this policy can act on. It is compared against 'git branch --show-current' inside the pre-commit hook 'nen scaffold init' generates, so it is held to the names git accepts that a shell also reads only once: letters, digits, '.', '_', '/' and '-', not starting with '-' and with no '..'`,
    );
  }
  return { template, base, raw };
}

function parseIteration(path: string, value: unknown): IterationPolicy {
  const raw = block(
    path,
    "iteration",
    value,
    ITERATION_KEYS,
    "An iteration policy's two keys are",
  );
  return {
    checks: stringsOr(path, "iteration.checks", raw["checks"], DEFAULT_CHECKS),
    lane: optionalString(path, "iteration.lane", raw["lane"]),
    raw,
  };
}

function parseTests(path: string, value: unknown): TestsPolicy {
  const raw = block(path, "tests", value, TESTS_KEYS, "A tests policy's two keys are");
  return {
    required: stringsOr(path, "tests.required", raw["required"], DEFAULT_REQUIRED_TESTS),
    extra: stringsOr(path, "tests.extra", raw["extra"], []),
    raw,
  };
}

function parseCoverage(path: string, value: unknown): CoveragePolicy {
  const raw = block(
    path,
    "coverage",
    value,
    COVERAGE_KEYS,
    "A coverage policy's four keys are",
  );
  const minimum = numberOr(path, "coverage.minimum", raw["minimum"], DEFAULT_MINIMUM, 0, 100);
  const recommended = numberOr(
    path,
    "coverage.recommended",
    raw["recommended"],
    DEFAULT_RECOMMENDED,
    0,
    100,
  );
  const ideal = numberOr(path, "coverage.ideal", raw["ideal"], DEFAULT_IDEAL, 0, 100);
  // THE LADDER MUST BE A LADDER. Three numbers that do not ascend are three
  // rungs whose ORDER is the whole of their meaning: `minimum` is the rung a
  // run stops under, `ideal` the one it aims at, and a file saying
  // `{"minimum": 90, "ideal": 80}` describes a bar that is simultaneously the
  // floor and above the target. Nen cannot pick which of the two the author
  // meant, and either guess silently changes where a run stops.
  if (!(minimum <= recommended && recommended <= ideal)) {
    throw new SchemaError(
      path,
      "coverage",
      `states a ladder that does not ascend: minimum ${minimum}, recommended ${recommended}, ideal ${ideal}. The three rungs mean 'stop below this', 'aim for this', 'this is the target', so they must satisfy minimum <= recommended <= ideal -- nen will not guess which of the three was mistyped`,
    );
  }
  return {
    minimum,
    recommended,
    ideal,
    scope: stringOr(path, "coverage.scope", raw["scope"], DEFAULT_SCOPE),
    raw,
  };
}

function parseLaunch(path: string, value: unknown): LaunchPolicy {
  const raw = block(path, "launch", value, LAUNCH_KEYS, "A launch policy's two keys are");
  return {
    default: optionalString(path, "launch.default", raw["default"]),
    fallback: optionalString(path, "launch.fallback", raw["fallback"]),
    raw,
  };
}

/** One path this policy states, held to `REPO_RELATIVE_PATH`. */
function requireRepoPath(path: string, pointer: string, value: string): string {
  if (REPO_RELATIVE_PATH.test(value) && !value.split("/").includes("..")) return value;
  throw new SchemaError(
    path,
    pointer,
    `'${value}' is not a path this policy can act on. It names a directory INSIDE this repository -- 'nen scaffold init' appends it to .gitignore and reports are written under it -- so it is repo-relative, has no '..' segment, and carries no character a .gitignore line cannot hold`,
  );
}

function parseReports(path: string, value: unknown): ReportsPolicy {
  const raw = block(path, "reports", value, REPORTS_KEYS, "A reports policy's four keys are");
  return {
    dir: requireRepoPath(
      path,
      "reports.dir",
      stringOr(path, "reports.dir", raw["dir"], DEFAULT_REPORTS_DIR),
    ),
    retain: stringOr(path, "reports.retain", raw["retain"], DEFAULT_RETAIN),
    template: stringOr(path, "reports.template", raw["template"], DEFAULT_REPORT_TEMPLATE),
    captures: requireRepoPath(
      path,
      "reports.captures",
      stringOr(path, "reports.captures", raw["captures"], DEFAULT_CAPTURES),
    ),
    raw,
  };
}

function parseNotifications(path: string, value: unknown): NotificationsPolicy {
  const raw = block(
    path,
    "notifications",
    value,
    NOTIFICATIONS_KEYS,
    "A notifications policy's three keys are",
  );
  const turnRaw = raw["turn"];
  return {
    rungs: stringsOr(path, "notifications.rungs", raw["rungs"], DEFAULT_RUNGS),
    sound: stringOr(path, "notifications.sound", raw["sound"], DEFAULT_SOUND),
    turn:
      turnRaw === undefined || turnRaw === null
        ? DEFAULT_TURN
        : requireEnum(path, "notifications.turn", turnRaw, TURN_VALUES),
    raw,
  };
}

/** One trailer key a policy states, checked against the shape a hook can carry. */
function requireTrailerKey(path: string, pointer: string, key: string): string {
  if (TRAILER_KEY.test(key)) return key;
  throw new SchemaError(
    path,
    pointer,
    `'${key}' is not a name a git trailer key can have ([A-Za-z0-9][A-Za-z0-9-]*). This name is interpolated into the generated commit-msg hook -- as a pattern and inside a quoted message -- and compared against a caller's --trailer key, so a value carrying a colon, a space or a regex metacharacter would change what the hook matches rather than what it admits. State the key alone: 'Some-Key', not 'Some-Key: value'`,
  );
}

function parseCommits(path: string, value: unknown): CommitsPolicy {
  const raw = block(path, "commits", value, COMMITS_KEYS, "A commits policy's two keys are");
  const read = (key: string): readonly string[] =>
    stringsOr(path, `commits.${key}`, raw[key], []).map((entry, index): string =>
      requireTrailerKey(path, `commits.${key}[${index}]`, entry),
    );
  const allowedAttributionTrailers = read("allowedAttributionTrailers");
  const forbiddenTrailers = read("forbiddenTrailers");
  // A KEY ON BOTH LISTS IS A POLICY WITH TWO ANSWERS. Honouring either half
  // would be nen deciding which of two things the repository said it meant, and
  // the two halves are read by different callers -- `nen commit format` and the
  // generated hook -- so a silent pick would refuse in one place and admit in
  // the other, which is worse than either.
  const both = allowedAttributionTrailers.filter((key): boolean =>
    forbiddenTrailers.some((other): boolean => other.toLowerCase() === key.toLowerCase()),
  );
  if (both.length > 0) {
    throw new SchemaError(
      path,
      "commits",
      `lists ${both.map((key): string => `'${key}'`).join(", ")} as both allowed and forbidden. A trailer key is one or the other; nen will not pick, because the two lists are read by different callers and a guess would admit the key in one place and refuse it in the other`,
    );
  }
  return { allowedAttributionTrailers, forbiddenTrailers, raw };
}

function parseMonitor(path: string, value: unknown): MonitorPolicy {
  const raw = block(path, "monitor", value, MONITOR_KEYS, "A monitor policy's two keys are");
  return {
    // A CAP OF ZERO IS A LOOP THAT NEVER RUNS, which is a thing a repository is
    // allowed to say; there is no upper bound, because "how long may a monitor
    // watch" is the caller's business and any ceiling here would be nen's
    // opinion about somebody else's patience.
    maxCycles: numberOr(path, "monitor.maxCycles", raw["maxCycles"], DEFAULT_MAX_CYCLES, 0, Number.MAX_SAFE_INTEGER),
    pollSeconds: numberOr(
      path,
      "monitor.pollSeconds",
      raw["pollSeconds"],
      DEFAULT_POLL_SECONDS,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    raw,
  };
}

/**
 * `models` -- an OPEN map at both levels, validated for TYPE and nothing else.
 *
 * `rule` and `roles` are the two keys nen names; every other key is a SURFACE,
 * and a surface's keys are TIERS. Both are the ecosystem's vocabulary rather
 * than nen's -- which is why no near-miss refusal runs here and no tier name is
 * written down anywhere in this file. What IS checked is that every leaf is a
 * string, because a leaf is an alias a caller pastes into a subagent's model
 * field, and an object there is a caller reading `[object Object]`.
 */
function parseModels(path: string, value: unknown): ModelsPolicy {
  if (value === undefined || value === null) {
    return { rule: null, surfaces: {}, roles: {}, raw: {} };
  }
  const raw = requireRecord(path, "models", value);
  const surfaces: Record<string, Readonly<Record<string, string>>> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (name.startsWith("$") || name === "rule" || name === "roles") continue;
    const pointer = `models.${name}`;
    const perSurface = requireRecord(path, pointer, entry);
    const tiers: Record<string, string> = {};
    for (const [tier, alias] of Object.entries(perSurface)) {
      if (tier.startsWith("$")) continue;
      tiers[tier] = requireString(path, `${pointer}.${tier}`, alias);
    }
    surfaces[name] = tiers;
  }
  const rolesRaw = raw["roles"];
  const roles: Record<string, string> = {};
  if (rolesRaw !== undefined && rolesRaw !== null) {
    for (const [role, tier] of Object.entries(requireRecord(path, "models.roles", rolesRaw))) {
      if (role.startsWith("$")) continue;
      roles[role] = requireString(path, `models.roles.${role}`, tier);
    }
  }
  return {
    rule: optionalString(path, "models.rule", raw["rule"]),
    surfaces,
    roles,
    raw,
  };
}

export function parseWorkflow(path: string, value: unknown): Workflow {
  const raw = requireRecord(path, "(root)", value);
  refuseNearMissKey(path, "", raw, ROOT_KEYS, "A workflow's ten blocks are");
  return {
    // `$schema` IS A `$`-KEY LIKE EVERY OTHER -- surfaced when it happens to be
    // a string, ignored otherwise, and preserved either way by `raw`. The same
    // rule ../schema/contract.ts states for the same field.
    schema: typeof raw["$schema"] === "string" && raw["$schema"] !== "" ? raw["$schema"] : null,
    branch: parseBranch(path, raw["branch"]),
    iteration: parseIteration(path, raw["iteration"]),
    tests: parseTests(path, raw["tests"]),
    coverage: parseCoverage(path, raw["coverage"]),
    launch: parseLaunch(path, raw["launch"]),
    reports: parseReports(path, raw["reports"]),
    notifications: parseNotifications(path, raw["notifications"]),
    commits: parseCommits(path, raw["commits"]),
    monitor: parseMonitor(path, raw["monitor"]),
    models: parseModels(path, raw["models"]),
    raw,
  };
}

/**
 * Read and validate `nen/workflow.json`.
 *
 * AN ABSENT FILE IS NEVER AN ERROR -- it is `present: false` plus the defaults
 * above, which is what lets every caller read a policy unconditionally instead
 * of each one deciding for itself what a repository with no policy means. A
 * file that IS there and is WRONG still throws, loudly and by pointer: the
 * distinction this loader draws is the one ../schema/taxonomy.ts draws for
 * every other optional file.
 */
export function loadWorkflow(repoRoot: string): LoadedWorkflow {
  const resolved = resolveSchemaFile(repoRoot, WORKFLOW_FILE);
  const absent = (): LoadedWorkflow => ({
    path: resolved.canonical.path,
    present: false,
    location: "nen",
    workflow: defaultWorkflow(),
    raw: {},
  });
  // ABSENCE IS ../schema/source.ts's OWN QUESTION, ASKED ITS OWN WAY. Its probe
  // already folds the two errnos that mean "nothing can be there" into one
  // answer -- an ENOENT, and the ENOTDIR a stray FILE named `nen` produces --
  // and a repository with a file where that directory belongs is a repository
  // with no policy, which is exactly what it would be with no `nen` entry at
  // all. Deciding it from the READ's error message instead made the stray-file
  // case an unreadable POLICY rather than an absent one, which is a different
  // and much louder thing.
  if (!resolved.canonical.present) return absent();
  // A FILE THE PROBE SAW AND THE READ CANNOT OPEN IS NOT ABSENT, AND THE READ'S
  // OWN ERRNO IS NOT ALLOWED TO SAY OTHERWISE. An EACCES, an EISDIR or a
  // malformed JSON document is a policy this repository HAS and nen could not
  // read -- and so is a DANGLING SYMLINK, which fails the read with a plain
  // ENOENT that ../schema/source.ts phrases as "no such file". Branching on
  // that phrasing here would have made the one case ../schema/source.ts's own
  // probe exists to catch -- a link at `nen/workflow.json` pointing at nothing
  // -- read as "no policy, defaults apply", which is the fail-open this loader
  // must not have. The probe decides absence; everything after it throws.
  const read: { path: string; value: unknown; location: SchemaLocation } = readSchemaJson(
    repoRoot,
    WORKFLOW_FILE,
  );
  const workflow = parseWorkflow(read.path, read.value);
  return {
    path: read.path,
    present: true,
    location: read.location,
    workflow,
    raw: workflow.raw,
  };
}

/** A one-line `nen schema check` summary of what the policy states. */
export function describeWorkflow(workflow: Workflow): string {
  const { coverage, branch, iteration } = workflow;
  return `coverage ${coverage.minimum}/${coverage.recommended}/${coverage.ideal} (${coverage.scope}), branch '${branch.template}' off '${branch.base}', checks: ${
    iteration.checks.join(", ") || "(none)"
  }`;
}

/**
 * Every trailer key this policy REFUSES, resolved once.
 *
 * ONE ANSWER FOR TWO CALLERS. `nen commit format` asks it of a `--trailer` a
 * caller typed; `nen scaffold init` asks it once at generation time and bakes
 * the answer into the commit-msg hook as data. A second derivation of "which
 * keys are refused" would be a second policy, and the two would disagree the
 * first time either list changed -- with the CLI admitting a trailer the hook
 * then rejects at the moment of commit, or worse, the other way round.
 */
export function refusedTrailerKeys(commits: CommitsPolicy): readonly string[] {
  const allowed = new Set(
    commits.allowedAttributionTrailers.map((key): string => key.toLowerCase()),
  );
  const refused: string[] = [];
  const seen = new Set<string>();
  for (const key of [...ATTRIBUTION_TRAILERS, ...commits.forbiddenTrailers]) {
    const lower = key.toLowerCase();
    if (allowed.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    refused.push(key);
  }
  return refused;
}

/**
 * Whether one caller-typed trailer key is refused by this policy.
 *
 * CASE-INSENSITIVE, for the reason `ATTRIBUTION_TRAILERS` states: every tool
 * that will read the finished commit reads a trailer key without regard to
 * case, so a guard that a capital defeats guards nothing.
 */
export function trailerRefusal(commits: CommitsPolicy, key: string): string | null {
  const lower = key.trim().toLowerCase();
  const refused = refusedTrailerKeys(commits).find(
    (candidate): boolean => candidate.toLowerCase() === lower,
  );
  return refused ?? null;
}
