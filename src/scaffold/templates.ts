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

/** `vX.Y.Z` -- the only ref shape a generated workflow may pin nen at. */
export const NEN_REF = /^v\d+\.\d+\.\d+$/;

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
 * The oldest nen release a generated workflow may be pinned at, and why.
 *
 * IT IS DATA, IN THE FILE THE WORKFLOW BODIES LIVE IN. Every CI template here
 * runs `nen shu tools`, `nen shu build`, `nen shu test` and `nen shu lint`, and
 * a workflow pinned at a ref whose binary has no `shu` family is red on the
 * first push -- twice over, because the bootstrap refuses at exit 6 before any
 * verb runs when the tag carries no published release. The build's own
 * `src/version.ts` cannot answer this: it says which nen WROTE the file, not
 * which nen can RUN it, and while `shu` is unreleased those two are different
 * numbers. Declaring it beside the bodies keeps the two facts in one file --
 * add a verb to a template body, and the ref it needs is on the next screen.
 */
export interface MinimumRef {
  /** `vX.Y.Z`. */
  readonly ref: string;
  /** One sentence, printed whenever the written ref is not this build's own. */
  readonly why: string;
}

export function minimumNenRef(): MinimumRef {
  const path = `${TEMPLATE_DIRECTORY}/${TEMPLATE_INDEX_FILE}`;
  const block = objectAt(templateIndex, path, "minimumNenRef");
  const ref = stringAt(block, path, "ref");
  if (!NEN_REF.test(ref)) {
    throw new TemplateError(path, "minimumNenRef.ref", "must be a 'vX.Y.Z' tag");
  }
  return { ref, why: stringAt(block, path, "why") };
}

/**
 * Compare two `vX.Y.Z` refs numerically. Negative when `a` is older.
 *
 * FIELD BY FIELD, NEVER `localeCompare`: `v0.10.0` sorts BEFORE `v0.9.0` as a
 * string, which would let a minimum of `v0.9.0` silently accept a `v0.10.0`
 * pin's older sibling, and the whole point of the minimum is that the
 * comparison is right.
 */
export function compareNenRefs(a: string, b: string): number {
  const parse = (ref: string): number[] => ref.slice(1).split(".").map(Number);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
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

/**
 * A path a template WRITES, held to the shape a report can print and a caller
 * can trust.
 *
 * THIS IS CHECKED AT LOAD TIME, NOT AT WRITE TIME, and the difference is who
 * finds out. A `files` key of `../ESCAPED.txt` is joined against `--dir` and
 * lands one directory ABOVE the fresh tree, reported as `../ESCAPED.txt` at
 * exit 0 -- a template that writes outside the tree it was pointed at. The
 * containment checks in ./init.ts guard a path a CALLER typed; this guards a
 * path the DATA states, and a bad one must fail this repository's own suite
 * rather than a user's scaffold, because every byte of it shipped inside the
 * binary. Forward slashes only: the key is split on `/` before it is joined,
 * so a backslash would be a filename on POSIX and a separator on Windows.
 */
export function assertWritablePath(value: string, path: string, field: string): string {
  const segments = value.split("/");
  const bad =
    value === "" ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value) ||
    segments.some((segment): boolean => segment === "" || segment === "." || segment === "..");
  if (bad) {
    throw new TemplateError(
      path,
      field,
      `names '${value}', which is not a repo-relative forward-slashed path. A template writes INSIDE the tree it was pointed at: no leading '/', no drive letter, no '\\', and no '.' or '..' segment`,
    );
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
    files.push({ path: assertWritablePath(key, path, `${field}.${key}`), body });
  }
  return files;
}

function documentFor(name: string): { path: string; document: Record<string, unknown> } {
  const bundled = BUNDLED.find((entry): boolean => entry.directory === name);
  const path = `<bundled>:${TEMPLATE_DIRECTORY}/${name}/${TEMPLATE_FILE}`;
  if (bundled === undefined) {
    // BOTH SOURCES OF THE NAME ARE NAMED. A template name reaches this function
    // from `profiles/<stack>.json`'s `scaffoldTemplate` as often as from
    // `templates/index.json`, and blaming only the index sends a reader to the
    // file that is usually right: the pack points a stack at a template, and
    // the template pack has not caught up.
    throw new TemplateError(
      `${TEMPLATE_DIRECTORY}/${TEMPLATE_INDEX_FILE}`,
      "templates",
      `names '${name}', which no bundled document answers -- and so does the 'scaffoldTemplate' of whichever profiles/<stack>.json points a stack at it. The import list in src/scaffold/templates.ts must name ${TEMPLATE_DIRECTORY}/${name}/${TEMPLATE_FILE}: a bundler cannot follow a directory read, so a template absent from that list is absent from the binary`,
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
      path: assertWritablePath(stringAt(ciBlock, path, "path"), path, "ci.path"),
      body: stringAt(ciBlock, path, "body"),
    },
    noFreshTree,
    freshTree: [...shared, ...own].sort((a, b): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    postSteps: postSteps as readonly string[],
  };
}

/** Which stacks `scaffold new` can write a tree for, and which it cannot. */
export interface FreshTreeSupport {
  /** Stacks with a fresh-tree form: `scaffold new` writes these. */
  readonly freshTree: readonly string[];
  /** Stacks with a template but no tree: `scaffold init` serves these. */
  readonly initOnly: readonly string[];
  /** Stacks the catalogue proposes no template for at all. */
  readonly noTemplate: readonly string[];
}

/**
 * The three lists, COMPUTED FROM THE PACKS rather than written down.
 *
 * `--help` HAS TO ANSWER THIS QUESTION -- a caller who types
 * `scaffold new --stack <one of the two>` gets a refusal they could have read
 * first -- and it may not answer it from a literal, because no module of this
 * family names a stack (./templates.test.ts sweeps for one, the way
 * ../shu/purity.test.ts sweeps the execution path). Deriving it also means the
 * help text cannot go stale: a stack that gains a template joins the list on
 * the same commit.
 */
export function freshTreeSupport(): FreshTreeSupport {
  const freshTree: string[] = [];
  const initOnly: string[] = [];
  const noTemplate: string[] = [];
  for (const stack of knownStacks()) {
    const template = templateForStack(stack);
    if (template === null) noTemplate.push(stack);
    else if (template.noFreshTree !== null) initOnly.push(stack);
    else freshTree.push(stack);
  }
  return { freshTree, initOnly, noTemplate };
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
    // `Object.hasOwn`, NOT `values[token] !== undefined`. A plain object's
    // prototype answers for `constructor`, `toString` and `valueOf`, so a
    // template body carrying `{{constructor}}` used to substitute the SOURCE OF
    // A NATIVE FUNCTION into a generated file at exit 0 -- a template writing
    // whatever the runtime happened to hold, rather than being refused for
    // naming a token this invocation did not supply.
    if (!Object.hasOwn(values, token)) {
      missing.add(token);
      return whole;
    }
    return values[token] as string;
  });
  if (missing.size > 0) {
    throw new VerbUsageError(
      `${where} needs ${[...missing].sort().map((token): string => `{{${token}}}`).join(", ")}, which this invocation did not supply. nen never invents a project name, an organisation or an identifier -- pass it, or edit the template.`,
    );
  }
  return out;
}
