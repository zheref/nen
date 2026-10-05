// src/pr/template.ts -- the `nen pr body-check` bootstrap (zheref/nen#239):
// when no `--requirements-from` file is given, derive a MINIMAL requirement
// set from the repository's own pull-request template, deterministically, and
// check a body against it.
//
// THE LOCATIONS ARE GITHUB'S CONVENTION, NEVER A REPOSITORY'S NAME (§3). GitHub
// reads a default pull-request template named `pull_request_template` with a
// `.md` or `.txt` extension (any letter case) from the repository root,
// `.github/` or `docs/`, and a set of alternatives from a
// `PULL_REQUEST_TEMPLATE/` directory in those same three places. Those are a
// platform's fixed file names, the same kind of fact as `.git/`; nothing here
// names a repository, a section, or a convention one repository happens to
// follow. What the body must carry stays the template's own words: each of its
// headings becomes one requirement.
//
// ONE TEMPLATE, OR A REFUSAL -- NEVER A GUESS. The selection rule:
//   1. Every DEFAULT template file in one of the three directories is a
//      candidate. Exactly one -> it is the source; it is also what GitHub
//      pre-fills a new PR with, so any directory alternatives beside it are not
//      the default and are ignored. More than one -> AMBIGUOUS.
//   2. No default file -> every `.md`/`.txt` file directly inside a
//      `PULL_REQUEST_TEMPLATE/` directory (any case) is a candidate. Exactly
//      one -> it is the source. More than one -> AMBIGUOUS: GitHub only picks
//      among them by a `?template=` query a body-check cannot see.
//   3. None at all -> NO TEMPLATE.
// Ambiguity and absence are both refusals the caller resolves by passing
// `--requirements-from`; neither is ever a silent skip, and neither picks a
// candidate by directory-listing order.
//
// WHERE THE TEMPLATE IS READ FROM IS THE CALLER'S CHOICE, AND IT IS NAMED.
// Without `--base` the working tree under `--repo` is read; a PR's own head can
// edit that template, so a gate passes `--base <ref>` and the template is read
// from git at that ref instead (the zheref/nen#249 precedent: a PR is never
// judged by a policy it can rewrite). The working-tree reader refuses a
// template whose real path leaves the root (a symlink pointing elsewhere); the
// git reader never follows a symlink at all.

import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep, win32 } from "node:path";

import { VerbUsageError } from "../cli/command.js";
import { readTextFile } from "../cli/inputs.js";
import { GIT, ToolError, type Seams } from "../seam/exec.js";
import type { BodyRequirement, RequirementResult } from "./bodycheck.js";

/** The directories GitHub searches for a pull-request template, repo-relative ("" is the root). */
export const PR_TEMPLATE_HOMES: readonly string[] = [".github", "", "docs"];
const DEFAULT_TEMPLATE = /^pull_request_template\.(md|txt)$/i;
const ALTERNATIVES_FOLDER = /^pull_request_template$/i;
const ALTERNATIVE_FILE = /\.(md|txt)$/i;

export interface TemplateEntry {
  readonly name: string;
  /** `symlink` is only ever reported at a ref; the working tree follows links and checks where they land. */
  readonly kind: "file" | "directory" | "symlink" | "other";
}

/** Where a template is listed and read from: the working tree, or git at one ref. */
export interface TemplateReader {
  /** The ref read at, or null for the working tree. */
  readonly ref: string | null;
  /** The full commit oid `ref` resolved to, or null for the working tree. */
  readonly commit: string | null;
  /** The entries of one repo-relative directory ("" is the root); [] when it does not exist. */
  list(directory: string): readonly TemplateEntry[];
  /** One repo-relative file's text. Refuses (exit 2) rather than returning nothing. */
  read(relative: string): string;
}

/** "in the working tree" or "at <ref>" -- where `reader` reads, in words. */
export function describeReader(reader: TemplateReader): string {
  return reader.ref === null || reader.commit === null ? "in the working tree" : `at ${reader.ref} (${reader.commit.slice(0, 7)})`;
}

