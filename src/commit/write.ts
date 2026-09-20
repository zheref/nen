// src/commit/write.ts -- `nen commit write`: validate a message file under
// the same rules `commit format` applies, optionally require a green build
// proof, and commit the index with it (zheref/nen#227; Hatsu's `kokusen`
// hand-rolled the `git commit`).
//
// ONE VALIDATOR, NOT A SECOND COPY OF ITS RULES. The file is parsed by
// ../wc/messagefile.ts -- the reader `wc squash` already uses -- and every
// `--trailer` is APPENDED TO THE TEXT before that read, so the composed
// message is validated whole: Conventional Commits shape through
// ../commit/format.ts's `validateCommitMessage`, the attribution-trailer
// policy through ../schema/workflow.ts's `attributionRefusalMessages`. A
// trailer this verb accepted that `commit format` would refuse is the drift
// that sharing prevents.
//
// THE PROOF GATE IS `commit check`'s OWN VERDICT (./check.ts's
// `proofVerdict`), asked and then acted on: `--require-proof <lane>` refuses
// the commit at exit 1 when the proof is absent, for another lane, or for a
// tree that has since moved. Without the flag nothing about proofs is read.
//
// THE ORDER IS REFUSE, THEN REFUSE, THEN WRITE: the message (exit 2, a fact
// about the invocation), the proof (exit 1, a fact about the tree), an empty
// index (exit 1, `nothing staged`), and only then `git commit -F` on a file
// nen writes under `.nen/` and removes afterwards -- a deterministic path so
// a test can name it, under the dot-prefixed directory so it is never
// committed by accident.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { messageFileRefusals, parseCommitMessageFile } from "../wc/messagefile.js";
import type { Trailer } from "./format.js";
import { proofVerdict } from "./check.js";

export const WRITE_CONTRACT = "nen.commit.write/v0.1";

/** Where the composed message is written for `git commit -F`, repo-relative. */
export const COMMIT_MESSAGE_PATH = ".nen/commit/message.txt";

/** `Key: value` -- a key `[A-Za-z0-9][A-Za-z0-9-]*`, a colon, ONE space, a non-empty value; ../wc/messagefile.ts's own line shape. */
const TRAILER_FLAG = /^([A-Za-z0-9][A-Za-z0-9-]*): (\S.*)$/;

/** KEY ORDER IS THE CONTRACT; ./command.test.ts pins it. */
export interface WriteReport {
  readonly contract: string;
  /** The new commit, or null on a dry run. */
  readonly sha: string | null;
  readonly subject: string;
  /** Every trailer the committed message carries -- the file's own and the appended ones, in order. */
  readonly trailers: readonly Trailer[];
  readonly dryRun: boolean;
}

export type WriteOutcome =
  | { readonly kind: "usage"; readonly reasons: readonly string[] }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "done"; readonly report: WriteReport; readonly lines: readonly string[]; readonly message: string };

export interface WriteOptions {
  /** The message file's text, already read. */
  readonly messageText: string;
  /** Every `--trailer` as typed, in order. */
  readonly trailerFlags: readonly string[];
  readonly requireProof: string | null;
  readonly dryRun: boolean;
}

/** Each `--trailer` parsed, or the reasons the shape refused. */
export function parseTrailerFlags(flags: readonly string[]): { readonly trailers: readonly Trailer[]; readonly reasons: readonly string[] } {
  const trailers: Trailer[] = [];
  const reasons: string[] = [];
  for (const flag of flags) {
    const match = TRAILER_FLAG.exec(flag);
    if (match === null) {
      reasons.push(`--trailer '${flag}' is not 'Key: value' -- a key of letters, digits and '-', a colon, ONE space, then the value`);
      continue;
    }
    trailers.push({ key: match[1] as string, value: match[2] as string });
  }
  return { trailers, reasons };
}

/**
 * The file's text with the trailers appended: onto the existing trailer
 * block when the file ends in one, as a new final paragraph otherwise. The
 * decision is ../wc/messagefile.ts's, asked rather than guessed.
 */
