// src/commit/commitlint.ts -- the repository's OWN commitlint `subject-case`
// rule, read from where commitlint reads it, and the one check `commit
// format` and `commit write` both run with it (part of zheref/nen#263).
//
// WHY THIS EXISTS. A builder runs `nen commit format` so they do not have to
// guess whether the repository's commit-msg hook will accept a message. When
// the hook runs commitlint and commitlint enforces a rule nen does not, the
// builder gets a green from nen, commits, and meets the real gate afterwards
// -- in the sitting this issue came from, 'Start…' and 'Escape…' subjects,
// twice, each an amend and a recommit. So nen now reads the rule the
// repository itself states, WHEN IT STATES IT AS DATA, and gives commitlint's
// verdict first.
//
// THE LIMIT THIS LEAVES, STATED RATHER THAN SOFTENED. A repository whose
// commitlint config is CODE (commitlint.config.cjs and the other .js/.ts
// forms -- the repository this issue came from is one) still meets a
// subject-case refusal from commitlint AFTER the commit exists: nen does not
// execute the file, so it only warns that the rule was NOT checked and gives
// @commitlint/config-conventional's verdict for reference, at exit 0. A
// caller that gates on the exit code alone is not protected there. Closing
// that needs the rule declared somewhere nen can read as data, which is a new
// policy surface and the maintainer's decision, not this module's.
//
// SCOPE: `subject-case`, AND NOTHING ELSE commitlint checks. This is not a
// commitlint reimplementation; nen's own shape rules (./format.ts) are
// unchanged and are not reconciled with the repository's other commitlint
// rules. ./case.ts holds the rule's semantics; this module finds the rule and
// the subject commitlint would hand it.
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
// matter is said out loud: when nothing is found and the directory has no
// `.git` entry, so it is probably not a checkout root, the verb warns that
// the rule was not checked and names `--repo`. Cosmiconfig's own rules are
// kept: package.json and package.yaml count only when they carry a
// `commitlint` key, and a file that is blank or holds `null` is skipped and
// the search goes on to the next place, exactly as cosmiconfig skips it.
//
// DATA IS READ; CODE IS NOT. JSON (package.json, .commitlintrc.json), YAML
// (.commitlintrc.yaml/.yml, package.yaml -- through ../schema/yaml.ts, the one
// YAML reader in this binary) and the extensionless .commitlintrc (JSON
// first, then YAML: cosmiconfig loads it as YAML, of which JSON is a subset)
// are parsed. A .js/.cjs/.mjs/.ts/.cts/.mts config is NOT, because the only
// way to read one is to execute the repository's code, and a message
// formatter has no business doing that. It is not a silent pass either: the
// verb prints a warning naming the file and saying the rule was not checked.
// The YAML reader is the strict one the taxonomy files use, so a YAML config
// built with anchors, aliases, tags or merge keys -- which commitlint's own
// YAML loader accepts -- is refused by name rather than half-read.
//
// A PACKAGE FILE IS NOT COMMITLINT'S UNTIL IT SAYS SO. package.json and
// package.yaml belong to the repository's package manager; most of them carry
// no `commitlint` key at all, and an idiomatic package.yaml uses the very
// anchors the strict reader refuses. So a package file whose TEXT has no
// `commitlint` key is stepped past unparsed, and one that has the key but
// will not parse is a "not checked" warning, never exit 1 -- a repository
// without commitlint must never have its commit verbs stopped by its package
// manifest. The .commitlintrc forms are commitlint's by name, so a malformed
// one stays exit 1, and so does a package key that parses into a config
// commitlint itself would reject.
//
// `extends`, AS FAR AS DATA CAN SEE. commitlint merges a config's `extends`
// in order, each over the last, and the file's own `rules` over all of them
// (@commitlint/resolve-extends). An explicit `rules['subject-case']` is
// therefore decisive whatever is extended. Without one, the rule comes from
// the last preset that sets it -- and a preset is a JavaScript package, so the
// one nen can answer for is the one whose rule is published and fixed:
// `@commitlint/config-conventional`, whose default this module carries. Any
// other preset AFTER the last config-conventional may set the rule too, so
// that is a stated "not checked", never a guess. A preset BEFORE it is
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
// accepts.
//
// THE OUTCOMES, AND WHO SEES EACH:
//
//   * no config, or one that states no subject-case -> nothing at all; the
//     verb behaves exactly as it did before this module existed (plus the
//     not-a-checkout-root warning above, when it applies).
//   * a rule at level 2 that the subject breaks -> a refusal, at the verb's
//     existing shape-refusal exit (2): commitlint would refuse the commit.
//   * a rule at level 1 -> a `warning:` line and exit 0: commitlint warns and
//     still commits (unless the hook runs it with --strict).
//   * a config nen cannot read the rule from (code, an unknown preset,
//     cosmiconfig's `$import`, a package file with a `commitlint` key that
//     will not parse), or a header commitlint's default parser cannot split
//     -> a `warning:` line saying NOT CHECKED, and exit 0.
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
import { isCaseName, subjectCaseVerdict, type CaseCheck, type CaseName, type CaseVerdict, type Condition } from "./case.js";

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

