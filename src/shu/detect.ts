// src/shu/detect.ts -- read the markers on disk and PROPOSE a `project` block.
// It never decides, and without `--write` it never writes.
//
// WHY MARKERS ARE LEGITIMATELY CODE, when nothing else in this family is. A
// FILENAME is a universal fact -- `next.config.mjs` means the same thing in
// every repository on earth -- while a repository's lane names, its argv, its
// preconditions and its targets are that repository's own vocabulary, which §3
// forbids this binary from deciding. So the marker table lives here and the argv
// table does not: the argv comes from ../profiles/pack.ts, is proposed rather
// than run, and is cross-checked against what the repository actually declares
// before it is even proposed.
//
// THIS IS THE ONE MODULE IN THE FAMILY THAT READS THE PACK, and the reason it
// may is a property rather than a promise: ../profiles/inertness.test.ts sweeps
// the whole import graph and fails the build if anything that can spawn a
// process reaches the pack, at any depth. `detect` spawns nothing. It writes a
// FILE a human then edits, and the executor (./render.ts, ./run.ts) has no
// parameter a pack could arrive through.
//
// THE THREE THINGS THIS VERB WILL NOT DO, each of which is a temptation the
// design names by hand:
//
//   1. **It never resolves an ambiguity.** A tree carrying two lanes' markers
//      gets two lanes and `defaultLane: null`, plus a note. Choosing for the
//      caller is how a scripted `nen shu build` silently starts building
//      something else the day a second lane appears.
//   2. **It never proposes a command the repository cannot run.** Every cell
//      the pack carries is substituted and then cross-checked against the
//      lane's own `package.json`; a row that fails any check is WITHHELD with
//      the reason, never proposed unverified. A proposal a human pastes and
//      then discovers is fiction is worse than an empty map with a reason.
//   3. **It never overwrites a declaration.** A declaration is a DECISION, and
//      `--write` over one would overwrite a decision with an inference. There
//      is no `--force`: the block is printed, and a human merges it.
//
// THE ONE THING IT DOES WRITE WITHOUT A COMMAND TO READ: an `unsupported` SEAT.
// Every verb in the pack's `commandVerbs` gets a row -- a command where the
// repository's own manifest confirms one, and `{"unsupported": "<the pack's own
// reason, quoted>"}` where the pack has none. That is not this file deciding: it
// is the catalogue's sentence, in the one form a declaration can carry it, in a
// row a maintainer replaces. It is also what makes the proposal LOADABLE, which
// is the argument that settles it -- ../schema/contract.ts refuses a lane whose
// verb map is empty, by name, so a tree whose every command row was withheld
// used to get a file the very next `nen shu build` rejected. `proposeVerbs`
// below carries the full argument.
//
// A `Makefile` IS A FINDING, NEVER A PROPOSAL. Whether a repository routes its
// verbs through one is that repository's call to write down; nen proposing it
// would be nen choosing an indirection layer for somebody.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import {
  loadProfilesPack,
  PLACEHOLDERS,
  profileById,
  verbCell,
  type ProfilesPack,
  type ProfileVerb,
  type StackProfile,
} from "../profiles/pack.js";
import { CONTRACT_FILE, resolveSchemaFile } from "../schema/source.js";
import { parseYaml } from "../schema/yaml.js";

/** Directories a marker scan never descends into. */
const SKIP = new Set([
  ".git",
  ".next",
  ".gradle",
  ".idea",
  ".nen",
  "node_modules",
  "build",
  "dist",
  "out",
  "vendor",
  "Pods",
  "DerivedData",
]);

/**
 * How deep the scan goes.
 *
 * Bounded on purpose. The lanes this exists to find sit at a repository root or
 * one or two directories down (a workspace, an `android/` sibling); an unbounded
 * walk of a large checkout is slow, and a marker eight directories down inside
 * somebody's fixture tree is far more likely to be test data than a lane.
 *
 * THE BOUND IS A REAL BLIND SPOT AND IS SAID OUT LOUD: a lane deeper than this,
 * or one living in a directory named like build output, is invisible to the
 * scan. `renderDetect`'s "no lane detected" prose names both, because a silent
 * miss and an empty tree look identical from the outside.
 */
export const MAX_DEPTH = 3;

const NEXT_CONFIG = /^next\.config\.(js|mjs|cjs|ts|mts|cts)$/;
const GATSBY_CONFIG = /^gatsby-config\.(js|mjs|cjs|ts)$/;
const APP_CONFIG = /^app\.config\.(js|mjs|cjs|ts)$/;
const XCWORKSPACE = /\.xcworkspace$/;
const XCODEPROJ = /\.xcodeproj$/;
const CSPROJ = /\.csproj$/;
const GRADLE_BUILD = /^build\.gradle(\.kts)?$/;

/** The Android Gradle plugin's own id, as a build file applies it. */
const AGP_MARKER = "com.android.application";
/** The desktop packaging block a Compose Multiplatform desktop target declares. */
const COMPOSE_DESKTOP_MARKER = "compose.desktop";
/** The one element that separates a WinUI app from every other .NET project. */
const WINUI_MARKER = "<UseWinUI>";
/** The key an app manifest carries when the project is an Expo one. */
const EXPO_MANIFEST_KEY = "expo";

/**
 * Every stack id `matchesIn` below can answer with.
 *
 * IT IS ASSERTED AGAINST THE PACK'S OWN ID LIST (./detect.test.ts), in both
 * directions. A marker answering a stack the pack has no profile for is a lane
 * whose verb lookup throws; a profile no marker can reach is a stack `detect`
 * can never propose, which is a gap worth failing the build over rather than
 * discovering from a user.
 */
export const MARKER_STACKS: readonly string[] = [
  "compose-desktop",
  "dotnet-winui",
  "expo",
  "gatsby",
  "gradle-android",
  "nextjs",
  "xcode-ios",
];

export interface DetectedLane {
  readonly lane: string;
  readonly stack: string;
  /** Repo-relative, forward-slashed. `.` for the repository root. */
  readonly cwd: string;
  /**
   * The repo-relative paths that identified this stack in this directory, in
   * the order they were found. Usually one; a tree carrying `next.config.js`
   * AND `next.config.mjs` matches twice and is ONE lane with two markers, not
   * two lanes with one each.
   */
  readonly markers: readonly string[];
  /** The proposed per-verb argv, empty when nothing could be cross-checked. */
  readonly verbs: Readonly<Record<string, unknown>>;
  readonly notes: readonly string[];
}

export interface DetectReport {
  readonly contract: string;
  readonly repo: string;
  readonly declaration: string;
  readonly declarationPresent: boolean;
  readonly lanes: readonly DetectedLane[];
  /** The document to paste, or null when nothing was found. */
  readonly proposal: Readonly<Record<string, unknown>> | null;
  readonly notes: readonly string[];
  /** The path written, or null -- and null is the default. */
  readonly written: string | null;
  readonly exitCode: number;
}

