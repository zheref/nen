// src/schema/repos.ts -- the consuming-repository registry, read from the TARGET
// repository's `schemas/repos.json`.
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
   * ONLY THE SLUG IS MODELLED. Each entry carries more (`role`, `status`,
   * `reason`, ...), and that prose is the target repository's business, on the
   * same discipline that keeps `callerPins` raw: the slug is the one fact
   * token resolution needs, and modelling the rest would be this binary
   * learning another repository's onboarding vocabulary.
   */
  readonly maintainedTools: readonly string[];
  /** `owner/name` slugs listed under `pending_onboarding`, in file order. See `maintainedTools`. */
  readonly pendingOnboarding: readonly string[];
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
function parseListedRepos(path: string, field: string, raw: unknown): readonly string[] {
  if (raw === undefined || raw === null) return [];
  return requireArray(path, field, raw).map((entry, index): string => {
    const pointer = `${field}[${index}]`;
    const record = requireRecord(path, pointer, entry);
    const repo = requireString(path, `${pointer}.repo`, record["repo"]);
    if (!repo.includes("/")) {
      throw new SchemaError(
        path,
        `${pointer}.repo`,
        `expected an 'owner/name' slug, got '${repo}'`,
      );
    }
    return repo;
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
      if (key === "pinned" || !key.endsWith(CALLER_PIN_SUFFIX)) continue;
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

  return {
    path,
    latest,
    consumers,
    productCodes,
    maintainedTools: parseListedRepos(path, "maintained_tools", root["maintained_tools"]),
    pendingOnboarding: parseListedRepos(path, "pending_onboarding", root["pending_onboarding"]),
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
