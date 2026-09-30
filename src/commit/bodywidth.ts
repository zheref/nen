// src/commit/bodywidth.ts -- the repository's OWN commitlint
// `body-max-line-length` and `footer-max-line-length`, read from where
// commitlint reads them -- or the body width the repository DECLARES in
// nen/workflow.json's `commits.bodyMaxLineLength` -- and the one check
// `commit format` and `commit write` both run with them (zheref/nen#290).
// ./linelength.ts holds what the rules mean; this module finds them and says
// what a verdict means to the caller.
//
// WHERE THEY ARE READ: the same file ./commitlint.ts reads `subject-case`
// from (locateCommitlintConfig), with the same `extends` rule (ruleInConfig):
// an explicit `rules[...]` entry is decisive; without one, extending
// @commitlint/config-conventional -- with no preset nen cannot resolve after
// it -- means that preset's published `[2, "always", 100]`; neither means
// commitlint checks nothing. A tuple of the wrong shape is exit 1, as a
// malformed subject-case tuple is; its WIDTH never is, because commitlint
// never refuses one (./linelength.ts's parseLineLengthTuple).
//
// THE BODY WIDTH, AND THE PRECEDENCE -- the maintainer's ruling on #290,
// "Refuse at 100, declarable", on `commits.subjectCase`'s pattern exactly:
//
//   1. A COMMITLINT CONFIG NEN CAN READ AS DATA DECIDES. It is the gate
//      commitlint runs. A `commits.bodyMaxLineLength` beside it is reported
//      in a `note:` as not applied -- agreeing (redundant) or DIFFERING (both
//      named) -- never silently dropped, and never allowed to overrule it.
//   2. OTHERWISE THE DECLARATION BINDS: where the config is code (zheref/
//      kro-pwa's commitlint.config.cjs), cosmiconfig's `$import`, a preset
//      nen cannot resolve, a package key that will not parse -- and where
//      there is no config at all. A body line over it is refused at exit 2,
//      and every outcome names nen/workflow.json as the width's source.
//   3. WITH NEITHER, an unreadable config means config-conventional's 100,
//      ASSUMED -- the width nearly every such config inherits, kro-pwa's
//      included -- and BINDING: a body line over it is refused at exit 2,
//      with a `note:` saying the width was not read and naming the key that
//      declares another. A config that states a wider width in code is then
//      stricter here than at the hook until the repository declares it.
//      With no config and no declaration there is no gate: `commit format`
//      still wraps at 100, and nothing is judged.
//
// WHAT "THE BODY" IS, where nen's width binds (the declared key, or the
// assumed 100): EVERY LINE OF THE MESSAGE'S OWN PROSE -- every line after the
// header that is not in the TRAILER BLOCK -- wherever commitlint places it. A
// `Note: ...` or `Closes #1 ...` line opens commitlint's footer, and the
// rest of --body then parses as footer; holding only commitlint's body to
// the ruled width let that prose escape the ruling (#290's review, F1). The
// trailer block is the final paragraph when every line of it is a `Key:
// value` trailer, exactly as ../wc/messagefile.ts -- nen's one reader of a
// finished message -- and git's interpret-trailers decide it: for `commit
// format` that is the --trailer lines, and for `commit write` the file's own
// trailer block, so the two verbs split one message the same way. A readable
// footer rule beside an unreadable body one (a config that states
// `footer-max-line-length` and extends a preset nen cannot resolve) still
// decides the footer's prose: it is the gate commitlint runs there.
//
// THE TRAILER BLOCK IS NOT BOUND. `footer-max-line-length` has no declared
// form: where the config cannot be read, a trailer line over 100 is judged
// for reference only -- a `warning:`, never a refusal -- because the ruling
// named body lines, and widening it to trailers is not this change's call.
//
// THE OUTCOMES, per rule and per line the rule refuses:
//
//   * a readable rule at level 2, or -- on every line of the message's own
//     prose -- the declared width or the assumed 100 for an unreadable body
//     -> a refusal, at the verb's shape-refusal exit (2), naming the line,
//     its length, the width and where it came from;
//   * a readable rule at level 1 -> a `warning:`, exit 0;
//   * a readable rule whose width is below 1 or not a number -> one finding
//     per section, at its level, saying what commitlint does with that width;
//   * a trailer-block line under an unreadable footer rule (or any footer
//     line, beside a readable body rule) -> a `warning:` against 100, for
//     reference only;
//   * no config and nothing declared, a config that states no such rule, or
//     one that turns it off (level 0) -> nothing: commitlint checks nothing,
//     and neither does nen. `commit format` wraps --body at 100 there -- but
//     not under a rule the repository turned off -- and says so in a
//     `warning:` for a line it could not wrap (leftOverWarnings).
//
// AND WHATEVER THE RULE, a `note:` for every --body line `commit format`
// REWRAPPED (wrapFormatBody): its output then differs from what the caller
// typed, and that is said rather than left to be noticed -- on a run another
// problem refuses too, so one pass names both (the issue's third criterion:
// an over-long header and an over-long body line, both named).

