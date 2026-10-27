// Invokable before `bun install`: runtime imports reach builtins and the local
// argument/format/seam code only. Never import CLI registry or package SDKs here.
import { runtimeSupervisorInvocation, type EntryRuntime, type SupervisorInvocation } from "./execute.js";
import { UsageError } from "../cli/args.js";
import { VerbUsageError } from "../cli/command.js";
import { defaultSeams } from "../seam/exec.js";
import { hostAction, hostCommand, standaloneArgs } from "./command.js";
export function standalone(argv: readonly string[], invocation?: SupervisorInvocation): number {
  const args = standaloneArgs(argv);
  if (args.booleans.has("help")) { console.log(hostCommand.usage); return 0; }
  return hostAction({ args, repoFlag: null, json: args.booleans.has("json"), seams: defaultSeams(invocation), io: { out: console.log, err: console.error } });
}
/** Main-mode error boundary, including runtime discovery; standalone still throws. */
export function standaloneMain(argv: readonly string[], runtime: () => EntryRuntime): number {
  try {
    const invocation = runtimeSupervisorInvocation(runtime(), ["_exec"]);
    return standalone(argv, invocation);
  } catch (error) {
    console.error(`nen host: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof UsageError || error instanceof VerbUsageError ? 2 : 1;
  }
}
/** Read the actual current runtime lazily; callers choose no supervisor path. */
export function currentEntryRuntime(): EntryRuntime {
  return {
    executable: process.execPath,
    standalone: typeof Bun === "undefined" ? undefined : Bun.isStandaloneExecutable,
    entrypoint: typeof Bun === "undefined" ? "" : Bun.main,
  };
}
if (import.meta.main) {
  process.exitCode = standaloneMain(process.argv.slice(2), currentEntryRuntime);
}
