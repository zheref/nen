// src/shu/detect.ts -- read the markers on disk and PROPOSE a `project` block.
// It never decides, and without `--write` it never writes.
//
// WHY MARKERS ARE LEGITIMATELY CODE, when nothing else in this family is. A
// FILENAME is a universal fact -- `next.config.mjs` means the same thing in
// every repository on earth -- while a repository's lane names, its argv, its
// preconditions and its targets are that repository's own vocabulary, which §3
// forbids this binary from deciding. So the marker table lives here and the argv
// table does not: the argv comes from ../../profiles/, is proposed rather than
// run, and is cross-checked against what the repository actually declares before
// it is even proposed.
//
// THE THREE THINGS THIS VERB WILL NOT DO, each of which is a temptation the
// design names by hand:
//
//   1. **It never resolves an ambiguity.** A tree carrying two lanes' markers
//      gets two lanes and `defaultLane: null`, plus a note. Choosing for the
//      caller is how a scripted `nen shu build` silently starts building
//      something else the day a second lane appears.
//   2. **It never proposes a command the repository cannot run.** Every verb
//      from the pack is dropped unless package.json declares the dependency its
//      argv names, and the whole verb map is dropped unless `packageManager`
//      names the manager every argv routes through. A proposal a human pastes
//      and then discovers is fiction is worse than an empty map with a reason.
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
import { CONTRACT_FILE, resolveSchemaFile } from "../schema/source.js";
import { PACK, type PackStack } from "./pack.js";

/** The seven stacks the design names, defined by the seven product repos. */
export const STACKS: readonly string[] = [
  "compose-desktop",
  "dotnet-winui",
  "expo",
  "gatsby",
  "gradle-android",
  "nextjs",
  "xcode-ios",
];

/**
 * Which platforms each stack's toolchain can run on.
 *
 * A PLATFORM IS NOT A TOOLCHAIN NAME -- `darwin`, `linux` and `win32` are
 * `process.platform`'s own vocabulary, and the fact that one stack's build
 * system ships only on macOS is a property of the world rather than of any
 * repository. This is the one per-stack fact detect proposes for a stack the
 * pack has no verbs for, because getting it wrong costs a caller an exit 3 on
 * the right machine.
 */
const STACK_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "compose-desktop": ["darwin", "linux", "win32"],
  "dotnet-winui": ["win32"],
  expo: ["darwin", "linux", "win32"],
  gatsby: ["darwin", "linux", "win32"],
  "gradle-android": ["darwin", "linux", "win32"],
  nextjs: ["darwin", "linux", "win32"],
  "xcode-ios": ["darwin"],
};

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
 */
const MAX_DEPTH = 3;

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

export interface DetectedLane {
  readonly lane: string;
  readonly stack: string;
  /** Repo-relative, forward-slashed. `.` for the repository root. */
  readonly cwd: string;
  /** The repo-relative paths that matched, in the order they were found. */
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
 * into `--lane` and what a script pins. Two stacks in one directory take the
 * directory name and the directory-plus-stack name, in the stacks' own sorted
 * order, so the same tree always produces the same names.
 */
function laneName(cwd: string, stack: string, taken: ReadonlySet<string>): string {
  const base = cwd === "." ? stack : (cwd.split("/").pop() ?? stack);
  if (!taken.has(base)) return base;
  const qualified = `${base}-${stack}`;
  if (!taken.has(qualified)) return qualified;
  for (let index = 2; ; index += 1) {
    const numbered = `${qualified}-${index}`;
    if (!taken.has(numbered)) return numbered;
  }
}

interface ProposedVerbs {
  readonly verbs: Readonly<Record<string, unknown>>;
  readonly notes: readonly string[];
}

/**
 * The pack's reference verbs for this lane, cross-checked, or an empty map with
 * the reason it is empty.
 */
function proposeVerbs(pack: PackStack | undefined, laneDirectory: string): ProposedVerbs {
  if (pack === undefined) {
    return {
      verbs: {},
      notes: [
        "the reference pack carries no verbs for this stack yet (zheref/nen#91's PR3 fills the remaining six). The lane is proposed so the declaration's shape is right; write its verbs from what this project already runs.",
      ],
    };
  }
  const packageJson = readJson(join(laneDirectory, "package.json"));
  if (packageJson === null) {
    return {
      verbs: {},
      notes: [
        "no readable package.json in this lane, so nothing the pack would propose could be cross-checked. Every reference verb is withheld rather than proposed unverified.",
      ],
    };
  }
  if (pack.packageManager !== null) {
    const declared = packageJson["packageManager"];
    const names =
      typeof declared === "string" &&
      (declared === pack.packageManager || declared.startsWith(`${pack.packageManager}@`));
    if (!names) {
      return {
        verbs: {},
        notes: [
          `package.json declares ${
            typeof declared === "string" ? `packageManager '${declared}'` : "no packageManager"
          }, and every reference verb for this stack routes through '${pack.packageManager}'. The verbs are withheld: proposing a command this repository has never run would be nen choosing its toolchain.`,
        ],
      };
    }
  }

  const verbs: Record<string, unknown> = {};
  const notes: string[] = [];
  for (const [verb, entry] of Object.entries(pack.verbs)) {
    if (entry.requiresDependency !== null && !dependsOn(packageJson, entry.requiresDependency)) {
      notes.push(
        `'${verb}' withheld: its reference command names '${entry.requiresDependency}', which package.json does not declare. A verb the project does not carry is a warning, never a proposal.`,
      );
      continue;
    }
    const steps = entry.steps;
    const first = steps[0];
    /* c8 ignore next -- the pack reader always produces at least one step */
    if (first === undefined) continue;
    verbs[verb] =
      steps.length === 1
        ? { exe: first.exe, argv: first.argv, why: entry.why }
        : { steps: steps.map((step): unknown => ({ exe: step.exe, argv: step.argv })), why: entry.why };
  }
  return { verbs, notes };
}

/** Scan, cross-check and assemble the proposal. Writes nothing. */
export function detect(repoRoot: string): DetectReport {
  const resolved = resolveSchemaFile(repoRoot, CONTRACT_FILE);
  const found = scan(repoRoot);
  const lanes: DetectedLane[] = [];
  const taken = new Set<string>();
  const notes: string[] = [];

  for (const { directory, matches } of found) {
    const cwd = relativePath(repoRoot, directory);
    const stacks = [...matches].sort((a, b): number => a.stack.localeCompare(b.stack));
    if (stacks.length > 1) {
      notes.push(
        `${cwd} carries markers for ${stacks.length} stacks (${stacks.map((match): string => match.stack).join(", ")}). Both lanes are proposed and neither is chosen -- delete the one this repository does not build.`,
      );
    }
    for (const match of stacks) {
      const lane = laneName(cwd, match.stack, taken);
      taken.add(lane);
      const proposed = proposeVerbs(PACK[match.stack], directory);
      lanes.push({
        lane,
        stack: match.stack,
        cwd,
        markers: [match.marker],
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

  const hostSets = new Set(lanes.map((lane): string => (STACK_HOSTS[lane.stack] ?? []).join(",")));
  let hosts: Readonly<Record<string, readonly string[]>> = {};
  if (hostSets.size === 1 && lanes[0] !== undefined) {
    hosts = { "*": STACK_HOSTS[lanes[0].stack] ?? [] };
  } else if (hostSets.size > 1) {
    notes.push(
      `the lanes need different platforms (${lanes
        .map((lane): string => `${lane.lane}: ${(STACK_HOSTS[lane.stack] ?? []).join("/")}`)
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