export const DETECT_CONTRACT = "nen.shu.detect/v0.1";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    // A MALFORMED MARKER IS NOT A MATCH. `detect` reads a file to CONFIRM a
    // marker, never to validate it: refusing the whole scan because one
    // package.json has a trailing comma would make a proposal impossible for
    // the repository most in need of one.
    return null;
  }
}

export interface Entry {
  readonly name: string;
  readonly directory: boolean;
}

/**
 * BYTE ORDER (code unit), the one order anything in this file sorts in.
 *
 * `localeCompare` is the tempting alternative and is wrong for every sort here:
 * it depends on the machine's collation, so `apps/Beta` and `apps/alpha` come
 * back in one order under an ICU build and the other under a locale that folds
 * case -- which is the SAME class of bug as an unsorted `readdirSync`, one layer
 * up, and harder to see because it reproduces on the machine that wrote it.
 * Byte order is ugly on purpose (`Beta` before `alpha`, because `B` is 0x42 and
 * `a` is 0x61) and it is the same everywhere.
 */
function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The reader `listDirectory` sorts. A SEAM, so the order can be pinned.
 *
 * It exists because a test over a real directory can only assert what THAT
 * host's `readdirSync` happened to return -- which is precisely the thing this
 * module may not trust (see below). Injecting the entries turns "the sort is
 * byte order" from a claim about a filesystem into an assertion about a
 * function.
 */
export type DirectoryReader = (path: string) => readonly Entry[];

const readEntries: DirectoryReader = (path): readonly Entry[] => {
  try {
    return readdirSync(path, { withFileTypes: true }).map(
      (entry): Entry => ({ name: entry.name, directory: entry.isDirectory() }),
    );
  } catch {
    return [];
  }
};

/**
 * One directory's entries, SORTED BY BYTE ORDER.
 *
 * `readdirSync` returns whatever order the host hands back, and the host is not
 * ONE host: this suite runs under Node and the shipped binary is Bun, and the
 * two answer the same directory differently. Reproduced on one machine, over
 * one directory, in the same second -- three files created in the order `zulu`,
 * `Beta`, `alpha`:
 *
 *     node -> ["Beta","alpha","zulu"]      bun -> ["Beta","zulu","alpha"]
 *
 * That is not a checkout being rewritten between two runs; it is two runtimes
 * reading one unchanged directory, and it reproduces every time. So the suite
 * agreeing with itself proves nothing about what a user's binary does, which is
 * the whole reason the sort is here rather than left to the platform.
 *
 * Unsorted, a proposal is not reproducible: the LANE ORDER changes (which
 * changes the order `--lane`'s refusal lists them in, and the key order of the
 * written file), the MARKER list for a lane that matched twice changes, and --
 * the one that is a correctness problem rather than a cosmetic one --
 * `laneName`'s collision suffixes are assigned in iteration order, so two lanes
 * competing for one name could swap between two runs over the same tree.
 *
 * Sorting here fixes every caller at once: the marker scan, the walk and the
 * workspace-member expansion all read through this one function, and nothing
 * downstream sorts a second time.
 */
export function listDirectory(
  path: string,
  read: DirectoryReader = readEntries,
): readonly Entry[] {
  return [...read(path)].sort((a, b): number => compareBytes(a.name, b.name));
}

function relativePath(repoRoot: string, path: string): string {
  const rel = relative(repoRoot, path);
  return rel === "" ? "." : rel.split(sep).join("/");
}

interface Match {
  readonly stack: string;
  readonly marker: string;
}

/** Whether any build file in or under this directory carries a text marker. */
function buildFileCarries(directory: string, needle: string, depth: number): string | null {
  for (const entry of listDirectory(directory)) {
    const path = join(directory, entry.name);
    if (entry.directory) {
      if (depth === 0 || SKIP.has(entry.name)) continue;
      const found = buildFileCarries(path, needle, depth - 1);
      if (found !== null) return found;
      continue;
    }
    if (!GRADLE_BUILD.test(entry.name)) continue;
    if ((readText(path) ?? "").includes(needle)) return path;
  }
  return null;
}

/** Every stack whose markers this ONE directory carries. */
function matchesIn(repoRoot: string, directory: string): readonly Match[] {
  const entries = listDirectory(directory);
  const names = entries.map((entry): string => entry.name);
  const found: Match[] = [];
  const add = (stack: string, marker: string): void => {
    found.push({ stack, marker: relativePath(repoRoot, marker) });
  };

  for (const name of names) {
    if (NEXT_CONFIG.test(name)) add("nextjs", join(directory, name));
    if (GATSBY_CONFIG.test(name)) add("gatsby", join(directory, name));
  }

  // Expo: an app manifest that actually SAYS so. `app.json` is a filename a
  // dozen unrelated tools use, so the key inside it is the marker -- and the
  // JS/TS manifest form, which cannot be read without executing it, is
  // confirmed against the dependency the repository declares instead.
  const appJson = names.includes("app.json") ? readJson(join(directory, "app.json")) : null;
  if (appJson !== null && appJson[EXPO_MANIFEST_KEY] !== undefined) {
    add("expo", join(directory, "app.json"));
  } else {
    const appConfig = names.find((name): boolean => APP_CONFIG.test(name));
    if (appConfig !== undefined && dependsOn(readJson(join(directory, "package.json")), EXPO_MANIFEST_KEY)) {
      add("expo", join(directory, appConfig));
    }
  }

  // Apple: the workspace is PREFERRED over the project, because a tree carrying
  // both is one where building the project directly skips the dependency
  // manager's own generated targets.
  const workspace = names.find((name): boolean => XCWORKSPACE.test(name));
  const project = names.find((name): boolean => XCODEPROJ.test(name));
  if (workspace !== undefined) add("xcode-ios", join(directory, workspace));
  else if (project !== undefined) add("xcode-ios", join(directory, project));

  if (names.includes("gradlew") || names.includes("gradlew.bat")) {
    const agp = buildFileCarries(directory, AGP_MARKER, 2);
    if (agp !== null) add("gradle-android", agp);
    const desktop = buildFileCarries(directory, COMPOSE_DESKTOP_MARKER, 2);
    if (desktop !== null) add("compose-desktop", desktop);
  }

  for (const name of names) {
    if (!CSPROJ.test(name)) continue;
    if ((readText(join(directory, name)) ?? "").includes(WINUI_MARKER)) {
      add("dotnet-winui", join(directory, name));
    }
  }

  return found;
}

function dependsOn(packageJson: Record<string, unknown> | null, dependency: string): boolean {
  if (packageJson === null) return false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const block = packageJson[field];
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
    if (Object.prototype.hasOwnProperty.call(block, dependency)) return true;
  }
  return false;
}

