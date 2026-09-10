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
//
// WHY THE MATCH IS ON A NAME AND NOTHING ELSE. A declaration says
// `"name": "<the name the developer sees in their own device list>"`, and that
// string is the whole match: no prefix matching, no "the only one connected",
// no most-recently-used. Every one of those would be nen choosing a device, and
// the device is which computer the build lands on. A name the output does not
// carry is a refusal that LISTS what the probe did offer -- which is the one
// answer that turns "it did not work" into "the phone is asleep" or "you
// renamed it".

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
export function substituteSteps(
  steps: readonly Step[],
  values: { readonly deviceId: string | null; readonly artifact: string | null },
): readonly Step[] {
  const fill = (piece: string): string => {
    let out = piece;
    if (values.deviceId !== null) out = out.split(DEVICE_ID_TOKEN).join(values.deviceId);
    if (values.artifact !== null) out = out.split(ARTIFACT_TOKEN).join(values.artifact);
    return out;
  };
  return steps.map((step): Step => ({ exe: fill(step.exe), argv: step.argv.map(fill) }));
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
  /** What the probe offered instead: every device NAME, or its own LINES. */
  readonly saw: readonly string[];
  readonly sawKind: "names" | "lines";
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
 * EVERY object whose own `name` is `name`, as the id each one resolves to
 * (`null` where that object offers none), in encounter order.
 *
 * IT COLLECTS RATHER THAN STOPPING AT THE FIRST, and the difference is a wrong
 * device rather than a slow one: two objects sharing one name is a real shape
 * (the same simulator name under two runtimes, the same handset seen over two
 * transports) and the FIRST of them is not more correct than the second. What
 * comes back is every candidate, so the caller can refuse rather than pick.
 */
function idsForName(
  node: unknown,
  name: string,
  ancestors: readonly Record<string, unknown>[],
  found: (string | null)[],
): (string | null)[] {
  if (Array.isArray(node)) {
    for (const item of node) idsForName(item, name, ancestors, found);
    return found;
  }
  if (!isRecord(node)) return found;
  if (node["name"] === name) {
    const here = idNear(node);
    if (here !== null) {
      found.push(here);
      return found;
    }
    for (const ancestor of ancestors.slice(-ANCESTOR_LIMIT).reverse()) {
      const above = idNear(ancestor);
      if (above !== null) {
        found.push(above);
        return found;
      }
    }
    // FOUND, WITH NO ID: `null` rather than nothing at all, and the difference
    // is the third outcome `DeviceLookup` exists for. Dropping it would end as
    // "no such device", a sentence contradicting what the reader can see.
    found.push(null);
    return found;
  }
  for (const value of Object.values(node)) idsForName(value, name, [...ancestors, node], found);
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

/** Every non-empty trimmed line, for the refusal that has no names to list. */
function linesOf(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line): string => line.trim())
    .filter((line): boolean => line !== "");
}

/**
 * Find one device's id in whatever its declared probe printed.
 *
 * JSON FIRST, TEXT SECOND, AND THE PROBE DECIDES WHICH -- not the declaration
 * and not a flag. Output that parses as JSON is read as JSON; everything else
 * is read as lines. There is no `format` key for a repository to get wrong, and
 * a probe that changes its own output shape between releases changes nothing
 * here.
 */
export function findDevice(name: string, stdout: string): DeviceLookup {
  const text = stdout.replace(/\r\n/g, "\n");
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    document = undefined;
  }
  if (document !== undefined && (isRecord(document) || Array.isArray(document))) {
    const saw = [...new Set(namesIn(document))].sort();
    const candidates = idsForName(document, name, [], []);
    if (candidates.length === 0) return { found: false, id: null, ambiguous: [], saw, sawKind: "names" };
    const ids = [...new Set(candidates.filter((id): id is string => id !== null))];
    // TWO OBJECTS, ONE NAME, TWO IDS: nen picks neither. One id reached twice
    // is not an ambiguity -- it is the same device described twice, which some
    // probes do -- so the set is what decides, not the count of matches.
    if (ids.length > 1) return { found: true, id: null, ambiguous: ids, saw, sawKind: "names" };
    return { found: true, id: ids[0] ?? null, ambiguous: [], saw, sawKind: "names" };
  }
  const lines = linesOf(text);
  const matching = lines.filter((line): boolean => line.includes(name));
  if (matching.length === 0) return { found: false, id: null, ambiguous: [], saw: lines, sawKind: "lines" };
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
    return { found: true, id: null, ambiguous: withIds, saw: lines, sawKind: "lines" };
  }
  const only = withIds[0];
  return {
    found: true,
    id: only === undefined ? null : idOnLine(only, name),
    ambiguous: [],
    saw: lines,
    sawKind: "lines",
  };
}
