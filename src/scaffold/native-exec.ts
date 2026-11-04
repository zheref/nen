// This executor reads no profile or template. The command joins a validated plan
// and explicit --run-native consent here; init and other post-steps never run.
import type { Seams } from "../seam/exec.js";
import type { NativeExecution } from "./native-types.js";

export function executeNative(plan: NativeExecution, seams: Seams): {
  path: "native-handoff" | "refused"; notes: readonly string[]; exitCode: number;
} {
  const probe = seams.run(plan.tool, plan.probe);
  if (probe.spawnFailed || probe.code !== 0) return { path: "refused", notes: [`Native generator unavailable: ${plan.tool}; install the declared first-party tool/template yourself. No installation was attempted.`], exitCode: 5 };
  const help = probe.stdout + probe.stderr;
  if (plan.requiredHelp.some(word => !help.includes(word))) return { path: "refused", notes: [`Installed ${plan.tool} lacks the declared safe generator options; no generator was run.`], exitCode: 5 };
  const generated = seams.run(plan.tool, plan.argv);
  return { path: generated.spawnFailed || generated.code !== 0 ? "refused" : "native-handoff", notes: [generated.spawnFailed || generated.code !== 0 ? `Native generator failed; inspect '${plan.dir}' before retrying. No init step was run.` : "The declared native generator completed. Nen init and all remaining post-steps were not run."], exitCode: generated.spawnFailed ? 5 : generated.code };
}
