// src/watch/merged.ts -- `nen watch until --pr <ref> --until merged`
// (zheref/nen#454): wait for a pull request to MERGE, and tell a merge from a
// close without one.
//
// WHY THIS IS NOT ONE MORE `readReady` PREDICATE. The other four `--until`
// values are facts of a readiness evaluation (./pr.ts), and a readiness read
// needs reviewer identities and a gate before it says anything. Whether a pull
// request merged needs neither: it is GitHub's `state` and `mergeCommit`, read
// from the same PULL_REQUEST_QUERY snapshot `pr ready` reads, through the same
// transport and the same token rule (`--token-env`, never an ambient
// credential), with the same ref grammar (`<CODE>#<N>`, or `<N> --gh-repo`).
//
// THREE READINGS, NEVER TWO. `MERGED` is the condition (exit 0, with the merge
// commit and the base branch). `CLOSED` without a merge is TERMINAL -- it can
// never become merged without a human reopening it, so the watch stops on the
// first such read with outcome `terminal` and `state: "CLOSED"` (exit 1), never
// polling to the bound and never reading the same as a merge. `OPEN` is "not
// yet". A state GitHub did not answer, or answered outside those three, is an
// OBSERVATION ERROR counted toward the three-error streak: could not read is
// never "still open".

import { digPath, type GhPullRequestNode } from "../github/graphql.js";
import type { PrStateSource } from "../github/pr_state.js";
import { assertRepoRoot } from "../repo/root.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { DEFAULT_TOKEN_ENV, resolveRef, type PrReadyDeps, type PrReadyInput, type ResolvedRef } from "../verbs/pr_ready.js";
import type { WatchObservation } from "./until.js";

export type PrLifecycleState = "OPEN" | "CLOSED" | "MERGED";

export interface PrLifecycle {
  readonly repo: string;
  readonly number: number;
  readonly state: PrLifecycleState;
  /** The merge commit SHA when merged, else null. */
  readonly mergeCommit: string | null;
  /** The base branch the pull request targets (merged into, once merged). */
  readonly base: string | null;
  readonly head: string | null;
}

export type LifecycleRead =
  | { readonly kind: "usage"; readonly message: string }
  | { readonly kind: "unreadable"; readonly message: string }
  | { readonly kind: "state"; readonly lifecycle: PrLifecycle };

/** The pull-request reference, resolved once: a malformed ref refuses every poll identically, so it is a usage error. */
export function resolveLifecycleRef(typedRef: string, input: PrReadyInput): ResolvedRef {
  const repoRoot = assertRepoRoot({ repoFlag: input.repoFlag });
  return resolveRef(typedRef, input.values["gh-repo"], () => loadRepoRegistry(repoRoot));
}

/** Read the node's lifecycle off one snapshot. Pure. */
export function lifecycleOf(ref: ResolvedRef, node: GhPullRequestNode | undefined): LifecycleRead {
  if (node === undefined) {
    return { kind: "unreadable", message: `GitHub answered no pull request node for ${ref.owner}/${ref.repo}#${ref.number}` };
  }
  const state = node.state;
  if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") {
    return { kind: "unreadable", message: `the pull request's state could not be read (got ${JSON.stringify(state ?? null)})` };
  }
  const oid = node.mergeCommitOid;
  const mergeCommit = typeof oid === "string" && oid !== "" ? oid : null;
  if (state === "MERGED" && mergeCommit === null) {
    return { kind: "unreadable", message: "the pull request reads MERGED but its merge commit could not be read" };
  }
  return {
    kind: "state",
    lifecycle: {
      repo: `${ref.owner}/${ref.repo}`,
      number: ref.number,
      state,
      mergeCommit: state === "MERGED" ? mergeCommit : null,
      base: typeof node.baseRefName === "string" && node.baseRefName !== "" ? node.baseRefName : null,
      head: typeof node.headRefOid === "string" && node.headRefOid !== "" ? node.headRefOid : null,
    },
  };
}

/** One observation: open the transport, read the snapshot, decide. Network errors are unreadable, never a state. */
export async function readLifecycle(ref: ResolvedRef, input: PrReadyInput, deps: PrReadyDeps): Promise<LifecycleRead> {
  const opened = deps.openSource(input.values["token-env"] ?? DEFAULT_TOKEN_ENV);
  if (!opened.ok) {
    return {
      kind: "unreadable",
      message: `${opened.message}. Set GH_TOKEN explicitly, or use --token-env <VAR>; never an ambient credential`,
    };
  }
  const source: PrStateSource = opened.source;
  try {
    const snapshot = await source.pullRequestSnapshot(ref, ref.number);
    return lifecycleOf(ref, snapshot.pullRequest);
  } catch (error) {
    const status = digPath(error, "status");
    return {
      kind: "unreadable",
      message: `GitHub could not be read${typeof status === "number" ? ` (HTTP ${status})` : ""}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    };
  }
}

/** The watch loop's verdict on one read. */
export function observeLifecycle(read: LifecycleRead): WatchObservation {
  if (read.kind !== "state") {
    return { errored: true, conditionTrue: false, message: `observation failed: ${read.message}` };
  }
  const { lifecycle } = read;
  const where = `${lifecycle.repo}#${lifecycle.number}`;
  if (lifecycle.state === "MERGED") {
    return {
      errored: false,
      conditionTrue: true,
      message: `merged is true -- ${where} merged into ${lifecycle.base ?? "(base unread)"} at ${lifecycle.mergeCommit ?? ""}`,
    };
  }
  if (lifecycle.state === "CLOSED") {
    return {
      errored: false,
      conditionTrue: false,
      terminal: true,
      message: `merged can no longer become true -- ${where} was CLOSED without a merge`,
    };
  }
  return { errored: false, conditionTrue: false, message: `merged is not yet true -- ${where} is OPEN (head ${lifecycle.head?.slice(0, 7) ?? "(unread)"})` };
}