/** Every directory with markers, deepest-last, root first. */
function scan(repoRoot: string): readonly { directory: string; matches: readonly Match[] }[] {
  const out: { directory: string; matches: readonly Match[] }[] = [];
  const walk = (directory: string, depth: number): void => {
    const matches = matchesIn(repoRoot, directory);
    if (matches.length > 0) out.push({ directory, matches });
    if (depth === 0) return;
    for (const entry of listDirectory(directory)) {
      if (!entry.directory || SKIP.has(entry.name)) continue;
      // A bundle IS a directory on disk; descending into one finds the same
      // marker again one level down and proposes a phantom lane.
      if (XCWORKSPACE.test(entry.name) || XCODEPROJ.test(entry.name)) continue;
      walk(join(directory, entry.name), depth - 1);
    }
  };
  walk(repoRoot, MAX_DEPTH);
  return out;
}

/**
 * A lane's name: the directory it lives in, or the stack id at the root.
 *
 * DETERMINISTIC AND COLLISION-FREE, because a lane name is what a caller types
 * into `--lane` and what a script pins. Two stacks in ONE subdirectory are both
 * qualified by their stack id -- `web-gatsby` and `web-nextjs`, never `web` and
 * `web-nextjs`, which would give one of the two the unqualified name for no
 * reason a reader could see and would change the day a marker was deleted.
 */
function laneName(cwd: string, stack: string, qualify: boolean, taken: ReadonlySet<string>): string {
  const directory = cwd === "." ? stack : (cwd.split("/").pop() ?? stack);
  // At the repository root the base IS the stack id, so qualifying would spell
  // it twice.
  const base = qualify && cwd !== "." ? `${directory}-${stack}` : directory;
  if (!taken.has(base)) return base;
  const qualified = `${directory}-${stack}`;
  if (!taken.has(qualified)) return qualified;
  for (let index = 2; ; index += 1) {
    const numbered = `${qualified}-${index}`;
    if (!taken.has(numbered)) return numbered;
  }
}

// ── the cross-checks ────────────────────────────────────────────────────────
//
// RE-HOMED ONTO PR 3's PACK, AND DERIVED RATHER THAN DECLARED. An earlier draft
// of this file read two extra fields off its own private pack -- a
// `requiresDependency` per verb and a `packageManager` per stack -- and PR 3
// (zheref/nen#112) shipped the pack for all seven stacks without either. The
// three ways to put them back, and why this is the one taken:
//
//   (a) ADD THE FIELDS TO PR 3's PROFILES. Rejected. The pack is a CATALOGUE of
//       what seven product repositories were observed to run, every cell cited
//       to a file and a line; `requiresDependency` is not an observation about
//       those repositories, it is an instruction to THIS verb about how to
//       check a different repository. Detection knowledge in the catalogue is
//       how a catalogue starts deciding.
//   (b) DERIVE THE CHECKS FROM THE ROW ITSELF -- taken, below. Everything these
//       checks need is already in the argv the pack states plus the manifest
//       the target repository states, and neither file grows a field.
//   (c) A CROSS-CHECK TABLE LOCAL TO THIS FILE. Rejected for the reason the
//       marker table is KEPT: a marker is a universal fact about a filename,
//       and "this argv needs that package" is not -- it is a per-stack, per-row
//       claim, which is exactly the shape of thing §3 says this binary may not
//       carry. A hand table here would also have to be edited every time the
//       pack gained a row, silently, with no test able to notice it had not
//       been.
//
// So the checks below are syntactic rules over the SUBSTITUTED argv, and they
// name no tool:
//
//   1. PLACEHOLDERS. `{pm}` and `{packageManager}` are answered by the lane's
//      own `package.json` (`packageManager: "<name>@<version>"`), which is the
//      repository's statement about itself and never the pack's. `{package}` is
//      answered by that manifest's own `name` AND ONLY WHEN THE MANIFEST IS NOT
//      A WORKSPACE ROOT (see below). Every OTHER token in the pack's closed set
//      is withheld with the token named -- `{scheme}`, `{destination}` and the
//      rest are facts only the repository knows, and nen guessing one is a
//      different command.
//   1b. A TOKEN THE MANIFEST'S OWN `scripts` ANSWERS. A step that matches a
//      declared script's command word for word, differing only where the pack
//      wrote a token, is answered from that script -- `node {archiveScript}`
//      against `"resume:pdf": "node scripts/build-resume-pdf.mjs"` yields the
//      path the repository itself runs. TWO MATCHES THAT DISAGREE ARE AN
//      AMBIGUITY AND ARE WITHHELD, never resolved: rule 1 in this file's header
//      is not suspended because the two candidates came from the same file.
//      THE RULE IS OVER TOKENS, NOT OVER ONE TOKEN, and deliberately so: a
//      manifest that spells the whole command out has stated something stronger
//      about itself than any single field does, so a manager named in a script
//      answers as well as one named in a field. What it may never do is answer
//      a token from anywhere but this repository -- the pack contributes the
//      SHAPE and never a value, which is the property the whole family rests on.
//   2. THE EXECUTABLE. A step's `exe` must be the package manager the manifest
//      names, or a package the manifest declares as a dependency, or -- the
//      third route -- part of a step the manifest declares VERBATIM as one of
//      its own scripts. Those are the only three ways `detect` can SEE that a
//      repository carries a program, and "the marker matched so the tool must
//      be here" is exactly the inference §2.6 calls a warning rather than a
//      proposal. The third route is the strongest of the three and is why it
//      exists: a manifest whose `scripts` block spells this exact command is
//      the repository stating that it runs THIS LINE, which outranks a guess
//      from a dependency list that the line merely might use.
//   3. THE SCRIPT, in two shapes. An argv containing `run <task>` names a task
//      the manifest must declare under `scripts` -- `<pm> run <script>`
//      directly, and `<pm> <runner> run <task>` because a workspace task
//      runner's task list is the manifest's scripts. AND, for a row nen
//      answered `{package}` in from this manifest's own `name`, the element
//      that FOLLOWS that package name is the task that package must declare:
//      `{package}`'s documented meaning is "one workspace package the command
//      runs for", so everything before it is the manager's own filter syntax
//      and what comes after it is the task. This is the check whose absence
//      made the header's "never proposes a command the repository cannot run"
//      false: a manifest with `scripts: { lint: "…" }` and nothing else still
//      got a proposed `build`. It is deliberately CONSERVATIVE about a task
//      declared somewhere this reader cannot see (a workspace member, a runner's
//      own config file), and the note says so, because withholding a row a
//      human can add back beats proposing one that exits 1.
//
// A WORKSPACE ROOT NEVER ANSWERS `{package}`. A manifest declaring `workspaces`
// -- or sitting beside a `pnpm-workspace.yaml` -- is not itself the package a
// per-package row runs for; it is the list of them. Substituting its own `name`
// there would propose a command that runs the root against itself, which is a
// different command from the N the repository actually runs, so the row is
// withheld and the note NAMES THE MEMBERS nen could see, because "which of these,
// and in what order" is the question the maintainer is being asked.
//
// Every check that fails withholds ONE ROW and names it. Nothing here refuses
// the scan, and nothing here writes.

