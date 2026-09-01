// src/dev/test.ts -- `nen dev test`, D16's "one command runs the whole harness".
//
// IT IS A THIN SPAWN OF THE SAME HARNESS `bun run test` RUNS, and that is the
// entire point. D16 asks for ONE harness -- TypeScript + vitest, no make, no
// bats, no pytest, no runtime python3 -- and the way a repository ends up with
// two is by giving the verb its own runner "just for convenience", which then
// acquires its own reporter defaults, its own include globs, and eventually its
// own answer to "did the tests pass". So this runs `bun run test`, which runs
// vitest, which reads vitest.config.ts. There is one harness because there is
// one invocation.
//
// IT IS A DEV VERB AND SAYS SO. A COMPILED BINARY CANNOT RUN IT: vitest is a
// devDependency of a checkout, and `nen dev test` from a downloaded binary in an
// arbitrary directory has nothing to run. The failure is therefore reported as
// itself -- "there is no package.json here" -- rather than as an opaque spawn
// error, and the verb lives under `dev` precisely so the distinction between
// "what nen does for a repository" and "what nen does for its own development"
// is visible in the command name.
//
// EVERYTHING AFTER `--` GOES STRAIGHT THROUGH, unparsed. A wrapper that
// re-interprets its passthrough is a wrapper that will one day disagree with the
// tool it wraps about what `-t` means.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoRoot, type RepoRootOptions } from "../repo/root.js";

export interface DevTestOptions extends RepoRootOptions {
  /** Arguments after `--`, handed to vitest untouched. */
  readonly passthrough?: readonly string[];
}

export interface DevTestResult {
  readonly code: number;
  readonly message: string | null;
}

export function devTestArgv(passthrough: readonly string[] = []): string[] {
  // `bun run test` rather than `bunx vitest run`: the script in package.json is
  // the one definition of what "the harness" means, and CI runs the same one.
  return ["run", "test", ...(passthrough.length > 0 ? ["--", ...passthrough] : [])];
}

export function runDevTest(options: DevTestOptions = {}): DevTestResult {
  const root = resolveRepoRoot(options);
  if (!existsSync(join(root, "package.json"))) {
    return {
      code: 2,
      message: `no package.json under '${root}'. \`nen dev test\` runs this repository's OWN harness (\`bun run test\` -> vitest), so it needs a checkout; a compiled binary has no harness to run. Run it from the nen checkout, or point --repo at one.`,
    };
  }

  const result = spawnSync("bun", devTestArgv(options.passthrough), {
    cwd: root,
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      code: 2,
      message: missing
        ? "no 'bun' on PATH. The harness is bun + vitest (D16); install bun 1.4.0 or newer."
        : `could not run the harness (${result.error.message}).`,
    };
  }
  return { code: result.status ?? 1, message: null };
}
