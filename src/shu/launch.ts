// src/shu/launch.ts -- the two things a LAUNCH TARGET needs that rendering a
// plan does not: finding a device's id in whatever its declared probe printed,
// and substituting that id (and the build's artifact) into the steps that run
// after the verb exits. Pure: no seam, no filesystem, no clock, no network.
//
// THIS FILE CONTAINS NO TOOLCHAIN NAME, AND THAT IS THE POINT (./purity.test.ts).
// Nen does not know what a device probe is called on any platform, what its
// flags are, or what shape its output takes. What it knows is two SHAPES that
// every such probe's output is one of -- a JSON document, or lines of text --
// and one question to ask of either: which id belongs to the device the
// declaration named. The probe itself is `project.launch.<name>.device.resolve`,
// an ordinary `{exe, argv}` the repository states and nen spawns unchanged.
// A device may additionally declare `extract`: JSON names its record-array
// boundary and ordered fields, while text names explicit columns. With no such
// declaration this module keeps the original inference for compatibility.
//
// WHY THE MATCH IS ON A NAME AND NOTHING ELSE. A declaration says
// `"name": "<the name the developer sees in their own device list>"`, and that
// string is the whole match: no prefix matching, no "the only one connected",
// no most-recently-used. Every one of those would be nen choosing a device, and
// the device is which computer the build lands on. A name the output does not
// carry is a refusal that LISTS what the probe did offer -- which is the one
// answer that turns "it did not work" into "the phone is asleep" or "you
// renamed it".
//
// AND WHY A NAME IS NOT ENOUGH BY ITSELF. The row that carries the name also
// carries a STATE, and the two are different facts: attached is not paired,
// paired is not unlocked, present is not ready. A declaration may state which of
// the probe's own state words count (`device.readyWhen`,
// ../schema/contract.ts's `DeviceReadiness`) and this file reads that value out
// of the same two shapes it reads an id out of. It compares nothing and refuses
// nothing -- it reports what stood at the declared position, and ./run.ts is
// where the state seen is held against the states accepted.

import { posix } from "node:path";
import type { DeviceExtraction, DeviceReadiness } from "../schema/contract.js";

/** The token an `after` step writes where the resolved device id belongs. */
export const DEVICE_ID_TOKEN = "{device.id}";

/** The token an `after` step writes where the verb's first artifact belongs. */
export const ARTIFACT_TOKEN = "{artifact}";

/**
 * The two tokens THIS family substitutes, as opposed to the reference pack's
 * closed set, which it refuses (../shu/render.ts's `REFUSED_PLACEHOLDERS`).
 *
 * THE TWO SETS MUST NOT OVERLAP and ./launch.test.ts pins that they do not: a
 * token in both would be refused by one rule and substituted by the other, and
 * which one won would depend on the order two functions happen to be called in.
 */
export const LAUNCH_PLACEHOLDERS: readonly string[] = [DEVICE_ID_TOKEN, ARTIFACT_TOKEN];

/** One command, exe apart from argv -- ../shu/render.ts's `RenderedStep`. */
interface Step {
  readonly exe: string;
  readonly argv: readonly string[];
}

/** True when any of these steps writes `token` inside one of its tokens. */
export function usesToken(steps: readonly Step[], token: string): boolean {
  return steps.some((step): boolean =>
    [step.exe, ...step.argv].some((piece): boolean => piece.includes(token)),
  );
}

/**
 * Every launch token these steps name, in this file's own order, de-duplicated.
 *
 * FOR THE REFUSALS AND FOR THE DRY RUN'S `substitutes:` LINE, which is the same
 * question asked twice: a caller must be told what a run would put where, and a
 * step naming a token nothing can fill must be refused before anything spawns.
 */
export function tokensUsed(steps: readonly Step[]): readonly string[] {
  return LAUNCH_PLACEHOLDERS.filter((token): boolean => usesToken(steps, token));
}

