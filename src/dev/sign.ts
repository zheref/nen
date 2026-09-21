// src/dev/sign.ts -- ad-hoc-sign a compiled darwin binary AFTER `bun build
// --compile` has finished writing it, then verify the signature (zheref/nen#233).
//
// WHY A STEP AT ALL. `bun build --compile` links an executable that the linker
// ad-hoc-signs (`flags=0x20002(adhoc,linker-signed)`), then APPENDS the bundled
// payload after the link. A linker signature covers the bytes as linked, so
// the append invalidates it: `codesign -v` answers "code or signature have
// been modified", and a macOS that enforces the signature SIGKILLs the process
// before main (exit 137). Every published nen-darwin-arm64 from v0.9.0 to
// v0.12.0 shipped that way; v0.8.0 carried a plain ad-hoc signature
// (`flags=0x2(adhoc)`, two special slots) and runs. `codesign -s - --force`
// re-signs the whole file as it now is, which is that shape.
//
// A REPOSITORY SCRIPT, NOT A VERB, in `src/dev/` beside `matrix.ts` for the
// same reasons it gives: `bun run build:darwin-arm64` runs it as the build's
// last step, `nen dev` gains no subcommand, and it is TypeScript because
// `bootstrap/nen.sh` is the one shell file this repository ships.
//
// A NO-OP WHERE `codesign` IS ABSENT -- Linux, Windows -- because the build
// script is cross-platform and a host without the tool cannot sign; it says
// so on stderr and exits 0, and the release lane (which runs on macOS, and
// verifies with `codesign -v` on its own) is where the signature is REQUIRED.
// A `codesign` that is present and fails is an error, never a no-op.

import { spawnSync } from "node:child_process";

export interface SignSpawnResult {
  readonly status: number | null;
  readonly error?: NodeJS.ErrnoException | undefined;
  readonly stderr: string;
}

export type SignSpawn = (exe: string, args: readonly string[]) => SignSpawnResult;

export interface SignOutcome {
  /** `signed` when codesign ran and verified; `no-codesign` when the tool is not on PATH. */
  readonly kind: "signed" | "no-codesign";
  readonly line: string;
}

const defaultSpawn: SignSpawn = (exe, args) => {
  const result = spawnSync(exe, [...args], { encoding: "utf8" });
  return { status: result.status, error: result.error, stderr: result.stderr ?? "" };
};

/** Sign `path` ad hoc and verify it; throw when codesign is present and either step fails. */
export function signDarwinBinary(path: string, spawn: SignSpawn = defaultSpawn): SignOutcome {
  const sign = spawn("codesign", ["-s", "-", "--force", path]);
  if (sign.error !== undefined && sign.error.code === "ENOENT") {
    return { kind: "no-codesign", line: `sign: codesign is not on PATH; '${path}' is left as bun built it (linker-signed, and invalid once the payload is appended). Sign it on a Mac before shipping it -- the release lane does, and refuses a binary that does not verify.` };
  }
  if (sign.error !== undefined) throw new Error(`sign: could not run codesign: ${sign.error.message}`);
  if (sign.status !== 0) throw new Error(`sign: 'codesign -s - --force ${path}' exited ${sign.status}: ${sign.stderr.trim()}`);
  const verify = spawn("codesign", ["-v", path]);
  if (verify.error !== undefined) throw new Error(`sign: could not run codesign -v: ${verify.error.message}`);
  if (verify.status !== 0) throw new Error(`sign: '${path}' was signed and still does not verify ('codesign -v' exited ${verify.status}: ${verify.stderr.trim()}). Nothing to ship.`);
  return { kind: "signed", line: `sign: '${path}' ad-hoc-signed and verified (codesign -s - --force; codesign -v).` };
}

export function signMain(argv: readonly string[], spawn: SignSpawn = defaultSpawn, err: (line: string) => void = (line): void => { process.stderr.write(`${line}\n`); }): number {
  const path = argv[0];
  if (path === undefined || argv.length !== 1) {
    err("usage: bun src/dev/sign.ts <compiled darwin binary>");
    return 2;
  }
  try {
    err(signDarwinBinary(path, spawn).line);
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = signMain(process.argv.slice(2));
}
