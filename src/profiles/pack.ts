// src/profiles/pack.ts -- the loader for the bundled profiles pack.
//
// THE PACK IS A CATALOGUE, NOT AN AUTHORITY, and that sentence is the whole
// design of this file. `profiles/*.json` states, per stack, the reference
// command each verb has IN THE SEVEN PRODUCT REPOSITORIES THE INVENTORY READ --
// every cell cited to a file and a line. The only thing an execution path ever
// reads is the TARGET repository's own `nen/contract.json` (../schema/
// contract.ts). This pack exists so that a human writing that declaration has
// somewhere honest to start, and so `docs/STACK-MATRIX.md` can be GENERATED
// rather than hand-maintained -- the ancestor artifact was a 688-line
// hand-written table with no generator and no drift check, and it was deleted
// rather than fixed.
//
// NOTHING THAT SPAWNS A PROCESS MAY READ THIS MODULE. That is not a convention:
// it is `inertness.test.ts`, a source sweep over `src/**` that fails the build
// when a module importing the runner seam also imports this file, and that
// names its allowed importers explicitly. The pack may say what nen was TESTED
// against; it may never contribute a version, a URL or an argument to a command
// nen runs. The two functions that will one day build commands --
// `renderInvocation` over a declaration, and `resolveInstall` over a
// declaration's toolchain entry -- take a declaration and nothing else.
//
// WHY THE DATA IS IMPORTED RATHER THAN READ FROM DISK. `bun build --compile`
// produces one executable with no `profiles/` directory beside it, and
// `import.meta.url` inside a compiled bun binary resolves to `/$bunfs/...`,
// which is not a path on any filesystem (../version.ts's header, and
// ../taxonomy-purity.test.ts's own sweep, both say so). A pack read from disk
// at runtime would therefore work in a checkout and fail from the binary -- the
// single worst failure shape available, because every test would pass. So the
// seven documents are STATIC IMPORTS: the bundler embeds them, and the compiled
// binary carries the pack. The import list is explicit because a bundler cannot
// follow a `readdirSync`; `pack.test.ts` pins that list against the contents of
// `profiles/` and against `profiles/index.json`, so a stack added as a file and
// forgotten here fails the build rather than shipping as a silently absent row.
//
// THE STACK SET AND THE VERB SET ARE DATA, NOT LITERALS HERE. Both live in
// `profiles/index.json`. That is what lets this module and the matrix renderer
// contain zero stack ids and zero toolchain names -- the property
// ../taxonomy-purity.test.ts exists to keep -- and it is what makes "exactly
// these thirteen verbs, in every profile" a check rather than a hope.
//
// VALIDATION IS BORROWED, NOT RESTATED. The verb forms this pack uses are the
// declaration's own forms, so the declaration's own reader validates them
// (`parseInvocation`, `requireArgv`, `requireEnum` from ../schema/contract.ts).
// A second copy of those rules here would be a second set of rules, and the two
// would drift in the direction of whichever file was edited last.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  INSTALLERS,
  VERSION_FROM,
  parseInvocation,
  requireArgv,
  requireEnum,
  type Installer,
  type Invocation,
  type VersionFrom,
} from "../schema/contract.js";
import {
  describeValue,
  optionalString,
  requireArray,
  requireRecord,
  requireString,
  SchemaError,
} from "../schema/errors.js";

// ── the bundled documents ───────────────────────────────────────────────────

import composeDesktopDocument from "../../profiles/compose-desktop.json";
import dotnetWinuiDocument from "../../profiles/dotnet-winui.json";
import expoDocument from "../../profiles/expo.json";
import gatsbyDocument from "../../profiles/gatsby.json";
import gradleAndroidDocument from "../../profiles/gradle-android.json";
import indexDocument from "../../profiles/index.json";
import nextjsDocument from "../../profiles/nextjs.json";
import xcodeIosDocument from "../../profiles/xcode-ios.json";

/** The pack's directory name, relative to the repository root. */
export const PACK_DIRECTORY = "profiles";

