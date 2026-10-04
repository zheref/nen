// src/commit/write.ts -- `nen commit write`: validate a message file under
// the same rules `commit format` applies, optionally require a green build
// proof, and commit the index with it (zheref/nen#227; Hatsu's `kokusen`
// hand-rolled the `git commit`).
//
// ONE SET OF VALIDATORS, NOT A SECOND COPY OF THEIR RULES. The file is parsed
// by ../wc/messagefile.ts's `parseCommitMessageFile` -- the reader `wc
// squash` already uses -- and every `--trailer` is APPENDED TO THE TEXT
// before that read, so the composed message is validated whole: Conventional
// Commits shape through ../commit/format.ts's `validateCommitMessage`, the
// attribution-trailer policy through ../schema/workflow.ts's
// `attributionRefusalMessages`. Those are the two validators
// `messageFileRefusals` composes for `wc squash`; this verb composes them
// itself, with the ONE nen/workflow.json it has already loaded, because it
// needs that file for `commits.subjectCase` too -- asking
// `messageFileRefusals` would load it a second time, and a broken one would
// then throw before the message's own shape was ever reported. A trailer
// this verb accepted that `commit format` would refuse is the drift sharing
// the validators prevents.
//
// AND THE REPOSITORY'S `subject-case` RULE (zheref/nen#263) -- commitlint's
// own, or the one nen/workflow.json's `commits.subjectCase` declares, under
// the precedence ./commitlint.ts's header states -- through
// `subjectCaseFindings`, the one function `commit format` calls too, on the
// composed message's header exactly as it will be committed. The policy file
// is therefore read on every run here too, not only when a trailer could
// trip it. A level-2 break joins the shape reasons (exit 2); a level-1 break,
// a rule nen could not check, and the note saying which rule applied are
// handed to the caller's `warn` / `note` the moment they are known, so they
// are printed whether the commit then lands, is refused, or fails in git. It
// is asked here rather than in ../wc/messagefile.ts because that reader is
// `wc squash`'s too, and this change is scoped to the two `commit` verbs.
//
// AND THE REPOSITORY'S LINE-LENGTH RULES (zheref/nen#290) --
// commitlint's `body-max-line-length` and `footer-max-line-length`, read by
// ./bodywidth.ts from the same config -- through `lineLengthFindings`, the
// check `commit format` runs on the message it emits, with the body width
// nen/workflow.json's `commits.bodyMaxLineLength` declares under the same
// precedence. A level-2 rule, the declared width, and the 100 assumed for a
// body whose config nen cannot read join the shape reasons (exit 2, naming
// the line); level 1, and an unreadable footer (for reference only), are
// warnings. `format` WRAPS --body to the width first; this verb
// does not rewrite the caller's file -- it validates it, as it validates
// every other part of it.
//
// A BROKEN CONFIG IS REPORTED FIRST, AND WHOLE, EXACTLY AS `commit format`
// REPORTS IT. A nen/workflow.json that will not load and a .commitlintrc
// nen cannot read are both named -- one does not hide the other -- and
// whatever the message's own shape still says is reported after them; the
// exit is 1, because the repository's files are what is wrong. Only with
// both configs readable does a shape refusal decide the exit, at 2.
//
// THE PROOF GATE IS `commit check`'s OWN VERDICT (./check.ts's
// `proofVerdict`), asked and then acted on: `--require-proof <lane>` refuses
// the commit at exit 1 when the proof is absent, for another lane, or for a
// tree that has since moved. Without the flag nothing about proofs is read.
//
// THE ORDER IS REFUSE, THEN REFUSE, THEN WRITE: a broken config (exit 1, a
// fact about the repository's files, with any shape reason alongside), the
// message (exit 2, a fact about the invocation), the proof (exit 1, a fact
// about the tree), an empty
// index (exit 1, `nothing staged`), and only then `git commit -F` on a file
// nen writes under `.nen/` and removes afterwards -- a deterministic path so
// a test can name it, under the dot-prefixed directory so it is never
// committed by accident.
//
// AND THEN THE COMMIT IS READ BACK (zheref/nen#273). A hook running inside
// that `git commit` can append a trailer nen never saw, so on a real write
// `trailers` is what the WRITTEN commit carries, as git reads it -- no longer
// the message nen handed over -- and every refused key on it is `injected`,
// the verb's exit 3, with the commit left in place and never amended.
// ./readback.ts's header has the three rules and why both sides are read by
// git's own parser; an added key nothing refuses is a `note`, not a failure.