/** The three placeholders a repository's own `package.json` answers. */
const PM_EXECUTABLE = "{pm}";
const PM_PIN = "{packageManager}";
const PACKAGE_NAME = "{package}";

/** Every token the pack may use, so a leftover one can be named exactly. */
const PACK_TOKENS: readonly string[] = PLACEHOLDERS.map(
  (placeholder): string => placeholder.token,
);

const PACK_TOKEN_SET: ReadonlySet<string> = new Set(PACK_TOKENS);

/**
 * The tokens whose value a DECLARATION supplies, as the pack itself classifies
 * them.
 *
 * Read off `PLACEHOLDERS[].kind` rather than listed here, because the one token
 * of the other kind (`host-conditional`) is one nen resolves for itself from
 * the platform it is running on -- so a probe naming it is not a probe nen has
 * to decline to propose a precondition for, and hard-coding either list here
 * would be this file re-deciding a classification the catalogue already makes.
 */
const DECLARATION_TOKENS: ReadonlySet<string> = new Set(
  PLACEHOLDERS.filter((placeholder): boolean => placeholder.kind === "declaration-supplied").map(
    (placeholder): string => placeholder.token,
  ),
);

/** A workspace root's own statement of where its members live. */
interface WorkspaceShape {
  /** Where the statement was read from, for the note. */
  readonly source: string;
  /** The patterns verbatim, in the order the file states them. */
  readonly patterns: readonly string[];
  /** Every member nen could resolve and name, in pattern order. */
  readonly members: readonly string[];
}

interface Manifest {
  /** False when the lane has no readable `package.json` at all. */
  readonly present: boolean;
  /** `{ executable: "pnpm", pin: "pnpm@9.15.9" }`, or null when unstated. */
  readonly packageManager: { readonly executable: string; readonly pin: string } | null;
  /**
   * Set only when `package.json` DOES declare a `packageManager` string but
   * it carries no `@version` nen can split off -- a bare name (`"pnpm"`), a
   * bare scope (`"@scope/pm"`), or the empty string after trimming a scope.
   * `packageManager` stays null in this case, and this is the reason a note
   * quotes rather than the generic "declares no 'packageManager' field" one,
   * which is reserved for the field being absent altogether.
   */
  readonly packageManagerIssue: string | null;
  /** This manifest's own `name`, or null when it states none. */
  readonly packageName: string | null;
  /** Set when this lane is a workspace ROOT, which never answers `{package}`. */
  readonly workspace: WorkspaceShape | null;
  readonly declares: (name: string) => boolean;
  readonly scripts: ReadonlySet<string>;
  /** Each declared script's command, split on whitespace, in declared order. */
  readonly scriptWords: readonly (readonly string[])[];
}

/** `"packages/*"` -> every directory under `packages/`; a literal path -> itself. */
function expandWorkspacePattern(
  laneDirectory: string,
  pattern: string,
): readonly string[] {
  // ONLY A TRAILING `*` IS EXPANDED, and everything richer is left alone rather
  // than half-understood: `**`, a `!negation` and a mid-segment glob each mean
  // something a partial reader would get wrong, and this list exists to be
  // NAMED in a note, not to be authoritative.
  const segments = pattern.split("/");
  const last = segments[segments.length - 1];
  if (last === undefined || pattern.includes("**") || pattern.startsWith("!")) return [];
  if (last !== "*") {
    return pattern.includes("*") ? [] : [pattern];
  }
  const parent = segments.slice(0, -1).join("/");
  if (parent === "" || parent.includes("*")) return [];
  return listDirectory(join(laneDirectory, ...segments.slice(0, -1)))
    .filter((entry): boolean => entry.directory && !SKIP.has(entry.name))
    .map((entry): string => `${parent}/${entry.name}`)
    .sort((a, b): number => a.localeCompare(b));
}

/** The name a resolved member states for itself, or its path when it states none. */
function memberName(laneDirectory: string, memberPath: string): string {
  const document = readJson(join(laneDirectory, ...memberPath.split("/"), "package.json"));
  const name = document?.["name"];
  return typeof name === "string" && name !== "" ? name : memberPath;
}

/**
 * The workspace shape this lane declares, or null when it declares none.
 *
 * BOTH SPELLINGS ARE READ, because the two are the same statement in two files:
 * `package.json`'s `workspaces` (an array, or an object with a `packages` array)
 * and a sibling `pnpm-workspace.yaml`'s `packages`. A file that is PRESENT but
 * unreadable still makes this a workspace root -- the whole point of the check
 * is "this manifest is not itself the package", and a parse failure does not
 * make it one.
 */
function readWorkspace(
  laneDirectory: string,
  document: Record<string, unknown> | null,
): WorkspaceShape | null {
  const shape = (source: string, patterns: readonly string[]): WorkspaceShape => ({
    source,
    patterns,
    members: patterns
      .flatMap((pattern): readonly string[] => expandWorkspacePattern(laneDirectory, pattern))
      .map((memberPath): string => memberName(laneDirectory, memberPath)),
  });

  const declared = document?.["workspaces"];
  const fromManifest = Array.isArray(declared)
    ? declared
    : typeof declared === "object" && declared !== null
      ? (declared as Record<string, unknown>)["packages"]
      : undefined;
  if (Array.isArray(fromManifest)) {
    return shape(
      "package.json's own 'workspaces'",
      fromManifest.filter((entry): entry is string => typeof entry === "string"),
    );
  }

  const workspaceFile = "pnpm-workspace.yaml";
  const text = readText(join(laneDirectory, workspaceFile));
  if (text === null) return null;
  try {
    const parsed = parseYaml(text);
    const packages =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)["packages"]
        : undefined;
    return shape(
      `the ${workspaceFile} beside it`,
      Array.isArray(packages)
        ? packages.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
  } catch {
    // A WORKSPACE FILE NEN CANNOT PARSE IS STILL A WORKSPACE FILE. Falling back
    // to "not a workspace" here would answer `{package}` with the root's own
    // name on the strength of a syntax error.
    return shape(`the ${workspaceFile} beside it (which nen could not parse)`, []);
  }
}

