// src/commit/commitlint.ts -- the repository's OWN commitlint `subject-case`
// rule, read from where commitlint reads it -- or from where the repository
// DECLARES it for nen -- and the one check `commit format` and `commit write`
// both run with it (zheref/nen#263).
//
// WHY THIS EXISTS. A builder runs `nen commit format` so they do not have to
// guess whether the repository's commit-msg hook will accept a message. When
// the hook runs commitlint and commitlint enforces a rule nen does not, the
// builder gets a green from nen, commits, and meets the real gate afterwards
// -- in the sitting this issue came from, 'Start…' and 'Escape…' subjects,
// twice, each an amend and a recommit. So nen now gives commitlint's verdict
// first, under the rule the repository itself states.
//
// TWO PLACES THE RULE CAN BE STATED, AND THE PRECEDENCE BETWEEN THEM:
//
//   1. THE COMMITLINT CONFIG, WHEN NEN CAN READ IT AS DATA. It is the gate
//      commitlint actually runs at commit time, so where it is readable it
//      WINS: its rule is applied (or its absence of one is honoured), and a
//      `commits.subjectCase` beside it is reported as not applied -- never
//      silently ignored, and never allowed to overrule the real gate, which
//      would refuse subjects commitlint accepts or pass ones it refuses.
//   2. `commits.subjectCase` IN nen/workflow.json, everywhere else: when the
//      commitlint config is CODE (commitlint.config.cjs and kin, which nen
//      never executes), when nen cannot otherwise read the rule from it (an
//      unresolvable preset, cosmiconfig's `$import`, a package manifest whose
//      `commitlint` key will not parse), and when there is no commitlint config
//      at all. There the declared rule is BINDING -- level 2 refuses at the
//      verb's exit 2 through the same path a commitlint rule does -- and the
//      output says the rule came from nen/workflow.json. The repository that
//      declares it owns keeping it in step with its commitlint config.
//
// With neither -- a code config and no declaration -- the verb can only warn
// that the rule was NOT checked, with config-conventional's verdict for
// reference, at exit 0; a caller gating on the exit code alone is not
// protected there, which is exactly what the declaration exists to close.
//
// SCOPE: `subject-case`, AND NOTHING ELSE commitlint checks. This is not a
// commitlint reimplementation; nen's own shape rules (./format.ts) are
// unchanged and are not reconciled with the repository's other commitlint
// rules. ./case.ts holds the rule's semantics, ./rule.ts the tuple both places
// state it in; this module finds the rule and the subject commitlint would
// hand it.
//
// WHERE COMMITLINT LOOKS, AND WHERE NEN DOES. @commitlint/load 21.2.3
// (src/utils/load-config.ts) asks cosmiconfig 9 for the first of
// COMMITLINT_SEARCH_PLACES below, in that order, in each directory from its
// cwd up to the home directory and then in commitlint's global config
// directory. A commit-msg hook runs it from the repository root, so the root
// is where it finds a repository's config -- and the root is the one place
// nen reads: `--repo`, never a parent (../repo/root.ts refuses an upward walk,
// deliberately). A config that lives only above the checkout or in the global
// directory, a `--config <path>` the hook passes, and cosmiconfig's meta
// configuration (`.config/config.*`) are therefore NOT read. Where that could
// matter is said out loud: when nothing is found, nothing is declared, and
// the directory has no `.git` entry, so it is probably not a checkout root,
// the verb warns that the rule was not checked and names `--repo`.
// Cosmiconfig's own rules are kept: package.json and package.yaml count only
// when they carry a `commitlint` key, and a file that is blank or holds `null`
// is skipped and the search goes on to the next place, exactly as cosmiconfig
// skips it.
//
// DATA IS READ; CODE IS NOT. JSON (package.json, .commitlintrc.json), YAML
// (.commitlintrc.yaml/.yml, package.yaml -- through ../schema/yaml.ts, the one
// YAML reader in this binary) and the extensionless .commitlintrc (JSON
// first, then YAML: cosmiconfig loads it as YAML, of which JSON is a subset)
// are parsed. A .js/.cjs/.mjs/.ts/.cts/.mts config is NOT, because the only
// way to read one is to execute the repository's code, and a message
// formatter has no business doing that. The YAML reader is the strict one the
// taxonomy files use, so a YAML config built with anchors, aliases, tags or
// merge keys -- which commitlint's own YAML loader accepts -- is refused by
// name rather than half-read.
//
// A PACKAGE FILE IS NOT COMMITLINT'S UNTIL IT SAYS SO. package.json and
// package.yaml belong to the repository's package manager; most of them carry
// no `commitlint` key at all, and an idiomatic package.yaml uses the very
// anchors the strict reader refuses. So a package file whose TEXT has no
// `commitlint` key is stepped past unparsed, and one that has the key but
// will not parse is a rule nen could not read (precedence 2 above), never
// exit 1 -- a repository without commitlint must never have its commit verbs
// stopped by its package manifest. The .commitlintrc forms are commitlint's
// by name, so a malformed one stays exit 1 whatever nen/workflow.json
// declares, and so does a package key that parses into a config commitlint
// itself would reject.
//
// `extends`, AS FAR AS DATA CAN SEE. commitlint merges a config's `extends`
// in order, each over the last, and the file's own `rules` over all of them
// (@commitlint/resolve-extends). An explicit `rules['subject-case']` is
// therefore decisive whatever is extended. Without one, the rule comes from
// the last preset that sets it -- and a preset is a JavaScript package, so the
// one nen can answer for is the one whose rule is published and fixed:
// `@commitlint/config-conventional`, whose default ./rule.ts carries. Any
// other preset AFTER the last config-conventional may set the rule too, so
// that is a rule nen cannot read, never a guess. A preset BEFORE it is
// overridden by it and does not matter.
//
// THE SUBJECT IS THE ONE COMMITLINT'S PARSER FINDS, not the one nen was
// handed. commitlint splits the header with its parser preset's patterns, and
// they are greedy about the scope: `fix(a): Foo (b): bar` has the subject
// `bar` to commitlint. With config-conventional extended, or any
// `parserPreset` named, the grammar is conventional-changelog-
// conventionalcommits'; with neither -- and no preset extended that could
// supply one -- it is @commitlint/parse's default, conventional-changelog-
// angular's, which has no `!`: `feat!: Foo bar` does not parse, commitlint
// finds no subject, and gives it no subject-case verdict. nen then gives none
// either, and says so in a warning rather than refusing what commitlint
// accepts. A rule DECLARED in nen/workflow.json is judged with the
// conventionalcommits grammar -- the Conventional Commits header nen renders,
// and config-conventional's own.
//
// THE OUTCOMES, AND WHO SEES EACH:
//
//   * no config, nothing declared, or a readable config that states no
//     subject-case -> nothing at all; the verb behaves exactly as it did
//     before this module existed (plus the not-a-checkout-root warning above,
//     when it applies, and the not-applied note when something is declared).
//   * a rule at level 2 that the subject breaks -- read from commitlint's
//     config or declared in nen/workflow.json -> a refusal, at the verb's
//     existing shape-refusal exit (2).
//   * a rule at level 1 -> a `warning:` line and exit 0: commitlint warns and
//     still commits (unless the hook runs it with --strict).
//   * a declared rule the subject passes -> a `note:` line saying the rule
//     came from nen/workflow.json and why it was applied.
//   * a config nen cannot read the rule from with nothing declared, or a
//     header commitlint's default parser cannot split -> a `warning:` line
//     saying NOT CHECKED, and exit 0.
//   * a .commitlintrc that is present but malformed, or a config commitlint
//     itself would reject -> CommitlintConfigError, which the verbs turn into
//     exit 1, on the same argument as a malformed nen/workflow.json: nen will
//     not call a subject well-formed under a rule it could not read.
//
// WHAT IS NOT MIRRORED, NAMED. commitlint's `ignores` (a JS config's
// functions, and `defaultIgnores`' merge/revert/fixup patterns), under which
// commitlint skips a message nen still judges; a `parserPreset` other than
// conventional-changelog-conventionalcommits, and a preset extended beside an
// explicit rule that may supply one -- nen reads the header with the
// conventionalcommits grammar in both, so a preset whose grammar differs may
// hand commitlint's rule a different subject; and a plugin that redefines
// `subject-case` itself, which only code can define.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml, YamlError } from "../schema/yaml.js";
import type { DeclaredSubjectCase, LoadedWorkflow } from "../schema/workflow.js";
import { subjectCaseVerdict, type CaseCheck, type CaseName, type CaseVerdict, type Condition } from "./case.js";
import { CONFIG_CONVENTIONAL, CONVENTIONAL_SUBJECT_CASE, parseSubjectCaseTuple, type SubjectCaseSpec } from "./rule.js";

