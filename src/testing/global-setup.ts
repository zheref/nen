// vitest globalSetup (vitest.config.ts): every temp directory the suite makes
// lives in one sandbox that is removed when the run ends, pass or fail
// (zheref/nen#635). See temp-sandbox.ts for the why.
import { openTempSandbox } from "./temp-sandbox.js";

export default function setup(): () => void {
  const sandbox = openTempSandbox();
  return () => {
    const { leftover, error } = sandbox.close();
    // Not a failure: the sandbox already took them out. The number is how many
    // temp entries this run's tests created and did not remove themselves, so
    // a growing count is visible; src/testing/temp-hygiene.test.ts is what
    // keeps the files that make them from multiplying.
    if (leftover > 0) process.stderr.write(`nen test temp sandbox: removed ${leftover} entries the tests left behind (${sandbox.dir})\n`);
    if (error !== undefined) process.stderr.write(`nen test temp sandbox: could not remove ${sandbox.dir} (${error}); the next run sweeps it\n`);
  };
}