import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { parseCommitMessageFile } from "../wc/messagefile.js";
import { validateCommitMessage, type Trailer } from "./format.js";
import { proofVerdict } from "./check.js";
import { addedNote, admittedAdditions, readBack, sentTrailers, type InjectedFinding } from "./readback.js";
import { CommitlintConfigError, declaredSubjectCase, readSubjectCaseRule, subjectCaseFindings } from "./commitlint.js";
import { declaredBodyWidth, lineLengthFindings, readLineLengthRules } from "./bodywidth.js";
import { SchemaError } from "../schema/errors.js";
import { attributionRefusalMessages, loadWorkflow, type LoadedWorkflow } from "../schema/workflow.js";

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
  /**
   * Every trailer the commit carries, in order. On a real write it is READ
   * BACK from the written commit (zheref/nen#273), so a trailer a hook added
   * is here too; on a dry run it is the composed message's -- the file's own,
   * then the appended ones.
   */
  readonly trailers: readonly Trailer[];
  /**
   * Every refused key the written commit carries -- added by a hook, or
   * carried by the message where git's parser read a trailer nen's did not;
   * ./readback.ts's three rules. Non-empty is exit 3. `null` on a dry
   * run: nothing was written, so nothing was read back, and "not checked" is
   * never rendered as `[]`.
   */
  readonly injected: readonly string[] | null;
  readonly dryRun: boolean;
}

/** A config the repository carries that nen could not read: its nen/workflow.json, or its .commitlintrc. */
export type ConfigFailure = SchemaError | CommitlintConfigError;

export type WriteOutcome =
  /** A config nen could not read (every one, named), and whatever the message's shape still said. Exit 1. */
  | { readonly kind: "broken"; readonly failures: readonly ConfigFailure[]; readonly reasons: readonly string[] }
  | { readonly kind: "usage"; readonly reasons: readonly string[] }
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "done";
      readonly report: WriteReport;
      readonly lines: readonly string[];
      readonly message: string;
      /**
       * The read-back's refused keys, each with its source and rule, and the
       * policy they were judged against -- the exit-3 refusal's wording. Empty
       * and null on a dry run.
       */
      readonly findings: readonly InjectedFinding[];
      readonly policy: LoadedWorkflow | null;
      /** How to drop the written commit with the change still staged -- parent-aware; null when nothing is refused. */
      readonly undo: string | null;
    };

export interface WriteOptions {
  /** The message file's text, already read. */
  readonly messageText: string;
  /** Every `--trailer` as typed, in order. */
  readonly trailerFlags: readonly string[];
  readonly requireProof: string | null;
  readonly dryRun: boolean;
  /**
   * Called once per subject-case line that does not refuse -- a level-1
   * rule, or a rule nen could not read -- AS SOON AS IT IS KNOWN, before the
   * proof, the index or git is asked anything. A callback rather than a field
   * on the outcome because the path that most needs the line is the one with
   * no outcome: a `git commit` the repository's own hook refused, which throws.
   */
  readonly warn: (warning: string) => void;
  /** The same, for a line that is neither: which rule a verdict came from, or which declaration was not applied. */
  readonly note: (note: string) => void;
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
  // 1. THE CONFIGS AND THE MESSAGE, WHOLE: the flags' shape, then the
  // composed text under the shared validators, the one loaded policy, and the
  // subject-case check `commit format` runs. A broken config is exit 1 with
  // every fault named; otherwise a shape reason is exit 2.
  const { trailers: appended, reasons: flagReasons } = parseTrailerFlags(options.trailerFlags);
  if (flagReasons.length > 0) return { kind: "usage", reasons: flagReasons };
  const message = composeMessage(options.messageText, appended);
  const parsed = parseCommitMessageFile(message);
  const reasons: string[] = parsed.ok ? [...validateCommitMessage(parsed.value.input)] : [...parsed.reasons];
  const failures: ConfigFailure[] = [];
  let loaded: LoadedWorkflow | null = null;
  try {
    loaded = loadWorkflow(root);
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    failures.push(error);
  }
  try {
    if (loaded === null || !parsed.ok) {
      // No verdict is possible -- the declaration could not be read, or the
      // header has no subject -- but a broken .commitlintrc is still named
      // beside everything else, as `commit format` names it.
      readSubjectCaseRule(root);
      readLineLengthRules(root, null);
    } else {
      reasons.push(...attributionRefusalMessages(loaded, parsed.value.input.trailers.map((trailer): string => trailer.key)));
      const found = subjectCaseFindings(root, message.split("\n")[0] ?? "", declaredSubjectCase(loaded));
      for (const warning of found.warnings) options.warn(warning);
      for (const note of found.notes) options.note(note);
      reasons.push(...found.refusals);
      // The body's and footer's line lengths (zheref/nen#290), judged by the
      // one check `commit format` runs -- on the composed message as it will
      // be committed. This verb does NOT wrap: the file is the caller's
      // message, committed as written or refused, never rewritten.
      const width = lineLengthFindings(message, readLineLengthRules(root, declaredBodyWidth(loaded)));
      for (const warning of width.warnings) options.warn(warning);
      for (const note of width.notes) options.note(note);
      reasons.push(...width.refusals);
    }
  } catch (error) {
    if (!(error instanceof CommitlintConfigError)) throw error;
    failures.push(error);
  }
  if (failures.length > 0) return { kind: "broken", failures, reasons };
  if (reasons.length > 0) return { kind: "usage", reasons };
  /* c8 ignore next -- a message that did not parse has its parse reasons above */
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

