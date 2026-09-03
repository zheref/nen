// src/issue/comment.ts -- the general-purpose comment primitive: post one
// caller-supplied comment on one issue.
//
// WHY IT EXISTS AT ALL. Every other verb in this family either reads, or writes
// text this binary composed itself (`file`'s create call, `consolidate-close`'s
// close message). Nothing could post a comment a CALLER wrote, so every skill
// that mechanised its choreography onto these verbs still had to drop back to a
// hand-run `gh issue comment <n> --body "<text>"` for the one step that says
// something in a human's own words (zheref/nen#29). That is not a missing
// convenience: a choreography with one hand-run `gh` call in the middle is a
// choreography whose middle step has no dry run, no refusal, and no seam -- so
// it is untested, unpreviewable and unreplayable exactly where it is
// irreversible.
//
// TWO SPELLINGS OF ONE INPUT, AND THE FAMILY IS DELIBERATELY INCONSISTENT HERE.
// `nen issue file` REFUSES an inline body ("a body typed on the command line is
// a body nobody reviewed") because an issue's opening body is a document. A
// comment is not: the call this verb exists to retire is literally
// `gh issue comment <n> --body "<text>"`, usually one sentence, and a verb that
// forced every one-line comment through a temp file would make the mechanised
// path MORE expensive than the hand-run one it replaces -- which is how a
// primitive gets routed around. So both spellings are accepted, exactly one at
// a time, on ../cli/inputs.ts's own "give exactly one, so the answer names the
// set it was computed from" rule. `nen wake fire --comment <text>` already set
// the inline precedent for a short, machine-composed comment.
//
// THE BODY IS READ AND CHECKED BEFORE ANYTHING IS POSTED, whichever spelling
// carried it, because "--dry-run prints exactly what would be posted" is only
// true if this module is holding the same bytes `gh` will send. A `--body-file`
// that does not exist, or holds nothing but whitespace, is refused here rather
// than surfacing as a `gh` error after the caller has already been told the
// dry run looked fine.
//
// ...BUT A FILE BODY IS HANDED TO `gh` AS A FILE. The bytes are read here for
// the check and the transcript; the argv still says `--body-file <path>` when
// that is how the caller supplied it. A body of any size on the command line is
// a body against the host's argv limit -- ~32k on Windows, which is one of this
// repository's three CI lanes -- and a comment is allowed to be far longer than
// that. Inline `--body` stays inline because the caller already put it on a
// command line to get here.
//
// A PULL-REQUEST NUMBER IS ACCEPTED, ON PURPOSE, AND THAT IS THE OPPOSITE OF
// WHAT zheref/nen#25 DECIDED FOR ITS OWN VERBS. GitHub numbers issues and pull
// requests in one sequence, and `POST .../issues/{n}/comments` -- the endpoint
// `gh issue comment` drives -- is where GitHub itself serves a pull request's
// conversation comments from. The distinction that makes #25's refusal right
// and a refusal here wrong is what the verb DOES with the number:
//
//   * `chain-position` and `terminus` CLASSIFY. Fed a pull request they ran
//     every test cleanly and answered something plausible and silently wrong,
//     with exit 0, and a caller routed real work off that answer. The wrongness
//     was invisible, so it had to be refused.
//   * `comment` does not classify. It posts the caller's text to the timeline
//     of the number it was handed, which is exactly what the caller asked for
//     on either object class, and it prints the resulting comment URL -- so a
//     mistyped number is visible in the transcript on the very next line rather
//     than hidden inside a verdict.
//
// Refusing here would also cost more than it protects: this family is the only
// place in the binary that can post a comment (there is no `nen pr comment`),
// so a guard would send every pull-request comment straight back to the raw
// `gh` call this verb exists to retire -- reinstating #29's gap for half the
// objects in the repository -- and would make the thinnest primitive in the
// family the only one that spends a second round trip (an extra `gh api` read)
// before it can do its one job. The decision is recorded here rather than left
// to be inferred, because silent acceptance and deliberate acceptance read
// identically in a diff.
//
// WHAT THIS VERB DOES *NOT* RETIRE, AND WHY THAT IS ALSO A DECISION. #29's
// workaround names two hand-run calls, not one: `gh issue comment <ref> --body`
// and `gh issue close <ref> --comment`. The first is fully retired here. The
// second is retired only INSIDE the consolidation choreography, where
// `nen issue consolidate-close` owns the close and now carries its own
// close-comment channel (./subissue.ts). A caller who wants to close ONE issue
// with a comment, outside a consolidation -- hatsu:file's "close with a comment
// naming this issue" is the live example -- still reaches for raw `gh`, or for
// `nen issue comment` followed by a raw `gh issue close`. There is deliberately
// no `nen issue close`.
//
// The reason is that closing is a judgement and commenting is not. Every close
// this family performs is the last step of a choreography that computed WHY the
// close is safe -- the label union, the severity maximum, and above all the
// open-PR guard, which refuses to orphan work in flight. A bare `nen issue
// close` would be that verb with all of its guards removed, wearing the same
// family name: the one shape of this surface that would make the mechanised
// path more dangerous than the hand-run call it replaces, rather than less. #29
// asks for a comment primitive and a per-child close-comment channel, and its
// Expected section asks for nothing beyond them; the third verb is left unbuilt
// on purpose, and said so here so that "not yet" and "not ever" are
// distinguishable to the next reader.