export { CONFIG_CONVENTIONAL, CONVENTIONAL_SUBJECT_CASE };

/** @commitlint/load 21.2.3's searchPlaces, in its order: the first present, non-empty one is the config. */
export const COMMITLINT_SEARCH_PLACES: readonly string[] = [
  "package.json",
  "package.yaml",
  ".commitlintrc",
  ".commitlintrc.json",
  ".commitlintrc.yaml",
  ".commitlintrc.yml",
  ".commitlintrc.js",
  ".commitlintrc.cjs",
  ".commitlintrc.mjs",
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  ".commitlintrc.ts",
  ".commitlintrc.cts",
  ".commitlintrc.mts",
  "commitlint.config.ts",
  "commitlint.config.cts",
  "commitlint.config.mts",
];

/** The places whose only reader is an interpreter. */
const CODE_CONFIG = /\.(?:js|cjs|mjs|ts|cts|mts)$/;

/** The places that belong to the package manager, and are commitlint's only through a `commitlint` key. */
const PACKAGE_PLACES: ReadonlySet<string> = new Set(["package.json", "package.yaml"]);

/**
 * A `commitlint` KEY, as either file would spell it: `"commitlint":` in JSON,
 * `commitlint:` at the start of a YAML line. A textual pre-check, so a package
 * file with no such key is never parsed at all; a dependency name such as
 * `"@commitlint/cli":` does not match, because the key must begin the token.
 */
