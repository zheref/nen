// src/grammar/engine.ts -- the shared invocation-grammar engine.
//
// WHY IT EXISTS. Seven bankai-core skills carry the SAME grammar rules, written
// out separately in each, and the audit's finding was that they are "a grammar,
// specified verbatim in each skill" and re-improvised every run. The rules
// themselves are four sentences, and every one of them is a bug someone hit:
//
//   1. THE SEPARATOR IS THE LAST WHOLE-WORD OCCURRENCE, matched
//      case-insensitively. izanami §1 states the reason exactly: "a task
//      description containing the word 'until' in prose is a real thing someone
//      types, so match the LAST occurrence... A wrong split silently watches for
//      the wrong condition." futon §1 says the same of `then`: "an issue title
//      containing the word cannot be mistaken for one."
//
//   2. ECHO THE PARSE BACK BEFORE ACTING. izanagi §1: "Echo the full parse
//      before the first iteration -- task, condition, cap -- and take ONE
//      confirmation... it must show exactly what will happen N times."
//
//   3. AN UNPARSEABLE INVOCATION IS REFUSED WITH THE CORRECTED LINE READY TO
//      PASTE, never run as "the closest valid reading to see" (futon §1,
//      izanagi §1). The corrected line is the product, not the error message:
//      a refusal a caller cannot act on costs a round trip.
//
//   4. RESOLVE OR REFUSE, NEVER GUESS. An enumerated slot given a value outside
//      its set is an error that lists the set.
//
// THE GRAMMAR IS WRITTEN THE WAY THE SKILLS WRITE IT. A template here is the
// same line those documents already publish -- `<repo>@<gate> [every <mode>]` --
// so the specification and the parser cannot drift apart. That is the ONE design
// decision in this file worth defending: the alternative, a hand-built clause
// list per skill, would mean the documented grammar and the implemented grammar
// are two artefacts, and the whole finding was that duplicated grammars diverge.
//
// PER-SKILL GRAMMARS ARE NOT HERE. This ships the engine and the template
// language; registering the futon/izanagi/izanami templates is zheref/nen#4's,
// deliberately, so that a skill's grammar arrives with the verb that uses it.
//
// SLOTS ARE PARSED RIGHT TO LEFT. A template's clauses appear in the order they
// are typed, so the RIGHTMOST separator is resolved first against the whole
// line and each earlier one against what is left. Left-to-right would let an
// earlier slot swallow a later separator -- exactly the "wrong split" rule 1 is
// about, reintroduced by the traversal order.

export interface Slot {
  readonly name: string;
  /** Allowed values, case-insensitively, when the template enumerates them. */
  readonly values: readonly string[];
  /** The separator that introduces this slot, or null for the leading slot. */
  readonly separator: string | null;
  /** `word` separators match on a whole-word boundary; `symbol` ones do not. */
  readonly separatorKind: "word" | "symbol" | null;
  readonly optional: boolean;
  /** A literal suffix the slot may carry, e.g. futon's `[+]`. */
  readonly suffix: string | null;
}

export interface Grammar {
  /** The template exactly as written. */
  readonly template: string;
  readonly slots: readonly Slot[];
}

export class GrammarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrammarError";
  }
}

// --- the template language ---------------------------------------------------
//
//   <name>              a free slot
//   <name:a|b|c>        an enumerated slot; the values are matched case-insensitively
//   <a|b|c>             the same, named after its first value
//   word(s) <slot>      the words are the separator that introduces the slot
//   @ or # before <slot>  a SYMBOL separator: no whitespace or word boundary needed
//   [ ... ]             an optional trailing clause
//   [+]                 an optional literal suffix on the slot just declared

const TOKEN = /<([^<>]+)>|\[|\]|[^\s<>[\]]+/g;

