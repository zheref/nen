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
// (`parseInvocation`, `requireArgv`, `requireEnum`, `parseHosts` from
// ../schema/contract.ts). A second copy of those rules here would be a second
// set of rules, and the two would drift in the direction of whichever file was
// edited last.
//
// UNKNOWN KEYS FOLLOW THE FAMILY'S CONVENTION, WHICH IS THE DECLARATION'S:
// unknown keys are PRESERVED (the whole document is kept on `raw`) and never
// refused, `$`-prefixed keys are skipped as commentary, and a MISSPELLING of a
// known key is therefore not detected -- it reads as an unknown key and the
// known one reads as absent, which is where the refusal lands. That is a real
// cost and it is paid on purpose: ../schema/contract.ts made the same trade for
// the declaration, and a catalogue that refused what the declaration preserves
// would teach a reader the wrong rule about the file they are about to write.
// An earlier draft of this file refused a stray `summary` on a cell the grid
// never abbreviates; it was the only key in the family treated that way, and it
// is gone.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  INSTALLERS,
  VERSION_FROM,
  parseHosts,
  parseInvocation,
  requireArgv,
  requireEnum,
  requireToolName,
  type Installer,
  type Invocation,
  type VersionFrom,
} from "../schema/contract.js";
import {
  optionalString,
  requireArray,
  requireRecord,
  requireString,
  SchemaError,
} from "../schema/errors.js";

// ── the bundled documents ───────────────────────────────────────────────────
//
// PURITY EXEMPTION, STATED HERE BECAUSE THE SWEEP CANNOT INFER IT. Four of
// these eight specifiers spell a toolchain's name (a build tool, an IDE, an SDK
// and a UI framework) inside a string literal, which is the shape
// ../taxonomy-purity.test.ts's FORBIDDEN list exists to catch -- and a planned
// extension of that sweep to toolchain names would report all eight.
//
// THEY ARE NOT VALUES THIS BINARY DECIDES WITH. They are FILE NAMES, and they
// are file names a bundler REQUIRES to be literal: `bun build --compile` embeds
// what a static import names and cannot follow a `readdirSync` (see this file's
// header). The stack set itself is data -- `profiles/index.json` -- and neither
// this module nor ../dev/matrix.ts branches on any of these strings; the loader
// looks a filename up in this list and nothing reads the id. If that sweep is
// extended, exempt THIS BLOCK by path and line, not the whole file: everything
// below it should still be held to the rule.

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

// ── placeholders ────────────────────────────────────────────────────────────

/**
 * Where a placeholder's value comes from -- the whole reason the set is typed
 * rather than being a list of strings.
 *
 *   * `host-conditional` -- nen resolves it from `process.platform`. Exactly
 *     one token is this, and a second would be a design change, not a data
 *     change: every other difference between hosts is a difference between
 *     REPOSITORIES, and a repository states its own.
 *   * `declaration-supplied` -- the consumer's `nen/contract.json` states the
 *     value. The pack may NEVER contribute one: a version, a path or a UDID
 *     from this file reaching a spawned command is the exact failure
 *     `inertness.test.ts` exists to prevent.
 */
export type PlaceholderKind = "host-conditional" | "declaration-supplied";

export interface Placeholder {
  /** The token as it appears in the data, braces included. */
  readonly token: string;
  readonly kind: PlaceholderKind;
  /** One line. It is rendered into the page verbatim. */
  readonly meaning: string;
}

