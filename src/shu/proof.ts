// src/shu/proof.ts -- the build proof: a green `nen shu build` leaves behind
// one small document saying WHICH TREE it was green for.
//
// THE PROBLEM IT SOLVES. "I built it and it passed" is a claim about a moment,
// and by the time anybody acts on it -- a commit, a push, a pull request -- the
// moment is over and the tree may have moved. A skill that must not commit over
// a red build has, without this, exactly two options: rebuild everything before
// every commit (minutes, per commit), or believe a sentence in a transcript.
// The proof is the third: the build records the tree it proved, and
// `nen commit check` compares that against the tree in front of it. Equal means
// the build's verdict still applies to these bytes; different means it does not,
// and says so.
//
// IT IS A FACT, NOT A GATE. Nothing in `nen shu build` reads a proof, no verb
// refuses because one is absent, and `commit check` reports rather than blocks
// -- it is `nen`'s usual shape: state what is true, let the caller decide.
//
// AND IT NEVER OUTLIVES THE TREE IT PROVED. A red build REMOVES an existing
// proof rather than leaving yesterday's, because a stale proof is worse than
// none: it is a green answer to a question nobody has asked again. A dry run
// writes nothing and removes nothing -- it ran no build, so it has learned
// nothing about this tree in either direction.
//
// THE SHAPE IS READ BY SOMEBODY ELSE ALREADY. `nen report data` carries
// `.nen/proof/<lane>.json` verbatim into the report document (../report/data.ts),
// which is why the path lives here and is imported there rather than spelled
// twice.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { containedPath } from "../repo/contain.js";
import { NEN_DIR, workingTreeHash } from "../repo/tree.js";
import { normalizeEol, type Seams } from "../seam/exec.js";
import { VerbUsageError } from "../cli/command.js";

/** `nen.shu.proof/v0.1` -- one versioned contract string, as everywhere here. */
export const PROOF_CONTRACT = "nen.shu.proof/v0.1";

/** The one verb that writes a proof. A test is not a build; only this is. */
export const PROOF_VERB = "build";

/**
 * The document, key order and all.
 *
 * `exitCode` IS ALWAYS 0 AND IS STILL WRITTEN. A reader that had to know "this
 * file only exists when the build was green" is a reader holding a rule instead
 * of a document; the field says it in the file, and a later release that
 * recorded something else has somewhere to say so.
 */
export interface BuildProof {
  readonly contract: string;
  readonly lane: string;
  readonly verb: string;
  /** The git tree object of the working copy the build ran against. */
  readonly treeHash: string;
  readonly at: string;
  readonly exitCode: number;
}

/** `.nen/proof/<lane>.json`, repo-relative -- the one definition of where. */
export function proofRelativePath(lane: string): string {
  return `${NEN_DIR}/proof/${lane}.json`;
}

/**
 * The absolute path, or a refusal naming the lane.
 *
 * A LANE IS A KEY IN A DECLARATION, NOT A PATH, and `--lane ../../etc/passwd`
 * would otherwise address a file outside the tree through a flag that means
 * something else entirely. The check costs nothing and the refusal names the
 * flag rather than the file it would have written.
 */
export function proofPath(root: string, lane: string): string {
  const absolute = containedPath(root, proofRelativePath(lane));
  if (absolute === null) {
    throw new VerbUsageError(
      `lane '${lane}' resolves outside the repository (its build proof would be at '${proofRelativePath(lane)}'). A lane is a key in this repository's own declaration, not a path.`,
    );
  }
  return absolute;
}

/**
 * Write the proof for a green build, and answer what was written.
 *
 * THE TREE IS HASHED HERE, AFTER THE BUILD, not before it: what the proof
 * asserts is "these bytes built", and a hash taken before the run would be a
 * hash of the tree the build STARTED from -- which a build that writes into its
 * own tree (a generated file, a lockfile, a formatted source) has already moved.
 */
export function writeProof(seams: Seams, root: string, lane: string): BuildProof {
  const proof: BuildProof = {
    contract: PROOF_CONTRACT,
    lane,
    verb: PROOF_VERB,
    treeHash: workingTreeHash(seams, root),
    at: seams.now().toISOString(),
    exitCode: 0,
  };
  const absolute = proofPath(root, lane);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  return proof;
}

/** Remove this lane's proof if there is one. Absent is not an error. */
export function removeProof(root: string, lane: string): void {
  rmSync(proofPath(root, lane), { force: true });
}

/**
 * The proof on disk, or null when there is none.
 *
 * A FILE THAT IS NOT JSON IS NOT A PROOF, and it raises rather than reading as
 * an absence: "there is no proof" and "there is something here nen cannot read"
 * are different facts, and a checker that folded the second into the first would
 * report a corrupted proof as a build nobody ran.
 */
export function readProof(root: string, lane: string): unknown {
  const absolute = proofPath(root, lane);
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(normalizeEol(text)) as unknown;
  } catch (error) {
    throw new VerbUsageError(
      `${proofRelativePath(lane)} is present and is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      }). nen will not read a damaged proof as a missing one: delete it, or run the build again.`,
    );
  }
}