import type { LoadedWorkflow } from "../schema/workflow.js";
import { parseCommitMessageFile } from "../wc/messagefile.js";
import { CONFIG_CONVENTIONAL } from "./rule.js";
import { CommitlintConfigError, locateCommitlintConfig, NO_FINDINGS, ruleInConfig, type SubjectCaseFindings } from "./commitlint.js";
import {
  commitlintSections,
  CONVENTIONAL_MAX_LINE_LENGTH,
  lineFits,
  parseLineLengthTuple,
  unwrappable,
  usableWidth,
  wrapBody,
  type LeftOver,
  type LineRuleName,
  type MessageLine,
  type Rewrapped,
  type Section,
} from "./linelength.js";

/** The rule that judges each section. */
export const SECTION_RULE: Readonly<Record<Section, LineRuleName>> = {
  body: "body-max-line-length",
  footer: "footer-max-line-length",
};

/** A `commits.bodyMaxLineLength` a repository declared, with the file it came from. */
export interface DeclaredWidth {
  readonly file: string;
  readonly width: number;
}

/** The declaration a loaded nen/workflow.json carries, or null when it states none (or there is no file). */
export function declaredBodyWidth(loaded: LoadedWorkflow): DeclaredWidth | null {
  const width = loaded.present ? loaded.workflow.commits.bodyMaxLineLength : null;
  return width === null ? null : { file: loaded.path, width };
}

export type LineLengthRule =
  /** No config at any search place, and nothing declared. */
  | { readonly kind: "absent" }
  /** A readable config that states no such rule and extends no config-conventional. */
  | { readonly kind: "none"; readonly file: string }
  /** A readable config that states the rule at level 0: the repository turned the limit off, so nothing is judged or wrapped. */
  | { readonly kind: "off"; readonly file: string }
  /** A config nen cannot read the rule from, and nothing declared; `cause` says why, as a clause. */
  | { readonly kind: "unreadable"; readonly file: string; readonly cause: string }
  | {
      readonly kind: "rule";
      readonly file: string;
      /** Where it was stated: the file's own `rules`, or config-conventional through `extends`. */
      readonly origin: "rules" | "extends";
      readonly level: 1 | 2;
      /** The number commitlint compares each line's length against -- ./linelength.ts's parseLineLengthTuple says how it is found. */
      readonly max: number;
      /** The width as the config states it. */
      readonly stated: unknown;
    }
  /** The body width nen/workflow.json declares, BINDING because `because` (precedence 2). Body only. */
  | {
      readonly kind: "declared";
      readonly file: string;
      readonly max: number;
      readonly because: string;
      /** Whether a commitlint config exists that still runs its own rule at commit time. */
      readonly commitlintRuns: boolean;
    };

type ReadRule = Extract<LineLengthRule, { kind: "rule" }>;

export interface LineLengthRules {
  readonly body: LineLengthRule;
  readonly footer: LineLengthRule;
  /** PRECEDENCE 1's note: the declaration beside a readable config, not applied -- and whether it agrees. */
  readonly shadowed: string | null;
}

