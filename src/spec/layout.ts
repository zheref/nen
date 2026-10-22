// src/spec/layout.ts -- a spec repository's folder layout, read and refused.
//
// THE LAYOUT IS THE CALLER'S, NEVER A HARD-CODED `specs/`. Hatsu's port
// conventions (docs/config/ports.md, *Slug, number and layout*) fix the rule
// this file enforces: `{slug}` matches `^[a-z0-9]+(-[a-z0-9]+)*$`, `{nnn}`
// `^[0-9]{3}$`, and a layout containing `..`, starting with `/` or resolving
// outside its first path segment is refused. The search for folders runs under
// the layout's directory part, never anywhere else.
//
// WHAT A LAYOUT MAY LOOK LIKE. One or more literal directory segments, then
// one final segment carrying `{nnn}` and `{slug}` exactly once each with any
// literal text around them: `specs/{nnn}-{slug}` (Spec Kit's own) or
// `features/F{nnn}_{slug}`. A placeholder in a directory segment would make
// the search root depend on the folder it is looking for, so it is refused.

import { VerbUsageError } from "../cli/command.js";

export const SLUG_PATTERN = "[a-z0-9]+(?:-[a-z0-9]+)*";
export const NNN_PATTERN = "[0-9]{3}";

export interface SpecLayout {
  /** The layout as typed. */
  readonly pattern: string;
  /** The literal directory every feature folder sits directly under (`specs`). */
  readonly root: string;
  /** The final segment's matcher: group 1 is `{nnn}`, group 2 `{slug}`. */
  readonly folder: RegExp;
  /** `{nnn}` before `{slug}` in the final segment, or after it. */
  readonly nnnFirst: boolean;
}

export interface FolderName {
  readonly nnn: string;
  readonly slug: string;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseLayout(pattern: string): SpecLayout {
  const refuse = (why: string): never => {
    throw new VerbUsageError(`--layout '${pattern}' ${why}. A layout is '<dir>[/<dir>...]/<final>' whose final segment holds {nnn} and {slug} once each, e.g. 'specs/{nnn}-{slug}'.`);
  };
  if (pattern.trim() === "") refuse("is empty");
  if (pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern) || pattern.includes("\\")) refuse("is not a relative '/'-separated path");
  const segments = pattern.split("/");
  if (segments.some((segment): boolean => segment === ".." || segment === "." || segment === "")) refuse("has an empty, '.' or '..' segment");
  if (segments.length < 2) refuse("has no directory segment to search under");
  const final = segments[segments.length - 1] as string;
  const dirs = segments.slice(0, -1);
  if (dirs.some((segment): boolean => /[{}]/.test(segment))) refuse("carries a placeholder or brace outside its final segment");
  const count = (token: string): number => final.split(token).length - 1;
  if (count("{nnn}") !== 1 || count("{slug}") !== 1) refuse("does not carry {nnn} and {slug} exactly once each in its final segment");
  const rest = final.replace("{nnn}", "").replace("{slug}", "");
  if (/[{}]/.test(rest)) refuse("carries a placeholder other than {nnn} and {slug}");
  const nnnFirst = final.indexOf("{nnn}") < final.indexOf("{slug}");
  const source = final
    .split(/(\{nnn\}|\{slug\})/)
    .map((part): string => (part === "{nnn}" ? `(${NNN_PATTERN})` : part === "{slug}" ? `(${SLUG_PATTERN})` : escape(part)))
    .join("");
  return { pattern, root: dirs.join("/"), folder: new RegExp(`^${source}$`), nnnFirst };
}

/** The `{nnn}` and `{slug}` a folder name carries under this layout, or null when it does not match. */
export function matchFolder(layout: SpecLayout, name: string): FolderName | null {
  const match = layout.folder.exec(name);
  if (match === null) return null;
  const [first, second] = [match[1] as string, match[2] as string];
  return layout.nnnFirst ? { nnn: first, slug: second } : { nnn: second, slug: first };
}

/**
 * A caller-typed folder path (`specs/001-sample`), refused unless it is a plain
 * relative path inside the repository: no absolute form, no `..`, no empty
 * segment, no leading `-` that a later git argv could read as an option.
 */
export function checkRelativePath(flag: string, value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  const bad =
    trimmed === "" ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("-") ||
    /^[A-Za-z]:/.test(trimmed) ||
    trimmed.includes("\\") ||
    trimmed.split("/").some((segment): boolean => segment === "" || segment === "." || segment === "..");
  if (bad) throw new VerbUsageError(`--${flag} '${value}' must be a relative path inside --repo with no '.', '..' or empty segment.`);
  return trimmed;
}