export function parseTemplate(template: string): Grammar {
  const slots: Slot[] = [];
  let pendingWords: string[] = [];
  let pendingSymbol: string | null = null;
  let depth = 0;

  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(template)) !== null) {
    const raw = match[0];
    if (raw === "[") {
      depth += 1;
      continue;
    }
    if (raw === "]") {
      depth -= 1;
      if (depth < 0) throw new GrammarError(`template '${template}' closes a '[' that was never opened`);
      continue;
    }

    const inner = match[1];
    if (inner === undefined) {
      // A literal. `[+]` (a suffix on the slot just declared) is the one literal
      // that is not a separator, and it is recognised by being bracketed and
      // non-alphanumeric.
      if (depth > 0 && slots.length > 0 && /^[^A-Za-z0-9]+$/.test(raw) && pendingWords.length === 0) {
        const last = slots[slots.length - 1];
        if (last !== undefined) slots[slots.length - 1] = { ...last, suffix: raw };
        continue;
      }
      // A trailing symbol like `@` or `#` glued to the next slot arrives as its
      // own token because TOKEN stops at `<`.
      if (/^[^A-Za-z0-9]+$/.test(raw)) {
        pendingSymbol = raw;
        continue;
      }
      pendingWords.push(raw);
      continue;
    }

    // A slot.
    const colon = inner.indexOf(":");
    const name = colon === -1 ? inner.split("|")[0]?.trim() ?? inner : inner.slice(0, colon).trim();
    const valueSource = colon === -1 ? (inner.includes("|") ? inner : "") : inner.slice(colon + 1);
    const values = valueSource
      .split("|")
      .map((value): string => value.trim())
      .filter((value): boolean => value !== "");

    const separator = pendingSymbol ?? (pendingWords.length > 0 ? pendingWords.join(" ") : null);
    slots.push({
      name,
      values,
      separator,
      separatorKind: separator === null ? null : pendingSymbol !== null ? "symbol" : "word",
      // The FIRST slot is never optional even inside brackets: a template whose
      // subject is optional has no subject, and every skill that omits one
      // resolves it from the working directory instead (see ../repo/resolve.ts).
      optional: depth > 0 && slots.length > 0,
      suffix: null,
    });
    pendingWords = [];
    pendingSymbol = null;
  }

  if (depth !== 0) throw new GrammarError(`template '${template}' has an unclosed '['`);
  if (slots.length === 0) throw new GrammarError(`template '${template}' declares no <slot>`);
  return { template, slots };
}

// --- the split ---------------------------------------------------------------

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The LAST whole-word occurrence of `phrase`, case-insensitively. Returns the
 * text before it and the text after it, or null when it does not occur.
 *
 * Internal whitespace in a multi-word phrase (`up to`) is matched flexibly, so a
 * caller who typed two spaces is not refused for a reason nobody would guess.
 */
export function splitLastWord(text: string, phrase: string): { head: string; tail: string } | null {
  const words = phrase.trim().split(/\s+/).map(escapeRegex);
  const pattern = new RegExp(`(?<![A-Za-z0-9])${words.join("\\s+")}(?![A-Za-z0-9])`, "gi");
  return lastSplit(text, pattern);
}

/** The LAST occurrence of a symbol separator. No word boundary: `@` and `#` have none. */
export function splitLastSymbol(text: string, symbol: string): { head: string; tail: string } | null {
  return lastSplit(text, new RegExp(escapeRegex(symbol), "g"));
}

function lastSplit(text: string, pattern: RegExp): { head: string; tail: string } | null {
  let found: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(text)) !== null) {
    found = match;
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  if (found === null) return null;
  return {
    head: text.slice(0, found.index),
    tail: text.slice(found.index + found[0].length),
  };
}

// --- the parse ---------------------------------------------------------------

export interface SlotValue {
  readonly name: string;
  readonly value: string;
  /** True when the template's `[+]` suffix was present on this slot. */
  readonly suffix: boolean;
}

export interface ParseResult {
  readonly skill: string;
  readonly template: string;
  readonly line: string;
  readonly ok: boolean;
  readonly slots: readonly SlotValue[];
  /** Required slots the line did not supply. */
  readonly missing: readonly string[];
  /** One line per problem, in the order they were found. */
  readonly problems: readonly string[];
  /** The line the caller should paste instead. */
  readonly corrected: string;
  /** The echo: the parse restated, one clause per line. */
  readonly echo: readonly string[];
}

