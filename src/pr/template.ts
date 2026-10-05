// src/pr/template.ts -- the `nen pr body-check` bootstrap (zheref/nen#239):
// when no `--requirements-from` file is given, derive a MINIMAL requirement
// set from the repository's own pull-request template, deterministically.
//
// THE LOCATIONS ARE GITHUB'S CONVENTION, NEVER A REPOSITORY'S NAME (§3). GitHub
// reads a default pull-request template named `pull_request_template.md`
// (any letter case) from the repository root, `.github/` or `docs/`, and a
// set of alternatives from a `PULL_REQUEST_TEMPLATE/` directory in those same
// three places. Those are a platform's fixed file names, the same kind of fact
// as `.git/`; nothing here names a repository, a section, or a convention one
// repository happens to follow. What the body must carry stays the template's
// own words: each of its headings becomes one requirement.
//
// ONE TEMPLATE, OR A REFUSAL -- NEVER A GUESS. The selection rule:
//   1. Every DEFAULT template file (a `pull_request_template.md`, any case, in
//      one of the three directories) is a candidate. Exactly one -> it is the
//      source; it is also what GitHub pre-fills a new PR with, so any
//      directory alternatives beside it are not the default and are ignored.
//      More than one (e.g. one in `.github/` and one at the root) -> AMBIGUOUS.
//   2. No default file -> every `*.md` file directly inside a
//      `PULL_REQUEST_TEMPLATE/` directory (any case) is a candidate. Exactly
//      one -> it is the source. More than one -> AMBIGUOUS: GitHub only picks
//      among them by a `?template=` query a body-check cannot see.
//   3. None at all -> NO TEMPLATE.
// Ambiguity and absence are both refusals the caller resolves by passing
// `--requirements-from`; neither is ever a silent skip, and neither picks a
// candidate by directory-listing order.
//
// The directory listing is matched case-insensitively against the real entry
// names, so a case-insensitive filesystem (where `PULL_REQUEST_TEMPLATE.md` and
// `pull_request_template.md` are one file) yields one candidate, and a
// case-sensitive one carrying both yields two -- which is ambiguous, honestly.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { BodyRequirement } from "./bodycheck.js";

/** The directories GitHub searches for a pull-request template, repo-relative ("" is the root). */
export const PR_TEMPLATE_HOMES: readonly string[] = [".github", "", "docs"];
const DEFAULT_TEMPLATE_NAME = "pull_request_template.md";
const ALTERNATIVES_FOLDER_NAME = "pull_request_template";

export type TemplateDiscovery =
  | { readonly kind: "found"; readonly path: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "none"; readonly searched: readonly string[] };

function entries(root: string, relative: string): readonly string[] {
  try {
    return readdirSync(relative === "" ? root : join(root, relative));
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function joinRelative(directory: string, name: string): string {
  return directory === "" ? name : `${directory}/${name}`;
}

/** Find the repository's pull-request template under `root`, per the rule above. */
export function discoverTemplate(root: string): TemplateDiscovery {
  const defaults: string[] = [];
  const alternatives: string[] = [];
  for (const directory of PR_TEMPLATE_HOMES) {
    for (const name of [...entries(root, directory)].sort()) {
      const relative = joinRelative(directory, name);
      const lower = name.toLowerCase();
      if (lower === DEFAULT_TEMPLATE_NAME && isFile(join(root, relative))) {
        defaults.push(relative);
      } else if (lower === ALTERNATIVES_FOLDER_NAME && isDirectory(join(root, relative))) {
        for (const inner of [...entries(root, relative)].sort()) {
          const innerRelative = `${relative}/${inner}`;
          if (inner.toLowerCase().endsWith(".md") && isFile(join(root, innerRelative))) {
            alternatives.push(innerRelative);
          }
        }
      }
    }
  }
  const pick = (candidates: readonly string[]): TemplateDiscovery | null => {
    if (candidates.length === 1) return { kind: "found", path: candidates[0] as string };
    if (candidates.length > 1) return { kind: "ambiguous", candidates };
    return null;
  };
  return (
    pick(defaults) ??
    pick(alternatives) ?? {
      kind: "none",
      searched: PR_TEMPLATE_HOMES.flatMap((directory): string[] => [
        joinRelative(directory, DEFAULT_TEMPLATE_NAME),
        joinRelative(directory, "PULL_REQUEST_TEMPLATE/*.md"),
      ]),
    }
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Each ATX heading of `template` (`#` .. `######`) as one requirement: the body
 * must carry a heading at the SAME level with the SAME text (letter case and
 * surrounding whitespace aside). Headings inside a fenced code block or an HTML
 * comment are template scaffolding, not sections, and are skipped; a leading
 * YAML front-matter block is skipped too. A heading repeated verbatim yields one
 * requirement. Setext headings (`===`/`---` underlines) are not read.
 */
export function deriveRequirements(template: string): BodyRequirement[] {
  const lines = template.replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, index): boolean => index > 0 && line.trim() === "---");
    if (close > 0) start = close + 1;
  }
  const requirements: BodyRequirement[] = [];
  const seen = new Set<string>();
  let fence: string | null = null;
  let inComment = false;
  for (const line of lines.slice(start)) {
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (fenceMatch !== null && fenceMatch[1]?.[0] === fence[0] && (fenceMatch[1]?.length ?? 0) >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch !== null) {
      fence = fenceMatch[1] as string;
      continue;
    }
    const commentOpen = line.indexOf("<!--");
    if (commentOpen >= 0 && !line.includes("-->", commentOpen + 4)) {
      // A line that OPENS a comment without closing it is skipped whole, and
      // so is every line up to the one that closes it.
      inComment = true;
      continue;
    }
    // The line must START as a heading; a line that starts with a comment is
    // an HTML block, never a heading. Inline comments AFTER the marker are
    // template guidance and are dropped from the heading's text.
    if (!/^ {0,3}#{1,6}[ \t]/.test(line)) continue;
    const heading = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line.replace(/<!--.*?-->/g, ""));
    if (heading === null) continue;
    const level = heading[1] as string;
    const text = (heading[2] as string).trim();
    if (text === "") continue;
    const pattern = `^ {0,3}${level}[ \\t]+${escapeRegExp(text).replace(/ +/g, "[ \\t]+")}(?:[ \\t]+#+)?[ \\t]*$`;
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    requirements.push({ name: `${level} ${text}`, pattern });
  }
  return requirements;
}

/** Read `relative` under `root` and derive its requirements. */
export function requirementsFromTemplate(root: string, relative: string): BodyRequirement[] {
  return deriveRequirements(readFileSync(join(root, relative), "utf8"));
}