/**
 * Replace both tokens throughout a set of steps.
 *
 * SUBSTITUTION IS WHOLE-TOKEN AND EVERYWHERE IT APPEARS, including inside a
 * longer argument (`--device={device.id}` and `path/{artifact}` are both real
 * shapes), and it never splits one argv element into two: an id carrying a
 * space would stay one argument, because the argv is a LIST and nothing here
 * ever joins it into a string.
 *
 * A value of `null` LEAVES ITS TOKEN ALONE, which is what a dry run wants: the
 * printed step shows `{device.id}` unfilled, because nothing was probed and nen
 * does not print a value it did not read.
 */
export function substituteSteps<T extends Step>(
  steps: readonly T[],
  values: { readonly deviceId: string | null; readonly artifact: string | null },
): readonly T[] {
  const fill = (piece: string): string => {
    let out = piece;
    if (values.deviceId !== null) out = out.split(DEVICE_ID_TOKEN).join(values.deviceId);
    if (values.artifact !== null) out = out.split(ARTIFACT_TOKEN).join(values.artifact);
    return out;
  };
  // GENERIC, AND SPREAD RATHER THAN REBUILT, so a step that carries MORE than
  // an exe and an argv keeps it. `../shu/render.ts`'s step also says where its
  // stdout goes, and a substitution that rebuilt the object from two fields
  // would silently turn a declared file write back into terminal output.
  return steps.map((step): T => ({ ...step, exe: fill(step.exe), argv: step.argv.map(fill) }));
}

/**
 * A repo-relative artifact path, AS THE AFTER-STEPS' OWN DIRECTORY SEES IT.
 *
 * TWO ROOTS, ONE STRING -- and this function is where they stop disagreeing. A
 * declaration states every path relative to the REPOSITORY ROOT (`artifacts`,
 * `project.launch.<name>.artifact`, and every containment check nen makes), but
 * an after-step is spawned with its cwd set to the LANE'S directory. On a lane
 * whose `cwd` is the root the two are the same string and always were; on a lane
 * one directory down, substituting the declared string handed the installer a
 * path that resolved against the wrong root -- `<repo>/native/build/App.app` for
 * a declaration that plainly means `<repo>/build/App.app` -- and the child
 * answered "no such file" about a file that was sitting there.
 *
 * RELATIVE, NOT ABSOLUTE, and that is the choice worth stating. An absolute path
 * would also resolve correctly, and it would change what EVERY existing launch
 * target spawns: a declaration written against v0.4.0 would suddenly print and
 * pass `/Users/somebody/code/repo/build/App.app` where it had always printed
 * `build/App.app`. Relative to the step's own cwd, a lane at the root -- which
 * is nearly all of them -- gets back the identical string, byte for byte, and
 * only the lanes that were broken change.
 *
 * POSIX ARITHMETIC ON TWO REPO-RELATIVE STRINGS, so it is pure: no filesystem,
 * no repository root, and the same answer on all three platforms this project's
 * CI runs. The result is forward-slashed for the reason the declaration is --
 * that is the separator both a declaration and every one of these toolchains
 * accept, and a backslash would make the same lane render differently on one OS.
 */
export function artifactAsSeenFrom(cwdRelative: string, artifact: string): string {
  // `normalize` IS WHAT MAKES AN EMPTY `cwd` THE ROOT rather than a special
  // case: it answers "." for "", for "." and for "./", so the three spellings a
  // lane may use for the repository root all take the same path through here.
  const from = posix.normalize(cwdRelative.split("\\").join("/"));
  const to = posix.normalize(artifact.split("\\").join("/"));
  const relative = posix.relative(from, to);
  // AN ARTIFACT AT THE CWD ITSELF is the one case `relative` answers with the
  // empty string, and handing an installer an empty argument is the failure
  // `project.launch.<name>.artifact`'s own empty-string refusal exists to
  // prevent. `.` is what that path means from where the step stands.
  return relative === "" ? "." : relative;
}

/**
 * What a probe's output said about one device.
 *
 * THREE OUTCOMES, NOT TWO, and the third is the one a two-state answer gets
 * wrong: a probe that NAMED the device and carried no id nen recognises is not
 * the same fact as a probe that did not name it at all, and telling the first
 * reader "it is not among the devices the probe saw" would be nen contradicting
 * output the reader can see on their own screen.
 */