const TEMPLATE_READ_RATIONALE =
  "It is the pull-request template body-check derives its requirements from; pass --requirements-from <path> to check against a file instead.";

/**
 * Is `file` (a real path) inside `root` (a real path)? On Windows the
 * filesystem is case-insensitive and either separator may appear, so the
 * comparison folds case and separators there; elsewhere it is exact.
 */
export function isContained(root: string, file: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") {
    const fold = (path: string): string => win32.normalize(path).toLowerCase();
    const base = fold(root);
    return fold(file).startsWith(base.endsWith(win32.sep) ? base : base + win32.sep);
  }
  return file.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The working tree under `root`. */
export function workingTreeReader(root: string): TemplateReader {
  const kindOf = (path: string): TemplateEntry["kind"] => {
    try {
      const stat = statSync(path);
      return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
    } catch {
      return "other";
    }
  };
  return {
    ref: null,
    commit: null,
    list(directory: string): readonly TemplateEntry[] {
      const absolute = directory === "" ? root : join(root, directory);
      try {
        return readdirSync(absolute).map((name): TemplateEntry => ({ name, kind: kindOf(join(absolute, name)) }));
      } catch {
        return [];
      }
    },
    read(relative: string): string {
      const full = join(root, relative);
      // A SYMLINK MAY POINT OUTSIDE THE ROOT. The template is this repository's
      // declaration, so a file whose real path leaves the repository is not
      // one, and is refused by name rather than read.
      let realRoot: string;
      let realFile: string;
      try {
        realRoot = realpathSync(root);
        realFile = realpathSync(full);
      } catch {
        // Unresolvable: readTextFile names the file and the errno, at exit 2.
        return readTextFile(full, root, TEMPLATE_READ_RATIONALE);
      }
      if (!isContained(realRoot, realFile)) {
        throw new VerbUsageError(
          `the pull-request template '${relative}' resolves to '${realFile}', outside the repository root '${realRoot}'. Nen will not read a template from outside the repository. Pass --requirements-from <path>, or replace the link with the file.`,
        );
      }
      return readTextFile(full, root, TEMPLATE_READ_RATIONALE);
    },
  };
}

/**
 * The git environment a caller's shell may carry that would point these reads
 * at some OTHER repository, index or object store than the checkout at `root`
 * -- every one unset on every git call here. (../surface/command.ts carries a
 * three-key GIT_PROBE_ENV for its own probe; it is not lifted, because
 * widening it to these nine would change that verb's behaviour too.)
 */
export const GIT_SCRUBBED_ENV: Readonly<Record<string, undefined>> = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_NAMESPACE: undefined,
  GIT_CONFIG_PARAMETERS: undefined,
  GIT_CONFIG_COUNT: undefined,
};

/**
 * Git at `ref`, in the checkout at `root`. The ref is resolved ONCE to a single
 * commit with `rev-parse --verify` (a range such as `a..b` is refused, never
 * read as its tip), behind `--end-of-options`, and a ref beginning with '-' is
 * refused before git sees it; every listing and read is against that commit.
 * A symlink in the tree (mode 120000) is never read: a candidate that is one
 * is refused by name, because following it is exactly the escape the
 * working-tree reader refuses.
 */
