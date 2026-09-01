// src/commit/format.ts -- Conventional Commits formatting, tensho §4.
//
// "THE MESSAGE SAYS WHAT CHANGED AND WHY, NOT WHAT FILES MOVED" is the skill's
// own instruction and it is judgment this module cannot enforce -- it validates
// SHAPE (a type from the declared set, a non-empty subject, a length bound),
// never CONTENT. Writing a good subject line stays with whoever is committing.
//
// TRAILERS ARE THE CALLER'S DATA, NEVER A LITERAL BAKED IN HERE. The skill's
// own convention is a specific trailer key naming a specific persona
// ("Bankai-Agent: ichigo") -- exactly the kind of literal §3 forbids in shipped
// code, and exactly why this module takes trailers as `{key, value}` pairs
// supplied by the caller rather than writing that key in. A caller serving the
// bankai-core convention passes `--trailer Bankai-Agent=ichigo`; a caller
// serving Akatsuki's own passes its own key. Neither is this binary's business
// to know by name.

export type CommitType = "feat" | "fix" | "chore" | "docs" | "refactor" | "test" | "perf" | "build" | "ci";

export const COMMIT_TYPES: readonly CommitType[] = [
  "feat",
  "fix",
  "chore",
  "docs",
  "refactor",
  "test",
  "perf",
  "build",
  "ci",
];

/** GitHub's own subject-line convenience truncates well past this; 72 is the Conventional-Commits-community convention this repo also follows. */
export const SUBJECT_LENGTH_LIMIT = 72;

export interface Trailer {
  readonly key: string;
  readonly value: string;
}

export interface CommitMessageInput {
  readonly type: CommitType;
  readonly scope: string | null;
  readonly breaking: boolean;
  readonly subject: string;
  /** Body paragraphs, in order. Each renders as its own paragraph, blank-line separated. */
  readonly body: readonly string[];
  readonly trailers: readonly Trailer[];
}

export function validateCommitMessage(input: CommitMessageInput): readonly string[] {
  const refusals: string[] = [];
  if (!COMMIT_TYPES.includes(input.type)) {
    refusals.push(`type '${input.type}' is not one of ${COMMIT_TYPES.join(", ")}`);
  }
  if (input.subject.trim() === "") {
    refusals.push("subject is empty");
  } else {
    const header = headerLine(input);
    if (header.length > SUBJECT_LENGTH_LIMIT) {
      refusals.push(`header line is ${header.length} characters, over the ${SUBJECT_LENGTH_LIMIT}-character convention: '${header}'`);
    }
    if (/[.!?]$/.test(input.subject.trim())) {
      refusals.push("subject ends with punctuation -- Conventional Commits subjects read as a sentence fragment, not a sentence");
    }
  }
  if (input.scope !== null && input.scope.trim() === "") {
    refusals.push("scope is present but empty -- omit it (null) rather than passing an empty string");
  }
  for (const trailer of input.trailers) {
    if (trailer.key.trim() === "") refusals.push("a trailer has an empty key");
    if (/:/.test(trailer.key)) refusals.push(`trailer key '${trailer.key}' contains ':' -- a trailer key is the part BEFORE the colon`);
  }
  return refusals;
}

function headerLine(input: CommitMessageInput): string {
  const scope = input.scope === null ? "" : `(${input.scope})`;
  const bang = input.breaking ? "!" : "";
  return `${input.type}${scope}${bang}: ${input.subject.trim()}`;
}

export function formatCommitMessage(input: CommitMessageInput): string {
  const parts: string[] = [headerLine(input)];
  const body = input.body.map((paragraph): string => paragraph.trim()).filter((paragraph): boolean => paragraph !== "");
  if (body.length > 0) {
    parts.push("");
    parts.push(body.join("\n\n"));
  }
  if (input.trailers.length > 0) {
    parts.push("");
    parts.push(input.trailers.map((trailer): string => `${trailer.key}: ${trailer.value}`).join("\n"));
  }
  return parts.join("\n");
}
