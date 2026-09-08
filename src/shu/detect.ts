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
  spellOnHost,
  verbCell,
  type PackMinimum,
  type Placeholder,
  type ProfileCrossCheck,
  type ProfileMarker,
  type ProfilesPack,
  type ProfileVerb,
  type StackProfile,
} from "../profiles/pack.js";
import { CONTRACT_FILE, resolveSchemaFile } from "../schema/source.js";
import { parseYaml } from "../schema/yaml.js";
import { ASSERTABLE_KINDS, insideRepo } from "./run.js";

/**
 * Directories NOTHING IN THIS FILE ever descends into -- one set, for every
 * walk.
 *
 * IT WAS TWO SETS AND THAT WAS A DEFECT, not a nuance. The project walk skipped
 * `bin` and `obj` -- output directories where a build leaves a COPY of the
 * project file it built -- and the lane scan did not, so a `bin/Sub/App.csproj`
 * became a lane called `Sub` and an `obj/App.csproj` became a lane called
 * `obj`: a lane proposed out of build output, addressing a file the next clean
 * deletes. Two lists that must agree and are spelled twice agree only until
 * somebody edits one, and the disagreement is invisible because both readings
 * "work".
 *
 * They are output directories on the same evidence as `build`, `dist` and `out`
 * above them, and the cost of the wider set is stated with the other bounds:
 * `renderDetect`'s "no lane detected" prose names every one of these, because a
 * lane living in a directory named like build output is invisible by design and
 * a bound nobody states is a bug report.
 */