function readManifest(laneDirectory: string): Manifest {
  const document = readJson(join(laneDirectory, "package.json"));
  const declared = document?.["packageManager"];
  const pin = typeof declared === "string" && declared !== "" ? declared : null;
  const scriptBlock = document?.["scripts"];
  const scriptRecord =
    typeof scriptBlock === "object" && scriptBlock !== null && !Array.isArray(scriptBlock)
      ? (scriptBlock as Record<string, unknown>)
      : {};
  const scripts = new Set(Object.keys(scriptRecord));
  const scriptWords = Object.values(scriptRecord)
    .filter((command): command is string => typeof command === "string")
    .map((command): readonly string[] => command.trim().split(/\s+/))
    .filter((words): boolean => words.length > 0 && words[0] !== "");
  const name = document?.["name"];
  // The EXECUTABLE is the pin with its trailing `@<version>` stripped, and the
  // PIN is the string verbatim -- the pack keeps the two apart because one of
  // them may carry a version into an install argv and the other may not. The
  // split is the LAST `@`, never the first: a scoped manager's own name opens
  // with `@` (`@scope/pm@1.2.3`), so splitting on the first `@` would hand back
  // an empty executable. An `@` at index 0 (no version after a scope) or no
  // `@` at all (no version at all) is not a name+version pin nen can use, so
  // nen withholds rather than guessing one half of it.
  const at = pin === null ? -1 : pin.lastIndexOf("@");
  const packageManager = pin !== null && at > 0 ? { executable: pin.slice(0, at), pin } : null;
  const packageManagerIssue =
    pin !== null && at <= 0
      ? `package.json names 'packageManager: "${pin}"', which carries no '@version' nen can split an executable from -- nen withholds rather than guessing one`
      : null;
  return {
    present: document !== null,
    packageManager,
    packageManagerIssue,
    packageName: typeof name === "string" && name !== "" ? name : null,
    workspace: readWorkspace(laneDirectory, document),
    declares: (dependency): boolean => dependsOn(document, dependency),
    scripts,
    scriptWords,
  };
}

interface ProposedStep {
  readonly exe: string;
  readonly argv: readonly string[];
}

/** The value the manifest answers `{package}` with, or null when it answers none. */
function packageAnswer(manifest: Manifest): string | null {
  return manifest.workspace === null ? manifest.packageName : null;
}

function substitute(token: string, manifest: Manifest): string {
  const pm = manifest.packageManager;
  const packageName = packageAnswer(manifest);
  let out = token;
  if (pm !== null) {
    out = out.split(PM_EXECUTABLE).join(pm.executable).split(PM_PIN).join(pm.pin);
  }
  if (packageName !== null) out = out.split(PACKAGE_NAME).join(packageName);
  return out;
}

/**
 * Every distinct answer this manifest's own `scripts` block gives one step.
 *
 * A candidate script is one whose command has the SAME WORD COUNT and agrees
 * with the step at every position except the ones where the pack wrote a whole
 * token; those positions are the answer. The word-count equality is what keeps
 * this from being a fuzzy match: `node {archiveScript}` matches `node
 * scripts/build-resume-pdf.mjs` and matches nothing that merely mentions it,
 * and a compound script (`a && b`) has more words than any single-step row and
 * so matches none.
 */
function scriptAnswers(
  step: ProposedStep,
  manifest: Manifest,
): readonly ReadonlyMap<string, string>[] {
  const words = [step.exe, ...step.argv];
  const found = new Map<string, ReadonlyMap<string, string>>();
  for (const parts of manifest.scriptWords) {
    if (parts.length !== words.length) continue;
    const answer = new Map<string, string>();
    let usable = true;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index] ?? "";
      const part = parts[index] ?? "";
      if (word === part) continue;
      // ONLY A WHOLE TOKEN may differ. A word that merely CONTAINS a token
      // (`--out={package}/dist`) is a shape this match cannot read the intent
      // of, and reading it anyway is how a proposal acquires an argument
      // nobody wrote.
      if (!PACK_TOKEN_SET.has(word)) {
        usable = false;
        break;
      }
      const prior = answer.get(word);
      if (prior !== undefined && prior !== part) {
        usable = false;
        break;
      }
      answer.set(word, part);
    }
    if (!usable || answer.size === 0) continue;
    // TWO SCRIPTS GIVING THE SAME ANSWER ARE ONE ANSWER, not an ambiguity, so
    // the map is keyed by the answer itself rather than by the script. The
    // separator is the unit separator because it cannot appear in a shell word:
    // a printable one would let `{a} = "x y"` and `{a} = "x", {b} = "y"` collide
    // into one key and hide a real disagreement.
    const key = [...answer.entries()]
      .sort(([a], [b]): number => a.localeCompare(b))
      .map(([token, value]): string => `${token}\u001f${value}`)
      .join("\u001f");
    if (!found.has(key)) found.set(key, answer);
  }
  return [...found.values()];
}

/** Whether the manifest declares this step, word for word, as one of its scripts. */
function runsVerbatim(step: ProposedStep, manifest: Manifest): boolean {
  const words = [step.exe, ...step.argv];
  return manifest.scriptWords.some(
    (parts): boolean =>
      parts.length === words.length && parts.every((part, index): boolean => part === words[index]),
  );
}

function stepsOfCell(cell: ProfileVerb): readonly ProposedStep[] {
  if (cell.kind === "command" && cell.invocation.kind === "command") {
    return [{ exe: cell.invocation.exe, argv: cell.invocation.argv }];
  }
  /* c8 ignore next 5 -- the two kinds are the two the caller filters to */
  if (cell.kind === "steps" && cell.invocation.kind === "steps") {
    return cell.invocation.steps.map(
      (step): ProposedStep => ({ exe: step.exe, argv: step.argv }),
    );
  }
  return [];
}

/** Every pack token still standing in a substituted step, in the pack's order. */
function leftoverTokens(steps: readonly ProposedStep[]): readonly string[] {
  const text = steps.flatMap((step): readonly string[] => [step.exe, ...step.argv]).join(" ");
  return PACK_TOKENS.filter((token): boolean => text.includes(token));
}

/** The task an argv's `run <task>` names, or null when it names none. */
function runTask(argv: readonly string[]): string | null {
  const at = argv.indexOf("run");
  // `<tool> run` with nothing after it is a MODE, not a task -- a test runner
  // told to run once instead of watching. There is nothing to look up.
  if (at === -1 || at === argv.length - 1) return null;
  return argv[at + 1] ?? null;
}

/**
 * The task a PER-PACKAGE argv names, or null when it names none.
 *
 * `{package}`'s documented meaning is "one workspace package the command runs
 * for", so an argv nen answered it in has the shape `<filter syntax> <package>
 * <task>`: everything up to the package name is the manager's own way of
 * saying WHICH package, and the element after it is what that package is asked
 * to do. A row with nothing after the package name asks for no task and this
 * returns null rather than inventing one.
 */
function packageTask(argv: readonly string[], packageName: string): string | null {
  const at = argv.indexOf(packageName);
  if (at === -1 || at === argv.length - 1) return null;
  return argv[at + 1] ?? null;
}

interface ProposedVerbs {
  readonly verbs: Readonly<Record<string, unknown>>;
  readonly notes: readonly string[];
}

