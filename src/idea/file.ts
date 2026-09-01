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

import { lines, type Runner } from "../exec/seam.js";
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

function readIssueForVerification(runner: Runner, target: Target, number: number): ReadBack {
  const result = runner.run({
    bin: "gh",
    args: ["issue", "view", String(number), "--repo", target.slug, "--json", "title,body,labels"],
  });
  if (result.code !== 0) {
    throw new FileIdeaError(
      `idea filed as #${number}, but the read-back could not confirm it: ${
        (result.spawnError ?? lines(result.stderr).join(" ")) || `exit ${result.code}`
      }. The issue exists; verify it by hand.`,
    );
  }
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
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
  runner: Runner,
  target: Target,
  request: FileRequest,
  submittedBody: string,
  taxonomy: LabelTaxonomy,
): { readonly refusals: readonly { readonly reason: string }[] } | FileIdeaResult {
  const refusals = validateFiling(request, taxonomy);
  if (refusals.length > 0) return { refusals };

  const filed = fileIssue(runner, target, request);
  const readBack = readIssueForVerification(runner, target, filed.number);
  const mismatches = compareReadBack(request, submittedBody, readBack);
  return { filed, readBack, mismatches };
}
