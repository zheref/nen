// src/scaffold/templates.ts -- the DATA side of `nen scaffold`: which template
// a stack gets, and every byte that template would write.
//
// THIS IS THE ONE MODULE OF THIS FAMILY THAT READS THE PROFILES PACK, and that
// is why it is its own file. `nen scaffold init` ends by running `nen shu tools`
// in check mode, which spawns the version probes the target repository declares;
// ../profiles/inertness.test.ts computes its rule from the SEAM, so the half
// that can reach a spawn must never be the half that reads the catalogue. So:
//
//   * THIS module reads the pack, for exactly one fact per stack -- the NAME of
//     the template the catalogue points that stack at (`scaffoldTemplate`), plus
//     the id list a `--stack` is validated against. It imports no seam, imports
//     nothing that imports one, and spawns nothing.
//   * ./init.ts and ./new.ts WRITE FILES and never spawn.
//   * ./command.ts joins them with the `shu tools` check, and imports no seam of
//     its own -- exactly as ../shu/command.ts already joins ../shu/detect.ts
//     (which reads the pack) with ../shu/run.ts (which spawns).
//
// The pack contributes a template NAME to a filename lookup and a runner NAME to
// a generated YAML file. It contributes nothing to any argv, because this family
// builds none: every command in a template's CI file is `nen shu <verb>`, whose
// argv comes from the scaffolded repository's own declaration.
//
// NO TOOLCHAIN NAME LIVES IN ANY MODULE OF THIS FAMILY -- ./templates.test.ts
// sweeps `src/scaffold/*.ts` for one, the way ../shu/purity.test.ts sweeps the
// execution path. A template's BODY may name whatever a project's own manifest
// has to name; that body is a data file under `templates/`, versioned with nen
// and readable end to end by a reviewer, which is the whole reason it is data.

// ── the bundled documents ───────────────────────────────────────────────────
//
// STATIC IMPORTS, FOR THE REASON ../profiles/pack.ts's own import list is
// static: `bun build --compile` embeds what a static import names and cannot
// follow a directory read, so a template absent from this list is absent from
// every shipped binary -- the worst available failure, because it only shows up
// on a machine nobody is testing on. ./templates.test.ts pins this list against
// `templates/` in both directions and against `templates/index.json`, so the
// list cannot fall behind the data quietly.

import fullTemplate from "../../templates/full/template.json";
import minimalTemplate from "../../templates/minimal/template.json";
import templateIndex from "../../templates/index.json";

import { VerbUsageError } from "../cli/command.js";
import { loadProfilesPack, profileById } from "../profiles/pack.js";

/** The template pack's directory name, relative to the repository root. */
export const TEMPLATE_DIRECTORY = "templates";

/** Its table of contents, inside that directory. */
export const TEMPLATE_INDEX_FILE = "index.json";

/** The one document each template directory holds. */
export const TEMPLATE_FILE = "template.json";

/**
 * The token shape a `--stack` value must have.
 *
 * THE SAME POSITIVE ALLOWLIST ../canon/resolve.ts USES, and for the same
 * reason: the id is looked up in a bundled table and printed into a generated
 * file, and a value that has to be escaped before either is a value that was
 * never a stack id. Membership is checked separately and second -- this is the
 * shape gate, so a `../../etc` never reaches a lookup at all.
 */
const STACK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** `{{token}}`, the only substitution a template body performs. */
const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

interface BundledTemplate {
  /** The directory inside `templates/`, which is also the template's name. */
  readonly directory: string;
  readonly document: unknown;
}

// Sorted, so this list and `templates/index.json` read in the same order.
const BUNDLED: readonly BundledTemplate[] = [
  { directory: "full", document: fullTemplate },
  { directory: "minimal", document: minimalTemplate },
];

/** Every bundled template directory name, for the test that pins the list. */
export function bundledTemplateNames(): readonly string[] {
  return BUNDLED.map((entry): string => entry.directory);
}

/** The names `templates/index.json` lists, for the same test. */
export function indexedTemplateNames(): readonly string[] {
  const listed = (templateIndex as { templates?: unknown }).templates;
  if (!Array.isArray(listed) || listed.some((name): boolean => typeof name !== "string")) {
    throw new TemplateError(
      `${TEMPLATE_DIRECTORY}/${TEMPLATE_INDEX_FILE}`,
      "templates",
      "must be an array of template directory names",
    );
  }
  return listed as readonly string[];
}

/**
 * A malformed bundled document. It is not a `VerbUsageError`: nothing the
 * caller typed can produce it, and telling them to read `--help` would be
 * advice about the wrong file entirely.
 */
