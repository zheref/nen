// Synthetic two-process race: no workload, runners or host-global state.
import { openStore, reserve } from "../store.js";
const root = process.argv[2]!;
const owner = process.argv[3]!;
let requested = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (): void => {
  if (requested) { process.exit(0); return; }
  requested = true;
  try {
    reserve(openStore(root), owner, { pid: process.pid, pgid: process.pid, started: "synthetic process identity" });
    console.log("admitted");
  } catch (error) { console.log(`refused: ${error instanceof Error ? error.message : String(error)}`); }
});
console.log("ready");
