// src/issue/privacy.testkit.ts -- the private-name guard's two reads, as the
// guarded verbs' tests answer them (zheref/nen#329, #363).
//
// TEST-ONLY: vitest collects `*.test.ts` only, and no shipped module imports
// this one (the same convention as ../runner/testkit.ts).
//
// Every guarded verb reads its target's visibility before any write, and a
// public target's private list after that. A test about something else gets
// the first read answered "private" -- so the guard skips and reads no list --
// and that read is never recorded, so the test keeps asserting the calls ITS
// behaviour makes. A test about the guard scripts both reads itself with the
// rows below.

import type { ScriptedCall } from "../seam/scripted.js";
import type { CommandResult, RunOptions, Seams } from "../seam/exec.js";

/** The one page of the private list a short list fills. */
export const PRIVATE_LIST_PAGE = "gh api user/repos?visibility=private&per_page=100&page=1";

/** `gh api repos/<slug>` answering a visibility. */
export function visibilityRow(slug: string, visibility: "public" | "private" | "internal"): ScriptedCall {
  return { match: `gh api repos/${slug}`, result: { stdout: JSON.stringify({ visibility }) } };
}

/** The credential-reach read the guard makes before the list (zheref/nen#363, Feitan F7). */
export const SCOPES_CALL = "gh api -i user";

/** A classic token whose scopes include `repo`: the list it returns is the whole list. */
export const FULL_REACH_ROW: ScriptedCall = {
  match: SCOPES_CALL,
  result: { stdout: "HTTP/2.0 200 OK\nX-Oauth-Scopes: gist, read:org, repo\n\n{}" },
};

/** The private list's first page, holding exactly these `owner/name`s. */
export function privateListRow(names: readonly string[]): ScriptedCall {
  return {
    match: PRIVATE_LIST_PAGE,
    result: { stdout: JSON.stringify(names.map((full_name): { full_name: string } => ({ full_name }))) },
  };
}

/** The private list failing to read -- the guard must refuse, never pass. */
export const UNREADABLE_PRIVATE_LIST: ScriptedCall = { match: PRIVATE_LIST_PAGE, result: { code: 1, stderr: "HTTP 401: Bad credentials" } };

/**
 * `seams`, with `gh api repos/<slug>` answered "private" and NOT recorded.
 * Every other call reaches `seams` unchanged, so an unscripted one still
 * throws exactly as it would have. The wrapper inherits from `seams`, so a
 * ScriptedSeams' own `calls` log is the one the test reads.
 */
export function withPrivateTarget(seams: Seams, slug: string): Seams {
  const wrapped = Object.create(seams) as Seams;
  Object.defineProperty(wrapped, "run", {
    value: (command: string, args: readonly string[], options?: RunOptions): CommandResult =>
      command === "gh" && args.length === 2 && args[0] === "api" && args[1] === `repos/${slug}`
        ? { code: 0, stdout: JSON.stringify({ visibility: "private" }), stderr: "", spawnFailed: false }
        : seams.run(command, args, options),
  });
  return wrapped;
}