/** The pack's table of contents, inside that directory. */
export const PACK_INDEX_FILE = "index.json";

interface BundledFile {
  /** The basename inside `profiles/`, which is also the error label's tail. */
  readonly file: string;
  readonly document: unknown;
}

// The explicit import list, paired with the filename each document came from.
// Sorted, so this list and `profiles/index.json` read in the same order.
const BUNDLED: readonly BundledFile[] = [
  { file: "compose-desktop.json", document: composeDesktopDocument },
  { file: "dotnet-winui.json", document: dotnetWinuiDocument },
  { file: "expo.json", document: expoDocument },
  { file: "gatsby.json", document: gatsbyDocument },
  { file: "gradle-android.json", document: gradleAndroidDocument },
  { file: "nextjs.json", document: nextjsDocument },
  { file: "xcode-ios.json", document: xcodeIosDocument },
];

/** Every bundled profile filename, for the test that pins the import list. */
export function bundledProfileFiles(): readonly string[] {
  return BUNDLED.map((entry): string => entry.file);
}

// ── the shapes ──────────────────────────────────────────────────────────────

/**
 * One detection marker: a filename pattern, optionally refined by a literal the
 * matched file must contain.
 *
 * THE REFINEMENT IS NOT DECORATION. Two stacks in this pack are identified by
 * it and not by their filename at all -- a `*.csproj` is .NET, not this stack,
 * until a property inside it says so; a `settings.gradle.kts` is a JVM build
 * until a plugin id inside it says otherwise. A marker model with no `contains`
 * would misfile both, confidently.
 */
export interface ProfileMarker {
  readonly pattern: string;
  readonly contains: string | null;
  readonly why: string;
}

/**
 * A verb's cell in the pack, in FIVE forms -- three of them the declaration's
 * own (`command`, `steps`, `unsupported`, parsed by ../schema/contract.ts), and
 * two that exist only in a catalogue:
 *
 *   * `declared-only` -- the verb is REAL for this stack, and the observed
 *     repositories disagree about what it means, so the pack proposes no
 *     default and the target repository's declaration must say. This is not
 *     `unsupported`: picking one repository's convention and shipping it as
 *     everyone's is exactly the failure a reference matrix causes.
 *   * `delegated` -- the verb's work IS another verb's, named. Only `warmup`
 *     uses it: its version-control half runs for every stack, and its
 *     verification half is that stack's own `build` and `test` rows. Collapsing
 *     it into `declared-only` would report four stacks as having no answer when
 *     the answer is "this row, and that one".
 */
export type ProfileVerb =
  | { readonly kind: "command"; readonly invocation: Invocation; readonly source: string }
  | { readonly kind: "steps"; readonly invocation: Invocation; readonly source: string }
  | {
      readonly kind: "unsupported";
      readonly invocation: Invocation;
      /** The short form the summary grid prints; the reason is the authority. */
      readonly summary: string;
      readonly source: string;
    }
  | {
      readonly kind: "declared-only";
      readonly reason: string;
      readonly summary: string;
      readonly source: string;
    }
  | {
      readonly kind: "delegated";
      readonly delegatesTo: readonly string[];
      readonly why: string;
      readonly source: string;
    };

/**
 * A toolchain minimum: what nen has been TESTED against, and nothing more.
 *
 * `minimum` IS NULLABLE, and the declaration's `version` is not. That asymmetry
 * is the point: a declaration with no pin is refused, because nen never
 * installs "latest"; a pack entry with no minimum is a tool the inventory
 * evidences as REQUIRED and pins NOWHERE, and saying so beats inventing a
 * floor. An advisory column may say "presence only"; an install argv may not.
 */
export interface PackMinimum {
  readonly tool: string;
  readonly minimum: string | null;
  readonly probe: readonly string[];
  readonly versionFrom: VersionFrom;
  readonly installer: Installer;
  readonly why: string;
  readonly source: string;
}