export function gitReader(seams: Seams, root: string, ref: string): TemplateReader {
  if (ref === "" || ref.startsWith("-")) {
    throw new VerbUsageError(`--base takes a git ref, got '${ref}'. A ref beginning with '-' would be read as an option, so it is refused.`);
  }
  const options = { cwd: root, env: GIT_SCRUBBED_ENV };
  const resolveArgs = ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`];
  const resolved = seams.run(GIT, resolveArgs, options);
  if (resolved.spawnFailed) throw new ToolError(GIT, resolveArgs, resolved);
  const commit = resolved.stdout.trim();
  if (resolved.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) {
    const said = resolved.stderr.trim();
    throw new VerbUsageError(
      `--base '${ref}' does not resolve to a single commit in '${root}'${said === "" ? "" : ` (git: ${said})`}. Fetch it, or name one ref that exists -- a range is not a ref.`,
    );
  }
  const blobs = new Map<string, string>();
  const links = new Set<string>();
  return {
    ref,
    commit,
    list(directory: string): readonly TemplateEntry[] {
      const args = ["ls-tree", "-z", "--full-tree", commit, ...(directory === "" ? [] : ["--", `${directory}/`])];
      const result = seams.run(GIT, args, options);
      if (result.spawnFailed || result.code !== 0) throw new ToolError(GIT, args, result);
      return result.stdout
        .split("\0")
        .filter((record): boolean => record !== "")
        .map((record): TemplateEntry => {
          const tab = record.indexOf("\t");
          const [mode, type, oid] = record.slice(0, tab).split(" ");
          const path = record.slice(tab + 1);
          const name = path.slice(path.lastIndexOf("/") + 1);
          const relative = directory === "" ? name : `${directory}/${name}`;
          if (mode === "120000") {
            links.add(relative);
            return { name, kind: "symlink" };
          }
          if (type === "blob" && oid !== undefined) {
            blobs.set(relative, oid);
            return { name, kind: "file" };
          }
          return { name, kind: type === "tree" ? "directory" : "other" };
        });
    },
    read(relative: string): string {
      if (links.has(relative)) {
        throw new VerbUsageError(
          `the pull-request template '${relative}' is a symlink at ${ref}; nen never follows a link in the tree. Commit the file itself, or pass --requirements-from <path>.`,
        );
      }
      const oid = blobs.get(relative);
      if (oid === undefined) {
        throw new VerbUsageError(`the pull-request template '${relative}' is not a file at ${ref}. ${TEMPLATE_READ_RATIONALE}`);
      }
      const args = ["cat-file", "blob", oid];
      const result = seams.run(GIT, args, options);
      if (result.spawnFailed || result.code !== 0) {
        throw new VerbUsageError(
          `could not read the pull-request template '${relative}' at ${ref} (git: ${result.stderr.trim()}). ${TEMPLATE_READ_RATIONALE}`,
        );
      }
      return result.stdout;
    },
  };
}

export type TemplateDiscovery =
  | { readonly kind: "found"; readonly path: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "none"; readonly searched: readonly string[] };

function joinRelative(directory: string, name: string): string {
  return directory === "" ? name : `${directory}/${name}`;
}

function byName(left: TemplateEntry, right: TemplateEntry): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/** Find the repository's pull-request template through `reader`, per the rule above. */
export function discoverTemplate(reader: TemplateReader): TemplateDiscovery {
  const defaults: string[] = [];
  const alternatives: string[] = [];
  for (const directory of PR_TEMPLATE_HOMES) {
    for (const entry of [...reader.list(directory)].sort(byName)) {
      const relative = joinRelative(directory, entry.name);
      // A SYMLINK AT A REF IS A CANDIDATE, so it is refused by name when
      // chosen (TemplateReader.read) rather than vanishing into "none found".
      if ((entry.kind === "file" || entry.kind === "symlink") && DEFAULT_TEMPLATE.test(entry.name)) {
        defaults.push(relative);
      } else if (entry.kind === "symlink" && ALTERNATIVES_FOLDER.test(entry.name)) {
        alternatives.push(relative);
      } else if (entry.kind === "directory" && ALTERNATIVES_FOLDER.test(entry.name)) {
        for (const inner of [...reader.list(relative)].sort(byName)) {
          if ((inner.kind === "file" || inner.kind === "symlink") && ALTERNATIVE_FILE.test(inner.name)) alternatives.push(`${relative}/${inner.name}`);
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
        joinRelative(directory, "pull_request_template.{md,txt}"),
        joinRelative(directory, "PULL_REQUEST_TEMPLATE/*.{md,txt}"),
      ]),
    }
  );
}

// --- One markdown reading, shared by the template and the body ------------

/** One line of a template or body, as this module reads it. */
export type ReadLine =
  | {
      readonly kind: "heading";
      readonly level: number;
      /** The line, comments removed -- what a derived pattern is tested against. */
      readonly text: string;
      /** The heading's own words; "" for a bare `##`. */
      readonly title: string;
      /** False for a Setext heading (a line underlined with `===`/`---`): a section boundary, never a requirement. */
      readonly atx: boolean;
    }
  | { readonly kind: "content"; readonly text: string }
  | { readonly kind: "blank" };

