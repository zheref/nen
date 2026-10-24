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
import { readSchemaFile, resolveSchemaFile, type SchemaLocation } from "./source.js";
import { refuseDuplicateKeyWithin } from "./gates.js";
import { exactPathProblem, matchesPattern } from "../report/patterns.js";
import { releaseLinePatterns, ReleaseLinePatternsError } from "./pattern.js";
import { RELEASE_PATTERN_LIMITS } from "./releasepattern.js";
import { CONVENTIONAL_SUBJECT_CASE, parseBodyWidth, parseSubjectCaseTuple, type SubjectCaseSpec } from "../commit/rule.js";

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

/**
 * `deploy` -- the destination a caller's OWN tooling sends to when it is told
 * no target (zheref/nen#300; zheref/hatsu#146).
 *
 * NEN NEVER READS THIS TO CHOOSE ANYTHING. `nen shu deploy` still requires
 * `--target` with no default, ever; the reader of `defaultTarget` is a
 * consumer's skill (Hatsu's `kagutsuchi`), which passes it to `--target`
 * explicitly. So "nen never chooses where a build goes" stays true of nen, and
 * the choice lives in a file the maintainer wrote.
 *
 * NEN VALIDATES IT ANYWAY, because a value here IS a destination name: a
 * non-string is refused at load, by pointer, like every other key in this
 * file; a string naming no key of `nen/contract.json`'s `project.targets` is a
 * cross-file fact this loader cannot see, so `nen schema check` fails it on its
 * own pointer row (../schema/taxonomy.ts). `null`, or the key absent, is the
 * ordinary state and means "ask" -- no default name, ever, for the same reason
 * `launch.default` has none.
 */