export interface StackProfile {
  readonly id: string;
  readonly displayName: string;
  readonly markers: readonly ProfileMarker[];
  /** Per-verb allowlist of `process.platform` values; `*` means every verb. */
  readonly hosts: Readonly<Record<string, readonly string[]>>;
  /** The prose the `hosts` map cannot carry -- per-format and per-lane splits. */
  readonly hostNote: string;
  /** A template NAME only. The templates themselves are a later change. */
  readonly scaffoldTemplate: string | null;
  readonly scaffoldNote: string;
  readonly verbs: Readonly<Record<string, ProfileVerb>>;
  readonly toolchain: Readonly<Record<string, PackMinimum>>;
  readonly notes: readonly string[];
  /** The document exactly as the file states it, every key preserved. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface ProfilesPack {
  /** Profile ids, in `profiles/index.json`'s order (sorted). */
  readonly ids: readonly string[];
  /** The thirteen verbs, in the family's own declared order -- NOT sorted. */
  readonly verbs: readonly string[];
  readonly profiles: Readonly<Record<string, StackProfile>>;
  /** Where this pack came from: the binary, or a `--profiles <dir>` override. */
  readonly origin: string;
}

// ── reading ─────────────────────────────────────────────────────────────────

// The label a SchemaError carries for a bundled document. It is NOT a path, and
// deliberately does not look like one: inside a compiled binary there is no
// `profiles/` directory to open, and a message pointing at a file that is not
// there is worse than one that says where the bytes actually came from.
function bundledLabel(file: string): string {
  return `<bundled>:${PACK_DIRECTORY}/${file}`;
}

