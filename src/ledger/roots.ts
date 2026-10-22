// src/ledger/roots.ts -- the one durable-state root for nen's own records under
// the git common dir. The segments are ./roots.json's data: read by the loop
// ledger (src/loop/home.ts), the stop-answer ledger (src/stop/answer.ts) and the
// run manifest (src/run/manifest.ts), so the three cannot drift apart again
// (delivery round on zheref/nen#498, reading 7).

import roots from "./roots.json";

/** `<common>/.nen/` -- the root every nen-owned common-dir record lives under. */
export const NEN_COMMON_ROOT: readonly string[] = roots.root;
/** `<common>/.nen/loop/` -- `nen loop iterate` ledgers. */
export const LOOP_COMMON_SEGMENTS: readonly string[] = roots.loop;
/** `<common>/.nen/stops/` -- `nen stop answer` records. */
export const STOPS_COMMON_SEGMENTS: readonly string[] = roots.stops;
/** `<common>/.nen/stop-ids/` -- `nen stop answer` reserved ids. */
export const STOP_IDS_COMMON_SEGMENTS: readonly string[] = roots.stopIds;
/** `<common>/.nen/runs/` -- `nen run` manifests. */
export const RUNS_COMMON_SEGMENTS: readonly string[] = roots.runs;
/** Spellings older builds wrote the loop ledger to, relative to the common dir. */
export const LOOP_LEGACY_SEGMENTS: readonly (readonly string[])[] = roots.legacy.loop;
/** Spellings older builds wrote run manifests to, relative to the common dir. */
export const RUNS_LEGACY_SEGMENTS: readonly (readonly string[])[] = roots.legacy.runs;
