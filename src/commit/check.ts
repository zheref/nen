// src/commit/check.ts -- `nen commit check --require-proof <lane>`: is the tree
// in front of me the tree a green build proved?
//
// WHAT THIS IS FOR. A loop that must not commit over a red build has, without a
// proof, two options and neither is good: rebuild everything before every commit
// (minutes, per commit, on the stack where this matters most), or believe a
// sentence somebody wrote in a transcript. This verb is the third: `nen shu
// build` records the tree it proved (../shu/proof.ts) and this compares that
// against the tree as it stands. Equal is "the build's verdict still applies to
// these bytes"; different is "it does not", and which of the three ways it
// differs is the whole of what this prints.
//
// IT REPORTS AND NEVER BLOCKS. Nothing is refused, no commit is prevented, no
// file is touched: the caller reads the code and decides, exactly as they do
// with `nen shu coverage --threshold`'s `met`. That is also why the failure is
// exit 1 rather than 2 -- the invocation was correct, and the answer is a fact
// about the repository.
//
// READ-ONLY, AND HERE IS THE HONEST FULL STATEMENT OF IT. Computing the tree
// hash runs `git add -A` into a SCRATCH INDEX and `git write-tree` (see
// ../repo/tree.ts): the repository's own index is neither read nor written, no
// ref moves, no tracked file changes, and the scratch file is removed. What it
// does leave behind is unreferenced git objects for file contents, which
// `git status` also creates and `gc` collects. Nothing a later reader can
// observe as a change, which is what ../parse/izanami.ts's read-only row means.

import { emit, VerbUsageError, type CommandContext } from "../cli/command.js";
import { assertRepoRoot } from "../repo/root.js";
import { workingTreeHash } from "../repo/tree.js";
import { PROOF_CONTRACT, proofRelativePath, readProof, type BuildProof } from "../shu/proof.js";

/** `nen.commit.check/v0.1` -- KEY ORDER IS THE CONTRACT; ./check.test.ts pins it. */
export const CHECK_CONTRACT = "nen.commit.check/v0.1";

export interface ProofCheckReport {
  readonly contract: string;
  readonly repo: string;
  readonly lane: string;
  /** Repo-relative, so a `--json` document does not carry whose machine it ran on. */
  readonly path: string;
  /** The proof as it was read, or null when there is none. */
  readonly proof: BuildProof | null;
  /** The tree as it stands NOW. */
  readonly treeHash: string;
  readonly ok: boolean;
  /** The one sentence saying how it differs, or null when it does not. */
  readonly difference: string | null;
  readonly exitCode: number;
}

/**
 * The document on disk, narrowed -- or null with the reason it is not a proof.
 *
 * NARROWED RATHER THAN TRUSTED. `../report/data.ts` carries this file VERBATIM
 * into a report, which is right for a reporter; a verb that COMPARES two hashes
 * has to know it has two hashes, and a file whose `treeHash` is a number would
 * otherwise compare unequal and be reported as a moved tree -- the wrong
 * difference, and the one a caller would act on by rebuilding forever.
 */
function narrow(document: unknown): { proof: BuildProof | null; wrong: string | null } {
  if (document === null) return { proof: null, wrong: null };
  if (typeof document !== "object" || Array.isArray(document)) {
    return { proof: null, wrong: "it is not a JSON object" };
  }
  const raw = document as Record<string, unknown>;
  for (const field of ["contract", "lane", "verb", "treeHash", "at"]) {
    if (typeof raw[field] !== "string") {
      return { proof: null, wrong: `its '${field}' is not a string` };
    }
  }
  if (typeof raw["exitCode"] !== "number") {
    return { proof: null, wrong: "its 'exitCode' is not a number" };
  }
  return {
    proof: {
      contract: raw["contract"] as string,
      lane: raw["lane"] as string,
      verb: raw["verb"] as string,
      treeHash: raw["treeHash"] as string,
      at: raw["at"] as string,
      exitCode: raw["exitCode"] as number,
    },
    wrong: null,
  };
}

/**
 * The three ways a proof can fail to answer for this tree, in this order.
 *
 * THE ORDER IS THE ORDER A READER CAN ACT ON. "There is none" comes before
 * "it is for another lane", which comes before "the tree moved": each later
 * answer presupposes the earlier one, and reporting the last of them for a file
 * that is not there would send somebody looking for a change they did not make.
 */
function difference(lane: string, proof: BuildProof | null, wrong: string | null, treeHash: string): string | null {
  if (wrong !== null) {
    return `${proofRelativePath(lane)} is there and is not a build proof nen can read: ${wrong}. Delete it and run the build again.`;
  }
  if (proof === null) {
    return `there is no build proof for lane '${lane}': ${proofRelativePath(lane)} is not there. A green 'nen shu build --lane ${lane}' records one; a build that came out red removes it, so this is also what a failed build since the last green one looks like.`;
  }
  if (proof.lane !== lane) {
    return `${proofRelativePath(lane)} records lane '${proof.lane}', and this check asked about '${lane}'. A proof answers for the lane that built it and for no other; run 'nen shu build --lane ${lane}'.`;
  }
  if (proof.treeHash !== treeHash) {
    return `the tree has moved since the build: it proved ${proof.treeHash} at ${proof.at}, and this working copy is ${treeHash}. Whatever changed since is unbuilt -- run 'nen shu build --lane ${lane}' again.`;
  }
  return null;
}

/** The human rendering, derived from the same report `--json` prints. */
export function renderCheck(report: ProofCheckReport): readonly string[] {
  const lines = [
    `lane:      ${report.lane}`,
    `tree:      ${report.treeHash}`,
    `proof:     ${report.proof === null ? "(none)" : `${report.path}  tree ${report.proof.treeHash} at ${report.proof.at}`}`,
  ];
  lines.push(
    report.ok
      ? "verdict:   OK -- this working copy is the one the build proved green."
      : `verdict:   NOT PROVED -- ${report.difference ?? ""}`,
  );
  return lines;
}

export function runCheck(context: CommandContext): number {
  const lane = context.args.values["require-proof"];
  if (lane === undefined || lane.trim() === "") {
    throw new VerbUsageError(
      "--require-proof <lane> is required: 'commit check' answers about ONE lane's build proof, and nen never picks a lane for you. It is the lane you built -- a key of this repository's own project.verbs.",
    );
  }
  // `--repo` IS REQUIRED HERE. This verb answers about the tree in a particular
  // working copy, and "wherever this process happens to be" is not a working
  // copy anybody named -- `shu warmup`'s rule (zheref/nen#28), applied to the
  // one other verb whose answer is entirely about which directory it ran in.
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const { proof, wrong } = narrow(readProof(root, lane));
  const treeHash = workingTreeHash(context.seams, root);
  const why = difference(lane, proof, wrong, treeHash);
  const report: ProofCheckReport = {
    contract: CHECK_CONTRACT,
    repo: root,
    lane,
    path: proofRelativePath(lane),
    proof,
    treeHash,
    ok: why === null,
    difference: why,
    exitCode: why === null ? 0 : 1,
  };
  emit(context.io, context.json, report, renderCheck(report));
  if (why !== null) context.io.err(`nen commit check: ${why}`);
  return report.exitCode;
}

/** Named here so the usage text and the verb cannot state different contracts. */
export const PROOF_CONTRACT_NAME = PROOF_CONTRACT;
