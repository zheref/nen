// src/quality/method.ts -- QA-15 method-block validation.
//
// "EVERY NUMBER CARRIES ITS METHOD BLOCK": device/OS; Release config, no
// debugger; n >= 5 with the first discarded; median and p90; thermal/network
// conditions. This module validates that a reported measurement's method block
// states all six -- it does not measure anything itself, and it does not judge
// whether the NUMBER is good; only whether the claim behind it is complete
// enough to trust ("prove or drop", QA-1 -- a number with no method is the
// speculation this whole gate refuses).

export interface MethodBlock {
  readonly device: string;
  readonly os: string;
  readonly releaseConfig: boolean;
  readonly debuggerAttached: boolean;
  readonly sampleSize: number;
  readonly firstDiscarded: boolean;
  readonly median: number | null;
  readonly p90: number | null;
  readonly thermalState: string | null;
  readonly networkCondition: string | null;
}

export const MINIMUM_SAMPLE_SIZE = 5;

export function validateMethodBlock(block: MethodBlock): readonly string[] {
  const refusals: string[] = [];
  if (block.device.trim() === "") refusals.push("device is not stated");
  if (block.os.trim() === "") refusals.push("OS is not stated");
  if (!block.releaseConfig) refusals.push("not measured in a Release configuration");
  if (block.debuggerAttached) refusals.push("measured with a debugger attached -- QA-15 requires none");
  if (block.sampleSize < MINIMUM_SAMPLE_SIZE) {
    refusals.push(`sample size is ${block.sampleSize}, under the QA-15 minimum of ${MINIMUM_SAMPLE_SIZE}`);
  }
  if (!block.firstDiscarded) refusals.push("the first run was not discarded (warm-up/cold-cache skew)");
  if (block.median === null) refusals.push("no median reported");
  if (block.p90 === null) refusals.push("no p90 reported");
  if (block.thermalState === null || block.thermalState.trim() === "") refusals.push("no thermal state reported");
  if (block.networkCondition === null || block.networkCondition.trim() === "") refusals.push("no network condition reported");
  return refusals;
}