/** One rule, from one loaded data config. THROWS CommitlintConfigError, naming the rule, for a tuple commitlint itself rejects. */
function resolveLineRule(file: string, config: unknown, name: LineRuleName): Exclude<LineLengthRule, { kind: "declared" }> {
  const { resolved } = ruleInConfig(file, config, name);
  switch (resolved.kind) {
    case "import":
      return { kind: "unreadable", file, cause: `${file} uses cosmiconfig's '$import', which nen does not follow` };
    case "unresolved":
      return {
        kind: "unreadable",
        file,
        cause: `${file} extends '${resolved.preset}', a shareable config nen cannot resolve (it is a JavaScript package, and nen does not execute one), and it may set the rule -- stating '${name}' under the file's own 'rules' makes it decisive`,
      };
    case "none":
      return { kind: "none", file };
    case "conventional":
      // config-conventional 21.2.3 publishes [2, "always", 100] for both rules.
      return { kind: "rule", file, origin: "extends", level: 2, max: CONVENTIONAL_MAX_LINE_LENGTH, stated: CONVENTIONAL_MAX_LINE_LENGTH };
    case "explicit": {
      const parsed = parseLineLengthTuple(resolved.value);
      if (!parsed.ok) {
        throw new CommitlintConfigError(file, `rule '${name}' ${parsed.problem}, received ${JSON.stringify(resolved.value)} -- commitlint refuses the config too`, name);
      }
      if (parsed.spec.level === 0) return { kind: "off", file };
      return { kind: "rule", file, origin: "rules", level: parsed.spec.level, max: parsed.spec.max, stated: parsed.spec.stated };
    }
  }
}

/** The rule a readable config states for the body, as the tuple it would be written as -- or what it states instead. */
function describeConfigRule(rule: Extract<LineLengthRule, { kind: "none" | "off" | "rule" }>): string {
  if (rule.kind === "none") return "no body-max-line-length rule";
  if (rule.kind === "off") return "body-max-line-length turned off ([0])";
  const tuple = `[${rule.level}, "always", ${rule.stated === undefined ? "(no width)" : JSON.stringify(rule.stated)}]`;
  return rule.origin === "extends" ? `${tuple} (${CONFIG_CONVENTIONAL}'s default, through extends)` : tuple;
}

/**
 * PRECEDENCE 1's note. A declaration that AGREES with the readable config --
 * a level-2 rule of the same width, which is what the key binds as -- is
 * merely redundant; one that DIFFERS is a second answer the repository wrote
 * down, and both are named, with the one nen followed.
 */
function shadowNote(declared: DeclaredWidth, rule: Extract<LineLengthRule, { kind: "none" | "off" | "rule" }>): string {
  const agrees = rule.kind === "rule" && rule.level === 2 && rule.max === declared.width;
  if (agrees) {
    return `commits.bodyMaxLineLength in ${declared.file} is not applied: ${rule.file} states the commitlint config as data, and that config is the gate commitlint runs, so nen reads the width there. The declaration agrees with it: redundant here -- remove it, or keep it in step`;
  }
  return `commits.bodyMaxLineLength in ${declared.file} is not applied, and it DIFFERS: ${rule.file} states ${describeConfigRule(rule)}, the declaration states ${declared.width}; nen follows ${rule.file}, which is what commitlint runs -- align the declaration with it, or remove it`;
}

/**
 * The line-length rules for the repository at `root`: its commitlint config's
 * -- the file ./commitlint.ts finds -- under the precedence this module's
 * header states against `declared` (nen/workflow.json's
 * `commits.bodyMaxLineLength`, or null). THROWS CommitlintConfigError when
 * that place is a .commitlintrc nen cannot parse, or a config commitlint
 * itself would reject -- a line-length tuple of the wrong shape included.
 */
