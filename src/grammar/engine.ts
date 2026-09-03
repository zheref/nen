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
// about, reintroduced by the traversal order. Literal-only optional clauses
// (`[then sweep]`) take part in the SAME right-to-left resolution: they are what
// stops an earlier slot's capture, so dropping them (as this engine did before
// zheref/nen#30) let the first slot swallow the caller's clause verbatim and
// report the swallow as a successful parse.
//
// A TEMPLATE THE ENGINE CANNOT PARSE UNAMBIGUOUSLY IS REFUSED, LOUDLY, AT
// parseTemplate TIME (zheref/nen#30). The alternative -- accepting the template
// and mis-splitting the line -- is the silent-`ok:true` failure mode that issue
// documents, and a silent mis-parse is strictly worse than a refusal that names
// the unsupported shape and the rewrite that avoids it.

export interface Slot {
  readonly name: string;
  /** Allowed values, case-insensitively, when the template enumerates them. */
  readonly values: readonly string[];
  /** The separator that introduces this slot, or null for an unintroduced leading slot. */
  readonly separator: string | null;
  /** `word` separators match on a whole-word boundary; `symbol` ones do not. */
  readonly separatorKind: "word" | "symbol" | null;
  /**
   * True when the separator itself sits inside `[ ... ]` (`[@<gate>]`), so a
   * line may omit separator and slot together. False for a separator written
   * OUTSIDE the brackets (`onto [<target-branch>]`): there the literal is
   * required even when the bracketed slot after it is omitted.
   */
  readonly separatorOptional: boolean;
  readonly optional: boolean;
  /** A literal suffix the slot may carry, e.g. futon's `[+]`. */
  readonly suffix: string | null;
}

/**
 * A `[ ... ]` clause holding literal words and no slot at all, e.g. futon's
 * `[then sweep]`. It captures nothing; its whole meaning is whether the line
 * carries it. It exists as its own kind (zheref/nen#30) because it also bounds
 * the slot to its left -- without it the leading slot has nothing to stop at.
 */
export interface OptionalClause {
  /** The literal words, exactly as the template writes them inside `[ ... ]`. */
  readonly literal: string;
  /** How many slots are declared to its left; fixes its place in the right-to-left resolution. */
  readonly slotsBefore: number;
}

export interface Grammar {
  /** The template exactly as written. */
  readonly template: string;
  readonly slots: readonly Slot[];
  readonly clauses: readonly OptionalClause[];
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
//   [ ... ]             an optional trailing clause -- a separator plus its slot
//                       (`[@<gate>]`, `[every <mode>]`), a slot behind a literal
//                       written outside the brackets (`onto [<target-branch>]`),
//                       or literal words alone (`[then sweep]`)
//   [+]                 an optional literal suffix on the slot just declared,
//                       recognised by its bracket group holding NOTHING ELSE

const TOKEN = /<([^<>]+)>|\[|\]|[^\s<>[\]]+/g;

/**
 * A literal word waiting for the slot it will introduce, TAGGED WITH THE BRACKET
 * DEPTH IT WAS TYPED AT. The depth is what tells `onto [<target-branch>]` (the
 * literal is required, only the slot is optional) apart from `[then sweep]`
 * (the literal IS the optional clause) when a `]` closes -- zheref/nen#30.
 */
interface PendingWord {
  readonly word: string;
  readonly depth: number;
}

export function parseTemplate(template: string): Grammar {
  const slots: Slot[] = [];
  const clauses: OptionalClause[] = [];
  let pendingWords: PendingWord[] = [];
  let pendingSymbol: { readonly symbol: string; readonly depth: number } | null = null;
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
      if (depth === 0) throw new GrammarError(`template '${template}' closes a '[' that was never opened`);
      if (pendingSymbol !== null && pendingSymbol.depth >= depth) {
        // `[@]`-shapes reach the suffix rule below; this is `[x @<eof-of-group>`:
        // a symbol that introduces nothing. Refuse the TEMPLATE rather than
        // guess which neighbour the symbol belonged to.
        throw new GrammarError(
          `template '${template}' is refused: its '[ ... ]' clause ends with the separator '${pendingSymbol.symbol}' introducing no <slot>. Put a <slot> after the separator, or drop it.`,
        );
      }
      // Words still pending when their bracket group closes are a LITERAL-ONLY
      // optional clause, e.g. `[then sweep]`. Before zheref/nen#30 they were
      // silently dropped, which left the leading slot nothing to stop its
      // capture at -- `<repo> [then sweep]` + 'BC then sweep' reported
      // repo='BC then sweep', ok:true. Words from OUTSIDE this group (a lower
      // depth) are someone else's separator and stay pending.
      const inside = pendingWords.filter((pending): boolean => pending.depth >= depth);
      if (inside.length > 0) {
        const literal = inside.map((pending): string => pending.word).join(" ");
        if (slots.length === 0) {
          throw new GrammarError(
            `template '${template}' is refused: the literal clause '[${literal}]' appears before any <slot>, and a clause with nothing to its left bounds nothing. Declare a <slot> first, or drop the brackets.`,
          );
        }
        clauses.push({ literal, slotsBefore: slots.length });
        pendingWords = pendingWords.filter((pending): boolean => pending.depth < depth);
      }
      depth -= 1;
      continue;
    }