const COMMITLINT_KEY = /(?:^|[\s{,])["']?commitlint["']?\s*:/m;

/**
 * The header grammars commitlint's parser can use, by preset. Each list is
 * tried in order and the first match's third group is the subject, exactly
 * as conventional-commits-parser does (a preset's breakingHeaderPattern
 * before its headerPattern).
 *
 *   * conventionalcommits -- conventional-changelog-conventionalcommits'
 *     src/parser.js and src/constants.js, the parserPreset config-conventional
 *     names.
 *   * default -- conventional-changelog-angular's src/parser.js, which
 *     @commitlint/parse 21.2.3 falls back to when no parserPreset is named. It
 *     has no `!`.
 */
const HEADER_GRAMMARS = {
  conventionalcommits: [/^(\w*)(?:\((.*)\))?!: (.*)$/, /^(\w*)(?:\((.*)\))?!?: (.*)$/],
  default: [/^(\w*)(?:\((.*)\))?: (.*)$/],
} as const;

export type HeaderGrammar = keyof typeof HEADER_GRAMMARS;

/** The subject commitlint's parser finds in `header` under `grammar`, or null when the header does not parse. */
export function commitlintSubject(header: string, grammar: HeaderGrammar): string | null {
  for (const pattern of HEADER_GRAMMARS[grammar]) {
    const match = pattern.exec(header);
    if (match !== null) return match[3] ?? null;
  }
  return null;
}

/** A config nen cannot read the rule from: a .commitlintrc that will not parse, or one commitlint would reject. The verbs turn it into exit 1. */
export class CommitlintConfigError extends Error {
  readonly file: string;
  constructor(file: string, reason: string) {
    super(`${file} could not be read for its commitlint 'subject-case' rule: ${reason}`);
    this.name = "CommitlintConfigError";
    this.file = file;
  }
}

export type SubjectCaseRule =
  /** No config at any search place. */
  | { readonly kind: "absent" }
  /** A config that states no subject-case rule: commitlint checks nothing, and neither does nen. */
  | { readonly kind: "none"; readonly file: string }
  /**
   * A config nen cannot read the rule from. `reason` says why and what would
   * let nen read it; `cause` is the same fact in a clause, for the line that
   * says a declared rule was applied instead.
   */
  | { readonly kind: "unreadable"; readonly file: string; readonly reason: string; readonly cause: string }
  | (SubjectCaseSpec & {
      readonly kind: "rule";
      readonly file: string;
      /** Where the rule was stated: the file's own `rules`, or config-conventional through `extends`. */
      readonly origin: "rules" | "extends";
      /** The header grammar commitlint's parser uses under this config. */
      readonly grammar: HeaderGrammar;
    });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A search place's text, or null when there is no readable file there. The
 * four codes are the ones cosmiconfig itself steps past (no file, a
 * directory, a path through a file, no permission); anything else is a
 * failure to report, not an absence.
 */
function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR" || code === "EACCES") return null;
    /* c8 ignore next -- an I/O failure other than those four has no portable fixture */
    throw error;
  }
}

