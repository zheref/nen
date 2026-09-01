// src/dev/lint.ts -- `nen dev lint`, D16's "one command" for the linter, the
// same shape ./test.ts already gives the test harness.
//
// A THIN SPAWN OF `bun run lint`, for the same reason ./test.ts is a thin
// spawn of `bun run test`: `package.json`'s script is the one definition of
// what "lint" means here, and CI runs the same one. A dev verb with its own
// eslint invocation would drift from it the first time someone adds a rule
// override to the script and not to the verb.
//
// A DEV VERB, SAYING SO. A COMPILED BINARY CANNOT RUN IT: eslint is a
// devDependency of a checkout, not something a downloaded binary carries, so
// the failure is reported as itself (no package.json here) rather than as an
// opaque spawn error -- see ./test.ts's header for the fuller reasoning,
// which applies unchanged.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoRoot, type RepoRootOptions } from "../repo/root.js";

export interface DevLintOptions extends RepoRootOptions {
  readonly passthrough?: readonly string[];
}

export interface DevLintResult {
  readonly code: number;
  readonly message: string | null;
}

export function devLintArgv(passthrough: readonly string[] = []): string[] {
  return ["run", "lint", ...(passthrough.length > 0 ? ["--", ...passthrough] : [])];
}

export function runDevLint(options: DevLintOptions = {}): DevLintResult {
  const root = resolveRepoRoot(options);
  if (!existsSync(join(root, "package.json"))) {
    return {
      code: 2,
      message: `no package.json under '${root}'. \`nen dev lint\` runs this repository's OWN linter (\`bun run lint\` -> eslint), so it needs a checkout; a compiled binary has no linter to run. Run it from the nen checkout, or point --repo at one.`,
    };
  }

  const result = spawnSync("bun", devLintArgv(options.passthrough), {
    cwd: root,
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      code: 2,
      message: missing
        ? "no 'bun' on PATH. The harness is bun + eslint; install bun 1.4.0 or newer."
        : `could not run the linter (${result.error.message}).`,
    };
  }
  return { code: result.status ?? 1, message: null };
}
