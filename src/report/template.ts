// src/report/template.ts -- the substitution language `nen report render` fills
// a template with. Pure: no filesystem, no seam, no clock.
//
// FOUR CONSTRUCTS, AND NOTHING ELSE. `{{token}}`, `{{{token}}}`, `{{#each
// list}}…{{/each}}` and `{{#if key}}…{{/if}}`. Not a general template engine
// growing a feature per report -- a template that can branch on an expression,
// call a helper or include a partial is a program, and a program in a data file
// is a thing nobody reviews. The whole language fits in this file's own header,
// which is the property it is chosen for.
//
// IT IS THE SAME SPIRIT AS ../canon/mirror.ts's `{{TOKEN}}` SUBSTITUTION, and
// deliberately not the same code. That module binds a FLAT `TOKEN -> literal`
// table and refuses an unbound token (MissingTokenError) -- exactly this
// module's refusal, one level simpler. What a report needs and a canon mirror
// does not is a LIST: a commit table is `{{#each commits}}` over rows nobody can
// enumerate in advance. Widening mirror.ts to carry blocks and dotted paths
// would put a loop in the module whose whole job is a byte-for-byte
// regeneration check; so the two stay separate, and the shared idea -- an
// unbound token is a REFUSAL, never a blank -- is stated in both.
//
// AN UNKNOWN TOKEN IS EXIT 2, NAMING IT. The failure this rules out is the one
// a template engine is normally happy to produce: a report published with an
// empty cell where a number should be, because the data document spells the key
// `lastStop` and the template spells it `laststop`. A blank renders as a fact
// ("there were no commits"), so a template that asks for something the data has
// not got must not render at all.
//
// HTML-ESCAPED BY DEFAULT, RAW ONLY WHERE THE TEMPLATE SAYS SO. The reports this
// fills are HTML pages carrying commit subjects, file paths and branch names --
// caller text, straight off a git log. `{{{token}}}` is the explicit opt-out for
// a value that IS markup (a pre-rendered fragment, a data URI in an attribute
// the author built), so the dangerous form is the one somebody has to type.
//
// SCOPE RESOLUTION WALKS OUTWARD, AND ONLY ON THE FIRST SEGMENT. Inside
// `{{#each commits}}`, `{{sha}}` is the row's and `{{branch}}` is the document's
// -- the innermost scope that HAS the first segment answers the whole path. Once
// a scope has claimed it, a missing LATER segment is an unknown token rather
// than a reason to try the next scope out: `{{coverage.lines}}` on a document
// whose `coverage` is null is a template/data disagreement, and silently
// answering it from an outer scope's unrelated `coverage` would be the blank
// this module exists to refuse, wearing a value.

/** One node of a parsed template. */
export type TemplateNode =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "value"; readonly token: string; readonly raw: boolean }
  | { readonly kind: "each"; readonly token: string; readonly body: readonly TemplateNode[] }
  | { readonly kind: "if"; readonly token: string; readonly body: readonly TemplateNode[] };

export interface ParsedTemplate {
  readonly nodes: readonly TemplateNode[];
  /**
   * Every token the template names, in first-appearance order, de-duplicated
   * and spelled exactly as the template spells it -- `{{#each commits}}`
   * contributes `commits`, `{{.}}` contributes `.`.
   *
   * THIS IS WHAT `--dry-run` PRINTS, and it is computed from the PARSE rather
   * than from a second regex over the text: a dry run whose token list came
   * from a different reader than the renderer's could report a token the render
   * never asks for, which is the one thing a dry run must not do.
   */
  readonly tokens: readonly string[];
}

/**
 * A template this module refuses. Every message is written to be actionable on
 * its own, and the command layer re-raises it as a `VerbUsageError` so it exits
 * 2 -- "you wrote it wrong", which no retry fixes.
 */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/**
 * The tag scanner. The TRIPLE form is first in the alternation so `{{{x}}}` is
 * never read as a `{{` tag whose body starts with `{`.
 *
 * `[^{}]` in both bodies rather than a lazy `.+?`: a tag body containing a
 * brace is not a tag this language has, and matching it lazily would silently
 * cut `{{ a } b }}` in a place nobody wrote.
 */
const TAG = /\{\{\{\s*([^{}]+?)\s*\}\}\}|\{\{\s*([^{}]+?)\s*\}\}/g;

/** A dotted path: `branch`, `coverage.total.lines.percent`. */
const PATH = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

const OPEN_EACH = /^#each\s+(\S+)$/;
const OPEN_IF = /^#if\s+(\S+)$/;

interface Frame {
  readonly kind: "each" | "if";
  readonly token: string;
  readonly body: TemplateNode[];
}

/**
 * Text into nodes, or a refusal naming the tag.
 *
 * The block stack is checked at BOTH ends: an unclosed `{{#each}}` is refused
 * naming the token it opened over, and a `{{/if}}` closing an `{{#each}}` is
 * refused naming both -- a mismatched pair renders SOMETHING under a forgiving
 * parser, and what it renders is the wrong half of the template.
 */
