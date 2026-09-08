// src/schema/fixtures/paths.ts -- where the three fixture repository roots live,
// resolved the same way the shipped code resolves a target repo: from
// `process.cwd()`, never from `import.meta.url`.
//
// TEST SUPPORT ONLY. It is under `fixtures/` so the taxonomy-purity sweep and
// eslint both skip it, and nothing in the shipped tree imports it. The reason it
// exists rather than each test spelling the path itself: vitest's cwd is the
// repo root, so every test would otherwise repeat the same join and one of them
// would eventually get it wrong in a way that silently reads the wrong fixture.

import { join } from "node:path";

const FIXTURES = join(process.cwd(), "src", "schema", "fixtures");

/** The vocabulary of the live system nen serves today. */
export const BANKAI_REPO = join(FIXTURES, "bankai-repo");

/** A deliberately different vocabulary; nothing shipped knows its strings. */
export const ALT_REPO = join(FIXTURES, "alt-repo");

/**
 * The un-migrated layout: the same four files as `bankai-repo`, still under
 * `schemas/` and absent from `nen/`. It exists so the fallback is proved
 * against a repository root rather than a temp directory, and it is deleted in
 * v0.4.0 together with the legacy map in ../source.ts.
 */
export const LEGACY_REPO = join(FIXTURES, "legacy-repo");
