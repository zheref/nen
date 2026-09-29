// src/schema/repos.ts -- the consuming-repository registry, read from the TARGET
// repository's `nen/repos.json`.
//
// WHAT IT IS FOR. The registry records, factually, which repositories consume
// this one's reusable machinery, what version each is pinned to, and which
// product code (`KP`, `KN`, ...) names it. Two things downstream need it: the
// affected-set computation for a release fan-out (which consumers intersect a
// changed file set), and the product-code lookup that turns `KP#460` into a
// repository. Both are pure functions of this file, so both belong on the far
// side of a validating loader rather than in a jq expression.
//
// PRODUCT CODES ARE DATA, INCLUDING THE CODES THEMSELVES. `BC`, `KP`, `KN` and
// the rest are keys of `product_codes` in the target repo's file; this module
// has no opinion about which exist. That is the whole §3 discipline applied to
// the one place it is most tempting to cheat -- a two-letter code feels like a
// constant, and it is exactly the kind of constant that makes a binary
// unusable against the next repository.
//
// THE OPTIONAL FIELDS ARE OPTIONAL ON PURPOSE. `pinned`, `scenario`, `auth`,
// `notes` and the per-caller pin overrides are absent for legitimate reasons in
// a live registry, and a loader that required them would refuse to read a
// perfectly valid file. `repo` and `consumes` are required, because an entry
// that names no repository or reports no consumption is invisible to the
// affected-set computation -- which is precisely how a consumer silently sits
// several tags behind.

import { requireArray, requireRecord, requireString, SchemaError } from "./errors.js";
import { optionalString } from "./errors.js";
import { readSchemaJson, REPOS_FILE } from "./source.js";

export interface ConsumerEntry {
  /** `owner/name`. */
  readonly repo: string;
  /** The baseline tag this consumer's callers reference. `null` when unrecorded. */
  readonly pinned: string | null;
  /** Reusable-workflow basenames this consumer's default branch calls. */
  readonly consumes: readonly string[];
  readonly scenario: string | null;
  readonly phases: readonly string[];
  readonly auth: string | null;
  readonly notes: string | null;
  /** The short product code, when the registry assigns one. */
  readonly code: string | null;
  /**
   * Per-caller pin overrides, keyed by the raw field name (`db_migrate_pinned`,
   * ...). Kept RAW rather than modelled: the set of callers is the target
   * repository's business, and enumerating them here would be this binary
   * learning another repository's workflow names.
   */
  readonly callerPins: Readonly<Record<string, string>>;
}

/** The two sections that record a repository WITHOUT listing it as a consumer. */
export type ListedSection = "maintained_tools" | "pending_onboarding";

/**
 * One `maintained_tools[]` or `pending_onboarding[]` row: the slug, the
 * section it came from, and the one further field nen reads off it.
 *
 * `scenario` IS MODELLED HERE FOR THE SAME REASON IT IS ON A CONSUMER: it is
 * the value canon-resolve and the quality-tooling lookups read to pick a
 * handbook and a tool set, so it is a fact nen acts on rather than prose.
 * A registry's own tool repositories consume nothing -- `zheref/nen` does not
 * consume `zheref/nen` -- so while only a consumers[] entry could carry one,
 * neither tool repository could ever resolve a pinned handbook, and the only
 * way to give one a scenario was to record a false consumption
 * (zheref/nen#219). The rest of the row (`role`, `status`, `reason`, ...)
 * stays unmodelled, on the discipline that keeps `callerPins` raw.
 */
export interface ListedEntry {
  /** `owner/name`. */
  readonly repo: string;
  readonly section: ListedSection;
  /**
   * The row's position inside its own section, so a message can name it by
   * pointer (`maintained_tools[1]`). Two rows of one section may name the same
   * repository -- this loader does not refuse that -- and a label without the
   * index would print them identically.
   */
  readonly index: number;
  /** The scenario this row records. `null` when the row states none. */
  readonly scenario: string | null;
}

