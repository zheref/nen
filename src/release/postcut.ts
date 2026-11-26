import { plainLine } from "../cli/plain.js";
import type { PreflightCheck } from "./preflight.js";

export interface PostCutTag {
  readonly expectedCommit: string;
  readonly listing: string;
  readonly expectedIsCommit: boolean;
}

/** Read exact remote refs, preferring the peeled object for an annotated tag. */
export function postCutTagCheck(tag: string, input: PostCutTag): PreflightCheck {
  const name = "tag exists at expected commit", ref = `refs/tags/${tag}`, peeledRef = `${ref}^{}`;
  if (!input.expectedIsCommit) return {name, ok: false, detail: "expected SHA does not name a locally readable commit (Git 2.45+ with --no-lazy-fetch required; replacement objects and lazy fetch disabled)"};
  const malformed = (): PreflightCheck => ({name, ok: false, detail: "remote tag evidence is unreadable (malformed, duplicate or orphaned ref)"});
  const refs = new Map<string, string>();
  for (const line of input.listing.split(/\r?\n/)) {
    if (line === "") continue;
    const match = /^([0-9a-fA-F]{40})\t(refs\/tags\/[^\s]+)$/.exec(line);
    if (match === null) return malformed();
    const key = match[2]!, sha = match[1]!.toLowerCase();
    if (key !== ref && key !== peeledRef) continue;
    if (refs.has(key)) return malformed();
    refs.set(key, sha);
  }
  const direct = refs.get(ref), peeled = refs.get(peeledRef);
  if (direct === undefined && peeled !== undefined) return malformed();
  if (direct === undefined) return {name, ok: false, detail: `'${plainLine(tag)}' is absent from origin`};
  const actual = peeled ?? direct;
  const ok = actual === input.expectedCommit.toLowerCase();
  return {name, ok, detail: ok ? `'${plainLine(tag)}' resolves to expected commit ${actual}` : `'${plainLine(tag)}' resolves to another commit ${actual}; expected ${input.expectedCommit.toLowerCase()}`};
}