    const inner = match[1];
    if (inner === undefined) {
      // A literal.
      if (/^[^A-Za-z0-9]+$/.test(raw)) {
        // `[+]` -- an optional literal suffix on the slot just declared -- is
        // recognised by its bracket group holding NOTHING ELSE: the next thing
        // after the literal must be the closing ']'. Requiring that lookahead is
        // zheref/nen#30's fix. The old test ("bracketed and non-alphanumeric")
        // also matched the '@' of `[@<gate>]`, consumed it as a suffix on the
        // PREVIOUS slot, and left <gate> with no separator at all -- which is
        // exactly how the whole line ended up inside the first slot.
        const closesImmediately = depth > 0 && /^\s*\]/.test(template.slice(TOKEN.lastIndex));
        if (closesImmediately && slots.length > 0 && pendingWords.length === 0 && pendingSymbol === null) {
          const last = slots[slots.length - 1];
          if (last !== undefined) slots[slots.length - 1] = { ...last, suffix: raw };
          continue;
        }
        // A symbol like `@` or `#` glued to the next slot arrives as its own
        // token because TOKEN stops at `<`.
        pendingSymbol = { symbol: raw, depth };
        continue;
      }
      pendingWords.push({ word: raw, depth });
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

    if (pendingSymbol === null && new Set(pendingWords.map((pending): number => pending.depth)).size > 1) {
      // `foo [bar <slot>]`: are the introducing words 'foo bar' (with 'bar'
      // omissible) or is 'foo' required and 'bar <slot>' the optional part?
      // The engine cannot know, and a guess is a mis-parse -- refuse the
      // template with the rewrite that resolves it (zheref/nen#30).
      throw new GrammarError(
        `template '${template}' is refused: the words introducing <${name}> cross a '[' boundary, so the engine cannot tell which of them the line may omit. Keep a slot's introducing words on ONE side of the bracket, e.g. 'foo [bar <${name}>]' -> 'foo bar [<${name}>]' or '[foo bar <${name}>]'.`,
      );
    }

    const separator =
      pendingSymbol?.symbol ?? (pendingWords.length > 0 ? pendingWords.map((pending): string => pending.word).join(" ") : null);
    const separatorDepth = pendingSymbol !== null ? pendingSymbol.depth : pendingWords[0]?.depth ?? null;
    // A bracketed slot is optional -- INCLUDING a leading one, so long as a
    // literal anchors it (`onto [<target-branch>]`: 'onto' alone is a valid
    // line, zheref/nen#30). A leading slot that is bracketed AND unintroduced
    // (`[<repo>]...`) is refused instead: an omitted value and a mistyped one
    // would read identically, and every skill that omits its subject resolves
    // it from the working directory, not from an optional slot
    // (see ../repo/resolve.ts).
    const optional = depth > 0;
    if (optional && slots.length === 0 && separator === null) {
      throw new GrammarError(
        `template '${template}' is refused: its leading slot <${name}> is bracketed but nothing introduces it, so an omitted value cannot be told apart from a mistyped one. Anchor it behind a literal ('word [<${name}>]') or drop the brackets.`,
      );
    }
    slots.push({
      name,
      values,
      separator,
      separatorKind: separator === null ? null : pendingSymbol !== null ? "symbol" : "word",
      separatorOptional: separatorDepth !== null && separatorDepth > 0,
      optional,
      suffix: null,
    });
    pendingWords = [];
    pendingSymbol = null;
  }

  if (depth !== 0) throw new GrammarError(`template '${template}' has an unclosed '['`);
  if (slots.length === 0) throw new GrammarError(`template '${template}' declares no <slot>`);
  return { template, slots, clauses };
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