export function readLineLengthRules(root: string, declared: DeclaredWidth | null): LineLengthRules {
  const located = locateCommitlintConfig(root, SECTION_RULE.body);
  let body: Exclude<LineLengthRule, { kind: "declared" }>;
  let footer: LineLengthRule;
  switch (located.kind) {
    case "absent":
      body = { kind: "absent" };
      footer = { kind: "absent" };
      break;
    case "code":
      body = { kind: "unreadable", file: located.file, cause: `${located.file} is a JavaScript/TypeScript commitlint config nen does not execute` };
      footer = body;
      break;
    case "unparsed-package":
      body = { kind: "unreadable", file: located.file, cause: `${located.file} carries a 'commitlint' key but will not parse (${located.reason})` };
      footer = body;
      break;
    case "data":
      body = resolveLineRule(located.file, located.config, SECTION_RULE.body);
      footer = resolveLineRule(located.file, located.config, SECTION_RULE.footer);
      break;
  }
  if (declared === null) return { body, footer, shadowed: null };
  if (body.kind === "absent") {
    return { body: { kind: "declared", file: declared.file, max: declared.width, because: `no commitlint config was found at ${root}`, commitlintRuns: false }, footer, shadowed: null };
  }
  if (body.kind === "unreadable") {
    return { body: { kind: "declared", file: declared.file, max: declared.width, because: body.cause, commitlintRuns: true }, footer, shadowed: null };
  }
  return { body, footer, shadowed: shadowNote(declared, body) };
}

/**
 * The width `commit format` wraps each section to, or null for a section it
 * leaves alone: a readable rule's width when a line can be wrapped to it,
 * and the declared width; null when the rule is off (the repository turned
 * the limit off) or states a width below 1 (no wrap can meet it --
 * lineLengthFindings says what commitlint does with it); config-
 * conventional's 100 everywhere else.
 */
export function wrapWidths(rules: LineLengthRules): Readonly<Record<Section, number | null>> {
  const width = (rule: LineLengthRule): number | null => {
    if (rule.kind === "rule") return usableWidth(rule.max) ? rule.max : null;
    if (rule.kind === "declared") return rule.max;
    return rule.kind === "off" ? null : CONVENTIONAL_MAX_LINE_LENGTH;
  };
  // --body is all prose: where nen's width binds, the part commitlint reads
  // as footer is held -- and so wrapped -- to the body's width.
  return { body: width(rules.body), footer: width(ruleFor(rules, "footer")) };
}

/** The rule a --body line in commitlint's `section` is held to: the footer's, unless nen's width binds the prose. */
function ruleFor(rules: LineLengthRules, section: Section): LineLengthRule {
  return section === "footer" && bindsProse(rules) ? rules.body : rules[section];
}

/** The first sixty characters of a line, for a message that names it. */
function quote(line: string): string {
  return line.length <= 60 ? `'${line}'` : `'${line.slice(0, 60)}...'`;
}

/** What to do about a line over `max`, in words a builder can act on -- why nen's wrap could not do it, when it could not. */
function fixFor(line: string, max: number): string {
  switch (unwrappable(line, max)) {
    case "preformatted":
      return "it is indented as preformatted text (four spaces or a tab), which 'nen commit format' never rewraps -- break or shorten it by hand";
    case "unbroken":
      return `it holds a word longer than ${max} characters, which nen never splits -- shorten it (a line holding an http(s) URL is exempt, as commitlint exempts it)`;
    case "unsafe":
      return `no break within ${max} characters keeps how commitlint reads the message -- each would start a line with a footer token ('Key: value', 'Closes #1'), a 'BREAKING CHANGE:' note, '#' or 'gpg:', or cut this line's own footer token off the words after it -- reword it`;
    case null:
      return `break it at a space so no line is over ${max} characters -- 'nen commit format' wraps --body this way, and never a --trailer`;
  }
}

/** Where a rule is stated, and -- when the config wrote the width as something other than a number -- how commitlint reads it. */
function whereOf(rule: ReadRule): string {
  if (rule.origin === "extends") return `${CONFIG_CONVENTIONAL}'s default, which ${rule.file} extends`;
  const stated = typeof rule.stated === "number" ? "" : `, where the width is ${rule.stated === undefined ? "not stated" : JSON.stringify(rule.stated)} and commitlint compares each line against ${String(rule.max)}`;
  return `set under 'rules' in ${rule.file}${stated}`;
}

