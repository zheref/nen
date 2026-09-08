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
export const EMPTY_TREE = join(FIXTURES, "empty-tree");
/** Two separate Gradle builds in one tree, the shape the inventory found. */
export const KRO_SHAPED = join(FIXTURES, "kro-shaped");

/** One marker tree per stack, by the stack id `detect` should answer with. */
export const MARKERS = join(FIXTURES, "markers");
export const markerTree = (name: string): string => join(MARKERS, name);