/**
 * THE CLOSED SET OF PLACEHOLDERS THE PACK MAY USE.
 *
 * A catalogue command is a SHAPE, not a runnable line: `xcodebuild -project
 * {project} -scheme {scheme}` is true of every iOS repository and executable in
 * none of them. So the pack templates -- and the moment it does, the tokens
 * become an interface, because a reader copying a row into their declaration
 * has to know what to put in each one and PR 2's executor refuses a token that
 * survived to a spawn.
 *
 * THIS LIST IS WHY IT IS AN INTERFACE AND NOT A HABIT.
 * `requireKnownPlaceholders` below refuses any `{...}` in an `exe`, an `argv`
 * or a `toolchain.probe` that is not here, naming the file, the field and the
 * token; a test walks every
 * argv in every shipped profile and asserts membership; and ../dev/matrix.ts
 * renders the section of `docs/STACK-MATRIX.md` that explains them FROM THIS
 * CONST, so a token cannot be added without being explained.
 *
 * MARKER PATTERNS ARE NOT SCANNED, deliberately: `settings.gradle{,.kts}` and
 * `*.config.{js,mjs,ts}` are brace GLOBS, a different language that happens to
 * share a delimiter, and holding them to this set would refuse three correct
 * markers to enforce a rule about commands.
 *
 * Sorted by token -- by code unit, which is why `{packageManager}` precedes
 * `{package}` -- so this list, the refusal's message and the rendered section
 * all read in one order, and a test pins it.
 */
export const PLACEHOLDERS: readonly Placeholder[] = [
  {
    token: "{app}",
    kind: "declaration-supplied",
    meaning:
      "the workspace an end-to-end or Storybook command is filtered to, in a monorepo whose root script fans out.",
  },
  {
    token: "{archiveScript}",
    kind: "declaration-supplied",
    meaning:
      "the repository's own archive script, as a path relative to the repository root -- the script is that repository's, not this stack's.",
  },
  {
    token: "{browserPath}",
    kind: "declaration-supplied",
    meaning:
      "the installed browser binary an archive step probes for, as an absolute path -- the probe is for presence, and the location is the machine's.",
  },
  {
    token: "{destination}",
    kind: "declaration-supplied",
    meaning:
      "an `xcodebuild -destination` argument, in either of its two forms: `id=<udid>`, or a `platform=...,name=...,OS=...` selector.",
  },
  {
    token: "{gw}",
    kind: "host-conditional",
    meaning:
      "the repository's Gradle wrapper: `./gradlew` on darwin and linux, `gradlew.bat` on win32. THE ONE TOKEN NEN RESOLVES ITSELF, from `process.platform` -- a lane with no wrapper is a finding, never an install.",
  },
  {
    token: "{name}",
    kind: "declaration-supplied",
    meaning:
      "the test-case name in an `-only-testing:<target>/<name>` selector, for the local subset form.",
  },
  {
    token: "{packageManager}",
    kind: "declaration-supplied",
    meaning:
      "the declaration's own `packageManager` PIN, `<name>@<version>`, as corepack activates it. Distinct from `{pm}`, and the distinction is the point: this one carries a VERSION, and a version in an install argv may only ever come from the declaration.",
  },
  {
    token: "{package}",
    kind: "declaration-supplied",
    meaning:
      "one workspace package the command runs for. The row is templated because the command runs ONCE PER PACKAGE, and the package names are the repository's.",
  },
  {
    token: "{platform}",
    kind: "declaration-supplied",
    meaning:
      "the native lane an `expo run:<platform>` targets. Neither lane is the other's default, so the pack templates rather than picks.",
  },
  {
    token: "{pm}",
    kind: "declaration-supplied",
    meaning:
      "the repository's package-manager EXECUTABLE, from its own `packageManager` field. The command name only; the pinned version is `{packageManager}`.",
  },
  {
    token: "{project}",
    kind: "declaration-supplied",
    meaning:
      "the Xcode project the build addresses -- and, for a workspace-based repository, the flag changes with it.",
  },
  {
    token: "{resultBundle}",
    kind: "declaration-supplied",
    meaning:
      "the `.xcresult` bundle path a test run writes and the coverage step then reads. The same value in both steps, which is why the row is a two-step cell and not two rows.",
  },
  {
    token: "{scheme}",
    kind: "declaration-supplied",
    meaning: "the Xcode scheme to build, test or archive.",
  },
  {
    token: "{simUdid}",
    kind: "declaration-supplied",
    meaning:
      "the UDID of the simulator the run is pinned to. CI creates and boots one per runner; a name-based destination is the other observed form.",
  },
  {
    token: "{testTarget}",
    kind: "declaration-supplied",
    meaning:
      "the test target in an `-only-testing:<target>/<name>` selector, for the local subset form.",
  },
  {
    token: "{unitTestTask}",
    kind: "declaration-supplied",
    meaning:
      "the repository's own JVM unit-test Gradle task, module path included -- the module name is that repository's, not this stack's.",
  },
  {
    token: "{workload}",
    kind: "declaration-supplied",
    meaning:
      "the Visual Studio workload id a `vswhere -requires` probe asks for. It names what must be INSTALLED, and the probe never installs it.",
  },
];