type Loaded = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string };

function parseJson(text: string): Loaded {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, reason: `it is not valid JSON (${(error as Error).message})` };
  }
}

function parseYamlConfig(text: string): Loaded {
  try {
    return { ok: true, value: parseYaml(text) };
  } catch (error) {
    /* c8 ignore next -- parseYaml throws nothing but YamlError */
    if (!(error instanceof YamlError)) throw error;
    return { ok: false, reason: `nen's YAML reader refused it (${error.message})` };
  }
}

/** One search place's value: JSON, YAML, or -- for the extensionless rc -- JSON first. The caller decides what a failure means. */
function loadData(place: string, text: string): Loaded {
  if (place.endsWith(".json")) return parseJson(text);
  if (place.endsWith(".yaml") || place.endsWith(".yml")) return parseYamlConfig(text);
  const json = parseJson(text);
  return json.ok ? json : parseYamlConfig(text);
}

/**
 * An explicit `rules['subject-case']`, through ./rule.ts's one validator --
 * the same one nen/workflow.json's `commits.subjectCase` goes through.
 *
 * A SHAPE FAULT IS ONE COMMITLINT REFUSES AT LOAD, so it is named as such. AN
 * UNKNOWN CASE NAME IS REFUSED FOR EVERY SUBJECT, where nen is deliberately
 * stricter than commitlint: commitlint throws only when it reaches the
 * transform, so a subject that does not open with a letter slips past a list
 * it cannot evaluate. A gate that crashes on nearly every message is broken
 * rather than configured, and saying so once, by name, beats passing the one
 * subject in twenty that happens to dodge it.
 */
function parseExplicitRule(file: string, value: unknown, grammar: HeaderGrammar): SubjectCaseRule {
  const parsed = parseSubjectCaseTuple(value);
  if (!parsed.ok) {
    throw new CommitlintConfigError(
      file,
      parsed.refusedAtLoad
        ? `rule 'subject-case' ${parsed.problem}, received ${JSON.stringify(value)} -- commitlint refuses the config too`
        : `rule 'subject-case' ${parsed.problem}`,
    );
  }
  return { kind: "rule", file, origin: "rules", ...parsed.spec, grammar };
}