  const report = (sha: string | null, written: readonly Trailer[] = trailers, injected: readonly string[] | null = null): WriteReport => ({
    contract: WRITE_CONTRACT,
    sha,
    subject,
    trailers: written,
    injected,
    dryRun: options.dryRun,
  });
  const messageLines = message.replace(/\n$/, "").split("\n").map((line): string => `  ${line}`);
  if (options.dryRun) {
    return {
      kind: "done",
      report: report(null),
      message,
      lines: [`would run: git commit -F ${COMMIT_MESSAGE_PATH}`, "message:", ...messageLines],
      findings: [],
      policy: loaded,
      undo: null,
    };
  }

  // 3a. THE SENT TRAILERS, BY GIT'S OWN PARSER (zheref/nen#273, hanten N2),
  // before anything is written: the read-back compares like with like, and a
  // git that cannot parse stops the verb with nothing committed.
  /* c8 ignore next -- `loaded` is null only when a failure returned above */
  if (loaded === null) throw new Error("the commit policy was not loaded before the write");
  const policy = loaded;
  const sent = sentTrailers(seams, root, message);

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
    // And the directory it sat in, when the message was its only occupant: a
    // `.nen/commit/` left behind is a directory nobody asked for (N15).
    try {
      rmdirSync(dirname(messagePath));
    } catch {
      /* not empty, or already gone -- either way not this verb's to force */
    }
  }
  const head = seams.run(GIT, ["rev-parse", "HEAD"], { cwd: root });
  if (head.code !== 0) throw new Error(`committed, but could not read the new commit's sha ('git rev-parse HEAD' failed: ${gitError(head.stderr, head.code)}).`);
  const sha = head.stdout.trim();

  // 5. THE READ-BACK (zheref/nen#273): what the commit actually carries,
  // against what nen sent and what the policy refuses. Never an amend.
  const back = readBack(seams, root, sha, sent, policy);
  const admitted = admittedAdditions(back);
  if (admitted.length > 0) options.note(addedNote(sha, admitted));
  return {
    kind: "done",
    report: report(sha, back.written, back.injected),
    message,
    lines: [`committed ${sha}: ${subject}`],
    findings: back.findings,
    policy,
    undo: back.findings.length === 0 ? null : undoLine(seams, root, back.root),
  };
}

/**
 * The way back from a refused commit, keeping the change staged -- PARENT-
 * AWARE (Copilot, NN-PR-#357). A ROOT commit has no `HEAD~1`, so the reset
 * every other commit is undone with fails there. On a branch, `git update-ref
 * -d HEAD` deletes the branch's only ref: the branch is unborn again and the
 * index -- the staged tree -- is untouched. On a detached HEAD there is no
 * branch to delete, and `git checkout --orphan <branch>` starts an unborn
 * branch over the same index. Which of the two is asked of `git symbolic-ref
 * -q HEAD` (exit 0 on a branch, 1 detached); anything else names both rather
 * than guessing.
 */
function undoLine(seams: Seams, root: string, isRoot: boolean): string {
  if (!isRoot) return "'git reset --soft HEAD~1' keeps the change staged";
  const head = seams.run(GIT, ["symbolic-ref", "-q", "HEAD"], { cwd: root });
  const onBranch = "'git update-ref -d HEAD' makes the branch unborn again with the change still staged";
  const detached = "on this detached HEAD, 'git checkout --orphan <branch>' starts an unborn branch over the same staged change";
  const prefix = "it is the ROOT commit, so there is no HEAD~1 to reset to: ";
  if (!head.spawnFailed && head.code === 0) return `${prefix}${onBranch} (${head.stdout.trim()})`;
  if (!head.spawnFailed && head.code === 1) return `${prefix}${detached}`;
  return `${prefix}on a branch, ${onBranch}; ${detached}`;
}