function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new SchemaError(
      path,
      null,
      `could not be read (${error instanceof Error ? error.message : String(error)}). A --profiles override names a directory holding ${PACK_INDEX_FILE} and one <id>.json per profile it lists`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new SchemaError(
      path,
      null,
      `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseMarkers(path: string, value: unknown): readonly ProfileMarker[] {
  const entries = requireArray(path, "markers", value);
  if (entries.length === 0) {
    throw new SchemaError(
      path,
      "markers",
      "declares no marker. A profile with no marker is a stack nothing can ever be detected as; state at least one filename pattern",
    );
  }
  return entries.map((entry, index): ProfileMarker => {
    const pointer = `markers[${index}]`;
    const raw = requireRecord(path, pointer, entry);
    return {
      pattern: requireString(path, `${pointer}.pattern`, raw["pattern"]),
      contains: optionalString(path, `${pointer}.contains`, raw["contains"]),
      why: requireString(path, `${pointer}.why`, raw["why"]),
    };
  });
}

function parseHosts(path: string, value: unknown): Record<string, readonly string[]> {
  const record = requireRecord(path, "hosts", value);
  const hosts: Record<string, readonly string[]> = {};
  for (const [verb, entry] of Object.entries(record)) {
    if (verb.startsWith("$")) continue;
    const pointer = `hosts.${verb}`;
    const platforms = requireArray(path, pointer, entry);
    if (platforms.length === 0) {
      throw new SchemaError(
        path,
        pointer,
        "lists no platform. An empty allowlist is a verb no host may ever run, which is what an `unsupported` verb row says properly",
      );
    }
    hosts[verb] = platforms.map((item, index): string =>
      requireString(path, `${pointer}[${index}]`, item),
    );
  }
  if (Object.keys(hosts).length === 0) {
    throw new SchemaError(
      path,
      "hosts",
      'declares no host constraint. Use "*" for a stack every platform can run, which is a claim worth stating rather than an omission',
    );
  }
  return hosts;
}

// The short form the summary grid prints for a cell that carries no command.
// REQUIRED on exactly the two forms the grid abbreviates, and refused on the
// three it does not, because a field nothing reads is a field nobody maintains.
function requireSummary(path: string, pointer: string, raw: Record<string, unknown>): string {
  return requireString(path, `${pointer}.summary`, raw["summary"]);
}

function refuseSummary(path: string, pointer: string, raw: Record<string, unknown>): void {
  if (raw["summary"] === undefined) return;
  throw new SchemaError(
    path,
    `${pointer}.summary`,
    "carries a summary, which only a `declaredOnly` or `unsupported` cell has: the grid prints the command itself for every other form, so this string would never be read",
  );
}

function parseVerb(path: string, pointer: string, value: unknown): ProfileVerb {
  const raw = requireRecord(path, pointer, value);
  const source = requireString(path, `${pointer}.source`, raw["source"]);

  // THE TWO CATALOGUE-ONLY FORMS FIRST, because ../schema/contract.ts's reader
  // knows nothing about them and would report "expected one of exe, steps or
  // unsupported" for a cell that is neither malformed nor its business.
  if (raw["declaredOnly"] !== undefined) {
    for (const other of ["exe", "steps", "unsupported", "delegatesTo"]) {
      if (raw[other] === undefined) continue;
      throw new SchemaError(
        path,
        pointer,
        `declares both 'declaredOnly' and '${other}'. A cell has exactly one form, and guessing which one wins is not this loader's to do`,
      );
    }
    return {
      kind: "declared-only",
      reason: requireString(path, `${pointer}.declaredOnly`, raw["declaredOnly"]),
      summary: requireSummary(path, pointer, raw),
      source,
    };
  }

  if (raw["delegatesTo"] !== undefined) {
    for (const other of ["exe", "steps", "unsupported"]) {
      if (raw[other] === undefined) continue;
      throw new SchemaError(
        path,
        pointer,
        `declares both 'delegatesTo' and '${other}'. A cell has exactly one form, and guessing which one wins is not this loader's to do`,
      );
    }
    const targets = requireArray(path, `${pointer}.delegatesTo`, raw["delegatesTo"]);
    if (targets.length === 0) {
      throw new SchemaError(
        path,
        `${pointer}.delegatesTo`,
        "delegates to no verb. A cell that delegates to nothing is a cell with no answer; state the verbs, or use `declaredOnly` with the reason",
      );
    }
    refuseSummary(path, pointer, raw);
    return {
      kind: "delegated",
      delegatesTo: targets.map((item, index): string =>
        requireString(path, `${pointer}.delegatesTo[${index}]`, item),
      ),
      why: requireString(path, `${pointer}.why`, raw["why"]),
      source,
    };
  }

  const invocation = parseInvocation(path, pointer, value);
  if (invocation.kind === "unsupported") {
    return { kind: "unsupported", invocation, summary: requireSummary(path, pointer, raw), source };
  }
  refuseSummary(path, pointer, raw);
  // EVERY COMMAND CELL CARRIES ITS `why`, and the declaration's reader makes it
  // optional. That is the one rule this loader tightens rather than borrows: a
  // catalogue row is READ BY A HUMAN DECIDING WHAT TO DECLARE, and a command
  // with no reason is the row that survives a refactor it should not have.
  if (invocation.why === null) {
    throw new SchemaError(
      path,
      `${pointer}.why`,
      "expected the reason this command is the reference for this stack, got nothing (the field is absent). A declaration may omit `why`; a catalogue entry may not -- the reason is what a reader is deciding on",
    );
  }
  return { kind: invocation.kind, invocation, source };
}

function parseVerbs(
  path: string,
  value: unknown,
  expected: readonly string[],
): Record<string, ProfileVerb> {
  const record = requireRecord(path, "verbs", value);
  const verbs: Record<string, ProfileVerb> = {};
  for (const [verb, entry] of Object.entries(record)) {
    if (verb.startsWith("$")) continue;
    verbs[verb] = parseVerb(path, `verbs.${verb}`, entry);
  }
  // EXACTLY THE INDEX'S VERBS -- no more, no fewer. The matrix is a comparison
  // across stacks, and a comparison with a hole in it is worse than no
  // comparison: a missing row renders as an absent cell that reads like a `-`,
  // and a stack that quietly answered a verb nobody else does would never
  // appear in the grid at all.
  const missing = expected.filter((verb): boolean => verbs[verb] === undefined);
  const extra = Object.keys(verbs).filter((verb): boolean => !expected.includes(verb));
  if (missing.length > 0 || extra.length > 0) {
    throw new SchemaError(
      path,
      "verbs",
      `must declare exactly the ${expected.length} verbs ${PACK_DIRECTORY}/${PACK_INDEX_FILE} lists${
        missing.length > 0 ? `; missing [${missing.join(", ")}]` : ""
      }${extra.length > 0 ? `; unknown [${extra.join(", ")}]` : ""}. Every profile answers every verb, using {"unsupported": "<why>"} for the ones this stack genuinely has none of`,
    );
  }
  return verbs;
}