export interface RepoRegistry {
  readonly path: string;
  /** Newest tag of the registry's own repository, as recorded. */
  readonly latest: string | null;
  readonly consumers: readonly ConsumerEntry[];
  /** `code -> full name`, exactly as the file states it. */
  readonly productCodes: Readonly<Record<string, string>>;
  /**
   * `owner/name` slugs listed under `maintained_tools`, in file order.
   *
   * REPOSITORIES THE REGISTRY RECORDS WITHOUT LISTING AS CONSUMERS. A live
   * registry names repositories in two more places than `consumers[]`: its own
   * maintained tooling repos (`maintained_tools`) and repos slated to adopt
   * the machinery that have not yet (`pending_onboarding`). Both exist
   * precisely BECAUSE those repos are not consumers -- so a token resolution
   * that stops at `consumers[]` refuses a repository the file plainly records,
   * which is how five independent skill ports each rediscovered that the
   * registry's own source repo "is not in this registry" (zheref/nen#27).
   *
   * ONLY THE SLUG IS IN THIS LIST -- with the two exceptions `toolPins` and
   * `listed` state. Each entry carries more (`role`, `status`, `reason`, ...),
   * and that prose is the target repository's business, on the same
   * discipline that keeps `callerPins` raw: the slug is the one fact token
   * resolution needs, and modelling the rest would be this binary learning
   * another repository's onboarding vocabulary. The two further fields nen
   * DOES act on -- the canon `pinned` tag and the `scenario` -- are on
   * `toolPins` and `listed`, below.
   */
  readonly maintainedTools: readonly string[];
  /** `owner/name` slugs listed under `pending_onboarding`, in file order. See `maintainedTools`. */
  readonly pendingOnboarding: readonly string[];
  /**
   * Every `maintained_tools` row, then every `pending_onboarding` row, in file
   * order, each with the `scenario` it states (zheref/nen#219). The two slug
   * lists above are this list's `repo` column, kept as they were because
   * every other reader wants exactly a slug list and nothing more.
   *
   * OPTIONAL IN THE TYPE, ALWAYS SET BY THE LOADER. parseRepoRegistry() fills
   * it on every registry it returns; the `?` exists for a registry assembled
   * by hand -- a test double that models only the consumers a fan-out reads
   * -- which predates the field and records no listed row that could state a
   * scenario. A reader treats its absence as exactly that: no row outside
   * consumers[] states one.
   */
  readonly listed?: readonly ListedEntry[];
  /**
   * `owner/name` -> the tag a `maintained_tools` entry records as `pinned`,
   * for the entries that record one. THE CANON PIN (CON-13): a consumer
   * repository mirrors the canonical handbooks repository at a TAG, and that
   * tag has to be data a sync (`nen canon mirror`) and a drift check can
   * read, not prose in a `$comment`. It lives on the `maintained_tools` entry
   * because that is where a canon repository is recorded: a `consumers[]`
   * entry classifies as a consumer at G2 (../repo/classify.ts), a canon
   * repository stands at G4, and `maintained_tools` is the list whose entries
   * classify as canon. The same `pinned` spelling `consumers[]` uses, so a
   * reader meets one word for one idea.
   */
  readonly toolPins: Readonly<Record<string, string>>;
  byRepo(repo: string): ConsumerEntry | undefined;
  byCode(code: string): ConsumerEntry | undefined;
  /** Consumers whose `consumes` intersects `changed`. Order is the file's. */
  affectedBy(changed: readonly string[]): readonly ConsumerEntry[];
}

const CALLER_PIN_SUFFIX = "_pinned";

// One of the non-consumer repository lists (`maintained_tools`,
// `pending_onboarding`). ABSENT IS FINE -- both sections are newer than many
// registries and a loader that required them would refuse a perfectly valid
// file -- but an entry that IS present must name an `owner/name` repo, for the
// same reason a consumer must: an entry without one records nothing a
// resolution (or a reader) can act on, and these lists exist to record exactly
// the owner that `product_codes`' bare values omit.
//
// `scenario` IS VALIDATED EXACTLY AS A CONSUMER'S IS -- optional, and a string
// when present -- because the lookup that reads it (../repo/scenario.ts) reads
// the three sections as one source. A number or an object there used to pass
// unread, since nothing consulted the field; now that a lookup acts on it, a
// malformed one is refused by pointer rather than read as "no scenario".
interface ListedRepo extends ListedEntry {
  /** The entry's `pinned` tag, when it records one (a canon pin -- see `RepoRegistry.toolPins`). */
  readonly pinned: string | null;
}

function parseListedRepos(path: string, section: ListedSection, raw: unknown): readonly ListedRepo[] {
  if (raw === undefined || raw === null) return [];
  return requireArray(path, section, raw).map((entry, index): ListedRepo => {
    const pointer = `${section}[${index}]`;
    const record = requireRecord(path, pointer, entry);
    const repo = requireString(path, `${pointer}.repo`, record["repo"]);
    if (!repo.includes("/")) {
      throw new SchemaError(
        path,
        `${pointer}.repo`,
        `expected an 'owner/name' slug, got '${repo}'`,
      );
    }
    return {
      repo,
      section,
      index,
      scenario: optionalString(path, `${pointer}.scenario`, record["scenario"]),
      pinned: optionalString(path, `${pointer}.pinned`, record["pinned"]),
    };
  });
}

