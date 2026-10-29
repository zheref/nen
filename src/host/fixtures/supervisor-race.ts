// Deterministic interleaving: BOTH dedicated-group contenders validate the
// same reserved step before either may atomically register/spawn its payload.
import { readSync } from "node:fs";
import { supervise } from "../execute.js";
const [store, slot, claim, step, marker] = process.argv.slice(2);
try {
  const code = supervise(store!, Number(slot), claim!, step!, "bun", ["-e", "require('node:fs').appendFileSync(process.argv[1], 'launched\\n')", marker!], {
    beforeRegister(): void {
      console.log("ready");
      const byte = Buffer.alloc(1);
      if (readSync(0, byte, 0, 1, null) !== 1) throw new Error("synthetic barrier closed before registration");
    },
  });
  console.log(`result:${code}`);
  process.exitCode = code;
} catch (error) {
  console.log(`refused:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