/**
 * What commitlint does under a width below 1 -- or one that is not a number
 * -- in words: it is still a rule it runs, on `line.length <= max`.
 */
function degenerateBehaviour(rule: ReadRule, section: Section): string {
  const blanksToo = Number.isNaN(rule.max) || rule.max < 0;
  const which = blanksToo ? `every ${section} line that holds no URL, blank ones included` : `every ${section} line that is not blank and holds no URL`;
  return `commitlint compares each line's length against ${String(rule.max)}, so it refuses ${which}; a message with no ${section} passes`;
}

/** "line 3", "lines 3 and 5", "lines 3, 5 and 7". */
function lineList(numbers: readonly number[]): string {
  if (numbers.length === 1) return `line ${numbers[0] ?? ""}`;
  return `lines ${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1] ?? ""}`;
}

const LEVEL_1 = "The rule is at level 1, so commitlint only warns and still commits -- unless the hook runs it with --strict, which refuses on a warning.";

/** The key a repository declares its body width with, as the verbs name it. */
const DECLARE = "nen/workflow.json's commits.bodyMaxLineLength";

interface Collected {
  readonly refusals: string[];
  readonly warnings: string[];
  readonly notes: string[];
  /** The sections whose rule was not read, for the one NOT read note. */
  readonly unread: Section[];
}

/** How a prose line is named in a refusal: the body, or the prose commitlint reads as footer. */
function heldAs(line: MessageLine): string {
  return line.section === "body" ? "the body" : "every line before the trailer block (commitlint reads this one as footer, after a footer token)";
}

/**
 * The findings for one ROLE's lines under its rule: "body" for the lines the
 * body rule judges (commitlint's body, and -- where nen's width binds -- the
 * rest of the message's prose), "footer" for the rest (commitlint's footer,
 * or just the trailer block where nen's width binds).
 */
function judgeSection(section: Section, lines: readonly MessageLine[], rule: LineLengthRule, out: Collected): void {
  const name = SECTION_RULE[section];
  switch (rule.kind) {
    case "absent":
    case "none":
    case "off":
      return;
    case "unreadable": {
      out.unread.push(section);
      for (const line of lines) {
        if (lineFits(line.text, CONVENTIONAL_MAX_LINE_LENGTH)) continue;
        const fix = fixFor(line.text, CONVENTIONAL_MAX_LINE_LENGTH);
        if (section === "body") {
          // THE RULING: an unreadable body width is config-conventional's
          // 100, assumed, and binding -- declarable when it is another -- on
          // every line of the message's own prose (this module's header).
          out.refusals.push(
            `line ${line.number} is ${line.text.length} characters, over the ${CONVENTIONAL_MAX_LINE_LENGTH} nen holds ${heldAs(line)} to because '${SECTION_RULE[line.section]}' could not be read (${rule.cause}) -- ${CONFIG_CONVENTIONAL}'s default, the width most commitlint configs inherit: ${quote(line.text)}. nen refuses it: ${fix} -- or, if the repository allows longer lines, declare its width in ${DECLARE}.`,
          );
        } else {
          out.warnings.push(
            `line ${line.number} is ${line.text.length} characters: '${name}' NOT checked, because ${rule.cause}. For reference only: ${CONFIG_CONVENTIONAL}'s default, [2, "always", ${CONVENTIONAL_MAX_LINE_LENGTH}] -- the width most commitlint configs inherit -- refuses it: ${quote(line.text)}. commitlint applies whatever the file states when the commit is made. To clear it: ${fix}.`,
          );
        }
      }
      return;
    }
    case "declared": {
      const source = `commits.bodyMaxLineLength in ${rule.file}, ${rule.max}; nen applies it because ${rule.because}`;
      const over = lines.filter((line): boolean => !lineFits(line.text, rule.max));
      if (over.length === 0) {
        const tail = rule.commitlintRuns ? " -- keep the two in step, since commitlint still runs its own rule at commit time" : "";
        out.notes.push(`${name} checked against ${source}${tail}`);
        return;
      }
      for (const line of over) {
        const asFooter = line.section === "footer" ? ", which holds every line before the trailer block -- commitlint reads this one as footer, after a footer token" : "";
        out.refusals.push(
          `line ${line.number} is ${line.text.length} characters, over the body width this repository declares (${source}${asFooter}): ${quote(line.text)}. The declaration makes the width binding, so nen refuses it: ${fixFor(line.text, rule.max)}.`,
        );
      }
      return;
    }
    case "rule": {
      const where = whereOf(rule);
      const over = lines.filter((line): boolean => !lineFits(line.text, rule.max));
      if (over.length === 0) return;
      if (!usableWidth(rule.max)) {
        // A width no line can be wrapped to: one finding for the section,
        // saying what commitlint does with it.
        const head = `the ${section}'s ${lineList(over.map((line): number => line.number))} ${over.length === 1 ? "breaks" : "break"} this repository's commitlint rule '${name}' (${where}): ${degenerateBehaviour(rule, section)}.`;
        const fix = `give the rule a width of at least 1 -- ${CONFIG_CONVENTIONAL}'s is ${CONVENTIONAL_MAX_LINE_LENGTH} -- or leave the ${section} out`;
        if (rule.level === 2) out.refusals.push(`${head} commitlint refuses this message at commit time, so nen refuses it now: ${fix}.`);
        else out.warnings.push(`${head} ${LEVEL_1} To clear it: ${fix}.`);
        return;
      }
      for (const line of over) {
        const head = `line ${line.number} is ${line.text.length} characters, over the ${String(rule.max)} that this repository's commitlint rule '${name}' allows (${where}): ${quote(line.text)}.`;
        const fix = fixFor(line.text, rule.max);
        if (rule.level === 2) out.refusals.push(`${head} commitlint refuses this message at commit time, so nen refuses it now: ${fix}.`);
        else out.warnings.push(`${head} ${LEVEL_1} To clear it: ${fix}.`);
      }
      return;
    }
  }
}