/**
 * Remove every `<!-- ... -->` span from `line`, scanning the WHOLE line pair by
 * pair. `inComment` says the line starts inside a comment opened earlier; the
 * returned `open` says whether one is still open at its end.
 */
export function stripComments(line: string, inComment: boolean): { text: string; open: boolean } {
  let text = "";
  let index = 0;
  let open = inComment;
  for (;;) {
    if (open) {
      const close = line.indexOf("-->", index);
      if (close < 0) return { text, open: true };
      index = close + 3;
      open = false;
    } else {
      const start = line.indexOf("<!--", index);
      if (start < 0) return { text: text + line.slice(index), open: false };
      text += line.slice(index, start);
      index = start + 4;
      open = true;
    }
  }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])( *\1){2,} *$/;
const HTML_TAGS_ONLY = /^(?:\s*<\/?[A-Za-z][^<>]*>)+\s*$/;

/**
 * Classify every line of `source`. A leading BOM is dropped. Comment spans are
 * removed before a line is read (so `## X <!-- note` is the heading `## X`,
 * and the comment it opens swallows the lines up to its `-->`). A line that
 * STARTS with `<!--`, or starts inside a comment opened earlier, is never a
 * heading. Fenced code is content and never a heading. A thematic break and a
 * line made only of HTML tags are blank. ATX headings are read, a bare `##`
 * included (a boundary with no title); a Setext underline turns the paragraph
 * line above it into a heading boundary, so its title is not content.
 */
export function readLines(source: string): ReadLine[] {
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const read: ReadLine[] = [];
  let fence: string | null = null;
  let inComment = false;
  // The index of a paragraph line a Setext underline may turn into a heading.
  let paragraph: number | null = null;
  for (const line of lines) {
    if (fence !== null) {
      const close = FENCE.exec(line);
      if (close !== null && close[1]?.[0] === fence[0] && (close[1]?.length ?? 0) >= fence.length && line.trim() === close[1]) {
        fence = null;
      }
      read.push(line.trim() === "" ? { kind: "blank" } : { kind: "content", text: line.trim() });
      continue;
    }
    const startedInComment = inComment;
    const stripped = stripComments(line, inComment);
    inComment = stripped.open;
    const text = stripped.text;
    const underParagraph = paragraph;
    paragraph = null;
    if (text.trim() === "") {
      read.push({ kind: "blank" });
      continue;
    }
    // Text after a `-->` that closed a comment opened on an EARLIER line is
    // never a heading, a fence or an underline: the line began inside the
    // comment, so it is the tail of an HTML block.
    if (startedInComment) {
      read.push({ kind: "content", text: text.trim() });
      continue;
    }
    const htmlBlock = /^ {0,3}<!--/.test(line);
    if (!htmlBlock) {
      const open = FENCE.exec(text);
      if (open !== null) {
        fence = open[1] as string;
        read.push({ kind: "content", text: text.trim() });
        continue;
      }
      const underline = SETEXT_UNDERLINE.exec(text);
      if (underline !== null && underParagraph !== null && underParagraph === read.length - 1) {
        const title = (read[underParagraph] as { text: string }).text;
        read[underParagraph] = { kind: "heading", level: underline[1]?.[0] === "=" ? 1 : 2, text: title, title, atx: false };
        read.push({ kind: "blank" });
        continue;
      }
      if (THEMATIC_BREAK.test(text) || HTML_TAGS_ONLY.test(text)) {
        read.push({ kind: "blank" });
        continue;
      }
      const heading = HEADING.exec(text);
      if (heading !== null) {
        read.push({ kind: "heading", level: (heading[1] as string).length, text, title: (heading[2] ?? "").trim(), atx: true });
        continue;
      }
    }
    read.push({ kind: "content", text: text.trim() });
    if (!htmlBlock) paragraph = read.length - 1;
  }
  return read;
}