/** The reason clause a leftover `{package}` earns, or "" when it earns none. */
function packageReason(manifest: Manifest): string {
  const workspace = manifest.workspace;
  if (workspace !== null) {
    return ` -- ${workspace.source} declares this lane a WORKSPACE ROOT (${
      workspace.patterns.length === 0 ? "no pattern nen could read" : workspace.patterns.join(", ")
    }), so it is not itself the package this row runs for: the row runs ONCE PER PACKAGE, and the members nen can see here are ${
      workspace.members.length === 0
        ? "none nen could resolve (only a literal path and a trailing '*' are expanded)"
        : workspace.members.join(", ")
    }. Which of them this repository means, and in what order, is a list only it can state`;
  }
  return manifest.present
    ? " -- package.json states no 'name' of its own, which is where nen reads a single-package lane's package name from"
    : " -- this lane has no readable package.json to read a package name from";
}

/**
 * The pack's reference verbs for this lane, substituted and cross-checked, plus
 * a note for every row that was withheld and the reason it was.
 *
 * ONLY THE PACK'S `commandVerbs` ARE CONSIDERED, which is the index's own name
 * for "the subset of the thirteen that names a command a repository RUNS". The
 * other three are not gaps in a proposal: `detect` is this verb, `tools` is a
 * host-toolchain report read out of `project.toolchain`, and `warmup` is
 * version-control work plus a delegation to `build` and `test`. None of the
 * three is an argv a lane declares, so proposing a row for them would put a
 * command in a place nothing reads.
 *
 * A CELL THE PACK CARRIES NO COMMAND FOR IS PROPOSED AS AN EXPLICIT
 * `{"unsupported": "<the pack's own reason>"}` ROW rather than left out, and
 * that is the one place this verb writes a row it did not read a command for.
 * Three arguments, and the first is the decisive one:
 *
 *   * A LANE WITH AN EMPTY VERB MAP IS A DECLARATION NEN'S OWN READER REFUSES
 *     (../schema/contract.ts: "declares no verb for lane '<lane>'", and its
 *     message names this exact remedy). Before this, `detect --write` against a
 *     tree whose every row was withheld wrote a file the very next `nen shu
 *     build` rejected -- a proposal that cannot be run is the failure this file
 *     exists to prevent, arrived at from the other side.
 *   * The reason is QUOTED, never rewritten, so it is the catalogue's sentence
 *     a maintainer reads -- and the executor prints that same sentence back at
 *     exit 4, which is what makes an `unsupported` row a working answer rather
 *     than a silence.
 *   * A `declared-only` cell becomes `unsupported` TOO, because a declaration
 *     has three forms and none of them is "the reference disagrees with
 *     itself". The row is the visible seat for this repository's answer, the
 *     note below says which rows are of that kind, and the pack's reason names
 *     the commands it declined to pick between.
 */
