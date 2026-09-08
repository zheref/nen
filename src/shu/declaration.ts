// src/shu/declaration.ts -- open the target repository's `nen/contract.json`
// and hand back its `project` block, or refuse by name.
//
// TWO ABSENCES, TWO SENTENCES, AND THEY ARE NOT THE SAME PROBLEM. A repository
// with no contract file has never told nen anything, and the fix is to write
// one -- which `nen shu detect` proposes. A repository whose contract carries a
// `dependency` block and no `project` one has told nen something else entirely:
// it declares what it needs FROM nen (a plugin repository does exactly this) and
// nothing ABOUT itself for nen to build. Collapsing the two into "no contract"
// would send the second reader looking for a file that is right there.
//
// BOTH ARE EXIT 2, not 1. The invocation named a repository that cannot answer
// the question as asked, which is the same class as a missing flag: a caller
// fixes it by supplying something, not by retrying.

import { VerbUsageError } from "../cli/command.js";
import { loadContract, type ProjectBlock, type RepositoryContract } from "../schema/contract.js";
import { CONTRACT_FILE, resolveSchemaFile } from "../schema/source.js";

export interface OpenedDeclaration {
  /** Absolute path of the file that answered. */
  readonly path: string;
  readonly project: ProjectBlock;
  readonly contract: RepositoryContract;
}

/**
 * The `project` block, or a refusal naming the file and the way out.
 *
 * The presence probe is ../schema/source.ts's resolver rather than a bare
 * `existsSync`: it is the one place that knows a dangling symlink and an
 * unreadable parent are PRESENT-but-broken rather than absent, so a repository
 * whose contract cannot be opened gets the loader's real errno instead of this
 * file's "there is no contract here".
 */
export function openDeclaration(repoRoot: string): OpenedDeclaration {
  const resolved = resolveSchemaFile(repoRoot, CONTRACT_FILE);
  if (!resolved.canonical.present) {
    throw new VerbUsageError(
      `no such file: ${resolved.canonical.path}. 'nen shu' runs what a repository DECLARES -- lanes, per-verb argv, preconditions -- and this repository declares nothing. Run 'nen shu detect --repo ${repoRoot}' to see a project block proposed from the markers on disk, then write it (or pass --write) and run this again.`,
    );
  }
  const contract = loadContract(repoRoot);
  if (contract.project === null) {
    throw new VerbUsageError(
      `${contract.path} has no "project" block. It declares a dependency ON nen${
        contract.dependency === null ? "" : ` (>= ${contract.dependency.minimum})`
      } but nothing FOR nen to run: no lanes, no verbs. Add one with 'nen shu detect --repo ${repoRoot} --write', or point --repo at a repository that carries one.`,
    );
  }
  return { path: contract.path, project: contract.project, contract };
}