export interface DeviceLookup {
  /** Why a declared extraction could not read the probe output. */
  readonly malformed?: string;
  /** Declared records, rather than inferred names/lines, caused the ambiguity. */
  readonly duplicateRecords?: boolean;
  /** The probe's output named this device. */
  readonly found: boolean;
  /** Its id, or null when the output named it and carried no id. */
  readonly id: string | null;
  /**
   * The competing candidates when MORE THAN ONE carried the name, and empty
   * otherwise. Non-empty means nen resolved nothing on purpose.
   *
   * THE FOURTH OUTCOME, AND IT IS THE ONE A SUBSTRING MATCH MAKES POSSIBLE.
   * JSON is compared whole (`node.name === name`), but plain output has no
   * field boundaries to compare against -- a line is a line -- so a declared
   * `Handset` is carried by the `Handset Pro` row exactly as it is by the
   * `Handset` row. Taking the first would resolve a DIFFERENT DEVICE and say
   * nothing, which is the one failure this whole file exists to prevent. Two
   * candidates that both offer an id are therefore a refusal listing both, and
   * the same rule covers the JSON shape where two objects share one name.
   */
  readonly ambiguous: readonly string[];
  /**
   * What stood at the declared readiness position on this device's own row, or
   * null -- when the declaration states no rule, when nothing stood there, and
   * when the match was ambiguous enough that "this device's row" names two.
   *
   * IT IS A READING, NOT A VERDICT. This file compares it against nothing: the
   * accepted set is the declaration's and the refusal is ./run.ts's, because a
   * refusal has to name a pointer and this module knows no pointers. What it
   * contributes is the one thing only a reader of the probe's output can say --
   * the word the probe actually printed there.
   */
  readonly readiness: string | null;
  /** What the probe offered instead: every device NAME, or its own LINES. */
  readonly saw: readonly string[];
  readonly sawKind: "names" | "lines";
}

function scalarAtPath(node: Record<string, unknown>, path: string): string | null {
  return atPath(node, path);
}

function firstAtPaths(node: Record<string, unknown>, paths: readonly string[]): string | null {
  for (const path of paths) {
    const value = scalarAtPath(node, path);
    if (value !== null && value !== "") return value;
  }
  return null;
}

function declaredJson(
  name: string,
  text: string,
  extraction: Extract<DeviceExtraction, { format: "json" }>,
): DeviceLookup {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (error) {
    return { found: false, id: null, ambiguous: [], readiness: null, saw: [], sawKind: "names", malformed: `expected JSON but could not parse it: ${error instanceof Error ? error.message : String(error)}` };
  }
  let records: unknown = document;
  for (const segment of extraction.records.split(".")) {
    if (!isRecord(records)) {
      return { found: false, id: null, ambiguous: [], readiness: null, saw: [], sawKind: "names", malformed: `record path '${extraction.records}' does not lead to an array` };
    }
    records = records[segment];
  }
  if (!Array.isArray(records)) {
    return { found: false, id: null, ambiguous: [], readiness: null, saw: [], sawKind: "names", malformed: `record path '${extraction.records}' does not lead to an array` };
  }
  if (records.some((record): boolean => !isRecord(record))) {
    return { found: false, id: null, ambiguous: [], readiness: null, saw: [], sawKind: "names", malformed: `record path '${extraction.records}' contains a value that is not an object` };
  }
  const rows = (records as Record<string, unknown>[]).map((record) => ({
    name: firstAtPaths(record, extraction.name),
    id: firstAtPaths(record, extraction.identifier),
    readiness: firstAtPaths(record, extraction.readiness),
  }));
  const nameless = rows.findIndex((row): boolean => row.name === null);
  if (nameless !== -1) {
    return {
      found: false,
      id: null,
      ambiguous: [],
      readiness: null,
      saw: [],
      sawKind: "names",
      malformed: `record ${nameless + 1} under '${extraction.records}' has no scalar name at ${extraction.name.map((path): string => `'${path}'`).join(", then ")}`,
    };
  }
  const saw = [...new Set(rows.flatMap((row): readonly string[] => row.name === null ? [] : [row.name]))].sort();
  const matching = rows.filter((row): boolean => row.name === name);
  if (matching.length === 0) return { found: false, id: null, ambiguous: [], readiness: null, saw, sawKind: "names" };
  if (matching.length > 1) {
    return {
      found: true,
      id: null,
      ambiguous: matching.map((row, index): string =>
        `matching record ${index + 1}: ${row.id === null ? "no identifier" : `identifier '${row.id}'`}`,
      ),
      readiness: null,
      saw,
      sawKind: "names",
      duplicateRecords: true,
    };
  }
  const only = matching[0];
  return { found: true, id: only?.id ?? null, ambiguous: [], readiness: only?.readiness ?? null, saw, sawKind: "names" };
}