function proposeVerbs(
  pack: ProfilesPack,
  profile: StackProfile,
  laneDirectory: string,
  lane: string,
): ProposedVerbs {
  const manifest = readManifest(laneDirectory);
  const verbs: Record<string, unknown> = {};
  const notes: string[] = [];
  const noCommand: string[] = [];
  const declaredOnly: string[] = [];

  for (const verb of pack.commandVerbs) {
    const cell = verbCell(profile, verb);
    if (cell.kind === "unsupported" || cell.kind === "declared-only") {
      noCommand.push(`${verb} (${cell.summary})`);
      if (cell.kind === "declared-only") declaredOnly.push(verb);
      verbs[verb] = {
        unsupported:
          cell.kind === "declared-only"
            ? cell.reason
            : /* c8 ignore next -- the pack's reader gives an `unsupported` cell an `unsupported` invocation */
              cell.invocation.kind === "unsupported"
              ? cell.invocation.reason
              : cell.summary,
      };
      continue;
    }
    /* c8 ignore next 5 -- `delegated` never appears among the command verbs */
    if (cell.kind === "delegated") {
      noCommand.push(`${verb} (delegates to ${cell.delegatesTo.join(", ")})`);
      verbs[verb] = { unsupported: cell.why };
      continue;
    }

    const substituted = stepsOfCell(cell).map(
      (step): ProposedStep => ({
        exe: substitute(step.exe, manifest),
        argv: step.argv.map((token): string => substitute(token, manifest)),
      }),
    );

    // The manifest's own `scripts` block, asked once per step for the tokens the
    // fields above could not answer. TWO ANSWERS THAT DISAGREE END THE ROW: this
    // file resolves no ambiguity, and one arriving from inside a single file is
    // not a different kind of ambiguity.
    const steps: ProposedStep[] = [];
    let ambiguity: string | null = null;
    for (const step of substituted) {
      if (leftoverTokens([step]).length === 0) {
        steps.push(step);
        continue;
      }
      const answers = scriptAnswers(step, manifest);
      if (answers.length > 1) {
        ambiguity ??= `'${verb}' withheld: ${answers.length} of this lane's own scripts match its reference command '${[
          step.exe,
          ...step.argv,
        ].join(" ")}' and they disagree about ${leftoverTokens([step]).join(", ")} (${answers
          .map((answer): string =>
            [...answer.entries()]
              .sort(([a], [b]): number => a.localeCompare(b))
              .map(([token, value]): string => `${token} = ${value}`)
              .join(", "),
          )
          .join(
            "; ",
          )}). nen resolves no ambiguity, not even one that arrives from a single file: state the row this repository means.`;
        steps.push(step);
        continue;
      }
      const answer = answers[0];
      if (answer === undefined) {
        steps.push(step);
        continue;
      }
      const apply = (token: string): string => answer.get(token) ?? token;
      steps.push({ exe: apply(step.exe), argv: step.argv.map(apply) });
    }
    if (ambiguity !== null) {
      notes.push(ambiguity);
      continue;
    }

    const leftover = leftoverTokens(steps);
    if (leftover.length > 0) {
      const clauses = [
        leftover.includes(PM_EXECUTABLE) || leftover.includes(PM_PIN)
          ? manifest.packageManagerIssue !== null
            ? ` -- ${manifest.packageManagerIssue}`
            : " -- package.json declares no 'packageManager' field, which is where nen reads that one from"
          : "",
        leftover.includes(PACKAGE_NAME) ? packageReason(manifest) : "",
      ].join("");
      notes.push(
        `'${verb}' withheld: its reference command still names ${leftover.join(", ")}, which only this repository can answer${clauses}. nen never proposes an unsubstituted token: a guessed argument is a different command.`,
      );
      continue;
    }

    const unknownExe = steps.find(
      (step): boolean =>
        step.exe !== manifest.packageManager?.executable &&
        !manifest.declares(step.exe) &&
        !runsVerbatim(step, manifest),
    );
    if (unknownExe !== undefined) {
      notes.push(
        `'${verb}' withheld: it runs '${unknownExe.exe}', ${
          manifest.present
            ? "which this lane's package.json neither declares as a dependency, nor names as its packageManager, nor spells out verbatim as one of its own scripts"
            : "and this lane has no readable package.json to confirm the project carries it"
        }. A tool the project does not visibly carry is a warning, never a proposal.`,
      );
      continue;
    }

    // THE TASK CHECK, over both shapes an argv names a task in. The per-package
    // one applies only where nen ANSWERED `{package}` from this manifest, so a
    // lane that never carried the token is never asked about a task it has no
    // reason to declare.
    const answeredPackage = leftoverTokens(stepsOfCell(cell)).includes(PACKAGE_NAME)
      ? packageAnswer(manifest)
      : null;
    const missingScript = steps
      .flatMap((step): readonly (string | null)[] => [
        runTask(step.argv),
        answeredPackage === null ? null : packageTask(step.argv, answeredPackage),
      ])
      .find((task): boolean => task !== null && !manifest.scripts.has(task));
    if (missingScript !== undefined && missingScript !== null) {
      notes.push(
        `'${verb}' withheld: its reference command runs the task '${missingScript}', and this lane's package.json declares no such script. If the task is declared somewhere nen does not read -- a workspace member, a task runner's own config -- add the row by hand; a verb the project does not visibly carry is a warning, never a proposal.`,
      );
      continue;
    }

    const first = steps[0];
    /* c8 ignore next -- the pack's reader always produces at least one step */
    if (first === undefined) continue;
    // The pack requires a `why` on every command cell, and the row carries it
    // verbatim: it is the sentence a human reads while deciding whether to keep
    // the row, and rewriting it here would make it nen's reason rather than the
    // catalogue's.
    /* c8 ignore next -- the `unsupported` arm was filtered out above */
    const why = cell.invocation.kind === "unsupported" ? null : cell.invocation.why;
    verbs[verb] =
      steps.length === 1
        ? { exe: first.exe, argv: first.argv, why }
        : {
            steps: steps.map((step): unknown => ({ exe: step.exe, argv: step.argv })),
            why,
          };
  }

  if (noCommand.length > 0) {
    notes.push(
      `the reference pack proposes no command for ${noCommand.join(", ")}. That is the pack DECLINING to choose for you rather than a gap in this proposal -- docs/STACK-MATRIX.md carries each one's full reason, and the declaration is where this repository's answer goes. Each is proposed as an explicit {"unsupported": "<the pack's own reason>"} row rather than left out, because a lane whose verb map is empty is a declaration nen's own reader refuses, and because a row a maintainer can SEE is a row they can replace.${
        declaredOnly.length === 0
          ? ""
          : ` ${declaredOnly.join(", ")} ${declaredOnly.length === 1 ? "is" : "are"} declared-only rather than unsupported: the pack HAS observed commands for ${declaredOnly.length === 1 ? "it" : "them"} and declines to pick one, so ${declaredOnly.length === 1 ? "that row is" : "those rows are"} the first to replace.`
      }`,
    );
  }

  // WHAT NEN WILL NOT PROPOSE A PRECONDITION FOR, said out loud. A toolchain
  // entry whose PROBE still carries a declaration-supplied token is a host fact
  // whose value only the machine running the verb knows -- a binary somewhere on
  // this disk, a workload id on this installation. A `path` precondition would
  // pin one machine's location into a file every machine reads, and nen has no
  // second kind to reach for unless the repository names one. So it proposes
  // nothing and says which row it declined, which is the honest half of a
  // constraint the pack states in prose.
  for (const [tool, entry] of Object.entries(profile.toolchain)) {
    const tokens = PACK_TOKENS.filter(
      (token): boolean =>
        DECLARATION_TOKENS.has(token) &&
        entry.probe.some((word): boolean => word.includes(token)),
    );
    if (tokens.length === 0) continue;
    notes.push(
      `no precondition is proposed for the '${tool}' this stack's toolchain requires: its probe is '${entry.probe.join(" ")}', and ${tokens.join(", ")} is a value only the machine running the verb can answer. nen asserts a precondition of kind 'path' or 'env' and performs neither -- a 'path' here would pin one machine's install location into a file every machine reads, and the reference pack names no environment variable to assert instead, so nen proposes nothing rather than inventing one. If this repository has such a variable, state it yourself: {"kind": "env", "value": "<NAME>", "why": "..."} under project.preconditions.${lane}. The pack's own reason for the requirement: ${entry.why}`,
    );
  }
  // THERE IS DELIBERATELY NO LANE-LEVEL "no package.json" NOTE. An earlier
  // draft withheld the whole map with one such note, which was wrong twice: it
  // told a repository whose commands legitimately live elsewhere that its
  // manifest was the problem, and it hid WHICH rows the manifest would have
  // answered. Every withheld row now carries its own reason, and a row that
  // never needed a manifest never mentions one.
  return { verbs, notes };
}

/** The `hosts` map a set of lanes agrees on, or null when they disagree. */
function hostSignature(hosts: Readonly<Record<string, readonly string[]>>): string {
  return JSON.stringify(
    Object.entries(hosts)
      .map(([verb, platforms]): [string, readonly string[]] => [verb, platforms])
      .sort(([a], [b]): number => compareBytes(a, b)),
  );
}

