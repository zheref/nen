// src/shu/pack.ts -- the reference profiles pack, typed.
//
// THE PACK IS A CATALOGUE, NOT AN AUTHORITY. Its rows are read by exactly one
// caller -- ./detect.ts, which writes a PROPOSAL a human edits into their own
// repository -- and by nothing that spawns a process. ./render.ts's signature is
// the enforcement: `renderInvocation` takes a declaration and has no parameter a
// pack could arrive through, so an execution path that reached one would not
// typecheck. See ../../profiles/README.md.
//
// IT LIVES OUTSIDE `src/` for the same reason, made physical: the toolchain
// names this family must never decide with are all in one directory of DATA,
// swept for by ./purity.test.ts, rather than spread through code where the next
// convenient literal is invisible.
//
// ONE STACK TODAY. `nextjs` is the only row this release carries, because it is
// the only stack a CI runner can exercise on all three platforms; the other six
// arrive with PR3 of zheref/nen#91 and `detect` says so rather than proposing a
// verb it cannot stand behind.

import nextjs from "../../profiles/nextjs.json";

export interface PackStep {
  readonly exe: string;
  readonly argv: readonly string[];
}

export interface PackVerb {
  readonly steps: readonly PackStep[];
  /**
   * A package.json dependency this verb's argv names. `detect` proposes the
   * verb only when the repository actually declares it -- section 2.6's rule
   * that "a task a marker implies but the project does not contain is a
   * WARNING, never a proposal".
   */
  readonly requiresDependency: string | null;
  readonly why: string;
}

export interface PackStack {
  readonly stack: string;
  /** The package manager every argv routes through, or null for a stack with none. */
  readonly packageManager: string | null;
  readonly hosts: readonly string[];
  readonly verbs: Readonly<Record<string, PackVerb>>;
}

interface RawVerb {
  readonly exe?: string;
  readonly argv?: readonly string[];
  readonly steps?: readonly { readonly exe: string; readonly argv: readonly string[] }[];
  readonly requiresDependency?: string;
  readonly why: string;
}

function readVerb(raw: RawVerb): PackVerb {
  const steps =
    raw.steps !== undefined
      ? raw.steps.map((step): PackStep => ({ exe: step.exe, argv: [...step.argv] }))
      : [{ exe: raw.exe ?? "", argv: [...(raw.argv ?? [])] }];
  return {
    steps,
    requiresDependency: raw.requiresDependency ?? null,
    why: raw.why,
  };
}

function readStack(raw: {
  stack: string;
  packageManager?: { id: string };
  hosts: readonly string[];
  verbs: Readonly<Record<string, RawVerb>>;
}): PackStack {
  return {
    stack: raw.stack,
    packageManager: raw.packageManager?.id ?? null,
    hosts: [...raw.hosts],
    verbs: Object.fromEntries(
      Object.entries(raw.verbs).map(([verb, entry]): [string, PackVerb] => [verb, readVerb(entry)]),
    ),
  };
}

/** Every stack the pack carries a reference row for, keyed by stack id. */
export const PACK: Readonly<Record<string, PackStack>> = {
  [nextjs.stack]: readStack(nextjs),
};