/**
 * Strip `separator` from the FRONT of `text`, or return null when it is not
 * there. The leading slot's separator anchors at the start -- unlike every
 * later separator, which is the LAST occurrence -- because everything to its
 * left has, by construction, already been resolved away.
 */
function stripLeading(text: string, separator: string, kind: "word" | "symbol" | null): string | null {
  if (kind === "symbol") {
    return text.startsWith(separator) ? text.slice(separator.length) : null;
  }
  const words = separator.trim().split(/\s+/).map(escapeRegex);
  const pattern = new RegExp(`^${words.join("\\s+")}(?![A-Za-z0-9])`, "i");
  const hit = pattern.exec(text);
  if (hit === null) return null;
  return text.slice(hit[0].length);
}

// --- the parse ---------------------------------------------------------------

export interface SlotValue {
  readonly name: string;
  readonly value: string;
  /** True when the template's `[+]` suffix was present on this slot. */
  readonly suffix: boolean;
}

/** One literal-only `[ ... ]` clause and whether the line carried it. */
export interface ClauseValue {
  readonly literal: string;
  readonly present: boolean;
}

export interface ParseResult {
  readonly skill: string;
  readonly template: string;
  readonly line: string;
  readonly ok: boolean;
  readonly slots: readonly SlotValue[];
  /** Every literal-only clause the template declares, present or not. */
  readonly clauses: readonly ClauseValue[];
  /** Required slots the line did not supply. */
  readonly missing: readonly string[];
  /** One line per problem, in the order they were found. */
  readonly problems: readonly string[];
  /** The line the caller should paste instead. */
  readonly corrected: string;
  /** The echo: the parse restated, one clause per line. */
  readonly echo: readonly string[];
}

/**
 * Slots and literal clauses interleaved back into TEMPLATE order, so the
 * right-to-left resolution (and the corrected line, and the echo) walk one
 * sequence instead of two arrays whose relative order was lost.
 */
type TemplateEntry =
  | { readonly kind: "slot"; readonly index: number }
  | { readonly kind: "clause"; readonly index: number };

function templateOrder(grammar: Grammar): TemplateEntry[] {
  const entries: TemplateEntry[] = [];
  let clause = 0;
  for (let index = 0; index <= grammar.slots.length; index += 1) {
    while (clause < grammar.clauses.length && grammar.clauses[clause]?.slotsBefore === index) {
      entries.push({ kind: "clause", index: clause });
      clause += 1;
    }
    if (index < grammar.slots.length) entries.push({ kind: "slot", index });
  }
  return entries;
}