/** Scan, cross-check and assemble the proposal. Writes nothing. */
export function detect(repoRoot: string): DetectReport {
  const pack = loadProfilesPack();
  const resolved = resolveSchemaFile(repoRoot, CONTRACT_FILE);
  const found = scan(repoRoot);
  const lanes: DetectedLane[] = [];
  const profiles = new Map<string, StackProfile>();
  const taken = new Set<string>();
  const notes: string[] = [];

  for (const { directory, matches } of found) {
    const cwd = relativePath(repoRoot, directory);
    // ONE LANE PER STACK PER DIRECTORY, whatever the marker count. A tree with
    // both `next.config.js` and `next.config.mjs` matched twice and used to
    // become two lanes, the second with a name nobody could have predicted.
    const byStack = new Map<string, string[]>();
    for (const match of matches) {
      const markers = byStack.get(match.stack) ?? [];
      markers.push(match.marker);
      byStack.set(match.stack, markers);
    }
    const stacks = [...byStack.keys()].sort(compareBytes);
    if (stacks.length > 1) {
      notes.push(
        `${cwd} carries markers for ${stacks.length} stacks (${stacks.join(", ")}). Both lanes are proposed and neither is chosen -- delete the one this repository does not build.`,
      );
    }
    for (const stack of stacks) {
      const lane = laneName(cwd, stack, stacks.length > 1, taken);
      taken.add(lane);
      const profile = profileById(pack, stack);
      profiles.set(lane, profile);
      const proposed = proposeVerbs(pack, profile, directory, lane);
      lanes.push({
        lane,
        stack,
        cwd,
        markers: byStack.get(stack) ?? [],
        verbs: proposed.verbs,
        notes: proposed.notes,
      });
    }
  }

  if (lanes.length > 0) {
    notes.push(
      "a lane's NAME is proposed from the directory it lives in (or from the stack id at the repository root) and is yours to change -- it is the token '--lane' takes, and nothing in nen reads meaning into it.",
    );
  }
  if (lanes.length > 1) {
    notes.push(
      `${lanes.length} lanes were found, so defaultLane is null and --lane is required. nen will not pick one: a repository with several builds in one tree has not said which one 'nen shu build' means.`,
    );
  }
  const makefile = found.some((entry): boolean =>
    listDirectory(entry.directory).some((file): boolean => file.name === "Makefile"),
  );
  if (makefile) {
    notes.push(
      "a Makefile sits beside a lane. That is a finding, not a proposal: whether this repository's verbs route through it is its own call to write into the declaration.",
    );
  }

  // THE PLATFORMS COME FROM THE PACK, PER STACK, and the pack states them the
  // same way a declaration does -- keyed by verb, with `*` for a stack whose
  // every verb runs anywhere. Lanes that disagree get NO block rather than a
  // union: a union would let a verb start on a host that cannot run it.
  const signatures = new Set(
    lanes.map((lane): string => hostSignature(profiles.get(lane.lane)?.hosts ?? {})),
  );
  let hosts: Readonly<Record<string, readonly string[]>> = {};
  if (signatures.size === 1 && lanes[0] !== undefined) {
    hosts = profiles.get(lanes[0].lane)?.hosts ?? {};
  } else if (signatures.size > 1) {
    notes.push(
      `the lanes need different platforms (${lanes
        .map(
          (lane): string =>
            `${lane.lane}: ${Object.entries(profiles.get(lane.lane)?.hosts ?? {})
              .map(([verb, platforms]): string => `${verb} ${platforms.join("/")}`)
              .join(", ")}`,
        )
        .join("; ")}), and 'hosts' is keyed by VERB rather than by lane. No hosts block is proposed -- state one per verb yourself rather than take a union, which would let a verb start on a host that cannot run it.`,
    );
  }

  const proposal =
    lanes.length === 0
      ? null
      : {
          $schema: "nen.contract/v0.1",
          project: {
            lanes: Object.fromEntries(
              lanes.map((lane): [string, unknown] => [lane.lane, { stack: lane.stack, cwd: lane.cwd }]),
            ),
            defaultLane: lanes.length === 1 ? (lanes[0]?.lane ?? null) : null,
            verbs: Object.fromEntries(lanes.map((lane): [string, unknown] => [lane.lane, lane.verbs])),
            hosts,
          },
        };

  return {
    contract: DETECT_CONTRACT,
    repo: repoRoot,
    declaration: resolved.canonical.path,
    declarationPresent: resolved.canonical.present,
    lanes,
    proposal,
    notes,
    written: null,
    exitCode: lanes.length === 0 ? 1 : 0,
  };
}

/**
 * `--write`, which writes ONLY into the absence of a declaration.
 *
 * There is no `--force` and no merge. A file that is there was written by a
 * human who decided something; the proposal is on stdout either way, and
 * merging two decisions is a human's job with a diff in front of them.
 */
export function writeProposal(repoRoot: string, report: DetectReport): DetectReport {
  if (report.proposal === null) {
    throw new VerbUsageError(
      `--write has nothing to write: no lane was detected under ${repoRoot}.`,
    );
  }
  if (report.declarationPresent) {
    throw new VerbUsageError(
      `${report.declaration} already exists, and --write never overwrites a declaration -- a declaration is a decision, and this proposal is an inference. The block to merge is printed above; there is deliberately no --force.`,
    );
  }
  mkdirSync(dirname(report.declaration), { recursive: true });
  writeFileSync(report.declaration, `${JSON.stringify(report.proposal, null, 2)}\n`, "utf8");
  return { ...report, written: report.declaration };
}

/**
 * Whether a proposed row is an `unsupported` seat rather than a command.
 *
 * Read off the ROW's own shape, which is the same test ../schema/contract.ts
 * applies to a declaration: a row carrying `unsupported` is one form, a row
 * carrying `exe` or `steps` is another. Nothing here needs a second field to
 * remember what this verb just wrote.
 */
function isUnsupportedRow(row: unknown): boolean {
  return typeof row === "object" && row !== null && "unsupported" in row;
}

/** The human rendering of the same value `--json` prints. */
export function renderDetect(report: DetectReport): readonly string[] {
  const lines: string[] = [];
  lines.push(`repository:  ${report.repo}`);
  lines.push(
    `declaration: ${report.declaration}${report.declarationPresent ? "  (present -- --write will refuse)" : "  (absent)"}`,
  );
  if (report.lanes.length === 0) {
    lines.push("");
    lines.push(
      "no lane detected. Nen proposes a lane only from a marker it can see -- a framework config, a workspace, a wrapper plus its plugin, a project file. If this repository has a build nen should know about, write the project block by hand: `nen shu --help` names the fields.",
    );
    lines.push(
      `the scan is bounded, and both bounds can hide a real lane: it descends at most ${MAX_DEPTH} directories below --repo, and it never enters ${[...SKIP].sort().join(", ")} -- so a lane living in a directory named like build output is invisible to it by design.`,
    );
    return lines;
  }
  lines.push("");
  for (const lane of report.lanes) {
    lines.push(`  ${lane.lane}  (${lane.stack})  cwd ${lane.cwd}`);
    for (const marker of lane.markers) lines.push(`        marker: ${marker}`);
    // THE TWO KINDS OF PROPOSED ROW ARE PRINTED APART, because they ask the
    // reader for opposite things: a command row is one to keep or correct, and
    // an `unsupported` row is a seat this repository's own answer goes into.
    // One combined list read as "eleven verbs are ready", which is the reading
    // that gets an unsupported row shipped unedited. The JSON is UNCHANGED --
    // the split is derived from the row's own shape, not a new field.
    const entries = Object.entries(lane.verbs);
    const proposed = entries
      .filter(([, row]): boolean => !isUnsupportedRow(row))
      .map(([verb]): string => verb);
    const unsupported = entries
      .filter(([, row]): boolean => isUnsupportedRow(row))
      .map(([verb]): string => verb);
    lines.push(
      `        verbs:  ${proposed.length === 0 ? "(none proposed)" : proposed.sort().join(", ")}`,
    );
    if (unsupported.length > 0) {
      lines.push(`        unsupported (the pack's reason, yours to replace):  ${unsupported.sort().join(", ")}`);
    }
    for (const note of lane.notes) lines.push(`        ^ ${note}`);
  }
  for (const note of report.notes) {
    lines.push("");
    lines.push(`note: ${note}`);
  }
  lines.push("");
  lines.push(
    report.written === null
      ? `proposed ${CONTRACT_FILE} (nothing was written -- pass --write, or paste this):`
      : `wrote ${report.written}:`,
  );
  lines.push(JSON.stringify(report.proposal, null, 2));
  return lines;
}
