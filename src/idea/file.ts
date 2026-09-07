// src/idea/file.ts -- `nen idea file`: file an idea issue, THEN read it back
// and verify GitHub actually stored what was submitted.
//
// WHY A READ-BACK, AND NOT JUST TRUSTING THE CREATE CALL'S OWN EXIT CODE. A
// `gh issue create` that exits 0 has confirmed the REQUEST succeeded; it has
// not confirmed the STORED issue matches what was sent. GitHub itself is the
// only source of truth for what a reader will see -- a body silently
// re-rendered, a label the create call raced against a rename, a title
// GitHub trimmed -- and the cheapest way to catch any of that is to ask
// GitHub back rather than assume the request and the record agree. An idea
// is meant to be picked up by a routing sweep on nothing but its labels and
// title; a silent mismatch there is invisible until someone reads the issue
// by hand and wonders why it was never picked up.
//
// THIS REUSES ../issue/file.ts'S OWN CHOREOGRAPHY -- validate, then create,
// labels and assignee IN the call -- rather than reimplementing it. The one
// thing this module adds is the verification step after.

import { GH, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import { fileIssue, validateFiling, type FileRequest, type FileResult } from "../issue/file.js";
import type { LabelTaxonomy } from "../schema/labels.js";

export interface ReadBack {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export interface Mismatch {
  readonly field: "title" | "body" | "labels";
  readonly expected: string;
  readonly actual: string;
}

export interface FileIdeaResult {
  readonly filed: FileResult;
  readonly readBack: ReadBack;
  readonly mismatches: readonly Mismatch[];
}

export class FileIdeaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileIdeaError";
  }
}

// THE READ-BACK IS A REST READ, AND THAT IS WHAT MAKES THE OBJECT CLASS
// VISIBLE (zheref/nen#77).
//
// It used to be `gh issue view <n> --json title,body,labels`, which answers
// with the three fields compared below and NOTHING that says which class of
// object answered -- `--json pull_request` does not exist on that command; it
// errors on every object (zheref/nen#25). Issues and pull requests share one
// number sequence and one `issues/{n}` endpoint, so `gh api` returns the same
// three fields AND the `pull_request` discriminator in the same single call,
// which is the same reason ../issue/subissue.ts's `readIssue` is a REST read.
// No extra round trip was added to gain the check.
//
// AND A PULL REQUEST HERE IS NOT A CALLER'S MISTAKE -- IT IS A BROKEN PROOF.
// This verb has just CREATED an issue and is reading back the number that
// creation returned, so there is no number for a caller to have mistyped: if
// that number answers as a pull request, the verification fetch reached a
// DIFFERENT object than the one filed, and every field compared below is being
// compared against the wrong record. Both outcomes of that comparison are
// worthless and one of them is dangerous -- a mismatch report that describes
// an object nobody filed, or, if the fields happen to agree, a confident
// "read-back OK" certifying a record this run never saw. The whole value of
// this module is the read-back proof (see the header), so it fails LOUDLY, in
// the same channel the unreadable-response failure already uses, rather than
// rendering a verdict it cannot support.
function readIssueForVerification(seams: Seams, target: Target, number: number): ReadBack {
  const result = seams.run(GH, ["api", `repos/${target.slug}/issues/${number}`]);
  if (result.code !== 0) {
    throw new FileIdeaError(
      `idea filed as #${number}, but the read-back could not confirm it: ${
        outputLines(result.stderr).join(" ") || `exit ${result.code}`
      }. The issue exists; verify it by hand.`,
    );
  }
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  const rawPullRequest = parsed["pull_request"];
  // An explicit `null` counts as ABSENT, i.e. as an issue -- the same
  // predicate ../issue/subissue.ts's `readIssue` uses, and its note records
  // why: real GitHub sends the key absent on an issue and as an OBJECT on a
  // pull request, never as null, while `pull_request: {}` and a payload with
  // no usable fields already fail closed. The two sites are kept identical on
  // purpose; a divergence here would mean the same payload is one class in
  // this verb and another one verb over.
  if (rawPullRequest !== undefined && rawPullRequest !== null) {
    throw new FileIdeaError(
      `idea filed as #${number}, but the read-back answered with a PULL REQUEST, not an issue -- so it confirms ` +
        "nothing about the issue that was just filed. Issues and pull requests share one number sequence and one " +
        "issues/{n} endpoint, and this verb never asks for a number, so this read reached a different object than " +
        "the one it created: comparing title, body and labels against it would report either a mismatch about a " +
        "record nobody filed, or -- worse -- a match. The issue exists; verify it by hand.",
    );
  }
  const rawLabels = parsed["labels"];
  const labelList = Array.isArray(rawLabels)
    ? rawLabels
        .map((label): string => String((label as Record<string, unknown>)["name"] ?? ""))
        .filter((name): boolean => name !== "")
    : [];
  return {
    title: String(parsed["title"] ?? ""),
    body: String(parsed["body"] ?? ""),
    labels: labelList,
  };
}

// CRLF-normalized before comparison, and ONLY CRLF-normalized: GitHub always
// stores LF, and a body read from a Windows-checked-out file would otherwise
// mismatch on line endings alone -- a false positive this verb exists to
// avoid, not manufacture. Nothing else is normalized here. This function's
// whole value IS the read-back proof -- the verb's job is to confirm GitHub
// stored the body as submitted -- so a comparison looser than that advertised
// single exception (trimming whitespace, collapsing blank lines, ...) would
// hide a real mismatch (trailing spaces, a leading blank line, ...) behind a
// confident match. If GitHub's own storage behavior is ever found to require
// a second normalization, it must be named explicitly here AND in the
// mismatch report below, never folded into this function silently.
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function compareReadBack(
  request: FileRequest,
  submittedBody: string,
  readBack: ReadBack,
): readonly Mismatch[] {
  const mismatches: Mismatch[] = [];
  if (readBack.title !== request.title) {
    mismatches.push({ field: "title", expected: request.title, actual: readBack.title });
  }
  if (normalize(readBack.body) !== normalize(submittedBody)) {
    mismatches.push({ field: "body", expected: normalize(submittedBody), actual: normalize(readBack.body) });
  }
  const expectedLabels = [...request.labels].sort();
  const actualLabels = [...readBack.labels].sort();
  if (JSON.stringify(expectedLabels) !== JSON.stringify(actualLabels)) {
    mismatches.push({ field: "labels", expected: expectedLabels.join(","), actual: actualLabels.join(",") });
  }
  return mismatches;
}

export function fileIdea(
  seams: Seams,
  target: Target,
  request: FileRequest,
  submittedBody: string,
  taxonomy: LabelTaxonomy,
): { readonly refusals: readonly { readonly reason: string }[] } | FileIdeaResult {
  const refusals = validateFiling(request, taxonomy);
  if (refusals.length > 0) return { refusals };

  const filed = fileIssue(seams, target, request);
  const readBack = readIssueForVerification(seams, target, filed.number);
  const mismatches = compareReadBack(request, submittedBody, readBack);
  return { filed, readBack, mismatches };
}