/** How a line is compared against the template's own placeholder lines. */
function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A requirement derived from one template heading. */
export interface DerivedRequirement extends BodyRequirement {
  readonly level: number;
  /** The template's own content lines in this section, normalized: placeholder text, never content. */
  readonly placeholder: readonly string[];
}

/** The section heading `index` opens: up to the next heading at its level or higher. */
function sectionOf(read: readonly ReadLine[], index: number, level: number): readonly ReadLine[] {
  const section: ReadLine[] = [];
  for (const line of read.slice(index + 1)) {
    if (line.kind === "heading" && line.level <= level) break;
    section.push(line);
  }
  return section;
}

/**
 * Each ATX heading of `template` (`#` .. `######`) as one requirement: the body
 * must carry a heading at the SAME level with the SAME text (letter case and
 * whitespace runs aside), optionally followed by `<!-- ... -->` spans -- so a
 * body that kept GitHub's prefilled inline comment still matches. A heading
 * repeated verbatim yields one requirement.
 */
export function deriveRequirements(template: string): DerivedRequirement[] {
  const read = readLines(template);
  const requirements: DerivedRequirement[] = [];
  const seen = new Set<string>();
  read.forEach((line, index): void => {
    if (line.kind !== "heading" || !line.atx || line.title === "") return;
    const text = line.title;
    const marks = "#".repeat(line.level);
    const pattern = `^ {0,3}${marks}[ \\t]+${escapeRegExp(text).replace(/[ \t]+/g, "[ \\t]+")}(?:[ \\t]+#+)?(?:[ \\t]*<!--.*?-->)*[ \\t]*$`;
    if (seen.has(pattern)) return;
    seen.add(pattern);
    const placeholder = sectionOf(read, index, line.level).flatMap((entry): string[] => (entry.kind === "content" ? [normalized(entry.text)] : []));
    requirements.push({ name: `${marks} ${text.replace(/[ \t]+/g, " ")}`, pattern, level: line.level, placeholder });
  });
  return requirements;
}

export type DerivedStatus = "ok" | "missing" | "empty";

export interface DerivedResult extends RequirementResult {
  readonly status: DerivedStatus;
}

/**
 * Check `body` against DERIVED requirements. Comment spans and fenced code in
 * the body are masked first, so a heading hidden in either never counts. A
 * matched heading must ALSO carry content: at least one non-blank line, not a
 * comment and not one of the template's own lines for that section, before the
 * next heading at its level or higher (a deeper sub-heading is structure, and
 * the content under it counts). An untouched template therefore fails, as
 * EMPTY, distinct from MISSING. Shipped requirements never come through here.
 */
export function checkDerivedBody(
  body: string,
  requirements: readonly DerivedRequirement[],
): { readonly results: readonly DerivedResult[]; readonly ok: boolean } {
  const read = readLines(body);
  const results = requirements.map((requirement): DerivedResult => {
    const regex = new RegExp(requirement.pattern, "i");
    const placeholder = new Set(requirement.placeholder);
    let matched = false;
    let filled = false;
    read.forEach((line, index): void => {
      if (filled || line.kind !== "heading" || line.level !== requirement.level || !regex.test(line.text)) return;
      matched = true;
      filled = sectionOf(read, index, requirement.level).some(
        (entry): boolean => entry.kind === "content" && !placeholder.has(normalized(entry.text)),
      );
    });
    const status: DerivedStatus = !matched ? "missing" : filled ? "ok" : "empty";
    return { name: requirement.name, pattern: requirement.pattern, satisfied: status === "ok", status };
  });
  return { results, ok: results.every((result): boolean => result.satisfied) };
}