/**
 * THE ONE CHECK `commit format` AND `commit write` RUN on the message exactly
 * as it will be committed, so the two cannot give two answers for one
 * message: split it into commitlint's body and footer, and judge every line
 * of each under its rule, as this module's header lays out. The shadowed
 * declaration's note is printed on every run, as `commits.subjectCase`'s is.
 */
export function lineLengthFindings(message: string, rules: LineLengthRules): SubjectCaseFindings {
  const sections = commitlintSections(message);
  const out: Collected = { refusals: [], warnings: [], notes: [], unread: [] };
  // WHO JUDGES WHICH LINE. commitlint's body is the body rule's; its footer
  // is the footer rule's -- except that where nen's width binds, the
  // message's own prose in the footer is the body rule's too, and only the
  // trailer block is left to the footer rule (this module's header, F1).
  const binding = bindsProse(rules);
  const trailers = binding ? trailerBlock(message) : new Set<number>();
  const byRole: Record<Section, readonly MessageLine[]> = {
    body: [...sections.body, ...sections.footer.filter((line): boolean => binding && !trailers.has(line.number))],
    footer: sections.footer.filter((line): boolean => !binding || trailers.has(line.number)),
  };
  for (const role of ["body", "footer"] as const) {
    const lines = byRole[role];
    // @commitlint/rules passes an empty section, and a section of blank
    // lines is empty once the parser trims it.
    if (lines.every((line): boolean => line.text === "")) continue;
    judgeSection(role, lines, rules[role], out);
  }
  const notes = [...(rules.shadowed === null ? [] : [rules.shadowed]), ...out.notes];
  const first = rules[out.unread[0] ?? "body"];
  if (out.unread.length > 0 && first.kind === "unreadable") {
    const names = out.unread.map((section): string => `'${SECTION_RULE[section]}'`).join(" and ");
    const held = out.unread.map((section): string =>
      section === "body"
        ? `holds the body${binding ? " -- every line before the trailer block, wherever commitlint places it --" : ""} to ${CONFIG_CONVENTIONAL}'s ${CONVENTIONAL_MAX_LINE_LENGTH} characters a line, the width most commitlint configs inherit, and refuses a line over it -- declare the repository's own width in ${DECLARE} if it is another`
        : `judges the ${binding ? "trailer block" : "footer"} against the same ${CONVENTIONAL_MAX_LINE_LENGTH} for reference only -- commitlint applies whatever width the file states when the commit is made`,
    );
    notes.push(`${names} NOT read: ${first.cause}. So nen ${held.join("; and it ")}`);
  }
  return { ...NO_FINDINGS, refusals: out.refusals, warnings: out.warnings, notes };
}

