import { loadWorkflow } from "../schema/workflow.js";

/** The `--pr` pacing floor accounts for the GitHub reads in each poll. */
export const PR_MIN_INTERVAL_MS = 30_000;
export const DEFAULT_WATCH_INTERVAL_MS = 5_000;

/**
 * The target's `monitor` block, or null when the checkout declares no policy
 * file. A present-but-malformed policy throws, exactly as every other reader
 * of that file lets it: a watch paced by a file it could not read is a watch
 * paced by a guess.
 */
export function readWatchMonitor(root: string): { pollSeconds: number | null; maxCycles: number | null } | null {
  const loaded = loadWorkflow(root);
  if (!loaded.present) return null;
  // ONLY WHAT THE FILE DECLARES, KEY BY KEY. `loadWorkflow` fills an absent
  // block with nen's own defaults (300 s, 20 cycles); a watch that read those
  // as the repository's policy would turn a 5-second unbounded watch into a
  // 300-second one that exits after 20 observations, in a repository that
  // said nothing (review finding on zheref/nen#216).
  const raw = loaded.workflow.monitor.raw;
  const declared = (key: "pollSeconds" | "maxCycles"): number | null =>
    typeof raw[key] === "number" ? loaded.workflow.monitor[key] : null;
  const pollSeconds = declared("pollSeconds");
  const maxCycles = declared("maxCycles");
  if (pollSeconds === null && maxCycles === null) return null;
  return { pollSeconds, maxCycles };
}