export class TemplateError extends Error {
  constructor(path: string, field: string, message: string) {
    super(`${path}: '${field}' ${message}.`);
    this.name = "TemplateError";
  }
}

/** One file a template would write: a repo-relative path and its whole body. */
export interface TemplateFile {
  /** Repo-relative, forward-slashed -- the spelling every message prints. */
  readonly path: string;
  /** The body, with every `{{token}}` still in it. */
  readonly body: string;
}

/**
 * Everything one stack's template says, flattened.
 *
 * `freshTree` IS NULL FOR A STACK NEN CANNOT HONESTLY WRITE A TREE FOR, and
 * `noFreshTree` then carries the template's own sentence saying why. Two of the
 * five stacks with a template are in that state, and the reason is the same
 * shape in both: their stack marker is not text. A wrapper script paired with a
 * downloaded jar and an IDE-authored project document are things nen would have
 * to fabricate, and a fabricated marker is a declaration that lies about a tree
 * `nen shu build` then cannot build. `scaffold init` still serves both -- the
 * CI file, the declaration and the hook are text either way.
 */
export interface StackTemplate {
  readonly stack: string;
  /** The template's name, which is the pack's own `scaffoldTemplate` value. */
  readonly template: string;
  /** The CI runner label this stack's workflow uses. */
  readonly runner: string;
  /** The CI workflow, the one file `scaffold init` adds from a template. */
  readonly ci: TemplateFile;
  /** Why this stack has no fresh-tree form, or null when it has one. */
  readonly noFreshTree: string | null;
  /** The whole tree `scaffold new` would write, shared files included. */
  readonly freshTree: readonly TemplateFile[];
  /** Stack-specific post-steps, printed by `scaffold new` and never run. */
  readonly postSteps: readonly string[];
}

function objectAt(document: unknown, path: string, field: string): Record<string, unknown> {
  const value =
    typeof document === "object" && document !== null && !Array.isArray(document)
      ? (document as Record<string, unknown>)[field]
      : undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TemplateError(path, field, "must be an object");
  }
  return value as Record<string, unknown>;
}

function stringAt(document: Record<string, unknown>, path: string, field: string): string {
  const value = document[field];
  if (typeof value !== "string" || value === "") {
    throw new TemplateError(path, field, "must be a non-empty string");
  }
  return value;
}

function fileMap(document: Record<string, unknown>, path: string, field: string): TemplateFile[] {
  const raw = objectAt(document, path, field);
  const files: TemplateFile[] = [];
  // BYTE ORDER, so a template's file list reads the same on every platform and
  // a golden transcript is a golden transcript.
  for (const key of Object.keys(raw).sort()) {
    const body = raw[key];
    if (typeof body !== "string") {
      throw new TemplateError(path, `${field}.${key}`, "must be a string body");
    }
    files.push({ path: key, body });
  }
  return files;
}

function documentFor(name: string): { path: string; document: Record<string, unknown> } {
  const bundled = BUNDLED.find((entry): boolean => entry.directory === name);
  const path = `<bundled>:${TEMPLATE_DIRECTORY}/${name}/${TEMPLATE_FILE}`;
  if (bundled === undefined) {
    throw new TemplateError(
      `${TEMPLATE_DIRECTORY}/${TEMPLATE_INDEX_FILE}`,
      "templates",
      `names '${name}', which no bundled document answers. The import list in src/scaffold/templates.ts must name ${TEMPLATE_DIRECTORY}/${name}/${TEMPLATE_FILE}: a bundler cannot follow a directory read, so a template absent from that list is absent from the binary`,
    );
  }
  if (
    typeof bundled.document !== "object" ||
    bundled.document === null ||
    Array.isArray(bundled.document)
  ) {
    throw new TemplateError(path, "(document)", "must be a JSON object");
  }
  return { path, document: bundled.document as Record<string, unknown> };
}

/** Every stack the profiles pack lists, in the pack's own (sorted) order. */
export function knownStacks(): readonly string[] {
  return loadProfilesPack().ids;
}

/**
 * A `--stack` value, validated by SHAPE first and MEMBERSHIP second.
 *
 * Both refusals are exit 2 and both name the known ids, because a caller who
 * typed a stack that does not exist and a caller who typed something that could
 * never be one want the same next line on screen.
 */
export function resolveStackId(value: string): string {
  const known = knownStacks();
  if (!STACK_ID.test(value)) {
    throw new VerbUsageError(
      `--stack '${value}' is not a stack id ([A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]). Known: ${known.join(", ")}.`,
    );
  }
  if (!known.includes(value)) {
    throw new VerbUsageError(`--stack '${value}' is not a stack nen knows. Known: ${known.join(", ")}.`);
  }
  return value;
}