const PLACEHOLDER_TOKENS: ReadonlySet<string> = new Set(
  PLACEHOLDERS.map((placeholder): string => placeholder.token),
);

// Matched braces only. An argv is data, not a template language: `{` with no
// `}` is a literal brace some tool wanted, and refusing it would be this file
// inventing a syntax rule for shells it does not run.
const PLACEHOLDER_PATTERN = /\{[^{}]*\}/g;

/**
 * Refuse any placeholder an argv uses that this pack does not document.
 *
 * NAMED SEPARATELY FROM THE VALUE CHECKS, because the failure it prevents is
 * not a malformed document: a profile carrying `{someUnknownPlaceholder}`
 * parses, renders, and ships a row whose reader has no way to learn what to
 * substitute. The refusal names the file, the field and the token, and lists
 * the set -- which is the whole answer to "then what should I have written".
 */
export function requireKnownPlaceholders(path: string, pointer: string, text: string): string {
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const token = match[0];
    if (PLACEHOLDER_TOKENS.has(token)) continue;
    throw new SchemaError(
      path,
      pointer,
      `uses the placeholder '${token}', which this pack does not document. Placeholders are a CLOSED set (src/profiles/pack.ts, PLACEHOLDERS): ${PLACEHOLDERS.map(
        (placeholder): string => placeholder.token,
      ).join(
        ", ",
      )}. A reader substitutes each one from their own nen/contract.json, so a token nothing explains is a row nobody can use; add it to that const with its meaning, or spell the existing one`,
    );
  }
  return text;
}

/** The same check over every element of an argv, pointing at the element. */
export function parsePlaceholders(
  path: string,
  pointer: string,
  argv: readonly string[],
): readonly string[] {
  argv.forEach((item, index): void => {
    requireKnownPlaceholders(path, `${pointer}[${index}]`, item);
  });
  return argv;
}

// The same check over a parsed invocation, in whichever of its two command
// shapes the cell used. An `unsupported` cell has no argv to check.
function checkInvocationPlaceholders(path: string, pointer: string, invocation: Invocation): void {
  if (invocation.kind === "command") {
    requireKnownPlaceholders(path, `${pointer}.exe`, invocation.exe);
    parsePlaceholders(path, `${pointer}.argv`, invocation.argv);
    return;
  }
  if (invocation.kind === "steps") {
    invocation.steps.forEach((step, index): void => {
      requireKnownPlaceholders(path, `${pointer}.steps[${index}].exe`, step.exe);
      parsePlaceholders(path, `${pointer}.steps[${index}].argv`, step.argv);
    });
  }
}

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
  /**
   * The subset of `verbs` that names a command a repository RUNS.
   *
   * THE PAGE'S ONE HONEST NUMBER IS COUNTED OVER THESE. The other rows describe
   * what nen does AROUND a build -- a marker match, a toolchain report, a
   * delegation -- and folding them into the ratio moves it in both directions
   * at once. It is data (`profiles/index.json`) so that ../dev/matrix.ts can
   * say which rows those are without naming one.
   */
  readonly commandVerbs: readonly string[];
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

