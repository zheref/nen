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

interface Entry {
  readonly name: string;
  readonly directory: boolean;
}

function listDirectory(path: string): readonly Entry[] {
  try {
    return readdirSync(path, { withFileTypes: true }).map(
      (entry): Entry => ({ name: entry.name, directory: entry.isDirectory() }),
    );
  } catch {
    return [];
  }
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
// So the checks below are three syntactic rules over the SUBSTITUTED argv, and
// they name no tool:
//
//   1. PLACEHOLDERS. `{pm}` and `{packageManager}` are answered by the lane's
//      own `package.json` (`packageManager: "<name>@<version>"`), which is the
//      repository's statement about itself and never the pack's. Every OTHER
//      token in the pack's closed set is withheld with the token named --
//      `{scheme}`, `{destination}`, `{package}` and the rest are facts only the
//      repository knows, and nen guessing one is a different command.
//   2. THE EXECUTABLE. A step's `exe` must be either the package manager the
//      manifest names or a package the manifest declares as a dependency.
//      Those are the only two ways `detect` can SEE that a repository carries a
//      program, and "the marker matched so the tool must be here" is exactly
//      the inference §2.6 calls a warning rather than a proposal.
//   3. THE SCRIPT. An argv containing `run <task>` names a task the manifest
//      must declare under `scripts` -- `<pm> run <script>` directly, and
//      `<pm> <runner> run <task>` because a workspace task runner's task list
//      is the manifest's scripts. This is the check whose absence made the
//      header's "never proposes a command the repository cannot run" false: a
//      manifest with `scripts: { lint: "…" }` and nothing else still got a
//      proposed `build`. It is deliberately CONSERVATIVE about a task declared
//      somewhere this reader cannot see (a workspace member, a runner's own
//      config file), and the note says so, because withholding a row a human
//      can add back beats proposing one that exits 1.
//
// Every check that fails withholds ONE ROW and names it. Nothing here refuses
// the scan, and nothing here writes.

/** The two placeholders a repository's own `package.json` answers. */
const PM_EXECUTABLE = "{pm}";
const PM_PIN = "{packageManager}";

/** Every token the pack may use, so a leftover one can be named exactly. */
const PACK_TOKENS: readonly string[] = PLACEHOLDERS.map(
  (placeholder): string => placeholder.token,
);

interface Manifest {
  /** False when the lane has no readable `package.json` at all. */
  readonly present: boolean;
  /** `{ executable: "pnpm", pin: "pnpm@9.15.9" }`, or null when unstated. */
  readonly packageManager: { readonly executable: string; readonly pin: string } | null;
  readonly declares: (name: string) => boolean;
  readonly scripts: ReadonlySet<string>;
}

function readManifest(laneDirectory: string): Manifest {
  const document = readJson(join(laneDirectory, "package.json"));
  const declared = document?.["packageManager"];
  const pin = typeof declared === "string" && declared !== "" ? declared : null;
  const scriptBlock = document?.["scripts"];
  const scripts =
    typeof scriptBlock === "object" && scriptBlock !== null && !Array.isArray(scriptBlock)
      ? new Set(Object.keys(scriptBlock))
      : new Set<string>();
  return {
    present: document !== null,
    // The EXECUTABLE is the pin with its version stripped, and the PIN is the
    // string verbatim -- the pack keeps the two apart because one of them may
    // carry a version into an install argv and the other may not.
    packageManager:
      pin === null ? null : { executable: pin.split("@")[0] ?? pin, pin },
    declares: (name): boolean => dependsOn(document, name),
    scripts,
  };
}

interface ProposedStep {
  readonly exe: string;
  readonly argv: readonly string[];
}

function substitute(token: string, manifest: Manifest): string {
  const pm = manifest.packageManager;
  if (pm === null) return token;
  return token.split(PM_EXECUTABLE).join(pm.executable).split(PM_PIN).join(pm.pin);
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

interface ProposedVerbs {
  readonly verbs: Readonly<Record<string, unknown>>;
  readonly notes: readonly string[];
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
 */
function proposeVerbs(
  pack: ProfilesPack,
  profile: StackProfile,
  laneDirectory: string,
): ProposedVerbs {
  const manifest = readManifest(laneDirectory);
  const verbs: Record<string, unknown> = {};
  const notes: string[] = [];
  const noCommand: string[] = [];

  for (const verb of pack.commandVerbs) {
    const cell = verbCell(profile, verb);
    if (cell.kind === "unsupported" || cell.kind === "declared-only") {
      noCommand.push(`${verb} (${cell.summary})`);
      continue;
    }
    /* c8 ignore next 4 -- `delegated` never appears among the command verbs */
    if (cell.kind === "delegated") {
      noCommand.push(`${verb} (delegates to ${cell.delegatesTo.join(", ")})`);
      continue;
    }

    const steps = stepsOfCell(cell).map(
      (step): ProposedStep => ({
        exe: substitute(step.exe, manifest),
        argv: step.argv.map((token): string => substitute(token, manifest)),
      }),
    );

    const leftover = leftoverTokens(steps);
    if (leftover.length > 0) {
      notes.push(
        `'${verb}' withheld: its reference command still names ${leftover.join(", ")}, which only this repository can answer${
          leftover.includes(PM_EXECUTABLE) || leftover.includes(PM_PIN)
            ? " -- package.json declares no 'packageManager' field, which is where nen reads that one from"
            : ""
        }. nen never proposes an unsubstituted token: a guessed argument is a different command.`,
      );
      continue;
    }

    const unknownExe = steps.find(
      (step): boolean =>
        step.exe !== manifest.packageManager?.executable && !manifest.declares(step.exe),
    );
    if (unknownExe !== undefined) {
      notes.push(
        `'${verb}' withheld: it runs '${unknownExe.exe}', ${
          manifest.present
            ? "which this lane's package.json neither declares as a dependency nor names as its packageManager"
            : "and this lane has no readable package.json to confirm the project carries it"
        }. A tool the project does not visibly carry is a warning, never a proposal.`,
      );
      continue;
    }

    const missingScript = steps
      .map((step): string | null => runTask(step.argv))
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
      `the reference pack proposes no command for ${noCommand.join(", ")}. That is the pack DECLINING to choose for you rather than a gap in this proposal -- docs/STACK-MATRIX.md carries each one's full reason, and the declaration is where this repository's answer goes.`,
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
      .sort(([a], [b]): number => a.localeCompare(b)),
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
    const stacks = [...byStack.keys()].sort((a, b): number => a.localeCompare(b));
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
      const proposed = proposeVerbs(pack, profile, directory);
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
    const verbs = Object.keys(lane.verbs);
    lines.push(`        verbs:  ${verbs.length === 0 ? "(none proposed)" : verbs.sort().join(", ")}`);
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