import { GH, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";

/** How the caller spelled the body. The argv differs; the bytes do not. */
export type BodySource = "inline" | "file";

interface CommentBase {
  readonly issue: number;
  /** The exact bytes that will be posted, whichever spelling carried them. */
  readonly body: string;
}

/**
 * A DISCRIMINATED UNION, so the file case cannot be constructed without its
 * path.
 *
 * The first shape of this was one interface with `source: BodySource` and
 * `bodyFile: string | null`, which made `{source: "file", bodyFile: null}` a
 * perfectly typed value that commentArgv had to paper over with `?? ""` -- an
 * argv reading `gh issue comment 12 --repo o/n --body-file` with an empty path,
 * failing open into a `gh` error rather than being impossible. No CLI path could
 * build it, which is the argument for deleting the state rather than for keeping
 * the fallback: an unreachable branch is one refactor away from being reachable,
 * and the `?? ""` is what makes that refactor silent.
 */
export type CommentRequest =
  | (CommentBase & { readonly source: "inline" })
  | (CommentBase & {
      readonly source: "file";
      /** The path as the caller typed it -- what `gh` is handed. */
      readonly bodyFile: string;
    });

/**
 * The `gh` call, built once and used by BOTH the dry run and the post -- so the
 * argv a caller approves in a dry run is the argv that runs, rather than a
 * rendering of it that a later edit can drift away from.
 */
export function commentArgv(target: Target, request: CommentRequest): readonly string[] {
  return [
    "issue",
    "comment",
    String(request.issue),
    "--repo",
    target.slug,
    ...(request.source === "file"
      ? ["--body-file", request.bodyFile]
      : ["--body", request.body]),
  ];
}

export interface CommentResult {
  /** The posted comment's URL, when `gh` printed one. */
  readonly url: string | null;
}

const COMMENT_URL = /https:\/\/\S+\/(?:issues|pull)\/\d+#issuecomment-\d+/;

/**
 * Post the comment and report where it landed.
 *
 * A MISSING URL IS NOT A FAILURE HERE, and that is the one place this differs
 * from ./file.ts's `fileIssue`. A create whose URL could not be read leaves the
 * caller with no issue number, so there is nothing to report as filed and it
 * throws. A comment whose URL could not be read has still been posted -- `gh`
 * exited 0 -- and throwing would tell the caller their write failed when it did
 * not, which is the one report that would make them post it a second time.
 */
export function postComment(seams: Seams, target: Target, request: CommentRequest): CommentResult {
  const argv = commentArgv(target, request);
  const result = seams.run(GH, argv);
  if (result.spawnFailed || result.code !== 0) {
    throw new Error(
      `could not comment on ${target.slug}#${request.issue}: ${
        outputLines(result.stderr).join(" ") || `exit ${result.code}`
      }`,
    );
  }
  const match = COMMENT_URL.exec(result.stdout);
  return { url: match === null ? null : match[0] };
}