export function parseInvocation(skill: string, grammar: Grammar, line: string): ParseResult {
  const found = new Map<string, SlotValue>();
  const missing: string[] = [];
  const problems: string[] = [];

  // RIGHT TO LEFT (see the header). Each separator is resolved against what the
  // separators to its right have not already taken.
  let remaining = line.trim();
  for (let index = grammar.slots.length - 1; index >= 1; index -= 1) {
    const slot = grammar.slots[index];
    if (slot === undefined || slot.separator === null) continue;
    const split =
      slot.separatorKind === "symbol"
        ? splitLastSymbol(remaining, slot.separator)
        : splitLastWord(remaining, slot.separator);
    if (split === null) {
      if (!slot.optional) missing.push(slot.name);
      continue;
    }
    remaining = split.head;
    found.set(slot.name, { name: slot.name, value: split.tail.trim(), suffix: false });
  }

  const first = grammar.slots[0];
  if (first !== undefined) {
    found.set(first.name, { name: first.name, value: remaining.trim(), suffix: false });
  }

  // Suffixes and enumerations, in template order, so problems read in the order
  // the caller typed them.
  const slots: SlotValue[] = [];
  for (const slot of grammar.slots) {
    const value = found.get(slot.name);
    if (value === undefined) continue;
    let text = value.value;
    let suffix = false;
    if (slot.suffix !== null && text.endsWith(slot.suffix)) {
      text = text.slice(0, text.length - slot.suffix.length).trim();
      suffix = true;
    }
    if (text === "" && !slot.optional) {
      missing.push(slot.name);
      continue;
    }
    if (text === "") continue;
    if (slot.values.length > 0) {
      const hit = slot.values.find((candidate): boolean => candidate.toLowerCase() === text.toLowerCase());
      if (hit === undefined) {
        problems.push(
          `<${slot.name}> is one of ${slot.values.join(" | ")} (case-insensitively), and '${text}' is none of them. It is resolved, never guessed at: the closest match is not the answer.`,
        );
        continue;
      }
      // NORMALIZED TO THE TEMPLATE'S OWN SPELLING. Every skill states the
      // grammar is case-insensitive; carrying the caller's casing forward would
      // make two identical invocations compare unequal downstream.
      text = hit;
    }
    slots.push({ name: slot.name, value: text, suffix });
  }

  for (const name of missing) {
    problems.push(`<${name}> is required and the line does not supply it.`);
  }

  const byName = new Map(slots.map((slot): [string, SlotValue] => [slot.name, slot]));
  const corrected = correctedLine(skill, grammar, byName);
  const echo = slots.map(
    (slot): string => `${slot.name}: ${slot.value}${slot.suffix ? " (+)" : ""}`,
  );

  return {
    skill,
    template: grammar.template,
    line,
    ok: problems.length === 0,
    slots,
    missing,
    problems,
    corrected,
    echo,
  };
}

// The corrected line: the template, with every slot that WAS understood filled
// in and every slot that was not left as its placeholder.
//
// IT KEEPS WHAT THE CALLER GOT RIGHT, deliberately. A refusal that hands back a
// blank template makes the caller retype the part that was already correct, and
// the part they retype is where the next typo goes.
function correctedLine(
  skill: string,
  grammar: Grammar,
  values: ReadonlyMap<string, SlotValue>,
): string {
  let out = skill;
  for (const slot of grammar.slots) {
    const value = values.get(slot.name);
    if (value === undefined && slot.optional) continue;
    const rendered =
      value === undefined
        ? `<${slot.name}${slot.values.length > 0 ? `: ${slot.values.join(" | ")}` : ""}>`
        : `${value.value}${value.suffix && slot.suffix !== null ? slot.suffix : ""}`;
    if (slot.separator === null) {
      out += ` ${rendered}`;
    } else if (slot.separatorKind === "symbol") {
      out += `${slot.separator}${rendered}`;
    } else {
      out += ` ${slot.separator} ${rendered}`;
    }
  }
  return out;
}