export function parseRepoRegistry(path: string, value: unknown): RepoRegistry {
  const root = requireRecord(path, "$", value);
  const latest = optionalString(path, "latest", root["latest"]);

  const rawConsumers = requireArray(path, "consumers", root["consumers"]);
  const consumers: ConsumerEntry[] = [];
  const seen = new Map<string, number>();

  rawConsumers.forEach((entry, index): void => {
    const pointer = `consumers[${index}]`;
    const record = requireRecord(path, pointer, entry);
    const repo = requireString(path, `${pointer}.repo`, record["repo"]);
    if (!repo.includes("/")) {
      throw new SchemaError(
        path,
        `${pointer}.repo`,
        `expected an 'owner/name' slug, got '${repo}'`,
      );
    }
    const previous = seen.get(repo);
    if (previous !== undefined) {
      throw new SchemaError(
        path,
        `${pointer}.repo`,
        `duplicates consumers[${previous}].repo ('${repo}'); two entries for one consumer means two pins, and an affected-set computation would use whichever it read first`,
      );
    }
    seen.set(repo, index);

    const consumes = requireArray(path, `${pointer}.consumes`, record["consumes"]).map(
      (item, itemIndex): string =>
        requireString(path, `${pointer}.consumes[${itemIndex}]`, item),
    );
    const rawPhases = record["phases"];
    const phases =
      rawPhases === undefined || rawPhases === null
        ? []
        : requireArray(path, `${pointer}.phases`, rawPhases).map((item, itemIndex): string =>
            requireString(path, `${pointer}.phases[${itemIndex}]`, item),
          );

    const callerPins: Record<string, string> = {};
    for (const [key, raw] of Object.entries(record)) {
      // Same `$`-prefix-is-metadata convention as `product_codes` below
      // (zheref/nen#17): a `$comment_pinned` key would otherwise pass the
      // `_pinned`-suffix check and become a phantom per-caller pin.
      if (key === "pinned" || key.startsWith("$") || !key.endsWith(CALLER_PIN_SUFFIX)) continue;
      callerPins[key] = requireString(path, `${pointer}.${key}`, raw);
    }

    consumers.push({
      repo,
      pinned: optionalString(path, `${pointer}.pinned`, record["pinned"]),
      consumes,
      scenario: optionalString(path, `${pointer}.scenario`, record["scenario"]),
      phases,
      auth: optionalString(path, `${pointer}.auth`, record["auth"]),
      notes: optionalString(path, `${pointer}.notes`, record["notes"]),
      code: optionalString(path, `${pointer}.code`, record["code"]),
      callerPins,
    });
  });

  const productCodes: Record<string, string> = {};
  const rawCodes = root["product_codes"];
  if (rawCodes !== undefined && rawCodes !== null) {
    const codes = requireRecord(path, "product_codes", rawCodes);
    for (const [code, name] of Object.entries(codes)) {
      // `$`-prefixed keys are metadata, not data -- a nested `$comment` is a
      // shape real registries carry (bankai-core's own nen/repos.json
      // documents the object-reference notation from INSIDE product_codes,
      // not beside it), and walking it as a product code manufactures a
      // bogus entry whose "repository" is the comment's own prose
      // (zheref/nen#17).
      if (code.startsWith("$")) continue;
      productCodes[code] = requireString(path, `product_codes.${code}`, name);
    }
  }

  const byRepoIndex = new Map(
    consumers.map((entry): [string, ConsumerEntry] => [entry.repo, entry]),
  );
  const byCodeIndex = new Map<string, ConsumerEntry>();
  for (const entry of consumers) {
    if (entry.code === null) continue;
    // FIRST WINS, and a second entry with the same code is an ERROR rather than
    // a silent overwrite: a product code that resolves to two repositories makes
    // every `<CODE>#<n>` reference ambiguous.
    const existing = byCodeIndex.get(entry.code);
    if (existing !== undefined) {
      throw new SchemaError(
        path,
        "consumers",
        `product code '${entry.code}' is claimed by both '${existing.repo}' and '${entry.repo}', so a '${entry.code}#123' reference names neither`,
      );
    }
    byCodeIndex.set(entry.code, entry);
  }

  const maintained = parseListedRepos(path, "maintained_tools", root["maintained_tools"]);
  const pending = parseListedRepos(path, "pending_onboarding", root["pending_onboarding"]);
  const slugs = (entries: readonly ListedRepo[]): readonly string[] =>
    entries.map((entry): string => entry.repo);
  const toolPins: Record<string, string> = {};
  for (const tool of maintained) if (tool.pinned !== null) toolPins[tool.repo] = tool.pinned;
  // `listed` carries the four fields its type names and not the pin, which
  // `toolPins` already holds keyed by slug -- one home per fact.
  const asEntry = ({ repo, section, index, scenario }: ListedRepo): ListedEntry => ({ repo, section, index, scenario });

  return {
    path,
    latest,
    consumers,
    productCodes,
    maintainedTools: slugs(maintained),
    pendingOnboarding: slugs(pending),
    listed: [...maintained, ...pending].map(asEntry),
    toolPins,
    byRepo: (repo): ConsumerEntry | undefined => byRepoIndex.get(repo),
    byCode: (code): ConsumerEntry | undefined => byCodeIndex.get(code),
    affectedBy: (changed): readonly ConsumerEntry[] => {
      const wanted = new Set(changed);
      return consumers.filter((entry): boolean =>
        entry.consumes.some((file): boolean => wanted.has(file)),
      );
    },
  };
}

export function loadRepoRegistry(repoRoot: string): RepoRegistry {
  const { path, value } = readSchemaJson(repoRoot, REPOS_FILE);
  return parseRepoRegistry(path, value);
}