export function composeMessage(text: string, trailers: readonly Trailer[]): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (trailers.length === 0) return `${normalized}\n`;
  const parsed = parseCommitMessageFile(normalized);
  const endsInTrailers = parsed.ok && parsed.value.input.trailers.length > 0;
  const block = trailers.map((trailer): string => `${trailer.key}: ${trailer.value}`).join("\n");
  return `${normalized}${endsInTrailers ? "\n" : "\n\n"}${block}\n`;
}

function gitError(stderr: string, code: number): string {
  return outputLines(stderr).join(" ") || `exit ${code}`;
}

export function write(seams: Seams, root: string, options: WriteOptions): WriteOutcome {
  // 1. THE MESSAGE, WHOLE: the flags' shape, then the composed text under the
  // one validator. Exit 2 -- the invocation is what is wrong.
  const { trailers: appended, reasons: flagReasons } = parseTrailerFlags(options.trailerFlags);
  if (flagReasons.length > 0) return { kind: "usage", reasons: flagReasons };
  const message = composeMessage(options.messageText, appended);
  const shapeReasons = messageFileRefusals(root, message); // throws SchemaError on a malformed policy
  if (shapeReasons.length > 0) return { kind: "usage", reasons: shapeReasons };
  const parsed = parseCommitMessageFile(message);
  /* c8 ignore next -- messageFileRefusals has just proved the message parses */
  if (!parsed.ok) return { kind: "usage", reasons: parsed.reasons };
  const subject = message.split("\n")[0] ?? "";
  const trailers = parsed.value.input.trailers;

  // 2. THE PROOF, when one is required. Exit 1 -- the tree is what is wrong.
  if (options.requireProof !== null) {
    const verdict = proofVerdict(seams, root, options.requireProof);
    if (!verdict.ok) {
      return { kind: "refused", reason: `refusing to commit over a build that is not proved: ${verdict.difference ?? ""}` };
    }
  }

  // 3. SOMETHING MUST BE STAGED. `git diff --cached --quiet` exits 0 when the
  // index equals HEAD, 1 when it does not, and anything else is git failing.
  const staged = seams.run(GIT, ["diff", "--cached", "--quiet"], { cwd: root });
  if (staged.spawnFailed || staged.code > 1) {
    throw new Error(`could not read the index ('git diff --cached --quiet' failed: ${gitError(staged.stderr, staged.code)}).`);
  }
  if (staged.code === 0) {
    return { kind: "refused", reason: "nothing staged: the index equals HEAD, so there is nothing to commit. Stage the change first ('git add'), then run this again." };
  }

  const report = (sha: string | null): WriteReport => ({ contract: WRITE_CONTRACT, sha, subject, trailers, dryRun: options.dryRun });
  const messageLines = message.replace(/\n$/, "").split("\n").map((line): string => `  ${line}`);
  if (options.dryRun) {
    return {
      kind: "done",
      report: report(null),
      message,
      lines: [`would run: git commit -F ${COMMIT_MESSAGE_PATH}`, "message:", ...messageLines],
    };
  }

  // 4. THE WRITE. The message file lands under .nen/ and is removed after the
  // commit whatever git answered: a stale message file is a message file
  // somebody will commit twice.
  const messagePath = join(root, ...COMMIT_MESSAGE_PATH.split("/"));
  mkdirSync(dirname(messagePath), { recursive: true });
  writeFileSync(messagePath, message, "utf8");
  try {
    const commit = seams.run(GIT, ["commit", "-F", COMMIT_MESSAGE_PATH], { cwd: root });
    if (commit.spawnFailed || commit.code !== 0) {
      throw new Error(`'git commit -F ${COMMIT_MESSAGE_PATH}' failed: ${gitError(commit.stderr, commit.code)}. Nothing was committed; the index is as you staged it.`);
    }
  } finally {
    if (existsSync(messagePath)) rmSync(messagePath, { force: true });
  }
  const head = seams.run(GIT, ["rev-parse", "HEAD"], { cwd: root });
  if (head.code !== 0) throw new Error(`committed, but could not read the new commit's sha ('git rev-parse HEAD' failed: ${gitError(head.stderr, head.code)}).`);
  const sha = head.stdout.trim();
  return { kind: "done", report: report(sha), message, lines: [`committed ${sha}: ${subject}`] };
}