export interface DeployPolicy {
  /** A key of `project.targets`, or null for "none declared". No default ever. */
  readonly defaultTarget: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * `privateNames` -- the private-name guard's COMMITTED NAMED LIST
 * (zheref/nen#441): private repositories whose NAME a recorded ruling made
 * public while their code stays private.
 *
 * ONE KEY, A REPO-RELATIVE PATH, AND NO DEFAULT EVER. The guard
 * (../issue/privacy.ts) exempts the exact `owner/name` slugs that file lists,
 * beside the caller's own `--private-names-ignore-file`. THE CHECKOUT'S COPY
 * OF THIS KEY IS ONLY THE SWITCH: declared here, the guard looks; what it
 * reads -- this policy, the path and the list -- it takes at the remote's
 * default branch (`refs/remotes/origin/HEAD`), never from the checkout,
 * because a list the change under review can edit is an exemption it wrote
 * for itself (zheref/nen#363, Feitan F8), and a committed file, this key and
 * `branch.base` are exactly what a branch can edit. A line reaches the guard
 * once it has been merged to the default branch and fetched. No default,
 * because the file publishes what it names and only a ruling may.
 */
export interface PrivateNamesPolicy {
  /** The committed named list's repo-relative path, or null for "none declared". No default ever. */
  readonly namedFile: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * ONE REPORT VARIANT: which template renders it, and which blocks it carries.
 *
 * WHICH BLOCKS A REPORT SHOWS IS CONFIGURATION, NOT CODE (zheref/nen#220). A
 * turn report, a landing report and a dated final report are the same page
 * rendered with different parts switched on, and the repository that owns the
 * template is the one that knows which parts. `nen report render --variant
 * <name>` injects `sections.<block>` presence flags from these lists, so a
 * template writes `{{#if sections.desk}}…{{/if}}` and the decision lives in
 * this file beside `reports.template` rather than in a renderer nen ships.
 */
export interface ReportSection {
  /** The template this variant renders with -- `reports.template`'s vocabulary. */
  readonly template: string;
  /** The blocks it carries, in the order the file states them. Never empty. */
  readonly blocks: readonly string[];
}

export interface ReportsPolicy {
  readonly dir: string;
  readonly retain: string;
  readonly template: string;
  readonly captures: string;
  /** Variant name -> its template and blocks. Empty when none are declared. */
  readonly sections: Readonly<Record<string, ReportSection>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * ONE REVIEW SCOPE: who reads it, at what tier, how often, and over which paths.
 *
 * THE PATHS ARE ../report/patterns.ts's GRAMMAR, the same one `report data
 * --tiers` reads -- a prefix matched on segment boundaries, or a narrow glob.
 * One grammar, because a maintainer who writes `hooks/**` in a tier table and
 * in a scope list is entitled to have it claim the same files in both.
 *
 * `tier` AND `persona` ARE THE REPOSITORY'S OWN VOCABULARY and nen validates
 * neither against a list: a persona is a name somebody's roster gives a
 * reviewer, and a tier is a key of `models.<surface>`, which this file has
 * always treated as an open map. Nen holds them to being non-empty strings and
 * nothing more -- an enumeration here would be nen inventing somebody else's
 * roster, which is the refusal this module's own header states about `models`.
 */
export interface ReviewScope {
  readonly persona: string;
  readonly tier: string;
  /** Reviews this scope may spend per session and repository. `0` disables it. */
  readonly budget: number;
  readonly paths: readonly string[];
}

export interface ReviewPolicy {
  /** Scope name -> its row, in the file's own declaration order. */
  readonly scopes: Readonly<Record<string, ReviewScope>>;
  /**
   * Personas the repository declares never to be code reviewers (zheref/nen#472;
   * Hatsu HR-23's intake examiners), as written. No scope may name one.
   */
  readonly excludedPersonas: readonly string[];
  readonly raw: Readonly<Record<string, unknown>>;
}

/** The three repo kinds `futon.advanceGo` may name -- ../repo/classify.ts's own vocabulary, never a fourth invented here. */
export type AdvanceGoKind = "product" | "process" | "library";
export const ADVANCE_GO_KINDS: readonly AdvanceGoKind[] = ["product", "process", "library"];

/**
 * ONE CONTENT-SCOPED ENTRY of `release.unitPaths`: an EXACT JSON file, bounded
 * not to "the whole file" but to a set of its own LEAF keys -- a version file
 * a release unit owns may bump `version` without the unit ever claiming
 * `description` too. `path` is compared by EXACT EQUALITY against a changed
 * file's path, never a pattern -- a content-scoped bound only ever makes
 * sense for one named file, because "which keys may change" is a question
 * with one answer per file, not per glob. `keys` is a JSON pointer
 * (`/version`) or dotted (`version`) leaf path, normalized the same way by
 * ../release/unitcheck.ts's own reader -- SHAPE validated here, never
 * resolved against real file content, which is that module's own job once a
 * pull request's base and head are known.
 */
export interface ReleaseUnitKeyedPath {
  readonly path: string;
  readonly keys: readonly string[];
}

/** One exact text file, bounded to the full-line regexes its removed AND added lines must match. */
export interface ReleaseUnitLinedPath {
  readonly path: string;
  readonly lines: readonly string[];
}

/** A literal repo-relative path prefix whose changed files may only be removed. */
export interface ReleaseUnitDeletedPath {
  readonly path: string;
  readonly deleteOnly: true;
}

/** A whole-path pattern, a keyed JSON file, a line-bound text file, or a deletion-only prefix. */
export type ReleaseUnitEntry = string | ReleaseUnitKeyedPath | ReleaseUnitLinedPath | ReleaseUnitDeletedPath;

/**
 * `release.unitPaths` -- the repo-relative path set (an `=exact` path, a prefix or a narrow glob,
 * ../report/patterns.ts's own grammar -- the same one `review.scopes` above
 * reads, so a maintainer who writes `hooks/**` in one table is entitled to
 * have it claim the same files in the other) a release unit is bounded to.
 *
 * `null` MEANS UNDECLARED, NOT "EVERYTHING" OR "NOTHING". `nen release
 * unit-check` REFUSES (exit 2) when this is null, naming the key to add: a
 * repository that never declared a unit has stated no boundary at all, and
 * reporting every changed path as "outside the unit" (or the other silent
 * failure, "inside" by default) would be this binary inventing a boundary the
 * repository never drew.
 */
export interface ReleasePolicy {
  readonly unitPaths: readonly ReleaseUnitEntry[] | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * `futon.advanceGo` -- the ONLY repo-kind gate an advance-go skill chain is
 * held to, keyed by skill name.
 *
 * KEYS ARE NORMALIZED WITHOUT A `plugin:` PREFIX, because ../parse/futon.ts's
 * own skill-chain grammar accepts a step's skill both ways (`plugin:mugetsu`
 * and `mugetsu` name the same skill) and a gate keyed on one spelling would
 * silently never match the other. A skill this map does not name is UNGATED --
 * ../grammar/command.ts's futon() annotates a step with a `gate` field only
 * for a skill this record lists, exactly as `review.scopes` raises a scope
 * only for a path a declared pattern claims.
 */
export interface FutonPolicy {
  /** skill name, plugin-prefix stripped, lower-cased -> the repo kinds it may advance-go against. */
  readonly advanceGo: Readonly<Record<string, readonly AdvanceGoKind[]>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * The advance-go gate a repository that DECLARES NO `futon.advanceGo` at all
 * runs under -- the maintainer's ruling (2026-09-28): an absent key must
 * never read as "no gate". `mugetsu`, `kagutsuchi` and `getsuga` are the
 * three publishing/deploying skills a futon chain can name that carry real
 * side effects outside the checkout, and this is the floor every repository
 * gets before it has written a policy of its own -- exactly the same
 * argument this file's header makes for `coverage`'s 80/85/90: a default for
 * the SHAPE (there IS a gate) is not nen inventing a NAME, because these
 * three skill names and the three repo kinds are already this ecosystem's
 * own vocabulary, declared once in ../parse/futon.ts and ADVANCE_GO_KINDS
 * above -- nothing here is invented for the occasion.
 *
 * A REPOSITORY THAT DECLARES `futon.advanceGo` AT ALL, EVEN PARTIALLY,
 * REPLACES THIS ENTIRELY -- ../grammar/command.ts's futon() only reaches for
 * this default when the declared map is empty (the key, or the whole file,
 * is absent). A repository that declares a policy naming only `mugetsu` has
 * made a real decision to leave `kagutsuchi` and `getsuga` ungated, and this
 * default must not silently reinstate a gate that repository chose to drop.
 */
export const DEFAULT_ADVANCE_GO: Readonly<Record<string, readonly AdvanceGoKind[]>> = {
  mugetsu: ["process", "library"],
  kagutsuchi: ["product", "process", "library"],
  getsuga: ["product", "process", "library"],
};

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
  /**
   * The trailer key naming which CI run produced an automated commit, or
   * `null` when this repository states none.
   *
   * ABSENT BY DEFAULT, AND NEVER ITSELF AN ATTRIBUTION TRAILER. A run
   * identifier says WHICH RUN produced a commit, not who or what did --
   * `ATTRIBUTION_TRAILERS` is closed to keys that answer the second question,
   * so this one is never folded into `allowedAttributionTrailers` and is
   * never auto-refused by that enumeration either. When a repository states
   * one, ./scaffold/hook.ts's generated commit-msg hook requires it too,
   * alongside the one attribution trailer `allowedAttributionTrailers`
   * admits, on every automated commit.
   */
  readonly runTrailer: string | null;
  /**
   * The commitlint `subject-case` rule this repository DECLARES for nen, or
   * `null` when it declares none (zheref/nen#263).
   *
   * WHY A REPOSITORY WOULD STATE IT TWICE. `nen commit format` and `commit
   * write` read the rule from the repository's own commitlint config -- but a
   * config that is code (commitlint.config.cjs and kin) can only be read by
   * executing it, which nen never does, so there the verbs could only warn.
   * This key is the rule written where nen CAN read it: `"config-conventional"`
   * (that preset's published default) or an explicit commitlint tuple
   * `[level, "always"|"never", cases]`, validated by ../commit/rule.ts -- the
   * same validator a commitlint data config's own rule goes through.
   *
   * IT DOES NOT OVERRIDE A READABLE COMMITLINT DATA CONFIG. That config is the
   * gate commitlint actually runs, so where nen can read it, it wins and this
   * key is reported as not applied; the key binds only where the commitlint
   * config is code, or nen cannot otherwise read the rule from it, or there is
   * none. ../commit/commitlint.ts states the precedence in full.
   *
   * NO DEFAULT. A default rule would be nen deciding somebody's commit
   * convention, exactly as a default `models` matrix would be.
   */
  readonly subjectCase: DeclaredSubjectCase | null;
  /**
   * The BODY width commitlint's `body-max-line-length` holds a commit to,
   * DECLARED as data (zheref/nen#290; the maintainer's ruling "Refuse at 100,
   * declarable"). Where the commitlint config is code, or nen cannot
   * otherwise read the rule from it, `nen commit format` and `nen commit
   * write` assume config-conventional's 100 and REFUSE a body line over it;
   * this key states the repository's own width instead, and binds the same
   * way -- a line over it is exit 2. A positive whole number, validated by
   * ../commit/rule.ts's parseBodyWidth.
   *
   * THE SAME PRECEDENCE AS `subjectCase`: a commitlint config nen can read as
   * data wins, and this key beside it is reported as not applied (agreeing or
   * differing); it binds where that config is code or unreadable, and where
   * there is none. It names the BODY only: `footer-max-line-length` is not
   * declared here. ../commit/bodywidth.ts states the rules in full.
   *
   * NO DEFAULT: absent is "not declared", and the verbs then say what they
   * assumed.
   */
  readonly bodyMaxLineLength: number | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** `commits.subjectCase`, read: which of the two forms it was stated in, and the rule it means. */
export interface DeclaredSubjectCase extends SubjectCaseSpec {
  /** `config-conventional` for the preset string, `rule` for an explicit tuple. */
  readonly form: "config-conventional" | "rule";
}

/** The one string `commits.subjectCase` accepts; any other preset is a JavaScript package nen cannot read. */
export const SUBJECT_CASE_PRESET = "config-conventional";

/**
 * When a LOCAL concurrency slot frees (`monitor.localSlotFrees`, HR-5). A
 * CLOSED set, read by `nen loop slots`:
 *
 *   - `ready+prompted` (the default, and the rule before the key existed): the
 *     PR is ready AND the human has been prompted.
 *   - `merged`: only when the PR has merged -- the strictest reading.
 *   - `stacked-open`: an effort whose PR is OPEN and STACKED onto another
 *     effort's branch frees (the stack's owner drives it from there); every
 *     other effort keeps the `ready+prompted` rule.
 */
export const LOCAL_SLOT_RULES = ["ready+prompted", "merged", "stacked-open"] as const;
export type LocalSlotRule = (typeof LOCAL_SLOT_RULES)[number];
export const DEFAULT_LOCAL_SLOT_RULE: LocalSlotRule = "ready+prompted";

export interface MonitorPolicy {
  readonly maxCycles: number;
  readonly pollSeconds: number;
  /** `monitor.localSlotFrees`, or the default when the key is absent. */
  readonly localSlotFrees: LocalSlotRule;
  /** Whether `localSlotFrees` was stated, so a reader can say where the rule came from. */
  readonly localSlotFreesDeclared: boolean;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** What an idle batch does with one ask-once row it was not asked about (HR-5). */
export const IDLE_RESOLUTIONS = ["default", "hold", "refuse"] as const;
export type IdleResolution = (typeof IDLE_RESOLUTIONS)[number];

/**
 * The `idle` block (HR-5): a typed idle profile's batch resolution per
 * ask-once row, the terminal state it runs to, and its budget. nen validates
 * and reports it; it never runs a batch and never picks a resolution.
 */
export interface IdlePolicy {
  /** ask-once row id -> resolution. Row ids are `[a-z0-9-]+`, as nen/decisions.json spells them. */
  readonly decisions: Readonly<Record<string, IdleResolution>>;
  /** The terminal state the batch runs to, in the repository's own words. `null` when unstated. */
  readonly terminal: string | null;
  /** The batch's budget; each half `null` when unstated. `minutes` is wall-clock from the run manifest's startedAt. */
  readonly budget: { readonly minutes: number | null; readonly tokens: number | null };
  /**
   * `idle.localSlotFrees`: when a local slot frees under an idle run. Read by
   * `nen loop slots` in preference to `monitor.localSlotFrees` (delivery round
   * on zheref/nen#498, reading 5); null when unstated.
   */
  readonly localSlotFrees: LocalSlotRule | null;
  /** Keys of the block nen does not read (not `$`-prefixed): `nen schema check`'s idle row reports them rather than accepting them silently. */
  readonly unreadKeys: readonly string[];
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

/**
 * `profile` -- which RUN PROFILE a turn runs under, and which it may be asked
 * for (zheref/nen#227).
 *
 * THE NAMES ARE CLOSED HERE AND THEIR MEANING IS NOT. `fast`, `standard` and
 * `thorough` are the three profiles the ecosystem's turn loop knows; what each
 * one skips or adds is the consumer's (Hatsu's `ren`) and nen validates only
 * that a repository names ones that exist and defaults to one it allows. A
 * fourth name would be a profile no loop implements, refused by pointer
 * rather than preserved for a reader that never comes.
 */
export interface ProfilePolicy {
  /** The profile a bare turn runs under. Always one of `allowed`. */
  readonly default: string;
  /** The profiles a caller may ask for, in the file's own order. */
  readonly allowed: readonly string[];
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface SeverityPolicy {
  readonly family: string;
  /** Optional name-to-full-label mapping for taxonomies without slash families. */
  readonly labels: Readonly<Record<string, string>> | null;
  /** Highest priority first; leaves in the declared label family. */
  readonly order: readonly string[];
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface CiPolicy {
  /** Product code resolved through the target registry; provider names are data. */
  readonly provider: string;
  readonly pinned: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface Workflow {
  readonly ci?: CiPolicy | null;
  readonly severity: SeverityPolicy | null;
  readonly schema: string | null;
  readonly branch: BranchPolicy;
  readonly iteration: IterationPolicy;
  readonly tests: TestsPolicy;
  readonly coverage: CoveragePolicy;
  readonly launch: LaunchPolicy;
  /** `deploy` -- see DeployPolicy. `defaultTarget` is null unless declared. */
  readonly deploy: DeployPolicy;
  /** `privateNames` -- see PrivateNamesPolicy. `namedFile` is null unless declared. */
  readonly privateNames: PrivateNamesPolicy;
  readonly reports: ReportsPolicy;
  readonly notifications: NotificationsPolicy;
  readonly commits: CommitsPolicy;
  readonly monitor: MonitorPolicy;
  readonly models: ModelsPolicy;
  readonly review: ReviewPolicy;
  readonly profile: ProfilePolicy;
  readonly release: ReleasePolicy;
  readonly futon: FutonPolicy;
  /** `runners` -- the self-hosted runner policy, or null when none is declared. No default. */
  readonly runners: RunnersPolicy | null;
  /** `idle` -- the typed idle profile (HR-5), or null when none is declared. No default. */
  readonly idle?: IdlePolicy | null;
  /** `spec` -- a spec repository's capture and autonomy keys (zheref/nen#493), defaults filled; `declared` false when the block is absent. */
  readonly spec?: SpecPolicy;
  /**
   * `alwaysOverlaps` -- paths every delivery touches sooner or later (a
   * manifest version, the CHANGELOG, generated mirrors), read by `nen wc
   * overlap` as touched by every effort (NN#488 AC-2). An entry ending in '/'
   * is a directory prefix. Empty when undeclared.
   */
  readonly alwaysOverlaps?: readonly string[];
  /**
   * `canon` -- the canon prose verbs' declared inputs (zheref/nen#481):
   * `canon.lint` names the rules contract and the baseline `nen canon lint`
   * reads when no flag names them, and the paths its marker limit and reading
   * rule apply to when the contract declares none. Null when undeclared.
   */
  readonly canon?: CanonPolicy | null;
  /** The document exactly as the file states it, every key preserved. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** `canon.lint` -- repository-relative paths; `baseline` and `skillPaths` optional. */
export interface CanonLintPolicy {
  readonly rules: string;
  readonly baseline: string | null;
  readonly skillPaths: readonly string[] | null;
}

export interface CanonPolicy {
  readonly lint: CanonLintPolicy | null;
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
/** The three run profiles, in the order a reader ranks them. CLOSED: see ProfilePolicy. */
export const PROFILE_NAMES: readonly string[] = ["fast", "standard", "thorough"];
export const DEFAULT_PROFILE = "standard";

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
    severity: null,
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
    // NO DEFAULT DESTINATION, EVER -- see DeployPolicy.
    deploy: { defaultTarget: null, raw: empty },
    privateNames: { namedFile: null, raw: empty },
    reports: {
      dir: DEFAULT_REPORTS_DIR,
      retain: DEFAULT_RETAIN,
      template: DEFAULT_REPORT_TEMPLATE,
      captures: DEFAULT_CAPTURES,
      // NO DEFAULT VARIANT, EVER -- the same rule `models` and `launch.default`
      // follow. A variant nen invented would name blocks nobody's template has,
      // and `report render --variant` would then refuse a variant this binary
      // made up. An absent block is "none declared", which is a true sentence.
      sections: emptyRecord<ReportSection>(),
      raw: empty,
    },
    notifications: { rungs: DEFAULT_RUNGS, sound: DEFAULT_SOUND, turn: DEFAULT_TURN, raw: empty },
    commits: { allowedAttributionTrailers: [], forbiddenTrailers: [], runTrailer: null, subjectCase: null, bodyMaxLineLength: null, raw: empty },
    monitor: { maxCycles: DEFAULT_MAX_CYCLES, pollSeconds: DEFAULT_POLL_SECONDS, localSlotFrees: DEFAULT_LOCAL_SLOT_RULE, localSlotFreesDeclared: false, raw: empty },
    models: { rule: null, surfaces: emptyRecord(), roles: emptyRecord(), raw: empty },
    review: { scopes: emptyRecord<ReviewScope>(), excludedPersonas: [], raw: empty },
    profile: { default: DEFAULT_PROFILE, allowed: PROFILE_NAMES, raw: empty },
    release: { unitPaths: null, raw: empty },
    futon: { advanceGo: emptyRecord<readonly AdvanceGoKind[]>(), raw: empty },
    // NO DEFAULT POOL, EVER -- see RunnersPolicy.
    runners: null,
    ci: null,
    idle: null,
    spec: defaultSpecPolicy(),
    alwaysOverlaps: [],
    raw: empty,
  };
}

// ── readers ─────────────────────────────────────────────────────────────────

/** The blocks this loader reads. Everything else at the root is preserved. */
const ROOT_KEYS: readonly string[] = [
  "severity",
  "branch",
  "iteration",
  "tests",
  "coverage",
  "launch",
  "deploy",
  "privateNames",
  "reports",
  "notifications",
  "commits",
  "monitor",
  "models",
  "review",
  "profile",
  "release",
  "futon",
  "runners", "ci",
  "idle",
  "spec",
  "alwaysOverlaps",
  "canon",
];

const BRANCH_KEYS: readonly string[] = ["template", "base"];
const ITERATION_KEYS: readonly string[] = ["checks", "lane"];
const TESTS_KEYS: readonly string[] = ["required", "extra"];
const COVERAGE_KEYS: readonly string[] = ["minimum", "recommended", "ideal", "scope"];
const LAUNCH_KEYS: readonly string[] = ["default", "fallback"];
const DEPLOY_KEYS: readonly string[] = ["defaultTarget"];
const PRIVATE_NAMES_KEYS: readonly string[] = ["namedFile"];
const REPORTS_KEYS: readonly string[] = ["dir", "retain", "template", "captures", "sections"];
const REVIEW_KEYS: readonly string[] = ["scopes", "excludedPersonas"];
const RELEASE_KEYS: readonly string[] = ["unitPaths"];
const FUTON_KEYS: readonly string[] = ["advanceGo"];
const NOTIFICATIONS_KEYS: readonly string[] = ["rungs", "sound", "turn"];
const COMMITS_KEYS: readonly string[] = [
  "allowedAttributionTrailers",
  "forbiddenTrailers",
  "runTrailer",
  "subjectCase",
  "bodyMaxLineLength",
];
const MONITOR_KEYS: readonly string[] = ["maxCycles", "pollSeconds", "localSlotFrees"];
const IDLE_KEYS: readonly string[] = ["decisions", "terminal", "budget", "localSlotFrees"];
const IDLE_BUDGET_KEYS: readonly string[] = ["minutes", "tokens"];
/** A decisions.json row id, as ../schema/decisions.ts spells one. */
const DECISION_ROW_ID = /^[a-z0-9][a-z0-9-]*$/;
const PROFILE_KEYS: readonly string[] = ["default", "allowed"];
const SPEC_KEYS: readonly string[] = ["clarify", "capture", "maxBytes", "autonomy"];
const SPEC_CLARIFY_KEYS: readonly string[] = ["maxQuestions", "maxRounds"];
const SPEC_CAPTURE_KEYS: readonly string[] = ["foldersPerPr"];
const SPEC_AUTONOMY_KEYS: readonly string[] = ["platformOrder", "referencePlatform", "maxInFlight", "unmetSc", "convergeFiling", "waveEnds"];
export const SPEC_UNMET_SC = ["refuse"] as const;
export const SPEC_CONVERGE_FILING = ["propose", "file"] as const;
export const SPEC_WAVE_ENDS = ["all-at-prompt"] as const;

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

/**
 * The `branch` block's own parser, exported (zheref/nen#286, Copilot round 1)
 * so `pr merge --delivery` holds a REMOTE copy of `branch` -- read at a pull
 * request's base commit -- to exactly the rules this loader holds the local
 * one to, rather than a second, looser reading.
 */
export function parseBranchPolicy(path: string, value: unknown): BranchPolicy {
  return parseBranch(path, value);
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

/**
 * `deploy` -- its one key, held to its SHAPE here and to its MEANING by
 * `nen schema check`, which is the one reader that holds both files.
 *
 * A near-miss key (`defaultTaget`) is refused by `block`, naming the key it
 * was one edit from, for this file's own reason: preserved, it would be read
 * by nobody and the caller's tooling would keep asking for a target the
 * maintainer believed was declared. An empty string is refused rather than
 * read as "none": `null` is how this file says none, and `""` is a name no
 * `project.targets` key can be.
 */
function parseDeploy(path: string, value: unknown): DeployPolicy {
  const raw = block(path, "deploy", value, DEPLOY_KEYS, "A deploy policy's one key is");
  const stated = raw["defaultTarget"];
  return {
    defaultTarget:
      stated === undefined || stated === null
        ? null
        : requireString(path, "deploy.defaultTarget", stated),
    raw,
  };
}

function parsePrivateNames(path: string, value: unknown): PrivateNamesPolicy {
  const raw = block(path, "privateNames", value, PRIVATE_NAMES_KEYS, "A privateNames policy's one key is");
  const stated = raw["namedFile"];
  if (stated === undefined || stated === null) return { namedFile: null, raw };
  const file = requireString(path, "privateNames.namedFile", stated);
  // The same allowlist `reports.dir` is held to, and for the same reason: this
  // value becomes a path in a `git show <ref>:<path>` argument, so a leading
  // `/`, a `..` segment or a character outside the set is refused where it is
  // read, by pointer, rather than resolved to a file nobody declared.
  if (!REPO_RELATIVE_PATH.test(file) || file.split("/").includes("..") || file.endsWith("/")) {
    throw new SchemaError(
      path,
      "privateNames.namedFile",
      `'${file}' is not a path the private-name guard can read. It names a FILE committed in this repository, read at the base tip as 'refs/remotes/origin/<branch.base>:<namedFile>', so it is repo-relative (no leading '/'), has no '..' segment, does not end in '/', and carries only letters, digits, '.', '_', '-' and '/'`,
    );
  }
  return { namedFile: file, raw };
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
  const raw = block(path, "reports", value, REPORTS_KEYS, "A reports policy's five keys are");
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
    sections: parseSections(path, raw["sections"]),
    raw,
  };
}

/** A name a variant, a template or a scope may take: a slug, and nothing else. */
export const POLICY_SLUG = /^[a-z][a-z0-9-]*$/;

/**
 * The three names that are a slug, and are still not a key (Copilot, #221).
 *
 * A NAME THIS FILE ACCEPTS BECOMES A KEY OF A RECORD, and JavaScript has three
 * of those that are not ordinary keys: assigning `__proto__` on a plain object
 * invokes the prototype SETTER instead of creating an own property, so the
 * variant or scope vanishes from `Object.keys` and from every reader -- a row
 * this schema said was valid, silently absent everywhere downstream.
 * `constructor` and `prototype` are here with it because they are the same
 * class of surprise for a reader of the resulting object, even where they
 * happen to assign.
 *
 * THE ACCUMULATORS ARE NULL-PROTOTYPE TOO, and the belt and the braces are
 * both deliberate: this refusal is what a MAINTAINER sees (a name refused by
 * pointer, at load, with a reason), and `emptyRecord()` is what makes the
 * failure impossible rather than merely reported -- including for any future
 * key space that forgets to ask.
 */
const RESERVED_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/**
 * A record no prototype key can reach into.
 *
 * `Object.create(null)` rather than `{}`: see `RESERVED_KEYS`. Every map this
 * loader builds from names the REPOSITORY chose goes through here.
 */
function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** A name that is a slug AND is a key, or a refusal by pointer naming why. */
function requirePolicyName(path: string, pointer: string, name: string, what: string): void {
  if (RESERVED_KEYS.includes(name)) {
    throw new SchemaError(
      path,
      pointer,
      `'${name}' is not a name this policy can carry. It is a slug, but it is also a JavaScript prototype key: stored as ${what}, '__proto__' invokes the prototype setter instead of creating an entry, so the ${what} would be accepted here and then be missing from every reader of this file. Choose any other name`,
    );
  }
  if (!POLICY_SLUG.test(name)) {
    throw new SchemaError(
      path,
      pointer,
      `'${name}' is not a name this policy can carry. ${what} is named on the command line and is held to a slug: a lowercase letter, then lowercase letters, digits and single hyphens`,
    );
  }
}

/**
 * A BLOCK name, which is deliberately NOT the slug above.
 *
 * A block becomes a `sections.<block>` TOKEN in the template this variant
 * renders, so the shape it is held to is ../report/template.ts's own path
 * grammar and not a stricter one: that language's paths are
 * `[A-Za-z_][A-Za-z0-9_-]*`, which is what lets a repository name a block
 * `lastTurn` or `prBody` -- the spellings a template author naturally writes,
 * and the spellings hatsu's own file already uses. Holding a block to a
 * lowercase slug here would have refused a name the renderer accepts, which is
 * a refusal about nothing.
 */
export const BLOCK_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * `reports.sections` -- the report variants, validated for SHAPE only.
 *
 * THE VARIANT NAMES AND THE BLOCK NAMES ARE THE REPOSITORY'S, NOT NEN'S. A
 * block is a region of somebody's template; nen has never seen the template and
 * would be inventing a vocabulary by enumerating them, which is the same
 * refusal `models` makes one screen down. So this checks that a name is a name
 * (a slug, because it becomes a `sections.<block>` token in a template and
 * ./template.ts's paths are slugs), that a variant states a template and at
 * least one block, and that it does not state the same block twice.
 *
 * A REPEATED BLOCK IS REFUSED RATHER THAN DE-DUPLICATED. `sections.<block>` is
 * a presence flag, so a second mention changes nothing in the render -- which is
 * exactly why it must not be silently accepted: the author who wrote it twice
 * meant something (a second occurrence of the block, an ordering) that this
 * contract does not provide, and quietly collapsing it answers a question
 * nobody asked.
 *
 * AN EMPTY `blocks` IS REFUSED for the same class of reason: a variant that
 * renders no block at all is a report with nothing in it, and `--variant` would
 * then produce a page whose emptiness reads as "this effort did nothing".
 */
function parseSections(path: string, value: unknown): Readonly<Record<string, ReportSection>> {
  if (value === undefined || value === null) return emptyRecord<ReportSection>();
  const raw = requireRecord(path, "reports.sections", value);
  const sections = emptyRecord<ReportSection>();
  for (const [name, entry] of Object.entries(raw)) {
    if (name.startsWith("$")) continue;
    const pointer = `reports.sections.${name}`;
    requirePolicyName(path, pointer, name, "a report variant");
    const variant = requireRecord(path, pointer, entry);
    const blocksRaw = requireArray(path, `${pointer}.blocks`, variant["blocks"]);
    const blocks = blocksRaw.map((block_, index): string => {
      const block = requireString(path, `${pointer}.blocks[${index}]`, block_);
      if (RESERVED_KEYS.includes(block)) {
        throw new SchemaError(
          path,
          `${pointer}.blocks[${index}]`,
          `'${block}' is not a block name. It becomes a key of the 'sections' map '${"nen report render --variant"}' injects, and a JavaScript prototype key assigned there invokes the prototype setter instead of creating a flag -- so the block would be declared here and missing from the template that asked for it. Choose any other name`,
        );
      }
      if (!BLOCK_NAME.test(block)) {
        throw new SchemaError(
          path,
          `${pointer}.blocks[${index}]`,
          `'${block}' is not a block name. A block becomes a 'sections.<block>' token in the template this variant renders, so it is held to exactly the shape that language's paths take ([A-Za-z_][A-Za-z0-9_-]*) -- 'lastTurn' and 'prBody' are names; 'last turn' and 'pr.body' are not`,
        );
      }
      return block;
    });
    if (blocks.length === 0) {
      throw new SchemaError(
        path,
        `${pointer}.blocks`,
        `names no blocks. A variant that switches on nothing renders a page with nothing in it, and an empty report reads as an effort that did nothing`,
      );
    }
    const repeated = blocks.filter((block, index): boolean => blocks.indexOf(block) !== index);
    if (repeated.length > 0) {
      throw new SchemaError(
        path,
        `${pointer}.blocks`,
        `names ${[...new Set(repeated)].map((block): string => `'${block}'`).join(", ")} more than once. 'sections.<block>' is a PRESENCE flag, so a second mention changes nothing in the render -- which is why it is refused rather than collapsed: whatever the second one meant, this contract does not provide it`,
      );
    }
    const template = requireString(path, `${pointer}.template`, variant["template"]);
    if (!POLICY_SLUG.test(template)) {
      throw new SchemaError(
        path,
        `${pointer}.template`,
        `'${template}' is not a template name. It is the same vocabulary 'reports.template' uses -- a slug naming one of this repository's own templates, never a path`,
      );
    }
    sections[name] = { template, blocks };
  }
  return sections;
}

/** A persona name as the exclusion compares it: trimmed, case-folded. */
const personaKey = (name: string): string => name.trim().toLowerCase();

/**
 * `review.excludedPersonas` (zheref/nen#472): the personas this repository
 * declares never to be code reviewers -- Hatsu's intake examiners (HR-23),
 * which challenge a brief at capture intake and nowhere else. THE HOME IS THIS
 * BLOCK, not the consumer's `intake.challenger` options: that key is Hatsu's
 * own vocabulary, which nen does not read (names are data), and a list here is
 * one choke point every writer of `review.scopes` already passes through.
 * Each entry is a non-empty name, unique after trimming and case-folding.
 */
function parseExcludedPersonas(path: string, value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  const list = requireArray(path, "review.excludedPersonas", value);
  const seen = new Map<string, number>();
  return list.map((item, index): string => {
    const pointer = `review.excludedPersonas[${index}]`;
    const name = requireString(path, pointer, item);
    if (name.trim() === "") throw new SchemaError(path, pointer, "is empty. An exclusion that names nobody excludes nobody");
    const previous = seen.get(personaKey(name));
    if (previous !== undefined) throw new SchemaError(path, pointer, `repeats review.excludedPersonas[${previous}] (compared trimmed and case-insensitively)`);
    seen.set(personaKey(name), index);
    return name;
  });
}

/**
 * `review.scopes` -- who reads which paths, validated for SHAPE only.
 *
 * SHAPE ONLY, AND THAT IS THE WHOLE POINT. `nen review scopes` classifies a
 * branch diff by these rows and reports which scopes it raised; it never
 * summons anybody, never decides whether a persona exists, and never reads a
 * budget as permission. Nen holds the row to being a row -- a persona, a tier,
 * a whole-number budget, at least one path -- because those are the fields the
 * verb reads, and everything beyond that is the consuming repository's own
 * business, preserved verbatim by `raw` like every other key in this file.
 *
 * AT LEAST ONE PATH, because a scope that claims nothing is a reviewer who can
 * never be raised: the row would sit in the file looking like policy and have
 * no effect any diff could produce, which is the silent-default failure this
 * module's near-miss rule exists to prevent one level up.
 */
function parseReview(path: string, value: unknown): ReviewPolicy {
  const raw = block(path, "review", value, REVIEW_KEYS, "A review policy's keys are");
  const excludedPersonas = parseExcludedPersonas(path, raw["excludedPersonas"]);
  const excluded = new Set(excludedPersonas.map(personaKey));
  const scopesRaw = raw["scopes"];
  if (scopesRaw === undefined || scopesRaw === null) return { scopes: emptyRecord<ReviewScope>(), excludedPersonas, raw };
  const record = requireRecord(path, "review.scopes", scopesRaw);
  const scopes = emptyRecord<ReviewScope>();
  for (const [name, entry] of Object.entries(record)) {
    if (name.startsWith("$")) continue;
    const pointer = `review.scopes.${name}`;
    requirePolicyName(path, pointer, name, "a review scope");
    const scope = requireRecord(path, pointer, entry);
    const persona = requireString(path, `${pointer}.persona`, scope["persona"]);
    if (persona.trim() === "") {
      throw new SchemaError(path, `${pointer}.persona`, `is empty. A scope with no reviewer is a review nobody owes`);
    }
    if (excluded.has(personaKey(persona))) {
      throw new SchemaError(
        path,
        `${pointer}.persona`,
        `names '${persona.trim()}', which review.excludedPersonas declares is never a code reviewer (zheref/nen#472). Name a reviewer persona, or remove the scope`,
      );
    }
    const tier = requireString(path, `${pointer}.tier`, scope["tier"]);
    if (tier.trim() === "") {
      throw new SchemaError(
        path,
        `${pointer}.tier`,
        `is empty. It names a key of this file's own 'models.<surface>' matrix, which is an open map -- nen checks it is a name, never which name`,
      );
    }
    const budget = numberOr(path, `${pointer}.budget`, scope["budget"], 1, 0, Number.MAX_SAFE_INTEGER);
    const pathsRaw = requireArray(path, `${pointer}.paths`, scope["paths"]);
    const paths = pathsRaw.map((entry_, index): string => {
      const pattern = requireString(path, `${pointer}.paths[${index}]`, entry_);
      if (pattern.trim() === "") {
        throw new SchemaError(
          path,
          `${pointer}.paths[${index}]`,
          `is empty. An empty pattern matches nothing at all, so it is a path list entry that can never raise this scope`,
        );
      }
      const problem = exactPathProblem(pattern);
      if (problem !== null) throw new SchemaError(path, `${pointer}.paths[${index}]`, problem);
      return pattern;
    });
    if (paths.length === 0) {
      throw new SchemaError(
        path,
        `${pointer}.paths`,
        `names no paths. A scope that claims nothing can never be raised by any diff -- it would sit here looking like policy with no effect. Claim everything with '**' if that is what this scope means`,
      );
    }
    scopes[name] = { persona, tier, budget, paths };
  }
  return { scopes, excludedPersonas, raw };
}

/**
 * `release.unitPaths` -- SHAPE ONLY, exactly as `review.scopes` above: a
 * non-empty list of non-empty path patterns, or `null` when the key was never
 * declared. `nen release unit-check` is the one place this is read; this
 * loader states only what a caller may parse, never what the declared paths
 * mean for a repository's own release process.
 */
/**
 * A handful of repo-relative paths, deliberately varied in segment depth and
 * shape, that a pattern must claim EVERY one of to be provably universal.
 * This is not exhaustive proof for every conceivable glob, but it is the same
 * kind of proof ../report/patterns.ts's own grammar admits: a pattern that
 * fails to claim even one of these plainly ordinary paths is not a pattern
 * that claims every path in the checkout, whatever it looks like on the page.
 */
const UNIVERSAL_PROBE_PATHS: readonly string[] = [
  "a",
  "a.ts",
  "a/b",
  "a/b/c",
  ".hidden",
  "very/deeply/nested/path/to/a/file.ts",
];

/**
 * True only when `pattern` claims every one of `UNIVERSAL_PROBE_PATHS` under
 * ../report/patterns.ts's own `matchesPattern` -- the SAME grammar `release.
 * unitPaths` and `review.scopes` are both read by, so a pattern this function
 * calls universal is universal by the one matcher this binary actually runs
 * it through, never by a second, hand-maintained list of "the strings that
 * mean everything" that could drift from what the matcher itself does.
 *
 * `*` (a single path segment) is NOT universal by this proof -- it fails to
 * claim `a/b`, exactly as a real diff's multi-segment paths would not be
 * claimed by it either.
 */
function isUniversalPattern(pattern: string): boolean {
  return UNIVERSAL_PROBE_PATHS.every((probe): boolean => matchesPattern(probe, pattern));
}

/** An object chooses one content or deletion bound. */
const UNIT_PATH_ENTRY_KEYS: readonly string[] = ["path", "keys", "lines", "deleteOnly"];

/**
 * One `release.unitPaths[i]` that arrived as an OBJECT rather than a string
 * -- a content or deletion bound, validated for SHAPE only (the same discipline
 * `review.scopes` and the plain-string branch below both already hold to):
 * `path` is a repo-relative path to the ONE exact file this entry bounds
 * (never a pattern -- see `ReleaseUnitKeyedPath`'s own doc comment), `keys`
 * is a non-empty list of leaf-key strings, or `lines` a non-empty list of
 * safe full-line regexes. `deleteOnly: true` instead bounds a literal path
 * prefix to removals. Whether the file is readable as JSON/text and its
 * changes stayed inside these bounds,
 * is ../release/unitcheck.ts's own question, asked against real base/head
 * content this loader has never seen.
 */
function parseUnitPathEntry(path: string, pointer: string, value: Readonly<Record<string, unknown>>): ReleaseUnitKeyedPath | ReleaseUnitLinedPath | ReleaseUnitDeletedPath {
  for (const key of Object.keys(value)) {
    if (key.startsWith("$") || UNIT_PATH_ENTRY_KEYS.includes(key)) continue;
    throw new SchemaError(
      path,
      `${pointer}.${key}`,
      `is not a key a ${Object.hasOwn(value, "deleteOnly") ? "deletion-only" : "content-scoped"} release-unit entry can carry. Use 'path' and exactly one of 'keys', 'lines' or 'deleteOnly'`,
    );
  }
  const filePath = requireString(path, `${pointer}.path`, value["path"]);
  if (Object.hasOwn(value, "deleteOnly")) {
    if (value["deleteOnly"] !== true) throw new SchemaError(path, `${pointer}.deleteOnly`, "must be true; omit the entry to leave deletions unclaimed");
    if (Object.hasOwn(value, "keys") || Object.hasOwn(value, "lines")) throw new SchemaError(path, pointer, "must carry exactly one of 'keys', 'lines' or 'deleteOnly', never a mixed bound");
    // One optional trailing slash spells a directory prefix. Keep the shared
    // segment-boundary matcher, with no glob or '=path' interpretation here.
    const prefix = filePath.endsWith("/") ? filePath.slice(0, -1) : filePath;
    if (filePath.startsWith("=") || /[#?%]/.test(prefix) || exactPathProblem(`=${prefix}`) !== null) {
      throw new SchemaError(path, `${pointer}.path`, "must name a literal repo-relative path prefix, with no glob, URL metacharacter, backslash, control character, empty, '.' or '..' segment; one trailing '/' is allowed");
    }
    return { path: filePath, deleteOnly: true };
  }
  if (filePath.trim() === "" || filePath.startsWith("/") || filePath.split("/").some((segment): boolean => segment === "" || segment === "." || segment === "..") || /[\\*\u0000-\u001f\u007f]/.test(filePath)) {
    throw new SchemaError(
      path,
      `${pointer}.path`,
      `'${filePath}' is not a path this policy can act on. A content-scoped entry names the EXACT repo-relative file it bounds -- compared by equality against a changed file's own path, never as a pattern -- so it is repo-relative, has no leading '/' and no '..' segment`,
    );
  }
  // N2: '#', '?' and '%' are refused too -- this path is interpolated
  // segment-by-segment into 'repos/{slug}/contents/<path>?ref=<sha>'
  // (../release/unitcheck.ts's `fetchJsonAtRef`). '#' truncates the request
  // path at the URL fragment, '?' opens a second query string ahead of
  // '?ref=', and '%' either starts a percent-escape this reader never
  // intended or, doubly so once ../release/unitcheck.ts itself
  // percent-encodes each segment, reads back as something other than the
  // literal byte this file named -- refused at load, where the fix is a
  // one-line rename, rather than as a misrouted GitHub API call.
  if (/[#?%]/.test(filePath)) {
    throw new SchemaError(
      path,
      `${pointer}.path`,
      `'${filePath}' carries a '#', '?' or '%' -- refused. This path is interpolated into a GitHub contents API URL (repos/{slug}/contents/<path>?ref=<sha>), and any of the three would change what that URL means (a fragment, a second query string, or a percent-escape) rather than naming the file verbatim. Rename the file, or point this entry at a path that does not need one`,
    );
  }
  const hasKeys = Object.hasOwn(value, "keys");
  const hasLines = Object.hasOwn(value, "lines");
  if (hasKeys === hasLines) {
    throw new SchemaError(path, pointer, "must carry exactly one of 'keys' (a JSON bound) or 'lines' (a text bound), never both or neither");
  }
  if (hasLines) {
    const linesRaw = requireArray(path, `${pointer}.lines`, value["lines"]);
    if (linesRaw.length === 0) throw new SchemaError(path, `${pointer}.lines`, "names no line patterns; name at least one whole-line regular expression");
    if (linesRaw.length > RELEASE_PATTERN_LIMITS.patterns) throw new SchemaError(path, `${pointer}.lines[${RELEASE_PATTERN_LIMITS.patterns}]`, `pattern count limit (${RELEASE_PATTERN_LIMITS.patterns}) exceeded`);
    const lines = linesRaw.map((item, index): string => {
      const at = `${pointer}.lines[${index}]`;
      const source = requireString(path, at, item);
      if (source === "") throw new SchemaError(path, at, "is empty; write '^$' to allow an empty line");
      return source;
    });
    try {
      releaseLinePatterns(lines);
    } catch (error) {
      const at = error instanceof ReleaseLinePatternsError ? `${pointer}.lines[${error.index}]` : `${pointer}.lines`;
      throw new SchemaError(path, at, `is not a safe line regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { path: filePath, lines };
  }
  const keysRaw = requireArray(path, `${pointer}.keys`, value["keys"]);
  if (keysRaw.length === 0) {
    throw new SchemaError(
      path,
      `${pointer}.keys`,
      `names no keys. A content-scoped entry with no allowed key would let '${filePath}' change at NOTHING, which is never what declaring the object form is meant to say -- name at least one JSON-pointer or dotted leaf key, or drop the object form and bound the whole file by its path string instead`,
    );
  }
  const keys = keysRaw.map((item, index): string => {
    const key = requireString(path, `${pointer}.keys[${index}]`, item);
    if (key.trim() === "") {
      throw new SchemaError(path, `${pointer}.keys[${index}]`, "is empty. An empty key names no leaf this file may change at");
    }
    return key;
  });
  return { path: filePath, keys };
}

function parseReleasePolicy(path: string, value: unknown): ReleasePolicy {
  const raw = block(path, "release", value, RELEASE_KEYS, "A release policy's one key is");
  const unitPathsRaw = raw["unitPaths"];
  if (unitPathsRaw === undefined || unitPathsRaw === null) return { unitPaths: null, raw };
  const list = requireArray(path, "release.unitPaths", unitPathsRaw).map((entry, index): ReleaseUnitEntry => {
    const pointer = `release.unitPaths[${index}]`;
    // AN OBJECT ENTRY IS THE CONTENT-SCOPED FORM -- routed to its own parser
    // before the plain-string checks below, which is why this branch tests
    // for "object, not array, not null" rather than falling through to
    // `requireString`'s own type refusal (that refusal's wording is about a
    // STRING, and would be the wrong sentence for an object that is simply
    // missing its 'path'/'keys' keys).
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      return parseUnitPathEntry(path, pointer, entry as Readonly<Record<string, unknown>>);
    }
    const pattern = requireString(path, `release.unitPaths[${index}]`, entry);
    if (pattern.startsWith("=")) {
      const problem = exactPathProblem(pattern);
      if (problem !== null) throw new SchemaError(path, pointer, problem);
      return pattern;
    }
    if (pattern.trim() === "") {
      throw new SchemaError(
        path,
        `release.unitPaths[${index}]`,
        "is empty. An empty pattern matches nothing, so it is a path list entry that can never bound the release unit",
      );
    }
    // A LEADING '/' IS AN INVALID ABSOLUTE PATTERN, refused with its own
    // message rather than folded into the catch-all check below: every path
    // this policy is ever compared against (../release/unitcheck.ts's
    // changed-file paths) is already repository-relative, so '/**' does not
    // claim every path -- under ../report/patterns.ts's own grammar it claims
    // none, since no repo-relative path begins with '/'. That is not "bounds
    // nothing" in the same useful sense a real catch-all is; it is a typo for
    // '**' that would otherwise be preserved silently.
    if (pattern.startsWith("/")) {
      throw new SchemaError(
        path,
        `release.unitPaths[${index}]`,
        `is '${pattern}', which begins with a leading '/'. Every path this policy is compared against is already repository-relative, so a pattern starting with '/' can never match anything -- drop the leading slash (write '**' for every path, or a bare prefix/glob for one directory).`,
      );
    }
    // FEI-3: a pattern that claims EVERY path is not a bounded release unit --
    // it is the same silent "everything passes" a null 'unitPaths' already
    // refuses (this function's own header), just spelled as a glob instead of
    // an absent key. Proven universal by actually running ../report/
    // patterns.ts's own `matchesPattern` over a handful of representative
    // paths (`isUniversalPattern` above), not by a fixed list of literal
    // spellings -- '*' (one path segment) is deliberately NOT refused here:
    // it claims a single top-level entry, never a multi-segment path, so it
    // is a normal, bounded pattern under this same grammar.
    if (isUniversalPattern(pattern)) {
      throw new SchemaError(
        path,
        `release.unitPaths[${index}]`,
        `is '${pattern}', which claims every path in the checkout. A release unit that bounds nothing is never what declaring this key is meant to say -- name the actual prefix or glob this release owns, or drop the key entirely to leave the unit undeclared`,
      );
    }
    return pattern;
  });
  if (list.length === 0) {
    throw new SchemaError(
      path,
      "release.unitPaths",
      "names no paths. A release unit that bounds nothing would make every changed path read as outside it, which is never what declaring the key empty is meant to say -- drop the key entirely to leave the unit undeclared, or list at least one prefix or glob",
    );
  }
  return { unitPaths: list, raw };
}

/**
 * `futon.advanceGo` -- SHAPE ONLY, mirroring `review.scopes`'s discipline: a
 * skill name mapped to a non-empty list of repo kinds drawn from the CLOSED
 * three ../repo/classify.ts already reports (`product` | `process` |
 * `library`) -- a fourth name would be a kind that verb can never classify a
 * repository as, so it is refused by pointer rather than preserved for a
 * reader that never comes.
 */
function parseFutonPolicy(path: string, value: unknown): FutonPolicy {
  const raw = block(path, "futon", value, FUTON_KEYS, "A futon policy's one key is");
  const advanceGoRaw = raw["advanceGo"];
  if (advanceGoRaw === undefined || advanceGoRaw === null) {
    return { advanceGo: emptyRecord<readonly AdvanceGoKind[]>(), raw };
  }
  const record = requireRecord(path, "futon.advanceGo", advanceGoRaw);
  const advanceGo = emptyRecord<readonly AdvanceGoKind[]>();
  // Tracks each NORMALIZED name back to the first raw key that produced it,
  // so a second key that normalizes to the same name is refused by pointer,
  // naming both the key being read and the one it collides with -- 'mugetsu'
  // and 'plugin:mugetsu' are the same gate under two spellings, and a second
  // entry would otherwise silently overwrite the first with no signal that
  // anything was lost.
  const seenBy = new Map<string, string>();
  for (const [name, entry] of Object.entries(record)) {
    if (name.startsWith("$")) continue;
    const pointer = `futon.advanceGo.${name}`;
    // NORMALIZED WITHOUT ANY NAMESPACE PREFIX before the name check, so a
    // maintainer who writes 'plugin:mugetsu' or 'hatsu:mugetsu' is held to the
    // same slug rule as 'mugetsu' -- the prefix is a namespace marker, never
    // part of the name, and 'plugin:' is not the only namespace a skill chain
    // step can carry (../parse/futon.ts's SKILL_STEP grammar).
    const normalized = name.replace(/^[a-z0-9][a-z0-9-]*:/i, "").toLowerCase();
    requirePolicyName(path, pointer, normalized, "a skill name");
    const firstKey = seenBy.get(normalized);
    if (firstKey !== undefined) {
      throw new SchemaError(
        path,
        pointer,
        `normalizes to '${normalized}', the same as 'futon.advanceGo.${firstKey}' -- a namespace prefix is not a different gate, so these two keys collide on the one skill they both name. Keep exactly one.`,
      );
    }
    seenBy.set(normalized, name);
    const kindsRaw = requireArray(path, pointer, entry);
    if (kindsRaw.length === 0) {
      throw new SchemaError(
        path,
        pointer,
        `names no repo kind. A skill listed here with nothing allowed is a gate that always refuses every target -- drop the '${normalized}' entry to leave it ungated under THIS declared policy. Note that dropping every entry (leaving 'futon.advanceGo' empty, or the key absent entirely) does not mean "ungated": an empty declared map is read as UNDECLARED, and DEFAULT_ADVANCE_GO (../grammar/command.ts) applies instead -- to truly leave '${normalized}' ungated while keeping other skills declared, omit only its own entry, not the whole map`,
      );
    }
    const kinds = kindsRaw.map((item, index): AdvanceGoKind => {
      const kind = requireString(path, `${pointer}[${index}]`, item);
      if (!ADVANCE_GO_KINDS.includes(kind as AdvanceGoKind)) {
        throw new SchemaError(
          path,
          `${pointer}[${index}]`,
          `'${kind}' is not a repo kind this policy knows. The three are ${ADVANCE_GO_KINDS.join(", ")} -- ../repo/classify.ts's own vocabulary, not this file's to invent a fourth of`,
        );
      }
      return kind as AdvanceGoKind;
    });
    advanceGo[normalized] = kinds;
  }
  return { advanceGo, raw };
}

// ── runners (hatsu:jusshin) ─────────────────────────────────────────────────

/** The three operating systems a self-hosted pool may run, in GitHub's own label case. */
export const RUNNER_OSES = ["Linux", "macOS", "Windows"] as const;
export type RunnerOs = (typeof RUNNER_OSES)[number];
/** The two architectures a pool may declare, in GitHub's own label case. */
export const RUNNER_ARCHES = ["X64", "ARM64"] as const;
export type RunnerArch = (typeof RUNNER_ARCHES)[number];
/**
 * How a pool's runners run on their host (#333). `service` is a boot-persistent
 * service with no desktop -- on Windows, session 0, where a job that drives a
 * real UI cannot. `interactive` runs inside a signed-in desktop session: on
 * Windows a Scheduled Task at the identity's logon, and on macOS the launchd
 * LaunchAgent a macOS runner always is.
 */
export const RUNNER_MODES = ["service", "interactive"] as const;
export type RunnerMode = (typeof RUNNER_MODES)[number];
/** The mode of a pool that declares none: a macOS runner is a LaunchAgent, so it is already interactive. */
export const DEFAULT_RUNNER_MODE: Readonly<Record<RunnerOs, RunnerMode>> = {
  Windows: "service",
  Linux: "service",
  macOS: "interactive",
};
/**
 * The fourth label an interactive Windows pool carries, and only that pool. A
 * job that needs a desktop asks for it, so only this pool's runners take that
 * job. It no longer decides which pool a runner is in: the pool's own label
 * (POOL_LABEL_PREFIX, below) does that, so a desktop runner -- which carries
 * `pool-<its pool>` and not the plain pool's -- takes none of the plain pool's
 * jobs once every runner carries its pool label (#340).
 */
export const DESKTOP_LABEL = "desktop";

/**
 * The label a pool carries of its OWN (#340): `pool-<id>`, appended LAST.
 *
 * DERIVED, NEVER DECLARED. GitHub gives `self-hosted`, the OS and the arch to
 * every runner of that OS and arch at registration, so with the defaults alone
 * any later registration on the repository silently joins the pool -- and
 * takes its preflight and its gated jobs -- without having been proven. A
 * label only runners registered or relabelled into this pool carry closes that
 * ACCIDENTAL join. It is not an authorization boundary: anyone who can
 * register a runner on the repository can register it with this label too.
 * Deriving it from the
 * pool's id means a declaration written before it still parses unchanged, and
 * Hatsu's guard and tenkai compute the same string from the same id.
 *
 * NO DUPLICATE-LABEL REFUSAL EXISTS, because none is needed: pool ids are
 * unique (parseRunners refuses a repeated one), so two pools can never derive
 * one pool label, and a pool's full label set can never equal another's.
 */
export const POOL_LABEL_PREFIX = "pool-";

/** The one label a pool carries of its own: `pool-<id>`. */
export function poolOwnLabel(id: string): string {
  return `${POOL_LABEL_PREFIX}${id}`;
}

/**
 * The labels a pool may DECLARE: self-hosted, its os, its arch -- then
 * `desktop` for an interactive Windows pool. GitHub's defaults plus the one
 * mode label; the pool's own label is appended by `poolLabels`.
 */
export function declaredPoolLabels(os: RunnerOs, arch: RunnerArch, mode: RunnerMode): string[] {
  return os === "Windows" && mode === "interactive" ? ["self-hosted", os, arch, DESKTOP_LABEL] : ["self-hosted", os, arch];
}

/**
 * A pool's exact, full label set: `declaredPoolLabels`, then `pool-<id>`
 * last. It is what a runner registers with, what a generated workflow's
 * `runs-on` targets, what `runner verify` and `runner enable` require, and
 * what `runner relabel` completes on a runner registered before #340.
 */
export function poolLabels(os: RunnerOs, arch: RunnerArch, mode: RunnerMode, id: string): string[] {
  return [...declaredPoolLabels(os, arch, mode), poolOwnLabel(id)];
}

/**
 * The one runner-name template this release accepts.
 *
 * A TEMPLATE WITH ONE ACCEPTED VALUE IS STILL A KEY, because the declaration
 * is where a repository says which convention its runner list is read by --
 * and `nen runner inventory` parses every registered name against it. A
 * second template would need a second parser, and a parser nen does not have
 * for a template a repository wrote is a runner list read wrong without a
 * word said, so every other string is refused naming this one.
 */
export const RUNNER_NAMING = "{machine}-{consumer}R{slot}";

/**
 * A tool name a pool declares. It is interpolated, space-separated, into a
 * `run:` step of the rendered preflight workflow (`nen runner workflow`'s
 * `@@TOOLS@@`), so it is held to a word no shell reads twice: letters, digits,
 * `.`, `_`, `+` and `-`, starting with a letter or digit.
 */
export const RUNNER_TOOL = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** A repository variable name, as GitHub accepts one and a workflow's `vars.<X>` reads it. */
export const RUNNER_VARIABLE = /^[A-Z][A-Z0-9_]*$/;

/** A workflow file's own basename: the push path filter and `gh workflow run` both name it. */
export const RUNNER_WORKFLOW_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.yml$/;

/**
 * A runner root. It leaves this file TWICE -- into the PowerShell and bash host
 * scripts `nen runner script` renders, inside single quotes -- so it is held
 * to characters no quoting in either language can be broken out of: no quote,
 * no `$`, no backtick, no `;`/`&`/`|`, no `%`, no newline. `~` is allowed
 * (`nen runner plan` expands it at run time; it is never stored expanded) and
 * so are spaces and parentheses (`C:\Program Files (x86)` is a real root).
 */
export const RUNNER_ROOT = /^[A-Za-z0-9 _.:\\/~()-]+$/;

/** The per-host-OS root keys a pool may default, as `process.platform` spells them. */
const RUNNER_ROOT_KEYS: readonly string[] = ["windows", "linux", "darwin"];
const RUNNERS_KEYS: readonly string[] = ["naming", "pools"];
const RUNNER_POOL_KEYS: readonly string[] = [
  "id",
  "os",
  "arch",
  "mode",
  "labels",
  "enableVariable",
  "tools",
  "preflightWorkflow",
  "root",
];

export interface RunnerPoolRoot {
  readonly windows: string | null;
  readonly linux: string | null;
  readonly darwin: string | null;
}

/**
 * One pool: the label set a workflow of this repository targets, the variable
 * that switches its jobs on, the tools a job there invokes, and the preflight
 * workflow that proves it. See `parseRunners`.
 */
export interface RunnerPool {
  readonly id: string;
  readonly os: RunnerOs;
  readonly arch: RunnerArch;
  /** `service` or `interactive`; a pool that declares none takes its OS's DEFAULT_RUNNER_MODE. */
  readonly mode: RunnerMode;
  /**
   * Always exactly `poolLabels(os, arch, mode, id)` -- the declared defaults
   * (plus `desktop`), then the derived `pool-<id>` LAST (#340). The policy
   * refuses any other declaration.
   */
  readonly labels: readonly string[];
  /** Absent when this pool's jobs are not variable-gated; `runner enable` then has nothing to set. */
  readonly enableVariable: string | null;
  readonly tools: readonly string[];
  readonly preflightWorkflow: string;
  readonly root: RunnerPoolRoot;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * `runners` -- the self-hosted runner policy `hatsu:jusshin` executes.
 *
 * NO DEFAULT, EVER, the way `models` and `review.scopes` have none: a default
 * pool would be nen inventing a label set, a variable name and a toolchain for
 * somebody else's CI. An absent block is `null`, and every `nen runner` verb
 * that needs one refuses at exit 2 naming the key.
 */
export interface RunnersPolicy {
  readonly naming: string;
  readonly pools: readonly RunnerPool[];
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * A closed, case-sensitive vocabulary whose near-spellings are refused naming
 * the canonical one. GitHub matches labels case-insensitively, but a workflow's
 * `runs-on` and this repository's own runner-policy guard compare them as
 * strings -- so `windows` is refused as "write 'Windows'" rather than accepted
 * and then failing a string comparison three files away.
 */
function requireCanonical<T extends string>(
  path: string,
  pointer: string,
  value: unknown,
  allowed: readonly T[],
  aliases: Readonly<Record<string, T>>,
  what: string,
): T {
  const text = requireString(path, pointer, value);
  if ((allowed as readonly string[]).includes(text)) return text as T;
  const meant =
    allowed.find((candidate): boolean => candidate.toLowerCase() === text.toLowerCase()) ??
    aliases[text.toLowerCase()];
  throw new SchemaError(
    path,
    pointer,
    meant === undefined
      ? `'${text}' is not ${what} a self-hosted pool can declare. The ${allowed.length} are ${allowed.join(", ")}, in GitHub's own label case`
      : `'${text}' is spelled '${meant}' here -- GitHub's own label case, which a workflow's runs-on and the runner-policy guard compare as a string. Write '${meant}'`,
  );
}

const OS_ALIASES: Readonly<Record<string, RunnerOs>> = {
  ubuntu: "Linux",
  darwin: "macOS",
  osx: "macOS",
  mac: "macOS",
  win: "Windows",
  win32: "Windows",
};
const ARCH_ALIASES: Readonly<Record<string, RunnerArch>> = {
  amd64: "X64",
  x86_64: "X64",
  aarch64: "ARM64",
};

function parseRunnerRoot(path: string, pointer: string, value: unknown): RunnerPoolRoot {
  const raw = block(path, pointer, value, RUNNER_ROOT_KEYS, "A pool's root defaults are keyed by host OS:");
  const one = (key: string): string | null => {
    const entry = raw[key];
    if (entry === undefined || entry === null) return null;
    const text = requireString(path, `${pointer}.${key}`, entry);
    if (!RUNNER_ROOT.test(text)) {
      throw new SchemaError(
        path,
        `${pointer}.${key}`,
        `'${text}' is not a root nen can render into a host script. It is written into PowerShell and bash inside single quotes, so it may carry letters, digits, spaces, and . _ : \\ / ~ ( ) - only -- never a quote, '$', a backtick, ';', '&', '|', '%' or a newline`,
      );
    }
    return text;
  };
  return { windows: one("windows"), linux: one("linux"), darwin: one("darwin") };
}

/** `mode`: absent is the OS's default; a macOS pool is only interactive, a Linux pool only a service. */
function parseRunnerMode(path: string, pointer: string, value: unknown, os: RunnerOs): RunnerMode {
  if (value === undefined || value === null) return DEFAULT_RUNNER_MODE[os];
  const text = requireString(path, pointer, value);
  if (!(RUNNER_MODES as readonly string[]).includes(text)) {
    throw new SchemaError(
      path,
      pointer,
      `'${text}' is not a runner mode. The two are ${RUNNER_MODES.join(" and ")}; absent means ${DEFAULT_RUNNER_MODE[os]} for a ${os} pool`,
    );
  }
  if (os === "macOS" && text === "service") {
    throw new SchemaError(
      path,
      pointer,
      "is 'service', and a macOS runner is only ever a launchd LaunchAgent of the user who installs it -- interactive, in that user's session; nen renders no LaunchDaemon. Drop the key, or write 'interactive'",
    );
  }
  if (os === "Linux" && text === "interactive") {
    throw new SchemaError(
      path,
      pointer,
      "is 'interactive', and nen provisions a Linux runner only as a systemd service: there is no desktop session it knows how to start one in. Drop the key, or write 'service'",
    );
  }
  return text as RunnerMode;
}

/**
 * Why a pool's declared `labels` are refused, naming each way they are wrong
 * (#340): a bare `self-hosted`, a missing os or arch, a label foreign to the
 * pool's set, another pool's own label, or more than one label of its own.
 * Every reason found is named, then the two spellings the pool admits.
 */
function poolLabelsRefusal(
  labels: readonly string[],
  declared: readonly string[],
  own: string,
  os: RunnerOs,
  arch: RunnerArch,
): string {
  const reasons: string[] = [];
  if (labels.length === 1 && labels[0] === "self-hosted") {
    reasons.push("a bare 'self-hosted' would match every runner the repository has");
  } else {
    if (!labels.includes("self-hosted")) reasons.push("'self-hosted' is missing");
    if (!labels.includes(os)) reasons.push(`its os '${os}' is missing`);
    if (!labels.includes(arch)) reasons.push(`its arch '${arch}' is missing`);
    if (declared.includes(DESKTOP_LABEL) && !labels.includes(DESKTOP_LABEL)) reasons.push(`'${DESKTOP_LABEL}' is missing`);
  }
  const extras = labels.filter((label): boolean => !declared.includes(label));
  // CASE-INSENSITIVE, as GitHub matches labels: `Pool-windows-x64` is this
  // pool's own label in the wrong case, not another pool's.
  const isPoolLabel = (label: string): boolean => label.toLowerCase().startsWith(POOL_LABEL_PREFIX);
  const wrongCase = extras.filter((label): boolean => label !== own && label.toLowerCase() === own.toLowerCase());
  for (const label of wrongCase) reasons.push(`'${label}' is the pool label, in the wrong case: write '${own}'`);
  const foreignPool = extras.filter((label): boolean => isPoolLabel(label) && label.toLowerCase() !== own.toLowerCase());
  if (foreignPool.length > 0) {
    reasons.push(
      `${foreignPool.map((label): string => `'${label}'`).join(", ")} is not this pool's own label: a pool's own label is derived from its id, '${own}', so it is never another pool's -- and since ids are unique, no two pools can carry one`,
    );
  }
  const others = extras.filter((label): boolean => !isPoolLabel(label));
  if (extras.length > 1) {
    reasons.push(`it carries ${extras.length} labels beyond the defaults, and a pool carries exactly one of its own, '${own}'`);
  }
  if (others.length > 0) {
    reasons.push(
      `${others.map((label): string => `'${label}'`).join(", ")} is an extra label: nen's own runner-policy guard (src/ci/runner-policy.test.ts), and a consumer's guard of the same shape, admits a job only on a canonical label set plus its pool's own label, so a pool carrying another is a pool no guarded workflow can target`,
    );
  }
  if (labels.join(",") !== declared.join(",") && reasons.length === 0) reasons.push("its labels are out of order");
  const desktopHint =
    os === "Windows" && !declared.includes(DESKTOP_LABEL) && labels.includes(DESKTOP_LABEL)
      ? `. '${DESKTOP_LABEL}' is an interactive pool's fourth label: declare "mode": "interactive"`
      : "";
  const shape =
    declared.length === 4
      ? `an interactive Windows pool's labels are exactly ${JSON.stringify(declared)} -- 'self-hosted', its os, its arch, then '${DESKTOP_LABEL}', in GitHub's case ('${DESKTOP_LABEL}' is what a job that needs a signed-in desktop asks for)`
      : `a pool's labels are exactly ${JSON.stringify(declared)} -- 'self-hosted', then its os, then its arch, in GitHub's case`;
  return `is ${JSON.stringify(labels)}: ${reasons.join("; ")}. ${shape[0]?.toUpperCase()}${shape.slice(1)}, and nen appends the pool's own label '${own}' last -- declare them without it, or with it written last (${JSON.stringify([...declared, own])})${desktopHint}`;
}

function parseRunnerPool(path: string, pointer: string, value: unknown): RunnerPool {
  const raw = block(path, pointer, value, RUNNER_POOL_KEYS, "A runner pool's keys are");
  if (raw["id"] === undefined) {
    throw new SchemaError(path, `${pointer}.id`, "is required: a pool is named on the command line by its id (--pool <id>)");
  }
  const id = requireString(path, `${pointer}.id`, raw["id"]);
  requirePolicyName(path, `${pointer}.id`, id, "a pool id");
  const os = requireCanonical(path, `${pointer}.os`, raw["os"], RUNNER_OSES, OS_ALIASES, "an operating system");
  const arch = requireCanonical(path, `${pointer}.arch`, raw["arch"], RUNNER_ARCHES, ARCH_ALIASES, "an architecture");
  const mode = parseRunnerMode(path, `${pointer}.mode`, raw["mode"], os);
  const declared = declaredPoolLabels(os, arch, mode);
  const own = poolOwnLabel(id);
  const labels = requireArray(path, `${pointer}.labels`, raw["labels"]).map((item, index): string =>
    requireString(path, `${pointer}.labels[${index}]`, item),
  );
  // TWO SPELLINGS, ONE SET (#340): the declared defaults alone -- every
  // declaration written before the pool label existed -- or those with this
  // pool's own label written out last. Either way the parsed set is the full
  // one, `pool-<id>` appended from the id.
  const same = (expected: readonly string[]): boolean =>
    labels.length === expected.length && labels.every((label, index): boolean => label === expected[index]);
  if (!same(declared) && !same([...declared, own])) {
    throw new SchemaError(path, `${pointer}.labels`, poolLabelsRefusal(labels, declared, own, os, arch));
  }
  const variableRaw = raw["enableVariable"];
  let enableVariable: string | null = null;
  if (variableRaw !== undefined && variableRaw !== null) {
    enableVariable = requireString(path, `${pointer}.enableVariable`, variableRaw);
    if (!RUNNER_VARIABLE.test(enableVariable)) {
      throw new SchemaError(
        path,
        `${pointer}.enableVariable`,
        `'${enableVariable}' is not a repository variable name a workflow's 'vars.<NAME>' can read under this policy: an upper-case letter, then upper-case letters, digits and underscores`,
      );
    }
  }
  const tools = requireArray(path, `${pointer}.tools`, raw["tools"]).map((item, index): string => {
    const tool = requireString(path, `${pointer}.tools[${index}]`, item);
    if (!RUNNER_TOOL.test(tool)) {
      throw new SchemaError(
        path,
        `${pointer}.tools[${index}]`,
        `'${tool}' is not a tool name the preflight workflow can check. It is written into a bash step as one word, so it may carry letters, digits, '.', '_', '+' and '-' only, starting with a letter or digit`,
      );
    }
    return tool;
  });
  if (tools.length === 0) {
    throw new SchemaError(
      path,
      `${pointer}.tools`,
      "is empty. The preflight proves a pool by running every tool a job on it invokes; a pool that declares none is proved by nothing but the runner answering, which is registration, not capability",
    );
  }
  const seenTools = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    if (seenTools.has(tool)) throw new SchemaError(path, `${pointer}.tools[${index}]`, `repeats '${tool}'. Each tool is checked once`);
    seenTools.add(tool);
  }
  if (raw["preflightWorkflow"] === undefined) {
    throw new SchemaError(
      path,
      `${pointer}.preflightWorkflow`,
      "is required: 'nen runner enable' switches a pool on only after a green run of this workflow, so a pool without one could never be enabled",
    );
  }
  const preflightWorkflow = requireString(path, `${pointer}.preflightWorkflow`, raw["preflightWorkflow"]);
  if (!RUNNER_WORKFLOW_FILE.test(preflightWorkflow)) {
    throw new SchemaError(
      path,
      `${pointer}.preflightWorkflow`,
      `'${preflightWorkflow}' is not a workflow basename. It names a file under .github/workflows/ -- no directory, ending '.yml' -- because 'gh workflow run' and the rendered workflow's own push path filter both name it by that basename`,
    );
  }
  return {
    id,
    os,
    arch,
    mode,
    labels: poolLabels(os, arch, mode, id),
    enableVariable,
    tools,
    preflightWorkflow,
    root: parseRunnerRoot(path, `${pointer}.root`, raw["root"]),
    raw,
  };
}

/**
 * `runners` -- the naming template and the pools. SHAPE AND VOCABULARY ONLY:
 * whether a pool's runners exist, and whether its preflight is green, are the
 * `nen runner` verbs' questions, asked against GitHub, never this loader's.
 */
export function parseRunners(path: string, value: unknown): RunnersPolicy | null {
  if (value === undefined || value === null) return null;
  const raw = block(path, "runners", value, RUNNERS_KEYS, "A runners policy's two keys are");
  const namingRaw = raw["naming"];
  const naming =
    namingRaw === undefined || namingRaw === null ? RUNNER_NAMING : requireString(path, "runners.naming", namingRaw);
  if (naming !== RUNNER_NAMING) {
    throw new SchemaError(
      path,
      "runners.naming",
      `'${naming}' is not a naming template this release accepts. The one template is '${RUNNER_NAMING}' -- <MachineCode>-<ConsumerCode>R<N>, the three placeholders all required -- and 'nen runner inventory' parses every registered runner name against it; a second template would need a second parser this binary does not have. Write '${RUNNER_NAMING}', or drop the key to use it`,
    );
  }
  const poolsRaw = requireArray(path, "runners.pools", raw["pools"]);
  if (poolsRaw.length === 0) {
    throw new SchemaError(
      path,
      "runners.pools",
      "is empty. A runners block that declares no pool gives every 'nen runner' verb nothing to act on -- drop the block entirely, or declare at least one pool",
    );
  }
  const pools = poolsRaw.map((entry, index): RunnerPool => parseRunnerPool(path, `runners.pools[${index}]`, entry));
  const seen = new Map<string, number>();
  for (const [index, pool] of pools.entries()) {
    const first = seen.get(pool.id);
    if (first !== undefined) {
      throw new SchemaError(
        path,
        `runners.pools[${index}].id`,
        `repeats '${pool.id}', already the id of runners.pools[${first}]. --pool <id> names exactly one pool`,
      );
    }
    seen.set(pool.id, index);
    // NO SEPARATE LABEL-COLLISION REFUSAL (#340). A pool IS its label set, and
    // that set ends in `pool-<id>`: the repeated-id refusal above is therefore
    // also the refusal of two pools sharing a pool label or a label set. Two
    // pools of one os and arch are two pools now, told apart by that label.
    // ONE PREFLIGHT FILE PER POOL, because the file is RENDERED per pool
    // (`nen runner workflow` substitutes this pool's runs-on) and `nen runner
    // enable` reads a green run of it as proof of THIS pool. Two pools sharing
    // one basename would overwrite each other's file, and a green run on one
    // pool would read as proof of the other.
    const sharer = pools.findIndex((other): boolean => other.preflightWorkflow === pool.preflightWorkflow);
    if (sharer !== index) {
      throw new SchemaError(
        path,
        `runners.pools[${index}].preflightWorkflow`,
        `'${pool.preflightWorkflow}' is already runners.pools[${sharer}]'s preflight workflow. The file is rendered for ONE pool's runs-on, and a green run of it is what 'nen runner enable' accepts as proof of that pool -- so each pool names its own, e.g. 'runner-preflight-${pool.id}.yml'`,
      );
    }
  }
  return { naming, pools, raw };
}

/** The `runners` row `nen schema check` prints. See `describeSections`. */
export function describeRunners(workflow: Workflow): string {
  const runners = workflow.runners;
  if (runners === null) return "none declared";
  return `${runners.pools.length} pool(s): ${runners.pools
    .map(
      (pool): string =>
        `${pool.id} [${pool.labels.join(", ")}]${pool.enableVariable === null ? "" : ` via ${pool.enableVariable}`}`,
    )
    .join("; ")}`;
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

/**
 * `commits.subjectCase`: the preset string, or a commitlint tuple held to
 * ../commit/rule.ts's checks -- the same ones a commitlint data config's rule
 * meets -- and refused BY POINTER, down to the tuple element at fault, rather
 * than defaulted around. Any other string is refused naming the one accepted,
 * because another preset is a JavaScript package nen would have to execute.
 */
function parseSubjectCase(path: string, value: unknown): DeclaredSubjectCase | null {
  const pointer = "commits.subjectCase";
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    if (value === SUBJECT_CASE_PRESET) return { form: "config-conventional", ...CONVENTIONAL_SUBJECT_CASE };
    throw new SchemaError(
      path,
      pointer,
      `'${value}' is not a subject-case rule nen can apply. It takes the string '${SUBJECT_CASE_PRESET}' (@commitlint/config-conventional's default: [2, "never", ["sentence-case", "start-case", "pascal-case", "upper-case"]]) or an explicit commitlint rule [level, "always"|"never", cases]; any other preset is a JavaScript package nen does not execute, so state its rule as the tuple instead`,
    );
  }
  if (!Array.isArray(value)) {
    throw new SchemaError(
      path,
      pointer,
      `expected '${SUBJECT_CASE_PRESET}' or a commitlint rule [level, "always"|"never", cases], got ${describeValue(value)}`,
    );
  }
  const parsed = parseSubjectCaseTuple(value);
  if (!parsed.ok) {
    throw new SchemaError(path, `${pointer}${parsed.at}`, `the subject-case rule ${parsed.problem}, received ${JSON.stringify(value)}`);
  }
  return { form: "rule", ...parsed.spec };
}

function parseCommits(path: string, value: unknown): CommitsPolicy {
  const raw = block(path, "commits", value, COMMITS_KEYS, "A commits policy's five keys are");
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
  const runTrailerRaw = raw["runTrailer"];
  const runTrailer =
    runTrailerRaw === undefined || runTrailerRaw === null
      ? null
      : requireTrailerKey(path, "commits.runTrailer", requireString(path, "commits.runTrailer", runTrailerRaw));
  // A `runTrailer` THIS POLICY ALSO REFUSES IS A REQUIREMENT NO COMMIT CAN
  // EVER SATISFY. The generated hook's automated half would demand the key on
  // every automated commit and then refuse the very same message for carrying
  // it -- the refusal check sits ABOVE the marker-env gate and applies to
  // every commit unconditionally. Caught here, at load, by pointer, rather
  // than as a hook nobody can ever get past.
  if (runTrailer !== null) {
    const refused = refusedTrailerKeys({ allowedAttributionTrailers, forbiddenTrailers, runTrailer: null, subjectCase: null, bodyMaxLineLength: null, raw: {} }).find(
      (key): boolean => key.toLowerCase() === runTrailer.toLowerCase(),
    );
    if (refused !== undefined) {
      throw new SchemaError(
        path,
        "commits.runTrailer",
        `'${runTrailer}' is also a trailer this policy REFUSES ('${refused}', by the rules above). The generated hook would then require it on every automated commit and refuse the same message for carrying it -- a requirement no commit could ever satisfy. Add '${runTrailer}' to commits.allowedAttributionTrailers, add it to neither list, or choose a different commits.runTrailer`,
      );
    }
  }
  return {
    allowedAttributionTrailers,
    forbiddenTrailers,
    runTrailer,
    subjectCase: parseSubjectCase(path, raw["subjectCase"]),
    bodyMaxLineLength: parseBodyMaxLineLength(path, raw["bodyMaxLineLength"]),
    raw,
  };
}

/**
 * `commits.bodyMaxLineLength`: a positive whole number, held to
 * ../commit/rule.ts's parseBodyWidth and refused BY POINTER rather than
 * defaulted around -- a width nen could not read is a width nobody checked.
 */
function parseBodyMaxLineLength(path: string, value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = parseBodyWidth(value);
  if (!parsed.ok) throw new SchemaError(path, "commits.bodyMaxLineLength", `the declared body width ${parsed.problem}, got ${describeValue(value)}`);
  return parsed.width;
}

function parseMonitor(path: string, value: unknown): MonitorPolicy {
  const raw = block(path, "monitor", value, MONITOR_KEYS, "A monitor policy's three keys are");
  const slotRaw = raw["localSlotFrees"];
  const localSlotFreesDeclared = slotRaw !== undefined && slotRaw !== null;
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
    localSlotFrees: localSlotFreesDeclared
      ? requireEnum(path, "monitor.localSlotFrees", slotRaw, LOCAL_SLOT_RULES)
      : DEFAULT_LOCAL_SLOT_RULE,
    localSlotFreesDeclared,
    raw,
  };
}

/**
 * The `idle` block (HR-5). Every key is optional, but a key that IS stated is
 * validated: a resolution outside the closed set, a row id that is not a
 * decisions.json slug, an empty terminal or a budget that is not a positive
 * whole number is refused by pointer. Whether each row id is an ask-once row
 * is a SECOND file's question, answered by `nen schema check`'s
 * `nen/workflow.json#idle` row, never here.
 */
function parseIdle(path: string, value: unknown): IdlePolicy | null {
  if (value === undefined || value === null) return null;
  const raw = block(path, "idle", value, IDLE_KEYS, "An idle profile's three keys are");
  const decisions: Record<string, IdleResolution> = {};
  if (raw["decisions"] !== undefined && raw["decisions"] !== null) {
    const map = requireRecord(path, "idle.decisions", raw["decisions"]);
    for (const [id, resolution] of Object.entries(map)) {
      if (id.startsWith("$")) continue;
      if (!DECISION_ROW_ID.test(id)) {
        throw new SchemaError(
          path,
          `idle.decisions.${id}`,
          "is not a decision row id: nen/decisions.json spells a row id [a-z0-9-]+, so this key could never name an ask-once row",
        );
      }
      decisions[id] = requireEnum(path, `idle.decisions.${id}`, resolution, IDLE_RESOLUTIONS);
    }
  }
  let terminal: string | null = null;
  if (raw["terminal"] !== undefined && raw["terminal"] !== null) {
    terminal = requireString(path, "idle.terminal", raw["terminal"]);
    if (terminal.trim() === "") {
      throw new SchemaError(path, "idle.terminal", "is an empty string. State the terminal state the batch runs to, or omit the key");
    }
  }
  let minutes: number | null = null;
  let tokens: number | null = null;
  if (raw["budget"] !== undefined && raw["budget"] !== null) {
    const budget = block(path, "idle.budget", raw["budget"], IDLE_BUDGET_KEYS, "An idle budget's two keys are");
    const whole = (key: string): number | null => {
      const at = budget[key];
      if (at === undefined || at === null) return null;
      if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 1) {
        throw new SchemaError(path, `idle.budget.${key}`, `expected a positive whole number, got ${describeValue(at)}. A budget of zero or less is a batch that may never start`);
      }
      return at;
    };
    minutes = whole("minutes");
    tokens = whole("tokens");
  }
  const slotRaw = raw["localSlotFrees"];
  const localSlotFrees = slotRaw === undefined || slotRaw === null ? null : requireEnum(path, "idle.localSlotFrees", slotRaw, LOCAL_SLOT_RULES);
  const unreadKeys = Object.keys(raw).filter((key): boolean => !key.startsWith("$") && !IDLE_KEYS.includes(key));
  return { decisions, terminal, budget: { minutes, tokens }, localSlotFrees, unreadKeys, raw };
}

/** The `nen/workflow.json#idle` row's text when a profile is declared. */
export function describeIdle(idle: IdlePolicy): string {
  const ids = Object.keys(idle.decisions);
  const budget = [
    idle.budget.minutes === null ? null : `${idle.budget.minutes} min`,
    idle.budget.tokens === null ? null : `${idle.budget.tokens} tokens`,
  ].filter((part): part is string => part !== null);
  return `${ids.length} ask-once row resolution${ids.length === 1 ? "" : "s"}${ids.length === 0 ? "" : ` (${ids.map((id): string => `${id}=${idle.decisions[id] ?? ""}`).join(", ")})`}; terminal ${idle.terminal === null ? "unstated" : JSON.stringify(idle.terminal)}; budget ${budget.length === 0 ? "unstated" : budget.join(", ")}; local slot frees ${idle.localSlotFrees ?? "unstated"}`;
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
export function parseModels(path: string, value: unknown): ModelsPolicy {
  if (value === undefined || value === null) {
    return { rule: null, surfaces: emptyRecord(), roles: emptyRecord(), raw: {} };
  }
  const raw = requireRecord(path, "models", value);
  const surfaces = emptyRecord<Readonly<Record<string, string>>>();
  for (const [name, entry] of Object.entries(raw)) {
    if (name.startsWith("$") || name === "rule" || name === "roles") continue;
    const pointer = `models.${name}`;
    const perSurface = requireRecord(path, pointer, entry);
    const tiers = emptyRecord<string>();
    for (const [tier, alias] of Object.entries(perSurface)) {
      if (tier.startsWith("$")) continue;
      tiers[tier] = requireString(path, `${pointer}.${tier}`, alias);
    }
    surfaces[name] = tiers;
  }
  const rolesRaw = raw["roles"];
  const roles = emptyRecord<string>();
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

/**
 * `profile` -- a default and an allow-list, both held to the three known names.
 *
 * `default` MUST BE ALLOWED, and the refusal names both: a default outside
 * the allow-list is a turn that runs under a profile the same file forbids
 * asking for, which is a contradiction and not a configuration. Each name is
 * validated against PROFILE_NAMES by pointer, and a duplicate in `allowed` is
 * refused too -- it is a list somebody edited twice, not a wider allowance.
 */
function parseProfile(path: string, value: unknown): ProfilePolicy {
  const raw = block(path, "profile", value, PROFILE_KEYS, "A profile policy's two keys are");
  const known = PROFILE_NAMES.join(", ");
  const name = (pointer: string, candidate: unknown): string => {
    const text = requireString(path, pointer, candidate);
    if (!PROFILE_NAMES.includes(text)) {
      throw new SchemaError(path, pointer, `'${text}' is not a run profile nen knows. The three are ${known}; a fourth name would be a profile no turn loop implements`);
    }
    return text;
  };
  const allowed = stringsOr(path, "profile.allowed", raw["allowed"], PROFILE_NAMES).map((entry, index): string => name(`profile.allowed[${index}]`, entry));
  if (allowed.length === 0) {
    throw new SchemaError(path, "profile.allowed", `is empty. A repository that allows no profile allows no turn; list at least one of ${known}, or drop the key to allow all three`);
  }
  const seen = new Set<string>();
  for (const [index, entry] of allowed.entries()) {
    if (seen.has(entry)) throw new SchemaError(path, `profile.allowed[${index}]`, `repeats '${entry}'. Each profile is allowed once; a repeat is an edit made twice, not a wider allowance`);
    seen.add(entry);
  }
  const fallback = allowed.includes(DEFAULT_PROFILE) ? DEFAULT_PROFILE : (allowed[0] as string);
  const defaultProfile = raw["default"] === undefined || raw["default"] === null ? fallback : name("profile.default", raw["default"]);
  if (!allowed.includes(defaultProfile)) {
    throw new SchemaError(path, "profile.default", `'${defaultProfile}' is not in profile.allowed (${allowed.join(", ")}). A bare turn would run under a profile this same file forbids asking for; add it to 'allowed' or pick one that is`);
  }
  return { default: defaultProfile, allowed, raw };
}

function parseSeverity(path: string, value: unknown): SeverityPolicy | null {
  if (value === undefined) return null;
  const raw = block(path, "severity", value, ["family", "order", "labels"], "Severity keys are");
  const family = requireString(path, "severity.family", raw["family"]);
  if (!/^[^/,\s+]+$/.test(family)) throw new SchemaError(path, "severity.family", "expected a family identifier without whitespace, slash, comma or plus");
  const order = requireArray(path, "severity.order", raw["order"]).map((item, index): string => {
    const pointer = `severity.order[${index}]`;
    const name = requireString(path, pointer, item);
    if (name.startsWith("$")) throw new SchemaError(path, pointer, "must not start with '$': $-prefixed names are metadata and cannot select severity labels");
    return name;
  });
  if (order.length === 0 || order.some((leaf) => leaf.trim() !== leaf || /[/:,+\s]/.test(leaf)) || new Set(order.map((leaf) => leaf.toLowerCase())).size !== order.length) {
    throw new SchemaError(path, "severity.order", "expected nonempty, distinct label leaves, highest priority first (no whitespace, '/', ':', ',' or '+')");
  }
  let labels: Record<string, string> | null = null;
  if (raw["labels"] !== undefined) {
    const mapping = requireRecord(path, "severity.labels", raw["labels"]);
    labels = emptyRecord<string>();
    for (const name of order) labels[name] = requireString(path, `severity.labels.${name}`, mapping[name]);
    for (const key of Object.keys(mapping)) {
      if (!key.startsWith("$") && !order.includes(key)) throw new SchemaError(path, `severity.labels.${key}`, "is not named in severity.order");
    }
    if (new Set(Object.values(labels)).size !== order.length) throw new SchemaError(path, "severity.labels", "each severity must name a distinct label");
  } else if (!/^([^:/\s]+):([^:/\s]+)$/.test(family)) {
    throw new SchemaError(path, "severity.family", "expected '<namespace>:<family>', or explicit severity.labels mapping to full label names");
  }
  return { family, order, labels, raw };
}

function parseCi(path: string, value: unknown): CiPolicy | null {
  if (value === undefined) return null;
  const raw = requireRecord(path, "ci", value);
  const provider = requireString(path, "ci.provider", raw["provider"]);
  const pinned = raw["pinned"] === undefined || raw["pinned"] === null ? null : requireString(path, "ci.pinned", raw["pinned"]);
  if (raw["tiers"] !== undefined) requireArray(path, "ci.tiers", raw["tiers"]).forEach((tier, i): void => { requireString(path, `ci.tiers[${i}]`, tier); });
  if (raw["rulings"] !== undefined) requireRecord(path, "ci.rulings", raw["rulings"]);
  return { provider, pinned, raw };
}

export function parseWorkflow(path: string, value: unknown): Workflow {
  const raw = requireRecord(path, "(root)", value);
  refuseNearMissKey(path, "", raw, ROOT_KEYS, "A workflow's twenty-three blocks are");
  const monitor = parseMonitor(path, raw["monitor"]);
  const idle = parseIdle(path, raw["idle"]);
  // ONE RULE, ONE VALUE: a repository that states the slot rule under both
  // keys with two values has not said when a slot frees.
  if (idle !== null && idle.localSlotFrees !== null && monitor.localSlotFreesDeclared && idle.localSlotFrees !== monitor.localSlotFrees) {
    throw new SchemaError(path, "idle.localSlotFrees", `is '${idle.localSlotFrees}' while monitor.localSlotFrees is '${monitor.localSlotFrees}'. State the rule once (idle.localSlotFrees is read under an idle profile), or state the same value in both`);
  }
  return {
    // `$schema` IS A `$`-KEY LIKE EVERY OTHER -- surfaced when it happens to be
    // a string, ignored otherwise, and preserved either way by `raw`. The same
    // rule ../schema/contract.ts states for the same field.
    schema: typeof raw["$schema"] === "string" && raw["$schema"] !== "" ? raw["$schema"] : null,
    severity: parseSeverity(path, raw["severity"]),
    branch: parseBranch(path, raw["branch"]),
    iteration: parseIteration(path, raw["iteration"]),
    tests: parseTests(path, raw["tests"]),
    coverage: parseCoverage(path, raw["coverage"]),
    launch: parseLaunch(path, raw["launch"]),
    deploy: parseDeploy(path, raw["deploy"]),
    privateNames: parsePrivateNames(path, raw["privateNames"]),
    reports: parseReports(path, raw["reports"]),
    notifications: parseNotifications(path, raw["notifications"]),
    commits: parseCommits(path, raw["commits"]),
    monitor,
    models: parseModels(path, raw["models"]),
    review: parseReview(path, raw["review"]),
    profile: parseProfile(path, raw["profile"]),
    release: parseReleasePolicy(path, raw["release"]),
    futon: parseFutonPolicy(path, raw["futon"]),
    runners: parseRunners(path, raw["runners"]),
    ci: parseCi(path, raw["ci"]),
    idle,
    spec: parseSpecPolicy(path, raw["spec"]),
    alwaysOverlaps: parseAlwaysOverlaps(path, raw["alwaysOverlaps"]),
    canon: parseCanonPolicy(path, raw["canon"]),
    raw,
  };
}

/**
 * `spec` -- the keys a product family's spec repository states for its
 * capture skill (Hatsu docs/config/spec-repo.md § The spec repository's keys;
 * zheref/nen#493's catalogue domain). Every key is optional; a stated key is
 * held to its type and range, a near-miss refused by the name it meant. Three
 * carry the catalogue's defaults (clarify.maxQuestions 5, clarify.maxRounds 3,
 * capture.foldersPerPr 4) and two their one safe value (autonomy.unmetSc
 * refuse, autonomy.convergeFiling propose); the rest are TYPED by the
 * maintainer and have none -- null here, and a reader that needs one says it
 * is missing rather than inventing it.
 */
export interface SpecPolicy {
  readonly declared: boolean;
  /**
   * Every key path the file STATES (`clarify.maxQuestions`, `autonomy.unmetSc`, …), so a reader can tell a
   * stated value from a filled default: Hatsu reads an absent key at wave time as missing-configuration,
   * never as the default (spec-repo.md § The spec repository's keys; Nobunaga F13).
   */
  readonly stated: readonly string[];
  readonly clarify: { readonly maxQuestions: number; readonly maxRounds: number };
  readonly capture: { readonly foldersPerPr: number };
  readonly maxBytes: number | null;
  readonly autonomy: {
    readonly platformOrder: readonly string[] | null;
    readonly referencePlatform: string | null;
    readonly maxInFlight: Readonly<Record<string, number>> | null;
    readonly unmetSc: (typeof SPEC_UNMET_SC)[number];
    readonly convergeFiling: (typeof SPEC_CONVERGE_FILING)[number];
    readonly waveEnds: (typeof SPEC_WAVE_ENDS)[number] | null;
  };
}

export function defaultSpecPolicy(): SpecPolicy {
  return {
    declared: false,
    stated: [],
    clarify: { maxQuestions: 5, maxRounds: 3 },
    capture: { foldersPerPr: 4 },
    maxBytes: null,
    autonomy: { platformOrder: null, referencePlatform: null, maxInFlight: null, unmetSc: "refuse", convergeFiling: "propose", waveEnds: null },
  };
}

function parseSpecPolicy(path: string, value: unknown): SpecPolicy {
  const defaults = defaultSpecPolicy();
  if (value === undefined || value === null) return defaults;
  const raw = block(path, "spec", value, SPEC_KEYS, "A spec block's four keys are");
  const positive = (pointer: string, at: unknown, fallback: number): number => {
    if (at === undefined) return fallback;
    if (!Number.isSafeInteger(at) || (at as number) < 1) throw new SchemaError(path, pointer, `expected a positive whole number, got ${describeValue(at)}`);
    return at as number;
  };
  const clarify = block(path, "spec.clarify", raw["clarify"], SPEC_CLARIFY_KEYS, "spec.clarify's two keys are");
  const capture = block(path, "spec.capture", raw["capture"], SPEC_CAPTURE_KEYS, "spec.capture's one key is");
  const autonomy = block(path, "spec.autonomy", raw["autonomy"], SPEC_AUTONOMY_KEYS, "spec.autonomy's six keys are");
  const word = (pointer: string, at: unknown): string => {
    const text = requireString(path, pointer, at);
    if (text.trim() === "") throw new SchemaError(path, pointer, "is an empty string");
    return text;
  };
  let platformOrder: string[] | null = null;
  if (autonomy["platformOrder"] !== undefined) {
    platformOrder = requireArray(path, "spec.autonomy.platformOrder", autonomy["platformOrder"]).map((item, index): string => word(`spec.autonomy.platformOrder[${index}]`, item));
    if (platformOrder.length === 0 || new Set(platformOrder).size !== platformOrder.length) throw new SchemaError(path, "spec.autonomy.platformOrder", "expected a non-empty list of distinct platforms");
  }
  const referencePlatform = autonomy["referencePlatform"] === undefined ? null : word("spec.autonomy.referencePlatform", autonomy["referencePlatform"]);
  if (referencePlatform !== null && platformOrder !== null && !platformOrder.includes(referencePlatform)) throw new SchemaError(path, "spec.autonomy.referencePlatform", `'${referencePlatform}' is not in spec.autonomy.platformOrder (${platformOrder.join(", ")})`);
  // "an integer per platform" (Hatsu spec-repo.md): a map, each key a platform of platformOrder when it is stated (Nobunaga F19).
  let maxInFlight: Record<string, number> | null = null;
  const inFlight = autonomy["maxInFlight"];
  if (inFlight !== undefined) {
    const map = requireRecord(path, "spec.autonomy.maxInFlight", inFlight);
    maxInFlight = Object.fromEntries(Object.entries(map).filter(([key]): boolean => !key.startsWith("$")).map(([key, at]): [string, number] => {
      if (platformOrder !== null && !platformOrder.includes(key)) throw new SchemaError(path, `spec.autonomy.maxInFlight.${key}`, `'${key}' is not in spec.autonomy.platformOrder (${platformOrder.join(", ")})`);
      return [key, positive(`spec.autonomy.maxInFlight.${key}`, at, 1)];
    }));
  }
  const stated = [
    ...SPEC_CLARIFY_KEYS.filter((key): boolean => clarify[key] !== undefined).map((key): string => `clarify.${key}`),
    ...SPEC_CAPTURE_KEYS.filter((key): boolean => capture[key] !== undefined).map((key): string => `capture.${key}`),
    ...(raw["maxBytes"] === undefined ? [] : ["maxBytes"]),
    ...SPEC_AUTONOMY_KEYS.filter((key): boolean => autonomy[key] !== undefined).map((key): string => `autonomy.${key}`),
  ];
  return {
    declared: true,
    stated,
    clarify: { maxQuestions: positive("spec.clarify.maxQuestions", clarify["maxQuestions"], defaults.clarify.maxQuestions), maxRounds: positive("spec.clarify.maxRounds", clarify["maxRounds"], defaults.clarify.maxRounds) },
    capture: { foldersPerPr: positive("spec.capture.foldersPerPr", capture["foldersPerPr"], defaults.capture.foldersPerPr) },
    maxBytes: raw["maxBytes"] === undefined ? null : positive("spec.maxBytes", raw["maxBytes"], 1),
    autonomy: {
      platformOrder,
      referencePlatform,
      maxInFlight,
      unmetSc: autonomy["unmetSc"] === undefined ? "refuse" : requireEnum(path, "spec.autonomy.unmetSc", autonomy["unmetSc"], SPEC_UNMET_SC),
      convergeFiling: autonomy["convergeFiling"] === undefined ? "propose" : requireEnum(path, "spec.autonomy.convergeFiling", autonomy["convergeFiling"], SPEC_CONVERGE_FILING),
      waveEnds: autonomy["waveEnds"] === undefined ? null : requireEnum(path, "spec.autonomy.waveEnds", autonomy["waveEnds"], SPEC_WAVE_ENDS),
    },
  };
}

const CANON_KEYS: readonly string[] = ["lint"];
const CANON_LINT_KEYS: readonly string[] = ["rules", "baseline", "skillPaths"];

/** A repository-relative path: non-empty, never absolute, never climbing out with '..'. */
function repoRelativePath(path: string, pointer: string, value: unknown): string {
  const entry = requireString(path, pointer, value);
  if (entry.trim() === "" || entry.startsWith("/") || /^[A-Za-z]:/.test(entry) || entry.split(/[\\/]/).includes("..")) {
    throw new SchemaError(path, pointer, `is ${JSON.stringify(entry)}: a repository-relative path, never empty, absolute or climbing out with '..'`);
  }
  return entry;
}

/**
 * `canon` (zheref/nen#481): `canon.lint` is the declared home of the canon
 * prose lint's rules contract and baseline, so `nen canon lint --repo <path>`
 * needs no flag and `nen schema check` has a file to validate them from.
 * `rules` is required once `lint` is declared; `baseline` and `skillPaths`
 * are optional. The CONTENTS of the two files are checked by the
 * `nen/workflow.json#canon.lint` row, never here: this loader reads one file.
 */
function parseCanonPolicy(path: string, value: unknown): CanonPolicy | null {
  if (value === undefined || value === null) return null;
  const raw = block(path, "canon", value, CANON_KEYS, "A canon policy's keys are");
  const lintRaw = raw["lint"];
  if (lintRaw === undefined || lintRaw === null) return { lint: null, raw };
  const lint = block(path, "canon.lint", lintRaw, CANON_LINT_KEYS, "A canon lint policy's keys are");
  if (lint["rules"] === undefined) throw new SchemaError(path, "canon.lint.rules", "is required: the rules contract nen canon lint reads (nen.prose-lint/v0.1). A lint with no rules checks nothing");
  const rules = repoRelativePath(path, "canon.lint.rules", lint["rules"]);
  const baseline = lint["baseline"] === undefined || lint["baseline"] === null ? null : repoRelativePath(path, "canon.lint.baseline", lint["baseline"]);
  let skillPaths: string[] | null = null;
  if (lint["skillPaths"] !== undefined && lint["skillPaths"] !== null) {
    skillPaths = requireArray(path, "canon.lint.skillPaths", lint["skillPaths"]).map((item, index): string => {
      const glob = requireString(path, `canon.lint.skillPaths[${index}]`, item);
      if (glob.trim() === "") throw new SchemaError(path, `canon.lint.skillPaths[${index}]`, "is empty. A glob that matches nothing applies the rule nowhere");
      return glob;
    });
    if (skillPaths.length === 0) throw new SchemaError(path, "canon.lint.skillPaths", "is an empty array. Omit it to apply the per-skill rules to every linted path, or name the globs");
  }
  return { lint: { rules, baseline, skillPaths }, raw };
}

/** `alwaysOverlaps`: a list of non-empty repository-relative paths, each once; refused by pointer otherwise. */
function parseAlwaysOverlaps(path: string, value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  const list = requireArray(path, "alwaysOverlaps", value).map((item, index): string => {
    const entry = requireString(path, `alwaysOverlaps[${index}]`, item);
    if (entry.trim() === "" || entry.startsWith("/") || entry.split("/").includes("..")) {
      throw new SchemaError(path, `alwaysOverlaps[${index}]`, `is ${JSON.stringify(entry)}: a repository-relative path (a trailing '/' for a directory prefix), never empty, absolute or climbing out with '..'`);
    }
    return entry;
  });
  const twice = list.find((entry, index): boolean => list.indexOf(entry) !== index);
  if (twice !== undefined) throw new SchemaError(path, "alwaysOverlaps", `names '${twice}' twice`);
  return list;
}

/** The `nen/workflow.json#alwaysOverlaps` row's text. */
export function describeAlwaysOverlaps(workflow: Workflow): string {
  const list = workflow.alwaysOverlaps ?? [];
  return list.length === 0 ? "none declared" : `${list.length} path${list.length === 1 ? "" : "s"} every effort counts as touching (${list.join(", ")})`;
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
  const read: { path: string; text: string; location: SchemaLocation } = readSchemaFile(
    repoRoot,
    WORKFLOW_FILE,
  );
  // A REPEATED KEY IN THE `deploy` BLOCK IS REFUSED BEFORE PARSING
  // (zheref/nen#300, Feitan N1): two `defaultTarget`s read as the last to
  // `JSON.parse` and as either to a reviewer. Scoped to that block, which is
  // the one this change adopts the rule for.
  refuseDuplicateKeyWithin(read.path, read.text, "deploy");
  let value: unknown;
  try {
    value = JSON.parse(read.text) as unknown;
  } catch (error) {
    throw new SchemaError(read.path, null, `is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const workflow = parseWorkflow(read.path, value);
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
 * The `reports.sections` row `nen schema check` prints, worded once.
 *
 * IT IS ITS OWN ROW AND NOT A CLAUSE OF THE POLICY ROW (zheref/nen#220). The
 * policy row answers "does this file load"; these two answer "does this
 * repository declare the thing the verb that reads it needs" -- which is the
 * question a warm-up asks before `report render --variant` or `review scopes`
 * refuses at exit 1 or 2, and folding it into the one-line policy summary would
 * hide it behind a coverage ladder.
 */
export function describeSections(workflow: Workflow): string {
  const names = Object.keys(workflow.reports.sections);
  return names.length === 0
    ? "none declared"
    : `${names.length} variant(s): ${names.join(", ")}`;
}

/**
 * The `deploy.defaultTarget` row's text when the policy states NO name
 * (zheref/nen#300). A stated name is described by ../schema/taxonomy.ts, which
 * holds the contract the name has to be a key of.
 */
export const DEFAULT_TARGET_NONE = "none declared (a caller's tooling asks; nen shu deploy still requires --target)";

/** The `profile` row `nen schema check` prints (zheref/nen#227). See `describeSections`. */
export function describeProfile(workflow: Workflow): string {
  return `default ${workflow.profile.default}; allowed ${workflow.profile.allowed.join(", ")}`;
}

/** The `review.scopes` row `nen schema check` prints. See `describeSections`. */
export function describeReviewScopes(workflow: Workflow): string {
  const names = Object.keys(workflow.review.scopes);
  return names.length === 0
    ? "none declared"
    : `${names.length} scope(s): ${names
        .map((name): string => `${name} (${workflow.review.scopes[name]?.persona ?? "?"})`)
        .join(", ")}`;
}

/** The release pointer row exposes the declared bounds independently of the coverage/branch summary. */
export function describeRelease(workflow: Workflow): string {
  const entries = workflow.release.unitPaths;
  if (entries === null) return "none declared (release unit-check refuses an undeclared unit)";
  const strings = entries.filter((entry): entry is string => typeof entry === "string");
  const keyed = entries.filter((entry): boolean => typeof entry !== "string" && "keys" in entry).length;
  const lined = entries.filter((entry): boolean => typeof entry !== "string" && "lines" in entry).length;
  const deleted = entries.filter((entry): boolean => typeof entry !== "string" && "deleteOnly" in entry).length;
  return `${entries.length} entry(s): ${strings.filter((entry): boolean => entry.startsWith("=")).length} exact path(s), ${strings.filter((entry): boolean => !entry.startsWith("=")).length} prefix/glob(s), ${keyed} key-bound, ${lined} line-bound${deleted === 0 ? "" : `, ${deleted} deletion-only`}`;
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

/**
 * Whether this policy's OWN allow-list admits one caller-typed trailer key.
 *
 * NOT THE SAME QUESTION AS `trailerRefusal`. A key nen has never heard of
 * (`Akatsuki-Agent`, a caller's own vocabulary rather than one of
 * `ATTRIBUTION_TRAILERS`) is never auto-refused, so it can be "not refused"
 * and "not admitted" at the same time -- and that is exactly the state
 * ./scaffold/hook.ts's generated commit-msg hook needs to tell apart from
 * "admitted": a hook required to demand a trailer on every automated commit
 * that this repository's own policy does not list under
 * `commits.allowedAttributionTrailers` is a requirement no commit can ever
 * satisfy honestly, and `nen scaffold init` generates a hook that refuses
 * every automated commit outright rather than one that checks for a trailer
 * it would then be impossible to add. Matched case-insensitively, for the
 * same reason every other trailer comparison here is.
 */
export function trailerAdmitted(commits: CommitsPolicy, key: string): boolean {
  const lower = key.trim().toLowerCase();
  return commits.allowedAttributionTrailers.some(
    (candidate): boolean => candidate.toLowerCase() === lower,
  );
}

/**
 * Every attribution-trailer refusal message a LOADED policy has for a set of
 * caller-typed trailer keys, worded once so `nen commit format` and `nen wc
 * squash` -- the two callers that shape a commit message under this policy --
 * cannot drift into two different sentences for the same refusal.
 *
 * TAKES BARE KEYS, NOT ../commit/format.ts's `Trailer` PAIRS, on purpose:
 * this module is read by every taxonomy loader and must not grow a dependency
 * on a commit-formatting type merely to describe one of its own fields.
 *
 * AN ABSENT POLICY REFUSES NOTHING, exactly as `nen commit format` has always
 * behaved: only a repository that STATES `nen/workflow.json` gets an opinion
 * about its trailers.
 */
export function attributionRefusalMessages(
  loaded: LoadedWorkflow,
  trailerKeys: readonly string[],
): readonly string[] {
  if (!loaded.present) return [];
  const allowed = loaded.workflow.commits.allowedAttributionTrailers;
  const refusals: string[] = [];
  for (const key of trailerKeys) {
    const refused = trailerRefusal(loaded.workflow.commits, key);
    if (refused === null) continue;
    // TWO WHOLE SENTENCES, NOT ONE WITH A HOLE IN IT -- see ../commit/
    // command.ts's original header for why an empty and a populated allow
    // list are different facts that read as different sentences.
    refusals.push(
      allowed.length === 0
        ? `trailer key '${key}' is an attribution trailer this repository refuses. '${loaded.path}' admits none at all: its commits.allowedAttributionTrailers is empty. Drop the trailer, or add '${refused}' to that list`
        : `trailer key '${key}' is an attribution trailer this repository refuses. '${loaded.path}' admits ${allowed
            .map((k): string => `'${k}'`)
            .join(", ")} under commits.allowedAttributionTrailers, and '${refused}' is not one of them. Drop the trailer, or add its key to that list`,
    );
  }
  return refusals;
}
