// src/supply/bootstrap.ts -- `nen bootstrap`, the TypeScript half of the supply
// contract.
//
// WHAT IT DOES: resolves `bootstrap/nen.sh`, runs it, and relays its answer.
// WHAT IT DOES NOT DO: reimplement any of it.
//
// WHY DELEGATE RATHER THAN PORT. The integrity rules in that script -- refuse an
// absent manifest, refuse an ambiguous one, refuse a host with no hashing tool,
// DELETE bytes that mismatch, never print a path to a binary that was not
// verified -- are the whole product. A second implementation of them in
// TypeScript would be a second thing that can drift, and the two would drift in
// the direction that is hardest to notice: the shell is the one a machine with
// no `nen` runs, so a divergence would show up first for the consumer who has
// the least ability to debug it. One implementation, two entry points.
//
// SO WHAT IS `nen bootstrap` FOR? Two things the shell cannot be:
//   1. A PEER bootstrap. A machine that already has `nen` can fetch a DIFFERENT
//      pinned version -- for a repository whose registry pins an older one --
//      without the caller having to know where the script lives or which
//      platform triple it is on.
//   2. A stable, documented contract for zheref/hatsu#1's D10 minimum-version
//      gate: one command, one line of stdout, and an exit code whose meaning is
//      fixed (see BootstrapExit).
//
// THE SCRIPT IS FOUND FROM THE REPOSITORY ROOT, never from `import.meta.url`.
// A compiled binary has no sibling `bootstrap/` directory -- it is one file,
// copied wherever the operator put it -- so the honest answer is: look in the
// target repository (cwd, or `--repo <path>`), and if it is not there, SAY SO
// and name the two ways to fix it. Guessing a path relative to the executable
// is the failure §3 is about, arrived at from a different direction.
//
// IT REQUIRES A POSIX SHELL. On Windows that means Git Bash, which is a
// first-class supported host (§10) and is where `bash` comes from on the
// maintainer's own machine. An absent `bash` is reported as itself rather than
// as a mysterious spawn failure.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoRoot, type RepoRootOptions } from "../repo/root.js";

/** The path of the one permitted shell file, relative to a repository root. */
export const BOOTSTRAP_SCRIPT = "bootstrap/nen.sh";

/**
 * The script's exit codes, restated here as a CONTRACT rather than imported --
 * they are a published interface that callers branch on, and the restatement is
 * checked against the script's own text by bootstrap.test.ts.
 *
 * The retry rule is the important half and it is not a style preference: retry
 * DOWNLOAD, NEVER retry CHECKSUM or MANIFEST. Retrying a checksum failure is how
 * a fail-closed guard becomes a fail-open one by attrition, and an absent
 * manifest does not become present by being asked for again.
 */
export const BootstrapExit = {
  OK: 0,
  USAGE: 2,
  UNSUPPORTED_HOST: 3,
  /** The retryable one, and the only one. */
  DOWNLOAD: 4,
  /** SECURITY: bytes did not verify, or could not be verified. Never retry. */
  CHECKSUM: 5,
  /** Manifest unfetchable, missing, malformed, or silent. Never retry. */
  MANIFEST: 6,
  /** Not the script's: this wrapper could not run it at all. */
  WRAPPER: 7,
} as const;

export type BootstrapExitCode = (typeof BootstrapExit)[keyof typeof BootstrapExit];

export function isRetryable(code: number): boolean {
  return code === BootstrapExit.DOWNLOAD;
}

