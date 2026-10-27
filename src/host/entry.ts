// Invokable before `bun install`: runtime imports reach builtins and the local
// argument/format/seam code only. Never import CLI registry or package SDKs here.
import { UsageError } from "../cli/args.js";
import { VerbUsageError } from "../cli/command.js";
import { defaultSeams } from "../seam/exec.js";
import { hostAction, hostCommand, standaloneArgs } from "./command.js";
export function standalone(argv: readonly string[]): number {
  const args = standaloneArgs(argv);
  if (args.booleans.has("help")) { console.log(hostCommand.usage); return 0; }
  return hostAction({ args, repoFlag: null, json: args.booleans.has("json"), seams: defaultSeams(), io: { out: console.log, err: console.error } });
}
if (import.meta.main) {
  try { process.exitCode = standalone(process.argv.slice(2)); }
  catch (error) { console.error(`nen host: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = error instanceof UsageError || error instanceof VerbUsageError ? 2 : 1; }
}
