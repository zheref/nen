// src/shu/exit.ts -- the two exit codes this family adds to the CLI's published
// three, and the one error class that carries them.
//
// WHY 3 AND 4 EXIST AT ALL. ../index.ts publishes 0 success / 1 the verb's own
// failure / 2 a usage error, and a caller that retries branches on them. Two of
// this family's refusals fit none of the three, and collapsing either into an
// existing code makes an automated caller do the wrong thing:
//
//   * UNSUPPORTED HOST (3). A build system that ships only on macOS, asked for
//     on linux; a Windows-only one, asked for on macOS. Not 1, because a retry
//     wrapper would retry forever on a machine that can never satisfy the
//     request; not 2, because the invocation was CORRECT -- the
//     caller typed a real verb on a real lane, on the wrong computer. The code
//     is not invented here: ../supply/bootstrap.ts already publishes
//     `UNSUPPORTED_HOST: 3` for the same fact about the same kind of host.
//
//   * UNSUPPORTED VERB FOR THIS LANE (4). The declaration says, in the
//     repository's own sentence, that this lane has no such verb -- kro-pwa has
//     no `archive` because it is a PWA. Again not 2: the invocation was correct
//     and the answer is a fact about the repository, which is why the refusal
//     always quotes the declaration's own `why` rather than nen's guess. This
//     is the MAJORITY case across the seven stacks the family is designed for
//     (~44 of 70 cells), so it earns a code rather than a message.
//
//   * TOOL NOT INSTALLED (5). The seam already separates "the tool ran and said
//     no" from "the tool could not be started" (../seam/exec.ts's header, and
//     `CommandResult.spawnFailed`), and this is the code that carries that
//     distinction out to a caller. Exiting 1 for it would tell a developer with
//     no package manager on PATH that their build failed.
//
// A FAILED PRECONDITION IS 2, NOT A CODE OF ITS OWN, and that is deliberate: it
// is the one refusal a caller fixes by doing something first, which is the same
// shape as a missing flag. It shares 2 with a missing declaration, an unknown
// lane and an unsubstituted placeholder -- all of them "the request cannot be
// carried out as stated", all of them ../cli/command.ts's VerbUsageError.

/** Unsupported host: the verb is real, the machine cannot run it. */
export const EXIT_UNSUPPORTED_HOST = 3;

/** Unsupported verb for this lane: the declaration says this lane has none. */
export const EXIT_UNSUPPORTED_VERB = 4;

/** The declared program could not be started at all. */
export const EXIT_TOOL_NOT_INSTALLED = 5;

/**
 * `shu coverage --touched` measured nothing: the report parsed, the diff named
 * files, and not one of them joined to a row (zheref/nen#236).
 *
 * `coverage` ONLY, AND NOT 0 AND NOT 1. Exit 0 was the defect -- "0 of 58
 * matched" read as "measured and fine" to every caller branching on `$?` --
 * and 1 already means "the tool failed, or its report could not be read",
 * which is not this: the run passed and the report is sound, and what failed
 * is the JOIN between the report's paths and the diff's. A distinct code lets
 * a gate tell "fix the tests" from "fix the path shape". 6 because 3, 4 and 5
 * are this family's already; the bootstrap family's own 6 (a manifest fault)
 * is a different command's contract and never reaches `nen shu`.
 */
export const EXIT_COVERAGE_UNJOINED = 6;

/**
 * A refusal that exits with one of this family's own codes.
 *
 * It is NOT a VerbUsageError subclass on purpose: ../index.ts's `runFamily`
 * maps that class to 2 for every family, and inheriting it would make these
 * three codes depend on an `instanceof` ordering in a file that knows nothing
 * about them. The family catches this itself and returns the number.
 */
export class ShuRefusal extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "ShuRefusal";
    this.code = code;
  }
}