/**
 * Whether nen's own width binds the message's prose: the body's rule is the
 * declared key or the assumed 100 (its config unreadable), and no readable
 * footer rule stands beside it to decide the footer's prose instead.
 */
function bindsProse(rules: LineLengthRules): boolean {
  const own = rules.body.kind === "unreadable" || rules.body.kind === "declared";
  const readableFooter = rules.footer.kind === "rule" || rules.footer.kind === "none" || rules.footer.kind === "off";
  return own && !readableFooter;
}

/**
 * The message lines of its TRAILER BLOCK, by number: the final paragraph when
 * every line of it is a `Key: value` trailer, as ../wc/messagefile.ts's
 * parseCommitMessageFile -- the reader `commit write` and `wc squash` use --
 * decides it. Empty when the message ends in prose, or does not parse.
 *
 * THE LINES ARE FOUND BY THE READER'S OWN RULES, NOT COUNTED FROM THE END.
 * The reader treats a line of only spaces or tabs as a paragraph break, the
 * same as an empty one, and never counts the header into a paragraph; a count
 * back from the last non-empty line lands on a trailing whitespace-only line
 * instead, and marks the wrong lines -- a long trailer was then held as prose
 * and refused (PR #302's review). So the paragraph is located here with the
 * reader's rules -- skip the blank-or-whitespace lines at the end, take the run
 * of lines above them down to, never into, the header -- and it counts only if
 * it IS the reader's trailer block, key for key; anything else is no block at
 * all, never a guess.
 */
function trailerBlock(message: string): ReadonlySet<number> {
  const parsed = parseCommitMessageFile(message);
  const trailers = parsed.ok ? parsed.value.input.trailers : [];
  if (trailers.length === 0) return new Set();
  // The reader's split: CRLF normalised, then LF -- the same lines, numbered
  // as commitlintSections numbers them.
  const lines = message.split(/\r?\n/);
  const blank = (index: number): boolean => (lines[index] ?? "").trim() === "";
  let end = lines.length;
  while (end > 1 && blank(end - 1)) end -= 1;
  let start = end;
  while (start > 1 && !blank(start - 1)) start -= 1;
  const block = lines.slice(start, end);
  const same = block.length === trailers.length && block.every((line, index): boolean => line.startsWith(`${trailers[index]?.key ?? ""}:`));
  /* c8 ignore next -- the reader's last paragraph is its trailer block whenever it reports trailers */
  if (!same) return new Set();
  return new Set(block.map((_, index): number => start + index + 1));
}

/**
 * `commit format`'s --body, wrapped: every paragraph trimmed and joined as
 * ./format.ts joins them, then wrapped whole -- so a footer token in one
 * paragraph opens the footer for the rest, as it does for commitlint -- to
 * the widths wrapWidths gives, and the warnings for the lines it could not
 * wrap where no rule judges them. The body starts on message line 3, after
 * the header and its blank line. A body with no line to wrap comes back as
 * the same string.
 */