function parseToolchain(path: string, value: unknown): Record<string, PackMinimum> {
  const record = requireRecord(path, "toolchain", value);
  const toolchain: Record<string, PackMinimum> = {};
  for (const [tool, entry] of Object.entries(record)) {
    if (tool.startsWith("$")) continue;
    const pointer = `toolchain.${tool}`;
    const raw = requireRecord(path, pointer, entry);
    if (raw["minimum"] === undefined) {
      throw new SchemaError(
        path,
        `${pointer}.minimum`,
        'expected the version nen has been tested against, or null, got nothing (the field is absent). Write null for a tool the inventory evidences as required and pins nowhere -- "presence only" is a true statement, and a floor nobody measured is not',
      );
    }
    toolchain[tool] = {
      tool,
      minimum: optionalString(path, `${pointer}.minimum`, raw["minimum"]),
      probe: requireArgv(path, `${pointer}.probe`, raw["probe"]),
      versionFrom: requireEnum(path, `${pointer}.versionFrom`, raw["versionFrom"], VERSION_FROM),
      installer: requireEnum(path, `${pointer}.installer`, raw["installer"], INSTALLERS),
      why: requireString(path, `${pointer}.why`, raw["why"]),
      source: requireString(path, `${pointer}.source`, raw["source"]),
    };
  }
  return toolchain;
}

function parseNotes(path: string, value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  const entries = requireArray(path, "notes", value);
  return entries.map((entry, index): string => requireString(path, `notes[${index}]`, entry));
}

/** Parse one `profiles/<id>.json`. Exported for the malformed-pack tests. */
export function parseProfile(
  path: string,
  expectedId: string,
  expectedVerbs: readonly string[],
  value: unknown,
): StackProfile {
  const raw = requireRecord(path, "(root)", value);
  const id = requireString(path, "id", raw["id"]);
  // THE FILENAME AND THE ID MUST AGREE. They are two spellings of one fact, and
  // the pack is addressed by both -- the index lists ids, the bundler names
  // files. A copied-and-half-edited profile is the exact way they come apart.
  if (id !== expectedId) {
    throw new SchemaError(
      path,
      "id",
      `is '${id}', but this document was read as '${expectedId}'. The id and the filename are the same fact spelled twice; ${PACK_DIRECTORY}/${PACK_INDEX_FILE} addresses the profile by id and the bundler addresses it by file`,
    );
  }
  return {
    id,
    displayName: requireString(path, "displayName", raw["displayName"]),
    markers: parseMarkers(path, raw["markers"]),
    hosts: parseHosts(path, raw["hosts"]),
    hostNote: requireString(path, "hostNote", raw["hostNote"]),
    scaffoldTemplate: optionalString(path, "scaffoldTemplate", raw["scaffoldTemplate"]),
    scaffoldNote: requireString(path, "scaffoldNote", raw["scaffoldNote"]),
    verbs: parseVerbs(path, raw["verbs"], expectedVerbs),
    toolchain: parseToolchain(path, raw["toolchain"]),
    notes: parseNotes(path, raw["notes"]),
    raw,
  };
}

interface PackIndex {
  readonly ids: readonly string[];
  readonly verbs: readonly string[];
}