const SKIP = new Set([
  ".git",
  ".next",
  ".gradle",
  ".idea",
  ".nen",
  "node_modules",
  "bin",
  "build",
  "dist",
  "obj",
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
const XCSCHEME = /\.xcscheme$/;

/** The key an app manifest carries when the project is an Expo one. */
const EXPO_MANIFEST_KEY = "expo";

/**
 * The cloud-build profile file that sits beside an Expo manifest.
 *
 * EVIDENCE, NEVER AN IDENTIFICATION, and the difference is the whole reason it
 * is a separate constant. The reference pack lists it as a marker that
 * "identifies an Expo project on its own", and `detect` deliberately declines
 * that half: a tree carrying only this file has stated a build service's
 * configuration and not which manifest, lane or platform anything runs on, and
 * a lane proposed from it would be nen deciding what kind of project this is
 * from an ancillary file. So its presence is recorded as a SECOND marker of a
 * lane the manifest already identified, and `detect` notes it -- because the
 * pack's `archive` and `release` seats were written about repositories that had
 * NONE, and a maintainer reading those seats against a tree that has one needs
 * to be told the premise differs here.
 */
const EAS_CONFIG = "eas.json";

/**
 * Where a SHARED Xcode scheme lives, inside a `.xcworkspace` or `.xcodeproj`.
 *
 * A path, which is the one class of fact this module's header argues it may
 * carry: `xcshareddata/xcschemes/` means the same thing in every Xcode
 * repository on earth. What sits BESIDE it -- `xcuserdata/` -- is deliberately
 * not read: a scheme in there belongs to one developer's checkout rather than
 * to the repository, and proposing a row from it would propose a name a
 * colleague's clone does not have.
 */
const SHARED_SCHEMES: readonly string[] = ["xcshareddata", "xcschemes"];

/** The file an `.xcodeproj` bundle keeps its target list in. */
const PBXPROJ = "project.pbxproj";
/**
 * The stacks whose marker match is READ FROM THE PACK rather than spelled as a
 * pattern above.
 *
 * WHY THIS LIST IS SHORT RATHER THAN COMPLETE. This file's header argues that a
 * FILENAME is a universal fact and may live in code -- and `*.csproj` plus a
 * property inside it is that same class of fact, so either home is defensible.
 * What decides it here is that this stack's detection is not a filename at all:
 * the pattern is a wildcard, the refinement is a literal string the pack states
 * word for word, and a SECOND marker (the solution) is recorded only as
 * corroboration. Three pieces of one statement, all of them already written
 * down in `profiles/dotnet-winui.json` and rendered into `docs/STACK-MATRIX.md`
 * -- restating them here would be two copies of one rule with nothing to keep
 * them equal.
 *
 * The other six stay above because moving one is a behaviour change with its
 * own goldens: `settings.gradle{,.kts}` and `next.config.{js,mjs,cjs,ts,mts,
 * cts}` are BRACE GLOBS the matcher below deliberately does not read, and the
 * Expo and Apple rules are not a pattern match at all (a key inside a document,
 * a workspace PREFERRED over a project). A stack joins this list when its rule
 * is genuinely pattern-plus-literal and its own tests move with it.
 */
export const PACK_MATCHED_STACKS: readonly string[] = ["dotnet-winui"];

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
   *
   * IDENTIFYING PATHS ONLY. A file the pack calls a marker that this scan
   * declines to identify a lane from is not one of these -- it is `evidence`
   * below, and mixing the two made `markers` a list a reader could not act on:
   * "delete the marker and the lane goes away" is true of every entry here and
   * false of every entry there.
   */
  readonly markers: readonly string[];
  /**
   * The repo-relative paths this lane CARRIES that the pack names as markers of
   * its stack and that nen did NOT identify the lane from -- `eas.json` beside
   * an Expo manifest is the one shape in the pack today. Empty for almost every
   * lane, and never a reason a lane exists.
   */
  readonly evidence: readonly string[];
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

/**
 * A build script with its comments removed, so a LITERAL is read as code.
 *
 * EVERY MATCH THIS FILE MAKES AGAINST A BUILD SCRIPT GOES THROUGH HERE, and it
 * is one function rather than three because the three were drifting: the
 * settings file's `include(...)` reader stripped `//` and not `/* *\/`, and the
 * marker `contains` check stripped nothing at all. The consequences were the
 * same shape in both directions -- a `/* include(":retired") *\/` proposed a
 * module the build does not have, and a `// TODO: id("com.android.application")`
 * proposed a whole LANE out of a line somebody wrote to remind themselves. A
 * commented-out fact is not a fact about the project, and §2.6's rule is that a
 * thing the project does not contain is a warning and never a proposal.
 *
 * QUOTED STRINGS ARE STEPPED OVER, because a `//` inside one is not a comment:
 * `url = "https://example.invalid/x"` would otherwise lose the rest of its line
 * and take a real literal with it. The scanner is deliberately small -- it knows
 * quotes, escapes and the two comment forms, and nothing else about Kotlin or
 * Groovy -- and newlines inside a block comment are kept so that nothing
 * downstream reading line by line sees the file shrink.
 */
export function stripScriptComments(text: string): string {
  let out = "";
  let index = 0;
  let quote: string | null = null;
  while (index < text.length) {
    const character = text[index] ?? "";
    if (quote !== null) {
      if (character === "\\" && index + 1 < text.length) {
        out += character + (text[index + 1] ?? "");
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      out += character;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      out += character;
      index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n") out += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

/** A build script read from disk with its comments gone, or "" when unreadable. */
function readScript(path: string): string | null {
  const text = readText(path);
  return text === null ? null : stripScriptComments(text);
}

/**
 * MARKUP with its comments removed -- the XML twin of `stripScriptComments`.
 *
 * IT EXISTS FOR THE SAME DEFECT IN THE OTHER SYNTAX, and the three shapes it
 * closes are the three questions this file asks a project file. A commented
 * `<!-- <UseWinUI>true</UseWinUI> -->` qualified a whole LANE off a line
 * somebody wrote to switch a property off; a commented-out `<ProjectReference>`
 * withheld a build over a dependency the project does not have; and a
 * `<!-- we deleted xunit -->` made a documentation project the tree's test
 * project. A commented-out fact is not a fact about the project, and §2.6's
 * rule is that a thing the project does not contain is a warning and never a
 * proposal.
 *
 * CDATA IS STEPPED OVER RATHER THAN SCANNED, because a `<!--` inside one is
 * character data and not a comment -- the same argument the script scanner
 * makes for a `//` inside a quoted string, and the reason both are one function
 * rather than a regex. Newlines inside a comment are kept, so that nothing
 * downstream reading line by line sees the file shrink.
 */
export function stripMarkupComments(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("<![CDATA[", index)) {
      const end = text.indexOf("]]>", index);
      if (end === -1) {
        out += text.slice(index);
        break;
      }
      out += text.slice(index, end + 3);
      index = end + 3;
      continue;
    }
    if (text.startsWith("<!--", index)) {
      const end = text.indexOf("-->", index + 4);
      // AN UNTERMINATED COMMENT SWALLOWS THE REST OF THE FILE, which is what
      // every XML reader does with one: a file nen cannot parse is a file nen
      // reads nothing out of, and half-reading it is how a marker inside a
      // comment gets believed.
      const stop = end === -1 ? text.length : end + 3;
      for (let at = index; at < stop; at += 1) {
        if (text[at] === "\n") out += "\n";
      }
      index = stop;
      continue;
    }
    out += text[index] ?? "";
    index += 1;
  }
  return out;
}

/** A markup file read from disk with its comments gone, or null when unreadable. */
function readMarkup(path: string): string | null {
  const text = readText(path);
  return text === null ? null : stripMarkupComments(text);
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
  /**
   * Whether this marker is what ANSWERED the stack, or a second file recorded
   * beside one that did.
   *
   * The distinction exists for exactly one shape today and is worth a field
   * rather than a convention: a file the reference pack names as a marker, that
   * this scan declines to identify a lane from, and whose presence still
   * changes how a reader should read the pack's own seats. `detect()` turns
   * every non-identifying marker into a note quoting the pack's reason for the
   * marker, so the fact is never recorded silently.
   */
  readonly identifying: boolean;
}

// ── the host-tool stacks, read off the catalogue ────────────────────────────
//
// TWO STACKS IN THIS PACK ARE FOUND BY A TOOL THE REPOSITORY SHIPS IN ITS OWN
// TREE rather than by a config filename: a wrapper script beside a build file
// that carries a plugin id. Everything about them below -- the tool's two
// spellings, the build files to read, the literal each must carry -- is read
// out of ../profiles, and the argument for that is not tidiness:
//
//   * THE TOOL'S TWO SPELLINGS ARE THE VALUE `{gw}` RESOLVES TO. The pack
//     states them (`PLACEHOLDERS[].hostSpelling`, with its citation) because
//     nen substitutes that token itself, from the host. Spelling them a second
//     time HERE, to find the file, would be two copies of one fact in two
//     files, and the copy in this one would be the stack literal §3 forbids --
//     this module is allowed FILENAMES, and "the name of the wrapper this
//     particular build system happens to use" is a fact about that build
//     system, not about filesystems.
//   * THE PLUGIN ID IS ALREADY DATA. Each profile's `markers[].contains` is
//     documented as "a literal the matched file must contain", so reading it
//     is reading the catalogue's own sentence rather than restating it. That
//     also surfaced a marker that could never have matched: one profile's
//     `contains` named a DSL block by its dotted name, which appears in no
//     build file, and it is now the block's receiver, as written.
//
// A stack qualifies as one of these when its OWN rows go through the
// host-conditional token -- a property of the catalogue, not a list here.

/** A `host-conditional` token and the file its value names inside a lane. */
interface HostToken {
  readonly token: string;
  readonly placeholder: Placeholder;
}

const HOST_TOKENS: readonly HostToken[] = PLACEHOLDERS.filter(
  (placeholder): boolean => placeholder.hostSpelling !== undefined,
).map((placeholder): HostToken => ({ token: placeholder.token, placeholder }));

/**
 * A value like `./gradlew` as the FILENAME it names inside a lane.
 *
 * The leading `./` is what makes the tool the lane's own rather than whatever
 * the PATH resolves, and it is meaningful to the executor for exactly that
 * reason -- but a directory listing has no `./` in it.
 */
function laneRelativeName(value: string): string {
  const segments = value.split("/").filter((segment): boolean => segment !== "" && segment !== ".");
  return segments[segments.length - 1] ?? value;
}

/** Every spelling of every host-conditional token, as a lane-relative filename. */
const HOST_TOOL_FILES: ReadonlySet<string> = new Set(
  HOST_TOKENS.flatMap((entry): readonly string[] => {
    const spelling = entry.placeholder.hostSpelling;
    /* c8 ignore next -- HOST_TOKENS is filtered on this field being present */
    if (spelling === undefined) return [];
    return [laneRelativeName(spelling.posix), laneRelativeName(spelling.win32)];
  }),
);

/**
 * `settings.gradle{,.kts}` -> `settings.gradle`, `settings.gradle.kts`.
 *
 * BRACE ALTERNATION IS THE ONE GLOB SHAPE MARKER PATTERNS USE, and the pack
 * documents it as such (../profiles/pack.ts: marker patterns are brace globs,
 * deliberately not held to the placeholder set they share a delimiter with).
 * Expanding it here rather than teaching this file that one suffix is optional
 * keeps the two spellings of a filename where the other filename facts are.
 */
function expandBraces(pattern: string): readonly string[] {
  const open = pattern.indexOf("{");
  const close = pattern.indexOf("}", open + 1);
  if (open === -1 || close === -1) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  return pattern
    .slice(open + 1, close)
    .split(",")
    .flatMap((alternative): readonly string[] => expandBraces(`${head}${alternative}${tail}`));
}

/**
 * The filename SPELLINGS a marker pattern names, its directory prefix dropped.
 *
 * EXPORTED FOR ./detect.test.ts, which holds every pattern in every profile to
 * a shape this reader understands -- a sweep that has to enumerate the
 * alternatives to build a sample out of each.
 */
export function markerSpellings(pattern: string): readonly string[] {
  return expandBraces(pattern).map(laneRelativeName);
}

/**
 * ONE SPELLING against one filename: an exact name, or a `*<suffix>` glob.
 *
 * A RICHER SHAPE NEVER MATCHES, and that is a blind spot rather than a silent
 * pass -- ../profiles/pack.test.ts pins every pattern in the pack to the two
 * shapes this reads, so a `**`, a mid-name wildcard or a character class fails
 * the build rather than shipping as a stack nothing detects. Reading half of a
 * pattern language is the one outcome worse than reading none of it: it matches
 * the wrong files confidently.
 */
function matchesSpelling(spelling: string, name: string): boolean {
  if (!spelling.startsWith("*")) return spelling === name;
  const suffix = spelling.slice(1);
  // A bare `*`, or a second wildcard, is a shape this does not read. And the
  // name must be LONGER than the suffix: `.csproj` itself is a dotfile, not a
  // project called nothing.
  if (suffix === "" || suffix.includes("*")) return false;
  return name.length > suffix.length && name.endsWith(suffix);
}

/**
 * A PACK MARKER PATTERN AGAINST ONE FILENAME -- the file's ONE pattern reader.
 *
 * THREE DIALECTS ARRIVED IN THREE PULL REQUESTS AND THIS IS THE ONE THEY
 * BECAME. `*.csproj` is a suffix glob, `settings.gradle{,.kts}` is a brace
 * alternation, and `*\/build.gradle{,.kts}` carries a directory prefix that
 * `isNestedPattern` reads separately; a second reader for any of them would
 * have drifted the first time either was fixed, and the drift is invisible
 * because a pattern that reads as "no match" proposes nothing rather than
 * failing. So the prefix is dropped, the braces are expanded, and every
 * alternative goes through one predicate.
 */
export function matchesPattern(pattern: string, name: string): boolean {
  return markerSpellings(pattern).some((spelling): boolean => matchesSpelling(spelling, name));
}

/** Whether any spelling in this set matches the name. */
function anySpellingMatches(spellings: ReadonlySet<string>, name: string): boolean {
  for (const spelling of spellings) {
    if (matchesSpelling(spelling, name)) return true;
  }
  return false;
}

/**
 * Whether a pattern names a file BELOW the lane root rather than in it.
 *
 * THE PREFIX IS PART OF THE PATTERN AND IS NOW HONOURED. `*\/build.gradle{,.kts}`
 * was being reduced to its filenames and matched against the lane's OWN build
 * file too, which made the pack say one thing and the code do another: the
 * profile's `why` reads "a MODULE applying the Android application plugin", and
 * a root build file naming that plugin `apply false` -- the ordinary Android
 * root convention, and the fixture in this repository -- is not a module and is
 * not applying it. A tree with such a root and no module at all was proposed as
 * an Android lane on the strength of a line that switches the plugin OFF.
 *
 * `*\/` IS READ AS "NOT THE LANE'S OWN FILE", not as "exactly one level down",
 * and the difference is deliberate: how far down the search goes is
 * `REFINEMENT_DEPTH`'s job, it is documented as a bound, and making the prefix
 * a second, silent bound would hide a real module behind a rule nothing states.
 * The pack uses exactly one directory prefix and ../profiles/pack.test.ts pins
 * that, so this reads a shape rather than parses a glob language.
 */
function isNestedPattern(pattern: string): boolean {
  return pattern.includes("/");
}

/** A marker that is a filename PLUS a literal the file must carry. */
interface Refinement {
  readonly files: ReadonlySet<string>;
  readonly literal: string;
  /** True when the pattern carried a directory prefix -- see `isNestedPattern`. */
  readonly nested: boolean;
}

/** One stack whose lanes are found by a tool the repository ships. */
interface HostToolStack {
  readonly stack: string;
  /**
   * Every `contains` marker the profile states. ALL must match, which is the
   * conservative reading of a marker list that reads "the wrapper, its settings
   * file, and the module that makes it THIS stack".
   */
  readonly refinements: readonly Refinement[];
  /**
   * ONE SET PER NO-LITERAL MARKER, minus the tool itself: the alternative
   * spellings of one required file. At least one name from EVERY group must be
   * in a directory before this stack matches there.
   *
   * THEY WERE COMPUTED AND NEVER REQUIRED, and that is what let a nested build
   * be attributed to its parent. `compose-desktop`'s first marker is "the
   * lane's OWN settings file, not the repository root's" -- the pack says so in
   * the marker's own `why` -- and with the requirement missing, a tree whose
   * root carried a wrapper and whose `program/` carried a settings file and a
   * `compose.desktop` block came out as TWO lanes both at cwd `.`, the second
   * of them proposing the ROOT wrapper against a build that wrapper never
   * reads. A marker the code does not check is documentation, not a marker.
   */
  readonly contextGroups: readonly ReadonlySet<string>[];
  /** The union of the groups above -- the files a cross-check may then read. */
  readonly contextFiles: ReadonlySet<string>;
}

/** Whether any of this profile's own rows or probes name this token. */
function profileUses(profile: StackProfile, token: string): boolean {
  const inRows = Object.values(profile.verbs).some((cell): boolean =>
    stepsOfCell(cell).some((step): boolean =>
      [step.exe, ...step.argv].some((word): boolean => word.includes(token)),
    ),
  );
  const inProbes = Object.values(profile.toolchain).some((entry): boolean =>
    entry.probe.some((word): boolean => word.includes(token)),
  );
  return inRows || inProbes;
}

/** The pack's host-tool stacks, in the pack's own id order. */
function hostToolStacks(pack: ProfilesPack): readonly HostToolStack[] {
  const out: HostToolStack[] = [];
  for (const id of pack.ids) {
    const profile = profileById(pack, id);
    if (!HOST_TOKENS.some((entry): boolean => profileUses(profile, entry.token))) continue;
    const refinements: Refinement[] = [];
    const contextGroups: ReadonlySet<string>[] = [];
    const contextFiles = new Set<string>();
    for (const marker of profile.markers) {
      const files = markerSpellings(marker.pattern);
      if (marker.contains !== null) {
        refinements.push({
          files: new Set(files),
          literal: marker.contains,
          nested: isNestedPattern(marker.pattern),
        });
        continue;
      }
      const group = new Set(files.filter((file): boolean => !HOST_TOOL_FILES.has(file)));
      if (group.size === 0) continue;
      contextGroups.push(group);
      for (const file of group) contextFiles.add(file);
    }
    out.push({ stack: id, refinements, contextGroups, contextFiles });
  }
  return out;
}

/**
 * Whether this directory is a BUILD OF ITS OWN rather than part of the one above.
 *
 * TWO PIECES OF EVIDENCE, EITHER OF WHICH IS ENOUGH, and the second was
 * missing. A directory shipping its own copy of the tool is plainly its own
 * build -- and so is one carrying its own SETTINGS file, which is the file that
 * declares where a build begins and what it contains. Only the first was
 * checked, so a nested build with a settings file and no wrapper of its own had
 * its build files read as evidence about the lane ABOVE it: the parent was
 * proposed a command naming its own wrapper against a build that wrapper does
 * not read, which is a row that exits non-zero the first time anybody runs it.
 */
function isOwnBuildRoot(directory: string, context: ReadonlySet<string>): boolean {
  return listDirectory(directory).some(
    (entry): boolean =>
      !entry.directory &&
      (HOST_TOOL_FILES.has(entry.name) || anySpellingMatches(context, entry.name)),
  );
}

/**
 * The file in or under this directory that carries a refinement's literal.
 *
 * IT STOPS AT A NESTED LANE ROOT, and that is the whole of what makes a
 * two-lane repository come out as two lanes. A directory shipping its own copy
 * of the tool is its own build -- it has its own settings file, its own pinned
 * tool version, and is included by nothing above it -- so a marker inside it is
 * evidence about THAT lane. Without the stop, a repository whose root is one
 * stack and whose subdirectory is another proposed the subdirectory's stack at
 * the root as well: three lanes for two builds, one of them addressing a build
 * file the root's tool would never read.
 */
function fileCarrying(
  directory: string,
  refinement: Refinement,
  depth: number,
  context: ReadonlySet<string>,
  atLaneRoot: boolean,
  nestedBuilds: Set<string>,
): string | null {
  for (const entry of listDirectory(directory)) {
    const path = join(directory, entry.name);
    if (entry.directory) {
      if (depth === 0 || SKIP.has(entry.name)) continue;
      if (isOwnBuildRoot(path, context)) {
        nestedBuilds.add(path);
        continue;
      }
      const found = fileCarrying(path, refinement, depth - 1, context, false, nestedBuilds);
      if (found !== null) return found;
      continue;
    }
    // The pattern's own directory prefix, honoured: a marker written
    // `<dir>/<file>` is never satisfied by the lane's own `<file>`.
    if (atLaneRoot && refinement.nested) continue;
    if (!anySpellingMatches(refinement.files, entry.name)) continue;
    if ((readScript(path) ?? "").includes(refinement.literal)) return path;
  }
  return null;
}

/**
 * The pack's markers for one stack, against one directory.
 *
 * A REFINED MARKER QUALIFIES THE STACK; AN UNREFINED ONE ONLY CORROBORATES IT.
 * That is the pack's own sentence made operational: a `*.csproj` is .NET until
 * a property inside it says which kind, and a `*.sln` is "present but not
 * sufficient". So a directory carrying only unrefined matches is NOT this
 * stack -- proposing the narrower stack from the broader marker would be nen
 * deciding what kind of application this is -- while a directory that qualifies
 * records every matched file, refined and unrefined alike, in byte order.
 *
 * A PROFILE STATING NO REFINED MARKER AT ALL has nothing to be refined by, so
 * every one of its markers qualifies. That branch is unused by today's pack and
 * is the honest reading of the rule rather than a special case: "must be
 * refined" is a claim only a profile that states a refinement can make.
 */
function packMarkersIn(
  repoRoot: string,
  directory: string,
  names: readonly string[],
  markers: readonly ProfileMarker[],
): PackMarkerMatches {
  const found: string[] = [];
  let qualifies = !markers.some((marker): boolean => marker.contains !== null);
  for (const name of names) {
    const marker = markers.find((entry): boolean => fileCarriesMarker(directory, name, entry));
    if (marker === undefined) continue;
    found.push(join(directory, name));
    if (marker.contains !== null) qualifies = true;
  }
  if (qualifies) return { markers: found, nearMisses: [] };
  return { markers: [], nearMisses: nearMissesIn(repoRoot, directory, names, markers) };
}

/**
 * `<UseWinUI>true</UseWinUI>` -> `UseWinUI`, when the literal is ONE WHOLE
 * ELEMENT and nothing else.
 *
 * READ OFF THE PACK'S OWN LITERAL rather than stated here, which is what keeps
 * this file free of the stack: nen does not know what the element MEANS, only
 * that the catalogue wrote a complete element and that a file spelling the same
 * element with attributes is a near miss rather than a coincidence.
 */
function markerElement(contains: string): string | null {
  return /^<([A-Za-z_][\w.-]*)>[^<>]*<\/\1>$/.exec(contains)?.[1] ?? null;
}

/**
 * A file that ALMOST carries a refined marker, and the sentence that says so.
 *
 * THE SILENT NON-DETECTION THIS EXISTS TO END. `<UseWinUI Condition="'$(Config)'
 * == 'Release'">true</UseWinUI>` is a real project of this stack, written the
 * way MSBuild lets you write it, and it matched no marker at all -- so the tree
 * came back "no lane detected", which is the same answer an empty directory
 * gets. nen does not evaluate conditions and should not start; what it can do is
 * refuse to be silent about the one shape it knows it is declining.
 *
 * IT IS A NEAR MISS AND NOT A MATCH, deliberately: an attribute can switch the
 * element OFF as easily as on, and proposing a lane from a line nen cannot
 * evaluate is exactly the guess §2.6 forbids.
 */
function nearMissesIn(
  repoRoot: string,
  directory: string,
  names: readonly string[],
  markers: readonly ProfileMarker[],
): readonly string[] {
  const out: string[] = [];
  for (const marker of markers) {
    const literal = marker.contains;
    if (literal === null) continue;
    const element = markerElement(literal);
    if (element === null) continue;
    for (const name of names) {
      if (!matchesPattern(marker.pattern, name)) continue;
      const text = readMarkup(join(directory, name));
      if (text === null || text.includes(literal)) continue;
      if (!new RegExp(`<${literalPattern(element)}\\s[^>]*>`).test(text)) continue;
      out.push(
        `${relativePath(repoRoot, join(directory, name))} spells <${element}> WITH ATTRIBUTES, and the reference pack's marker for this stack is the literal '${literal}'. nen does not evaluate a condition -- an attribute can switch the element off as easily as on, and a lane proposed from a line nen cannot read would be a guess. So this tree is NOT proposed as that stack, and the reason is here rather than in the silence a missing marker otherwise leaves. Write the unconditional form, or state the lane by hand.`,
      );
    }
  }
  return out;
}

/** Whether this file both matches a marker's pattern and carries its literal. */
function fileCarriesMarker(directory: string, name: string, marker: ProfileMarker): boolean {
  if (!matchesPattern(marker.pattern, name)) return false;
  if (marker.contains === null) return true;
  return (readMarkup(join(directory, name)) ?? "").includes(marker.contains);
}

/**
 * How far below a lane root a refinement is looked for.
 *
 * A SECOND BOUND BESIDE `MAX_DEPTH`, and it is the one that decides whether a
 * MODULE is seen: the scan finds lane roots down to `MAX_DEPTH`, and from each
 * one this decides how deep the module carrying the plugin may sit. A module at
 * `a/b/c/` under a lane root is invisible to it, exactly as a lane four
 * directories down is invisible to the other -- and for the same reason, which
 * is that an unbounded walk of a large checkout is slow and a build file deep
 * inside somebody's fixture tree is far likelier to be test data than a module.
 * Both numbers are named in `renderDetect`'s "no lane detected" prose and in
 * docs/USAGE.md, because a bound nobody states is a bug report.
 */
export const REFINEMENT_DEPTH = 2;

/** What one directory answered: its stacks, and the nested builds it hid. */
interface DirectoryMatches {
  readonly matches: readonly Match[];
  /**
   * Absolute paths of subdirectories the refinement search STOPPED at because
   * they are builds of their own. Reported as a finding when none of them
   * became a lane -- a build nen can see and cannot address is exactly the
   * "warning, never a proposal" case, and silence about it reads as absence.
   */
  readonly nestedBuilds: readonly string[];
  /**
   * Files that ALMOST carried a pack-matched stack's refined marker -- see
   * `nearMissesIn`. Reported as findings, because a real project nen declines
   * to read looks exactly like an empty directory from the outside.
   */
  readonly nearMisses: readonly string[];
}

/** One pack-matched stack's answer for one directory. */
interface PackMarkerMatches {
  readonly markers: readonly string[];
  readonly nearMisses: readonly string[];
}

/** Every stack whose markers this ONE directory carries. */
function matchesIn(
  repoRoot: string,
  directory: string,
  hostStacks: readonly HostToolStack[],
  packMarkers: readonly PackMarkers[],
): DirectoryMatches {
  const entries = listDirectory(directory);
  const names = entries.map((entry): string => entry.name);
  const files = new Set(
    entries.filter((entry): boolean => !entry.directory).map((entry): string => entry.name),
  );
  const nestedBuilds = new Set<string>();
  const nearMisses: string[] = [];
  const found: Match[] = [];
  const add = (stack: string, marker: string): void => {
    found.push({ stack, marker: relativePath(repoRoot, marker), identifying: true });
  };
  const alsoCarries = (stack: string, marker: string): void => {
    found.push({ stack, marker: relativePath(repoRoot, marker), identifying: false });
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
  let expoManifest: string | null = null;
  if (appJson !== null && appJson[EXPO_MANIFEST_KEY] !== undefined) {
    expoManifest = join(directory, "app.json");
  } else {
    const appConfig = names.find((name): boolean => APP_CONFIG.test(name));
    if (appConfig !== undefined && dependsOn(readJson(join(directory, "package.json")), EXPO_MANIFEST_KEY)) {
      expoManifest = join(directory, appConfig);
    }
  }
  if (expoManifest !== null) {
    add("expo", expoManifest);
    // THE CLOUD-BUILD PROFILE IS RECORDED AND NEVER IDENTIFIES. See EAS_CONFIG:
    // the pack says it identifies a project on its own, and this scan declines
    // that half deliberately -- so it is a second marker of a lane the manifest
    // already answered, and `detect()` notes it against the pack's own seats.
    if (names.includes(EAS_CONFIG)) alsoCarries("expo", join(directory, EAS_CONFIG));
  }

  // Apple: the workspace is PREFERRED over the project, because a tree carrying
  // both is one where building the project directly skips the dependency
  // manager's own generated targets.
  const workspace = names.find((name): boolean => XCWORKSPACE.test(name));
  const project = names.find((name): boolean => XCODEPROJ.test(name));
  if (workspace !== undefined) add("xcode-ios", join(directory, workspace));
  else if (project !== undefined) add("xcode-ios", join(directory, project));

  // The host-tool stacks: the tool the repository ships, plus every context
  // file and every refinement its own profile states. THE TOOL AND THE CONTEXT
  // FILES MUST BE FILES -- a directory named `gradlew` is not a wrapper, and a
  // marker scan that reads a listing rather than a file type would propose a
  // lane out of one. EVERY refinement must then be found, and the files that
  // carried them are the markers: a stack identified by a plugin id is
  // identified by the file that applies it, not by the wrapper beside it.
  if ([...files].some((name): boolean => HOST_TOOL_FILES.has(name))) {
    for (const entry of hostStacks) {
      const context = entry.contextGroups.every((group): boolean =>
        [...files].some((name): boolean => anySpellingMatches(group, name)),
      );
      if (!context) continue;
      const carriers: string[] = [];
      for (const refinement of entry.refinements) {
        const file = fileCarrying(
          directory,
          refinement,
          REFINEMENT_DEPTH,
          entry.contextFiles,
          true,
          nestedBuilds,
        );
        if (file === null) {
          carriers.length = 0;
          break;
        }
        carriers.push(file);
      }
      for (const carrier of carriers) add(entry.stack, carrier);
    }
  }

  for (const { stack, markers } of packMarkers) {
    const answer = packMarkersIn(repoRoot, directory, names, markers);
    for (const marker of answer.markers) add(stack, marker);
    nearMisses.push(...answer.nearMisses);
  }

  return {
    matches: found,
    nestedBuilds: [...nestedBuilds].sort(compareBytes),
    nearMisses,
  };
}

/** One pack-matched stack and the markers the pack states for it. */
interface PackMarkers {
  readonly stack: string;
  readonly markers: readonly ProfileMarker[];
}

/** The marker tables `matchesIn` reads out of the pack, resolved once per scan. */
function packMarkersOf(pack: ProfilesPack): readonly PackMarkers[] {
  return PACK_MATCHED_STACKS.map(
    (stack): PackMarkers => ({ stack, markers: profileById(pack, stack).markers }),
  );
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

/**
 * Whether the manifest declares a package that CARRIES this program.
 *
 * `dependsOn` compares names; this compares a name to a PROGRAM, and the one
 * difference between the two is the scope. A tool published under a scope ships
 * its binary under the unscoped tail -- `@biomejs/biome` is how you depend on
 * `biome`, and every scoped tool in existence is spelled that way -- so an exact
 * match alone would withhold a row whose tool the repository plainly declares.
 * It is a WIDENING of the check and never a narrowing: nothing it accepts is
 * absent from the manifest, and the scope belongs to the publisher rather than
 * to the repository being read.
 */
function carriesDependency(
  packageJson: Record<string, unknown> | null,
  program: string,
): boolean {
  if (dependsOn(packageJson, program)) return true;
  if (packageJson === null || program === "" || program.includes("/")) return false;
  const tail = `/${program}`;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const block = packageJson[field];
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
    for (const name of Object.keys(block as Record<string, unknown>)) {
      if (name.startsWith("@") && name.endsWith(tail)) return true;
    }
  }
  return false;
}

interface Scan {
  readonly found: readonly { directory: string; matches: readonly Match[] }[];
  /** Every nested build the refinement search stopped at, absolute, byte-ordered. */
  readonly nestedBuilds: readonly string[];
  /** Every near-miss sentence the scan collected, byte-ordered. */
  readonly nearMisses: readonly string[];
}

/** Every directory with markers, deepest-last, root first. */
function scan(
  repoRoot: string,
  hostStacks: readonly HostToolStack[],
  packMarkers: readonly PackMarkers[],
): Scan {
  const out: { directory: string; matches: readonly Match[] }[] = [];
  const nested = new Set<string>();
  const misses = new Set<string>();
  const walk = (directory: string, depth: number): void => {
    const { matches, nestedBuilds, nearMisses } = matchesIn(
      repoRoot,
      directory,
      hostStacks,
      packMarkers,
    );
    for (const build of nestedBuilds) nested.add(build);
    for (const miss of nearMisses) misses.add(miss);
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
  return {
    found: out,
    nestedBuilds: [...nested].sort(compareBytes),
    nearMisses: [...misses].sort(compareBytes),
  };
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
//   1b. A TOKEN THE MANIFEST'S OWN `scripts` ANSWERS -- ARITY PLUS
//      CORROBORATION. A step that matches a declared script's command word for
//      word, differing only where the pack wrote a token, is answered from that
//      script -- `node {archiveScript}` against `"resume:pdf": "node
//      scripts/build-resume-pdf.mjs"` yields the path the repository itself
//      runs. ARITY ALONE IS NOT ENOUGH, and that was a real defect: `node
//      {archiveScript}` spells out ONE word and asks for one, so every
//      one-argument `node` script in the manifest agreed with it, and a
//      `"start": "node server.js"` answered the PDF-archive row. So a candidate
//      whose literal words do not OUTNUMBER its token positions is answered
//      only where the SCRIPT'S OWN KEY names the intent -- a word of the key
//      appearing in the verb, in the token's name, or in the value that script
//      would answer with, which is what makes `resume:pdf` -> `…-pdf.mjs`
//      corroboration and `start` -> `server.js` a coincidence. `scriptAnswers`
//      carries the full argument and the boundary case.
//      TWO CORROBORATED MATCHES THAT DISAGREE ARE AN AMBIGUITY AND ARE
//      WITHHELD, never resolved: rule 1 in this file's header is not suspended
//      because the two candidates came from the same file. THE RULE IS OVER
//      TOKENS, NOT OVER ONE TOKEN, and deliberately so: a manifest that spells
//      the whole command out has stated something stronger about itself than
//      any single field does, so a manager named in a script answers as well as
//      one named in a field. What it may never do is answer a token from
//      anywhere but this repository -- the pack contributes the SHAPE and never
//      a value, which is the property the whole family rests on.
//   2. THE EXECUTABLE, AND THE TOOL IT HANDS THE WORK TO. A step's `exe` must be
//      the package manager the manifest names, or a package the manifest
//      declares as a dependency, or -- the third route -- part of a step the
//      manifest declares VERBATIM as one of its own scripts. Those are the only
//      three ways `detect` can SEE that a repository carries a program, and "the
//      marker matched so the tool must be here" is exactly the inference §2.6
//      calls a warning rather than a proposal. The third route is the strongest
//      of the three and is why it exists: a manifest whose `scripts` block
//      spells this exact command is the repository stating that it runs THIS
//      LINE, which outranks a guess from a dependency list that the line merely
//      might use -- so a verbatim step skips this check and the task check both.
//      AND THE CHECK FOLLOWS THE WORK ONE HOP FURTHER. `pnpm turbo run build`
//      passes on `exe` the moment the manifest names pnpm, and says nothing
//      about turbo, which is the program that has to be there; the same held for
//      `pnpm exec biome check .`. So the three forms where a manager hands a step
//      to something else -- `npx <tool>`, `<pm> exec <tool>`, `<pm> <tool> run
//      <task>` -- are read one level in, and the tool must be a package the
//      manifest declares. A scoped `@biomejs/biome` answers for `biome`: the
//      scope is the publisher's, and matching only the exact string would
//      withhold a row whose tool the repository plainly declares.
//   3. THE TASK, AGAINST THE LIST ITS RUNNER WOULD ACTUALLY CONSULT. `run
//      <task>` names a task, and WHO is being asked to run it is the word before
//      `run`. `<pm> run <task>` asks the package manager, whose list is this
//      manifest's `scripts`. `<pm> turbo run <task>` asks TURBO, whose list is
//      its own `turbo.json` (`tasks`, or `pipeline` in turbo 1) -- a repository
//      can declare the npm script and not the turbo task, or the reverse, and
//      checking `scripts` for a turbo task validated the wrong list in both
//      directions. Where nen cannot see the runner's list -- no `turbo.json`
//      here, or a runner whose config filename nen does not know -- the row is
//      WITHHELD saying which, because "nen could not check" must never render as
//      "nen checked and it was fine". AND, for a row nen answered `{package}` in
//      from this manifest's own `name`, the element that FOLLOWS that package
//      name is the task that package must declare: `{package}`'s documented
//      meaning is "one workspace package the command runs for", so everything
//      before it is the manager's own filter syntax and what comes after it is
//      the task. This is the check whose absence made the header's "never
//      proposes a command the repository cannot run" false: a manifest with
//      `scripts: { lint: "…" }` and nothing else still got a proposed `build`.
//      It is deliberately CONSERVATIVE about a task declared somewhere this
//      reader cannot see (a workspace member, a runner's own config file), and
//      the note says so, because withholding a row a human can add back beats
//      proposing one that exits 1.
//
// A WORKSPACE ROOT NEVER ANSWERS `{package}`. A manifest declaring `workspaces`
// -- or sitting beside a `pnpm-workspace.yaml`, which is a FILENAME rather than
// a tool this file has an opinion about, exactly as `next.config.mjs` is -- is
// not itself the package a per-package row runs for; it is the list of them.
// Substituting its own `name` there would propose a command that runs the root
// against itself, which is a different command from the N the repository
// actually runs, so the row is withheld and the note NAMES THE MEMBERS nen could
// see, because "which of these, and in what order" is the question the
// maintainer is being asked. The member list applies NEGATIONS after expansion
// and names only directories that are there, because a list that includes the
// one package the repository said to exclude, or one that names a directory the
// tree does not have, is worse than no list at all.
//
// Every check that fails withholds ONE ROW and names it. Nothing here refuses
// the scan, and nothing here writes.

/** The three placeholders a repository's own `package.json` answers. */
const PM_EXECUTABLE = "{pm}";
const PM_PIN = "{packageManager}";
const PACKAGE_NAME = "{package}";

/**
 * The one declaration-supplied token a lane's own SETTINGS file can answer.
 *
 * Spelled here beside the three above for the same reason they are: a token is
 * an interface the pack publishes, and naming one is naming a field, not a
 * stack. What nen may never do is supply its VALUE, and it does not -- the
 * value is read out of the repository being scanned.
 */
const UNIT_TEST_TASK = "{unitTestTask}";

/**
 * The one placeholder whose REASON is read out of the working tree.
 *
 * IT IS NOT A FOURTH ANSWERED TOKEN, and the asymmetry is the point: the three
 * above are substituted, and this one is never substituted at all. A row naming
 * it stays withheld exactly as before; the token is listed here only because it
 * tells `detect` that this lane is one whose scheme and project files are worth
 * READING for the note (`appleReason`). Naming a token to decide what to read
 * is the same class of fact as naming `turbo.json` to decide where a task list
 * lives -- a filename, not a command -- and it keeps the file reads off every
 * lane that has no such files.
 */
const SCHEME_NAME = "{scheme}";

/** Every token the pack may use, so a leftover one can be named exactly. */
const PACK_TOKENS: readonly string[] = PLACEHOLDERS.map(
  (placeholder): string => placeholder.token,
);

const PACK_TOKEN_SET: ReadonlySet<string> = new Set(PACK_TOKENS);

/**
 * The tokens whose value a DECLARATION supplies, as the pack itself classifies
 * them.
 *
 * Read off `PLACEHOLDERS[].kind` rather than listed here, because hard-coding
 * either list would be this file re-deciding a classification the catalogue
 * already makes.
 *
 * IT DECIDES WORDING AND NOTHING ELSE, and that is a correction. It was a GATE:
 * a toolchain probe naming the one `host-conditional` token, `{gw}`, was
 * treated as a probe nen had no need to decline, on the strength of the pack's
 * own prose calling it "THE ONE TOKEN NEN RESOLVES ITSELF". The program says
 * otherwise -- ./render.ts lists `{gw}` in REFUSED_PLACEHOLDERS and ./purity.
 * test.ts pins that list against `PLACEHOLDERS` in BOTH directions, so every
 * token the pack has is a token the executor refuses, `{gw}` included. The
 * effect of believing the prose was that `gradle-android` and `compose-desktop`
 * -- the two stacks whose every command goes through that wrapper -- got no
 * note at all about the one toolchain row nen was declining to propose a
 * precondition for.
 *
 * THE RULE THIS FILE FOLLOWS, STATED ONCE: where the catalogue's prose and the
 * executor's behaviour disagree about what nen does, the behaviour is the fact.
 * A note is a promise to a reader, and it has to be checkable against the code
 * that will run.
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
  /**
   * The patterns nen could not expand, verbatim -- a `**`, a mid-segment glob.
   * NAMED IN THE NOTE rather than silently dropped, because a pattern nen could
   * not read is the difference between "these are the members" and "these are
   * the members nen could see", and a NEGATION nen could not read is worse
   * still: it means the member list may name a package the repository excludes.
   */
  readonly unread: readonly string[];
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
  /**
   * Each declared script, KEY INCLUDED, its command split on whitespace, in
   * declared order. The key travels with the words because it is half the
   * evidence: see `scriptAnswers`, where a script's own name is what
   * corroborates a match a thin step could never corroborate by itself.
   */
  readonly scriptWords: readonly DeclaredScript[];
  /** The task list of a non-manager runner, when nen can read one. */
  readonly runnerTasks: (runner: string) => RunnerTasks;
}

interface DeclaredScript {
  readonly key: string;
  readonly words: readonly string[];
}

/**
 * What nen can see of a task runner's own task list.
 *
 * `kind: "unknown"` is the honest answer for a runner whose config filename nen
 * does not know, and `kind: "absent"` for one whose file is simply not here.
 * Both withhold; neither pretends the package.json scripts are the list.
 */
type RunnerTasks =
  | { readonly kind: "read"; readonly file: string; readonly tasks: ReadonlySet<string> }
  | { readonly kind: "absent"; readonly file: string }
  | { readonly kind: "unknown" };

/**
 * `"packages/*"` -> every directory under `packages/`; a literal path -> itself.
 *
 * ONLY A TRAILING `*` IS EXPANDED, and everything richer is left alone rather
 * than half-understood: a `**` and a mid-segment glob each mean something a
 * partial reader would get wrong. The leading `!` of a NEGATION is stripped by
 * the caller before this is asked, because a negation is the same pattern
 * language pointing the other way -- see `readWorkspace`.
 */
function expandWorkspacePattern(
  laneDirectory: string,
  pattern: string,
): readonly string[] {
  if (!isReadablePattern(pattern)) return [];
  const segments = pattern.split("/");
  if (segments[segments.length - 1] !== "*") return [pattern];
  const parent = segments.slice(0, -1).join("/");
  return listDirectory(join(laneDirectory, ...segments.slice(0, -1)))
    .filter((entry): boolean => entry.directory && !SKIP.has(entry.name))
    .map((entry): string => `${parent}/${entry.name}`);
}

/**
 * Whether nen understands this pattern's SHAPE (the leading `!` already gone).
 *
 * Kept apart from the expansion because "nen cannot read this pattern" and
 * "this pattern matched nothing on disk" are different facts and the note says
 * only the first: an `apps/*` over an empty `apps/` was read perfectly well.
 */
function isReadablePattern(pattern: string): boolean {
  if (pattern === "" || pattern.includes("**")) return false;
  const segments = pattern.split("/");
  if (segments[segments.length - 1] !== "*") return !pattern.includes("*");
  const parent = segments.slice(0, -1).join("/");
  return parent !== "" && !parent.includes("*");
}

/** Whether a resolved member path is a directory that is actually there. */
function memberExists(laneDirectory: string, memberPath: string): boolean {
  const segments = memberPath.split("/");
  const name = segments[segments.length - 1];
  if (name === undefined || name === "") return false;
  return listDirectory(join(laneDirectory, ...segments.slice(0, -1))).some(
    (entry): boolean => entry.directory && entry.name === name,
  );
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
  // THE THREE THINGS THE MEMBER LIST IS FOR: it is printed in a note, it is the
  // question the maintainer is being asked ("which of these, and in what
  // order"), and it is therefore a list that must not name a package this
  // repository does not have or has explicitly excluded.
  //
  //   * NEGATIONS ARE APPLIED AFTER EXPANSION, never skipped as unreadable. A
  //     `!apps/legacy` is not a pattern nen cannot read -- it is the same
  //     pattern language pointing the other way, and dropping it while still
  //     expanding `apps/*` named the one package the repository had just said
  //     to leave out.
  //   * ONLY DIRECTORIES THAT EXIST ARE LISTED. A literal pattern is taken
  //     verbatim, so `vendor/one` used to be reported as a member of a tree
  //     with no `vendor/` at all -- nen reading a file back to the reader as
  //     though it were a fact about the disk.
  //   * A PATTERN NEN COULD NOT EXPAND IS NAMED, not silently dropped, and a
  //     negation among them is the one that matters: it means this list may
  //     still name something the repository excludes.
  const shape = (source: string, patterns: readonly string[]): WorkspaceShape => {
    const expand = (pattern: string): readonly string[] =>
      expandWorkspacePattern(laneDirectory, pattern);
    const negations = patterns.filter((pattern): boolean => pattern.startsWith("!"));
    const excluded = new Set(
      negations.flatMap((pattern): readonly string[] => expand(pattern.slice(1))),
    );
    const seen = new Set<string>();
    const members: string[] = [];
    for (const pattern of patterns) {
      if (pattern.startsWith("!")) continue;
      for (const memberPath of expand(pattern)) {
        if (excluded.has(memberPath) || seen.has(memberPath)) continue;
        if (!memberExists(laneDirectory, memberPath)) continue;
        seen.add(memberPath);
        members.push(memberName(laneDirectory, memberPath));
      }
    }
    return {
      source,
      patterns,
      members,
      unread: patterns.filter(
        (pattern): boolean =>
          !isReadablePattern(pattern.startsWith("!") ? pattern.slice(1) : pattern),
      ),
    };
  };

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
  const scriptWords = Object.entries(scriptRecord)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, command]): DeclaredScript => ({ key, words: command.trim().split(/\s+/) }))
    .filter((script): boolean => script.words.length > 0 && script.words[0] !== "");
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
    declares: (dependency): boolean => carriesDependency(document, dependency),
    scripts,
    scriptWords,
    runnerTasks: (runner): RunnerTasks => readRunnerTasks(laneDirectory, runner),
  };
}

/**
 * The config file a task runner keeps its task list in.
 *
 * A FILENAME, which is the one class of fact this module's header argues it may
 * carry: `turbo.json` means the same thing in every repository on earth, the
 * same way `next.config.mjs` does. What it may NOT carry is what the tasks
 * should be -- those are read out of the repository's own file, or not read at
 * all. A runner absent from this table gets `kind: "unknown"` and the row is
 * withheld saying so, which is the honest answer rather than a silent pass.
 */
const RUNNER_CONFIG: Readonly<Record<string, string>> = { turbo: "turbo.json" };

/**
 * The tasks a runner's own config declares, when nen can read one.
 *
 * BOTH SPELLINGS OF THE SAME STATEMENT are read: `tasks` (turbo 2) and
 * `pipeline` (turbo 1). A file that is present but unreadable answers `read`
 * with an empty set rather than `absent`, because "the file is there and nen
 * could not parse it" must not read as "this repository has no such runner".
 */
function readRunnerTasks(laneDirectory: string, runner: string): RunnerTasks {
  const file = RUNNER_CONFIG[runner];
  if (file === undefined) return { kind: "unknown" };
  if (readText(join(laneDirectory, file)) === null) return { kind: "absent", file };
  const document = readJson(join(laneDirectory, file));
  const block = document?.["tasks"] ?? document?.["pipeline"];
  const tasks =
    typeof block === "object" && block !== null && !Array.isArray(block)
      ? Object.keys(block as Record<string, unknown>)
      : [];
  return { kind: "read", file, tasks: new Set(tasks) };
}

interface ProposedStep {
  readonly exe: string;
  readonly argv: readonly string[];
}

/** The value the manifest answers `{package}` with, or null when it answers none. */
function packageAnswer(manifest: Manifest): string | null {
  return manifest.workspace === null ? manifest.packageName : null;
}

// ── what NEN answers, as opposed to what the manifest answers ───────────────
//
// Two tokens on this path are answered from something other than a
// `package.json`, and they are answered in opposite ways:
//
//   * `{gw}`-SHAPED TOKENS -- the `host-conditional` ones -- are the only
//     tokens nen resolves from the PLATFORM. The value is the pack's own
//     spelling for this host, and nen writes it into the proposal so that the
//     declaration a human ends up with carries a runnable word rather than a
//     token: ./render.ts refuses every pack token by name at spawn time,
//     `{gw}` included, so a declaration still carrying one is exit 2 the first
//     time anybody runs it. RESOLVING IT IS NOT THE SAME AS ASSUMING IT: the
//     spelling names a file in the lane, and nen writes the value only when
//     that file is there. A lane carrying the other host's spelling and not
//     this one's is withheld saying exactly that -- which is the pack's own
//     sentence, "a repo without one is a finding, not an install".
//   * `{unitTestTask}` is a DECLARATION-SUPPLIED token that this lane's own
//     settings file can nonetheless answer, and §2.6 names the cross-check by
//     hand: "a scheme, target or task a marker implies but the project does
//     not contain is a WARNING, never a proposal -- detect cross-checks ... a
//     Gradle settings file's `include`s ... before proposing any verb that
//     names one". NEITHER HALF OF THE ANSWER IS NEN'S: the module comes from
//     the repository's own `include(...)`, and the task is the VERB the row is
//     for. Where the repository names no single library module, the row is
//     withheld with every module it does name.

/** What nen could answer for one lane, and what it tried to and could not. */
interface LaneAnswers {
  /** token -> the value nen wrote. */
  readonly answered: ReadonlyMap<string, string>;
  /** token -> why nen wrote none, ready to append to a withholding note. */
  readonly refused: ReadonlyMap<string, string>;
  /**
   * Every value nen wrote that a step may use as its `exe`.
   *
   * THE EXECUTABLE CHECK IS ABOUT WHAT THE PROJECT VISIBLY CARRIES, and for
   * these values nen has just looked: the file is in the lane. Sending them
   * through the manifest check instead would withhold every row of a stack
   * that has no `package.json` at all, for a reason that is not true of it.
   */
  readonly exes: ReadonlySet<string>;
}

/**
 * The host-conditional tokens, answered from the platform AND from the lane.
 *
 * The reason names the platform, the spelling it implies and what the lane
 * carries instead, because those are the three things a maintainer needs to
 * tell "wrong host" from "no wrapper committed" from "committed under the
 * other name".
 */
function hostAnswers(
  laneDirectory: string,
  platform: string,
  answered: Map<string, string>,
  refused: Map<string, string>,
  exes: Set<string>,
): void {
  const present = new Set(
    listDirectory(laneDirectory)
      .filter((entry): boolean => !entry.directory)
      .map((entry): string => entry.name),
  );
  for (const entry of HOST_TOKENS) {
    const value = spellOnHost(entry.placeholder, platform);
    /* c8 ignore next -- HOST_TOKENS is filtered on the spelling being present */
    if (value === null) continue;
    const wanted = laneRelativeName(value);
    if (present.has(wanted)) {
      answered.set(entry.token, value);
      exes.add(value);
      continue;
    }
    const spelling = entry.placeholder.hostSpelling;
    /* c8 ignore next -- same filter */
    if (spelling === undefined) continue;
    const others = [spelling.posix, spelling.win32]
      .map(laneRelativeName)
      .filter((name): boolean => name !== wanted && present.has(name));
    refused.set(
      entry.token,
      ` -- nen resolves ${entry.token} from the HOST and this host is ${platform}, whose spelling is '${value}'; this lane has no '${wanted}'${
        others.length === 0
          ? ""
          : `, though it does carry '${others.join("', '")}' -- the other host's spelling, which nen will not run here`
      }. A lane without its own wrapper is a FINDING, never an install: nen proposes no row it cannot see the tool for, and installs nothing`,
    );
  }
}

/** `include(":app", ":KroCore")` -> `:app`, `:KroCore`, in declared order. */
const INCLUDE_CALL = /\binclude(?![A-Za-z0-9_])\s*(\([^)]*\)|[^\n]*)/g;
const QUOTED = /["']([^"'\n]+)["']/g;

/**
 * The modules a settings file includes, normalised to a leading `:`.
 *
 * BOTH SPELLINGS OF THE ONE STATEMENT are read -- the parenthesised call and
 * the bare argument list -- because the two script languages a settings file is
 * written in differ there and nowhere that matters here. `includeBuild` and
 * `includeFlat` are deliberately NOT read: the first names a whole separate
 * build (a submodule, in the observed repository) and the second a directory
 * outside the tree, and neither is a module whose tasks this lane runs.
 */
function includedModules(text: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // BOTH COMMENT FORMS, through the one stripper -- a `/* include(":retired")
  // *\/` is not an include, and reading it as one proposed a module the build
  // has not had since somebody commented it out.
  const source = stripScriptComments(text);
  for (const call of source.matchAll(INCLUDE_CALL)) {
    for (const quoted of (call[1] ?? "").matchAll(QUOTED)) {
      const raw = (quoted[1] ?? "").trim();
      if (raw === "") continue;
      const module = raw.startsWith(":") ? raw : `:${raw}`;
      if (seen.has(module)) continue;
      seen.add(module);
      out.push(module);
    }
  }
  return out;
}

/**
 * `project(":shared").projectDir = file("../shared")` -> `:shared` -> `../shared`.
 *
 * A MODULE'S NAME IS NOT ITS PATH once a settings file says otherwise, and
 * every reading of that name as a directory was wrong for a remapped one --
 * silently, because the directory the name implies simply is not there. Both
 * script languages spell the statement the same way up to the assignment; the
 * PATH is the last quoted string on the right-hand side, which reads
 * `file("../shared")` and `new File(rootDir, "../shared")` alike.
 */
const PROJECT_DIR =
  /\bproject\s*\(\s*["']([^"'\n]+)["']\s*\)\s*\.\s*projectDir\s*=\s*([^\n]*)/g;

/** Every remap a settings file states, module -> the path it names, in order. */
function projectDirectories(text: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const statement of stripScriptComments(text).matchAll(PROJECT_DIR)) {
    const raw = (statement[1] ?? "").trim();
    if (raw === "") continue;
    const module = raw.startsWith(":") ? raw : `:${raw}`;
    const quoted = [...(statement[2] ?? "").matchAll(QUOTED)];
    const path = quoted[quoted.length - 1]?.[1];
    if (path === undefined || path === "") continue;
    out.set(module, path);
  }
  return out;
}

/**
 * What nen could establish about one included module, and it is THREE-VALUED.
 *
 * THE TWO-VALUED VERSION WAS THE BLOCKER. It asked "does this module's build
 * file carry the plugin literal?" and read `false` as "library" -- collapsing
 * "nen looked and this module applies something else" together with "nen could
 * not tell". The second is the common case in a modern Android build: a module
 * applying the plugin through a CONVENTION PLUGIN (`id("myapp.android.
 * application")`) or a VERSION CATALOGUE ALIAS (`alias(libs.plugins.
 * androidApplication)`) never spells the plugin's own id anywhere in its file.
 * Read as a library, the application module became the one candidate the
 * settings file "named", and `{unitTestTask}` was answered `:app:test` -- the
 * aggregate the pack's own `why` exists to forbid, written into a declaration
 * with that `why` sitting beside it.
 *
 * SO THE CLASSIFICATION PROVES ONE DIRECTION AND WITHHOLDS ON THE OTHER:
 *
 *   * `application` -- the module's own build file carries the refinement
 *     literal. Provable, and proved.
 *   * `library` -- nen read the file, every plugin application in it is a
 *     literal id it can compare, none of them is the refinement, and none of
 *     them ends in the refinement's own last dotted segment (which is how a
 *     convention plugin wrapping it is spelled).
 *   * `unknown` -- everything else: no directory, no build file, an unreadable
 *     one, a file that applies no plugin nen can see, an `alias(...)` or a
 *     dynamic `apply(...)`, or a look-alike id. nen names the module and says
 *     which, and answers nothing.
 */
type ModuleClass = "application" | "library" | "unknown";

interface ModuleFinding {
  readonly module: string;
  readonly kind: ModuleClass;
  /** Why nen could not classify it, for the note. Empty unless `unknown`. */
  readonly why: string;
}

/** A plugin application spelled as a literal id: `id("x")`, `apply plugin: "x"`. */
const PLUGIN_ID = /\b(?:id|kotlin)\s*[(\s]\s*["']([^"'\n]+)["']|\bplugin\s*[:=]\s*["']([^"'\n]+)["']/g;
/** A plugin application whose id nen cannot resolve from this file alone. */
const OPAQUE_PLUGIN = /\balias\s*\(|\bapply\s*\(|\bapply\s+from\s*:|\bid\s*\(\s*[^"'\s)]/;

/** The last dotted segment of a plugin id: `com.android.application` -> `application`. */
function lastSegment(literal: string): string {
  return literal.split(".").pop() ?? literal;
}

/**
 * A `projectDir` value that is ROOTED SOMEWHERE OF ITS OWN, decided by SHAPE.
 *
 * `path.isAbsolute` is the wrong question here and it was the hole: it answers
 * for the host NEN IS RUNNING ON, and the host that WROTE the settings file is
 * a different one. On a POSIX host `isAbsolute("C:\\shared")` is `false`, so
 * `join(lane, "C:\\shared")` produced `<lane>/C:\shared` -- a path the escape
 * check below then certified as INSIDE the repository, for a statement that
 * says the module lives on another drive entirely. `/srv/shared` was worse
 * still: `join` swallows the leading separator, so an ABSOLUTE remap became
 * `<lane>/srv/shared`, and nen read whatever happened to be there.
 *
 * So the three shapes are read off the text directly, and all three are read on
 * EVERY host, because the value is the settings file's word and not this host's:
 *
 *   * `/srv/shared`     -- a POSIX absolute path (and the `//server/share` UNC form)
 *   * `C:\shared`       -- a Windows drive letter, rooted or drive-relative (`C:shared`)
 *   * `\\server\share`  -- a UNC path (and `\shared`, rooted on the current drive)
 *
 * A rooted value NEVER resolves inside the tree nen was pointed at, so it is an
 * escape before any join happens rather than after one that hid it.
 */
const ROOTED_PATH = /^(?:\/|[A-Za-z]:|\\)/;

/**
 * A `projectDir` value nen cannot resolve to a directory AT ALL.
 *
 * `file("$rootDir/shared")`, `file("${rootDir}/shared")` and `file("~/shared")`
 * name a Gradle property and a shell home directory -- values whose meaning
 * lives outside the text nen is reading. Resolving one would be nen GUESSING
 * where a module is and then reading the guess, which is rule 1 of this file's
 * header wearing a filesystem hat.
 */
const UNRESOLVED_REFERENCE = /[$]|^~/;

/**
 * The segments of a remap, over BOTH separators.
 *
 * A settings file written on Windows spells `file("..\\shared")`, and splitting
 * that on `/` alone produced the single segment `..\shared` -- a directory name
 * with a backslash in it, which is not what the file says and which the escape
 * check could not see the `..` inside.
 */
function pathSegments(value: string): readonly string[] {
  return value.split(/[/\\]+/).filter((segment): boolean => segment !== "" && segment !== ".");
}

/**
 * THE ONE TEST FOR "does this leave the repository", over a resolved path.
 *
 * The `..` reading alone is not enough on win32: two paths on DIFFERENT DRIVES
 * have no relative spelling, so `relative` hands back an absolute path instead
 * of a `..` -- which the first conjunct reads as inside. The shape test is the
 * same one the raw value goes through, which is the point: one predicate, two
 * inputs, rather than two predicates that can drift apart.
 */
function leavesRepository(repoRoot: string, directory: string): boolean {
  const within = relative(repoRoot, directory);
  return within.split(sep)[0] === ".." || ROOTED_PATH.test(within);
}

/** Where a module's directory is -- or why nen will not go looking for it. */
type ModuleLocation =
  | { readonly kind: "inside"; readonly directory: string }
  | { readonly kind: "withheld"; readonly why: string };

/**
 * Where a module's directory is, honouring a `projectDir` remap -- or refusing.
 *
 * BOTH READERS OF A MODULE'S PATH COME THROUGH HERE (`classifyModule` and
 * `laneScope`), so the containment rule is stated once. A remap that leaves the
 * repository -- by shape, by `..`, or by naming something nen cannot resolve --
 * yields no directory at all rather than one its caller is trusted to re-check.
 */
function moduleDirectory(
  repoRoot: string,
  laneDirectory: string,
  module: string,
  remaps: ReadonlyMap<string, string>,
): ModuleLocation {
  const remapped = remaps.get(module);
  const outside = (): ModuleLocation => ({
    kind: "withheld",
    why:
      remapped === undefined
        ? "its name resolves to a directory outside this repository -- nen reads only the tree it was given"
        : `its projectDir is remapped to '${remapped}', which resolves outside this repository -- nen reads only the tree it was given`,
  });
  // SHAPE FIRST, BEFORE ANY JOIN, because the join is what hid it.
  if (remapped !== undefined && ROOTED_PATH.test(remapped)) return outside();
  if (remapped !== undefined && UNRESOLVED_REFERENCE.test(remapped)) {
    return {
      kind: "withheld",
      why: `its projectDir is remapped to '${remapped}', which names a property or a home directory rather than a path nen can resolve -- nen resolves neither, and it reads nothing on a guess about where a module is`,
    };
  }
  const directory = join(
    laneDirectory,
    ...(remapped === undefined
      ? module.split(":").filter((segment): boolean => segment !== "")
      : pathSegments(remapped)),
  );
  if (leavesRepository(repoRoot, directory)) return outside();
  return { kind: "inside", directory };
}

function classifyModule(
  repoRoot: string,
  laneDirectory: string,
  module: string,
  remaps: ReadonlyMap<string, string>,
  refinements: readonly Refinement[],
): ModuleFinding {
  const unknown = (why: string): ModuleFinding => ({ module, kind: "unknown", why });
  // A REMAP THAT ESCAPES THE REPOSITORY IS NOT A CANDIDATE. nen reads only the
  // tree it was pointed at -- every other path in this family is resolved
  // against the repository root and one that leaves it is refused by name --
  // so a module living outside it is one nen cannot see, let alone classify.
  // The judgement is `moduleDirectory`'s, over the raw value AND the resolved
  // path; this seam only reports it.
  const location = moduleDirectory(repoRoot, laneDirectory, module, remaps);
  if (location.kind === "withheld") return unknown(location.why);
  const directory = location.directory;
  const remapped = remaps.get(module);
  const buildFiles = new Set(refinements.flatMap((entry): readonly string[] => [...entry.files]));
  const present = listDirectory(directory).filter(
    (entry): boolean => !entry.directory && buildFiles.has(entry.name),
  );
  const build = present[0];
  if (build === undefined) {
    return unknown(
      remapped === undefined
        ? `there is no ${[...buildFiles].sort(compareBytes).join(" or ")} at '${module.slice(1).split(":").join("/")}' for nen to read`
        : `its projectDir is remapped to '${remapped}', where there is no ${[...buildFiles].sort(compareBytes).join(" or ")} for nen to read`,
    );
  }
  const text = readScript(join(directory, build.name));
  /* c8 ignore next -- `listDirectory` just named the file; an unreadable one is a race */
  if (text === null) return unknown(`nen could not read its ${build.name}`);
  const refinement = refinements.find((entry): boolean => text.includes(entry.literal));
  if (refinement !== undefined) return { module, kind: "application", why: "" };
  if (OPAQUE_PLUGIN.test(text)) {
    return unknown(
      `its ${build.name} applies a plugin nen cannot resolve to an id from this file alone -- an alias(...) reads its id out of a version catalogue, and an apply(...) can name one at runtime, so the plugin that identifies this lane may be arriving through it`,
    );
  }
  const ids = [...text.matchAll(PLUGIN_ID)].map(
    (match): string => match[1] ?? match[2] ?? "",
  );
  if (ids.length === 0) {
    return unknown(
      `its ${build.name} applies no plugin nen can see, so nen cannot tell whether this module is an application module or a library one`,
    );
  }
  const tails = new Set(refinements.map((entry): string => lastSegment(entry.literal)));
  const lookAlike = ids.find((id): boolean => tails.has(lastSegment(id)));
  if (lookAlike !== undefined) {
    return unknown(
      `its ${build.name} applies '${lookAlike}', which ends in the same word as the plugin that identifies this lane -- that is how a CONVENTION PLUGIN wrapping it is spelled, and nen cannot see what it applies`,
    );
  }
  return { module, kind: "library", why: "" };
}

/**
 * `{unitTestTask}`, answered from this lane's own settings file or withheld
 * with every module that file names.
 *
 * ONE LIBRARY MODULE OR NOTHING. A module whose own build file applies the
 * plugin that identified this lane is the APPLICATION module -- the row it
 * would name is the one the pack's `why` exists to forbid -- so it is removed
 * from the candidates rather than being one of them. What is left is either
 * exactly one module, which the repository has effectively named, or a choice,
 * and nen resolves no choice: rule 1 of this file's header.
 */
function unitTestAnswers(
  repoRoot: string,
  laneDirectory: string,
  stack: HostToolStack | undefined,
  verb: string,
  answered: Map<string, string>,
  refused: Map<string, string>,
): void {
  if (stack === undefined) return;
  const names = [...stack.contextFiles].sort(compareBytes);
  const settings = listDirectory(laneDirectory).find(
    (entry): boolean => !entry.directory && anySpellingMatches(stack.contextFiles, entry.name),
  );
  /* c8 ignore next 8 -- `matchesIn` requires a context file before the stack
     matches at all, so a lane reaching this function has one. The branch stays
     because the requirement and this reader are two places, and a lane whose
     settings file vanished between them must refuse rather than throw. */
  if (settings === undefined) {
    refused.set(
      UNIT_TEST_TASK,
      ` -- nen answers this token only from this lane's own settings file, and there is none here to read (nen looks for ${names.join(", ")}). The module a repository runs its JVM unit tests in is that repository's word, and the settings file is where it says it`,
    );
    return;
  }
  const file = join(laneDirectory, settings.name);
  const text = readText(file) ?? "";
  const modules = includedModules(text);
  const remaps = projectDirectories(text);
  const findings = modules.map(
    (module): ModuleFinding =>
      classifyModule(repoRoot, laneDirectory, module, remaps, stack.refinements),
  );
  const of = (kind: ModuleClass): readonly ModuleFinding[] =>
    findings.filter((finding): boolean => finding.kind === kind);
  const unknown = of("unknown");
  const libraries = of("library");

  // A MODULE NEN COULD NOT CLASSIFY ENDS THE ROW, and it ends it even when a
  // single library module is standing right beside it. Both ways of arriving
  // here are the same mistake seen from two sides: an unclassifiable module may
  // BE the JVM one this row wants, and it may equally be an application module
  // wearing a convention plugin -- so treating it as neither and answering from
  // what is left is nen choosing, which is rule 1 of this file's header. §2.6
  // is the other half: a task the project does not contain is a warning and
  // never a proposal, and `:ghost:test` for an `include(":ghost")` with no
  // directory is exactly that task.
  if (unknown.length > 0) {
    refused.set(
      UNIT_TEST_TASK,
      ` -- ${settings.name} includes ${modules.join(", ")}, and nen could not classify ${unknown
        .map((finding): string => `${finding.module} (${finding.why})`)
        .join("; ")}. A module nen cannot classify may be the JVM one this row wants or an application module applying the plugin indirectly, and nen answers no row it would have to choose for`,
    );
    return;
  }

  const only = libraries.length === 1 ? libraries[0]?.module : undefined;
  if (only !== undefined) {
    // The MODULE is the repository's word and the TASK is the caller's: the
    // token sits in this verb's row, so the task nen names is that module's
    // task of this verb's own name. nen contributes neither half.
    answered.set(UNIT_TEST_TASK, `${only}:${verb}`);
    return;
  }
  refused.set(
    UNIT_TEST_TASK,
    ` -- ${settings.name} ${
      modules.length === 0
        ? "declares no `include(...)` nen could read, so it names no module for this row"
        : `includes ${modules.join(", ")}, of which ${
            libraries.length === 0
              ? "every one applies the plugin that identified this lane -- they are application modules, and the row this token fills is the JVM unit-test one"
              : `${libraries.length} are library modules (${libraries
                  .map((finding): string => finding.module)
                  .join(", ")}), and which of them carries this repository's JVM unit tests is a choice only it can make`
          }`
    }. nen answers this token only where the settings file names a single library module`,
  );
}

/** Everything nen itself can answer for one lane, computed once per verb. */
function laneAnswers(
  repoRoot: string,
  laneDirectory: string,
  platform: string,
  stack: HostToolStack | undefined,
  verb: string,
  wanted: ReadonlySet<string>,
): LaneAnswers {
  const answered = new Map<string, string>();
  const refused = new Map<string, string>();
  const exes = new Set<string>();
  if (HOST_TOKENS.some((entry): boolean => wanted.has(entry.token))) {
    hostAnswers(laneDirectory, platform, answered, refused, exes);
  }
  if (wanted.has(UNIT_TEST_TASK)) {
    unitTestAnswers(repoRoot, laneDirectory, stack, verb, answered, refused);
  }
  return { answered, refused, exes };
}

/**
 * WHOSE TASKS THE PACK'S ROWS NAME: this lane's build, or a module of it.
 *
 * A marker pattern with a directory prefix says the carrier is a MODULE and the
 * rows are the BUILD's own root tasks -- `{gw} assembleDebug` is what the
 * observed repository runs, from the root, with the application module one
 * level down. A pattern with NO prefix says the carrier IS this lane's own
 * build file; when nen instead found it in a subdirectory, that subdirectory is
 * the build the pack's rows describe, and running them at the lane root runs
 * the wrong project. So the module's own path prefixes each task, which is the
 * spelling Gradle itself uses and the one the observed lane's IDE run
 * configuration would carry if the build were nested that way.
 *
 * AND WHERE NEN CANNOT ADDRESS IT AT ALL, EVERY ROW GOES. A carrier in a
 * subdirectory the lane's settings file does not include is a build this lane's
 * tool cannot reach: not a module of it, and not a build of its own (a build of
 * its own would have stopped the search). Proposing the root's tasks for it
 * would be the exact defect this whole seam exists to remove.
 */
type LaneScope =
  | { readonly kind: "root" }
  | { readonly kind: "module"; readonly module: string }
  | { readonly kind: "unaddressable"; readonly why: string };

function laneScope(
  repoRoot: string,
  laneDirectory: string,
  stack: HostToolStack | undefined,
): LaneScope {
  if (stack === undefined) return { kind: "root" };
  const sink = new Set<string>();
  for (const refinement of stack.refinements) {
    if (refinement.nested) continue;
    const carrier = fileCarrying(
      laneDirectory,
      refinement,
      REFINEMENT_DEPTH,
      stack.contextFiles,
      true,
      sink,
    );
    if (carrier === null) continue;
    const within = relativePath(laneDirectory, dirname(carrier));
    if (within === ".") continue;
    const module = `:${within.split("/").join(":")}`;
    const settings = listDirectory(laneDirectory).find(
      (entry): boolean =>
        !entry.directory && anySpellingMatches(stack.contextFiles, entry.name),
    );
    const text = settings === undefined ? "" : (readText(join(laneDirectory, settings.name)) ?? "");
    const remaps = projectDirectories(text);
    // A module whose remap leaves the repository is NOT a name for this carrier
    // either: `moduleDirectory` yields no directory for it, so it cannot match.
    const declared = includedModules(text).find((candidate): boolean => {
      const location = moduleDirectory(repoRoot, laneDirectory, candidate, remaps);
      return location.kind === "inside" && relativePath(laneDirectory, location.directory) === within;
    });
    if (declared === undefined) {
      return {
        kind: "unaddressable",
        why: `this stack's marker was found at ${relativePath(repoRoot, carrier)}, one directory below the lane, and ${
          settings === undefined ? "this lane has no settings file" : `this lane's ${settings.name}`
        } includes no module there. That build is neither a module this lane's tool can address ('${module}:<task>') nor a build of its own -- a build of its own carries its own wrapper or settings file, and the scan stops at one. nen proposes no row it cannot address`,
      };
    }
    return { kind: "module", module: declared };
  }
  return { kind: "root" };
}

/**
 * A bare task word, as opposed to a flag, a path, or an already-qualified task.
 *
 * Deliberately narrow: only a word nen is SURE is a task name gets a module
 * prefix. A `--stacktrace` is a flag, a `:app:lintDebug` already says which
 * project it means, and anything carrying a `/` or a `.` is a path or a
 * property rather than a task. Everything else is left exactly as the pack
 * wrote it.
 */
function isBareTask(word: string): boolean {
  return (
    word !== "" &&
    !word.startsWith("-") &&
    !word.includes(":") &&
    !word.includes("/") &&
    !word.includes(".") &&
    // A word still carrying a token is not yet a task name; the row it is in is
    // about to be withheld for that reason, and prefixing it would only make
    // the token harder to read back in the note.
    !word.includes("{")
  );
}

function substitute(
  token: string,
  manifest: Manifest,
  answers: LaneAnswers,
  layer: TokenLayer,
): string {
  const pm = manifest.packageManager;
  const packageName = packageAnswer(manifest);
  let out = token;
  if (pm !== null) {
    out = out.split(PM_EXECUTABLE).join(pm.executable).split(PM_PIN).join(pm.pin);
  }
  if (packageName !== null) out = out.split(PACKAGE_NAME).join(packageName);
  for (const [answeredToken, value] of answers.answered) {
    out = out.split(answeredToken).join(value);
  }
  // THE PROJECT READER'S ANSWERS, from the same repository and under the same
  // rule: the pack states which file answers the token, and the VALUE is this
  // tree's own path. A stack that states no `answers` rule contributes nothing
  // here, which is every stack but one today.
  for (const [answered, value] of layer.answers) out = out.split(answered).join(value);
  return out;
}

/** Words a name is made of: separators and camel humps, lowercased, 3+ letters. */
function wordsOf(text: string): readonly string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word): boolean => word.length >= 3);
}

/** What `scriptAnswers` found: the answers it stands behind, and the near misses. */
interface ScriptMatch {
  /** Every distinct CORROBORATED answer, in declared order. */
  readonly answers: readonly ReadonlyMap<string, string>[];
  /**
   * `'<key>': <command>` for every script that agreed by ARITY and was not
   * corroborated. Named in the note, because "no script answers this" and "a
   * script has the same shape and nothing backs it up" are different facts, and
   * the second is the one a maintainer can act on in one edit.
   */
  readonly nearMisses: readonly string[];
}

/**
 * Every answer this manifest's own `scripts` block gives one step -- ARITY PLUS
 * CORROBORATION, and the second half is the whole of this function's argument.
 *
 * A CANDIDATE is a script whose command has the same word count and agrees with
 * the step at every position except the ones where the pack wrote a whole token;
 * those positions are the answer. For a step that spells most of itself out that
 * is a strong match: `{pm} turbo run build` states three words and asks for one,
 * so a script agreeing with it has agreed about `turbo`, `run` and `build`.
 *
 * FOR A THIN STEP IT IS NOT A MATCH AT ALL, and this was a real defect rather
 * than a hypothetical one. `node {archiveScript}` states ONE word and asks for
 * one, so EVERY one-argument `node` script in the manifest agrees with it:
 * against `scripts: { "start": "node server.js" }` the pack's PDF-archive row
 * was answered `node server.js`, carrying the catalogue's own `why` about
 * producing a PDF. Arity cannot tell that apart from the real thing.
 *
 * So a candidate must also be CORROBORATED, by one of two routes, and both take
 * their evidence from THE REPOSITORY -- the pack contributes the shape and never
 * a value, which is the property the whole family rests on:
 *
 *   1. THE STEP'S OWN SHAPE. Its literal words OUTNUMBER its token positions,
 *      and there are at least two of them. The step has then said more about
 *      itself than nen is asking for, and the agreement is about content.
 *   2. THE SCRIPT'S KEY NAMES THE INTENT. A word of the script's own key (split
 *      on `:`, `-`, `_`, `.` and camel humps, three letters or more) appears in
 *      the step's vocabulary: the VERB being proposed, the words of a token the
 *      step still carries, or the words of the value that script would answer
 *      with. The last is the one that carries the real case --
 *      `"resume:pdf": "node scripts/build-resume-pdf.mjs"` corroborates itself,
 *      because this repository named the script after the file it runs, while
 *      `"start": "node server.js"` says nothing that ties it to an archive.
 *
 * THE 1:1 SHAPE IS THE BOUNDARY, AND IT IS DELIBERATE. `node {archiveScript}`
 * has one literal word and one token, so route 1 never saves it and route 2
 * always decides it. A step with two literals and two tokens sits in the same
 * place for the same reason: nen would be guessing as much as the repository
 * stated.
 *
 * AND CORROBORATION IS PART OF BEING A CANDIDATE -- applied BEFORE the ambiguity
 * test, not after it. That is the one place this could read as resolving an
 * ambiguity and does not: a script nothing corroborates was never a competing
 * answer, it was a collision of word counts. Two CORROBORATED candidates that
 * disagree are still an ambiguity and are still withheld; rule 1 of this file's
 * header is not suspended because both arrived from one file.
 */
function scriptAnswers(step: ProposedStep, manifest: Manifest, verb: string): ScriptMatch {
  const words = [step.exe, ...step.argv];
  const tokenPositions = words.filter((word): boolean => PACK_TOKEN_SET.has(word)).length;
  const literals = words.length - tokenPositions;
  const shapeCorroborates = literals >= 2 && literals > tokenPositions;
  const vocabulary = new Set([
    ...wordsOf(verb),
    ...words.flatMap((word): readonly string[] => (PACK_TOKEN_SET.has(word) ? wordsOf(word) : [])),
  ]);

  const found = new Map<string, ReadonlyMap<string, string>>();
  const nearMisses: string[] = [];
  for (const script of manifest.scriptWords) {
    const parts = script.words;
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
    if (!shapeCorroborates && !keyCorroborates(script.key, answer, vocabulary)) {
      nearMisses.push(`'${script.key}': ${parts.join(" ")}`);
      continue;
    }
    // TWO SCRIPTS GIVING THE SAME ANSWER ARE ONE ANSWER, not an ambiguity, so
    // the map is keyed by the answer itself rather than by the script. The
    // separator is the unit separator because it cannot appear in a shell word:
    // a printable one would let `{a} = "x y"` and `{a} = "x", {b} = "y"` collide
    // into one key and hide a real disagreement.
    const key = [...answer.entries()]
      .sort(([a], [b]): number => compareBytes(a, b))
      .map(([token, value]): string => `${token}\u001f${value}`)
      .join("\u001f");
    if (!found.has(key)) found.set(key, answer);
  }
  return { answers: [...found.values()], nearMisses };
}

/**
 * Route 2: a word of the script's KEY appears in the step's own vocabulary.
 *
 * The answer's own words are part of that vocabulary, which is what makes
 * `resume:pdf` -> `scripts/build-resume-pdf.mjs` corroboration rather than
 * coincidence: the repository stated the same word twice, in the name and in
 * the path, and nen is reading its agreement with itself.
 */
function keyCorroborates(
  key: string,
  answer: ReadonlyMap<string, string>,
  vocabulary: ReadonlySet<string>,
): boolean {
  const wanted = new Set([
    ...vocabulary,
    ...[...answer.values()].flatMap((value): readonly string[] => wordsOf(value)),
  ]);
  return wordsOf(key).some((word): boolean => wanted.has(word));
}

/** Whether the manifest declares this step, word for word, as one of its scripts. */
function runsVerbatim(step: ProposedStep, manifest: Manifest): boolean {
  const words = [step.exe, ...step.argv];
  return manifest.scriptWords.some(
    (script): boolean =>
      script.words.length === words.length &&
      script.words.every((part, index): boolean => part === words[index]),
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

// ── what a withheld row can still SHOW a maintainer ─────────────────────────
//
// Nothing below this line ever proposes anything. Every function here runs only
// after a row has ALREADY been withheld, and its whole output is text in that
// row's note. The distinction matters more here than anywhere else in the file,
// because both readers are deliberately WIDER than the ones that answer a
// token: they read a word that merely CONTAINS a token, and they read files
// (`.xcscheme`, `project.pbxproj`) that no substitution consults. Reading a
// half-understood shape into a PROPOSAL is how a command acquires an argument
// nobody wrote -- `scriptAnswers` refuses exactly that, one screen up, and this
// section does not weaken it. Reading it into a REASON is the opposite: it is
// the difference between "nen cannot answer {platform}" and "nen cannot answer
// {platform}, and here are the two values your own scripts spell in that
// position".

/** A word that EMBEDS a pack token rather than being one, with its literal halves. */
interface EmbeddedToken {
  readonly token: string;
  readonly index: number;
  readonly prefix: string;
  readonly suffix: string;
}

/**
 * Every position of a step whose word wraps a token in literal text.
 *
 * `run:{platform}` and `id={simUdid}` are the two shapes in the pack, and both
 * are invisible to every other reader in this file: `PACK_TOKEN_SET.has(word)`
 * is false for each, so `scriptAnswers` skips the position and the row is
 * withheld naming a token with nothing else said about it.
 */
function embeddedTokens(step: ProposedStep): readonly EmbeddedToken[] {
  const words = [step.exe, ...step.argv];
  const found: EmbeddedToken[] = [];
  words.forEach((word, index): void => {
    if (PACK_TOKEN_SET.has(word)) return;
    for (const token of PACK_TOKENS) {
      const at = word.indexOf(token);
      if (at === -1) continue;
      found.push({
        token,
        index,
        prefix: word.slice(0, at),
        suffix: word.slice(at + token.length),
      });
    }
  });
  return found;
}

/** One value a declared script spells where the pack wrote an embedded token. */
interface EmbeddedValue {
  readonly value: string;
  readonly key: string;
  readonly command: string;
}

/**
 * The values this lane's own scripts spell in an embedded token's position.
 *
 * THE MATCH IS THE STRICTEST ONE THAT CAN SEE ANYTHING: same word count, every
 * other position either identical or a whole token the pack wrote, and at the
 * embedded position a word that opens with the pack's literal prefix, closes
 * with its literal suffix, and has something of its own in between. Against
 * `expo run:{platform}` a `"web": "expo start --web"` disagrees on arity, a
 * `"lint": "expo lint"` disagrees on the prefix, and `"ios": "expo run:ios"`
 * and `"android": "expo run:android"` each contribute one value.
 *
 * TWO VALUES ARE NOT AN AMBIGUITY TO RESOLVE, because there is nothing here to
 * resolve: the row stays withheld either way. They are two facts to REPORT, and
 * reporting both is the point -- neither native lane is the other's default,
 * which is precisely why the pack templated the position instead of picking.
 */
function embeddedValues(
  step: ProposedStep,
  embedded: EmbeddedToken,
  manifest: Manifest,
): readonly EmbeddedValue[] {
  const words = [step.exe, ...step.argv];
  const seen = new Set<string>();
  const values: EmbeddedValue[] = [];
  for (const script of manifest.scriptWords) {
    if (script.words.length !== words.length) continue;
    let usable = true;
    for (let index = 0; index < words.length; index += 1) {
      if (index === embedded.index) continue;
      const word = words[index] ?? "";
      const part = script.words[index] ?? "";
      if (word === part || PACK_TOKEN_SET.has(word)) continue;
      usable = false;
      break;
    }
    if (!usable) continue;
    const spelled = script.words[embedded.index] ?? "";
    if (!spelled.startsWith(embedded.prefix) || !spelled.endsWith(embedded.suffix)) continue;
    const value = spelled.slice(
      embedded.prefix.length,
      spelled.length - embedded.suffix.length,
    );
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    values.push({ value, key: script.key, command: script.words.join(" ") });
  }
  return [...values].sort((a, b): number => compareBytes(a.value, b.value));
}

/** One shared scheme, and the targets its two actions name. */
interface SchemeFinding {
  readonly name: string;
  /** Lane-relative, forward-slashed, so the note points at a file. */
  readonly file: string;
  readonly buildTargets: readonly string[];
  readonly testTargets: readonly TestTarget[];
}

/** A scheme's test entry: the target it names, and the product that target builds. */
interface TestTarget {
  readonly blueprint: string;
  readonly buildable: string;
  /**
   * The reference carries `skipped = "YES"`.
   *
   * KEPT, NOT DROPPED. A skipped testable is excluded from a plain run of the
   * scheme and still NAMES a target that has to exist for the reference to
   * resolve, so the cross-check applies to it exactly as it does to the rest.
   * The note says which kind it found, because "the target is missing AND the
   * scheme skips it" is a different job of work from "the target is missing".
   */
  readonly skipped: boolean;
}

/**
 * What an Apple lane's own files say about itself.
 *
 * READ ONLY TO EXPLAIN A WITHHOLDING. Nothing here is ever substituted into a
 * row: a scheme name is a fact about the repository, but WHICH scheme a verb
 * means is a decision, and a lane with two shared schemes has not made it. So
 * the reader collects and the note reports.
 */
interface AppleLane {
  /** `.xcworkspace` bundles at the lane root, byte-ordered. */
  readonly workspaces: readonly string[];
  /** `.xcodeproj` bundles at the lane root, byte-ordered. */
  readonly projects: readonly string[];
  readonly schemes: readonly SchemeFinding[];
  /**
   * Every native target name declared across EVERY project in the lane, or
   * `null` when nen could not read even one of them.
   *
   * `null` is a different fact from "the list is empty" and must never be
   * reported as one -- a cross-check nen could not perform is not a cross-check
   * that passed, and it is not one that failed either.
   *
   * ALL OR NOTHING, AND THAT IS THE POINT. An earlier draft merged whatever
   * projects happened to parse and left the rest out, which made a PARTIAL
   * target list indistinguishable from a complete one: a lane holding a
   * readable `A.xcodeproj` beside an unparsable `B.xcodeproj` reported every
   * scheme whose test target lives in B as BROKEN ON A CLEAN CHECKOUT, on the
   * strength of a list that never asked B a thing. One unreadable project
   * withholds the whole cross-check, and `unreadableProjects` says which.
   */
  readonly targets: ReadonlySet<string> | null;
  /**
   * The `.xcodeproj` bundles whose target list nen could not read, byte-ordered
   * (a filtered view of `projects`, which is already in that order).
   *
   * Non-empty exactly when `targets` is `null` and the lane has a project at
   * all, and the note names these rather than every project in the lane: a
   * maintainer sent to check three files when one is unreadable is a maintainer
   * sent to the wrong two.
   */
  readonly unreadableProjects: readonly string[];
}

const BLUEPRINT_NAME = /BlueprintName\s*=\s*"([^"]*)"/g;
const TEST_ACTION = /<TestAction\b[\s\S]*?<\/TestAction>/;
const BUILD_ACTION = /<BuildAction\b[\s\S]*?<\/BuildAction>/;
/**
 * The OPENING TAG of an element, attributes captured whole.
 *
 * `(?:[^>"]|"[^"]*")*` walks to the first `>` that is not inside a quoted
 * value, which is what makes the two readers below element-scoped rather than
 * text-scoped: an attribute is read out of the tag it was written in, and never
 * out of the tag after it.
 */
const TESTABLE_OPEN = /<TestableReference\b((?:[^>"]|"[^"]*")*)>/g;
const BUILDABLE_OPEN = /<BuildableReference\b((?:[^>"]|"[^"]*")*)>/;
const TESTABLE_CLOSE = "</TestableReference>";
/**
 * One attribute, read out of ONE tag's captured attribute text.
 *
 * Each is matched independently and none of them assumes a position, because
 * Xcode's own writer does not fix one: `BuildableName` precedes `BlueprintName`
 * in a scheme it wrote today and a hand-edited file may spell either first.
 */
const BLUEPRINT_ATTRIBUTE = /\bBlueprintName\s*=\s*"([^"]*)"/;
const BUILDABLE_ATTRIBUTE = /\bBuildableName\s*=\s*"([^"]*)"/;
const SKIPPED_ATTRIBUTE = /\bskipped\s*=\s*"([^"]*)"/;
/** The section an `.xcodeproj` lists its native targets in, by its own delimiters. */
const NATIVE_TARGETS =
  /\/\* Begin PBXNativeTarget section \*\/([\s\S]*?)\/\* End PBXNativeTarget section \*\//;
/** `name = Foo;` or `name = "Foo Bar";` -- the two spellings a project file uses. */
const TARGET_NAME = /\bname\s*=\s*(?:"([^"]*)"|([A-Za-z0-9_.+-]+))\s*;/g;

function attributesIn(text: string, pattern: RegExp): readonly string[] {
  const out: string[] = [];
  for (const match of text.matchAll(new RegExp(pattern.source, "g"))) {
    const value = match[1];
    if (value !== undefined && value !== "" && !out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * The test targets a `<TestAction>` names, each paired with the product ITS OWN
 * reference builds.
 *
 * ONE `<TestableReference>` IS ONE UNIT, and that is the whole of this reader.
 * The draft it replaces swept the test action for every `BlueprintName` and
 * every `BuildableName`, de-duplicated each list on its own, and paired the two
 * BY INDEX -- a pairing that holds only when the lists come out the same length
 * in the same order, which real schemes break three ways:
 *
 *   * TWO TEST BUNDLES BUILT FROM ONE PRODUCT repeat a `BuildableName`, and
 *     de-duplication drops the repeat: every blueprint after it slid onto the
 *     NEXT reference's product, so the clause sent a maintainer to a bundle
 *     some other, perfectly present target builds.
 *   * A `<MacroExpansion>` inside the test action names the APP target, not a
 *     test one. Swept flat it became a test target of its own, and a scheme
 *     whose test action is fine was reported BROKEN ON A CLEAN CHECKOUT.
 *   * A `skipped = "YES"` REFERENCE was indistinguishable from a running one,
 *     because `skipped` is written on the testable and the flat sweep never
 *     visited it -- so a note could not say which of the two it had found.
 *
 * The finding this clause exists to make is "the scheme names a target your
 * project has not got", and a finding that names the wrong pair is worse than
 * no finding: it is a maintainer sent to edit a file that is not broken. So the
 * reader DESCENDS -- only a `<BuildableReference>` inside a
 * `<TestableReference>` is a test target at all, and both names come off the
 * same element.
 */
function testTargetsIn(testSection: string): readonly TestTarget[] {
  const found: TestTarget[] = [];
  for (const opening of testSection.matchAll(TESTABLE_OPEN)) {
    const attributes = opening[1] ?? "";
    // A self-closing `<TestableReference ... />` carries no reference to read,
    // and reading on to the next `</TestableReference>` would take the FOLLOWING
    // block's element as this one's -- the very misassociation being fixed.
    if (attributes.trimEnd().endsWith("/")) continue;
    const from = (opening.index ?? 0) + opening[0].length;
    const closes = testSection.indexOf(TESTABLE_CLOSE, from);
    const element = BUILDABLE_OPEN.exec(closes === -1 ? "" : testSection.slice(from, closes))?.[1];
    const blueprint = BLUEPRINT_ATTRIBUTE.exec(element ?? "")?.[1] ?? "";
    // A reference naming no target names nothing to cross-check.
    if (blueprint === "") continue;
    const target: TestTarget = {
      blueprint,
      buildable: BUILDABLE_ATTRIBUTE.exec(element ?? "")?.[1] ?? "",
      skipped: (SKIPPED_ATTRIBUTE.exec(attributes)?.[1] ?? "").toUpperCase() === "YES",
    };
    // DE-DUPLICATION IS PER PAIR, NEVER PER NAME. Two references to the same
    // (target, product) are one finding printed once; two references sharing a
    // product are two findings and must both survive. And a pair a scheme names
    // once skipped and once not is NOT skipped -- the scheme runs it.
    const already = found.findIndex(
      (entry): boolean =>
        entry.blueprint === target.blueprint && entry.buildable === target.buildable,
    );
    if (already === -1) found.push(target);
    else if (!target.skipped) found[already] = target;
  }
  return found;
}

function readScheme(laneDirectory: string, container: string, file: string): SchemeFinding {
  const path = join(laneDirectory, container, ...SHARED_SCHEMES, file);
  const text = readText(path) ?? "";
  const testSection = TEST_ACTION.exec(text)?.[0] ?? "";
  const buildSection = BUILD_ACTION.exec(text)?.[0] ?? "";
  return {
    name: file.replace(XCSCHEME, ""),
    file: [container, ...SHARED_SCHEMES, file].join("/"),
    buildTargets: attributesIn(buildSection, BLUEPRINT_NAME),
    testTargets: testTargetsIn(testSection),
  };
}

/** Every native target an `.xcodeproj` declares, or null when nen cannot tell. */
function readTargets(laneDirectory: string, project: string): ReadonlySet<string> | null {
  const text = readText(join(laneDirectory, project, PBXPROJ));
  if (text === null) return null;
  const section = NATIVE_TARGETS.exec(text)?.[1];
  // FAIL CLOSED. A project file whose target section nen cannot find is one nen
  // knows nothing about, and answering "no targets" from it would report every
  // scheme in the lane as broken on the strength of an unfamiliar file format.
  if (section === undefined) return null;
  const targets = new Set<string>();
  for (const match of section.matchAll(TARGET_NAME)) {
    const name = match[1] ?? match[2];
    if (name !== undefined && name !== "") targets.add(name);
  }
  return targets;
}

function readAppleLane(laneDirectory: string): AppleLane {
  const entries = listDirectory(laneDirectory)
    .filter((entry): boolean => entry.directory)
    .map((entry): string => entry.name);
  const workspaces = entries.filter((name): boolean => XCWORKSPACE.test(name));
  const projects = entries.filter((name): boolean => XCODEPROJ.test(name));
  const schemes: SchemeFinding[] = [];
  for (const container of [...workspaces, ...projects]) {
    for (const entry of listDirectory(join(laneDirectory, container, ...SHARED_SCHEMES))) {
      if (entry.directory || !XCSCHEME.test(entry.name)) continue;
      schemes.push(readScheme(laneDirectory, container, entry.name));
    }
  }
  // THE UNION IS ALL OR NOTHING. Skipping the projects that would not parse
  // and merging the rest builds a target list that LOOKS complete and is not,
  // and `appleReason` reads a complete list as licence to call a scheme broken.
  // So one unreadable project withholds the cross-check for the whole lane, and
  // the names are kept so the note can say which file to go and look at.
  let merged: Set<string> | null = null;
  const unreadableProjects: string[] = [];
  for (const project of projects) {
    const declared = readTargets(laneDirectory, project);
    if (declared === null) {
      unreadableProjects.push(project);
      continue;
    }
    merged = new Set([...(merged ?? []), ...declared]);
  }
  const targets = unreadableProjects.length > 0 ? null : merged;
  return { workspaces, projects, schemes, targets, unreadableProjects };
}

/** What a `run <task>` in a step names, and WHO is being asked to run it. */
interface RunClause {
  /** The program the task is handed to: the word before `run`. */
  readonly runner: string;
  readonly task: string;
}

/**
 * The `<runner> run <task>` a step spells out, or null when it spells none.
 *
 * THE RUNNER IS READ, NOT ASSUMED, and that is the correction. The old check
 * looked up every `run <task>` in `package.json`'s `scripts` -- which is right
 * for `pnpm run build` and wrong for `pnpm turbo run build`, where `build` is a
 * TURBO PIPELINE NAME and turbo would not look in `scripts` for it either. Two
 * different lists, one syntax; reading the word before `run` is what tells them
 * apart.
 */
function runClause(step: ProposedStep): RunClause | null {
  const words = [step.exe, ...step.argv];
  const at = words.indexOf("run");
  // `<tool> run` with nothing after it is a MODE, not a task -- a test runner
  // told to run once instead of watching. There is nothing to look up. And a
  // `run` in first position has no runner before it to read.
  if (at < 1 || at === words.length - 1) return null;
  const runner = words[at - 1] ?? "";
  const task = words[at + 1] ?? "";
  return runner === "" || task === "" ? null : { runner, task };
}

/**
 * The TOOL a manager step hands the work to, or null when it hands it to none.
 *
 * WHY THE EXECUTABLE CHECK IS NOT ENOUGH ON ITS OWN. `pnpm turbo run build`
 * passes it the moment `package.json` names pnpm as its `packageManager` -- and
 * says nothing whatever about turbo, which is the program that has to be there.
 * The same held for `pnpm exec biome check .`: both rows were proposed against a
 * manifest declaring neither tool, and both exit non-zero the first time a human
 * runs them. So the check follows the work one hop further, into the three forms
 * a manager hands a step to something else:
 *
 *     npx <tool> …          <pm> exec <tool> …          <pm> <tool> run <task>
 *
 * and the tool must be a package the manifest declares (`carriesDependency`, so
 * a scoped `@biomejs/biome` answers for `biome`).
 *
 * WHAT IT DELIBERATELY DOES NOT READ is the bare `<pm> <word>` form where the
 * word is not a runner: `pnpm --filter <package> test:coverage` hands the work
 * to the package's own script, and `pnpm install` names a subcommand. Reading
 * either as a tool would require this file to carry a package manager's
 * vocabulary -- a table that drifts and that no test could notice was stale --
 * so it reads only the three shapes above, each of which is a form rather than
 * a name.
 */
function managerTool(step: ProposedStep, manifest: Manifest): string | null {
  const words = [step.exe, ...step.argv];
  const manager = manifest.packageManager?.executable;
  const isManager = step.exe === "npx" || (manager !== undefined && step.exe === manager);
  if (!isManager) return null;
  if (step.exe === "npx") {
    return words.slice(1).find((word): boolean => !word.startsWith("-")) ?? null;
  }
  const handoff = words.findIndex((word): boolean => word === "exec" || word === "dlx");
  if (handoff > 0) {
    return words.slice(handoff + 1).find((word): boolean => !word.startsWith("-")) ?? null;
  }
  const clause = runClause(step);
  return clause !== null && clause.runner !== step.exe ? clause.runner : null;
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

/**
 * What is wrong with a `<runner> run <task>`, or null when nothing is.
 *
 * TWO LISTS, ONE SYNTAX, and confusing them is how the check validated the
 * wrong thing. `pnpm run build` asks the PACKAGE MANAGER for a `build` script,
 * so `package.json`'s `scripts` is the list. `pnpm turbo run build` asks TURBO
 * for a `build` task, and turbo reads its own `turbo.json` -- a repository can
 * have the script and not the task, or the task and not the script, and the old
 * check passed the row either way by looking only at `scripts`.
 *
 * WHERE NEN CANNOT SEE THE LIST IT WITHHOLDS AND SAYS SO, in both shapes: a
 * runner whose config file is simply not here (turbo would fail on this tree
 * too), and a runner whose config file nen does not know how to find at all.
 * "nen could not check" must never render as "nen checked and it was fine" --
 * that is the same fail-closed rule the rest of this file is built on.
 */
function runnerTaskProblem(
  clause: RunClause,
  step: ProposedStep,
  manifest: Manifest,
): string | null {
  const line = [step.exe, ...step.argv].join(" ");
  if (clause.runner === step.exe) {
    return manifest.scripts.has(clause.task)
      ? null
      : `its reference command runs the task '${clause.task}', and this lane's package.json declares no such script`;
  }
  const tasks = manifest.runnerTasks(clause.runner);
  if (tasks.kind === "unknown") {
    return `'${line}' hands the task '${clause.task}' to '${clause.runner}' rather than to the package manager, and nen does not know where '${clause.runner}' keeps its task list -- a '${clause.runner}' task is a name in that tool's own config, not a package.json script, so nen can confirm nothing here and withholds rather than checking the wrong list`;
  }
  if (tasks.kind === "absent") {
    return `'${line}' hands the task '${clause.task}' to '${clause.runner}', whose task list lives in ${tasks.file} -- and this lane has none for nen to read. A '${clause.runner}' task is not a package.json script, so nen withholds rather than confirming this row against the wrong list`;
  }
  return tasks.tasks.has(clause.task)
    ? null
    : `'${line}' hands the task '${clause.task}' to '${clause.runner}', and this lane's ${tasks.file} declares no such task (${
        tasks.tasks.size === 0
          ? "it declares none nen could read"
          : `it declares: ${[...tasks.tasks].sort(compareBytes).join(", ")}`
      })`;
}

// ── the second cross-check family: what a PROJECT FILE says ─────────────────
//
// EVERYTHING ABOVE READS A `package.json`, AND THAT IS AN ECOSYSTEM'S ANSWER
// RATHER THAN EVERY ECOSYSTEM'S. A stack whose builds are described by project
// files has no manifest to be cross-checked against, and the old behaviour was
// exactly right for it and exactly useless: every row withheld, "this lane has
// no readable package.json", forever, for the absence of a file that ecosystem
// does not have.
//
// SO THE SECOND FAMILY READS THE PACK RATHER THAN CARRYING A TABLE. Four
// optional fields, each of them a fact about a FILE FORMAT that
// `profiles/*.json` already states and `docs/STACK-MATRIX.md` already renders:
//
//   * `answers`   -- which file of the target tree answers which token, as an
//                    ORDERED candidate list. Exactly one match at a rank
//                    answers; several are an ambiguity naming them; none falls
//                    through to the next rank.
//   * `references` -- the element and attribute one project file points at
//                    another path with. A reference that leaves the repository
//                    is the finding this exists for.
//   * `crossChecks` -- per-verb evidence: the row is proposed only where the
//                    tree carries the thing it would run against.
//   * `toolchain[].versionFile` / `hostTool` -- where the REPOSITORY states its
//                    own pin, and whether the program a row runs is the host
//                    SDK rather than a package a manifest could declare.
//
// A PROFILE STATING NONE OF THEM READS NOTHING AND CHANGES NOTHING. That is the
// whole of the containment: `EMPTY_READING` below is what every other stack
// gets, the tree is not even walked for them, and every existing proposal is
// byte for byte what it was.
//
// AND NONE OF IT LETS THE PACK CONTRIBUTE A VALUE. The pack states WHERE to
// look; every string that reaches a proposed row is read out of the target
// repository's own bytes, which is the same rule `{pm}` has always followed.

/** One file under a lane, in the three spellings the notes and rows need. */
interface TreeFile {
  readonly name: string;
  readonly directory: string;
  /** Lane-relative, forward-slashed: the value a proposed row is answered with. */
  readonly laneRelative: string;
  /** Repo-relative, forward-slashed: what a note and a precondition name. */
  readonly repoRelative: string;
  /**
   * This file's markup, COMMENTS ALREADY GONE, READ AT MOST ONCE.
   *
   * THE STRIPPING IS HERE RATHER THAN AT THE FIVE CALL SITES, and that is the
   * point of putting it on the file instead of beside each question. Every
   * question this reader asks a project file -- the two `answers` ranks, the
   * four test-evidence markers, the reference rule -- is a question about what
   * the project CONTAINS, and a commented-out element is exactly what it does
   * not contain. One of the five forgetting to strip is a defect nothing
   * fails: it reads a fact that is not there and proposes a row from it.
   *
   * Lazy rather than eager, and memoised rather than lazy-and-repeated. Eager
   * would read every asset in the tree to answer a question about project
   * files; repeated would read (and re-strip) each project file once per
   * marker, and this stack asks seven questions of the same `*.csproj`. One
   * read each is the only version that is neither.
   */
  readonly markup: () => string | null;
}

/**
 * Every file under a lane, bounded exactly as the marker scan is.
 *
 * THE SAME DEPTH BOUND, AND FOR THE SAME REASON: a project eight directories
 * down inside somebody's fixture tree is far more likely to be test data than a
 * build. The bound is a real blind spot and the withholding notes say so, the
 * way `renderDetect`'s "no lane detected" prose already does for the scan.
 */
function walkLaneFiles(repoRoot: string, laneDirectory: string): readonly TreeFile[] {
  const files: TreeFile[] = [];
  const walk = (directory: string, depth: number): void => {
    for (const entry of listDirectory(directory)) {
      const absolute = join(directory, entry.name);
      if (entry.directory) {
        if (depth === 0 || SKIP.has(entry.name)) continue;
        walk(absolute, depth - 1);
        continue;
      }
      let text: string | null | undefined;
      files.push({
        name: entry.name,
        directory,
        laneRelative: relativePath(laneDirectory, absolute),
        repoRelative: relativePath(repoRoot, absolute),
        markup: (): string | null => (text === undefined ? (text = readMarkup(absolute)) : text),
      });
    }
  };
  walk(laneDirectory, MAX_DEPTH);
  return files;
}

/**
 * Every file in the lane that matches ANY of these markers' patterns AND
 * carries that marker's literal.
 *
 * VARIADIC BECAUSE A RANK CAN BE A LIST. One marker is the ordinary call; the
 * agreement check below asks it about every LOWER rank at once, which is one
 * question ("what would the next rank have answered?") rather than several.
 */
function filesCarrying(files: readonly TreeFile[], ...markers: readonly ProfileMarker[]): readonly TreeFile[] {
  return files.filter((file): boolean =>
    markers.some(
      (marker): boolean =>
        matchesPattern(marker.pattern, file.name) &&
        (marker.contains === null || (file.markup() ?? "").includes(marker.contains)),
    ),
  );
}

/** A pattern list, for a note that has to say what nen looked for. */
function describeMarkers(markers: readonly ProfileMarker[]): string {
  return markers
    .map(
      (marker): string =>
        marker.contains === null ? `'${marker.pattern}'` : `'${marker.pattern}' carrying '${marker.contains}'`,
    )
    .join(", ");
}

/** A pack-supplied name, made safe to build a pattern out of. */
function literalPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a reference is absolute in ANY of the three ways a path can be.
 *
 * `path.isAbsolute` ANSWERS FOR THE HOST NEN IS RUNNING ON, and this reader is
 * asked about a file written for another one: a `C:/…` reference is absolute on
 * the machine the project came from and merely a strange relative segment to a
 * POSIX `resolve`, which would silently join it under the repository root and
 * report a path that escapes nothing. The three forms are checked by shape --
 * a POSIX root, a UNC root, a drive letter -- so the answer is the same on
 * every platform this binary is compiled for.
 */
function isAbsoluteReference(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * The shapes a reference value can have that are NOT A PATH AT ALL, each with
 * the sentence a maintainer needs to see.
 *
 * A REFERENCE NEN CANNOT RESOLVE IS UNANSWERABLE, AND UNANSWERABLE IS NOT THE
 * SAME AS ABSENT. Every one of these used to be resolved as a LITERAL path --
 * `$(SolutionDir)Core\Core.csproj` became a directory named `$(SolutionDir)Core`
 * -- written into the declaration as a `path` precondition and proposed with a
 * command beside it. That row exits 2 forever, on a tree that builds perfectly,
 * over a file that was never missing. The same property fails the other way
 * when the separators fall differently: `$(MSBuildThisFileDirectory)/../../x`
 * carries a `..`, so it was reported as an ESCAPE and the rows refused. One
 * property, a false proposal or a false refusal depending on punctuation.
 *
 * So nen says what it can see and stops: the rows are withheld, the value is
 * quoted verbatim, and NO precondition is written -- an assertion nen cannot
 * evaluate is worse than none, because a maintainer reads it as checked.
 */
const UNRESOLVABLE_SHAPES: readonly { readonly probe: string; readonly what: string }[] = [
  {
    probe: "$(",
    what: "an MSBuild PROPERTY, whose value lives outside the text nen reads -- nen expands none, so the file this names is not knowable from this file",
  },
  { probe: "%(", what: "an ITEM METADATA reference, whose value is computed while the build runs" },
  { probe: "*", what: "a WILDCARD, which names a SET of files rather than one" },
  { probe: "?", what: "a WILDCARD, which names a SET of files rather than one" },
  { probe: ";", what: "a ';'-SEPARATED LIST, which names several files in one attribute" },
  { probe: "&", what: "an XML ENTITY, which nen does not expand" },
];

/** What one path walk found at its last segment. */
type TreeLookup =
  | { readonly kind: "file" }
  | { readonly kind: "directory" }
  | { readonly kind: "missing" }
  /** Present under a DIFFERENT spelling; `actual` is the one on disk. */
  | { readonly kind: "case"; readonly actual: string };

/**
 * Whether this repo-relative path names a file in the tree, BYTE FOR BYTE.
 *
 * `existsSync` IS THE WRONG QUESTION ON TWO OF THE THREE HOSTS. macOS and
 * Windows answer from a case-insensitive filesystem, so a `core\core.csproj`
 * naming a `Core/Core.csproj` on disk "exists" there and does not on the Linux
 * runner that has to build it -- a precondition that passes on the machine that
 * wrote it and fails in CI, which is the worst shape a check can have. So the
 * walk compares each segment against that directory's own listing exactly, and
 * where only a case-folded match is there it says so and names BOTH spellings,
 * which is the one fact that makes the fix a one-character edit.
 */
function lookInTree(repoRoot: string, repoRelative: string): TreeLookup {
  const segments = repoRelative.split("/").filter((segment): boolean => segment !== "");
  /* c8 ignore next -- a reference resolving to the repository root itself is
     refused by `insideRepo` before this is asked */
  if (segments.length === 0) return { kind: "directory" };
  let directory = repoRoot;
  const walked: string[] = [];
  // THE WALK CONTINUES THROUGH A FOLDED SEGMENT rather than stopping at it, so
  // the spelling reported is the whole path as this tree writes it. Stopping at
  // the first difference reported `Core/core.csproj` for a tree containing
  // `Core/Core.csproj`, which is a third spelling that exists nowhere.
  let folded = false;
  for (let index = 0; index < segments.length; index += 1) {
    const wanted = segments[index] ?? "";
    const entries = listDirectory(directory);
    let match = entries.find((entry): boolean => entry.name === wanted);
    if (match === undefined) {
      match = entries.find((entry): boolean => entry.name.toLowerCase() === wanted.toLowerCase());
      if (match === undefined) return { kind: "missing" };
      folded = true;
    }
    walked.push(match.name);
    if (index === segments.length - 1) {
      if (!match.directory && folded) return { kind: "case", actual: walked.join("/") };
      return { kind: match.directory ? "directory" : "file" };
    }
    if (!match.directory) return { kind: "missing" };
    directory = join(directory, match.name);
  }
  /* c8 ignore next -- the loop returns on its final iteration */
  return { kind: "missing" };
}

/** What nen could make of ONE reference value. */
type ReferenceVerdict =
  /** Not a path nen can resolve at all: withhold, quote it, assert nothing. */
  | { readonly kind: "unresolvable"; readonly why: string }
  /** A path that leaves the repository: withhold, and say where it lands. */
  | { readonly kind: "escape"; readonly resolved: string; readonly why: string }
  /** Inside the tree under a DIFFERENT spelling: withhold, naming both. */
  | { readonly kind: "case"; readonly resolved: string; readonly actual: string }
  /** Inside the tree and NOT THERE: a note, and no precondition. */
  | { readonly kind: "missing"; readonly resolved: string }
  /** Inside the tree and there today: the one shape a precondition is written for. */
  | { readonly kind: "file"; readonly resolved: string };

/** Every verdict but `file` and `missing` -- the ones that end a row. */
function blocks(verdict: ReferenceVerdict): boolean {
  return verdict.kind === "unresolvable" || verdict.kind === "escape" || verdict.kind === "case";
}

/** One reference, the file that states it, and what nen could make of it. */
interface ReadReference {
  /** The file that states it, repo-relative. */
  readonly from: string;
  /** The attribute value verbatim, as the project file spells it. */
  readonly value: string;
  /** `<Element Attribute="...">`, so a note names the rule it read. */
  readonly rule: string;
  readonly verdict: ReferenceVerdict;
}

/**
 * ONE reference value, classified -- the single place the refusals are decided.
 *
 * THE ORDER IS THE ARGUMENT. A value that is not a path cannot be asked whether
 * it leaves the tree, and a path that leaves the tree cannot be asked whether it
 * is there: each question is meaningful only once the one before it is
 * answered. Reversing any pair is how one MSBuild property produced a false
 * refusal on one machine and a false proposal on another.
 */
function classifyReference(repoRoot: string, file: TreeFile, raw: string): ReferenceVerdict {
  const shape = UNRESOLVABLE_SHAPES.find((entry): boolean => raw.includes(entry.probe));
  if (shape !== undefined) return { kind: "unresolvable", why: shape.what };
  // A PROJECT FILE IS WRITTEN FOR ONE PLATFORM AND READ ON THREE. The separator
  // is normalised before anything resolves it, because a backslash is a legal
  // filename character on POSIX and a `..\..\x` would otherwise resolve to a
  // single file named `..\..\x` sitting safely inside the tree -- an escape
  // reported as a local path.
  const normalised = raw.split("\\").join("/");
  if (isAbsoluteReference(normalised)) {
    return {
      kind: "escape",
      resolved: normalised,
      why: "it is an ABSOLUTE path, naming a location on one machine rather than a file in this repository",
    };
  }
  const repoRelative = relativePath(repoRoot, join(file.directory, ...normalised.split("/")));
  try {
    // THE EXECUTOR'S OWN FUNCTION, ASKED RATHER THAN RESTATED. `./run.ts`'s
    // `insideRepo` is what a declared path is resolved through at run time, and
    // it refuses one that leaves the tree by name at exit 2 -- so a reference it
    // would refuse is a precondition that could never hold. A second copy of the
    // rule here would drift the first time either was fixed.
    insideRepo(repoRoot, repoRelative, `project.preconditions (from ${file.repoRelative})`);
  } catch {
    return {
      kind: "escape",
      resolved: repoRelative,
      why: "it resolves OUTSIDE the repository",
    };
  }
  const found = lookInTree(repoRoot, repoRelative);
  if (found.kind === "case") return { kind: "case", resolved: repoRelative, actual: found.actual };
  if (found.kind !== "file") return { kind: "missing", resolved: repoRelative };
  return { kind: "file", resolved: repoRelative };
}

interface ReferenceReading {
  /** Every reference every matching file states, in walk order. */
  readonly all: readonly ReadReference[];
  /** Repo-relative path -> the files that point at it, both byte-sorted. */
  readonly byTarget: ReadonlyMap<string, readonly string[]>;
}

/** The reference values ONE file states, per the pack's own element/attribute rules. */
function referencesIn(
  profile: StackProfile,
  repoRoot: string,
  file: TreeFile,
): readonly ReadReference[] {
  const out: ReadReference[] = [];
  for (const rule of profile.references) {
    if (!matchesPattern(rule.pattern, file.name)) continue;
    const pattern = new RegExp(
      `<${literalPattern(rule.element)}\\b[^>]*?\\b${literalPattern(rule.attribute)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
      "g",
    );
    const label = `<${rule.element} ${rule.attribute}="...">`;
    const text = file.markup();
    if (text === null) continue;
    for (const match of text.matchAll(pattern)) {
      const raw = (match[1] ?? match[2] ?? "").trim();
      if (raw === "") continue;
      out.push({
        from: file.repoRelative,
        value: raw,
        rule: label,
        verdict: classifyReference(repoRoot, file, raw),
      });
    }
  }
  return out;
}

/**
 * Every OTHER file this one names that is itself a file the reference rules
 * read -- how an AGGREGATE's list becomes an edge without teaching this file
 * what an aggregate is.
 *
 * A SOLUTION IS A LIST OF PROJECTS, AND NOTHING HERE KNOWS THE WORD "SOLUTION".
 * What it knows is the shape the pack already states: `references[].pattern`
 * says which files carry a project graph, so a quoted value that resolves to
 * one of THOSE is this file naming a member of the graph. A quoted value that
 * resolves to a source file, a GUID, a configuration name or nothing at all is
 * not, and is dropped without a word -- this is a reader of edges, not a parser
 * of somebody's file format, and the difference matters because the format is
 * theirs to change.
 */
function listedProjects(
  profile: StackProfile,
  repoRoot: string,
  file: TreeFile,
): readonly string[] {
  const text = file.markup();
  if (text === null) return [];
  const out: string[] = [];
  for (const match of text.matchAll(/"([^"\n]{1,400})"|'([^'\n]{1,400})'/g)) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (raw === "") continue;
    if (!profile.references.some((rule): boolean => matchesPattern(rule.pattern, laneRelativeName(raw.split("\\").join("/"))))) {
      continue;
    }
    const verdict = classifyReference(repoRoot, file, raw);
    if (verdict.kind === "file") out.push(verdict.resolved);
  }
  return out;
}

/**
 * Every path this lane's project files point at, and which of them the graph
 * NEN IS ADDRESSING can actually reach.
 *
 * REACHABILITY IS THE WHOLE OF THIS FUNCTION AND IT USED TO BE ABSENT. The
 * reader globbed every file in the lane matching the rule's pattern, so an
 * escaping reference in `third_party/Vendor/Vendor.csproj` -- a checked-in
 * vendor drop the application references nowhere -- withheld the lane's `build`,
 * with a note claiming it was "this lane's project graph". It was a file in the
 * same directory tree, which is a different statement. What a build resolves is
 * the graph reachable from the file it is pointed at, so that is what is walked:
 * the answered project, the projects an aggregate lists, and every reference
 * edge out of each. Anything outside that set is reported and blocks nothing.
 */
function walkGraph(
  profile: StackProfile,
  repoRoot: string,
  files: readonly TreeFile[],
  roots: readonly TreeFile[],
): ReferenceReading {
  const byPath = new Map<string, TreeFile>(
    files.map((file): [string, TreeFile] => [file.repoRelative, file]),
  );
  const seen = new Set<string>();
  const all: ReadReference[] = [];
  const byTarget = new Map<string, Set<string>>();
  const queue: TreeFile[] = [];
  const push = (file: TreeFile | undefined): void => {
    if (file === undefined || seen.has(file.repoRelative)) return;
    seen.add(file.repoRelative);
    queue.push(file);
  };
  for (const root of roots) push(root);
  while (queue.length > 0) {
    const file = queue.shift();
    /* c8 ignore next -- the loop condition guarantees one */
    if (file === undefined) continue;
    for (const reference of referencesIn(profile, repoRoot, file)) {
      all.push(reference);
      if (reference.verdict.kind !== "file") continue;
      // EVERY referrer is kept, not the first one the walk happened to reach:
      // two project files naming one shared library is the ordinary case, and a
      // precondition's reason crediting whichever of them the directory listing
      // returned first is a sentence that changes when a file is renamed.
      const referrers = byTarget.get(reference.verdict.resolved) ?? new Set<string>();
      referrers.add(file.repoRelative);
      byTarget.set(reference.verdict.resolved, referrers);
      push(byPath.get(reference.verdict.resolved));
    }
    for (const listed of listedProjects(profile, repoRoot, file)) push(byPath.get(listed));
  }
  return {
    all,
    byTarget: new Map(
      [...byTarget.entries()]
        .sort(([a], [b]): number => compareBytes(a, b))
        .map(([path, from]): [string, readonly string[]] => [path, [...from].sort(compareBytes)]),
    ),
  };
}

/** One layer of token answers: what was read, and what could not be. */
interface TokenLayer {
  readonly answers: ReadonlyMap<string, string>;
  readonly unanswered: ReadonlyMap<string, string>;
}

/** What a stack's own files answered, and what they refused to answer. */
interface StackReading {
  /** Token -> the value read out of this repository's tree, for every verb. */
  readonly answers: ReadonlyMap<string, string>;
  /** Token -> why this tree could not answer it. Named in the withheld note. */
  readonly unanswered: ReadonlyMap<string, string>;
  /**
   * Per-verb OVERRIDES of the two maps above, from a cross-check that also
   * answers -- the case where the file a row must address is not the file the
   * lane's general rule chose. Empty for every stack that states none.
   */
  readonly perVerb: ReadonlyMap<string, TokenLayer>;
  /** Verb -> why a cross-check withholds it whatever else is true. */
  readonly withheld: ReadonlyMap<string, string>;
  /** Executables a `hostTool` toolchain entry confirms, so no manifest need. */
  readonly confirmed: ReadonlySet<string>;
  /** The `project.toolchain` rows this reading proposes. */
  readonly toolchain: Readonly<Record<string, unknown>>;
  /** The `project.preconditions.<lane>` rows this reading proposes. */
  readonly preconditions: readonly unknown[];
  readonly notes: readonly string[];
}

const EMPTY_READING: StackReading = {
  answers: new Map(),
  unanswered: new Map(),
  perVerb: new Map(),
  withheld: new Map(),
  confirmed: new Set(),
  toolchain: {},
  preconditions: [],
  notes: [],
};

/**
 * The token layer ONE verb reads through: its own overrides over the lane's.
 *
 * A per-verb ANSWER also clears that token's lane-wide REASON, and the reverse,
 * because the two maps are one statement read from two directions -- leaving a
 * stale reason behind would withhold a row nen had just answered, or answer one
 * it had just refused.
 */
function layerFor(reading: StackReading, verb: string): TokenLayer {
  const own = reading.perVerb.get(verb);
  if (own === undefined) return { answers: reading.answers, unanswered: reading.unanswered };
  const answers = new Map(reading.answers);
  const unanswered = new Map(reading.unanswered);
  for (const [token, value] of own.answers) {
    answers.set(token, value);
    unanswered.delete(token);
  }
  for (const [token, reason] of own.unanswered) {
    unanswered.set(token, reason);
    answers.delete(token);
  }
  return { answers, unanswered };
}

/**
 * The program ONE toolchain entry lets a row skip the manifest check for.
 *
 * A SET RATHER THAN A BOOLEAN AT THE CALL SITE, because this is the exemption
 * itself and it is worth being able to look at. It is EMPTY unless the pack
 * says otherwise: `hostTool` is false by default and false for every tool a
 * repository could also declare as a dependency, so the ordinary answer here is
 * "nothing", and a mutant that turned it on everywhere would erase the
 * executable check for every stack that states any toolchain at all.
 * ./detect.test.ts pins it against the pack in both directions.
 */
export function hostToolPrograms(entry: PackMinimum): ReadonlySet<string> {
  const program = entry.probe[0];
  if (!entry.hostTool || program === undefined) return new Set();
  return new Set([program]);
}

/** Whether this profile states anything the project reader could act on. */
function statesProjectRules(profile: StackProfile): boolean {
  return (
    profile.answers.length > 0 ||
    profile.references.length > 0 ||
    profile.crossChecks.length > 0 ||
    Object.values(profile.toolchain).some(
      (entry): boolean => entry.versionFile !== null || entry.hostTool,
    )
  );
}

/** A JSON document's value at a key path, when every step is a plain object. */
function valueAtPath(document: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = document;
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * The version file this lane sits under, searched from the lane UP to the
 * repository root.
 *
 * UPWARDS, because that is how the files this reads actually apply: a pin at
 * the repository root governs every project beneath it, and a reader that only
 * looked in the lane would report "no pin" for a tree that states one two
 * directories up. It stops AT the root and never above it, for the same reason
 * every other path in this family does.
 */
function findVersionFile(repoRoot: string, laneDirectory: string, file: string): string | null {
  let directory = laneDirectory;
  for (;;) {
    const candidate = join(directory, file);
    if (readText(candidate) !== null) return candidate;
    if (relativePath(repoRoot, directory) === ".") return null;
    const parent = dirname(directory);
    /* c8 ignore next -- the root check above ends the walk before this can */
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * Read everything this stack's own files can say about this lane.
 *
 * ORDER MATTERS IN ONE PLACE AND IT IS ARGUED WHERE IT HAPPENS: a reference
 * that escapes the repository makes every token this block would answer
 * unanswerABLE, because the row it would fill in addresses a project graph that
 * does not resolve. Reporting an ambiguity between two solutions to somebody
 * whose build cannot load either would be the less useful of two true things.
 */
function readStack(
  profile: StackProfile,
  repoRoot: string,
  laneDirectory: string,
): StackReading {
  if (!statesProjectRules(profile)) return EMPTY_READING;

  const files = walkLaneFiles(repoRoot, laneDirectory);
  const answers = new Map<string, string>();
  const unanswered = new Map<string, string>();
  const perVerb = new Map<string, TokenLayer>();
  /** Each cross-check's own layer, held until the graph says whether it stands. */
  const perVerbEvidence = new Map<ProfileCrossCheck, TokenLayer>();
  const withheld = new Map<string, string>();
  const confirmed = new Set<string>();
  const toolchain: Record<string, unknown> = {};
  const preconditions: unknown[] = [];
  const notes: string[] = [];

  // ── 1. WHICH FILE THIS LANE'S ROWS ADDRESS ─────────────────────────────────
  //
  // ANSWERED BEFORE THE REFERENCES ARE READ, and the order is now the other way
  // round from the first draft. The graph a build resolves is the graph
  // reachable FROM the file it is pointed at, so nen cannot know which
  // references matter until it knows which file that is. Reading the references
  // first is what let a vendored project nothing points at withhold a lane.
  const roots: TreeFile[] = [];
  for (const rule of profile.answers) {
    let answered: TreeFile | null = null;
    let ambiguity: string | null = null;
    for (const candidate of rule.from) {
      const hits = filesCarrying(files, candidate);
      if (hits.length === 0) continue;
      if (hits.length > 1) {
        // BYTE ORDER, like every other list this file prints: the walk's own
        // order is deterministic but depth-first, and a note that reads
        // `Nested/B.sln, A.sln` for a tree whose files are A and B is a note
        // that looks like a bug.
        ambiguity = `${hits.length} files in this lane match ${describeMarkers([candidate])} (${hits
          .map((file): string => file.laneRelative)
          .sort(compareBytes)
          .join(", ")}), and nen resolves no ambiguity: naming one of them would be nen choosing which of these this repository builds. State the row this repository means. ${rule.why}`;
        break;
      }
      const hit = hits[0];
      /* c8 ignore next -- `hits.length === 1` is the only way here */
      if (hit === undefined) continue;
      // AN AGGREGATE MUST AGREE WITH WHAT IT AGGREGATES, or it does not answer.
      // A candidate at a HIGHER rank wins because it is the repository's own
      // list of what a build addresses -- and a list that does not name the file
      // the next rank would have answered with is not a list of THIS lane: an
      // unrelated `samples/Unrelated.sln`, a zero-byte one, one still naming
      // projects that were deleted. All three used to beat the project file
      // beside them, because nothing ever opened them. So the check is that it
      // NAMES the thing it claims to aggregate, and a candidate that fails it is
      // reported by name and stands aside rather than answering.
      const subordinate = rule.from.slice(rule.from.indexOf(candidate) + 1);
      const named = subordinate.length === 0 ? null : filesCarrying(files, ...subordinate);
      if (named !== null && named.length > 0) {
        const listed = new Set(listedProjects(profile, repoRoot, hit));
        const agrees = named.some((file): boolean => listed.has(file.repoRelative));
        if (!agrees) {
          notes.push(
            `${hit.laneRelative} matches ${describeMarkers([candidate])} and does NOT answer ${rule.token}: it names none of this lane's own ${describeMarkers(subordinate)} (${named
              .map((file): string => file.laneRelative)
              .sort(compareBytes)
              .join(", ")}). A file that aggregates others is the repository's list of what a build addresses, and one naming none of them is a list of something else -- unrelated, empty, or left behind by a project that was deleted. nen reads the next rank instead, and says so here rather than silently preferring a file it could not corroborate.`,
          );
          continue;
        }
      }
      // A row is answered with the LANE-RELATIVE path, because a verb runs in
      // the lane's own `cwd` and a repo-relative argument would miss by exactly
      // that many directories.
      answers.set(rule.token, hit.laneRelative);
      answered = hit;
      break;
    }
    if (answered !== null) {
      roots.push(answered);
      continue;
    }
    unanswered.set(
      rule.token,
      ambiguity ??
        `no file in this lane matches ${describeMarkers(rule.from)}, which is where the reference reads this value from -- and the scan is bounded to ${MAX_DEPTH} directories below the lane and never enters ${[...SKIP].sort().join(", ")}, so a project file below that bound is invisible to it. ${rule.why}`,
    );
  }

  // ── 2. THE PER-ROW EVIDENCE, AND THE FILE EACH GATED ROW ADDRESSES ─────────
  //
  // BEFORE THE GRAPH WALK, because a cross-check that ANSWERS a token names a
  // SECOND file this lane's rows address -- the project carrying the tests is
  // not the application -- and the graph the gated row resolves starts there.
  // Reading it after would walk the graph of the build and then propose a row
  // addressing a file outside it.
  const evidenceRoots: TreeFile[] = [];
  for (const check of profile.crossChecks) {
    // ONE FILE MAY CARRY SEVERAL OF THE MARKERS -- a test project referencing
    // both a test SDK and a framework matches twice and is ONE piece of
    // evidence, not two, so the evidence is a SET of files keyed by path.
    const evidence = new Map<string, TreeFile>();
    for (const marker of check.markers) {
      for (const file of filesCarrying(files, marker)) evidence.set(file.laneRelative, file);
    }
    if (evidence.size === 0) {
      for (const verb of check.verbs) {
        withheld.set(
          verb,
          `no file in this lane carries the evidence this row needs (${describeMarkers(check.markers)}). The pack's own reason: ${check.why} If this repository has one somewhere nen does not read, add the row by hand -- a verb the project does not visibly carry is a warning, never a proposal.`,
        );
      }
      continue;
    }
    const token = check.answers;
    if (token === null) continue;
    const paths = [...evidence.keys()].sort(compareBytes);
    if (paths.length === 1) {
      const only = evidence.get(paths[0] ?? "");
      /* c8 ignore next -- `paths` is keyed off `evidence` */
      if (only !== undefined) evidenceRoots.push(only);
      perVerbEvidence.set(check, {
        answers: new Map([[token, paths[0] ?? ""]]),
        unanswered: new Map(),
      });
      continue;
    }
    perVerbEvidence.set(check, {
      answers: new Map(),
      unanswered: new Map([
        [
          token,
          `${paths.length} files in this lane carry the evidence this row needs (${paths.join(", ")}), and nen resolves no ambiguity: which of them this row means, and in what order, is a list only this repository can state. ${check.why}`,
        ],
      ]),
    });
  }

  // ── 3. THE GRAPH THOSE ANSWERS REACH ───────────────────────────────────────
  const references = walkGraph(profile, repoRoot, files, [...roots, ...evidenceRoots]);
  const blocking = references.all.filter((reference): boolean => blocks(reference.verdict));
  const describeBlocking = (reference: ReadReference): string => {
    const verdict = reference.verdict;
    /* c8 ignore next -- `blocking` is filtered on exactly the three below */
    if (verdict.kind === "file" || verdict.kind === "missing") return "";
    if (verdict.kind === "unresolvable") {
      return `${reference.from} states ${reference.rule} '${reference.value}', which is ${verdict.why}`;
    }
    if (verdict.kind === "case") {
      return `${reference.from} states ${reference.rule} '${reference.value}', which resolves to ${verdict.resolved} -- this tree spells that file ${verdict.actual}, and the two differ only in case. A case-insensitive host builds it and a case-sensitive one does not, so nen asserts neither spelling`;
    }
    return `${reference.from} states ${reference.rule} '${reference.value}', which lands at ${verdict.resolved}, and ${verdict.why}`;
  };
  // EVERY blocking reference is named, in byte order, not the first the walk
  // reached. A maintainer who fixes the one nen happened to print runs `detect`
  // again to be told about the next one, which is the shape of a tool that
  // knows more than it says.
  const blockingSentences = blocking
    .map(describeBlocking)
    .sort(compareBytes)
    .join("; ");
  const escapeReason =
    blocking.length === 0
      ? null
      : `${blocking.length === 1 ? "a reference in this lane's project graph is one nen cannot assert" : `${blocking.length} references in this lane's project graph are ones nen cannot assert`} -- ${blockingSentences}. Every path a declaration states is resolved against the repository root, and one nen cannot resolve, or that escapes the tree, exits 2 by name -- so a row depending on it would be proposed with a precondition that can never hold, or with none at all and a build that fails later. Nothing here clones, fetches or vendors a sibling checkout. Make the dependency one this tree contains, spell it as this tree spells it, or state the row by hand, and run detect again`;
  // ── 4. WHAT A BLOCKING REFERENCE TAKES WITH IT ─────────────────────────────
  //
  // EVERY TOKEN, LANE-WIDE AND PER-VERB ALIKE. A row addressing a graph that
  // does not resolve is a row nen already knows will not start, and reporting
  // an ambiguity between two solutions to somebody whose build cannot load
  // either would be the less useful of two true things.
  if (escapeReason !== null) {
    for (const token of [...answers.keys()]) {
      answers.delete(token);
      unanswered.set(token, escapeReason);
    }
  }
  for (const [check, layer] of perVerbEvidence) {
    const token = check.answers;
    /* c8 ignore next -- only checks that answer a token are recorded */
    if (token === null) continue;
    const resolved: TokenLayer =
      escapeReason === null
        ? layer
        : { answers: new Map(), unanswered: new Map([[token, escapeReason]]) };
    for (const verb of check.verbs) perVerb.set(verb, resolved);
  }

  for (const [tool, entry] of Object.entries(profile.toolchain)) {
    // A PROBE THAT STILL NAMES A PACK TOKEN IS NOT ONE NEN CAN PROPOSE. That
    // row already gets its own note further down (`proposeVerbs`), and this
    // reader adds nothing to it: a toolchain entry whose probe carries a brace
    // is one the executor refuses rather than runs.
    if (PACK_TOKENS.some((token): boolean => entry.probe.some((word): boolean => word.includes(token)))) {
      continue;
    }
    for (const program of hostToolPrograms(entry)) confirmed.add(program);
    const versionFile = entry.versionFile;
    if (versionFile === null) continue;
    const found = findVersionFile(repoRoot, laneDirectory, versionFile.file);
    const document = found === null ? null : readJson(found);
    const stated = document === null ? undefined : valueAtPath(document, versionFile.path);
    if (typeof stated === "string" && stated !== "") {
      const at = relativePath(repoRoot, found ?? "");
      // WHAT ELSE THE PIN'S OWN BLOCK SAYS, because a version alone is not the
      // whole statement. A `global.json` stating `"rollForward": "latestFeature"`
      // beside its `"version"` is declaring a FLOOR -- any SDK in that band
      // satisfies it -- and nen's toolchain check compares versions EXACTLY, so
      // a host with a newer SDK in the same band is reported as a mismatch
      // against a pin the repository never meant as exact. nen still proposes
      // the version and nothing else (a `version` is what the declaration's own
      // reader accepts, and there is no field for a policy), but it says so
      // rather than dropping the sentence: a pin whose meaning nen cannot carry
      // is a pin whose meaning a maintainer has to be told about.
      const block = valueAtPath(document ?? {}, versionFile.path.slice(0, -1));
      const key = versionFile.path[versionFile.path.length - 1];
      const siblings =
        typeof block === "object" && block !== null && !Array.isArray(block)
          ? Object.entries(block as Record<string, unknown>)
              .filter(([name, value]): boolean => name !== key && typeof value !== "object")
              .map(([name, value]): string => `${name} = ${JSON.stringify(value)}`)
              .sort(compareBytes)
          : [];
      const policy =
        siblings.length === 0
          ? ""
          : ` ${at} also states ${siblings.join(", ")} at ${versionFile.path.slice(0, -1).join(".") || "(root)"}, which nen's toolchain block has no field for: it means the pin is a FLOOR or a policy rather than an exact requirement, and 'nen shu tools' compares versions EXACTLY -- so a host inside the band this repository accepts can still be reported as a mismatch. Narrow it by hand, or read that report with this in mind.`;
      toolchain[tool] = {
        version: stated,
        probe: entry.probe,
        versionFrom: entry.versionFrom,
        installer: entry.installer,
        // THE PACK'S SENTENCE IS ABOUT THE REPOSITORY THE CATALOGUE OBSERVED,
        // not about this one, and splicing it in unlabelled produced a
        // declaration that contradicted itself: the reason quoted here begins
        // "There is NO global.json in the repository" on a tree whose pin nen
        // has just read out of one.
        why: `${at} states this pin at ${versionFile.path.join(".")}, and nen proposes that and nothing else.${policy} The reference pack requires this tool for a reason written against the repository the catalogue observed rather than this one: ${entry.why}`,
      };
      notes.push(
        `'${tool}' is proposed under project.toolchain with version ${stated}, read from ${at} (${versionFile.path.join(".")}) -- this repository's own statement about itself, never the pack's.${policy} Its installer is '${entry.installer}', and 'nen shu tools' reports what is on the host rather than installing it unless the installer is one this release runs.`,
      );
      continue;
    }
    notes.push(
      `'${tool}' is NOT proposed under project.toolchain, and its version is withheld: ${
        found === null
          ? `this tree states none -- there is no ${versionFile.file} in the lane or above it, up to the repository root`
          : `${relativePath(repoRoot, found)} is there but states nothing readable at ${versionFile.path.join(".")}`
      }. Assert the version CI would need and nen will use it; nen will not invent one, because a toolchain entry with no 'version' is one nen's own reader refuses and a pin nen chose is a pin that pins nothing. State it yourself: {"version": "<the SDK CI would need>", "probe": ${JSON.stringify(entry.probe)}, "versionFrom": "${entry.versionFrom}", "installer": "${entry.installer}"} under project.toolchain.${tool}. ${versionFile.why}`,
    );
  }

  // ── 3. WHAT THE GRAPH LETS NEN ASSERT ──────────────────────────────────────
  //
  // A `path` PRECONDITION IS WRITTEN FOR ONE SHAPE ONLY: a reference that
  // resolves, stays inside the tree, and names a file that is there TODAY. Not
  // for a property nen cannot expand, not for a path that leaves the tree, and
  // not for a file the tree does not contain -- that last one is the case that
  // reads most like a feature and is not: `<ProjectReference Include="Core\Core.csproj" />`
  // pointing at a directory somebody deleted became `FAIL path Core/Core.csproj
  // -- not present` on every verb of the lane, forever, for a build that had
  // already been fixed some other way. nen states what it CHECKED, and a file
  // it could not find is a finding.
  for (const [path, from] of references.byTarget) {
    preconditions.push({
      kind: "path",
      value: path,
      why: `${from.join(", ")} point${from.length === 1 ? "s" : ""} this lane's project graph at it, and the build does not resolve without it. nen ASSERTS a precondition of kind ${ASSERTABLE_KINDS.map((kind): string => `'${kind}'`).join(" or ")} and performs neither: it will not create, fetch or vendor what is missing.`,
    });
  }
  if (preconditions.length > 0) {
    notes.push(
      `${preconditions.length} path precondition${preconditions.length === 1 ? " is" : "s are"} proposed under project.preconditions from this lane's own project references (${[...references.byTarget.keys()].join(", ")}). Each is a fact nen CHECKS before a verb runs and never one it performs.`,
    );
  }
  const missing = references.all.filter((reference): boolean => reference.verdict.kind === "missing");
  if (missing.length > 0) {
    notes.push(
      `${missing.length === 1 ? "one reference in this lane's project graph names a file that is NOT in the tree" : `${missing.length} references in this lane's project graph name files that are NOT in the tree`}: ${missing
        .map(
          (reference): string =>
            `${reference.from} states ${reference.rule} '${reference.value}' (${reference.verdict.kind === "missing" ? reference.verdict.resolved : ""})`,
        )
        .sort(compareBytes)
        .join("; ")}. No precondition is proposed for ${missing.length === 1 ? "it" : "them"}: nen asserts what it CHECKED, and a precondition naming a file that is not there would fail every verb of this lane on a tree whose build a maintainer may already have fixed another way. Restore the file, delete the reference, or state the precondition by hand.`,
    );
  }
  if (escapeReason !== null) {
    notes.push(
      `no precondition is proposed for ${blocking.length === 1 ? "the reference nen cannot assert" : "the references nen cannot assert"}: ${escapeReason}. ${blocking.length === 1 ? "It is" : "They are"} named here rather than written into the file because a declaration cannot state ${blocking.length === 1 ? "it" : "them"} at all.`,
    );
  }
  // A BLOCKING REFERENCE THE ANSWERED PROJECT CANNOT REACH IS A FINDING, NOT A
  // WITHHOLDING -- and saying nothing about it would be the other error. A
  // vendored drop under `third_party/` with an absolute reference in it is real,
  // and it is also not in the graph this lane's `build` resolves; a maintainer
  // who adds a reference to it tomorrow should have been told today.
  const reached = new Set(references.all.map((reference): string => reference.from));
  const outside = files
    .filter(
      (file): boolean =>
        !reached.has(file.repoRelative) &&
        profile.references.some((rule): boolean => matchesPattern(rule.pattern, file.name)),
    )
    .flatMap((file): readonly ReadReference[] => referencesIn(profile, repoRoot, file))
    .filter((reference): boolean => blocks(reference.verdict));
  if (outside.length > 0) {
    notes.push(
      `${outside.length === 1 ? "one project file this lane's answered graph does not reach states a reference nen could not assert" : `${outside.length} references live in project files this lane's answered graph does not reach`}: ${outside
        .map(describeBlocking)
        .sort(compareBytes)
        .join("; ")}. ${outside.length === 1 ? "It withholds" : "They withhold"} nothing, because a build resolves the graph reachable from the file it is pointed at and nothing in that graph names ${outside.length === 1 ? "this file" : "these files"} -- but a reference added to ${outside.length === 1 ? "it" : "them"} tomorrow would.`,
    );
  }

  return { answers, unanswered, perVerb, withheld, confirmed, toolchain, preconditions, notes };
}

interface ProposedVerbs {
  readonly verbs: Readonly<Record<string, unknown>>;
  readonly notes: readonly string[];
  /** The `project.toolchain` rows this lane's own files answered. */
  readonly toolchain: Readonly<Record<string, unknown>>;
  /** The `project.preconditions.<lane>` rows this lane's own files answered. */
  readonly preconditions: readonly unknown[];
}

/** Every word a proposed row would spawn, in both of the row's two shapes. */
function wordsOfRow(row: unknown): readonly string[] {
  const value = row as {
    exe?: unknown;
    argv?: unknown;
    steps?: readonly { exe?: unknown; argv?: unknown }[];
  };
  const words = (exe: unknown, argv: unknown): readonly string[] => [
    ...(typeof exe === "string" ? [exe] : []),
    ...(Array.isArray(argv) ? argv.filter((word): word is string => typeof word === "string") : []),
  ];
  return Array.isArray(value.steps)
    ? value.steps.flatMap((step): readonly string[] => words(step.exe, step.argv))
    : words(value.exe, value.argv);
}

/**
 * A proposed seat's `unsupported` text: SELF-DESCRIBING, with the pack quoted.
 *
 * The executor prints an `unsupported` row back as "The declaration's own
 * reason: <text>" (./render.ts), and for a row `detect` wrote that sentence is
 * false twice over. The text is not the declaration's own reason -- it is a
 * catalogue's observation about OTHER repositories, and attributing it to this
 * maintainer is how a placeholder starts reading as a decision. And on its own
 * it is circular: "no test script and no test-runner dependency" answers a
 * question about somebody else's tree, in a file about this one.
 *
 * So the seat says what it is before it says anything else, names the program
 * that wrote it and why, and marks the quoted half AS the quote. `PROPOSED SEAT
 * -- replace it` is the first thing read in the file, in `--json`, and in the
 * exit-4 refusal, which are the three places this string is ever seen.
 */
function seatReason(verb: string, stack: string, packReason: string): string {
  return `PROPOSED SEAT -- replace it. nen shu detect wrote this row because the reference pack proposes no command for '${verb}' on ${stack}; nen never invents one. The pack's own reason: ${packReason}`;
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
    }. Which of them this repository means, and in what order, is a list only it can state${
      workspace.unread.length === 0
        ? ""
        : `. nen could not read ${workspace.unread.join(", ")} -- only a literal path and a trailing '*' are expanded, so a member matched only by one of those is missing from that list, and a NEGATION among them means the list may still name a package this repository excludes`
    }`;
  }
  return manifest.present
    ? " -- package.json states no 'name' of its own, which is where nen reads a single-package lane's package name from"
    : " -- this lane has no readable package.json to read a package name from";
}

/**
 * The reason clause an EMBEDDED token earns, or "" when nothing was found.
 *
 * WHY THIS IS WORTH A CLAUSE AND NOT A SHRUG. A withheld row naming
 * `{platform}` tells a maintainer that nen will not guess and nothing else --
 * yet the same manifest that failed to answer the token spells both of the
 * values out, one per script, and a reader can see it in five seconds. The
 * clause closes exactly that gap: it names every value the lane's own scripts
 * put in that position, quotes the script that says so, and then says the one
 * thing that has not changed -- nen is not choosing between them.
 *
 * IT NAMES WHERE THE ANSWER GOES, because a note that stops at "state it
 * yourself" makes a reader go looking for the field. The row's own address in
 * the declaration is `project.verbs.<lane>.<verb>`, which is where the proposal
 * this note is printed beside already puts it.
 */
function embeddedReason(
  steps: readonly ProposedStep[],
  manifest: Manifest,
  lane: string,
  verb: string,
): string {
  const clauses: string[] = [];
  for (const step of steps) {
    for (const embedded of embeddedTokens(step)) {
      const values = embeddedValues(step, embedded, manifest);
      if (values.length === 0) continue;
      clauses.push(
        ` -- this lane's own scripts spell ${embedded.token}'s position ${
          values.length === 1 ? "one way" : `${values.length} ways`
        } (${values
          .map((found): string => `${found.value}, in '${found.key}': ${found.command}`)
          .join("; ")}), so nen can SEE the value${values.length === 1 ? "" : "s"} and still will not pick${
          values.length === 1 ? " it up" : " one"
        }: a script is what this repository runs by hand, and which of them a verb MEANS is a decision. State it under project.verbs.${lane}.${verb}${
          values.length === 1 ? "" : ", or give each value a lane of its own"
        }`,
      );
    }
  }
  return clauses.join("");
}

/**
 * One missing test target, as the note names it: the blueprint the scheme
 * asked for, then whatever else THAT SAME reference says about it.
 *
 * The product is the maintainer's landmark -- it is the name that appears in
 * Xcode's own scheme editor beside the target -- so it is printed when the
 * reference carries one, and printed from the reference that carried it.
 * `skipped` is reported rather than filtered out or left silent: a skipped
 * testable still names a target that must resolve, and a maintainer weighing
 * "add the target" against "drop the reference" needs to know the scheme was
 * not going to run it anyway.
 */
function testTargetLabel(target: TestTarget): string {
  const aside = [target.buildable, target.skipped ? "skipped by the scheme" : ""].filter(
    (part): boolean => part !== "",
  );
  return `'${target.blueprint}'${aside.length === 0 ? "" : ` (${aside.join(", ")})`}`;
}

/**
 * The reason clause an Apple lane earns for a row still naming `{scheme}`.
 *
 * THE ROW IS WITHHELD EITHER WAY -- a destination and a simulator UDID are
 * facts about the MACHINE that will run the command, and `detect` reads the
 * working tree and spawns nothing. What this clause adds is everything the tree
 * DOES say, and one thing it says that a maintainer filling the tokens in would
 * otherwise discover from a failing build:
 *
 *   * THE SHARED SCHEMES, by name and by file, because that is the value the
 *     row is missing and it is sitting in the checkout. Nen names them and does
 *     not substitute one: a lane with two schemes has not said which a verb
 *     means, and a lane with one has not said it either -- it has only made the
 *     guess look safe.
 *   * THE SCHEME'S OWN TEST ACTION AGAINST THE PROJECT'S TARGET LIST, which is
 *     the finding this clause exists for. A scheme naming a test target the
 *     project does not contain fails `test` on a CLEAN CHECKOUT, so the row is
 *     not one token away from working -- it is broken upstream of the token,
 *     and a note that named only the token would send a maintainer to fix the
 *     wrong thing. The claim is made only from a COMPLETE target list: one
 *     project file nen cannot parse yields `targets: null` for the whole lane,
 *     and this names that file rather than reporting every scheme as broken
 *     against the projects that happened to parse.
 *   * WHICH CONTAINER THE LANE IS, because the reference row's own flag is for
 *     a project and a CocoaPods lane is addressed as a workspace. That is the
 *     pack's own warning about the token, restated against what is here.
 */
function appleReason(lane: AppleLane, leftover: readonly string[]): string {
  const clauses: string[] = [];

  if (lane.schemes.length === 0) {
    clauses.push(
      ` -- nen found no SHARED scheme in this lane (it looks in <container>/${SHARED_SCHEMES.join(
        "/",
      )}/, and a scheme under xcuserdata/ is one developer's checkout rather than this repository's), so there is nothing here for a reader to copy either`,
    );
  } else {
    clauses.push(
      ` -- the shared scheme${lane.schemes.length === 1 ? "" : "s"} nen can see here ${
        lane.schemes.length === 1 ? "is" : "are"
      } ${lane.schemes
        .map((scheme): string => `'${scheme.name}' (${scheme.file})`)
        .join(", ")}, and nen names ${
        lane.schemes.length === 1 ? "it" : "them"
      } rather than substituting: which scheme a verb means is this repository's decision, not a count`,
    );
  }

  const targets = lane.targets;
  if (targets === null && lane.projects.length > 0) {
    const unreadable = lane.unreadableProjects;
    const readable = lane.projects.filter((project): boolean => !unreadable.includes(project));
    clauses.push(
      ` -- nen could not read a native-target list out of ${unreadable
        .map((project): string => `${project}/${PBXPROJ}`)
        .join(
          ", ",
        )}, so it makes NO claim about whether this lane's schemes name targets that exist: a cross-check nen could not perform is not one that passed${
        readable.length === 0
          ? ""
          : // THE PARTIAL READ IS THE INTERESTING CASE, so it says out loud that
            // the readable projects were dropped ON PURPOSE. A maintainer who
            // can see nen parsed A.xcodeproj would otherwise read the silence
            // as "and A's targets checked out fine", which is the claim this
            // whole clause exists to refuse.
            `. ${readable.join(", ")} did parse, and ${
              readable.length === 1 ? "its target list is" : "their target lists are"
            } WITHHELD ALL THE SAME: a scheme's test target may live in the project nen could not read, so measuring these schemes against a target list missing ${
              unreadable.length === 1 ? "one project" : "those projects"
            } would report a working scheme as broken`
      }`,
    );
  } else if (targets !== null) {
    const broken = lane.schemes
      .map((scheme): { scheme: SchemeFinding; missing: readonly TestTarget[] } => ({
        scheme,
        missing: scheme.testTargets.filter((target): boolean => !targets.has(target.blueprint)),
      }))
      .filter((entry): boolean => entry.missing.length > 0);
    for (const { scheme, missing } of broken) {
      clauses.push(
        // THE FILE IS NAMED, NOT JUST THE SCHEME. A repository may keep a
        // scheme of the same name in its `.xcworkspace` AND its `.xcodeproj`,
        // and two byte-identical paragraphs read as one printed twice rather
        // than as two findings about two files a maintainer must edit apart.
        ` -- AND THAT SCHEME'S TEST ACTION IS BROKEN ON A CLEAN CHECKOUT: '${scheme.name}' (${scheme.file}) names ${missing
          .map(testTargetLabel)
          .join(", ")} in its test action, and this lane's project declares no such target -- it declares ${
          targets.size === 0
            ? "none nen could read"
            : [...targets].sort(compareBytes).join(", ")
        }. That is a finding about the CHECKOUT rather than about this proposal -- a test on that scheme fails before ${leftover.join(
          ", ",
        )} matters, because the scheme asks for a target the project does not contain`,
      );
    }
  }

  if (lane.workspaces.length > 0) {
    clauses.push(
      ` -- and this lane's container is a WORKSPACE (${lane.workspaces.join(
        ", ",
      )}), which the reference row's own flag does not address: the pack states that the flag changes with the container, so the value here is not simply that path`,
    );
  }
  return clauses.join("");
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
 *     than a silence. IT IS QUOTED INSIDE A SENTENCE OF NEN'S OWN, and that
 *     wrapper is not decoration. ./render.ts prints an `unsupported` row as
 *     "The declaration's own reason: <text>", which is true of a row a human
 *     wrote and a lie about this one -- the quoted half is a THIRD PARTY's
 *     observation about somebody else's repositories, and reading it back as
 *     the maintainer's own reason is circular: the file says the verb is
 *     unsupported because the file says so. So the row states, in this order,
 *     WHAT IT IS ("PROPOSED SEAT -- replace it"), WHO WROTE IT and WHY (`nen
 *     shu detect`, because the pack proposes no command for this verb on this
 *     stack), and only then the pack's sentence, marked as the pack's. A
 *     maintainer who replaces the row writes their own reason and the wrapper
 *     goes with it, which is exactly the signal that the seat was taken.
 *   * A `declared-only` cell becomes `unsupported` TOO, because a declaration
 *     has three forms and none of them is "the reference disagrees with
 *     itself". The row is the visible seat for this repository's answer, the
 *     note below says which rows are of that kind, and the pack's reason names
 *     the commands it declined to pick between.
 */