// The declaration's own `hosts` reader, plus the two refusals a CATALOGUE needs
// and a declaration does not.
//
// THE PLATFORM NAMES ARE VALIDATED IN ../schema/contract.ts, against
// `HOST_PLATFORMS`, so both readers gained the check at once. It is the one
// place a typo is visible: `hosts` is an ALLOWLIST, so `"macos"` does not fail,
// it silently removes the verb from every machine that exists.
function parsePackHosts(path: string, value: unknown): Record<string, readonly string[]> {
  const hosts = parseHosts(path, "hosts", value);
  for (const [verb, platforms] of Object.entries(hosts)) {
    if (platforms.length > 0) continue;
    throw new SchemaError(
      path,
      `hosts.${verb}`,
      "lists no platform. An empty allowlist is a verb no host may ever run, which is what an `unsupported` verb row says properly",
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
// REQUIRED on exactly the two forms the grid abbreviates. It is NOT refused on
// the three it does not: an unread key on a cell is an unknown key, and this
// family preserves those (see this file's header).
function requireSummary(path: string, pointer: string, raw: Record<string, unknown>): string {
  return requireString(path, `${pointer}.summary`, raw["summary"]);
}

// ── cell forms ──────────────────────────────────────────────────────────────
//
// A verb's cell is exactly one of FIVE forms -- three the declaration's own
// (`command`, `steps`, `unsupported`, parsed by ../schema/contract.ts) and two
// that exist only in a catalogue (`declaredOnly`, `delegatesTo`; see
// `ProfileVerb`'s doc comment above for what each means). Each form is named
// here by the ONE key whose presence marks a raw cell as that form (`exe` for
// `command`, since a cell never literally spells "command"), plus the small
// set of companion keys it owns besides that marker and `source`, which every
// form carries and which is read before any of this runs.
//
// ONE TABLE, ONE CHECK. `declaredOnly` and `delegatesTo` are the two forms
// this file itself must police, because ../schema/contract.ts has never heard
// of them -- and a cell mixing either with a key from another form (an `argv`
// beside a `declaredOnly`, a `declaredOnly` beside a `delegatesTo`, a `why`
// beside neither `command`, `steps` nor `delegatesTo`) is a mixed-form
// authoring error the same way declaring two of `exe`/`steps`/`unsupported`
// already is. `refuseStrayFormKeys` below reads this table rather than a
// second, hand-maintained list of "the other keys" per form -- which is
// exactly how `argv` and `why` went missing from those lists the first time --
// so a SIXTH form joins the same check by adding one row here.
interface CellForm {
  readonly name: string;
  /** The key whose presence marks a raw cell as this form. */
  readonly marker: string;
  /** Keys this form legitimately carries besides its marker and `source`. */
  readonly ownKeys: readonly string[];
}

const CELL_FORMS: readonly CellForm[] = [
  { name: "command", marker: "exe", ownKeys: ["argv", "why"] },
  { name: "steps", marker: "steps", ownKeys: ["why"] },
  { name: "unsupported", marker: "unsupported", ownKeys: [] },
  { name: "declaredOnly", marker: "declaredOnly", ownKeys: [] },
  { name: "delegatesTo", marker: "delegatesTo", ownKeys: ["why"] },
];

// Every key ANY form's marker or companion names -- the vocabulary a stray key
// is drawn from. `summary` and `source` are deliberately absent: `summary` is
// unread outside the two forms that abbreviate it and preserved everywhere
// else (this file's header explains why), and `source` is common to every
// cell rather than belonging to one form.
const ALL_FORM_KEYS: readonly string[] = [
  ...new Set(CELL_FORMS.flatMap((form): readonly string[] => [form.marker, ...form.ownKeys])),
];

/**
 * Refuse a cell that carries a key belonging to a form OTHER than `formName`.
 * Every key `ALL_FORM_KEYS` lists that is present on `raw` and not one of this
 * form's own is named together in one refusal -- not just the first found, so
 * a reader fixing the cell sees the whole mistake at once, not one key per
 * re-run.
 */
function refuseStrayFormKeys(
  path: string,
  pointer: string,
  raw: Record<string, unknown>,
  formName: string,
): void {
  const form = CELL_FORMS.find((entry): boolean => entry.name === formName);
  if (form === undefined) return;
  const allowed = new Set<string>([form.marker, ...form.ownKeys]);
  const strays = ALL_FORM_KEYS.filter(
    (key): boolean => !allowed.has(key) && raw[key] !== undefined,
  );
  if (strays.length === 0) return;
  throw new SchemaError(
    path,
    pointer,
    `declares '${form.marker}' alongside ${strays.map((key): string => `'${key}'`).join(", ")}. A cell has exactly one form, and guessing which one wins is not this loader's to do`,
  );
}

function parseVerb(
  path: string,
  pointer: string,
  value: unknown,
  expectedVerbs: readonly string[],
): ProfileVerb {
  const raw = requireRecord(path, pointer, value);
  const source = requireString(path, `${pointer}.source`, raw["source"]);

  // THE TWO CATALOGUE-ONLY FORMS FIRST, because ../schema/contract.ts's reader
  // knows nothing about them and would report "expected one of exe, steps or
  // unsupported" for a cell that is neither malformed nor its business.
  if (raw["declaredOnly"] !== undefined) {
    refuseStrayFormKeys(path, pointer, raw, "declaredOnly");
    return {
      kind: "declared-only",
      reason: requireString(path, `${pointer}.declaredOnly`, raw["declaredOnly"]),
      summary: requireSummary(path, pointer, raw),
      source,
    };
  }

  if (raw["delegatesTo"] !== undefined) {
    refuseStrayFormKeys(path, pointer, raw, "delegatesTo");
    const targets = requireArray(path, `${pointer}.delegatesTo`, raw["delegatesTo"]);
    if (targets.length === 0) {
      throw new SchemaError(
        path,
        `${pointer}.delegatesTo`,
        "delegates to no verb. A cell that delegates to nothing is a cell with no answer; state the verbs, or use `declaredOnly` with the reason",
      );
    }
    return {
      kind: "delegated",
      // EVERY TARGET IS A VERB THE INDEX LISTS. The point of this form is that
      // a reader can FOLLOW it -- "this row's answer is that row's" -- and a
      // target no column carries is a pointer at an empty seat. It renders as
      // a plausible `delegates to \`x\`` in the grid, which is the failure
      // shape worth refusing: wrong, and formatted exactly like right.
      delegatesTo: targets.map((item, index): string => {
        const at = `${pointer}.delegatesTo[${index}]`;
        const target = requireString(path, at, item);
        if (!expectedVerbs.includes(target)) {
          throw new SchemaError(
            path,
            at,
            `delegates to '${target}', which ${PACK_DIRECTORY}/${PACK_INDEX_FILE} does not list as a verb. A delegation names a row of this same matrix, and the matrix's rows are [${expectedVerbs.join(", ")}]`,
          );
        }
        return target;
      }),
      why: requireString(path, `${pointer}.why`, raw["why"]),
      source,
    };
  }

  const invocation = parseInvocation(path, pointer, value);
  // THE SAME CHECK, for the three forms ../schema/contract.ts already knows
  // how to tell apart from each other. It cannot know about `declaredOnly` or
  // `delegatesTo` -- so this closes the one gap borrowing `parseInvocation`
  // leaves open, a stray `why` on an `unsupported` cell, without restating
  // the exe/steps/unsupported exclusivity that file already owns.
  refuseStrayFormKeys(path, pointer, raw, invocation.kind);
  if (invocation.kind === "unsupported") {
    return { kind: "unsupported", invocation, summary: requireSummary(path, pointer, raw), source };
  }
  checkInvocationPlaceholders(path, pointer, invocation);
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
    verbs[verb] = parseVerb(path, `verbs.${verb}`, entry, expected);
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
    // THE SAME NAME RULE THE CONTRACT LOADER APPLIES, imported rather than
    // restated: `nen shu detect` copies a row of this block into a proposed
    // declaration, and a name that loader would refuse would make the proposal
    // unreadable by the program that wrote it.
    requireToolName(path, "toolchain", tool);
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
      // A PROBE ARGV IS TEMPLATED TOO, and that is the argv a reader is most
      // likely to copy without reading -- so it is held to the same closed set.
      probe: parsePlaceholders(
        path,
        `${pointer}.probe`,
        requireArgv(path, `${pointer}.probe`, raw["probe"]),
      ),
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
    hosts: parsePackHosts(path, raw["hosts"]),
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
  readonly commandVerbs: readonly string[];
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
  // WHICH VERBS NAME A SPAWNED COMMAND -- data, because the renderer must state
  // the grid's ratio over them and may not contain a verb name to do it.
  const commandNames = requireArray(path, "commandVerbs", raw["commandVerbs"]);
  if (commandNames.length === 0) {
    throw new SchemaError(
      path,
      "commandVerbs",
      "lists no verb. This list is what the summary's ratio is counted over; an empty one makes the one honest number in the page vacuous",
    );
  }
  const commandVerbs = commandNames.map((item, index): string => {
    const pointer = `commandVerbs[${index}]`;
    const verb = requireString(path, pointer, item);
    if (!verbs.includes(verb)) {
      throw new SchemaError(
        path,
        pointer,
        `is '${verb}', which is not one of the verbs this index lists [${verbs.join(", ")}]. This is a SUBSET of them, not a second vocabulary`,
      );
    }
    return verb;
  });
  const duplicateCommand = commandVerbs.find(
    (verb, index): boolean => commandVerbs.indexOf(verb) !== index,
  );
  if (duplicateCommand !== undefined) {
    throw new SchemaError(path, "commandVerbs", `lists '${duplicateCommand}' more than once`);
  }
  return { ids, verbs, commandVerbs };
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
  const { ids, verbs, commandVerbs } = parsePackIndex(indexPath, indexValue);

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

  // A `<id>.json` IN THE DIRECTORY AND ABSENT FROM THE INDEX IS REFUSED, which
  // is the same rule the bundled pack is held to and the same reason.
  //
  // `pack.test.ts` pins the bundled import list against `profiles/` in both
  // directions, so a stack added as a file and forgotten in the index fails the
  // build rather than shipping as a silently absent row. An override directory
  // had NO such check -- an author who dropped a file in and forgot the index
  // line got a pack that loaded cleanly and rendered a matrix with their stack
  // missing, and the only symptom was an absence. The asymmetry was the defect:
  // an override is validated exactly as the bundled pack is, or the two teach
  // different rules about the same directory layout.
  if (directory !== null) {
    const listed = new Set(ids.map((id): string => `${id}.json`));
    const stray = readdirSync(directory)
      .filter(
        (file): boolean =>
          file.endsWith(".json") && file !== PACK_INDEX_FILE && !listed.has(file),
      )
      .sort();
    if (stray.length > 0) {
      throw new SchemaError(
        indexPath,
        "profiles",
        `does not list [${stray.join(", ")}], which ${directory} holds. A profile the index omits is a stack that loads nowhere and renders in no row -- an absence with no message. List it, or delete the file`,
      );
    }
  }

  return { ids, verbs, commandVerbs, profiles, origin };
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
  //
  // The message says "nothing" rather than describing `cell`, because on this
  // line `cell` is PROVABLY undefined -- the branch above returned every other
  // case -- and a `describeValue` of it could only ever print the one word it
  // already knows. Naming the constant is the honest version of that call.
  throw new SchemaError(
    profile.id,
    "verbs",
    `carries no verb '${verb}' (nothing is stored under that key). It carries: ${Object.keys(profile.verbs).join(", ")}`,
  );
}