/**
 * The platforms the catalogue records for one stack, keyed by verb.
 *
 * IT IS A REPORT COLUMN, NOT AN ARGUMENT. The map lands verbatim in a proposed
 * `project.hosts` block for a human to read and edit -- the same value
 * `nen shu detect` proposes, which is why a `--stack` declaration and a
 * detected one cannot disagree about a platform. Nothing spawns from it.
 */
export function stackHosts(stack: string): Readonly<Record<string, readonly string[]>> {
  return profileById(loadProfilesPack(), stack).hosts;
}

/**
 * The template for one stack, or null when the catalogue proposes none.
 *
 * NULL IS AN ANSWER THE PACK GIVES, not an omission: two of the seven stacks
 * carry `scaffoldTemplate: null` with the pack's own reason beside it, and a
 * scaffold that invented a skeleton for a stack the catalogue declined to
 * propose one for would be nen deciding a project's shape. `scaffold init`
 * reports the CI step `skipped` and says so.
 */
export function templateForStack(stack: string): StackTemplate | null {
  const profile = profileById(loadProfilesPack(), stack);
  const name = profile.scaffoldTemplate;
  if (name === null) return null;
  const { path, document } = documentFor(name);
  const declaredName = stringAt(document, path, "name");
  if (declaredName !== name) {
    throw new TemplateError(
      path,
      "name",
      `is '${declaredName}', but this document was read as '${name}'. The name and the directory are the same fact spelled twice; ${TEMPLATE_DIRECTORY}/${TEMPLATE_INDEX_FILE} addresses a template by name and the bundler addresses it by directory`,
    );
  }
  const stacks = objectAt(document, path, "stacks");
  const entry = stacks[stack];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new TemplateError(
      path,
      `stacks.${stack}`,
      `is missing. The pack points '${stack}' at the '${name}' template, so this document must carry a row for it -- a stack with a template name and no template row is a stack every scaffold refuses at runtime`,
    );
  }
  const row = entry as Record<string, unknown>;
  const ciBlock = objectAt(document, path, "ci");
  const noFreshTree = row["noFreshTree"];
  if (noFreshTree !== null && typeof noFreshTree !== "string") {
    throw new TemplateError(path, `stacks.${stack}.noFreshTree`, "must be a string or null");
  }
  const own = fileMap(row, path, "files");
  const postSteps = row["postSteps"];
  if (!Array.isArray(postSteps) || postSteps.some((step): boolean => typeof step !== "string")) {
    throw new TemplateError(path, `stacks.${stack}.postSteps`, "must be an array of strings");
  }
  // A row that carries files and a refusal, or neither, is a document that has
  // not decided what it is -- and the caller would find out only by running it.
  if ((noFreshTree === null) !== (own.length > 0)) {
    throw new TemplateError(
      path,
      `stacks.${stack}`,
      "must carry EITHER a non-empty 'files' map (a fresh tree nen can write) OR a 'noFreshTree' sentence saying why it cannot, and never both or neither",
    );
  }
  const shared = noFreshTree === null ? fileMap(document, path, "shared") : [];
  return {
    stack,
    template: name,
    runner: stringAt(row, path, "runner"),
    ci: {
      path: stringAt(ciBlock, path, "path"),
      body: stringAt(ciBlock, path, "body"),
    },
    noFreshTree,
    freshTree: [...shared, ...own].sort((a, b): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    postSteps: postSteps as readonly string[],
  };
}

/**
 * Substitute every `{{token}}` a template body carries.
 *
 * AN UNSUBSTITUTED TOKEN IS A REFUSAL, NEVER A FILE. A body written to disk
 * still carrying `{{name}}` is a file that looks scaffolded and is not, and the
 * caller finds out from whatever tool reads it next rather than from nen. So a
 * token with no value refuses at exit 2 NAMING THE TOKEN -- the same rule
 * `nen shu` applies to an unsubstituted argv placeholder.
 */
export function substitute(
  body: string,
  values: Readonly<Record<string, string>>,
  where: string,
): string {
  const missing = new Set<string>();
  const out = body.replace(PLACEHOLDER, (whole, token: string): string => {
    const value = values[token];
    if (value === undefined) {
      missing.add(token);
      return whole;
    }
    return value;
  });
  if (missing.size > 0) {
    throw new VerbUsageError(
      `${where} needs ${[...missing].sort().map((token): string => `{{${token}}}`).join(", ")}, which this invocation did not supply. nen never invents a project name, an organisation or an identifier -- pass it, or edit the template.`,
    );
  }
  return out;
}