/** The subject-case rule one loaded config states, following the `extends` merge as far as data allows. */
function resolveRule(file: string, config: unknown): SubjectCaseRule {
  if (!isRecord(config)) throw new CommitlintConfigError(file, `a commitlint config is an object, and this is ${JSON.stringify(config)}`);
  if (Object.hasOwn(config, "$import")) {
    return {
      kind: "unreadable",
      file,
      reason: `${file} pulls part of itself in through cosmiconfig's '$import', which nen does not follow -- declare the rule in nen/workflow.json's commits.subjectCase and nen checks it`,
      cause: `${file} uses cosmiconfig's '$import', which nen does not follow`,
    };
  }
  const extended = config["extends"];
  let presets: readonly string[] = [];
  if (typeof extended === "string") presets = [extended];
  else if (Array.isArray(extended) && extended.every((entry): boolean => typeof entry === "string")) presets = extended as string[];
  else if (extended !== undefined) throw new CommitlintConfigError(file, `'extends' must be a string or a list of strings, and it is ${JSON.stringify(extended)}`);
  // commitlint's default parser is used only when nothing names another: no
  // parserPreset here, and no preset extended that could supply one.
  const grammar: HeaderGrammar = config["parserPreset"] === undefined && presets.length === 0 ? "default" : "conventionalcommits";
  const rules = config["rules"];
  if (rules !== undefined) {
    if (!isRecord(rules)) throw new CommitlintConfigError(file, `'rules' must be an object, and it is ${JSON.stringify(rules)}`);
    if (Object.hasOwn(rules, "subject-case")) return parseExplicitRule(file, rules["subject-case"], grammar);
  }
  const lastConventional = presets.lastIndexOf(CONFIG_CONVENTIONAL);
  const unresolved = presets.slice(lastConventional + 1)[0];
  if (unresolved !== undefined) {
    return {
      kind: "unreadable",
      file,
      reason: `${file} extends '${unresolved}', a shareable config nen cannot resolve (it is a JavaScript package, and nen does not execute one), and it may set the rule. Stating 'subject-case' under the file's own 'rules' makes it decisive, and nen then checks it -- or declare the rule in nen/workflow.json's commits.subjectCase and nen checks it`,
      cause: `${file} extends '${unresolved}', which nen cannot resolve`,
    };
  }
  if (lastConventional === -1) return { kind: "none", file };
  return { kind: "rule", file, origin: "extends", ...CONVENTIONAL_SUBJECT_CASE, grammar: "conventionalcommits" };
}

/**
 * The subject-case rule the repository at `root` states in its commitlint
 * config, read from the first of COMMITLINT_SEARCH_PLACES that holds one --
 * the one commitlint would load from that directory. THROWS
 * CommitlintConfigError when that place is a .commitlintrc nen cannot parse,
 * or a config commitlint itself would reject.
 */
export function readSubjectCaseRule(root: string): SubjectCaseRule {
  for (const place of COMMITLINT_SEARCH_PLACES) {
    const file = join(root, place);
    const text = readIfPresent(file);
    if (text === null || text.trim() === "") continue;
    if (CODE_CONFIG.test(place)) {
      return {
        kind: "unreadable",
        file,
        reason: `${file} is a JavaScript/TypeScript commitlint config, and nen does not execute a repository's code to read one. Declare the rule as data in nen/workflow.json's commits.subjectCase ('config-conventional' or a commitlint rule tuple) and nen checks it`,
        cause: `${file} is a JavaScript/TypeScript commitlint config nen does not execute`,
      };
    }
    const isPackage = PACKAGE_PLACES.has(place);
    if (isPackage && !COMMITLINT_KEY.test(text)) continue;
    const loaded = loadData(place, text);
    if (!loaded.ok) {
      if (!isPackage) throw new CommitlintConfigError(file, loaded.reason);
      return {
        kind: "unreadable",
        file,
        reason: `${file} carries a 'commitlint' key, but nen could not parse the file (${loaded.reason}), so it could not read the rule there -- fix the file, or declare the rule in nen/workflow.json's commits.subjectCase and nen checks it`,
        cause: `${file} carries a 'commitlint' key but will not parse`,
      };
    }
    const config = isPackage ? (isRecord(loaded.value) ? loaded.value["commitlint"] : undefined) : loaded.value;
    if (config === undefined || config === null) continue;
    return resolveRule(file, config);
  }
  return { kind: "absent" };
}

