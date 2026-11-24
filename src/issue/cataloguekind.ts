/**
 * Which of the two section catalogues a file says it is (zheref/nen#607).
 *
 * Two `nen pr` verbs take a `--catalogue`, and they take different files: the
 * issue-sections catalogue (`pr body-check`, `pr converge`, `pr merge`, and
 * the issue verbs' `--requirements-from`) and the PR-sections catalogue
 * (`pr sections resolve` / `family`). Handed the other kind, each loader used
 * to fail on the first inner field that did not fit, which reads like schema
 * drift rather than a swapped file. A catalogue that declares a top-level
 * `contract` says which kind it is, so the swap can be named before any field
 * is read.
 *
 * nen ships neither catalogue and knows no caller's namespace: the kind is the
 * NAME segment of the contract id (`<namespace>.<name>/<version>`), whoever
 * the namespace is. A file with no `contract`, or one naming neither kind, is
 * left to the loader's own field-level validation, unchanged.
 *
 * Each reader refuses the way it already refuses a catalogue it cannot use,
 * so no exit code moves: the issue-sections readers at exit 2 (a usage
 * error), `pr sections resolve` / `family` at exit 1 (an invalid catalogue).
 */

export type CatalogueKind = "issue-sections" | "pr-sections";

export interface DeclaredCatalogue {
  /** The `contract` string as the file wrote it. */
  readonly contract: string;
  readonly kind: CatalogueKind;
}

/** `hatsu.pr-sections/v1`, `pr-sections`, `acme.issue-sections/v3`: the name segment, bounded on both sides. */
const KIND_IN_CONTRACT = /(?:^|[.:/])(issue-sections|pr-sections)(?:[/@]|$)/;

/** The kind a parsed catalogue declares through its top-level `contract`, or null when it declares none nen can tell apart. */
export function declaredCatalogueKind(raw: unknown): DeclaredCatalogue | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const contract = (raw as Record<string, unknown>)["contract"];
  if (typeof contract !== "string") return null;
  const match = KIND_IN_CONTRACT.exec(contract);
  if (match === null) return null;
  return { contract, kind: match[1] as CatalogueKind };
}

const READS: Readonly<Record<CatalogueKind, string>> = {
  "issue-sections": "an issue-sections catalogue ('sections', 'kinds' and 'rows': the acceptance prefix and the sections a body is held to)",
  "pr-sections": "a PR-sections catalogue ('sections', 'footer', 'families' and 'variants': the sections a pull-request body carries)",
};

const TAKEN_BY: Readonly<Record<CatalogueKind, string>> = {
  "issue-sections": "An issue-sections catalogue is the --catalogue of 'nen pr body-check', 'nen pr converge' and 'nen pr merge', and the --requirements-from of 'nen issue body-check'.",
  "pr-sections": "A PR-sections catalogue is the --catalogue of 'nen pr sections resolve' and 'nen pr sections family'.",
};

const NAMED: Readonly<Record<CatalogueKind, string>> = {
  "issue-sections": "an issue-sections catalogue",
  "pr-sections": "a PR-sections catalogue",
};

/**
 * The refusal for a catalogue of the other kind, or null when the file
 * declares the expected kind or declares none. The message names the contract
 * read, the kind this reader expects, and the verbs that take the file given.
 */
export function wrongCatalogueKind(raw: unknown, expected: CatalogueKind): string | null {
  const declared = declaredCatalogueKind(raw);
  if (declared === null || declared.kind === expected) return null;
  return `the wrong kind of catalogue was passed: this file is ${NAMED[declared.kind]} (its 'contract' is '${declared.contract}'), and this verb reads ${READS[expected]}. ${TAKEN_BY[declared.kind]}`;
}