function declaredText(
  name: string,
  text: string,
  extraction: Extract<DeviceExtraction, { format: "text" }>,
): DeviceLookup {
  const lines = linesOf(text);
  const rows = lines.map((line) => {
    const fields = line.split(/\s+/).filter((field): boolean => field !== "");
    return { line, name: fields[extraction.name - 1] ?? null, id: fields[extraction.identifier - 1] ?? null, readiness: extraction.readiness === null ? null : fields[extraction.readiness - 1] ?? null };
  });
  const matching = rows.filter((row): boolean => row.name === name);
  if (matching.length === 0) return { found: false, id: null, ambiguous: [], readiness: null, saw: lines, sawKind: "lines" };
  if (matching.length > 1) {
    return { found: true, id: null, ambiguous: matching.map((row) => row.line), readiness: null, saw: lines, sawKind: "lines", duplicateRecords: true };
  }
  const only = matching[0];
  return { found: true, id: only?.id ?? null, ambiguous: [], readiness: only?.readiness ?? null, saw: lines, sawKind: "lines" };
}

/**
 * The keys an id is read from, IN PRIORITY ORDER, and the reason there are four.
 *
 * A device probe's JSON is somebody else's schema, and the four spellings below
 * are what the ecosystems this family serves actually use for "the string you
 * pass back to address this device". They are a CLOSED set on purpose: reading
 * "whatever other string key sits beside the name" would pick a model number, a
 * build version or an owner's name on the first probe whose object is shaped
 * differently, and nen would then address the wrong device with total
 * confidence. A probe whose id key is none of these is a refusal saying so.
 */