export const CONFIG_CONVENTIONAL = "@commitlint/config-conventional";

/**
 * @commitlint/config-conventional's `subject-case`, as published in its
 * src/index.ts (21.2.3, and unchanged for many majors before it):
 * `[2, "never", ["sentence-case", "start-case", "pascal-case", "upper-case"]]`.
 */
export const CONVENTIONAL_SUBJECT_CASE: { readonly level: 0 | 1 | 2; readonly when: Condition; readonly checks: readonly CaseCheck[] } = {
  level: 2,
  when: "never",
  checks: (["sentence-case", "start-case", "pascal-case", "upper-case"] as const).map((name): CaseCheck => ({ when: "always", case: name })),
};

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
  /** A config nen cannot read the rule from; `reason` says why, and what would let nen read it. */
  | { readonly kind: "unreadable"; readonly file: string; readonly reason: string }
  | {
      readonly kind: "rule";
      readonly file: string;
      /** Where the rule was stated: the file's own `rules`, or config-conventional through `extends`. */
      readonly origin: "rules" | "extends";
      /** 0 disables it, 1 is a warning, 2 an error -- the only three commitlint's schema admits. */
      readonly level: 0 | 1 | 2;
      readonly when: Condition;
      readonly checks: readonly CaseCheck[];
      /** The header grammar commitlint's parser uses under this config. */
      readonly grammar: HeaderGrammar;
    };

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
 * A rule's case list, normalized as @commitlint/rules normalizes it: absent
 * is `[]`, a single value is a list of one, a bare name is `always`, and an
 * object entry's `when` negates only when it is exactly "never".
 *
 * AN UNKNOWN CASE NAME IS REFUSED FOR EVERY SUBJECT, where nen is
 * deliberately stricter than commitlint: commitlint throws only when
 * it reaches the transform, so a subject that does not open with a letter
 * slips past a list it cannot evaluate. A gate that crashes on nearly every
 * message is broken rather than configured, and saying so once, by name,
 * beats passing the one subject in twenty that happens to dodge it.
 */
function parseChecks(file: string, value: unknown): CaseCheck[] {
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry): CaseCheck => {
    const name: unknown = isRecord(entry) ? entry["case"] : entry;
    if (!isCaseName(name)) {
      throw new CommitlintConfigError(
        file,
        `rule 'subject-case' lists ${JSON.stringify(entry)}, which is not a case commitlint knows -- it would throw "Unknown target case" on every subject. Use one of the names @commitlint/ensure accepts (lower-case, upper-case, camel-case, kebab-case, pascal-case, sentence-case, snake-case, start-case)`,
      );
    }
    return { when: isRecord(entry) && entry["when"] === "never" ? "never" : "always", case: name };
  });
}

/**
 * An explicit `rules['subject-case']`, held to the checks commitlint makes
 * before it runs any rule -- @commitlint/config-validator's schema (a level
 * of exactly 0, 1 or 2; 'always' or 'never') and @commitlint/lint's own (2 or
 * 3 items) -- whose failure makes commitlint throw rather than lint, so a
 * config that fails one is a gate that refuses every commit. Level 0 alone
 * (`[0]`) is the one short form both allow.
 */
function parseExplicitRule(file: string, value: unknown, grammar: HeaderGrammar): SubjectCaseRule {
  const refuse = (problem: string): never => {
    throw new CommitlintConfigError(file, `rule 'subject-case' ${problem}, received ${JSON.stringify(value)} -- commitlint refuses the config too`);
  };
  if (!Array.isArray(value)) return refuse("must be an array ([level, 'always'|'never', cases])");
  const [level, when] = value as unknown[];
  if (level === 0 && value.length === 1) return { kind: "rule", file, origin: "rules", level: 0, when: "always", checks: [], grammar };
  if (level !== 0 && level !== 1 && level !== 2) return refuse("must start with a level of 0, 1 or 2");
  if (value.length < 2 || value.length > 3) return refuse("must be 2 or 3 items long");
  if (when !== "always" && when !== "never") return refuse("must have 'always' or 'never' as its condition");
  // A disabled rule is never run, so its case list is never read -- commitlint
  // does not reject a bad one either.
  const checks = level === 0 ? [] : parseChecks(file, value[2]);
  return { kind: "rule", file, origin: "rules", level, when, checks, grammar };
}

