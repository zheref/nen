// src/version.ts -- the ONE place the binary's own version is written.
//
// A LITERAL, NOT AN IMPORT OF package.json, and that is the whole point of this
// file existing at all. `bun build --compile` produces a single executable with
// no package.json beside it, so anything that resolved the version at RUNTIME
// (reading a sibling file, walking up from `import.meta.url`) would work in a
// checkout and print nothing, or crash, from the compiled binary -- and
// `import.meta.url` in a compiled bun binary resolves to `/$bunfs/...`, which is
// not a path on any filesystem (Akatsuki migration §3). `nen --version` is the
// contract zheref/hatsu#1 builds its D10 minimum-version gate on: a version verb
// that can fail is a fail-closed contract with a hole in it.
//
// A BUNDLED `import pkg from "../package.json"` would also work under bun and is
// the obvious alternative. It is rejected because it makes the shipped surface
// depend on a bundler feature (JSON module resolution) that differs between the
// three consumers of this source tree -- `bun build --compile`, `vitest`, and
// `tsc --noEmit` -- and a version string is the wrong place to discover that
// they disagree.
//
// THE DRIFT IS GUARDED, NOT TRUSTED. version.test.ts reads package.json from the
// repo root and asserts the two agree, so the duplication costs one test and can
// never ship out of step. Bump BOTH in the same commit.
export const VERSION = "0.1.0";

// The binary's own name, used in usage text, error prefixes and the octokit
// user-agent. Not a persona and not taxonomy: it is this executable's identity,
// which is the one name a binary is allowed to know.
export const PROGRAM = "nen";