/** Parse `profiles/index.json`. Exported for the malformed-pack tests. */
export function parsePackIndex(path: string, value: unknown): PackIndex {
  const raw = requireRecord(path, "(root)", value);
  const names = requireArray(path, "profiles", raw["profiles"]);
  if (names.length === 0) {
    throw new SchemaError(
      path,
      "profiles",
      "lists no profile. An empty pack is a matrix with no rows; list the stacks, or delete the override directory and let the bundled pack answer",
    );
  }
  const ids = names.map((item, index): string =>
    requireString(path, `profiles[${index}]`, item),
  );
  const duplicate = ids.find((id, index): boolean => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    throw new SchemaError(path, "profiles", `lists '${duplicate}' more than once`);
  }
  const verbNames = requireArray(path, "verbs", raw["verbs"]);
  if (verbNames.length === 0) {
    throw new SchemaError(
      path,
      "verbs",
      "lists no verb. This list is the matrix's columns and the check every profile is held to; an empty one makes both vacuous",
    );
  }
  const verbs = verbNames.map((item, index): string =>
    requireString(path, `verbs[${index}]`, item),
  );
  const duplicateVerb = verbs.find((verb, index): boolean => verbs.indexOf(verb) !== index);
  if (duplicateVerb !== undefined) {
    throw new SchemaError(path, "verbs", `lists '${duplicateVerb}' more than once`);
  }
  return { ids, verbs };
}

/**
 * Load the profiles pack: the one bundled in this binary, or the one in
 * `directory` when a caller passes `--profiles <dir>` through.
 *
 * THE OVERRIDE IS A PARAMETER, NOT AN ENVIRONMENT LOOKUP OR A GLOBAL. No verb
 * reads the pack yet, so there is no flag parser to hang it off; the shape is
 * fixed now so that when one arrives it threads a value rather than reaching
 * for ambient state. An override directory is validated exactly as the bundled
 * pack is -- a pack a caller supplied is not a pack nen trusts more.
 */
export function loadProfilesPack(directory: string | null = null): ProfilesPack {
  const origin = directory === null ? "<bundled>" : directory;
  const indexPath =
    directory === null ? bundledLabel(PACK_INDEX_FILE) : join(directory, PACK_INDEX_FILE);
  const indexValue =
    directory === null ? (indexDocument as unknown) : readJsonFile(indexPath);
  const { ids, verbs } = parsePackIndex(indexPath, indexValue);

  const profiles: Record<string, StackProfile> = {};
  for (const id of ids) {
    const file = `${id}.json`;
    if (directory === null) {
      const bundled = BUNDLED.find((entry): boolean => entry.file === file);
      if (bundled === undefined) {
        // Only reachable if the index and the import list above disagree --
        // which `pack.test.ts` fails the build on, and which would otherwise
        // ship as a stack the matrix silently skips.
        throw new SchemaError(
          indexPath,
          "profiles",
          `lists '${id}', which no bundled document answers. The import list in src/profiles/pack.ts must name ${PACK_DIRECTORY}/${file}: a bundler cannot follow a directory read, so a profile absent from that list is absent from the binary`,
        );
      }
      profiles[id] = parseProfile(bundledLabel(file), id, verbs, bundled.document);
      continue;
    }
    const path = join(directory, file);
    profiles[id] = parseProfile(path, id, verbs, readJsonFile(path));
  }

  return { ids, verbs, profiles, origin };
}

/** One profile by id, or a refusal naming every id the pack does carry. */
export function profileById(pack: ProfilesPack, id: string): StackProfile {
  const profile = pack.profiles[id];
  if (profile !== undefined) return profile;
  throw new SchemaError(
    pack.origin,
    "profiles",
    `carries no profile '${id}'. It carries: ${pack.ids.join(", ")}`,
  );
}

/** The verb cell for a profile, in the pack's own column order. */
export function verbCell(profile: StackProfile, verb: string): ProfileVerb {
  const cell = profile.verbs[verb];
  if (cell !== undefined) return cell;
  // Unreachable while `parseVerbs` holds every profile to the index's verbs;
  // stated as a refusal rather than a `!` so that a future caller asking for a
  // verb the pack does not have is told which ones it does.
  throw new SchemaError(
    profile.id,
    "verbs",
    `carries no verb '${verb}'. It carries: ${Object.keys(profile.verbs).join(", ")} (${describeValue(cell)})`,
  );
}
