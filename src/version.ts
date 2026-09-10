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
export const VERSION = "0.8.0";

// THE LOWEST `dependency.minimum` PIN THIS BUILD SATISFIES -- `MAJOR.MINOR`,
// spelled the way a declaration spells the pin it is compared against.
//
// WHY A SECOND LITERAL BESIDE THE VERSION, AND WHY IT IS DATA THE BINARY SHIPS.
// At major zero the MINOR is semver's breaking-change vehicle, so nen read a
// `minimum` of `0.6` as `>=0.6.0 <0.7.0` EXACTLY: a v0.7.0 binary did not
// satisfy it, whatever v0.7.0 had actually changed. That is the right answer
// when v0.7.0 broke something and the wrong one when it did not, and nen could
// not tell the two apart, because nothing in the binary said which releases
// broke anything. So every minor -- breaking or not -- forced a repin PR in
// every consuming repository, and a repin that is owed unconditionally is a
// repin nobody reads.
//
// This constant is the missing fact, and the maintainer's ruling of 2026-09-10
// is what it states: "exact minor is fine, unless there is a breaking change".
// A release whose CHANGELOG section declares breaking consumer notes sets this
// to ITS OWN minor; a release that declares none leaves it where the previous
// release left it, and thereby goes on accepting the pins that were already
// written. It is a floor and never a ceiling: a pin AT or ABOVE it is read as
// ">= that minor", up to this build's own, and a pin BELOW it is refused by
// name at the same exit 5 it was refused at before.
//
// IT IS A LITERAL FOR THE SAME REASON `VERSION` IS. It has to be true of the
// compiled binary in a checkout that no longer exists, so it cannot be derived
// at run time from a CHANGELOG that will not be beside it -- and deriving a
// version comparison from prose is exactly the parse that must not stand
// between a consumer and its dependency. ./version.test.ts is the guard: it
// reads CHANGELOG.md's topmost released section and fails the build when a
// release that declares breaking notes has not moved this to its own minor, so
// the duplication costs one test and can never ship out of step with the prose
// it summarises. Set it in the SAME commit as `VERSION` whenever it moves.
export const COMPATIBLE_MINOR_FLOOR = "0.7";

// The binary's own name, used in usage text, error prefixes and the octokit
// user-agent. Not a persona and not taxonomy: it is this executable's identity,
// which is the one name a binary is allowed to know.
export const PROGRAM = "nen";
