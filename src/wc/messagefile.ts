// src/wc/messagefile.ts -- parsing and shape-checking a commit-message FILE
// for `nen wc squash --message-file`, to the SAME shape `nen commit format`
// enforces (../commit/format.ts) plus the SAME attribution-trailer policy it
// reads from nen/workflow.json (../schema/workflow.ts).
//
// WHY A SEPARATE PARSER FROM ../commit/format.ts RATHER THAN A SECOND COPY OF
// ITS RULES. That module FORMATS a message from typed parts a caller already
// has (--type, --subject, --trailer=...); this module goes the other way,
// turning a raw FILE a caller already wrote (or a template rendered) back
// into those same parts, so both share ONE validator
// (validateCommitMessage) and ONE attribution-policy reader
// (attributionRefusalMessages) instead of this binary carrying two answers to
// "what does a well-formed commit message look like".
//
// TRAILERS ARE THE LAST PARAGRAPH, AND ONLY WHEN EVERY LINE OF IT IS
// `Key: value`-SHAPED -- the same convention `git interpret-trailers` and
// every other tool that reads a finished commit already assumes. A file
// whose last paragraph is ordinary prose that happens not to match is body,
// not a malformed trailer block: this module never guesses that a paragraph
// was MEANT as trailers, it only recognizes one that unambiguously is.

import { COMMIT_TYPES, validateCommitMessage, type CommitMessageInput, type CommitType, type Trailer } from "../commit/format.js";
import { attributionRefusalMessages, loadWorkflow } from "../schema/workflow.js";

/**
 * `type(scope)!: subject` -- Conventional Commits' own header grammar.
 *
 * THE SPACE AFTER THE COLON IS LITERAL AND REQUIRED, not `\s?`. ../commit/
 * format.ts's own `headerLine` always renders exactly one -- `${type}${scope}
 * ${bang}: ${subject.trim()}` -- so a file this module accepts is a file that
 * shape could actually have produced; `feat:subject` with no space at all is
 * not that shape, and letting it through would validate a header nobody who
 * followed the documented grammar would ever write (review finding).
 */
const HEADER = /^([A-Za-z]+)(\(([^)]*)\))?(!)?: (.*)$/;

/**
 * One trailer line: a key `[A-Za-z0-9][A-Za-z0-9-]*`, a colon, ONE LITERAL
 * SPACE, a value -- not `\s`, which also matches a tab. ../commit/format.ts's
 * own trailer rendering is `${key}: ${value}`, always a single space, so the
 * same argument as HEADER's applies: a tab-separated line is not a shape
 * `nen commit format` ever produces (review finding).
 */
const TRAILER_LINE = /^[A-Za-z0-9][A-Za-z0-9-]*: .+$/;

export interface ParsedCommitMessage {
  readonly input: CommitMessageInput;
}

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedCommitMessage }
  | { readonly ok: false; readonly reasons: readonly string[] };

/** Contiguous non-blank lines, blank lines as separators, blank runs collapsed. */
function splitParagraphs(lines: readonly string[]): string[][] {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) {
        paragraphs.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) paragraphs.push(current);
  return paragraphs;
}

/**
 * Parse a raw commit-message file's TEXT into the same `CommitMessageInput`
 * shape ../commit/format.ts's `validateCommitMessage` already knows how to
 * check -- never the shape check itself, which stays in that one module.
 */
export function parseCommitMessageFile(raw: string): ParseResult {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  // Drop trailing blank lines a text editor or a rendered template leaves --
  // punctuation of the FILE FORMAT, never a paragraph of the message.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  if (lines.length === 0 || (lines[0]?.trim() ?? "") === "") {
    return { ok: false, reasons: ["the message file is empty"] };
  }

  const header = lines[0] ?? "";
  const match = HEADER.exec(header);
  if (match === null) {
    return {
      ok: false,
      reasons: [
        `the first line '${header}' does not look like a Conventional Commits header ('type(scope)!: subject') -- expected one of ${COMMIT_TYPES.join(", ")}, optionally '(scope)', optionally '!', then ': ' and a subject`,
      ],
    };
  }
  const type = (match[1] ?? "") as CommitType;
  const scope = match[3] === undefined || match[3] === "" ? null : match[3];
  const breaking = match[4] === "!";
  const subject = match[5] ?? "";

  const rest = lines.slice(1);
  // A single blank line right after the header is the header/body separator
  // Conventional Commits itself expects, not a paragraph of its own.
  const afterHeader = rest.length > 0 && rest[0] === "" ? rest.slice(1) : rest;
  const paragraphs = splitParagraphs(afterHeader);

  let trailers: Trailer[] = [];
  let bodyParagraphs = paragraphs;
  const last = paragraphs[paragraphs.length - 1];
  if (last !== undefined && last.every((line): boolean => TRAILER_LINE.test(line))) {
    trailers = last.map((line): Trailer => {
      const index = line.indexOf(":");
      return { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
    });
    bodyParagraphs = paragraphs.slice(0, -1);
  }

  const input: CommitMessageInput = {
    type,
    scope,
    breaking,
    subject,
    body: bodyParagraphs.map((paragraph): string => paragraph.join("\n")),
    trailers,
  };
  return { ok: true, value: { input } };
}

/**
 * Every reason a message FILE fails the shape `nen commit format` enforces:
 * an unparseable header, a shape violation `validateCommitMessage` already
 * catches (unknown type, empty/over-length/punctuated subject, a malformed
 * trailer key), or an attribution trailer this repository's
 * nen/workflow.json does not admit -- the SAME three questions `nen commit
 * format` answers, asked of a file instead of a `--trailer` flag.
 *
 * THROWS the underlying SchemaError when `root`'s own nen/workflow.json is
 * present and malformed, exactly as ../commit/command.ts's own policy read
 * does: a message shaped under a policy nen could not read is a message
 * nobody actually checked, which is worse than refusing outright.
 */
export function messageFileRefusals(root: string, raw: string): readonly string[] {
  const parsed = parseCommitMessageFile(raw);
  if (!parsed.ok) return parsed.reasons;
  const refusals: string[] = [...validateCommitMessage(parsed.value.input)];
  if (parsed.value.input.trailers.length > 0) {
    const loaded = loadWorkflow(root); // throws SchemaError on a malformed file
    refusals.push(
      ...attributionRefusalMessages(
        loaded,
        parsed.value.input.trailers.map((trailer): string => trailer.key),
      ),
    );
  }
  return refusals;
}