/** The subject-case rule one loaded config states, following the `extends` merge as far as data allows. */
function resolveRule(file: string, config: unknown): SubjectCaseRule {
  if (!isRecord(config)) throw new CommitlintConfigError(file, `a commitlint config is an object, and this is ${JSON.stringify(config)}`);
  if (Object.hasOwn(config, "$import")) {
    return {
      kind: "unreadable",
      file,
      reason: `${file} pulls part of itself in through cosmiconfig's '$import', which nen does not follow`,
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
      reason: `${file} extends '${unresolved}', a shareable config nen cannot resolve (it is a JavaScript package, and nen does not execute one), and it may set the rule. Stating 'subject-case' under the file's own 'rules' makes it decisive, and nen then checks it`,
    };
  }
  if (lastConventional === -1) return { kind: "none", file };
  return { kind: "rule", file, origin: "extends", ...CONVENTIONAL_SUBJECT_CASE, grammar: "conventionalcommits" };
}

/**
 * The subject-case rule the repository at `root` states, read from the first
 * of COMMITLINT_SEARCH_PLACES that holds a config -- the one commitlint would
 * load from that directory. THROWS CommitlintConfigError when that place is a
 * .commitlintrc nen cannot parse, or a config commitlint itself would reject.
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
        reason: `${file} is a JavaScript/TypeScript commitlint config, and nen does not execute a repository's code to read one. A data config (.commitlintrc.json, .commitlintrc.yaml, or package.json's 'commitlint' key) is one nen can check`,
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
        reason: `${file} carries a 'commitlint' key, but nen could not parse the file (${loaded.reason}), so it could not read the rule there`,
      };
    }
    const config = isPackage ? (isRecord(loaded.value) ? loaded.value["commitlint"] : undefined) : loaded.value;
    if (config === undefined || config === null) continue;
    return resolveRule(file, config);
  }
  return { kind: "absent" };
}

export interface SubjectCaseFindings {
  /** Lines that refuse the message: a level-2 rule the subject breaks. */
  readonly refusals: readonly string[];
  /** Lines to print and carry on: a level-1 rule the subject breaks, or a rule nen did not check. */
  readonly warnings: readonly string[];
}

export const NO_FINDINGS: SubjectCaseFindings = { refusals: [], warnings: [] };

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

/**
 * THE ONE CHECK `commit format` AND `commit write` RUN, so the two cannot
 * drift into two answers for the same message: read the rule at `root`, find
 * the subject commitlint's parser would find in `header` -- the message's
 * first line, exactly as it will be committed -- and judge it.
 *
 * THROWS CommitlintConfigError, as readSubjectCaseRule does.
 */
export function subjectCaseFindings(root: string, header: string): SubjectCaseFindings {
  const rule = readSubjectCaseRule(root);
  if (rule.kind === "absent") {
    // Not a checkout root, probably -- a subdirectory, with no --repo -- and
    // commitlint, unlike nen, would go on looking in the parents.
    if (existsSync(join(root, ".git"))) return NO_FINDINGS;
    return {
      refusals: [],
      warnings: [`subject-case NOT checked: no commitlint config at ${root}, and commitlint also looks in parent directories -- pass --repo <checkout root>`],
    };
  }
  if (rule.kind === "none") return NO_FINDINGS;
  if (rule.kind === "unreadable") {
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
      refusals: [],
      warnings: [`subject-case NOT checked: ${rule.reason}. commitlint still applies whatever rule the file states when the commit is made, after the commit exists.${reference}`],
    };
  }
  if (rule.level === 0) return NO_FINDINGS;
  const subject = commitlintSubject(header, rule.grammar);
  if (subject === null) {
    return {
      refusals: [],
      warnings: [
        `subject-case NOT checked: ${rule.file} names no parserPreset and extends no preset, so commitlint splits the header with its default parser (conventional-changelog-angular's), which does not parse '${header}' -- it has no '!' form -- finds no subject, and gives no subject-case verdict; nen gives none either`,
      ],
    };
  }
  const verdict = subjectCaseVerdict(subject, rule.when, rule.checks);
  if (verdict.valid) return NO_FINDINGS;
  const where = rule.origin === "rules" ? `set under 'rules' in ${rule.file}` : `${CONFIG_CONVENTIONAL}'s default, which ${rule.file} extends`;
  const head = `subject '${subject}' breaks this repository's commitlint rule 'subject-case' (${where}): ${verdict.message ?? ""}.`;
  const fix = fixFor(rule.when, verdict);
  if (rule.level === 2) {
    return { refusals: [`${head} commitlint refuses this message at commit time, so nen refuses it now: ${fix}.`], warnings: [] };
  }
  return {
    refusals: [],
    warnings: [`${head} The rule is at level 1, so commitlint only warns and still commits -- unless the hook runs it with --strict, which refuses on a warning. To clear it: ${fix}.`],
  };
}