export function parseTemplate(text: string): ParsedTemplate {
  const root: TemplateNode[] = [];
  const stack: Frame[] = [];
  const tokens: string[] = [];
  const seen = new Set<string>();

  const push = (node: TemplateNode): void => {
    (stack.at(-1)?.body ?? root).push(node);
  };
  const note = (token: string): void => {
    if (seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };

  let cursor = 0;
  TAG.lastIndex = 0;
  for (let match = TAG.exec(text); match !== null; match = TAG.exec(text)) {
    if (match.index > cursor) push({ kind: "text", text: text.slice(cursor, match.index) });
    cursor = match.index + match[0].length;

    const rawBody = match[1];
    if (rawBody !== undefined) {
      const token = readValueToken(rawBody, "{{{ }}}");
      note(token);
      push({ kind: "value", token, raw: true });
      continue;
    }

    const body = (match[2] as string).trim();
    const each = OPEN_EACH.exec(body);
    if (each !== null) {
      const token = requirePath(each[1] as string, "{{#each <list>}}");
      note(token);
      stack.push({ kind: "each", token, body: [] });
      continue;
    }
    const conditional = OPEN_IF.exec(body);
    if (conditional !== null) {
      const token = requirePath(conditional[1] as string, "{{#if <key>}}");
      note(token);
      stack.push({ kind: "if", token, body: [] });
      continue;
    }
    if (body === "/each" || body === "/if") {
      const open = stack.pop();
      const closing = body.slice(1) as "each" | "if";
      if (open === undefined) {
        throw new TemplateError(
          `'{{/${closing}}}' closes a block that was never opened. This language has exactly two blocks -- '{{#each <list>}}…{{/each}}' and '{{#if <key>}}…{{/if}}' -- and each one closes the block it opened.`,
        );
      }
      if (open.kind !== closing) {
        throw new TemplateError(
          `'{{/${closing}}}' closes a '{{#${open.kind} ${open.token}}}'. Blocks nest, and each closes with its own tag: '{{/${open.kind}}}' here.`,
        );
      }
      push({ kind: open.kind, token: open.token, body: open.body } as TemplateNode);
      continue;
    }
    if (body.startsWith("#") || body.startsWith("/") || body.startsWith(">") || body.startsWith("!")) {
      throw new TemplateError(
        `'{{${body}}}' is not a tag this language has. The whole language is: '{{token}}' (HTML-escaped), '{{{token}}}' (raw), '{{#each <list>}}…{{/each}}' and '{{#if <key>}}…{{/if}}' -- no helpers, no partials, no comments, no expressions. Nen fills reports; it does not run them.`,
      );
    }
    const token = readValueToken(body, "{{ }}");
    note(token);
    push({ kind: "value", token, raw: false });
  }
  if (cursor < text.length) push({ kind: "text", text: text.slice(cursor) });

  const unclosed = stack.at(-1);
  if (unclosed !== undefined) {
    throw new TemplateError(
      `'{{#${unclosed.kind} ${unclosed.token}}}' is never closed. Add '{{/${unclosed.kind}}}' -- an unclosed block would otherwise render the rest of the template inside it${stack.length > 1 ? ` (${stack.length} blocks are open at the end of the file)` : ""}.`,
    );
  }
  return { nodes: root, tokens };
}

/** `.`, `@index`, or a dotted path -- the three things a value tag may name. */
function readValueToken(body: string, form: string): string {
  const token = body.trim();
  if (token === "." || token === "@index") return token;
  return requirePath(token, form);
}

function requirePath(token: string, form: string): string {
  if (!PATH.test(token)) {
    throw new TemplateError(
      `'${token}' is not a token '${form}' can name. A token is a dotted path of letters, digits, '_' and '-' ('branch', 'coverage.total.lines.percent'), or -- in a value tag inside '{{#each}}' -- '.' for the item itself and '@index' for its position.`,
    );
  }
  return token;
}

// ── rendering ───────────────────────────────────────────────────────────────

/** One level of the scope chain: a data value, and a loop position when it has one. */
interface Scope {
  readonly value: unknown;
  /** The `{{@index}}` of this frame, or null outside an `{{#each}}`. */
  readonly index: number | null;
}

interface Resolved {
  readonly found: boolean;
  readonly value: unknown;
}

/**
 * Fill a parsed template from one data document.
 *
 * `data` IS THE ROOT SCOPE and is never mutated. The refusals are all
 * TemplateError, so the caller has one class to catch and one exit code to
 * return, whether the template was malformed or merely disagreed with the data.
 */
export function renderTemplate(parsed: ParsedTemplate, data: unknown): string {
  return renderNodes(parsed.nodes, [{ value: data, index: null }]);
}

function renderNodes(nodes: readonly TemplateNode[], scopes: readonly Scope[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += node.text;
        break;
      case "value":
        out += renderValue(node.token, node.raw, scopes);
        break;
      case "each": {
        const list = mustResolve(node.token, scopes, "{{#each}}");
        if (!Array.isArray(list)) {
          throw new TemplateError(
            `'{{#each ${node.token}}}' needs a list, and '${node.token}' is ${describe(list)}. A block that quietly iterated a non-list would render nothing and read as an empty list.`,
          );
        }
        list.forEach((item, index): void => {
          out += renderNodes(node.body, [...scopes, { value: item, index }]);
        });
        break;
      }
      case "if": {
        const value = mustResolve(node.token, scopes, "{{#if}}");
        if (truthy(value)) out += renderNodes(node.body, scopes);
        break;
      }
    }
  }
  return out;
}