/** A `commits.subjectCase` a repository declared, with the file it came from. */
export interface DeclaredRule {
  readonly file: string;
  readonly rule: DeclaredSubjectCase;
}

/** The declaration a loaded nen/workflow.json carries, or null when it states none (or there is no file). */
export function declaredSubjectCase(loaded: LoadedWorkflow): DeclaredRule | null {
  const rule = loaded.present ? loaded.workflow.commits.subjectCase : null;
  return rule === null ? null : { file: loaded.path, rule };
}

export interface SubjectCaseFindings {
  /** Lines that refuse the message: a level-2 rule the subject breaks. */
  readonly refusals: readonly string[];
  /** Lines to print and carry on: a level-1 rule the subject breaks, or a rule nen did not check. */
  readonly warnings: readonly string[];
  /** Lines that are neither: which rule a verdict came from, or which declaration was not applied. */
  readonly notes: readonly string[];
}

export const NO_FINDINGS: SubjectCaseFindings = { refusals: [], warnings: [], notes: [] };

/** The case names that begin with a capital: a `never` on any of them is fixed by a lower-case first word. */
const CAPITAL_LEADING: ReadonlySet<CaseName> = new Set(["sentence-case", "sentencecase", "start-case", "pascal-case", "upper-case", "uppercase"]);

/** What to do about a failed verdict, in words a builder can act on without reading commitlint's source. */
function fixFor(when: Condition, verdict: CaseVerdict): string {
  const list = verdict.reported.join(", ");
  const exempt = "a quoted or backticked span is not checked, so a proper name can stay as it is inside `backticks`";
  if (when === "never" && verdict.reported.some((name): boolean => CAPITAL_LEADING.has(name))) {
    return `start the subject with a lower-case word -- ${exempt}`;
  }
  if (when === "never") return `recase the subject so it is not ${list} -- ${exempt}`;
  return `recase the subject to ${verdict.reported.length === 1 ? list : `one of ${list}`} -- ${exempt}`;
}

/** A rule as the tuple a config would state it: `[0]` when it is off, `[level, when, cases]` otherwise. */
function renderSpec(spec: SubjectCaseSpec): string {
  if (spec.level === 0) return "[0]";
  const cases = spec.checks.map((check: CaseCheck): unknown => (check.when === "never" ? { case: check.case, when: "never" } : check.case));
  return JSON.stringify([spec.level, spec.when, cases]);
}

/** A declared rule as the tuple a reader would write, for the line that names it. */
function describeDeclared(rule: DeclaredSubjectCase): string {
  if (rule.form === "config-conventional") return `'config-conventional' (${CONFIG_CONVENTIONAL}'s default)`;
  return `the rule ${renderSpec(rule)}`;
}

/**
 * Whether two rules give every subject the same verdict at the same level:
 * both off (no rule, or level 0), or the same level, condition and case list
 * in the same order. Compared as stated, so an alias (`uppercase` for
 * `upper-case`) or a reordered list reads as a difference -- the note then
 * shows both tuples, which is a reader's cue rather than a wrong claim.
 */