export function parseInvocation(skill: string, grammar: Grammar, line: string): ParseResult {
  const found = new Map<string, SlotValue>();
  const missing: string[] = [];
  const problems: string[] = [];
  const clausePresent: boolean[] = grammar.clauses.map((): boolean => false);

  // RIGHT TO LEFT (see the header). Each separator -- and each literal-only
  // clause, which is resolved exactly like a separator that captures nothing --
  // is resolved against what the entries to its right have not already taken.
  let remaining = line.trim();
  const order = templateOrder(grammar);
  for (let at = order.length - 1; at >= 0; at -= 1) {
    const entry = order[at];
    if (entry === undefined) continue;

    if (entry.kind === "clause") {
      const clause = grammar.clauses[entry.index];
      if (clause === undefined) continue;
      const split = splitLastWord(remaining, clause.literal);
      if (split === null) continue; // literal clauses are optional by construction: absence parses
      if (split.tail.trim() !== "") {
        // The message asserts only that the tail is UNCONSUMABLE, not that the
        // grammar ends here: entries to the clause's right resolve first (the
        // right-to-left rule above), so text still standing after the literal
        // is text none of them accounted for -- but later optional entries may
        // well exist ('<repo> [then sweep] [every <mode>]'), and claiming "the
        // grammar defines nothing after it" would be flatly wrong there.
        problems.push(
          `'[${clause.literal}]' is a literal clause, but the line continues past it with '${split.tail.trim()}', which nothing later in the grammar consumes. Drop the trailing text, or move it before '${clause.literal}'.`,
        );
      }
      clausePresent[entry.index] = true;
      remaining = split.head;
      continue;
    }

    if (entry.index === 0) continue; // the leading slot takes what is left, below
    const slot = grammar.slots[entry.index];
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

  // THE LEADING SLOT. Whatever the later entries left behind is its region --
  // which, before zheref/nen#30, included its own introducing literal, so
  // `onto [<target-branch>]` + 'onto' reported target-branch: onto. The literal
  // is stripped (or its absence ruled on) FIRST, so the separator can never be
  // read as the value.
  const first = grammar.slots[0];
  if (first !== undefined) {
    let text: string | null = remaining.trim();
    if (first.separator !== null) {
      const stripped = stripLeading(text, first.separator, first.separatorKind);
      if (stripped !== null) {
        text = stripped.trim();
      } else if (first.separatorOptional && first.optional) {
        // The whole `[word <slot>]` clause is optional; its absence parses.
        // Text that is neither the clause nor nothing belongs to no slot.
        if (text !== "") {
          problems.push(
            `the line must open with '${first.separator}' to supply <${first.name}>, or omit that clause entirely -- '${text}' is neither.`,
          );
        }
        text = null;
      } else {
        problems.push(
          `the line must open with the literal '${first.separator}' -- it is what introduces <${first.name}>${text === "" ? "" : `, and '${text}' does not carry it`}.`,
        );
        text = null;
      }
    }
    // An optional leading slot whose region is empty was simply omitted; a
    // required one records the empty capture so the pass below reports it.
    if (text !== null && (text !== "" || !first.optional)) {
      found.set(first.name, { name: first.name, value: text, suffix: false });
    }
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
  // ATTEMPTED = the line supplied SOMETHING for the slot, valid or not. It is
  // what keeps a refused optional slot in the corrected line: a caller who
  // typed 'BC@G9' against `<repo>[@<gate:...>]` is corrected to
  // 'BC@<gate: ...>', not to a line that pretends they never typed a gate.
  const attempted = new Set<string>();
  for (const [name, value] of found) {
    if (value.value.trim() !== "") attempted.add(name);
  }
  const corrected = correctedLine(skill, grammar, byName, attempted, clausePresent);

  const clauses = grammar.clauses.map(
    (clause, index): ClauseValue => ({ literal: clause.literal, present: clausePresent[index] === true }),
  );
  const echo: string[] = [];
  for (const entry of templateOrder(grammar)) {
    if (entry.kind === "clause") {
      const clause = grammar.clauses[entry.index];
      if (clause !== undefined && clausePresent[entry.index] === true) echo.push(`[${clause.literal}]: present`);
      continue;
    }
    const slot = grammar.slots[entry.index];
    const value = slot === undefined ? undefined : byName.get(slot.name);
    if (value !== undefined) echo.push(`${value.name}: ${value.value}${value.suffix ? " (+)" : ""}`);
  }

  return {
    skill,
    template: grammar.template,
    line,
    ok: problems.length === 0,
    slots,
    clauses,
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
  attempted: ReadonlySet<string>,
  clausePresent: readonly boolean[],
): string {
  let out = skill;
  for (const entry of templateOrder(grammar)) {
    if (entry.kind === "clause") {
      const clause = grammar.clauses[entry.index];
      if (clause !== undefined && clausePresent[entry.index] === true) out += ` ${clause.literal}`;
      continue;
    }
    const slot = grammar.slots[entry.index];
    if (slot === undefined) continue;
    const value = values.get(slot.name);
    if (value === undefined && slot.optional && !attempted.has(slot.name)) {
      // An untouched optional slot renders nothing -- EXCEPT its introducing
      // literal when the template writes that literal OUTSIDE the brackets
      // (`onto [<target-branch>]`): 'onto' alone is a complete valid line,
      // and a corrected line that dropped the literal would not be.
      if (slot.separator !== null && !slot.separatorOptional) {
        out += slot.separatorKind === "symbol" ? slot.separator : ` ${slot.separator}`;
      }
      continue;
    }
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