function proposeVerbs(
  pack: ProfilesPack,
  profile: StackProfile,
  repoRoot: string,
  laneDirectory: string,
  lane: string,
  platform: string,
  hostStack: HostToolStack | undefined,
): ProposedVerbs {
  const manifest = readManifest(laneDirectory);
  const reading = readStack(profile, repoRoot, laneDirectory);
  const verbs: Record<string, unknown> = {};
  const notes: string[] = [];
  const noCommand: string[] = [];
  const declaredOnly: string[] = [];
  const scope = laneScope(repoRoot, laneDirectory, hostStack);
  const hostResolved = new Map<string, string>();
  // READ ONCE, AND ONLY WHERE A ROW ASKS FOR IT. Three of this stack's rows
  // name the same token and would otherwise walk the same bundles three times,
  // and a lane no row of which names it never opens a directory at all.
  let apple: AppleLane | null = null;
  const appleLane = (): AppleLane => (apple ??= readAppleLane(laneDirectory));

  for (const verb of pack.commandVerbs) {
    const cell = verbCell(profile, verb);
    if (cell.kind === "unsupported" || cell.kind === "declared-only") {
      noCommand.push(`${verb} (${cell.summary})`);
      if (cell.kind === "declared-only") declaredOnly.push(verb);
      verbs[verb] = {
        unsupported: seatReason(
          verb,
          profile.id,
          cell.kind === "declared-only"
            ? cell.reason
            : /* c8 ignore next -- the pack's reader gives an `unsupported` cell an `unsupported` invocation */
              cell.invocation.kind === "unsupported"
              ? cell.invocation.reason
              : cell.summary,
        ),
      };
      continue;
    }
    /* c8 ignore next 5 -- `delegated` never appears among the command verbs */
    if (cell.kind === "delegated") {
      noCommand.push(`${verb} (delegates to ${cell.delegatesTo.join(", ")})`);
      verbs[verb] = { unsupported: seatReason(verb, profile.id, cell.why) };
      continue;
    }

    // A LANE WHOSE BUILD NEN CANNOT ADDRESS PROPOSES NOTHING, and it says which
    // build and why once per row rather than once per lane, so that the reason
    // travels with the row a maintainer is reading.
    if (scope.kind === "unaddressable") {
      notes.push(
        `'${verb}' withheld: ${scope.why}. A command the repository cannot run is a warning, never a proposal.`,
      );
      continue;
    }

    // WHAT NEN ITSELF CAN ANSWER, ASKED BEFORE THE MANIFEST IS. It is scoped to
    // the tokens THIS row actually names, so a stack that never mentions a
    // wrapper never reads a directory looking for one, and a row that never
    // mentions a task never reads a settings file.
    const answers = laneAnswers(
      repoRoot,
      laneDirectory,
      platform,
      hostStack,
      verb,
      new Set(leftoverTokens(stepsOfCell(cell))),
    );
    for (const [token, value] of answers.answered) {
      if (HOST_TOKENS.some((entry): boolean => entry.token === token)) {
        hostResolved.set(token, value);
      }
    }
    // The module prefix, where the pack's rows describe a build one directory
    // down -- `run` becomes `:desktop:run`, and a flag or an already-qualified
    // task is left exactly as the pack wrote it.
    const qualify = (word: string): string =>
      scope.kind === "module" && isBareTask(word) ? `${scope.module}:${word}` : word;
    // THE PROJECT READER'S OWN LAYER for this verb, over the lane's: a stack
    // that states no `answers` rule contributes an empty one.
    const layer = layerFor(reading, verb);
    const substituted = stepsOfCell(cell).map(
      (step): ProposedStep => ({
        exe: substitute(step.exe, manifest, answers, layer),
        argv: step.argv.map((token): string =>
          qualify(substitute(token, manifest, answers, layer)),
        ),
      }),
    );

    // The manifest's own `scripts` block, asked once per step for the tokens the
    // fields above could not answer -- ARITY PLUS CORROBORATION (`scriptAnswers`
    // carries the argument). TWO CORROBORATED ANSWERS THAT DISAGREE END THE ROW:
    // this file resolves no ambiguity, and one arriving from inside a single
    // file is not a different kind of ambiguity.
    const steps: ProposedStep[] = [];
    const nearMisses: string[] = [];
    let ambiguity: string | null = null;
    for (const step of substituted) {
      if (leftoverTokens([step]).length === 0) {
        steps.push(step);
        continue;
      }
      const { answers, nearMisses: missed } = scriptAnswers(step, manifest, verb);
      if (answers.length > 1) {
        ambiguity ??= `'${verb}' withheld: ${answers.length} of this lane's own scripts share the shape of its reference command '${[
          step.exe,
          ...step.argv,
        ].join(" ")}' and corroborate it, and they disagree about ${leftoverTokens([step]).join(", ")} (${answers
          .map((answer): string =>
            [...answer.entries()]
              .sort(([a], [b]): number => compareBytes(a, b))
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
        nearMisses.push(...missed);
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
        // THE VALUES THE LANE'S OWN SCRIPTS SPELL where the pack embedded a
        // token in a longer word, and the SCHEME/TARGET reading for a lane
        // whose row names one. Both are note-only: see the section header above
        // `embeddedTokens`. The Apple read is gated on the token so that no
        // lane without such a row ever touches the filesystem for it.
        embeddedReason(steps, manifest, lane, verb),
        leftover.includes(SCHEME_NAME) ? appleReason(appleLane(), leftover) : "",
        // THE NEAR MISS IS NAMED. A script that agreed by word count and that
        // nothing corroborated is the most useful thing nen can say here: it is
        // the row a maintainer either confirms in one edit or recognises as the
        // coincidence it was.
        nearMisses.length === 0
          ? ""
          : ` -- ${nearMisses.length === 1 ? "one script shares" : `${nearMisses.length} scripts share`} its shape (${nearMisses.join("; ")}) and nothing corroborates the match: a step this thin agrees with every script of the same length, so nen answers it only from a script whose own KEY names what the row is for`,
        // A TOKEN NEN TRIED TO ANSWER AND COULD NOT gets the reason it could
        // not, in the token's own terms. "only this repository can answer" is
        // true and useless for a wrapper nen looked for and did not find.
        ...leftover.map((token): string => answers.refused.get(token) ?? ""),
        // A TOKEN THE PROJECT READER TRIED AND COULD NOT ANSWER says far more
        // than "only this repository can answer it": it says nen looked in the
        // file the pack names, and what it found there instead.
        ...leftover.map((token): string => {
          const reason = layer.unanswered.get(token);
          return reason === undefined ? "" : ` -- ${token}: ${reason}`;
        }),
      ].join("");
      notes.push(
        `'${verb}' withheld: its reference command still names ${leftover.join(", ")}, which only this repository can answer${clauses}. nen never proposes an unsubstituted token: a guessed argument is a different command.`,
      );
      continue;
    }

    // THE PACK'S OWN PER-ROW EVIDENCE, checked AFTER the tokens and before the
    // manifest. After, because a token nen could not answer is a fact about the
    // whole lane and blocks every row that carries it, while this is a fact
    // about ONE row -- telling a maintainer their tree has no test project,
    // when nothing in it resolves to a buildable project at all, answers the
    // smaller question first. Before the manifest checks, because a stack that
    // states evidence of its own is one whose rows a `package.json` was never
    // going to confirm.
    const missingEvidence = reading.withheld.get(verb);
    if (missingEvidence !== undefined) {
      notes.push(`'${verb}' withheld: ${missingEvidence}`);
      // AND IT IS SEATED, not deleted -- the same argument `proposeVerbs`'s
      // header makes for the pack's own `unsupported` cells, one layer in. A
      // row that is simply absent makes `nen shu test` answer "this lane
      // declares no 'test'", which is true of the FILE and says nothing about
      // the tree: the maintainer is told the declaration is incomplete rather
      // than that their repository has no test project. A row a maintainer can
      // SEE is a row they can replace, and the reason travels inside it.
      verbs[verb] = {
        unsupported: `PROPOSED SEAT -- replace it once this repository can answer it. nen shu detect withheld the reference pack's command for '${verb}' on ${profile.id}: ${missingEvidence}`,
      };
      continue;
    }

    // THE EXECUTABLE CHECK, and then the same question one hop further in. A
    // step the manifest spells out VERBATIM as one of its own scripts skips both
    // and the task check below: that route is the repository stating it runs
    // THIS LINE, which is stronger evidence than any list nen could consult
    // about the line's parts.
    // A FOURTH ROUTE, and the pack has to ASK for it: an executable a
    // `hostTool` toolchain entry probes for is confirmed by that entry rather
    // than by a manifest. It exists because a stack whose driver is an SDK on
    // the machine has none of the other three -- no manifest in that ecosystem
    // can declare it -- and requiring one would withhold every row of that
    // stack forever for the absence of a file it does not have. It is OFF by
    // default and off for every tool a repository could also declare as a
    // dependency; ../profiles/pack.ts's `hostTool` carries the full argument.
    const unconfirmed = steps.find((step): boolean => !runsVerbatim(step, manifest));
    const unknownExe =
      unconfirmed !== undefined &&
      // A value NEN wrote is one nen has just seen on disk in this lane -- see
      // `LaneAnswers.exes`. Asking a package.json to confirm it would withhold
      // every row of a stack that legitimately has no package.json at all.
      !answers.exes.has(unconfirmed.exe) &&
      unconfirmed.exe !== manifest.packageManager?.executable &&
      !reading.confirmed.has(unconfirmed.exe) &&
      !manifest.declares(unconfirmed.exe)
        ? unconfirmed
        : undefined;
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
    const unknownTool = steps
      .filter((step): boolean => !runsVerbatim(step, manifest))
      .map((step): { step: ProposedStep; tool: string | null } => ({
        step,
        tool: managerTool(step, manifest),
      }))
      .find(({ tool }): boolean => tool !== null && !manifest.declares(tool));
    if (unknownTool !== undefined && unknownTool.tool !== null) {
      notes.push(
        `'${verb}' withheld: '${[unknownTool.step.exe, ...unknownTool.step.argv].join(" ")}' asks the package manager to run '${unknownTool.tool}', and this lane's package.json declares no such dependency. The manager being present says nothing about the tool it hands the work to -- that is the program that has to be there, and a tool the project does not visibly carry is a warning, never a proposal.`,
      );
      continue;
    }

    // THE TASK CHECK, over both shapes an argv names a task in, and against the
    // list the RUNNER would actually consult. The per-package one applies only
    // where nen ANSWERED `{package}` from this manifest, so a lane that never
    // carried the token is never asked about a task it has no reason to declare.
    const answeredPackage = leftoverTokens(stepsOfCell(cell)).includes(PACKAGE_NAME)
      ? packageAnswer(manifest)
      : null;
    const taskProblem = steps
      .filter((step): boolean => !runsVerbatim(step, manifest))
      .flatMap((step): readonly string[] => {
        const problems: string[] = [];
        const clause = runClause(step);
        if (clause !== null) {
          const missing = runnerTaskProblem(clause, step, manifest);
          if (missing !== null) problems.push(missing);
        }
        const task = answeredPackage === null ? null : packageTask(step.argv, answeredPackage);
        if (task !== null && !manifest.scripts.has(task)) {
          problems.push(
            `its reference command asks the package '${answeredPackage}' for the task '${task}', and this lane's package.json declares no such script`,
          );
        }
        return problems;
      });
    const missingTask = taskProblem[0];
    if (missingTask !== undefined) {
      notes.push(
        `'${verb}' withheld: ${missingTask}. If the task is declared somewhere nen does not read -- a workspace member, a task runner's own config -- add the row by hand; a verb the project does not visibly carry is a warning, never a proposal.`,
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

  // WHERE THE PACK'S TASKS WERE RE-ADDRESSED, said out loud. A reader comparing
  // the proposal against docs/STACK-MATRIX.md must be able to see why the argv
  // is not the catalogue's verbatim word, and the answer is a fact about THIS
  // tree rather than a decision of nen's.
  if (scope.kind === "module") {
    notes.push(
      `this lane's marker was found in a subdirectory that this lane's own settings file includes as the module '${scope.module}', so every bare task the reference pack names is proposed as '${scope.module}:<task>'. The pack's rows describe that build, and running its task name at the lane root would run the ROOT project's task of the same name instead -- a different command with the same spelling. If this build is meant to be a lane of its own, give it its own wrapper and settings file: the scan stops at either, and proposes it as a separate lane.`,
    );
  }

  // WHAT A DECLARATION CANNOT CARRY: the host it was written on. `{gw}` is the
  // one token nen resolves for itself, and it resolves it to a DIFFERENT word
  // per platform -- so a file written on one host carries one spelling, and a
  // teammate on the other host reads a word their machine has no file for.
  //
  // `hosts` IS DELIBERATELY NOT NARROWED FOR IT, and that is the whole reason
  // this is a note rather than a code change: the pack states this stack runs
  // on every platform and cites the repository saying so, the wrapper ships
  // under BOTH names in the tree, and narrowing `hosts` per spelling would turn
  // "this word needs re-resolving" into exit 3 "unsupported host" -- a refusal
  // that is false about the stack and that hides the one-word fix. The longer
  // term answer is for the executor to substitute a host-conditional token at
  // spawn time rather than at proposal time; that is a change to ./render.ts's
  // refusal list and is not this verb's to make.
  const proposedWords = Object.values(verbs).flatMap((row): readonly string[] =>
    isUnsupportedRow(row) ? [] : wordsOfRow(row),
  );
  for (const [token, value] of hostResolved) {
    if (!proposedWords.includes(value)) continue;
    notes.push(
      `${token} in this lane's proposed rows was resolved for ${platform}: nen wrote '${value}'. A teammate on the other host must re-run \`nen shu detect\` or hand-edit the spelling -- the wrapper is committed under both names, but a declaration carries one. 'hosts' is NOT narrowed for it: this stack runs on every platform the pack states, and only this one word differs.`,
    );
  }

  // THE PROSE A `hosts` MAP CANNOT CARRY, carried beside it. `hosts` is a list
  // of `process.platform` values and nothing else, so everything that makes a
  // platform constraint actionable -- which IDE, which SDK, which formats are
  // per-host, what a teammate on the other machine sees -- lived only in the
  // pack and in docs/STACK-MATRIX.md. A maintainer reading `"hosts": {"*":
  // ["win32"]}` in their own declaration was told WHAT nen refuses and never
  // why, and the exit-3 message says less still. It is emitted wherever a
  // `hosts` block is proposed at all: a stack running everywhere still has
  // something to say about per-format and per-lane splits.
  if (Object.keys(profile.hosts).length > 0 && profile.hostNote !== "") {
    notes.push(
      `the platforms in 'hosts' are ${Object.entries(profile.hosts)
        .map(([verb, platforms]): string => `${verb}: ${platforms.join(", ")}`)
        .join("; ")}, and the reference pack's own note on what that means in practice -- which a 'hosts' map cannot carry and an exit-3 refusal does not print -- is: ${profile.hostNote}`,
    );
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
  // entry whose PROBE still carries a pack token is one nen cannot turn into a
  // precondition, and there are two ways to arrive there and one answer:
  //
  //   * A DECLARATION-SUPPLIED TOKEN is a fact only the repository or the
  //     machine knows -- a binary somewhere on this disk, a workload id on this
  //     installation.
  //   * `{gw}`, THE ONE `host-conditional` TOKEN, is the one the pack's own
  //     prose says nen resolves for itself. It gets a note all the same, and
  //     that correction is the point of reading behaviour instead of prose:
  //     ./render.ts REFUSES `{gw}` by name (REFUSED_PLACEHOLDERS, pinned
  //     against the pack in ./purity.test.ts, in both directions), so a probe
  //     naming it is a probe nen cannot perform either. Filtering on `kind`
  //     here left `gradle-android` and `compose-desktop` silent about the one
  //     toolchain row nen was declining -- the two stacks whose whole build
  //     goes through that wrapper.
  //
  // So every such row gets a note naming what it declined, which is the honest
  // half of a constraint the pack states in prose.
  for (const [tool, entry] of Object.entries(profile.toolchain)) {
    const tokens = PACK_TOKENS.filter((token): boolean =>
      entry.probe.some((word): boolean => word.includes(token)),
    );
    if (tokens.length === 0) continue;
    const resolvedByNen = tokens.filter((token): boolean => !DECLARATION_TOKENS.has(token));
    notes.push(
      `no precondition is proposed for the '${tool}' this stack's toolchain requires: its probe is '${entry.probe.join(" ")}', and ${tokens.join(", ")} is a value nen has nothing to read here. nen asserts a precondition of kind ${ASSERTABLE_KINDS.map((kind): string => `'${kind}'`).join(" or ")} and performs neither -- and 'path' is not merely a bad choice here, it is one nen REFUSES: every path a declaration states is resolved against the repository root and one that escapes it exits 2 by name, so an installed binary's absolute location cannot be written as a precondition at all. The reference pack names no environment variable to assert instead, so nen proposes nothing rather than inventing one. If this repository has such a variable, state it yourself: {"kind": "env", "value": "<NAME>", "why": "..."} under project.preconditions.${lane}.${
        resolvedByNen.length === 0
          ? ""
          : ` (${resolvedByNen.join(", ")} is the token the pack says nen resolves for itself from the platform -- and nen's own executor refuses it by name all the same, so this row is no different from the others.)`
      } The pack's own reason for the requirement: ${entry.why}`,
    );
  }
  // THE CATALOGUE'S OWN NOTES ON THIS STACK, CARRIED THROUGH VERBATIM.
  //
  // They were being dropped, and what was dropped was the half of the pack a
  // proposal cannot express as a row: the preconditions this stack asserts and
  // never performs, the extra verbs an inventory found that the thirteen do not
  // cover, and -- the one that made this a defect rather than a tidiness --
  // a CONFLICT the catalogue records between two sources that disagree about
  // what a verb should run. A conflict is exactly the thing that must never be
  // encoded as a command: nen states one side, cites it, and reports that the
  // other exists, so the maintainer resolves it upstream instead of finding out
  // from a green build that overwrote a golden. A note is the only shape that
  // says that, and a note nobody prints says nothing.
  for (const note of profile.notes) {
    notes.push(`the reference pack's own note on ${profile.id}: ${note}`);
  }

  // THERE IS DELIBERATELY NO LANE-LEVEL "no package.json" NOTE. An earlier
  // draft withheld the whole map with one such note, which was wrong twice: it
  // told a repository whose commands legitimately live elsewhere that its
  // manifest was the problem, and it hid WHICH rows the manifest would have
  // answered. Every withheld row now carries its own reason, and a row that
  // never needed a manifest never mentions one.
  notes.push(...reading.notes);
  return { verbs, notes, toolchain: reading.toolchain, preconditions: reading.preconditions };
}

/**
 * A note for every marker this lane CARRIES and was not IDENTIFIED by.
 *
 * ONE SHAPE PRODUCES ONE TODAY and the mechanism is still general, which is the
 * right way round: `matchesIn` decides what is evidence and what identifies,
 * and this reads the pack for the reason rather than restating it. A lane with
 * a single marker -- every lane in the reference set but one -- produces
 * nothing here, so no stack acquires a note by accident.
 *
 * WHAT THE NOTE IS FOR. The pack's `unsupported` seats quote observations about
 * the repositories the catalogue read, and a maintainer meeting one in their own
 * proposal has no way to tell which of those observations still holds. A file
 * that is HERE and that the catalogue recorded as absent is exactly that signal,
 * and it is the one a reader can act on: the seat is not merely a seat, it is a
 * seat whose stated reason is already untrue of this tree.
 */
function evidenceNotes(profile: StackProfile, matches: readonly Match[]): readonly string[] {
  const notes: string[] = [];
  for (const match of matches) {
    if (match.identifying) continue;
    const name = match.marker.split("/").pop() ?? match.marker;
    // The pattern is matched WHOLE and never globbed. A pack pattern carrying a
    // `*` simply finds nothing here, which is honest: this file has no glob
    // engine, and half-expanding one is how a note starts describing a file
    // that is not there.
    const declared = profile.markers.find((marker): boolean => marker.pattern === name);
    /* c8 ignore next -- every evidence marker `matchesIn` records is one the pack declares */
    if (declared === undefined) continue;
    notes.push(
      `this lane also carries ${match.marker}, which the reference pack names as a marker of this stack and which nen did NOT identify the lane from -- a lane proposed from that file alone would be nen deciding what kind of project this is from an ancillary one. It is reported because the pack's own seats below were written about repositories that had none, so a seat whose quoted reason turns on its absence is the first row to distrust here. The pack's reason for the marker: ${declared.why}`,
    );
  }
  return notes;
}

/**
 * A marker pattern that could name a CHILD DIRECTORY rather than a file in the
 * lane: a single bare segment, no extension and no glob.
 *
 * THE CLASSIFICATION IS SYNTACTIC AND IT FAILS CLOSED, which is why a rule this
 * blunt is safe here. Three patterns in the whole pack match it -- `ios` and
 * `android` (expo), which are directories, and `gradlew` (gradle-android) and
 * `Podfile` (xcode-ios), which are files. Reading a FILE as a directory marker
 * can only make `nestedLaneNote` fire LESS: the gate below demands that every
 * such pattern be present as a nested LANE, and no tree produces a lane whose
 * directory is named `gradlew`. The misreading that would matter is the other
 * one -- a directory read as a file, which would let the note fire on a partly
 * met conjunction -- and it cannot happen for a pattern the pack writes as a
 * bare name, because that is the only shape a lane's own directory name takes
 * in the marker table.
 */
const DIRECTORY_MARKER = /^[^./\\*?{}[\]]+$/;

/**
 * The note a lane earns for the lanes found INSIDE it, when its own profile
 * declares those directories as markers.
 *
 * THE GATE IS THE PACK'S MARKER TABLE, IN FULL, and both halves of that matter.
 *
 *   * IT IS THE MARKER TABLE rather than the nesting, which is what keeps this
 *     from firing on every nested lane in existence. A workspace root with two
 *     member lanes under `apps/` is a nesting nen already explains a different
 *     way (the member list in `{package}`'s reason), and calling those two
 *     "native siblings" would be nonsense. A profile that names a child
 *     DIRECTORY among its own markers has said something much narrower: that
 *     the directory being there means this lane is of a particular kind.
 *   * IT IS THE TABLE IN FULL -- EVERY directory the profile names must be
 *     present as a nested lane -- because the pack's `why` is a CONJUNCTION
 *     ("`ios/` AND `android/` both present means the BARE workflow") and a note
 *     that fires on `ios/` alone quotes a sentence that is not true of the tree
 *     in front of it. A half-met conjunction is not a weaker version of the
 *     claim; it is a different tree, and nen says nothing about it.
 *
 * THE PAYLOAD IS THE DECLARED CHILDREN AND NOTHING ELSE. An unrelated lane that
 * happens to sit one directory down -- a `site/` Next.js build beside a bare
 * Expo tree -- is not generated native output, and describing it as such was
 * this note's first bug. Other nested lanes are still worth naming, so they get
 * a clause of their own that says exactly what nen knows about them: the
 * profile's markers do not name them, so nen relates them to nothing.
 *
 * WHAT THE READER GETS THAT THE LANE LIST DOES NOT ALREADY SAY: three lanes in
 * one tree read as three independent builds, and `defaultLane: null` reads as
 * nen being unable to choose. Neither is what this is. The native lanes are the
 * SAME application, generated, and the verbs that drive them may well belong on
 * the parent lane -- which is a decision, so nen states the relationship and
 * makes none of it.
 */
function nestedLaneNote(
  parent: DetectedLane,
  parentProfile: StackProfile,
  lanes: readonly DetectedLane[],
): string | null {
  const prefix = parent.cwd === "." ? "" : `${parent.cwd}/`;
  const children = lanes.filter(
    (lane): boolean =>
      lane !== parent &&
      lane.cwd.startsWith(prefix) &&
      !lane.cwd.slice(prefix.length).includes("/") &&
      lane.cwd !== parent.cwd,
  );
  const directoryMarkers = parentProfile.markers.filter((marker): boolean =>
    DIRECTORY_MARKER.test(marker.pattern),
  );
  if (directoryMarkers.length === 0) return null;
  const declared = directoryMarkers.map(
    (marker): { lane: DetectedLane | undefined; pattern: string; why: string } => ({
      lane: children.find((lane): boolean => lane.cwd.slice(prefix.length) === marker.pattern),
      pattern: marker.pattern,
      why: marker.why,
    }),
  );
  // THE CONJUNCTION, ENFORCED. One missing directory and nen says nothing:
  // the sentence this note quotes is about a tree that has them all.
  if (declared.some((entry): boolean => entry.lane === undefined)) return null;
  // The LANES are listed in the order the scan found them (byte-ordered by
  // directory), and the MARKERS in the order the pack's own table states them.
  // Both are fixed, so one tree always prints one sentence.
  const named = new Set(declared.map((entry): string => entry.pattern));
  const siblings = children.filter((lane): boolean => named.has(lane.cwd.slice(prefix.length)));
  const others = children.filter((lane): boolean => !named.has(lane.cwd.slice(prefix.length)));
  const one = siblings.length === 1;
  const unrelated =
    others.length === 0
      ? ""
      : ` nen also found ${others
          .map((lane): string => `'${lane.lane}' (${lane.stack}, cwd ${lane.cwd})`)
          .join(", ")} directly inside '${parent.lane}', and says nothing of the kind about ${
          others.length === 1 ? "it" : "them"
        }: this profile's markers do not name ${
          others.length === 1 ? "that directory" : "those directories"
        }, so nen relates ${others.length === 1 ? "it" : "them"} to nothing.`;
  return `the lane '${parent.lane}' names ${declared
    .map((entry): string => `'${entry.pattern}'`)
    .join(" AND ")} among its OWN markers, and nen found a lane in ${
    one ? "it" : "each of them"
  }: ${siblings
    .map((lane): string => `'${lane.lane}' (${lane.stack}, cwd ${lane.cwd})`)
    .join(
      ", ",
    )}. ${one ? "It is a SIBLING LANE" : "They are SIBLING LANES"} of one application rather than ${
    one ? "a separate project" : "separate projects"
  }: generated native output committed beside the manifest that generates it. nen proposes each with its own stack's rows and relates them here without merging them -- whether a verb on '${parent.lane}' should drive a native lane, and which one, is a decision this repository makes.${unrelated} The pack's own ${
    declared.length === 1 ? "reason for the marker" : "reasons for the markers"
  }: ${declared.map((entry): string => `'${entry.pattern}' -- ${entry.why}`).join(" ")}`;
}

/** The `hosts` map a set of lanes agrees on, or null when they disagree. */
function hostSignature(hosts: Readonly<Record<string, readonly string[]>>): string {
  return JSON.stringify(
    Object.entries(hosts)
      .map(([verb, platforms]): [string, readonly string[]] => [verb, platforms])
      .sort(([a], [b]): number => compareBytes(a, b)),
  );
}

/**
 * Scan, cross-check and assemble the proposal. Writes nothing.
 *
 * THE PLATFORM IS A PARAMETER, NOT A READ, and it is the one input here that
 * is about the machine rather than about the tree. `{gw}` resolves to a
 * different word on Windows, so the proposal a caller gets differs by host --
 * and a test that read `process.platform` could only ever prove that on the
 * host it happened to run on, which is the same argument ../seam/exec.ts makes
 * for every other platform decision in this repository. ./command.ts passes
 * `context.seams.platform`.
 */
export function detect(repoRoot: string, platform: NodeJS.Platform): DetectReport {
  const pack = loadProfilesPack();
  const hostStacks = hostToolStacks(pack);
  const resolved = resolveSchemaFile(repoRoot, CONTRACT_FILE);
  const { found, nestedBuilds, nearMisses } = scan(repoRoot, hostStacks, packMarkersOf(pack));
  const lanes: DetectedLane[] = [];
  const profiles = new Map<string, StackProfile>();
  const taken = new Set<string>();
  const notes: string[] = [];
  // KEPT OUT OF `DetectedLane` ON PURPOSE. Both blocks are per-LANE facts that
  // belong in the proposed document, and both are empty for every stack that
  // states no project rules -- putting them on the public per-lane shape would
  // add two always-empty fields to every `--json` reader in exchange for
  // nothing a caller of this function could not read off `proposal`.
  const toolchains = new Map<string, Readonly<Record<string, unknown>>>();
  const preconditions = new Map<string, readonly unknown[]>();

  for (const { directory, matches } of found) {
    const cwd = relativePath(repoRoot, directory);
    // ONE LANE PER STACK PER DIRECTORY, whatever the marker count. A tree with
    // both `next.config.js` and `next.config.mjs` matched twice and used to
    // become two lanes, the second with a name nobody could have predicted.
    const byStack = new Map<string, Match[]>();
    for (const match of matches) {
      const markers = byStack.get(match.stack) ?? [];
      markers.push(match);
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
      const proposed = proposeVerbs(
        pack,
        profile,
        repoRoot,
        directory,
        lane,
        platform,
        hostStacks.find((entry): boolean => entry.stack === stack),
      );
      const found = byStack.get(stack) ?? [];
      if (Object.keys(proposed.toolchain).length > 0) toolchains.set(lane, proposed.toolchain);
      if (proposed.preconditions.length > 0) preconditions.set(lane, proposed.preconditions);
      lanes.push({
        lane,
        stack,
        cwd,
        markers: found
          .filter((match): boolean => match.identifying)
          .map((match): string => match.marker),
        evidence: found
          .filter((match): boolean => !match.identifying)
          .map((match): string => match.marker),
        verbs: proposed.verbs,
        // THE EVIDENCE-ONLY MARKERS COME FIRST, because they change how the
        // rows BELOW them should be read: a seat whose quoted reason turns on a
        // file this tree actually has is the first row a maintainer should
        // distrust, and a note about it printed after eleven rows is a note
        // read too late.
        notes: [...evidenceNotes(profile, found), ...proposed.notes],
      });
    }
  }

  // The lanes a lane's OWN profile says should be there, related before the
  // generic "several lanes were found" note below reads them as rivals.
  for (const lane of lanes) {
    const profile = profiles.get(lane.lane);
    /* c8 ignore next -- every lane pushed above has its profile recorded */
    if (profile === undefined) continue;
    const note = nestedLaneNote(lane, profile, lanes);
    if (note !== null) notes.push(note);
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
  // A NESTED BUILD NEN STOPPED AT AND THEN COULD NOT PROPOSE. The refinement
  // search stops at a directory carrying its own wrapper or its own settings
  // file, because a marker inside one is evidence about THAT build; usually
  // that directory then becomes a lane of its own. When it does not -- a
  // settings file with no wrapper beside it -- the honest answer is a FINDING:
  // nen saw a build, cannot address it with any tool it can see, and says so
  // rather than attributing its build files to the lane above (which is what it
  // used to do, proposing the parent's wrapper against a build that wrapper
  // never reads).
  const laneDirectories = new Set(found.map((entry): string => entry.directory));
  const orphaned = nestedBuilds.filter((build): boolean => !laneDirectories.has(build));
  for (const build of orphaned) {
    notes.push(
      `${relativePath(repoRoot, build)} carries its own build settings, so the scan stopped there and read nothing inside it as evidence about the directory above -- and it ships no build wrapper of its own, so nen proposes no lane for it either. That is a finding, not a proposal: give it its own wrapper to have it detected as a lane, or state the lane by hand.`,
    );
  }

  // A PROJECT NEN DECLINED TO READ IS NOT AN EMPTY DIRECTORY, and from the
  // outside they used to look identical. `nearMissesIn` carries the whole
  // argument; these are the sentences it produced, reported whether or not a
  // lane was found -- a tree with one lane and a second, conditional project is
  // exactly the case where the silence is most expensive.
  for (const miss of nearMisses) {
    notes.push(`a project file nen did NOT read as a marker: ${miss}`);
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
    // THE PACK'S OWN QUALIFICATION OF THE BLOCK NEN JUST WROTE. `hosts` is a
    // machine-readable allowlist keyed by verb, and the pack states in prose
    // what that shape cannot: a managed Expo tree is written `{"*": [darwin,
    // linux, win32]}` while the pack's note says `expo run:ios` needs macOS.
    // Nen writes the row the pack states and prints the sentence beside it --
    // narrowing the row from the note would be nen deciding a platform policy
    // from prose, and dropping the note leaves the reader the row alone.
    for (const stack of [...new Set(lanes.map((lane): string => lane.stack))].sort(compareBytes)) {
      const note = profiles.get(
        lanes.find((lane): boolean => lane.stack === stack)?.lane ?? "",
      )?.hostNote;
      /* c8 ignore next -- every lane's stack has a profile, and every profile a hostNote */
      if (note === undefined || note === "") continue;
      notes.push(
        `the proposed 'hosts' block is the reference pack's own for the ${stack} stack, and it is an ALLOWLIST nen refuses to start outside -- not a claim that every platform in it can do every part of every verb. The pack's own note on the platforms: ${note}`,
      );
    }
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

  // `project.toolchain` IS PER PROJECT AND `project.preconditions` IS PER LANE,
  // which is the declaration's own shape and not this file's choice -- so two
  // lanes answering the SAME tool with different versions is an ambiguity, and
  // this file resolves none: neither is proposed, and the note names both.
  const toolchain: Record<string, unknown> = {};
  // WHICH LANE PUT EACH ENTRY THERE, kept alongside it. Without it the note
  // below could only name the lanes that ARRIVED SECOND -- "(program among
  // them)" for a disagreement between `app` and `program` -- which names one
  // side of a two-sided fact and leaves the maintainer to find the other. Both
  // sides, always, byte-ordered.
  const owner = new Map<string, string>();
  const contested = new Map<string, Set<string>>();
  for (const [lane, entries] of toolchains) {
    for (const [tool, entry] of Object.entries(entries)) {
      const prior = toolchain[tool];
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(entry)) {
        const involved = contested.get(tool) ?? new Set<string>();
        const first = owner.get(tool);
        /* c8 ignore next -- an entry is in `toolchain` only via `owner` */
        if (first !== undefined) involved.add(first);
        involved.add(lane);
        contested.set(tool, involved);
        continue;
      }
      toolchain[tool] = entry;
      owner.set(tool, lane);
    }
  }
  for (const [tool, lanesInvolved] of contested) {
    delete toolchain[tool];
    const named = [...lanesInvolved].sort(compareBytes);
    notes.push(
      `no project.toolchain entry is proposed for '${tool}': ${named.length} lanes state a version for it and they disagree (${named.join(", ")}), and project.toolchain is ONE block for the whole project rather than one per lane. nen resolves no ambiguity -- state the version this repository means.`,
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
            // ADDED ONLY WHEN THIS TREE ANSWERED SOMETHING. An empty block is
            // not a neutral one: `project.toolchain: {}` reads as "this
            // repository needs no tools", which is a claim, and every existing
            // proposal would have grown one.
            ...(Object.keys(toolchain).length === 0 ? {} : { toolchain }),
            ...(preconditions.size === 0
              ? {}
              : { preconditions: Object.fromEntries(preconditions) }),
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
      `the scan is bounded, and every bound can hide a real lane: it descends at most ${MAX_DEPTH} directories below --repo, from each lane root it looks at most ${REFINEMENT_DEPTH} directories down for the module that carries a stack's plugin, and it never enters ${[...SKIP].sort().join(", ")} -- so a lane living in a directory named like build output, or one whose application module sits deeper than ${REFINEMENT_DEPTH} directories inside it, is invisible to it by design.`,
    );
    return lines;
  }
  lines.push("");
  for (const lane of report.lanes) {
    lines.push(`  ${lane.lane}  (${lane.stack})  cwd ${lane.cwd}`);
    for (const marker of lane.markers) lines.push(`        marker: ${marker}`);
    // PRINTED APART FROM THE MARKERS, under a word that says what it is: this
    // file did not make the lane, and a reader who deletes it still has a lane.
    for (const carried of lane.evidence) lines.push(`        evidence: ${carried}`);
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