function sameRule(effective: SubjectCaseSpec | null, declared: SubjectCaseSpec): boolean {
  const effectiveOff = effective === null || effective.level === 0;
  const declaredOff = declared.level === 0;
  if (effectiveOff || declaredOff) return effectiveOff && declaredOff;
  return (
    effective.level === declared.level &&
    effective.when === declared.when &&
    effective.checks.length === declared.checks.length &&
    effective.checks.every((check, index): boolean => check.case === declared.checks[index]?.case && check.when === declared.checks[index]?.when)
  );
}

/**
 * PRECEDENCE 1's note: the declaration is not applied, and whether that
 * matters. A declaration that AGREES with the readable config is merely
 * redundant; one that DIFFERS is a second answer the repository wrote down,
 * and saying only "redundant" would hide exactly the disagreement a reader
 * needs to see -- so both tuples are named, and which one nen followed.
 */
function shadowNote(declared: DeclaredRule, rule: Extract<SubjectCaseRule, { kind: "none" | "rule" }>): string {
  const effective = rule.kind === "none" ? null : rule;
  if (sameRule(effective, declared.rule)) {
    return `commits.subjectCase in ${declared.file} is not applied: ${rule.file} states the commitlint config as data, and that config is the gate commitlint runs, so nen reads the rule there. The declaration agrees with it: redundant here -- remove it, or keep it in step`;
  }
  const stated =
    effective === null
      ? "no subject-case rule"
      : `${renderSpec(effective)}${effective.origin === "extends" ? ` (${CONFIG_CONVENTIONAL}'s default, through extends)` : ""}`;
  const declaredText = declared.rule.form === "config-conventional" ? `'config-conventional' = ${renderSpec(declared.rule)}` : renderSpec(declared.rule);
  return `commits.subjectCase in ${declared.file} is not applied, and it DIFFERS: ${rule.file} states ${stated}, the declaration states ${declaredText}; nen follows ${rule.file}, which is what commitlint runs -- align the declaration with it, or remove it`;
}

/**
 * PRECEDENCE 2: the declared rule, applied because the commitlint config
 * could not be read (`because` says why) or there is none. Binding exactly as
 * a commitlint rule is -- level 2 refuses, level 1 warns -- and every outcome
 * names nen/workflow.json as the rule's source, so no verdict here can be
 * mistaken for one read from commitlint's own config.
 */
function judgeDeclared(declared: DeclaredRule, header: string, because: string, commitlintRuns: boolean): SubjectCaseFindings {
  const { rule, file } = declared;
  const source = `commits.subjectCase in ${file}, ${describeDeclared(rule)}`;
  const why = `nen applies it because ${because}`;
  if (rule.level === 0) return { ...NO_FINDINGS, notes: [`subject-case is off: ${source} disables it, and ${why}`] };
  // The grammar config-conventional names and nen renders; a header nen
  // rendered always parses under it.
  const subject = commitlintSubject(header, "conventionalcommits");
  const verdict = subject === null ? null : subjectCaseVerdict(subject, rule.when, rule.checks);
  if (verdict === null || verdict.valid) {
    const tail = commitlintRuns ? " -- keep the two in step, since commitlint still runs its own rule at commit time" : "";
    return { ...NO_FINDINGS, notes: [`subject-case checked against ${source}: ${why}${tail}`] };
  }
  const head = `subject '${subject ?? ""}' breaks the subject-case rule this repository declares (${source}; ${why}): ${verdict.message ?? ""}.`;
  const fix = fixFor(rule.when, verdict);
  if (rule.level === 2) {
    return { ...NO_FINDINGS, refusals: [`${head} The declaration makes the rule binding, so nen refuses it: ${fix}.`] };
  }
  return { ...NO_FINDINGS, warnings: [`${head} The rule is declared at level 1, so nen only warns. To clear it: ${fix}.`] };
}

/**
 * THE ONE CHECK `commit format` AND `commit write` RUN, so the two cannot
 * drift into two answers for the same message: read the commitlint config at
 * `root`, apply the precedence in this module's header against `declared`
 * (nen/workflow.json's `commits.subjectCase`, or null), find the subject
 * commitlint's parser would find in `header` -- the message's first line,
 * exactly as it will be committed -- and judge it.
 *
 * THROWS CommitlintConfigError, as readSubjectCaseRule does -- whatever is
 * declared, because a malformed .commitlintrc is a broken gate, not a missing
 * one.
 */
export function subjectCaseFindings(root: string, header: string, declared: DeclaredRule | null): SubjectCaseFindings {
  const rule = readSubjectCaseRule(root);
  if (rule.kind === "absent") {
    if (declared !== null) return judgeDeclared(declared, header, `no commitlint config was found at ${root}`, false);
    // Not a checkout root, probably -- a subdirectory, with no --repo -- and
    // commitlint, unlike nen, would go on looking in the parents.
    if (existsSync(join(root, ".git"))) return NO_FINDINGS;
    return {
      ...NO_FINDINGS,
      warnings: [`subject-case NOT checked: no commitlint config at ${root}, and commitlint also looks in parent directories -- pass --repo <checkout root>`],
    };
  }
  if (rule.kind === "unreadable") {
    if (declared !== null) return judgeDeclared(declared, header, rule.cause, true);
    // FOR REFERENCE, NEVER AS A VERDICT: the preset most configs extend. The
    // warning already says the repository's own rule was not read; this only
    // saves a builder from meeting the commonest refusal after the fact.
    const subject = commitlintSubject(header, "conventionalcommits");
    const conventional = subject === null ? null : subjectCaseVerdict(subject, CONVENTIONAL_SUBJECT_CASE.when, CONVENTIONAL_SUBJECT_CASE.checks);
    const reference =
      conventional === null || conventional.valid
        ? ""
        : ` For reference only: under ${CONFIG_CONVENTIONAL}'s default -- the preset most commitlint configs extend -- this subject would be refused (${conventional.message ?? ""}).`;
    return {
      ...NO_FINDINGS,
      warnings: [`subject-case NOT checked: ${rule.reason}. commitlint still applies whatever rule the file states when the commit is made, after the commit exists.${reference}`],
    };
  }
  // PRECEDENCE 1: a readable commitlint config is the real gate. A declaration
  // beside it is said to be unapplied -- and whether it agrees -- never
  // silently dropped.
  const shadowed: readonly string[] = declared === null ? [] : [shadowNote(declared, rule)];
  if (rule.kind === "none" || rule.level === 0) return { ...NO_FINDINGS, notes: shadowed };
  const subject = commitlintSubject(header, rule.grammar);
  if (subject === null) {
    return {
      refusals: [],
      warnings: [
        `subject-case NOT checked: ${rule.file} names no parserPreset and extends no preset, so commitlint splits the header with its default parser (conventional-changelog-angular's), which does not parse '${header}' -- it has no '!' form -- finds no subject, and gives no subject-case verdict; nen gives none either`,
      ],
      notes: shadowed,
    };
  }
  const verdict = subjectCaseVerdict(subject, rule.when, rule.checks);
  if (verdict.valid) return { ...NO_FINDINGS, notes: shadowed };
  const where = rule.origin === "rules" ? `set under 'rules' in ${rule.file}` : `${CONFIG_CONVENTIONAL}'s default, which ${rule.file} extends`;
  const head = `subject '${subject}' breaks this repository's commitlint rule 'subject-case' (${where}): ${verdict.message ?? ""}.`;
  const fix = fixFor(rule.when, verdict);
  if (rule.level === 2) {
    return { refusals: [`${head} commitlint refuses this message at commit time, so nen refuses it now: ${fix}.`], warnings: [], notes: shadowed };
  }
  return {
    refusals: [],
    warnings: [`${head} The rule is at level 1, so commitlint only warns and still commits -- unless the hook runs it with --strict, which refuses on a warning. To clear it: ${fix}.`],
    notes: shadowed,
  };
}
