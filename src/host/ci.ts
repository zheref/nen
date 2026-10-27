// Invokable before dependencies exist. Hosted disposable VMs provision one
// per-job store. Self-hosted jobs require the operator's EXISTING host budget,
// shared with interactive accounts: no checkout/user-local fallback.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { standalone } from "./entry.js";
import { hasClaimMarkers, hostActivated, HOST_STORE_ENV, unavailableNotice } from "./execute.js";
import { spawnInteractiveRunner } from "../seam/exec.js";
import { initStore, openStore } from "./store.js";
export function ci(argv: readonly string[]): number {
  if (argv[0] === undefined) throw new Error("CI host guard requires an executable and argv");
  if (!hostActivated(process.env) && !hasClaimMarkers(process.env)) {
    process.stderr.write(`${unavailableNotice("CI")}\n`);
    return spawnInteractiveRunner(argv[0], argv.slice(1)).code === 0 ? 0 : 1;
  }
  if (process.env.RUNNER_ENVIRONMENT === "github-hosted" && !hasClaimMarkers(process.env)) {
    const temp = process.env.RUNNER_TEMP;
    if (temp === undefined || !isAbsolute(temp)) throw new Error("hosted CI needs its absolute RUNNER_TEMP; nothing was launched");
    const root = join(temp, "nen-host-budget");
    // Each later step reads the SAME state, including unresolved prior owners.
    if (!existsSync(root)) initStore(root);
    process.env[HOST_STORE_ENV] = openStore(root).root;
  }
  return standalone(["run", "--", ...argv]);
}
if (import.meta.main) {
  try { process.exitCode = ci(process.argv.slice(2)); }
  catch (error) { console.error(`nen host CI: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