export interface BootstrapOptions extends RepoRootOptions {
  /** The tag to fetch. REQUIRED -- there is deliberately no `latest`. */
  readonly ref: string;
  /** `owner/name` to fetch release assets from. */
  readonly source?: string | undefined;
  readonly cacheDir?: string | undefined;
  /**
   * An explicit path to the script, for the case the header describes: a
   * compiled binary invoked outside any checkout.
   */
  readonly script?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface BootstrapResult {
  readonly code: number;
  /** The verified binary's path, and nothing else. Empty on failure. */
  readonly path: string;
  /** Every diagnostic the script emitted. */
  readonly stderr: string;
}

// Where the script is, or a loud error saying why it is not.
//
// `options.env` FALLS BACK TO `process.env`, and that fallback is the fix for a
// doc claim that was false: the error message below offers `$NEN_BOOTSTRAP_SH`
// as one of the two ways out, but this function only ever read `options.env` --
// which `src/index.ts` does not pass -- so the variable was dead from the CLI
// and the advice sent an operator to set something that could not work. An
// escape hatch nobody can reach is worse than none, because the message
// promises it.
export function resolveScript(options: BootstrapOptions): string {
  const env = options.env ?? process.env;
  const explicit = options.script ?? env["NEN_BOOTSTRAP_SH"];
  if (explicit !== undefined && explicit !== "") {
    if (!existsSync(explicit)) {
      throw new Error(
        `bootstrap script '${explicit}' does not exist (from ${options.script === undefined ? "$NEN_BOOTSTRAP_SH" : "--script"}).`,
      );
    }
    return explicit;
  }

  const root = resolveRepoRoot(options);
  const path = join(root, ...BOOTSTRAP_SCRIPT.split("/"));
  if (!existsSync(path)) {
    throw new Error(
      `no '${BOOTSTRAP_SCRIPT}' under '${root}'. \`nen bootstrap\` runs the checksum bootstrap rather than reimplementing it, so it needs the script on disk. Either run from a checkout that carries it (or point --repo at one), or name the script with --script / $NEN_BOOTSTRAP_SH. This is NOT resolved relative to the executable: a compiled binary has no sibling bootstrap/ directory, and guessing one is how a path that does not exist becomes a silent failure.`,
    );
  }
  return path;
}

// Build the script's argv. Separate from the spawn so the mapping from flags to
// flags is testable without running anything.
export function bootstrapArgv(script: string, options: BootstrapOptions): string[] {
  const argv = [script, "--ref", options.ref];
  if (options.source !== undefined && options.source !== "") {
    argv.push("--source", options.source);
  }
  if (options.cacheDir !== undefined && options.cacheDir !== "") {
    argv.push("--cache-dir", options.cacheDir);
  }
  return argv;
}

export function runBootstrap(options: BootstrapOptions): BootstrapResult {
  if (options.ref.trim() === "") {
    // Refused HERE rather than passed through, so the message names the reason
    // rather than the script's generic usage text. There is no default and no
    // `latest`: a bootstrap that guessed a ref would unpin the supply chain it
    // exists to pin.
    return {
      code: BootstrapExit.USAGE,
      path: "",
      stderr:
        "nen bootstrap: --ref is required. There is deliberately no default and no 'latest' -- a bootstrap that picked the newest release would convert a source-pinned supply chain into an unpinned one.\n",
    };
  }

  let script: string;
  try {
    script = resolveScript(options);
  } catch (error) {
    return {
      code: BootstrapExit.WRAPPER,
      path: "",
      stderr: `nen bootstrap: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }

  const result = spawnSync("bash", bootstrapArgv(script, options), {
    encoding: "utf8",
    // The script inherits the caller's environment so its own NEN_* variables
    // keep working; the flags above take precedence inside it, as its own
    // argument parsing documents.
    env: { ...process.env, ...(options.env ?? {}) } as NodeJS.ProcessEnv,
  });

  if (result.error !== undefined) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      code: BootstrapExit.WRAPPER,
      path: "",
      stderr: missing
        ? "nen bootstrap: no 'bash' on PATH. The checksum bootstrap is a BASH script -- deliberately, because it must run on a machine that has no nen yet. (It is bash rather than plain POSIX sh: it uses BASH_SOURCE, `local`, and ${var//} substitution.) On Windows, run from Git Bash (or put its bin/ on PATH).\n"
        : `nen bootstrap: could not run the bootstrap script (${result.error.message}).\n`,
    };
  }

  // stdout carries the verified path ALONE -- the script sends every diagnostic
  // to stderr precisely so this is safe. Trimmed, never parsed: if it ever
  // carried more than a path, taking the first line would silently hide that.
  //
  // AND IT IS EMPTIED ON A NON-ZERO STATUS, which this function's own doc
  // comment on `path` already promised ("Empty on failure") and did not deliver.
  // The script is careful never to print a path it did not verify, so today the
  // two agree -- but a caller reading `result.path` without checking
  // `result.code` is the caller this wrapper exists to keep safe, and "the thing
  // we call is well behaved" is not a guarantee, it is an assumption about
  // somebody else's code. The one thing this must never do is hand back a path
  // to a binary that was not verified, and that is worth enforcing on BOTH sides
  // of the boundary.
  const code = result.status ?? BootstrapExit.WRAPPER;
  return {
    code,
    path: code === BootstrapExit.OK ? (result.stdout ?? "").trim() : "",
    stderr: result.stderr ?? "",
  };
}