const ID_KEYS: readonly string[] = ["identifier", "id", "udid", "serial"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first id key this object carries itself, as a string. */
function idOn(node: Record<string, unknown>): string | null {
  for (const key of ID_KEYS) {
    const value = node[key];
    if (typeof value === "string" && value !== "") return value;
    // A NUMBER IS AN ID TOO, and it is rendered rather than refused: a probe
    // that numbers its devices states a fact nen can pass back. What is NOT
    // accepted is an object or a list under an id key -- that is a shape nen
    // would have to guess its way into.
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/**
 * An id ON this object, or on one of its DIRECT object children.
 *
 * THE ONE STEP DOWNWARD IS WHAT MAKES REAL PROBE OUTPUT READABLE. The flat
 * shape -- `{"name": ..., "udid": ...}` -- needs no step at all; the shape the
 * larger toolchains print puts the name in one sub-object and the id in its
 * sibling, so the two are cousins rather than siblings. One level, never a full
 * subtree walk: a walk would happily take the id of a DIFFERENT device out of
 * the same array and report it as this one's.
 */
function idNear(node: Record<string, unknown>): string | null {
  const own = idOn(node);
  if (own !== null) return own;
  for (const value of Object.values(node)) {
    if (!isRecord(value)) continue;
    const nested = idOn(value);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * How far above the matching object nen will look for its id.
 *
 * TWO, AND IT IS A BOUND RATHER THAN A DEPTH LIMIT. One ancestor covers every
 * shape seen in the field (the name in a sub-object, the id in its sibling);
 * the second is slack for one more wrapper. Above that, the enclosing object is
 * the LIST of devices or the response envelope, and an id found there belongs
 * to something else entirely -- which is the one mistake this whole file is
 * written to avoid.
 */
const ANCESTOR_LIMIT = 2;

/** Every `name` string anywhere in a parsed document, in encounter order. */
function namesIn(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) namesIn(item, found);
    return found;
  }
  if (!isRecord(node)) return found;
  const name = node["name"];
  if (typeof name === "string" && name !== "") found.push(name);
  for (const value of Object.values(node)) namesIn(value, found);
  return found;
}

/**
 * A dotted key path read off one object, as a string, or null.
 *
 * THE SAME CLOSED IDEA AS `idOn`: it walks the segments the declaration wrote
 * and nothing else -- no wildcards, no searching, no "the first key that looks
 * like a state". A scalar at the end of the path is rendered (a boolean and a
 * number are both real shapes for "is this usable"); an object or a list there
 * is NOT, because a rule comparing `[object Object]` against a word would refuse
 * every device forever while looking like it was working.
 */
function atPath(node: Record<string, unknown>, path: string): string | null {
  let here: unknown = node;
  for (const segment of path.split(".")) {
    if (!isRecord(here)) return null;
    here = here[segment];
  }
  if (typeof here === "string") return here;
  if (typeof here === "number" && Number.isFinite(here)) return String(here);
  if (typeof here === "boolean") return String(here);
  return null;
}

/**
 * The readiness value for a matched object, ON IT or on one of its ancestors.
 *
 * IT WALKS EXACTLY AS FAR AS THE ID DOES, and deliberately shares
 * `ANCESTOR_LIMIT` rather than keeping a bound of its own. The shape that makes
 * the walk necessary is one shape: the name in a sub-object, everything else in
 * its siblings. A readiness rule that stopped at the matched object would be
 * unreadable on exactly the documents whose ids are already read from above it,
 * and a rule that walked FURTHER would read the state of the enclosing list.
 */
function readinessNear(
  node: Record<string, unknown>,
  ancestors: readonly Record<string, unknown>[],
  path: string,
): string | null {
  const own = atPath(node, path);
  if (own !== null) return own;
  for (const ancestor of ancestors.slice(-ANCESTOR_LIMIT).reverse()) {
    const above = atPath(ancestor, path);
    if (above !== null) return above;
  }
  return null;
}

/** One object whose own `name` matched: what it resolves to, and its state. */
interface JsonMatch {
  readonly id: string | null;
  readonly readiness: string | null;
}

/**
 * EVERY object whose own `name` is `name`, as the id each one resolves to
 * (`null` where that object offers none) and the state each one reports, in
 * encounter order.
 *
 * IT COLLECTS RATHER THAN STOPPING AT THE FIRST, and the difference is a wrong
 * device rather than a slow one: two objects sharing one name is a real shape
 * (the same simulator name under two runtimes, the same handset seen over two
 * transports) and the FIRST of them is not more correct than the second. What
 * comes back is every candidate, so the caller can refuse rather than pick.
 *
 * THE STATE IS READ WHERE THE MATCH IS MADE, because that is the one place both
 * the matched object and its ancestors are in hand. Reading it afterwards would
 * mean walking the document a second time to find the same object again, and
 * the second walk is exactly where the two readings could disagree.
 */
function matchesForName(
  node: unknown,
  name: string,
  ancestors: readonly Record<string, unknown>[],
  found: JsonMatch[],
  ready: DeviceReadiness | null,
): JsonMatch[] {
  if (Array.isArray(node)) {
    for (const item of node) matchesForName(item, name, ancestors, found, ready);
    return found;
  }
  if (!isRecord(node)) return found;
  if (node["name"] === name) {
    const readiness =
      ready === null || ready.path === null ? null : readinessNear(node, ancestors, ready.path);
    const here = idNear(node);
    if (here !== null) {
      found.push({ id: here, readiness });
      return found;
    }
    for (const ancestor of ancestors.slice(-ANCESTOR_LIMIT).reverse()) {
      const above = idNear(ancestor);
      if (above !== null) {
        found.push({ id: above, readiness });
        return found;
      }
    }
    // FOUND, WITH NO ID: `null` rather than nothing at all, and the difference
    // is the third outcome `DeviceLookup` exists for. Dropping it would end as
    // "no such device", a sentence contradicting what the reader can see.
    found.push({ id: null, readiness });
    return found;
  }
  for (const value of Object.values(node)) {
    matchesForName(value, name, [...ancestors, node], found, ready);
  }
  return found;
}

/** Punctuation a probe wraps an id in. Stripped from both ends of a token. */
const WRAPPER = /^[([{'"]+|[)\]}'",;.]+$/g;

/** What an id looks like: long, alphanumeric-ish, and carrying a digit. */
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,}$/;

/**
 * The id on a plain-text line, and the rule stated in full because it is a
 * guess nen makes and every guess this family makes has to be printable.
 *
 * THE LINE IS THE ONE CONTAINING THE DECLARED NAME, verbatim and
 * case-sensitively -- a device name is the developer's own string and nen does
 * not decide that two spellings of it are the same thing. On that line, the id
 * is THE FIRST whitespace-delimited token that
 *
 *   * is not one of the name's own words (so a name carrying a serial-shaped
 *     word does not answer with a piece of itself),
 *   * survives having wrapping brackets and quotes stripped,
 *   * is at least six characters of letters, digits, `.`, `_`, `:` and `-`,
 *   * and carries at least one DIGIT.
 *
 * The digit is what separates an id from a status word: a row's trailing
 * `available` or `connected` is longer than six characters and would otherwise
 * be read as an id. A probe whose line offers no such token is a refusal saying
 * the name matched and the id did not -- never a silent wrong device.
 */
function idOnLine(line: string, name: string): string | null {
  const own = new Set(name.toLowerCase().split(/\s+/).filter((word): boolean => word !== ""));
  own.add(name.toLowerCase());
  for (const raw of line.split(/\s+/)) {
    const token = raw.replace(WRAPPER, "");
    if (token === "" || own.has(token.toLowerCase())) continue;
    if (!ID_SHAPE.test(token) || !/[0-9]/.test(token)) continue;
    return token;
  }
  return null;
}

/**
 * The whitespace-separated token at a 1-BASED field position on one line.
 *
 * COUNTED FROM ONE, which is the one arithmetic decision in this file that a
 * reader could reasonably expect to go the other way. It counts the way every
 * column-oriented tool on a terminal counts -- the row's first token is field 1
 * -- because the person writing `readyWhen` is reading the probe's own output
 * off their screen and counting across it, not indexing an array they cannot
 * see. ../schema/contract.ts refuses a `field` below 1 at load, so a
 * zero-indexed declaration is a refusal naming the key rather than a silent
 * off-by-one that reads the serial as a state.
 */
function fieldOnLine(line: string, field: number): string | null {
  const tokens = line.split(/\s+/).filter((token): boolean => token !== "");
  return tokens[field - 1] ?? null;
}

/** Every non-empty trimmed line, for the refusal that has no names to list. */
function linesOf(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line): string => line.trim())
    .filter((line): boolean => line !== "");
}

/**
 * ONE state, out of every reading the matching rows offered, or null.
 *
 * AGREEMENT OR NOTHING, and the rule is `findDevice`'s own "nen picks neither"
 * applied to the second fact a row carries. A name can be matched by more than
 * one row without that being an id AMBIGUITY -- the same device described twice
 * is one device, and rows carrying no id at all are not competing candidates --
 * but "this device's state" still names two values whenever those rows disagree,
 * and answering with the first would refuse (or permit) a launch on a row nen
 * chose. Readings that are absent are not disagreement: a row that carried
 * nothing at the declared position says nothing, and one that did says it.
 */
function agreedReading(values: readonly (string | null)[]): string | null {
  // DESTRUCTURED RATHER THAN COUNTED, so every arm below is one a test can
  // reach: nothing read (`only` undefined -- an empty position, or no rule's
  // shape matched), one thing read, and two that disagree.
  const [only, second] = [...new Set(values.filter((value): value is string => value !== null))];
  return second === undefined ? (only ?? null) : null;
}

/**
 * Find one device's id in whatever its declared probe printed.
 *
 * JSON FIRST, TEXT SECOND, AND THE PROBE DECIDES WHICH -- not the declaration
 * and not a flag. Output that parses as JSON is read as JSON; everything else
 * is read as lines. There is no `format` key for a repository to get wrong, and
 * a probe that changes its own output shape between releases changes nothing
 * here.
 *
 * `ready` IS OPTIONAL AND CHANGES NOTHING WHEN ABSENT. It decides only what
 * `DeviceLookup.readiness` carries; the id, the ambiguity and the "what the
 * probe saw" listing are the same answers they were before the key existed. A
 * rule stating the position for the OTHER shape -- a `field` against a JSON
 * probe, a `path` against a plain one -- reads nothing rather than guessing, and
 * ./run.ts refuses with the rule quoted, which is a refusal a reader can act on.
 */
export function findDevice(
  name: string,
  stdout: string,
  ready: DeviceReadiness | null = null,
  extraction: DeviceExtraction | null = null,
): DeviceLookup {
  const text = stdout.replace(/\r\n/g, "\n");
  if (extraction?.format === "json") return declaredJson(name, text, extraction);
  if (extraction?.format === "text") return declaredText(name, text, extraction);
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    document = undefined;
  }
  if (document !== undefined && (isRecord(document) || Array.isArray(document))) {
    const saw = [...new Set(namesIn(document))].sort();
    const candidates = matchesForName(document, name, [], [], ready);
    if (candidates.length === 0) {
      return { found: false, id: null, ambiguous: [], readiness: null, saw, sawKind: "names" };
    }
    const ids = [...new Set(candidates.flatMap((match): readonly string[] => (match.id === null ? [] : [match.id])))];
    // TWO OBJECTS, ONE NAME, TWO IDS: nen picks neither. One id reached twice
    // is not an ambiguity -- it is the same device described twice, which some
    // probes do -- so the set is what decides, not the count of matches.
    //
    // AND THE READINESS GOES WITH IT: two candidates are two rows, so "this
    // device's state" names two values, and reporting either would be nen
    // choosing. The caller refuses the ambiguity first in any case.
    if (ids.length > 1) {
      return { found: true, id: null, ambiguous: ids, readiness: null, saw, sawKind: "names" };
    }
    return {
      found: true,
      id: ids[0] ?? null,
      ambiguous: [],
      readiness: agreedReading(candidates.map((match): string | null => match.readiness)),
      saw,
      sawKind: "names",
    };
  }
  const lines = linesOf(text);
  const matching = lines.filter((line): boolean => line.includes(name));
  if (matching.length === 0) {
    return { found: false, id: null, ambiguous: [], readiness: null, saw: lines, sawKind: "lines" };
  }
  // THE LINES THAT ACTUALLY OFFER AN ID ARE THE CANDIDATES, and the narrowing
  // is what keeps this usable. A probe that prints a summary line naming the
  // device above its table carries the name TWICE and means one device; only
  // the table row offers an id, so there is one candidate and no ambiguity.
  // Two rows that BOTH offer an id are two devices, and one of them is a
  // longer name this one is a prefix of -- which is exactly the case a plain
  // `includes` cannot tell apart and must therefore not resolve.
  const withIds = matching.flatMap((line): readonly string[] => {
    const id = idOnLine(line, name);
    return id === null ? [] : [line];
  });
  if (withIds.length > 1) {
    return { found: true, id: null, ambiguous: withIds, readiness: null, saw: lines, sawKind: "lines" };
  }
  const only = withIds[0];
  // WHICH ROWS THE STATE IS READ FROM. The row the id came off, when one line
  // offered one -- that line IS the device's row and the narrowing above has
  // already said so. When NO line offered an id, every line carrying the name
  // is a candidate and they have to AGREE: a device whose state is the reason
  // it is unusable routinely prints a row with no id on it (answering "the
  // probe gave nen no id" about a phone showing an unanswered pairing prompt is
  // the true sentence that helps least), but two such rows disagreeing about
  // the state is two answers, and nen reports neither.
  const rows = only === undefined ? matching : [only];
  const field = ready === null ? null : ready.field;
  return {
    found: true,
    id: only === undefined ? null : idOnLine(only, name),
    ambiguous: [],
    readiness:
      field === null
        ? null
        : agreedReading(rows.map((line): string | null => fieldOnLine(line, field))),
    saw: lines,
    sawKind: "lines",
  };
}
