// src/shu/fixtures/paths.ts -- where the marker trees live, resolved the same
// way the shipped code resolves a target repo: from `process.cwd()`, never from
// `import.meta.url`.
//
// TEST SUPPORT ONLY, and under `fixtures/` so eslint and the taxonomy-purity
// sweep both skip it. It exists rather than each test spelling the join itself
// because vitest's cwd is the repo root and one of those joins would eventually
// be wrong in a way that silently reads the wrong tree.

import { join } from "node:path";

const FIXTURES = join(process.cwd(), "src", "shu", "fixtures");

export const NEXTJS_SINGLE = join(FIXTURES, "nextjs-single");
export const NEXTJS_MULTI = join(FIXTURES, "nextjs-multi");
export const NEXTJS_UNVERIFIED = join(FIXTURES, "nextjs-unverified");
export const NEXTJS_PARTIAL = join(FIXTURES, "nextjs-partial");
export const NEXTJS_WORKSPACES = join(FIXTURES, "nextjs-workspaces");
export const NEXTJS_UNTOOLED = join(FIXTURES, "nextjs-untooled");
export const GATSBY_SITE = join(FIXTURES, "gatsby-site");
export const EXPO_BARE = join(FIXTURES, "expo-bare");
export const WINUI_APP = join(FIXTURES, "winui-app");
export const WINUI_LINKED = join(FIXTURES, "winui-linked");
/** A `dotnet-winui` lane that is NOT the repository root, and an XML solution. */
export const WINUI_NESTED = join(FIXTURES, "winui-nested");
export const EMPTY_TREE = join(FIXTURES, "empty-tree");
/** Two separate Gradle builds in one tree, the shape the inventory found. */
export const KRO_SHAPED = join(FIXTURES, "kro-shaped");

/** One `.xcodeproj`, one shared scheme whose test target exists. */
export const XCODE_PROJECT = join(FIXTURES, "xcode-project");

/** The same project inside the workspace a dependency manager writes. */
export const XCODE_WORKSPACE = join(FIXTURES, "xcode-workspace");

/** One marker tree per stack, by the stack id `detect` should answer with. */
export const MARKERS = join(FIXTURES, "markers");
export const markerTree = (name: string): string => join(MARKERS, name);

/**
 * The coverage REPORT fixtures -- one per format, plus each format's empty and
 * malformed shapes. They are reports, not marker trees: nothing detects
 * anything about them, they are read as text and handed to a parser.
 * `coverage/README.md` says what each one is for and why every happy fixture
 * states the same 14-of-17 lines.
 */
export const COVERAGE_REPORTS = join(FIXTURES, "coverage");
export const coverageReport = (name: string): string => join(COVERAGE_REPORTS, name);

/**
 * The test REPORT fixtures -- one per format, plus each format's empty and
 * malformed shapes. Reports, not marker trees: nothing detects anything about
 * them. `test-report/README.md` says what each one is for and why every happy
 * fixture states the same five tests.
 */
export const TEST_REPORTS = join(FIXTURES, "test-report");
export const testReport = (name: string): string => join(TEST_REPORTS, name);
