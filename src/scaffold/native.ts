// Native project ownership stays with the profile's explicitly named first-party generator.
import { VerbUsageError } from "../cli/command.js";
import { nativeSeat } from "./templates.js";
import type { HookSpec } from "./hook.js";
import type { NativeExecution } from "./native-types.js";
import { PROGRAM } from "../version.js";

export interface NativePlan {
  readonly nativeExecution?: NativeExecution;
  readonly path: "native-handoff" | "refused";
  readonly postSteps: readonly string[];
  readonly notes: readonly string[];
  readonly exitCode: number;
}

export function nativePlan(options: {
  stack: string; name: string; dir: string; platform: NodeJS.Platform;
  runNative?: boolean; dryRun?: boolean; hook?: HookSpec; nenRef?: string;
}): NativePlan | null {
  const raw = nativeSeat(options.stack);
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new VerbUsageError("nativeScaffolder must be a declared object.");
  const seat = raw as Record<string, unknown>;
  const strings = (key: string): string[] => {
    const value = seat[key];
    if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || /[\x00-\x1f\x7f]/.test(entry))) throw new VerbUsageError(`nativeScaffolder.${key} must be an array of argument strings.`);
    return value as string[];
  };
  if (typeof seat.handoff !== "string" || typeof seat.source !== "string" || !["manual", "generator"].includes(String(seat.mode))) throw new VerbUsageError("nativeScaffolder needs mode, handoff and source.");
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const hookFlags = options.hook === undefined ? "--marker-env <YOUR_DECLARED_MARKER_VARIABLE>" : `--marker-env ${quote(options.hook.markerEnvVar)} --agent-trailer ${quote(options.hook.agentTrailer)}${options.hook.runTrailer === null ? "" : ` --run-trailer ${quote(options.hook.runTrailer)}`}`;
  const postSteps = [String(seat.handoff).replaceAll("<name>", quote(options.name)).replaceAll("<dir>", quote(options.dir)) + ` Project name: ${quote(options.name)}; destination: ${quote(options.dir)}.`, `${PROGRAM} scaffold init --repo ${quote(options.dir)} --stack ${quote(options.stack)} ${hookFlags}${options.nenRef === undefined ? "" : ` --nen-ref ${quote(options.nenRef)}`}`];
  const notes = [`First-party instructions: ${seat.source}`, "No native marker, wrapper, IDE project, dependency or hook is fabricated. Post-steps require separate invocation."];
  if (!options.runNative || options.dryRun) return { path: "native-handoff", postSteps, notes, exitCode: 0 };
  if (seat.mode === "manual") throw new VerbUsageError(`--run-native is unavailable for '${options.stack}': this declared seat requires the manual IDE wizard. ${postSteps[0]}`);
  const hosts = strings("hosts");
  if (!hosts.includes(options.platform)) return { path: "refused", postSteps, notes: [...notes, `Native generator requires one of: ${hosts.join(", ")}; this host is ${options.platform}.`], exitCode: 3 };
  if (typeof seat.tool !== "string" || !/^[A-Za-z0-9._-]+$/.test(seat.tool)) throw new VerbUsageError("nativeScaffolder.tool must name one executable.");
  const argv = strings("argv").map(arg => arg.replaceAll("{{name}}", options.name).replaceAll("{{dir}}", options.dir));
  return { path: "native-handoff", postSteps, notes, exitCode: 0, nativeExecution: { tool: seat.tool, probe: strings("probe"), requiredHelp: strings("requiredHelp"), argv, dir: options.dir } };

}