/**
 * TRUTHINESS, STATED RATHER THAN INHERITED. JavaScript's own rules are close
 * enough to be confusing here: `[]` is truthy in the language and means "no
 * rows" in a report, which is exactly the case `{{#if}}` is written for. So an
 * EMPTY ARRAY IS FALSE, and everything else follows the obvious reading --
 * `null`, `false`, `0`, `NaN` and `""` are false, an object (empty or not) is
 * true, because a document with a `coverage` object HAS coverage.
 */
export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  return value !== null && value !== undefined && value !== false && value !== "";
}

function renderValue(token: string, raw: boolean, scopes: readonly Scope[]): string {
  const value = mustResolve(token, scopes, raw ? "{{{ }}}" : "{{ }}");
  const text = stringify(token, value);
  return raw ? text : escapeHtml(text);
}

/**
 * A value's TEXT, or a refusal.
 *
 * `null` RENDERS AS THE EMPTY STRING, and it is the one blank this module
 * allows: the data document's own contract uses `null` for "there is nothing to
 * say" (no coverage report, no proof), so a `null` reaching a value tag is the
 * document answering rather than failing to. An OBJECT or a LIST is refused,
 * because `[object Object]` in a published report is the silent-wrong-answer
 * this whole file is written against -- the template meant a field of it.
 */
function stringify(token: string, value: unknown): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new TemplateError(
    `'${token}' is ${describe(value)}, which has no text form. Name a field of it ('${token}.<field>'), or iterate it with '{{#each ${token}}}' -- rendering it whole would print '[object Object]' into the report.`,
  );
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `a list of ${value.length}`;
  if (typeof value === "object") return `an object (${Object.keys(value as object).join(", ") || "no keys"})`;
  return `a ${typeof value}`;
}

function mustResolve(token: string, scopes: readonly Scope[], form: string): unknown {
  const resolved = resolve(token, scopes);
  if (!resolved.found) {
    throw new TemplateError(
      `'${form.replace(" ", token)}' names '${token}', which the data document has not got. Every token a template names must be in the data -- a blank renders as a fact, so nen refuses the whole render rather than publishing a report with a hole in it. Run 'nen report render --dry-run' to list every token this template asks for.`,
    );
  }
  return resolved.value;
}

/** `.`, `@index`, or a dotted path against the scope chain. See the file header. */
export function resolve(token: string, scopes: readonly Scope[]): Resolved {
  const innermost = scopes.at(-1);
  /* c8 ignore next -- renderTemplate always seeds the chain with the root scope */
  if (innermost === undefined) return { found: false, value: undefined };

  if (token === ".") {
    return innermost.index === null ? { found: false, value: undefined } : { found: true, value: innermost.value };
  }
  if (token === "@index") {
    return innermost.index === null ? { found: false, value: undefined } : { found: true, value: innermost.index };
  }

  const segments = token.split(".");
  const head = segments[0] as string;
  for (let depth = scopes.length - 1; depth >= 0; depth -= 1) {
    const frame = scopes[depth] as Scope;
    if (!owns(frame.value, head)) continue;
    let current: unknown = frame.value;
    for (const segment of segments) {
      if (!owns(current, segment)) return { found: false, value: undefined };
      current = (current as Record<string, unknown>)[segment];
    }
    return { found: true, value: current };
  }
  return { found: false, value: undefined };
}

/**
 * Does this value carry this key AS ITS OWN?
 *
 * `Object.hasOwn` rather than `in` or a `!== undefined` test, for two different
 * reasons that both end in a wrong report: `in` walks the prototype chain, so
 * `{{constructor}}` would resolve on any object, and a `!== undefined` test
 * cannot tell a key holding `undefined` from an absent one -- which is the
 * distinction the whole unknown-token refusal rests on. An ARRAY is deliberately
 * not indexable by a token: `{{commits.0.sha}}` is a template reaching into a
 * position, and lists are for `{{#each}}`.
 */
function owns(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, key);
}

/**
 * The five characters, escaped in one pass.
 *
 * `&` FIRST, ALWAYS, or the escapes escape each other: a `<` replaced by `&lt;`
 * before the ampersand pass would come out as `&amp;lt;`.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