export function wrapFormatBody(
  paragraphs: readonly string[],
  rules: LineLengthRules,
): { readonly body: readonly string[]; readonly warnings: readonly string[]; readonly notes: readonly string[] } {
  const kept = paragraphs.filter((paragraph): boolean => paragraph.trim() !== "");
  const joined = kept.map((paragraph): string => paragraph.trim()).join("\n\n");
  if (joined === "") return { body: [], warnings: [], notes: [] };
  const wrapped = wrapBody(joined, wrapWidths(rules));
  // The note numbers a --body line as the caller gave it: the trim above
  // drops the blank lines a value may start with, so count them back in.
  const first = kept[0] ?? "";
  const skipped = (first.slice(0, first.length - first.trimStart().length).match(/\n/g) ?? []).length;
  return { body: [wrapped.text], warnings: leftOverWarnings(wrapped.leftOver, rules, 3), notes: rewrapNotes(wrapped.rewrapped, rules, skipped) };
}

/** The width a section was wrapped to, and where it came from, as a clause. */
function widthSource(rule: LineLengthRule, name: LineRuleName): string {
  if (rule.kind === "rule") return `the ${String(rule.max)} characters this repository's commitlint rule '${name}' allows (${whereOf(rule)})`;
  if (rule.kind === "declared") return `the ${rule.max} characters this repository declares in commits.bodyMaxLineLength (${rule.file})`;
  if (rule.kind === "unreadable") return `${CONVENTIONAL_MAX_LINE_LENGTH} characters, ${CONFIG_CONVENTIONAL}'s default, since '${name}' could not be read`;
  return `${CONVENTIONAL_MAX_LINE_LENGTH} characters, nen's default width (${CONFIG_CONVENTIONAL}'s), since no commitlint rule states one here`;
}

/**
 * A `note:` per section whose lines `commit format` rewrapped, naming each
 * line by its number in the --body as given (`skipped` is the count of blank
 * lines the value began with): the output differs from what the caller
 * typed, and that is said rather than left to be noticed -- including on a
 * run another problem refuses, so one pass names both.
 */
function rewrapNotes(rewrapped: readonly Rewrapped[], rules: LineLengthRules, skipped: number): readonly string[] {
  const notes: string[] = [];
  for (const section of ["body", "footer"] as const) {
    const lines = rewrapped.filter((line): boolean => line.section === section);
    if (lines.length === 0) continue;
    const list = lines.map((line): string => `${line.index + 1 + skipped} (${line.length} characters)`);
    const which = list.length === 1 ? `its line ${list[0] ?? ""} was` : `its lines ${list.slice(0, -1).join(", ")} and ${list[list.length - 1] ?? ""} were`;
    notes.push(`--body rewrapped: ${which} over ${widthSource(ruleFor(rules, section), SECTION_RULE[section])}, so nen broke ${lines.length === 1 ? "it" : "them"} at spaces, never inside a word`);
  }
  return notes;
}

/**
 * `commit format`'s own report on its wrap, for the lines it could not bring
 * under the width where NO rule judges them -- no config and nothing
 * declared, or a config that does not state the rule. (Where a rule or a
 * declaration does, lineLengthFindings already names the line; a rule that
 * is off, or whose width no wrap can meet, is never wrapped to.)
 * `firstLine` is the message line the body starts on.
 */
export function leftOverWarnings(leftOver: readonly LeftOver[], rules: LineLengthRules, firstLine: number): readonly string[] {
  const warnings: string[] = [];
  for (const line of leftOver) {
    const rule = ruleFor(rules, line.section);
    if (rule.kind !== "absent" && rule.kind !== "none") continue;
    const unruled = rule.kind === "absent" ? "no commitlint config was found" : `${rule.file} states no '${SECTION_RULE[line.section]}'`;
    const why =
      line.why === "preformatted"
        ? "it is indented as preformatted text, which nen never rewraps"
        : line.why === "unbroken"
          ? "it holds a word longer than that, which nen never splits"
          : "no break within that keeps how commitlint reads the message: each would start a line with a footer token, a note, '#' or 'gpg:', or cut the line's own footer token off the words after it";
    warnings.push(
      `line ${firstLine + line.index} is ${line.text.length} characters, and 'commit format' could not wrap it to ${CONVENTIONAL_MAX_LINE_LENGTH}: ${why}. No commitlint rule limits it here (${unruled}), so it is emitted as it is: ${quote(line.text)}.`,
    );
  }
  return warnings;
}
